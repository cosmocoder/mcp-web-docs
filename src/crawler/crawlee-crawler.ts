import { createHash } from 'node:crypto';
import { PlaywrightCrawler } from 'crawlee';
import { ContentFormat, CrawlResult } from '../types.js';
import { BaseCrawler } from './base.js';
import { Page, Frame } from 'playwright';
import type { Request as PlaywrightRequest } from 'playwright';
import { siteRules } from './site-rules.js';
import { ContentExtractor } from './content-extractor-types.js';
import { QueueManager } from './queue-manager.js';
import { getBrowserConfig } from './browser-config.js';
import { cleanContent } from './content-utils.js';
import { logger } from '../util/logger.js';
import { detectLoginPage, SessionExpiredError, type ValidatedStorageState } from '../util/security.js';
import {
  BlockedOutboundRequestError,
  classifyOutboundFailure,
  getOutboundResponseError,
  isNavigationCancellationError,
  OutboundRequestFailedError,
} from '../util/outbound-request.js';

function normalizeOutboundFailure(error: unknown, seen = new Set<object>()): OutboundRequestFailedError | undefined {
  if (error instanceof OutboundRequestFailedError) {
    return error;
  }
  if (!error || typeof error !== 'object' || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  const value = error as { name?: unknown; message?: unknown; cause?: unknown };
  if (value.name === 'OutboundRequestFailedError') {
    return new OutboundRequestFailedError(typeof value.message === 'string' ? value.message : undefined);
  }
  return normalizeOutboundFailure(value.cause, seen);
}

function normalizeQueuedUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname + parsed.search;
}

/**
 * A crawl may lose a few pages to flaky rendering without being a failed crawl. Tolerate
 * whichever is larger: a small fixed number of pages, or this share of the crawl. The fixed
 * number is what makes small crawls workable, so it is paired with a minority check at the
 * use site - otherwise it would wave through most of a handful-of-pages site.
 */
const MIN_TOLERATED_FAILED_PAGES = 5;
const MAX_TOLERATED_FAILED_PAGE_RATIO = 0.02;

/**
 * How many times one login page must come back before the session is called dead. One is not
 * enough: the detector scores authentication wording, which documentation about signing in also
 * carries. What documentation does not do is answer several different URLs with the same page.
 */
const REPEATED_LOGIN_PAGES_BEFORE_SESSION_EXPIRED = 3;

/** Three of the detector's six indicators, its own bar for calling something a login page */
const LOGIN_PAGE_CONFIDENCE = 0.5;

/**
 * How many URLs one login page must have answered before "it was most of the crawl" means anything.
 * At one, a two-page site whose second page documents signing in would fail.
 */
const MIN_REPEATS_FOR_MOSTLY_LOGIN_PAGES = 2;

interface NavigationAttempt {
  failedUrl?: string;
  outboundFailure?: BlockedOutboundRequestError | OutboundRequestFailedError;
  cleanup?: () => void;
}

export class CrawleeCrawler extends BaseCrawler {
  private crawler: PlaywrightCrawler | null = null;
  private queueManager: QueueManager = new QueueManager();
  private storageState?: ValidatedStorageState;
  private sessionExpiredError: SessionExpiredError | null = null;
  /** How many pages each distinct login page has answered, and how many pages were checked at all */
  private loginPageCounts: Map<string, number> = new Map();
  private pagesChecked: number = 0;
  private expectedUrl: string = '';
  /** The allowed hostname for crawling - pages outside this domain are skipped */
  private allowedHostname: string = '';
  /** Track pages skipped due to domain mismatch */
  private skippedExternalPages: number = 0;
  /** Optional path prefix to restrict crawling */
  private pathPrefix?: string;
  private terminalRootFailure?: OutboundRequestFailedError;
  /** The root page failed for any reason, not just the outbound failures terminalRootFailure covers */
  private rootPageFailed: boolean = false;
  private failedPages: number = 0;

  /** Pages lost to a tolerated partial crawl. Only meaningful once crawl() has finished. */
  get failedPageCount(): number {
    return this.failedPages;
  }
  private navigationAttempts = new WeakMap<object, NavigationAttempt>();

  private cleanupNavigationListener(request: object): void {
    this.navigationAttempts.get(request)?.cleanup?.();
  }

  /**
   * Set authentication cookies/localStorage to use when crawling
   */
  setStorageState(state: ValidatedStorageState): void {
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
    }
    catch {
      return false;
    }
  }

  /**
   * The error to fail the crawl with if this page shows the session has expired, else null. Only
   * consulted when we authenticated, so a login page here means the session died rather than the
   * site being public.
   *
   * Scored on content alone. Passing the URL would settle it by itself - a URL match is worth three
   * of the detector's six indicators, so every /oauth, /sso or /auth page of ordinary documentation
   * would score as a login page, as would every page on a host like auth.example.com.
   */
  private async checkForLoginPage(page: Page, isEntryPage: boolean): Promise<SessionExpiredError | null> {
    let bodyText;
    let detection;
    try {
      bodyText = await page.evaluate(() => document.body?.textContent || '');
      // Serializing the DOM of every page in a crawl is the expensive part, so it is skipped for
      // pages showing no sign of a login at all. The two cheap signals have to be generous, not
      // decisive: an SSO page can be one branded button whose only real evidence is in the markup.
      const worthReading =
        detectLoginPage(bodyText, '').reasons.length > 0 ||
        (await page.evaluate(() => document.querySelector('input[type="password"]') !== null));
      if (!worthReading) {
        return null;
      }
      detection = detectLoginPage(bodyText + (await page.content()), '');
    }
    catch (error) {
      logger.debug(`[CrawleeCrawler] Error checking for login page:`, error);
      return null;
    }

    if (detection.confidence < LOGIN_PAGE_CONFIDENCE) {
      return null;
    }

    if (isEntryPage) {
      logger.warn(`[CrawleeCrawler] First page appears to be a login page (confidence: ${detection.confidence.toFixed(2)})`);
      logger.debug(`[CrawleeCrawler] Detection reasons: ${detection.reasons.join(', ')}`);
      return new SessionExpiredError(
        `Authentication session has expired - crawled page is a login page`,
        this.expectedUrl,
        page.url(),
        detection
      );
    }

    // Counted per distinct page rather than in a row: handlers run concurrently, so "in a row"
    // would mean "in the order five lanes happened to finish"
    const fingerprint = this.loginPageFingerprint(bodyText, page.url());
    const timesServed = (this.loginPageCounts.get(fingerprint) ?? 0) + 1;
    this.loginPageCounts.set(fingerprint, timesServed);
    if (timesServed < REPEATED_LOGIN_PAGES_BEFORE_SESSION_EXPIRED) {
      return null;
    }

    logger.warn(`[CrawleeCrawler] One login page has answered ${timesServed} URLs - the session expired mid-crawl`);
    return new SessionExpiredError(
      `Authentication session expired during the crawl - one login page answered ${timesServed} different URLs`,
      this.expectedUrl,
      page.url(),
      detection
    );
  }

  /**
   * Identifies the page behind the text, so the same login page answering different URLs is counted
   * as one. Only this page's own address is removed - a login page often names the URL it turned
   * away ("sign in to continue to /docs/42"). Stripping every path and number instead would fold
   * genuinely different documentation together: one API reference template describing three
   * endpoints, or the same page across three versions, would all become one page.
   */
  private loginPageFingerprint(bodyText: string, currentUrl: string): string {
    let withoutOwnUrl = bodyText.replace(/\s+/g, ' ');
    for (const address of new Set([currentUrl, new URL(currentUrl).pathname, this.expectedUrl])) {
      withoutOwnUrl = withoutOwnUrl.split(address).join('');
    }
    return createHash('sha1').update(withoutOwnUrl.trim()).digest('hex');
  }

  /**
   * A crawl can end before any login page repeats often enough to be caught above - a short site,
   * or a session that died near the end. Login pages being most of what the crawl saw says the same
   * thing after the fact, and unlike the count above it does not depend on how the crawl was
   * ordered.
   */
  private sessionExpiredAcrossCrawl(): SessionExpiredError | null {
    const timesServed = Math.max(0, ...this.loginPageCounts.values());
    if (timesServed < MIN_REPEATS_FOR_MOSTLY_LOGIN_PAGES || timesServed * 2 < this.pagesChecked) {
      return null;
    }

    logger.warn(`[CrawleeCrawler] One login page answered ${timesServed} of ${this.pagesChecked} crawled URLs`);
    return new SessionExpiredError(
      `Authentication session expired during the crawl - one login page answered ${timesServed} of ${this.pagesChecked} URLs`,
      this.expectedUrl,
      this.expectedUrl,
      { isLoginPage: true, confidence: 1, reasons: [`${timesServed} of ${this.pagesChecked} crawled pages were one login page`] }
    );
  }

  /**
   * Wait for the page to fully stabilize after navigation, handling:
   * - Client-side redirects (meta-refresh, JavaScript location changes) common in Docusaurus
   * - Cloudflare challenge interstitials
   *
   * Must be called after initial waitForLoadState, before content extraction.
   */
  private async waitForPageStabilization(page: Page): Promise<void> {
    const initialUrl = page.url();

    // Detect client-side redirect pages (Docusaurus generates these for /docs/ → /docs/intro/)
    // These are tiny HTML pages with a meta-refresh and/or JS redirect but no real content.
    let isRedirectPage = false;
    try {
      isRedirectPage = await page.evaluate(() => {
        const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
        if (metaRefresh) {
          return true;
        }
        const body = document.body;
        const hasMinimalContent = !body || (body.textContent?.trim().length || 0) < 100;
        const hasNoMainContent = !document.querySelector('main, article, [role="main"], .content, #content');
        return hasMinimalContent && hasNoMainContent;
      });
    }
    catch {
      // evaluate failed — page is likely mid-navigation already, which is fine
      isRedirectPage = true;
    }

    if (isRedirectPage) {
      logger.debug(`[CrawleeCrawler] Redirect/minimal page detected at ${initialUrl}, waiting for navigation...`);
      try {
        await page.waitForURL((url) => url.href !== initialUrl, { timeout: 10000 });
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}),
        ]);
        logger.debug(`[CrawleeCrawler] Redirect completed: ${initialUrl} → ${page.url()}`);
      }
      catch {
        logger.debug(`[CrawleeCrawler] No redirect detected within timeout, continuing with current page`);
      }
    }

    // Detect Cloudflare challenge pages (after any redirect has settled)
    try {
      const isChallenge = await page.evaluate(() => {
        const bodyText = document.body?.textContent || '';
        const hasChallengeText =
          bodyText.includes('Checking your browser') ||
          bodyText.includes('Verify you are human') ||
          bodyText.includes('Enable JavaScript and cookies');
        const hasChallengeElement =
          document.querySelector('#challenge-running, #challenge-stage, .cf-browser-verification, #cf-wrapper') !== null;
        return hasChallengeText || hasChallengeElement;
      });

      if (isChallenge) {
        logger.info(`[CrawleeCrawler] Cloudflare challenge detected, waiting for resolution...`);
        try {
          await page.waitForFunction(
            () => {
              const bodyText = document.body?.textContent || '';
              const stillChallenge = bodyText.includes('Checking your browser') || bodyText.includes('Verify you are human');
              const hasChallengeElement = document.querySelector('#challenge-running, #challenge-stage, .cf-browser-verification') !== null;
              return !stillChallenge && !hasChallengeElement;
            },
            { timeout: 15000 }
          );
          await page.waitForLoadState('domcontentloaded');
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
          logger.info(`[CrawleeCrawler] Cloudflare challenge resolved`);
        }
        catch {
          logger.warn(`[CrawleeCrawler] Cloudflare challenge did not resolve within timeout`);
        }
      }
    }
    catch {
      // evaluate failed during challenge detection — page may be navigating, proceed anyway
      logger.debug(`[CrawleeCrawler] Could not check for Cloudflare challenge, continuing`);
    }
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
        }
        catch (error) {
          logger.debug('Error checking frame', { error: String(error) });
        }
        return null;
      })
    );

    const frame = contentFrames.find((f) => f !== null) || null;
    if (frame) {
      logger.debug('Found content in iframe');
    }
    return frame;
  }

  private async evaluateExtractor(
    context: Page | Frame,
    extractor: ContentExtractor
  ): Promise<{ content: string; contentFormat: ContentFormat; title?: string }> {
    const extractorCode = extractor.constructor.toString();
    return context.evaluate(async (code: string) => {
      const ExtractorClass = new Function(`return ${code}`)();
      const extractor = new ExtractorClass();
      const result = await extractor.extractContent(document);
      return { content: result.content, contentFormat: result.contentFormat, title: result.title };
    }, extractorCode);
  }

  private async extractContent(
    page: Page,
    siteType: string,
    extractor: ContentExtractor
  ): Promise<{ content: string; contentFormat: ContentFormat; extractorUsed: string; title?: string }> {
    let content = '';
    let contentFormat: ContentFormat = 'text';
    let extractorUsed = extractor.constructor.name;
    let title: string | undefined;

    try {
      if (siteType === 'storybook') {
        // Try iframe first
        const frame = await this.findContentFrame(page);
        if (frame) {
          ({ content, contentFormat, title } = await this.evaluateExtractor(frame, extractor));
        }

        // Fallback to main page
        if (!content) {
          ({ content, contentFormat, title } = await this.evaluateExtractor(page, extractor));
        }
      }
      else {
        ({ content, contentFormat, title } = await this.evaluateExtractor(page, extractor));
      }
    }
    catch {
      content = await page.evaluate<string>(() => document.body.textContent || '');
      contentFormat = 'text';
      extractorUsed = 'ErrorFallback';
      title = undefined;
    }

    return { content, contentFormat, extractorUsed, title };
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
    this.sessionExpiredError = null;
    this.loginPageCounts.clear();
    this.pagesChecked = 0;
    this.terminalRootFailure = undefined;
    this.rootPageFailed = false;
    this.failedPages = 0;
    this.navigationAttempts = new WeakMap();
    this.expectedUrl = normalizeQueuedUrl(url);
    this.skippedExternalPages = 0;

    // Extract and store the allowed hostname from the initial URL
    try {
      this.allowedHostname = new URL(url).hostname;
      logger.info(`[CrawleeCrawler] Domain restriction: only crawling pages on ${this.allowedHostname}`);
    }
    catch {
      this.allowedHostname = '';
    }

    await this.queueManager.initialize(url, this.pathPrefix);

    // Seed URLs from llms.txt for better coverage on bot-protected sites
    await this.queueManager.seedFromLlmsTxt(url);

    // Build crawler options with optional authentication
    const crawlerOptions = await getBrowserConfig(this.queueManager.getRequestQueue() ?? undefined);

    // If we have storage state (auth cookies), configure the browser to use them
    if (this.storageState) {
      logger.info(`[CrawleeCrawler] Using authenticated session with ${this.storageState.cookies?.length || 0} cookies`);
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

    const existingPreNavigationHooks = crawlerOptions.preNavigationHooks ?? [];
    crawlerOptions.preNavigationHooks = [
      ...existingPreNavigationHooks,
      async ({ page, request }) => {
        const requestKey = request as object;
        this.cleanupNavigationListener(requestKey);
        const mainFrame = page.mainFrame();
        const attempt: NavigationAttempt = {};
        const onRequestFailed = (failedRequest: PlaywrightRequest) => {
          const errorText = failedRequest.failure()?.errorText ?? '';
          if (failedRequest.isNavigationRequest() && failedRequest.frame() === mainFrame && !isNavigationCancellationError(errorText)) {
            attempt.failedUrl = failedRequest.url();
          }
        };
        page.on('requestfailed', onRequestFailed);
        attempt.cleanup = () => page.off('requestfailed', onRequestFailed);
        this.navigationAttempts.set(requestKey, attempt);
      },
    ];

    this.crawler = new PlaywrightCrawler({
      ...crawlerOptions,
      errorHandler: async (context, error) => {
        const requestKey = context.request as object;
        const attempt = this.navigationAttempts.get(requestKey) ?? {};
        const failedUrl = attempt.failedUrl;
        const outboundFailure = failedUrl ? await classifyOutboundFailure(failedUrl) : normalizeOutboundFailure(error);
        if (outboundFailure) {
          attempt.outboundFailure = outboundFailure;
          this.navigationAttempts.set(requestKey, attempt);
        }
        if (outboundFailure instanceof BlockedOutboundRequestError) {
          context.request.noRetry = true;
        }
        try {
          await crawlerOptions.errorHandler?.(context, error);
        }
        finally {
          if (outboundFailure instanceof BlockedOutboundRequestError) {
            context.request.noRetry = true;
          }
          this.cleanupNavigationListener(requestKey);
        }
      },
      failedRequestHandler: async (context, error) => {
        const requestKey = context.request as object;
        this.cleanupNavigationListener(requestKey);
        const attempt = this.navigationAttempts.get(requestKey);
        const failedUrl = attempt?.failedUrl;
        const outboundFailure =
          attempt?.outboundFailure ?? (failedUrl ? await classifyOutboundFailure(failedUrl) : normalizeOutboundFailure(error));
        if (normalizeQueuedUrl(context.request.url) === this.expectedUrl) {
          // Any root failure is terminal. terminalRootFailure only carries the outbound ones,
          // so timeouts, bad status codes and extractor crashes need their own flag.
          this.rootPageFailed = true;
          if (outboundFailure instanceof OutboundRequestFailedError) {
            this.terminalRootFailure = outboundFailure;
          }
        }
        this.navigationAttempts.delete(requestKey);
        await crawlerOptions.failedRequestHandler?.(context, error);
      },
      requestHandler: async ({ request, response, page, enqueueLinks, log }) => {
        const requestKey = request as object;
        this.cleanupNavigationListener(requestKey);
        this.navigationAttempts.delete(requestKey);
        let latestMainFrameResponse = response;
        let mainFrameNavigationError: BlockedOutboundRequestError | OutboundRequestFailedError | undefined;
        let navigationSequence = 0;
        const pendingNavigationChecks = new Set<Promise<void>>();
        const trackMainFrameResponse = (nextResponse: typeof response) => {
          const nextRequest = nextResponse?.request();
          if (nextRequest?.isNavigationRequest() && nextRequest.frame() === page.mainFrame()) {
            navigationSequence++;
            latestMainFrameResponse = nextResponse;
            mainFrameNavigationError = undefined;
          }
        };
        const trackMainFrameFailure = (failedRequest: PlaywrightRequest) => {
          if (
            failedRequest.isNavigationRequest() &&
            failedRequest.frame() === page.mainFrame() &&
            !isNavigationCancellationError(failedRequest.failure()?.errorText ?? '')
          ) {
            const failureSequence = ++navigationSequence;
            const check = classifyOutboundFailure(failedRequest.url())
              .then((error) => {
                if (navigationSequence === failureSequence) {
                  mainFrameNavigationError = error;
                }
              })
              .finally(() => pendingNavigationChecks.delete(check));
            pendingNavigationChecks.add(check);
          }
        };
        page.on('response', trackMainFrameResponse);
        page.on('requestfailed', trackMainFrameFailure);
        const shouldSkipNavigation = async () => {
          await Promise.all(pendingNavigationChecks);
          if (mainFrameNavigationError) {
            if (mainFrameNavigationError instanceof BlockedOutboundRequestError) {
              log.warning(`Skipping blocked outbound destination: ${request.url}`);
              return true;
            }
            throw mainFrameNavigationError;
          }
          const outboundError = await getOutboundResponseError(latestMainFrameResponse);
          if (outboundError instanceof BlockedOutboundRequestError) {
            log.warning(`Skipping blocked outbound destination: ${request.url}`);
            return true;
          }
          if (outboundError) {
            throw outboundError;
          }
          return false;
        };

        try {
          if (this.isAborting) {
            log.debug('Crawl aborted');
            return;
          }

          if (await shouldSkipNavigation()) {
            return;
          }

          // Wait for initial page load
          await Promise.all([
            page.waitForLoadState('domcontentloaded'),
            page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => log.debug('Network idle timeout - continuing anyway')),
          ]);

          // Handle client-side redirects (Docusaurus) and Cloudflare challenges
          await this.waitForPageStabilization(page);
          if (await shouldSkipNavigation()) {
            return;
          }

          // Get the actual URL after any redirects
          const actualUrl = page.url();
          // The request the crawl was asked for, not whichever handler happens to run first: five
          // run at once, so a mutable "have we done one yet" flag is true for several of them
          const isEntryPage = normalizeQueuedUrl(request.url) === normalizeQueuedUrl(this.expectedUrl);

          // Check if the page redirected outside the allowed domain
          if (!this.isWithinAllowedDomain(actualUrl)) {
            const requestedHostname = new URL(request.url).hostname;
            const actualHostname = new URL(actualUrl).hostname;

            if (isEntryPage) {
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
              }
              else {
                // No auth but redirected - might be site misconfiguration
                log.error(`First page redirected to external domain: ${actualHostname}. Aborting crawl.`);
                this.abort();
                return;
              }
            }
            else {
              // Subsequent page redirected outside domain - skip it
              this.skippedExternalPages++;
              log.warning(
                `Skipping page that redirected outside domain: ${request.url} → ${actualUrl} (skipped ${this.skippedExternalPages} external pages)`
              );
              return;
            }
          }

          if (this.storageState) {
            this.pagesChecked++;
            // Kept if already set: later handlers are still in flight after abort(), so the message
            // would otherwise report whichever count finished last
            const expired = await this.checkForLoginPage(page, isEntryPage);
            if (expired) {
              this.sessionExpiredError ??= expired;
              log.error('Session appears expired - the crawl is being served login pages. Aborting crawl.');
              this.abort();
              return;
            }
          }

          // Detect site type and get extractor
          for (const rule of siteRules) {
            if (await rule.detect(page)) {
              if (rule.prepare) {
                await rule.prepare(page, log);
              }

              await this.queueManager.handleQueueAndLinks(enqueueLinks, log, rule);

              const pageTitle = await page.title();
              const { content, contentFormat, extractorUsed, title } = await this.extractContent(page, rule.type, rule.extractor);

              const result: CrawlResult = {
                url: request.url,
                path: new URL(request.url).pathname + new URL(request.url).search,
                content: contentFormat === 'text' ? cleanContent(content) : content,
                contentFormat,
                title: title || pageTitle,
                extractorUsed,
              };

              if (await shouldSkipNavigation()) {
                return;
              }
              this.queueManager.addResult(result);
              break;
            }
          }
        }
        finally {
          page.off('response', trackMainFrameResponse);
          page.off('requestfailed', trackMainFrameFailure);
        }
      },
    });

    try {
      const crawlerPromise = this.crawler.run();

      while (!this.isAborting) {
        // Yield whatever has been crawled so far rather than waiting for a full batch,
        // so callers can report progress while a slow site is still being crawled.
        for (const result of this.queueManager.drainResults()) {
          yield result;
        }

        if (await Promise.race([crawlerPromise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))])) {
          break;
        }
      }

      const finalStatistics = await crawlerPromise;
      if (this.terminalRootFailure) {
        throw this.terminalRootFailure;
      }
      logger.debug('Crawler finished');

      // Log summary of domain-restricted crawling
      if (this.skippedExternalPages > 0) {
        logger.warn(
          `[CrawleeCrawler] Skipped ${this.skippedExternalPages} pages that redirected outside the allowed domain (${this.allowedHostname})`
        );
      }

      // Check if we detected an expired session during crawling
      const sessionExpired = this.sessionExpiredError ?? this.sessionExpiredAcrossCrawl();
      if (sessionExpired) {
        throw sessionExpired;
      }

      if (finalStatistics.requestsFailed > 0) {
        // Losing the entry point is terminal however well the rest of the crawl went, and it is
        // not covered by terminalRootFailure above, which only carries outbound failures.
        if (this.rootPageFailed) {
          throw new Error(`Crawl failed: the root page ${this.expectedUrl} could not be loaded`);
        }

        // A few unreachable leaf pages shouldn't throw away everything else we crawled, but a
        // partial crawl can go on to replace a complete index, so tolerate only a small loss -
        // and never a loss that is half the crawl or more, however small the crawl is.
        const tolerated = Math.max(MIN_TOLERATED_FAILED_PAGES, finalStatistics.requestsTotal * MAX_TOLERATED_FAILED_PAGE_RATIO);
        if (finalStatistics.requestsFailed > tolerated || finalStatistics.requestsFailed * 2 >= finalStatistics.requestsTotal) {
          throw new Error(`Crawl failed for ${finalStatistics.requestsFailed} of ${finalStatistics.requestsTotal} pages after retries`);
        }
        this.failedPages = finalStatistics.requestsFailed;
        logger.warn(
          `[CrawleeCrawler] Continuing with a partial crawl: ${finalStatistics.requestsFailed} of ${finalStatistics.requestsTotal} pages failed after retries`
        );
      }

      for (const result of this.queueManager.drainResults()) {
        yield result;
      }
    }
    catch (error) {
      // Re-throw session expired errors as-is
      if (error instanceof SessionExpiredError) {
        throw error;
      }
      logger.debug('Crawler error:', error);
      throw error;
    }
    finally {
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
