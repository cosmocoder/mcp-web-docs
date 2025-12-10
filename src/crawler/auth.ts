import { chromium, firefox, webkit, Browser, BrowserContext, Page } from 'playwright';
import { mkdir, readFile, writeFile, access, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import defaultBrowser from 'default-browser';
import { logger } from '../util/logger.js';
import {
  encryptData,
  decryptData,
  createSafeRegex,
  isSafeRegex,
  StorageStateSchema,
  StoredSessionSchema,
  safeJsonParse,
  detectLoginPage,
  isLoginPageUrl,
  SessionExpiredError,
  type ValidatedStoredSession,
  type LoginPageDetectionResult,
} from '../util/security.js';

/** Supported browser types */
export type BrowserType = 'chromium' | 'chrome' | 'firefox' | 'webkit' | 'edge';

/**
 * Detect the user's default browser from OS settings using the default-browser package
 * https://github.com/sindresorhus/default-browser
 */
export async function detectDefaultBrowser(): Promise<BrowserType> {
  logger.info(`[Auth] === Detecting default browser ===`);

  try {
    logger.info(`[Auth] Calling default-browser package...`);
    const browser = await defaultBrowser();
    logger.info(`[Auth] ✓ default-browser returned: name="${browser.name}", id="${browser.id}"`);

    const id = browser.id.toLowerCase();
    const name = browser.name.toLowerCase();

    if (id.includes('firefox') || name.includes('firefox')) {
      logger.info(`[Auth] → Mapped to: firefox`);
      return 'firefox';
    }
    if (id.includes('chrome') || name.includes('chrome')) {
      logger.info(`[Auth] → Mapped to: chrome`);
      return 'chrome';
    }
    if (id.includes('edge') || name.includes('edge')) {
      logger.info(`[Auth] → Mapped to: edge`);
      return 'edge';
    }
    if (id.includes('safari') || name.includes('safari')) {
      logger.info(`[Auth] → Mapped to: webkit (Safari)`);
      return 'webkit';
    }
    if (id.includes('chromium') || name.includes('chromium')) {
      logger.info(`[Auth] → Mapped to: chromium`);
      return 'chromium';
    }

    // Unknown browser, default to chromium
    logger.warn(`[Auth] Unknown browser "${browser.name}" (id: ${browser.id}), falling back to chromium`);
    return 'chromium';
  } catch (error) {
    const err = error as Error;
    logger.error(`[Auth] ✗ default-browser package threw an error:`);
    logger.error(`[Auth]   Error name: ${err?.name}`);
    logger.error(`[Auth]   Error message: ${err?.message}`);
    logger.error(`[Auth]   Error stack: ${err?.stack}`);
    logger.info('[Auth] Falling back to chromium');
    return 'chromium';
  }
}

/** Authentication options for crawling */
export interface AuthOptions {
  /** Whether authentication is required */
  requiresAuth?: boolean;

  /** Browser to use for authentication */
  browser?: BrowserType;

  /** URL pattern that indicates successful login (regex) */
  loginSuccessPattern?: string;

  /** CSS selector that appears after successful login */
  loginSuccessSelector?: string;

  /** Login page URL (if different from main URL) */
  loginUrl?: string;

  /** Timeout for waiting for login (seconds) */
  loginTimeoutSecs?: number;
}

/**
 * Manages authentication sessions for crawling protected pages.
 * Opens a visible browser for user to login, then saves the session for reuse.
 */
export class AuthManager {
  private sessionsDir: string;
  private activeBrowser: Browser | null = null;
  private activeContext: BrowserContext | null = null;

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, 'sessions');
  }

  async initialize(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  /**
   * Get the session file path for a domain with path traversal protection
   */
  private getSessionPath(domain: string): string {
    // Strict sanitization - only allow alphanumeric, dots, and hyphens
    // Limit length to prevent filesystem issues
    const safeDomain = domain
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '_')
      .slice(0, 100);

    if (!safeDomain || safeDomain === '.' || safeDomain === '..') {
      throw new Error('Invalid domain for session storage');
    }

    const filename = `${safeDomain}.json`;
    const fullPath = resolve(this.sessionsDir, filename);

    // Verify the resolved path stays within the sessions directory (path traversal protection)
    const resolvedSessionsDir = resolve(this.sessionsDir);
    if (!fullPath.startsWith(resolvedSessionsDir + '/') && fullPath !== resolvedSessionsDir) {
      throw new Error('Invalid session path: path traversal detected');
    }

    return fullPath;
  }

  /**
   * Check if we have a saved session for a domain
   */
  async hasSession(url: string): Promise<boolean> {
    const domain = new URL(url).hostname;
    const sessionPath = this.getSessionPath(domain);
    try {
      await access(sessionPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load a saved session for a domain
   * Sessions are encrypted at rest and validated on load
   */
  async loadSession(url: string): Promise<string | null> {
    const domain = new URL(url).hostname;
    const sessionPath = this.getSessionPath(domain);
    try {
      const data = await readFile(sessionPath, 'utf-8');

      // Validate the session structure
      const session: ValidatedStoredSession = safeJsonParse(data, StoredSessionSchema);

      // Decrypt the storage state
      const decryptedStorageState = decryptData(session.storageState);

      // Validate the decrypted storage state structure
      safeJsonParse(decryptedStorageState, StorageStateSchema);

      logger.info(`[AuthManager] Loaded and validated saved session for ${domain}`);
      return decryptedStorageState;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.debug(`[AuthManager] Failed to load session for ${domain}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Save a session for a domain with encryption
   * The storage state is encrypted before being written to disk
   */
  private async saveSession(url: string, storageState: string, browser: BrowserType): Promise<void> {
    const domain = new URL(url).hostname;
    const sessionPath = this.getSessionPath(domain);

    // Validate the storage state structure before saving
    safeJsonParse(storageState, StorageStateSchema);

    // Encrypt the storage state before saving
    const encryptedStorageState = encryptData(storageState);

    const session = {
      domain,
      storageState: encryptedStorageState,
      createdAt: new Date().toISOString(),
      browser,
      version: 2 as const, // Schema version for future migrations
    };

    // Write with restrictive permissions (owner read/write only)
    await writeFile(sessionPath, JSON.stringify(session, null, 2), { mode: 0o600 });

    // Ensure permissions are set correctly (in case file already existed)
    await chmod(sessionPath, 0o600);

    logger.info(`[AuthManager] Saved encrypted session for ${domain}`);
  }

  /**
   * Clear a saved session for a domain
   */
  async clearSession(url: string): Promise<void> {
    const domain = new URL(url).hostname;
    const sessionPath = this.getSessionPath(domain);
    try {
      const { unlink } = await import('fs/promises');
      await unlink(sessionPath);
      logger.info(`[AuthManager] Cleared session for ${domain}`);
    } catch {
      // Session didn't exist
    }
  }

  /**
   * Check if stored cookies have expired based on their expiration timestamps.
   * This is a fast check that doesn't require launching a browser.
   *
   * @param storageStateJson - The decrypted storage state JSON
   * @param domain - The domain to check cookies for
   * @returns Object with expiration status and details
   */
  private checkCookieExpiration(
    storageStateJson: string,
    domain: string
  ): { hasExpiredCookies: boolean; expiredCount: number; totalCount: number; details: string[] } {
    try {
      const storageState = safeJsonParse(storageStateJson, StorageStateSchema);
      const cookies = storageState.cookies || [];
      const now = Date.now() / 1000; // Convert to seconds (cookie expires is in seconds)

      // Filter cookies relevant to this domain
      const domainLower = domain.toLowerCase();
      const relevantCookies = cookies.filter((cookie: { domain: string }) => {
        const cookieDomain = cookie.domain.toLowerCase().replace(/^\./, ''); // Remove leading dot
        return domainLower === cookieDomain || domainLower.endsWith('.' + cookieDomain);
      });

      if (relevantCookies.length === 0) {
        // No domain-specific cookies, check all cookies
        // This handles cases where auth cookies are on a different domain (e.g., github.com for github.io)
        logger.debug(`[AuthManager] No cookies found for ${domain}, checking all ${cookies.length} cookies`);
      }

      const cookiesToCheck = relevantCookies.length > 0 ? relevantCookies : cookies;

      let expiredCount = 0;
      const details: string[] = [];

      for (const cookie of cookiesToCheck) {
        // Skip cookies without expiration (session cookies)
        if (cookie.expires === undefined || cookie.expires === -1 || cookie.expires === 0) {
          continue;
        }

        if (cookie.expires < now) {
          expiredCount++;
          const expiredAgo = Math.round((now - cookie.expires) / 3600); // Hours ago
          details.push(`Cookie "${cookie.name}" expired ${expiredAgo}h ago`);
        }
      }

      // Consider session expired if ANY auth-related cookies are expired
      // Common auth cookie names
      const authCookiePatterns = /session|auth|token|jwt|sid|login|user|identity|sso|saml|oauth/i;
      const expiredAuthCookies = cookiesToCheck.filter((cookie: { name: string; expires?: number }) => {
        if (!cookie.expires || cookie.expires === -1 || cookie.expires === 0) return false;
        return cookie.expires < now && authCookiePatterns.test(cookie.name);
      });

      return {
        hasExpiredCookies: expiredCount > 0,
        expiredCount,
        totalCount: cookiesToCheck.length,
        details:
          expiredAuthCookies.length > 0
            ? details.filter((d) => expiredAuthCookies.some((c: { name: string }) => d.includes(c.name)))
            : details.slice(0, 3), // Limit details
      };
    } catch (error) {
      logger.debug(`[AuthManager] Error checking cookie expiration:`, error);
      return { hasExpiredCookies: false, expiredCount: 0, totalCount: 0, details: [] };
    }
  }

  /**
   * Validate that a stored session is still valid.
   * First checks cookie expiration timestamps (fast, no network).
   * Falls back to browser-based validation for edge cases.
   *
   * @param url - The protected URL to validate against
   * @param browserType - Browser type to use for browser-based validation (if needed)
   * @returns Validation result indicating if session is still valid
   */
  async validateSession(
    url: string,
    browserType: BrowserType = 'chromium'
  ): Promise<{ isValid: boolean; reason?: string; loginDetection?: LoginPageDetectionResult; finalUrl?: string }> {
    const domain = new URL(url).hostname;
    logger.info(`[AuthManager] Validating session for ${domain}...`);

    const storageStateJson = await this.loadSession(url);
    if (!storageStateJson) {
      logger.info(`[AuthManager] No stored session found for ${domain}`);
      return { isValid: false, reason: 'No stored session found' };
    }

    // Fast check: Look at cookie expiration timestamps
    const cookieCheck = this.checkCookieExpiration(storageStateJson, domain);
    logger.debug(`[AuthManager] Cookie check: ${cookieCheck.expiredCount}/${cookieCheck.totalCount} expired`);

    if (cookieCheck.hasExpiredCookies) {
      const reason = `Session cookies have expired (${cookieCheck.expiredCount} expired). ${cookieCheck.details.join('; ')}`;
      logger.warn(`[AuthManager] Session expired based on cookie timestamps: ${reason}`);
      return {
        isValid: false,
        reason,
        loginDetection: {
          isLoginPage: false,
          confidence: 1.0,
          reasons: [`Cookie expiration check: ${cookieCheck.details.join(', ')}`],
        },
      };
    }

    // If no cookies have explicit expiration, or all have valid timestamps,
    // do a quick browser-based check to be sure
    logger.debug(`[AuthManager] Cookie timestamps look valid, performing browser-based validation...`);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      const launcher = this.getBrowserLauncher(browserType);
      const launchOptions = this.getLaunchOptions(browserType);

      // Launch headless browser for validation
      browser = await launcher.launch({
        headless: true,
        ...launchOptions,
      });

      const storageState = JSON.parse(storageStateJson);
      context = await browser.newContext({ storageState });

      const page = await context.newPage();

      // Navigate to the protected URL and check the result
      logger.debug(`[AuthManager] Navigating to ${url} to validate session...`);
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Wait for potential JavaScript redirects
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      // Additional wait for JS-based auth redirects (GitHub Pages, etc.)
      await page.waitForTimeout(2000);

      const finalUrl = page.url();
      logger.debug(`[AuthManager] Final URL after navigation: ${finalUrl}`);

      // Check 1: Were we redirected to a different domain (likely auth)?
      const finalDomain = new URL(finalUrl).hostname.toLowerCase();
      const expectedDomain = domain.toLowerCase();
      if (finalDomain !== expectedDomain && !finalDomain.endsWith('.' + expectedDomain)) {
        // Redirected to a different domain - check if it's a login page
        if (isLoginPageUrl(finalUrl)) {
          logger.warn(`[AuthManager] Session appears expired - redirected to login page: ${finalUrl}`);
          return {
            isValid: false,
            reason: `Redirected to login page on different domain (${finalDomain})`,
            finalUrl,
            loginDetection: { isLoginPage: true, confidence: 1.0, reasons: ['Redirected to external login URL'] },
          };
        }
      }

      // Check 2: Did we get an auth-related HTTP status?
      const status = response?.status();
      if (status === 401 || status === 403) {
        logger.warn(`[AuthManager] Session appears expired - received HTTP ${status}`);
        return {
          isValid: false,
          reason: `Authentication failed with HTTP ${status}`,
          finalUrl,
        };
      }

      // Check 3: Does the page content look like a login page?
      const pageContent = await page.content();
      const bodyText = await page.evaluate(() => document.body?.textContent || '');
      const loginDetection = detectLoginPage(bodyText + pageContent, finalUrl);

      if (loginDetection.isLoginPage && loginDetection.confidence >= 0.5) {
        logger.warn(`[AuthManager] Session appears expired - login page detected (confidence: ${loginDetection.confidence.toFixed(2)})`);
        logger.debug(`[AuthManager] Login detection reasons: ${loginDetection.reasons.join(', ')}`);
        return {
          isValid: false,
          reason: `Login page detected (confidence: ${Math.round(loginDetection.confidence * 100)}%)`,
          finalUrl,
          loginDetection,
        };
      }

      // Session appears valid
      logger.info(`[AuthManager] ✓ Session for ${domain} is valid`);
      return { isValid: true, finalUrl };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[AuthManager] Error validating session: ${errorMsg}`);
      // On error, we can't confirm validity - treat as potentially invalid
      return {
        isValid: false,
        reason: `Validation failed: ${errorMsg}`,
      };
    } finally {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Validate session and throw SessionExpiredError if expired.
   * This is a convenience method for use in crawling workflows.
   *
   * @param url - The protected URL to validate against
   * @param browserType - Browser type to use for validation
   * @throws SessionExpiredError if the session has expired
   */
  async validateSessionOrThrow(url: string, browserType: BrowserType = 'chromium'): Promise<void> {
    const result = await this.validateSession(url, browserType);

    if (!result.isValid) {
      // Clear the expired session
      await this.clearSession(url);
      logger.info(`[AuthManager] Cleared expired session for ${new URL(url).hostname}`);

      throw new SessionExpiredError(
        `Authentication session has expired: ${result.reason}`,
        url,
        result.finalUrl || url,
        result.loginDetection || { isLoginPage: true, confidence: 0.5, reasons: [result.reason || 'Unknown'] }
      );
    }
  }

  /**
   * Get the Playwright browser launcher for a browser type
   */
  private getBrowserLauncher(browserType: BrowserType) {
    switch (browserType) {
      case 'firefox':
        return firefox;
      case 'webkit':
        return webkit;
      case 'chromium':
      case 'chrome':
      case 'edge':
      default:
        return chromium;
    }
  }

  /**
   * Get launch options for a browser type
   *
   * Note: Firefox cannot use the installed browser - Playwright requires its bundled
   * Firefox (Nightly) which includes the Juggler automation protocol.
   * Chrome and Edge can use the installed browser via the 'channel' option.
   */
  private getLaunchOptions(browserType: BrowserType): { channel?: string } {
    switch (browserType) {
      case 'chrome':
        return { channel: 'chrome' };
      case 'edge':
        return { channel: 'msedge' };
      case 'firefox':
        // Note: Must use Playwright's bundled Firefox - regular Firefox doesn't have Juggler protocol
        logger.info(`[AuthManager] Note: Using Playwright's bundled Firefox (regular Firefox not supported)`);
        return {};
      case 'webkit':
      case 'chromium':
      default:
        return {};
    }
  }

  /**
   * Open a visible browser for user to login interactively.
   * Returns the storage state (cookies/localStorage) after successful login.
   *
   * Opens a fresh browser instance for the user to login manually.
   * Note: We don't use the user's existing browser profile because:
   * 1. Firefox locks profiles when already open
   * 2. Playwright uses its own bundled browsers, not system browsers
   */
  async performInteractiveLogin(url: string, options: AuthOptions = {}): Promise<string> {
    const {
      browser: initialBrowserType,
      loginSuccessPattern,
      loginSuccessSelector,
      loginUrl,
      loginTimeoutSecs = 300, // 5 minutes default
    } = options;
    let browserType = initialBrowserType;

    logger.info(`[AuthManager] === Starting Interactive Login ===`);
    logger.info(`[AuthManager] Target URL: ${url}`);
    logger.info(
      `[AuthManager] Options: browser=${browserType || 'auto-detect'}, loginUrl=${loginUrl || 'same as target'}, timeout=${loginTimeoutSecs}s`
    );

    // Auto-detect default browser type if not specified (for UI preference)
    if (!browserType) {
      logger.info(`[AuthManager] No browser specified, auto-detecting...`);
      browserType = await detectDefaultBrowser();
    }
    logger.info(`[AuthManager] Using browser type: ${browserType}`);

    const domain = new URL(url).hostname;
    const targetUrl = loginUrl || url;

    logger.info(`[AuthManager] Will open ${browserType} browser for authentication to ${domain}`);
    logger.info(`[AuthManager] Please login in the browser window. You have ${loginTimeoutSecs} seconds.`);
    logger.info(`[AuthManager] NOTE: This is a fresh browser - you will need to login manually.`);

    // Always use fresh browser to avoid profile conflicts
    return this.loginWithFreshBrowser(url, targetUrl, browserType, {
      loginSuccessPattern,
      loginSuccessSelector,
      loginTimeoutSecs,
    });
  }

  /**
   * Login using a fresh browser instance (for manual login)
   */
  private async loginWithFreshBrowser(
    url: string,
    targetUrl: string,
    browserType: BrowserType,
    options: {
      loginSuccessPattern?: string;
      loginSuccessSelector?: string;
      loginTimeoutSecs: number;
    }
  ): Promise<string> {
    const { loginSuccessPattern, loginSuccessSelector, loginTimeoutSecs } = options;
    const domain = new URL(url).hostname;
    const launcher = this.getBrowserLauncher(browserType);
    const launchOptions = this.getLaunchOptions(browserType);

    logger.info(`[AuthManager] Launching fresh ${browserType} browser...`);
    logger.debug(`[AuthManager] Launch options:`, launchOptions);

    try {
      // Launch visible browser
      this.activeBrowser = await launcher.launch({
        headless: false, // VISIBLE browser for user interaction
        ...launchOptions,
      });
      logger.info(`[AuthManager] ✓ Browser launched successfully`);

      this.activeContext = await this.activeBrowser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      logger.debug(`[AuthManager] ✓ Browser context created`);

      const page = await this.activeContext.newPage();
      logger.debug(`[AuthManager] ✓ New page created`);

      // Navigate to login page
      logger.info(`[AuthManager] Navigating to: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      logger.info(`[AuthManager] ✓ Page loaded. Waiting for user to login...`);
      logger.info(`[AuthManager] ⏳ You have ${loginTimeoutSecs} seconds to complete login.`);

      // Wait for successful login
      const loginSuccess = await this.waitForLogin(page, {
        targetUrl: url, // The original target URL to return to
        successPattern: loginSuccessPattern,
        successSelector: loginSuccessSelector,
        timeoutSecs: loginTimeoutSecs,
      });

      if (!loginSuccess) {
        logger.error(`[AuthManager] ✗ Login timed out after ${loginTimeoutSecs} seconds`);
        throw new Error('Login timed out or was cancelled');
      }

      logger.info(`[AuthManager] ✓ Login detected!`);

      // Extract and save the storage state
      const storageState = await this.activeContext.storageState();
      const storageStateJson = JSON.stringify(storageState);
      logger.debug(`[AuthManager] Storage state captured (${storageStateJson.length} bytes)`);

      await this.saveSession(url, storageStateJson, browserType);

      logger.info(`[AuthManager] ✓ Session saved for ${domain}`);

      return storageStateJson;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Wait for the user to complete login.
   *
   * Detection methods (in order of priority):
   * 1. If successPattern is provided: wait for URL to match the regex
   * 2. If successSelector is provided: wait for the CSS selector to appear
   * 3. Default: poll for common login success indicators or return to target domain
   *
   * For multi-step OAuth flows (e.g., GitHub Pages → GitHub Login → Okta → back),
   * the method tracks when the user returns to the original target domain.
   */
  private async waitForLogin(
    page: Page,
    options: {
      targetUrl: string; // The original target URL the user wants to access
      successPattern?: string;
      successSelector?: string;
      timeoutSecs: number;
    }
  ): Promise<boolean> {
    const { targetUrl, successPattern, successSelector, timeoutSecs } = options;
    const startTime = Date.now();
    const timeoutMs = timeoutSecs * 1000;

    // Extract target domain for multi-step OAuth flow detection
    let targetDomain: string;
    try {
      targetDomain = new URL(targetUrl).hostname.toLowerCase();
    } catch {
      targetDomain = '';
    }

    logger.debug(
      `[AuthManager] Login detection method: ${
        successPattern
          ? `URL pattern: ${successPattern}`
          : successSelector
            ? `CSS selector: ${successSelector}`
            : `auto-detect (target domain: ${targetDomain})`
      }`
    );

    // If we have specific success criteria, wait for them
    if (successPattern) {
      // Validate the regex pattern to prevent ReDoS attacks
      if (!isSafeRegex(successPattern)) {
        logger.error(`[AuthManager] Unsafe regex pattern provided: ${successPattern}`);
        throw new Error('Unsafe regex pattern: may cause catastrophic backtracking (ReDoS)');
      }

      const pattern = createSafeRegex(successPattern);
      logger.info(`[AuthManager] Waiting for URL to match pattern: ${successPattern}`);
      try {
        await page.waitForURL(pattern, { timeout: timeoutMs });
        logger.info(`[AuthManager] ✓ URL matched success pattern`);
        return true;
      } catch {
        logger.debug(`[AuthManager] ✗ URL did not match pattern within timeout`);
        return false;
      }
    }

    if (successSelector) {
      logger.info(`[AuthManager] Waiting for element: ${successSelector}`);
      try {
        await page.waitForSelector(successSelector, { timeout: timeoutMs });
        logger.info(`[AuthManager] ✓ Success selector found`);
        return true;
      } catch {
        logger.debug(`[AuthManager] ✗ Selector not found within timeout`);
        return false;
      }
    }

    // Default: wait for navigation away from login page or for page to show logged-in state
    // Poll for changes that indicate successful login
    logger.info(`[AuthManager] Using auto-detection for login success...`);
    logger.info(`[AuthManager] Target domain: ${targetDomain}`);
    logger.info(`[AuthManager] The browser will stay open until you login or ${timeoutSecs} seconds pass.`);
    let lastLogTime = 0;

    // Track the initial URL to detect navigation
    const initialUrl = page.url();
    let hasNavigatedAway = false;
    let wasOnLoginPage = false;
    const visitedDomains = new Set<string>();

    // Enhanced login page URL pattern including common IdPs
    const loginPagePattern =
      /login|signin|sign-in|auth|sso|oauth|session|okta|oktapreview|auth0|onelogin|pingone|pingidentity|pingfederate|duosecurity|adfs|saml|idp/i;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const currentUrl = page.url();
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        // Extract current domain
        let currentDomain: string;
        try {
          currentDomain = new URL(currentUrl).hostname.toLowerCase();
        } catch {
          currentDomain = '';
        }

        // Track visited domains for debugging
        if (currentDomain && !visitedDomains.has(currentDomain)) {
          visitedDomains.add(currentDomain);
          logger.debug(`[AuthManager] Visited new domain: ${currentDomain}`);
        }

        // Log status every 10 seconds
        if (elapsed - lastLogTime >= 10) {
          logger.info(`[AuthManager] Still waiting for login... (${elapsed}s elapsed, current URL: ${currentUrl})`);
          lastLogTime = elapsed;
        }

        // Check if we're on a login-like page (URL-based detection)
        const isLoginPageUrl = loginPagePattern.test(currentUrl);

        // Check if we're on a known identity provider domain
        const isIdpDomain = /okta|auth0|onelogin|pingidentity|duosecurity|microsoftonline|accounts\.google/i.test(currentDomain);

        const isLoginPage = isLoginPageUrl || isIdpDomain;

        // Track if we've been to a login page (to know when we've successfully logged in)
        if (isLoginPage) {
          wasOnLoginPage = true;
          logger.debug(`[AuthManager] Detected login/IdP page: ${currentUrl}`);
        }

        // Track navigation away from initial URL
        if (currentUrl !== initialUrl && !hasNavigatedAway) {
          hasNavigatedAway = true;
          logger.debug(`[AuthManager] Navigation detected: ${initialUrl} → ${currentUrl}`);
        }

        // Check if we've returned to the target domain after visiting login pages
        const isBackAtTargetDomain = targetDomain && (currentDomain === targetDomain || currentDomain.endsWith('.' + targetDomain));

        // Check for common logged-in indicators
        const hasLogoutButton = (await page.locator('text=/log\\s*out|sign\\s*out/i').count()) > 0;
        const hasUserMenu = (await page.locator('[class*="user"], [class*="avatar"], [class*="profile"]').count()) > 0;

        // Success condition 1: Found logout button or user menu (and not on login page)
        if (!isLoginPage && (hasLogoutButton || hasUserMenu)) {
          logger.info(`[AuthManager] ✓ Login indicators found (logout button or user menu)`);
          await page.waitForTimeout(1000);
          return true;
        }

        // Success condition 2: Returned to target domain after visiting login page(s)
        // This handles multi-step OAuth flows (GitHub Pages → GitHub → Okta → back to GitHub Pages)
        if (isBackAtTargetDomain && wasOnLoginPage && !isLoginPage) {
          // We were redirected to login/IdP and now we're back on the target domain
          const bodyText = (await page.locator('body').textContent()) || '';
          // Make sure it's not an error page
          if (bodyText.length > 100 && !bodyText.includes('404') && !bodyText.includes('not found')) {
            logger.info(
              `[AuthManager] ✓ Returned to target domain (${currentDomain}) after login. Visited ${visitedDomains.size} domains during auth flow.`
            );
            // Wait a bit longer for any post-login redirects to settle
            await page.waitForTimeout(2000);

            // Double-check we're still on target domain after waiting
            const finalUrl = page.url();
            let finalDomain: string;
            try {
              finalDomain = new URL(finalUrl).hostname.toLowerCase();
            } catch {
              finalDomain = '';
            }

            if (finalDomain === targetDomain || finalDomain.endsWith('.' + targetDomain)) {
              logger.info(`[AuthManager] ✓ Confirmed on target domain: ${finalUrl}`);
              return true;
            } else {
              logger.debug(`[AuthManager] Redirected away from target domain after waiting, continuing...`);
            }
          }
        }

        // Wait a bit before checking again
        await page.waitForTimeout(1000);
      } catch (error) {
        // Page might have navigated, which is fine
        logger.debug(`[AuthManager] Error during login check (may be normal during navigation):`, error);
        await page.waitForTimeout(1000);
      }
    }

    logger.warn(`[AuthManager] Login detection timed out after ${timeoutSecs} seconds`);
    logger.warn(`[AuthManager] Visited domains during flow: ${Array.from(visitedDomains).join(', ')}`);
    return false;
  }

  /**
   * Create a browser context with saved authentication
   */
  async createAuthenticatedContext(
    url: string,
    browserType: BrowserType = 'chromium'
  ): Promise<{ browser: Browser; context: BrowserContext } | null> {
    const storageStateJson = await this.loadSession(url);

    if (!storageStateJson) {
      return null;
    }

    const launcher = this.getBrowserLauncher(browserType);
    const launchOptions = this.getLaunchOptions(browserType);

    const browser = await launcher.launch({
      headless: true,
      ...launchOptions,
    });

    const storageState = JSON.parse(storageStateJson);
    const context = await browser.newContext({ storageState });

    return { browser, context };
  }

  /**
   * Clean up any active browser instances
   */
  async cleanup(): Promise<void> {
    if (this.activeContext) {
      await this.activeContext.close().catch(() => {});
      this.activeContext = null;
    }
    if (this.activeBrowser) {
      await this.activeBrowser.close().catch(() => {});
      this.activeBrowser = null;
    }
  }
}
