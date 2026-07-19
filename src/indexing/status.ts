import { SingleBar, MultiBar } from 'cli-progress';
import { IndexingStatus } from '../types.js';

/** How long to keep completed/failed statuses before auto-cleanup (2 minutes) */
const COMPLETED_STATUS_TTL_MS = 2 * 60 * 1000;

export class IndexingStatusTracker {
  private multibar: MultiBar;
  private bars: Map<string, SingleBar>;
  private statuses: Map<string, IndexingStatus>;
  private statusListeners: Array<(status: IndexingStatus) => void>;
  /** Tracks when statuses completed for auto-cleanup */
  private completedAt: Map<string, Date>;

  constructor() {
    this.multibar = new MultiBar({
      format: '{title} [{bar}] {percentage}% | {value}/{total} | {status}',
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: true,
    });
    this.bars = new Map();
    this.statuses = new Map();
    this.statusListeners = [];
    this.completedAt = new Map();
  }

  addStatusListener(listener: (status: IndexingStatus) => void) {
    this.statusListeners.push(listener);
  }

  private notifyListeners(status: IndexingStatus) {
    this.statusListeners.forEach((listener) => listener(status));
  }

  startIndexing(operationId: string, documentId: string, url: string, title: string): void {
    const status: IndexingStatus = {
      operationId,
      documentId,
      id: documentId,
      url,
      title,
      status: 'indexing',
      progress: 0,
      description: 'Starting indexing...',
      startedAt: new Date(),
      pagesFound: 0,
      pagesProcessed: 0,
      chunksCreated: 0,
    };

    const bar = this.multibar.create(100, 0, {
      title: title.slice(0, 30).padEnd(30),
      status: 'Starting...',
    });

    this.bars.set(operationId, bar);
    this.statuses.set(operationId, status);
    this.notifyListeners(status);
  }

  updateStats(operationId: string, stats: { pagesFound?: number; pagesProcessed?: number; chunksCreated?: number }): void {
    const currentStatus = this.statuses.get(operationId);
    if (!currentStatus) {
      return;
    }

    const status: IndexingStatus = {
      ...currentStatus,
      pagesFound: stats.pagesFound ?? currentStatus.pagesFound,
      pagesProcessed: stats.pagesProcessed ?? currentStatus.pagesProcessed,
      chunksCreated: stats.chunksCreated ?? currentStatus.chunksCreated,
    };

    this.statuses.set(operationId, status);
    this.notifyListeners(status);
  }

  updateProgress(operationId: string, progress: number, description: string): void {
    const bar = this.bars.get(operationId);
    const currentStatus = this.statuses.get(operationId);

    if (!bar || !currentStatus) {
      return;
    }

    const progressValue = Math.min(Math.round(progress * 100), 100);
    bar.update(progressValue, {
      status: description,
    });

    const status: IndexingStatus = {
      ...currentStatus,
      progress,
      description,
      status: currentStatus.status === 'complete' ? 'complete' : 'indexing',
    };

    this.statuses.set(operationId, status);
    this.notifyListeners(status);
  }

  failIndexing(operationId: string, error: string): void {
    const bar = this.bars.get(operationId);
    const currentStatus = this.statuses.get(operationId);

    if (!bar || !currentStatus) {
      return;
    }

    bar.update(100, {
      status: `Failed: ${error}`,
    });

    const status: IndexingStatus = {
      ...currentStatus,
      status: 'failed',
      progress: 1,
      description: error,
      error,
    };

    this.statuses.set(operationId, status);
    this.completedAt.set(operationId, new Date());
    this.notifyListeners(status);
  }

  completeIndexing(operationId: string): void {
    const bar = this.bars.get(operationId);
    const currentStatus = this.statuses.get(operationId);

    if (!bar || !currentStatus) {
      return;
    }

    bar.update(100, {
      status: 'Complete',
    });

    const status: IndexingStatus = {
      ...currentStatus,
      status: 'complete',
      progress: 1,
      description: 'Indexing complete',
    };

    this.statuses.set(operationId, status);
    this.completedAt.set(operationId, new Date());
    this.notifyListeners(status);
  }

  cancelIndexing(operationId: string): void {
    const bar = this.bars.get(operationId);
    const currentStatus = this.statuses.get(operationId);

    if (!bar || !currentStatus) {
      return;
    }

    bar.update(currentStatus.progress * 100, {
      status: 'Cancelled (new operation started)',
    });

    const status: IndexingStatus = {
      ...currentStatus,
      status: 'cancelled',
      description: 'Cancelled - replaced by new indexing operation',
    };

    this.statuses.set(operationId, status);
    this.completedAt.set(operationId, new Date());
    this.notifyListeners(status);
  }

  getStatus(operationId: string): IndexingStatus | undefined {
    return this.statuses.get(operationId);
  }

  /**
   * Get only active indexing operations and recently completed ones.
   * Completed statuses are automatically cleaned up after TTL expires.
   * This is the primary method for the get_indexing_status tool.
   */
  getActiveStatuses(): IndexingStatus[] {
    this.cleanupOldStatuses();

    const now = new Date();
    return Array.from(this.statuses.values()).filter((status) => {
      // Always include active indexing operations
      if (status.status === 'indexing') {
        return true;
      }

      // Include completed/failed/cancelled if within TTL
      const completedTime = this.completedAt.get(status.operationId);
      if (completedTime) {
        const age = now.getTime() - completedTime.getTime();
        return age < COMPLETED_STATUS_TTL_MS;
      }

      return false;
    });
  }

  /**
   * Remove statuses that completed more than TTL ago
   */
  private cleanupOldStatuses(): void {
    const now = new Date();

    for (const [operationId, completedTime] of this.completedAt.entries()) {
      const age = now.getTime() - completedTime.getTime();
      if (age >= COMPLETED_STATUS_TTL_MS) {
        this.statuses.delete(operationId);
        this.completedAt.delete(operationId);
        this.bars.delete(operationId);
      }
    }
  }

  stop(): void {
    this.multibar.stop();
  }
}
