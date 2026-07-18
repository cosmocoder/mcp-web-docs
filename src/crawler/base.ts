import { setTimeout as delay } from 'node:timers/promises';
import { RATE_LIMIT } from '../config.js';
import { CrawlResult } from '../types.js';

export abstract class BaseCrawler {
  protected isAborting = false;
  private readonly abortController = new AbortController();
  protected readonly abortSignal = this.abortController.signal;
  private requestCount = 0;
  private lastRequestTime = 0;

  abstract crawl(url: string): AsyncGenerator<CrawlResult, void, unknown>;

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
      await delay(waitTime, undefined, { signal: this.abortSignal });
      this.requestCount = 1;
      this.lastRequestTime = Date.now();
      return;
    }

    // Ensure minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT.minDelay) {
      await delay(RATE_LIMIT.minDelay - timeSinceLastRequest, undefined, { signal: this.abortSignal });
    }

    this.lastRequestTime = Date.now();
  }

  abort(): void {
    this.isAborting = true;
    this.abortController.abort();
  }
}
