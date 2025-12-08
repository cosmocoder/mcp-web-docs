import { IndexingStatusTracker } from './status.js';

// Mock cli-progress to avoid terminal output during tests
vi.mock('cli-progress', () => {
  class MockSingleBar {
    update = vi.fn();
    stop = vi.fn();
  }

  class MockMultiBar {
    create = vi.fn(() => new MockSingleBar());
    stop = vi.fn();
  }

  return {
    SingleBar: MockSingleBar,
    MultiBar: MockMultiBar,
  };
});

describe('IndexingStatusTracker', () => {
  let tracker: IndexingStatusTracker;

  beforeEach(() => {
    tracker = new IndexingStatusTracker();
  });

  afterEach(() => {
    tracker.stop();
  });

  describe('startIndexing', () => {
    it('should create initial status', () => {
      tracker.startIndexing('test-id', 'https://example.com', 'Test Site');

      const status = tracker.getStatus('test-id');
      expect(status).toBeDefined();
      expect(status?.id).toBe('test-id');
      expect(status?.url).toBe('https://example.com');
      expect(status?.title).toBe('Test Site');
      expect(status?.status).toBe('indexing');
      expect(status?.progress).toBe(0);
      expect(status?.startedAt).toBeInstanceOf(Date);
    });

    it('should initialize tracking fields', () => {
      tracker.startIndexing('test-id', 'https://example.com', 'Test');

      const status = tracker.getStatus('test-id');
      expect(status?.pagesFound).toBe(0);
      expect(status?.pagesProcessed).toBe(0);
      expect(status?.chunksCreated).toBe(0);
    });
  });

  describe('updateProgress', () => {
    beforeEach(() => {
      tracker.startIndexing('test-id', 'https://example.com', 'Test');
    });

    it('should update progress and description', () => {
      tracker.updateProgress('test-id', 0.5, 'Halfway done');

      const status = tracker.getStatus('test-id');
      expect(status?.progress).toBe(0.5);
      expect(status?.description).toBe('Halfway done');
    });

    it('should not change completed status back to indexing', () => {
      tracker.completeIndexing('test-id');
      tracker.updateProgress('test-id', 0.5, 'Still going');

      const status = tracker.getStatus('test-id');
      expect(status?.status).toBe('complete');
    });

    it('should ignore updates for unknown ids', () => {
      tracker.updateProgress('unknown-id', 0.5, 'Test');
      expect(tracker.getStatus('unknown-id')).toBeUndefined();
    });
  });

  describe('updateStats', () => {
    beforeEach(() => {
      tracker.startIndexing('test-id', 'https://example.com', 'Test');
    });

    it('should update stats incrementally', () => {
      tracker.updateStats('test-id', { pagesFound: 10 });
      let status = tracker.getStatus('test-id');
      expect(status?.pagesFound).toBe(10);

      tracker.updateStats('test-id', { pagesProcessed: 5 });
      status = tracker.getStatus('test-id');
      expect(status?.pagesFound).toBe(10);
      expect(status?.pagesProcessed).toBe(5);

      tracker.updateStats('test-id', { chunksCreated: 20 });
      status = tracker.getStatus('test-id');
      expect(status?.chunksCreated).toBe(20);
    });

    it('should ignore stats updates for unknown ids', () => {
      tracker.updateStats('unknown-id', { pagesFound: 10 });
      // Should not throw
    });
  });

  describe('completeIndexing', () => {
    beforeEach(() => {
      tracker.startIndexing('test-id', 'https://example.com', 'Test');
    });

    it('should mark indexing as complete', () => {
      tracker.completeIndexing('test-id');

      const status = tracker.getStatus('test-id');
      expect(status?.status).toBe('complete');
      expect(status?.progress).toBe(1);
      expect(status?.description).toBe('Indexing complete');
    });

    it('should ignore completion for unknown ids', () => {
      tracker.completeIndexing('unknown-id');
      // Should not throw
    });
  });

  describe('failIndexing', () => {
    beforeEach(() => {
      tracker.startIndexing('test-id', 'https://example.com', 'Test');
    });

    it('should mark indexing as failed with error', () => {
      tracker.failIndexing('test-id', 'Connection timeout');

      const status = tracker.getStatus('test-id');
      expect(status?.status).toBe('failed');
      expect(status?.error).toBe('Connection timeout');
      expect(status?.description).toBe('Connection timeout');
    });
  });

  describe('abortIndexing', () => {
    beforeEach(() => {
      tracker.startIndexing('test-id', 'https://example.com', 'Test');
    });

    it('should mark indexing as aborted', () => {
      tracker.abortIndexing('test-id');

      const status = tracker.getStatus('test-id');
      expect(status?.status).toBe('aborted');
      expect(status?.description).toBe('Indexing aborted');
    });
  });

  describe('cancelIndexing', () => {
    beforeEach(() => {
      tracker.startIndexing('test-id', 'https://example.com', 'Test');
    });

    it('should mark indexing as cancelled', () => {
      tracker.cancelIndexing('test-id');

      const status = tracker.getStatus('test-id');
      expect(status?.status).toBe('cancelled');
      expect(status?.description).toContain('Cancelled');
    });
  });

  describe('status listeners', () => {
    it('should notify listeners on status changes', () => {
      const listener = vi.fn();
      tracker.addStatusListener(listener);

      tracker.startIndexing('test-id', 'https://example.com', 'Test');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-id',
          status: 'indexing',
        })
      );

      tracker.updateProgress('test-id', 0.5, 'Progress');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          progress: 0.5,
        })
      );

      tracker.completeIndexing('test-id');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'complete',
        })
      );
    });

    it('should support multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      tracker.addStatusListener(listener1);
      tracker.addStatusListener(listener2);

      tracker.startIndexing('test-id', 'https://example.com', 'Test');

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });
  });

  describe('getAllStatuses', () => {
    it('should return all statuses', () => {
      tracker.startIndexing('id1', 'https://example1.com', 'Site 1');
      tracker.startIndexing('id2', 'https://example2.com', 'Site 2');
      tracker.startIndexing('id3', 'https://example3.com', 'Site 3');

      const statuses = tracker.getAllStatuses();
      expect(statuses.length).toBe(3);
    });

    it('should return empty array when no statuses', () => {
      const statuses = tracker.getAllStatuses();
      expect(statuses).toEqual([]);
    });
  });

  describe('getActiveStatuses', () => {
    it('should return only active statuses', () => {
      tracker.startIndexing('active', 'https://active.com', 'Active');
      tracker.startIndexing('complete', 'https://complete.com', 'Complete');
      tracker.completeIndexing('complete');

      const active = tracker.getActiveStatuses();

      // Active should always be included
      expect(active.some((s) => s.id === 'active')).toBe(true);
    });

    it('should include recently completed statuses', () => {
      tracker.startIndexing('test', 'https://test.com', 'Test');
      tracker.completeIndexing('test');

      const active = tracker.getActiveStatuses();
      expect(active.some((s) => s.id === 'test')).toBe(true);
    });
  });

  describe('concurrent operations', () => {
    it('should handle multiple concurrent indexing operations', () => {
      tracker.startIndexing('id1', 'https://example1.com', 'Site 1');
      tracker.startIndexing('id2', 'https://example2.com', 'Site 2');

      tracker.updateProgress('id1', 0.3, 'Progress 1');
      tracker.updateProgress('id2', 0.6, 'Progress 2');

      const status1 = tracker.getStatus('id1');
      const status2 = tracker.getStatus('id2');

      expect(status1?.progress).toBe(0.3);
      expect(status2?.progress).toBe(0.6);
    });

    it('should handle mixed completion states', () => {
      tracker.startIndexing('id1', 'https://example1.com', 'Site 1');
      tracker.startIndexing('id2', 'https://example2.com', 'Site 2');
      tracker.startIndexing('id3', 'https://example3.com', 'Site 3');

      tracker.completeIndexing('id1');
      tracker.failIndexing('id2', 'Error');
      // id3 still indexing

      expect(tracker.getStatus('id1')?.status).toBe('complete');
      expect(tracker.getStatus('id2')?.status).toBe('failed');
      expect(tracker.getStatus('id3')?.status).toBe('indexing');
    });
  });

  describe('edge cases', () => {
    it('should handle very long titles', () => {
      const longTitle = 'A'.repeat(100);
      tracker.startIndexing('test', 'https://example.com', longTitle);

      const status = tracker.getStatus('test');
      expect(status?.title).toBe(longTitle);
    });

    it('should handle special characters in error messages', () => {
      tracker.startIndexing('test', 'https://example.com', 'Test');
      tracker.failIndexing('test', 'Error with \'quotes\' and "doubles" and <tags>');

      const status = tracker.getStatus('test');
      expect(status?.error).toContain('quotes');
    });

    it('should handle progress values at boundaries', () => {
      tracker.startIndexing('test', 'https://example.com', 'Test');

      tracker.updateProgress('test', 0, 'Start');
      expect(tracker.getStatus('test')?.progress).toBe(0);

      tracker.updateProgress('test', 1, 'End');
      expect(tracker.getStatus('test')?.progress).toBe(1);
    });

    it('should handle progress values beyond boundaries', () => {
      tracker.startIndexing('test', 'https://example.com', 'Test');

      tracker.updateProgress('test', -0.1, 'Negative');
      // Implementation may or may not clamp - just verify no crash

      tracker.updateProgress('test', 1.5, 'Over');
      // Implementation may or may not clamp - just verify no crash
    });
  });
});
