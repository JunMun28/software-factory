-- Translated from sqlite/0006-version-diffstat.sql for Azure SQL (T-SQL).
-- Version diffstat (v0-parity gap 3): per-version change summary computed once
-- at version-cut time (git diff vs the parent commit). Additive nullable
-- columns; legacy rows read as NULL, which the UI treats as "no diffstat
-- available". Both columns hold JSON payloads, so both use NVARCHAR(MAX).

IF COL_LENGTH('versions','diffstat_json') IS NULL
ALTER TABLE versions ADD diffstat_json NVARCHAR(MAX);

IF COL_LENGTH('versions','files_json') IS NULL
ALTER TABLE versions ADD files_json NVARCHAR(MAX);
