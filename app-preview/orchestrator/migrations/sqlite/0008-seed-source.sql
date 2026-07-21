-- Seed provenance (ng-v0 bridge piece 1): a chat born from an existing repo
-- state rather than the golden template records where it came from, so the UI
-- can show "seeded from REQ-2136". Additive nullable columns; template-born
-- chats read both as NULL. TEXT keeps the schema Postgres-portable.
ALTER TABLE chats ADD COLUMN seed_url TEXT;
ALTER TABLE chats ADD COLUMN seed_ref TEXT;
