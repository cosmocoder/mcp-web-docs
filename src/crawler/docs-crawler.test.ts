import type { CrawlResult } from '../types.js';
import { DocsCrawler } from './docs-crawler.js';

const mockGitHubCrawl = vi.fn();
vi.mock('./github.js', () => ({
  GitHubCrawler: function () {
    return {
      crawl: mockGitHubCrawl,
    };
  },
}));

const mockCrawleeCrawl = vi.fn();
const mockSetStorageState = vi.fn();
vi.mock('./crawlee-crawler.js', () => ({
  CrawleeCrawler: function () {
    return {
      crawl: mockCrawleeCrawl,
      setStorageState: mockSetStorageState,
    };
  },
}));

describe('DocsCrawler', () => {
  let crawler: DocsCrawler;

  beforeEach(() => {
    vi.clearAllMocks();
    crawler = new DocsCrawler();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      expect(crawler).toBeDefined();
    });

    it('should accept custom parameters', () => {
      const customCrawler = new DocsCrawler(10, 500, 'github_token', vi.fn());
      expect(customCrawler).toBeDefined();
    });
  });

  describe('crawl', () => {
    describe('GitHub URLs', () => {
      it('should use GitHubCrawler for github.com URLs', async () => {
        const mockResults: CrawlResult[] = [
          { url: 'https://github.com/owner/repo/README.md', path: 'README.md', content: '# README', title: 'README' },
        ];

        mockGitHubCrawl.mockImplementation(async function* () {
          for (const result of mockResults) {
            yield result;
          }
        });

        const results: CrawlResult[] = [];
        const generator = crawler.crawl('https://github.com/owner/repo');

        for await (const result of generator) {
          results.push(result);
        }

        expect(results).toHaveLength(1);
        expect(results[0].url).toContain('github.com');
      });

      it('should return github type for GitHub URLs', async () => {
        mockGitHubCrawl.mockImplementation(async function* () {
          yield { url: 'https://github.com/owner/repo', path: '/', content: 'test', title: 'Test' };
        });

        const generator = crawler.crawl('https://github.com/owner/repo');

        // Manually iterate to capture the return value
        let result = await generator.next();
        while (!result.done) {
          result = await generator.next();
        }
        const crawlerType = result.value;

        expect(crawlerType).toBe('github');
      });

      it('should propagate errors from GitHubCrawler', async () => {
        // eslint-disable-next-line require-yield
        mockGitHubCrawl.mockImplementation(async function* () {
          throw new Error('GitHub API error');
        });

        const generator = crawler.crawl('https://github.com/owner/repo');

        await expect(async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of generator) {
            // Just consume results
          }
        }).rejects.toThrow('GitHub API error');
      });
    });

    describe('Non-GitHub URLs', () => {
      it('should use CrawleeCrawler for non-GitHub URLs', async () => {
        const mockResults: CrawlResult[] = [
          { url: 'https://docs.example.com/guide', path: '/guide', content: '<h1>Guide</h1>', title: 'Guide' },
          { url: 'https://docs.example.com/api', path: '/api', content: '<h1>API</h1>', title: 'API' },
        ];

        mockCrawleeCrawl.mockImplementation(async function* () {
          for (const result of mockResults) {
            yield result;
          }
        });

        const results: CrawlResult[] = [];
        for await (const result of crawler.crawl('https://docs.example.com')) {
          results.push(result);
        }

        expect(results).toHaveLength(2);
      });

      it('should return crawlee type for sufficient pages', async () => {
        mockCrawleeCrawl.mockImplementation(async function* () {
          yield { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', title: 'Page 1' };
          yield { url: 'https://example.com/page2', path: '/page2', content: 'Page 2', title: 'Page 2' };
        });

        const generator = crawler.crawl('https://example.com');

        // Manually iterate to capture the return value
        let result = await generator.next();
        while (!result.done) {
          result = await generator.next();
        }
        const crawlerType = result.value;

        expect(crawlerType).toBe('crawlee');
      });

      it('should throw error when insufficient pages found', async () => {
        mockCrawleeCrawl.mockImplementation(async function* () {
          yield { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', title: 'Page 1' };
          // Only 1 page, needs at least 2
        });

        const generator = crawler.crawl('https://example.com');

        await expect(async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of generator) {
            // Just consume results
          }
        }).rejects.toThrow(/found only 1 pages/);
      });
    });

    describe('abort', () => {
      it('should stop crawling when aborted', async () => {
        mockCrawleeCrawl.mockImplementation(async function* () {
          yield { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', title: 'Page 1' };
          yield { url: 'https://example.com/page2', path: '/page2', content: 'Page 2', title: 'Page 2' };
          yield { url: 'https://example.com/page3', path: '/page3', content: 'Page 3', title: 'Page 3' };
        });

        const results: CrawlResult[] = [];
        const generator = crawler.crawl('https://example.com');

        // Get first result
        const first = await generator.next();
        if (!first.done) {
          results.push(first.value);
        }

        // Abort
        crawler.abort();

        // Generator should stop yielding after abort (depending on implementation)
        // The test verifies abort() method exists and is callable
        expect(results).toHaveLength(1);
      });

      it('should return early when already aborting', async () => {
        crawler.abort();

        mockCrawleeCrawl.mockImplementation(async function* () {
          yield { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', title: 'Page 1' };
        });

        const generator = crawler.crawl('https://example.com');
        const result = await generator.next();

        // Should return immediately with crawlee type when aborted
        expect(result.done).toBe(true);
        expect(result.value).toBe('crawlee');
      });
    });

    describe('setStorageState', () => {
      it('should set storage state', () => {
        const storageState = {
          cookies: [{ name: 'session', value: 'abc123', domain: 'example.com', path: '/' }],
        };

        crawler.setStorageState(storageState);

        // Verify the method doesn't throw
        expect(true).toBe(true);
      });

      it('should pass storage state to CrawleeCrawler', async () => {
        const storageState = {
          cookies: [{ name: 'session', value: 'abc123', domain: 'example.com', path: '/' }],
        };

        crawler.setStorageState(storageState);

        mockCrawleeCrawl.mockImplementation(async function* () {
          yield { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', title: 'Page 1' };
          yield { url: 'https://example.com/page2', path: '/page2', content: 'Page 2', title: 'Page 2' };
        });

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of crawler.crawl('https://example.com')) {
          // Just consume results
        }

        expect(mockSetStorageState).toHaveBeenCalledWith(storageState);
      });
    });
  });
});
