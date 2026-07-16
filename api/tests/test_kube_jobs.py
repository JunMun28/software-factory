"""Kube building blocks: settings, StageJob rows, names, manifests, envelopes."""

import os
import subprocess
import sys
import uuid
from datetime import timezone
from pathlib import Path

import pytest

from app import settings
from app.db import SessionLocal, migrate
from app.deploy_manifests import build_job_manifest
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


def test_real_delete_job_uses_uid_precondition_when_known():
    from app.kube_client import RealKubeClient

    class DeleteOptions:
        def __init__(self, *, propagation_policy=None, preconditions=None):
            self.propagation_policy = propagation_policy
            self.preconditions = preconditions

    class Preconditions:
        def __init__(self, *, uid):
            self.uid = uid

    class Types:
        V1DeleteOptions = DeleteOptions
        V1Preconditions = Preconditions

    class Batch:
        def delete_namespaced_job(self, name, namespace, **kwargs):
            self.call = (name, namespace, kwargs)

    real = object.__new__(RealKubeClient)
    real.ns = "software-factory"
    real._batch = Batch()
    real._types = Types
    real._ApiException = RuntimeError

    real.delete_job("sf-req-2050-red-1", uid="uid-original")

    name, namespace, kwargs = real._batch.call
    assert (name, namespace) == ("sf-req-2050-red-1", "software-factory")
    # DEPLOY-03: Foreground GC rides INSIDE the body (a query-param kwarg is
    # ignored by the apiserver when a body is present -> Jobs default to Orphan).
    assert kwargs["body"].propagation_policy == "Foreground"
    assert kwargs["body"].preconditions.uid == "uid-original"
    assert "propagation_policy" not in kwargs

    # no-uid path still deletes Foreground (just without the precondition)
    real.delete_job("sf-req-2050-red-1")
    _n, _ns, kwargs2 = real._batch.call
    assert kwargs2["body"].propagation_policy == "Foreground"
    assert kwargs2["body"].preconditions is None


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
        # a real parent row: MSSQL enforces the FK that SQLite lets slide
        req = Request(
            ref=f"REQ-{uuid.uuid4().hex[:8]}",
            title="uid roundtrip fixture",
            description="StageJob.job_uid column roundtrip.",
            type="enh",
            status="approved",
        )
        db.add(req)
        db.commit()
        row = StageJob(
            request_id=req.id,
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


def _env_entries(m):
    return {
        entry["name"]: entry
        for entry in _pod(m)["containers"][0]["env"]
    }


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


def test_github_stage_manifest_uses_slug_and_optional_token_secret(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "orchestrator-only-token")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "octocat")

    manifest = stage_job_manifest(
        "REQ-2052", "green", 2, repo_slug="northwind"
    )
    env = _env_entries(manifest)

    assert env["SF_REPO_URL"] == {
        "name": "SF_REPO_URL",
        "value": "https://github.com/octocat/sf-app-northwind.git",
    }
    assert env["SF_BRANCH"] == {
        "name": "SF_BRANCH",
        "value": "work/req-2052",
    }
    assert env["SF_GITHUB_TOKEN"] == {
        "name": "SF_GITHUB_TOKEN",
        "valueFrom": {
            "secretKeyRef": {
                "name": "sf-github-token",
                "key": "token",
                "optional": True,
            }
        },
    }
    assert "value" not in env["SF_GITHUB_TOKEN"]
    assert "orchestrator-only-token" not in str(manifest)


def test_github_stage_manifest_honors_custom_token_secret(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "orchestrator-only-token")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "octocat")
    monkeypatch.setattr(settings, "GITHUB_TOKEN_SECRET", "custom-github-secret")

    env = _env_entries(
        stage_job_manifest("REQ-2052", "red", 1, repo_slug="northwind")
    )

    assert env["SF_GITHUB_TOKEN"]["valueFrom"]["secretKeyRef"] == {
        "name": "custom-github-secret",
        "key": "token",
        "optional": True,
    }


def test_token_unset_stage_manifest_is_b2_b3_identical(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "")
    expected = stage_job_manifest("REQ-2052", "green", 2)

    monkeypatch.setattr(settings, "GITHUB_OWNER", "octocat")
    actual = stage_job_manifest(
        "REQ-2052", "green", 2, repo_slug="northwind"
    )

    assert actual == expected


def test_github_does_not_change_gate_or_build_manifests(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "REGISTRY", "registry.local:5000")
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "")
    gate_before = gate_job_manifest("REQ-2052", "green", 2, sha="a" * 40)
    build_before = build_job_manifest("REQ-2052", "northwind", "b" * 40)

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "orchestrator-only-token")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "octocat")
    gate_after = gate_job_manifest("REQ-2052", "green", 2, sha="a" * 40)
    build_after = build_job_manifest("REQ-2052", "northwind", "b" * 40)

    assert gate_after == gate_before
    assert build_after == build_before
    assert "SF_GITHUB_TOKEN" not in str(gate_after)
    assert "SF_GITHUB_TOKEN" not in str(build_after)
    assert "orchestrator-only-token" not in str(gate_after)
    assert "orchestrator-only-token" not in str(build_after)


def test_entrypoint_authenticates_only_github_clone_without_leaking_token():
    source = (
        Path(__file__).resolve().parents[2] / "docker/sf-agent/entrypoint.sh"
    ).read_text()

    assert '[[ "$SF_REPO_URL" == https://github.com/* ]]' in source
    assert (
        'AUTHED_URL="https://x-access-token:${SF_GITHUB_TOKEN}'
        '@${SF_REPO_URL#https://}"'
    ) in source
    assert (
        'git clone -q --branch "$SF_BRANCH" "$AUTHED_URL" "$REPO" '
        '>/dev/null 2>&1 || die_stage "clone failed"'
    ) in source
    assert 'git -C "$REPO" remote set-url origin "$AUTHED_URL"' in source
    assert (
        'git clone -q --branch "$SF_BRANCH" "$SF_REPO_URL" "$REPO" '
        '|| die_stage "clone failed: $SF_REPO_URL"'
    ) in source
    assert not any(
        "AUTHED_URL" in line and line.lstrip().startswith("note ")
        for line in source.splitlines()
    )
    assert 'die_stage "clone failed: $AUTHED_URL"' not in source


def _run_clone_entrypoint(tmp_path, *, repo_url, token=""):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    git_calls = tmp_path / "git-calls"
    termlog = tmp_path / "termination-log"
    termlog.write_text("")

    fake_git = fake_bin / "git"
    fake_git.write_text(
        """#!/usr/bin/env bash
command="$1"
{
  printf '%s' "$1"
  shift
  printf '\t%s' "$@"
  printf '\n'
} >> "$GIT_CALLS"
if [ "$command" = "clone" ]; then
  for arg in "$@"; do
    case "$arg" in
      https://x-access-token:*)
        printf 'git clone failed for %s\n' "$arg" >&2
        ;;
    esac
  done
fi
exit 0
"""
    )
    fake_git.chmod(0o755)

    fake_jq = fake_bin / "jq"
    fake_jq.write_text(
        """#!/usr/bin/env bash
printf '{"type":"note","text":"safe"}\n'
"""
    )
    fake_jq.chmod(0o755)

    bash_env = tmp_path / "bash-env"
    bash_env.write_text("cd() { return 0; }\n")
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "BASH_ENV": str(bash_env),
        "GIT_CALLS": str(git_calls),
        "SF_TERMLOG": str(termlog),
        "SF_REF": "REQ-2052",
        "SF_STAGE": "build",
        "SF_ROLE": "clone",
        "SF_REPO_URL": repo_url,
        "SF_BRANCH": "main",
        "SF_SHA": "a" * 40,
        "SF_GITHUB_TOKEN": token,
    }
    entrypoint = Path(__file__).resolve().parents[2] / "docker/sf-agent/entrypoint.sh"

    result = subprocess.run(
        ["bash", str(entrypoint)],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    calls = [line.split("\t") for line in git_calls.read_text().splitlines()]
    captured = result.stdout + result.stderr + termlog.read_text()
    return result, calls, captured


def test_entrypoint_github_clone_uses_auth_without_output_leak(tmp_path):
    repo_url = "https://github.com/acme/sf-app-northwind.git"
    token = "super-secret-token"
    authed_url = (
        "https://x-access-token:super-secret-token"
        "@github.com/acme/sf-app-northwind.git"
    )

    result, calls, captured = _run_clone_entrypoint(
        tmp_path, repo_url=repo_url, token=token
    )

    assert result.returncode == 0, captured
    assert calls[0] == [
        "clone",
        "-q",
        "--branch",
        "main",
        authed_url,
        "/workspace/repo",
    ]
    assert calls[1] == [
        "-C",
        "/workspace/repo",
        "remote",
        "set-url",
        "origin",
        authed_url,
    ]
    assert token not in captured
    assert "x-access-token:" not in captured


def test_entrypoint_non_github_clone_preserves_original_remote(tmp_path):
    repo_url = "git://api:9418/req-2052"

    result, calls, captured = _run_clone_entrypoint(
        tmp_path, repo_url=repo_url, token="unused-token"
    )

    assert result.returncode == 0, captured
    assert calls[0] == [
        "clone",
        "-q",
        "--branch",
        "main",
        repo_url,
        "/workspace/repo",
    ]
    assert not any(call[2:5] == ["remote", "set-url", "origin"] for call in calls)


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


def test_entrypoint_push_and_review_paths_cannot_leak_the_token():
    # review MEDIUM (B4b): a failed push must not echo the authed origin URL
    # into captured logs; the read-only review stage must not keep a
    # credentialed origin after its clone.
    src = (
        Path(__file__).resolve().parents[2] / "docker/sf-agent/entrypoint.sh"
    ).read_text()
    push_line = next(line for line in src.splitlines() if "git push -q origin" in line)
    assert "2>&1" in push_line or "2>/dev/null" in push_line
    assert 'remote set-url origin "$SF_REPO_URL"' in src  # review keeps the clean URL
