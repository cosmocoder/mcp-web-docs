import { PlaywrightCrawlerOptions, log } from 'crawlee';

// Suppress Crawlee's stdout logging for MCP compatibility
// MCP servers must only output JSON-RPC messages to stdout
log.setLevel(log.LEVELS.OFF);

export const getBrowserConfig = (requestQueue: PlaywrightCrawlerOptions['requestQueue']): Partial<PlaywrightCrawlerOptions> => ({
  maxRequestsPerCrawl: 1000,
  requestQueue,
  maxConcurrency: 5,
  maxRequestsPerMinute: 120,
  maxRequestRetries: 2,
  navigationTimeoutSecs: 30,
  requestHandlerTimeoutSecs: 60,
  browserPoolOptions: {
    maxOpenPagesPerBrowser: 3,
    useFingerprints: true,
    operationTimeoutSecs: 30,
    closeInactiveBrowserAfterSecs: 20,
  },
  preNavigationHooks: [
    async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      });
    },
  ],
});
