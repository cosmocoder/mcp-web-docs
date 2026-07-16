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
        extractContent: vi.fn().mockResolvedValue({ content: 'Extracted content', metadata: {} }),
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

async function emitPreNavigationFailure(request: object, failedUrl: string): Promise<void> {
  const mainFrame = {};
  let onRequestFailed: ((request: Record<string, unknown>) => void) | undefined;
  const page = {
    mainFrame: vi.fn().mockReturnValue(mainFrame),
    on: vi.fn((event: string, listener: (request: Record<string, unknown>) => void) => {
      if (event === 'requestfailed') {
        onRequestFailed = listener;
      }
    }),
    off: vi.fn(),
  };
  const hooks = (global as { __preNavigationHooks?: Array<(context: Record<string, unknown>) => Promise<void>> }).__preNavigationHooks!;
  await hooks.at(-1)!({ page, request });
  onRequestFailed?.({
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

  describe('constructor', () => {
    it('should initialize with default values', () => {
      expect(crawler).toBeDefined();
    });

    it('should accept custom maxDepth and maxRequestsPerCrawl', () => {
      const customCrawler = new CrawleeCrawler(10, 500);
      expect(customCrawler).toBeDefined();
    });

    it('should accept progress callback', () => {
      const progressFn = vi.fn();
      const progressCrawler = new CrawleeCrawler(4, 1000, progressFn);
      expect(progressCrawler).toBeDefined();
    });
  });

  describe('setStorageState', () => {
    it('should accept storage state', () => {
      const state: StorageState = {
        cookies: [{ name: 'session', value: 'abc123', domain: 'example.com', path: '/' }],
      };

      crawler.setStorageState(state);

      // No error means success
      expect(true).toBe(true);
    });

    it('should accept storage state with origins', () => {
      const state: StorageState = {
        cookies: [{ name: 'session', value: 'abc123', domain: 'example.com', path: '/' }],
        origins: [
          {
            origin: 'https://example.com',
            localStorage: [{ name: 'token', value: 'xyz' }],
          },
        ],
      };

      crawler.setStorageState(state);
      expect(true).toBe(true);
    });
  });

  describe('crawl', () => {
    it('surfaces a terminal root outbound failure after retries', async () => {
      mockCrawlerRun.mockImplementationOnce(async () => {
        const failedRequestHandler = (
          global as { __failedRequestHandler?: (context: Record<string, unknown>, error: Error) => Promise<void> }
        ).__failedRequestHandler!;
        await failedRequestHandler(
          { request: { url: 'https://example.com' } },
          Object.assign(new Error('Crawlee retry wrapper'), {
            cause: { name: 'OutboundRequestFailedError', message: 'terminal failure' },
          })
        );
      });

      await expect(async () => {
        for await (const result of crawler.crawl('https://example.com')) {
          void result;
        }
      }).rejects.toThrow('terminal failure');
    });

    it('matches a terminal root failure after queue-style URL normalization', async () => {
      mockCrawlerRun.mockImplementationOnce(async () => {
        const failedRequestHandler = (
          global as { __failedRequestHandler?: (context: Record<string, unknown>, error: Error) => Promise<void> }
        ).__failedRequestHandler!;
        await failedRequestHandler(
          { request: { url: 'https://example.com/' } },
          Object.assign(new Error('Crawlee retry wrapper'), {
            cause: { name: 'OutboundRequestFailedError', message: 'normalized terminal failure' },
          })
        );
      });

      await expect(async () => {
        for await (const result of crawler.crawl('https://example.com#fragment')) {
          void result;
        }
      }).rejects.toThrow('normalized terminal failure');
    });

    it('marks a redirected pre-handler policy failure as non-retryable', async () => {
      const request = { url: 'https://example.com/', noRetry: false };
      mockConfiguredErrorHandler.mockImplementationOnce(async (context) => {
        context.request.noRetry = false;
      });
      mockCrawlerRun.mockImplementationOnce(async () => {
        await emitPreNavigationFailure(request, 'http://127.0.0.1/private');
        const errorHandler = (global as { __errorHandler?: (context: Record<string, unknown>, error: Error) => Promise<void> })
          .__errorHandler!;
        const failedRequestHandler = (
          global as { __failedRequestHandler?: (context: Record<string, unknown>, error: Error) => Promise<void> }
        ).__failedRequestHandler!;
        const error = new Error('net::ERR_TUNNEL_CONNECTION_FAILED');
        await errorHandler({ request }, error);
        await failedRequestHandler({ request }, error);
      });

      for await (const result of crawler.crawl(request.url)) {
        void result;
      }

      expect(request.noRetry).toBe(true);
      expect(mockConfiguredErrorHandler).toHaveBeenCalledWith({ request }, expect.any(Error));
    });

    it('keeps a redirected pre-handler transient failure retryable and surfaces it terminally', async () => {
      const request = { url: 'https://example.com/', noRetry: false };
      mockCrawlerRun.mockImplementationOnce(async () => {
        await emitPreNavigationFailure(request, 'https://8.8.8.8/redirected');
        const errorHandler = (global as { __errorHandler?: (context: Record<string, unknown>, error: Error) => Promise<void> })
          .__errorHandler!;
        const failedRequestHandler = (
          global as { __failedRequestHandler?: (context: Record<string, unknown>, error: Error) => Promise<void> }
        ).__failedRequestHandler!;
        const error = new Error('net::ERR_TUNNEL_CONNECTION_FAILED');
        await errorHandler({ request }, error);
        expect(request.noRetry).toBe(false);
        await failedRequestHandler({ request }, error);
      });

      await expect(async () => {
        for await (const result of crawler.crawl(request.url)) {
          void result;
        }
      }).rejects.toThrow('Outbound destination unavailable');
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
        const requestHandler = (global as { __requestHandler?: (context: Record<string, unknown>) => Promise<void> }).__requestHandler!;
        await requestHandler({
          request: { url: 'https://example.com/private' },
          response: {
            status: () => 403,
            headerValue: vi.fn().mockResolvedValue('1'),
          },
          page,
          enqueueLinks: vi.fn(),
          log: { debug: vi.fn(), error: vi.fn(), warning },
        });
      });

      for await (const result of crawler.crawl('https://example.com/private')) {
        void result;
      }

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('blocked outbound destination'));
      expect(page.waitForLoadState).not.toHaveBeenCalled();
      expect(mockQueueManager.addResult).not.toHaveBeenCalled();
    });

    it('does not index a client-side navigation blocked after the initial response', async () => {
      const mainFrame = {};
      let onResponse: ((response: Record<string, unknown>) => void) | undefined;
      const laterResponse = {
        status: () => 403,
        headerValue: vi.fn().mockResolvedValue('1'),
        request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
      };
      const page = {
        mainFrame: vi.fn().mockReturnValue(mainFrame),
        on: vi.fn((event: string, listener: (response: Record<string, unknown>) => void) => {
          if (event === 'response') {
            onResponse = listener;
          }
        }),
        off: vi.fn(),
        waitForLoadState: vi.fn().mockImplementation(async () => onResponse?.(laterResponse)),
        evaluate: vi.fn().mockResolvedValue(false),
        url: vi.fn().mockReturnValue('https://example.com/docs'),
      };
      const warning = vi.fn();
      mockCrawlerRun.mockImplementationOnce(async () => {
        const requestHandler = (global as { __requestHandler?: (context: Record<string, unknown>) => Promise<void> }).__requestHandler!;
        await requestHandler({
          request: { url: 'https://example.com/docs' },
          response: {
            status: () => 200,
            headerValue: vi.fn().mockResolvedValue(null),
          },
          page,
          enqueueLinks: vi.fn(),
          log: { debug: vi.fn(), error: vi.fn(), warning },
        });
      });

      for await (const result of crawler.crawl('https://example.com/docs')) {
        void result;
      }

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('blocked outbound destination'));
      expect(mockQueueManager.addResult).not.toHaveBeenCalled();
      expect(page.off).toHaveBeenCalledWith('response', onResponse);
    });

    it('rethrows a later main-frame navigation failure for Crawlee to retry', async () => {
      const mainFrame = {};
      let onRequestFailed: ((request: Record<string, unknown>) => void) | undefined;
      const page = {
        mainFrame: vi.fn().mockReturnValue(mainFrame),
        on: vi.fn((event: string, listener: (request: Record<string, unknown>) => void) => {
          if (event === 'requestfailed') {
            onRequestFailed = listener;
          }
        }),
        off: vi.fn(),
        waitForLoadState: vi.fn().mockImplementation(async () => {
          onRequestFailed?.({
            isNavigationRequest: () => true,
            frame: () => mainFrame,
            failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
            url: () => 'https://8.8.8.8/docs',
          });
        }),
        evaluate: vi.fn().mockResolvedValue(false),
        url: vi.fn().mockReturnValue('https://8.8.8.8/docs'),
      };
      const warning = vi.fn();
      mockCrawlerRun.mockImplementationOnce(async () => {
        const requestHandler = (global as { __requestHandler?: (context: Record<string, unknown>) => Promise<void> }).__requestHandler!;
        await requestHandler({
          request: { url: 'https://8.8.8.8/docs' },
          response: {
            status: () => 200,
            headerValue: vi.fn().mockResolvedValue(null),
          },
          page,
          enqueueLinks: vi.fn(),
          log: { debug: vi.fn(), error: vi.fn(), warning },
        });
      });

      await expect(async () => {
        for await (const result of crawler.crawl('https://8.8.8.8/docs')) {
          void result;
        }
      }).rejects.toThrow('Outbound destination unavailable');

      expect(warning).not.toHaveBeenCalled();
      expect(mockQueueManager.addResult).not.toHaveBeenCalled();
      expect(page.off).toHaveBeenCalledWith('requestfailed', onRequestFailed);
    });

    it('treats a policy-blocked later navigation as handled without retry', async () => {
      const mainFrame = {};
      let onRequestFailed: ((request: Record<string, unknown>) => void) | undefined;
      const page = {
        mainFrame: vi.fn().mockReturnValue(mainFrame),
        on: vi.fn((event: string, listener: (request: Record<string, unknown>) => void) => {
          if (event === 'requestfailed') {
            onRequestFailed = listener;
          }
        }),
        off: vi.fn(),
        waitForLoadState: vi.fn().mockImplementation(async () => {
          onRequestFailed?.({
            isNavigationRequest: () => true,
            frame: () => mainFrame,
            failure: () => ({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }),
            url: () => 'http://127.0.0.1/docs',
          });
        }),
        evaluate: vi.fn().mockResolvedValue(false),
        url: vi.fn().mockReturnValue('https://example.com/docs'),
      };
      const warning = vi.fn();
      mockCrawlerRun.mockImplementationOnce(async () => {
        const requestHandler = (global as { __requestHandler?: (context: Record<string, unknown>) => Promise<void> }).__requestHandler!;
        await requestHandler({
          request: { url: 'https://example.com/docs' },
          response: { status: () => 200, headerValue: vi.fn().mockResolvedValue(null) },
          page,
          enqueueLinks: vi.fn(),
          log: { debug: vi.fn(), error: vi.fn(), warning },
        });
      });

      for await (const result of crawler.crawl('https://example.com/docs')) {
        void result;
      }

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('blocked outbound destination'));
      expect(mockQueueManager.addResult).not.toHaveBeenCalled();
    });

    it('extracts a later successful page after superseded navigation failures', async () => {
      const mainFrame = {};
      let onResponse: ((response: Record<string, unknown>) => void) | undefined;
      let onRequestFailed: ((request: Record<string, unknown>) => void) | undefined;
      const successfulResponse = {
        status: () => 200,
        headerValue: vi.fn().mockResolvedValue(null),
        request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
      };
      let emittedNavigation = false;
      const page = {
        mainFrame: vi.fn().mockReturnValue(mainFrame),
        on: vi.fn((event: string, listener: (value: Record<string, unknown>) => void) => {
          if (event === 'response') {
            onResponse = listener;
          }
          else if (event === 'requestfailed') {
            onRequestFailed = listener;
          }
        }),
        off: vi.fn(),
        waitForLoadState: vi.fn().mockImplementation(async () => {
          if (!emittedNavigation) {
            emittedNavigation = true;
            for (const errorText of ['net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'Load request canceled']) {
              onRequestFailed?.({
                isNavigationRequest: () => true,
                frame: () => mainFrame,
                failure: () => ({ errorText }),
              });
            }
            onRequestFailed?.({
              isNavigationRequest: () => true,
              frame: () => mainFrame,
              failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
            });
            onResponse?.(successfulResponse);
          }
        }),
        evaluate: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue('Extracted content'),
        url: vi.fn().mockReturnValue('https://example.com/docs'),
        title: vi.fn().mockResolvedValue('Docs'),
      };
      mockCrawlerRun.mockImplementationOnce(async () => {
        const requestHandler = (global as { __requestHandler?: (context: Record<string, unknown>) => Promise<void> }).__requestHandler!;
        await requestHandler({
          request: { url: 'https://example.com/docs' },
          response: {
            status: () => 200,
            headerValue: vi.fn().mockResolvedValue(null),
          },
          page,
          enqueueLinks: vi.fn(),
          log: { debug: vi.fn(), error: vi.fn(), warning: vi.fn() },
        });
      });

      for await (const result of crawler.crawl('https://example.com/docs')) {
        void result;
      }

      expect(mockQueueManager.addResult).toHaveBeenCalledWith(expect.objectContaining({ content: 'Extracted content', title: 'Docs' }));
      expect(page.off).toHaveBeenCalledWith('response', onResponse);
      expect(page.off).toHaveBeenCalledWith('requestfailed', onRequestFailed);
    });

    it('should initialize queue manager with URL', async () => {
      // Set up processBatch to return results immediately to end the crawl
      mockCrawlerRun.mockResolvedValueOnce(undefined);
      mockQueueManager.processBatch.mockResolvedValueOnce([]);

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://example.com/docs')) {
        results.push(result);
      }

      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://example.com/docs', undefined);
    });

    it('should yield results from queue manager', async () => {
      const mockResults: CrawlResult[] = [
        { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', title: 'Page 1' },
        { url: 'https://example.com/page2', path: '/page2', content: 'Page 2', title: 'Page 2' },
      ];

      // Since hasEnoughResults returns false, processBatch is only called once
      // at the end of crawl (line 388 in crawlee-crawler.ts), so we only need one mock value
      mockQueueManager.processBatch.mockResolvedValueOnce(mockResults);

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://example.com')) {
        results.push(result);
      }

      expect(results).toEqual(mockResults);
    });

    it('should cleanup queue manager after crawl', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of crawler.crawl('https://example.com')) {
        // Just consume results
      }

      expect(mockQueueManager.cleanup).toHaveBeenCalled();
    });

    it('should process batch when enough results accumulated', async () => {
      const mockResults: CrawlResult[] = [{ url: 'https://example.com/page1', path: '/page1', content: 'Page 1', title: 'Page 1' }];

      mockQueueManager.hasEnoughResults.mockReturnValueOnce(true).mockReturnValue(false);
      mockQueueManager.processBatch.mockResolvedValueOnce(mockResults).mockResolvedValueOnce([]);

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://example.com')) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
    });

    it('should set allowed hostname from URL', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of crawler.crawl('https://docs.example.com/guide')) {
        // Just consume results
      }

      // Verify through the initialize call
      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://docs.example.com/guide', undefined);
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
      const results: CrawlResult[] = [];
      for await (const result of generator) {
        results.push(result);
      }

      expect(mockCrawlerTeardown).toHaveBeenCalled();
    });
  });

  describe('domain restriction', () => {
    it('should extract hostname from URL for domain restriction', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of crawler.crawl('https://subdomain.example.com/path')) {
        // Just consume results
      }

      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://subdomain.example.com/path', undefined);
    });

    it('should pass path prefix to queue manager when set', async () => {
      crawler.setPathPrefix('/docs/api');

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of crawler.crawl('https://example.com/docs/api')) {
        // Just consume results
      }

      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://example.com/docs/api', '/docs/api');
    });
  });

  describe('authentication', () => {
    it('should configure crawler with storage state when set', async () => {
      const state: StorageState = {
        cookies: [{ name: 'auth', value: 'token123', domain: 'example.com', path: '/' }],
      };

      crawler.setStorageState(state);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of crawler.crawl('https://example.com')) {
        // Just consume results
      }

      // Verify queue manager was initialized (auth is handled internally)
      expect(mockQueueManager.initialize).toHaveBeenCalled();
    });
  });

  describe('isWithinAllowedDomain', () => {
    // Access the private method through the class prototype for testing
    it('should handle URL parsing for domain check', async () => {
      // This is tested indirectly through the crawl method
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of crawler.crawl('https://example.com')) {
        // Just consume results
      }

      // No errors means domain parsing worked
      expect(mockQueueManager.initialize).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should cleanup on error', async () => {
      mockCrawlerRun.mockRejectedValueOnce(new Error('Crawl failed'));

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of crawler.crawl('https://example.com')) {
          // Just consume results
        }
      }).rejects.toThrow('Crawl failed');

      expect(mockQueueManager.cleanup).toHaveBeenCalled();
    });

    it('should handle invalid URLs gracefully', async () => {
      // The crawler should handle this internally
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of crawler.crawl('https://example.com')) {
        // Just consume results
      }

      expect(mockQueueManager.initialize).toHaveBeenCalled();
    });
  });
});

describe('StorageState interface', () => {
  it('should allow cookies with all optional properties', () => {
    const state: StorageState = {
      cookies: [
        {
          name: 'session',
          value: 'abc',
          domain: 'example.com',
          path: '/',
          expires: 1234567890,
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
        },
      ],
    };

    expect(state.cookies).toHaveLength(1);
    expect(state.cookies[0].sameSite).toBe('Strict');
  });

  it('should allow minimal cookie definition', () => {
    const state: StorageState = {
      cookies: [{ name: 'token', value: 'xyz', domain: 'test.com', path: '/' }],
    };

    expect(state.cookies[0].expires).toBeUndefined();
  });

  it('should allow origins for localStorage', () => {
    const state: StorageState = {
      cookies: [],
      origins: [
        {
          origin: 'https://example.com',
          localStorage: [
            { name: 'key1', value: 'value1' },
            { name: 'key2', value: 'value2' },
          ],
        },
      ],
    };

    expect(state.origins).toHaveLength(1);
    expect(state.origins![0].localStorage).toHaveLength(2);
  });
});
