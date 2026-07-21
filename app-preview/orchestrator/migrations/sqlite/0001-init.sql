-- Platform metadata store (docs/plan/persistence-design.md §2).
-- Postgres-portable: TEXT uuids, TEXT ISO-8601 timestamps, ANSI types only.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  display_name  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE chats (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  title          TEXT,
  workspace_ref  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE TABLE generations (
  id               TEXT PRIMARY KEY,
  chat_id          TEXT NOT NULL REFERENCES chats(id),
  turn_number      INTEGER NOT NULL,
  prompt           TEXT NOT NULL,
  result           TEXT NOT NULL CHECK (result IN ('green','red','no-change','error','timeout','running')),
  gate_output_tail TEXT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  UNIQUE (chat_id, turn_number)
);

CREATE TABLE versions (
  id                       TEXT PRIMARY KEY,
  chat_id                  TEXT NOT NULL REFERENCES chats(id),
  generation_id            TEXT UNIQUE REFERENCES generations(id),
  seq                      INTEGER NOT NULL,
  manifest_ref             TEXT NOT NULL,
  message                  TEXT,
  restored_from_version_id TEXT REFERENCES versions(id),
  created_at               TEXT NOT NULL,
  UNIQUE (chat_id, seq)
);
