-- Translated from sqlite/0004-plans.sql for Azure SQL (T-SQL).

IF OBJECT_ID('plans') IS NULL
CREATE TABLE plans (
  id         NVARCHAR(450) PRIMARY KEY,
  chat_id    NVARCHAR(450) NOT NULL REFERENCES chats(id),
  -- prompt and text are free-form generated content, so both need MAX.
  prompt     NVARCHAR(MAX) NOT NULL,
  text       NVARCHAR(MAX) NOT NULL,
  created_at NVARCHAR(450) NOT NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'plans_chat_created_at_idx' AND object_id = OBJECT_ID('plans'))
CREATE INDEX plans_chat_created_at_idx
ON plans (chat_id, created_at DESC);

IF COL_LENGTH('generations','plan_id') IS NULL
ALTER TABLE generations
ADD plan_id NVARCHAR(450) REFERENCES plans(id);
