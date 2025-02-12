import { URL } from 'url';
import { CrawlResult, DocsCrawlerType, WebCrawler } from '../types.js';
import { loadConfig } from '../config.js';
import { DefaultCrawler } from './default.js';
import { CrawleeCrawler } from './crawlee-crawler.js';
import { CheerioCrawler } from './cheerio.js';
import { GitHubCrawler } from './github.js';

export class DocsCrawler implements WebCrawler {
  private readonly GITHUB_HOST = 'github.com';
  private readonly MIN_PAGES = 2; // Require at least 2 pages for component libraries
  private isAborting = false;

  constructor(
    private readonly maxDepth: number = 4,
    private readonly maxRequestsPerCrawl: number = 1000,
    private readonly githubToken?: string,
    private readonly onProgress?: (progress: number, description: string) => void
  ) {}

  async *crawl(url: string): AsyncGenerator<CrawlResult, DocsCrawlerType> {
    const startUrl = new URL(url);
    console.debug(`[DocsCrawler] Starting crawl of ${startUrl}`);

    if (this.isAborting) {
      console.debug('[DocsCrawler] Crawl aborted');
      return 'default';
    }

    // Handle GitHub repositories
    if (startUrl.host === this.GITHUB_HOST) {
      console.debug('[DocsCrawler] Detected GitHub repository');
      const githubCrawler = new GitHubCrawler(
        this.maxDepth,
        this.maxRequestsPerCrawl,
        this.githubToken,
        this.onProgress
      );

      try {
        for await (const page of githubCrawler.crawl(url)) {
          if (this.isAborting) break;
          yield page;
        }
        return 'github';
      } catch (e) {
        console.error('[DocsCrawler] GitHub crawler failed:', e);
        // Don't fall through to other crawlers for GitHub URLs
        throw e;
      }
    }

    // Try Crawlee for JavaScript-heavy sites
    try {
      // Skip Crawlee if experimental flag is disabled
      const config = await loadConfig();
      if (!config.experimental?.useChromiumForDocsCrawling) {
        throw new Error('Crawlee crawler is disabled by configuration');
      }

      console.debug('[DocsCrawler] Attempting Crawlee crawler');
      const crawleeCrawler = new CrawleeCrawler(this.maxDepth, this.maxRequestsPerCrawl, this.onProgress);
      let pageCount = 0;

      for await (const page of crawleeCrawler.crawl(url)) {
        if (this.isAborting) break;
        pageCount++;
        yield page;
      }

      if (pageCount >= this.MIN_PAGES) {
        console.debug(`[DocsCrawler] Crawlee crawler successful (${pageCount} pages)`);
        return 'chromium'; // Keep returning 'chromium' for backward compatibility
      }
      console.debug(`[DocsCrawler] Crawlee crawler found insufficient pages (${pageCount})`);
      throw new Error(`Crawlee crawler found only ${pageCount} pages, need at least ${this.MIN_PAGES}`);
    } catch (e) {
      console.debug('[DocsCrawler] Chromium crawler failed:', e);
      throw e; // Re-throw to prevent falling back to other crawlers for JS-heavy sites
    }

    // Try default crawler
    try {
      console.debug('[DocsCrawler] Attempting default crawler');
      const defaultCrawler = new DefaultCrawler(this.maxDepth, this.maxRequestsPerCrawl, this.onProgress);
      let pageCount = 0;

      for await (const page of defaultCrawler.crawl(url)) {
        if (this.isAborting) break;
        pageCount++;
        yield page;
      }

      if (pageCount >= this.MIN_PAGES) {
        console.debug(`[DocsCrawler] Default crawler successful (${pageCount} pages)`);
        return 'default';
      } else {
        console.debug(`[DocsCrawler] Default crawler found insufficient pages (${pageCount})`);
      }
    } catch (e) {
      console.debug('[DocsCrawler] Default crawler failed:', e);
    }

    // Fall back to Cheerio crawler
    console.debug('[DocsCrawler] Attempting Cheerio crawler');
    const cheerioCrawler = new CheerioCrawler(this.maxDepth, this.maxRequestsPerCrawl, this.onProgress);
    let pageCount = 0;

    for await (const page of cheerioCrawler.crawl(url)) {
      if (this.isAborting) break;
      pageCount++;
      yield page;
    }

    if (pageCount >= this.MIN_PAGES) {
      console.debug(`[DocsCrawler] Cheerio crawler successful (${pageCount} pages)`);
      return 'cheerio';
    }

    console.error('[DocsCrawler] All crawlers failed to find sufficient pages');
    throw new Error(`Failed to crawl ${url} with any available crawler (insufficient pages)`);
  }

  abort(): void {
    this.isAborting = true;
  }
}
