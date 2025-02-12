import { URL } from 'url';
import { BaseCrawler } from './base.js';
import { DefaultCrawler } from './default.js';
import { ChromiumCrawler } from './chromium.js';
import { CheerioCrawler } from './cheerio.js';

export class CrawlerFactory {
  // Common JavaScript framework identifiers
  private static readonly JS_FRAMEWORK_INDICATORS = [
    'react',
    'vue',
    'angular',
    'next',
    'nuxt',
    'gatsby',
    'docusaurus',
    'vuepress',
    'gridsome',
    'svelte'
  ];

  private static async detectSiteType(url: string): Promise<{
    isJsHeavy: boolean;
    hasFramework: boolean;
  }> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const html = await response.text();

      // Check for JavaScript frameworks
      const hasFramework = CrawlerFactory.JS_FRAMEWORK_INDICATORS.some(framework =>
        html.toLowerCase().includes(framework)
      );

      // Check for JavaScript-heavy indicators
      const isJsHeavy = (
        html.includes('data-react') ||
        html.includes('ng-') ||
        html.includes('v-') ||
        html.includes('__NEXT_DATA__') ||
        html.includes('nuxt') ||
        html.includes('id="___gatsby"')
      );

      return { isJsHeavy, hasFramework };
    } catch (e) {
      console.error('[CrawlerFactory] Error detecting site type:', e);
      return { isJsHeavy: false, hasFramework: false };
    }
  }

  static async createCrawler(
    url: string,
    maxRequestsPerCrawl: number = 1000,
    maxDepth: number = 4,
    onProgress?: (progress: number, description: string) => void
  ): Promise<BaseCrawler> {
    const startUrl = new URL(url);
    console.debug(`[CrawlerFactory] Creating crawler for ${startUrl}`);

    // Check if site is JavaScript-heavy first
    const { isJsHeavy, hasFramework } = await CrawlerFactory.detectSiteType(url);

    // Try Chromium for JavaScript-heavy sites
    if (isJsHeavy || hasFramework) {
      console.debug(`[CrawlerFactory] Site appears to be JavaScript-heavy, using Chromium crawler`);
      return new ChromiumCrawler(maxDepth, maxRequestsPerCrawl, onProgress);
    }

    // Try default crawler
    try {
      console.debug(`[CrawlerFactory] Attempting default crawler for ${url}`);
      const defaultCrawler = new DefaultCrawler(maxDepth, maxRequestsPerCrawl, onProgress);
      const generator = defaultCrawler.crawl(url);
      const { value: firstPage, done } = await generator.next();

      if (!done && firstPage?.content) {
        console.debug('[CrawlerFactory] Successfully created default crawler');
        return defaultCrawler;
      }
    } catch (e) {
      console.debug('[CrawlerFactory] Default crawler failed:', e);
    }

    // Fall back to Cheerio crawler
    console.debug(`[CrawlerFactory] Attempting Cheerio crawler for ${url}`);
    const cheerioCrawler = new CheerioCrawler(maxDepth, maxRequestsPerCrawl, onProgress);
    const generator = cheerioCrawler.crawl(url);
    const { value: firstPage, done } = await generator.next();

    if (!done && firstPage?.content) {
      console.debug('[CrawlerFactory] Successfully created Cheerio crawler');
      return cheerioCrawler;
    }

    console.error(`[CrawlerFactory] All crawlers failed for ${url}`);
    throw new Error(`Failed to create crawler for ${url}`);
  }
}
