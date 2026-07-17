ALTER TABLE scheduler_slots RENAME TO scheduler_slots_one_slot;

CREATE TABLE scheduler_slots (
  slot_no INTEGER PRIMARY KEY CHECK (slot_no IN (1, 2)),
  state TEXT NOT NULL CHECK (state IN ('free', 'owned')),
  owner_turn_id TEXT UNIQUE REFERENCES turns(id),
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'free' AND owner_turn_id IS NULL)
    OR (state = 'owned' AND owner_turn_id IS NOT NULL)
  )
);

INSERT INTO scheduler_slots (slot_no, state, owner_turn_id, updated_at)
SELECT slot_no, state, owner_turn_id, updated_at
FROM scheduler_slots_one_slot;

INSERT INTO scheduler_slots (slot_no, state, owner_turn_id, updated_at)
VALUES (2, 'free', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

DROP TABLE scheduler_slots_one_slot;
