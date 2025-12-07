import { chromium, firefox, webkit, Browser, BrowserContext, Page } from 'playwright';
import { mkdir, readFile, writeFile, access, chmod } from 'fs/promises';
import { join, resolve } from 'path';
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
  type ValidatedStoredSession,
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

    logger.debug(
      `[AuthManager] Login detection method: ${
        successPattern
          ? `URL pattern: ${successPattern}`
          : successSelector
            ? `CSS selector: ${successSelector}`
            : 'auto-detect (looking for logout button, user menu, or URL change)'
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
        const hasLogoutButton = (await page.locator('text=/log\\s*out|sign\\s*out/i').count()) > 0;
        const hasUserMenu = (await page.locator('[class*="user"], [class*="avatar"], [class*="profile"]').count()) > 0;

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
          const bodyText = (await page.locator('body').textContent()) || '';
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
