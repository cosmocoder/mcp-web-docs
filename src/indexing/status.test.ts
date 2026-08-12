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
      tracker.startIndexing('test-id', 'test-id', 'https://example.com', 'Test Site');

      const status = tracker.getStatus('test-id');
      expect(status).toBeDefined();
      expect(status?.operationId).toBe('test-id');
      expect(status?.documentId).toBe('test-id');
      expect(status?.id).toBe('test-id');
      expect(status?.url).toBe('https://example.com');
      expect(status?.title).toBe('Test Site');
      expect(status?.status).toBe('indexing');
      expect(status?.progress).toBe(0);
      expect(status?.startedAt).toBeInstanceOf(Date);
    });

    it('should initialize tracking fields', () => {
      tracker.startIndexing('test-id', 'test-id', 'https://example.com', 'Test');

      const status = tracker.getStatus('test-id');
      expect(status?.pagesFound).toBe(0);
      expect(status?.pagesProcessed).toBe(0);
      expect(status?.chunksCreated).toBe(0);
    });
  });

  describe('updateProgress', () => {
    beforeEach(() => {
      tracker.startIndexing('test-id', 'test-id', 'https://example.com', 'Test');
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
      tracker.startIndexing('test-id', 'test-id', 'https://example.com', 'Test');
    });

    it('should keep pagesSkipped through later stat updates', () => {
      tracker.updateStats('test-id', { pagesSkipped: 3 });
      tracker.updateStats('test-id', { chunksCreated: 20 });

      expect(tracker.getStatus('test-id')).toMatchObject({ pagesSkipped: 3, chunksCreated: 20 });
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
      tracker.startIndexing('test-id', 'test-id', 'https://example.com', 'Test');
    });

    it('should mark indexing as complete', () => {
      tracker.completeIndexing('test-id');

      const status = tracker.getStatus('test-id');
      expect(status?.status).toBe('complete');
      expect(status?.progress).toBe(1);
      expect(status?.description).toBe('Indexing complete');
    });

    it('should say so when pages are missing from the index', () => {
      tracker.updateStats('test-id', { pagesFound: 120, pagesFailed: 4 });
      tracker.completeIndexing('test-id');

      const status = tracker.getStatus('test-id');
      expect(status?.status).toBe('complete');
      expect(status?.pagesFailed).toBe(4);
      expect(status?.description).toBe('Indexing complete, but 4 pages could not be fetched and are missing from the index');
    });

    // The tolerance floor is max(5, 2%), so a single lost page is the likeliest non-zero case
    it('should use the singular when exactly one page is missing', () => {
      tracker.updateStats('test-id', { pagesFound: 120, pagesFailed: 1 });
      tracker.completeIndexing('test-id');

      expect(tracker.getStatus('test-id')?.description).toBe(
        'Indexing complete, but 1 page could not be fetched and is missing from the index'
      );
    });

    // The count alone cannot tell a correct skip from a mistaken one, and both remedies need a URL
    it('should name the login pages it left out of the index', () => {
      tracker.updateStats('test-id', {
        pagesFound: 40,
        loginPagesSkipped: 2,
        skippedLoginUrls: ['https://docs.example.com/login', 'https://docs.example.com/admin'],
      });
      tracker.completeIndexing('test-id');

      const description = tracker.getStatus('test-id')?.description;
      expect(description).toContain('2 pages asked for a password and were left out');
      expect(description).toContain('https://docs.example.com/login, https://docs.example.com/admin');
      expect(description).toContain("Use the 'authenticate' tool");
      expect(description).toContain('pathPrefix');
      // Every URL is named, so there is no remainder to mention
      expect(description).not.toContain('more');
    });

    // A walled crawl can skip hundreds; the point is to name the part of the site, not to paste it
    it('should name only the first few and count the rest', () => {
      tracker.updateStats('test-id', {
        loginPagesSkipped: 9,
        skippedLoginUrls: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `https://docs.example.com/p${n}`),
      });
      tracker.completeIndexing('test-id');

      const description = tracker.getStatus('test-id')?.description;
      expect(description).toContain('https://docs.example.com/p3');
      expect(description).not.toContain('https://docs.example.com/p4');
      expect(description).toContain('and 6 more');
    });

    // Both kinds of absence at once: one sentence must not hide the other
    it('should report failed pages and login pages together', () => {
      tracker.updateStats('test-id', { pagesFailed: 2, loginPagesSkipped: 1, skippedLoginUrls: ['https://docs.example.com/login'] });
      tracker.completeIndexing('test-id');

      // Asserted across the seam: two substrings on their own pass however the sentences are joined
      expect(tracker.getStatus('test-id')?.description).toContain(
        'missing from the index; and 1 page asked for a password and was left out'
      );
    });

    // Nothing to name is not an empty pair of brackets
    it('should not name any URL when it has none', () => {
      tracker.updateStats('test-id', { loginPagesSkipped: 2 });
      tracker.completeIndexing('test-id');

      const description = tracker.getStatus('test-id')?.description;
      expect(description).toContain('2 pages asked for a password');
      // No bracket at all, rather than an empty or comma-led one
      expect(description).not.toContain('(');
    });

    // The whole status goes to the client on every poll, so the list is capped where it is stored
    it('should keep only the first few URLs it was given', () => {
      tracker.updateStats('test-id', {
        loginPagesSkipped: 9,
        skippedLoginUrls: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `https://docs.example.com/p${n}`),
      });

      expect(tracker.getStatus('test-id')?.skippedLoginUrls).toEqual([
        'https://docs.example.com/p1',
        'https://docs.example.com/p2',
        'https://docs.example.com/p3',
      ]);
    });

    // Three clauses, so the conjunction goes before the last one rather than before each
    it('should list all three kinds of missing page readably', () => {
      tracker.updateStats('test-id', {
        pagesFailed: 2,
        pagesSkipped: 1,
        loginPagesSkipped: 1,
        skippedLoginUrls: ['https://docs.example.com/login'],
      });
      tracker.completeIndexing('test-id');

      const description = tracker.getStatus('test-id')?.description;
      expect(description).toContain(
        'could not be fetched and are missing from the index; 1 page had no indexable content; and 1 page asked'
      );
      expect(description).not.toContain('; and 1 page had no indexable content');
    });

    it('should ignore completion for unknown ids', () => {
      tracker.completeIndexing('unknown-id');
      // Should not throw
    });
  });

  describe('failIndexing', () => {
    beforeEach(() => {
      tracker.startIndexing('test-id', 'test-id', 'https://example.com', 'Test');
    });

    it('should mark indexing as failed with error', () => {
      tracker.failIndexing('test-id', 'Connection timeout');

      const status = tracker.getStatus('test-id');
      expect(status?.status).toBe('failed');
      expect(status?.error).toBe('Connection timeout');
      expect(status?.description).toBe('Connection timeout');
    });
  });

  describe('cancelIndexing', () => {
    beforeEach(() => {
      tracker.startIndexing('test-id', 'test-id', 'https://example.com', 'Test');
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

      tracker.startIndexing('test-id', 'test-id', 'https://example.com', 'Test');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'test-id',
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

      tracker.startIndexing('test-id', 'test-id', 'https://example.com', 'Test');

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });
  });

  describe('getActiveStatuses', () => {
    it('should return only active statuses', () => {
      tracker.startIndexing('active', 'active', 'https://active.com', 'Active');
      tracker.startIndexing('complete', 'complete', 'https://complete.com', 'Complete');
      tracker.completeIndexing('complete');

      const active = tracker.getActiveStatuses();

      // Active should always be included
      expect(active.some((s) => s.id === 'active')).toBe(true);
    });

    it('should include recently completed statuses', () => {
      tracker.startIndexing('test', 'test', 'https://test.com', 'Test');
      tracker.completeIndexing('test');

      const active = tracker.getActiveStatuses();
      expect(active.some((s) => s.id === 'test')).toBe(true);
    });
  });

  describe('concurrent operations', () => {
    it('should keep operations with the same document ID independent', () => {
      tracker.startIndexing('operation-1', 'shared-doc', 'https://example.com/one', 'Site 1');
      tracker.startIndexing('operation-2', 'shared-doc', 'https://example.com/two', 'Site 2');

      tracker.updateProgress('operation-1', 0.3, 'Progress 1');
      tracker.updateProgress('operation-2', 0.6, 'Progress 2');
      tracker.cancelIndexing('operation-1');

      expect(tracker.getStatus('operation-1')).toEqual(
        expect.objectContaining({
          operationId: 'operation-1',
          documentId: 'shared-doc',
          id: 'shared-doc',
          status: 'cancelled',
        })
      );
      expect(tracker.getStatus('operation-2')).toEqual(
        expect.objectContaining({
          operationId: 'operation-2',
          documentId: 'shared-doc',
          id: 'shared-doc',
          status: 'indexing',
          progress: 0.6,
        })
      );
    });

    it('should clean up a completed operation without removing an active operation for the same document', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        tracker.startIndexing('operation-1', 'shared-doc', 'https://example.com/one', 'Site 1');
        tracker.startIndexing('operation-2', 'shared-doc', 'https://example.com/two', 'Site 2');
        tracker.completeIndexing('operation-1');

        vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));
        const active = tracker.getActiveStatuses();

        expect(active.map((status) => status.operationId)).toEqual(['operation-2']);
        expect(tracker.getStatus('operation-1')).toBeUndefined();
        expect(tracker.getStatus('operation-2')?.documentId).toBe('shared-doc');
      }
      finally {
        vi.useRealTimers();
      }
    });

    it('should handle mixed completion states', () => {
      tracker.startIndexing('id1', 'id1', 'https://example1.com', 'Site 1');
      tracker.startIndexing('id2', 'id2', 'https://example2.com', 'Site 2');
      tracker.startIndexing('id3', 'id3', 'https://example3.com', 'Site 3');

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
      tracker.startIndexing('test', 'test', 'https://example.com', longTitle);

      const status = tracker.getStatus('test');
      expect(status?.title).toBe(longTitle);
    });

    it('should handle special characters in error messages', () => {
      tracker.startIndexing('test', 'test', 'https://example.com', 'Test');
      tracker.failIndexing('test', 'Error with \'quotes\' and "doubles" and <tags>');

      const status = tracker.getStatus('test');
      expect(status?.error).toContain('quotes');
    });

    it('should handle progress values at boundaries', () => {
      tracker.startIndexing('test', 'test', 'https://example.com', 'Test');

      tracker.updateProgress('test', 0, 'Start');
      expect(tracker.getStatus('test')?.progress).toBe(0);

      tracker.updateProgress('test', 1, 'End');
      expect(tracker.getStatus('test')?.progress).toBe(1);
    });

    it('should handle progress values beyond boundaries', () => {
      tracker.startIndexing('test', 'test', 'https://example.com', 'Test');

      tracker.updateProgress('test', -0.1, 'Negative');
      // Implementation may or may not clamp - just verify no crash

      tracker.updateProgress('test', 1.5, 'Over');
      // Implementation may or may not clamp - just verify no crash
    });
  });
});
