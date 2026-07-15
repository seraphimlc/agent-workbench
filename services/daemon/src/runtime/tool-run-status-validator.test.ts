import { describe, expect, it } from 'vitest';

import {
  ToolRunStatusMatrixError,
  type ToolRunDispatchState,
  type ToolRunEffectState,
  type ToolRunExecutionMode,
  type ToolRunStatus,
  validateToolRunStatusTuple,
} from './tool-run-status-validator.js';

const activeExpected = new Map<
  string,
  readonly ['canceled' | 'interrupted', 'not_applied' | 'unknown']
>([
  ['queued/read_inline/null/not_applied', ['canceled', 'not_applied']],
  ['running/read_inline/null/not_applied', ['interrupted', 'not_applied']],
  ['cancel_requested/read_inline/null/not_applied', ['interrupted', 'not_applied']],
  ['queued/transactional_intrinsic/null/not_applied', ['canceled', 'not_applied']],
  ['queued/transactional_intrinsic/null/unknown', ['canceled', 'not_applied']],
  ['running/transactional_intrinsic/null/not_applied', ['interrupted', 'not_applied']],
  ['running/transactional_intrinsic/null/unknown', ['interrupted', 'not_applied']],
  [
    'cancel_requested/transactional_intrinsic/null/not_applied',
    ['interrupted', 'not_applied'],
  ],
  [
    'cancel_requested/transactional_intrinsic/null/unknown',
    ['interrupted', 'not_applied'],
  ],
  ['queued/worker/prepared/unknown', ['canceled', 'not_applied']],
  ['queued/worker/worker_ready/unknown', ['canceled', 'not_applied']],
  ['running/worker/go_sent/unknown', ['interrupted', 'unknown']],
  ['running/worker/acknowledged/unknown', ['interrupted', 'unknown']],
  ['cancel_requested/worker/go_sent/unknown', ['interrupted', 'unknown']],
  ['cancel_requested/worker/acknowledged/unknown', ['interrupted', 'unknown']],
]);

const terminalLegal = new Set<string>([
  'succeeded/read_inline/null/not_applied',
  'failed/read_inline/null/not_applied',
  'canceled/read_inline/null/not_applied',
  'interrupted/read_inline/null/not_applied',
  'succeeded/transactional_intrinsic/null/not_applied',
  'failed/transactional_intrinsic/null/not_applied',
  'canceled/transactional_intrinsic/null/not_applied',
  'interrupted/transactional_intrinsic/null/not_applied',
  'succeeded/worker/acknowledged/applied',
  'failed/worker/prepared/not_applied',
  'failed/worker/worker_ready/not_applied',
  'failed/worker/go_sent/not_applied',
  'failed/worker/go_sent/applied',
  'failed/worker/go_sent/unknown',
  'failed/worker/acknowledged/not_applied',
  'failed/worker/acknowledged/applied',
  'failed/worker/acknowledged/unknown',
  'canceled/worker/prepared/not_applied',
  'canceled/worker/worker_ready/not_applied',
  'canceled/worker/go_sent/not_applied',
  'canceled/worker/acknowledged/not_applied',
  'interrupted/worker/go_sent/applied',
  'interrupted/worker/go_sent/unknown',
  'interrupted/worker/acknowledged/applied',
  'interrupted/worker/acknowledged/unknown',
]);

const statuses: readonly ToolRunStatus[] = [
  'queued',
  'running',
  'cancel_requested',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
];
const executionModes: readonly ToolRunExecutionMode[] = [
  'read_inline',
  'worker',
  'transactional_intrinsic',
];
const dispatchStates: readonly ToolRunDispatchState[] = [
  null,
  'prepared',
  'worker_ready',
  'go_sent',
  'acknowledged',
];
const effectStates: readonly ToolRunEffectState[] = [
  'not_applied',
  'applied',
  'unknown',
];

describe('validateToolRunStatusTuple', () => {
  it('enforces the explicit status × mode × dispatch × effect matrix', () => {
    for (const status of statuses) {
      for (const executionMode of executionModes) {
        for (const dispatchState of dispatchStates) {
          for (const effectState of effectStates) {
            const key = `${status}/${executionMode}/${String(dispatchState)}/${effectState}`;
            const tuple = { status, executionMode, dispatchState, effectState };
            const expected = activeExpected.get(key);
            if (expected) {
              expect(validateToolRunStatusTuple(tuple), key).toEqual({
                kind: 'active',
                outcome: expected[0],
                terminalEffectState: expected[1],
                eventSuffix: expected[0],
              });
            } else if (terminalLegal.has(key)) {
              expect(validateToolRunStatusTuple(tuple), key).toEqual({
                kind: 'terminal',
              });
            } else {
              expect(() => validateToolRunStatusTuple(tuple), key).toThrow(
                ToolRunStatusMatrixError,
              );
            }
          }
        }
      }
    }
  });
});
