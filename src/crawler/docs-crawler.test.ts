import type { CrawlResult } from '../types.js';
import { DocsCrawler } from './docs-crawler.js';

const mockGitHubCrawl = vi.fn();
const mockGitHubAbort = vi.fn();
const mockGitHubConstructor = vi.fn();
vi.mock('./github.js', () => ({
  GitHubCrawler: function (...args: unknown[]) {
    mockGitHubConstructor(...args);
    return {
      crawl: mockGitHubCrawl,
      abort: mockGitHubAbort,
    };
  },
}));

const mockCrawleeCrawl = vi.fn();
const mockCrawleeAbort = vi.fn();
const mockCrawleeConstructor = vi.fn();
const mockSetStorageState = vi.fn();
const mockSetPathPrefix = vi.fn();
vi.mock('./crawlee-crawler.js', () => ({
  CrawleeCrawler: function (...args: unknown[]) {
    mockCrawleeConstructor(...args);
    return {
      crawl: mockCrawleeCrawl,
      abort: mockCrawleeAbort,
      setStorageState: mockSetStorageState,
      setPathPrefix: mockSetPathPrefix,
    };
  },
}));

describe('DocsCrawler', () => {
  let crawler: DocsCrawler;

  beforeEach(() => {
    vi.clearAllMocks();
    crawler = new DocsCrawler();
  });

  it('passes the GitHub token to the selected crawler', async () => {
    const configuredCrawler = new DocsCrawler('github_token');
    mockGitHubCrawl.mockImplementation(async function* () {
      yield* [];
    });

    await configuredCrawler.crawl('https://github.com/owner/repo').next();

    expect(mockGitHubConstructor).toHaveBeenCalledWith('github_token');
  });

  describe('crawl', () => {
    describe('GitHub URLs', () => {
      it('should use GitHubCrawler for github.com URLs', async () => {
        const mockResults: CrawlResult[] = [
          {
            url: 'https://github.com/owner/repo/README.md',
            path: 'README.md',
            content: '# README',
            contentFormat: 'markdown',
            title: 'README',
          },
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
          { url: 'https://docs.example.com/guide', path: '/guide', content: 'Guide', contentFormat: 'text', title: 'Guide' },
          { url: 'https://docs.example.com/api', path: '/api', content: 'API', contentFormat: 'text', title: 'API' },
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
    });

    describe('abort', () => {
      it.each([
        {
          name: 'GitHub',
          url: 'https://github.com/owner/repo',
          crawl: mockGitHubCrawl,
          abort: mockGitHubAbort,
          contentFormat: 'markdown' as const,
        },
        {
          name: 'Crawlee',
          url: 'https://example.com',
          crawl: mockCrawleeCrawl,
          abort: mockCrawleeAbort,
          contentFormat: 'text' as const,
        },
      ])('delegates to the active $name crawler before its first page', async ({ url, crawl, abort, contentFormat }) => {
        const entered = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        crawl.mockImplementation(async function* () {
          entered.resolve();
          await released.promise;
          yield { url, path: '/', content: 'Page', contentFormat, title: 'Page' };
        });

        const next = crawler.crawl(url).next();
        await entered.promise;
        crawler.abort();

        expect(abort).toHaveBeenCalledOnce();
        released.resolve();
        await expect(next).resolves.toMatchObject({ done: true });
      });

      it('should return early when already aborting', async () => {
        crawler.abort();

        mockCrawleeCrawl.mockImplementation(async function* () {
          yield { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', contentFormat: 'text', title: 'Page 1' };
        });

        const generator = crawler.crawl('https://example.com');
        const result = await generator.next();

        expect(result.done).toBe(true);
        expect(mockCrawleeCrawl).not.toHaveBeenCalled();
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
          yield { url: 'https://example.com/page1', path: '/page1', content: 'Page 1', contentFormat: 'text', title: 'Page 1' };
          yield { url: 'https://example.com/page2', path: '/page2', content: 'Page 2', contentFormat: 'text', title: 'Page 2' };
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
