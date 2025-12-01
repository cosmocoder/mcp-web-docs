import { normalizeUrl } from '../config.js';
import { logger } from '../util/logger.js';

interface ActiveOperation {
  controller: AbortController;
  promise: Promise<void>;
  url: string;
  startedAt: Date;
}

/**
 * Manages concurrent indexing operations to prevent conflicts.
 * Ensures only one indexing operation runs per URL at a time.
 */
export class IndexingQueueManager {
  private activeOperations: Map<string, ActiveOperation> = new Map();

  /**
   * Start a new operation for a URL, cancelling any existing operation first.
   * @param url The URL to index
   * @returns AbortController for the new operation
   */
  async startOperation(url: string): Promise<AbortController> {
    const normalizedUrl = normalizeUrl(url);

    // Cancel existing operation for this URL if any
    const existing = this.activeOperations.get(normalizedUrl);
    if (existing) {
      logger.debug(`[IndexingQueue] Cancelling existing operation for ${url}`);
      existing.controller.abort();

      // Wait for cancellation to complete (with timeout)
      try {
        await Promise.race([
          existing.promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Cancellation timeout')), 5000)
          )
        ]);
      } catch (e) {
        // Expected - operation was cancelled or timed out
        logger.debug(`[IndexingQueue] Previous operation ended: ${e instanceof Error ? e.message : 'cancelled'}`);
      }
    }

    // Create new abort controller for this operation
    const controller = new AbortController();
    return controller;
  }

  /**
   * Register an active operation
   */
  registerOperation(url: string, controller: AbortController, promise: Promise<void>): void {
    const normalizedUrl = normalizeUrl(url);
    this.activeOperations.set(normalizedUrl, {
      controller,
      promise,
      url,
      startedAt: new Date()
    });
    logger.debug(`[IndexingQueue] Registered operation for ${url}`);
  }

  /**
   * Mark an operation as complete
   */
  completeOperation(url: string): void {
    const normalizedUrl = normalizeUrl(url);
    this.activeOperations.delete(normalizedUrl);
    logger.debug(`[IndexingQueue] Completed operation for ${url}`);
  }

  /**
   * Cancel all active operations (for shutdown)
   */
  async cancelAll(): Promise<void> {
    logger.debug(`[IndexingQueue] Cancelling all ${this.activeOperations.size} operations`);

    const cancellations = Array.from(this.activeOperations.values()).map(op => {
      op.controller.abort();
      return op.promise.catch(() => {});
    });

    await Promise.all(cancellations);
    this.activeOperations.clear();
  }

  /**
   * Check if a URL is currently being indexed
   */
  isIndexing(url: string): boolean {
    return this.activeOperations.has(normalizeUrl(url));
  }

  /**
   * Get information about active operations
   */
  getActiveOperations(): Array<{ url: string; startedAt: Date }> {
    return Array.from(this.activeOperations.values()).map(op => ({
      url: op.url,
      startedAt: op.startedAt
    }));
  }
}

