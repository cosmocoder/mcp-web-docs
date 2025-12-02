import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import * as lancedb from '@lancedb/lancedb';
import { PhraseQuery, MatchQuery, BooleanQuery, Occur } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Schema, Utf8, Int32 } from 'apache-arrow';
import QuickLRU from 'quick-lru';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { DocumentMetadata, ProcessedDocument, SearchResult, SearchOptions, StorageProvider } from '../types.js';
import { EmbeddingsProvider } from '../embeddings/types.js';
import { logger } from '../util/logger.js';

type LanceDBConnection = Awaited<ReturnType<typeof lancedb.connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

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
  // Serialized JSON for code blocks and props
  codeBlocks: string;
  props: string;
};

/**
 * Query preprocessing result for improved search
 */
interface ProcessedQuery {
  /** Exact phrases to match (from quoted strings) */
  phrases: string[];
  /** Cleaned query text for general search */
  cleanedQuery: string;
  /** Original query for fallback */
  original: string;
}

/**
 * Preprocesses a search query - keeps it generic for any documentation type.
 * Only extracts explicitly quoted phrases, otherwise passes through to LanceDB's
 * built-in tokenization which handles stop words and stemming.
 */
function preprocessQuery(query: string): ProcessedQuery {
  const result: ProcessedQuery = {
    phrases: [],
    cleanedQuery: query,
    original: query
  };

  // Extract quoted phrases for exact matching
  const quotedPattern = /"([^"]+)"/g;
  let match;
  while ((match = quotedPattern.exec(query)) !== null) {
    result.phrases.push(match[1]);
  }

  // Remove quotes from cleaned query
  result.cleanedQuery = query.replace(/"([^"]+)"/g, '$1').trim();

  logger.debug('[QueryPreprocess] Processed query:', result);
  return result;
}

export class DocumentStore implements StorageProvider {
  private sqliteDb?: Database;
  private lanceConn?: LanceDBConnection;
  private lanceTable?: LanceDBTable;
  private readonly searchCache: QuickLRU<string, SearchResult[]>;
  private ftsIndexCreated = false;

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

          // Define schema using Apache Arrow
          const vectorType = new FixedSizeList(
            this.embeddings.dimensions,
            new Field('item', new Float32(), true)
          );

          const schema = new Schema([
            new Field('url', new Utf8(), false),
            new Field('title', new Utf8(), false),
            new Field('content', new Utf8(), false),
            new Field('path', new Utf8(), false),
            new Field('startLine', new Int32(), false),
            new Field('endLine', new Int32(), false),
            new Field('vector', vectorType, false),
            new Field('type', new Utf8(), false),
            new Field('lastUpdated', new Utf8(), false),
            new Field('version', new Utf8(), true),
            new Field('framework', new Utf8(), true),
            new Field('language', new Utf8(), true),
            // Flatten arrays to simple strings for better FTS support
            new Field('codeBlocks', new Utf8(), true),
            new Field('props', new Utf8(), true),
          ]);

          // Create empty table with schema
          this.lanceTable = await this.lanceConn.createEmptyTable('chunks', schema, { mode: 'create' });
          logger.debug(`[DocumentStore] New chunks table created successfully`);

          // Create FTS index for better text search
          await this.createFTSIndex();
        } else {
          logger.debug(`[DocumentStore] Using existing chunks table`);
          this.lanceTable = await this.lanceConn.openTable('chunks');

          // Try to create FTS index if it doesn't exist
          await this.createFTSIndex();
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
        // Serialize code blocks and props as JSON strings
        codeBlocks: JSON.stringify(chunk.metadata.codeBlocks || []),
        props: JSON.stringify(chunk.metadata.props || [])
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

      const results = await query.toArray();

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

          // Parse JSON fields
          let codeBlocks;
          let props;
          try {
            codeBlocks = result.codeBlocks ? JSON.parse(result.codeBlocks) : undefined;
          } catch {
            codeBlocks = undefined;
          }
          try {
            props = result.props ? JSON.parse(result.props) : undefined;
          } catch {
            props = undefined;
          }

          return {
            id: String(result.id || result.url),
            content: String(result.content),
            url: String(result.url),
            title: String(result.title),
            score: result._distance != null ? 1 - result._distance : (result.score ?? null),
            ...(includeVectors && { vector: result.vector as number[] }),
            metadata: {
              type: (result.type || 'overview') as 'overview' | 'api' | 'example' | 'usage',
              path: String(result.path),
              lastUpdated: new Date(result.lastUpdated ? String(result.lastUpdated) : Date.now()),
              version: result.version as string | undefined,
              framework: result.framework as string | undefined,
              language: result.language as string | undefined,
              codeBlocks,
              props
            }
          };
        });

        return searchResults;
    } catch (error) {
      logger.error('[DocumentStore] Error searching documents:', error);
      throw error;
    }
  }

  /**
   * Create full-text search index on the content field
   */
  private async createFTSIndex(): Promise<void> {
    if (!this.lanceTable || this.ftsIndexCreated) {
      return;
    }

    try {
      logger.debug('[DocumentStore] Creating FTS index on content field...');
      await this.lanceTable.createIndex('content', {
        config: lancedb.Index.fts()
      });
      this.ftsIndexCreated = true;
      logger.debug('[DocumentStore] FTS index created successfully');
    } catch (error: any) {
      if (error.message?.toLowerCase().includes('already exists')) {
        logger.debug('[DocumentStore] FTS index already exists');
        this.ftsIndexCreated = true;
      } else {
        logger.warn('[DocumentStore] Failed to create FTS index:', error.message);
        // Don't throw - FTS is optional, we can fall back to vector search
      }
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

    const { limit = 10, filterByType } = options;

    try {
      if (!this.lanceTable) {
        throw new Error('Storage not initialized');
      }

      // Preprocess query - only extracts quoted phrases, keeps everything else generic
      const processedQuery = preprocessQuery(query);

      // Generate embedding for vector search
      const queryVector = await this.embeddings.embed(query);

      logger.debug('[DocumentStore] Attempting hybrid search (FTS + vector with RRF)');

      // Strategy 1: If user provided quoted phrases, use phrase matching
      if (this.ftsIndexCreated && processedQuery.phrases.length > 0) {
        try {
          logger.debug('[DocumentStore] Using phrase-based search for quoted terms:', processedQuery.phrases);

          // Build boolean query: phrase matches (must) + general terms (should)
          const queries: [Occur, PhraseQuery | MatchQuery][] = [];

          // Add phrase queries for quoted phrases (exact match)
          for (const phrase of processedQuery.phrases) {
            queries.push([Occur.Must, new PhraseQuery(phrase, 'content', { slop: 0 })]);
          }

          // Add fuzzy match for the overall cleaned query
          if (processedQuery.cleanedQuery) {
            queries.push([Occur.Should, new MatchQuery(processedQuery.cleanedQuery, 'content', { fuzziness: 1 })]);
          }

          const boolQuery = new BooleanQuery(queries);

          let ftsQuery = this.lanceTable
            .query()
            .fullTextSearch(boolQuery)
            .limit(limit * 2);

          if (filterByType) {
            ftsQuery = ftsQuery.where(`type = '${filterByType}'`);
          }

          const ftsResults = await ftsQuery.toArray();
          logger.debug(`[DocumentStore] Phrase-based FTS returned ${ftsResults.length} results`);

          if (ftsResults.length > 0) {
            // Combine with vector search for semantic relevance
            let vectorQuery = this.lanceTable.search(queryVector).limit(limit * 2);
            if (filterByType) {
              vectorQuery = vectorQuery.where(`type = '${filterByType}'`);
            }
            const vectorResults = await vectorQuery.toArray();

            const mergedResults = this.mergeAndRankResults(ftsResults, vectorResults, limit);
            const searchResults = this.formatSearchResults(mergedResults);

            this.searchCache.set(cacheKey, searchResults);
            return searchResults;
          }
        } catch (phraseError: any) {
          logger.debug('[DocumentStore] Phrase-based search failed:', phraseError.message);
        }
      }

      // Strategy 2: Standard hybrid search - FTS with fuzziness + vector search
      if (this.ftsIndexCreated) {
        try {
          // LanceDB's FTS already handles stop words and stemming
          // Add fuzziness for typo tolerance
          const matchQuery = new MatchQuery(processedQuery.cleanedQuery, 'content', { fuzziness: 1 });

          let ftsQuery = this.lanceTable
            .query()
            .fullTextSearch(matchQuery)
            .limit(limit * 2);

          if (filterByType) {
            ftsQuery = ftsQuery.where(`type = '${filterByType}'`);
          }

          const ftsResults = await ftsQuery.toArray();
          logger.debug(`[DocumentStore] FTS returned ${ftsResults.length} results`);

          // Always combine with vector search for best results
          let vectorQuery = this.lanceTable.search(queryVector).limit(limit * 2);
          if (filterByType) {
            vectorQuery = vectorQuery.where(`type = '${filterByType}'`);
          }
          const vectorResults = await vectorQuery.toArray();
          logger.debug(`[DocumentStore] Vector search returned ${vectorResults.length} results`);

          // Merge using RRF even if one is empty - ensures we get results
          const mergedResults = this.mergeAndRankResults(ftsResults, vectorResults, limit);
          if (mergedResults.length > 0) {
            const searchResults = this.formatSearchResults(mergedResults);
            this.searchCache.set(cacheKey, searchResults);
            return searchResults;
          }
        } catch (ftsError: any) {
          logger.debug('[DocumentStore] FTS search failed, falling back to vector search:', ftsError.message);
        }
      }

      // Strategy 3: Fallback to pure vector search (semantic similarity)
      logger.debug('[DocumentStore] Falling back to pure vector search');
      const results = await this.searchDocuments(queryVector, options);
      this.searchCache.set(cacheKey, results);
      return results;
    } catch (error) {
      logger.error('[DocumentStore] Error searching documents by text:', error);
      throw error;
    }
  }

  /**
   * Merge FTS and vector results using Reciprocal Rank Fusion (RRF)
   */
  private mergeAndRankResults(ftsResults: any[], vectorResults: any[], limit: number): any[] {
    const k = 60; // RRF constant
    const scores = new Map<string, { result: any; score: number }>();

    // Score FTS results
    ftsResults.forEach((result, rank) => {
      const key = `${result.url}:${result.path}:${result.startLine}`;
      const rrfScore = 1 / (k + rank + 1);
      scores.set(key, { result, score: rrfScore });
    });

    // Add/combine vector results
    vectorResults.forEach((result, rank) => {
      const key = `${result.url}:${result.path}:${result.startLine}`;
      const rrfScore = 1 / (k + rank + 1);

      if (scores.has(key)) {
        // Combine scores if result appears in both
        const existing = scores.get(key)!;
        existing.score += rrfScore;
      } else {
        scores.set(key, { result, score: rrfScore });
      }
    });

    // Sort by combined RRF score and return top results
    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => ({ ...item.result, _rrfScore: item.score }));
  }

  /**
   * Format raw LanceDB results into SearchResult objects
   */
  private formatSearchResults(results: any[]): SearchResult[] {
    return results.map((result: any) => {
      let codeBlocks, props;
      try { codeBlocks = result.codeBlocks ? JSON.parse(result.codeBlocks) : undefined; } catch { codeBlocks = undefined; }
      try { props = result.props ? JSON.parse(result.props) : undefined; } catch { props = undefined; }

      return {
        id: String(result.url),
        content: String(result.content),
        url: String(result.url),
        title: String(result.title),
        score: result._rrfScore ?? (result._distance != null ? 1 - result._distance : (result._score ?? null)),
        metadata: {
          type: (result.type || 'overview') as 'overview' | 'api' | 'example' | 'usage',
          path: String(result.path),
          lastUpdated: new Date(result.lastUpdated ? String(result.lastUpdated) : Date.now()),
          version: result.version as string | undefined,
          framework: result.framework as string | undefined,
          language: result.language as string | undefined,
          codeBlocks,
          props
        }
      };
    });
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

      // Get a sample row using a query
      const sample = await this.lanceTable.query().limit(1).toArray();
      if (sample.length === 0) {
        logger.debug('[DocumentStore] Vector validation: No rows returned from query');
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

      const searchResults = await this.lanceTable.search(testVector).limit(1).toArray();
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
