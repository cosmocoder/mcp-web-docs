import { IndexingQueueManager } from './queue-manager.js';

describe('IndexingQueueManager', () => {
  let queue: IndexingQueueManager;

  beforeEach(() => {
    queue = new IndexingQueueManager();
  });

  describe('startOperation', () => {
    it('should return an AbortController for new operations', async () => {
      const controller = await queue.startOperation('https://example.com');

      expect(controller).toBeDefined();
      expect(controller).toBeInstanceOf(AbortController);
      expect(controller.signal.aborted).toBe(false);
    });

    it('should normalize URLs when starting operations', async () => {
      const controller = await queue.startOperation('https://example.com/');

      // Register the operation to verify normalization works
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example.com/', controller, mockPromise);

      // Should find it with or without trailing slash
      expect(queue.isIndexing('https://example.com')).toBe(true);
      expect(queue.isIndexing('https://example.com/')).toBe(true);

      queue.completeOperation('https://example.com');
    });

    it('should cancel existing operation when starting new one for same URL', async () => {
      // Start first operation
      const controller1 = await queue.startOperation('https://example.com');
      const mockPromise1 = new Promise<void>((_resolve, reject) => {
        controller1.signal.addEventListener('abort', () => reject(new Error('Aborted')));
      });
      queue.registerOperation('https://example.com', controller1, mockPromise1);

      // Start second operation for same URL - should cancel first
      const controller2 = await queue.startOperation('https://example.com');

      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(false);

      queue.completeOperation('https://example.com');
    });

    it('should not affect operations for different URLs', async () => {
      const controller1 = await queue.startOperation('https://example.com');
      const mockPromise1 = new Promise<void>((resolve) => setTimeout(resolve, 1000));
      queue.registerOperation('https://example.com', controller1, mockPromise1);

      const controller2 = await queue.startOperation('https://other.com');
      const mockPromise2 = new Promise<void>((resolve) => setTimeout(resolve, 1000));
      queue.registerOperation('https://other.com', controller2, mockPromise2);

      // Both should be active
      expect(controller1.signal.aborted).toBe(false);
      expect(controller2.signal.aborted).toBe(false);
      expect(queue.isIndexing('https://example.com')).toBe(true);
      expect(queue.isIndexing('https://other.com')).toBe(true);

      queue.completeOperation('https://example.com');
      queue.completeOperation('https://other.com');
    });

    it('should handle cancellation timeout gracefully', async () => {
      vi.useFakeTimers();

      // Start operation that never resolves
      const controller1 = await queue.startOperation('https://example.com');
      const neverResolves = new Promise<void>(() => {
        // This promise never resolves
      });
      queue.registerOperation('https://example.com', controller1, neverResolves);

      // Start new operation - should timeout waiting for cancellation
      const startPromise = queue.startOperation('https://example.com');

      // Advance timers past the 5000ms timeout
      await vi.advanceTimersByTimeAsync(5100);

      const controller2 = await startPromise;

      // Should have returned a new controller after timeout
      expect(controller2).toBeDefined();
      expect(controller2.signal.aborted).toBe(false);

      queue.completeOperation('https://example.com');
      vi.useRealTimers();
    });
  });

  describe('registerOperation', () => {
    it('should register an operation', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));

      queue.registerOperation('https://example.com', controller, mockPromise);

      expect(queue.isIndexing('https://example.com')).toBe(true);

      queue.completeOperation('https://example.com');
    });

    it('should store operation with correct metadata', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));

      const beforeRegister = new Date();
      queue.registerOperation('https://example.com', controller, mockPromise);
      const afterRegister = new Date();

      const operations = queue.getActiveOperations();
      expect(operations).toHaveLength(1);
      expect(operations[0].url).toBe('https://example.com');
      expect(operations[0].startedAt.getTime()).toBeGreaterThanOrEqual(beforeRegister.getTime());
      expect(operations[0].startedAt.getTime()).toBeLessThanOrEqual(afterRegister.getTime());

      queue.completeOperation('https://example.com');
    });

    it('should normalize URL when registering', async () => {
      const controller = await queue.startOperation('https://example.com/');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));

      queue.registerOperation('https://example.com/', controller, mockPromise);

      // Should be findable with normalized URL
      expect(queue.isIndexing('https://example.com')).toBe(true);

      queue.completeOperation('https://example.com');
    });
  });

  describe('completeOperation', () => {
    it('should remove operation from active map', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example.com', controller, mockPromise);

      expect(queue.isIndexing('https://example.com')).toBe(true);

      queue.completeOperation('https://example.com');

      expect(queue.isIndexing('https://example.com')).toBe(false);
    });

    it('should handle completing non-existent operation gracefully', () => {
      // Should not throw
      expect(() => queue.completeOperation('https://nonexistent.com')).not.toThrow();
    });

    it('should normalize URL when completing', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example.com', controller, mockPromise);

      // Complete with trailing slash
      queue.completeOperation('https://example.com/');

      expect(queue.isIndexing('https://example.com')).toBe(false);
    });
  });

  describe('cancelAll', () => {
    it('should cancel all active operations', async () => {
      const controller1 = await queue.startOperation('https://example1.com');
      const mockPromise1 = new Promise<void>((resolve) => {
        controller1.signal.addEventListener('abort', () => resolve());
      });
      queue.registerOperation('https://example1.com', controller1, mockPromise1);

      const controller2 = await queue.startOperation('https://example2.com');
      const mockPromise2 = new Promise<void>((resolve) => {
        controller2.signal.addEventListener('abort', () => resolve());
      });
      queue.registerOperation('https://example2.com', controller2, mockPromise2);

      expect(queue.getActiveOperations()).toHaveLength(2);

      await queue.cancelAll();

      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(true);
      expect(queue.getActiveOperations()).toHaveLength(0);
    });

    it('should handle empty queue', async () => {
      await expect(queue.cancelAll()).resolves.not.toThrow();
      expect(queue.getActiveOperations()).toHaveLength(0);
    });

    it('should handle operations that reject on cancel', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('Cancelled')));
      });
      queue.registerOperation('https://example.com', controller, mockPromise);

      // Should not throw even if promises reject
      await expect(queue.cancelAll()).resolves.not.toThrow();
      expect(queue.getActiveOperations()).toHaveLength(0);
    });
  });

  describe('isIndexing', () => {
    it('should return false for URLs not being indexed', () => {
      expect(queue.isIndexing('https://example.com')).toBe(false);
    });

    it('should return true for URLs being indexed', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example.com', controller, mockPromise);

      expect(queue.isIndexing('https://example.com')).toBe(true);

      queue.completeOperation('https://example.com');
    });

    it('should return false after operation completes', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example.com', controller, mockPromise);
      queue.completeOperation('https://example.com');

      expect(queue.isIndexing('https://example.com')).toBe(false);
    });

    it('should normalize URL when checking', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example.com', controller, mockPromise);

      // Check with trailing slash
      expect(queue.isIndexing('https://example.com/')).toBe(true);

      queue.completeOperation('https://example.com');
    });
  });

  describe('getActiveOperations', () => {
    it('should return empty array when no operations', () => {
      expect(queue.getActiveOperations()).toEqual([]);
    });

    it('should return all active operations', async () => {
      const controller1 = await queue.startOperation('https://example1.com');
      const mockPromise1 = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example1.com', controller1, mockPromise1);

      const controller2 = await queue.startOperation('https://example2.com');
      const mockPromise2 = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example2.com', controller2, mockPromise2);

      const operations = queue.getActiveOperations();
      expect(operations).toHaveLength(2);

      const urls = operations.map((op) => op.url);
      expect(urls).toContain('https://example1.com');
      expect(urls).toContain('https://example2.com');

      queue.completeOperation('https://example1.com');
      queue.completeOperation('https://example2.com');
    });

    it('should return operation metadata', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example.com', controller, mockPromise);

      const operations = queue.getActiveOperations();
      expect(operations[0]).toHaveProperty('url');
      expect(operations[0]).toHaveProperty('startedAt');
      expect(operations[0].startedAt).toBeInstanceOf(Date);

      queue.completeOperation('https://example.com');
    });

    it('should not include completed operations', async () => {
      const controller = await queue.startOperation('https://example.com');
      const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
      queue.registerOperation('https://example.com', controller, mockPromise);
      queue.completeOperation('https://example.com');

      expect(queue.getActiveOperations()).toHaveLength(0);
    });
  });

  describe('concurrent operations', () => {
    it('should handle multiple concurrent operations for different URLs', async () => {
      const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
      const controllers: AbortController[] = [];

      for (const url of urls) {
        const controller = await queue.startOperation(url);
        const mockPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
        queue.registerOperation(url, controller, mockPromise);
        controllers.push(controller);
      }

      expect(queue.getActiveOperations()).toHaveLength(3);

      // All should be active
      for (const controller of controllers) {
        expect(controller.signal.aborted).toBe(false);
      }

      // Complete one
      queue.completeOperation('https://b.com');
      expect(queue.getActiveOperations()).toHaveLength(2);
      expect(queue.isIndexing('https://a.com')).toBe(true);
      expect(queue.isIndexing('https://b.com')).toBe(false);
      expect(queue.isIndexing('https://c.com')).toBe(true);

      queue.completeOperation('https://a.com');
      queue.completeOperation('https://c.com');
    });

    it('should handle rapid start/complete cycles', async () => {
      for (let i = 0; i < 10; i++) {
        const controller = await queue.startOperation('https://example.com');
        const mockPromise = Promise.resolve();
        queue.registerOperation('https://example.com', controller, mockPromise);
        queue.completeOperation('https://example.com');
      }

      expect(queue.isIndexing('https://example.com')).toBe(false);
      expect(queue.getActiveOperations()).toHaveLength(0);
    });
  });
});
