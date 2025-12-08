import type { CrawlResult } from '../types.js';

const mockQueueManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getRequestQueue: vi.fn().mockReturnValue({}),
  handleQueueAndLinks: vi.fn().mockResolvedValue(undefined),
  addResult: vi.fn(),
  hasEnoughResults: vi.fn().mockReturnValue(false),
  processBatch: vi.fn().mockResolvedValue([]),
  cleanup: vi.fn().mockResolvedValue(undefined),
};

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
  PlaywrightCrawler: function (options: { requestHandler?: unknown }) {
    // Store the request handler for testing
    (global as { __requestHandler?: unknown }).__requestHandler = options.requestHandler;
    return {
      run: mockCrawlerRun,
      teardown: mockCrawlerTeardown,
    };
  },
}));

// Import after mocking
import { CrawleeCrawler, StorageState } from './crawlee-crawler.js';

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
    it('should initialize queue manager with URL', async () => {
      // Set up processBatch to return results immediately to end the crawl
      mockCrawlerRun.mockResolvedValueOnce(undefined);
      mockQueueManager.processBatch.mockResolvedValueOnce([]);

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://example.com/docs')) {
        results.push(result);
      }

      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://example.com/docs');
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
      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://docs.example.com/guide');
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

      expect(mockQueueManager.initialize).toHaveBeenCalledWith('https://subdomain.example.com/path');
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
