from datetime import timedelta

import pytest
from helpers import approved_request
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Request, StageJob, utcnow


def _job(request_id, *, stage, role, attempt, seconds, usage=None):
    finished = utcnow()
    return StageJob(
        request_id=request_id,
        stage=stage,
        role=role,
        attempt=attempt,
        job_name=f"cost-{request_id}-{stage}-{role}-{attempt}",
        status="succeeded",
        envelope={"outcome": "ok", **({"usage": usage} if usage else {})},
        created_at=finished - timedelta(seconds=seconds),
        completed_at=finished,
        deadline_at=finished + timedelta(minutes=5),
    )


def test_request_and_fleet_cost_api_aggregate_durable_job_evidence(client):
    request = approved_request(client, title="Cost accounting probe")
    with SessionLocal() as db:
        db.add_all(
            [
                _job(
                    request["id"],
                    stage="architecture",
                    role="stage",
                    attempt=1,
                    seconds=120,
                    usage={"tokens_in": 100, "tokens_out": 40},
                ),
                _job(
                    request["id"],
                    stage="red",
                    role="stage",
                    attempt=1,
                    seconds=30,
                    usage={"tokens_in": 25, "tokens_out": 10},
                ),
                _job(
                    request["id"],
                    stage="red",
                    role="gate",
                    attempt=1,
                    seconds=30,
                ),
                StageJob(
                    request_id=request["id"],
                    stage="green",
                    role="gate",
                    attempt=1,
                    job_name=f"cost-{request['id']}-green-running",
                    status="running",
                    created_at=utcnow() - timedelta(hours=1),
                    deadline_at=utcnow() + timedelta(minutes=5),
                ),
            ]
        )
        db.commit()

    response = client.get(f"/api/requests/{request['id']}/cost")
    assert response.status_code == 200
    cost = response.json()
    assert cost["request_id"] == request["id"]
    assert cost["job_count"] == 4
    assert cost["attempt_count"] == 2
    assert cost["job_minutes"] == pytest.approx(3.0)
    assert cost["usage"] == {"tokens_in": 125, "tokens_out": 50}
    assert cost["stages"]["red"]["job_minutes"] == pytest.approx(1.0)
    assert cost["queue_position"] is None

    fleet = client.get("/api/cost/fleet")
    assert fleet.status_code == 200
    payload = fleet.json()
    assert payload["request_count"] >= 1
    assert payload["job_count"] >= 4
    assert payload["attempt_count"] >= 2
    assert payload["job_minutes"] >= 3.0
    assert payload["usage"]["tokens_in"] >= 125
    assert payload["usage"]["tokens_out"] >= 50
    with SessionLocal() as db:
        running = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"],
                StageJob.status == "running",
            )
        )
        running.status = "succeeded"
        running.completed_at = running.created_at
        db.commit()


def test_request_cost_404s_for_unknown_request(client):
    assert client.get("/api/requests/999999/cost").status_code == 404


def test_attempt_budget_counts_every_agent_execution_including_infra(client):
    from app.cost import agent_attempt_count

    request = approved_request(client, title="Attempt accounting probe")
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        first = _job(req.id, stage="architecture", role="stage", attempt=1, seconds=10)
        duplicate_infra = _job(
            req.id, stage="architecture", role="stage", attempt=1, seconds=10
        )
        duplicate_infra.status = "infra"
        gate = _job(req.id, stage="architecture", role="gate", attempt=1, seconds=5)
        second = _job(req.id, stage="red", role="stage", attempt=1, seconds=10)
        db.add_all([first, duplicate_infra, gate, second])
        db.commit()

        assert agent_attempt_count(db, req.id) == 3
