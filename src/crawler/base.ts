import { URL } from 'url';
import { IGNORED_PATHS, RATE_LIMIT } from '../config.js';
import { CrawlResult } from '../types.js';
import { logger } from '../util/logger.js';

export abstract class BaseCrawler {
  protected seenUrls: Set<string>;
  protected isAborting: boolean;
  private requestCount: number;
  private lastRequestTime: number;
  protected totalUrls: number;
  protected processedUrls: number;
  protected onProgress?: (progress: number, description: string) => void;

  constructor(
    protected readonly maxDepth: number = 4,
    protected readonly maxRequestsPerCrawl: number = 1000,
    onProgress?: (progress: number, description: string) => void
  ) {
    this.seenUrls = new Set();
    this.isAborting = false;
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.totalUrls = 1; // Start with 1 for the initial URL
    this.processedUrls = 0;
    this.onProgress = onProgress;
  }

  protected updateProgress(description: string): void {
    if (this.onProgress) {
      // Calculate progress as percentage (0-100)
      const progress = Math.min(Math.round((this.processedUrls / this.totalUrls) * 100), 100);
      this.onProgress(progress, description);
    }
  }

  protected addDiscoveredUrls(count: number): void {
    this.totalUrls += count;
    this.updateProgress('Discovering pages...');
  }

  protected markUrlProcessed(url: string): void {
    this.processedUrls++;
    this.markUrlAsSeen(url);
    this.updateProgress(`Processing page ${this.processedUrls} of ${this.totalUrls}`);
  }

  abstract crawl(url: string, maxDepth?: number): AsyncGenerator<CrawlResult, void, unknown>;

  protected shouldCrawl(urlString: string): boolean {
    try {
      const url = new URL(urlString);

      // Skip if already seen (using full URL including query params)
      if (this.seenUrls.has(urlString)) {
        logger.debug(`[${this.constructor.name}] Skipping already seen URL: ${urlString}`);
        return false;
      }

      // Skip fragments only
      if (url.hash) {
        logger.debug(`[${this.constructor.name}] Skipping URL with hash: ${urlString}`);
        return false;
      }

      // Skip non-HTML files only if they have a file extension
      const ext = url.pathname.split('.').pop()?.toLowerCase();
      if (ext && ext !== 'html' && ext !== 'htm') {
        logger.debug(`[${this.constructor.name}] Skipping non-HTML file: ${urlString}`);
        return false;
      }

      // Skip ignored paths only if they match exactly
      const path = url.pathname.toLowerCase();
      const isIgnored = IGNORED_PATHS.some((ignored) => {
        // If ignored path ends with /, treat it as a directory
        if (ignored.endsWith('/')) {
          return path.startsWith(ignored);
        }
        // Otherwise match exactly
        return path === `/${ignored}`;
      });

      if (isIgnored) {
        logger.debug(`[${this.constructor.name}] Skipping ignored path: ${urlString}`);
        return false;
      }

      return true;
    } catch (error) {
      logger.debug(`[${this.constructor.name}] Error checking URL: ${urlString}`, error);
      return false;
    }
  }

  protected markUrlAsSeen(url: string): void {
    this.seenUrls.add(url);
  }

  protected getPathFromUrl(urlString: string): string {
    try {
      const url = new URL(urlString);
      return url.pathname + url.search; // Include query params in path
    } catch {
      return urlString;
    }
  }

  protected normalizeUrl(urlString: string): string {
    try {
      const url = new URL(urlString);
      // Remove hash fragment but keep query params
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch {
      return urlString;
    }
  }

  protected async rateLimit(): Promise<void> {
    const now = Date.now();
    this.requestCount++;

    // Reset counter if time window has passed
    if (now - this.lastRequestTime > RATE_LIMIT.timeWindow) {
      this.requestCount = 1;
      this.lastRequestTime = now;
      return;
    }

    // If we've hit the rate limit, wait until the next window
    if (this.requestCount > RATE_LIMIT.maxRequests) {
      const waitTime = RATE_LIMIT.timeWindow - (now - this.lastRequestTime);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.requestCount = 1;
      this.lastRequestTime = Date.now();
      return;
    }

    // Ensure minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT.minDelay) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT.minDelay - timeSinceLastRequest));
    }

    this.lastRequestTime = Date.now();
  }

  protected async retryWithBackoff<T>(operation: () => Promise<T>, maxRetries: number = 3, baseDelay: number = 1000): Promise<T> {
    let lastError: Error | undefined;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        if (i === maxRetries - 1) break;

        // Exponential backoff
        const delay = baseDelay * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  abort(): void {
    this.isAborting = true;
  }
}
