-- Per-chat external data connections. Secrets stay separate from display
-- configuration. Postgres-portable (TEXT ids/timestamps and JSON payloads).
CREATE TABLE connections (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('mssql','snowflake','rest')),
  config_json TEXT NOT NULL,
  secret_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (chat_id, name)
);
