"""C3 operator evidence is additive, honest, and decision-ready."""

import json
from datetime import timedelta

from helpers import approved_request
from sqlalchemy import select

from app import settings, supervision, transitions, verification
from app.db import SessionLocal
from app.events import emit
from app.kube_runner import KubeJobRunner
from app.models import Intent, ProgressEvent, Request, StageJob, utcnow


def test_verification_optional_evidence_is_additive(client):
    request = approved_request(client, title="Optional merge evidence")
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        before = verification.payload_from_metrics(
            req,
            {
                "tests_passed": 2,
                "tests_total": 2,
                "diff_added": 4,
                "diff_removed": 1,
                "files_changed": 2,
                "reviewer_verdict": "APPROVE",
            },
        )
        after = verification.payload_from_metrics(
            req,
            {
                "tests_passed": 2,
                "tests_total": 2,
                "diff_added": 4,
                "diff_removed": 1,
                "files_changed": 2,
                "reviewer_verdict": "APPROVE",
            },
            pr_url="https://github.com/acme/app/pull/7",
            diffstat=[{"file": "src/app.py", "added": 4, "removed": 1}],
            reviewer_reasoning="Tests cover the error path.",
        )

    assert set(after) - set(before) == {
        "pr_url",
        "diffstat",
        "reviewer_reasoning",
    }
    assert before == verification.payload_from_metrics(
        req,
        {
            "tests_passed": 2,
            "tests_total": 2,
            "diff_added": 4,
            "diff_removed": 1,
            "files_changed": 2,
            "reviewer_verdict": "APPROVE",
        },
    )


def test_architecture_plan_and_recorded_pr_base_feed_merge_evidence(
    client, monkeypatch, tmp_path
):
    request = approved_request(client, title="Trusted architecture evidence")
    runner = KubeJobRunner(client=None)
    sha = "a" * 40
    base_sha = "b" * 40
    ws = tmp_path / "req"
    (ws / ".git").mkdir(parents=True)
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "token-for-test")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "acme")
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path)
    monkeypatch.setattr("app.workspace.workspace_for", lambda _req: ws)
    monkeypatch.setattr("app.workspace.plan_at", lambda *_args: ("# Plan\n", "sha256:123456789abc"))
    seen = {}

    def numstat(_ws, base, head):
        seen["pair"] = (base, head)
        return [{"file": "src/app.py", "added": 3, "removed": 0}]

    monkeypatch.setattr("app.workspace.numstat_at", numstat)
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage = "review"
        db.add_all(
            [
                StageJob(
                    request_id=req.id,
                    stage="architecture",
                    attempt=1,
                    role="stage",
                    job_name="architecture-stage",
                    status="succeeded",
                    envelope={"sha": sha},
                    deadline_at=utcnow() + timedelta(minutes=5),
                ),
                StageJob(
                    request_id=req.id,
                    stage="review",
                    attempt=1,
                    role="stage",
                    job_name="review-stage",
                    status="succeeded",
                    envelope={"sha": sha, "detail": "APPROVE"},
                    logs_tail='{"type":"review","text":"Sound change."}',
                    deadline_at=utcnow() + timedelta(minutes=5),
                ),
                Intent(
                    key=f"pr:{req.ref}",
                    kind="open_pr",
                    request_id=req.id,
                    payload_json=json.dumps(
                        {"slug": "northwind", "branch": "work/req", "base_sha": base_sha}
                    ),
                    status="done",
                    outcome_json=json.dumps({"pr_number": 7}),
                ),
            ]
        )
        db.commit()

        runner._emit_architecture_plan(db, req)
        runner._finish_review(
            db,
            req,
            {
                "metrics": {
                    "tests_passed": 2,
                    "tests_total": 2,
                    "diff_added": 3,
                    "files_changed": 1,
                    "reviewer_verdict": "APPROVE",
                }
            },
            [],
            attempt=1,
        )
        plan_event = db.scalar(
            select(ProgressEvent).where(
                ProgressEvent.request_id == req.id,
                ProgressEvent.kind == "architecture_plan",
            )
        )
        db.refresh(req)
        merge_evidence = supervision.evidence(db, req)

    assert seen["pair"] == (base_sha, sha)
    assert plan_event.payload == {
        "Ref": request["ref"],
        "plan_excerpt": "# Plan\n",
        "plan_digest": "sha256:123456789abc",
        "pr_url": "https://github.com/acme/sf-app-northwind/pull/7",
    }
    assert merge_evidence["diffstat"][0]["file"] == "src/app.py"
    assert merge_evidence["reviewer_reasoning"] == "Sound change."
    assert merge_evidence["pr_url"].endswith("/pull/7")


def test_diffstat_marks_unavailable_base_instead_of_claiming_no_changes(
    client, monkeypatch, tmp_path
):
    request = approved_request(client, title="Unavailable diffstat")
    runner = KubeJobRunner(client=None)
    ws = tmp_path / "req"
    (ws / ".git").mkdir(parents=True)
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr("app.workspace.workspace_for", lambda _req: ws)
    monkeypatch.setattr("app.workspace.merge_base_at", lambda *_args: None)
    with SessionLocal() as db:
        req = db.get(Request, request["id"])

        diffstat = runner._review_diffstat(db, req, "a" * 40)

    assert diffstat == {
        "status": "unavailable",
        "reason": "PR base SHA unavailable",
    }


def test_deploy_gate_surfaces_preview_digest_and_review_link(client):
    request = approved_request(client, title="Deploy evidence")
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage = "deploy"
        req.gate = transitions.GATE_APPROVE_DEPLOY
        emit(
            db,
            req,
            "verification",
            "review",
            payload={"reviewer_verdict": "APPROVE"},
        )
        emit(
            db,
            req,
            "gate_event",
            "deploy gate",
            payload={
                "gate": transitions.GATE_APPROVE_DEPLOY,
                "sha": "a" * 40,
                "preview_digest": "sha256:" + "d" * 64,
                "preview_url": "http://northwind-preview.localtest.me",
                "pr_url": "https://github.com/acme/app/pull/7",
            },
        )
        db.commit()

        result = supervision.evidence(db, req)

    assert result["kind"] == "deploy"
    assert result["preview_digest"].startswith("sha256:")
    assert "built_digest" not in result
    assert result["review_event_id"] is not None
    assert result["pr_url"].endswith("/pull/7")
