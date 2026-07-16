import subprocess
from datetime import timedelta

import pytest
from fake_kube import FakeKubeClient
from helpers import approved_request
from sqlalchemy import select

from app import kube_client, settings, workspace, ws_exec
from app.db import SessionLocal
from app.kube_client import RealKubeClient
from app.kube_runner import GATE_INFRA_LIMIT, KubeJobRunner
from app.models import Request, StageJob, utcnow


def _timeout(*_args, **_kwargs):
    raise subprocess.TimeoutExpired(["git"], timeout=0.01)


def test_git_timeout_returns_sentinel_not_raise(monkeypatch, tmp_path):
    monkeypatch.setattr(ws_exec.subprocess, "run", _timeout)

    proc = ws_exec._git(tmp_path, "fetch", "https://example.invalid/repo.git")

    assert isinstance(proc, subprocess.CompletedProcess)
    assert proc.returncode == 124
    assert "timed out" in proc.stderr


def test_git_timeout_sentinel_has_no_token(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "ghs_SECRET")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "northwind")
    monkeypatch.setattr(ws_exec.subprocess, "run", _timeout)

    proc = ws_exec._git(
        tmp_path,
        "fetch",
        workspace._authed_url("northwind"),
        "work/req-1",
    )

    assert "ghs_SECRET" not in proc.stderr
    assert "x-access-token" not in proc.stderr
    assert "github.com" not in proc.stderr


def test_surface_hash_timeout_does_not_burn_attempt_or_fail(
    monkeypatch, client, tmp_path
):
    assert hasattr(ws_exec, "GitTimeout")
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    ws = tmp_path / "request"
    (ws / ".git").mkdir(parents=True)
    monkeypatch.setattr(workspace, "workspace_for", lambda _req: ws)
    monkeypatch.setattr(
        workspace,
        "_git",
        lambda ws, *args: subprocess.CompletedProcess(
            ["git", "-C", str(ws), *args],
            ws_exec.GIT_TIMEOUT_RC,
            "",
            f"git timed out after {settings.GIT_TIMEOUT}s (op: {args[0]})",
        ),
    )
    runner = KubeJobRunner(client=FakeKubeClient())
    request = approved_request(
        client,
        title="Surface hash timeout",
        description="Keep a passing green grade retry-neutral on git timeout.",
    )

    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        deadline = utcnow() + timedelta(seconds=60)
        db.add_all(
            [
                StageJob(
                    request_id=req.id,
                    stage="red",
                    attempt=1,
                    role="stage",
                    job_name=f"sf-{req.ref.lower()}-red-1",
                    status="succeeded",
                    envelope={"outcome": "ok", "sha": "a" * 40},
                    epoch=1,
                    deadline_at=deadline,
                ),
                StageJob(
                    request_id=req.id,
                    stage="green",
                    attempt=1,
                    role="stage",
                    job_name=f"sf-{req.ref.lower()}-green-1",
                    status="succeeded",
                    envelope={"outcome": "ok", "sha": "b" * 40},
                    epoch=1,
                    deadline_at=deadline,
                ),
            ]
        )
        db.commit()
        stage_attempt = db.scalar(
            select(StageJob).where(
                StageJob.request_id == req.id,
                StageJob.stage == "green",
                StageJob.role == "stage",
            )
        ).attempt

        for round_no in range(GATE_INFRA_LIMIT):
            gate = StageJob(
                request_id=req.id,
                stage="green",
                attempt=1,
                role="gate",
                job_name=f"sf-{req.ref.lower()}-green-1-gate",
                status="running",
                envelope={"outcome": "pass"},
                epoch=1,
                deadline_at=deadline,
            )
            db.add(gate)
            db.commit()
            assert runner._surface_check(db, req, gate) == "infra"
            runner._grade(db, req, gate, "succeeded", {"outcome": "pass"}, [])
            db.refresh(req)
            assert gate.status == "infra"
            assert (gate.envelope or {}).get("outcome") != "fail"
            assert db.scalar(
                select(StageJob).where(
                    StageJob.request_id == req.id,
                    StageJob.stage == "green",
                    StageJob.role == "stage",
                )
            ).attempt == stage_attempt
            assert req.needs_human is (round_no == GATE_INFRA_LIMIT - 1)

        assert "test-isolation" not in (req.needs_human_reason or "").lower()


def test_kube_timeout_is_infra_classified(client):
    assert hasattr(kube_client, "KubeTimeout")

    class TimingOutFake(FakeKubeClient):
        def get_job(self, name, *, capture=False, probe=False):
            raise kube_client.KubeTimeout("read_job timed out")

    fake = TimingOutFake()
    runner = KubeJobRunner(client=fake)
    request = approved_request(
        client,
        title="Kube observe timeout",
        description="A client deadline is infrastructure, not agent work.",
    )
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(
            select(StageJob).where(StageJob.request_id == request["id"])
        )
        attempt = row.attempt
    with SessionLocal() as db:
        runner.tick(db)
    assert client.get(f"/api/requests/{request['id']}").json()["needs_human"] is False
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(
            select(StageJob).where(StageJob.request_id == request["id"])
        )
        req = db.get(Request, request["id"])
        assert req.needs_human is True
        assert row.attempt == attempt


def test_kube_create_timeout_marks_infra_and_adopts_on_retry(client):
    assert hasattr(kube_client, "KubeTimeout")

    class CreateLandedThenTimedOut(FakeKubeClient):
        first = True

        def create_job(self, manifest):
            if self.first:
                self.first = False
                super().create_job(manifest)
                raise kube_client.KubeTimeout("create_job timed out")
            return None

    fake = CreateLandedThenTimedOut()
    runner = KubeJobRunner(client=fake)
    request = approved_request(
        client,
        title="Kube create timeout",
        description="Adopt a create that landed before its response timed out.",
    )
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(
            select(StageJob).where(StageJob.request_id == request["id"])
        )
        assert row.status == "infra" and row.attempt == 1
    retry = client.post(
        f"/api/requests/{request['id']}/retry",
        json={"operator_id": 1, "note": "cluster recovered"},
    )
    assert retry.status_code == 200, retry.text
    with SessionLocal() as db:
        runner.tick(db)
        rows = db.scalars(
            select(StageJob)
            .where(StageJob.request_id == request["id"])
            .order_by(StageJob.id)
        ).all()
    assert [row.attempt for row in rows] == [1, 1]
    assert rows[-1].status == "running" and rows[-1].job_uid
    assert len(fake.creations) == 1


def _real_client_with_stubs(batch):
    import urllib3

    real = RealKubeClient.__new__(RealKubeClient)
    real.ns = "default"
    real._batch = batch
    real._core = type("Core", (), {})()
    real._ApiException = RuntimeError
    real._request_timeout = (
        settings.KUBE_CONNECT_TIMEOUT,
        settings.KUBE_READ_TIMEOUT,
    )
    real._timeout_excs = (
        urllib3.exceptions.TimeoutError,
        urllib3.exceptions.MaxRetryError,
        urllib3.exceptions.ProtocolError,
        TimeoutError,
    )
    return real


def test_request_timeout_kwarg_passed():
    class Batch:
        def read_namespaced_job(self, name, namespace, **kwargs):
            self.call = (name, namespace, kwargs)
            return type(
                "Job",
                (),
                {
                    "status": type("Status", (), {"succeeded": 0, "failed": 0})(),
                    "metadata": type("Meta", (), {"uid": "uid-1"})(),
                },
            )()

    batch = Batch()
    real = _real_client_with_stubs(batch)
    view = real.get_job("job-1")

    assert view.phase == "running"
    assert real._request_timeout == (
        settings.KUBE_CONNECT_TIMEOUT,
        settings.KUBE_READ_TIMEOUT,
    )
    assert batch.call[2]["_request_timeout"] == real._request_timeout


def test_real_urllib3_timeout_maps_to_kubetimeout():
    assert hasattr(kube_client, "KubeTimeout")
    import time

    import urllib3
    from kubernetes import client as kc

    real = RealKubeClient.__new__(RealKubeClient)
    cfg = kc.Configuration(host="https://192.0.2.1:6443")
    cfg.retries = 0
    api = kc.ApiClient(cfg)
    real.ns = "default"
    real._batch = kc.BatchV1Api(api)
    real._core = kc.CoreV1Api(api)
    real._ApiException = kc.exceptions.ApiException
    real._request_timeout = (0.5, 0.5)
    real._timeout_excs = (
        urllib3.exceptions.TimeoutError,
        urllib3.exceptions.MaxRetryError,
        urllib3.exceptions.ProtocolError,
        TimeoutError,
    )
    t0 = time.monotonic()
    with pytest.raises(kube_client.KubeTimeout):
        real.get_job("does-not-matter")
    assert time.monotonic() - t0 < 5
