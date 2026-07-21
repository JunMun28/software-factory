-- Translated from sqlite/0003-turn-events.sql for Azure SQL (T-SQL).

IF OBJECT_ID('turn_events') IS NULL
CREATE TABLE turn_events (
  chat_id       NVARCHAR(450) NOT NULL REFERENCES chats(id),
  generation_id NVARCHAR(450) NOT NULL REFERENCES generations(id),
  seq           INT NOT NULL,
  type          NVARCHAR(450) NOT NULL,
  -- payload is a JSON blob, so it needs MAX rather than a keyable width.
  payload       NVARCHAR(MAX) NOT NULL,
  created_at    NVARCHAR(450) NOT NULL,
  PRIMARY KEY (generation_id, seq)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'turn_events_chat_generation_seq_idx' AND object_id = OBJECT_ID('turn_events'))
CREATE INDEX turn_events_chat_generation_seq_idx
ON turn_events (chat_id, generation_id, seq);
