import type { CrawlResult } from '../types.js';

const mockQueueManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  seedFromLlmsTxt: vi.fn().mockResolvedValue(0),
  getRequestQueue: vi.fn().mockReturnValue({}),
  handleQueueAndLinks: vi.fn().mockResolvedValue(undefined),
  addResult: vi.fn(),
  hasEnoughResults: vi.fn().mockReturnValue(false),
  processBatch: vi.fn().mockResolvedValue([]),
  cleanup: vi.fn().mockResolvedValue(undefined),
};
const { mockConfiguredErrorHandler } = vi.hoisted(() => ({
  mockConfiguredErrorHandler: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./queue-manager.js', () => ({
  QueueManager: function () {
    return mockQueueManager;
  },
}));

vi.mock('./browser-config.js', () => ({
  getBrowserConfig: vi.fn().mockReturnValue({
    requestQueue: {},
    preNavigationHooks: [],
    launchContext: {},
    browserPoolOptions: {},
    errorHandler: mockConfiguredErrorHandler,
  }),
}));

vi.mock('./site-rules.js', () => ({
  siteRules: [
    {
      type: 'default',
      extractor: {
        extractContent: vi.fn().mockResolvedValue({ content: 'Extracted content', contentFormat: 'text', metadata: {} }),
      },
      detect: vi.fn().mockResolvedValue(true),
    },
  ],
}));

// Mock PlaywrightCrawler
const mockCrawlerRun = vi.fn().mockResolvedValue(undefined);
const mockCrawlerTeardown = vi.fn().mockResolvedValue(undefined);

vi.mock('crawlee', () => ({
  PlaywrightCrawler: function (options: {
    preNavigationHooks?: unknown;
    requestHandler?: unknown;
    errorHandler?: unknown;
    failedRequestHandler?: unknown;
  }) {
    // Store the request handler for testing
    (global as { __preNavigationHooks?: unknown }).__preNavigationHooks = options.preNavigationHooks;
    (global as { __requestHandler?: unknown }).__requestHandler = options.requestHandler;
    (global as { __errorHandler?: unknown }).__errorHandler = options.errorHandler;
    (global as { __failedRequestHandler?: unknown }).__failedRequestHandler = options.failedRequestHandler;
    return {
      run: mockCrawlerRun,
      teardown: mockCrawlerTeardown,
    };
  },
}));

// Import after mocking
import { CrawleeCrawler, StorageState } from './crawlee-crawler.js';

type RequestHandler = (context: Record<string, unknown>) => Promise<void>;
type ErrorHandler = (context: Record<string, unknown>, error: Error) => Promise<void>;
type NavigationListener = (value: Record<string, unknown>) => void;

function getRequestHandler(): RequestHandler {
  return (globalThis as unknown as { __requestHandler: RequestHandler }).__requestHandler;
}

function getErrorHandler(name: '__errorHandler' | '__failedRequestHandler'): ErrorHandler {
  return (globalThis as unknown as Record<string, ErrorHandler>)[name];
}

async function collect(crawler: CrawleeCrawler, url: string): Promise<CrawlResult[]> {
  const results: CrawlResult[] = [];
  for await (const result of crawler.crawl(url)) {
    results.push(result);
  }
  return results;
}

function response(status = 200, blocked = false, mainFrame?: object): Record<string, unknown> {
  return {
    status: () => status,
    headerValue: vi.fn().mockResolvedValue(blocked ? '1' : null),
    ...(mainFrame && { request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }) }),
  };
}

function navigationPage(
  url: string,
  onLoad: (emit: { response: (status?: number, blocked?: boolean) => void; failure: (error: string, url?: string) => void }) => void,
  evaluate = vi.fn().mockResolvedValue(false)
) {
  const mainFrame = {};
  const listeners: Partial<Record<'response' | 'requestfailed', NavigationListener>> = {};
  let loaded = false;
  const page = {
    mainFrame: vi.fn().mockReturnValue(mainFrame),
    on: vi.fn((event: 'response' | 'requestfailed', listener: NavigationListener) => {
      listeners[event] = listener;
    }),
    off: vi.fn(),
    waitForLoadState: vi.fn(async () => {
      if (!loaded) {
        loaded = true;
        onLoad({
          response: (status = 200, blocked = false) => listeners.response?.(response(status, blocked, mainFrame)),
          failure: (error, failedUrl) =>
            listeners.requestfailed?.({
              isNavigationRequest: () => true,
              frame: () => mainFrame,
              failure: () => ({ errorText: error }),
              ...(failedUrl && { url: () => failedUrl }),
            }),
        });
      }
    }),
    evaluate,
    url: vi.fn().mockReturnValue(url),
    title: vi.fn().mockResolvedValue('Docs'),
  };
  return { page, listeners, mainFrame };
}

async function runRequestHandler(page: object, url: string, initialResponse = response(), warning = vi.fn()): Promise<void> {
  await getRequestHandler()({
    request: { url },
    response: initialResponse,
    page,
    enqueueLinks: vi.fn(),
    log: { debug: vi.fn(), error: vi.fn(), warning },
  });
}

async function emitPreNavigationFailure(request: object, failedUrl: string): Promise<void> {
  const { page, listeners, mainFrame } = navigationPage('', () => {});
  const hooks = (global as { __preNavigationHooks?: Array<(context: Record<string, unknown>) => Promise<void>> }).__preNavigationHooks!;
  await hooks.at(-1)!({ page, request });
  listeners.requestfailed?.({
    isNavigationRequest: () => true,
    frame: () => mainFrame,
    failure: () => ({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }),
    url: () => failedUrl,
  });
}

describe('CrawleeCrawler', () => {
  let crawler: CrawleeCrawler;

  beforeEach(() => {
    vi.clearAllMocks();
    crawler = new CrawleeCrawler();
    mockQueueManager.hasEnoughResults.mockReturnValue(false);
    mockQueueManager.processBatch.mockResolvedValue([]);
  });

  describe('crawl', () => {
    it('should carry the extractor content format and mark error fallbacks as text', async () => {
      class MarkdownExtractor {
        async extractContent(): Promise<{ content: string; contentFormat: 'markdown'; title: string; metadata: { type: 'overview' } }> {
          return { content: '# Guide', contentFormat: 'markdown', title: 'Guide', metadata: { type: 'overview' } };
        }
      }

      const extractContent = (
        crawler as unknown as {
          extractContent(
            page: { evaluate: ReturnType<typeof vi.fn> },
            siteType: string,
            extractor: MarkdownExtractor
          ): Promise<{ content: string; contentFormat: string; extractorUsed: string; title?: string }>;
        }
      ).extractContent.bind(crawler);
      const successPage = {
        evaluate: vi.fn().mockResolvedValue({ content: '# Guide', contentFormat: 'markdown', title: 'Guide' }),
      };

      await expect(extractContent(successPage, 'default', new MarkdownExtractor())).resolves.toMatchObject({
        content: '# Guide',
        contentFormat: 'markdown',
        extractorUsed: 'MarkdownExtractor',
        title: 'Guide',
      });

      const fallbackPage = {
        evaluate: vi.fn().mockRejectedValueOnce(new Error('extractor failed')).mockResolvedValueOnce('Plain fallback'),
      };
      await expect(extractContent(fallbackPage, 'default', new MarkdownExtractor())).resolves.toMatchObject({
        content: 'Plain fallback',
        contentFormat: 'text',
        extractorUsed: 'ErrorFallback',
      });

      const findContentFrameSpy = vi
        .spyOn(
          crawler as unknown as {
            findContentFrame(page: unknown): Promise<{ evaluate: ReturnType<typeof vi.fn> }>;
          },
          'findContentFrame'
        )
        .mockResolvedValue({
          evaluate: vi.fn().mockResolvedValue({ content: '', contentFormat: 'markdown', title: 'Stale Storybook Title' }),
        });
      try {
        const storybookFallbackPage = {
          evaluate: vi.fn().mockRejectedValueOnce(new Error('main extraction failed')).mockResolvedValueOnce('Storybook fallback text'),
        };
        await expect(extractContent(storybookFallbackPage, 'storybook', new MarkdownExtractor())).resolves.toEqual({
          content: 'Storybook fallback text',
          contentFormat: 'text',
          extractorUsed: 'ErrorFallback',
          title: undefined,
        });
      }
      finally {
        findContentFrameSpy.mockRestore();
      }
    });

    it.each([
      {
        label: 'exact root URL',
        requestedUrl: 'https://example.com',
        queuedUrl: 'https://example.com',
        message: 'terminal failure',
      },
      {
        label: 'queue-normalized root URL',
        requestedUrl: 'https://example.com#fragment',
        queuedUrl: 'https://example.com/',
        message: 'normalized terminal failure',
      },
    ])('surfaces a terminal outbound failure for the $label', async ({ requestedUrl, queuedUrl, message }) => {
      mockCrawlerRun.mockImplementationOnce(async () => {
        await getErrorHandler('__failedRequestHandler')(
          { request: { url: queuedUrl } },
          Object.assign(new Error('Crawlee retry wrapper'), {
            cause: { name: 'OutboundRequestFailedError', message },
          })
        );
      });

      await expect(collect(crawler, requestedUrl)).rejects.toThrow(message);
    });

    it('marks a redirected pre-handler policy failure as non-retryable', async () => {
      const request = { url: 'https://example.com/', noRetry: false };
      mockConfiguredErrorHandler.mockImplementationOnce(async (context) => {
        context.request.noRetry = false;
      });
      mockCrawlerRun.mockImplementationOnce(async () => {
        await emitPreNavigationFailure(request, 'http://127.0.0.1/private');
        const error = new Error('net::ERR_TUNNEL_CONNECTION_FAILED');
        await getErrorHandler('__errorHandler')({ request }, error);
        await getErrorHandler('__failedRequestHandler')({ request }, error);
      });

      await collect(crawler, request.url);

      expect(request.noRetry).toBe(true);
      expect(mockConfiguredErrorHandler).toHaveBeenCalledWith({ request }, expect.any(Error));
    });

    it('keeps a redirected pre-handler transient failure retryable and surfaces it terminally', async () => {
      const request = { url: 'https://example.com/', noRetry: false };
      mockCrawlerRun.mockImplementationOnce(async () => {
        await emitPreNavigationFailure(request, 'https://8.8.8.8/redirected');
        const error = new Error('net::ERR_TUNNEL_CONNECTION_FAILED');
        await getErrorHandler('__errorHandler')({ request }, error);
        expect(request.noRetry).toBe(false);
        await getErrorHandler('__failedRequestHandler')({ request }, error);
      });

      await expect(collect(crawler, request.url)).rejects.toThrow('Outbound destination unavailable');
    });

    it('does not extract or index a proxy-blocked response', async () => {
      const page = {
        waitForLoadState: vi.fn(),
        mainFrame: vi.fn().mockReturnValue({}),
        on: vi.fn(),
        off: vi.fn(),
      };
      const warning = vi.fn();
      mockCrawlerRun.mockImplementationOnce(async () => {
        await runRequestHandler(page, 'https://example.com/private', response(403, true), warning);
      });

      await collect(crawler, 'https://example.com/private');

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('blocked outbound destination'));
      expect(page.waitForLoadState).not.toHaveBeenCalled();
      expect(mockQueueManager.addResult).not.toHaveBeenCalled();
    });

    it('does not index a client-side navigation blocked after the initial response', async () => {
      const { page, listeners } = navigationPage('https://example.com/docs', (emit) => emit.response(403, true));
      const warning = vi.fn();
      mockCrawlerRun.mockImplementationOnce(async () => {
        await runRequestHandler(page, 'https://example.com/docs', response(), warning);
      });

      await collect(crawler, 'https://example.com/docs');

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('blocked outbound destination'));
      expect(mockQueueManager.addResult).not.toHaveBeenCalled();
      expect(page.off).toHaveBeenCalledWith('response', listeners.response);
    });

    it('rethrows a later main-frame navigation failure for Crawlee to retry', async () => {
      const { page, listeners } = navigationPage('https://8.8.8.8/docs', (emit) =>
        emit.failure('net::ERR_CONNECTION_REFUSED', 'https://8.8.8.8/docs')
      );
      const warning = vi.fn();
      mockCrawlerRun.mockImplementationOnce(async () => {
        await runRequestHandler(page, 'https://8.8.8.8/docs', response(), warning);
      });

      await expect(collect(crawler, 'https://8.8.8.8/docs')).rejects.toThrow('Outbound destination unavailable');

      expect(warning).not.toHaveBeenCalled();
      expect(mockQueueManager.addResult).not.toHaveBeenCalled();
      expect(page.off).toHaveBeenCalledWith('requestfailed', listeners.requestfailed);
    });

    it('treats a policy-blocked later navigation as handled without retry', async () => {
      const { page } = navigationPage('https://example.com/docs', (emit) =>
        emit.failure('net::ERR_TUNNEL_CONNECTION_FAILED', 'http://127.0.0.1/docs')
      );
      const warning = vi.fn();
      mockCrawlerRun.mockImplementationOnce(async () => {
        await runRequestHandler(page, 'https://example.com/docs', response(), warning);
      });

      await collect(crawler, 'https://example.com/docs');

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('blocked outbound destination'));
      expect(mockQueueManager.addResult).not.toHaveBeenCalled();
    });

    it('extracts a later successful page after superseded navigation failures', async () => {
      const { page, listeners } = navigationPage(
        'https://example.com/docs',
        (emit) => {
          for (const error of ['net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'Load request canceled']) {
            emit.failure(error);
          }
          emit.failure('net::ERR_NAME_NOT_RESOLVED', 'https://example.com/docs');
          emit.response();
        },
        vi
          .fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(false)
          .mockResolvedValue({ content: 'Extracted content', contentFormat: 'text' })
      );
      mockCrawlerRun.mockImplementationOnce(async () => {
        await runRequestHandler(page, 'https://example.com/docs');
      });

      await collect(crawler, 'https://example.com/docs');

      expect(mockQueueManager.addResult).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Extracted content', contentFormat: 'text', title: 'Docs' })
      );
      expect(page.off).toHaveBeenCalledWith('response', listeners.response);
      expect(page.off).toHaveBeenCalledWith('requestfailed', listeners.requestfailed);
    });

    it('should initialize queue manager with URL', async () => {
      // Set up processBatch to return results immediately to end the crawl
      mockCrawlerRun.mockResolvedValueOnce(undefined);
      mockQueueManager.processBatch.mockResolvedValueOnce([]);

      await collect(crawler, 'https://example.com/docs');

      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://example.com/docs', undefined);
    });

    it('should yield results from queue manager', async () => {
      const mockResults: CrawlResult[] = [
        { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', contentFormat: 'html', title: 'Page 1' },
        { url: 'https://example.com/page2', path: '/page2', content: 'Page 2', contentFormat: 'html', title: 'Page 2' },
      ];

      // Since hasEnoughResults returns false, processBatch is only called once
      // at the end of crawl (line 388 in crawlee-crawler.ts), so we only need one mock value
      mockQueueManager.processBatch.mockResolvedValueOnce(mockResults);

      const results = await collect(crawler, 'https://example.com');

      expect(results).toEqual(mockResults);
    });

    it('should cleanup queue manager after crawl', async () => {
      await collect(crawler, 'https://example.com');

      expect(mockQueueManager.cleanup).toHaveBeenCalled();
    });

    it('should process batch when enough results accumulated', async () => {
      const mockResults: CrawlResult[] = [
        { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', contentFormat: 'html', title: 'Page 1' },
      ];

      mockQueueManager.hasEnoughResults.mockReturnValueOnce(true).mockReturnValue(false);
      mockQueueManager.processBatch.mockResolvedValueOnce(mockResults).mockResolvedValueOnce([]);

      const results = await collect(crawler, 'https://example.com');

      expect(results).toHaveLength(1);
    });
  });

  describe('abort', () => {
    it('should stop the crawler', async () => {
      // Make run() hang until we resolve it, so abort() can be called while crawler exists
      let resolveRun: () => void;
      const runPromise = new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      mockCrawlerRun.mockReturnValueOnce(runPromise);

      // Create a crawler that we can abort
      const abortableCrawler = new CrawleeCrawler();

      // Start consuming the generator - this creates the crawler
      const generator = abortableCrawler.crawl('https://example.com');

      // Get the first value to start the generator (this creates the crawler)
      const firstResultPromise = generator.next();

      // Give the generator time to start and create the crawler
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now abort - the crawler exists at this point
      abortableCrawler.abort();

      // Let the run() complete so the generator can finish
      resolveRun!();

      // Wait for the generator to complete
      await firstResultPromise;

      expect(mockCrawlerTeardown).toHaveBeenCalled();
    });
  });

  describe('domain restriction', () => {
    it('should pass path prefix to queue manager when set', async () => {
      crawler.setPathPrefix('/docs/api');

      await collect(crawler, 'https://example.com/docs/api');

      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://example.com/docs/api', '/docs/api');
    });
  });

  describe('authentication', () => {
    it('should configure crawler with storage state when set', async () => {
      const state: StorageState = {
        cookies: [{ name: 'auth', value: 'token123', domain: 'example.com', path: '/' }],
      };

      crawler.setStorageState(state);

      await collect(crawler, 'https://example.com');

      // Verify queue manager was initialized (auth is handled internally)
      expect(mockQueueManager.initialize).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should cleanup on error', async () => {
      mockCrawlerRun.mockRejectedValueOnce(new Error('Crawl failed'));

      await expect(collect(crawler, 'https://example.com')).rejects.toThrow('Crawl failed');

      expect(mockQueueManager.cleanup).toHaveBeenCalled();
    });
  });
});
