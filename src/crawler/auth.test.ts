import { detectDefaultBrowser, AuthManager, type BrowserType } from './auth.js';
import { encryptData } from '../util/security.js';

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
    url = 'https://example.com',
    content = '<html><body>Welcome!</body></html>',
    bodyText = 'Welcome to the site',
  } = options;

  const mockPage = {
    goto: vi.fn().mockResolvedValue({ status: () => status }),
    url: vi.fn().mockReturnValue(url),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue(content),
    evaluate: vi.fn().mockResolvedValue(bodyText),
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };
  mockChromiumLaunch.mockResolvedValue(mockBrowser);

  return { mockPage, mockContext, mockBrowser };
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
        setupBrowserMock();

        const result = await authManager.validateSession('https://example.com');

        expect(result.isValid).toBe(true);
      });
    });
  });
});
