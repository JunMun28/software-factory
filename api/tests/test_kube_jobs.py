"""Kube building blocks: settings, StageJob rows, names, manifests, envelopes."""

import uuid
from datetime import timezone

from app import settings
from app.db import SessionLocal, migrate
from app.models import Request, StageJob, job_name, utcnow


def test_kube_settings_defaults():
    assert settings.KUBE_NAMESPACE == "software-factory"
    assert settings.AGENT_IMAGE == "sf-agent:dev"
    assert settings.STAGE_WALL_CLOCK > settings.JOB_ACTIVE_DEADLINE
    assert settings.GATE_WALL_CLOCK > settings.GATE_ACTIVE_DEADLINE
    assert settings.KUBE_MAX_ATTEMPTS == 2
    assert settings.KUBE_JOB_CAP == 10


def test_stage_job_row_roundtrip():
    migrate()
    with SessionLocal() as db:
        generated_name = job_name("REQ-9001", "red", 1)
        assert generated_name == "sf-req-9001-red-1"
        assert job_name("REQ-9001", "red", 1) == generated_name
        assert job_name("REQ-9001", "red", 1, gate=True) == f"{generated_name}-gate"
        request = Request(
            ref=f"REQ-{uuid.uuid4().hex[:8]}",
            title="Stage Job round trip",
            description="Exercise the durable Kubernetes Job row.",
            type="enh",
        )
        db.add(request)
        db.flush()
        row = StageJob(
            request_id=request.id,
            stage="red",
            attempt=1,
            role="stage",
            job_name=generated_name,
            epoch=3,
            deadline_at=utcnow(),
        )
        db.add(row)
        db.commit()
        got = db.get(StageJob, row.id)
        assert got.status == "running" and got.envelope is None
        assert got.deadline_at.tzinfo is timezone.utc
