export type ToolRunStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export type ToolRunExecutionMode =
  | 'read_inline'
  | 'worker'
  | 'transactional_intrinsic';

export type ToolRunDispatchState =
  | 'prepared'
  | 'worker_ready'
  | 'go_sent'
  | 'acknowledged'
  | null;

export type ToolRunEffectState = 'not_applied' | 'applied' | 'unknown';

export type ToolRunStatusTuple = {
  readonly status: ToolRunStatus;
  readonly executionMode: ToolRunExecutionMode;
  readonly dispatchState: ToolRunDispatchState;
  readonly effectState: ToolRunEffectState;
};

export type ActiveToolRunRecoveryDecision = {
  readonly kind: 'active';
  readonly outcome: 'canceled' | 'interrupted';
  readonly terminalEffectState: 'not_applied' | 'unknown';
  readonly eventSuffix: 'canceled' | 'interrupted';
};

export type TerminalToolRunValidation = {
  readonly kind: 'terminal';
};

export type ToolRunStatusValidation =
  | ActiveToolRunRecoveryDecision
  | TerminalToolRunValidation;

export class ToolRunStatusMatrixError extends Error {
  constructor(tuple: ToolRunStatusTuple) {
    super(
      `invalid ToolRun status tuple: ${tuple.status}/${tuple.executionMode}/${String(tuple.dispatchState)}/${tuple.effectState}`,
    );
    this.name = 'ToolRunStatusMatrixError';
  }
}

const isActiveStatus = (
  status: ToolRunStatus,
): status is 'queued' | 'running' | 'cancel_requested' =>
  status === 'queued' || status === 'running' || status === 'cancel_requested';

const isPreGo = (
  dispatchState: ToolRunDispatchState,
): dispatchState is 'prepared' | 'worker_ready' =>
  dispatchState === 'prepared' || dispatchState === 'worker_ready';

const isPostGo = (
  dispatchState: ToolRunDispatchState,
): dispatchState is 'go_sent' | 'acknowledged' =>
  dispatchState === 'go_sent' || dispatchState === 'acknowledged';

const activeInlineDecision = (
  status: 'queued' | 'running' | 'cancel_requested',
): ActiveToolRunRecoveryDecision => {
  const canceled = status === 'queued';
  return {
    kind: 'active',
    outcome: canceled ? 'canceled' : 'interrupted',
    terminalEffectState: 'not_applied',
    eventSuffix: canceled ? 'canceled' : 'interrupted',
  };
};

export const validateToolRunStatusTuple = (
  tuple: ToolRunStatusTuple,
): ToolRunStatusValidation => {
  if (tuple.executionMode === 'read_inline') {
    if (tuple.dispatchState !== null || tuple.effectState !== 'not_applied') {
      throw new ToolRunStatusMatrixError(tuple);
    }
    return isActiveStatus(tuple.status)
      ? activeInlineDecision(tuple.status)
      : { kind: 'terminal' };
  }

  if (tuple.executionMode === 'transactional_intrinsic') {
    if (
      tuple.dispatchState !== null ||
      tuple.effectState === 'applied' ||
      (!isActiveStatus(tuple.status) && tuple.effectState !== 'not_applied')
    ) {
      throw new ToolRunStatusMatrixError(tuple);
    }
    return isActiveStatus(tuple.status)
      ? activeInlineDecision(tuple.status)
      : { kind: 'terminal' };
  }

  if (tuple.dispatchState === null) {
    throw new ToolRunStatusMatrixError(tuple);
  }

  if (isActiveStatus(tuple.status)) {
    if (
      tuple.effectState !== 'unknown' ||
      (tuple.status === 'queued' && !isPreGo(tuple.dispatchState)) ||
      (tuple.status !== 'queued' && !isPostGo(tuple.dispatchState))
    ) {
      throw new ToolRunStatusMatrixError(tuple);
    }
    const canceled = tuple.status === 'queued';
    return {
      kind: 'active',
      outcome: canceled ? 'canceled' : 'interrupted',
      terminalEffectState: canceled ? 'not_applied' : 'unknown',
      eventSuffix: canceled ? 'canceled' : 'interrupted',
    };
  }

  const valid =
    (tuple.status === 'succeeded' &&
      tuple.dispatchState === 'acknowledged' &&
      tuple.effectState === 'applied') ||
    (tuple.status === 'failed' &&
      ((isPreGo(tuple.dispatchState) && tuple.effectState === 'not_applied') ||
        isPostGo(tuple.dispatchState))) ||
    (tuple.status === 'canceled' && tuple.effectState === 'not_applied') ||
    (tuple.status === 'interrupted' &&
      isPostGo(tuple.dispatchState) &&
      (tuple.effectState === 'unknown' || tuple.effectState === 'applied'));
  if (!valid) {
    throw new ToolRunStatusMatrixError(tuple);
  }
  return { kind: 'terminal' };
};
