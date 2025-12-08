import { BaseCrawler } from './base.js';
import type { CrawlResult } from '../types.js';

/**
 * Concrete implementation of BaseCrawler for testing purposes.
 *
 * Since BaseCrawler is abstract, we create this minimal subclass that:
 * 1. Implements the required abstract `crawl` method
 * 2. Exposes protected BaseCrawler methods via public wrappers
 *
 * The wrapper methods (testShouldCrawl, testMarkUrlAsSeen, etc.) simply call
 * the inherited BaseCrawler methods - we're testing the REAL BaseCrawler
 * implementation, not overridden methods.
 */
class TestCrawler extends BaseCrawler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *crawl(_url: string): AsyncGenerator<CrawlResult, void, unknown> {
    yield {
      url: 'https://example.com',
      path: '/',
      content: '<h1>Test</h1>',
      title: 'Test',
    };
  }

  // Expose protected BaseCrawler methods for testing (these call the real implementations)
  public testShouldCrawl(url: string): boolean {
    return this.shouldCrawl(url);
  }

  public testMarkUrlAsSeen(url: string): void {
    this.markUrlAsSeen(url);
  }

  public testGetPathFromUrl(url: string): string {
    return this.getPathFromUrl(url);
  }

  public testNormalizeUrl(url: string): string {
    return this.normalizeUrl(url);
  }

  public async testRateLimit(): Promise<void> {
    return this.rateLimit();
  }

  public async testRetryWithBackoff<T>(operation: () => Promise<T>, maxRetries?: number): Promise<T> {
    return this.retryWithBackoff(operation, maxRetries);
  }

  public testAbort(): void {
    this.abort();
  }

  public get isAbortingFlag(): boolean {
    return this.isAborting;
  }

  public testUpdateProgress(description: string): void {
    this.updateProgress(description);
  }

  public testAddDiscoveredUrls(count: number): void {
    this.addDiscoveredUrls(count);
  }

  public testMarkUrlProcessed(url: string): void {
    this.markUrlProcessed(url);
  }
}

describe('BaseCrawler', () => {
  let crawler: TestCrawler;

  beforeEach(() => {
    crawler = new TestCrawler();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      const defaultCrawler = new TestCrawler();
      expect(defaultCrawler).toBeDefined();
    });

    it('should accept custom maxDepth', () => {
      const customCrawler = new TestCrawler(10);
      expect(customCrawler).toBeDefined();
    });

    it('should accept custom maxRequestsPerCrawl', () => {
      const customCrawler = new TestCrawler(4, 500);
      expect(customCrawler).toBeDefined();
    });

    it('should accept progress callback', () => {
      const progressFn = vi.fn();
      const customCrawler = new TestCrawler(4, 1000, progressFn);
      customCrawler.testUpdateProgress('Testing');
      expect(progressFn).toHaveBeenCalled();
    });
  });

  describe('shouldCrawl', () => {
    it('should return true for valid URLs', () => {
      // URLs with .html extension pass the file extension check
      expect(crawler.testShouldCrawl('https://example.com/docs.html')).toBe(true);
      expect(crawler.testShouldCrawl('https://example.com/api.html')).toBe(true);
      expect(crawler.testShouldCrawl('https://example.com/page.htm')).toBe(true);
    });

    it('should return false for already seen URLs', () => {
      crawler.testMarkUrlAsSeen('https://example.com/seen');
      expect(crawler.testShouldCrawl('https://example.com/seen')).toBe(false);
    });

    it('should return false for URLs with hash fragments', () => {
      expect(crawler.testShouldCrawl('https://example.com/page#section')).toBe(false);
    });

    it('should return false for non-HTML files', () => {
      expect(crawler.testShouldCrawl('https://example.com/image.png')).toBe(false);
      expect(crawler.testShouldCrawl('https://example.com/doc.pdf')).toBe(false);
      expect(crawler.testShouldCrawl('https://example.com/script.js')).toBe(false);
      expect(crawler.testShouldCrawl('https://example.com/style.css')).toBe(false);
    });

    it('should return true for HTML files', () => {
      expect(crawler.testShouldCrawl('https://example.com/page.html')).toBe(true);
      expect(crawler.testShouldCrawl('https://example.com/page.htm')).toBe(true);
    });

    it('should return true for HTML file extensions', () => {
      expect(crawler.testShouldCrawl('https://example.com/docs.html')).toBe(true);
      expect(crawler.testShouldCrawl('https://example.com/page.htm')).toBe(true);
      expect(crawler.testShouldCrawl('https://example.com/index.HTML')).toBe(true);
    });

    it('should return false for paths without HTML extension', () => {
      // The implementation's file extension check treats all paths without
      // .html/.htm extension as non-HTML files
      expect(crawler.testShouldCrawl('https://example.com/docs')).toBe(false);
      expect(crawler.testShouldCrawl('https://example.com/')).toBe(false);
    });

    it('should return false for invalid URLs', () => {
      expect(crawler.testShouldCrawl('not-a-url')).toBe(false);
      expect(crawler.testShouldCrawl('')).toBe(false);
    });
  });

  describe('markUrlAsSeen', () => {
    it('should mark URL as seen', () => {
      const url = 'https://example.com/test.html';
      expect(crawler.testShouldCrawl(url)).toBe(true);
      crawler.testMarkUrlAsSeen(url);
      expect(crawler.testShouldCrawl(url)).toBe(false);
    });
  });

  describe('getPathFromUrl', () => {
    it('should extract pathname from URL', () => {
      expect(crawler.testGetPathFromUrl('https://example.com/docs/page')).toBe('/docs/page');
    });

    it('should include query params in path', () => {
      expect(crawler.testGetPathFromUrl('https://example.com/search?q=test')).toBe('/search?q=test');
    });

    it('should return original string for invalid URL', () => {
      expect(crawler.testGetPathFromUrl('not-a-url')).toBe('not-a-url');
    });

    it('should handle root path', () => {
      expect(crawler.testGetPathFromUrl('https://example.com')).toBe('/');
      expect(crawler.testGetPathFromUrl('https://example.com/')).toBe('/');
    });
  });

  describe('normalizeUrl', () => {
    it('should remove hash fragments', () => {
      expect(crawler.testNormalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
    });

    it('should remove trailing slash', () => {
      expect(crawler.testNormalizeUrl('https://example.com/docs/')).toBe('https://example.com/docs');
    });

    it('should preserve query params', () => {
      expect(crawler.testNormalizeUrl('https://example.com/search?q=test')).toBe('https://example.com/search?q=test');
    });

    it('should return original string for invalid URL', () => {
      expect(crawler.testNormalizeUrl('not-a-url')).toBe('not-a-url');
    });
  });

  describe('abort', () => {
    it('should set isAborting flag to true', () => {
      expect(crawler.isAbortingFlag).toBe(false);
      crawler.testAbort();
      expect(crawler.isAbortingFlag).toBe(true);
    });
  });

  describe('retryWithBackoff', () => {
    it('should return result on successful operation', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      const result = await crawler.testRetryWithBackoff(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      const operation = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('success');

      vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });

      const result = await crawler.testRetryWithBackoff(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);

      vi.restoreAllMocks();
    });

    it('should throw after max retries', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('persistent error'));

      vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });

      await expect(crawler.testRetryWithBackoff(operation, 3)).rejects.toThrow('persistent error');
      expect(operation).toHaveBeenCalledTimes(3);

      vi.restoreAllMocks();
    });
  });

  describe('progress tracking', () => {
    it('should call progress callback with updateProgress', () => {
      const progressFn = vi.fn();
      const progressCrawler = new TestCrawler(4, 1000, progressFn);

      progressCrawler.testUpdateProgress('Processing...');

      expect(progressFn).toHaveBeenCalledWith(expect.any(Number), 'Processing...');
    });

    it('should track discovered URLs', () => {
      const progressFn = vi.fn();
      const progressCrawler = new TestCrawler(4, 1000, progressFn);

      progressCrawler.testAddDiscoveredUrls(5);

      expect(progressFn).toHaveBeenCalled();
    });

    it('should track processed URLs', () => {
      const progressFn = vi.fn();
      const progressCrawler = new TestCrawler(4, 1000, progressFn);

      progressCrawler.testMarkUrlProcessed('https://example.com/page1');

      expect(progressFn).toHaveBeenCalled();
    });

    it('should not throw when progress callback not provided', () => {
      const noCrawler = new TestCrawler();

      expect(() => noCrawler.testUpdateProgress('Test')).not.toThrow();
      expect(() => noCrawler.testAddDiscoveredUrls(5)).not.toThrow();
      expect(() => noCrawler.testMarkUrlProcessed('https://example.com')).not.toThrow();
    });
  });

  describe('crawl', () => {
    it('should yield CrawlResult', async () => {
      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://example.com')) {
        results.push(result);
      }

      expect(results.length).toBe(1);
      expect(results[0].url).toBe('https://example.com');
      expect(results[0].content).toBe('<h1>Test</h1>');
    });
  });
});
