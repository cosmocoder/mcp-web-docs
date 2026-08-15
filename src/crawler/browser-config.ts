import { PlaywrightCrawlerOptions, log } from 'crawlee';
import { getOutboundProxyUrl } from '../util/outbound-request.js';

// MCP servers must write nothing but JSON-RPC to stdout, and Crawlee's logger sends its info and
// debug lines there. Off rather than raised to warning, because this project logs through
// util/logger, which writes to stderr - a Crawlee line would be a second, unprefixed channel.
log.setLevel(log.LEVELS.OFF);

export const getBrowserConfig = async (
  requestQueue: PlaywrightCrawlerOptions['requestQueue']
): Promise<Partial<PlaywrightCrawlerOptions>> => ({
  maxRequestsPerCrawl: 1000,
  requestQueue,
  maxConcurrency: 5,
  maxRequestsPerMinute: 120,
  maxRequestRetries: 2,
  navigationTimeoutSecs: 30,
  requestHandlerTimeoutSecs: 60,
  launchContext: {
    launchOptions: {
      proxy: { server: await getOutboundProxyUrl(), bypass: '<-loopback>' },
    },
  },
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
