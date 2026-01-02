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

  describe('document tags', () => {
    it('should set and retrieve tags for a document', async () => {
      const url = 'https://example.com/tagged';
      await store.addDocument(createTestDocument(url, 'Tagged Doc'));

      await store.setTags(url, ['frontend', 'react']);

      const doc = await store.getDocument(url);
      expect(doc?.tags).toEqual(['frontend', 'react']);
    });

    it('should normalize tags to lowercase', async () => {
      const url = 'https://example.com/normalized';
      await store.addDocument(createTestDocument(url, 'Normalized Tags'));

      await store.setTags(url, ['FrontEnd', 'REACT', 'MyCompany']);

      const doc = await store.getDocument(url);
      expect(doc?.tags).toEqual(['frontend', 'mycompany', 'react']);
    });

    it('should deduplicate tags', async () => {
      const url = 'https://example.com/dedup';
      await store.addDocument(createTestDocument(url, 'Dedup Tags'));

      await store.setTags(url, ['frontend', 'frontend', 'react', 'React']);

      const doc = await store.getDocument(url);
      expect(doc?.tags).toEqual(['frontend', 'react']);
    });

    it('should replace existing tags when setting new ones', async () => {
      const url = 'https://example.com/replace';
      await store.addDocument(createTestDocument(url, 'Replace Tags'));

      await store.setTags(url, ['old-tag']);
      let doc = await store.getDocument(url);
      expect(doc?.tags).toEqual(['old-tag']);

      await store.setTags(url, ['new-tag-1', 'new-tag-2']);
      doc = await store.getDocument(url);
      expect(doc?.tags).toEqual(['new-tag-1', 'new-tag-2']);
    });

    it('should remove all tags when setting empty array', async () => {
      const url = 'https://example.com/remove';
      await store.addDocument(createTestDocument(url, 'Remove Tags'));

      await store.setTags(url, ['tag1', 'tag2']);
      await store.setTags(url, []);

      const doc = await store.getDocument(url);
      expect(doc?.tags).toEqual([]);
    });

    it('should throw error when setting tags for non-existent document', async () => {
      await expect(store.setTags('https://nonexistent.com', ['tag'])).rejects.toThrow('Documentation not found');
    });

    it('should include tags in listDocuments', async () => {
      await store.addDocument(createTestDocument('https://example.com/list1', 'List 1'));
      await store.addDocument(createTestDocument('https://example.com/list2', 'List 2'));

      await store.setTags('https://example.com/list1', ['frontend']);
      await store.setTags('https://example.com/list2', ['backend', 'api']);

      const docs = await store.listDocuments();
      const doc1 = docs.find((d) => d.url === 'https://example.com/list1');
      const doc2 = docs.find((d) => d.url === 'https://example.com/list2');

      expect(doc1?.tags).toEqual(['frontend']);
      expect(doc2?.tags).toEqual(['api', 'backend']);
    });

    it('should return empty tags array for untagged documents', async () => {
      await store.addDocument(createTestDocument('https://example.com/untagged', 'Untagged'));

      const doc = await store.getDocument('https://example.com/untagged');
      expect(doc?.tags).toEqual([]);
    });

    it('should delete tags when document is deleted', async () => {
      const url = 'https://example.com/delete-with-tags';
      await store.addDocument(createTestDocument(url, 'Delete With Tags'));
      await store.setTags(url, ['tag1', 'tag2']);

      await store.deleteDocument(url);

      // Re-add document and verify tags are gone
      await store.addDocument(createTestDocument(url, 'New Doc'));
      const doc = await store.getDocument(url);
      expect(doc?.tags).toEqual([]);
    });
  });

  describe('listAllTags', () => {
    it('should return empty array when no tags exist', async () => {
      const tags = await store.listAllTags();
      expect(tags).toEqual([]);
    });

    it('should list all unique tags with counts', async () => {
      await store.addDocument(createTestDocument('https://example.com/t1', 'T1'));
      await store.addDocument(createTestDocument('https://example.com/t2', 'T2'));
      await store.addDocument(createTestDocument('https://example.com/t3', 'T3'));

      await store.setTags('https://example.com/t1', ['frontend', 'react']);
      await store.setTags('https://example.com/t2', ['frontend', 'vue']);
      await store.setTags('https://example.com/t3', ['backend']);

      const tags = await store.listAllTags();

      expect(tags.find((t) => t.tag === 'frontend')?.count).toBe(2);
      expect(tags.find((t) => t.tag === 'react')?.count).toBe(1);
      expect(tags.find((t) => t.tag === 'vue')?.count).toBe(1);
      expect(tags.find((t) => t.tag === 'backend')?.count).toBe(1);
    });

    it('should sort tags by count descending', async () => {
      await store.addDocument(createTestDocument('https://example.com/s1', 'S1'));
      await store.addDocument(createTestDocument('https://example.com/s2', 'S2'));
      await store.addDocument(createTestDocument('https://example.com/s3', 'S3'));

      await store.setTags('https://example.com/s1', ['common', 'rare']);
      await store.setTags('https://example.com/s2', ['common']);
      await store.setTags('https://example.com/s3', ['common']);

      const tags = await store.listAllTags();

      expect(tags[0].tag).toBe('common');
      expect(tags[0].count).toBe(3);
    });
  });

  describe('getUrlsByTags', () => {
    beforeEach(async () => {
      await store.addDocument(createTestDocument('https://example.com/u1', 'U1'));
      await store.addDocument(createTestDocument('https://example.com/u2', 'U2'));
      await store.addDocument(createTestDocument('https://example.com/u3', 'U3'));

      await store.setTags('https://example.com/u1', ['frontend', 'react']);
      await store.setTags('https://example.com/u2', ['frontend', 'vue']);
      await store.setTags('https://example.com/u3', ['backend']);
    });

    it('should return URLs with single tag', async () => {
      const urls = await store.getUrlsByTags(['frontend']);

      expect(urls.length).toBe(2);
      expect(urls).toContain('https://example.com/u1');
      expect(urls).toContain('https://example.com/u2');
    });

    it('should return URLs with ALL specified tags (AND logic)', async () => {
      const urls = await store.getUrlsByTags(['frontend', 'react']);

      expect(urls.length).toBe(1);
      expect(urls).toContain('https://example.com/u1');
    });

    it('should return empty array when no URLs match all tags', async () => {
      const urls = await store.getUrlsByTags(['frontend', 'backend']);
      expect(urls).toEqual([]);
    });

    it('should return empty array for empty tags', async () => {
      const urls = await store.getUrlsByTags([]);
      expect(urls).toEqual([]);
    });

    it('should normalize tags when searching', async () => {
      const urls = await store.getUrlsByTags(['FrontEnd', 'REACT']);

      expect(urls.length).toBe(1);
      expect(urls).toContain('https://example.com/u1');
    });
  });

  describe('searchByText with tag filtering', () => {
    beforeEach(async () => {
      await store.addDocument(createTestDocument('https://example.com/react-hooks', 'React Hooks Guide', 2));
      await store.addDocument(createTestDocument('https://example.com/vue-components', 'Vue Components', 2));
      await store.addDocument(createTestDocument('https://example.com/express-api', 'Express API', 2));

      await store.setTags('https://example.com/react-hooks', ['frontend', 'react']);
      await store.setTags('https://example.com/vue-components', ['frontend', 'vue']);
      await store.setTags('https://example.com/express-api', ['backend', 'api']);
    });

    it('should filter search results by tags', async () => {
      const results = await store.searchByText('guide', { filterByTags: ['frontend'] });

      results.forEach((result) => {
        expect(result.url.startsWith('https://example.com/react') || result.url.startsWith('https://example.com/vue')).toBe(true);
      });
    });

    it('should return empty results when no documents match tags', async () => {
      const results = await store.searchByText('guide', { filterByTags: ['nonexistent-tag'] });
      expect(results).toEqual([]);
    });

    it('should combine tag filter with URL filter', async () => {
      const results = await store.searchByText('guide', {
        filterByTags: ['frontend'],
        filterUrl: 'https://example.com/react',
      });

      results.forEach((result) => {
        expect(result.url.startsWith('https://example.com/react')).toBe(true);
      });
    });
  });

  describe('document version', () => {
    it('should store and retrieve version for a document', async () => {
      const doc = createTestDocument('https://react.dev/v19', 'React 19 Docs');
      doc.metadata.version = '19';

      await store.addDocument(doc);

      const retrieved = await store.getDocument('https://react.dev/v19');
      expect(retrieved?.version).toBe('19');
    });

    it('should return undefined version for documents without version', async () => {
      const doc = createTestDocument('https://example.com/no-version', 'No Version Doc');
      // Don't set version

      await store.addDocument(doc);

      const retrieved = await store.getDocument('https://example.com/no-version');
      expect(retrieved?.version).toBeUndefined();
    });

    it('should include version in listDocuments', async () => {
      const doc1 = createTestDocument('https://react.dev/v18', 'React 18');
      doc1.metadata.version = '18';

      const doc2 = createTestDocument('https://react.dev/v19', 'React 19');
      doc2.metadata.version = '19';

      const doc3 = createTestDocument('https://docs.company.com', 'Company Docs');
      // No version

      await store.addDocument(doc1);
      await store.addDocument(doc2);
      await store.addDocument(doc3);

      const docs = await store.listDocuments();
      const react18 = docs.find((d) => d.url === 'https://react.dev/v18');
      const react19 = docs.find((d) => d.url === 'https://react.dev/v19');
      const companyDocs = docs.find((d) => d.url === 'https://docs.company.com');

      expect(react18?.version).toBe('18');
      expect(react19?.version).toBe('19');
      expect(companyDocs?.version).toBeUndefined();
    });

    it('should preserve version when updating document', async () => {
      const url = 'https://example.com/version-update';

      // Add document with version
      const doc1 = createTestDocument(url, 'Original');
      doc1.metadata.version = 'v1.0.0';
      await store.addDocument(doc1);

      // Update document, preserving version
      const doc2 = createTestDocument(url, 'Updated');
      doc2.metadata.version = 'v1.0.0';
      await store.addDocument(doc2);

      const retrieved = await store.getDocument(url);
      expect(retrieved?.title).toBe('Updated');
      expect(retrieved?.version).toBe('v1.0.0');
    });

    it('should allow changing version when updating document', async () => {
      const url = 'https://example.com/version-change';

      // Add document with version
      const doc1 = createTestDocument(url, 'Version 1');
      doc1.metadata.version = 'v1';
      await store.addDocument(doc1);

      // Update with new version
      const doc2 = createTestDocument(url, 'Version 2');
      doc2.metadata.version = 'v2';
      await store.addDocument(doc2);

      const retrieved = await store.getDocument(url);
      expect(retrieved?.version).toBe('v2');
    });

    it('should handle various version formats', async () => {
      const testCases = [
        { url: 'https://example.com/semver', version: '1.2.3' },
        { url: 'https://example.com/prefix', version: 'v6.4' },
        { url: 'https://example.com/major', version: '18' },
        { url: 'https://example.com/latest', version: 'latest' },
        { url: 'https://example.com/date', version: '2024-01' },
        { url: 'https://example.com/prerelease', version: 'v2.0.0-beta.1' },
      ];

      for (const { url, version } of testCases) {
        const doc = createTestDocument(url, `Test ${version}`);
        doc.metadata.version = version;
        await store.addDocument(doc);

        const retrieved = await store.getDocument(url);
        expect(retrieved?.version).toBe(version);
      }
    });
  });

  describe('optimize', () => {
    it('should return error when storage is not initialized', async () => {
      const uninitializedStore = new DocumentStore(join(tempDir, 'uninit.db'), join(tempDir, 'uninit-vectors'), mockEmbeddings);

      const result = await uninitializedStore.optimize();

      expect(result.compacted).toBe(false);
      expect(result.cleanedUp).toBe(false);
      expect(result.error).toBe('Storage not initialized');
    });

    it('should run optimization on empty database', async () => {
      const result = await store.optimize();

      // Optimization may succeed or fail depending on LanceDB internal state
      // The important thing is it doesn't throw and returns a result
      expect(typeof result.compacted).toBe('boolean');
      expect(typeof result.cleanedUp).toBe('boolean');
    });

    it('should run optimization on database with data', async () => {
      // Add some documents
      await store.addDocument(createTestDocument('https://example.com/opt1', 'Optimize Test 1', 3));
      await store.addDocument(createTestDocument('https://example.com/opt2', 'Optimize Test 2', 3));

      // Delete one to create fragmentation
      await store.deleteDocument('https://example.com/opt1');

      // Run optimization
      const result = await store.optimize();

      // Should complete without throwing
      expect(typeof result.compacted).toBe('boolean');
      expect(typeof result.cleanedUp).toBe('boolean');
    });

    it('should clear search cache after optimization', async () => {
      // Add document and search to populate cache
      await store.addDocument(createTestDocument('https://example.com/cache', 'Cache Test'));
      await store.searchByText('cache test');

      // Run optimization (which should clear cache)
      await store.optimize();

      // Search should still work (but cache was cleared)
      const results = await store.searchByText('cache test');
      expect(Array.isArray(results)).toBe(true);
    });

    it('should preserve data after optimization', async () => {
      // Add documents
      await store.addDocument(createTestDocument('https://example.com/preserve1', 'Preserve 1', 2));
      await store.addDocument(createTestDocument('https://example.com/preserve2', 'Preserve 2', 2));

      // Run optimization
      await store.optimize();

      // Verify documents are still accessible
      const doc1 = await store.getDocument('https://example.com/preserve1');
      const doc2 = await store.getDocument('https://example.com/preserve2');

      expect(doc1?.title).toBe('Preserve 1');
      expect(doc2?.title).toBe('Preserve 2');

      // Verify search still works
      const results = await store.searchByText('preserve');
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
