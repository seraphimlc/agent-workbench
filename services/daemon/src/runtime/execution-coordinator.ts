import type { Claim } from './scheduler.js';

export interface ExecutionRun {
  readonly completion: Promise<void>;
}

export interface ExecutionDriver {
  start(claim: Claim): Promise<ExecutionRun>;
  shutdown(): Promise<void>;
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
  private activeRunner = false;

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
  }

  private scheduleDrain(): void {
    if (!this.running || this.drainScheduled) {
      return;
    }
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (!this.running || this.draining || !this.dirty) {
      return;
    }
    if (
      this.activeRunner ||
      !this.executionDriver ||
      !this.terminalizer ||
      this.authenticatedControlConnectionCount() <= 0
    ) {
      return;
    }

    this.draining = true;
    this.dirty = false;
    try {
      const claim = this.scheduler.claimNext();
      if (!claim || !this.running) {
        return;
      }
      this.activeRunner = true;
      try {
        const execution = await this.executionDriver.start(claim);
        this.observeCompletion(execution);
      } catch {
        try {
          this.terminalizer.fail({
            binding: claim,
            errorCode: 'RUNNER_START_FAILED',
            errorMessage: 'Runner failed to start',
          });
        } catch (error) {
          this.reportError(error);
        } finally {
          this.activeRunner = false;
        }
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      this.draining = false;
      if (this.running && this.dirty && !this.activeRunner) {
        this.scheduleDrain();
      }
    }
  }

  private observeCompletion(execution: ExecutionRun): void {
    void execution.completion.then(
      () => {
        this.activeRunner = false;
        if (this.running && this.dirty) {
          this.scheduleDrain();
        }
      },
      (error: unknown) => {
        this.activeRunner = false;
        this.reportError(error);
        if (this.running && this.dirty) {
          this.scheduleDrain();
        }
      },
    );
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Coordinator wakeups and error reporting must remain nonthrowing.
    }
  }
}
