"""C4 acceptance-criteria contract — deterministic, immutable, structural-only."""

import importlib.util
import json

from sqlalchemy import func, select

from app import acceptance, models, settings, supervision, verification, workspace
from app.db import SessionLocal
from app.models import AcceptanceCriterion, ProgressEvent, SpecLine, SpecSnapshot
from app.schemas import EvidenceOut
from app.ws_exec import _git
from tests.helpers import submitted_request


def test_acceptance_tables_are_part_of_the_backend_model():
    assert hasattr(models, "AcceptanceCriterion")
    assert hasattr(models, "SpecSnapshot")
    assert models.AcceptanceCriterion.__table__.name == "acceptance_criteria"
    assert models.SpecSnapshot.__table__.name == "spec_snapshots"
    relationship = models.Request.acceptance_criteria.property
    assert "delete-orphan" not in relationship.cascade


def test_acceptance_contract_module_exists():
    assert importlib.util.find_spec("app.acceptance") is not None


def _commit_all(repo, message):
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def _approve(client, title):
    request = submitted_request(client, title=title)
    response = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_scripted_approve_derives_numbered_rows_and_immutable_snapshot(client):
    assert client.get("/api/health").json()["brain"] == "scripted"
    request = _approve(client, "Scripted acceptance derivation")

    with SessionLocal() as db:
        req = db.get(models.Request, request["id"])
        criteria = acceptance.active(db, req)
        snapshot = db.scalar(
            select(SpecSnapshot).where(SpecSnapshot.request_id == req.id)
        )
        event = db.scalar(
            select(ProgressEvent).where(
                ProgressEvent.request_id == req.id,
                ProgressEvent.kind == "spec_snapshot",
            )
        )
        assert len(criteria) == len(req.spec_lines) > 0
        assert [item.code for item in criteria] == [
            f"AC-{index}" for index in range(1, len(criteria) + 1)
        ]
        assert [(item.prov, item.assume) for item in criteria] == [
            (line.prov, line.assume) for line in req.spec_lines
        ]
        assert snapshot is not None and len(snapshot.content_hash) == 64
        assert snapshot.criteria_json == [
            {
                "code": item.code,
                "text": item.text,
                "prov": item.prov,
                "assume": item.assume,
            }
            for item in criteria
        ]
        assert event is not None


def test_changed_round_keeps_codes_retains_rows_and_replay_is_noop(client):
    request = _approve(client, "Stable acceptance identifiers")
    with SessionLocal() as db:
        req = db.get(models.Request, request["id"])
        first = acceptance.active(db, req)
        original = {_item.text: _item.code for _item in first}
        for index, line in enumerate(reversed(req.spec_lines)):
            line.order = index
        req.spec_lines.append(
            SpecLine(
                order=len(req.spec_lines),
                text="The preview correction is preserved.",
                prov="preview 1",
                assume=False,
            )
        )
        version = acceptance.derive_and_snapshot(db, req)
        db.commit()
        assert version == 1

        current = acceptance.active(db, req)
        current_by_text = {item.text: item.code for item in current}
        assert all(current_by_text[text] == code for text, code in original.items())
        assert current_by_text["The preview correction is preserved."] == (
            f"AC-{max(item.ordinal for item in first) + 1}"
        )
        assert db.scalar(
            select(func.count(AcceptanceCriterion.id)).where(
                AcceptanceCriterion.request_id == req.id
            )
        ) == len(first) + len(current)

        snapshots_before = db.scalar(
            select(func.count(SpecSnapshot.id)).where(SpecSnapshot.request_id == req.id)
        )
        events_before = db.scalar(
            select(func.count(ProgressEvent.id)).where(
                ProgressEvent.request_id == req.id,
                ProgressEvent.kind == "spec_snapshot",
            )
        )
        assert acceptance.derive_and_snapshot(db, req) == version
        db.commit()
        assert db.scalar(
            select(func.count(SpecSnapshot.id)).where(SpecSnapshot.request_id == req.id)
        ) == snapshots_before
        assert db.scalar(
            select(func.count(ProgressEvent.id)).where(
                ProgressEvent.request_id == req.id,
                ProgressEvent.kind == "spec_snapshot",
            )
        ) == events_before


def test_duplicate_text_matches_prior_codes_one_for_one(client):
    request = _approve(client, "Duplicate acceptance text")
    with SessionLocal() as db:
        req = db.get(models.Request, request["id"])
        first = acceptance.active(db, req)
        duplicate_text = first[0].text
        req.spec_lines.append(
            SpecLine(
                order=len(req.spec_lines),
                text=duplicate_text,
                prov="preview 1",
            )
        )
        acceptance.derive_and_snapshot(db, req)
        db.commit()
        duplicated = [
            item for item in acceptance.active(db, req) if item.text == duplicate_text
        ]
        assert len(duplicated) == 2
        assert len({item.code for item in duplicated}) == 2
        assert first[0].code in {item.code for item in duplicated}


def test_stage_refresh_commits_current_snapshot_and_acceptance_bytes(
    client, tmp_path, monkeypatch
):
    request = _approve(client, "Snapshot blob fidelity")
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "workspaces")
    with SessionLocal() as db:
        req = db.get(models.Request, request["id"])
        first_snapshot = db.scalar(
            select(SpecSnapshot).where(SpecSnapshot.request_id == req.id)
        )
        repo = workspace.ensure_repo(req, first_snapshot.spec_md)
        req.spec_lines.append(
            SpecLine(
                order=len(req.spec_lines),
                text="A changed preview contract is visible to RED.",
                prov="preview 1",
            )
        )
        acceptance.derive_and_snapshot(db, req)
        db.commit()
        latest = db.scalar(
            select(SpecSnapshot)
            .where(SpecSnapshot.request_id == req.id)
            .order_by(SpecSnapshot.version.desc())
        )
        workspace.refresh_contract(repo, req)
        head = workspace.head_sha(repo)
        assert _git(repo, "show", f"{head}:SPEC.md").stdout == latest.spec_md
        assert _git(repo, "show", f"{head}:ACCEPTANCE.md").stdout == workspace.acceptance_md(req)


def test_structural_coverage_handles_classes_and_rejects_global_fan_in(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "factory@test")
    _git(repo, "config", "user.name", "Factory Test")
    (repo / "tests").mkdir()
    (repo / "tests" / "test_contract.py").write_text(
        "class TestContract:\n"
        "    def test_shared(self):\n"
        "        assert True\n\n"
        "    def test_second(self):\n"
        "        assert True\n"
    )
    manifest = {
        "AC-1": ["tests/test_contract.py::TestContract::test_shared"],
        "AC-2": ["tests/test_contract.py::TestContract::test_shared"],
    }
    (repo / "tests" / "acceptance.json").write_text(json.dumps(manifest))
    shared_sha = _commit_all(repo, "shared node")

    shared = workspace.acceptance_coverage_at(repo, shared_sha, ["AC-1", "AC-2"])
    assert shared == {
        "total_count": 2,
        "covered_count": 0,
        "coverage": 0.0,
        "distinct_covering_nodes": 0,
        "max_fanin": 2,
        "per_ac": {"AC-1": False, "AC-2": False},
    }

    manifest["AC-2"] = ["tests/test_contract.py::TestContract::test_second[param]"]
    (repo / "tests" / "acceptance.json").write_text(json.dumps(manifest))
    distinct_sha = _commit_all(repo, "distinct class nodes")
    distinct = workspace.acceptance_coverage_at(
        repo, distinct_sha, ["AC-1", "AC-2"]
    )
    assert distinct["covered_count"] == 2
    assert distinct["distinct_covering_nodes"] == 2
    assert distinct["max_fanin"] == 1
    assert distinct["coverage"] == 1.0


def test_structural_coverage_rejects_missing_nodes_and_absent_manifest(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "factory@test")
    _git(repo, "config", "user.name", "Factory Test")
    (repo / "README.md").write_text("baseline\n")
    no_manifest = _commit_all(repo, "baseline")
    assert workspace.acceptance_coverage_at(repo, no_manifest, ["AC-1"]) is None
    (repo / "tests").mkdir()
    (repo / "tests" / "test_real.py").write_text("def test_real():\n    assert True\n")
    (repo / "tests" / "acceptance.json").write_text(
        json.dumps(
            {
                "AC-1": ["tests/test_real.py::test_missing"],
                "AC-2": ["tests/test_real.py::MissingClass::test_real"],
            }
        )
    )
    missing = _commit_all(repo, "lying manifest")
    coverage = workspace.acceptance_coverage_at(repo, missing, ["AC-1", "AC-2"])
    assert coverage["covered_count"] == 0


def test_acceptance_endpoint_returns_active_contract(client):
    request = _approve(client, "Acceptance API")
    response = client.get(f"/api/requests/{request['id']}/acceptance")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == 0
    assert len(body["content_hash"]) == 64
    assert body["criteria"] and body["criteria"][0]["code"] == "AC-1"


def test_acceptance_endpoint_never_pairs_new_contract_with_old_coverage(client):
    request = _approve(client, "Versioned acceptance API")
    with SessionLocal() as db:
        req = db.get(models.Request, request["id"])
        db.add(
            ProgressEvent(
                request_id=req.id,
                kind="acceptance_coverage",
                stage="build",
                title="v0 coverage",
                payload={"version": 0, "covered_count": 1},
            )
        )
        req.spec_lines.append(
            SpecLine(
                order=len(req.spec_lines),
                text="A second version changes the contract.",
                prov="preview 1",
            )
        )
        acceptance.derive_and_snapshot(db, req)
        db.commit()
    body = client.get(f"/api/requests/{request['id']}/acceptance").json()
    assert body["version"] == 1
    assert body["coverage"] is None


def test_kill_switch_preserves_pre_c4_approve_flow(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "ACCEPTANCE", False)
    request = _approve(client, "Acceptance disabled")
    assert request["status"] == "approved"
    assert request["stage"] == "architecture"
    assert request["gate"] is None
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "workspaces")
    with SessionLocal() as db:
        req = db.get(models.Request, request["id"])
        assert not acceptance.active(db, req)
        assert db.scalar(
            select(SpecSnapshot).where(SpecSnapshot.request_id == req.id)
        ) is None
        assert db.scalar(
            select(ProgressEvent).where(
                ProgressEvent.request_id == req.id,
                ProgressEvent.kind.in_(("spec_snapshot", "acceptance_coverage")),
            )
        ) is None
        repo = workspace.ensure_repo(req, workspace.spec_md(req))
        original_head = workspace.head_sha(repo)
        original_spec = (repo / "SPEC.md").read_text()
        req.spec_lines.append(
            SpecLine(
                order=len(req.spec_lines),
                text="Disabled acceptance must not refresh the contract.",
                prov="preview 1",
            )
        )
        workspace.refresh_contract(repo, req)
        assert not (repo / "ACCEPTANCE.md").exists()
        assert workspace.head_sha(repo) == original_head
        assert (repo / "SPEC.md").read_text() == original_spec
        assert _git(repo, "status", "--porcelain").stdout == ""


def test_kill_switch_preserves_pre_c4_merge_evidence_shape(client, monkeypatch):
    monkeypatch.setattr(settings, "ACCEPTANCE", False)
    request = _approve(client, "Acceptance evidence disabled")
    for _ in range(16):
        client.post("/api/simulator/tick")
    with SessionLocal() as db:
        req = db.get(models.Request, request["id"])
        evidence = supervision.evidence(db, req)
        assert set(evidence) == {
            "kind",
            "tests_passed",
            "tests_total",
            "diff_added",
            "diff_removed",
            "files_changed",
            "reviewer_verdict",
            "assumptions",
        }


def test_merge_evidence_surfaces_structural_counts(client):
    request = _approve(client, "Acceptance evidence")
    with SessionLocal() as db:
        req = db.get(models.Request, request["id"])
        req.stage = "review"
        req.gate = "approve_merge"
        payload = verification.payload_from_metrics(
            req,
            {
                "tests_passed": 3,
                "tests_total": 3,
                "files_changed": 2,
                "reviewer_verdict": "APPROVE",
            },
        )
        payload.update(
            {
                "ac_total": 2,
                "ac_covered": 1,
                "ac_coverage": 0.5,
                "total_count": 2,
                "covered_count": 1,
                "distinct_covering_nodes": 1,
                "max_fanin": 1,
            }
        )
        verification.emit_verification(db, req, payload=payload)
        db.commit()
        evidence = supervision.evidence(db, req)
        assert evidence["covered_count"] == 1
        assert evidence["total_count"] == 2
        assert evidence["distinct_covering_nodes"] == 1
        assert evidence["max_fanin"] == 1
        assert EvidenceOut(**evidence).model_dump()["ac_coverage"] == 0.5


def test_verification_payload_is_pre_c4_shape_when_no_coverage_is_supplied():
    req = models.Request(ref="REQ-9901")
    req.spec_lines = []
    payload = verification.payload_from_metrics(
        req,
        {
            "tests_passed": 1,
            "tests_total": 1,
            "diff_added": 1,
            "diff_removed": 0,
            "files_changed": 1,
            "reviewer_verdict": "APPROVE",
        },
    )
    assert set(payload) == {
        "tests_passed",
        "tests_total",
        "diff_added",
        "diff_removed",
        "files_changed",
        "reviewer_verdict",
        "assumptions",
        "Ref",
    }


def test_red_prompt_requires_acceptance_manifest():
    prompt = (settings.REPO_DIR / "docker/sf-agent/prompts/red.md").read_text()
    assert "If ACCEPTANCE.md exists" in prompt
    assert "tests/acceptance.json" in prompt
    assert "pytest node ids" in prompt
