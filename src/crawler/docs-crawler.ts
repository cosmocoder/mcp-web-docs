import { URL } from 'url';
import { CrawlResult, DocsCrawlerType, WebCrawler } from '../types.js';
import { CrawleeCrawler, StorageState } from './crawlee-crawler.js';
import { GitHubCrawler } from './github.js';
import { logger } from '../util/logger.js';

export class DocsCrawler implements WebCrawler {
  private readonly GITHUB_HOST = 'github.com';
  private readonly MIN_PAGES = 2; // Require at least 2 pages for component libraries
  private isAborting = false;
  private storageState?: StorageState;

  constructor(
    private readonly maxDepth: number = 4,
    private readonly maxRequestsPerCrawl: number = 1000,
    private readonly githubToken?: string,
    private readonly onProgress?: (progress: number, description: string) => void
  ) {}

  /**
   * Set authentication storage state (cookies) to use when crawling
   */
  setStorageState(state: StorageState): void {
    this.storageState = state;
    logger.info(`[DocsCrawler] Set storage state with ${state.cookies?.length || 0} cookies`);
  }

  async *crawl(url: string): AsyncGenerator<CrawlResult, DocsCrawlerType> {
    const startUrl = new URL(url);
    logger.debug(`[DocsCrawler] Starting crawl of ${startUrl}`);

    if (this.isAborting) {
      logger.debug('[DocsCrawler] Crawl aborted');
      return 'crawlee';
    }

    // Handle GitHub repositories
    if (startUrl.host === this.GITHUB_HOST) {
      logger.debug('[DocsCrawler] Detected GitHub repository');
      const githubCrawler = new GitHubCrawler(this.maxDepth, this.maxRequestsPerCrawl, this.githubToken, this.onProgress);

      try {
        for await (const page of githubCrawler.crawl(url)) {
          if (this.isAborting) break;
          yield page;
        }
        return 'github';
      } catch (e) {
        logger.debug('[DocsCrawler] GitHub crawler failed:', e);
        // Don't fall through to other crawlers for GitHub URLs
        throw e;
      }
    }

    // Use Crawlee for all other sites
    logger.debug('[DocsCrawler] Using Crawlee crawler');
    const crawleeCrawler = new CrawleeCrawler(this.maxDepth, this.maxRequestsPerCrawl, this.onProgress);

    // Pass authentication if available
    if (this.storageState) {
      crawleeCrawler.setStorageState(this.storageState);
    }

    let pageCount = 0;

    try {
      for await (const page of crawleeCrawler.crawl(url)) {
        if (this.isAborting) break;
        pageCount++;
        yield page;
      }

      if (pageCount >= this.MIN_PAGES) {
        logger.debug(`[DocsCrawler] Crawlee crawler successful (${pageCount} pages)`);
        return 'crawlee';
      }
      logger.debug(`[DocsCrawler] Crawlee crawler found insufficient pages (${pageCount})`);
      throw new Error(`Crawlee crawler found only ${pageCount} pages, need at least ${this.MIN_PAGES}`);
    } catch (e) {
      logger.debug('[DocsCrawler] Crawlee crawler failed:', e);
      throw e;
    }
  }

  abort(): void {
    this.isAborting = true;
  }
}
