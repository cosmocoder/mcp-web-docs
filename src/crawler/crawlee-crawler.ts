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
import { isLoginWall, LOGIN_PAGE_CONFIDENCE, readLoginPageSignals } from './login-page-signals.js';
import { detectLoginPage, redactUrlSecrets, SessionExpiredError, type ValidatedStorageState } from '../util/security.js';
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
 * A session that has died answers page after page with a wall, so what gives it away is a run of them
 * among the pages the crawl is currently seeing - not one page, which a public site's own /login also
 * is, and not a total spread over a whole crawl, which a handful of scattered sign-up pages would
 * reach on a large site. Five of the last eight means a wall is most of what the crawl can still see.
 */
const LOGIN_WALL_WINDOW = 8;
const LOGIN_WALLS_IN_WINDOW_BEFORE_SESSION_EXPIRED = 5;

/** A crawl too short to fill the window says the same thing by proportion. Two, or /login alone counts. */
const MIN_WALLS_FOR_MOSTLY_WALLS = 2;

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
  /**
   * Whether each URL the check looked at turned out to be a login wall, in the order they were first
   * seen. Keyed by the requested URL, so a page the crawl retried is one page and a wall reached by
   * redirect from several URLs is several.
   */
  private wallByRequestedUrl: Map<string, boolean> = new Map();
  private expectedUrl: string = '';
  /** The allowed hostname for crawling - pages outside this domain are skipped */
  private allowedHostname: string = '';
  /** Track pages skipped due to domain mismatch */
  private skippedExternalPages: number = 0;
  /** The URLs of login walls left out of the index without stopping the crawl */
  private skippedLoginUrls: string[] = [];

  /** Login walls this crawl left out of the index. Only meaningful once crawl() has finished. */
  get skippedLoginPageUrls(): string[] {
    return [...this.skippedLoginUrls];
  }
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

  /** Which of the two it was. The remedy is the same; only what went wrong differs. */
  private loginPageMessage(what: string): string {
    return this.storageState ? `Authentication session expired during the crawl - ${what}` : `This site requires authentication - ${what}`;
  }

  /**
   * What to do with this page: nothing, keep it out of the index, or stop the crawl.
   *
   * Scored on content alone: a URL match is worth three of the detector's six indicators, enough on
   * its own, so every /oauth or /sso documentation page would score as a login page, as would every
   * page on a host like auth.example.com.
   */
  private async checkForLoginPage(page: Page, requestedUrl: string, isEntryPage: boolean): Promise<SessionExpiredError | 'skip' | null> {
    // Recorded before anything can return: the rules below count walls among the pages the crawl
    // looked at, not among the ones that got this far. Set() keeps a retried URL where it first was.
    this.wallByRequestedUrl.set(requestedUrl, this.wallByRequestedUrl.get(requestedUrl) ?? false);
    let observed;
    let detection;
    try {
      observed = await page.evaluate(readLoginPageSignals);
      // Serializing the DOM of every page is the expensive part, so it is skipped for pages showing
      // no sign of a login. Never for the entry page - one page.content() per crawl - because an SSO
      // wall can be a branded button, with nothing in its text and its form in a frame.
      if (!isEntryPage && detectLoginPage(observed.text, '').confidence === 0 && !observed.hasPasswordInput) {
        return null;
      }
      detection = detectLoginPage(observed.text + (await page.content()), '');
    }
    catch (error) {
      logger.debug(`[CrawleeCrawler] Error checking for login page:`, error);
      return null;
    }

    if (detection.confidence < LOGIN_PAGE_CONFIDENCE) {
      return null;
    }

    // With a session, a login page where documentation was asked for means the session is dead in
    // whatever shape it arrives - an SSO wall can be a branded button with no password field. Without
    // one it has to be a wall: a code sample containing type="password" is worth two of the detector's
    // six indicators, so an article about building login forms would fail the crawl.
    if (isEntryPage && (this.storageState || isLoginWall(observed))) {
      logger.warn(`[CrawleeCrawler] First page appears to be a login page (confidence: ${detection.confidence.toFixed(2)})`);
      logger.debug(`[CrawleeCrawler] Detection reasons: ${detection.reasons.join(', ')}`);
      return new SessionExpiredError(
        this.loginPageMessage('the page the crawl was asked for is a login page'),
        this.expectedUrl,
        page.url(),
        detection
      );
    }

    // Anything the detector flagged that is not a wall is left alone: a sign-in box in the site's
    // furniture reads as a login page on wording, and so does documentation about signing in.
    if (!isLoginWall(observed)) {
      return null;
    }
    // Deleted first so the wall takes the position the crawl found it in: a page recorded by an
    // earlier attempt that could not be read would otherwise sit outside every window that follows.
    this.wallByRequestedUrl.delete(requestedUrl);
    this.wallByRequestedUrl.set(requestedUrl, true);

    // Never indexed - it is not documentation - but one wall is not a dead session: a public site's
    // own /login is a wall, and a crawl without a pathPrefix reaches it from the nav.
    //
    // This rule and the proportion rule below are both for a crawl that authenticated. Without a session
    // nothing can have expired, and a public site has login pages in it by design - a /login, a /signup,
    // one per gated area, all hanging off the same nav and so arriving together. Only the entry rule
    // above fails such a crawl; every other wall is kept out of the index and reported.
    const recent = [...this.wallByRequestedUrl.values()].slice(-LOGIN_WALL_WINDOW);
    const walls = recent.filter(Boolean).length;
    if (walls < LOGIN_WALLS_IN_WINDOW_BEFORE_SESSION_EXPIRED || !this.storageState) {
      return 'skip';
    }

    logger.warn(`[CrawleeCrawler] ${walls} of the last ${recent.length} pages were login walls - the session expired mid-crawl`);
    return new SessionExpiredError(
      this.loginPageMessage(`${walls} of the last ${recent.length} pages the crawl saw were login walls`),
      this.expectedUrl,
      page.url(),
      detection
    );
  }

  /**
   * A crawl can end before the window fills - a short site, or a session that died near the end. Walls
   * being most of what the crawl saw at all says the same thing after the fact.
   */
  private sessionExpiredAcrossCrawl(): SessionExpiredError | null {
    const checked = this.wallByRequestedUrl.size;
    const walls = [...this.wallByRequestedUrl.values()].filter(Boolean).length;
    // A crawl that authenticated, for the reason given at the window rule
    if (!this.storageState || walls < MIN_WALLS_FOR_MOSTLY_WALLS || walls * 2 < checked) {
      return null;
    }

    logger.warn(`[CrawleeCrawler] ${walls} of ${checked} crawled pages were login walls`);
    return new SessionExpiredError(
      this.loginPageMessage(`${walls} of the ${checked} pages the crawl saw were login walls`),
      this.expectedUrl,
      this.expectedUrl,
      { isLoginPage: true, confidence: 1, reasons: [`${walls} of ${checked} crawled pages were login walls`] }
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
    this.wallByRequestedUrl.clear();
    this.terminalRootFailure = undefined;
    this.rootPageFailed = false;
    this.failedPages = 0;
    this.navigationAttempts = new WeakMap();
    this.expectedUrl = normalizeQueuedUrl(url);
    this.skippedExternalPages = 0;
    this.skippedLoginUrls = [];

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
          const isEntryPage = normalizeQueuedUrl(request.url) === this.expectedUrl;

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
              logger.warn(
                `[CrawleeCrawler] Skipping page that redirected outside domain: ${request.url} → ${actualUrl} (skipped ${this.skippedExternalPages} external pages)`
              );
              return;
            }
          }

          // Every crawl, not only an authenticated one: indexing the wall as documentation is the bug
          const verdict = await this.checkForLoginPage(page, normalizeQueuedUrl(request.url), isEntryPage);
          if (verdict instanceof SessionExpiredError) {
            this.sessionExpiredError = verdict;
            logger.error(`[CrawleeCrawler] ${verdict.message}. Aborting crawl.`);
            this.abort();
            return;
          }

          // Detect site type and get extractor
          for (const rule of siteRules) {
            if (await rule.detect(page)) {
              if (rule.prepare) {
                await rule.prepare(page, log);
              }

              await this.queueManager.handleQueueAndLinks(enqueueLinks, log, rule);

              // After the links, not before: a page skipped by mistake would otherwise take the whole
              // section under it out of the crawl, and the sparse nav of a small section is exactly the
              // page most likely to be mistaken for a wall.
              if (verdict === 'skip') {
                // Redacted once here, because the same string goes to the client and to stderr, and
                // the logger's own redaction covers fewer parameter names than this one
                const skipped = redactUrlSecrets(normalizeQueuedUrl(request.url));
                this.skippedLoginUrls.push(skipped);
                logger.warn(`[CrawleeCrawler] Not indexing ${skipped}: it asks for a password and has no content of its own`);
                return;
              }

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
      if (this.skippedLoginUrls.length > 0) {
        logger.warn(
          `[CrawleeCrawler] Left ${this.skippedLoginUrls.length} login ${this.skippedLoginUrls.length === 1 ? 'page' : 'pages'} out of the index; ` +
            'they had no content of their own'
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
