# The runnable prototype: simulator stands in for CI agents; intake brain is scripted

**Status:** accepted

The first runnable implementation of the web app (FastAPI `api/` + Angular `web/`,
per ADR 0007) ships **without** the external systems: no GitHub App, no Entra SSO,
no LLM API. Three stand-ins make the whole management experience operable and
verifiable locally:

- **Factory simulator** (`api/app/simulator.py`) plays the Stage 2–6 CI agents: each
  tick advances approved Work items through a deterministic per-stage script and emits
  the same milestone summaries / gate events the real Copilot agents would post as PR
  comments (ADR 0004). It **stops at the merge gate** and waits for an Admin — the
  "humans gate the irreversible" rule is enforced, not simulated.
- **Scripted intake brain** (`api/app/interview.py`) implements the Stage 1 interview
  + grounded draft-spec generation deterministically behind the `LLMClient`-shaped
  seam ADR 0007 reserves; swapping in a real model touches only this module.
- **Role-picker sign-in** stands in for the Entra role fork; identities are fixed
  (Jordan D. = Submitter, Kim P. = Admin).

## Why recorded

- A future engineer wiring real GitHub/Entra/LLM should **replace these seams, not the
  domain model**: the Request lifecycle, per-step approve ledger (ADR 0006), and the
  two-axis `progress_event` log (ADR 0008) are implemented for real and tested — they
  are the keepers. The simulator/brain/login are the disposable shells.
- Determinism is load-bearing for verification: `make verify` (pytest + build + smoke)
  depends on the scripted brain and tick-driven simulator producing the same world
  every run. Keep any future "real" integrations behind flags so the deterministic
  path survives.

## Consequences

- `SIM_INTERVAL` env (seconds) auto-ticks the factory in `make dev`; tests and the
  smoke script tick explicitly instead.
- The merge gate doubles as the deploy gate (one protected-branch idea, ADR 0005);
  the prototype collapses merge→deploy into one approval rather than two PRs.
