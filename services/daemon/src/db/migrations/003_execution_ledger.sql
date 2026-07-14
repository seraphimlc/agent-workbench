ALTER TABLE turns
ADD COLUMN execution_fence INTEGER NOT NULL DEFAULT 0
CHECK (execution_fence >= 0);

ALTER TABLE runner_leases ADD COLUMN runner_instance_id TEXT;
ALTER TABLE runner_leases ADD COLUMN pid INTEGER;
ALTER TABLE runner_leases ADD COLUMN process_start_identity TEXT;

CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind = 'craft'),
  status TEXT NOT NULL CHECK (
    status IN ('running', 'succeeded', 'failed', 'interrupted')
  ),
  profile_snapshot_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  successful_attempt_id TEXT REFERENCES model_attempts(id)
    DEFERRABLE INITIALLY DEFERRED,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (turn_id, ordinal)
);

CREATE TABLE model_attempts (
  id TEXT PRIMARY KEY,
  model_call_id TEXT NOT NULL REFERENCES model_calls(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (
    status IN ('running', 'succeeded', 'failed', 'interrupted')
  ),
  provider_request_id TEXT,
  partial_output_json TEXT,
  result_json TEXT,
  finish_reason TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_tokens INTEGER CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (model_call_id, attempt)
);

CREATE TABLE model_tool_calls (
  model_attempt_id TEXT NOT NULL REFERENCES model_attempts(id),
  logical_call_id TEXT NOT NULL,
  call_index INTEGER NOT NULL CHECK (call_index >= 0),
  tool_id TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  normalized_input_hash TEXT NOT NULL,
  PRIMARY KEY (model_attempt_id, logical_call_id),
  UNIQUE (model_attempt_id, call_index)
);

CREATE TABLE tool_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  logical_call_id TEXT NOT NULL,
  source_model_call_id TEXT NOT NULL REFERENCES model_calls(id),
  source_model_attempt_id TEXT NOT NULL REFERENCES model_attempts(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  operation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT,
  source_handle TEXT UNIQUE,
  tool_id TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (
    execution_mode IN ('read_inline', 'worker', 'transactional_intrinsic')
  ),
  side_effect_class TEXT NOT NULL CHECK (
    side_effect_class IN ('read', 'local_write')
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'running',
      'cancel_requested',
      'succeeded',
      'failed',
      'canceled',
      'interrupted'
    )
  ),
  dispatch_state TEXT CHECK (
    dispatch_state IS NULL
    OR dispatch_state IN ('prepared', 'worker_ready', 'go_sent', 'acknowledged')
  ),
  dispatch_nonce TEXT UNIQUE,
  normalized_input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  effect_state TEXT NOT NULL CHECK (
    effect_state IN ('not_applied', 'applied', 'unknown')
  ),
  pid INTEGER,
  process_start_identity TEXT,
  error_code TEXT,
  error_message TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (turn_id, ordinal),
  UNIQUE (source_model_attempt_id, logical_call_id, attempt),
  CHECK (
    (
      execution_mode = 'read_inline'
      AND side_effect_class = 'read'
      AND dispatch_state IS NULL
      AND dispatch_nonce IS NULL
      AND effect_state = 'not_applied'
    )
    OR (
      execution_mode = 'worker'
      AND side_effect_class = 'local_write'
      AND operation_id IS NOT NULL
      AND idempotency_key IS NOT NULL
      AND dispatch_state IS NOT NULL
      AND dispatch_nonce IS NOT NULL
    )
    OR (
      execution_mode = 'transactional_intrinsic'
      AND dispatch_state IS NULL
      AND dispatch_nonce IS NULL
      AND effect_state <> 'applied'
    )
  ),
  CHECK (
    source_handle IS NULL
    OR (tool_id = 'fs.write_text' AND status = 'succeeded')
  )
);

CREATE TABLE tracked_files (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  canonical_path TEXT NOT NULL,
  requested_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  baseline_source TEXT NOT NULL CHECK (baseline_source IN ('read', 'write')),
  last_source_tool_run_id TEXT NOT NULL REFERENCES tool_runs(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, canonical_path)
);

CREATE TABLE fs_write_effects (
  tool_run_id TEXT PRIMARY KEY REFERENCES tool_runs(id),
  requested_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  target_existed_before INTEGER NOT NULL CHECK (target_existed_before IN (0, 1)),
  baseline_sha256 TEXT,
  expected_sha256 TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size >= 0)
);

CREATE TABLE audit_events (
  global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  operation_key TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('intent', 'outcome')),
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (operation_key, phase)
);

CREATE TABLE effect_resolutions (
  id TEXT PRIMARY KEY,
  resolution_key TEXT NOT NULL UNIQUE,
  tool_run_id TEXT NOT NULL REFERENCES tool_runs(id),
  resolution TEXT NOT NULL CHECK (
    resolution IN ('confirmed_applied', 'confirmed_not_applied')
  ),
  evidence_json TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor = 'daemon'),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX model_calls_one_running_per_turn
ON model_calls(turn_id)
WHERE status = 'running';

CREATE UNIQUE INDEX model_attempts_one_running_per_call
ON model_attempts(model_call_id)
WHERE status = 'running';

CREATE UNIQUE INDEX model_attempts_one_succeeded_per_call
ON model_attempts(model_call_id)
WHERE status = 'succeeded';

CREATE UNIQUE INDEX tool_runs_one_active_per_turn
ON tool_runs(turn_id)
WHERE status IN ('queued', 'running', 'cancel_requested');

CREATE UNIQUE INDEX tool_runs_effectful_idempotency_owner
ON tool_runs(tool_id, tool_version, idempotency_key)
WHERE side_effect_class = 'local_write' AND idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX runner_leases_one_active_per_turn
ON runner_leases(current_turn_id)
WHERE status = 'active';
