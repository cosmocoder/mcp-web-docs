import { getBrowserConfig } from './browser-config.js';
import type { PlaywrightCrawlingContext, PlaywrightGotoOptions } from '@crawlee/playwright';
import type { Page } from 'playwright';

describe('Browser Config', () => {
  describe('getBrowserConfig', () => {
    it('should return config with default values', () => {
      const mockQueue = {} as Parameters<typeof getBrowserConfig>[0];
      const config = getBrowserConfig(mockQueue);

      expect(config.maxRequestsPerCrawl).toBe(1000);
      expect(config.maxConcurrency).toBe(20);
      expect(config.maxRequestsPerMinute).toBe(600);
      expect(config.maxRequestRetries).toBe(0);
      expect(config.navigationTimeoutSecs).toBe(10);
    });

    it('should return config with requestQueue', () => {
      const mockQueue = { name: 'test-queue' } as Parameters<typeof getBrowserConfig>[0];
      const config = getBrowserConfig(mockQueue);

      expect(config.requestQueue).toBe(mockQueue);
    });

    it('should have browser pool options', () => {
      const mockQueue = {} as Parameters<typeof getBrowserConfig>[0];
      const config = getBrowserConfig(mockQueue);

      expect(config.browserPoolOptions).toBeDefined();
      expect(config.browserPoolOptions?.maxOpenPagesPerBrowser).toBe(5);
      expect(config.browserPoolOptions?.useFingerprints).toBe(false);
      expect(config.browserPoolOptions?.operationTimeoutSecs).toBe(15);
      expect(config.browserPoolOptions?.closeInactiveBrowserAfterSecs).toBe(10);
    });

    it('should have preNavigationHooks', () => {
      const mockQueue = {} as Parameters<typeof getBrowserConfig>[0];
      const config = getBrowserConfig(mockQueue);

      expect(config.preNavigationHooks).toBeDefined();
      expect(Array.isArray(config.preNavigationHooks)).toBe(true);
      expect(config.preNavigationHooks?.length).toBe(1);
    });

    it('should configure page in preNavigationHook', async () => {
      const mockQueue = {} as Parameters<typeof getBrowserConfig>[0];
      const config = getBrowserConfig(mockQueue);

      const mockPage = {
        setViewportSize: vi.fn().mockResolvedValue(undefined),
        setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      } as unknown as Page;

      const mockContext = { page: mockPage } as PlaywrightCrawlingContext;
      const mockGotoOptions = {} as PlaywrightGotoOptions;

      const hook = config.preNavigationHooks?.[0];
      if (hook) {
        await hook(mockContext, mockGotoOptions);
      }

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1920, height: 1080 });
      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          'Accept-Language': expect.any(String),
          Accept: expect.any(String),
          'User-Agent': expect.any(String),
        })
      );
    });
  });
});
