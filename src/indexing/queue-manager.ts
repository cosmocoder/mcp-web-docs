import { setTimeout as delay } from 'node:timers/promises';
import { normalizeUrl } from '../config.js';
import { logger } from '../util/logger.js';

const DEFAULT_CANCELLATION_TIMEOUT_MS = 5_000;
const CANCELLATION_IN_PROGRESS_MESSAGE = 'Indexing operations are being cancelled';

interface ActiveOperation {
  controller: AbortController;
  completion: Promise<void>;
}

export interface IndexingOperationHandle {
  completion: Promise<void>;
  replacedExisting: boolean;
}

/** Owns the complete lifecycle of at most one indexing operation per URL. */
export class IndexingQueueManager {
  private readonly activeOperations = new Map<string, ActiveOperation>();
  private readonly transitions = new Map<string, Promise<void>>();
  private cancellation?: Promise<void>;

  constructor(private readonly cancellationTimeoutMs = DEFAULT_CANCELLATION_TIMEOUT_MS) {}

  runLatest(url: string, operation: (signal: AbortSignal) => Promise<void>): Promise<IndexingOperationHandle> {
    if (this.cancellation) {
      return Promise.reject(new Error(CANCELLATION_IN_PROGRESS_MESSAGE));
    }
    const normalizedUrl = normalizeUrl(url);
    return this.runTransition(normalizedUrl, async () => {
      if (this.cancellation) {
        throw new Error(CANCELLATION_IN_PROGRESS_MESSAGE);
      }
      const existing = this.activeOperations.get(normalizedUrl);
      if (existing) {
        logger.debug(`[IndexingQueue] Cancelling existing operation for ${url}`);
        existing.controller.abort();
        await this.awaitCancellation(existing.completion, `the existing indexing operation for ${url}`);
        if (this.cancellation) {
          throw new Error(CANCELLATION_IN_PROGRESS_MESSAGE);
        }
      }

      const controller = new AbortController();
      const started = Promise.resolve().then(() => operation(controller.signal));
      const completion = started.finally(() => {
        if (this.activeOperations.get(normalizedUrl)?.controller === controller) {
          this.activeOperations.delete(normalizedUrl);
          logger.debug(`[IndexingQueue] Completed operation for ${url}`);
        }
      });
      this.activeOperations.set(normalizedUrl, { controller, completion });
      logger.debug(`[IndexingQueue] Registered operation for ${url}`);
      return { completion, replacedExisting: existing !== undefined };
    });
  }

  private runTransition<T>(normalizedUrl: string, transition: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(normalizedUrl) ?? Promise.resolve();
    const result = previous.then(transition);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.transitions.set(normalizedUrl, tail);
    void tail.then(() => {
      if (this.transitions.get(normalizedUrl) === tail) {
        this.transitions.delete(normalizedUrl);
      }
    });
    return result;
  }

  private async awaitCancellation(completion: Promise<void>, description: string): Promise<void> {
    const timerController = new AbortController();
    try {
      await Promise.race([
        completion.catch(() => undefined),
        delay(this.cancellationTimeoutMs, undefined, { signal: timerController.signal }).then(() => {
          throw new Error(`Timed out cancelling ${description}`);
        }),
      ]);
    }
    finally {
      timerController.abort();
    }
  }

  cancelAll(): Promise<void> {
    if (this.cancellation) {
      return this.cancellation;
    }
    this.cancellation = Promise.resolve()
      .then(() => this.drainOperations())
      .finally(() => {
        this.cancellation = undefined;
      });
    return this.cancellation;
  }

  private async drainOperations(): Promise<void> {
    const operations = [...this.activeOperations.values()];
    const transitions = [...this.transitions.values()];
    logger.debug(`[IndexingQueue] Cancelling ${operations.length} operations and draining ${transitions.length} transitions`);
    for (const operation of operations) {
      operation.controller.abort();
    }
    await this.awaitCancellation(
      Promise.allSettled([...operations.map((operation) => operation.completion), ...transitions]).then(() => undefined),
      'all indexing operations'
    );
  }
}
