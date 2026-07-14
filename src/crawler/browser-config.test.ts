import type { PlaywrightCrawlingContext, PlaywrightGotoOptions } from '@crawlee/playwright';
import type { Page } from 'playwright';

import { getBrowserConfig } from './browser-config.js';

describe('Browser Config', () => {
  describe('getBrowserConfig', () => {
    it('should return config with default values', async () => {
      const mockQueue = {} as Parameters<typeof getBrowserConfig>[0];
      const config = await getBrowserConfig(mockQueue);

      expect(config.maxRequestsPerCrawl).toBe(1000);
      expect(config.maxConcurrency).toBe(5);
      expect(config.maxRequestsPerMinute).toBe(120);
      expect(config.maxRequestRetries).toBe(2);
      expect(config.navigationTimeoutSecs).toBe(30);
      expect(config.requestHandlerTimeoutSecs).toBe(60);
    });

    it('should return config with requestQueue', async () => {
      const mockQueue = { name: 'test-queue' } as Parameters<typeof getBrowserConfig>[0];
      const config = await getBrowserConfig(mockQueue);

      expect(config.requestQueue).toBe(mockQueue);
    });

    it('preserves the persistent browser context behind the pinned proxy', async () => {
      const mockQueue = {} as Parameters<typeof getBrowserConfig>[0];
      const config = await getBrowserConfig(mockQueue);

      expect(config.browserPoolOptions).toBeDefined();
      expect(config.browserPoolOptions?.maxOpenPagesPerBrowser).toBe(3);
      expect(config.browserPoolOptions?.useFingerprints).toBe(true);
      expect(config.browserPoolOptions?.operationTimeoutSecs).toBe(30);
      expect(config.browserPoolOptions?.closeInactiveBrowserAfterSecs).toBe(20);
      expect(config.launchContext?.useIncognitoPages).toBeUndefined();
      expect(config.launchContext?.launchOptions?.proxy).toEqual({
        server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
        bypass: '<-loopback>',
      });
      expect(config.launchContext?.launchOptions).not.toHaveProperty('serviceWorkers');
    });

    it('should have preNavigationHooks', async () => {
      const mockQueue = {} as Parameters<typeof getBrowserConfig>[0];
      const config = await getBrowserConfig(mockQueue);

      expect(config.preNavigationHooks).toBeDefined();
      expect(Array.isArray(config.preNavigationHooks)).toBe(true);
      expect(config.preNavigationHooks?.length).toBe(1);
    });

    it('should configure page in preNavigationHook', async () => {
      const mockQueue = {} as Parameters<typeof getBrowserConfig>[0];
      const config = await getBrowserConfig(mockQueue);

      const mockPage = {
        route: vi.fn().mockResolvedValue(undefined),
        routeWebSocket: vi.fn().mockResolvedValue(undefined),
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
      expect(mockPage.route).not.toHaveBeenCalled();
      expect(mockPage.routeWebSocket).not.toHaveBeenCalled();
      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          'Accept-Language': expect.any(String),
          Accept: expect.any(String),
        })
      );
    });
  });
});
