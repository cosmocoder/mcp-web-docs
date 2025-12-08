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

    it('should skip anchor links with hash fragments', async () => {
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
        // Test that anchor links are filtered out (return false)
        const anchorResult = transformFn({
          url: 'https://example.com/page#section',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);

        expect(anchorResult).toBe(false);
      }
    });

    it('should strip hash from URL when returning transformed request', async () => {
      let capturedOptions: EnqueueLinksOptions | null = null;

      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        // URL without hash should be returned with clean URL
        const transformed = transformFn({
          url: 'https://example.com/page',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);

        expect(transformed).toEqual(
          expect.objectContaining({
            url: 'https://example.com/page',
            uniqueKey: '/page',
          })
        );
      }
    });
  });

  describe('path prefix filtering', () => {
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

    it('should initialize with path prefix', async () => {
      await queueManager.initialize('https://example.com/docs/api', '/docs/api');

      // The path prefix should be stored (we can verify through transform function behavior)
      expect(queueManager.getFilteredByPathCount()).toBe(0);
    });

    it('should allow URLs within path prefix', async () => {
      await queueManager.initialize('https://example.com/docs', '/docs');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        // Exact match
        const exactMatch = transformFn({
          url: 'https://example.com/docs',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);
        expect(exactMatch).not.toBe(false);

        // Subpath
        const subpath = transformFn({
          url: 'https://example.com/docs/api/v2',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);
        expect(subpath).not.toBe(false);
      }
    });

    it('should filter URLs outside path prefix', async () => {
      await queueManager.initialize('https://example.com/docs', '/docs');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        // Different path entirely
        const differentPath = transformFn({
          url: 'https://example.com/blog/post',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);
        expect(differentPath).toBe(false);
      }
    });

    it('should not match paths that only start with prefix string', async () => {
      await queueManager.initialize('https://example.com/docs', '/docs');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        // /documentation starts with /docs but is NOT a subpath of /docs
        const similarButDifferent = transformFn({
          url: 'https://example.com/documentation',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);
        expect(similarButDifferent).toBe(false);
      }
    });

    it('should track filtered URL count', async () => {
      await queueManager.initialize('https://example.com/docs', '/docs');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        // Filter some URLs
        transformFn({ url: 'https://example.com/blog', uniqueKey: 'a' } as Parameters<typeof transformFn>[0]);
        transformFn({ url: 'https://example.com/about', uniqueKey: 'b' } as Parameters<typeof transformFn>[0]);
      }

      expect(queueManager.getFilteredByPathCount()).toBe(2);
    });

    it('should strip hash from initial URL', async () => {
      await queueManager.initialize('https://example.com/docs#intro');

      expect(mockRequestQueue.addRequest).toHaveBeenCalledWith({
        url: 'https://example.com/docs',
        uniqueKey: '/docs',
      });
    });
  });

  describe('hostname filtering', () => {
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

    it('should allow URLs with exact hostname match', async () => {
      await queueManager.initialize('https://docs.example.com/api');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        const result = transformFn({
          url: 'https://docs.example.com/other',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);
        expect(result).not.toBe(false);
      }
    });

    it('should allow URLs with subdomain of starting hostname', async () => {
      await queueManager.initialize('https://docs.example.com/api');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        // api.docs.example.com is a subdomain of docs.example.com - should be allowed
        const result = transformFn({
          url: 'https://api.docs.example.com/endpoint',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);
        expect(result).not.toBe(false);
      }
    });

    it('should filter URLs with sibling subdomain', async () => {
      await queueManager.initialize('https://docs.example.com/api');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        // python.example.com is a sibling subdomain, not a subdomain of docs.example.com
        const result = transformFn({
          url: 'https://python.example.com/guide',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);
        expect(result).toBe(false);
      }
    });

    it('should filter URLs with parent domain', async () => {
      await queueManager.initialize('https://docs.example.com/api');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        // example.com is the parent domain of docs.example.com
        const result = transformFn({
          url: 'https://example.com/home',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);
        expect(result).toBe(false);
      }
    });

    it('should track filtered hostname count', async () => {
      await queueManager.initialize('https://docs.example.com/api');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        // Filter some URLs with wrong hostnames
        transformFn({ url: 'https://python.example.com/a', uniqueKey: 'a' } as Parameters<typeof transformFn>[0]);
        transformFn({ url: 'https://other.example.com/b', uniqueKey: 'b' } as Parameters<typeof transformFn>[0]);
      }

      expect(queueManager.getFilteredByHostnameCount()).toBe(2);
    });

    it('should handle case-insensitive hostname matching', async () => {
      await queueManager.initialize('https://Docs.Example.Com/api');

      let capturedOptions: EnqueueLinksOptions | null = null;
      const mockEnqueueLinks = vi.fn().mockImplementation((options: EnqueueLinksOptions) => {
        capturedOptions = options;
        return Promise.resolve({ processedRequests: [] });
      });

      await queueManager.handleQueueAndLinks(mockEnqueueLinks, mockLog, mockRule);

      const transformFn = capturedOptions!.transformRequestFunction;
      if (transformFn) {
        const result = transformFn({
          url: 'https://docs.example.com/other',
          uniqueKey: 'original',
        } as Parameters<typeof transformFn>[0]);
        expect(result).not.toBe(false);
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
