# CLAUDE.md

Full agent guidance lives in [AGENTS.md](AGENTS.md) — read it first.

Three highest-value rules:

1. **Verify with `make verify`** before merging anything — lint + pytest +
   vitest + Angular build + smoke must all be green.
2. **Never UPDATE or DELETE `progress_event` rows** — the log is append-only
   (ADR 0008); mutations break replay and cursors.
3. **Single uvicorn worker only** — the tick loop and pipeline threads assume
   one process; do not scale replicas without an ADR.
