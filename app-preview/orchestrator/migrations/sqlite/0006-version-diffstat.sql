-- Version diffstat (v0-parity gap 3): per-version change summary computed once
-- at version-cut time (git diff vs the parent commit). Additive nullable
-- columns; legacy rows read as NULL, which the UI treats as "no diffstat
-- available". JSON payloads keep the schema Postgres-portable (TEXT columns).
ALTER TABLE versions ADD COLUMN diffstat_json TEXT;
ALTER TABLE versions ADD COLUMN files_json TEXT;
