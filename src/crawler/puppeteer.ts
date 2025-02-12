import puppeteer, { Browser, Page, ConsoleMessage } from 'puppeteer';
import { CrawlResult } from '../types.js';
import { BaseCrawler } from './base.js';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export class PuppeteerCrawler extends BaseCrawler {
  private browser?: Browser;
  private readonly userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
  private readonly LINK_GROUP_SIZE = 2;
  private curCrawlCount = 0;

  async *crawl(url: string): AsyncGenerator<CrawlResult, void, unknown> {
    try {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--window-size=1280,800'
        ]
      });

      const page = await this.browser.newPage();
      await this.setupPage(page);

      const visitedUrls = new Set<string>();
      yield* this.crawlSitePages(page, new URL(url), 0, visitedUrls);
    } finally {
      await this.browser?.close();
    }
  }

  private async setupPage(page: Page): Promise<void> {
    await page.setUserAgent(this.userAgent);
    await page.setViewport({ width: 1280, height: 800 });

    // Block only unnecessary resources
    await page.setRequestInterception(true);
    page.on('request', request => {
      const resourceType = request.resourceType();
      if (['image', 'media', 'font'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Handle JavaScript errors
    page.on('pageerror', error => {
      console.warn('Page error:', error);
    });

    // Handle console messages
    page.on('console', (msg: ConsoleMessage) => {
      const type = msg.type();
      if (type === 'error' || type === 'warn') {
        console.debug(`Console ${type}:`, msg.text());
      }
    });
  }

  private async *crawlSitePages(
    page: Page,
    curUrl: URL,
    depth: number,
    visitedUrls: Set<string>
  ): AsyncGenerator<CrawlResult, void, unknown> {
    const urlStr = curUrl.toString();

    if (visitedUrls.has(urlStr) || !this.shouldCrawl(urlStr) || depth > this.maxDepth) {
      return;
    }

    try {
      // Rate limiting
      await this.rateLimit();

      // Navigate to page with proper redirect handling
      await this.gotoPageAndHandleRedirects(page, urlStr);

      // Extract content
      const { content, title, links } = await this.processPage(page, curUrl);

      visitedUrls.add(urlStr);
      this.markUrlAsSeen(urlStr);
      this.curCrawlCount++;

      yield {
        url: urlStr,
        path: this.getPathFromUrl(urlStr),
        content,
        title
      };

      // Process links in batches
      if (depth < this.maxDepth && this.curCrawlCount < this.maxRequestsPerCrawl) {
        const linkGroups = this.groupLinks(links);
        for (const linkGroup of linkGroups) {
          for (const link of linkGroup) {
            if (this.curCrawlCount >= this.maxRequestsPerCrawl) {
              return;
            }
            yield* this.crawlSitePages(page, new URL(link), depth + 1, visitedUrls);
          }
        }
      }
    } catch (error) {
      console.error(`Error crawling ${urlStr}:`, error);
    }
  }

  private async gotoPageAndHandleRedirects(page: Page, url: string) {
    const MAX_PAGE_WAIT_MS = 5000;

    await page.goto(url, {
      timeout: 0,
      waitUntil: 'networkidle2'
    });

    let responseEventOccurred = false;
    const responseHandler = () => responseEventOccurred = true;

    const responseWatcher = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!responseEventOccurred) {
          resolve();
        } else {
          setTimeout(() => resolve(), MAX_PAGE_WAIT_MS);
        }
      }, 500);
    });

    page.on('response', responseHandler);
    await Promise.race([responseWatcher, page.waitForNavigation()]);
    page.off('response', responseHandler);
  }

  private async processPage(page: Page, url: URL): Promise<{ content: string; title: string; links: string[] }> {
    // Wait for dynamic content
    try {
      await page.waitForFunction(() => {
        const mainContent = document.querySelector('main') || document.querySelector('.content') || document.querySelector('#content');
        return mainContent && mainContent.children.length > 0;
      }, { timeout: 5000 });
    } catch (error) {
      console.warn('Timeout waiting for main content, proceeding anyway');
    }

    // Extract content using Readability
    const html = await page.content();
    const dom = new JSDOM(html, { url: url.toString() });
    const reader = new Readability(dom.window.document, {
      charThreshold: 20,
      nbTopCandidates: 5,
      maxElemsToParse: 10000
    });
    const article = reader.parse();

    if (!article) {
      throw new Error('Failed to parse page content');
    }

    // Extract links
    const links = await this.getLinksFromPage(page, url);

    return {
      content: article.textContent,
      title: article.title,
      links
    };
  }

  private async getLinksFromPage(page: Page, curUrl: URL): Promise<string[]> {
    const links = await page.$$eval('a', (links) => links.map((a) => a.href));

    const cleanedLinks = links
      .map(link => {
        try {
          const url = new URL(link);
          url.hash = ''; // Remove hash
          return url.href;
        } catch {
          return null;
        }
      })
      .filter((link): link is string => {
        if (!link) return false;
        try {
          const url = new URL(link);
          return (
            url.pathname.startsWith(curUrl.pathname) &&
            url.hostname === curUrl.hostname &&
            link !== curUrl.href
          );
        } catch {
          return false;
        }
      });

    return Array.from(new Set(cleanedLinks));
  }

  private groupLinks(links: string[]): string[][] {
    return links.reduce((acc, link, i) => {
      const groupIndex = Math.floor(i / this.LINK_GROUP_SIZE);
      if (!acc[groupIndex]) {
        acc.push([]);
      }
      acc[groupIndex].push(link);
      return acc;
    }, [] as string[][]);
  }

  abort(): void {
    super.abort();
    void this.browser?.close();
  }
}