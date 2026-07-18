"""C3 review binding, retry feedback, and operator Job evidence."""

import json
from datetime import timedelta

from fake_kube import FakeKubeClient, pass_verdict, stage_ok
from helpers import approved_request
from sqlalchemy import select

from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import ProgressEvent, StageJob, utcnow


def _runner() -> tuple[KubeJobRunner, FakeKubeClient]:
    fake = FakeKubeClient()
    return KubeJobRunner(client=fake), fake


def _tick_until(client, runner, rid: int, predicate, *, limit: int = 50):
    current = client.get(f"/api/requests/{rid}").json()
    for _ in range(limit):
        if predicate(current):
            return current
        with SessionLocal() as db:
            runner.tick(db)
        current = client.get(f"/api/requests/{rid}").json()
    raise AssertionError(f"condition not reached: {current}")


def _script_reviews(fake: FakeKubeClient, verdicts: dict[int, str], reasoning: str):
    def run(name, job):
        if job.phase != "running":
            return
        labels = job.manifest["metadata"]["labels"]
        stage = labels.get("sf/stage")
        attempt = int(labels.get("sf/attempt", "1"))
        role = labels.get("sf/role")
        if role == "gate":
            envelope = pass_verdict()
            logs = '{"type":"pytest","text":"3 passed in 0.03s"}\n'
        elif stage == "review":
            envelope = stage_ok(verdicts.get(attempt, verdicts[max(verdicts)]))
            logs = json.dumps({"type": "review", "text": reasoning}) + "\n"
        else:
            envelope = stage_ok()
            logs = '{"type":"note","text":"stage complete"}\n'
        job.phase = "succeeded"
        job.termination_message = json.dumps(envelope)
        job.logs = logs

    fake.on_observe = run


def _manifest_env(manifest: dict) -> dict[str, str]:
    return {
        item["name"]: item["value"]
        for item in manifest["spec"]["template"]["spec"]["containers"][0]["env"]
        if "value" in item
    }


def test_request_changes_retries_review_with_scrubbed_reasoning_then_approves(client):
    token = "ghp_" + "S" * 36
    runner, fake = _runner()
    _script_reviews(
        fake,
        {1: "REQUEST-CHANGES", 2: "APPROVE"},
        f"Fix the race. git remote https://x-access-token:{token}@github.com/acme/app.git",
    )
    request = approved_request(client, title="Binding review retry")

    out = _tick_until(
        client, runner, request["id"], lambda value: value["gate"] == "approve_merge"
    )

    assert out["needs_human"] is False
    merge_response = client.get(f"/api/requests/{request['id']}")
    assert token not in merge_response.text
    assert "Fix the race" in merge_response.json()["evidence"]["reviewer_reasoning"]
    # E2E-4 rework: the rejection sends the WORK back to the build stage with
    # the review as feedback (delivered to the first rework pod); the second
    # review round then judges the fixed code.
    red_two = next(
        manifest
        for manifest in fake.creations
        if manifest["metadata"]["name"] == f"sf-{out['ref'].lower()}-red-2"
    )
    feedback = _manifest_env(red_two)["SF_GATE_FEEDBACK"]
    assert "REQUESTED CHANGES" in feedback and "Fix the race" in feedback
    assert token not in feedback
    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob)
            .where(StageJob.request_id == request["id"], StageJob.stage == "review")
            .order_by(StageJob.id)
        ).all()
        assert [(row.role, row.attempt, row.status) for row in rows] == [
            ("stage", 1, "superseded"),
            ("gate", 1, "superseded"),
            ("stage", 2, "succeeded"),
            ("gate", 2, "succeeded"),
        ]
        assert rows[0].envelope["detail"] == "REQUEST-CHANGES"
        reports = db.scalars(
            select(ProgressEvent).where(
                ProgressEvent.request_id == request["id"],
                ProgressEvent.kind == "review_report",
            )
        ).all()
        assert [event.payload["verdict"] for event in reports] == [
            "REQUEST-CHANGES",
            "APPROVE",
        ]
        assert "Fix the race" in reports[0].payload["reasoning"]
        assert token not in str([event.payload for event in reports])


def test_second_request_changes_escalates_without_merge_gate(client):
    runner, fake = _runner()
    # every round rejects: two rework rounds run, then a human decides
    _script_reviews(fake, {1: "REQUEST-CHANGES"}, "Still broken")
    request = approved_request(client, title="Binding review escalation")

    out = _tick_until(
        client, runner, request["id"], lambda value: value["needs_human"], limit=120
    )

    assert out["gate"] != "approve_merge"
    with SessionLocal() as db:
        from app.models import AuditEvent

        reworks = db.scalars(
            select(AuditEvent).where(
                AuditEvent.request_id == request["id"],
                AuditEvent.action == "review_rework",
            )
        ).all()
        assert len(reworks) == 2
    assert "review still requests changes after 2 rework rounds" in out["needs_human_reason"]
    client.post(
        f"/api/requests/{request['id']}/cancel",
        json={"operator_id": 1, "note": "test cleanup"},
    )


def test_no_explicit_verdict_fails_closed(client):
    runner, fake = _runner()
    _script_reviews(fake, {1: "no explicit verdict", 2: "no explicit verdict"}, "No token")
    request = approved_request(client, title="Binding missing verdict")

    out = _tick_until(client, runner, request["id"], lambda value: value["needs_human"])

    assert out["gate"] != "approve_merge"
    assert "no explicit verdict" in out["needs_human_reason"]
    client.post(
        f"/api/requests/{request['id']}/cancel",
        json={"operator_id": 1, "note": "test cleanup"},
    )


def test_jobs_api_orders_attempts_and_scrubs_all_egress(client):
    token = "ghp_" + "J" * 36
    request = approved_request(client, title="Job evidence API")
    now = utcnow()
    with SessionLocal() as db:
        db.add_all(
            [
                StageJob(
                    request_id=request["id"],
                    stage="review",
                    attempt=1,
                    role="stage",
                    job_name="review-stage",
                    status="succeeded",
                    envelope={"detail": "REQUEST-CHANGES", "reason": f"token={token}"},
                    logs_tail=json.dumps(
                        {"type": "review", "text": f"remote Bearer {token}"}
                    ),
                    deadline_at=now + timedelta(minutes=5),
                    completed_at=now,
                ),
                StageJob(
                    request_id=request["id"],
                    stage="architecture",
                    attempt=1,
                    role="stage",
                    job_name="architecture-stage",
                    status="infra",
                    envelope={
                        "infra_class": "image_pull",
                        "infra_cause": "stage_terminal",
                        "reason": f"Authorization: Bearer {token}",
                    },
                    logs_tail=f"safe prefix SF_GITHUB_TOKEN={token}",
                    deadline_at=now + timedelta(minutes=5),
                ),
            ]
        )
        db.commit()

    response = client.get(f"/api/requests/{request['id']}/jobs")

    assert response.status_code == 200, response.text
    assert token not in response.text
    jobs = response.json()["jobs"]
    assert [job["stage"] for job in jobs] == ["architecture", "review"]
    assert jobs[0]["status"] == "infra"
    assert jobs[0]["envelope"]["infra_class"] == "image_pull"
    assert jobs[1]["review"]["verdict"] == "REQUEST-CHANGES"
    assert jobs[1]["review"]["reasoning"] == "remote Bearer ***"
    assert client.get("/api/requests/999999/jobs").status_code == 404


def test_red_retry_feedback_contains_actual_scrubbed_pytest_failure(client):
    token = "ghp_" + "P" * 36
    runner, fake = _runner()

    def run(name, job):
        if job.phase != "running":
            return
        if name.endswith("-red-1-gate"):
            envelope = {
                "outcome": "fail",
                "reason": "RED gate failed",
                "metrics": None,
            }
            logs = json.dumps(
                {
                    "type": "pytest",
                    "text": f"FAILED tests/test_export.py::test_csv\nassert csv == json\nBearer {token}",
                }
            )
        elif name.endswith("-gate"):
            envelope = pass_verdict()
            logs = ""
        else:
            envelope = stage_ok()
            logs = ""
        job.phase = "succeeded"
        job.termination_message = json.dumps(envelope)
        job.logs = logs

    fake.on_observe = run
    request = approved_request(client, title="Pytest retry evidence")
    red_two_name = f"sf-{request['ref'].lower()}-red-2"
    _tick_until(
        client,
        runner,
        request["id"],
        lambda _value: any(
            manifest["metadata"]["name"] == red_two_name
            for manifest in fake.creations
        ),
    )
    red_two = next(
        manifest
        for manifest in fake.creations
        if manifest["metadata"]["name"] == red_two_name
    )

    feedback = _manifest_env(red_two)["SF_GATE_FEEDBACK"]
    assert "FAILED tests/test_export.py::test_csv" in feedback
    assert "assert csv == json" in feedback
    assert token not in feedback
