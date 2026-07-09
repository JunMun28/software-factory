# Verification Event (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live `ClaudeRunner` emit a real `verification` progress event at the review stage, derived from the actual workspace, so the human merge-gate evidence strip shows true test counts / diff size / reviewer verdict instead of "no evidence recorded".

**Architecture:** A new pure-ish deep module `verification` derives the merge-gate evidence payload (pytest counts, branch-vs-main diff stat, reviewer verdict, spec assumptions) from a finished workspace. The runner's `_review` stage calls it and appends a `verification` event via the existing `emit` helper. No schema change and no web change: `supervision.evidence()` already reads the latest `verification` event's payload for `approve_merge` gates, and the simulator already emits the same payload shape — this slice makes the *real* runner conform (ADR 0014 already mandates it).

**Tech Stack:** Python 3, FastAPI, SQLAlchemy, SQLite, pytest, `uv`. Tests run from `api/` with `uv run pytest`. Agent stages are driven through an injectable executor (`ClaudeRunner(executor=...)`), so these tests prove factory behavior without any model call.

---

## Invariants this slice must honor

- **Append-only log (ADR 0008):** the verification event is a new `INSERT` via `emit(...)`. Never `UPDATE`/`DELETE` `progress_event`.
- **Single worker:** no new process or thread; the builder shells out to `git`/`pytest` synchronously, like the existing `_pytest`/`_git` helpers.
- **Payload shape is a contract:** `supervision.evidence()` (api/app/supervision.py:83-97) reads exactly these keys for `approve_merge`: `tests_passed`, `tests_total`, `diff_added`, `diff_removed`, `files_changed`, `reviewer_verdict`, `assumptions`. The builder MUST emit those keys (plus `Ref`), matching the simulator's `emit_verification` (api/app/simulator.py:42-51).

## File Structure

- **Create:** `api/app/verification.py` — one responsibility: derive the merge-gate evidence payload from a finished workspace. Self-contained (its own thin `git`/`pytest` calls) so it is unit-testable in isolation. Distinct from the gate logic in `claude_runner` (this is *evidence derivation*, not a pass/fail gate), which is why it does not import `claude_runner` (also avoids a circular import).
- **Modify:** `api/app/claude_runner.py` — the `_review` method (currently api/app/claude_runner.py:299-325) emits the `verification` event before raising the merge gate.
- **Test (create):** `api/tests/test_verification.py` — unit tests for the builder against a fixture git workspace.
- **Test (modify):** `api/tests/test_claude_runner.py` — one integration test asserting `supervision.evidence()` is populated after the real pipeline reaches the merge gate.

---

### Task 1: `verification` builder module

**Files:**
- Create: `api/app/verification.py`
- Test: `api/tests/test_verification.py`

- [ ] **Step 1: Write the failing unit test**

Create `api/tests/test_verification.py`:

```python
"""verification.build_payload — derives the merge-gate evidence from a real
workspace. Builds a throwaway git repo + runs pytest in it (deterministic,
offline), so it proves the payload shape supervision.evidence() depends on."""
import subprocess
from pathlib import Path

from app import verification
from app.models import Request, SpecLine


def _git(ws: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(ws), *args], capture_output=True, text=True, check=True)


def _make_green_ws(tmp_path: Path) -> Path:
    """A workspace whose work branch is green and diverges from main by 3 files."""
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "tests").mkdir()
    _git(ws, "init", "-b", "main")
    _git(ws, "config", "user.email", "t@t")
    _git(ws, "config", "user.name", "t")
    # baseline on main: an empty conftest makes ws importable, plus one passing test
    (ws / "conftest.py").write_text("")
    (ws / "tests" / "test_base.py").write_text("def test_base():\n    assert True\n")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", "baseline")
    # work branch: the feature + its test + the review report (3 new files)
    _git(ws, "checkout", "-q", "-b", "work/req-9001")
    (ws / "expenses.py").write_text("def monthly_export():\n    return 'csv'\n")
    (ws / "tests" / "test_feature.py").write_text(
        "import expenses\n\n"
        "def test_monthly_export_is_csv():\n"
        "    assert expenses.monthly_export() == 'csv'\n"
    )
    (ws / "REVIEW.md").write_text("APPROVE\nImplements the spec; tests are meaningful.\n")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", "feature")
    return ws


def test_build_payload_from_green_workspace(tmp_path):
    ws = _make_green_ws(tmp_path)
    req = Request(ref="REQ-9001")
    req.spec_lines = [
        SpecLine(text="Exports run as CSV.", prov="interview", assume=False),
        SpecLine(text="Runs against the Concur connector.", assume=True),
    ]

    payload = verification.build_payload(ws, req)

    assert payload["tests_passed"] == 2 and payload["tests_total"] == 2
    assert payload["files_changed"] == 3
    assert payload["diff_added"] > 0 and payload["diff_removed"] == 0
    assert payload["reviewer_verdict"] == "APPROVE"
    assert payload["assumptions"] == ["Runs against the Concur connector."]
    assert payload["Ref"] == "REQ-9001"


def test_build_payload_missing_review_is_marked(tmp_path):
    ws = _make_green_ws(tmp_path)
    (ws / "REVIEW.md").unlink()
    req = Request(ref="REQ-9002")
    req.spec_lines = []

    payload = verification.build_payload(ws, req)

    assert payload["reviewer_verdict"] == "no review"
    assert payload["assumptions"] == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && uv run pytest tests/test_verification.py -v`
Expected: FAIL at collection — `ModuleNotFoundError: No module named 'app.verification'`.

- [ ] **Step 3: Write the minimal implementation**

Create `api/app/verification.py`:

```python
"""Derives the merge-gate evidence payload from a finished workspace (ADR 0014).

The real runner's review stage emits a `verification` event whose payload feeds
supervision.evidence(); this module computes that payload from the ACTUAL
workspace (pytest counts, the work-branch diff, the reviewer verdict) rather
than the hardcoded numbers the simulator uses. It is read-only over the
workspace (its own thin git/pytest calls — evidence derivation, not a gate) and
writes nothing to the DB.

Payload keys are a contract with supervision.evidence() and must match the
simulator's emit_verification: tests_passed, tests_total, diff_added,
diff_removed, files_changed, reviewer_verdict, assumptions, Ref.
"""
import re
import subprocess
import sys
from pathlib import Path

from .models import Request

# pytest summary fragments: "2 passed", "1 failed", "3 errors"
_COUNT = re.compile(r"(\d+) (passed|failed|error|errors)")
# git --shortstat: " 3 files changed, 7 insertions(+), 2 deletions(-)"
_SHORTSTAT = re.compile(
    r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?"
)


def _pytest_counts(ws: Path) -> tuple[int, int]:
    """(passed, total) from a pytest run in the API's own venv. total counts
    passed + failed + errors; (0, 0) if the suite could not run."""
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "--no-header"],
            cwd=ws, capture_output=True, text=True, timeout=120,
        )
    except (subprocess.TimeoutExpired, OSError):
        return 0, 0
    counts = {kind.rstrip("s"): int(n) for n, kind in _COUNT.findall(proc.stdout or "")}
    passed = counts.get("passed", 0)
    total = passed + counts.get("failed", 0) + counts.get("error", 0)
    return passed, total


def _diff_stat(ws: Path) -> tuple[int, int, int]:
    """(files_changed, added, removed) for the work branch vs main."""
    out = subprocess.run(
        ["git", "-C", str(ws), "diff", "main...HEAD", "--shortstat"],
        capture_output=True, text=True,
    ).stdout
    m = _SHORTSTAT.search(out)
    if not m:
        return 0, 0, 0
    return int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0)


def _verdict(ws: Path) -> str:
    review = ws / "REVIEW.md"
    if not review.exists():
        return "no review"
    lines = review.read_text().strip().splitlines()
    return lines[0][:120] if lines else "no review"


def build_payload(ws: Path, req: Request) -> dict:
    passed, total = _pytest_counts(ws)
    files, added, removed = _diff_stat(ws)
    return {
        "tests_passed": passed,
        "tests_total": total,
        "diff_added": added,
        "diff_removed": removed,
        "files_changed": files,
        "reviewer_verdict": _verdict(ws),
        "assumptions": [ln.text for ln in req.spec_lines if ln.assume],
        "Ref": req.ref,
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && uv run pytest tests/test_verification.py -v`
Expected: PASS — `test_build_payload_from_green_workspace` and `test_build_payload_missing_review_is_marked` both green.

- [ ] **Step 5: Commit**

```bash
git add api/app/verification.py api/tests/test_verification.py
git commit -m "feat(api): verification payload builder for merge-gate evidence"
```

---

### Task 2: Emit the `verification` event from the review stage

**Files:**
- Modify: `api/app/claude_runner.py` (import at top; `_review` method, api/app/claude_runner.py:299-325)
- Test: `api/tests/test_claude_runner.py`

- [ ] **Step 1: Write the failing integration test**

Append to `api/tests/test_claude_runner.py` (the fixtures `client`, `ws_root`, the `honest_executor`, `_approved_request`, and the `SessionLocal`/`Request` imports already exist in this file):

```python
def test_review_emits_verification_for_merge_evidence(client, ws_root):
    from app import supervision

    d = _approved_request(client, "Verification evidence")
    ClaudeRunner(executor=honest_executor).run_pipeline(d["id"])

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["gate"] == "approve_merge" and not out["needs_human"]

    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        ev = supervision.evidence(db, req)

    assert ev is not None and ev["kind"] == "merge"
    assert ev["tests_passed"] == ev["tests_total"] and ev["tests_total"] >= 1
    assert ev["diff_added"] > 0 and ev["files_changed"] >= 1
    assert "APPROVE" in (ev["reviewer_verdict"] or "")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && uv run pytest tests/test_claude_runner.py::test_review_emits_verification_for_merge_evidence -v`
Expected: FAIL at `assert ev is not None` — under the real runner no `verification` event exists yet, so `supervision.evidence()` returns `None`.

- [ ] **Step 3: Add the import to `claude_runner.py`**

In `api/app/claude_runner.py`, add to the existing imports (next to `from .events import emit`):

```python
from .verification import build_payload
```

- [ ] **Step 4: Emit the event in `_review`**

In `api/app/claude_runner.py`, the tail of `_review` currently reads:

```python
        emit(db, req, "milestone_summary", f"Review report committed — {verdict}",
             payload={"fields": {"Artifacts": "REVIEW.md", "Agent": "Claude Code"}, "Ref": req.ref})
        lifecycle.raise_merge_gate(db, req)
        db.commit()
        log.info("%s: review committed, merge gate raised", req.ref)
        return True
```

Replace it with (insert the verification emit + guard between the milestone and the gate):

```python
        emit(db, req, "milestone_summary", f"Review report committed — {verdict}",
             payload={"fields": {"Artifacts": "REVIEW.md", "Agent": "Claude Code"}, "Ref": req.ref})
        vpayload = build_payload(ws, req)
        if vpayload["tests_total"] == 0:
            # the suite proved green at the GREEN gate; if it cannot run now, the
            # evidence would be a lie — escalate rather than raise a blind gate
            self._escalate(db, req, "Verification could not be built — the suite did not run at review")
            return False
        emit(db, req, "verification", "Verification report — ready for the merge gate",
             stage="review", payload=vpayload)
        lifecycle.raise_merge_gate(db, req)
        db.commit()
        log.info("%s: review committed, verification emitted, merge gate raised", req.ref)
        return True
```

- [ ] **Step 5: Run the new test, then the whole runner + supervision suite**

Run: `cd api && uv run pytest tests/test_claude_runner.py::test_review_emits_verification_for_merge_evidence -v`
Expected: PASS.

Run (no regressions): `cd api && uv run pytest tests/test_claude_runner.py tests/test_verification.py -q`
Expected: PASS — all runner tests (full pipeline, isolation gate, RED gate, retry resume, pytest-cannot-run) and the verification unit tests stay green.

- [ ] **Step 6: Commit**

```bash
git add api/app/claude_runner.py api/tests/test_claude_runner.py
git commit -m "feat(api): real runner emits verification event at the review stage"
```

---

## Coverage check (self-review)

- **Slice A goal — real verification event feeds the merge-gate evidence strip:** Task 2 (emit in `_review`) + the integration test asserting `supervision.evidence()` is populated. ✓
- **Deep, isolated, tested module:** Task 1 (`verification.build_payload` + unit tests). ✓
- **Payload-shape contract with `supervision.evidence()` / simulator parity:** the builder returns exactly `tests_passed`, `tests_total`, `diff_added`, `diff_removed`, `files_changed`, `reviewer_verdict`, `assumptions`, `Ref`. ✓
- **Append-only / single-worker invariants:** event added via `emit` (INSERT); builder is synchronous shell-outs, no new process. ✓
- **No web change required:** `supervision.evidence()` already renders the payload; confirmed by asserting through it. ✓
- **Not in this slice (later DRE-6 slices):** categorized findings (Slice I), edge-case ledger (Slice J), latency/cost (Slice C) — the builder returns the base payload only; richer fields are additive later.

## Notes

- `build_payload` re-runs pytest at review time. The suite is already green from the GREEN gate, so this is a fast, honest re-confirmation; if a future change makes review heavier, consider stashing the GREEN counts on the green milestone payload instead of re-running.
- `verification.py` deliberately duplicates thin `git`/`pytest` invocations rather than importing `claude_runner._pytest`/`_git` (which would be circular). If a later slice extracts those into a shared `workspace` helper, route this module through it then.
- Source spec: Linear DRE-6 ("Harden the Factory's trust & control surfaces"), Slice A; analysis in `docs/reviews/2026-06-16-new-sdlc-applicability.md`.
