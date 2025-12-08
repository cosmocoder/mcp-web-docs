import { RequestQueue, Dataset, Log, EnqueueLinksOptions, EnqueueStrategy } from 'crawlee';
import { generateDocId } from '../util/docs.js';
import { CrawlResult } from '../types.js';
import { SiteDetectionRule } from './site-rules.js';
import { logger } from '../util/logger.js';

export class QueueManager {
  private requestQueue: RequestQueue | null = null;
  private websiteId: string = '';
  private results: CrawlResult[] = [];
  private static readonly BATCH_SIZE = 20;
  /** Optional path prefix to restrict crawling to URLs under this path */
  private pathPrefix: string = '';
  /** The allowed hostname - only URLs with this exact hostname (or its subdomains) are allowed */
  private allowedHostname: string = '';
  /** Count of URLs filtered due to path prefix mismatch */
  private filteredByPathCount: number = 0;
  /** Count of URLs filtered due to hostname mismatch */
  private filteredByHostnameCount: number = 0;

  async initialize(url: string, pathPrefix?: string): Promise<void> {
    const parsedUrl = new URL(url);
    this.websiteId = generateDocId(url, parsedUrl.hostname);
    this.pathPrefix = pathPrefix || '';
    this.allowedHostname = parsedUrl.hostname.toLowerCase();
    this.filteredByPathCount = 0;
    this.filteredByHostnameCount = 0;

    logger.info(`[QueueManager] Hostname restriction: only crawling URLs on ${this.allowedHostname} (and its subdomains)`);
    if (this.pathPrefix) {
      logger.info(`[QueueManager] Path restriction enabled: only crawling URLs under ${this.pathPrefix}`);
    }
    logger.debug(`[QueueManager] Using website ID: ${this.websiteId}`);

    // Initialize queue
    this.requestQueue = await RequestQueue.open(this.websiteId);
    await this.requestQueue.drop();
    this.requestQueue = await RequestQueue.open(this.websiteId);

    // Add initial request (strip any hash from URL)
    const cleanUrl = parsedUrl.origin + parsedUrl.pathname + parsedUrl.search;
    await this.requestQueue.addRequest({
      url: cleanUrl,
      uniqueKey: parsedUrl.pathname + parsedUrl.search,
    });

    // Clear existing dataset
    const dataset = await Dataset.open(this.websiteId);
    await dataset.drop();
  }

  getFilteredByPathCount(): number {
    return this.filteredByPathCount;
  }

  getFilteredByHostnameCount(): number {
    return this.filteredByHostnameCount;
  }

  /**
   * Check if a hostname matches the allowed hostname.
   * Allows exact match or subdomains of the allowed hostname.
   * Does NOT allow sibling subdomains or parent domains.
   *
   * @example
   * If allowedHostname is 'docs.example.com':
   * - 'docs.example.com' → true (exact match)
   * - 'api.docs.example.com' → true (subdomain)
   * - 'example.com' → false (parent domain)
   * - 'python.example.com' → false (sibling subdomain)
   */
  private isHostnameAllowed(hostname: string): boolean {
    const h = hostname.toLowerCase();
    const allowed = this.allowedHostname;

    // Exact match
    if (h === allowed) {
      return true;
    }

    // Subdomain of allowed hostname (e.g., api.docs.example.com when allowed is docs.example.com)
    if (h.endsWith('.' + allowed)) {
      return true;
    }

    return false;
  }

  async handleQueueAndLinks(
    enqueueLinks: (options: EnqueueLinksOptions) => Promise<{ processedRequests: { uniqueKey: string }[] }>,
    log: Log,
    rule: SiteDetectionRule
  ): Promise<void> {
    const queueInfo = await this.requestQueue!.getInfo();
    if (queueInfo) {
      log.info('Queue status:', {
        pendingCount: queueInfo.pendingRequestCount || 0,
        handledCount: queueInfo.handledRequestCount || 0,
        totalCount: queueInfo.totalRequestCount || 0,
      });
    }

    // Capture values for use in transform function closures
    const pathPrefix = this.pathPrefix;
    const allowedHostname = this.allowedHostname;
    const isHostnameAllowed = this.isHostnameAllowed.bind(this);
    const incrementFilteredByPath = () => {
      this.filteredByPathCount++;
    };
    const incrementFilteredByHostname = () => {
      this.filteredByHostnameCount++;
    };

    const enqueueOptions: EnqueueLinksOptions = {
      strategy: 'same-domain' as EnqueueStrategy,
      transformRequestFunction(req) {
        const url = new URL(req.url);

        // Skip URLs with hash fragments (same-page anchors)
        // These point to sections within a page, not separate pages
        if (url.hash) {
          logger.debug(`[QueueManager] Skipping anchor link: ${req.url}`);
          return false;
        }

        // Skip URLs with different hostname (stricter than same-domain strategy)
        // This prevents crawling sibling subdomains (e.g., python.langchain.com when starting from docs.langchain.com)
        if (!isHostnameAllowed(url.hostname)) {
          logger.debug(`[QueueManager] Skipping URL with different hostname: ${url.hostname} (allowed: ${allowedHostname})`);
          incrementFilteredByHostname();
          return false;
        }

        // Skip URLs outside the path prefix (if configured)
        // Use precise matching: /docs matches /docs and /docs/foo but NOT /documentation
        if (pathPrefix) {
          const isMatch = url.pathname === pathPrefix || url.pathname.startsWith(pathPrefix + '/');
          if (!isMatch) {
            logger.debug(`[QueueManager] Skipping URL outside path prefix: ${url.pathname} (prefix: ${pathPrefix})`);
            incrementFilteredByPath();
            return false;
          }
        }

        // Return the request with a normalized URL (without hash) and unique key
        return {
          ...req,
          url: url.origin + url.pathname + url.search, // Strip hash from URL
          uniqueKey: url.pathname + url.search,
        };
      },
    };

    // Add site-specific link selectors if provided
    if (rule.linkSelectors?.length) {
      enqueueOptions.selector = rule.linkSelectors.join(', ');
    }

    const enqueueResult = await enqueueLinks(enqueueOptions);

    log.info('Enqueued links:', {
      processedCount: enqueueResult.processedRequests.length,
      urls: enqueueResult.processedRequests.map((r: { uniqueKey: string }) => r.uniqueKey),
      ...(this.filteredByHostnameCount > 0 ? { filteredByHostname: this.filteredByHostnameCount } : {}),
      ...(this.pathPrefix ? { pathPrefix: this.pathPrefix, filteredByPath: this.filteredByPathCount } : {}),
    });
  }

  async processBatch(): Promise<CrawlResult[]> {
    if (this.results.length === 0) return [];

    const dataset = await Dataset.open(this.websiteId);
    const resultsToProcess = [...this.results];
    this.results = [];

    // Process in chunks for better memory management
    for (let i = 0; i < resultsToProcess.length; i += 5) {
      await dataset.pushData(resultsToProcess.slice(i, i + 5));
    }

    return resultsToProcess;
  }

  addResult(result: CrawlResult): void {
    this.results.push(result);
  }

  hasEnoughResults(): boolean {
    return this.results.length >= QueueManager.BATCH_SIZE;
  }

  getRequestQueue(): RequestQueue | null {
    return this.requestQueue;
  }

  async cleanup(): Promise<void> {
    this.results = [];
    if (this.requestQueue) {
      await this.requestQueue.drop().catch((err) => logger.error('Failed to drop request queue:', err));
      this.requestQueue = null;
    }
  }
}
