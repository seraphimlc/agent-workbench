CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  storage_relpath TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  logical_name TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, logical_name),
  FOREIGN KEY (id, current_version_id)
    REFERENCES artifact_versions(artifact_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version INTEGER NOT NULL CHECK (version > 0),
  source_turn_id TEXT NOT NULL REFERENCES turns(id),
  source_tool_run_id TEXT NOT NULL REFERENCES tool_runs(id),
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  visibility TEXT NOT NULL CHECK (
    visibility IN ('final', 'working', 'evidence')
  ),
  artifact_type TEXT NOT NULL CHECK (artifact_type = 'markdown'),
  mime_type TEXT NOT NULL CHECK (mime_type = 'text/markdown'),
  filename TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  validation_status TEXT NOT NULL CHECK (
    validation_status IN ('valid', 'warning', 'invalid', 'unchecked')
  ),
  registration_key TEXT NOT NULL,
  registration_input_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (artifact_id, id),
  UNIQUE (artifact_id, version),
  UNIQUE (source_turn_id, registration_key)
);
