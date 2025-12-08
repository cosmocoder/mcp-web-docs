import type { EnqueueLinksOptions, Log } from 'crawlee';
import { QueueManager } from './queue-manager.js';
import type { CrawlResult } from '../types.js';
import type { SiteDetectionRule } from './site-rules.js';

const { mockRequestQueue, mockDataset } = vi.hoisted(() => ({
  mockRequestQueue: {
    drop: vi.fn().mockResolvedValue(undefined),
    addRequest: vi.fn().mockResolvedValue(undefined),
    getInfo: vi.fn().mockResolvedValue({
      pendingRequestCount: 5,
      handledRequestCount: 10,
      totalRequestCount: 15,
    }),
  },
  mockDataset: {
    drop: vi.fn().mockResolvedValue(undefined),
    pushData: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('crawlee', () => ({
  RequestQueue: {
    open: vi.fn().mockResolvedValue(mockRequestQueue),
  },
  Dataset: {
    open: vi.fn().mockResolvedValue(mockDataset),
  },
  EnqueueStrategy: {
    SameDomain: 'same-domain',
  },
}));

describe('QueueManager', () => {
  let queueManager: QueueManager;

  beforeEach(() => {
    vi.clearAllMocks();
    queueManager = new QueueManager();
  });

  describe('initialize', () => {
    it('should initialize with a URL', async () => {
      await queueManager.initialize('https://example.com/docs');

      expect(mockRequestQueue.drop).toHaveBeenCalled();
      expect(mockRequestQueue.addRequest).toHaveBeenCalledWith({
        url: 'https://example.com/docs',
        uniqueKey: '/docs',
      });
    });

    it('should generate correct unique key from URL', async () => {
      await queueManager.initialize('https://example.com/path/to/page?query=1');

      expect(mockRequestQueue.addRequest).toHaveBeenCalledWith({
        url: 'https://example.com/path/to/page?query=1',
        uniqueKey: '/path/to/page?query=1',
      });
    });

    it('should clear existing dataset', async () => {
      await queueManager.initialize('https://example.com');

      expect(mockDataset.drop).toHaveBeenCalled();
    });
  });

  describe('handleQueueAndLinks', () => {
    const mockLog: Log = {
      info: vi.fn(),
      debug: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    } as unknown as Log;

    const mockRule: SiteDetectionRule = {
      type: 'default',
      extractor: { extractContent: vi.fn() },
      detect: vi.fn().mockResolvedValue(true),
    };

    beforeEach(async () => {
      await queueManager.initialize('https://example.com');
    });

    it('should log queue status', async () => {
      const mockEnqueueLinks = vi.fn().mockResolvedValue({
        processedRequests: [],
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      expect(mockLog.info).toHaveBeenCalledWith('Queue status:', {
        pendingCount: 5,
        handledCount: 10,
        totalCount: 15,
      });
    });

    it('should enqueue links with same-domain strategy', async () => {
      const mockEnqueueLinks = vi.fn().mockResolvedValue({
        processedRequests: [{ uniqueKey: '/page1' }, { uniqueKey: '/page2' }],
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      expect(mockEnqueueLinks).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: 'same-domain',
        })
      );
    });

    it('should use link selectors from rule when provided', async () => {
      const ruleWithSelectors: SiteDetectionRule = {
        ...mockRule,
        linkSelectors: ['.nav a', '.content a'],
      };

      const mockEnqueueLinks = vi.fn().mockResolvedValue({
        processedRequests: [],
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, ruleWithSelectors);

      expect(mockEnqueueLinks).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: '.nav a, .content a',
        })
      );
    });

    it('should log enqueued links count', async () => {
      const mockEnqueueLinks = vi.fn().mockResolvedValue({
        processedRequests: [{ uniqueKey: '/page1' }, { uniqueKey: '/page2' }],
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      expect(mockLog.info).toHaveBeenCalledWith('Enqueued links:', {
        processedCount: 2,
        urls: ['/page1', '/page2'],
      });
    });

    it('should transform request URLs to use pathname as unique key', async () => {
      let capturedOptions: EnqueueLinksOptions | null = null;

      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      expect(capturedOptions).not.toBeNull();
      const transformFn = capturedOptions!.transformRequestFunction;
      expect(transformFn).toBeDefined();

      if (transformFn) {
        const transformed = transformFn({
          url: 'https://example.com/new/page?param=1',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);

        expect(transformed).toEqual(
          expect.objectContaining({
            url: 'https://example.com/new/page?param=1',
            uniqueKey: '/new/page?param=1',
          })
        );
      }
    });
  });

  describe('addResult and processBatch', () => {
    beforeEach(async () => {
      await queueManager.initialize('https://example.com');
    });

    it('should add results', () => {
      const result: CrawlResult = {
        url: 'https://example.com/page',
        path: '/page',
        content: 'Test content',
        title: 'Test Page',
      };

      queueManager.addResult(result);

      expect(queueManager.hasEnoughResults()).toBe(false);
    });

    it('should process batch and return results', async () => {
      const result: CrawlResult = {
        url: 'https://example.com/page',
        path: '/page',
        content: 'Test content',
        title: 'Test Page',
      };

      queueManager.addResult(result);

      const processed = await queueManager.processBatch();

      expect(processed).toHaveLength(1);
      expect(processed[0]).toEqual(result);
      expect(mockDataset.pushData).toHaveBeenCalled();
    });

    it('should return empty array when no results', async () => {
      const processed = await queueManager.processBatch();

      expect(processed).toHaveLength(0);
    });

    it('should clear results after processing', async () => {
      queueManager.addResult({
        url: 'https://example.com/page',
        path: '/page',
        content: 'Test',
        title: 'Test',
      });

      await queueManager.processBatch();
      const secondBatch = await queueManager.processBatch();

      expect(secondBatch).toHaveLength(0);
    });

    it('should push data to dataset in chunks', async () => {
      // Add 7 results
      for (let i = 0; i < 7; i++) {
        queueManager.addResult({
          url: `https://example.com/page${i}`,
          path: `/page${i}`,
          content: `Content ${i}`,
          title: `Page ${i}`,
        });
      }

      await queueManager.processBatch();

      // Should be pushed in chunks of 5
      expect(mockDataset.pushData).toHaveBeenCalledTimes(2);
    });
  });

  describe('hasEnoughResults', () => {
    beforeEach(async () => {
      await queueManager.initialize('https://example.com');
    });

    it('should return false when below batch size', () => {
      for (let i = 0; i < 10; i++) {
        queueManager.addResult({
          url: `https://example.com/page${i}`,
          path: `/page${i}`,
          content: `Content ${i}`,
          title: `Page ${i}`,
        });
      }

      expect(queueManager.hasEnoughResults()).toBe(false);
    });

    it('should return true when at batch size', () => {
      for (let i = 0; i < 20; i++) {
        queueManager.addResult({
          url: `https://example.com/page${i}`,
          path: `/page${i}`,
          content: `Content ${i}`,
          title: `Page ${i}`,
        });
      }

      expect(queueManager.hasEnoughResults()).toBe(true);
    });
  });

  describe('getRequestQueue', () => {
    it('should return null before initialization', () => {
      expect(queueManager.getRequestQueue()).toBeNull();
    });

    it('should return request queue after initialization', async () => {
      await queueManager.initialize('https://example.com');

      expect(queueManager.getRequestQueue()).toBe(mockRequestQueue);
    });
  });

  describe('cleanup', () => {
    it('should clear results and drop queue', async () => {
      await queueManager.initialize('https://example.com');

      queueManager.addResult({
        url: 'https://example.com/page',
        path: '/page',
        content: 'Test',
        title: 'Test',
      });

      await queueManager.cleanup();

      expect(mockRequestQueue.drop).toHaveBeenCalled();
      expect(queueManager.getRequestQueue()).toBeNull();

      // Results should be cleared
      const processed = await queueManager.processBatch();
      expect(processed).toHaveLength(0);
    });

    it('should handle cleanup errors gracefully', async () => {
      await queueManager.initialize('https://example.com');

      mockRequestQueue.drop.mockRejectedValueOnce(new Error('Drop failed'));

      // Should not throw
      await expect(queueManager.cleanup()).resolves.toBeUndefined();
    });
  });
});
