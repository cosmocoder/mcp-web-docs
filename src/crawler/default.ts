import { URL } from 'url';
import * as cheerio from 'cheerio';
import { CrawlResult } from '../types.js';
import { BaseCrawler } from './base.js';

export class DefaultCrawler extends BaseCrawler {
  private readonly BATCH_SIZE = 50;
  private readonly FETCH_TIMEOUT = 30000; // 30 seconds

  constructor(
    maxDepth: number = 4,
    maxRequestsPerCrawl: number = 1000,
    onProgress?: (progress: number, description: string) => void
  ) {
    super(maxDepth, maxRequestsPerCrawl, onProgress);
  }

  async *crawl(url: string): AsyncGenerator<CrawlResult, void, unknown> {
    console.debug(`[${this.constructor.name}] Starting crawl from: ${url}`);

    if (this.isAborting) {
      console.debug('[DefaultCrawler] Crawl aborted');
      return;
    }

    const startUrl = new URL(url);
    const baseUrl = this.normalizeUrl(startUrl.toString());

    // Track pages to process
    const pagesToCrawl = new Map<string, number>(); // URL -> depth
    pagesToCrawl.set(baseUrl, 0);

    while (pagesToCrawl.size > 0 && !this.isAborting) {
      // Get batch of URLs to process
      const batchEntries = Array.from(pagesToCrawl.entries()).slice(0, this.BATCH_SIZE);
      const batch = new Map(batchEntries);

      // Remove batch from queue
      batchEntries.forEach(([url]) => pagesToCrawl.delete(url));

      try {
        // Process batch in parallel with timeout and rate limiting
        const results = await Promise.all(
          Array.from(batch.entries()).map(async ([pageUrl]) => {
            // Apply rate limiting
            await this.rateLimit();
            const result = await this.processPageWithRetry(pageUrl);
            return { pageUrl, ...result };
          })
        );

        // Handle results
        for (const { pageUrl, content, links, error } of results) {
          if (error || !content || this.isAborting) continue;

          this.markUrlAsSeen(pageUrl);

          yield {
            url: pageUrl,
            path: this.getPathFromUrl(pageUrl),
            content,
            title: this.extractTitle(content)
          };

          // Add new links to queue if within depth limit
          const currentDepth = batch.get(pageUrl) || 0;
          if (currentDepth < this.maxDepth) {
            for (const link of links) {
              const normalizedLink = this.normalizeUrl(link);
              if (this.shouldCrawl(normalizedLink) && !pagesToCrawl.has(normalizedLink)) {
                pagesToCrawl.set(normalizedLink, currentDepth + 1);
              }
            }
          }

          // Check if we've hit the request limit
          if (this.seenUrls.size >= this.maxRequestsPerCrawl) {
            console.debug('[DefaultCrawler] Max requests reached');
            return;
          }
        }

        // Add delay between batches
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (e) {
        console.error('[DefaultCrawler] Error processing batch:', e);
      }
    }

    console.debug('[DefaultCrawler] Crawl completed');
  }

  private async processPageWithRetry(url: string): Promise<{
    content: string | null;
    links: string[];
    error?: Error;
  }> {
    return this.retryWithBackoff(async () => {
      try {
        // Create fetch request with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const content = await response.text();
        const links = this.extractLinks(content, new URL(url));

        return { content, links };
      } catch (e) {
        if (e instanceof Error) {
          return { content: null, links: [], error: e };
        }
        return { content: null, links: [], error: new Error('Unknown error occurred') };
      }
    });
  }

  private extractLinks(html: string, baseUrl: URL): string[] {
    try {
      const $ = cheerio.load(html);
      const links = new Set<string>();

      // Find all links, including those in navigation elements
      $('a').each((_, element) => {
        const href = $(element).attr('href');
        if (!href) return;

        try {
          const url = new URL(href, baseUrl);
          const normalizedUrl = this.normalizeUrl(url.toString());

          // Use BaseCrawler's URL validation
          if (this.shouldCrawl(normalizedUrl)) {
            links.add(normalizedUrl);
          }
        } catch (e) {
          console.debug(`[DefaultCrawler] Invalid URL ${href}:`, e);
        }
      });

      return Array.from(links);
    } catch (e) {
      console.error('[DefaultCrawler] Error extracting links:', e);
      return [];
    }
  }

  private extractTitle(html: string): string {
    try {
      const $ = cheerio.load(html);
      return $('title').text().trim() || 'Untitled';
    } catch (e) {
      console.error('[DefaultCrawler] Error extracting title:', e);
      return 'Untitled';
    }
  }
}
