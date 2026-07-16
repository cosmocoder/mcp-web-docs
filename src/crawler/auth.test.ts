import { lookup } from 'node:dns/promises';

import { encryptData } from '../util/security.js';
import { detectDefaultBrowser, AuthManager, type BrowserType } from './auth.js';

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

interface BrowserMockOptions {
  status?: number;
  blocked?: boolean;
  url?: string;
  content?: string;
  bodyText?: string;
}

/**
 * Create an encrypted stored session for testing
 */
function createStoredSession(cookies: Cookie[], domain = 'example.com') {
  const storageState = { cookies };
  const encryptedStorageState = encryptData(JSON.stringify(storageState));

  return {
    domain,
    storageState: encryptedStorageState,
    createdAt: new Date().toISOString(),
    browser: 'chromium',
    version: 2,
  };
}

/**
 * Mock the file system to return a stored session
 */
function mockStoredSession(cookies: Cookie[], domain = 'example.com') {
  const storedSession = createStoredSession(cookies, domain);
  mockReadFile.mockResolvedValue(JSON.stringify(storedSession));
}

/**
 * Create browser mocks for session validation tests
 */
function setupBrowserMock(options: BrowserMockOptions = {}) {
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
    mainFrame,
  };
}

/**
 * Create test cookie with common defaults
 */
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
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockChmod.mockResolvedValue(undefined);
    });

    describe('initialize', () => {
      it('should create sessions directory', async () => {
        await authManager.initialize();

        expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('sessions'), { recursive: true });
      });
    });

    describe('hasSession', () => {
      it('should return true when session file exists', async () => {
        mockAccess.mockResolvedValue(undefined);

        const result = await authManager.hasSession('https://example.com/docs');
        expect(result).toBe(true);
      });

      it('should return false when session file does not exist', async () => {
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        const result = await authManager.hasSession('https://example.com/docs');
        expect(result).toBe(false);
      });

      it('should use domain for session path', async () => {
        mockAccess.mockResolvedValue(undefined);

        await authManager.hasSession('https://docs.example.com/path/page');

        expect(mockAccess).toHaveBeenCalledWith(expect.stringContaining('docs.example.com'));
      });
    });

    describe('loadSession', () => {
      it('should return null when session does not exist', async () => {
        mockReadFile.mockRejectedValue(new Error('ENOENT'));

        const result = await authManager.loadSession('https://example.com');
        expect(result).toBeNull();
      });

      it('should return null for invalid session data', async () => {
        mockReadFile.mockResolvedValue('invalid json');

        const result = await authManager.loadSession('https://example.com');
        expect(result).toBeNull();
      });

      it('should return null for session with invalid structure', async () => {
        mockReadFile.mockResolvedValue(JSON.stringify({ invalid: 'structure' }));

        const result = await authManager.loadSession('https://example.com');
        expect(result).toBeNull();
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
        const { mockBrowser, mockContext } = setupBrowserMock();

        await expect(authManager.createAuthenticatedContext('https://example.com')).resolves.toEqual({
          browser: mockBrowser,
          context: mockContext,
        });

        expect(mockBrowser.newContext).toHaveBeenCalledWith(
          expect.objectContaining({
            proxy: {
              server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
              bypass: '<-loopback>',
            },
          })
        );
        expect(mockBrowser.newContext.mock.calls[0][0]).not.toHaveProperty('serviceWorkers');
        expect(mockContext.route).not.toHaveBeenCalled();
        expect(mockContext.routeWebSocket).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
      });
    });

    describe('performInteractiveLogin', () => {
      it('uses the pinned proxy without changing service workers or registering routes', async () => {
        const { mockBrowser, mockContext } = setupBrowserMock();

        await authManager.performInteractiveLogin('https://example.com', {
          browser: 'chromium',
          loginSuccessPattern: 'example',
        });

        expect(mockBrowser.newContext).toHaveBeenCalledWith({
          viewport: { width: 1280, height: 800 },
          proxy: {
            server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
            bypass: '<-loopback>',
          },
        });
        expect(mockBrowser.newContext.mock.calls[0][0]).not.toHaveProperty('serviceWorkers');
        expect(mockContext.route).not.toHaveBeenCalled();
        expect(mockContext.routeWebSocket).not.toHaveBeenCalled();
      });

      it('does not wait for login when the proxy blocks the destination', async () => {
        const { mockPage } = setupBrowserMock({ status: 403, blocked: true });

        await expect(
          authManager.performInteractiveLogin('https://example.com', {
            browser: 'chromium',
            loginSuccessPattern: 'example',
          })
        ).rejects.toThrow('Blocked outbound destination');

        expect(mockPage.waitForURL).not.toHaveBeenCalled();
      });

      it.each([
        ['tagged response', 'Blocked outbound destination'],
        ['tunnel failure', 'Navigation failed: net::ERR_TUNNEL_CONNECTION_FAILED'],
      ])('rejects a main-frame %s emitted during goto', async (failureKind, expectedError) => {
        const { mockPage, emitResponse, emitRequestFailed, mainFrame } = setupBrowserMock();
        mockPage.goto.mockImplementation(async () => {
          if (failureKind === 'tagged response') {
            emitResponse({
              status: () => 403,
              headerValue: vi.fn().mockResolvedValue('1'),
              request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
            });
          }
          else {
            emitRequestFailed({
              isNavigationRequest: () => true,
              frame: () => mainFrame,
              failure: () => ({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }),
            });
          }
          return {
            status: () => 200,
            headerValue: vi.fn().mockResolvedValue(null),
          };
        });

        await expect(
          authManager.performInteractiveLogin('https://example.com', {
            browser: 'chromium',
            loginSuccessPattern: 'example',
          })
        ).rejects.toThrow(expectedError);

        expect(mockPage.waitForURL).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
        expect(mockPage.off).toHaveBeenCalledWith('response', expect.any(Function));
        expect(mockPage.off).toHaveBeenCalledWith('requestfailed', expect.any(Function));
      });

      it.each([
        ['blocked', 'http://127.0.0.1/login', 'Blocked outbound destination'],
        ['failed', 'https://8.8.8.8/login', 'Outbound destination unavailable'],
      ])('classifies an async %s requestfailed URL', async (_kind, failedUrl, expectedError) => {
        const { mockPage, emitRequestFailed, mainFrame } = setupBrowserMock();
        mockPage.goto.mockImplementation(async () => {
          emitRequestFailed({
            isNavigationRequest: () => true,
            frame: () => mainFrame,
            failure: () => ({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }),
            url: () => failedUrl,
          });
          return { status: () => 200, headerValue: vi.fn().mockResolvedValue(null) };
        });

        await expect(
          authManager.performInteractiveLogin('https://example.com', {
            browser: 'chromium',
            loginSuccessPattern: 'example',
          })
        ).rejects.toThrow(expectedError);

        expect(mockPage.waitForURL).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
      });

      it('awaits asynchronous requestfailed classification before continuing login', async () => {
        let resolveLookup!: (addresses: Array<{ address: string; family: 4 }>) => void;
        const pendingLookup = new Promise<Array<{ address: string; family: 4 }>>((resolve) => {
          resolveLookup = resolve;
        });
        vi.mocked(lookup).mockImplementationOnce(() => pendingLookup as never);
        const { mockPage, emitRequestFailed, mainFrame } = setupBrowserMock();
        mockPage.goto.mockImplementation(async () => {
          emitRequestFailed({
            isNavigationRequest: () => true,
            frame: () => mainFrame,
            failure: () => ({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }),
            url: () => 'https://redirected.example.com/login',
          });
          return { status: () => 200, headerValue: vi.fn().mockResolvedValue(null) };
        });

        const login = authManager.performInteractiveLogin('https://example.com', {
          browser: 'chromium',
          loginSuccessPattern: 'example',
        });
        let settled = false;
        void login.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        await vi.waitFor(() => expect(resolveLookup).toBeTypeOf('function'));
        expect(settled).toBe(false);

        resolveLookup([{ address: '127.0.0.1', family: 4 }]);
        await expect(login).rejects.toThrow('Blocked outbound destination');
      });

      it('awaits a deferred response marker before saving a successful login', async () => {
        const { mockPage, emitResponse, mainFrame } = setupBrowserMock();
        let finishWait!: () => void;
        mockPage.waitForURL.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finishWait = resolve;
            })
        );
        let resolveHeader!: (value: string | null) => void;
        const header = new Promise<string | null>((resolve) => {
          resolveHeader = resolve;
        });
        const login = authManager.performInteractiveLogin('https://example.com', {
          browser: 'chromium',
          loginSuccessPattern: 'example',
        });
        await vi.waitFor(() => expect(mockPage.waitForURL).toHaveBeenCalled());

        emitResponse({
          status: () => 403,
          headerValue: vi.fn().mockReturnValue(header),
          request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
        });
        finishWait();
        await Promise.resolve();
        await Promise.resolve();
        expect(mockWriteFile).not.toHaveBeenCalled();

        resolveHeader('1');

        await expect(login).rejects.toThrow('Blocked outbound destination');
        expect(mockWriteFile).not.toHaveBeenCalled();
      });

      it('fails closed when a login response marker cannot be inspected', async () => {
        const { mockPage, emitResponse, mainFrame } = setupBrowserMock();
        let finishWait!: () => void;
        mockPage.waitForURL.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finishWait = resolve;
            })
        );
        const login = authManager.performInteractiveLogin('https://example.com', {
          browser: 'chromium',
          loginSuccessPattern: 'example',
        });
        await vi.waitFor(() => expect(mockPage.waitForURL).toHaveBeenCalled());

        emitResponse({
          status: () => 403,
          headerValue: vi.fn().mockRejectedValue(new Error('headers unavailable')),
          request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
        });
        finishWait();

        await expect(login).rejects.toThrow('Failed to inspect outbound response: headers unavailable');
        expect(mockWriteFile).not.toHaveBeenCalled();
      });

      it('stops an OAuth wait when a later main-frame navigation is blocked', async () => {
        const { mockPage, emitResponse, mainFrame } = setupBrowserMock();
        let rejectWait!: (error: Error) => void;
        mockPage.waitForURL.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              rejectWait = reject;
            })
        );
        mockPage.close.mockImplementation(async () => rejectWait(new Error('Page closed')));
        const login = authManager.performInteractiveLogin('https://example.com', {
          browser: 'chromium',
          loginSuccessPattern: 'example',
        });
        await vi.waitFor(() => expect(mockPage.waitForURL).toHaveBeenCalled());

        let settled = false;
        void login.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        emitResponse({
          status: () => 403,
          headerValue: vi.fn().mockResolvedValue('1'),
          request: () => ({ isNavigationRequest: () => false, frame: () => mainFrame }),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        emitResponse({
          status: () => 403,
          headerValue: vi.fn().mockResolvedValue('1'),
          request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
        });

        await expect(login).rejects.toThrow('Blocked outbound destination');
        expect(mockPage.off).toHaveBeenCalledWith('response', expect.any(Function));
      });

      it('checks navigation policy after capturing storage state and before saving', async () => {
        const { mockPage, mockContext, emitResponse, mainFrame } = setupBrowserMock();
        let resolveHeader!: (value: string | null) => void;
        const blockedHeader = new Promise<string | null>((resolve) => {
          resolveHeader = resolve;
        });
        mockContext.storageState.mockImplementation(async () => {
          emitResponse({
            status: () => 403,
            headerValue: vi
              .fn()
              .mockImplementation((name: string) => (name === 'x-mcp-web-docs-blocked' ? blockedHeader : Promise.resolve(null))),
            request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
          });
          return { cookies: [], origins: [] };
        });
        const login = authManager.performInteractiveLogin('https://example.com', {
          browser: 'chromium',
          loginSuccessPattern: 'example',
        });
        await vi.waitFor(() => expect(mockContext.storageState).toHaveBeenCalled());
        await Promise.resolve();
        expect(mockWriteFile).not.toHaveBeenCalled();

        resolveHeader('1');

        await expect(login).rejects.toThrow('Blocked outbound destination');
        expect(mockWriteFile).not.toHaveBeenCalled();
        expect(mockPage.off).toHaveBeenCalledWith('response', expect.any(Function));
      });

      it('ignores an aborted OAuth navigation but stops on a later fatal tunnel failure', async () => {
        const { mockPage, emitRequestFailed, mainFrame } = setupBrowserMock();
        let rejectWait!: (error: Error) => void;
        mockPage.waitForURL.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              rejectWait = reject;
            })
        );
        mockPage.close.mockImplementation(async () => rejectWait(new Error('Page closed')));
        const login = authManager.performInteractiveLogin('https://example.com', {
          browser: 'chromium',
          loginSuccessPattern: 'example',
        });
        await vi.waitFor(() => expect(mockPage.waitForURL).toHaveBeenCalled());

        let settled = false;
        void login.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        emitRequestFailed({
          isNavigationRequest: () => false,
          frame: () => mainFrame,
          failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        for (const errorText of ['net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'Load request cancelled']) {
          emitRequestFailed({
            isNavigationRequest: () => true,
            frame: () => mainFrame,
            failure: () => ({ errorText }),
          });
          await Promise.resolve();
          expect(settled).toBe(false);
        }

        emitRequestFailed({
          isNavigationRequest: () => true,
          frame: () => mainFrame,
          failure: () => ({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }),
        });

        await expect(login).rejects.toThrow('Navigation failed: net::ERR_TUNNEL_CONNECTION_FAILED');
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

  describe('BrowserType', () => {
    it('should accept valid browser types', () => {
      const validTypes: BrowserType[] = ['chromium', 'chrome', 'firefox', 'webkit', 'edge'];

      validTypes.forEach((type) => {
        expect(typeof type).toBe('string');
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
      mockMkdir.mockResolvedValue(undefined);
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

      it('should detect expired cookies from stored session', async () => {
        mockStoredSession([createCookie({ name: 'session_token', expires: expiredTimestamp() })]);

        const result = await authManager.validateSession('https://example.com');

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('expired');
      });

      it('should detect expired auth-related cookies specifically', async () => {
        mockStoredSession([
          createCookie({ name: 'tracking_cookie', expires: validTimestamp() }),
          createCookie({ name: 'auth_token', expires: expiredTimestamp() }),
        ]);

        const result = await authManager.validateSession('https://example.com');

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('expired');
      });

      it('should handle cookies on parent domain (e.g., .example.com for sub.example.com)', async () => {
        mockStoredSession([createCookie({ name: 'auth_token', domain: '.example.com', expires: expiredTimestamp() })], 'sub.example.com');

        const result = await authManager.validateSession('https://sub.example.com');

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('expired');
      });

      it('should check all cookies when no domain-specific cookies found', async () => {
        // Auth cookies on different domain (e.g., github.com for github.io)
        mockStoredSession([createCookie({ name: 'user_session', domain: 'github.com', expires: expiredTimestamp() })], 'user.github.io');

        const result = await authManager.validateSession('https://user.github.io');

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
        const { mockPage, emitResponse, mainFrame } = setupBrowserMock();
        let emitted = false;
        mockPage.waitForLoadState.mockImplementation(async () => {
          if (!emitted) {
            emitted = true;
            emitResponse({
              status: () => 403,
              headerValue: vi.fn().mockResolvedValue('1'),
              request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
            });
          }
        });

        await expect(authManager.validateSessionOrThrow('https://example.com')).rejects.toThrow('Blocked outbound destination');
        expect(mockUnlink).not.toHaveBeenCalled();
        expect(mockPage.off).toHaveBeenCalledWith('response', expect.any(Function));
      });

      it('preserves the session when a post-load main-frame request fails', async () => {
        const { mockPage, emitRequestFailed, mainFrame } = setupBrowserMock();
        let emitted = false;
        mockPage.waitForLoadState.mockImplementation(async () => {
          if (!emitted) {
            emitted = true;
            emitRequestFailed({
              isNavigationRequest: () => true,
              frame: () => mainFrame,
              failure: () => ({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }),
            });
          }
        });

        await expect(authManager.validateSessionOrThrow('https://example.com')).rejects.toThrow(
          'Navigation failed: net::ERR_TUNNEL_CONNECTION_FAILED'
        );
        expect(mockUnlink).not.toHaveBeenCalled();
        expect(mockPage.off).toHaveBeenCalledWith('requestfailed', expect.any(Function));
      });

      it('fails closed without deleting the session when a validation marker cannot be inspected', async () => {
        const { mockPage, emitResponse, mainFrame } = setupBrowserMock();
        let emitted = false;
        mockPage.waitForLoadState.mockImplementation(async () => {
          if (!emitted) {
            emitted = true;
            emitResponse({
              status: () => 403,
              headerValue: vi.fn().mockRejectedValue(new Error('headers unavailable')),
              request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
            });
          }
        });

        await expect(authManager.validateSessionOrThrow('https://example.com')).rejects.toThrow(
          'Failed to inspect outbound response: headers unavailable'
        );
        expect(mockUnlink).not.toHaveBeenCalled();
      });

      it('preserves the session when a blocked marker resolves during content inspection', async () => {
        const { mockPage, emitResponse, mainFrame } = setupBrowserMock();
        let resolveHeader!: (value: string | null) => void;
        const header = new Promise<string | null>((resolve) => {
          resolveHeader = resolve;
        });
        mockPage.content.mockImplementation(async () => {
          emitResponse({
            status: () => 403,
            headerValue: vi.fn().mockReturnValue(header),
            request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
          });
          return '<html><body>Welcome!</body></html>';
        });
        mockPage.evaluate.mockImplementation(async () => {
          resolveHeader('1');
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
        const { mockContext, mockBrowser } = setupBrowserMock();

        const result = await authManager.validateSession('https://example.com');

        expect(result.isValid).toBe(true);
        expect(mockBrowser.newContext).toHaveBeenCalledWith(
          expect.objectContaining({
            proxy: {
              server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
              bypass: '<-loopback>',
            },
          })
        );
        expect(mockBrowser.newContext.mock.calls[0][0]).not.toHaveProperty('serviceWorkers');
        expect(mockContext.route).not.toHaveBeenCalled();
        expect(mockContext.routeWebSocket).not.toHaveBeenCalled();
      });
    });
  });
});
