CREATE TABLE plans (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id),
  prompt     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX plans_chat_created_at_idx
ON plans (chat_id, created_at DESC);

ALTER TABLE generations
ADD COLUMN plan_id TEXT REFERENCES plans(id);
