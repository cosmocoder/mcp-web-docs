import { chromium, firefox, webkit, Browser, BrowserContext, Page } from 'playwright';
import { mkdir, readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import defaultBrowser from 'default-browser';
import { logger } from '../util/logger.js';

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
  } catch (error: any) {
    logger.error(`[Auth] ✗ default-browser package threw an error:`);
    logger.error(`[Auth]   Error name: ${error?.name}`);
    logger.error(`[Auth]   Error message: ${error?.message}`);
    logger.error(`[Auth]   Error stack: ${error?.stack}`);
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

/** Session storage for authenticated domains */
interface StoredSession {
  domain: string;
  storageState: string; // JSON string of cookies/localStorage
  createdAt: string;
  browser: BrowserType;
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
   * Get the session file path for a domain
   */
  private getSessionPath(domain: string): string {
    // Sanitize domain for filename
    const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '_');
    return join(this.sessionsDir, `${safeDomain}.json`);
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
   */
  async loadSession(url: string): Promise<string | null> {
    const domain = new URL(url).hostname;
    const sessionPath = this.getSessionPath(domain);
    try {
      const data = await readFile(sessionPath, 'utf-8');
      const session: StoredSession = JSON.parse(data);
      logger.info(`[AuthManager] Loaded saved session for ${domain}`);
      return session.storageState;
    } catch {
      return null;
    }
  }

  /**
   * Save a session for a domain
   */
  private async saveSession(url: string, storageState: string, browser: BrowserType): Promise<void> {
    const domain = new URL(url).hostname;
    const sessionPath = this.getSessionPath(domain);

    const session: StoredSession = {
      domain,
      storageState,
      createdAt: new Date().toISOString(),
      browser
    };

    await writeFile(sessionPath, JSON.stringify(session, null, 2));
    logger.info(`[AuthManager] Saved session for ${domain}`);
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
  async performInteractiveLogin(
    url: string,
    options: AuthOptions = {}
  ): Promise<string> {
    let {
      browser: browserType,
      loginSuccessPattern,
      loginSuccessSelector,
      loginUrl,
      loginTimeoutSecs = 300 // 5 minutes default
    } = options;

    logger.info(`[AuthManager] === Starting Interactive Login ===`);
    logger.info(`[AuthManager] Target URL: ${url}`);
    logger.info(`[AuthManager] Options: browser=${browserType || 'auto-detect'}, loginUrl=${loginUrl || 'same as target'}, timeout=${loginTimeoutSecs}s`);

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
      loginTimeoutSecs
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
        ...launchOptions
      });
      logger.info(`[AuthManager] ✓ Browser launched successfully`);

      this.activeContext = await this.activeBrowser.newContext({
        viewport: { width: 1280, height: 800 }
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
        successPattern: loginSuccessPattern,
        successSelector: loginSuccessSelector,
        timeoutSecs: loginTimeoutSecs
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
   * 3. Default: poll for common login success indicators (logout button, user menu, URL change)
   */
  private async waitForLogin(
    page: Page,
    options: {
      successPattern?: string;
      successSelector?: string;
      timeoutSecs: number;
    }
  ): Promise<boolean> {
    const { successPattern, successSelector, timeoutSecs } = options;
    const startTime = Date.now();
    const timeoutMs = timeoutSecs * 1000;

    logger.debug(`[AuthManager] Login detection method: ${
      successPattern ? `URL pattern: ${successPattern}` :
      successSelector ? `CSS selector: ${successSelector}` :
      'auto-detect (looking for logout button, user menu, or URL change)'
    }`);

    // If we have specific success criteria, wait for them
    if (successPattern) {
      const pattern = new RegExp(successPattern);
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
    logger.info(`[AuthManager] The browser will stay open until you login or ${timeoutSecs} seconds pass.`);
    let lastLogTime = 0;

    // Track the initial URL to detect navigation
    const initialUrl = page.url();
    let hasNavigatedAway = false;
    let wasOnLoginPage = false;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const currentUrl = page.url();
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        // Log status every 10 seconds
        if (elapsed - lastLogTime >= 10) {
          logger.info(`[AuthManager] Still waiting for login... (${elapsed}s elapsed, current URL: ${currentUrl})`);
          lastLogTime = elapsed;
        }

        // Check if we're on a login-like page
        const isLoginPage = /login|signin|sign-in|auth|sso|oauth|session/i.test(currentUrl);

        // Track if we've been to a login page (to know when we've successfully logged in)
        if (isLoginPage) {
          wasOnLoginPage = true;
          logger.debug(`[AuthManager] Detected login page: ${currentUrl}`);
        }

        // Track navigation away from initial URL
        if (currentUrl !== initialUrl && !hasNavigatedAway) {
          hasNavigatedAway = true;
          logger.debug(`[AuthManager] Navigation detected: ${initialUrl} → ${currentUrl}`);
        }

        // Check for common logged-in indicators
        const hasLogoutButton = await page.locator('text=/log\\s*out|sign\\s*out/i').count() > 0;
        const hasUserMenu = await page.locator('[class*="user"], [class*="avatar"], [class*="profile"]').count() > 0;

        // Only consider login successful if:
        // 1. We're not on a login page, AND
        // 2. We have logged-in indicators OR we were on a login page and navigated away
        if (!isLoginPage && (hasLogoutButton || hasUserMenu)) {
          logger.info(`[AuthManager] ✓ Login indicators found (logout button or user menu)`);
          await page.waitForTimeout(1000);
          return true;
        }

        // For GitHub Pages: only consider successful if we were on login page and came back
        if (currentUrl.includes('github.io') && wasOnLoginPage && !isLoginPage) {
          // We were redirected to login and now we're back on the github.io page
          const bodyText = await page.locator('body').textContent() || '';
          // Make sure it's not an error page
          if (bodyText.length > 100 && !bodyText.includes('404') && !bodyText.includes('not found')) {
            logger.info(`[AuthManager] ✓ Returned to GitHub Pages after login`);
            await page.waitForTimeout(1000);
            return true;
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
      ...launchOptions
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

