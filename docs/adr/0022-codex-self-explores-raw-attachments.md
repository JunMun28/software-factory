# Codex self-explores raw uploaded attachments in a read-only sandbox (no pre-extraction)

**Status:** accepted
**Builds on:** ADR 0021 (Codex default runtime) · ADR 0007 (LLM seam) · ADR 0003 (Draft spec staged in DB) · ADR 0008 (append-only event log)

The Intake form will let a Submitter attach **images and documents** to a Request as
evidence — error-message screenshots, logs, a PDF/Word/Excel spec (see the **Attachment**
glossary term). The Stage 1 brain must read them as first-class source material, the same
standing as the typed description. There are two ways to get bytes into the agent: **pre-extract**
text from each file at upload and stuff it into the prompt, or **hand the agent the raw files**
and let it inspect what it needs. We chose the latter.

Codex is already the default runtime (ADR 0021) and is agentic with file tools and a shell.
Reading `.txt/.log/.csv/.md` is direct; `.docx/.xlsx` are ZIP+XML and parse with Python
**stdlib** (`zipfile`+`xml`); PDFs go through **`pdftotext`**; images attach via
`codex exec --image`. So "the agent reads the files itself" needs **no bespoke extraction
pipeline and no per-format parser library** in the API. Feeding whole and letting the agent
decide what to read keeps the user's actual description from being buried under a spreadsheet
dump, and bounds cost by the existing stage **timeout** (codex has no turn cap — ADR 0021).
The real-brain path never promised determinism (ADR 0009 keeps `verify`/CI on `scripted`), and
the brain is "enrichment, never a blocker" — it degrades to `ScriptedBrain`.

## Decision

- **The brain hands the agent an isolated, throwaway working directory** holding the Request's
  attachments and runs `codex exec` with `cwd` set to it; images are additionally passed via
  `--image`. No pre-extraction, no `pypdf`/`python-docx`/`openpyxl` in the API process.
- **The sandbox stays read-only** (`allow_edits=False` in `agent_exec.py::run_agent`). Reading a
  file and running `pdftotext file -` or inline `python3 -c '…'` writes nothing to disk, so
  read-only is sufficient — the agent never needs write access to inspect attachments.
- **The working dir is isolated from the repo/Subject** — only this Request's own attachments, a
  fresh temp dir per call, deleted after. The agent's exploration cannot reach Factory or Subject
  source.
- **Attachments are Request data on the local filesystem** (`var/uploads/<request_id>/…`) plus a
  metadata row — **not** in the append-only `progress_event` log (ADR 0008); mutable while the
  Request is a pre-approval draft, frozen at submit.
- **The `claude` path gets no attachment vision** (no `--image` equivalent is wired); it degrades,
  which is fine because the brain already falls back to `ScriptedBrain`.

## Consequences

- **A runtime dependency, not a code dependency.** PDF reading relies on `pdftotext`
  (`poppler-utils`) being present wherever the API runs; the compose stack / `api/Dockerfile`
  must ship it or PDF self-read silently yields nothing. `.docx/.xlsx`/text need nothing. The API
  gains **no** new Python parsing dependency.
- **Non-determinism accepted on the brain path.** The agent decides what to read and how deeply,
  drawing from the same stage timeout as its reasoning; a pathological file can spend the budget.
  Consistent with ADR 0009 and the "enrichment, never a blocker" contract — an empty or failed
  read falls back to the scripted draft, it never errors the submit.
- **Injection residual accepted (posture 1).** Raw file content enters the agent's context
  **outside** the `<request_data>` "data, not instructions" wrapper that protects typed input, so a
  malicious file can attempt prompt injection. Blast radius is a **poisoned Draft spec only** — the
  agent is read-only, network-off, in a throwaway dir, emits text, and every draft passes the human
  **Spec-approval** gate, with provenance/assumption tags flagging attachment-derived lines. No
  scanner in v1; the human gate is the backstop. (Read-only sandbox + the single submit write-path
  keep the real risk minimal.)
- **One load-bearing assumption to validate first.** That `codex exec --sandbox read-only` actually
  reads files in its `cwd` and runs `pdftotext`/stdlib to stdout is the premise the feature rests
  on — proven by a live probe **before** the brain wiring is trusted.
- **Reversible by design.** If self-explore proves flaky or unsafe, the fallback is a deterministic
  pre-extraction step at upload (parse to a `.txt` sidecar wrapped in `<request_data>`); the
  storage model, the API, and the UI are unchanged. "No pre-extraction" is a default we can walk
  back at the one brain chokepoint — like ADR 0021's CLI fork, churn stays cheap.
