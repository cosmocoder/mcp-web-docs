import { fetchFavicon } from './favicon.js';

describe('Favicon Utilities', () => {
  beforeEach(() => {
    fetchMock.resetMocks();
  });

  describe('fetchFavicon', () => {
    it('should fetch standard favicon.ico', async () => {
      const faviconData = new Uint8Array([0x00, 0x00, 0x01, 0x00]); // ICO header
      fetchMock.mockResponseOnce(async () => ({
        body: Buffer.from(faviconData).toString(),
        headers: { 'content-type': 'image/x-icon' },
      }));

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeDefined();
      expect(result).toContain('data:image/x-icon;base64,');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/favicon.ico',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should return undefined when favicon.ico returns non-OK status and no meta tag found', async () => {
      // favicon.ico returns 404
      fetchMock.mockResponseOnce('', { status: 404 });
      // HTML fallback - no icon link
      fetchMock.mockResponseOnce('<html><head></head><body></body></html>');

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeUndefined();
    });

    it('should reject oversized favicons based on content-length header', async () => {
      fetchMock.mockResponseOnce('', {
        status: 200,
        headers: {
          'content-type': 'image/x-icon',
          'content-length': '2000000', // 2MB, exceeds 1MB limit
        },
      });

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeUndefined();
    });

    it('should reject oversized favicons based on actual buffer size', async () => {
      const oversizedData = new Uint8Array(1024 * 1024 + 1); // 1MB + 1 byte
      fetchMock.mockResponseOnce(async () => ({
        body: Buffer.from(oversizedData).toString(),
        headers: { 'content-type': 'image/x-icon' },
      }));

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeUndefined();
    });

    it('should fallback to HTML meta tag parsing when favicon.ico fails', async () => {
      const faviconData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
      // favicon.ico returns 404
      fetchMock.mockResponseOnce('', { status: 404 });
      // HTML page with icon link
      fetchMock.mockResponseOnce('<html><head><link rel="icon" href="/icon.png"></head><body></body></html>');
      // Fetch the icon from meta tag
      fetchMock.mockResponseOnce(async () => ({
        body: Buffer.from(faviconData).toString(),
        headers: { 'content-type': 'image/png' },
      }));

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeDefined();
      expect(result).toContain('data:image/png;base64,');
    });

    it('should handle shortcut icon rel value', async () => {
      const faviconData = new Uint8Array([0x00, 0x00, 0x01, 0x00]);
      fetchMock.mockResponseOnce('', { status: 404 });
      fetchMock.mockResponseOnce('<html><head><link rel="shortcut icon" href="/favicon.ico"></head></html>');
      fetchMock.mockResponseOnce(async () => ({
        body: Buffer.from(faviconData).toString(),
        headers: { 'content-type': 'image/x-icon' },
      }));

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeDefined();
    });

    it('should handle href before rel attribute order', async () => {
      const faviconData = new Uint8Array([0x00, 0x00, 0x01, 0x00]);
      fetchMock.mockResponseOnce('', { status: 404 });
      fetchMock.mockResponseOnce('<html><head><link href="/my-icon.ico" rel="icon"></head></html>');
      fetchMock.mockResponseOnce(async () => ({
        body: Buffer.from(faviconData).toString(),
        headers: { 'content-type': 'image/x-icon' },
      }));

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeDefined();
    });

    it('should return undefined on network error', async () => {
      fetchMock.mockRejectOnce(new Error('Network error'));

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeUndefined();
    });

    it('should return undefined on timeout (AbortError)', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      fetchMock.mockRejectOnce(abortError);

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeUndefined();
    });

    it('should handle response with content-type header', async () => {
      const faviconData = new Uint8Array([0x00, 0x00, 0x01, 0x00]);
      fetchMock.mockResponseOnce(async () => ({
        body: Buffer.from(faviconData).toString(),
        headers: { 'content-type': 'image/vnd.microsoft.icon' },
      }));

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeDefined();
      // Should use the content-type from the response
      expect(result).toContain('data:image/vnd.microsoft.icon;base64,');
    });

    it('should handle relative icon URLs correctly', async () => {
      const faviconData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      fetchMock.mockResponseOnce('', { status: 404 });
      fetchMock.mockResponseOnce('<html><head><link rel="icon" href="/assets/favicon.png"></head></html>');
      fetchMock.mockResponseOnce(async () => ({
        body: Buffer.from(faviconData).toString(),
        headers: { 'content-type': 'image/png' },
      }));

      const result = await fetchFavicon(new URL('https://example.com/page'));

      expect(result).toBeDefined();
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/assets/favicon.png', expect.any(Object));
    });

    it('should return undefined when icon from meta tag fails to load', async () => {
      fetchMock.mockResponseOnce('', { status: 404 });
      fetchMock.mockResponseOnce('<html><head><link rel="icon" href="/icon.png"></head></html>');
      fetchMock.mockResponseOnce('', { status: 404 });

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeUndefined();
    });

    it('should reject oversized icons from meta tag', async () => {
      fetchMock.mockResponseOnce('', { status: 404 });
      fetchMock.mockResponseOnce('<html><head><link rel="icon" href="/icon.png"></head></html>');
      fetchMock.mockResponseOnce('', {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': '2000000',
        },
      });

      const result = await fetchFavicon(new URL('https://example.com'));

      expect(result).toBeUndefined();
    });
  });
});
