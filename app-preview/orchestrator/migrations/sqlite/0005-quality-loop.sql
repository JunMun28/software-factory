-- Dashboard quality loop: immutable, per-chat blueprint revisions with a
-- single approved revision at a time. Postgres-portable (TEXT ids/timestamps).
CREATE TABLE blueprint_revisions (
  id             TEXT PRIMARY KEY,
  chat_id        TEXT NOT NULL REFERENCES chats(id),
  revision       INTEGER NOT NULL,
  blueprint_json TEXT NOT NULL,
  approved_at    TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (chat_id, revision)
);
