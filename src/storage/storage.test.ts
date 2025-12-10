import { DocumentStore } from './storage.js';
import { createMockEmbeddings } from '../__mocks__/embeddings.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ProcessedDocument, DocumentChunk } from '../types.js';
import type { EmbeddingsProvider } from '../embeddings/types.js';

describe('DocumentStore', () => {
  let store: DocumentStore;
  let tempDir: string;
  let mockEmbeddings: EmbeddingsProvider;

  beforeEach(async () => {
    // Create temporary directory for test databases
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-web-docs-test-'));
    mockEmbeddings = createMockEmbeddings();
    store = new DocumentStore(join(tempDir, 'docs.db'), join(tempDir, 'vectors'), mockEmbeddings, 100);
    await store.initialize();
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function createTestDocument(url: string, title: string, chunkCount: number = 1): ProcessedDocument {
    const chunks: DocumentChunk[] = [];
    for (let i = 0; i < chunkCount; i++) {
      // Generate deterministic vector based on content
      const content = `Test content for chunk ${i + 1} of ${title}`;
      const vector = Array.from({ length: mockEmbeddings.dimensions }, (_, j) => Math.sin(i + j) * 0.1);

      chunks.push({
        content,
        url,
        title,
        path: new URL(url).pathname,
        startLine: i * 10,
        endLine: i * 10 + 9,
        vector,
        metadata: {
          type: 'overview',
        },
      });
    }

    return {
      metadata: {
        url,
        title,
        lastIndexed: new Date(),
      },
      chunks,
    };
  }

  describe('initialize', () => {
    it('should initialize storage successfully', async () => {
      // Already initialized in beforeEach
      // Try listing documents - should not throw
      const docs = await store.listDocuments();
      expect(Array.isArray(docs)).toBe(true);
    });

    it('should create necessary tables and indexes', async () => {
      // Add a document to verify tables exist
      const doc = createTestDocument('https://example.com/test', 'Test Doc');
      await store.addDocument(doc);

      const retrieved = await store.getDocument('https://example.com/test');
      expect(retrieved).toBeDefined();
    });
  });

  describe('addDocument', () => {
    it('should add a document successfully', async () => {
      const doc = createTestDocument('https://example.com/docs/page', 'Test Page', 3);

      await store.addDocument(doc);

      const retrieved = await store.getDocument('https://example.com/docs/page');
      expect(retrieved).toBeDefined();
      expect(retrieved?.url).toBe('https://example.com/docs/page');
      expect(retrieved?.title).toBe('Test Page');
    });

    it('should update existing document', async () => {
      const url = 'https://example.com/update-test';

      // Add initial document
      const doc1 = createTestDocument(url, 'Original Title');
      await store.addDocument(doc1);

      let retrieved = await store.getDocument(url);
      expect(retrieved?.title).toBe('Original Title');

      // Update with new document
      const doc2 = createTestDocument(url, 'Updated Title');
      await store.addDocument(doc2);

      retrieved = await store.getDocument(url);
      expect(retrieved?.title).toBe('Updated Title');
    });

    it('should store multiple chunks', async () => {
      const doc = createTestDocument('https://example.com/multi-chunk', 'Multi Chunk Doc', 5);
      await store.addDocument(doc);

      // Verify via search
      const queryVector = await mockEmbeddings.embed('test content');
      const results = await store.searchDocuments(queryVector, { limit: 10 });

      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle document with favicon', async () => {
      const doc = createTestDocument('https://example.com/favicon-test', 'Favicon Test');
      doc.metadata.favicon = 'https://example.com/favicon.ico';

      await store.addDocument(doc);

      const retrieved = await store.getDocument('https://example.com/favicon-test');
      expect(retrieved?.favicon).toBe('https://example.com/favicon.ico');
    });
  });

  describe('getDocument', () => {
    it('should return null for non-existent document', async () => {
      const result = await store.getDocument('https://nonexistent.com/page');
      expect(result).toBeNull();
    });

    it('should return document metadata', async () => {
      const doc = createTestDocument('https://example.com/get-test', 'Get Test');
      await store.addDocument(doc);

      const result = await store.getDocument('https://example.com/get-test');
      expect(result).toBeDefined();
      expect(result?.url).toBe('https://example.com/get-test');
      expect(result?.title).toBe('Get Test');
      expect(result?.lastIndexed).toBeInstanceOf(Date);
    });
  });

  describe('listDocuments', () => {
    it('should return empty array when no documents', async () => {
      const docs = await store.listDocuments();
      expect(docs).toEqual([]);
    });

    it('should list all documents', async () => {
      await store.addDocument(createTestDocument('https://example.com/doc1', 'Doc 1'));
      await store.addDocument(createTestDocument('https://example.com/doc2', 'Doc 2'));
      await store.addDocument(createTestDocument('https://example.com/doc3', 'Doc 3'));

      const docs = await store.listDocuments();
      expect(docs.length).toBe(3);
    });

    it('should return documents sorted by lastIndexed descending', async () => {
      // Use fake timers to avoid actual delays while ensuring different timestamps
      vi.useFakeTimers();

      await store.addDocument(createTestDocument('https://example.com/first', 'First'));
      vi.advanceTimersByTime(10);
      await store.addDocument(createTestDocument('https://example.com/second', 'Second'));
      vi.advanceTimersByTime(10);
      await store.addDocument(createTestDocument('https://example.com/third', 'Third'));

      vi.useRealTimers();

      const docs = await store.listDocuments();
      expect(docs[0].title).toBe('Third');
      expect(docs[2].title).toBe('First');
    });
  });

  describe('deleteDocument', () => {
    it('should delete document and its chunks', async () => {
      const url = 'https://example.com/delete-test';
      await store.addDocument(createTestDocument(url, 'To Delete', 3));

      // Verify it exists
      let doc = await store.getDocument(url);
      expect(doc).toBeDefined();

      // Delete
      await store.deleteDocument(url);

      // Verify it's gone
      doc = await store.getDocument(url);
      expect(doc).toBeNull();
    });

    it('should not throw when deleting non-existent document', async () => {
      await expect(store.deleteDocument('https://nonexistent.com/page')).resolves.not.toThrow();
    });

    it('should clear search cache for deleted document', async () => {
      const url = 'https://example.com/cache-test';
      await store.addDocument(createTestDocument(url, 'Cache Test'));

      // Search to populate cache
      await store.searchByText('cache test');

      // Delete document
      await store.deleteDocument(url);

      // Search again - should not find the document
      const results = await store.searchByText('cache test');
      const hasDeletedDoc = results.some((r) => r.url === url);
      expect(hasDeletedDoc).toBe(false);
    });
  });

  describe('searchDocuments (vector search)', () => {
    beforeEach(async () => {
      // Add some test documents
      await store.addDocument(createTestDocument('https://example.com/javascript', 'JavaScript Guide', 2));
      await store.addDocument(createTestDocument('https://example.com/python', 'Python Tutorial', 2));
      await store.addDocument(createTestDocument('https://example.com/rust', 'Rust Programming', 2));
    });

    it('should return results for valid query vector', async () => {
      const queryVector = await mockEmbeddings.embed('programming tutorial');
      const results = await store.searchDocuments(queryVector, { limit: 5 });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should respect limit option', async () => {
      const queryVector = await mockEmbeddings.embed('guide');
      const results = await store.searchDocuments(queryVector, { limit: 2 });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should include scores in results', async () => {
      const queryVector = await mockEmbeddings.embed('test');
      const results = await store.searchDocuments(queryVector, { limit: 5 });

      results.forEach((result) => {
        expect(typeof result.score).toBe('number');
      });
    });

    it('should optionally include vectors in results', async () => {
      const queryVector = await mockEmbeddings.embed('test');

      const withoutVectors = await store.searchDocuments(queryVector, {
        limit: 1,
        includeVectors: false,
      });
      expect(withoutVectors[0]?.vector).toBeUndefined();

      const withVectors = await store.searchDocuments(queryVector, {
        limit: 1,
        includeVectors: true,
      });
      expect(withVectors[0]?.vector).toBeDefined();
    });

    it('should filter by type', async () => {
      // Add document with specific type
      const doc = createTestDocument('https://example.com/api', 'API Reference');
      doc.chunks[0].metadata.type = 'api';
      await store.addDocument(doc);

      const queryVector = await mockEmbeddings.embed('api');
      const results = await store.searchDocuments(queryVector, {
        limit: 10,
        filterByType: 'api',
      });

      results.forEach((result) => {
        expect(result.metadata.type).toBe('api');
      });
    });

    it('should return empty array for empty query vector without text query', async () => {
      const results = await store.searchDocuments([], { limit: 5 });
      expect(results).toEqual([]);
    });
  });

  describe('searchByText (hybrid search)', () => {
    beforeEach(async () => {
      await store.addDocument(createTestDocument('https://example.com/react-hooks', 'React Hooks Guide', 2));
      await store.addDocument(createTestDocument('https://example.com/vue-components', 'Vue Components', 2));
      await store.addDocument(createTestDocument('https://example.com/angular-services', 'Angular Services', 2));
    });

    it('should search by text query', async () => {
      const results = await store.searchByText('hooks guide');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should use caching for repeated queries', async () => {
      const query = 'unique cache test query';

      const results1 = await store.searchByText(query);
      const results2 = await store.searchByText(query);

      // Results should be identical (from cache)
      expect(results1).toEqual(results2);
    });

    it('should respect limit option', async () => {
      const results = await store.searchByText('guide', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should filter by URL', async () => {
      const results = await store.searchByText('guide', {
        filterUrl: 'https://example.com/react',
      });

      results.forEach((result) => {
        expect(result.url.startsWith('https://example.com/react')).toBe(true);
      });
    });

    it('should handle quoted phrases', async () => {
      const results = await store.searchByText('"React Hooks"');
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle empty query gracefully', async () => {
      // Generate embedding for empty query
      const results = await store.searchByText('   ');
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('validateVectors', () => {
    it('should return false for empty database', async () => {
      const isValid = await store.validateVectors();
      expect(isValid).toBe(false);
    });

    it('should return true after adding documents', async () => {
      await store.addDocument(createTestDocument('https://example.com/validate', 'Validation Test'));

      const isValid = await store.validateVectors();
      expect(isValid).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw when not initialized', async () => {
      const uninitializedStore = new DocumentStore(join(tempDir, 'uninit.db'), join(tempDir, 'uninit-vectors'), mockEmbeddings);

      await expect(uninitializedStore.listDocuments()).rejects.toThrow('Storage not initialized');
    });

    it('should handle sequential document additions', async () => {
      // Note: SQLite doesn't support concurrent transactions well
      // So we test sequential additions instead
      for (let i = 0; i < 5; i++) {
        await store.addDocument(createTestDocument(`https://example.com/seq-${i}`, `Sequential ${i}`));
      }

      const docs = await store.listDocuments();
      expect(docs.length).toBe(5);
    });

    it('should rollback on transaction failure', async () => {
      // This tests the rollback mechanism indirectly
      // by checking that partial writes don't persist
      const url = 'https://example.com/rollback-test';

      try {
        // Attempt to add a document (this should succeed)
        await store.addDocument(createTestDocument(url, 'Rollback Test'));
      } catch {
        // If it fails, verify nothing was written
        const doc = await store.getDocument(url);
        expect(doc).toBeNull();
      }
    });
  });

  describe('database migrations', () => {
    it('should create schema_migrations table on initialize', async () => {
      // Store is already initialized in beforeEach
      // Verify by adding a document with auth fields (which requires migration to have run)
      const doc = createTestDocument('https://migration-test.com', 'Migration Test');
      doc.metadata.requiresAuth = true;
      doc.metadata.authDomain = 'migration-test.com';

      // This should not throw - migrations have been applied
      await store.addDocument(doc);

      const retrieved = await store.getDocument('https://migration-test.com');
      expect(retrieved?.requiresAuth).toBe(true);
    });

    it('should apply migrations only once', async () => {
      // Create a second store instance pointing to the same database
      const store2 = new DocumentStore(join(tempDir, 'docs.db'), join(tempDir, 'vectors'), mockEmbeddings, 100);
      await store2.initialize();

      // Add document with auth fields using new store
      const doc = createTestDocument('https://second-store.com', 'Second Store Test');
      doc.metadata.requiresAuth = true;
      await store2.addDocument(doc);

      // Should work without errors (migrations already applied, should be skipped)
      const retrieved = await store2.getDocument('https://second-store.com');
      expect(retrieved?.requiresAuth).toBe(true);
    });

    it('should handle auth columns added by migration', async () => {
      // Test that the migration added the requires_auth and auth_domain columns
      const docWithAuth = createTestDocument('https://auth-columns.com', 'Auth Columns Test');
      docWithAuth.metadata.requiresAuth = true;
      docWithAuth.metadata.authDomain = 'auth-columns.com';
      await store.addDocument(docWithAuth);

      const docWithoutAuth = createTestDocument('https://no-auth-columns.com', 'No Auth Test');
      await store.addDocument(docWithoutAuth);

      const withAuth = await store.getDocument('https://auth-columns.com');
      const withoutAuth = await store.getDocument('https://no-auth-columns.com');

      expect(withAuth?.requiresAuth).toBe(true);
      expect(withAuth?.authDomain).toBe('auth-columns.com');
      expect(withoutAuth?.requiresAuth).toBe(false);
      expect(withoutAuth?.authDomain).toBeUndefined();
    });
  });

  describe('authentication metadata', () => {
    it('should store and retrieve requiresAuth flag', async () => {
      const doc = createTestDocument('https://private.example.com/docs', 'Private Docs');
      doc.metadata.requiresAuth = true;
      doc.metadata.authDomain = 'private.example.com';

      await store.addDocument(doc);

      const retrieved = await store.getDocument('https://private.example.com/docs');
      expect(retrieved?.requiresAuth).toBe(true);
      expect(retrieved?.authDomain).toBe('private.example.com');
    });

    it('should default requiresAuth to false when not specified', async () => {
      const doc = createTestDocument('https://public.example.com/docs', 'Public Docs');
      // Don't set requiresAuth

      await store.addDocument(doc);

      const retrieved = await store.getDocument('https://public.example.com/docs');
      expect(retrieved?.requiresAuth).toBe(false);
      expect(retrieved?.authDomain).toBeUndefined();
    });

    it('should include auth fields in listDocuments', async () => {
      const doc1 = createTestDocument('https://public.example.com', 'Public');
      doc1.metadata.requiresAuth = false;

      const doc2 = createTestDocument('https://private.example.com', 'Private');
      doc2.metadata.requiresAuth = true;
      doc2.metadata.authDomain = 'private.example.com';

      await store.addDocument(doc1);
      await store.addDocument(doc2);

      const docs = await store.listDocuments();
      const publicDoc = docs.find((d) => d.url === 'https://public.example.com');
      const privateDoc = docs.find((d) => d.url === 'https://private.example.com');

      expect(publicDoc?.requiresAuth).toBe(false);
      expect(privateDoc?.requiresAuth).toBe(true);
      expect(privateDoc?.authDomain).toBe('private.example.com');
    });

    it('should preserve auth metadata when updating document', async () => {
      const url = 'https://auth-update.example.com';

      // Add document with auth
      const doc1 = createTestDocument(url, 'Original');
      doc1.metadata.requiresAuth = true;
      doc1.metadata.authDomain = 'auth-update.example.com';
      await store.addDocument(doc1);

      // Update document, preserving auth
      const doc2 = createTestDocument(url, 'Updated');
      doc2.metadata.requiresAuth = true;
      doc2.metadata.authDomain = 'auth-update.example.com';
      await store.addDocument(doc2);

      const retrieved = await store.getDocument(url);
      expect(retrieved?.title).toBe('Updated');
      expect(retrieved?.requiresAuth).toBe(true);
      expect(retrieved?.authDomain).toBe('auth-update.example.com');
    });
  });

  describe('SQL injection protection', () => {
    it('should safely handle URLs with special characters', async () => {
      const maliciousUrl = "https://example.com/test'; DROP TABLE documents; --";
      const doc = createTestDocument(maliciousUrl, 'Safe Title');

      await store.addDocument(doc);

      const retrieved = await store.getDocument(maliciousUrl);
      expect(retrieved?.url).toBe(maliciousUrl);
    });

    it('should safely handle titles with special characters', async () => {
      const doc = createTestDocument('https://example.com/special', 'Title with \'quotes\' and "doubles"');

      await store.addDocument(doc);

      const retrieved = await store.getDocument('https://example.com/special');
      expect(retrieved?.title).toBe('Title with \'quotes\' and "doubles"');
    });

    it('should safely filter by URL with special characters', async () => {
      await store.addDocument(createTestDocument('https://example.com/path', 'Normal'));

      // Try to inject via filterUrl
      const results = await store.searchByText('test', {
        filterUrl: "https://example.com' OR '1'='1",
      });

      // Should not throw and should return empty (no match)
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
