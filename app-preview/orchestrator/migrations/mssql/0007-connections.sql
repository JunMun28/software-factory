-- Translated from sqlite/0007-connections.sql for Azure SQL (T-SQL).
-- Per-chat external data connections. Secrets stay separate from display
-- configuration.

IF OBJECT_ID('connections') IS NULL
CREATE TABLE connections (
  id          NVARCHAR(450) PRIMARY KEY,
  chat_id     NVARCHAR(450) NOT NULL REFERENCES chats(id),
  name        NVARCHAR(450) NOT NULL,
  kind        NVARCHAR(450) NOT NULL CHECK (kind IN ('mssql','snowflake','rest')),
  -- config_json and secret_json are JSON payloads, so both use MAX.
  config_json NVARCHAR(MAX) NOT NULL,
  secret_json NVARCHAR(MAX) NOT NULL,
  created_at  NVARCHAR(450) NOT NULL,
  UNIQUE (chat_id, name)
);
