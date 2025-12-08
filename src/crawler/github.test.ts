import { GitHubCrawler } from './github.js';
import type { CrawlResult } from '../types.js';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('GitHubCrawler', () => {
  let crawler: GitHubCrawler;

  beforeEach(() => {
    vi.clearAllMocks();
    crawler = new GitHubCrawler();
    // Mock rateLimit to skip delays - the method is in BaseCrawler
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(crawler as any, 'rateLimit').mockResolvedValue(undefined);
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      const defaultCrawler = new GitHubCrawler();
      expect(defaultCrawler).toBeDefined();
    });

    it('should accept custom maxDepth and maxRequestsPerCrawl', () => {
      const customCrawler = new GitHubCrawler(10, 500);
      expect(customCrawler).toBeDefined();
    });

    it('should accept GitHub token', () => {
      const tokenCrawler = new GitHubCrawler(4, 1000, 'github_token_123');
      expect(tokenCrawler).toBeDefined();
    });

    it('should accept progress callback', () => {
      const progressFn = vi.fn();
      const progressCrawler = new GitHubCrawler(4, 1000, undefined, progressFn);
      expect(progressCrawler).toBeDefined();
    });
  });

  describe('crawl', () => {
    it('should reject invalid GitHub URLs', async () => {
      const results: CrawlResult[] = [];

      // Non-GitHub URL
      for await (const result of crawler.crawl('https://example.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });

    it('should reject URLs without owner/repo', async () => {
      const results: CrawlResult[] = [];

      for await (const result of crawler.crawl('https://github.com')) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });

    it('should crawl documentation directory when found', async () => {
      // Mock the API responses
      mockFetch
        // First call: list root directory
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { path: 'docs', type: 'dir', name: 'docs', url: 'https://api.github.com/repos/owner/repo/contents/docs' },
            { path: 'src', type: 'dir', name: 'src', url: 'https://api.github.com/repos/owner/repo/contents/src' },
          ],
        })
        // Second call: list docs directory
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              path: 'docs/guide.md',
              type: 'file',
              name: 'guide.md',
              url: 'https://api.github.com/repos/owner/repo/contents/docs/guide.md',
            },
            { path: 'docs/api.md', type: 'file', name: 'api.md', url: 'https://api.github.com/repos/owner/repo/contents/docs/api.md' },
          ],
        })
        // Third call: fetch guide.md content
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '# Guide\n\nThis is the guide content.',
        })
        // Fourth call: fetch api.md content
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '# API Reference\n\nAPI documentation.',
        });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results[0].path).toBe('docs/guide.md');
      expect(results[0].content).toContain('Guide');
      expect(results[1].path).toBe('docs/api.md');
    });

    it('should handle .git extension in repo URL', async () => {
      // No doc directories, so need two mocks for root: one for findDocumentationDirs, one for processDirectory
      const rootFiles = [
        { path: 'README.md', type: 'file', name: 'README.md', url: 'https://api.github.com/repos/owner/repo/contents/README.md' },
      ];
      mockFetch
        // First call: findDocumentationDirs checks root
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // Second call: processDirectory fetches root again (no doc dirs found)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // Third call: fetch README.md content
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '# README\n\nProject readme.',
        });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo.git')) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('README');
    });

    it('should skip non-markdown files', async () => {
      // No doc directories, so need two mocks for root
      const rootFiles = [
        { path: 'index.js', type: 'file', name: 'index.js', url: 'https://api.github.com/repos/owner/repo/contents/index.js' },
        { path: 'style.css', type: 'file', name: 'style.css', url: 'https://api.github.com/repos/owner/repo/contents/style.css' },
        { path: 'README.md', type: 'file', name: 'README.md', url: 'https://api.github.com/repos/owner/repo/contents/README.md' },
      ];
      mockFetch
        // First call: findDocumentationDirs checks root
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // Second call: processDirectory fetches root again (no doc dirs found)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // Third call: fetch README.md content
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '# README',
        });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('README.md');
    });

    it('should handle various markdown extensions', async () => {
      // No doc directories, so need two mocks for root
      const rootFiles = [
        { path: 'doc.md', type: 'file', name: 'doc.md', url: 'https://api.github.com/repos/owner/repo/contents/doc.md' },
        { path: 'page.mdx', type: 'file', name: 'page.mdx', url: 'https://api.github.com/repos/owner/repo/contents/page.mdx' },
        {
          path: 'guide.markdown',
          type: 'file',
          name: 'guide.markdown',
          url: 'https://api.github.com/repos/owner/repo/contents/guide.markdown',
        },
      ];
      mockFetch
        // First call: findDocumentationDirs checks root
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // Second call: processDirectory fetches root again (no doc dirs found)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // File content fetches
        .mockResolvedValueOnce({ ok: true, text: async () => '# Doc' })
        .mockResolvedValueOnce({ ok: true, text: async () => '# Page' })
        .mockResolvedValueOnce({ ok: true, text: async () => '# Guide' });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(3);
    });

    it('should skip directories like node_modules, vendor, test, etc.', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              path: 'node_modules',
              type: 'dir',
              name: 'node_modules',
              url: 'https://api.github.com/repos/owner/repo/contents/node_modules',
            },
            { path: 'vendor', type: 'dir', name: 'vendor', url: 'https://api.github.com/repos/owner/repo/contents/vendor' },
            { path: 'test', type: 'dir', name: 'test', url: 'https://api.github.com/repos/owner/repo/contents/test' },
            { path: 'docs', type: 'dir', name: 'docs', url: 'https://api.github.com/repos/owner/repo/contents/docs' },
          ],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              path: 'docs/guide.md',
              type: 'file',
              name: 'guide.md',
              url: 'https://api.github.com/repos/owner/repo/contents/docs/guide.md',
            },
          ],
        })
        .mockResolvedValueOnce({ ok: true, text: async () => '# Guide' });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      // Should only get the docs/guide.md, not files from skipped directories
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('docs/guide.md');
    });

    it('should handle GitHub API rate limit error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
      });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      // Should return empty due to rate limit
      expect(results).toHaveLength(0);
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });

    it('should use GitHub token in headers when provided', async () => {
      const tokenCrawler = new GitHubCrawler(4, 1000, 'test_token_123');
      // Mock rateLimit for new crawler instance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(tokenCrawler as any, 'rateLimit').mockResolvedValue(undefined);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const results: CrawlResult[] = [];
      for await (const result of tokenCrawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token test_token_123',
          }),
        })
      );
    });

    it('should extract title from file path', async () => {
      // No doc directories, so need two mocks for root
      const rootFiles = [
        {
          path: 'getting-started.md',
          type: 'file',
          name: 'getting-started.md',
          url: 'https://api.github.com/repos/owner/repo/contents/getting-started.md',
        },
        {
          path: 'api_reference.md',
          type: 'file',
          name: 'api_reference.md',
          url: 'https://api.github.com/repos/owner/repo/contents/api_reference.md',
        },
      ];
      mockFetch
        // First call: findDocumentationDirs checks root
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // Second call: processDirectory fetches root again (no doc dirs found)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // File content fetches
        .mockResolvedValueOnce({ ok: true, text: async () => '# Content' })
        .mockResolvedValueOnce({ ok: true, text: async () => '# Content' });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results[0].title).toBe('Getting Started');
      expect(results[1].title).toBe('Api Reference');
    });

    it('should construct correct GitHub blob URLs', async () => {
      mockFetch
        // First call: findDocumentationDirs checks root - find docs directory
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ path: 'docs', type: 'dir', name: 'docs', url: 'https://api.github.com/repos/owner/repo/contents/docs' }],
        })
        // Second call: processDirectory fetches docs directory contents
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              path: 'docs/guide.md',
              type: 'file',
              name: 'guide.md',
              url: 'https://api.github.com/repos/owner/repo/contents/docs/guide.md',
            },
          ],
        })
        // Third call: fetch file content
        .mockResolvedValueOnce({ ok: true, text: async () => '# Guide' });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results[0].url).toBe('https://github.com/owner/repo/blob/main/docs/guide.md');
    });

    it('should handle fetch errors for file content', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { path: 'guide.md', type: 'file', name: 'guide.md', url: 'https://api.github.com/repos/owner/repo/contents/guide.md' },
          ],
        })
        .mockRejectedValueOnce(new Error('Network error'));

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      // Should skip files that fail to fetch
      expect(results).toHaveLength(0);
    });

    it('should validate GitHub API response structure', async () => {
      // Mock invalid response structure
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invalid: 'structure' }),
      });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });

    it('should find multiple documentation directories', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { path: 'docs', type: 'dir', name: 'docs', url: 'https://api.github.com/repos/owner/repo/contents/docs' },
            { path: 'guide', type: 'dir', name: 'guide', url: 'https://api.github.com/repos/owner/repo/contents/guide' },
          ],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { path: 'docs/api.md', type: 'file', name: 'api.md', url: 'https://api.github.com/repos/owner/repo/contents/docs/api.md' },
          ],
        })
        .mockResolvedValueOnce({ ok: true, text: async () => '# API' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              path: 'guide/intro.md',
              type: 'file',
              name: 'intro.md',
              url: 'https://api.github.com/repos/owner/repo/contents/guide/intro.md',
            },
          ],
        })
        .mockResolvedValueOnce({ ok: true, text: async () => '# Intro' });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
    });

    it('should stop crawling when aborted', async () => {
      // No doc directories, so need two mocks for root
      const rootFiles = [
        { path: 'doc1.md', type: 'file', name: 'doc1.md', url: 'https://api.github.com/repos/owner/repo/contents/doc1.md' },
        { path: 'doc2.md', type: 'file', name: 'doc2.md', url: 'https://api.github.com/repos/owner/repo/contents/doc2.md' },
      ];
      mockFetch
        // First call: findDocumentationDirs checks root
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // Second call: processDirectory fetches root again (no doc dirs found)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => rootFiles,
        })
        // Third call: fetch doc1.md content
        .mockResolvedValueOnce({ ok: true, text: async () => '# Doc 1' });

      const results: CrawlResult[] = [];
      const abortableCrawler = new GitHubCrawler();
      // Mock rateLimit for new crawler instance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(abortableCrawler as any, 'rateLimit').mockResolvedValue(undefined);

      // Get the generator
      const generator = abortableCrawler.crawl('https://github.com/owner/repo');

      // Get first result
      const first = await generator.next();
      if (!first.done) {
        results.push(first.value);
      }

      // Abort before getting second result
      (abortableCrawler as unknown as { isAborting: boolean }).isAborting = true;

      // Try to get more results
      for await (const result of generator) {
        results.push(result);
      }

      // Should only have the first result
      expect(results).toHaveLength(1);
    });
  });
});
