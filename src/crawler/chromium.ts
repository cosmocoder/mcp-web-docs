import { URL } from 'url';
import { Page, ConsoleMessage, HTTPRequest, HTTPResponse, BrowserContext } from 'puppeteer';
// @ts-ignore
import PCR from 'puppeteer-chromium-resolver';
import { CrawlResult } from '../types.js';
import { BaseCrawler } from './base.js';

export class ChromiumCrawler extends BaseCrawler {
  private readonly PCR_CONFIG = {
    revision: '',
    detectionPath: '',
    folderName: '.chromium-browser',
    downloadPath: process.env.CHROMIUM_PATH || '/tmp/chromium'
  };

  private curCrawlCount = 0;
  private baseHostname: string = '';
  private readonly BATCH_SIZE = 20; // Increased for parallel processing
  private readonly REACT_WAIT_TIME = 3000; // Increased for Storybook initial load
  private readonly NAVIGATION_WAIT_TIME = 1000; // Increased for Storybook navigation
  private readonly MAX_CONCURRENT_PAGES = 3; // Number of concurrent pages
  private readonly PAGE_TIMEOUT = 20000; // Reduced page timeout
  private readonly resourceCache = new Map<string, string>();

  constructor(
    maxDepth: number = 4,
    maxRequestsPerCrawl: number = 1000,
    onProgress?: (progress: number, description: string) => void
  ) {
    super(maxDepth, maxRequestsPerCrawl, onProgress);
  }

  async *crawl(url: string): AsyncGenerator<CrawlResult, void, unknown> {
    console.debug(`[${this.constructor.name}] Starting crawl of: ${url}`);

    // Store the base hostname to restrict crawling
    const startUrl = new URL(url);
    this.baseHostname = startUrl.hostname;

    const stats = await PCR(this.PCR_CONFIG);
    const browser = await stats.puppeteer.launch({
      args: [
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.150 Safari/537.36',
        '--disable-web-security',  // Allow cross-origin requests
        '--disable-features=IsolateOrigins,site-per-process', // Disable site isolation
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1920,1080'  // Larger viewport
      ],
      executablePath: stats.executablePath,
      headless: 'new',
      defaultViewport: {
        width: 1920,
        height: 1080
      }
    });

    try {
      const page = await browser.newPage();

      // Enhanced page configuration
      await Promise.all([
        page.setDefaultNavigationTimeout(60000), // Increased timeout
        page.setDefaultTimeout(60000),
        page.setViewport({ width: 1920, height: 1080 }),
        page.setJavaScriptEnabled(true)
      ]);

      console.debug('[ChromiumCrawler] Basic page configuration complete');

      // Load the first page without request interception
      console.debug('[ChromiumCrawler] Loading initial page:', startUrl.toString());
      await page.goto(startUrl.toString(), {
        waitUntil: ['networkidle0'], // Wait for all network activity to stop
        timeout: 60000 // Longer timeout for initial load
      });
      console.debug('[ChromiumCrawler] Initial page navigation complete');

      // Initial wait for page load
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Wait for Storybook to be ready
      console.debug('[ChromiumCrawler] Waiting for Storybook...');
      await page.waitForFunction(
        () => {
          // Check for Storybook API
          const api = (window as any).__STORYBOOK_API__;
          if (!api?.store?.getState) {
            console.debug('[Page] No Storybook API yet');
            return false;
          }

          // Check for manager UI
          const manager = document.querySelector('#storybook-preview-wrapper');
          if (!manager) {
            console.debug('[Page] No manager UI yet');
            return false;
          }

          // Check for stories in the store
          const { stories = {} } = api.store.getState();
          const storyCount = Object.keys(stories).length;

          // Check for sidebar
          const sidebar = document.querySelector('[class*="sidebar"]');

          console.debug('[Page] Storybook check:', {
            hasApi: !!api,
            hasManager: !!manager,
            hasSidebar: !!sidebar,
            storyCount
          });

          // Wait for both stories and sidebar
          return storyCount > 0 && !!sidebar;
        },
        { timeout: 60000, polling: 1000 } // Longer timeout and active polling
      );
      console.debug('[ChromiumCrawler] Storybook initialized');

      // Wait for preview iframe
      console.debug('[ChromiumCrawler] Waiting for preview iframe...');
      await page.waitForSelector('iframe[id="storybook-preview-iframe"]', { timeout: 20000 })
        .catch(() => console.debug('[ChromiumCrawler] No preview iframe found'));

      // Additional wait for any dynamic updates
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Now enable request interception for subsequent requests
      await page.setRequestInterception(true);
      console.debug('[ChromiumCrawler] Request interception enabled for subsequent requests');

      // Short wait to ensure everything is stable
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.debug('[ChromiumCrawler] Additional wait complete');

      // Enhanced error and event handling
      page.on('console', (msg: ConsoleMessage) => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'error' || type === 'warn') {
          console.error(`[ChromiumCrawler] Console ${type}: ${text}`);
        } else {
          console.debug(`[ChromiumCrawler] Console ${type}: ${text}`);
        }
      });

      page.on('pageerror', (err: Error) => {
        console.error('[ChromiumCrawler] Page error:', {
          message: err.message,
          stack: err.stack,
          name: err.name
        });
      });

      page.on('requestfailed', (request: HTTPRequest) => {
        const failure = request.failure();
        console.error('[ChromiumCrawler] Request failed:', {
          url: request.url(),
          errorText: failure?.errorText,
          method: request.method(),
          resourceType: request.resourceType()
        });
      });

      page.on('response', (response: HTTPResponse) => {
        const status = response.status();
        if (status >= 400) {
          console.error('[ChromiumCrawler] HTTP error:', {
            url: response.url(),
            status,
            statusText: response.statusText()
          });
        }
      });

      // Minimal request handling for Storybook
      page.on('request', (request: HTTPRequest) => {
        const resourceType = request.resourceType();
        const url = request.url();

        // Block only non-essential resources
        if (['image', 'media', 'font', 'websocket'].includes(resourceType) ||
            url.includes('google-analytics') ||
            url.includes('analytics') ||
            url.includes('tracking')) {
          request.abort();
        } else {
          // Allow all other resources including Storybook-specific ones
          request.continue();
        }
      });

      // Initialize progress tracking
      this.updateProgress('Starting crawl...');

      // Extract content from initial page
      const { content, title } = await this.extractPageContent(page);

      // Get links from initial page
      const links = await this.getLinksFromPage(page, startUrl);
      console.debug(`[ChromiumCrawler] Found ${links.length} links on initial page:`, links);

      // Update progress for initial page
      this.addDiscoveredUrls(links.length);
      this.markUrlProcessed(startUrl.toString());

      // Yield initial page content
      const initialResult = {
        url: startUrl.toString(),
        path: startUrl.pathname + startUrl.search,
        content,
        title
      };
      console.debug('[ChromiumCrawler] Initial page content:', {
        url: initialResult.url,
        path: initialResult.path,
        titleLength: initialResult.title.length,
        contentLength: initialResult.content.length
      });
      yield initialResult;

      // Initialize visited links tracking
      const visitedLinks = new Set<string>([startUrl.toString()]);
      console.debug('[ChromiumCrawler] Initialized visited links with:', Array.from(visitedLinks));

      // Process remaining pages in parallel
      if (links.length > 0) {
        // Create initial pool of browser contexts
        const contexts = await Promise.all(
          Array(this.MAX_CONCURRENT_PAGES).fill(0).map(() => browser.createIncognitoBrowserContext())
        );
        let contextIndex = 0;

        // Process links in batches
        for (let i = 0; i < links.length; i += this.BATCH_SIZE) {
          const batch = links.slice(i, i + this.BATCH_SIZE);
          const batchPromises = [];

          for (const link of batch) {
            if (this.curCrawlCount >= this.maxRequestsPerCrawl) {
              break;
            }

            // Use round-robin context assignment
            const context = contexts[contextIndex];
            contextIndex = (contextIndex + 1) % contexts.length;

            const page = await context.newPage();
            await this.configurePage(page);

            this.curCrawlCount++;
            batchPromises.push(this.processSinglePage(page, new URL(link), visitedLinks));
          }

          // Process batch
          const results = await Promise.all(batchPromises);
          for (const result of results) {
            if (result) {
              yield result;
            }
          }

          // Short delay between batches
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Cleanup contexts
        await Promise.all(contexts.map((ctx: BrowserContext) => ctx.close()));
      }

      // Final progress update
      this.updateProgress('Crawl complete');
    } catch (e) {
      console.error('[ChromiumCrawler] Error during crawl:', e);
    } finally {
      await browser.close();
    }
  }

  private async extractPageContent(page: Page): Promise<{ content: string; title: string }> {
    // Import pdfjs-dist at runtime
    const pdfjsLib = require('pdfjs-dist');

    // Configure PDF.js worker
    const pdfjsWorker = require('pdfjs-dist/build/pdf.worker.entry');
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

    try {
      // Generate PDF of the page
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
      });

      // Load the PDF document
      const pdf = await pdfjsLib.getDocument({ data: pdfBuffer }).promise;

      // Extract text from all pages
      let textContent = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item: { str: string }) => item.str)
          .join(' ');
        textContent += pageText + '\n';
      }

      // Get the title from the page
      const title = await page.evaluate(() => {
        return document.querySelector('h1')?.textContent?.trim() ||
               document.title?.trim() ||
               'Untitled';
      });

      // Convert the text content to HTML with proper structure
      const htmlContent = textContent
        .split('\n')
        .filter(line => line.trim()) // Remove empty lines
        .map(line => `<p>${line}</p>`) // Wrap each line in a paragraph
        .join('\n');

      return {
        content: htmlContent,
        title: title
      };
    } catch (e) {
      console.error('[ChromiumCrawler] Error extracting content:', e);
      // Fallback to basic text extraction
      const title = await page.title();
      const content = await page.evaluate(() => document.body.innerText);
      return {
        content: `<p>${content}</p>`,
        title: title || 'Untitled'
      };
    }
  }

  private async waitForDynamicContent(page: Page) {
    try {
      // Initial shorter wait for React hydration
      await new Promise(resolve => setTimeout(resolve, this.REACT_WAIT_TIME));

      // Wait for Storybook's iframe to load
      try {
        const iframeHandle = await page.$('iframe[id="storybook-preview-iframe"]');
        if (iframeHandle) {
          const frame = await iframeHandle.contentFrame();
          if (frame) {
            // Wait for content in the iframe
            await frame.waitForFunction(
              () => {
                const root = document.querySelector('#root');
                return root && root.textContent ? root.textContent.trim().length > 0 : false;
              },
              { timeout: 10000 }
            ).catch(() => {
              console.debug('[ChromiumCrawler] Timeout waiting for iframe content');
            });
          }
        }
      } catch (e) {
        console.debug('[ChromiumCrawler] Error handling iframe:', e);
      }

      // Check for Storybook initialization in main document
      await page.waitForFunction(() => {
        // Check Storybook API and manager
        const hasStorybook = typeof (window as any).__STORYBOOK_API__ !== 'undefined' &&
                           document.querySelector('#storybook-preview-wrapper');

        // Check for either content or navigation
        const hasContent = document.querySelector('[class*="docs-content"]') ||
                         document.querySelector('[class*="story-content"]') ||
                         document.querySelector('[class*="storybook-"]');

        const hasSidebar = document.querySelector('[class*="sidebar"]') ||
                         document.querySelector('[data-nodetype]');

        return hasStorybook && (hasContent || hasSidebar);
      }, { timeout: 10000 });

      // Quick check for loading indicators
      await page.waitForFunction(() => {
        return !document.querySelector('[aria-busy="true"], [class*="loading"]');
      }, { timeout: 5000 }).catch(() => {
        // Continue even if loading indicators remain
        console.debug('[ChromiumCrawler] Some loading indicators still present');
      });

    } catch (e) {
      console.debug('[ChromiumCrawler] Error waiting for Storybook content:', e);
      throw e;
    }
  }

  private async gotoPageAndHandleRedirects(page: Page, url: string) {
    try {
      // Navigate with optimized options for Storybook
      await page.goto(url, {
        timeout: 30000, // Reduced timeout
        waitUntil: ['domcontentloaded', 'networkidle2'] // Removed 'load' to speed up
      });

      // Wait for client-side routing
      await new Promise(resolve => setTimeout(resolve, this.NAVIGATION_WAIT_TIME));

      // Wait for dynamic content
      await this.waitForDynamicContent(page);

    } catch (e) {
      console.error(`[ChromiumCrawler] Error loading page ${url}:`, e);
      throw e;
    }
  }


  private async configurePage(page: Page): Promise<void> {
    await Promise.all([
      page.setDefaultNavigationTimeout(this.PAGE_TIMEOUT),
      page.setDefaultTimeout(this.PAGE_TIMEOUT),
      page.setRequestInterception(true)
    ]);

    // Minimal request handling
    page.on('request', (request: HTTPRequest) => {
      const resourceType = request.resourceType();
      const url = request.url();

      // Check cache first
      if (this.resourceCache.has(url)) {
        request.respond({
          body: this.resourceCache.get(url)!
        });
        return;
      }

      // Block only non-essential resources
      if (['image', 'media', 'websocket'].includes(resourceType) ||
          url.includes('google-analytics') ||
          url.includes('analytics') ||
          url.includes('tracking')) {
        request.abort();
      } else {
        // Allow all other resources including Storybook-specific ones
        request.continue();
      }
    });

    // Cache responses
    page.on('response', async (response: HTTPResponse) => {
      const url = response.url();
      const resourceType = response.request().resourceType();

      if (['script', 'stylesheet'].includes(resourceType)) {
        try {
          const body = await response.text();
          this.resourceCache.set(url, body);
        } catch (e) {
          // Ignore cache errors
        }
      }
    });
  }

  private async processSinglePage(
    page: Page,
    url: URL,
    visitedLinks: Set<string>
  ): Promise<CrawlResult | null> {
    try {
      await this.gotoPageAndHandleRedirects(page, url.toString());
      const currentUrl = page.url();

      const { content, title } = await this.extractPageContent(page);

      // Update tracking
      this.markUrlProcessed(currentUrl);
      visitedLinks.add(currentUrl);

      await page.close();

      return {
        url: currentUrl,
        path: new URL(currentUrl).pathname + new URL(currentUrl).search,
        content,
        title
      };
    } catch (e) {
      console.error(`[ChromiumCrawler] Error processing single page ${url}:`, e);
      await page.close();
      return null;
    }
  }

  private async getLinksFromPage(page: Page, startUrl: URL): Promise<string[]> {
    try {
      console.debug('[ChromiumCrawler] Starting link discovery...');
      await new Promise(resolve => setTimeout(resolve, this.NAVIGATION_WAIT_TIME));

      // Get all links from the page
      const rawLinks = await page.evaluate(() => {
        console.debug('[Page] Starting link discovery in page...');
        const links = new Set<string>();

        // Helper function to normalize URLs
        const normalizeUrl = (url: string) => {
          console.debug('[Page] Normalizing URL:', url);
          try {
            // Handle relative paths with query parameters
            if (url.startsWith('/')) {
              // Keep the query parameters but ensure base path is correct
              const urlObj = new URL(url, window.location.origin);
              urlObj.hash = ''; // Remove hash
              return urlObj.toString();
            }
            // Handle absolute URLs
            const urlObj = new URL(url, window.location.href);
            urlObj.hash = ''; // Remove hash but keep query params
            return urlObj.toString();
          } catch (e) {
            console.debug('[Page] Error normalizing URL:', e);
            return '';
          }
        };

        console.debug('[Page] Document ready state:', document.readyState);

        // Get all anchor tags with href attributes
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        console.debug('[Page] Found anchors:', anchors.length);

        anchors.forEach(anchor => {
          const href = anchor.getAttribute('href');
          if (href && !href.startsWith('javascript:')) {
            const normalized = normalizeUrl(href);
            if (normalized) {
              links.add(normalized);
              console.debug('[Page] Added link:', {
                href,
                normalized,
                text: anchor.textContent?.trim()
              });
            }
          }
        });

        // Get links from iframes
        const iframes = Array.from(document.getElementsByTagName('iframe'));
        console.debug('[Page] Found iframes:', iframes.length);
        iframes.forEach(iframe => {
          try {
            if (iframe.contentDocument) {
              console.debug('[Page] Processing iframe:', iframe.id || 'unnamed');
              const iframeLinks = Array.from(iframe.contentDocument.querySelectorAll('a[href]'));
              console.debug('[Page] Found links in iframe:', iframeLinks.length);
              iframeLinks.forEach(link => {
                const href = (link as HTMLAnchorElement).href;
                if (href && !href.startsWith('javascript:')) {
                  const normalized = normalizeUrl(href);
                  links.add(normalized);
                  console.debug('[Page] Added iframe link:', normalized);
                }
              });
            }
          } catch (e) {
            console.debug('[Page] Error accessing iframe:', e);
          }
        });

        // Try to get Storybook links if available
        try {
          console.debug('[Page] Checking for Storybook API...');
          const api = (window as any).__STORYBOOK_API__;
          if (api?.store?.getState) {
            console.debug('[Page] Found Storybook API');
            const { stories = {}, refs = {} } = api.store.getState();
            console.debug('[Page] Stories count:', Object.keys(stories).length);
            console.debug('[Page] Refs count:', Object.keys(refs).length);

            // Add story links
            Object.entries(stories).forEach(([storyId, story]: [string, any]) => {
              // Add docs page
              const docsUrl = normalizeUrl(`${window.location.pathname}?path=/docs/${storyId}`);
              links.add(docsUrl);
              console.debug('[Page] Added docs link:', { storyId, docsUrl });

              // Add story page
              const storyUrl = normalizeUrl(`${window.location.pathname}?path=/story/${storyId}`);
              links.add(storyUrl);
              console.debug('[Page] Added story link:', { storyId, storyUrl });

              // Add any additional story variants
              if (story.args) {
                Object.keys(story.args).forEach(variantId => {
                  const variantUrl = normalizeUrl(`${window.location.pathname}?path=/story/${storyId}--${variantId}`);
                  links.add(variantUrl);
                  console.debug('[Page] Added variant link:', { storyId, variantId, variantUrl });
                });
              }
            });

            // Add reference links
            Object.entries(refs).forEach(([refId, ref]: [string, any]) => {
              if (ref.stories) {
                Object.entries(ref.stories).forEach(([storyId, _]: [string, any]) => {
                  // Add docs page
                  const docsUrl = normalizeUrl(`${window.location.pathname}?path=/docs/${refId}-${storyId}`);
                  links.add(docsUrl);
                  console.debug('[Page] Added ref docs link:', { refId, storyId, docsUrl });

                  // Add story page
                  const storyUrl = normalizeUrl(`${window.location.pathname}?path=/story/${refId}-${storyId}`);
                  links.add(storyUrl);
                  console.debug('[Page] Added ref story link:', { refId, storyId, storyUrl });
                });
              }
            });
          } else {
            console.debug('[Page] No Storybook API found');
          }
        } catch (e) {
          console.debug('[Page] Error getting Storybook links:', e);
        }

        const result = Array.from(links).map(href => ({ href }));
        console.debug('[Page] Total unique links found:', result.length);
        return result;
      });

      console.debug(`[ChromiumCrawler] Raw links found:`, rawLinks);

      const validLinks = new Set<string>();

      // Log the base hostname we're comparing against
      console.debug(`[ChromiumCrawler] Base hostname: ${this.baseHostname}`);

      for (const { href } of rawLinks) {
        try {
          // Handle different URL patterns
          let fullUrl: string;
          if (href.startsWith('?path=/')) {
            // Handle query-only URLs by combining with the current URL
            fullUrl = `${startUrl.origin}${startUrl.pathname}${href}`;
          } else if (href.startsWith('/')) {
            // Handle absolute paths by combining with origin
            fullUrl = `${startUrl.origin}${href}`;
          } else {
            // Handle full URLs
            fullUrl = href;
          }

          // Create URL object for validation
          const linkUrl = new URL(fullUrl);
          console.debug(`[ChromiumCrawler] Checking link:`, {
            original: href,
            fullUrl,
            hostname: linkUrl.hostname,
            pathname: linkUrl.pathname,
            search: linkUrl.search
          });

          // Accept links that:
          // 1. Match the base hostname and base path (/ui/latest/), or
          // 2. Are query parameters for docs
          if (linkUrl.hostname === this.baseHostname &&
              (linkUrl.pathname.startsWith(startUrl.pathname) || href.startsWith('?path=/docs/'))) {
            validLinks.add(linkUrl.toString());
            console.debug(`[ChromiumCrawler] Added valid link: ${linkUrl.toString()}`);
          } else {
            console.debug(`[ChromiumCrawler] Skipping link: ${href} (hostname: ${linkUrl.hostname}, pathname: ${linkUrl.pathname})`);
          }
        } catch (e) {
          console.debug(`[ChromiumCrawler] Invalid URL ${href}:`, e);
        }
      }

      const uniqueLinks = Array.from(validLinks);
      console.debug(`[ChromiumCrawler] Found ${uniqueLinks.length} unique valid links`);
      return uniqueLinks;
    } catch (e) {
      console.error('[ChromiumCrawler] Error extracting links:', e);
      return [];
    }
  }
}
