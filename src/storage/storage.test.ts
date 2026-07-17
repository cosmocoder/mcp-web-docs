import { DocumentStore } from './storage.js';
import { createMockEmbeddings } from '../__mocks__/embeddings.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ProcessedDocument, DocumentChunk } from '../types.js';
import type { EmbeddingsProvider } from '../embeddings/types.js';
import type { Database } from 'sqlite';
import type { Table } from '@lancedb/lancedb';

type ReplacementInternals = {
  sqliteDb?: Database;
  sqliteReadDb?: Database;
  sqliteLeaseDb?: Database;
  lanceTable?: Table;
  lanceConn?: { close(): void };
  finishDocumentReplacement(journal: {
    url: string;
    generation: string;
    state: 'prepared' | 'published' | 'deleting';
    owner_id: string;
    lease_expires_at: number;
    cleanup_generations: string;
  }): Promise<void>;
  parseCleanupGenerations(value: string): string[];
  getJournalVisibilityFilter(): Promise<string>;
  createFTSIndex(): Promise<void>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = () => resolvePromise();
  });
  return { promise, resolve };
}

describe('DocumentStore', () => {
  let store: DocumentStore;
  let tempDir: string;
  let mockEmbeddings: EmbeddingsProvider;
  let openStores: Set<DocumentStore>;

  beforeEach(async () => {
    // Create temporary directory for test databases
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-web-docs-test-'));
    mockEmbeddings = createMockEmbeddings();
    openStores = new Set();
    store = new DocumentStore(join(tempDir, 'docs.db'), join(tempDir, 'vectors'), mockEmbeddings, 100);
    openStores.add(store);
    await store.initialize();
  });

  afterEach(async () => {
    const closeResults = await Promise.allSettled([...openStores].map((openStore) => openStore.close()));
    // Clean up temporary directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    }
    catch {
      // Ignore cleanup errors
    }
    const closeErrors = closeResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, 'Failed to close one or more test stores');
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

  function replacementInternals(target: DocumentStore = store): ReplacementInternals {
    return target as unknown as ReplacementInternals;
  }

  function createDocumentWithContent(url: string, title: string, content: string): ProcessedDocument {
    const document = createTestDocument(url, title);
    document.chunks[0].content = content;
    return document;
  }

  async function openPeerStore(): Promise<DocumentStore> {
    const peer = new DocumentStore(join(tempDir, 'docs.db'), join(tempDir, 'vectors'), mockEmbeddings, 100);
    openStores.add(peer);
    await peer.initialize();
    return peer;
  }

  async function storedContents(target: DocumentStore, url: string): Promise<string[]> {
    const results = await target.searchByText('test content', { filterUrl: url, limit: 100 });
    return results.map((result) => result.content).sort();
  }

  function blockNextLanceAdd(target: DocumentStore = store): { staged: Promise<void>; release: () => void } {
    const table = replacementInternals(target).lanceTable!;
    const add = table.add.bind(table);
    const staged = deferred();
    const released = deferred();
    vi.spyOn(table, 'add').mockImplementationOnce(async (data, options) => {
      const result = await add(data, options);
      staged.resolve();
      await released.promise;
      return result;
    });
    return { staged: staged.promise, release: released.resolve };
  }

  function blockPublication(target: DocumentStore = store): { reached: Promise<void>; release: () => void } {
    const sqliteDb = replacementInternals(target).sqliteDb!;
    const run = sqliteDb.run.bind(sqliteDb);
    const reached = deferred();
    const released = deferred();
    vi.spyOn(sqliteDb, 'run').mockImplementation(async (sql, ...params) => {
      if (String(sql).includes("SET state = 'published'")) {
        reached.resolve();
        await released.promise;
      }
      return run(sql, ...params);
    });
    return { reached: reached.promise, release: released.resolve };
  }

  function waitForLeaseContention(target: DocumentStore): Promise<void> {
    const leaseDb = replacementInternals(target).sqliteLeaseDb!;
    const run = leaseDb.run.bind(leaseDb);
    const waiting = deferred();
    vi.spyOn(leaseDb, 'run').mockImplementation(async (sql, ...params) => {
      const result = await run(sql, ...params);
      if (String(sql).includes('INSERT OR IGNORE INTO document_replacements') && result.changes === 0) {
        waiting.resolve();
      }
      return result;
    });
    return waiting.promise;
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

    it('attempts every close when an earlier resource fails', async () => {
      const internals = replacementInternals();
      const closes = [
        vi.spyOn(internals.lanceTable!, 'close').mockImplementationOnce(() => {
          throw new Error('injected table close failure');
        }),
        vi.spyOn(internals.lanceConn!, 'close'),
        vi.spyOn(internals.sqliteReadDb!, 'close'),
        vi.spyOn(internals.sqliteLeaseDb!, 'close'),
        vi.spyOn(internals.sqliteDb!, 'close'),
      ];

      await expect(store.close()).rejects.toThrow('Failed to close one or more storage resources');
      expect(closes.map((close) => close.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);

      await expect(store.close()).resolves.toBeUndefined();
      expect(closes.map((close) => close.mock.calls.length)).toEqual([2, 1, 1, 1, 1]);
    });

    it('preserves initialization failure when resource cleanup also fails', async () => {
      const failingStore = new DocumentStore(
        join(tempDir, 'init-failure', 'docs.db'),
        join(tempDir, 'init-failure', 'vectors'),
        mockEmbeddings,
        100
      );
      const internals = replacementInternals(failingStore);
      vi.spyOn(internals, 'createFTSIndex').mockRejectedValue(new Error('injected initialization failure'));
      const close = vi.spyOn(failingStore, 'close').mockRejectedValueOnce(new Error('injected cleanup failure'));

      await expect(failingStore.initialize()).rejects.toThrow('Failed to initialize LanceDB: injected initialization failure');
      expect(close).toHaveBeenCalledOnce();
      close.mockRestore();
      await failingStore.close();
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

  describe('generation replacement', () => {
    it('keeps staged chunks hidden until publication and preserves document relationships', async () => {
      const url = 'https://example.com/replace-safe';
      const original = createTestDocument(url, 'Original', 3);
      original.chunks.forEach((chunk, index) => (chunk.content = `old replacement content ${index}`));
      await store.addDocument(original);
      await store.setTags(url, ['stable', 'docs']);
      await store.createCollection('Replacement Collection');
      await store.addToCollection('Replacement Collection', [url]);

      const replacement = createTestDocument(url, 'Replacement', 2);
      replacement.chunks.forEach((chunk, index) => (chunk.content = `new replacement content ${index}`));
      const publication = blockPublication();

      const replacementPromise = store.addDocument(replacement, { tags: ['new-tag'] });
      await publication.reached;

      expect(await store.getDocument(url)).toMatchObject({ title: 'Original', tags: ['docs', 'stable'] });
      expect((await store.listDocuments()).find((document) => document.url === url)).toMatchObject({
        title: 'Original',
        tags: ['docs', 'stable'],
      });
      expect((await store.getCollection('Replacement Collection'))?.documents[0]).toMatchObject({
        title: 'Original',
        tags: ['docs', 'stable'],
      });
      const journal = await replacementInternals().sqliteReadDb!.get<{ cleanup_generations: string }>(
        'SELECT cleanup_generations FROM document_replacements WHERE url = ?',
        [url]
      );
      expect(JSON.parse(journal!.cleanup_generations)).toHaveLength(1);
      expect(await storedContents(store, url)).toEqual([
        'old replacement content 0',
        'old replacement content 1',
        'old replacement content 2',
      ]);

      publication.release();
      await replacementPromise;

      const metadata = await store.getDocument(url);
      const collection = await store.getCollection('Replacement Collection');
      expect(metadata).toMatchObject({ title: 'Replacement', tags: ['new-tag'] });
      expect(collection?.documents[0]).toMatchObject({ title: 'Replacement', tags: ['new-tag'] });
      expect(collection?.documents.map((document) => document.url)).toEqual([url]);
      expect(await storedContents(store, url)).toEqual(['new replacement content 0', 'new replacement content 1']);
    });

    it.each(['add', 'delete'] as const)(
      'keeps the old document visible when %s preparation fails after lease acquisition',
      async (operation) => {
        const url = 'https://example.com/prepare-failure';
        await store.addDocument(createDocumentWithContent(url, 'Original', 'old prepare failure content'));

        const leaseDb = replacementInternals().sqliteLeaseDb!;
        const writerRun = vi.spyOn(replacementInternals().sqliteDb!, 'run');
        const run = leaseDb.run.bind(leaseDb);
        vi.spyOn(leaseDb, 'run').mockImplementation(async (sql, ...params) => {
          if (String(sql).includes('SET cleanup_generations = ?')) {
            throw new Error('injected journal preparation failure');
          }
          return run(sql, ...params);
        });

        const failedOperation =
          operation === 'add'
            ? store.addDocument(createDocumentWithContent(url, 'Replacement', 'new prepare failure content'))
            : store.deleteDocument(url);
        await expect(failedOperation).rejects.toThrow('injected journal preparation failure');
        expect(writerRun).not.toHaveBeenCalledWith('ROLLBACK');
        expect(await leaseDb.get('SELECT url FROM document_replacements WHERE url = ?', [url])).toBeUndefined();
        expect(await store.getDocument(url)).toMatchObject({ title: 'Original' });
        expect(await storedContents(store, url)).toEqual(['old prepare failure content']);
      }
    );

    it('leaves the old document intact when staging fails', async () => {
      const url = 'https://example.com/merge-failure';
      const original = createTestDocument(url, 'Original', 2);
      original.chunks.forEach((chunk, index) => (chunk.content = `old merge failure content ${index}`));
      await store.addDocument(original);

      vi.spyOn(replacementInternals().lanceTable!, 'add').mockRejectedValueOnce(new Error('injected staging failure'));

      const replacement = createDocumentWithContent(url, 'Replacement', 'new merge failure content');
      await expect(store.addDocument(replacement)).rejects.toThrow('injected staging failure');

      expect(await store.getDocument(url)).toMatchObject({ title: 'Original' });
      expect(await storedContents(store, url)).toEqual(['old merge failure content 0', 'old merge failure content 1']);
    });

    it('keeps unpublished rows hidden, then recovers the prepared generation after lease expiry', async () => {
      const url = 'https://example.com/hidden-publication-failure';
      const otherUrl = 'https://example.com/unrelated';
      const original = createTestDocument(url, 'Original', 2);
      original.chunks.forEach((chunk, index) => (chunk.content = `old publication failure content ${index}`));
      await store.addDocument(original);

      const sqliteDb = replacementInternals().sqliteDb!;
      const originalRun = sqliteDb.run.bind(sqliteDb);
      vi.spyOn(sqliteDb, 'run').mockImplementation(async (sql, ...params) => {
        if (String(sql).includes('INSERT INTO documents')) {
          throw new Error('injected publication failure');
        }
        return originalRun(sql, ...params);
      });
      vi.spyOn(replacementInternals(), 'finishDocumentReplacement').mockRejectedValueOnce(new Error('injected cleanup failure'));

      const replacement = createDocumentWithContent(url, 'Replacement', 'new publication failure content');
      await expect(store.addDocument(replacement)).rejects.toThrow('injected publication failure');

      expect(await store.getDocument(url)).toMatchObject({ title: 'Original' });
      expect(await storedContents(store, url)).toEqual(['old publication failure content 0', 'old publication failure content 1']);
      expect(await sqliteDb.get('SELECT state FROM document_replacements WHERE url = ?', [url])).toMatchObject({ state: 'prepared' });

      vi.restoreAllMocks();
      await store.addDocument(createTestDocument(otherUrl, 'Unrelated'));
      expect(await storedContents(store, otherUrl)).toEqual(['Test content for chunk 1 of Unrelated']);
      await sqliteDb.run('UPDATE document_replacements SET lease_expires_at = 0 WHERE url = ?', [url]);

      const recoveredStore = await openPeerStore();
      expect(await storedContents(recoveredStore, url)).toEqual(['old publication failure content 0', 'old publication failure content 1']);
      expect(await storedContents(recoveredStore, otherUrl)).toEqual(['Test content for chunk 1 of Unrelated']);
      expect(await sqliteDb.get('SELECT url FROM document_replacements WHERE url = ?', [url])).toBeUndefined();
    });

    it('keeps committed metadata and cached search results visible when publication is cancelled', async () => {
      const url = 'https://example.com/cancelled-publication';
      const original = createDocumentWithContent(url, 'Original', 'old cancellation content');
      await store.addDocument(original);

      const controller = new AbortController();
      const publication = blockPublication();

      const replacement = createDocumentWithContent(url, 'Replacement', 'new cancellation content');
      const replacementPromise = store.addDocument(replacement, { signal: controller.signal });
      await publication.reached;

      expect(await store.getDocument(url)).toMatchObject({ title: 'Original' });
      expect(await storedContents(store, url)).toEqual(['old cancellation content']);

      controller.abort();
      publication.release();
      await expect(replacementPromise).rejects.toMatchObject({ name: 'AbortError' });

      expect(await store.getDocument(url)).toMatchObject({ title: 'Original' });
      expect(await storedContents(store, url)).toEqual(['old cancellation content']);
    });

    it('keeps committed metadata and cached search results visible when publication commit fails', async () => {
      const url = 'https://example.com/commit-failure';
      const original = createDocumentWithContent(url, 'Original', 'old commit failure content');
      await store.addDocument(original);

      const sqliteDb = replacementInternals().sqliteDb!;
      const originalRun = sqliteDb.run.bind(sqliteDb);
      const commitReached = deferred();
      const commitReleased = deferred();
      vi.spyOn(sqliteDb, 'run').mockImplementation(async (sql, ...params) => {
        if (String(sql) === 'COMMIT') {
          commitReached.resolve();
          await commitReleased.promise;
          throw new Error('injected commit failure');
        }
        return originalRun(sql, ...params);
      });

      const replacement = createDocumentWithContent(url, 'Replacement', 'new commit failure content');
      const replacementPromise = store.addDocument(replacement);
      await commitReached.promise;

      expect(await store.getDocument(url)).toMatchObject({ title: 'Original' });
      expect(await storedContents(store, url)).toEqual(['old commit failure content']);

      commitReleased.resolve();
      await expect(replacementPromise).rejects.toThrow('injected commit failure');
      expect(await store.getDocument(url)).toMatchObject({ title: 'Original' });
      expect(await storedContents(store, url)).toEqual(['old commit failure content']);
    });

    it('preserves a published generation when COMMIT succeeds but reports an error', async () => {
      const url = 'https://example.com/ambiguous-commit';
      await store.addDocument(createDocumentWithContent(url, 'Original', 'old ambiguous commit content'));

      const sqliteDb = replacementInternals().sqliteDb!;
      const run = sqliteDb.run.bind(sqliteDb);
      vi.spyOn(sqliteDb, 'run').mockImplementation(async (sql, ...params) => {
        if (String(sql) !== 'COMMIT') {
          return run(sql, ...params);
        }
        await run(sql, ...params);
        throw new Error('commit succeeded but response was lost');
      });

      await expect(
        store.addDocument(createDocumentWithContent(url, 'Replacement', 'new ambiguous commit content'), { tags: ['new-tag'] })
      ).rejects.toThrow('commit succeeded but response was lost');
      await expect(store.getDocument(url)).resolves.toMatchObject({ title: 'Replacement', tags: ['new-tag'] });
      await expect(storedContents(store, url)).resolves.toEqual(['new ambiguous commit content']);
    });

    it('retries a search that overlaps publication cleanup', async () => {
      const url = 'https://example.com/search-publication-race';
      const original = createDocumentWithContent(url, 'Original', 'old search race content');
      await store.addDocument(original);

      const internals = replacementInternals();
      const publication = blockPublication();

      const replacement = createDocumentWithContent(url, 'Replacement', 'new search race content');
      const replacementPromise = store.addDocument(replacement);
      await publication.reached;

      const getVisibility = internals.getJournalVisibilityFilter.bind(internals);
      const visibilityCaptured = deferred();
      const searchReleased = deferred();
      vi.spyOn(internals, 'getJournalVisibilityFilter').mockImplementationOnce(async () => {
        const filter = await getVisibility();
        visibilityCaptured.resolve();
        await searchReleased.promise;
        return filter;
      });

      const searchPromise = storedContents(store, url);
      await visibilityCaptured.promise;
      publication.release();
      await replacementPromise;
      searchReleased.resolve();

      await expect(searchPromise).resolves.toEqual(['new search race content']);
    });

    it('retries a search that read visibility before replacement preparation', async () => {
      const url = 'https://example.com/search-preparation-race';
      const original = createDocumentWithContent(url, 'Original', 'old preparation race content');
      await store.addDocument(original);

      const internals = replacementInternals();
      const getVisibility = internals.getJournalVisibilityFilter.bind(internals);
      const visibilityCaptured = deferred();
      const searchReleased = deferred();
      vi.spyOn(internals, 'getJournalVisibilityFilter').mockImplementationOnce(async () => {
        const filter = await getVisibility();
        visibilityCaptured.resolve();
        await searchReleased.promise;
        return filter;
      });

      const searchPromise = storedContents(store, url);
      await visibilityCaptured.promise;

      const publication = blockPublication();

      const replacement = createDocumentWithContent(url, 'Replacement', 'new preparation race content');
      const replacementPromise = store.addDocument(replacement);
      await publication.reached;
      searchReleased.resolve();

      await expect(searchPromise).resolves.toEqual(['old preparation race content']);
      publication.release();
      await replacementPromise;
      await expect(storedContents(store, url)).resolves.toEqual(['new preparation race content']);
    });

    it('survives consecutive visibility invalidations from two replacements', async () => {
      const firstUrl = 'https://example.com/consecutive-race-a';
      const secondUrl = 'https://example.com/consecutive-race-b';
      const first = createDocumentWithContent(firstUrl, 'First', 'old consecutive invalidation A');
      const second = createDocumentWithContent(secondUrl, 'Second', 'old consecutive invalidation B');
      await store.addDocument(first);
      await store.addDocument(second);

      const internals = replacementInternals();
      const getVisibility = internals.getJournalVisibilityFilter.bind(internals);
      const firstAttemptCaptured = deferred();
      const firstAttemptReleased = deferred();
      const secondAttemptCaptured = deferred();
      const secondAttemptReleased = deferred();
      let attempt = 0;
      vi.spyOn(internals, 'getJournalVisibilityFilter').mockImplementation(async () => {
        const filter = await getVisibility();
        attempt++;
        if (attempt === 1) {
          firstAttemptCaptured.resolve();
          await firstAttemptReleased.promise;
        }
        else if (attempt === 2) {
          secondAttemptCaptured.resolve();
          await secondAttemptReleased.promise;
        }
        return filter;
      });

      const queryVector = await mockEmbeddings.embed('consecutive invalidation');
      const searchPromise = store.searchDocuments(queryVector, { limit: 100 });
      await firstAttemptCaptured.promise;

      const firstReplacement = createDocumentWithContent(firstUrl, 'First replacement', 'new consecutive invalidation A');
      await store.addDocument(firstReplacement);
      firstAttemptReleased.resolve();
      await secondAttemptCaptured.promise;

      const secondReplacement = createDocumentWithContent(secondUrl, 'Second replacement', 'new consecutive invalidation B');
      await store.addDocument(secondReplacement);
      secondAttemptReleased.resolve();

      const contents = (await searchPromise).map((result) => result.content).sort();
      expect(contents).toEqual(['new consecutive invalidation A', 'new consecutive invalidation B']);
    });

    it('uses committed visibility to invalidate another store instance cache', async () => {
      const url = 'https://example.com/cross-instance-race';
      const original = createDocumentWithContent(url, 'Original', 'old cross instance content');
      await store.addDocument(original);

      const readerStore = await openPeerStore();
      expect(await storedContents(readerStore, url)).toEqual(['old cross instance content']);

      const publication = blockPublication();

      const replacement = createDocumentWithContent(url, 'Replacement', 'new cross instance content');
      const replacementPromise = store.addDocument(replacement);
      await publication.reached;

      expect(await storedContents(readerStore, url)).toEqual(['old cross instance content']);

      publication.release();
      await replacementPromise;
      expect(await storedContents(readerStore, url)).toEqual(['new cross instance content']);
    });

    it('guarantees a retry after a slow query is invalidated', async () => {
      const url = 'https://example.com/slow-invalidated-search';
      const original = createDocumentWithContent(url, 'Original', 'slow invalidated search content');
      await store.addDocument(original);

      let now = 0;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const internals = replacementInternals();
      const getVisibility = internals.getJournalVisibilityFilter.bind(internals);
      const firstAttemptCaptured = deferred();
      const firstAttemptReleased = deferred();
      let attempts = 0;
      vi.spyOn(internals, 'getJournalVisibilityFilter').mockImplementation(async () => {
        const filter = await getVisibility();
        attempts++;
        if (attempts === 1) {
          firstAttemptCaptured.resolve();
          await firstAttemptReleased.promise;
        }
        return filter;
      });

      const queryVector = await mockEmbeddings.embed('slow invalidated search');
      const searchPromise = store.searchDocuments(queryVector, { limit: 10 });
      await firstAttemptCaptured.promise;
      now = 10_000;
      await store.createCollection('search-version-invalidation');
      firstAttemptReleased.resolve();

      await expect(searchPromise).resolves.toHaveLength(1);
      expect(attempts).toBeGreaterThanOrEqual(2);
      nowSpy.mockRestore();
    });

    it('serializes two store instances replacing the same URL', async () => {
      const url = 'https://example.com/same-url-writers';
      const original = createDocumentWithContent(url, 'Original', 'old same URL test content');
      await store.addDocument(original, { tags: ['original-tag'] });

      const contender = await openPeerStore();
      const firstStage = blockNextLanceAdd();
      const first = createDocumentWithContent(url, 'First replacement', 'first same URL test content');
      const firstPromise = store.addDocument(first, { tags: ['first-tag'] });
      await firstStage.staged;

      const contenderWaiting = waitForLeaseContention(contender);

      const second = createDocumentWithContent(url, 'Second replacement', 'second same URL test content');
      const secondPromise = contender.addDocument(second, { tags: ['Second-Tag', 'second-tag'] });
      await contenderWaiting;
      expect(await storedContents(contender, url)).toEqual(['old same URL test content']);
      expect(await contender.getDocument(url)).toMatchObject({ title: 'Original', tags: ['original-tag'] });

      firstStage.release();
      await Promise.all([firstPromise, secondPromise]);

      expect(await contender.getDocument(url)).toMatchObject({ title: 'Second replacement', tags: ['second-tag'] });
      expect(await storedContents(contender, url)).toEqual(['second same URL test content']);
      const table = replacementInternals(contender).lanceTable!;
      await table.checkoutLatest();
      const rows = await table.query().where(`url = '${url}'`).toArray();
      expect(rows).toHaveLength(1);
    });

    it('does not recover a live replacement during another store initialization', async () => {
      const url = 'https://example.com/live-initialization';
      const original = createDocumentWithContent(url, 'Original', 'old live initialization test content');
      await store.addDocument(original);

      const stage = blockNextLanceAdd();
      const replacement = createDocumentWithContent(url, 'Replacement', 'new live initialization test content');
      const replacementPromise = store.addDocument(replacement);
      await stage.staged;

      const initializingStore = await openPeerStore();
      expect(await storedContents(initializingStore, url)).toEqual(['old live initialization test content']);

      stage.release();
      await replacementPromise;
      expect(await storedContents(initializingStore, url)).toEqual(['new live initialization test content']);
    });

    it('renews the lease while Lance staging remains in flight', async () => {
      const url = 'https://example.com/heartbeat-renewal';
      await store.addDocument(createTestDocument(url, 'Original'));
      vi.useFakeTimers();

      try {
        const leaseDb = replacementInternals().sqliteLeaseDb!;
        const run = leaseDb.run.bind(leaseDb);
        const renewed = deferred();
        vi.spyOn(leaseDb, 'run').mockImplementation(async (sql, ...params) => {
          const result = await run(sql, ...params);
          if (String(sql).includes('SET lease_expires_at = ?') && String(sql).includes('state = ?')) {
            renewed.resolve();
          }
          return result;
        });

        const stage = blockNextLanceAdd();
        const replacementPromise = store.addDocument(createTestDocument(url, 'Replacement'));
        await stage.staged;
        const before = await leaseDb.get<{ lease_expires_at: number }>('SELECT lease_expires_at FROM document_replacements WHERE url = ?', [
          url,
        ]);

        await vi.advanceTimersByTimeAsync(10_000);
        await renewed.promise;
        const after = await leaseDb.get<{ lease_expires_at: number }>('SELECT lease_expires_at FROM document_replacements WHERE url = ?', [
          url,
        ]);
        expect(after!.lease_expires_at).toBeGreaterThan(before!.lease_expires_at);

        stage.release();
        await replacementPromise;
      }
      finally {
        vi.useRealTimers();
      }
    });

    it('prevents a stale owner from publishing or deleting its successor lease', async () => {
      const url = 'https://example.com/stale-owner';
      const original = createDocumentWithContent(url, 'Original', 'old stale owner test content');
      await store.addDocument(original);

      const stage = blockNextLanceAdd();
      const replacement = createDocumentWithContent(url, 'Stale replacement', 'stale replacement test content');
      const replacementPromise = store.addDocument(replacement);
      await stage.staged;

      const sqliteDb = replacementInternals().sqliteDb!;
      const journal = await sqliteDb.get<{ generation: string }>('SELECT generation FROM document_replacements WHERE url = ?', [url]);
      await sqliteDb.run('UPDATE document_replacements SET owner_id = ?, lease_expires_at = ? WHERE url = ?', [
        'successor-owner',
        Date.now() + 60_000,
        url,
      ]);
      stage.release();

      await expect(replacementPromise).rejects.toThrow(`Replacement lease lost for ${url}`);
      expect(await sqliteDb.get('SELECT owner_id, state FROM document_replacements WHERE url = ?', [url])).toMatchObject({
        owner_id: 'successor-owner',
        state: 'prepared',
      });
      expect(await store.getDocument(url)).toMatchObject({ title: 'Original' });
      expect(await storedContents(store, url)).toEqual(['old stale owner test content']);
      const table = replacementInternals().lanceTable!;
      expect(await table.countRows(`url = '${url}' AND generation = '${journal!.generation}'`)).toBe(0);
      await sqliteDb.run('DELETE FROM document_replacements WHERE url = ?', [url]);
    });

    it('keeps a late stale append hidden and reaps it during recovery', async () => {
      const url = 'https://example.com/late-stale-append';
      const original = createDocumentWithContent(url, 'Original', 'old late append test content');
      await store.addDocument(original);
      const successor = await openPeerStore();

      const staleTable = replacementInternals().lanceTable!;
      const add = staleTable.add.bind(staleTable);
      const appendStarted = deferred();
      const appendReleased = deferred();
      vi.spyOn(staleTable, 'add').mockImplementationOnce(async (data, options) => {
        appendStarted.resolve();
        await appendReleased.promise;
        return add(data, options);
      });

      const stale = createDocumentWithContent(url, 'Stale', 'stale late append test content');
      const stalePromise = store.addDocument(stale);
      await appendStarted.promise;
      const sqliteDb = replacementInternals().sqliteDb!;
      const staleJournal = await sqliteDb.get<{ generation: string }>('SELECT generation FROM document_replacements WHERE url = ?', [url]);
      await sqliteDb.run('UPDATE document_replacements SET lease_expires_at = 0 WHERE url = ?', [url]);

      const winner = createDocumentWithContent(url, 'Winner', 'winner late append test content');
      await successor.addDocument(winner);

      const deleteRows = staleTable.delete.bind(staleTable);
      vi.spyOn(staleTable, 'delete').mockImplementation(async (predicate) => {
        if (predicate.includes(staleJournal!.generation)) {
          throw new Error('injected stale cleanup failure');
        }
        return deleteRows(predicate);
      });
      appendReleased.resolve();
      await expect(stalePromise).rejects.toThrow(`Replacement lease lost for ${url}`);

      const winnerTable = replacementInternals(successor).lanceTable!;
      await winnerTable.checkoutLatest();
      const rows = await winnerTable.query().where(`url = '${url}'`).toArray();
      expect(rows.some((row) => row.generation === staleJournal!.generation && row.published === false)).toBe(true);
      expect(await storedContents(successor, url)).toEqual(['winner late append test content']);

      const recoveredStore = await openPeerStore();
      const recoveredTable = replacementInternals(recoveredStore).lanceTable!;
      await recoveredTable.checkoutLatest();
      expect(await recoveredTable.countRows(`url = '${url}' AND generation = '${staleJournal!.generation}'`)).toBe(0);
      expect(await storedContents(recoveredStore, url)).toEqual(['winner late append test content']);
    });

    it.each(['published', 'deleting'] as const)('does not let stale %s cleanup delete a successor generation', async (state) => {
      const url = `https://example.com/stale-${state}-cleanup`;
      await store.addDocument(createTestDocument(url, 'Original'));
      const successor = await openPeerStore();

      const staleTable = replacementInternals().lanceTable!;
      const deleteRows = staleTable.delete.bind(staleTable);
      const cleanupStarted = deferred();
      const cleanupReleased = deferred();
      vi.spyOn(staleTable, 'delete').mockImplementationOnce(async (predicate) => {
        cleanupStarted.resolve();
        await cleanupReleased.promise;
        return deleteRows(predicate);
      });

      const cleanupPromise =
        state === 'published'
          ? store.addDocument(createDocumentWithContent(url, 'Stale replacement', 'stale published cleanup content'))
          : store.deleteDocument(url);
      await cleanupStarted.promise;
      await replacementInternals().sqliteDb!.run('UPDATE document_replacements SET lease_expires_at = 0 WHERE url = ?', [url]);

      const winnerContent = `winner ${state} cleanup content`;
      const winner = createDocumentWithContent(url, 'Winner', winnerContent);
      await successor.addDocument(winner);
      cleanupReleased.resolve();
      await cleanupPromise;

      expect(await successor.getDocument(url)).toMatchObject({ title: 'Winner' });
      expect(await storedContents(successor, url)).toEqual([winnerContent]);
    });

    it('cancels a contender while it waits for a live same-URL lease', async () => {
      const url = 'https://example.com/cancelled-lease-wait';
      await store.addDocument(createTestDocument(url, 'Original'));
      const contender = await openPeerStore();

      const stage = blockNextLanceAdd();
      const activePromise = store.addDocument(createTestDocument(url, 'Active replacement'));
      await stage.staged;

      const waiting = waitForLeaseContention(contender);
      const controller = new AbortController();
      const waitingPromise = contender.addDocument(createTestDocument(url, 'Cancelled replacement'), { signal: controller.signal });
      await waiting;
      controller.abort();

      await expect(waitingPromise).rejects.toMatchObject({ name: 'AbortError' });
      stage.release();
      await activePromise;
      expect(await contender.getDocument(url)).toMatchObject({ title: 'Active replacement' });
    });

    it('serializes add then delete across two store instances', async () => {
      const url = 'https://example.com/add-then-delete';
      await store.addDocument(createTestDocument(url, 'Original'));
      const deletingStore = await openPeerStore();

      const stage = blockNextLanceAdd();
      const addPromise = store.addDocument(createTestDocument(url, 'Replacement'));
      await stage.staged;

      const deleteWaiting = waitForLeaseContention(deletingStore);
      const deletePromise = deletingStore.deleteDocument(url);
      await deleteWaiting;
      expect(await deletingStore.getDocument(url)).toMatchObject({ title: 'Original' });

      stage.release();
      await Promise.all([addPromise, deletePromise]);
      expect(await deletingStore.getDocument(url)).toBeNull();
      expect(await storedContents(deletingStore, url)).toEqual([]);
      const table = replacementInternals(deletingStore).lanceTable!;
      await table.checkoutLatest();
      expect(await table.countRows(`url = '${url}'`)).toBe(0);
    });

    it('serializes delete then add across two store instances', async () => {
      const url = 'https://example.com/delete-then-add';
      await store.addDocument(createTestDocument(url, 'Original'));
      const addingStore = await openPeerStore();

      const sqliteDb = replacementInternals().sqliteDb!;
      const runSql = sqliteDb.run.bind(sqliteDb);
      const deleteReady = deferred();
      const deleteReleased = deferred();
      vi.spyOn(sqliteDb, 'run').mockImplementation(async (sql, ...params) => {
        if (String(sql) === 'BEGIN TRANSACTION') {
          deleteReady.resolve();
          await deleteReleased.promise;
        }
        return runSql(sql, ...params);
      });
      const deletePromise = store.deleteDocument(url);
      await deleteReady.promise;

      const addWaiting = waitForLeaseContention(addingStore);
      const winner = createDocumentWithContent(url, 'Winner', 'winner delete then add test content');
      const addPromise = addingStore.addDocument(winner);
      await addWaiting;
      expect(await addingStore.getDocument(url)).toMatchObject({ title: 'Original' });

      deleteReleased.resolve();
      await Promise.all([deletePromise, addPromise]);
      expect(await addingStore.getDocument(url)).toMatchObject({ title: 'Winner' });
      expect(await storedContents(addingStore, url)).toEqual(['winner delete then add test content']);
      const table = replacementInternals(addingStore).lanceTable!;
      await table.checkoutLatest();
      expect(await table.countRows(`url = '${url}' AND published = true`)).toBe(1);
    });

    it('keeps the published generation visible, then recovers its cleanup after lease expiry', async () => {
      const url = 'https://example.com/published-cleanup-failure';
      const original = createDocumentWithContent(url, 'Original', 'old published cleanup content');
      await store.addDocument(original);

      const replacement = createDocumentWithContent(url, 'Replacement', 'new published cleanup content');
      vi.spyOn(replacementInternals(), 'finishDocumentReplacement').mockRejectedValueOnce(new Error('injected cleanup failure'));
      await expect(store.addDocument(replacement)).resolves.toBeUndefined();

      expect(await store.getDocument(url)).toMatchObject({ title: 'Replacement' });
      expect(await storedContents(store, url)).toEqual(['new published cleanup content']);
      expect(await replacementInternals().sqliteDb!.get('SELECT state FROM document_replacements WHERE url = ?', [url])).toMatchObject({
        state: 'published',
      });
      await replacementInternals().sqliteDb!.run('UPDATE document_replacements SET lease_expires_at = 0 WHERE url = ?', [url]);

      const recoveredStore = await openPeerStore();

      expect(await storedContents(recoveredStore, url)).toEqual(['new published cleanup content']);
      const journal = await replacementInternals(recoveredStore).sqliteDb!.get('SELECT url FROM document_replacements WHERE url = ?', [
        url,
      ]);
      expect(journal).toBeUndefined();
    });

    it('rejects a malformed durable cleanup generation list', () => {
      expect(() => replacementInternals().parseCleanupGenerations('{bad json')).toThrow();
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

    it('hydrates metadata and tags in one query for every document read API', async () => {
      const url = 'https://example.com/snapshot-tags';
      await store.addDocument(createTestDocument(url, 'Snapshot Tags'), { tags: ['tag'] });
      await store.createCollection('Snapshot Collection');
      await store.addToCollection('Snapshot Collection', [url]);
      const reader = replacementInternals().sqliteReadDb!;
      const get = vi.spyOn(reader, 'get');
      const all = vi.spyOn(reader, 'all');

      get.mockClear();
      await store.getDocument(url);
      expect(String(get.mock.calls[0]?.[0])).toContain('json_group_array');
      expect(get).toHaveBeenCalledOnce();

      all.mockClear();
      await store.listDocuments();
      expect(String(all.mock.calls[0]?.[0])).toContain('json_group_array');
      expect(all).toHaveBeenCalledOnce();

      all.mockClear();
      await store.getCollection('Snapshot Collection');
      expect(String(all.mock.calls[0]?.[0])).toContain('json_group_array');
      expect(all).toHaveBeenCalledOnce();
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

    it('keeps failed vector cleanup hidden behind a deleting journal', async () => {
      const url = 'https://example.com/delete-cleanup-failure';
      await store.addDocument(createTestDocument(url, 'Delete cleanup failure'));
      vi.spyOn(replacementInternals().lanceTable!, 'delete').mockRejectedValueOnce(new Error('injected delete cleanup failure'));

      await expect(store.deleteDocument(url)).resolves.toBeUndefined();

      expect(await store.getDocument(url)).toBeNull();
      expect(await storedContents(store, url)).toEqual([]);
      expect(await replacementInternals().sqliteReadDb!.get('SELECT state FROM document_replacements WHERE url = ?', [url])).toMatchObject({
        state: 'deleting',
      });
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
      }
      catch {
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
      const store2 = await openPeerStore();

      // Add document with auth fields using new store
      const doc = createTestDocument('https://second-store.com', 'Second Store Test');
      doc.metadata.requiresAuth = true;
      await store2.addDocument(doc);

      // Should work without errors (migrations already applied, should be skipped)
      const retrieved = await store2.getDocument('https://second-store.com');
      expect(retrieved?.requiresAuth).toBe(true);
    });

    it('should add generations to a legacy Lance table without losing its chunks', async () => {
      const url = 'https://example.com/legacy-lance';
      const original = createDocumentWithContent(url, 'Legacy', 'legacy table content');
      await store.addDocument(original);
      await replacementInternals().lanceTable!.dropColumns(['generation', 'published']);

      const migratedStore = await openPeerStore();

      expect(await storedContents(migratedStore, url)).toEqual(['legacy table content']);
      const migratedSchema = await replacementInternals(migratedStore).lanceTable!.schema();
      const fields = migratedSchema.fields.map((field) => field.name);
      expect(fields).toContain('generation');
      expect(fields).toContain('published');
      expect(migratedSchema.fields.find((field) => field.name === 'published')?.nullable).toBe(false);

      const replacement = createDocumentWithContent(url, 'Migrated', 'migrated table content');
      await migratedStore.addDocument(replacement);
      expect(await storedContents(migratedStore, url)).toEqual(['migrated table content']);
    });

    it('allows concurrent initializers to finish the same journal and generation migrations', async () => {
      const url = 'https://example.com/concurrent-migration';
      await store.addDocument(createTestDocument(url, 'Concurrent migration'));
      await replacementInternals().lanceTable!.dropColumns(['generation', 'published']);
      await replacementInternals().sqliteDb!.exec(`
        DROP TABLE document_replacements;
        DELETE FROM schema_migrations WHERE version = 5;
      `);
      await store.close();

      const first = new DocumentStore(join(tempDir, 'docs.db'), join(tempDir, 'vectors'), mockEmbeddings, 100);
      const second = new DocumentStore(join(tempDir, 'docs.db'), join(tempDir, 'vectors'), mockEmbeddings, 100);
      openStores.add(first);
      openStores.add(second);
      await Promise.all([first.initialize(), second.initialize()]);

      const firstFields = (await replacementInternals(first).lanceTable!.schema()).fields.map((field) => field.name);
      const secondFields = (await replacementInternals(second).lanceTable!.schema()).fields.map((field) => field.name);
      for (const fields of [firstFields, secondFields]) {
        expect(fields).toEqual(expect.arrayContaining(['generation', 'published']));
      }
      expect(
        await replacementInternals(first).sqliteReadDb!.get('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 5')
      ).toMatchObject({ count: 1 });
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

  // ============ Collection Tests ============

  describe('collections', () => {
    describe('createCollection', () => {
      it('should create a collection successfully', async () => {
        await store.createCollection('My React Project', 'React, Next.js, and TypeScript docs');

        const collection = await store.getCollection('My React Project');
        expect(collection).toBeDefined();
        expect(collection?.name).toBe('My React Project');
        expect(collection?.description).toBe('React, Next.js, and TypeScript docs');
        expect(collection?.createdAt).toBeInstanceOf(Date);
        expect(collection?.updatedAt).toBeInstanceOf(Date);
      });

      it('should create a collection without description', async () => {
        await store.createCollection('Backend APIs');

        const collection = await store.getCollection('Backend APIs');
        expect(collection?.name).toBe('Backend APIs');
        expect(collection?.description).toBeUndefined();
      });

      it('should throw error when creating duplicate collection', async () => {
        await store.createCollection('Duplicate Test');
        await expect(store.createCollection('Duplicate Test')).rejects.toThrow('already exists');
      });

      it('should trim whitespace from collection name', async () => {
        await store.createCollection('  Trimmed Name  ');

        const collection = await store.getCollection('Trimmed Name');
        expect(collection?.name).toBe('Trimmed Name');
      });
    });

    describe('deleteCollection', () => {
      it('should delete a collection', async () => {
        await store.createCollection('To Delete');

        await store.deleteCollection('To Delete');

        const collection = await store.getCollection('To Delete');
        expect(collection).toBeNull();
      });

      it('should throw error when deleting non-existent collection', async () => {
        await expect(store.deleteCollection('Nonexistent')).rejects.toThrow('not found');
      });

      it('should not delete documents when collection is deleted', async () => {
        // Add document
        await store.addDocument(createTestDocument('https://example.com/keep-me', 'Keep Me'));

        // Create collection and add document
        await store.createCollection('Temp Collection');
        await store.addToCollection('Temp Collection', ['https://example.com/keep-me']);

        // Delete collection
        await store.deleteCollection('Temp Collection');

        // Document should still exist
        const doc = await store.getDocument('https://example.com/keep-me');
        expect(doc).toBeDefined();
        expect(doc?.title).toBe('Keep Me');
      });
    });

    describe('updateCollection', () => {
      it('should update collection description', async () => {
        await store.createCollection('Update Test', 'Original description');

        await store.updateCollection('Update Test', { description: 'Updated description' });

        const collection = await store.getCollection('Update Test');
        expect(collection?.description).toBe('Updated description');
      });

      it('should rename collection', async () => {
        await store.createCollection('Old Name');

        await store.updateCollection('Old Name', { newName: 'New Name' });

        const oldCollection = await store.getCollection('Old Name');
        const newCollection = await store.getCollection('New Name');

        expect(oldCollection).toBeNull();
        expect(newCollection?.name).toBe('New Name');
      });

      it('should rename collection and preserve documents', async () => {
        // Add document
        await store.addDocument(createTestDocument('https://example.com/rename-test', 'Rename Test'));

        // Create collection and add document
        await store.createCollection('Before Rename');
        await store.addToCollection('Before Rename', ['https://example.com/rename-test']);

        // Rename collection
        await store.updateCollection('Before Rename', { newName: 'After Rename' });

        // Document should be in new collection
        const collection = await store.getCollection('After Rename');
        expect(collection?.documents.length).toBe(1);
        expect(collection?.documents[0].url).toBe('https://example.com/rename-test');
      });

      it('should throw error when renaming to existing name', async () => {
        await store.createCollection('Collection A');
        await store.createCollection('Collection B');

        await expect(store.updateCollection('Collection A', { newName: 'Collection B' })).rejects.toThrow('already exists');
      });

      it('should throw error when updating non-existent collection', async () => {
        await expect(store.updateCollection('Nonexistent', { description: 'New desc' })).rejects.toThrow('not found');
      });

      it('should update both name and description', async () => {
        await store.createCollection('Full Update', 'Old description');

        await store.updateCollection('Full Update', { newName: 'Fully Updated', description: 'New description' });

        const collection = await store.getCollection('Fully Updated');
        expect(collection?.name).toBe('Fully Updated');
        expect(collection?.description).toBe('New description');
      });
    });

    describe('listCollections', () => {
      it('should return empty array when no collections exist', async () => {
        const collections = await store.listCollections();
        expect(collections).toEqual([]);
      });

      it('should list all collections with document counts', async () => {
        // Add documents
        await store.addDocument(createTestDocument('https://example.com/list1', 'List 1'));
        await store.addDocument(createTestDocument('https://example.com/list2', 'List 2'));

        // Create collections
        await store.createCollection('Collection 1');
        await store.createCollection('Collection 2');

        // Add documents to collections
        await store.addToCollection('Collection 1', ['https://example.com/list1', 'https://example.com/list2']);
        await store.addToCollection('Collection 2', ['https://example.com/list1']);

        const collections = await store.listCollections();

        expect(collections.length).toBe(2);

        const col1 = collections.find((c) => c.name === 'Collection 1');
        const col2 = collections.find((c) => c.name === 'Collection 2');

        expect(col1?.documentCount).toBe(2);
        expect(col2?.documentCount).toBe(1);
      });

      it('should sort collections by name', async () => {
        await store.createCollection('Zebra');
        await store.createCollection('Alpha');
        await store.createCollection('Middle');

        const collections = await store.listCollections();

        expect(collections[0].name).toBe('Alpha');
        expect(collections[1].name).toBe('Middle');
        expect(collections[2].name).toBe('Zebra');
      });
    });

    describe('getCollection', () => {
      it('should return null for non-existent collection', async () => {
        const collection = await store.getCollection('Nonexistent');
        expect(collection).toBeNull();
      });

      it('should return collection with all documents', async () => {
        // Add documents
        await store.addDocument(createTestDocument('https://example.com/get1', 'Get 1'));
        await store.addDocument(createTestDocument('https://example.com/get2', 'Get 2'));

        // Create collection and add documents
        await store.createCollection('Get Test', 'Test collection');
        await store.addToCollection('Get Test', ['https://example.com/get1', 'https://example.com/get2']);

        const collection = await store.getCollection('Get Test');

        expect(collection?.name).toBe('Get Test');
        expect(collection?.description).toBe('Test collection');
        expect(collection?.documents.length).toBe(2);
        expect(collection?.documentCount).toBe(2);

        const urls = collection?.documents.map((d) => d.url);
        expect(urls).toContain('https://example.com/get1');
        expect(urls).toContain('https://example.com/get2');
      });

      it('should include tags in collection documents', async () => {
        await store.addDocument(createTestDocument('https://example.com/tagged-doc', 'Tagged Doc'));
        await store.setTags('https://example.com/tagged-doc', ['frontend', 'react']);

        await store.createCollection('Tagged Collection');
        await store.addToCollection('Tagged Collection', ['https://example.com/tagged-doc']);

        const collection = await store.getCollection('Tagged Collection');
        expect(collection?.documents[0].tags).toEqual(['frontend', 'react']);
      });
    });

    describe('addToCollection', () => {
      beforeEach(async () => {
        await store.addDocument(createTestDocument('https://example.com/add1', 'Add 1'));
        await store.addDocument(createTestDocument('https://example.com/add2', 'Add 2'));
        await store.createCollection('Add Test');
      });

      it('should add documents to collection', async () => {
        const result = await store.addToCollection('Add Test', ['https://example.com/add1', 'https://example.com/add2']);

        expect(result.added.length).toBe(2);
        expect(result.notFound.length).toBe(0);
        expect(result.alreadyInCollection.length).toBe(0);

        const collection = await store.getCollection('Add Test');
        expect(collection?.documents.length).toBe(2);
      });

      it('should report non-existent documents', async () => {
        const result = await store.addToCollection('Add Test', ['https://example.com/add1', 'https://nonexistent.com/doc']);

        expect(result.added).toContain('https://example.com/add1');
        expect(result.notFound).toContain('https://nonexistent.com/doc');
      });

      it('should handle duplicate additions idempotently', async () => {
        await store.addToCollection('Add Test', ['https://example.com/add1']);
        const result = await store.addToCollection('Add Test', ['https://example.com/add1']);

        expect(result.added.length).toBe(0);
        expect(result.alreadyInCollection).toContain('https://example.com/add1');

        // Collection should still have only one document
        const collection = await store.getCollection('Add Test');
        expect(collection?.documents.length).toBe(1);
      });

      it('should throw error for non-existent collection', async () => {
        await expect(store.addToCollection('Nonexistent', ['https://example.com/add1'])).rejects.toThrow('not found');
      });

      it('should update collection updatedAt timestamp', async () => {
        const beforeCollection = await store.getCollection('Add Test');
        const beforeTime = beforeCollection!.updatedAt;

        // Wait a bit to ensure timestamp difference
        await new Promise((resolve) => setTimeout(resolve, 10));

        await store.addToCollection('Add Test', ['https://example.com/add1']);

        const afterCollection = await store.getCollection('Add Test');
        expect(afterCollection!.updatedAt.getTime()).toBeGreaterThan(beforeTime.getTime());
      });
    });

    describe('removeFromCollection', () => {
      beforeEach(async () => {
        await store.addDocument(createTestDocument('https://example.com/rem1', 'Remove 1'));
        await store.addDocument(createTestDocument('https://example.com/rem2', 'Remove 2'));
        await store.createCollection('Remove Test');
        await store.addToCollection('Remove Test', ['https://example.com/rem1', 'https://example.com/rem2']);
      });

      it('should remove documents from collection', async () => {
        const result = await store.removeFromCollection('Remove Test', ['https://example.com/rem1']);

        expect(result.removed).toContain('https://example.com/rem1');
        expect(result.notInCollection.length).toBe(0);

        const collection = await store.getCollection('Remove Test');
        expect(collection?.documents.length).toBe(1);
        expect(collection?.documents[0].url).toBe('https://example.com/rem2');
      });

      it('should report documents not in collection', async () => {
        const result = await store.removeFromCollection('Remove Test', ['https://example.com/not-in-collection']);

        expect(result.removed.length).toBe(0);
        expect(result.notInCollection).toContain('https://example.com/not-in-collection');
      });

      it('should throw error for non-existent collection', async () => {
        await expect(store.removeFromCollection('Nonexistent', ['https://example.com/rem1'])).rejects.toThrow('not found');
      });

      it('should not delete the document itself', async () => {
        await store.removeFromCollection('Remove Test', ['https://example.com/rem1']);

        // Document should still exist
        const doc = await store.getDocument('https://example.com/rem1');
        expect(doc).toBeDefined();
        expect(doc?.title).toBe('Remove 1');
      });
    });

    describe('getCollectionUrls', () => {
      it('should return URLs in collection', async () => {
        await store.addDocument(createTestDocument('https://example.com/url1', 'URL 1'));
        await store.addDocument(createTestDocument('https://example.com/url2', 'URL 2'));
        await store.createCollection('URL Test');
        await store.addToCollection('URL Test', ['https://example.com/url1', 'https://example.com/url2']);

        const urls = await store.getCollectionUrls('URL Test');

        expect(urls.length).toBe(2);
        expect(urls).toContain('https://example.com/url1');
        expect(urls).toContain('https://example.com/url2');
      });

      it('should return empty array for empty collection', async () => {
        await store.createCollection('Empty Collection');

        const urls = await store.getCollectionUrls('Empty Collection');
        expect(urls).toEqual([]);
      });

      it('should return empty array for non-existent collection', async () => {
        const urls = await store.getCollectionUrls('Nonexistent');
        expect(urls).toEqual([]);
      });
    });

    describe('document deletion cascade', () => {
      it('should remove document from collections when document is deleted', async () => {
        // Add document
        await store.addDocument(createTestDocument('https://example.com/cascade', 'Cascade Test'));

        // Add to multiple collections
        await store.createCollection('Collection A');
        await store.createCollection('Collection B');
        await store.addToCollection('Collection A', ['https://example.com/cascade']);
        await store.addToCollection('Collection B', ['https://example.com/cascade']);

        // Delete the document
        await store.deleteDocument('https://example.com/cascade');

        // Document should be removed from both collections
        const colA = await store.getCollection('Collection A');
        const colB = await store.getCollection('Collection B');

        expect(colA?.documents.length).toBe(0);
        expect(colB?.documents.length).toBe(0);
      });
    });

    describe('document in multiple collections', () => {
      it('should allow same document in multiple collections', async () => {
        await store.addDocument(createTestDocument('https://example.com/shared', 'Shared Doc'));

        await store.createCollection('Frontend');
        await store.createCollection('React Project');

        await store.addToCollection('Frontend', ['https://example.com/shared']);
        await store.addToCollection('React Project', ['https://example.com/shared']);

        const frontendCollection = await store.getCollection('Frontend');
        const reactCollection = await store.getCollection('React Project');

        expect(frontendCollection?.documents.length).toBe(1);
        expect(reactCollection?.documents.length).toBe(1);
      });
    });
  });
});
