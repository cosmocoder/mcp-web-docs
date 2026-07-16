import { GitHubCrawler } from './github.js';
import type { CrawlResult } from '../types.js';

function githubFile(path: string, branch = 'main') {
  return {
    path,
    type: 'file',
    url: `https://api.github.com/repos/owner/repo/contents/${path}`,
    html_url: `https://github.com/owner/repo/blob/${branch}/${path}`,
    download_url: `https://raw.githubusercontent.com/owner/repo/${branch}/${path}`,
  };
}

describe('GitHubCrawler', () => {
  let crawler: GitHubCrawler;

  beforeEach(() => {
    fetchMock.resetMocks();
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
      // First call: list root directory
      fetchMock.mockResponseOnce(
        JSON.stringify([
          { path: 'docs', type: 'dir', name: 'docs', url: 'https://api.github.com/repos/owner/repo/contents/docs' },
          { path: 'src', type: 'dir', name: 'src', url: 'https://api.github.com/repos/owner/repo/contents/src' },
        ])
      );
      // Second call: list docs directory
      fetchMock.mockResponseOnce(JSON.stringify([githubFile('docs/guide.md'), githubFile('docs/api.md')]));
      // Third call: fetch guide.md content
      fetchMock.mockResponseOnce('# Guide\n\nThis is the guide content.');
      // Fourth call: fetch api.md content
      fetchMock.mockResponseOnce('# API Reference\n\nAPI documentation.');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results[0].path).toBe('docs/guide.md');
      expect(results[0].content).toContain('Guide');
      expect(results[0].contentFormat).toBe('markdown');
      expect(results[1].path).toBe('docs/api.md');
    });

    it('should use canonical URLs from a repository whose default branch is master', async () => {
      const rootFiles = [githubFile('README.md', 'master')];
      // First call: findDocumentationDirs checks root
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // Second call: processDirectory fetches root again (no doc dirs found)
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // Third call: fetch README.md content
      fetchMock.mockResponseOnce('# README\n\nProject readme.');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo.git')) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('README');
      expect(results[0].url).toBe('https://github.com/owner/repo/blob/master/README.md');
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/contents/');
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/repos/owner/repo/contents/');
      expect(fetchMock.mock.calls[2][0]).toBe('https://raw.githubusercontent.com/owner/repo/master/README.md');
    });

    it('should skip non-markdown files', async () => {
      const rootFiles = [githubFile('index.js'), githubFile('style.css'), githubFile('README.md')];
      // First call: findDocumentationDirs checks root
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // Second call: processDirectory fetches root again (no doc dirs found)
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // Third call: fetch README.md content
      fetchMock.mockResponseOnce('# README');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('README.md');
    });

    it('should handle various markdown extensions', async () => {
      const rootFiles = [githubFile('doc.md'), githubFile('page.mdx'), githubFile('guide.markdown')];
      // First call: findDocumentationDirs checks root
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // Second call: processDirectory fetches root again (no doc dirs found)
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // File content fetches
      fetchMock.mockResponseOnce('# Doc');
      fetchMock.mockResponseOnce('# Page');
      fetchMock.mockResponseOnce('# Guide');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(3);
    });

    it('should skip directories like node_modules, vendor, test, etc.', async () => {
      fetchMock.mockResponseOnce(
        JSON.stringify([
          {
            path: 'node_modules',
            type: 'dir',
            name: 'node_modules',
            url: 'https://api.github.com/repos/owner/repo/contents/node_modules',
          },
          { path: 'vendor', type: 'dir', name: 'vendor', url: 'https://api.github.com/repos/owner/repo/contents/vendor' },
          { path: 'test', type: 'dir', name: 'test', url: 'https://api.github.com/repos/owner/repo/contents/test' },
          { path: 'docs', type: 'dir', name: 'docs', url: 'https://api.github.com/repos/owner/repo/contents/docs' },
        ])
      );
      fetchMock.mockResponseOnce(JSON.stringify([githubFile('docs/guide.md')]));
      fetchMock.mockResponseOnce('# Guide');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      // Should only get the docs/guide.md, not files from skipped directories
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('docs/guide.md');
    });

    it('should handle GitHub API rate limit error', async () => {
      fetchMock.mockResponseOnce('', { status: 403 });

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      // Should return empty due to rate limit
      expect(results).toHaveLength(0);
    });

    it('should handle API errors gracefully', async () => {
      fetchMock.mockResponseOnce('', { status: 404 });

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

      const rootFiles = [githubFile('README.md')];
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      fetchMock.mockResponseOnce('# README');

      const results: CrawlResult[] = [];
      for await (const result of tokenCrawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://raw.githubusercontent.com/owner/repo/main/README.md',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token test_token_123',
          }),
        })
      );
    });

    it('should extract title from file path', async () => {
      const rootFiles = [githubFile('getting-started.md'), githubFile('api_reference.md')];
      // First call: findDocumentationDirs checks root
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // Second call: processDirectory fetches root again (no doc dirs found)
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // File content fetches
      fetchMock.mockResponseOnce('# Content');
      fetchMock.mockResponseOnce('# Content');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results[0].title).toBe('Getting Started');
      expect(results[1].title).toBe('Api Reference');
    });

    it('should use an explicit branch for root, recursive, and file requests', async () => {
      fetchMock.mockResponseOnce(
        JSON.stringify([{ path: 'docs', type: 'dir', url: 'https://api.github.com/repos/owner/repo/contents/docs' }])
      );
      fetchMock.mockResponseOnce(JSON.stringify([githubFile('docs/guide.md', 'develop')]));
      fetchMock.mockResponseOnce('# Guide');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo/tree/develop')) {
        results.push(result);
      }

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/contents/?ref=develop');
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/repos/owner/repo/contents/docs?ref=develop');
      expect(fetchMock.mock.calls[2][0]).toBe('https://raw.githubusercontent.com/owner/repo/develop/docs/guide.md');
      expect(results[0].url).toBe('https://github.com/owner/repo/blob/develop/docs/guide.md');
    });

    it('should treat a literal suffix as a subdirectory on a single-segment branch', async () => {
      fetchMock.mockResponseOnce(JSON.stringify([githubFile('docs/guide.md', 'feature')]));
      fetchMock.mockResponseOnce('# Guide');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo/tree/feature/docs')) {
        results.push(result);
      }

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/contents/docs?ref=feature');
      expect(results.map(({ path }) => path)).toEqual(['docs/guide.md']);
    });

    it('should use an encoded slash as part of the branch name', async () => {
      const rootFiles = [githubFile('README.md', 'feature/docs')];
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      fetchMock.mockResponseOnce('# README');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo/tree/feature%2Fdocs')) {
        results.push(result);
      }

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/contents/?ref=feature%2Fdocs');
      expect(results.map(({ url }) => url)).toEqual(['https://github.com/owner/repo/blob/feature/docs/README.md']);
    });

    it('should skip markdown files without canonical GitHub URLs', async () => {
      const rootFiles = [{ path: 'README.md', type: 'file', url: 'https://api.github.com/repos/owner/repo/contents/README.md' }];
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['invalid download URL', { download_url: 'not a URL' }],
      ['insecure download URL', { download_url: 'http://raw.githubusercontent.com/owner/repo/main/README.md' }],
      ['internal download URL', { download_url: 'https://127.0.0.1/README.md' }],
      ['attacker download URL', { download_url: 'https://attacker.example/README.md' }],
      ['insecure HTML URL', { html_url: 'http://github.com/owner/repo/blob/main/README.md' }],
      ['non-GitHub HTML URL', { html_url: 'https://attacker.example/owner/repo/blob/main/README.md' }],
    ])('should reject %s', async (_name, override) => {
      const rootFiles = [{ ...githubFile('README.md'), ...override }];
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.every(([request]) => String(request).startsWith('https://api.github.com/'))).toBe(true);
    });

    it('should handle fetch errors for file content', async () => {
      const rootFiles = [githubFile('guide.md')];
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      fetchMock.mockRejectOnce(new Error('Network error'));

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      // Should skip files that fail to fetch
      expect(results).toHaveLength(0);
      expect(fetchMock.mock.calls[2][0]).toBe('https://raw.githubusercontent.com/owner/repo/main/guide.md');
    });

    it('should validate GitHub API response structure', async () => {
      // Mock invalid response structure
      fetchMock.mockResponseOnce(JSON.stringify({ invalid: 'structure' }));

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });

    it('should find multiple documentation directories', async () => {
      fetchMock.mockResponseOnce(
        JSON.stringify([
          { path: 'docs', type: 'dir', name: 'docs', url: 'https://api.github.com/repos/owner/repo/contents/docs' },
          { path: 'guide', type: 'dir', name: 'guide', url: 'https://api.github.com/repos/owner/repo/contents/guide' },
        ])
      );
      fetchMock.mockResponseOnce(JSON.stringify([githubFile('docs/api.md')]));
      fetchMock.mockResponseOnce('# API');
      fetchMock.mockResponseOnce(JSON.stringify([githubFile('guide/intro.md')]));
      fetchMock.mockResponseOnce('# Intro');

      const results: CrawlResult[] = [];
      for await (const result of crawler.crawl('https://github.com/owner/repo')) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
    });

    it('should stop crawling when aborted', async () => {
      const rootFiles = [githubFile('doc1.md'), githubFile('doc2.md')];
      // First call: findDocumentationDirs checks root
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // Second call: processDirectory fetches root again (no doc dirs found)
      fetchMock.mockResponseOnce(JSON.stringify(rootFiles));
      // Third call: fetch doc1.md content
      fetchMock.mockResponseOnce('# Doc 1');

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

    it('cancels an in-flight GitHub request when aborted', async () => {
      const requestStarted = Promise.withResolvers<AbortSignal>();
      fetchMock.mockImplementationOnce((_input, init) => {
        const signal = init?.signal as AbortSignal;
        requestStarted.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });

      const result = crawler.crawl('https://github.com/owner/repo').next();
      const signal = await requestStarted.promise;
      crawler.abort();

      expect(signal.aborted).toBe(true);
      await expect(result).resolves.toMatchObject({ done: true });
    });
  });
});
