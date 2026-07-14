import { afterEach, describe, expect, it } from 'vitest';

import {
  ExecutionCoordinator,
  type ExecutionDriver,
  type ExecutionRun,
} from './execution-coordinator.js';
import type { Claim } from './scheduler.js';

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const waitFor = async (
  predicate: () => boolean,
  diagnostic: string,
): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${diagnostic}`);
    }
    await new Promise<void>((resolvePromise) => {
      setImmediate(resolvePromise);
    });
  }
};

const settleScheduledWork = async (): Promise<void> => {
  await new Promise<void>((resolvePromise) => {
    setImmediate(() => setImmediate(resolvePromise));
  });
};

const claim = (ordinal: number): Claim => ({
  slotNo: 1,
  sessionId: `session-${String(ordinal)}`,
  turnId: `turn-${String(ordinal)}`,
  leaseId: `lease-${String(ordinal)}`,
  daemonEpoch: 'daemon-epoch',
  leaseEpoch: ordinal,
  executionFence: 1,
});

class FakeScheduler {
  readonly pending: Array<Claim | null>;
  claimCalls = 0;

  constructor(...claims: Array<Claim | null>) {
    this.pending = [...claims];
  }

  claimNext(): Claim | null {
    this.claimCalls += 1;
    return this.pending.shift() ?? null;
  }
}

type StartedExecution = {
  readonly claim: Claim;
  readonly start: Deferred<ExecutionRun>;
  readonly completion: Deferred<void>;
};

class ControlledDriver implements ExecutionDriver {
  readonly started: StartedExecution[] = [];
  shutdownCalls = 0;

  start(nextClaim: Claim): Promise<ExecutionRun> {
    const start = deferred<ExecutionRun>();
    const completion = deferred<void>();
    this.started.push({ claim: nextClaim, start, completion });
    return start.promise;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

describe('ExecutionCoordinator level-triggered drain', () => {
  const coordinators: ExecutionCoordinator[] = [];

  afterEach(() => {
    for (const coordinator of coordinators) {
      coordinator.quiesce();
    }
    coordinators.length = 0;
  });

  const track = (coordinator: ExecutionCoordinator): ExecutionCoordinator => {
    coordinators.push(coordinator);
    return coordinator;
  };

  it('does not claim without execution dependencies', async () => {
    const scheduler = new FakeScheduler(claim(1));
    const coordinator = track(
      new ExecutionCoordinator({
        scheduler,
        authenticatedControlConnectionCount: () => 1,
      }),
    );

    expect(() => coordinator.notify()).not.toThrow();
    await settleScheduledWork();

    expect(scheduler.claimCalls).toBe(0);
  });

  it('does not claim until an authenticated control connection exists', async () => {
    const scheduler = new FakeScheduler(claim(1));
    const driver = new ControlledDriver();
    let authenticatedConnections = 0;
    const coordinator = track(
      new ExecutionCoordinator({
        scheduler,
        executionDriver: driver,
        terminalizer: { fail: () => undefined },
        authenticatedControlConnectionCount: () => authenticatedConnections,
      }),
    );

    coordinator.notify();
    await settleScheduledWork();
    expect(scheduler.claimCalls).toBe(0);

    authenticatedConnections = 1;
    coordinator.notify();
    await waitFor(() => driver.started.length === 1, 'first authenticated claim');
    expect(scheduler.claimCalls).toBe(1);
  });

  it('coalesces 100 synchronous notifications and never starts two drains', async () => {
    const scheduler = new FakeScheduler(claim(1), claim(2));
    const driver = new ControlledDriver();
    let concurrentStarts = 0;
    let maxConcurrentStarts = 0;
    const wrappedDriver: ExecutionDriver = {
      start: async (nextClaim) => {
        concurrentStarts += 1;
        maxConcurrentStarts = Math.max(maxConcurrentStarts, concurrentStarts);
        try {
          return await driver.start(nextClaim);
        } finally {
          concurrentStarts -= 1;
        }
      },
      shutdown: async () => undefined,
    };
    const coordinator = track(
      new ExecutionCoordinator({
        scheduler,
        executionDriver: wrappedDriver,
        terminalizer: { fail: () => undefined },
        authenticatedControlConnectionCount: () => 1,
      }),
    );

    for (let index = 0; index < 100; index += 1) {
      coordinator.notify();
    }
    await waitFor(() => driver.started.length === 1, 'coalesced execution start');
    expect(scheduler.claimCalls).toBe(1);
    expect(maxConcurrentStarts).toBe(1);

    coordinator.notify();
    await settleScheduledWork();
    expect(scheduler.claimCalls).toBe(1);
    expect(driver.started).toHaveLength(1);
  });

  it('atomically fails a pre-READY start error and accepts a later wake', async () => {
    const first = claim(1);
    const second = claim(2);
    const scheduler = new FakeScheduler(first, second);
    const driver = new ControlledDriver();
    const failures: Array<{
      readonly binding: Claim;
      readonly errorCode: string;
      readonly errorMessage: string;
    }> = [];
    const errors: unknown[] = [];
    const coordinator = track(
      new ExecutionCoordinator({
        scheduler,
        executionDriver: driver,
        terminalizer: {
          fail: (failure) => {
            failures.push(failure);
          },
        },
        authenticatedControlConnectionCount: () => 1,
        onError: (error) => {
          errors.push(error);
        },
      }),
    );

    coordinator.notify();
    await waitFor(() => driver.started.length === 1, 'first driver start');
    driver.started[0]?.start.reject(new Error('spawn failed'));
    await waitFor(() => failures.length === 1, 'atomic start failure terminalization');
    expect(failures).toEqual([
      {
        binding: first,
        errorCode: 'RUNNER_START_FAILED',
        errorMessage: 'Runner failed to start',
      },
    ]);
    expect(errors).toEqual([]);

    coordinator.notify();
    await waitFor(() => driver.started.length === 2, 'second driver start');
    expect(driver.started[1]?.claim).toEqual(second);
  });

  it('keeps the slot level dirty until terminal commit and Runner reap', async () => {
    const scheduler = new FakeScheduler(claim(1), claim(2));
    const driver = new ControlledDriver();
    const coordinator = track(
      new ExecutionCoordinator({
        scheduler,
        executionDriver: driver,
        terminalizer: { fail: () => undefined },
        authenticatedControlConnectionCount: () => 1,
      }),
    );

    coordinator.notify();
    await waitFor(() => driver.started.length === 1, 'first driver start');
    const first = driver.started[0] as StartedExecution;
    first.start.resolve({ completion: first.completion.promise });
    await settleScheduledWork();

    coordinator.notify();
    await settleScheduledWork();
    expect(scheduler.claimCalls).toBe(1);

    first.completion.resolve(undefined);
    await waitFor(() => driver.started.length === 2, 'claim after Runner reap');
    expect(scheduler.claimCalls).toBe(2);
  });

  it('quiesce permanently prevents new claims, including an already scheduled drain', async () => {
    const scheduler = new FakeScheduler(claim(1));
    const driver = new ControlledDriver();
    const coordinator = track(
      new ExecutionCoordinator({
        scheduler,
        executionDriver: driver,
        terminalizer: { fail: () => undefined },
        authenticatedControlConnectionCount: () => 1,
      }),
    );

    coordinator.notify();
    coordinator.quiesce();
    coordinator.notify();
    await settleScheduledWork();

    expect(scheduler.claimCalls).toBe(0);
    expect(driver.started).toEqual([]);
  });
});
