"""Single source of truth for the merge-gate `verification` event (ADR 0014).

Both pipelines emit the same event through this module:

* the SIMULATOR (no workspace) fires fabricated numbers matching its review
  script, and
* the REAL runner DERIVES the payload from the ACTUAL workspace — pytest
  counts, the work-branch diff, the reviewer verdict — read through the shared
  ws_exec git/pytest wrappers (evidence derivation, not a gate).

The event kind, title, stage, the 8-key payload SHAPE (its key set, the shared
`assumptions` derivation and `"Ref"`), and the emit itself all live here so the
contract with supervision.evidence() cannot drift by hand. This module must NOT
import agent_runner or simulator (they import it); it depends only on events
and models, neither of which imports back.
"""
import re
from pathlib import Path

from sqlalchemy.orm import Session

from .events import emit
from .models import Request
from .ws_exec import _git, _pytest

# the verification event's contract — owned here so both emitters agree
KIND = "verification"
TITLE = "Verification report — ready for the merge gate"
STAGE = "review"

# the simulator's fabricated numbers — match the text its review script reports
SIM_METRICS = {
    "tests_passed": 8,
    "tests_total": 8,
    "diff_added": 412,
    "diff_removed": 38,
    "files_changed": 9,
    "reviewer_verdict": "no blocking findings",
}

# pytest summary fragments: "2 passed", "1 failed", "3 errors" — rstrip("s")
# below folds "errors" → "error" so plural and singular share one key
_COUNT = re.compile(r"(\d+) (passed|failed|errors?)")
# git --shortstat: " 3 files changed, 7 insertions(+), 2 deletions(-)"
_SHORTSTAT = re.compile(
    r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?"
)


def _pytest_counts(ws: Path) -> tuple[int, int]:
    """(passed, total) from the canonical pytest gate (ws_exec._pytest). total
    counts passed + failed + errors; (0, 0) if the suite could not run — the
    timeout / missing-pytest paths return non-summary output that parses to zero."""
    counts = {kind.rstrip("s"): int(n) for n, kind in _COUNT.findall(_pytest(ws).stdout or "")}
    passed = counts.get("passed", 0)
    total = passed + counts.get("failed", 0) + counts.get("error", 0)
    return passed, total


def _diff_stat(ws: Path) -> tuple[int, int, int]:
    """(files_changed, added, removed) for the work branch vs main.
    (0, 0, 0) if the diff yielded nothing parseable."""
    m = _SHORTSTAT.search(_git(ws, "diff", "main...HEAD", "--shortstat").stdout)
    if not m:
        return 0, 0, 0
    return int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0)


def _verdict(ws: Path) -> str:
    review = ws / "REVIEW.md"
    if not review.exists():
        return "no review"
    lines = review.read_text().strip().splitlines()
    return lines[0][:120] if lines else "no review"


def _payload(
    req: Request,
    *,
    tests_passed: int,
    tests_total: int,
    diff_added: int,
    diff_removed: int,
    files_changed: int,
    reviewer_verdict: str,
) -> dict:
    """The one place the 8-key payload SHAPE is built. Both the fabricated
    (simulator) and derived (runner) paths pass their six metrics through here,
    so the key set, the `assumptions` derivation, and `"Ref"` cannot drift."""
    return {
        "tests_passed": tests_passed,
        "tests_total": tests_total,
        "diff_added": diff_added,
        "diff_removed": diff_removed,
        "files_changed": files_changed,
        "reviewer_verdict": reviewer_verdict,
        "assumptions": [ln.text for ln in req.spec_lines if ln.assume],
        "Ref": req.ref,
    }


def build_payload(ws: Path, req: Request) -> dict:
    """The real runner's DERIVED payload — metrics read from the workspace."""
    passed, total = _pytest_counts(ws)
    files, added, removed = _diff_stat(ws)
    return _payload(
        req,
        tests_passed=passed,
        tests_total=total,
        diff_added=added,
        diff_removed=removed,
        files_changed=files,
        reviewer_verdict=_verdict(ws),
    )


def emit_verification(
    db: Session,
    req: Request,
    ws: Path | None = None,
    *,
    payload: dict | None = None,
) -> dict:
    """Emit the single verification event for either pipeline and return the
    payload it wrote.

    Resolution order for the payload:
    * an explicit ``payload`` (the runner passes the dict it already built and
      ran its escalation guard against, so the guard and the emit never diverge),
    * else ``ws`` set → the DERIVED payload via ``build_payload(ws, req)``,
    * else (``ws is None``) → the simulator's fabricated ``SIM_METRICS``.
    """
    if payload is None:
        payload = (
            build_payload(ws, req)
            if ws is not None
            else _payload(req, **SIM_METRICS)
        )
    emit(db, req, KIND, TITLE, stage=STAGE, payload=payload)
    return payload
