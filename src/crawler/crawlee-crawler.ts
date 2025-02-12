import { PlaywrightCrawler, Dataset, RequestQueue } from 'crawlee';
import { CrawlResult } from '../types.js';
import { BaseCrawler } from './base.js';
import { contentExtractors } from './content-extractors.js';

export class CrawleeCrawler extends BaseCrawler {
  private crawler: PlaywrightCrawler | null = null;
  private results: CrawlResult[] = [];
  private static readonly BATCH_SIZE = 50;

  private async processBatch(): Promise<CrawlResult[]> {
    if (this.results.length === 0) return [];

    const dataset = await Dataset.open();
    await dataset.pushData(this.results);
    const resultsToReturn = [...this.results];
    this.results = [];
    return resultsToReturn;
  }

  async *crawl(url: string): AsyncGenerator<CrawlResult, void, unknown> {
    console.debug(`[${this.constructor.name}] Starting crawl of: ${url}`);

    // Create a request queue with deduplication
    const requestQueue = await RequestQueue.open();
    await requestQueue.addRequest({
      url,
      uniqueKey: new URL(url).pathname + new URL(url).search,
    });

    const self = this;
    this.crawler = new PlaywrightCrawler({
      maxRequestsPerCrawl: this.maxRequestsPerCrawl,
      requestQueue,
      // Add rate limiting
      maxRequestsPerMinute: 60,
      // Add automatic retries for failed requests
      maxRequestRetries: 3,
      // Increase default timeout
      navigationTimeoutSecs: 30,
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
            page.waitForLoadState('networkidle', { timeout: 10000 })
              .catch(() => log.debug('Network idle timeout - continuing anyway'))
          ]);

          // Check for Storybook and wait for it to be ready
          const isStorybook = await page.evaluate(() => {
            if (typeof (window as any).__STORYBOOK_CLIENT_API__ !== 'undefined') {
              // Wait for both the story store and router to be ready
              return new Promise(resolve => {
                const checkReady = () => {
                  const api = (window as any).__STORYBOOK_CLIENT_API__;
                  if (api?.storyStore?.ready) {
                    resolve(true);
                  } else {
                    setTimeout(checkReady, 100);
                  }
                };
                checkReady();
              });
            }
            return false;
          });

          if (isStorybook) {
            log.debug('Detected Storybook page');

            // Wait for the iframe with increased timeout
            const frameHandle = await page.waitForSelector('iframe#storybook-preview-iframe', {
              state: 'attached',
              timeout: 5000
            }).catch(() => {
              log.debug('No Storybook iframe found - continuing with main page');
              return null;
            });

            if (frameHandle) {
              const frame = await frameHandle.contentFrame();
              if (frame) {
                log.debug('Found Storybook iframe');
                // Wait for frame to load completely
                await Promise.all([
                  frame.waitForLoadState('domcontentloaded'),
                  frame.waitForLoadState('networkidle', { timeout: 5000 })
                    .catch(() => log.debug('Frame network idle timeout - continuing anyway'))
                ]);
              }
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

          await enqueueLinks();

          const title = await page.title();

          // Extract content using appropriate extractor
          let content = '';
          let extractorUsed = '';

          try {
            // Get the Storybook iframe if it exists
            const frameHandle = await page.waitForSelector('iframe#storybook-preview-iframe')
              .catch(() => null);

            // Get the frame if it exists
            const frame = frameHandle ? await frameHandle.contentFrame() : null;

            for (const extractor of contentExtractors) {
              // Try to handle content in both main page and iframe
              const canHandleMain = await page.evaluate(
                ({ extractorStr }) => {
                  try {
                    const ExtractorClass = new Function(`return ${extractorStr}`)();
                    const extractor = new ExtractorClass();
                    return extractor.canHandle(document);
                  } catch (error) {
                    console.error('Error in canHandle:', error);
                    return false;
                  }
                },
                { extractorStr: extractor.constructor.toString() }
              );

              const canHandleFrame = frame ? await frame.evaluate(
                ({ extractorStr }) => {
                  try {
                    const ExtractorClass = new Function(`return ${extractorStr}`)();
                    const extractor = new ExtractorClass();
                    return extractor.canHandle(document);
                  } catch (error) {
                    console.error('Error in canHandle:', error);
                    return false;
                  }
                },
                { extractorStr: extractor.constructor.toString() }
              ) : false;

              // Use the context that the extractor can handle
              const canHandle = canHandleMain || canHandleFrame;

              if (canHandle) {
                extractorUsed = extractor.constructor.name;
                log.debug(`Using ${extractorUsed} for content extraction`);

                // Extract content from the appropriate context
                if (canHandleFrame && frame) {
                  content = await frame.evaluate(
                    async ({ extractorStr }) => {
                      try {
                        const ExtractorClass = new Function(`return ${extractorStr}`)();
                        const extractor = new ExtractorClass();
                        const extracted = await extractor.extractContent(document);
                        return extracted.content;
                      } catch (error) {
                        console.error('Error in extractContent:', error);
                        return '';
                      }
                    },
                    { extractorStr: extractor.constructor.toString() }
                  );
                } else {
                  content = await page.evaluate(
                    async ({ extractorStr }) => {
                      try {
                        const ExtractorClass = new Function(`return ${extractorStr}`)();
                        const extractor = new ExtractorClass();
                        const extracted = await extractor.extractContent(document);
                        return extracted.content;
                      } catch (error) {
                        console.error('Error in extractContent:', error);
                        return '';
                      }
                    },
                    { extractorStr: extractor.constructor.toString() }
                  );
                }

                if (content) {
                  log.debug(`Content extracted successfully using ${extractorUsed}`);
                  break;
                } else {
                  log.debug(`${extractorUsed} failed to extract content, trying next extractor`);
                }
              }
            }

            if (!content) {
              log.debug('No content extracted, falling back to default extraction');
              // Try to extract from frame first, then fall back to main page
              if (frame) {
                content = await frame.evaluate(() => {
                  const main = document.querySelector('main, article, [role="main"], #root, #docs-root, .sbdocs');
                  if (main) {
                    return main.textContent || document.body.textContent || '';
                  }
                  return document.body.textContent || '';
                });
              }

              if (!content) {
                content = await page.evaluate(() => {
                  const main = document.querySelector('main, article, [role="main"], #root, #docs-root, .sbdocs');
                  if (main) {
                    return main.textContent || document.body.textContent || '';
                  }
                  return document.body.textContent || '';
                });
              }

              extractorUsed = 'DefaultFallback';
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error('Error during content extraction', { error: errorMessage });
            content = await page.evaluate<string>(() => document.body.textContent || '');
            extractorUsed = 'ErrorFallback';
          }

          // Clean up the content
          const cleanContent = (text: string) => {
            return text
              .replace(/\s+/g, ' ') // Replace multiple spaces with single space
              .replace(/\\n/g, '\n') // Preserve actual newlines
              .replace(/\n\s*\n\s*\n/g, '\n\n') // Replace multiple newlines with double newlines
              .replace(/[^\x20-\x7E\n]/g, ' ') // Remove non-printable characters except newlines
              .split('\n') // Split into lines
              .map(line => line.trim()) // Trim each line
              .filter(line => line) // Remove empty lines
              .join('\n') // Rejoin with newlines
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
      await requestQueue.drop().catch(console.error);
    }
  }

  abort(): void {
    super.abort();
    if (this.crawler) {
      this.crawler.teardown().catch(console.error);
    }
  }
}