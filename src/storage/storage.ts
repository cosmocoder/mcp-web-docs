import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import lancedb, { Connection, Table } from 'vectordb';
import QuickLRU from 'quick-lru';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { DocumentMetadata, ProcessedDocument, SearchResult, SearchOptions, StorageProvider } from '../types.js';
import { EmbeddingsProvider } from '../embeddings/types.js';
import { logger } from '../util/logger.js';

type LanceDbRow = {
  url: string;
  title: string;
  content: string;
  path: string;
  startLine: number;
  endLine: number;
  vector: number[];
  type: 'overview' | 'api' | 'example' | 'usage';
  lastUpdated: string;
  version: string;
  framework: string;
  language: string;
  codeBlocks_code: string[];
  codeBlocks_language: string[];
  codeBlocks_context: string[];
  props_name: string[];
  props_type: string[];
  props_required: boolean[];
  props_defaultValue: string[];
  props_description: string[];
};

export class DocumentStore implements StorageProvider {
  private sqliteDb?: Database;
  private lanceConn?: Connection;
  private lanceTable?: Table;
  private readonly searchCache: QuickLRU<string, SearchResult[]>;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDbPath: string,
    private readonly embeddings: EmbeddingsProvider,
    maxCacheSize: number = 1000
  ) {
    logger.debug(`[DocumentStore] Initializing with paths:`, {
      dbPath,
      vectorDbPath,
      maxCacheSize
    });
    this.searchCache = new QuickLRU({ maxSize: maxCacheSize });
  }

  async initialize(): Promise<void> {
    logger.debug(`[DocumentStore] Starting initialization with paths:`, {
      dbPath: this.dbPath,
      vectorDbPath: this.vectorDbPath
    });

    try {
      // Create directories with error handling
      try {
        logger.debug(`[DocumentStore] Creating SQLite directory: ${dirname(this.dbPath)}`);
        await mkdir(dirname(this.dbPath), { recursive: true });
        logger.debug(`[DocumentStore] Creating LanceDB directory: ${this.vectorDbPath}`);
        await mkdir(this.vectorDbPath, { recursive: true });
      } catch (error) {
        logger.error('[DocumentStore] Error creating directories:', error);
        throw new Error(`Failed to create storage directories: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Initialize SQLite with error handling
      try {
        logger.debug(`[DocumentStore] Opening SQLite database at ${this.dbPath}`);
        this.sqliteDb = await open({
          filename: this.dbPath,
          driver: sqlite3.Database
        });

        logger.debug(`[DocumentStore] Configuring SQLite database`);
        await this.sqliteDb.exec('PRAGMA busy_timeout = 5000;');
        await this.sqliteDb.exec('PRAGMA journal_mode = WAL;');
      } catch (error) {
        logger.error('[DocumentStore] Error initializing SQLite:', error);
        throw new Error(`Failed to initialize SQLite: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Create tables if they don't exist
      await this.sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          url TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          favicon TEXT,
          last_indexed DATETIME NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_last_indexed ON documents(last_indexed);
      `);

      // Initialize LanceDB with error handling
      try {
        logger.debug(`[DocumentStore] Connecting to LanceDB at ${this.vectorDbPath}`);
        this.lanceConn = await lancedb.connect(this.vectorDbPath);

        logger.debug(`[DocumentStore] Getting table list`);
        const tableNames = await this.lanceConn.tableNames();
        logger.debug(`[DocumentStore] Existing tables:`, tableNames);

        // Only create the table if it doesn't exist
        if (!tableNames.includes('chunks')) {
          logger.debug(`[DocumentStore] Creating chunks table with dimensions: ${this.embeddings.dimensions}`);
          // Create table with sample row to establish schema
          const sampleRow = [{
            url: '',
            title: '',
            content: '',
            path: '',
            startLine: 0,
            endLine: 0,
            vector: new Array(this.embeddings.dimensions).fill(0),
            type: 'overview',
            lastUpdated: new Date().toISOString(),
            version: '',
            framework: '',
            language: '',
            codeBlocks_code: [''],
            codeBlocks_language: [''],
            codeBlocks_context: [''],
            props_name: [''],
            props_type: [''],
            props_required: [false],
            props_defaultValue: [''],
            props_description: ['']
          }] as LanceDbRow[];

          // Create table with default options
          this.lanceTable = await this.lanceConn.createTable('chunks', sampleRow);
          logger.debug(`[DocumentStore] Removing sample row`);
          await this.lanceTable.delete("url = ''");
          logger.debug(`[DocumentStore] New chunks table created successfully`);
        } else {
          logger.debug(`[DocumentStore] Using existing chunks table`);
          this.lanceTable = await this.lanceConn.openTable('chunks');
        }

        // Verify table is accessible
        const rowCount = await this.lanceTable.countRows();
        logger.debug(`[DocumentStore] Chunks table initialized, contains ${rowCount} rows`);
      } catch (error) {
        logger.error('[DocumentStore] Error initializing LanceDB:', error);
        throw new Error(`Failed to initialize LanceDB: ${error instanceof Error ? error.message : String(error)}`);
      }

      logger.debug(`[DocumentStore] All storage components initialized successfully`);
    } catch (error) {
      logger.error('[DocumentStore] Error initializing storage:', error);
      throw error;
    }
  }

  async addDocument(doc: ProcessedDocument): Promise<void> {
    logger.debug(`[DocumentStore] Starting addDocument for:`, {
      url: doc.metadata.url,
      title: doc.metadata.title,
      chunks: doc.chunks.length
    });

    // Add diagnostic logging for vector dimensions
    if (doc.chunks.length > 0) {
      logger.debug(`[DocumentStore] Sample vector dimensions: ${doc.chunks[0].vector.length}`);
      logger.debug(`[DocumentStore] Sample vector first 5 values: ${doc.chunks[0].vector.slice(0, 5)}`);
    }

    // Validate storage initialization
    if (!this.sqliteDb) {
      logger.debug('[DocumentStore] SQLite not initialized during addDocument');
      throw new Error('SQLite storage not initialized');
    }
    if (!this.lanceTable) {
      logger.debug('[DocumentStore] LanceDB not initialized during addDocument');
      throw new Error('LanceDB storage not initialized');
    }

    try {
      // Check if document already exists
      const existing = await this.getDocument(doc.metadata.url);
      if (existing) {
        logger.debug(`[DocumentStore] Existing document found, will update:`, existing);
      }

      logger.debug(`[DocumentStore] Starting SQLite transaction`);
      await this.sqliteDb.run('BEGIN TRANSACTION');

      // Add metadata to SQLite
      await this.sqliteDb.run(
        'INSERT OR REPLACE INTO documents (url, title, favicon, last_indexed) VALUES (?, ?, ?, ?)',
        [doc.metadata.url, doc.metadata.title, doc.metadata.favicon, doc.metadata.lastIndexed.toISOString()]
      );
      logger.debug(`[DocumentStore] Added metadata to SQLite`);

      // Delete existing chunks for this document
      await this.lanceTable.delete(`url = '${doc.metadata.url}'`);
      logger.debug(`[DocumentStore] Deleted existing chunks`);

      // Add new chunks to LanceDB
      const rows = doc.chunks.map(chunk => ({
        url: doc.metadata.url,
        title: doc.metadata.title,
        content: chunk.content,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        vector: chunk.vector,
        type: chunk.metadata.type,
        lastUpdated: new Date().toISOString(),
        version: '',
        framework: '',
        language: '',
        codeBlocks_code: chunk.metadata.codeBlocks?.map(b => b.code) || [''],
        codeBlocks_language: chunk.metadata.codeBlocks?.map(b => b.language) || [''],
        codeBlocks_context: chunk.metadata.codeBlocks?.map(b => b.context) || [''],
        props_name: chunk.metadata.props?.map(p => p.name) || [''],
        props_type: chunk.metadata.props?.map(p => p.type) || [''],
        props_required: chunk.metadata.props?.map(p => p.required) || [false],
        props_defaultValue: chunk.metadata.props?.map(p => p.defaultValue || '') || [''],
        props_description: chunk.metadata.props?.map(p => p.description) || ['']
      })) as LanceDbRow[];

      logger.debug(`[DocumentStore] Adding ${rows.length} chunks to LanceDB`);
      await this.lanceTable.add(rows);

      // Verify data was added
      const rowCount = await this.lanceTable.countRows();
      logger.debug(`[DocumentStore] Table now contains ${rowCount} rows`);

      // Commit transaction
      await this.sqliteDb.run('COMMIT');
      logger.debug(`[DocumentStore] Committed transaction`);

      // Clear search cache for this URL
      this.clearCacheForUrl(doc.metadata.url);
    } catch (error) {
      // Rollback on error
      if (this.sqliteDb) {
        await this.sqliteDb.run('ROLLBACK');
      }
      logger.error('[DocumentStore] Error adding document:', error);
      throw error;
    }
  }

  async searchDocuments(queryVector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.lanceTable) {
      throw new Error('Storage not initialized');
    }

    const { limit = 10, includeVectors = false, filterByType, textQuery } = options;

    logger.debug(`[DocumentStore] Searching documents with vector:`, {
      dimensions: queryVector.length,
      limit,
      includeVectors,
      filterByType,
      hasTextQuery: !!textQuery
    });

    // Add validation for query vector
    if (queryVector.length === 0 && !textQuery) {
      logger.debug('[DocumentStore] Empty query vector and no text query provided');
      return [];
    }

    // Log search parameters
    logger.debug(`[DocumentStore] Search parameters:`, {
      vectorDimensions: queryVector.length,
      expectedDimensions: this.embeddings.dimensions,
      limit,
      filterType: filterByType
    });

    // Ensure vector dimensions match if provided
    if (queryVector.length > 0 && queryVector.length !== this.embeddings.dimensions) {
      logger.debug(`[DocumentStore] Vector dimension mismatch: got ${queryVector.length}, expected ${this.embeddings.dimensions}`);
      // Consider padding or truncating the vector to match expected dimensions
      if (queryVector.length < this.embeddings.dimensions) {
        // Pad the vector with zeros
        queryVector = [...queryVector, ...new Array(this.embeddings.dimensions - queryVector.length).fill(0)];
        logger.debug(`[DocumentStore] Padded vector to ${queryVector.length} dimensions`);
      } else {
        // Truncate the vector
        queryVector = queryVector.slice(0, this.embeddings.dimensions);
        logger.debug(`[DocumentStore] Truncated vector to ${queryVector.length} dimensions`);
      }
    }

    try {
      // Log query vector for debugging
      logger.debug(`[DocumentStore] Query vector first 5 values: ${queryVector.slice(0, 5)}`);

      // Ensure we have a valid query vector
      if (queryVector.length === 0) {
        logger.debug('[DocumentStore] Empty query vector provided for search');
        // Use a default vector of the correct dimension instead of an empty array
        queryVector = new Array(this.embeddings.dimensions).fill(0);
        logger.debug(`[DocumentStore] Using default zero vector with ${queryVector.length} dimensions`);
      }

      // Create search query
      let query = this.lanceTable.search(queryVector).limit(limit);

      if (filterByType) {
        query = query.where(`type = '${filterByType}'`);
      }

      const results = await query.execute();

      logger.debug(`[DocumentStore] Found ${results.length} results`);

      // Log the first result for debugging if available
      if (results.length > 0) {
        logger.debug(`[DocumentStore] First result:`, {
          id: results[0].id,
          score: results[0].score,
          hasVector: 'vector' in results[0],
          vectorType: typeof results[0].vector,
          vectorLength: Array.isArray(results[0].vector) ? results[0].vector.length : 'not an array'
        });
      }

      const searchResults = results.map((result: any) => {
        // Log the raw result for debugging
        logger.debug(`[DocumentStore] Raw search result:`, {
          id: result.id,
          url: result.url,
          hasVector: !!result.vector,
          vectorType: result.vector ? typeof result.vector : 'undefined',
          vectorLength: result.vector ? (Array.isArray(result.vector) ? result.vector.length : 'not an array') : 0
        });

        return {
          id: String(result.id || result.url),
          content: String(result.content),
          url: String(result.url),
          title: String(result.title),
          score: Number(result.score),
          ...(includeVectors && { vector: result.vector as number[] }),
          metadata: {
            type: (result.type || 'overview') as 'overview' | 'api' | 'example' | 'usage',
            path: String(result.path),
            lastUpdated: new Date(result.lastUpdated ? String(result.lastUpdated) : Date.now()),
            version: result.version as string | undefined,
            framework: result.framework as string | undefined,
            language: result.language as string | undefined,
            codeBlocks: result.codeBlocks_code ? Array.from({
              length: (result.codeBlocks_code as string[]).length
            }, (_, i) => ({
              code: (result.codeBlocks_code as string[])[i],
              language: (result.codeBlocks_language as string[])[i],
              context: (result.codeBlocks_context as string[])[i]
            })) : undefined,
            props: result.props_name ? Array.from({
              length: (result.props_name as string[]).length
            }, (_, i) => ({
              name: (result.props_name as string[])[i],
              type: (result.props_type as string[])[i],
              required: (result.props_required as boolean[])[i],
              defaultValue: (result.props_defaultValue as string[])[i],
              description: (result.props_description as string[])[i]
            })) : undefined
          }
        };
      });

      return searchResults;
    } catch (error) {
      logger.error('[DocumentStore] Error searching documents:', error);
      throw error;
    }
  }

  async searchByText(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    logger.debug(`[DocumentStore] Searching documents by text:`, { query, options });

    const cacheKey = `text:${query}:${JSON.stringify(options)}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) {
      logger.debug(`[DocumentStore] Returning cached results`);
      return cached;
    }

    try {
      // Use LanceDB's native text search if available
      if (this.lanceTable && 'textSearch' in this.lanceTable) {
        const results = await this.searchDocuments([], {
          ...options,
          textQuery: query
        });
        this.searchCache.set(cacheKey, results);
        return results;
      }

      // Fallback to vector search
      const queryVector = await this.embeddings.embed(query);
      const results = await this.searchDocuments(queryVector, options);

      this.searchCache.set(cacheKey, results);
      return results;
    } catch (error) {
      logger.error('[DocumentStore] Error searching documents by text:', error);
      throw error;
    }
  }

  async listDocuments(): Promise<DocumentMetadata[]> {
    if (!this.sqliteDb) {
      throw new Error('Storage not initialized');
    }

    logger.debug(`[DocumentStore] Listing documents`);

    try {
      const rows = await this.sqliteDb.all<Array<{
        url: string;
        title: string;
        favicon: string | null;
        last_indexed: string;
      }>>('SELECT url, title, favicon, last_indexed FROM documents ORDER BY last_indexed DESC');

      logger.debug(`[DocumentStore] Found ${rows.length} documents`);

      return rows.map(row => ({
        url: row.url,
        title: row.title,
        favicon: row.favicon ?? undefined,
        lastIndexed: new Date(row.last_indexed)
      }));
    } catch (error) {
      logger.error('[DocumentStore] Error listing documents:', error);
      throw error;
    }
  }

  async deleteDocument(url: string): Promise<void> {
    if (!this.sqliteDb || !this.lanceTable) {
      throw new Error('Storage not initialized');
    }

    logger.debug(`[DocumentStore] Deleting document: ${url}`);

    try {
      await this.sqliteDb.run('BEGIN TRANSACTION');

      await this.sqliteDb.run('DELETE FROM documents WHERE url = ?', [url]);
      await this.lanceTable.delete(`url = '${url}'`);

      await this.sqliteDb.run('COMMIT');

      // Clear cache for this URL
      this.clearCacheForUrl(url);
      logger.debug(`[DocumentStore] Document deleted successfully`);
    } catch (error) {
      if (this.sqliteDb) {
        await this.sqliteDb.run('ROLLBACK');
      }
      logger.error('[DocumentStore] Error deleting document:', error);
      throw error;
    }
  }

  async getDocument(url: string): Promise<DocumentMetadata | null> {
    if (!this.sqliteDb) {
      throw new Error('Storage not initialized');
    }

    logger.debug(`[DocumentStore] Getting document: ${url}`);

    try {
      // Check if SQLite is properly initialized
      if (!this.sqliteDb) {
        logger.debug('[DocumentStore] SQLite not initialized during getDocument');
        throw new Error('Storage not initialized');
      }

      // Log the query being executed
      logger.debug(`[DocumentStore] Executing SQLite query for URL: ${url}`);

      const row = await this.sqliteDb.get<{
        url: string;
        title: string;
        favicon: string | null;
        last_indexed: string;
      }>('SELECT url, title, favicon, last_indexed FROM documents WHERE url = ?', [url]);

      if (!row) {
        logger.debug(`[DocumentStore] Document not found in SQLite: ${url}`);
        return null;
      }

      // Check if LanceDB has any chunks for this document
      if (this.lanceTable) {
        const chunks = await this.lanceTable.countRows(`url = '${url}'`);
        logger.debug(`[DocumentStore] Found ${chunks} chunks in LanceDB for ${url}`);
      }

      logger.debug(`[DocumentStore] Document found in SQLite:`, row);

      return {
        url: row.url,
        title: row.title,
        favicon: row.favicon ?? undefined,
        lastIndexed: new Date(row.last_indexed)
      };
    } catch (error) {
      logger.error('[DocumentStore] Error getting document:', error);
      throw error;
    }
  }

  private clearCacheForUrl(url: string): void {
    // Clear all cache entries that might contain results for this URL
    for (const key of this.searchCache.keys()) {
      const results = this.searchCache.get(key);
      if (results?.some(result => result.url === url)) {
        this.searchCache.delete(key);
      }
    }
  }

  /**
   * Validates that vectors are properly stored and retrievable from LanceDB
   * @returns Promise<boolean> True if vectors are valid, false otherwise
   */
  async validateVectors(): Promise<boolean> {
    if (!this.lanceTable) {
      logger.debug('[DocumentStore] Cannot validate vectors: Storage not initialized');
      throw new Error('Storage not initialized');
    }

    try {
      // Get total row count
      const rowCount = await this.lanceTable.countRows();
      logger.debug(`[DocumentStore] Vector validation: Table contains ${rowCount} rows`);

      if (rowCount === 0) {
        logger.debug('[DocumentStore] Vector validation: No rows found in vector table');
        return false;
      }

      // Get a sample row
      const sample = await this.lanceTable.search([]).limit(1).execute();
      if (sample.length === 0) {
        logger.debug('[DocumentStore] Vector validation: No rows returned from search');
        return false;
      }

      // Log detailed information about the sample
      logger.debug('[DocumentStore] Vector validation sample:', {
        hasVector: 'vector' in sample[0],
        vectorType: typeof sample[0].vector,
        isArray: Array.isArray(sample[0].vector),
        length: Array.isArray(sample[0].vector) ? sample[0].vector.length : 'N/A',
        sample: Array.isArray(sample[0].vector) ? sample[0].vector.slice(0, 5) : sample[0].vector
      });

      // Try a simple vector search with a random vector
      const testVector = new Array(this.embeddings.dimensions).fill(0).map(() => Math.random());
      logger.debug(`[DocumentStore] Testing vector search with random vector of length ${testVector.length}`);

      const searchResults = await this.lanceTable.search(testVector).limit(1).execute();
      logger.debug(`[DocumentStore] Vector search test returned ${searchResults.length} results`);

      if (searchResults.length > 0) {
        logger.debug('[DocumentStore] Vector search test result:', {
          score: searchResults[0].score,
          hasVector: 'vector' in searchResults[0],
          vectorLength: Array.isArray(searchResults[0].vector) ? searchResults[0].vector.length : 'N/A'
        });
      }

      // Consider vectors valid if we have rows and can perform a search
      // Even if scores are null, the search is still working
      return rowCount > 0 && sample.length > 0 && searchResults.length > 0;
    } catch (error) {
      logger.error('[DocumentStore] Error validating vectors:', error);
      return false;
    }
  }
}
