import { SessionExpiredError } from '../util/security.js';
import type { CrawlResult, DocumentChunk, DocumentMetadata, ProcessedDocument } from '../types.js';
import { DocsCrawler } from '../crawler/docs-crawler.js';
import { IndexingWorkflow, type IndexingRequest } from './workflow.js';

const request: IndexingRequest = {
  operationId: 'operation-1',
  url: 'https://docs.example.com',
  title: 'Example Docs',
};

const page: CrawlResult = {
  url: request.url,
  path: '/',
  content: '<h1>Example</h1>',
  contentFormat: 'text',
  title: request.title,
};

const chunk: DocumentChunk = {
  content: 'Example content',
  url: request.url,
  title: request.title,
  path: '/',
  startLine: 0,
  endLine: 0,
  vector: [0.1, 0.2],
  metadata: { type: 'overview' },
};

function createHarness(
  options: {
    existingDocument?: DocumentMetadata | null;
    crawl?: () => AsyncGenerator<CrawlResult, void, unknown>;
    createCrawler?: () => DocsCrawler;
    process?: (crawlResult: CrawlResult) => Promise<ProcessedDocument>;
    savedSession?: string;
    previousPageCount?: number;
    failedPageCount?: number;
    skippedLoginPageUrls?: string[];
  } = {}
) {
  const addDocument = vi.fn().mockResolvedValue(undefined);
  const store = {
    addDocument,
    getPageHighWaterMark: vi.fn().mockResolvedValue(options.previousPageCount ?? 0),
    getDocument: vi.fn().mockResolvedValue(options.existingDocument ?? null),
    optimize: vi.fn().mockResolvedValue({ compacted: false, cleanedUp: false }),
  };
  const statusTracker = {
    cancelIndexing: vi.fn(),
    completeIndexing: vi.fn(),
    failIndexing: vi.fn(),
    getStatus: vi.fn(),
    updateProgress: vi.fn(),
    updateStats: vi.fn(),
  };
  const authManager = {
    clearSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(options.savedSession ?? null),
  };
  const crawler = {
    abort: vi.fn(),
    failedPageCount: options.failedPageCount ?? 0,
    skippedLoginPageUrls: options.skippedLoginPageUrls ?? [],
    crawl:
      options.crawl ??
      async function* () {
        yield page;
      },
    setPathPrefix: vi.fn(),
    setStorageState: vi.fn(),
  };
  const process = vi.fn(
    options.process ??
      // Carry the page's path onto its chunks, the way the real processor does
      (async (crawlResult: CrawlResult) => ({
        metadata: { url: page.url, title: page.title, lastIndexed: new Date() },
        chunks: [{ ...chunk, path: crawlResult.path }],
      }))
  );
  const processor = { process };
  const createCrawler = vi.fn(options.createCrawler ?? (() => crawler));
  const fetchFavicon = vi.fn().mockResolvedValue('data:image/x-icon;base64,AA==');
  const workflow = new IndexingWorkflow({ store, processor, statusTracker, authManager, createCrawler, fetchFavicon });

  return { workflow, store, statusTracker, authManager, crawler, createCrawler, fetchFavicon, addDocument, process };
}

const runWorkflow = (workflow: IndexingWorkflow, indexingRequest: IndexingRequest, signal = new AbortController().signal) =>
  workflow.run(indexingRequest, signal);

describe('IndexingWorkflow', () => {
  it('crawls, processes, stores, tags, completes, and optimizes a document', async () => {
    const harness = createHarness();

    await runWorkflow(harness.workflow, { ...request, pathPrefix: '/guide', tags: ['guide'], version: '2' });

    expect(harness.createCrawler).toHaveBeenCalledWith();
    expect(harness.crawler.setPathPrefix).toHaveBeenCalledWith('/guide');
    expect(harness.addDocument).toHaveBeenCalledWith(
      {
        metadata: expect.objectContaining({
          url: request.url,
          title: request.title,
          favicon: 'data:image/x-icon;base64,AA==',
          version: '2',
          pathPrefix: '/guide',
        }),
        chunks: [chunk],
      },
      { signal: expect.any(AbortSignal), tags: ['guide'] }
    );
    expect(harness.statusTracker.completeIndexing).toHaveBeenCalledWith(request.operationId);
    expect(harness.store.optimize).toHaveBeenCalledOnce();

    const progressStages = harness.statusTracker.updateProgress.mock.calls.map((call) => call[2]);
    expect(progressStages).toEqual(
      expect.arrayContaining(['Finding subpages', 'Finding subpages (/)', 'Creating embeddings (1/1)', 'Storing 1 chunks'])
    );
    expect(progressStages.indexOf('Finding subpages')).toBeLessThan(progressStages.indexOf('Creating embeddings (1/1)'));
    expect(progressStages.indexOf('Creating embeddings (1/1)')).toBeLessThan(progressStages.indexOf('Storing 1 chunks'));
    expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(request.operationId, { pagesFound: 1 });
    expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(request.operationId, { pagesProcessed: 1, chunksCreated: 1 });
    expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(request.operationId, { chunksCreated: 1 });
  });

  it('reports pages the crawl could not fetch', async () => {
    const harness = createHarness({ failedPageCount: 3 });

    await runWorkflow(harness.workflow, request);

    expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(
      request.operationId,
      expect.objectContaining({ pagesFound: 1, pagesFailed: 3 })
    );
    expect(harness.statusTracker.completeIndexing).toHaveBeenCalledWith(request.operationId);
  });

  it('reports no failed pages for a complete crawl', async () => {
    const harness = createHarness();

    await runWorkflow(harness.workflow, request);

    expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(
      request.operationId,
      expect.objectContaining({ pagesFound: 1, pagesFailed: 0 })
    );
  });

  // A login wall the crawl left out is a page the caller asked for and did not get, and the URL is
  // what either remedy needs
  it('reports the login pages a crawl left out of the index', async () => {
    const harness = createHarness({ skippedLoginPageUrls: ['https://docs.example.com/login', 'https://docs.example.com/admin'] });

    await runWorkflow(harness.workflow, request);

    expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(
      request.operationId,
      expect.objectContaining({
        loginPagesSkipped: 2,
        skippedLoginUrls: ['https://docs.example.com/login', 'https://docs.example.com/admin'],
      })
    );
  });

  // A crawl of a site that needs signing in ends here, its walls left out and nothing else to index.
  // The stats are never reached on this path, so the count and the remedies travel in the failure.
  it.each([
    ['counts the login page that left it with nothing to index', ['https://docs.example.com/login'], /reached 1 page asking/],
    [
      'counts several login pages that left it with nothing to index',
      ['https://docs.example.com/login', 'https://docs.example.com/admin'],
      /reached 2 pages asking/,
    ],
    ['reports finding nothing when no page was a login page', [], /^No pages found to index$/],
  ])('%s', async (_label, skippedLoginPageUrls, expected) => {
    const harness = createHarness({ skippedLoginPageUrls, crawl: async function* () {} });

    await runWorkflow(harness.workflow, request);

    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(request.operationId, expect.stringMatching(expected));
  });

  it('offers both remedies for a crawl that reached nothing but login pages', async () => {
    const harness = createHarness({ skippedLoginPageUrls: ['https://docs.example.com/login'], crawl: async function* () {} });

    await runWorkflow(harness.workflow, request);

    const [, message] = harness.statusTracker.failIndexing.mock.calls[0];
    expect(message).toContain('https://docs.example.com/login');
    expect(message).toContain("'authenticate' tool");
    expect(message).toContain('pathPrefix');
  });

  it('skips pages with no indexable content and still stores the rest', async () => {
    const harness = createHarness({
      crawl: async function* () {
        yield { ...page, path: '/good' };
        yield { ...page, path: '/blank' };
        yield { ...page, path: '/also-good' };
      },
      process: async (crawlResult) => ({
        metadata: { url: page.url, title: page.title, lastIndexed: new Date() },
        chunks: crawlResult.path === '/blank' ? [] : [chunk],
      }),
    });

    await runWorkflow(harness.workflow, request);

    expect(harness.addDocument).toHaveBeenCalledWith(expect.objectContaining({ chunks: [chunk, chunk] }), expect.anything());
    expect(harness.statusTracker.completeIndexing).toHaveBeenCalledWith(request.operationId);
    expect(harness.statusTracker.failIndexing).not.toHaveBeenCalled();
    // Pin the LAST page count: asserting any matching call would still pass if skipped
    // pages were counted as processed and the fixture happened to end on a good page
    expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(request.operationId, { pagesSkipped: 1 });
    const pageCounts = harness.statusTracker.updateStats.mock.calls.filter(([, stats]) => 'pagesProcessed' in stats);
    expect(pageCounts.at(-1)).toEqual([request.operationId, { pagesProcessed: 2, chunksCreated: 2 }]);
  });

  it('still fails the whole run when a page fails for any other reason', async () => {
    const harness = createHarness({
      crawl: async function* () {
        yield { ...page, path: '/good' };
        yield { ...page, path: '/broken' };
      },
      process: async (crawlResult) => {
        if (crawlResult.path === '/broken') {
          throw new Error('Embedding failed');
        }
        return { metadata: { url: page.url, title: page.title, lastIndexed: new Date() }, chunks: [chunk] };
      },
    });

    await runWorkflow(harness.workflow, request);

    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(
      request.operationId,
      expect.stringContaining('Failed to process /broken')
    );
    expect(harness.addDocument).not.toHaveBeenCalled();
    expect(harness.statusTracker.completeIndexing).not.toHaveBeenCalled();
  });

  it('stores when exactly half the pages were skipped', async () => {
    const harness = createHarness({
      crawl: async function* () {
        yield { ...page, path: '/good-1' };
        yield { ...page, path: '/blank-1' };
        yield { ...page, path: '/good-2' };
        yield { ...page, path: '/blank-2' };
      },
      process: async (crawlResult) => ({
        metadata: { url: page.url, title: page.title, lastIndexed: new Date() },
        chunks: crawlResult.path.startsWith('/good') ? [chunk] : [],
      }),
    });

    await runWorkflow(harness.workflow, request);

    // The gate is for extraction failing site-wide; half is not enough to call it broken
    expect(harness.addDocument).toHaveBeenCalledWith(expect.objectContaining({ chunks: [chunk, chunk] }), expect.anything());
    expect(harness.statusTracker.completeIndexing).toHaveBeenCalledWith(request.operationId);
  });

  it('refuses to store when most pages were skipped, leaving an existing index untouched', async () => {
    const harness = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date() },
      crawl: async function* () {
        yield { ...page, path: '/good' };
        yield { ...page, path: '/blank-1' };
        yield { ...page, path: '/blank-2' };
      },
      process: async (crawlResult) => ({
        metadata: { url: page.url, title: page.title, lastIndexed: new Date() },
        chunks: crawlResult.path === '/good' ? [chunk] : [],
      }),
    });

    await runWorkflow(harness.workflow, { ...request, reIndex: true });

    // Some content was extracted, so the run would otherwise have replaced a healthy
    // index with a gutted one and reported success
    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(
      request.operationId,
      expect.stringContaining('No indexable content on 2 of 3 pages')
    );
    expect(harness.addDocument).not.toHaveBeenCalled();
    expect(harness.statusTracker.completeIndexing).not.toHaveBeenCalled();
  });

  function crawlPages(count: number) {
    return async function* () {
      for (let i = 0; i < count; i++) {
        yield { ...page, path: `/p${i}` };
      }
    };
  }

  // Every page extracted cleanly, so the empty-content gate above sees nothing wrong - the
  // pages are simply missing because the crawl lost them. Losing exactly half is not tolerated.
  it.each([
    { crawled: 50, stored: 100, blocked: true },
    { crawled: 51, stored: 100, blocked: false },
  ])('reindex crawling $crawled pages against $stored stored is blocked: $blocked', async ({ crawled, stored, blocked }) => {
    const harness = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date() },
      previousPageCount: stored,
      crawl: crawlPages(crawled),
    });

    await runWorkflow(harness.workflow, { ...request, reIndex: true });

    expect(harness.store.getPageHighWaterMark).toHaveBeenCalledWith(request.url);
    if (blocked) {
      expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(
        request.operationId,
        expect.stringContaining(`Reindex produced ${crawled} pages but this document has held ${stored}`)
      );
      expect(harness.addDocument).not.toHaveBeenCalled();
      expect(harness.statusTracker.completeIndexing).not.toHaveBeenCalled();
    }
    else {
      expect(harness.addDocument).toHaveBeenCalledOnce();
      expect(harness.statusTracker.completeIndexing).toHaveBeenCalled();
    }
  });

  it('gates on pages produced, not chunks produced', async () => {
    const harness = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date() },
      previousPageCount: 100,
      crawl: crawlPages(50),
      // 50 pages but 100 chunks - counting chunks would wave this through
      process: async (crawlResult) => ({
        metadata: { url: crawlResult.url, title: crawlResult.title, lastIndexed: new Date() },
        chunks: [
          { ...chunk, path: crawlResult.path },
          { ...chunk, path: crawlResult.path },
        ],
      }),
    });

    await runWorkflow(harness.workflow, { ...request, reIndex: true });

    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(
      request.operationId,
      expect.stringContaining('Reindex produced 50 pages but this document has held 100')
    );
    expect(harness.addDocument).not.toHaveBeenCalled();
  });

  it('allows a reindex that deliberately narrows the path prefix', async () => {
    const harness = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date(), pathPrefix: '/docs' },
      previousPageCount: 100,
      crawl: crawlPages(1),
    });

    await runWorkflow(harness.workflow, { ...request, reIndex: true, pathPrefix: '/docs/v2' });

    expect(harness.statusTracker.failIndexing).not.toHaveBeenCalled();
    expect(harness.addDocument).toHaveBeenCalledOnce();
  });

  // Widening or clearing the prefix should return more pages, so a shrink is still suspicious, and
  // an unchanged prefix is the ordinary reindex the gate exists for
  it.each([
    { label: 'cleared', pathPrefix: undefined },
    { label: 'widened', pathPrefix: '/' + 'docs'.slice(0, 2) },
    { label: 'left unchanged', pathPrefix: '/docs' },
  ])('still gates a reindex whose prefix was $label', async ({ pathPrefix }) => {
    const harness = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date(), pathPrefix: '/docs' },
      previousPageCount: 100,
      crawl: crawlPages(1),
    });

    await runWorkflow(harness.workflow, { ...request, reIndex: true, pathPrefix });

    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(
      request.operationId,
      expect.stringContaining('Reindex produced 1 pages but this document has held 100')
    );
    expect(harness.addDocument).not.toHaveBeenCalled();
  });

  it('keeps indexing when the stored page count cannot be read', async () => {
    const harness = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date() },
      previousPageCount: 100,
      crawl: crawlPages(1),
    });
    harness.store.getPageHighWaterMark.mockRejectedValue(new Error('lance unavailable'));

    await runWorkflow(harness.workflow, { ...request, reIndex: true });

    expect(harness.statusTracker.failIndexing).not.toHaveBeenCalled();
    expect(harness.addDocument).toHaveBeenCalledOnce();
  });

  it('does not gate the first index of a document on a stored page count', async () => {
    const harness = createHarness({ previousPageCount: 100 });

    await runWorkflow(harness.workflow, request);

    expect(harness.store.getPageHighWaterMark).not.toHaveBeenCalled();
    expect(harness.addDocument).toHaveBeenCalledOnce();
  });

  it('reports each crawled page while the crawl is still running', async () => {
    const { promise: secondPageReleased, resolve: releaseSecondPage } = Promise.withResolvers<void>();
    const harness = createHarness({
      crawl: async function* () {
        yield { ...page, path: '/one' };
        await secondPageReleased;
        yield { ...page, path: '/two' };
      },
    });

    const run = runWorkflow(harness.workflow, request);

    await vi.waitFor(() => expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(request.operationId, { pagesFound: 1 }));
    expect(harness.statusTracker.updateStats).not.toHaveBeenCalledWith(request.operationId, { pagesFound: 2 });

    releaseSecondPage();
    await run;

    expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(request.operationId, { pagesFound: 2 });
  });

  it('reindexes only after processing and finishes metadata after the replacement write', async () => {
    const harness = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date() },
    });

    await runWorkflow(harness.workflow, { ...request, reIndex: true, tags: ['existing'] });

    const processOrder = harness.process.mock.invocationCallOrder[0];
    const addOrder = harness.addDocument.mock.invocationCallOrder[0];
    expect(processOrder).toBeLessThan(addOrder);
    expect(addOrder).toBeLessThan(harness.statusTracker.completeIndexing.mock.invocationCallOrder[0]);

    const progressStages = harness.statusTracker.updateProgress.mock.calls.map((call) => call[2]);
    expect(progressStages.indexOf('Creating embeddings (1/1)')).toBeLessThan(progressStages.indexOf('Storing 1 chunks'));
    expect(harness.statusTracker.updateStats).toHaveBeenCalledWith(request.operationId, {
      pagesProcessed: 1,
      chunksCreated: 1,
    });

    const failedWrite = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date() },
    });
    failedWrite.addDocument.mockRejectedValue(new Error('write failed'));

    await runWorkflow(failedWrite.workflow, { ...request, reIndex: true, tags: ['existing'] });

    expect(failedWrite.addDocument).toHaveBeenCalledOnce();
    expect(failedWrite.statusTracker.completeIndexing).not.toHaveBeenCalled();
    expect(failedWrite.statusTracker.failIndexing).toHaveBeenCalledWith(request.operationId, 'write failed');
  });

  it('completes an existing add without crawling or writing', async () => {
    const harness = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date() },
    });

    await runWorkflow(harness.workflow, request);

    expect(harness.statusTracker.completeIndexing).toHaveBeenCalledWith(request.operationId);
    expect(harness.createCrawler).not.toHaveBeenCalled();
    expect(harness.addDocument).not.toHaveBeenCalled();
  });

  it('fails without writing when processing produces no chunks', async () => {
    const harness = createHarness({
      existingDocument: { url: request.url, title: request.title, lastIndexed: new Date() },
      process: vi.fn().mockResolvedValue({
        metadata: { url: page.url, title: page.title, lastIndexed: new Date() },
        chunks: [],
      }),
    });

    await runWorkflow(harness.workflow, { ...request, reIndex: true });

    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(
      request.operationId,
      'No indexable content on 1 of 1 pages - extraction may be failing, so nothing was stored'
    );
    expect(harness.addDocument).not.toHaveBeenCalled();
    expect(harness.statusTracker.completeIndexing).not.toHaveBeenCalled();
  });

  it.each([
    ['valid', JSON.stringify({ cookies: [] }), { cookies: [] }],
    ['malformed', '{not json', undefined],
  ])('continues crawling with a %s saved session', async (_label, savedSession, expectedState) => {
    const harness = createHarness({ savedSession });

    await runWorkflow(harness.workflow, request);

    if (expectedState) {
      expect(harness.crawler.setStorageState).toHaveBeenCalledWith(expectedState);
    }
    else {
      expect(harness.crawler.setStorageState).not.toHaveBeenCalled();
    }
    expect(harness.addDocument).toHaveBeenCalledOnce();
    expect(harness.statusTracker.completeIndexing).toHaveBeenCalledWith(request.operationId);
  });

  it('aborts an in-progress crawl without writing', async () => {
    const controller = new AbortController();
    const harness = createHarness({
      crawl: async function* () {
        yield page;
        controller.abort();
        yield { ...page, path: '/second' };
      },
    });

    await runWorkflow(harness.workflow, request, controller.signal);

    expect(harness.crawler.abort).toHaveBeenCalledOnce();
    expect(harness.statusTracker.cancelIndexing).toHaveBeenCalledWith(request.operationId);
    expect(harness.addDocument).not.toHaveBeenCalled();
  });

  // Both need authenticating, but only a crawl that had a session can be described as expired, and
  // only the one that never had it wants telling about pathPrefix.
  it.each([
    ['a session that expired', JSON.stringify({ cookies: [] }), /session has expired/i, /before re-indexing/i],
    ['a site that always needed one', undefined, /This site requires authentication/i, /pathPrefix/],
  ])('clears the stored session and reports %s', async (_label, savedSession, expected, remedy) => {
    const harness = createHarness({
      savedSession,
      crawl: async function* () {
        yield* [] as CrawlResult[];
        throw new SessionExpiredError('served', request.url, 'https://docs.example.com/login?token=abc123&next=%2Fdocs', {
          isLoginPage: true,
          confidence: 1,
          reasons: ['login URL'],
        });
      },
    });

    await runWorkflow(harness.workflow, request);

    expect(harness.authManager.clearSession).toHaveBeenCalledWith(request.url);
    const [, message] = harness.statusTracker.failIndexing.mock.calls[0];
    expect(message).toMatch(expected);
    expect(message).toMatch(remedy);
    // The page it happened on, or the user cannot tell which part of the site to keep out of - with
    // its parameters redacted, since a login redirect is where a live token is likeliest to be
    expect(message).toContain('https://docs.example.com/login?token=[REDACTED]&next=%2Fdocs');
    expect(message).not.toContain('abc123');
    expect(message).toContain("'authenticate' tool");
    expect(harness.addDocument).not.toHaveBeenCalled();
  });

  it('consumes generic failures and marks the operation failed', async () => {
    const harness = createHarness({
      crawl: async function* () {
        yield* [] as CrawlResult[];
        throw new Error('crawl failed');
      },
    });

    await expect(runWorkflow(harness.workflow, request)).resolves.toBeUndefined();

    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(request.operationId, 'crawl failed');
    expect(harness.addDocument).not.toHaveBeenCalled();
  });

  it('surfaces unsupported GitHub blob URLs through indexing status', async () => {
    const harness = createHarness({ createCrawler: () => new DocsCrawler() });
    const blobUrl = 'https://github.com/owner/repo/blob/main/README.md';

    await runWorkflow(harness.workflow, { ...request, url: blobUrl });

    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(
      request.operationId,
      `Unsupported GitHub URL: ${blobUrl}. Use a repository root or /tree/<branch>[/path] URL.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.fetchFavicon).not.toHaveBeenCalled();
    expect(harness.addDocument).not.toHaveBeenCalled();
  });

  it.each(['Commit conflict', 'SQLITE_BUSY: database is locked'])('retries a transient %s before succeeding', async (message) => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.addDocument.mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(undefined);

    const run = runWorkflow(harness.workflow, request);
    await vi.runAllTimersAsync();
    await run;

    expect(harness.addDocument).toHaveBeenCalledTimes(2);
    expect(harness.addDocument).toHaveBeenLastCalledWith(expect.any(Object), {
      signal: expect.any(AbortSignal),
      tags: [],
    });
    expect(harness.statusTracker.completeIndexing).toHaveBeenCalledWith(request.operationId);
    vi.useRealTimers();
  });
});
