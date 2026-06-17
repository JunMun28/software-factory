"""Derives the merge-gate evidence payload from a finished workspace (ADR 0014).

The real runner's review stage emits a `verification` event whose payload feeds
supervision.evidence(); this module computes that payload from the ACTUAL
workspace (pytest counts, the work-branch diff, the reviewer verdict) rather
than the hardcoded numbers the simulator uses. It reads the workspace through
the shared ws_exec git/pytest wrappers (evidence derivation, not a gate) and
writes nothing to the DB.

Payload keys are a contract with supervision.evidence() and must match the
simulator's emit_verification: tests_passed, tests_total, diff_added,
diff_removed, files_changed, reviewer_verdict, assumptions, Ref.
"""
import re
from pathlib import Path

from .models import Request
from .ws_exec import _git, _pytest

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
