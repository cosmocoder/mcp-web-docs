import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import lancedb, { Connection, Table } from 'vectordb';
import QuickLRU from 'quick-lru';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { DocumentMetadata, ProcessedDocument, SearchResult, StorageProvider } from '../types.js';
import { EmbeddingsProvider } from '../embeddings/types.js';

type LanceDbRow = Record<string, unknown> & {
  url: string;
  title: string;
  content: string;
  path: string;
  startLine: number;
  endLine: number;
  vector: number[];
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
    console.debug(`[DocumentStore] Initializing with paths:`, {
      dbPath,
      vectorDbPath,
      maxCacheSize
    });
    this.searchCache = new QuickLRU({ maxSize: maxCacheSize });
  }

  async initialize(): Promise<void> {
    console.debug(`[DocumentStore] Starting initialization with paths:`, {
      dbPath: this.dbPath,
      vectorDbPath: this.vectorDbPath
    });

    try {
      // Create directories with error handling
      try {
        console.debug(`[DocumentStore] Creating SQLite directory: ${dirname(this.dbPath)}`);
        await mkdir(dirname(this.dbPath), { recursive: true });
        console.debug(`[DocumentStore] Creating LanceDB directory: ${this.vectorDbPath}`);
        await mkdir(this.vectorDbPath, { recursive: true });
      } catch (error) {
        console.error('[DocumentStore] Error creating directories:', error);
        throw new Error(`Failed to create storage directories: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Initialize SQLite with error handling
      try {
        console.debug(`[DocumentStore] Opening SQLite database at ${this.dbPath}`);
        this.sqliteDb = await open({
          filename: this.dbPath,
          driver: sqlite3.Database
        });

        console.debug(`[DocumentStore] Configuring SQLite database`);
        await this.sqliteDb.exec('PRAGMA busy_timeout = 5000;');
        await this.sqliteDb.exec('PRAGMA journal_mode = WAL;');
      } catch (error) {
        console.error('[DocumentStore] Error initializing SQLite:', error);
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
        console.debug(`[DocumentStore] Connecting to LanceDB at ${this.vectorDbPath}`);
        this.lanceConn = await lancedb.connect(this.vectorDbPath);

        console.debug(`[DocumentStore] Getting table list`);
        const tableNames = await this.lanceConn.tableNames();
        console.debug(`[DocumentStore] Existing tables:`, tableNames);

        if (!tableNames.includes('chunks')) {
          console.debug(`[DocumentStore] Creating new chunks table with dimensions: ${this.embeddings.dimensions}`);
          // Create table with sample row to establish schema
          const sampleRow = [{
            url: '',
            title: '',
            content: '',
            path: '',
            startLine: 0,
            endLine: 0,
            vector: new Array(this.embeddings.dimensions).fill(0)
          }] as LanceDbRow[];

          this.lanceTable = await this.lanceConn.createTable('chunks', sampleRow);
          console.debug(`[DocumentStore] Removing sample row`);
          await this.lanceTable.delete("url = ''");
          console.debug(`[DocumentStore] New chunks table created successfully`);
        } else {
          console.debug(`[DocumentStore] Opening existing chunks table`);
          this.lanceTable = await this.lanceConn.openTable('chunks');

          // Verify table is accessible
          const rowCount = await this.lanceTable.countRows();
          console.debug(`[DocumentStore] Chunks table opened successfully, contains ${rowCount} rows`);
        }
      } catch (error) {
        console.error('[DocumentStore] Error initializing LanceDB:', error);
        throw new Error(`Failed to initialize LanceDB: ${error instanceof Error ? error.message : String(error)}`);
      }

      console.debug(`[DocumentStore] All storage components initialized successfully`);
    } catch (error) {
      console.error('[DocumentStore] Error initializing storage:', error);
      throw error;
    }
  }

  async addDocument(doc: ProcessedDocument): Promise<void> {
    console.debug(`[DocumentStore] Starting addDocument for:`, {
      url: doc.metadata.url,
      title: doc.metadata.title,
      chunks: doc.chunks.length
    });

    // Validate storage initialization
    if (!this.sqliteDb) {
      console.error('[DocumentStore] SQLite not initialized during addDocument');
      throw new Error('SQLite storage not initialized');
    }
    if (!this.lanceTable) {
      console.error('[DocumentStore] LanceDB not initialized during addDocument');
      throw new Error('LanceDB storage not initialized');
    }

    try {
      // Check if document already exists
      const existing = await this.getDocument(doc.metadata.url);
      if (existing) {
        console.debug(`[DocumentStore] Existing document found, will update:`, existing);
      }

      console.debug(`[DocumentStore] Starting SQLite transaction`);
      await this.sqliteDb.run('BEGIN TRANSACTION');

      // Add metadata to SQLite
      await this.sqliteDb.run(
        'INSERT OR REPLACE INTO documents (url, title, favicon, last_indexed) VALUES (?, ?, ?, ?)',
        [doc.metadata.url, doc.metadata.title, doc.metadata.favicon, doc.metadata.lastIndexed.toISOString()]
      );
      console.debug(`[DocumentStore] Added metadata to SQLite`);

      // Delete existing chunks for this document
      await this.lanceTable.delete(`url = '${doc.metadata.url}'`);
      console.debug(`[DocumentStore] Deleted existing chunks`);

      // Add new chunks to LanceDB
      const rows = doc.chunks.map(chunk => ({
        url: doc.metadata.url,
        title: doc.metadata.title,
        content: chunk.content,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        vector: chunk.vector
      })) as LanceDbRow[];

      console.debug(`[DocumentStore] Adding ${rows.length} chunks to LanceDB`);
      await this.lanceTable.add(rows);

      // Commit transaction
      await this.sqliteDb.run('COMMIT');
      console.debug(`[DocumentStore] Committed transaction`);

      // Clear search cache for this URL
      this.clearCacheForUrl(doc.metadata.url);
    } catch (error) {
      // Rollback on error
      if (this.sqliteDb) {
        await this.sqliteDb.run('ROLLBACK');
      }
      console.error('[DocumentStore] Error adding document:', error);
      throw error;
    }
  }

  async searchDocuments(query: string, limit: number = 10): Promise<SearchResult[]> {
    if (!this.lanceTable) {
      throw new Error('Storage not initialized');
    }

    console.debug(`[DocumentStore] Searching documents:`, { query, limit });

    const cacheKey = `${query}:${limit}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) {
      console.debug(`[DocumentStore] Returning cached results`);
      return cached;
    }

    try {
      const queryVector = await this.embeddings.embed(query);

      const results = await this.lanceTable
        .search(queryVector)
        .limit(limit)
        .execute();

      console.debug(`[DocumentStore] Found ${results.length} results`);

      const searchResults = results.map(result => ({
        content: String(result.content),
        url: String(result.url),
        title: String(result.title),
        score: Number(result.score)
      }));

      this.searchCache.set(cacheKey, searchResults);
      return searchResults;
    } catch (error) {
      console.error('[DocumentStore] Error searching documents:', error);
      throw error;
    }
  }

  async listDocuments(): Promise<DocumentMetadata[]> {
    if (!this.sqliteDb) {
      throw new Error('Storage not initialized');
    }

    console.debug(`[DocumentStore] Listing documents`);

    try {
      const rows = await this.sqliteDb.all<Array<{
        url: string;
        title: string;
        favicon: string | null;
        last_indexed: string;
      }>>('SELECT url, title, favicon, last_indexed FROM documents ORDER BY last_indexed DESC');

      console.debug(`[DocumentStore] Found ${rows.length} documents`);

      return rows.map(row => ({
        url: row.url,
        title: row.title,
        favicon: row.favicon ?? undefined,
        lastIndexed: new Date(row.last_indexed)
      }));
    } catch (error) {
      console.error('[DocumentStore] Error listing documents:', error);
      throw error;
    }
  }

  async deleteDocument(url: string): Promise<void> {
    if (!this.sqliteDb || !this.lanceTable) {
      throw new Error('Storage not initialized');
    }

    console.debug(`[DocumentStore] Deleting document: ${url}`);

    try {
      await this.sqliteDb.run('BEGIN TRANSACTION');

      await this.sqliteDb.run('DELETE FROM documents WHERE url = ?', [url]);
      await this.lanceTable.delete(`url = '${url}'`);

      await this.sqliteDb.run('COMMIT');

      // Clear cache for this URL
      this.clearCacheForUrl(url);
      console.debug(`[DocumentStore] Document deleted successfully`);
    } catch (error) {
      if (this.sqliteDb) {
        await this.sqliteDb.run('ROLLBACK');
      }
      console.error('[DocumentStore] Error deleting document:', error);
      throw error;
    }
  }

  async getDocument(url: string): Promise<DocumentMetadata | null> {
    if (!this.sqliteDb) {
      throw new Error('Storage not initialized');
    }

    console.debug(`[DocumentStore] Getting document: ${url}`);

    try {
      // Check if SQLite is properly initialized
      if (!this.sqliteDb) {
        console.error('[DocumentStore] SQLite not initialized during getDocument');
        throw new Error('Storage not initialized');
      }

      // Log the query being executed
      console.debug(`[DocumentStore] Executing SQLite query for URL: ${url}`);

      const row = await this.sqliteDb.get<{
        url: string;
        title: string;
        favicon: string | null;
        last_indexed: string;
      }>('SELECT url, title, favicon, last_indexed FROM documents WHERE url = ?', [url]);

      if (!row) {
        console.debug(`[DocumentStore] Document not found in SQLite: ${url}`);
        return null;
      }

      // Check if LanceDB has any chunks for this document
      if (this.lanceTable) {
        const chunks = await this.lanceTable.countRows(`url = '${url}'`);
        console.debug(`[DocumentStore] Found ${chunks} chunks in LanceDB for ${url}`);
      }

      console.debug(`[DocumentStore] Document found in SQLite:`, row);

      return {
        url: row.url,
        title: row.title,
        favicon: row.favicon ?? undefined,
        lastIndexed: new Date(row.last_indexed)
      };
    } catch (error) {
      console.error('[DocumentStore] Error getting document:', error);
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
}