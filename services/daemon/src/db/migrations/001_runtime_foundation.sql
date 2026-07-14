CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) > 0),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active', 'archived')),
  runtime_status TEXT NOT NULL CHECK (
    runtime_status IN (
      'idle',
      'queued',
      'running',
      'waiting_for_user',
      'canceling',
      'recovering',
      'error'
    )
  ),
  queue_block_reason TEXT CHECK (
    queue_block_reason IS NULL OR queue_block_reason = 'recovery_review'
  ),
  recovery_episode INTEGER NOT NULL CHECK (recovery_episode >= 0),
  recovery_source_turn_id TEXT,
  current_turn_id TEXT REFERENCES turns(id) DEFERRABLE INITIALLY DEFERRED,
  mode TEXT NOT NULL CHECK (mode = 'craft'),
  access_mode TEXT NOT NULL CHECK (access_mode = 'full_access'),
  next_turn_ordinal INTEGER NOT NULL CHECK (next_turn_ordinal > 0),
  next_event_seq INTEGER NOT NULL CHECK (next_event_seq > 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL REFERENCES turns(id) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system_summary')),
  status TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'interrupted')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  client_request_id TEXT NOT NULL CHECK (length(client_request_id) > 0),
  queue_kind TEXT NOT NULL CHECK (queue_kind IN ('normal', 'input_response', 'recovery')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'running',
      'waiting_for_user',
      'cancel_requested',
      'succeeded',
      'failed',
      'canceled',
      'interrupted'
    )
  ),
  input_message_id TEXT NOT NULL REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED,
  mode_snapshot TEXT NOT NULL CHECK (mode_snapshot = 'craft'),
  access_mode_snapshot TEXT NOT NULL CHECK (access_mode_snapshot = 'full_access'),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  result_message_id TEXT REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (session_id, ordinal)
);

CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  tool_run_id TEXT,
  seq INTEGER NOT NULL CHECK (seq > 0),
  type TEXT NOT NULL CHECK (length(type) > 0),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'daemon', 'runner', 'model', 'tool')),
  audience TEXT NOT NULL CHECK (audience IN ('ui', 'model', 'both')),
  payload_json TEXT NOT NULL,
  blob_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE scheduler_slots (
  slot_no INTEGER PRIMARY KEY CHECK (slot_no = 1),
  state TEXT NOT NULL CHECK (state IN ('free', 'owned')),
  owner_turn_id TEXT UNIQUE REFERENCES turns(id),
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'free' AND owner_turn_id IS NULL)
    OR (state = 'owned' AND owner_turn_id IS NOT NULL)
  )
);

INSERT INTO scheduler_slots (slot_no, state, owner_turn_id, updated_at)
VALUES (1, 'free', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE runner_leases (
  id TEXT PRIMARY KEY,
  daemon_epoch TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  current_turn_id TEXT NOT NULL REFERENCES turns(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired')),
  heartbeat_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  UNIQUE (daemon_epoch, lease_epoch)
);

CREATE TABLE rpc_idempotency (
  method TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  normalized_payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (method, client_request_id)
);
