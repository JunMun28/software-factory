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
