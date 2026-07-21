-- Translated from sqlite/0001-init.sql for Azure SQL (T-SQL).
-- Platform metadata store (docs/plan/persistence-design.md §2).
-- TEXT ids/timestamps map to NVARCHAR(450) so they stay keyable (SQL Server
-- cannot index NVARCHAR(MAX)); free-form content maps to NVARCHAR(MAX).

IF OBJECT_ID('users') IS NULL
CREATE TABLE users (
  id            NVARCHAR(450) PRIMARY KEY,
  email         NVARCHAR(450) UNIQUE,
  display_name  NVARCHAR(450),
  created_at    NVARCHAR(450) NOT NULL
);

IF OBJECT_ID('projects') IS NULL
CREATE TABLE projects (
  id          NVARCHAR(450) PRIMARY KEY,
  user_id     NVARCHAR(450) NOT NULL REFERENCES users(id),
  name        NVARCHAR(450) NOT NULL,
  created_at  NVARCHAR(450) NOT NULL
);

IF OBJECT_ID('chats') IS NULL
CREATE TABLE chats (
  id             NVARCHAR(450) PRIMARY KEY,
  project_id     NVARCHAR(450) NOT NULL REFERENCES projects(id),
  title          NVARCHAR(450),
  workspace_ref  NVARCHAR(450) NOT NULL,
  created_at     NVARCHAR(450) NOT NULL,
  last_active_at NVARCHAR(450) NOT NULL
);

IF OBJECT_ID('generations') IS NULL
CREATE TABLE generations (
  id               NVARCHAR(450) PRIMARY KEY,
  chat_id          NVARCHAR(450) NOT NULL REFERENCES chats(id),
  turn_number      INT NOT NULL,
  prompt           NVARCHAR(MAX) NOT NULL,
  result           NVARCHAR(450) NOT NULL CHECK (result IN ('green','red','no-change','error','timeout','running')),
  -- gate_output_tail holds captured gate stdout/stderr, so it needs MAX.
  gate_output_tail NVARCHAR(MAX),
  started_at       NVARCHAR(450) NOT NULL,
  finished_at      NVARCHAR(450),
  UNIQUE (chat_id, turn_number)
);

IF OBJECT_ID('versions') IS NULL
CREATE TABLE versions (
  id                       NVARCHAR(450) PRIMARY KEY,
  chat_id                  NVARCHAR(450) NOT NULL REFERENCES chats(id),
  generation_id            NVARCHAR(450) UNIQUE REFERENCES generations(id),
  seq                      INT NOT NULL,
  manifest_ref             NVARCHAR(450) NOT NULL,
  message                  NVARCHAR(450),
  restored_from_version_id NVARCHAR(450) REFERENCES versions(id),
  created_at               NVARCHAR(450) NOT NULL,
  UNIQUE (chat_id, seq)
);
