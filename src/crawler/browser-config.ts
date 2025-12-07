import { PlaywrightCrawlerOptions, log } from 'crawlee';

// Suppress Crawlee's stdout logging for MCP compatibility
// MCP servers must only output JSON-RPC messages to stdout
log.setLevel(log.LEVELS.OFF);

export const getBrowserConfig = (requestQueue: PlaywrightCrawlerOptions['requestQueue']): Partial<PlaywrightCrawlerOptions> => ({
  maxRequestsPerCrawl: 1000,
  requestQueue,
  maxConcurrency: 20,
  maxRequestsPerMinute: 600,
  maxRequestRetries: 0,
  navigationTimeoutSecs: 10,
  browserPoolOptions: {
    maxOpenPagesPerBrowser: 5,
    useFingerprints: false,
    operationTimeoutSecs: 15,
    closeInactiveBrowserAfterSecs: 10
  },
  preNavigationHooks: [
    async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      });
    },
  ]
});
