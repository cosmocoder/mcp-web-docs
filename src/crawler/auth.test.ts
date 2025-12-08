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

describe('Auth Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectDefaultBrowser', () => {
    it('should detect Firefox', async () => {
      mockDefaultBrowser.mockResolvedValue({ name: 'Firefox', id: 'firefox' });

      const result = await detectDefaultBrowser();
      expect(result).toBe('firefox');
    });

    it('should detect Chrome', async () => {
      mockDefaultBrowser.mockResolvedValue({ name: 'Google Chrome', id: 'com.google.chrome' });

      const result = await detectDefaultBrowser();
      expect(result).toBe('chrome');
    });

    it('should detect Edge', async () => {
      mockDefaultBrowser.mockResolvedValue({ name: 'Microsoft Edge', id: 'microsoft-edge' });

      const result = await detectDefaultBrowser();
      expect(result).toBe('edge');
    });

    it('should detect Safari as webkit', async () => {
      mockDefaultBrowser.mockResolvedValue({ name: 'Safari', id: 'com.apple.safari' });

      const result = await detectDefaultBrowser();
      expect(result).toBe('webkit');
    });

    it('should detect Chromium', async () => {
      mockDefaultBrowser.mockResolvedValue({ name: 'Chromium', id: 'chromium-browser' });

      const result = await detectDefaultBrowser();
      expect(result).toBe('chromium');
    });

    it('should fall back to chromium for unknown browser', async () => {
      mockDefaultBrowser.mockResolvedValue({ name: 'Unknown Browser', id: 'unknown' });

      const result = await detectDefaultBrowser();
      expect(result).toBe('chromium');
    });

    it('should fall back to chromium on error', async () => {
      mockDefaultBrowser.mockRejectedValue(new Error('Detection failed'));

      const result = await detectDefaultBrowser();
      expect(result).toBe('chromium');
    });

    it('should be case-insensitive', async () => {
      mockDefaultBrowser.mockResolvedValue({ name: 'FIREFOX', id: 'FIREFOX' });

      const result = await detectDefaultBrowser();
      expect(result).toBe('firefox');
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
});
