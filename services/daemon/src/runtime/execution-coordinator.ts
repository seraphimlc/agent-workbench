import type { Claim } from './scheduler.js';

export interface ExecutionRun {
  readonly completion: Promise<void>;
}

export interface ExecutionDriver {
  start(claim: Claim): Promise<ExecutionRun>;
  /**
   * Stops and reaps every executor, settling pending starts and execution
   * completions before this promise resolves.
   */
  shutdown(): Promise<void>;
  inspectPersistedExecutor?(identity: {
    readonly pid: number;
    readonly processStartIdentity: string;
  }): 'live' | 'exited' | 'ambiguous';
  onDaemonPhase?(phase: 'coordinator.quiesced' | 'runtime_lock.released'): void;
}

export interface CoordinatorScheduler {
  claimNext(): Claim | null;
}

export interface StartFailureTerminalizer {
  fail(input: {
    readonly binding: Claim;
    readonly errorCode: string;
    readonly errorMessage: string;
  }): void;
}

export interface ExecutionCoordinatorOptions {
  readonly scheduler: CoordinatorScheduler;
  readonly authenticatedControlConnectionCount: () => number;
  readonly executionDriver?: ExecutionDriver;
  readonly terminalizer?: StartFailureTerminalizer;
  readonly onError?: (error: unknown) => void;
}

type StartingExecution = {
  readonly claim: Claim;
};

type ActiveExecution = {
  readonly claim: Claim;
  readonly execution: ExecutionRun;
};

const claimKey = (claim: Claim): string =>
  JSON.stringify([claim.turnId, claim.leaseId, claim.executionFence]);

export class ExecutionCoordinator {
  private readonly scheduler: CoordinatorScheduler;
  private readonly authenticatedControlConnectionCount: () => number;
  private readonly executionDriver: ExecutionDriver | undefined;
  private readonly terminalizer: StartFailureTerminalizer | undefined;
  private readonly onError: (error: unknown) => void;
  private running = true;
  private dirty = false;
  private drainScheduled = false;
  private draining = false;
  private readonly starting = new Map<string, StartingExecution>();
  private readonly active = new Map<string, ActiveExecution>();
  private readonly joinWaiters = new Set<() => void>();

  constructor(options: ExecutionCoordinatorOptions) {
    this.scheduler = options.scheduler;
    this.authenticatedControlConnectionCount =
      options.authenticatedControlConnectionCount;
    this.executionDriver = options.executionDriver;
    this.terminalizer = options.terminalizer;
    this.onError = options.onError ?? (() => undefined);
  }

  notify(): void {
    if (!this.running) {
      return;
    }
    this.dirty = true;
    this.scheduleDrain();
  }

  quiesce(): void {
    this.running = false;
    this.dirty = false;
    this.settleJoinWaiters();
  }

  join(): Promise<void> {
    if (this.isJoined()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise) => {
      this.joinWaiters.add(resolvePromise);
    });
  }

  private scheduleDrain(): void {
    if (!this.running || this.drainScheduled) {
      return;
    }
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
      this.settleJoinWaiters();
    });
  }

  private async drain(): Promise<void> {
    if (!this.running || this.draining || !this.dirty) {
      return;
    }

    this.draining = true;
    let gatesPassed = false;
    try {
      const executionDriver = this.executionDriver;
      const terminalizer = this.terminalizer;
      if (
        !executionDriver ||
        !terminalizer ||
        this.authenticatedControlConnectionCount() <= 0 ||
        !this.running
      ) {
        return;
      }
      gatesPassed = true;
      this.dirty = false;
      while (this.running) {
        const claim = this.scheduler.claimNext();
        if (!claim) {
          break;
        }
        this.startClaim(claim, executionDriver, terminalizer);
      }
    } catch (error) {
      if (!gatesPassed) {
        this.dirty = false;
      }
      this.reportError(error);
    } finally {
      this.draining = false;
      if (
        gatesPassed &&
        this.running &&
        this.dirty
      ) {
        this.scheduleDrain();
      }
      this.settleJoinWaiters();
    }
  }

  private startClaim(
    claim: Claim,
    executionDriver: ExecutionDriver,
    terminalizer: StartFailureTerminalizer,
  ): void {
    const key = claimKey(claim);
    const starting: StartingExecution = { claim };
    this.starting.set(key, starting);
    void Promise.resolve()
      .then(() => executionDriver.start(claim))
      .then(
        (execution) => {
          this.promoteStart(key, starting, execution);
        },
        () => {
          this.failStart(key, starting, terminalizer);
        },
      )
      .catch((error: unknown) => {
        this.reportError(error);
      });
  }

  private promoteStart(
    key: string,
    starting: StartingExecution,
    execution: ExecutionRun,
  ): void {
    if (this.starting.get(key) !== starting) {
      return;
    }
    this.starting.delete(key);
    const active: ActiveExecution = { claim: starting.claim, execution };
    this.active.set(key, active);
    this.observeCompletion(key, active);
    this.settleJoinWaiters();
  }

  private failStart(
    key: string,
    starting: StartingExecution,
    terminalizer: StartFailureTerminalizer,
  ): void {
    if (this.starting.get(key) !== starting) {
      return;
    }
    this.starting.delete(key);
    let terminalized = false;
    try {
      terminalizer.fail({
        binding: starting.claim,
        errorCode: 'RUNNER_START_FAILED',
        errorMessage: 'Runner failed to start',
      });
      terminalized = true;
    } catch (error) {
      this.reportError(error);
    }
    if (terminalized && this.running) {
      this.dirty = true;
      this.scheduleDrain();
    }
    this.settleJoinWaiters();
  }

  private observeCompletion(key: string, active: ActiveExecution): void {
    void active.execution.completion.then(
      () => {
        this.settleCompletion(key, active, false);
      },
      (error: unknown) => {
        this.settleCompletion(key, active, true, error);
      },
    ).catch((error: unknown) => {
      this.reportError(error);
    });
  }

  private settleCompletion(
    key: string,
    active: ActiveExecution,
    rejected: boolean,
    error?: unknown,
  ): void {
    if (this.active.get(key) !== active) {
      return;
    }
    this.active.delete(key);
    if (rejected) {
      this.reportError(error);
    }
    if (this.running) {
      this.dirty = true;
      this.scheduleDrain();
    }
    this.settleJoinWaiters();
  }

  private isJoined(): boolean {
    return (
      !this.running &&
      !this.drainScheduled &&
      !this.draining &&
      this.starting.size === 0 &&
      this.active.size === 0
    );
  }

  private settleJoinWaiters(): void {
    if (!this.isJoined() || this.joinWaiters.size === 0) {
      return;
    }
    const waiters = [...this.joinWaiters];
    this.joinWaiters.clear();
    for (const resolvePromise of waiters) {
      resolvePromise();
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Coordinator wakeups and error reporting must remain nonthrowing.
    }
  }
}
