import { PlaywrightCrawler } from 'crawlee';
import { CrawlResult } from '../types.js';
import { BaseCrawler } from './base.js';
import { Page, Frame } from 'playwright';
import { siteRules } from './site-rules.js';
import { QueueManager } from './queue-manager.js';
import { getBrowserConfig } from './browser-config.js';
import { cleanContent } from './content-utils.js';

export class CrawleeCrawler extends BaseCrawler {
  private crawler: PlaywrightCrawler | null = null;
  private queueManager: QueueManager = new QueueManager();

  private async findContentFrame(page: Page): Promise<Frame | null> {
    const frames = await page.frames();
    const contentFrames = await Promise.all(frames.map(async (frame) => {
      try {
        const hasContent = await frame.evaluate(() => {
          return document.querySelector('.sbdocs-content, #docs-root, .docs-story, [class*="story-"]') !== null;
        }).catch(() => false);

        if (hasContent) {
          await Promise.all([
            frame.waitForLoadState('domcontentloaded'),
            frame.waitForLoadState('networkidle', { timeout: 5000 })
              .catch(() => console.debug('Frame network idle timeout - continuing anyway'))
          ]);
          return frame;
        }
      } catch (error) {
        console.debug('Error checking frame', { error: String(error) });
      }
      return null;
    }));

    const frame = contentFrames.find(f => f !== null) || null;
    if (frame) {
      console.debug('Found content in iframe');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return frame;
  }

  private async evaluateExtractor(context: Page | Frame, extractor: any): Promise<string> {
    const extractorCode = extractor.constructor.toString();
    return context.evaluate(async (code: string) => {
      const ExtractorClass = new Function(`return ${code}`)();
      const extractor = new ExtractorClass();
      const result = await extractor.extractContent(document);
      return result.content;
    }, extractorCode);
  }

  private async extractContent(page: Page, siteType: string, extractor: any): Promise<{ content: string; extractorUsed: string }> {
    let content = '';
    let extractorUsed = extractor.constructor.name;

    try {
      if (siteType === 'storybook') {
        // Try iframe first
        const frame = await this.findContentFrame(page);
        if (frame) {
          content = await this.evaluateExtractor(frame, extractor);
        }

        // Fallback to main page
        if (!content) {
          content = await this.evaluateExtractor(page, extractor);
        }
      } else {
        content = await this.evaluateExtractor(page, extractor);
      }
    } catch (error) {
      content = await page.evaluate<string>(() => document.body.textContent || '');
      extractorUsed = 'ErrorFallback';
    }

    return { content, extractorUsed };
  }

  async *crawl(url: string): AsyncGenerator<CrawlResult, void, unknown> {
    console.debug(`[${this.constructor.name}] Starting crawl of: ${url}`);
    await this.queueManager.initialize(url);

    this.crawler = new PlaywrightCrawler({
      ...getBrowserConfig(this.queueManager.getRequestQueue()),
      requestHandler: async ({ request, page, enqueueLinks, log }) => {
        if (this.isAborting) {
          log.debug('Crawl aborted');
          return;
        }

        try {
          // Wait for initial page load
          await Promise.all([
            page.waitForLoadState('domcontentloaded'),
            page.waitForLoadState('networkidle', { timeout: 5000 })
              .catch(() => log.debug('Network idle timeout - continuing anyway'))
          ]);

          // Detect site type and get extractor
          for (const rule of siteRules) {
            if (await rule.detect(page)) {
              if (rule.prepare) {
                await rule.prepare(page, log);
              }

              await this.queueManager.handleQueueAndLinks(enqueueLinks, log);

              const title = await page.title();
              const { content, extractorUsed } = await this.extractContent(page, rule.type, rule.extractor);

              const result: CrawlResult = {
                url: request.url,
                path: new URL(request.url).pathname + new URL(request.url).search,
                content: cleanContent(content),
                title,
                extractorUsed
              };

              this.queueManager.addResult(result);
              this.markUrlProcessed(request.url);
              break;
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error(`Error processing ${request.url}: ${errorMessage}`);
        }
      }
    });

    try {
      const crawlerPromise = this.crawler.run();

      while (!this.isAborting) {
        if (this.queueManager.hasEnoughResults()) {
          for (const result of await this.queueManager.processBatch()) {
            yield result;
          }
        }

        if (await Promise.race([
          crawlerPromise.then(() => true),
          new Promise(resolve => setTimeout(() => resolve(false), 100))
        ])) break;
      }

      await crawlerPromise;
      console.debug('Crawler finished');

      for (const result of await this.queueManager.processBatch()) {
        yield result;
      }
    } catch (error) {
      console.error('Crawler error:', error);
      throw error;
    } finally {
      await this.queueManager.cleanup();
      this.crawler = null;
    }
  }

  abort(): void {
    super.abort();
    if (this.crawler) {
      this.crawler.teardown().catch(console.error);
    }
  }
}
