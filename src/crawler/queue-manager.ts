import { RequestQueue, Dataset, Log, EnqueueLinksOptions } from 'crawlee';
import { generateDocId } from '../util/docs.js';
import { CrawlResult } from '../types.js';
import { SiteDetectionRule } from './site-rules.js';

export class QueueManager {
  private requestQueue: RequestQueue | null = null;
  private websiteId: string = '';
  private results: CrawlResult[] = [];
  private static readonly BATCH_SIZE = 20;

  async initialize(url: string): Promise<void> {
    this.websiteId = generateDocId(url, new URL(url).hostname);
    console.debug(`[QueueManager] Using website ID: ${this.websiteId}`);

    // Initialize queue
    this.requestQueue = await RequestQueue.open(this.websiteId);
    await this.requestQueue.drop();
    this.requestQueue = await RequestQueue.open(this.websiteId);

    // Add initial request
    await this.requestQueue.addRequest({
      url,
      uniqueKey: new URL(url).pathname + new URL(url).search,
    });

    // Clear existing dataset
    const dataset = await Dataset.open(this.websiteId);
    await dataset.drop();
  }

  async handleQueueAndLinks(enqueueLinks: (options: EnqueueLinksOptions) => Promise<any>, log: Log, rule: SiteDetectionRule): Promise<void> {
    const queueInfo = await this.requestQueue!.getInfo();
    if (queueInfo) {
      log.info('Queue status:', {
        pendingCount: queueInfo.pendingRequestCount || 0,
        handledCount: queueInfo.handledRequestCount || 0,
        totalCount: queueInfo.totalRequestCount || 0
      });
    }

    const enqueueOptions: EnqueueLinksOptions = {
      strategy: 'same-domain',
      transformRequestFunction(req: any) {
        const url = new URL(req.url);
        return {
          ...req,
          uniqueKey: url.pathname + url.search
        };
      }
    };

    // Add site-specific link selectors if provided
    if (rule.linkSelectors?.length) {
      enqueueOptions.selector = rule.linkSelectors.join(', ');
    }

    const enqueueResult = await enqueueLinks(enqueueOptions);

    log.info('Enqueued links:', {
      processedCount: enqueueResult.processedRequests.length,
      urls: enqueueResult.processedRequests.map((r: any) => r.uniqueKey)
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
      await this.requestQueue.drop().catch(console.error);
      this.requestQueue = null;
    }
  }
}
