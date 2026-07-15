"""Kube building blocks: settings, StageJob rows, names, manifests, envelopes."""

import subprocess
import sys
import uuid
from datetime import timezone

import pytest

from app import settings
from app.db import SessionLocal, migrate
from app.kube_jobs import (
    KUBE_STAGES,
    REQUEST_STAGE,
    gate_job_manifest,
    job_name,
    ndjson_events,
    parse_envelope,
    stage_job_manifest,
)
from app.models import Request, StageJob, utcnow


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


def test_job_name_is_deterministic_and_validated():
    assert KUBE_STAGES == ("architecture", "red", "green", "review")
    assert REQUEST_STAGE == {
        "architecture": "architecture",
        "red": "build",
        "green": "build",
        "review": "review",
    }
    assert job_name("REQ-2045", "red", 1) == "sf-req-2045-red-1"
    assert job_name("REQ-2045", "red", 2, gate=True) == "sf-req-2045-red-2-gate"
    with pytest.raises(ValueError):
        job_name("nope; rm -rf", "red", 1)
    with pytest.raises(ValueError):
        job_name("REQ-2045", "deploy", 1)


def test_kube_client_import_does_not_load_kubernetes():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import app.kube_client; assert 'kubernetes' not in sys.modules",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_stage_manifest_carries_the_spec_hard_lines():
    m = stage_job_manifest("REQ-2045", "green", 2, feedback="RED gate said: tests passed")
    assert m["metadata"]["name"] == "sf-req-2045-green-2"
    labels = m["metadata"]["labels"]
    assert labels["sf/tier"] == "agent" and labels["sf/role"] == "stage"
    assert labels["sf/request"] == "req-2045" and labels["sf/stage"] == "green"
    spec = m["spec"]
    assert spec["backoffLimit"] == 0
    assert spec["activeDeadlineSeconds"] == settings.JOB_ACTIVE_DEADLINE
    rule = spec["podFailurePolicy"]["rules"][0]
    assert rule["action"] == "Ignore"
    assert rule["onPodConditions"] == [{"type": "DisruptionTarget"}]
    pod = spec["template"]["spec"]
    assert pod["restartPolicy"] == "Never"
    assert pod["automountServiceAccountToken"] is False
    env = {e["name"]: e["value"] for e in pod["containers"][0]["env"]}
    assert env["SF_GATE_FEEDBACK"] == "RED gate said: tests passed"
    assert env["SF_STAGE"] == "green" and env["SF_ATTEMPT"] == "2"


def test_gate_manifest_differs_where_it_must():
    m = gate_job_manifest("REQ-2045", "red", 1)
    assert m["metadata"]["name"] == "sf-req-2045-red-1-gate"
    assert m["metadata"]["labels"]["sf/role"] == "gate"
    assert m["spec"]["activeDeadlineSeconds"] == settings.GATE_ACTIVE_DEADLINE
    env = {
        e["name"]: e["value"]
        for e in m["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert env["SF_ROLE"] == "gate"
    assert "SF_GATE_FEEDBACK" not in env


def test_parse_envelope_and_ndjson_are_tolerant():
    assert parse_envelope('{"v":1,"outcome":"ok","detail":"done"}') == {
        "v": 1,
        "outcome": "ok",
        "detail": "done",
    }
    assert parse_envelope("") is None
    assert parse_envelope("panic: exit 2") is None
    assert parse_envelope('{"no_outcome": true}') is None
    logs = 'banner line\n{"type":"note","text":"a"}\nnot json\n{"type":"note","text":"b"}\n'
    assert [e["text"] for e in ndjson_events(logs)] == ["a", "b"]


def test_fake_kube_client_roundtrip():
    from fake_kube import FakeKubeClient

    fake = FakeKubeClient()
    fake.create_job(stage_job_manifest("REQ-2045", "architecture", 1))
    assert fake.get_job("sf-req-2045-architecture-1").phase == "running"
    fake.finish(
        "sf-req-2045-architecture-1",
        {"v": 1, "outcome": "ok", "detail": "done"},
        logs='{"type":"note","text":"hi"}\n',
    )
    view = fake.get_job("sf-req-2045-architecture-1")
    assert view.phase == "succeeded" and parse_envelope(view.termination_message)["outcome"] == "ok"
    fake.delete_job("sf-req-2045-architecture-1")
    assert fake.get_job("sf-req-2045-architecture-1").phase == "absent"
    assert fake.deletions == ["sf-req-2045-architecture-1"]


# ---------- seam v2 (Plan B2 task 1): uid, 409, running-pod capture ----------


def test_fake_create_returns_uid_and_conflict_returns_none():
    from fake_kube import FakeKubeClient

    fake = FakeKubeClient()
    uid = fake.create_job(stage_job_manifest("REQ-2050", "red", 1))
    assert uid and fake.get_job("sf-req-2050-red-1").uid == uid
    fake.delete_job("sf-req-2050-red-1")
    fake.conflicts.add("sf-req-2050-red-1")
    fake.jobs["sf-req-2050-red-1"].deleted = False  # a dying predecessor lingers
    assert fake.create_job(stage_job_manifest("REQ-2050", "red", 1)) is None
    # the live job is still the OLD one — same uid
    assert fake.get_job("sf-req-2050-red-1").uid == uid


def test_fake_capture_gates_running_pod_logs():
    from fake_kube import FakeKubeClient

    fake = FakeKubeClient()
    fake.create_job(stage_job_manifest("REQ-2051", "red", 1))
    fake.jobs["sf-req-2051-red-1"].logs = '{"type":"note","text":"live"}\n'
    # running + no capture: cheap poll, no log transfer (mirrors RealKubeClient)
    assert fake.get_job("sf-req-2051-red-1").logs == ""
    assert fake.get_job("sf-req-2051-red-1", capture=True).logs != ""
    # terminal: capture is implicit
    fake.finish(
        "sf-req-2051-red-1",
        {"v": 1, "outcome": "ok", "detail": "d"},
        logs='{"type":"note","text":"done"}\n',
    )
    view = fake.get_job("sf-req-2051-red-1")
    assert view.logs != "" and view.termination_message != ""


def test_stage_job_uid_column_roundtrip():
    from app.db import SessionLocal, migrate
    from app.models import StageJob, utcnow

    migrate()
    with SessionLocal() as db:
        row = StageJob(
            request_id=1,
            stage="red",
            attempt=1,
            role="stage",
            job_name="sf-req-9002-red-1",
            epoch=1,
            job_uid="uid-abc",
            deadline_at=utcnow(),
        )
        db.add(row)
        db.commit()
        assert db.get(StageJob, row.id).job_uid == "uid-abc"


# ---------- manifests v2 (Plan B2 task 4) ----------


def _pod(m):
    return m["spec"]["template"]["spec"]


def _env(m):
    return {e["name"]: e["value"] for e in _pod(m)["containers"][0]["env"]}


def test_manifests_carry_the_restricted_pod_shape():
    m = stage_job_manifest("REQ-2052", "red", 1)
    pod = _pod(m)
    sec = pod["securityContext"]
    assert sec["runAsNonRoot"] is True and sec["runAsUser"] == settings.KUBE_RUN_AS_UID
    assert sec["runAsGroup"] == 0 and sec["fsGroup"] == 0
    assert sec["seccompProfile"] == {"type": "RuntimeDefault"}
    c = pod["containers"][0]
    assert c["securityContext"] == {
        "allowPrivilegeEscalation": False,
        "capabilities": {"drop": ["ALL"]},
    }
    assert c["imagePullPolicy"] == "IfNotPresent"
    assert pod["automountServiceAccountToken"] is False
    assert {"name": "workspace", "mountPath": "/workspace"} in c["volumeMounts"]
    assert {"name": "workspace", "emptyDir": {}} in pod["volumes"]
    assert _env(m)["HOME"] == "/workspace"


def test_service_accounts_split_by_role():
    assert (
        _pod(stage_job_manifest("REQ-2052", "red", 1))["serviceAccountName"]
        == settings.KUBE_AGENT_SA
    )
    assert (
        _pod(gate_job_manifest("REQ-2052", "red", 1))["serviceAccountName"]
        == settings.KUBE_GATE_SA
    )


def test_codex_secret_only_on_stage_pods():
    stage = _pod(stage_job_manifest("REQ-2052", "red", 1))
    gate = _pod(gate_job_manifest("REQ-2052", "red", 1))
    assert any(
        v.get("secret", {}).get("secretName") == settings.CODEX_AUTH_SECRET
        for v in stage["volumes"]
    )
    assert {
        "name": "codex-auth",
        "mountPath": "/secrets/codex",
        "readOnly": True,
    } in stage["containers"][0]["volumeMounts"]
    assert not any(
        "secret" in v for v in gate["volumes"]
    )  # no LLM credential in gates (spec §6)


def test_git_env_rides_the_remote_base(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    env = _env(stage_job_manifest("REQ-2052", "green", 2))
    assert env["SF_REPO_URL"] == "git://api:9418/req-2052"
    assert env["SF_BRANCH"] == "work/req-2052"
    assert env["SF_CLI"] in ("codex", "opencode", "claude")
    genv = _env(gate_job_manifest("REQ-2052", "green", 2, sha="a" * 40))
    assert genv["SF_SHA"] == "a" * 40 and genv["SF_REPO_URL"] == "git://api:9418/req-2052"
    assert "SF_CLI" not in genv  # gates never run a CLI
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "")
    assert "SF_REPO_URL" not in _env(stage_job_manifest("REQ-2052", "green", 2))


def test_review_gate_carries_the_reviewer_verdict():
    env = _env(
        gate_job_manifest(
            "REQ-2052",
            "review",
            1,
            sha="b" * 40,
            review_verdict="APPROVE — implements the spec",
        )
    )
    assert env["SF_REVIEW_VERDICT"].startswith("APPROVE")
    assert "SF_REVIEW_VERDICT" not in _env(
        gate_job_manifest("REQ-2052", "red", 1)
    )
