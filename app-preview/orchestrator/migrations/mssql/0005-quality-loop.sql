-- Translated from sqlite/0005-quality-loop.sql for Azure SQL (T-SQL).
-- Dashboard quality loop: immutable, per-chat blueprint revisions with a
-- single approved revision at a time.

IF OBJECT_ID('blueprint_revisions') IS NULL
CREATE TABLE blueprint_revisions (
  id             NVARCHAR(450) PRIMARY KEY,
  chat_id        NVARCHAR(450) NOT NULL REFERENCES chats(id),
  revision       INT NOT NULL,
  -- blueprint_json is a JSON blob, so it needs MAX.
  blueprint_json NVARCHAR(MAX) NOT NULL,
  approved_at    NVARCHAR(450),
  created_at     NVARCHAR(450) NOT NULL,
  UNIQUE (chat_id, revision)
);
