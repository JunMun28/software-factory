CREATE TABLE turn_events (
  chat_id       TEXT NOT NULL REFERENCES chats(id),
  generation_id TEXT NOT NULL REFERENCES generations(id),
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (generation_id, seq)
);

CREATE INDEX turn_events_chat_generation_seq_idx
ON turn_events (chat_id, generation_id, seq);
