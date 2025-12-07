import { logger } from './logger.js';

/** Default timeout for favicon fetch requests (10 seconds) */
const FETCH_TIMEOUT_MS = 10000;

/** Maximum favicon file size (1MB) to prevent memory issues */
const MAX_FAVICON_SIZE = 1024 * 1024;

/**
 * Fetch with timeout support
 * @param url - URL to fetch
 * @param timeoutMs - Timeout in milliseconds
 * @returns Response object
 */
async function fetchWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch favicon for a URL with timeout and size limits
 * @param url - The URL to fetch favicon for
 * @returns Base64 encoded favicon data URL or undefined
 */
export async function fetchFavicon(url: URL): Promise<string | undefined> {
  try {
    // Try standard favicon.ico location
    const faviconUrl = new URL('/favicon.ico', url.origin);
    const response = await fetchWithTimeout(faviconUrl.toString());

    if (response.ok) {
      // Check content length before downloading
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_FAVICON_SIZE) {
        logger.debug(`[Favicon] Favicon too large: ${contentLength} bytes`);
        return undefined;
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_FAVICON_SIZE) {
        logger.debug(`[Favicon] Favicon too large: ${buffer.byteLength} bytes`);
        return undefined;
      }

      const base64 = Buffer.from(buffer).toString('base64');
      const mimeType = response.headers.get('content-type') || 'image/x-icon';
      return `data:${mimeType};base64,${base64}`;
    }

    // Try HTML head meta tags
    const pageResponse = await fetchWithTimeout(url.toString());
    const html = await pageResponse.text();

    // Look for favicon in meta tags
    const iconMatch =
      html.match(/<link[^>]*?rel=["'](?:shortcut )?icon["'][^>]*?href=["']([^"']+)["'][^>]*>/i) ||
      html.match(/<link[^>]*?href=["']([^"']+)["'][^>]*?rel=["'](?:shortcut )?icon["'][^>]*>/i);

    if (iconMatch) {
      const iconUrl = new URL(iconMatch[1], url.origin);
      const iconResponse = await fetchWithTimeout(iconUrl.toString());

      if (iconResponse.ok) {
        // Check content length before downloading
        const contentLength = iconResponse.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_FAVICON_SIZE) {
          logger.debug(`[Favicon] Icon too large: ${contentLength} bytes`);
          return undefined;
        }

        const buffer = await iconResponse.arrayBuffer();
        if (buffer.byteLength > MAX_FAVICON_SIZE) {
          logger.debug(`[Favicon] Icon too large: ${buffer.byteLength} bytes`);
          return undefined;
        }

        const base64 = Buffer.from(buffer).toString('base64');
        const mimeType = iconResponse.headers.get('content-type') || 'image/x-icon';
        return `data:${mimeType};base64,${base64}`;
      }
    }

    return undefined;
  } catch (error) {
    // Handle abort errors (timeout) differently
    if (error instanceof Error && error.name === 'AbortError') {
      logger.debug(`[Favicon] Timeout fetching favicon for ${url.origin}`);
    } else {
      logger.debug(`[Favicon] Error fetching favicon for ${url.origin}:`, error);
    }
    return undefined;
  }
}
