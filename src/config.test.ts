import { isValidUrl, isValidPublicUrl, normalizeUrl, isGitHubUrl, RATE_LIMIT } from './config.js';

describe('Configuration Utilities', () => {
  describe('isValidUrl', () => {
    it('should accept valid HTTP URLs', () => {
      expect(isValidUrl('http://example.com')).toBe(true);
      expect(isValidUrl('http://example.com:8080')).toBe(true);
      expect(isValidUrl('http://example.com/path/to/page')).toBe(true);
      expect(isValidUrl('http://example.com?query=1&other=2')).toBe(true);
    });

    it('should accept valid HTTPS URLs', () => {
      expect(isValidUrl('https://example.com')).toBe(true);
      expect(isValidUrl('https://subdomain.example.com')).toBe(true);
      expect(isValidUrl('https://example.com/path')).toBe(true);
    });

    it('should reject non-HTTP protocols', () => {
      expect(isValidUrl('ftp://example.com')).toBe(false);
      expect(isValidUrl('file:///etc/passwd')).toBe(false);
      expect(isValidUrl('javascript:alert(1)')).toBe(false);
      expect(isValidUrl('data:text/html,<h1>Test</h1>')).toBe(false);
    });

    it('should reject invalid URLs', () => {
      expect(isValidUrl('not-a-url')).toBe(false);
      expect(isValidUrl('')).toBe(false);
      expect(isValidUrl('example.com')).toBe(false);
      expect(isValidUrl('://missing-protocol.com')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isValidUrl('http://localhost')).toBe(true);
      expect(isValidUrl('http://127.0.0.1')).toBe(true);
      expect(isValidUrl('http://[::1]')).toBe(true);
    });
  });

  describe('isValidPublicUrl', () => {
    it('should accept valid public URLs', () => {
      expect(isValidPublicUrl('https://example.com')).toBe(true);
      expect(isValidPublicUrl('https://docs.microsoft.com')).toBe(true);
      expect(isValidPublicUrl('https://developer.mozilla.org')).toBe(true);
    });

    it('should reject private network URLs by default', () => {
      expect(isValidPublicUrl('http://localhost')).toBe(false);
      expect(isValidPublicUrl('http://127.0.0.1')).toBe(false);
      expect(isValidPublicUrl('http://10.0.0.1')).toBe(false);
      expect(isValidPublicUrl('http://192.168.1.1')).toBe(false);
      expect(isValidPublicUrl('http://172.16.0.1')).toBe(false);
    });

    it('should allow private URLs when allowPrivate is true', () => {
      expect(isValidPublicUrl('http://localhost', true)).toBe(true);
      expect(isValidPublicUrl('http://192.168.1.1', true)).toBe(true);
    });

    it('should reject invalid URLs regardless of allowPrivate', () => {
      expect(isValidPublicUrl('not-a-url', true)).toBe(false);
      expect(isValidPublicUrl('ftp://example.com', true)).toBe(false);
    });

    it('should block cloud metadata endpoints', () => {
      expect(isValidPublicUrl('http://169.254.169.254')).toBe(false);
      expect(isValidPublicUrl('http://metadata.google.internal')).toBe(false);
    });
  });

  describe('normalizeUrl', () => {
    it('should remove trailing slashes', () => {
      expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
      expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
    });

    it('should preserve URL components', () => {
      expect(normalizeUrl('https://example.com/path?query=1')).toBe('https://example.com/path?query=1');
      expect(normalizeUrl('https://example.com:8080/path')).toBe('https://example.com:8080/path');
    });

    it('should handle URLs without trailing slash', () => {
      expect(normalizeUrl('https://example.com')).toBe('https://example.com');
      expect(normalizeUrl('https://example.com/path')).toBe('https://example.com/path');
    });

    it('should throw for invalid URLs', () => {
      expect(() => normalizeUrl('not-a-url')).toThrow('Invalid URL');
      expect(() => normalizeUrl('')).toThrow('Invalid URL');
    });

    it('should handle URLs with fragments', () => {
      expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page#section');
    });
  });

  describe('isGitHubUrl', () => {
    it('should identify GitHub URLs', () => {
      expect(isGitHubUrl('https://github.com/user/repo')).toBe(true);
      expect(isGitHubUrl('https://github.com/user/repo/blob/main/README.md')).toBe(true);
      expect(isGitHubUrl('https://github.com')).toBe(true);
    });

    it('should not identify non-GitHub URLs', () => {
      expect(isGitHubUrl('https://gitlab.com/user/repo')).toBe(false);
      expect(isGitHubUrl('https://bitbucket.org/user/repo')).toBe(false);
      expect(isGitHubUrl('https://example.com')).toBe(false);
    });

    it('should handle GitHub-related but non-GitHub URLs', () => {
      expect(isGitHubUrl('https://github.io')).toBe(false);
      expect(isGitHubUrl('https://user.github.io')).toBe(false);
      expect(isGitHubUrl('https://raw.githubusercontent.com/user/repo/main/file')).toBe(false);
    });

    it('should return false for invalid URLs', () => {
      expect(isGitHubUrl('not-a-url')).toBe(false);
      expect(isGitHubUrl('')).toBe(false);
    });
  });

  describe('Constants', () => {
    describe('RATE_LIMIT', () => {
      it('should have reasonable default values', () => {
        expect(RATE_LIMIT.maxRequests).toBeGreaterThan(0);
        expect(RATE_LIMIT.timeWindow).toBeGreaterThan(0);
        expect(RATE_LIMIT.minDelay).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
