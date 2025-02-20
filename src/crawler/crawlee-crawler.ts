import { PlaywrightCrawler, Dataset, RequestQueue } from 'crawlee';
import { CrawlResult } from '../types.js';
import { BaseCrawler } from './base.js';
import { contentExtractors } from './content-extractors.js';
import { generateDocId } from '../util/docs.js';

export class CrawleeCrawler extends BaseCrawler {
  private crawler: PlaywrightCrawler | null = null;
  private requestQueue: RequestQueue | null = null;
  private results: CrawlResult[] = [];
  private websiteId: string = '';
  private static readonly BATCH_SIZE = 20; // Smaller batches for faster processing

  private async processBatch(): Promise<CrawlResult[]> {
    if (this.results.length === 0) return [];

    // Use website-specific dataset
    const dataset = await Dataset.open(this.websiteId);

    // Process results in chunks for better memory management
    const resultsToProcess = [...this.results];
    this.results = [];

    // Push data in smaller chunks
    const chunkSize = 5;
    for (let i = 0; i < resultsToProcess.length; i += chunkSize) {
      const chunk = resultsToProcess.slice(i, i + chunkSize);
      await dataset.pushData(chunk);
    }

    return resultsToProcess;
  }

  async *crawl(url: string): AsyncGenerator<CrawlResult, void, unknown> {
    console.debug(`[${this.constructor.name}] Starting crawl of: ${url}`);

    const self = this;

    // Set up website ID and request queue
    this.websiteId = generateDocId(url, new URL(url).hostname);
    console.debug(`[CrawleeCrawler] Using website ID: ${this.websiteId}`);

    // Create queue with website ID in storage directory
    console.debug(`[CrawleeCrawler] Opening request queue: ${this.websiteId}`);
    this.requestQueue = await RequestQueue.open(this.websiteId);

    // Clear existing queue
    console.debug(`[CrawleeCrawler] Clearing existing queue: ${this.websiteId}`);
    await this.requestQueue.drop();

    // Re-open queue after dropping
    this.requestQueue = await RequestQueue.open(this.websiteId);

    // Add initial request
    console.debug(`[CrawleeCrawler] Adding initial request: ${url}`);
    await this.requestQueue.addRequest({
      url,
      uniqueKey: new URL(url).pathname + new URL(url).search,
    });

    // Clear existing dataset
    console.debug(`[CrawleeCrawler] Opening dataset: ${this.websiteId}`);
    const dataset = await Dataset.open(this.websiteId);
    console.debug(`[CrawleeCrawler] Clearing existing dataset: ${this.websiteId}`);
    await dataset.drop();

    // Initialize crawler with the request queue
    this.crawler = new PlaywrightCrawler({
      maxRequestsPerCrawl: this.maxRequestsPerCrawl,
      requestQueue: this.requestQueue!,
      // Aggressive parallel processing
      maxConcurrency: 20, // Maximum parallel processing
      maxRequestsPerMinute: 600, // Very high rate limit
      maxRequestRetries: 0, // No retries for fastest processing
      navigationTimeoutSecs: 10, // Very short timeout
      // Optimize browser pool
      browserPoolOptions: {
        maxOpenPagesPerBrowser: 5, // More pages per browser
        useFingerprints: false, // Disable fingerprinting
        operationTimeoutSecs: 15, // Short operation timeout
        closeInactiveBrowserAfterSecs: 10 // Quick cleanup
      },
      preNavigationHooks: [
        async ({ page }) => {
          // Set viewport
          await page.setViewportSize({ width: 1920, height: 1080 });

          // Add custom headers to look more like a real browser
          await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          });
        },
      ],
      async requestHandler({ request, page, enqueueLinks, log }) {
        if (self.isAborting) {
          log.debug('Crawl aborted');
          return;
        }

        try {
          // Wait for initial page load
          log.debug('Waiting for page load...');
          await Promise.all([
            page.waitForLoadState('domcontentloaded'),
            page.waitForLoadState('networkidle', { timeout: 5000 }) // Reduced network idle timeout
              .catch(() => log.debug('Network idle timeout - continuing anyway'))
          ]);

          // Determine site type first
          let siteType = 'default';
          let frame = null;

          // Check for Storybook and wait for it to be ready
          const isStorybook = await page.evaluate(() => {
            return new Promise(resolve => {
              // Check for Storybook API
              if (typeof (window as any).__STORYBOOK_CLIENT_API__ !== 'undefined') {
                // Wait for story store to be ready
                const checkReady = () => {
                  const api = (window as any).__STORYBOOK_CLIENT_API__;
                  if (api?.storyStore?.ready) {
                    resolve(true);
                  } else {
                    setTimeout(checkReady, 100);
                  }
                };
                checkReady();
                return;
              }

              // Check for Storybook elements
              if (document.querySelector('#storybook-root, .sbdocs, [data-nodetype="root"]') !== null ||
                  document.querySelector('meta[name="storybook-version"]') !== null ||
                  document.baseURI?.includes('path=/docs/') ||
                  document.baseURI?.includes('path=/story/')) {
                resolve(true);
                return;
              }

              resolve(false);
            });
          });

          if (isStorybook) {
            log.debug('Detected Storybook page');
            siteType = 'storybook';

            // Wait for Storybook content to be ready
            await Promise.all([
              page.waitForLoadState('networkidle', { timeout: 5000 })
                .catch(() => log.debug('Network idle timeout - continuing anyway')),
              page.waitForSelector('.sbdocs-content, #docs-root, .docs-story, [class*="story-"]', {
                timeout: 5000
              }).catch(() => log.debug('No Storybook content found in main page'))
            ]);

            // Try to find the content iframe
            const frames = await page.frames();
            const contentFrames = await Promise.all(frames.map(async f => {
              try {
                const hasContent = await f.evaluate(() => {
                  return document.querySelector('.sbdocs-content, #docs-root, .docs-story, [class*="story-"]') !== null;
                }).catch(() => false);

                if (hasContent) {
                  await Promise.all([
                    f.waitForLoadState('domcontentloaded'),
                    f.waitForLoadState('networkidle', { timeout: 5000 })
                      .catch(() => log.debug('Frame network idle timeout - continuing anyway'))
                  ]);
                  return f;
                }
              } catch (error) {
                log.debug('Error checking frame', { error: String(error) });
              }
              return null;
            }));

            // Use the first frame that has content
            frame = contentFrames.find(f => f !== null) || null;
            if (frame) {
              log.debug('Found Storybook content in iframe');
              // Wait longer for dynamic content
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          } else {
            // Check for GitHub Pages
            const isGitHubPages = await page.evaluate(() => {
              return window.location.hostname.includes('github.io') &&
                     document.querySelector('.markdown-body, .site-footer, .page-header') !== null;
            });

            if (isGitHubPages) {
              log.debug('Detected GitHub Pages site');
              siteType = 'github';
            }
          }

          // Expand all sections in the sidebar
          await page.evaluate(() => {
            // Get all collapsed buttons
            const buttons = document.querySelectorAll('button[aria-expanded="false"]');
            if (buttons.length > 0) {
              // Click all at once
              buttons.forEach(button => (button as HTMLButtonElement).click());
              // Force immediate expansion by setting aria-expanded
              buttons.forEach(button => button.setAttribute('aria-expanded', 'true'));
            }
          });

          // Log current queue status
          const queueInfo = await this.requestQueue!.getInfo();
          if (queueInfo) {
            log.info('Queue status:', {
              pendingCount: queueInfo.pendingRequestCount || 0,
              handledCount: queueInfo.handledRequestCount || 0,
              totalCount: queueInfo.totalRequestCount || 0
            });
          }

          // Enqueue links with logging
          const enqueueResult = await enqueueLinks({
            strategy: 'same-domain',
            transformRequestFunction(req) {
              return {
                ...req,
                uniqueKey: new URL(req.url).pathname + new URL(req.url).search
              };
            }
          });

          // Log enqueued links
          log.info('Enqueued links:', {
            processedCount: enqueueResult.processedRequests.length,
            urls: enqueueResult.processedRequests.map(r => r.uniqueKey)
          });

          const title = await page.title();

          // Extract content using appropriate extractor
          let content = '';
          let extractorUsed = '';

          try {
            // Select appropriate extractor based on site type
            const extractor = siteType === 'storybook' ? contentExtractors[0] :
                            siteType === 'github' ? contentExtractors[1] :
                            contentExtractors[2];
            extractorUsed = extractor.constructor.name;
            log.debug(`Using ${extractorUsed} for content extraction`);

            // For Storybook, extract content with proper handling
            if (siteType === 'storybook') {
              log.debug('Extracting Storybook content');

              // Get the StorybookExtractor code
              const extractorCode = contentExtractors[0].constructor.toString();

              // Try to get content from the frame first
              if (frame) {
                log.debug('Extracting content from Storybook iframe');
                content = await frame.evaluate(async (extractorCode) => {
                  const ExtractorClass = new Function(`return ${extractorCode}`)();
                  const extractor = new ExtractorClass();
                  const result = await extractor.extractContent(document);
                  return result.content;
                }, extractorCode);
              }

              // If no content from frame, try main page
              if (!content) {
                log.debug('Extracting content from main page');
                content = await page.evaluate(async (extractorCode) => {
                  const ExtractorClass = new Function(`return ${extractorCode}`)();
                  const extractor = new ExtractorClass();
                  const result = await extractor.extractContent(document);
                  return result.content;
                }, extractorCode);
              }
            } else {
              // For non-Storybook, use the appropriate extractor
              content = await page.evaluate(
                async ({ extractorStr }) => {
                  try {
                    const ExtractorClass = new Function(`return ${extractorStr}`)();
                    const extractor = new ExtractorClass();
                    const extracted = await extractor.extractContent(document);
                    return extracted.content;
                  } catch (error) {
                    console.error('Error in main extractContent:', error);
                    return '';
                  }
                },
                { extractorStr: extractor.constructor.toString() }
              );
            }

            // No fallback to default extraction - if the extractor failed, log it and continue
            if (!content) {
              log.debug('No content extracted from extractor');
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error('Error during content extraction', { error: errorMessage });
            content = await page.evaluate<string>(() => document.body.textContent || '');
            extractorUsed = 'ErrorFallback';
          }

          // Clean up the content while preserving structure
          const cleanContent = (text: string) => {
            return text
              .replace(/\\n/g, '\n') // Convert escaped newlines
              .replace(/\r\n/g, '\n') // Normalize line endings
              .replace(/\t/g, '  ') // Convert tabs to spaces
              .replace(/[^\S\n]+/g, ' ') // Replace multiple spaces with single space (except newlines)
              .split('\n')
              .map(line => line.trim())
              .join('\n')
              .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
              .trim();
          };

          const result: CrawlResult = {
            url: request.url,
            path: new URL(request.url).pathname + new URL(request.url).search,
            content: cleanContent(content),
            title,
            extractorUsed
          };

          self.results.push(result);
          self.markUrlProcessed(request.url);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error(`Error processing ${request.url}: ${errorMessage}`);

          if (errorMessage.includes('timeout')) {
            log.debug('Timeout error - will be retried automatically');
          }
        }
      }
    });

    try {
      // Start the crawl from the base URL
      console.debug('Starting crawler...');

      // Start crawler and process results in parallel
      const crawlerPromise = this.crawler.run();

      while (!this.isAborting) {
        // Process batch if we've reached the batch size
        if (this.results.length >= CrawleeCrawler.BATCH_SIZE) {
          const processed = await this.processBatch();
          for (const result of processed) {
            yield result;
          }
        }

        // Check if crawler is done
        const isDone = await Promise.race([
          crawlerPromise.then(() => true),
          new Promise(resolve => setTimeout(() => resolve(false), 100))
        ]);

        if (isDone) break;
      }

      // Wait for crawler to finish
      await crawlerPromise;
      console.debug('Crawler finished');

      // Process any remaining results
      const remainingResults = await this.processBatch();
      for (const result of remainingResults) {
        yield result;
      }
    } catch (error) {
      console.error('Crawler error:', error);
      throw error;
    } finally {
      // Cleanup
      this.results = [];
      this.crawler = null;
      if (this.requestQueue) {
        await this.requestQueue.drop().catch(console.error);
        this.requestQueue = null;
      }
    }
  }

  abort(): void {
    super.abort();
    if (this.crawler) {
      this.crawler.teardown().catch(console.error);
    }
  }
}