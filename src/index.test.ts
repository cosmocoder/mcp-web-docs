import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ProgressToken } from '@modelcontextprotocol/sdk/types.js';
import { SessionExpiredError } from './util/security.js';
import { IndexingStatusTracker } from './indexing/status.js';
import type { DocumentChunk, DocumentMetadata } from './types.js';

type ToolHandler = (request: {
  params: { name: string; arguments?: Record<string, unknown>; _meta?: { progressToken?: ProgressToken } };
}) => Promise<unknown>;

const {
  mockCrawlerAbort,
  mockCrawlerCrawl,
  mockCrawlerSetPathPrefix,
  mockAuthCleanup,
  mockAuthHasSession,
  mockAuthInitialize,
  mockClearSession,
  mockCloseOutboundProxy,
  mockDatasetOpen,
  mockFetchFavicon,
  mockIsValidPublicUrl,
  mockLoadConfig,
  mockNotification,
  mockProcessorProcess,
  mockQueueCancelAll,
  mockRunLatest,
  mockServerClose,
  mockServerConnect,
  mockStoreAddDocument,
  mockStoreDeleteDocument,
  mockStoreGetCollectionUrls,
  mockStoreGetDocument,
  mockStoreSearchByText,
  requestHandlers,
  testConfig,
} = vi.hoisted(() => ({
  mockCrawlerAbort: vi.fn(),
  mockCrawlerCrawl: vi.fn().mockImplementation(async function* () {
    yield { url: 'https://example.com', path: '/', content: 'Test', contentFormat: 'text', title: 'Test' };
  }),
  mockCrawlerSetPathPrefix: vi.fn(),
  mockAuthCleanup: vi.fn().mockResolvedValue(undefined),
  mockAuthHasSession: vi.fn().mockResolvedValue(false),
  mockAuthInitialize: vi.fn().mockResolvedValue(undefined),
  mockClearSession: vi.fn().mockResolvedValue(undefined),
  mockCloseOutboundProxy: vi.fn().mockResolvedValue(undefined),
  mockDatasetOpen: vi.fn().mockResolvedValue({ drop: vi.fn().mockResolvedValue(undefined) }),
  mockFetchFavicon: vi.fn().mockResolvedValue('https://example.com/favicon.ico'),
  mockIsValidPublicUrl: vi.fn().mockReturnValue(true),
  mockLoadConfig: vi.fn(),
  mockNotification: vi.fn().mockResolvedValue(undefined),
  mockProcessorProcess: vi.fn().mockResolvedValue({
    metadata: { url: 'https://example.com', title: 'Test', lastIndexed: new Date() },
    chunks: [] as DocumentChunk[],
  }),
  mockQueueCancelAll: vi.fn().mockResolvedValue(undefined),
  mockRunLatest: vi.fn(),
  mockServerClose: vi.fn().mockResolvedValue(undefined),
  mockServerConnect: vi.fn().mockResolvedValue(undefined),
  mockStoreAddDocument: vi.fn().mockResolvedValue(undefined),
  mockStoreDeleteDocument: vi.fn().mockResolvedValue(undefined),
  mockStoreGetCollectionUrls: vi.fn().mockResolvedValue([]),
  mockStoreGetDocument: vi.fn().mockResolvedValue(null),
  mockStoreSearchByText: vi.fn().mockResolvedValue([]),
  requestHandlers: [] as ToolHandler[],
  testConfig: {
    maxChunkSize: 1000,
    cacheSize: 100,
    dataDir: '/tmp/test',
    dbPath: '/tmp/test/docs.db',
    vectorDbPath: '/tmp/test/vectors',
  },
}));

mockLoadConfig.mockResolvedValue(testConfig);

mockRunLatest.mockImplementation(async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
  const completion = Promise.resolve().then(() => operation(new AbortController().signal));
  return { completion, replacedExisting: false };
});

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(function () {
    return {
      server: {
        setRequestHandler: vi.fn((_schema: unknown, handler: ToolHandler) => {
          requestHandlers.push(handler);
        }),
        notification: mockNotification,
        onerror: null,
      },
      connect: mockServerConnect,
      close: mockServerClose,
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock('./storage/storage.js', () => ({
  DocumentStore: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      listDocuments: vi.fn().mockResolvedValue([]),
      getDocument: mockStoreGetDocument,
      searchByText: mockStoreSearchByText,
      addDocument: mockStoreAddDocument,
      deleteDocument: mockStoreDeleteDocument,
      setTags: vi.fn().mockResolvedValue(undefined),
      listAllTags: vi.fn().mockResolvedValue([]),
      getCollectionUrls: mockStoreGetCollectionUrls,
      optimize: vi.fn().mockResolvedValue({ compacted: false, cleanedUp: false }),
    };
  }),
}));

vi.mock('./indexing/queue-manager.js', () => ({
  IndexingQueueManager: function () {
    let closed = false;
    return {
      runLatest: (...args: Parameters<typeof mockRunLatest>) =>
        closed ? Promise.reject(new Error('Indexing queue is closed')) : mockRunLatest(...args),
      cancelAll: () => {
        closed = true;
        return mockQueueCancelAll();
      },
    };
  },
}));

vi.mock('./embeddings/fastembed.js', () => ({
  FastEmbeddings: vi.fn().mockImplementation(function () {
    return {
      dimensions: 384,
      embed: vi.fn().mockResolvedValue(new Array(384).fill(0)),
    };
  }),
}));

vi.mock('./processor/processor.js', () => ({
  WebDocumentProcessor: vi.fn().mockImplementation(function () {
    return {
      process: mockProcessorProcess,
    };
  }),
}));

vi.mock('./crawler/docs-crawler.js', () => ({
  DocsCrawler: vi.fn().mockImplementation(function () {
    return {
      crawl: mockCrawlerCrawl,
      abort: mockCrawlerAbort,
      setPathPrefix: mockCrawlerSetPathPrefix,
      setStorageState: vi.fn(),
    };
  }),
}));

vi.mock('./crawler/auth.js', () => ({
  AuthManager: vi.fn().mockImplementation(function () {
    return {
      initialize: mockAuthInitialize,
      cleanup: mockAuthCleanup,
      hasSession: mockAuthHasSession,
      loadSession: vi.fn().mockResolvedValue(null),
      clearSession: mockClearSession,
      performInteractiveLogin: vi.fn().mockResolvedValue(undefined),
      validateSession: vi.fn().mockResolvedValue({ isValid: true }),
    };
  }),
}));

vi.mock('./config.js', () => ({
  loadConfig: mockLoadConfig,
  isValidPublicUrl: mockIsValidPublicUrl,
  normalizeUrl: vi.fn().mockImplementation((url: string) => url.replace(/\/$/, '')),
}));

vi.mock('./util/favicon.js', () => ({
  fetchFavicon: mockFetchFavicon,
}));

vi.mock('./util/outbound-request.js', () => ({
  closeOutboundProxy: mockCloseOutboundProxy,
}));

vi.mock('./util/docs.js', () => ({
  generateDocId: vi.fn().mockImplementation((url: string, title: string) => {
    if (title.includes('/')) {
      return title.toLowerCase().replace(/[@/]/g, '-').replace(/\s+/g, '-');
    }
    const hostname = new URL(url).hostname;
    return hostname.replace(/\./g, '-');
  }),
  generateCrawlStorageId: vi.fn().mockImplementation((url: string) => `crawl-${new URL(url).hostname}`),
}));

vi.mock('crawlee', () => ({
  log: { setLevel: vi.fn(), LEVELS: { OFF: 0 } },
  Configuration: { getGlobalConfig: vi.fn().mockReturnValue({ set: vi.fn() }) },
  Dataset: { open: mockDatasetOpen },
}));

const processedPageWithChunk = {
  metadata: { url: 'https://example.com', title: 'Test', lastIndexed: new Date() },
  chunks: [
    {
      content: 'content',
      url: 'https://example.com',
      title: 'Test',
      path: '/',
      startLine: 1,
      endLine: 1,
      vector: [0],
      metadata: { type: 'overview' as const },
    },
  ],
};

describe('WebDocsServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('registered tool handler integration', () => {
    let toolHandler: ToolHandler;

    beforeAll(async () => {
      requestHandlers.length = 0;
      await import('./index.js');
      await nextTurn();
      toolHandler = requestHandlers.at(-1)!;
    });

    it.each([
      { progressToken: 0, url: 'https://progress-zero.example.com' },
      { progressToken: '', url: 'https://progress-empty.example.com' },
    ])('forwards progress token $progressToken from request metadata', async ({ progressToken, url }) => {
      const failIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'failIndexing');

      await toolHandler({
        params: {
          name: 'add_documentation',
          arguments: { url },
          _meta: { progressToken },
        },
      });

      await vi.waitFor(() => expect(failIndexing).toHaveBeenCalled());
      expect(mockNotification).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ progressToken }) }));
    });

    it('ignores progress metadata inside tool arguments', async () => {
      const failIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'failIndexing');

      await toolHandler({
        params: {
          name: 'add_documentation',
          arguments: { url: 'https://argument-metadata.example.com', _meta: { progressToken: 'argument-token' } },
        },
      });

      await vi.waitFor(() => expect(failIndexing).toHaveBeenCalled());
      expect(mockNotification).not.toHaveBeenCalled();
    });

    it('keeps operations distinct when two documents use the same compatibility ID', async () => {
      const startIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'startIndexing');
      const failIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'failIndexing');

      const responses = await Promise.all(
        ['first', 'second'].map((name) =>
          toolHandler({
            params: {
              name: 'add_documentation',
              arguments: { url: `https://${name}.example.com`, id: 'shared-document-id' },
              _meta: { progressToken: `${name}-token` },
            },
          })
        )
      );
      const payloads = responses.map((response) =>
        JSON.parse((response as { content: Array<{ text: string }> }).content[0].text)
      ) as Array<{ docId: string; operationId: string }>;

      await vi.waitFor(() => expect(failIndexing).toHaveBeenCalledTimes(2));

      expect(payloads.map(({ docId }) => docId)).toEqual(['shared-document-id', 'shared-document-id']);
      expect(payloads[0].operationId).not.toBe(payloads[1].operationId);
      expect(startIndexing.mock.calls).toEqual(
        expect.arrayContaining([
          [payloads[0].operationId, 'shared-document-id', 'https://first.example.com', 'first.example.com'],
          [payloads[1].operationId, 'shared-document-id', 'https://second.example.com', 'second.example.com'],
        ])
      );
      for (const progressToken of ['first-token', 'second-token']) {
        expect(mockNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            params: expect.objectContaining({
              progressToken,
              message: expect.stringContaining('No content was extracted'),
            }),
          })
        );
      }
    });

    it('does not start or notify a rejected operation before admitting its tokenless successor', async () => {
      const startIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'startIndexing');
      let successorCompletion!: Promise<void>;
      mockRunLatest
        .mockRejectedValueOnce(new Error('replacement cancellation timed out'))
        .mockImplementationOnce(async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
          successorCompletion = Promise.resolve().then(() => operation(new AbortController().signal));
          return { completion: successorCompletion, replacedExisting: false };
        });

      try {
        await expect(
          toolHandler({
            params: {
              name: 'add_documentation',
              arguments: { url: 'https://example.com' },
              _meta: { progressToken: 'rejected-token' },
            },
          })
        ).rejects.toThrow('replacement cancellation timed out');
        expect(startIndexing).not.toHaveBeenCalled();

        await toolHandler({ params: { name: 'add_documentation', arguments: { url: 'https://example.com' } } });
        await successorCompletion;

        expect(startIndexing).toHaveBeenCalledOnce();
        expect(mockNotification.mock.calls.some(([notification]) => notification.params?.progressToken === 'rejected-token')).toBe(false);
      }
      finally {
        await Promise.allSettled(successorCompletion ? [successorCompletion] : []);
      }
    });

    it.each([
      {
        name: 'keeps successor progress state when an old terminal notification finishes late',
        firstToken: 'same-token',
        secondToken: 'same-token',
      },
      {
        name: 'does not reuse an old progress token when its tokenless successor starts',
        firstToken: 'old-token',
        secondToken: undefined,
      },
    ])('$name', async ({ firstToken, secondToken }) => {
      const startIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'startIndexing');
      const firstStoreLookup = Promise.withResolvers<void>();
      const secondStoreLookup = Promise.withResolvers<void>();
      const oldTerminalNotification = Promise.withResolvers<void>();
      const oldTerminalStarted = Promise.withResolvers<void>();
      const successorProgressed = Promise.withResolvers<void>();
      const releaseSuccessorCrawl = Promise.withResolvers<void>();
      mockStoreGetDocument.mockReturnValueOnce(firstStoreLookup.promise).mockReturnValueOnce(secondStoreLookup.promise);
      mockCrawlerCrawl.mockImplementationOnce(async function* () {
        yield { url: 'https://example.com', path: '/', content: 'Test', contentFormat: 'text', title: 'Test' };
        successorProgressed.resolve();
        await releaseSuccessorCrawl.promise;
      });
      mockNotification.mockImplementation(async (notification: { params?: { message?: string } }) => {
        if (notification.params?.message?.startsWith('Cancelled -')) {
          oldTerminalStarted.resolve();
          await oldTerminalNotification.promise;
        }
      });

      let active: { controller: AbortController; completion: Promise<void> } | undefined;
      const completions: Promise<void>[] = [];
      const runLatest = async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
        const previous = active;
        if (previous) {
          previous.controller.abort();
          await previous.completion;
        }
        const controller = new AbortController();
        const completion = Promise.resolve().then(() => operation(controller.signal));
        completions.push(completion);
        active = { controller, completion };
        return { completion, replacedExisting: previous !== undefined };
      };
      mockRunLatest.mockImplementationOnce(runLatest).mockImplementationOnce(runLatest);

      try {
        await toolHandler({
          params: {
            name: 'add_documentation',
            arguments: { url: 'https://example.com' },
            _meta: { progressToken: firstToken },
          },
        });
        await nextTurn();
        expect(startIndexing).toHaveBeenCalledOnce();

        const replacementResponse = toolHandler({
          params: {
            name: 'add_documentation',
            arguments: { url: 'https://example.com' },
            ...(secondToken !== undefined && { _meta: { progressToken: secondToken } }),
          },
        });
        await nextTurn();
        firstStoreLookup.resolve();
        await oldTerminalStarted.promise;
        await replacementResponse;
        await nextTurn();

        expect(startIndexing).toHaveBeenCalledTimes(2);
        const notificationsAtSuccessorBoundary = mockNotification.mock.calls.length;

        oldTerminalNotification.resolve();
        await nextTurn();

        secondStoreLookup.resolve();
        await successorProgressed.promise;

        releaseSuccessorCrawl.resolve();
        await active!.completion;
        if (secondToken) {
          const successorNotifications = mockNotification.mock.calls
            .slice(notificationsAtSuccessorBoundary)
            .map(([notification]) => notification.params);
          expect(successorNotifications).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ progressToken: secondToken, message: expect.stringContaining('Finding subpages') }),
              expect.objectContaining({ progressToken: secondToken, message: expect.stringContaining('No content was extracted') }),
            ])
          );
        }
        else {
          expect(
            mockNotification.mock.calls
              .slice(notificationsAtSuccessorBoundary)
              .some(([notification]) => notification.params?.progressToken === firstToken)
          ).toBe(false);
        }
      }
      finally {
        firstStoreLookup.resolve();
        secondStoreLookup.resolve();
        oldTerminalNotification.resolve();
        releaseSuccessorCrawl.resolve();
        await Promise.allSettled(completions);
        mockNotification.mockResolvedValue(undefined);
      }
    });

    it('reports cancellation when an aborted crawler rejects with an ordinary error', async () => {
      const enteredCrawl = Promise.withResolvers<void>();
      const releaseCrawl = Promise.withResolvers<void>();
      mockCrawlerCrawl.mockImplementationOnce(async function* () {
        yield* [];
        enteredCrawl.resolve();
        await releaseCrawl.promise;
        throw new Error('crawler stopped');
      });
      const cancelIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'cancelIndexing');
      const failIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'failIndexing');
      const controller = new AbortController();
      let completion!: Promise<void>;
      mockRunLatest.mockImplementationOnce(async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
        completion = Promise.resolve().then(() => operation(controller.signal));
        return { completion, replacedExisting: false };
      });

      try {
        await toolHandler({ params: { name: 'add_documentation', arguments: { url: 'https://example.com' } } });
        await enteredCrawl.promise;
        controller.abort();
        releaseCrawl.resolve();
        await completion;

        expect(cancelIndexing).toHaveBeenCalledOnce();
        expect(failIndexing).not.toHaveBeenCalled();
      }
      finally {
        releaseCrawl.resolve();
        await Promise.allSettled(completion ? [completion] : []);
      }
    });

    it('cancels instead of failing when abort arrives while an expired session is being cleared', async () => {
      const clearSession = Promise.withResolvers<void>();
      const clearSessionStarted = Promise.withResolvers<void>();
      const controller = new AbortController();
      const cancelIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'cancelIndexing');
      const failIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'failIndexing');
      let completion!: Promise<void>;
      mockCrawlerCrawl.mockImplementationOnce(async function* () {
        yield* [];
        throw new SessionExpiredError('session expired', 'https://example.com', 'https://example.com/login', {
          isLoginPage: true,
          confidence: 1,
          reasons: ['login page'],
        });
      });
      mockClearSession.mockImplementationOnce(() => {
        clearSessionStarted.resolve();
        return clearSession.promise;
      });
      mockRunLatest.mockImplementationOnce(async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
        completion = Promise.resolve().then(() => operation(controller.signal));
        return { completion, replacedExisting: false };
      });

      try {
        await toolHandler({
          params: {
            name: 'add_documentation',
            arguments: { url: 'https://example.com' },
            _meta: { progressToken: 'expired-session-token' },
          },
        });
        await clearSessionStarted.promise;
        controller.abort();
        clearSession.resolve();
        await Promise.allSettled([completion]);
        await nextTurn();

        expect(cancelIndexing).toHaveBeenCalledOnce();
        expect(failIndexing).not.toHaveBeenCalled();
        expect(
          mockNotification.mock.calls.some(
            ([notification]) =>
              notification.params?.progressToken === 'expired-session-token' && notification.params?.message?.startsWith('Cancelled -')
          )
        ).toBe(true);
        expect(
          mockNotification.mock.calls.some(([notification]) => notification.params?.message?.includes('Authentication session has expired'))
        ).toBe(false);
      }
      finally {
        controller.abort();
        clearSession.resolve();
        await Promise.allSettled(completion ? [completion] : []);
      }
    });

    it('cancels instead of completing an existing add after its document lookup resolves', async () => {
      const lookup = Promise.withResolvers<DocumentMetadata>();
      const lookupStarted = Promise.withResolvers<void>();
      const controller = new AbortController();
      const cancelIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'cancelIndexing');
      const completeIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'completeIndexing');
      const failIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'failIndexing');
      let completion!: Promise<void>;
      mockStoreGetDocument.mockImplementationOnce(() => {
        lookupStarted.resolve();
        return lookup.promise;
      });
      mockRunLatest.mockImplementationOnce(async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
        completion = Promise.resolve().then(() => operation(controller.signal));
        return { completion, replacedExisting: false };
      });

      try {
        await toolHandler({ params: { name: 'add_documentation', arguments: { url: 'https://example.com' } } });
        await lookupStarted.promise;
        controller.abort();
        lookup.resolve({ url: 'https://example.com', title: 'Existing', lastIndexed: new Date() });
        await completion;

        expect(cancelIndexing).toHaveBeenCalledOnce();
        expect(completeIndexing).not.toHaveBeenCalled();
        expect(failIndexing).not.toHaveBeenCalled();
        expect(mockCrawlerCrawl).not.toHaveBeenCalled();
      }
      finally {
        lookup.resolve({ url: 'https://example.com', title: 'Existing', lastIndexed: new Date() });
        await Promise.allSettled(completion ? [completion] : []);
      }
    });

    it('does not store a document when cancellation arrives during favicon lookup', async () => {
      const favicon = Promise.withResolvers<string | null>();
      const faviconStarted = Promise.withResolvers<void>();
      const controller = new AbortController();
      const cancelIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'cancelIndexing');
      const completeIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'completeIndexing');
      const failIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'failIndexing');
      let completion!: Promise<void>;
      mockProcessorProcess.mockResolvedValueOnce(processedPageWithChunk);
      mockFetchFavicon.mockImplementationOnce(() => {
        faviconStarted.resolve();
        return favicon.promise;
      });
      mockRunLatest.mockImplementationOnce(async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
        completion = Promise.resolve().then(() => operation(controller.signal));
        return { completion, replacedExisting: false };
      });

      try {
        await toolHandler({ params: { name: 'add_documentation', arguments: { url: 'https://example.com' } } });
        await faviconStarted.promise;
        controller.abort();
        favicon.resolve(null);
        await completion;

        expect(cancelIndexing).toHaveBeenCalledOnce();
        expect(mockStoreAddDocument).not.toHaveBeenCalled();
        expect(completeIndexing).not.toHaveBeenCalled();
        expect(failIndexing).not.toHaveBeenCalled();
      }
      finally {
        favicon.resolve(null);
        await Promise.allSettled(completion ? [completion] : []);
      }
    });

    it('does not complete when cancellation arrives during document storage', async () => {
      const add = Promise.withResolvers<void>();
      const addStarted = Promise.withResolvers<void>();
      const controller = new AbortController();
      const cancelIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'cancelIndexing');
      const completeIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'completeIndexing');
      const failIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'failIndexing');
      let completion!: Promise<void>;
      mockProcessorProcess.mockResolvedValueOnce(processedPageWithChunk);
      mockStoreAddDocument.mockImplementationOnce(() => {
        addStarted.resolve();
        return add.promise;
      });
      mockRunLatest.mockImplementationOnce(async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
        completion = Promise.resolve().then(() => operation(controller.signal));
        return { completion, replacedExisting: false };
      });

      try {
        await toolHandler({ params: { name: 'add_documentation', arguments: { url: 'https://example.com' } } });
        await addStarted.promise;
        controller.abort();
        add.resolve();
        await completion;

        expect(cancelIndexing).toHaveBeenCalledOnce();
        expect(mockStoreAddDocument).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal, tags: [] });
        expect(completeIndexing).not.toHaveBeenCalled();
        expect(failIndexing).not.toHaveBeenCalled();
      }
      finally {
        add.resolve();
        await Promise.allSettled(completion ? [completion] : []);
      }
    });

    it('stops retrying a conflicted write when cancellation arrives during backoff', async () => {
      const firstAttempt = Promise.withResolvers<void>();
      const controller = new AbortController();
      const cancelIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'cancelIndexing');
      const completeIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'completeIndexing');
      let completion!: Promise<void>;
      mockProcessorProcess.mockResolvedValueOnce(processedPageWithChunk);
      mockStoreAddDocument.mockImplementationOnce(async () => {
        firstAttempt.resolve();
        throw new Error('Commit conflict');
      });
      mockRunLatest.mockImplementationOnce(async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
        completion = Promise.resolve().then(() => operation(controller.signal));
        return { completion, replacedExisting: false };
      });

      try {
        await toolHandler({ params: { name: 'add_documentation', arguments: { url: 'https://example.com' } } });
        await firstAttempt.promise;
        await nextTurn();
        controller.abort();
        await completion;

        expect(cancelIndexing).toHaveBeenCalledOnce();
        expect(mockStoreAddDocument).toHaveBeenCalledOnce();
        expect(completeIndexing).not.toHaveBeenCalled();
      }
      finally {
        controller.abort();
        await Promise.allSettled(completion ? [completion] : []);
      }
    });

    it('starts reindex status inside runLatest and preserves the replacement message', async () => {
      const url = 'https://example.com';
      mockStoreGetDocument.mockResolvedValueOnce({
        url,
        title: 'Example Docs',
        lastIndexed: new Date(),
        requiresAuth: false,
        tags: ['docs'],
        pathPrefix: '/api/v2',
      });
      mockProcessorProcess.mockResolvedValueOnce(processedPageWithChunk);
      const startIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'startIndexing');
      let completion!: Promise<void>;
      mockRunLatest.mockImplementationOnce(async (_url: string, operation: (signal: AbortSignal) => Promise<void>) => {
        expect(startIndexing).not.toHaveBeenCalled();
        completion = Promise.resolve().then(() => operation(new AbortController().signal));
        await nextTurn();
        expect(startIndexing).toHaveBeenCalledOnce();
        return { completion, replacedExisting: true };
      });

      const response = (await toolHandler({ params: { name: 'reindex_documentation', arguments: { url } } })) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(response.content[0].text) as { docId: string; message: string; operationId: string };

      expect(payload.message).toContain('Previous operation was cancelled');
      expect(payload.operationId).not.toBe(payload.docId);
      expect(mockRunLatest).toHaveBeenCalledOnce();
      await completion;
      expect(startIndexing).toHaveBeenCalledWith(payload.operationId, payload.docId, url, 'Example Docs');
      expect(mockCrawlerSetPathPrefix).toHaveBeenCalledWith('/api/v2');
      expect(mockStoreAddDocument).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ pathPrefix: '/api/v2' }) }),
        expect.objectContaining({ tags: ['docs'] })
      );
    });

    it('deletes current and historical crawl datasets independently', async () => {
      const legacyDrop = vi.fn().mockResolvedValue(undefined);
      mockStoreGetDocument.mockResolvedValueOnce({
        url: 'https://docs.example.com',
        title: '@org/package',
        lastIndexed: new Date(),
      });
      mockDatasetOpen.mockRejectedValueOnce(new Error('current dataset missing')).mockResolvedValueOnce({ drop: legacyDrop });

      const response = (await toolHandler({
        params: { name: 'delete_documentation', arguments: { url: 'https://docs.example.com' } },
      })) as { content: Array<{ text: string }> };
      const payload = JSON.parse(response.content[0].text) as { deletedItems: string[] };

      expect(mockDatasetOpen.mock.calls).toEqual([['crawl-docs.example.com'], ['docs-example-com']]);
      expect(legacyDrop).toHaveBeenCalledOnce();
      expect(payload.deletedItems).toContain('crawl cache (Crawlee dataset)');
      expect(mockStoreDeleteDocument).toHaveBeenCalledWith('https://docs.example.com');
    });

    it('scopes collection searches to the collection document URLs', async () => {
      const collectionUrls = ['https://example.com/react', 'https://example.com/vue'];
      mockStoreGetCollectionUrls.mockResolvedValueOnce(collectionUrls);

      await toolHandler({
        params: {
          name: 'search_collection',
          arguments: { name: 'frontend', query: 'hooks', limit: 2 },
        },
      });

      expect(mockStoreSearchByText).toHaveBeenCalledWith('hooks', { limit: 2, filterUrls: collectionUrls });
    });

    it('fails fast and preserves an existing document when one page fails processing', async () => {
      const existingDocument = {
        url: 'https://example.com',
        title: 'Example Docs',
        lastIndexed: new Date(),
        requiresAuth: false,
        tags: ['existing'],
      };
      mockStoreGetDocument.mockResolvedValueOnce(existingDocument).mockResolvedValueOnce(existingDocument);
      mockCrawlerCrawl.mockImplementationOnce(async function* () {
        yield { url: 'https://example.com/one', path: '/one', content: 'One', contentFormat: 'text', title: 'One' };
        yield { url: 'https://example.com/two', path: '/two?token=secret', content: 'Two', contentFormat: 'text', title: 'Two' };
        yield { url: 'https://example.com/three', path: '/three', content: 'Three', contentFormat: 'text', title: 'Three' };
      });
      mockProcessorProcess.mockResolvedValueOnce(processedPageWithChunk).mockRejectedValueOnce(new Error('Embedding failed'));
      const failIndexing = vi.spyOn(IndexingStatusTracker.prototype, 'failIndexing');

      const response = (await toolHandler({
        params: {
          name: 'reindex_documentation',
          arguments: { url: 'https://example.com' },
        },
      })) as { content: Array<{ text: string }> };
      const { operationId } = JSON.parse(response.content[0].text) as { operationId: string };

      await vi.waitFor(() => expect(failIndexing).toHaveBeenCalledWith(operationId, 'Failed to process /two?[REDACTED] Embedding failed'));
      expect(mockProcessorProcess).toHaveBeenCalledTimes(2);
      expect(mockFetchFavicon).not.toHaveBeenCalled();
      expect(mockStoreDeleteDocument).not.toHaveBeenCalled();
      expect(mockStoreAddDocument).not.toHaveBeenCalled();
    });
  });

  describe('process shutdown', () => {
    const captureProcess = () => {
      const handlers = new Map<string, NodeJS.SignalsListener>();
      vi.spyOn(process, 'once').mockImplementation(((event: string, listener: NodeJS.SignalsListener) => {
        handlers.set(event, listener);
        return process;
      }) as typeof process.once);
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
      return { handlers, exit };
    };

    beforeEach(() => {
      vi.useFakeTimers();
      mockServerConnect.mockResolvedValue(undefined);
      mockServerClose.mockResolvedValue(undefined);
      mockQueueCancelAll.mockResolvedValue(undefined);
      mockAuthInitialize.mockResolvedValue(undefined);
      mockAuthCleanup.mockResolvedValue(undefined);
      mockAuthHasSession.mockResolvedValue(false);
      mockCloseOutboundProxy.mockResolvedValue(undefined);
      mockIsValidPublicUrl.mockReturnValue(true);
      mockLoadConfig.mockResolvedValue(testConfig);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('deduplicates mixed signals and starts every cleanup while indexing settles', async () => {
      const cancellation = Promise.withResolvers<void>();
      mockQueueCancelAll.mockReturnValue(cancellation.promise);
      const { handlers, exit } = captureProcess();

      vi.resetModules();
      const { IndexingStatusTracker: StatusTracker } = await import('./indexing/status.js');
      const stop = vi.spyOn(StatusTracker.prototype, 'stop');
      await import('./index.js');
      await vi.waitFor(() => expect(mockServerConnect).toHaveBeenCalledOnce());

      handlers.get('SIGINT')?.('SIGINT');
      handlers.get('SIGTERM')?.('SIGTERM');
      await vi.waitFor(() => expect(mockQueueCancelAll).toHaveBeenCalledOnce());

      expect(mockServerClose).toHaveBeenCalledOnce();
      expect(mockServerClose.mock.invocationCallOrder[0]).toBeLessThan(mockQueueCancelAll.mock.invocationCallOrder[0]);
      expect(stop).toHaveBeenCalledOnce();
      expect(mockAuthCleanup).toHaveBeenCalledOnce();
      expect(mockCloseOutboundProxy).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      cancellation.resolve();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

      expect(exit).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not connect when shutdown starts during initialization', async () => {
      const config = Promise.withResolvers<typeof testConfig>();
      mockLoadConfig.mockReturnValue(config.promise);
      const { handlers, exit } = captureProcess();

      vi.resetModules();
      await import('./index.js');
      handlers.get('SIGTERM')?.('SIGTERM');
      await Promise.resolve();

      config.resolve(testConfig);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

      expect(mockServerConnect).not.toHaveBeenCalled();
      expect(mockAuthCleanup).toHaveBeenCalledOnce();
    });

    it('cleans up safely when initialization fails before auth exists', async () => {
      const config = Promise.withResolvers<typeof testConfig>();
      mockLoadConfig.mockReturnValue(config.promise);
      const { handlers, exit } = captureProcess();

      vi.resetModules();
      await import('./index.js');
      handlers.get('SIGINT')?.('SIGINT');
      config.reject(new Error('configuration unavailable'));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

      expect(mockAuthCleanup).not.toHaveBeenCalled();
    });

    it('drains a tool call accepted while the transport is closing', async () => {
      const preflight = Promise.withResolvers<boolean>();
      const serverClose = Promise.withResolvers<void>();
      mockAuthHasSession.mockReturnValue(preflight.promise);
      mockServerClose.mockReturnValue(serverClose.promise);
      const { handlers, exit } = captureProcess();

      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(mockServerConnect).toHaveBeenCalledOnce());

      handlers.get('SIGTERM')?.('SIGTERM');
      await vi.waitFor(() => expect(mockQueueCancelAll).toHaveBeenCalledOnce());

      const toolHandler = requestHandlers.at(-1)!;
      const toolCall = toolHandler({
        params: { name: 'add_documentation', arguments: { url: 'https://example.com' } },
      });
      const rejection = expect(toolCall).rejects.toThrow('Indexing queue is closed');

      serverClose.resolve();
      await Promise.resolve();
      expect(exit).not.toHaveBeenCalled();

      preflight.resolve(false);
      await rejection;
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    });

    it('exits once with failure when graceful shutdown times out', async () => {
      const cancellation = Promise.withResolvers<void>();
      mockQueueCancelAll.mockReturnValue(cancellation.promise);
      const { handlers, exit } = captureProcess();

      vi.resetModules();
      await import('./index.js');
      await vi.waitFor(() => expect(mockServerConnect).toHaveBeenCalledOnce());

      handlers.get('SIGINT')?.('SIGINT');
      handlers.get('SIGTERM')?.('SIGTERM');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(exit).toHaveBeenCalledWith(1);

      cancellation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledOnce();
    });
  });
});
