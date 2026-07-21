-- Translated from sqlite/0008-seed-source.sql for Azure SQL (T-SQL).
-- Seed provenance (ng-v0 bridge piece 1): a chat born from an existing repo
-- state rather than the golden template records where it came from, so the UI
-- can show "seeded from REQ-2136". Additive nullable columns; template-born
-- chats read both as NULL. seed_url holds a clone URL (free-form, so MAX);
-- seed_ref holds a git ref/sha (id-like, so NVARCHAR(450)).

IF COL_LENGTH('chats','seed_url') IS NULL
ALTER TABLE chats ADD seed_url NVARCHAR(MAX);

IF COL_LENGTH('chats','seed_ref') IS NULL
ALTER TABLE chats ADD seed_ref NVARCHAR(450);
