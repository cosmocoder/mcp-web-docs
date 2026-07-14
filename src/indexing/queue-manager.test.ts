import { setImmediate as nextTurn } from 'node:timers/promises';
import { IndexingQueueManager } from './queue-manager.js';

describe('IndexingQueueManager', () => {
  it('registers before running and removes the same completed operation', async () => {
    const queue = new IndexingQueueManager();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();

    const handle = await queue.runLatest('https://example.com/', async () => {
      started.resolve();
      await released.promise;
    });
    await started.promise;

    expect(handle.replacedExisting).toBe(false);
    released.resolve();
    await handle.completion;
  });

  it('rejects a replacement when its aborted predecessor does not stop in time', async () => {
    const queue = new IndexingQueueManager(10);
    const firstStarted = Promise.withResolvers<void>();
    const firstReleased = Promise.withResolvers<void>();
    let firstSignal!: AbortSignal;
    let replacementStarted = false;
    const first = await queue.runLatest('https://example.com', async (signal) => {
      firstSignal = signal;
      firstStarted.resolve();
      await firstReleased.promise;
    });
    await firstStarted.promise;

    await expect(
      queue.runLatest('https://example.com/', async () => {
        replacementStarted = true;
      })
    ).rejects.toThrow('Timed out cancelling');

    expect(firstSignal.aborted).toBe(true);
    expect(replacementStarted).toBe(false);
    firstReleased.resolve();
    await first.completion;
  });

  it('keeps same-URL transitions ordered while a different URL starts independently', async () => {
    const queue = new IndexingQueueManager(1_000);
    const firstStarted = Promise.withResolvers<void>();
    const firstReleased = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const secondReleased = Promise.withResolvers<void>();
    const thirdStarted = Promise.withResolvers<void>();
    const thirdReleased = Promise.withResolvers<void>();
    const otherStarted = Promise.withResolvers<void>();
    const otherReleased = Promise.withResolvers<void>();
    const order: string[] = [];
    let firstSignal!: AbortSignal;
    let secondSignal!: AbortSignal;

    const first = await queue.runLatest('https://example.com', async (signal) => {
      firstSignal = signal;
      order.push('first');
      firstStarted.resolve();
      await firstReleased.promise;
    });
    await firstStarted.promise;

    const secondStart = queue.runLatest('https://example.com', async (signal) => {
      secondSignal = signal;
      order.push('second');
      secondStarted.resolve();
      await secondReleased.promise;
    });
    const thirdStart = queue.runLatest('https://example.com', async () => {
      order.push('third');
      thirdStarted.resolve();
      await thirdReleased.promise;
    });
    const other = await queue.runLatest('https://other.com', async () => {
      order.push('other');
      otherStarted.resolve();
      await otherReleased.promise;
    });
    await otherStarted.promise;

    expect(order).toEqual(['first', 'other']);
    expect(firstSignal.aborted).toBe(true);
    firstReleased.resolve();
    const second = await secondStart;
    await secondStarted.promise;
    await first.completion;
    await nextTurn();
    expect(secondSignal.aborted).toBe(true);
    expect(order).toEqual(['first', 'other', 'second']);

    secondReleased.resolve();
    const third = await thirdStart;
    await thirdStarted.promise;
    expect(order).toEqual(['first', 'other', 'second', 'third']);

    thirdReleased.resolve();
    otherReleased.resolve();
    await Promise.all([second.completion, third.completion, other.completion]);
  });

  it('continues after a cancelled predecessor rejects', async () => {
    const queue = new IndexingQueueManager();
    const firstStarted = Promise.withResolvers<void>();
    const first = await queue.runLatest('https://example.com', async (signal) => {
      firstStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    });
    const firstCompletion = first.completion.catch(() => {});
    await firstStarted.promise;

    const second = await queue.runLatest('https://example.com', async () => {});
    expect(second.replacedExisting).toBe(true);
    await Promise.all([firstCompletion, second.completion]);
  });

  it('cancelAll drains pending transitions and rejects starts until its shared barrier completes', async () => {
    const queue = new IndexingQueueManager();
    const firstStarted = Promise.withResolvers<void>();
    const firstReleased = Promise.withResolvers<void>();
    let firstSignal!: AbortSignal;
    let secondStarted = false;

    const first = await queue.runLatest('https://example.com', async (signal) => {
      firstSignal = signal;
      firstStarted.resolve();
      await firstReleased.promise;
    });
    await firstStarted.promise;

    const secondStart = queue.runLatest('https://example.com', async () => {
      secondStarted = true;
    });
    const secondResult = expect(secondStart).rejects.toThrow('being cancelled');
    await nextTurn();

    let cancellationFinished = false;
    const cancellation = queue.cancelAll();
    expect(queue.cancelAll()).toBe(cancellation);
    void cancellation.then(() => {
      cancellationFinished = true;
    });

    let duringCancellationStarted = false;
    await expect(
      queue.runLatest('https://other.com', async () => {
        duringCancellationStarted = true;
      })
    ).rejects.toThrow('being cancelled');
    await nextTurn();

    expect(firstSignal.aborted).toBe(true);
    expect(duringCancellationStarted).toBe(false);
    expect(cancellationFinished).toBe(false);

    firstReleased.resolve();
    await Promise.all([first.completion, secondResult, cancellation]);

    expect(secondStarted).toBe(false);
    expect(cancellationFinished).toBe(true);

    let afterCancellationStarted = false;
    const afterCancellation = await queue.runLatest('https://example.com', async () => {
      afterCancellationStarted = true;
    });
    await afterCancellation.completion;
    expect(afterCancellationStarted).toBe(true);
  });
});
