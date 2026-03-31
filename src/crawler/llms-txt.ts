import { logger } from '../util/logger.js';

/**
 * Fetches and parses a site's llms.txt file to discover documentation URLs.
 *
 * llms.txt is a convention where sites publish a machine-readable index of their
 * documentation pages. This provides a reliable URL discovery mechanism that works
 * even when Cloudflare or other bot protection blocks link-following during crawls.
 *
 * @see https://llmstxt.org/
 */

const LLMS_TXT_TIMEOUT_MS = 10_000;

/**
 * Extract URLs from llms.txt content.
 * Parses markdown-style links: `- [Title](/path/)` → full URL
 */
export function parseLlmsTxt(content: string, baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  const urls: string[] = [];
  const seen = new Set<string>();

  // Match markdown links: [text](url)
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;

  while ((match = linkPattern.exec(content)) !== null) {
    const rawUrl = match[2].trim();
    if (!rawUrl) continue;

    let fullUrl: string;
    try {
      if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        fullUrl = rawUrl;
      } else if (rawUrl.startsWith('/')) {
        fullUrl = origin + rawUrl;
      } else {
        continue;
      }

      const parsed = new URL(fullUrl);

      // Only include URLs from the same origin
      if (parsed.origin !== origin) continue;

      // Skip non-page resources
      const ext = parsed.pathname.split('.').pop()?.toLowerCase();
      if (ext && !['html', 'htm'].includes(ext) && parsed.pathname.includes('.')) {
        continue;
      }

      // Normalize: strip hash, keep path+query
      const normalized = parsed.origin + parsed.pathname + parsed.search;

      if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    } catch {
      logger.debug(`[llms-txt] Skipping invalid URL: ${rawUrl}`);
    }
  }

  return urls;
}

/**
 * Attempt to fetch and parse llms.txt from a site.
 * Returns discovered URLs, or an empty array if llms.txt is unavailable.
 */
export async function discoverUrlsFromLlmsTxt(baseUrl: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const llmsTxtUrl = `${origin}/llms.txt`;

  logger.info(`[llms-txt] Checking for ${llmsTxtUrl}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLMS_TXT_TIMEOUT_MS);

    const response = await fetch(llmsTxtUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; mcp-web-docs/1.0)',
        Accept: 'text/plain, text/markdown, */*',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.debug(`[llms-txt] No llms.txt found (HTTP ${response.status})`);
      return [];
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      logger.debug(`[llms-txt] Response is HTML, not a text file - skipping`);
      return [];
    }

    const content = await response.text();
    if (!content.trim()) {
      logger.debug(`[llms-txt] Empty llms.txt`);
      return [];
    }

    const urls = parseLlmsTxt(content, baseUrl);
    logger.info(`[llms-txt] Discovered ${urls.length} URLs from llms.txt`);

    return urls;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      logger.debug(`[llms-txt] Request timed out`);
    } else {
      logger.debug(`[llms-txt] Failed to fetch:`, error);
    }
    return [];
  }
}
