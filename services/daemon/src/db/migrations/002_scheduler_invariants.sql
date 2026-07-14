CREATE UNIQUE INDEX turns_one_active_per_session ON turns(session_id) WHERE status IN ('running','cancel_requested');
