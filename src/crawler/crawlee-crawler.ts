import { PlaywrightCrawler } from 'crawlee';
import { CrawlResult } from '../types.js';
import { BaseCrawler } from './base.js';
import { Page, Frame } from 'playwright';
import { siteRules } from './site-rules.js';
import { ContentExtractor } from './content-extractor-types.js';
import { QueueManager } from './queue-manager.js';
import { getBrowserConfig } from './browser-config.js';
import { cleanContent } from './content-utils.js';
import { logger } from '../util/logger.js';
import { detectLoginPage, isLoginPageUrl, SessionExpiredError } from '../util/security.js';

/** Storage state for authentication (cookies and localStorage) */
export interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  origins?: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export class CrawleeCrawler extends BaseCrawler {
  private crawler: PlaywrightCrawler | null = null;
  private queueManager: QueueManager = new QueueManager();
  private storageState?: StorageState;
  private isFirstPage: boolean = true;
  private sessionExpiredError: SessionExpiredError | null = null;
  private expectedUrl: string = '';
  /** The allowed hostname for crawling - pages outside this domain are skipped */
  private allowedHostname: string = '';
  /** Track pages skipped due to domain mismatch */
  private skippedExternalPages: number = 0;
  /** Optional path prefix to restrict crawling */
  private pathPrefix?: string;

  /**
   * Set authentication cookies/localStorage to use when crawling
   */
  setStorageState(state: StorageState): void {
    this.storageState = state;
    logger.info(`[CrawleeCrawler] Set storage state with ${state.cookies?.length || 0} cookies`);
  }

  /**
   * Check if a URL is within the allowed domain for this crawl.
   * This prevents following redirects or links to external domains.
   *
   * @param url - The URL to check
   * @returns true if the URL is within the allowed domain
   */
  private isWithinAllowedDomain(url: string): boolean {
    if (!this.allowedHostname) {
      return true; // No restriction if not set
    }

    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      const allowed = this.allowedHostname.toLowerCase();

      // Exact match
      if (hostname === allowed) {
        return true;
      }

      // Allow subdomains (e.g., docs.example.com when allowed is example.com)
      // But NOT the other way around (github.com is not allowed for *.github.io)
      if (hostname.endsWith('.' + allowed)) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if a page appears to be a login/authentication page.
   * This is used to detect expired sessions during crawling.
   */
  private async checkForLoginPage(page: Page, currentUrl: string): Promise<boolean> {
    // Only check the first page with high scrutiny
    // (subsequent pages being login pages might be intentional navigation)
    if (!this.isFirstPage) {
      return false;
    }

    // Check URL pattern first (fast)
    if (isLoginPageUrl(currentUrl)) {
      logger.warn(`[CrawleeCrawler] First page URL matches login pattern: ${currentUrl}`);
      return true;
    }

    // Check page content
    try {
      const bodyText = await page.evaluate(() => document.body?.textContent || '');
      const pageHtml = await page.content();
      const detection = detectLoginPage(bodyText + pageHtml, currentUrl);

      if (detection.isLoginPage && detection.confidence >= 0.5) {
        logger.warn(`[CrawleeCrawler] First page appears to be a login page (confidence: ${detection.confidence.toFixed(2)})`);
        logger.debug(`[CrawleeCrawler] Detection reasons: ${detection.reasons.join(', ')}`);

        // Store the error for throwing later (can't throw from request handler)
        this.sessionExpiredError = new SessionExpiredError(
          `Authentication session has expired - crawled page is a login page`,
          this.expectedUrl,
          currentUrl,
          detection
        );
        return true;
      }
    } catch (error) {
      logger.debug(`[CrawleeCrawler] Error checking for login page:`, error);
    }

    return false;
  }

  private async findContentFrame(page: Page): Promise<Frame | null> {
    const frames = await page.frames();
    const contentFrames = await Promise.all(
      frames.map(async (frame) => {
        try {
          const hasContent = await frame
            .evaluate(() => {
              return document.querySelector('.sbdocs-content, #docs-root, .docs-story, [class*="story-"]') !== null;
            })
            .catch(() => false);

          if (hasContent) {
            await Promise.all([
              frame.waitForLoadState('domcontentloaded'),
              frame
                .waitForLoadState('networkidle', { timeout: 5000 })
                .catch(() => logger.debug('Frame network idle timeout - continuing anyway')),
            ]);
            return frame;
          }
        } catch (error) {
          logger.debug('Error checking frame', { error: String(error) });
        }
        return null;
      })
    );

    const frame = contentFrames.find((f) => f !== null) || null;
    if (frame) {
      logger.debug('Found content in iframe');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return frame;
  }

  private async evaluateExtractor(context: Page | Frame, extractor: ContentExtractor): Promise<string> {
    const extractorCode = extractor.constructor.toString();
    return context.evaluate(async (code: string) => {
      const ExtractorClass = new Function(`return ${code}`)();
      const extractor = new ExtractorClass();
      const result = await extractor.extractContent(document);
      return result.content;
    }, extractorCode);
  }

  private async extractContent(
    page: Page,
    siteType: string,
    extractor: ContentExtractor
  ): Promise<{ content: string; extractorUsed: string }> {
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
    } catch {
      content = await page.evaluate<string>(() => document.body.textContent || '');
      extractorUsed = 'ErrorFallback';
    }

    return { content, extractorUsed };
  }

  /**
   * Set an optional path prefix to restrict crawling to URLs under this path.
   * Must be called before crawl().
   */
  setPathPrefix(prefix: string): void {
    this.pathPrefix = prefix;
    logger.info(`[CrawleeCrawler] Path prefix restriction set: ${prefix}`);
  }

  async *crawl(url: string): AsyncGenerator<CrawlResult, void, unknown> {
    logger.debug(`[${this.constructor.name}] Starting crawl of: ${url}`);

    // Reset state for this crawl
    this.isFirstPage = true;
    this.sessionExpiredError = null;
    this.expectedUrl = url;
    this.skippedExternalPages = 0;

    // Extract and store the allowed hostname from the initial URL
    try {
      this.allowedHostname = new URL(url).hostname;
      logger.info(`[CrawleeCrawler] Domain restriction: only crawling pages on ${this.allowedHostname}`);
    } catch {
      this.allowedHostname = '';
    }

    await this.queueManager.initialize(url, this.pathPrefix);

    // Build crawler options with optional authentication
    const crawlerOptions = getBrowserConfig(this.queueManager.getRequestQueue() ?? undefined);

    // If we have storage state (auth cookies), configure the browser to use them
    if (this.storageState) {
      logger.info(`[CrawleeCrawler] Using authenticated session with ${this.storageState.cookies?.length || 0} cookies`);
      crawlerOptions.launchContext = {
        ...crawlerOptions.launchContext,
        launchOptions: {
          ...crawlerOptions.launchContext?.launchOptions,
        },
      };
      crawlerOptions.browserPoolOptions = {
        ...crawlerOptions.browserPoolOptions,
        preLaunchHooks: [
          async (pageId) => {
            // Storage state will be set in preNavigationHooks instead
            logger.debug(`[CrawleeCrawler] Browser launching for page ${pageId}`);
          },
        ],
      };
      // Add cookies via preNavigationHooks
      const existingHooks = crawlerOptions.preNavigationHooks || [];
      crawlerOptions.preNavigationHooks = [
        ...existingHooks,
        async ({ page }) => {
          if (this.storageState?.cookies) {
            logger.debug(`[CrawleeCrawler] Setting ${this.storageState.cookies.length} cookies before navigation`);
            await page.context().addCookies(this.storageState.cookies);
          }
        },
      ];
    }

    this.crawler = new PlaywrightCrawler({
      ...crawlerOptions,
      requestHandler: async ({ request, page, enqueueLinks, log }) => {
        if (this.isAborting) {
          log.debug('Crawl aborted');
          return;
        }

        try {
          // Wait for initial page load
          await Promise.all([
            page.waitForLoadState('domcontentloaded'),
            page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => log.debug('Network idle timeout - continuing anyway')),
          ]);

          // Get the actual URL after any redirects
          const actualUrl = page.url();

          // Check if the page redirected outside the allowed domain
          if (!this.isWithinAllowedDomain(actualUrl)) {
            const requestedHostname = new URL(request.url).hostname;
            const actualHostname = new URL(actualUrl).hostname;

            if (this.isFirstPage) {
              // First page redirected outside domain - likely auth redirect (session expired)
              logger.warn(`[CrawleeCrawler] First page redirected outside allowed domain: ${requestedHostname} → ${actualHostname}`);

              if (this.storageState) {
                // We had auth but got redirected - session expired
                this.sessionExpiredError = new SessionExpiredError(
                  `Authentication session has expired - page redirected to external domain (${actualHostname})`,
                  this.expectedUrl,
                  actualUrl,
                  { isLoginPage: true, confidence: 1.0, reasons: [`Redirected from ${requestedHostname} to ${actualHostname}`] }
                );
                log.error(`Session expired - redirected to external domain: ${actualHostname}. Aborting crawl.`);
                this.abort();
                return;
              } else {
                // No auth but redirected - might be site misconfiguration
                log.error(`First page redirected to external domain: ${actualHostname}. Aborting crawl.`);
                this.abort();
                return;
              }
            } else {
              // Subsequent page redirected outside domain - skip it
              this.skippedExternalPages++;
              log.warning(
                `Skipping page that redirected outside domain: ${request.url} → ${actualUrl} (skipped ${this.skippedExternalPages} external pages)`
              );
              return;
            }
          }

          // Check for login page on first page (detects expired sessions)
          if (this.isFirstPage && this.storageState) {
            const isLoginPage = await this.checkForLoginPage(page, actualUrl);
            if (isLoginPage) {
              log.error('Session appears expired - first page is a login page. Aborting crawl.');
              this.abort();
              return;
            }
            this.isFirstPage = false;
          } else if (this.isFirstPage) {
            this.isFirstPage = false;
          }

          // Detect site type and get extractor
          for (const rule of siteRules) {
            if (await rule.detect(page)) {
              if (rule.prepare) {
                await rule.prepare(page, log);
              }

              await this.queueManager.handleQueueAndLinks(enqueueLinks, log, rule);

              const title = await page.title();
              const { content, extractorUsed } = await this.extractContent(page, rule.type, rule.extractor);

              const result: CrawlResult = {
                url: request.url,
                path: new URL(request.url).pathname + new URL(request.url).search,
                content: cleanContent(content),
                title,
                extractorUsed,
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
      },
    });

    try {
      const crawlerPromise = this.crawler.run();

      while (!this.isAborting) {
        if (this.queueManager.hasEnoughResults()) {
          for (const result of await this.queueManager.processBatch()) {
            yield result;
          }
        }

        if (await Promise.race([crawlerPromise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))])) break;
      }

      await crawlerPromise;
      logger.debug('Crawler finished');

      // Log summary of domain-restricted crawling
      if (this.skippedExternalPages > 0) {
        logger.warn(
          `[CrawleeCrawler] Skipped ${this.skippedExternalPages} pages that redirected outside the allowed domain (${this.allowedHostname})`
        );
      }

      // Check if we detected an expired session during crawling
      if (this.sessionExpiredError) {
        throw this.sessionExpiredError;
      }

      for (const result of await this.queueManager.processBatch()) {
        yield result;
      }
    } catch (error) {
      // Re-throw session expired errors as-is
      if (error instanceof SessionExpiredError) {
        throw error;
      }
      logger.debug('Crawler error:', error);
      throw error;
    } finally {
      await this.queueManager.cleanup();
      this.crawler = null;
    }
  }

  abort(): void {
    super.abort();
    if (this.crawler) {
      this.crawler.teardown().catch((err) => logger.error('Failed to teardown crawler:', err));
    }
  }
}
