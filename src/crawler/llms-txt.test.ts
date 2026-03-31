import { parseLlmsTxt, discoverUrlsFromLlmsTxt } from './llms-txt.js';

describe('llms-txt', () => {
  describe('parseLlmsTxt', () => {
    const baseUrl = 'https://www.example.com/docs/';

    it('should parse markdown links with relative paths', () => {
      const content = `# Example Docs

## Docs
- [Getting Started](/docs/getting-started/)
- [API Reference](/docs/api/)
- [Configuration](/docs/config/)
`;
      const urls = parseLlmsTxt(content, baseUrl);

      expect(urls).toEqual([
        'https://www.example.com/docs/getting-started/',
        'https://www.example.com/docs/api/',
        'https://www.example.com/docs/config/',
      ]);
    });

    it('should parse absolute URLs from the same origin', () => {
      const content = `- [Page](https://www.example.com/docs/page1/)
- [Page 2](https://www.example.com/docs/page2/)`;

      const urls = parseLlmsTxt(content, baseUrl);

      expect(urls).toEqual(['https://www.example.com/docs/page1/', 'https://www.example.com/docs/page2/']);
    });

    it('should skip URLs from different origins', () => {
      const content = `- [External](https://other-site.com/docs/page/)
- [Local](/docs/local/)`;

      const urls = parseLlmsTxt(content, baseUrl);

      expect(urls).toEqual(['https://www.example.com/docs/local/']);
    });

    it('should deduplicate URLs', () => {
      const content = `- [Page](/docs/page/)
- [Same Page](/docs/page/)
- [Also Same](https://www.example.com/docs/page/)`;

      const urls = parseLlmsTxt(content, baseUrl);

      expect(urls).toEqual(['https://www.example.com/docs/page/']);
    });

    it('should strip hash fragments', () => {
      const content = `- [Section](/docs/page/#section)
- [Page](/docs/page/)`;

      const urls = parseLlmsTxt(content, baseUrl);

      expect(urls).toEqual(['https://www.example.com/docs/page/']);
    });

    it('should skip non-page resources', () => {
      const content = `- [Image](/images/logo.png)
- [PDF](/files/guide.pdf)
- [Page](/docs/guide/)`;

      const urls = parseLlmsTxt(content, baseUrl);

      expect(urls).toEqual(['https://www.example.com/docs/guide/']);
    });

    it('should return empty array when no links are present', () => {
      expect(parseLlmsTxt('', baseUrl)).toEqual([]);
      expect(parseLlmsTxt('# Just some text\nNo links here.', baseUrl)).toEqual([]);
    });

    it('should handle inline markdown links', () => {
      const content = `Check out the [Getting Started](/docs/start/) guide and [API](/docs/api/).`;

      const urls = parseLlmsTxt(content, baseUrl);

      expect(urls).toEqual(['https://www.example.com/docs/start/', 'https://www.example.com/docs/api/']);
    });

    it('should skip relative URLs that are not absolute paths', () => {
      const content = `- [Relative](relative/path/)
- [Absolute](/docs/absolute/)`;

      const urls = parseLlmsTxt(content, baseUrl);

      expect(urls).toEqual(['https://www.example.com/docs/absolute/']);
    });
  });

  describe('discoverUrlsFromLlmsTxt', () => {
    beforeEach(() => {
      fetchMock.resetMocks();
    });

    it('should fetch and parse llms.txt', async () => {
      const llmsContent = `# Docs
- [Page 1](/docs/page1/)
- [Page 2](/docs/page2/)`;

      fetchMock.mockResponseOnce(llmsContent, {
        headers: { 'content-type': 'text/plain' },
      });

      const urls = await discoverUrlsFromLlmsTxt('https://www.example.com/docs/');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://www.example.com/llms.txt',
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'text/plain, text/markdown, */*',
          }),
        })
      );
      expect(urls).toEqual(['https://www.example.com/docs/page1/', 'https://www.example.com/docs/page2/']);
    });

    it('should return empty array on 404', async () => {
      fetchMock.mockResponseOnce('Not Found', { status: 404 });

      const urls = await discoverUrlsFromLlmsTxt('https://www.example.com/docs/');

      expect(urls).toEqual([]);
    });

    it('should return empty array on network error', async () => {
      fetchMock.mockRejectOnce(new Error('Network error'));

      const urls = await discoverUrlsFromLlmsTxt('https://www.example.com/docs/');

      expect(urls).toEqual([]);
    });

    it('should skip HTML responses (likely a redirect to homepage)', async () => {
      fetchMock.mockResponseOnce('<html><body>Not found</body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });

      const urls = await discoverUrlsFromLlmsTxt('https://www.example.com/docs/');

      expect(urls).toEqual([]);
    });

    it('should return empty array for empty response', async () => {
      fetchMock.mockResponseOnce('', {
        headers: { 'content-type': 'text/plain' },
      });

      const urls = await discoverUrlsFromLlmsTxt('https://www.example.com/docs/');

      expect(urls).toEqual([]);
    });
  });
});
