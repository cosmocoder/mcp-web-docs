import type { CrawlResult } from '../types.js';
import { SessionExpiredError, type ValidatedStorageState } from '../util/security.js';

const mockQueueManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  seedFromLlmsTxt: vi.fn().mockResolvedValue(0),
  getRequestQueue: vi.fn().mockReturnValue({}),
  handleQueueAndLinks: vi.fn().mockResolvedValue(undefined),
  addResult: vi.fn(),
  drainResults: vi.fn().mockReturnValue([]),
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
const successfulRunStats = { requestsFailed: 0, requestsTotal: 0 };
const mockCrawlerRun = vi.fn().mockResolvedValue(successfulRunStats);
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
      run: async () => (await mockCrawlerRun()) ?? successfulRunStats,
      teardown: mockCrawlerTeardown,
    };
  },
}));

// Import after mocking
import { logger } from '../util/logger.js';
import { CrawleeCrawler } from './crawlee-crawler.js';
import { readLoginPageSignals } from './login-page-signals.js';

type RequestHandler = (context: Record<string, unknown>) => Promise<void>;
type ErrorHandler = (context: Record<string, unknown>, error: Error) => Promise<void>;
type NavigationListener = (value: Record<string, unknown>) => void;

function getRequestHandler(): RequestHandler {
  return (globalThis as unknown as { __requestHandler: RequestHandler }).__requestHandler;
}

function getErrorHandler(name: '__errorHandler' | '__failedRequestHandler'): ErrorHandler {
  return (globalThis as unknown as Record<string, ErrorHandler>)[name];
}

async function collect(crawler: CrawleeCrawler, url: string, results: CrawlResult[] = []): Promise<CrawlResult[]> {
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
    mockQueueManager.drainResults.mockReturnValue([]);
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

    it('should await frame readiness before returning the content frame', async () => {
      const contentFrame = { evaluate: vi.fn().mockResolvedValue(true), waitForLoadState: vi.fn().mockResolvedValue(undefined) };
      const emptyFrame = { evaluate: vi.fn().mockResolvedValue(false), waitForLoadState: vi.fn() };
      const findContentFrame = (crawler as unknown as { findContentFrame(page: unknown): Promise<unknown> }).findContentFrame.bind(crawler);

      // Nothing else waits for the frame, so this await is the only thing standing
      // between a freshly discovered iframe and the extractor reading it
      await expect(findContentFrame({ frames: () => [emptyFrame, contentFrame] })).resolves.toBe(contentFrame);

      expect(contentFrame.waitForLoadState).toHaveBeenCalledWith('domcontentloaded');
      expect(emptyFrame.waitForLoadState).not.toHaveBeenCalled();
    });

    it('should return null when no frame holds Storybook content', async () => {
      const emptyFrame = { evaluate: vi.fn().mockResolvedValue(false), waitForLoadState: vi.fn() };
      const findContentFrame = (crawler as unknown as { findContentFrame(page: unknown): Promise<unknown> }).findContentFrame.bind(crawler);

      await expect(findContentFrame({ frames: () => [emptyFrame] })).resolves.toBeNull();
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

    it('extracts a later successful page without altering Markdown after superseded navigation failures', async () => {
      const markdown = '    indented example\n\n# Guide\n\n```ts\nfunction example() {\n  return true;\n}\n```';
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
          .mockResolvedValue({ content: markdown, contentFormat: 'markdown' })
      );
      mockCrawlerRun.mockImplementationOnce(async () => {
        await runRequestHandler(page, 'https://example.com/docs');
      });

      await collect(crawler, 'https://example.com/docs');

      expect(mockQueueManager.addResult).toHaveBeenCalledWith(
        expect.objectContaining({ content: markdown, contentFormat: 'markdown', title: 'Docs' })
      );
      expect(page.off).toHaveBeenCalledWith('response', listeners.response);
      expect(page.off).toHaveBeenCalledWith('requestfailed', listeners.requestfailed);
    });

    it('should initialize queue manager with URL', async () => {
      await collect(crawler, 'https://example.com/docs');

      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://example.com/docs', undefined);
    });

    it('should yield results from queue manager', async () => {
      const mockResults: CrawlResult[] = [
        { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', contentFormat: 'text', title: 'Page 1' },
        { url: 'https://example.com/page2', path: '/page2', content: 'Page 2', contentFormat: 'text', title: 'Page 2' },
      ];

      mockQueueManager.drainResults.mockReturnValueOnce(mockResults);

      const results = await collect(crawler, 'https://example.com');

      expect(results).toEqual(mockResults);
    });

    it('should cleanup queue manager after crawl', async () => {
      await collect(crawler, 'https://example.com');

      expect(mockQueueManager.cleanup).toHaveBeenCalled();
    });

    it('should yield results while the crawl is still running', async () => {
      const mockResult: CrawlResult = { url: 'https://example.com/p1', path: '/p1', content: 'P1', contentFormat: 'text', title: 'P1' };

      // run() stays pending, so the generator can only produce a value if it
      // drains the queue mid-crawl instead of waiting for the crawl to finish
      const { promise, resolve: finishCrawl } = Promise.withResolvers<typeof successfulRunStats>();
      mockCrawlerRun.mockReturnValueOnce(promise);
      mockQueueManager.drainResults.mockReturnValueOnce([mockResult]);

      const generator = crawler.crawl('https://example.com');
      const first = await generator.next();

      expect(first).toEqual({ value: mockResult, done: false });

      finishCrawl(successfulRunStats);
      expect((await generator.next()).done).toBe(true);
    });

    it('should yield results queued after the crawl finishes', async () => {
      const lateResult: CrawlResult = { url: 'https://example.com/p2', path: '/p2', content: 'P2', contentFormat: 'text', title: 'P2' };

      // run() is already resolved, so the loop drains once (empty) and breaks on
      // its first tick — only the drain after the crawl promise can yield this.
      mockQueueManager.drainResults.mockReturnValueOnce([]).mockReturnValueOnce([lateResult]);

      expect(await collect(crawler, 'https://example.com')).toEqual([lateResult]);
      expect(mockQueueManager.drainResults).toHaveBeenCalledTimes(2);
    });
  });

  describe('abort', () => {
    it('should stop the crawler', async () => {
      // Make run() hang until we resolve it, so abort() can be called while crawler exists
      let resolveRun: (statistics: typeof successfulRunStats) => void;
      const runPromise = new Promise<typeof successfulRunStats>((resolve) => {
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
      resolveRun!(successfulRunStats);

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

    it.each([
      ['same hostname', 'https://example.com/guide', true],
      ['subdomain', 'https://api.example.com/guide', true],
      ['outside hostname', 'https://example.net/guide', false],
    ])('%s redirect is handled according to the crawl domain', async (_label, actualUrl, allowed) => {
      const { page } = navigationPage(actualUrl, () => {});
      mockCrawlerRun.mockImplementationOnce(async () => {
        await runRequestHandler(page, 'https://example.com/docs');
        return successfulRunStats;
      });

      await collect(crawler, 'https://example.com/docs');

      expect(mockQueueManager.addResult).toHaveBeenCalledTimes(allowed ? 1 : 0);
    });
  });

  describe('session expiry', () => {
    // Four indicators of the detector's six, so it clears the confidence bar on content alone
    const LOGIN_BODY = 'Sign in with your username and password. Forgot password?';

    // The other evaluate calls in the navigation path ask yes/no questions and must keep getting a
    // boolean. Shape is stated rather than derived from the prose, as the browser would report it.
    type PageSpec = { url: string; bodyText: string; html?: string; headings?: string[]; asksForPassword?: boolean };

    function authenticatedPage({ url, bodyText, html = '', headings = [], asksForPassword = false }: PageSpec) {
      const { page } = navigationPage(
        url,
        () => {},
        vi.fn(async (fn: unknown) =>
          fn === readLoginPageSignals
            ? ({
                text: bodyText,
                hasPasswordInput: asksForPassword || html.includes('type="password"'),
                headings,
                frameSources: [],
              } satisfies ReturnType<typeof readLoginPageSignals>)
            : false
        )
      );
      return Object.assign(page, { content: vi.fn().mockResolvedValue(`<html><body>${bodyText}${html}</body></html>`) });
    }

    // The check only runs on a crawl that authenticated, so every case here starts from one
    beforeEach(() => {
      crawler.setStorageState({ cookies: [{ name: 'auth', value: 'token', domain: 'example.com', path: '/' }] });
    });

    async function crawlPages(pages: PageSpec[], entry = 'https://example.com/docs'): Promise<void> {
      mockCrawlerRun.mockImplementationOnce(async () => {
        for (const spec of pages) {
          await runRequestHandler(authenticatedPage(spec), spec.url);
        }
        return successfulRunStats;
      });
      await collect(crawler, entry);
    }

    const docsPage = (n: number): PageSpec => ({
      url: `https://example.com/docs/${n}`,
      bodyText: `Ordinary content about topic ${n}`,
      headings: [`Topic ${n}`],
    });
    // One login page, whatever URL it was asked for
    const loginPage = (n: number): PageSpec => ({
      url: `https://example.com/docs/${n}`,
      bodyText: LOGIN_BODY,
      headings: ['Sign in'],
      asksForPassword: true,
    });

    it('fails the crawl when the first page is a login page', async () => {
      await expect(crawlPages([{ url: 'https://example.com/docs', bodyText: LOGIN_BODY }])).rejects.toThrow(SessionExpiredError);
    });

    // A URL match is worth three of the detector's six indicators, so scoring the URL would make
    // every page of this host a login page and no authenticated crawl of it possible. The wording
    // has to reach the scored line - one indicator, which is past the cost gate and short of the
    // confidence bar - and one page has to be the entry page, where a login page fails at once.
    it('crawls a documentation site hosted on an auth subdomain', async () => {
      const pages = ['', '/install', '/usage'].map((slug) => ({
        url: `https://auth.example.com/docs${slug}`,
        bodyText: `Signing in is covered elsewhere. This page is about ${slug || 'the basics'}.`,
      }));

      await expect(crawlPages(pages, 'https://auth.example.com/docs')).resolves.toBeUndefined();
      expect(mockQueueManager.addResult).toHaveBeenCalledTimes(3);
    });

    // Same outcome whichever order they finish in, which "in a row" could never give
    it.each([
      ['one login page answers several URLs', [docsPage(1), loginPage(2), loginPage(3), loginPage(4)]],
      ['real pages are interleaved with it', [docsPage(1), loginPage(2), docsPage(3), loginPage(4), docsPage(5), loginPage(6)]],
    ])('fails the crawl when %s', async (_label, pages) => {
      await expect(crawlPages(pages)).rejects.toThrow(/one login page answered 3 different URLs/i);
    });

    // Too short for any one login page to come back three times, but they were still most of it
    it('fails a short crawl that was mostly one login page', async () => {
      await expect(crawlPages([docsPage(1), loginPage(2), loginPage(3)])).rejects.toThrow(/answered 2 of 3 URLs/i);
    });

    // Two indicators is the detector's bar but half of ours, or any page mentioning a username counts
    it('ignores pages that only just trip the detector', async () => {
      const pages = [1, 2, 3].map((n) => ({ ...loginPage(n), bodyText: 'Log in with your username.' }));

      await expect(crawlPages([docsPage(0), ...pages])).resolves.toBeUndefined();
    });

    // Too small a share of the crawl for the after-the-fact rule; only the repeat count catches it
    it('fails a long crawl where the session died near the end', async () => {
      const tail = [1, 2, 3].map((n) => ({ ...loginPage(n), url: `https://example.com/docs/late-${n}` }));

      await expect(crawlPages([...[1, 2, 3, 4, 5, 6, 7, 8].map(docsPage), ...tail])).rejects.toThrow(
        /one login page answered 3 different URLs/i
      );
    });

    // One branded button, with the only real evidence in the markup
    it.each([
      ['a branded SSO button', 'Continue with SSO', '<form action="/login"><input type="password" name="p"></form>'],
      ['an almost wordless login shell', 'Continue', '<iframe src="/idp"></iframe><input type="password">'],
    ])('detects %s', async (_label, bodyText, html) => {
      const pages = [1, 2, 3].map((n) => ({ url: `https://example.com/docs/${n}`, bodyText, html }));

      await expect(crawlPages([docsPage(0), ...pages])).rejects.toThrow(SessionExpiredError);
    });

    // One page is documentation about signing in; the rule needs a page that came back
    it('keeps crawling a two-page site whose second page is about signing in', async () => {
      await expect(crawlPages([docsPage(1), { ...loginPage(2), url: 'https://example.com/docs/auth' }])).resolves.toBeUndefined();
    });

    // Exactly half, which "most of the crawl" has to include - otherwise a session dying at the
    // midpoint of a short crawl passes
    it('fails a crawl that was exactly half one login page', async () => {
      await expect(crawlPages([docsPage(1), loginPage(2), docsPage(3), loginPage(4)])).rejects.toThrow(/answered 2 of 4 URLs/i);
    });

    // By arrival order, one ordinary page reading as a login page would fail the crawl on its own,
    // with none of the repetition the rule is built on
    it('does not treat whichever page finishes first as the entry page', async () => {
      await expect(
        crawlPages([
          { url: 'https://example.com/docs/signing-in', bodyText: LOGIN_BODY },
          { url: 'https://example.com/docs', bodyText: 'Ordinary content on the page the crawl asked for' },
        ])
      ).resolves.toBeUndefined();
    });

    // A login page's wording varies per request - a return parameter, a csrf token, an attempt
    // counter - so the identity cannot rest on it. The form it puts in front of you does not vary.
    it('fails the crawl when the login page varies by the text it carries', async () => {
      const pages = [1, 2, 3].map((n) => ({ ...loginPage(n), bodyText: `${LOGIN_BODY} next=%2Fdocs%2F${n} token=a${n}f9c${n}` }));

      await expect(crawlPages([docsPage(0), ...pages])).rejects.toThrow(/one login page answered 3 different URLs/i);
    });

    it('does not serialize the markup of a page with no sign of a login', async () => {
      const ordinary = authenticatedPage(docsPage(1));
      mockCrawlerRun.mockImplementationOnce(async () => {
        await runRequestHandler(ordinary, docsPage(1).url);
        return successfulRunStats;
      });

      await collect(crawler, 'https://example.com/docs');

      expect(ordinary.content).not.toHaveBeenCalled();
    });

    // Shape alone cannot tell pages apart, so it never counts on its own
    it.each([
      ['a theme that renders no headings', [1, 2, 3].map((n) => ({ ...docsPage(n), headings: [] }))],
      [
        'a reference template with fixed headings',
        [1, 2, 3].map((n) => ({ ...docsPage(n), headings: ['Authentication', 'Request', 'Response'] })),
      ],
    ])('keeps crawling documentation pages that share %s', async (_label, pages) => {
      const aboutSigningIn = pages.map((page) => ({ ...page, bodyText: LOGIN_BODY }));

      await expect(crawlPages([docsPage(0), ...aboutSigningIn])).resolves.toBeUndefined();
      expect(mockQueueManager.addResult).toHaveBeenCalledTimes(4);
    });

    // A sign-in box in the page furniture. What still differs is what each page is about.
    it('keeps crawling a site whose every page carries a sign-in box', async () => {
      const pages = [1, 2, 3].map((n) => ({ ...loginPage(n), bodyText: `${LOGIN_BODY} Topic ${n}`, headings: [`Topic ${n}`] }));

      await expect(crawlPages([docsPage(0), ...pages])).resolves.toBeUndefined();
      expect(mockQueueManager.addResult).toHaveBeenCalledTimes(4);
    });

    // A sign-in box and no headings: neither half is enough to call these one page
    it('keeps crawling a heading-less site whose every page carries a sign-in box', async () => {
      const pages = [1, 2, 3].map((n) => ({
        ...loginPage(n),
        bodyText: `${LOGIN_BODY} ${'Ordinary content about topic '.repeat(8)}${n}`,
        headings: [],
      }));

      await expect(crawlPages([docsPage(0), ...pages])).resolves.toBeUndefined();
      expect(mockQueueManager.addResult).toHaveBeenCalledTimes(4);
    });

    // The heading of a login page names where it is sending you back to
    it('fails the crawl when the login page heading names the URL it turned away', async () => {
      const pages = [1, 2, 3].map((n) => ({
        ...loginPage(n),
        headings: [`Sign in to continue to /docs/${n}`],
      }));

      await expect(crawlPages([docsPage(0), ...pages])).rejects.toThrow(/one login page answered 3 different URLs/i);
    });

    // At two, a site with two pages about signing in fails a crawl that is otherwise fine
    it('keeps crawling when one login page has only answered twice', async () => {
      await expect(crawlPages([...[1, 2, 3, 4, 5, 6].map(docsPage), loginPage(7), loginPage(8)])).resolves.toBeUndefined();
    });

    // Nothing in its text and no password field in the page, so the markup is the only evidence -
    // and reading the markup is what the crawl skips for a page showing no sign of a login
    it('fails the crawl when the entry page is a wordless login wall', async () => {
      const wall = {
        url: 'https://example.com/docs',
        bodyText: 'Redirecting',
        html: '<form action="/login"><input name="username"><img alt="Continue with Okta"></form>',
      };

      await expect(crawlPages([wall])).rejects.toThrow(SessionExpiredError);
    });

    // The beforeEach above authenticated, and this crawl must not have
    it('does not check for login pages when the crawl never authenticated', async () => {
      crawler = new CrawleeCrawler();

      await expect(crawlPages([loginPage(1), loginPage(2), loginPage(3)])).resolves.toBeUndefined();
    });
  });

  describe('authentication', () => {
    it('should configure crawler with storage state when set', async () => {
      const state: ValidatedStorageState = {
        cookies: [{ name: 'auth', value: 'token123', domain: 'example.com', path: '/' }],
      };

      crawler.setStorageState(state);

      await collect(crawler, 'https://example.com');

      // Verify queue manager was initialized (auth is handled internally)
      expect(mockQueueManager.initialize).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should reject after Crawlee exhausts retries for a request handler error', async () => {
      mockCrawlerRun.mockImplementationOnce(async () => {
        try {
          await runRequestHandler(
            {
              mainFrame: vi.fn().mockReturnValue({}),
              on: vi.fn(),
              off: vi.fn(),
              waitForLoadState: vi.fn().mockRejectedValueOnce(new Error('Page load failed')).mockResolvedValue(undefined),
            },
            'https://example.com'
          );
        }
        catch {
          return { requestsFailed: 1, requestsTotal: 1 };
        }

        return successfulRunStats;
      });

      const partial: CrawlResult = { url: 'https://example.com/p1', path: '/p1', content: 'P1', contentFormat: 'text', title: 'P1' };
      mockQueueManager.drainResults.mockReturnValueOnce([partial]);

      // Pages drained before the failure are still handed to the caller, which
      // then sees the error — the crawl no longer withholds everything until the end
      const yielded: CrawlResult[] = [];
      await expect(collect(crawler, 'https://example.com', yielded)).rejects.toThrow('Crawl failed for 1 of 1 pages after retries');

      expect(yielded).toEqual([partial]);
      expect(mockQueueManager.cleanup).toHaveBeenCalled();
    });

    it('should yield results when only a few pages fail after retries', async () => {
      mockCrawlerRun.mockResolvedValueOnce({ requestsFailed: 2, requestsTotal: 124 });

      // Second drain, so the results come through after the failure check rather than before it
      const partial: CrawlResult = { url: 'https://example.com/p1', path: '/p1', content: 'P1', contentFormat: 'text', title: 'P1' };
      mockQueueManager.drainResults.mockReturnValueOnce([]).mockReturnValueOnce([partial]);

      await expect(collect(crawler, 'https://example.com')).resolves.toEqual([partial]);
    });

    it('should warn when it continues with a partial crawl', async () => {
      mockCrawlerRun.mockResolvedValueOnce({ requestsFailed: 2, requestsTotal: 124 });

      await collect(crawler, 'https://example.com');

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Continuing with a partial crawl: 2 of 124'));
    });

    it('should expose how many pages a tolerated partial crawl lost', async () => {
      mockCrawlerRun.mockResolvedValueOnce({ requestsFailed: 2, requestsTotal: 124 });

      await collect(crawler, 'https://example.com');

      expect(crawler.failedPageCount).toBe(2);
    });

    it('should report no lost pages for a complete crawl', async () => {
      mockCrawlerRun.mockResolvedValueOnce({ requestsFailed: 2, requestsTotal: 124 });
      await collect(crawler, 'https://example.com');

      mockCrawlerRun.mockResolvedValueOnce({ requestsFailed: 0, requestsTotal: 124 });
      await collect(crawler, 'https://example.com');

      expect(crawler.failedPageCount).toBe(0);
    });

    it('should reject when most pages fail after retries', async () => {
      mockCrawlerRun.mockResolvedValueOnce({ requestsFailed: 60, requestsTotal: 124 });

      await expect(collect(crawler, 'https://example.com')).rejects.toThrow('Crawl failed for 60 of 124 pages after retries');
    });

    // A fixed allowance keeps small crawls workable, a ratio keeps big ones honest, and the
    // minority check stops the fixed allowance from waving through most of a tiny site.
    it.each([
      { requestsFailed: 5, requestsTotal: 124, rejects: false },
      { requestsFailed: 6, requestsTotal: 124, rejects: true },
      { requestsFailed: 20, requestsTotal: 1000, rejects: false },
      { requestsFailed: 21, requestsTotal: 1000, rejects: true },
      { requestsFailed: 4, requestsTotal: 5, rejects: true },
      { requestsFailed: 5, requestsTotal: 10, rejects: true },
      { requestsFailed: 4, requestsTotal: 10, rejects: false },
      { requestsFailed: 3, requestsTotal: 3, rejects: true },
    ])('should reject $requestsFailed of $requestsTotal failures: $rejects', async ({ requestsFailed, requestsTotal, rejects }) => {
      mockCrawlerRun.mockResolvedValueOnce({ requestsFailed, requestsTotal });

      if (rejects) {
        await expect(collect(crawler, 'https://example.com')).rejects.toThrow('after retries');
      }
      else {
        await expect(collect(crawler, 'https://example.com')).resolves.toEqual([]);
      }
    });

    it('should reject when the root page fails even if the rest of the crawl succeeds', async () => {
      mockCrawlerRun.mockImplementationOnce(async () => {
        await getErrorHandler('__failedRequestHandler')(
          { request: { url: 'https://example.com', userData: {} } },
          new Error('Navigation timeout')
        );
        return { requestsFailed: 1, requestsTotal: 124 };
      });

      await expect(collect(crawler, 'https://example.com')).rejects.toThrow('the root page https://example.com/ could not be loaded');
    });

    it('should tolerate a leaf page failing without treating it as a root failure', async () => {
      mockCrawlerRun.mockImplementationOnce(async () => {
        await getErrorHandler('__failedRequestHandler')(
          { request: { url: 'https://example.com/leaf', userData: {} } },
          new Error('Navigation timeout')
        );
        return { requestsFailed: 1, requestsTotal: 124 };
      });

      await expect(collect(crawler, 'https://example.com')).resolves.toEqual([]);
    });

    it('should not carry a root failure into the next crawl on the same instance', async () => {
      mockCrawlerRun.mockImplementationOnce(async () => {
        await getErrorHandler('__failedRequestHandler')(
          { request: { url: 'https://example.com', userData: {} } },
          new Error('Navigation timeout')
        );
        return { requestsFailed: 1, requestsTotal: 124 };
      });
      await expect(collect(crawler, 'https://example.com')).rejects.toThrow('could not be loaded');

      // The second crawl has to lose a page too, or the root flag is never consulted
      mockCrawlerRun.mockResolvedValueOnce({ requestsFailed: 1, requestsTotal: 124 });
      await expect(collect(crawler, 'https://example.com')).resolves.toEqual([]);
    });

    it('should cleanup on error', async () => {
      mockCrawlerRun.mockRejectedValueOnce(new Error('Crawl failed'));

      await expect(collect(crawler, 'https://example.com')).rejects.toThrow('Crawl failed');

      expect(mockQueueManager.cleanup).toHaveBeenCalled();
    });
  });
});
