-- Translated from sqlite/0002-generation-narration.sql for Azure SQL (T-SQL).

IF COL_LENGTH('generations','narration') IS NULL
ALTER TABLE generations
ADD narration NVARCHAR(MAX) NOT NULL DEFAULT '';
