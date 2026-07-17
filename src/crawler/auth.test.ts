import { lookup } from 'node:dns/promises';

import { encryptData } from '../util/security.js';
import { detectDefaultBrowser, AuthManager } from './auth.js';

const { mockDefaultBrowser, mockMkdir, mockReadFile, mockWriteFile, mockAccess, mockChmod, mockUnlink, mockChromiumLaunch } = vi.hoisted(
  () => ({
    mockDefaultBrowser: vi.fn(),
    mockMkdir: vi.fn(),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockAccess: vi.fn(),
    mockChmod: vi.fn(),
    mockUnlink: vi.fn(),
    mockChromiumLaunch: vi.fn(),
  })
);

vi.mock('default-browser', () => ({
  default: mockDefaultBrowser,
}));

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  access: mockAccess,
  chmod: mockChmod,
  unlink: mockUnlink,
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: mockChromiumLaunch,
  },
  firefox: {
    launch: vi.fn(),
  },
  webkit: {
    launch: vi.fn(),
  },
}));

// ============ Test Helpers ============

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockStoredSession(cookies: Cookie[], domain = 'example.com') {
  mockReadFile.mockResolvedValue(
    JSON.stringify({
      domain,
      storageState: encryptData(JSON.stringify({ cookies })),
      createdAt: new Date().toISOString(),
      browser: 'chromium',
      version: 2,
    })
  );
}

function setupBrowserMock(options: { status?: number; blocked?: boolean; url?: string; content?: string; bodyText?: string } = {}) {
  const {
    status = 200,
    blocked = false,
    url = 'https://example.com',
    content = '<html><body>Welcome!</body></html>',
    bodyText = 'Welcome to the site',
  } = options;
  const mainFrame = {};
  const responseListeners = new Set<(response: Record<string, unknown>) => void>();
  const requestFailedListeners = new Set<(request: Record<string, unknown>) => void>();

  const mockPage = {
    goto: vi.fn().mockResolvedValue({
      status: () => status,
      headerValue: vi.fn().mockImplementation(async (name: string) => (blocked && name === 'x-mcp-web-docs-blocked' ? '1' : null)),
    }),
    url: vi.fn().mockReturnValue(url),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue(content),
    evaluate: vi.fn().mockResolvedValue(bodyText),
    close: vi.fn().mockResolvedValue(undefined),
    mainFrame: vi.fn().mockReturnValue(mainFrame),
    on: vi.fn((event: string, listener: (response: Record<string, unknown>) => void) => {
      if (event === 'response') {
        responseListeners.add(listener);
      }
      else if (event === 'requestfailed') {
        requestFailedListeners.add(listener);
      }
    }),
    off: vi.fn((event: string, listener: (response: Record<string, unknown>) => void) => {
      if (event === 'response') {
        responseListeners.delete(listener);
      }
      else if (event === 'requestfailed') {
        requestFailedListeners.delete(listener);
      }
    }),
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    route: vi.fn().mockResolvedValue(undefined),
    routeWebSocket: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };
  mockChromiumLaunch.mockResolvedValue(mockBrowser);

  return {
    mockPage,
    mockContext,
    mockBrowser,
    emitResponse: (response: Record<string, unknown>) => responseListeners.forEach((listener) => listener(response)),
    emitRequestFailed: (request: Record<string, unknown>) => requestFailedListeners.forEach((listener) => listener(request)),
    navigationResponse: ({ headerValue = '1', navigation = true }: { headerValue?: unknown; navigation?: boolean } = {}) => ({
      status: () => 403,
      headerValue: vi.fn().mockReturnValue(headerValue),
      request: () => ({ isNavigationRequest: () => navigation, frame: () => mainFrame }),
    }),
    failedNavigation: ({
      errorText = 'net::ERR_TUNNEL_CONNECTION_FAILED',
      navigation = true,
      url = 'https://8.8.8.8/login',
    }: { errorText?: string; navigation?: boolean; url?: string } = {}) => ({
      isNavigationRequest: () => navigation,
      frame: () => mainFrame,
      failure: () => ({ errorText }),
      url: () => url,
    }),
    expectPinnedProxy: (expected: Record<string, unknown> = {}, exact = false) => {
      const contextOptions = {
        ...expected,
        proxy: {
          server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
          bypass: '<-loopback>',
        },
      };
      expect(mockBrowser.newContext).toHaveBeenCalledWith(exact ? contextOptions : expect.objectContaining(contextOptions));
      expect(mockBrowser.newContext.mock.calls[0][0]).not.toHaveProperty('serviceWorkers');
      expect(mockContext.route).not.toHaveBeenCalled();
      expect(mockContext.routeWebSocket).not.toHaveBeenCalled();
    },
  };
}

function performLogin(authManager: AuthManager) {
  return authManager.performInteractiveLogin('https://example.com', {
    browser: 'chromium',
    loginSuccessPattern: 'example',
  });
}

function trackSettlement(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  return () => settled;
}

function createCookie(overrides: Partial<Cookie> = {}): Cookie {
  return {
    name: 'session_id',
    value: 'session-value',
    domain: 'example.com',
    path: '/',
    ...overrides,
  };
}

// ============ Tests ============

describe('Auth Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectDefaultBrowser', () => {
    it.each([
      [{ name: 'Firefox', id: 'firefox' }, 'firefox'],
      [{ name: 'Google Chrome', id: 'com.google.chrome' }, 'chrome'],
      [{ name: 'Microsoft Edge', id: 'microsoft-edge' }, 'edge'],
      [{ name: 'Safari', id: 'com.apple.safari' }, 'webkit'],
      [{ name: 'Chromium', id: 'chromium-browser' }, 'chromium'],
      [{ name: 'Unknown Browser', id: 'unknown' }, 'chromium'],
      [{ name: 'FIREFOX', id: 'FIREFOX' }, 'firefox'], // case-insensitive
    ])('should detect %o as %s', async (browserInfo, expected) => {
      mockDefaultBrowser.mockResolvedValue(browserInfo);
      const result = await detectDefaultBrowser();
      expect(result).toBe(expected);
    });

    it('should fall back to chromium on error', async () => {
      mockDefaultBrowser.mockRejectedValue(new Error('Detection failed'));

      const result = await detectDefaultBrowser();
      expect(result).toBe('chromium');
    });
  });

  describe('AuthManager', () => {
    let authManager: AuthManager;

    beforeEach(() => {
      authManager = new AuthManager('/tmp/test-data');
    });

    describe('initialize', () => {
      it('should create sessions directory', async () => {
        await authManager.initialize();

        expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('sessions'), { recursive: true });
      });
    });

    describe('hasSession', () => {
      it('should return true and use the URL domain when the session file exists', async () => {
        mockAccess.mockResolvedValue(undefined);

        const result = await authManager.hasSession('https://docs.example.com/path/page');

        expect(result).toBe(true);
        expect(mockAccess).toHaveBeenCalledWith(expect.stringContaining('docs.example.com'));
      });

      it('should return false when session file does not exist', async () => {
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        await expect(authManager.hasSession('https://example.com/docs')).resolves.toBe(false);
      });
    });

    describe('loadSession', () => {
      it.each([
        { label: 'missing file', input: new Error('ENOENT') },
        { label: 'invalid JSON', input: 'invalid json' },
        { label: 'invalid structure', input: JSON.stringify({ invalid: 'structure' }) },
      ])('should return null for $label', async ({ input }) => {
        if (input instanceof Error) {
          mockReadFile.mockRejectedValue(input);
        }
        else {
          mockReadFile.mockResolvedValue(input);
        }

        await expect(authManager.loadSession('https://example.com')).resolves.toBeNull();
      });
    });

    describe('createAuthenticatedContext', () => {
      it('returns null without DNS or browser setup when no saved session exists', async () => {
        mockReadFile.mockRejectedValue(new Error('ENOENT'));

        await expect(authManager.createAuthenticatedContext('https://example.com')).resolves.toBeNull();

        expect(lookup).not.toHaveBeenCalled();
        expect(mockChromiumLaunch).not.toHaveBeenCalled();
      });

      it('uses the pinned proxy without changing service workers or registering routes', async () => {
        mockStoredSession([]);
        const { mockBrowser, mockContext, expectPinnedProxy } = setupBrowserMock();

        await expect(authManager.createAuthenticatedContext('https://example.com')).resolves.toEqual({
          browser: mockBrowser,
          context: mockContext,
        });

        expectPinnedProxy();
        expect(lookup).not.toHaveBeenCalled();
      });
    });

    describe('performInteractiveLogin', () => {
      it('uses the pinned proxy without changing service workers or registering routes', async () => {
        const { expectPinnedProxy } = setupBrowserMock();

        await performLogin(authManager);

        expectPinnedProxy({ viewport: { width: 1280, height: 800 } }, true);
      });

      it('does not wait for login when the proxy blocks the destination', async () => {
        const { mockPage } = setupBrowserMock({ status: 403, blocked: true });

        await expect(performLogin(authManager)).rejects.toThrow('Blocked outbound destination');

        expect(mockPage.waitForURL).not.toHaveBeenCalled();
      });

      it.each([
        ['tagged response', 'Blocked outbound destination'],
        ['tunnel failure', 'Outbound destination unavailable'],
      ])('rejects a main-frame %s emitted during goto', async (failureKind, expectedError) => {
        const { mockPage, emitResponse, emitRequestFailed, navigationResponse, failedNavigation } = setupBrowserMock();
        mockPage.goto.mockImplementation(async () => {
          if (failureKind === 'tagged response') {
            emitResponse(navigationResponse());
          }
          else {
            emitRequestFailed(failedNavigation());
          }
          return {
            status: () => 200,
            headerValue: vi.fn().mockResolvedValue(null),
          };
        });

        await expect(performLogin(authManager)).rejects.toThrow(expectedError);

        expect(mockPage.waitForURL).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
        expect(mockPage.off).toHaveBeenCalledWith('response', expect.any(Function));
        expect(mockPage.off).toHaveBeenCalledWith('requestfailed', expect.any(Function));
      });

      it.each([
        ['blocked', 'http://127.0.0.1/login', 'Blocked outbound destination'],
        ['failed', 'https://8.8.8.8/login', 'Outbound destination unavailable'],
      ])('classifies an async %s requestfailed URL', async (_kind, failedUrl, expectedError) => {
        const { mockPage, emitRequestFailed, failedNavigation } = setupBrowserMock();
        mockPage.goto.mockImplementation(async () => {
          emitRequestFailed(failedNavigation({ url: failedUrl }));
          return { status: () => 200, headerValue: vi.fn().mockResolvedValue(null) };
        });

        await expect(performLogin(authManager)).rejects.toThrow(expectedError);

        expect(mockPage.waitForURL).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
      });

      it('awaits asynchronous requestfailed classification before continuing login', async () => {
        const pendingLookup = deferred<Array<{ address: string; family: 4 }>>();
        vi.mocked(lookup).mockImplementationOnce(() => pendingLookup.promise as never);
        const { mockPage, emitRequestFailed, failedNavigation } = setupBrowserMock();
        mockPage.goto.mockImplementation(async () => {
          emitRequestFailed(failedNavigation({ url: 'https://redirected.example.com/login' }));
          return { status: () => 200, headerValue: vi.fn().mockResolvedValue(null) };
        });

        const login = performLogin(authManager);
        const isSettled = trackSettlement(login);
        await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
        expect(isSettled()).toBe(false);

        pendingLookup.resolve([{ address: '127.0.0.1', family: 4 }]);
        await expect(login).rejects.toThrow('Blocked outbound destination');
      });

      it('awaits a deferred response marker before saving a successful login', async () => {
        const { mockPage, emitResponse, navigationResponse } = setupBrowserMock();
        const wait = deferred<void>();
        mockPage.waitForURL.mockImplementation(() => wait.promise);
        const header = deferred<string | null>();
        const login = performLogin(authManager);
        await vi.waitFor(() => expect(mockPage.waitForURL).toHaveBeenCalled());

        emitResponse(navigationResponse({ headerValue: header.promise }));
        wait.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(mockWriteFile).not.toHaveBeenCalled();

        header.resolve('1');

        await expect(login).rejects.toThrow('Blocked outbound destination');
        expect(mockWriteFile).not.toHaveBeenCalled();
      });

      it('fails closed when a login response marker cannot be inspected', async () => {
        const { mockPage, emitResponse, navigationResponse } = setupBrowserMock();
        const wait = deferred<void>();
        mockPage.waitForURL.mockImplementation(() => wait.promise);
        const login = performLogin(authManager);
        await vi.waitFor(() => expect(mockPage.waitForURL).toHaveBeenCalled());

        emitResponse(navigationResponse({ headerValue: Promise.reject(new Error('headers unavailable')) }));
        wait.resolve();

        await expect(login).rejects.toThrow('Failed to inspect outbound response: headers unavailable');
        expect(mockWriteFile).not.toHaveBeenCalled();
      });

      it('stops an OAuth wait when a later main-frame navigation is blocked', async () => {
        const { mockPage, emitResponse, navigationResponse } = setupBrowserMock();
        const wait = deferred<void>();
        mockPage.waitForURL.mockImplementation(() => wait.promise);
        mockPage.close.mockImplementation(async () => wait.reject(new Error('Page closed')));
        const login = performLogin(authManager);
        await vi.waitFor(() => expect(mockPage.waitForURL).toHaveBeenCalled());

        const isSettled = trackSettlement(login);
        emitResponse(navigationResponse({ navigation: false }));
        await Promise.resolve();
        await Promise.resolve();
        expect(isSettled()).toBe(false);

        emitResponse(navigationResponse());

        await expect(login).rejects.toThrow('Blocked outbound destination');
        expect(mockPage.off).toHaveBeenCalledWith('response', expect.any(Function));
      });

      it('checks navigation policy after capturing storage state and before saving', async () => {
        const { mockPage, mockContext, emitResponse, navigationResponse } = setupBrowserMock();
        const blockedHeader = deferred<string | null>();
        mockContext.storageState.mockImplementation(async () => {
          emitResponse(navigationResponse({ headerValue: blockedHeader.promise }));
          return { cookies: [], origins: [] };
        });
        const login = performLogin(authManager);
        await vi.waitFor(() => expect(mockContext.storageState).toHaveBeenCalled());
        await Promise.resolve();
        expect(mockWriteFile).not.toHaveBeenCalled();

        blockedHeader.resolve('1');

        await expect(login).rejects.toThrow('Blocked outbound destination');
        expect(mockWriteFile).not.toHaveBeenCalled();
        expect(mockPage.off).toHaveBeenCalledWith('response', expect.any(Function));
      });

      it('ignores an aborted OAuth navigation but stops on a later fatal tunnel failure', async () => {
        const { mockPage, emitRequestFailed, failedNavigation } = setupBrowserMock();
        const wait = deferred<void>();
        mockPage.waitForURL.mockImplementation(() => wait.promise);
        mockPage.close.mockImplementation(async () => wait.reject(new Error('Page closed')));
        const login = performLogin(authManager);
        await vi.waitFor(() => expect(mockPage.waitForURL).toHaveBeenCalled());

        const isSettled = trackSettlement(login);
        emitRequestFailed(failedNavigation({ errorText: 'net::ERR_CONNECTION_REFUSED', navigation: false }));
        await Promise.resolve();
        expect(isSettled()).toBe(false);

        for (const errorText of ['net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'Load request cancelled']) {
          emitRequestFailed(failedNavigation({ errorText }));
          await Promise.resolve();
          expect(isSettled()).toBe(false);
        }

        emitRequestFailed(failedNavigation());

        await expect(login).rejects.toThrow('Outbound destination unavailable');
        expect(mockPage.off).toHaveBeenCalledWith('response', expect.any(Function));
        expect(mockPage.off).toHaveBeenCalledWith('requestfailed', expect.any(Function));
      });
    });

    describe('clearSession', () => {
      it('should delete session file', async () => {
        mockUnlink.mockResolvedValue(undefined);

        await authManager.clearSession('https://example.com');

        expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('example.com'));
      });

      it('should not throw when session does not exist', async () => {
        mockUnlink.mockRejectedValue(new Error('ENOENT'));

        await expect(authManager.clearSession('https://nonexistent.com')).resolves.not.toThrow();
      });
    });

    describe('getSessionPath (security)', () => {
      it('should sanitize domain names', async () => {
        mockAccess.mockResolvedValue(undefined);

        await authManager.hasSession('https://example.com/../../../etc/passwd');

        // Should not contain path traversal sequences
        const calledPath = mockAccess.mock.calls[0][0] as string;
        expect(calledPath).not.toContain('..');
        expect(calledPath).not.toContain('etc');
        expect(calledPath).not.toContain('passwd');
      });

      it('should reject invalid domain names', async () => {
        // The URL constructor will throw for completely invalid URLs
        await expect(authManager.hasSession('not-a-url')).rejects.toThrow();
      });

      it('should convert domain to lowercase', async () => {
        mockAccess.mockResolvedValue(undefined);

        await authManager.hasSession('https://EXAMPLE.COM');

        expect(mockAccess).toHaveBeenCalledWith(expect.stringContaining('example.com'));
      });
    });

    describe('cleanup', () => {
      it('should not throw when no active browser', async () => {
        await expect(authManager.cleanup()).resolves.not.toThrow();
      });
    });
  });

  it.each(['http://127.0.0.1/login', 'http://[::1]/login'])(
    'rejects private custom login URL %s before launching a browser',
    async (loginUrl) => {
      const authManager = new AuthManager('/tmp/test-data');

      await expect(authManager.performInteractiveLogin('https://example.com', { loginUrl })).rejects.toThrow('not allowed');
      expect(mockChromiumLaunch).not.toHaveBeenCalled();
    }
  );

  describe('validateSession', () => {
    let authManager: AuthManager;

    beforeEach(() => {
      authManager = new AuthManager('/tmp/test-data');
    });

    it('should return isValid=false when no session exists', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await authManager.validateSession('https://example.com');

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('No stored session');
    });

    describe('cookie expiration detection', () => {
      const expiredTimestamp = () => Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const validTimestamp = () => Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      it.each([
        {
          label: 'an unrelated cookie is still valid',
          cookies: () => [
            createCookie({ name: 'tracking_cookie', expires: validTimestamp() }),
            createCookie({ name: 'auth_token', expires: expiredTimestamp() }),
          ],
          domain: 'example.com',
        },
        {
          label: 'the cookie belongs to a parent domain',
          cookies: () => [createCookie({ name: 'auth_token', domain: '.example.com', expires: expiredTimestamp() })],
          domain: 'sub.example.com',
        },
        {
          label: 'no target-domain cookie exists',
          cookies: () => [createCookie({ name: 'user_session', domain: 'github.com', expires: expiredTimestamp() })],
          domain: 'user.github.io',
        },
      ])('should detect expired auth cookies when $label', async ({ cookies, domain }) => {
        mockStoredSession(cookies(), domain);

        const result = await authManager.validateSession(`https://${domain}`);

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('expired');
      });
    });

    describe('session cookies (no expiration)', () => {
      it.each([
        ['no expires field', undefined],
        ['expires=-1', -1],
        ['expires=0', 0],
      ])('should treat cookies with %s as valid session cookies', async (_description, expiresValue) => {
        const cookie = createCookie();
        if (expiresValue !== undefined) {
          cookie.expires = expiresValue;
        }
        mockStoredSession([cookie]);
        setupBrowserMock();

        const result = await authManager.validateSession('https://example.com');

        // Session cookies pass cookie check, browser validation determines validity
        expect(result.isValid).toBe(true);
      });
    });

    describe('browser-based validation', () => {
      beforeEach(() => {
        // All browser validation tests need a session with non-expiring cookies
        mockStoredSession([createCookie()]);
      });

      it.each([
        [401, 'Unauthorized'],
        [403, 'Forbidden'],
      ])('should detect HTTP %i response as expired session', async (statusCode, bodyText) => {
        setupBrowserMock({
          status: statusCode,
          content: `<html><body>${bodyText}</body></html>`,
          bodyText,
        });

        const result = await authManager.validateSession('https://example.com');

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain(String(statusCode));
      });

      it('does not classify a proxy policy rejection as expired credentials', async () => {
        setupBrowserMock({ status: 403, blocked: true });

        await expect(authManager.validateSession('https://example.com')).rejects.toThrow('Blocked outbound destination');
      });

      it('preserves the session when a post-load main-frame response is proxy-blocked', async () => {
        const { mockPage, emitResponse, navigationResponse } = setupBrowserMock();
        mockPage.waitForLoadState.mockImplementation(async () => {
          emitResponse(navigationResponse());
        });

        await expect(authManager.validateSessionOrThrow('https://example.com')).rejects.toThrow('Blocked outbound destination');
        expect(mockUnlink).not.toHaveBeenCalled();
        expect(mockPage.off).toHaveBeenCalledWith('response', expect.any(Function));
      });

      it('preserves the session when a post-load main-frame request fails', async () => {
        const { mockPage, emitRequestFailed, failedNavigation } = setupBrowserMock();
        mockPage.waitForLoadState.mockImplementation(async () => {
          emitRequestFailed(failedNavigation());
        });

        await expect(authManager.validateSessionOrThrow('https://example.com')).rejects.toThrow('Outbound destination unavailable');
        expect(mockUnlink).not.toHaveBeenCalled();
        expect(mockPage.off).toHaveBeenCalledWith('requestfailed', expect.any(Function));
      });

      it('fails closed without deleting the session when a validation marker cannot be inspected', async () => {
        const { mockPage, emitResponse, navigationResponse } = setupBrowserMock();
        mockPage.waitForLoadState.mockImplementation(async () => {
          emitResponse(navigationResponse({ headerValue: Promise.reject(new Error('headers unavailable')) }));
        });

        await expect(authManager.validateSessionOrThrow('https://example.com')).rejects.toThrow(
          'Failed to inspect outbound response: headers unavailable'
        );
        expect(mockUnlink).not.toHaveBeenCalled();
      });

      it('preserves the session when a blocked marker resolves during content inspection', async () => {
        const { mockPage, emitResponse, navigationResponse } = setupBrowserMock();
        const header = deferred<string | null>();
        mockPage.content.mockImplementation(async () => {
          emitResponse(navigationResponse({ headerValue: header.promise }));
          return '<html><body>Welcome!</body></html>';
        });
        mockPage.evaluate.mockImplementation(async () => {
          header.resolve('1');
          return 'Welcome to the site';
        });

        await expect(authManager.validateSessionOrThrow('https://example.com')).rejects.toThrow('Blocked outbound destination');
        expect(mockUnlink).not.toHaveBeenCalled();
      });

      it('should detect redirect to external login page as expired session', async () => {
        setupBrowserMock({
          url: 'https://company.okta.com/login',
          content: '<html><body>Sign In</body></html>',
          bodyText: 'Sign In to continue',
        });

        const result = await authManager.validateSession('https://example.com');

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('login');
        expect(result.finalUrl).toBe('https://company.okta.com/login');
      });

      it('should detect login page content in response as expired session', async () => {
        const loginPageContent = `
          <html>
            <body>
              <h1>Sign In Required</h1>
              <form>
                <input type="text" placeholder="Username">
                <input type="password" placeholder="Password">
                <button>Sign In</button>
              </form>
              <a href="/forgot-password">Forgot your password?</a>
            </body>
          </html>
        `;
        setupBrowserMock({
          url: 'https://example.com/app',
          content: loginPageContent,
          bodyText: 'Sign In Required Username Password Sign In Forgot your password?',
        });

        const result = await authManager.validateSession('https://example.com');

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('Login page detected');
        expect(result.loginDetection?.isLoginPage).toBe(true);
      });

      it('should handle validation errors gracefully', async () => {
        mockChromiumLaunch.mockRejectedValue(new Error('Browser launch failed'));

        const result = await authManager.validateSession('https://example.com');

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('Validation failed');
      });

      it('should consider session valid when page loads successfully', async () => {
        const { expectPinnedProxy } = setupBrowserMock();

        const result = await authManager.validateSession('https://example.com');

        expect(result.isValid).toBe(true);
        expectPinnedProxy();
      });
    });
  });
});
