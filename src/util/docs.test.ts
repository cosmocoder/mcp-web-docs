import { generateCrawlStorageId, generateDocId, isPathAllowed } from './docs.js';

describe('Docs Utilities', () => {
  describe('generateDocId', () => {
    it('should generate ID for GitHub Pages URLs', () => {
      const result = generateDocId('https://jimdo.github.io/ui/latest', 'UI Components');
      expect(result).toBe('jimdo-ui');
    });

    it('should generate ID for GitHub Pages with subdirectory', () => {
      const result = generateDocId('https://myorg.github.io/my-package/docs/guide', 'Guide');
      expect(result).toBe('myorg-my-package');
    });

    it('should generate ID for scoped package titles', () => {
      const result = generateDocId('https://example.com/docs', '@org/package-name');
      expect(result).toBe('-org-package-name');
    });

    it('should generate ID from hostname for regular URLs', () => {
      const result = generateDocId('https://docs.example.com/guide', 'Example Guide');
      // Includes first path part since it's not 'docs'
      expect(result).toBe('docs-guide');
    });

    it('should include path part for non-docs paths', () => {
      const result = generateDocId('https://example.com/react-components', 'Components');
      expect(result).toBe('example-react-components');
    });

    it('should exclude docs from path', () => {
      const result = generateDocId('https://example.com/docs/getting-started', 'Getting Started');
      expect(result).toBe('example');
    });

    it('should handle www prefix', () => {
      const result = generateDocId('https://www.example.com/api', 'API Reference');
      expect(result).toBe('example-api');
    });

    it('should handle simple hostname', () => {
      const result = generateDocId('https://localhost:3000/', 'Local Docs');
      // Port is not included in the hostname parsing
      expect(result).toBe('localhost');
    });

    it('should handle URLs with query parameters', () => {
      const result = generateDocId('https://docs.site.com/api?version=2', 'API v2');
      // Includes path part
      expect(result).toBe('docs-api');
    });

    it('should handle URLs with fragments', () => {
      const result = generateDocId('https://example.com/guide#section', 'Guide');
      expect(result).toBe('example-guide');
    });
  });

  describe('generateCrawlStorageId', () => {
    it.each([
      ['https://example.com/docs', 'crawl-de106e607d0e711199de3fb7eb98fe5d412ee49ac326eadd3db848ee272ad2cb'],
      ['https://example.com/docs?', 'crawl-fcd40b351fdf73c2bb50cb17406ad09c27e47e9eaf274454c88f36731fdbfe3b'],
      ['https://example.com/docs/?', 'crawl-fcd40b351fdf73c2bb50cb17406ad09c27e47e9eaf274454c88f36731fdbfe3b'],
      ['https://example.com/docs?version=2', 'crawl-52c3bba491a1b593ab3ee5b9ff17a574e5a22f05591f68d3bce358760c027dcc'],
      ['https://example.com/', 'crawl-0f115db062b7c0dd030b16878c99dea5c354b49dc37b38eb8846179c7783e9d7'],
    ])('should preserve the SHA-256 storage ID for %s', (url, expected) => {
      expect(generateCrawlStorageId(url)).toBe(expected);
    });

    it('should ignore fragments and normalize trailing slashes', () => {
      const expected = generateCrawlStorageId('https://example.com/docs');

      expect(generateCrawlStorageId('https://example.com/docs/')).toBe(expected);
      expect(generateCrawlStorageId('https://example.com/docs/#introduction')).toBe(expected);
      expect(generateCrawlStorageId('https://example.com/docs/?version=2')).toBe(
        generateCrawlStorageId('https://example.com/docs?version=2')
      );
    });

    it('should distinguish URLs that collide under the display ID', () => {
      const firstUrl = 'https://docs.example.com/guide';
      const secondUrl = 'https://docs.example.com/guide?version=2';

      expect(generateDocId(firstUrl, 'Guide')).toBe(generateDocId(secondUrl, 'Guide'));
      expect(generateCrawlStorageId(firstUrl)).not.toBe(generateCrawlStorageId(secondUrl));
    });
  });

  describe('isPathAllowed', () => {
    it('should match exact prefix without trailing slash', () => {
      expect(isPathAllowed('/docs', '/docs')).toBe(true);
    });

    it('should match exact prefix with trailing slash', () => {
      expect(isPathAllowed('/docs/', '/docs/')).toBe(true);
    });

    it('should match subpaths', () => {
      expect(isPathAllowed('/docs/intro', '/docs')).toBe(true);
      expect(isPathAllowed('/docs/guides/getting-started', '/docs')).toBe(true);
    });

    it('should match subpaths when prefix has a trailing slash', () => {
      expect(isPathAllowed('/docs/intro', '/docs/')).toBe(true);
      expect(isPathAllowed('/docs/guides/getting-started', '/docs/')).toBe(true);
    });

    it('should reject paths outside the prefix', () => {
      expect(isPathAllowed('/blog/post', '/docs')).toBe(false);
      expect(isPathAllowed('/', '/docs')).toBe(false);
    });

    it('should not match paths that only share a string prefix', () => {
      expect(isPathAllowed('/documentation', '/docs')).toBe(false);
      expect(isPathAllowed('/docs-old/page', '/docs')).toBe(false);
    });
  });
});
