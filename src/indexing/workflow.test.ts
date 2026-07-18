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
  } = {}
) {
  const addDocument = vi.fn().mockResolvedValue(undefined);
  const store = {
    addDocument,
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
      (async () => ({
        metadata: { url: page.url, title: page.title, lastIndexed: new Date() },
        chunks: [chunk],
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

    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(request.operationId, 'No content was extracted from the pages');
    expect(harness.addDocument).not.toHaveBeenCalled();
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

  it('clears an expired session and reports the friendly authentication failure', async () => {
    const harness = createHarness({
      crawl: async function* () {
        yield* [] as CrawlResult[];
        throw new SessionExpiredError('redirected', request.url, 'https://docs.example.com/login', {
          isLoginPage: true,
          confidence: 1,
          reasons: ['login URL'],
        });
      },
    });

    await runWorkflow(harness.workflow, request);

    expect(harness.authManager.clearSession).toHaveBeenCalledWith(request.url);
    expect(harness.statusTracker.failIndexing).toHaveBeenCalledWith(
      request.operationId,
      expect.stringContaining("Please use the 'authenticate' tool")
    );
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

  it('retries transient commit conflicts before succeeding', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.addDocument.mockRejectedValueOnce(new Error('Commit conflict')).mockResolvedValueOnce(undefined);

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
