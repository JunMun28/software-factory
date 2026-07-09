# DRE-6 — Harden the Factory's Trust & Control Surfaces (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the governance gaps in [DRE-6](https://linear.app/dreammoments/issue/DRE-6) so every governed surface (merge gate, spec gate, retries, the architecture step) carries real evidence and real control under the live runner — without breaking the factory's invariants.

**Architecture:** A program of small, independently-green slices. Each adds one deep module (pure, unit-testable) and/or threads it into the runner/lifecycle seams. The linchpin — the real `verification` event — already landed (Slice A, `api/app/verification.py`). This plan covers the rest.

**Tech Stack:** Python 3 · FastAPI · SQLAlchemy · SQLite · pytest · `uv` (tests run from `api/` via `uv run pytest`). Angular 22 + Vitest for the final web slice. The runner's agent calls go through an injectable executor, so all factory behavior is provable offline with no model call.

## Global Constraints

- **Append-only log (ADR 0008):** every new signal is a new `INSERT` via `emit(...)` or additive payload on an existing event. Never `UPDATE`/`DELETE` a `progress_event` row. Per-assumption confirm/override are *new events*, never mutations of gate/spec events.
- **Single worker (ADR 0013):** no new process or thread. New gates shell out synchronously like the existing pytest gate (`ws_exec._git` / `ws_exec._pytest`).
- **Humans gate the irreversible:** new gates escalate (`needs_human`) on failure via the existing `ClaudeRunner._escalate`; they never auto-retry.
- **Deterministic/offline default:** telemetry/cost are real-runner-only and never fabricated on the simulated path. Every guardrail has a deterministic, offline test that runs under `make verify`.
- **Verify gate:** `make verify` (lint + pytest + vitest + Angular build + smoke) must be green before any slice is considered done.
- **Payload contract:** `supervision.evidence()` (`api/app/supervision.py:83-97`) reads the `approve_merge` keys `tests_passed, tests_total, diff_added, diff_removed, files_changed, reviewer_verdict, assumptions`. New keys are additive; existing keys never change shape.

---

## Slice Roadmap (each = one `make verify`-green commit on the worktree)

The linchpin (real `verification` event) is **done**. Remaining slices, ordered for independence then dependency:

| # | Slice | New module / seam | Depends on |
|---|-------|-------------------|-----------|
| 1 | **Secret scanner + SECURITY gate** | `secret_scan.py` (pure) → new `_security` gate after GREEN | — |
| 2 | **Reviewer REQUEST-CHANGES stance** | `_review` honors the parsed verdict (escalate vs labeled gate) + ADR | — |
| 3 | **Prompt registry + snapshot tests** | `prompts.py` versioned personas + brain; snapshot test | — |
| 4 | **Injection builder** | `injection.py` `request_data_block(note?, prior?, budget)` (pure) | — |
| 5 | **Real steering** | retry note threaded into the re-run as delimited data | 4 |
| 6 | **Telemetry** | wall-clock at the exec chokepoint; real-runner cost; additive payload | — |
| 7 | **Subject memory** | `subject_memory.py` `prior_context(db, subject_id, budget)` | 4 |
| 8 | **Architecture approval gate** | gate raised after `_architecture`; resume at test-author; ADR | — |
| 9 | **Inline SpecLine edit at spec gate** | status-guarded edit endpoint; per-assumption events | — |
| 10 | **Verification findings + edge-case ledger** | extend `build_payload` (categorized findings, covered/uncovered) | — |
| 11 | **Send-back-to-architecture** | recovery action: atomic reset to architecture + sanitized transcript | 4 |
| 12 | **Web surfacing** | console: findings/ledger/latency strip, arch gate, SpecLine edit, send-back | 8,9,10,11 |

Slices 1–11 are backend (`api/`). Slice 12 is the Angular console (`apps/console`). Each slice below is detailed to TDD steps **when it becomes the active slice** — Slice 1 is fully detailed now; the rest carry interface + behavior + test contracts and are expanded to red-green-commit steps at execution time (later signatures genuinely depend on earlier slices' real code, so detailing all 12 up front would go stale).

---

## Slice 1: Secret scanner + SECURITY gate

**Files:**
- Create: `api/app/secret_scan.py` — pure `scan(diff_text: str) -> list[Finding]`. No I/O.
- Test (create): `api/tests/test_secret_scan.py` — unit tests over crafted diffs.
- Modify: `api/app/claude_runner.py` — add `_security` gate method; insert it into the pipeline tuple between `_green` and `_review`; bump the `review` resume index.
- Test (modify): `api/tests/test_claude_runner.py` — adversarial planted-secret test drives the gate end-to-end and asserts it escalates; a clean run still reaches the merge gate.
- Create: `docs/adr/0018-security-gate-secret-scan.md` — extends ADR 0001 (CI-enforced factory).

**Interfaces:**
- Produces: `secret_scan.scan(diff_text) -> list[Finding]` where `Finding` is a small dataclass `(category: str, line: int, snippet: str)`. `category` ∈ a fixed vocabulary (`aws_key`, `private_key`, `generic_secret`, `password_assignment`, `high_entropy_token`). Helper `summarize(findings) -> str` returns a one-line category roll-up for the escalation reason.
- Consumes (gate): `ws_exec._git(ws, "diff", "main...HEAD")` for the unified diff text; `ClaudeRunner._escalate` for the failure path.

**Gate semantics (mirrors the pytest gate's honesty rules):**
- Scans **only added lines** of the branch-vs-main diff (`+` lines, never `+++` headers), so pre-existing `sample/` content cannot false-positive (US #5).
- A finding → `_escalate(... "SECURITY gate: <summary>")`, gate not advanced (US #4).
- The diff command failing (`returncode != 0`) → escalate `"SECURITY gate cannot run: <stderr>"` — an unrunnable guardrail never looks clean (US #6).
- Clean → pass through to `_review`. The gate does **not** call `_advance` (it is a post-build check; stage stays `build`).

- [ ] **Step 1: Write the failing scanner unit test**

Create `api/tests/test_secret_scan.py`:

```python
"""secret_scan.scan — pure function over a unified diff. Deterministic/offline."""
from app import secret_scan


def _added(*lines: str) -> str:
    """A minimal unified diff whose body is added (+) lines."""
    body = "".join(f"+{ln}\n" for ln in lines)
    return "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -0,0 +1 @@\n" + body


def test_flags_planted_aws_key():
    findings = secret_scan.scan(_added('AWS_KEY = "AKIAIOSFODNN7EXAMPLE"'))
    assert findings and findings[0].category == "aws_key"


def test_flags_private_key_header():
    findings = secret_scan.scan(_added("-----BEGIN RSA PRIVATE KEY-----"))
    assert any(f.category == "private_key" for f in findings)


def test_flags_password_assignment():
    findings = secret_scan.scan(_added('password = "hunter2pa55word!"'))
    assert any(f.category == "password_assignment" for f in findings)


def test_benign_diff_is_clean():
    diff = _added("def add(a, b):", "    return a + b")
    assert secret_scan.scan(diff) == []


def test_ignores_removed_and_context_lines():
    # a secret being DELETED (leading '-') or already present (context, no prefix)
    # is not introduced by this branch — only added (+) lines count
    diff = (
        "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,1 @@\n"
        '-AWS_KEY = "AKIAIOSFODNN7EXAMPLE"\n'
        ' unchanged_token = "AKIAIOSFODNN7EXAMPLE"\n'
    )
    assert secret_scan.scan(diff) == []


def test_summarize_rolls_up_categories():
    findings = secret_scan.scan(_added('AWS_KEY = "AKIAIOSFODNN7EXAMPLE"',
                                       "-----BEGIN RSA PRIVATE KEY-----"))
    summary = secret_scan.summarize(findings)
    assert "aws_key" in summary and "private_key" in summary
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd api && uv run pytest tests/test_secret_scan.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.secret_scan'`.

- [ ] **Step 3: Implement `secret_scan.py`**

Create `api/app/secret_scan.py`:

```python
"""Diff-scoped secret/credential scanner — the SECURITY gate's engine (ADR 0018).

A pure function over a unified-diff string: it inspects only ADDED lines (the
secrets THIS branch introduces), so pre-existing sample content never produces a
false escalation. No I/O, so it is trivially unit-testable and runs inside the
single worker. Conservative by design — it would rather escalate to a human than
wave a credential through; the human merge gate is the backstop, not this regex.
"""
import math
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Finding:
    category: str
    line: int       # 1-based index among added lines
    snippet: str    # the offending added line, trimmed


# category -> matcher. Ordered: the first matching category wins per line.
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("aws_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    ("password_assignment", re.compile(
        r"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key)\b\s*[=:]\s*['\"][^'\"]{6,}['\"]")),
]
# a long unbroken base64/hex-ish run assigned to something — catches opaque tokens
_HIGH_ENTROPY = re.compile(r"['\"]([A-Za-z0-9+/=_\-]{32,})['\"]")


def _shannon(s: str) -> float:
    if not s:
        return 0.0
    counts = {c: s.count(c) for c in set(s)}
    return -sum((n / len(s)) * math.log2(n / len(s)) for n in counts.values())


def _added_lines(diff_text: str) -> list[str]:
    """Body '+' lines only — never the '+++' file header."""
    out = []
    for ln in diff_text.splitlines():
        if ln.startswith("+") and not ln.startswith("+++"):
            out.append(ln[1:])
    return out


def scan(diff_text: str) -> list[Finding]:
    findings: list[Finding] = []
    for i, raw in enumerate(_added_lines(diff_text), start=1):
        line = raw.strip()
        matched = False
        for category, pat in _PATTERNS:
            if pat.search(raw):
                findings.append(Finding(category, i, line[:120]))
                matched = True
                break
        if matched:
            continue
        m = _HIGH_ENTROPY.search(raw)
        if m and _shannon(m.group(1)) >= 4.0:
            findings.append(Finding("high_entropy_token", i, line[:120]))
    return findings


def summarize(findings: list[Finding]) -> str:
    """One-line category roll-up for the escalation reason, e.g.
    'aws_key×1, private_key×1'."""
    counts: dict[str, int] = {}
    for f in findings:
        counts[f.category] = counts.get(f.category, 0) + 1
    return ", ".join(f"{cat}×{n}" for cat, n in sorted(counts.items()))
```

- [ ] **Step 4: Run the scanner tests, confirm green**

Run: `cd api && uv run pytest tests/test_secret_scan.py -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing end-to-end gate test**

Add to `api/tests/test_claude_runner.py` (a planted-secret executor + the gate assertion):

```python
def leaking_implementer(prompt: str, *, cwd: str | None = None, **kw) -> ClaudeResult:
    """Honest through GREEN, but the implementation hard-codes a credential."""
    ws = Path(cwd)
    if "architect" in prompt:
        (ws / "PLAN.md").write_text("# PLAN\nAdd monthly_export() to src/expenses.py.\n")
    elif "test-author" in prompt:
        (ws / "tests" / "test_feature.py").write_text(GOOD_TEST)
    elif "implementer" in prompt:
        with (ws / "src" / "expenses.py").open("a") as f:
            f.write(GOOD_IMPL)
            f.write('\nAWS_KEY = "AKIAIOSFODNN7EXAMPLE"  # leaked\n')
    elif "reviewer" in prompt:
        (ws / "REVIEW.md").write_text("APPROVE\nlgtm\n")
    return ClaudeResult(ok=True, text="done")


def test_security_gate_escalates_on_planted_secret(client, ws_root):
    d = _approved_request(client, "Leaked credential")
    ClaudeRunner(executor=leaking_implementer).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "SECURITY gate" in out["needs_human_reason"]
    assert out["gate"] != "approve_merge"  # never reached the merge gate
```

- [ ] **Step 6: Run it, confirm it fails for the right reason**

Run: `cd api && uv run pytest tests/test_claude_runner.py::test_security_gate_escalates_on_planted_secret -q`
Expected: FAIL — the request currently reaches `approve_merge` (no gate yet), so `needs_human` is False.

- [ ] **Step 7: Add the `_security` gate to the runner**

In `api/app/claude_runner.py`:

1. Import: add `from .secret_scan import scan as scan_secrets, summarize as summarize_findings` near the other app imports.
2. Add the gate method after `_green`:

```python
    def _security(self, db: Session, req: Request, ws: Path) -> bool:
        """Diff-scoped secret scan after GREEN, before the merge gate. Scans only
        the branch-vs-main diff so pre-existing sample content cannot false-flag;
        a finding — or an undrivable scan — escalates (ADR 0018)."""
        diff = _git(ws, "diff", "main...HEAD")
        if diff.returncode != 0:
            self._escalate(db, req, f"SECURITY gate cannot run: {(diff.stderr or 'git diff failed').strip()[:200]}")
            return False
        findings = scan_secrets(diff.stdout)
        if findings:
            self._escalate(db, req, f"SECURITY gate: credential(s) in the diff — {summarize_findings(findings)}")
            return False
        emit(db, req, "milestone_summary", "SECURITY gate passed — no secrets in the branch diff",
             payload={"fields": {"Gate": "SECURITY · passed", "Agent": "Factory"}, "Ref": req.ref})
        db.commit()
        log.info("%s: SECURITY gate passed", req.ref)
        return True
```

3. Insert `_security` into the pipeline tuple and fix the resume index map:

```python
        stages = (self._architecture, self._red, self._green, self._security, self._review)
        first = {"build": 1, "review": 4}.get(req.stage, 0) if resumable else 0
```

(`_security` keeps `req.stage == "build"`; on a `build` Retry it replays red→green→security, and `review` now resolves to index 4 = `_review`.)

- [ ] **Step 8: Run the gate test, confirm green**

Run: `cd api && uv run pytest tests/test_claude_runner.py::test_security_gate_escalates_on_planted_secret -q`
Expected: PASS.

- [ ] **Step 9: Run the full runner + verification suite (no regressions)**

Run: `cd api && uv run pytest tests/test_claude_runner.py tests/test_verification.py tests/test_supervision.py -q`
Expected: PASS — `test_full_pipeline_to_merge`, the Retry-resume test, and the verification-evidence test all still reach the merge gate (the clean executors plant no secret).

- [ ] **Step 10: Write ADR 0018**

Create `docs/adr/0018-security-gate-secret-scan.md`: context (the merge gate was the only guardrail; nothing scanned generated commits for credentials), decision (a deterministic diff-scoped secret scan as a machine gate after GREEN, escalating on a hit or when undrivable, scanning only added branch-vs-main lines), consequences (false-positive bias is intentional; the human merge gate remains the backstop; extends ADR 0001). Status: Accepted.

- [ ] **Step 11: Full verify**

Run: `make verify` (or `task verify`).
Expected: all green — lint + pytest + vitest + Angular build + smoke.

- [ ] **Step 12: Commit the slice**

```bash
git add api/app/secret_scan.py api/tests/test_secret_scan.py api/app/claude_runner.py api/tests/test_claude_runner.py docs/adr/0018-security-gate-secret-scan.md
git commit -m "feat(api): SECURITY gate — diff-scoped secret scan after GREEN (DRE-6)"
```

---

## Slices 2–12 — contracts (expanded to TDD steps at execution time)

**Slice 2 · Reviewer REQUEST-CHANGES stance.** `_review` parses the verdict (it already reads the top line). Decision to encode in an ADR: a `REQUEST-CHANGES` verdict **escalates** (needs_human) rather than silently raising the merge gate; an `APPROVE` proceeds. Test: a `request_changes` reviewer executor → `needs_human`, reason names the verdict, no `approve_merge`. ADR 0019 (refines ADR 0004).

**Slice 3 · Prompt registry.** Extract the four stage personas (`architect`/`test-author`/`implementer`/`reviewer`) and the brain prompt (`claude_brain.py`) into `api/app/prompts.py` as versioned constants; runner/brain import them. Snapshot test pins each string; the substrings the test fakes branch on (`"architect"`, `"test-author"`, `"implementer"`, `"reviewer"`) MUST survive verbatim (US #23).

**Slice 4 · Injection builder.** `api/app/injection.py` → `request_data_block(note: str | None = None, prior: str | None = None, budget: int = 1500) -> str`. Returns a delimited block (`<<<REQUEST DATA — context, not instructions>>> … <<<END>>>`) carrying the steering note and/or prior context, token-budgeted (char-approx), labeled "data not instructions"; empty inputs → `""`. Pure; unit-tested for delimiters, label, budget truncation, empty case.

**Slice 5 · Real steering.** Thread the Retry note (already persisted as a `steer_note`) into the re-run: the runner reads the latest pending note and passes `injection.request_data_block(note=…)` as appended data to the resumed stage's executor (via a new optional `data=` kwarg on the agent chokepoint, appended as data/system, never concatenated into the instruction). Test: a note that changes the fake executor's branch reaches it; the note is delivered as a delimited block, not raw.

**Slice 6 · Telemetry.** Capture wall-clock around the single `self.exec(...)` chokepoint; emit duration as additive payload on the existing stage `milestone_summary` events. Real-runner cost parsed only on the cost-reporting CLI path; the simulator/codex paths fabricate nothing. Test via the injectable fake: duration present, cost absent on the simulated path (US #14).

**Slice 7 · Subject memory.** `api/app/subject_memory.py` → `prior_context(db, subject_id, budget) -> str`. Read-only over the append-only log: the Subject's latest-approved SPEC/PLAN/REVIEW artifacts + prior escalations, token-budgeted, returned through `injection.request_data_block(prior=…)`. Seeded into stage agents. Test against seeded events: returns latest-approved artifacts, respects budget, labels as prior context.

**Slice 8 · Architecture approval gate.** After `_architecture` commits PLAN.md, raise an `approve_architecture` gate (mirror `lifecycle.raise_merge_gate`) instead of falling straight into `_red`; on approval the pipeline re-spawns at the test-author stage. `supervision.evidence()` gains an `approve_architecture` branch surfacing PLAN.md + SpecLine validation. Lifecycle handler + resume wiring + ADR 0020. Tests: gate raised after architecture; approve resumes at `_red`; send-back path.

**Slice 9 · Inline SpecLine edit at the spec gate.** A status-guarded endpoint to edit/sharpen a `SpecLine` and pin/override an assumption while `gate == "approve_spec"` and `status == "pending_approval"`; blocked once the request has left pending-approval (US #19). Each per-assumption confirm/override is a **new** `assumption_decision` event (US #20), never a mutation of a gate event. Tests: edit allowed pre-approval, rejected post-approval; each decision appends an event.

**Slice 10 · Verification findings + edge-case ledger.** Extend `verification.build_payload` with `findings` (categorized: security/hallucinated-dependency/error-handling/performance/correctness, parsed from REVIEW.md sections) and an `edge_cases` ledger (covered/uncovered). Additive payload keys; `supervision.evidence()` surfaces them. The simulator emits the same new keys with fabricated values. Tests: builder returns findings + ledger from a fixture REVIEW.md; evidence() carries them.

**Slice 11 · Send-back-to-architecture.** A recovery action on an escalated request: atomic state reset to the architecture stage carrying the sanitized failure transcript via `injection.request_data_block(prior=transcript)`; re-enters at `_architecture`. Lifecycle action + endpoint. Tests: a failed build sends back to architecture with the transcript attached; status transitions are atomic (a racing Cancel wins).

**Slice 12 · Web surfacing (apps/console).** Surface the new signals where the human decides: the evidence strip shows findings + edge-case ledger + per-stage latency; the architecture gate gets approve/send-back UI; inline SpecLine edit at the spec gate; the send-back-to-architecture action on escalated requests. Vitest for the new core/util derivations; the build + smoke prove it renders.

---

## Self-Review (against the DRE-6 spec)

- **Coverage:** the 29 user stories map onto slices — evidence/findings/ledger (US 1–3 → already-done linchpin + Slice 10), SECURITY gate (US 4–6 → Slice 1), reviewer verdict (US 7 → Slice 2), steering (US 8–9 → Slices 4–5), send-back (US 10 → Slice 11), architecture gate (US 11 → Slice 8), telemetry/cost/routing (US 12–15 → Slice 6), subject memory (US 16–17 → Slice 7), SpecLine edit/assumptions (US 18–20 → Slice 9), prompt registry (US 21–23 → Slice 3), web surfacing (US 24–25 → Slice 12), invariants + tests (US 26–28 → every slice's Global Constraints), ADRs (US 29 → Slices 1/2/8 + routing in 6). Per-Stage model routing (US 15) folds into Slice 6 (per-call `model` kwarg on the chokepoint).
- **Out of scope (respected):** no post-deploy monitoring/rollback, no per-Request runner selection, no machine spec-coverage gate, no live-model eval in CI, no intra-Stage step steering, no multi-worker. None of the slices introduce these.
- **Invariants:** every slice emits new events or additive payload only; all gates run in the single worker and shell out like the pytest gate; telemetry is real-runner-only.
