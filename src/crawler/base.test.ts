import { BaseCrawler } from './base.js';
import type { CrawlResult } from '../types.js';

/**
 * Concrete implementation of BaseCrawler for testing purposes.
 *
 * Since BaseCrawler is abstract, we create this minimal subclass that
 * implements the required abstract `crawl` method.
 */
class TestCrawler extends BaseCrawler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *crawl(_url: string): AsyncGenerator<CrawlResult, void, unknown> {
    yield {
      url: 'https://example.com',
      path: '/',
      content: '<h1>Test</h1>',
      contentFormat: 'text',
      title: 'Test',
    };
  }

  public async testRateLimit(): Promise<void> {
    return this.rateLimit();
  }

  public testAbort(): void {
    this.abort();
  }

  public get isAbortingFlag(): boolean {
    return this.isAborting;
  }
}

describe('BaseCrawler', () => {
  let crawler: TestCrawler;

  beforeEach(() => {
    crawler = new TestCrawler();
  });

  describe('abort', () => {
    it('should set isAborting flag to true', () => {
      expect(crawler.isAbortingFlag).toBe(false);
      crawler.testAbort();
      expect(crawler.isAbortingFlag).toBe(true);
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
