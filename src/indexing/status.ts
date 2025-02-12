import { SingleBar, MultiBar } from 'cli-progress';
import { IndexingStatus } from '../types.js';

export class IndexingStatusTracker {
  private multibar: MultiBar;
  private bars: Map<string, SingleBar>;
  private statuses: Map<string, IndexingStatus>;
  private statusListeners: Array<(status: IndexingStatus) => void>;

  constructor() {
    this.multibar = new MultiBar({
      format: '{title} [{bar}] {percentage}% | {value}/{total} | {status}',
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: true
    });
    this.bars = new Map();
    this.statuses = new Map();
    this.statusListeners = [];
  }

  addStatusListener(listener: (status: IndexingStatus) => void) {
    this.statusListeners.push(listener);
  }

  private notifyListeners(status: IndexingStatus) {
    this.statusListeners.forEach(listener => listener(status));
  }

  startIndexing(id: string, url: string, title: string): void {
    const status: IndexingStatus = {
      id,
      url,
      title,
      status: 'indexing',
      progress: 0,
      description: 'Starting indexing...'
    };

    const bar = this.multibar.create(100, 0, {
      title: title.slice(0, 30).padEnd(30),
      status: 'Starting...'
    });

    this.bars.set(id, bar);
    this.statuses.set(id, status);
    this.notifyListeners(status);
  }

  updateProgress(id: string, progress: number, description: string): void {
    const bar = this.bars.get(id);
    const currentStatus = this.statuses.get(id);

    if (!bar || !currentStatus) {
      return;
    }

    const progressValue = Math.min(Math.round(progress * 100), 100);
    bar.update(progressValue, {
      status: description
    });

    const status: IndexingStatus = {
      ...currentStatus,
      progress,
      description,
      status: currentStatus.status === 'complete' ? 'complete' : 'indexing'
    };

    this.statuses.set(id, status);
    this.notifyListeners(status);
  }

  failIndexing(id: string, error: string): void {
    const bar = this.bars.get(id);
    const currentStatus = this.statuses.get(id);

    if (!bar || !currentStatus) {
      return;
    }

    bar.update(100, {
      status: `Failed: ${error}`
    });

    const status: IndexingStatus = {
      ...currentStatus,
      status: 'failed',
      progress: 1,
      description: error,
      error
    };

    this.statuses.set(id, status);
    this.notifyListeners(status);
  }

  completeIndexing(id: string): void {
    const bar = this.bars.get(id);
    const currentStatus = this.statuses.get(id);

    if (!bar || !currentStatus) {
      return;
    }

    bar.update(100, {
      status: 'Complete'
    });

    const status: IndexingStatus = {
      ...currentStatus,
      status: 'complete',
      progress: 1,
      description: 'Indexing complete'
    };

    this.statuses.set(id, status);
    this.notifyListeners(status);
  }

  abortIndexing(id: string): void {
    const bar = this.bars.get(id);
    const currentStatus = this.statuses.get(id);

    if (!bar || !currentStatus) {
      return;
    }

    bar.update(100, {
      status: 'Aborted'
    });

    const status: IndexingStatus = {
      ...currentStatus,
      status: 'aborted',
      progress: 1,
      description: 'Indexing aborted'
    };

    this.statuses.set(id, status);
    this.notifyListeners(status);
  }

  getStatus(id: string): IndexingStatus | undefined {
    return this.statuses.get(id);
  }

  getAllStatuses(): IndexingStatus[] {
    return Array.from(this.statuses.values());
  }

  stop(): void {
    this.multibar.stop();
  }
}