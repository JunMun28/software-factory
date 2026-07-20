# The intake brain uses a direct Anthropic API transport

**Status:** accepted
**Supersedes:** ADR 0024 (Stage 1 intake brain transport only)

## Context

ADR 0024 sends both agent seams through the opencode CLI. That remains useful for
the build runner, which needs a workspace, tools, and sandbox enforcement. The
Stage 1 intake brain is different: classification, questions, summaries,
prototypes, and draft specs are read-only text or image-in/text-out calls. Starting
a CLI subprocess for each one adds cold-start latency and withholds all output until
the process exits, even though the intake SSE contract can carry progressive output.

The API backend already performs slow intake generation on background threads. A
synchronous streaming SDK call on those threads fits the current ownership model;
converting the sync FastAPI handlers or generation lifecycle to async would expand
this transport change without improving the browser stream.

## Decision

- `FACTORY_BRAIN=api` selects a direct Anthropic SDK transport for the intake brain.
  The offline default remains `scripted` until measured latency and operating cost
  justify a separate default flip.
- The fallback chain is **Anthropic API → agent CLI → scripted brain**. Provider,
  connection, capacity, parsing, or credential failures therefore preserve the
  existing rule that intake enrichment must not block a request.
- The transport uses the synchronous `Anthropic` client, created lazily as one
  process-local singleton. Calls run in the existing generation threads; no API-tier
  call launches a subprocess. `FACTORY_API_BRAIN_CAP` (default 20) bounds provider
  sockets independently of the existing `FACTORY_CLI_CAP` fallback bound.
- Models are tiered by task and independently configurable: Haiku for classify,
  Sonnet for questions, summaries, and prototypes, and Opus for the submitted draft
  spec. Interactive Sonnet calls disable thinking and use low effort; the Opus spec
  call uses high effort without a thinking budget.
- Interview and prototype text chunks are published over their existing SSE routes.
  Only the human-readable prose before `===META===` or `===PROTO===` is relayed;
  the final `state` event remains authoritative. The existing polling path remains
  the reconnect and degraded-mode source of truth.
- Image attachments become native base64 image content blocks. Other attachment
  binaries are not sent; their filenames and that limitation are stated in the
  prompt. Existing output hardening and shared prompt/parsing functions apply to
  both API and CLI transports.
- `brain_calls` is the durable idempotency and usage ledger. A unique non-null
  `dedup_key` elects question, summary, prototype, and classify generation; the row
  also records model, token usage, total duration, time to first token, and terminal
  status. Process-local locks remain only as a fast path.

## Consequences

- Users can see the first interview/prototype prose before the complete model reply,
  while a dropped SSE connection still converges through the existing poll response.
- Running `api` mode requires an Anthropic API key and incurs per-token charges.
  Per-user call/token budgets and a clear budget-exhausted response are mandatory
  before end-user launch; `brain_calls` supplies the accounting source for that work.
- The API key remains on the API pod while it is the only brain host. The Phase 1 pod
  sizing and CLI semaphore are not reverted by this decision; both remain until a
  later measured default-flip decision.
- The Stages 2–5 build pipeline is unchanged. It continues to use the selected agent
  CLI and Kubernetes Job/gate architecture from ADR 0024 and the later runner ADRs.
- Tests and CI remain deterministic: API mode is exercised with a mocked client and
  no real provider calls or credentials.
