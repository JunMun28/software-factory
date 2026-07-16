"""B3 build+deploy driver — FakeKubeClient stands in for the cluster, so these
prove the ORCHESTRATOR's guarantees: merge -> build Job -> digest capture ->
factory-owned deploy apply -> rollout wait -> health probe -> done, plus
escalation + capture-before-delete + cancel teardown. Env-gated: unset REGISTRY
keeps B2 (merge -> done) exactly."""

import copy
import json
from datetime import timedelta

from fake_github import FakeGitHub
from fake_kube import FakeKubeClient, honest_build
from helpers import approved_request
from sqlalchemy import select

from app import (
    api_helpers,
    deploy_manifests,
    intents,
    kube_runner,
    settings,
    transitions,
    workspace,
)
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import AuditEvent, Intent, Request, StageJob, utcnow
from app.ws_exec import _git

DIGEST = "sha256:" + "d" * 64


def _enable_git(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "kube-ws")


def _enable_deploy(monkeypatch, tmp_path):
    _enable_git(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)


def _northwind_request(client, title):
    app_id = next(app["id"] for app in client.get("/api/apps").json() if app["key"] == "northwind")
    return approved_request(
        client,
        app_id=app_id,
        title=title,
        description="Add a monthly export function that returns the export format name.",
    )


def _tick_until(client, runner, rid, predicate, limit=40):
    out = client.get(f"/api/requests/{rid}").json()
    for _ in range(limit):
        if predicate(out):
            return out
        with SessionLocal() as db:
            runner.tick(db)
        out = client.get(f"/api/requests/{rid}").json()
    raise AssertionError(f"condition not reached after {limit} ticks: {out}")


def _to_merge_gate(client, monkeypatch, tmp_path, title, *, deploy=True):
    # The session-scoped API client keeps rows between tests. A stranded deploy
    # intentionally replays teardown, so retire earlier scenarios before a new
    # FakeKubeClient starts representing the cluster.
    with SessionLocal() as db:
        for old in db.scalars(select(Request).where(Request.stage == "deploy")).all():
            old.stage = "done"
        db.commit()
    if deploy:
        _enable_deploy(monkeypatch, tmp_path)
    else:
        _enable_git(monkeypatch, tmp_path)
        monkeypatch.setattr(settings, "REGISTRY", "")
        monkeypatch.setattr(settings, "APP_DEPLOY", False)
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    honest_build(fake, settings.WORKSPACES)
    request = _northwind_request(client, title)
    out = _tick_until(
        client, runner, request["id"], lambda item: item["gate"] == "approve_merge"
    )
    assert out["stage"] == "review" and not out["needs_human"]
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    monkeypatch.setattr(api_helpers, "_pipeline", runner)
    approved = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert approved.status_code == 200, approved.text
    body = approved.json()
    if deploy:
        # B4: the merge approve leaves the request WAITING at the deploy gate;
        # a second approve (the second human gate, spec §4.10) releases it.
        assert body["gate"] == "approve_deploy" and body["stage"] == "deploy"
        second = client.post(
            f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
        )
        assert second.status_code == 200, second.text
        body = second.json()
        assert body["gate"] is None and body["stage"] == "deploy"
    return request, body, runner, fake


def _github_merge_ready(client, monkeypatch, tmp_path, title, *, deploy=False):
    with SessionLocal() as db:
        for old in db.scalars(select(Request).where(Request.stage == "deploy")).all():
            old.stage = "done"
        db.commit()
    if deploy:
        _enable_deploy(monkeypatch, tmp_path)
    else:
        _enable_git(monkeypatch, tmp_path)
        monkeypatch.setattr(settings, "REGISTRY", "")
        monkeypatch.setattr(settings, "APP_DEPLOY", False)
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "test-token")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "octocat")
    monkeypatch.setattr(
        KubeJobRunner,
        "_push_github_baseline",
        staticmethod(lambda _ws, _slug, _ref: None),
    )
    monkeypatch.setattr(
        workspace, "push_branch_to_github", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        workspace, "fetch_ref_from_github", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        workspace, "fetch_main_from_github", lambda *_args, **_kwargs: None
    )
    github = FakeGitHub("octocat")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()), github=github)
    honest_build(fake, settings.WORKSPACES)
    deterministic_runner = fake.on_observe

    def run_with_resolved_secrets(name, job):
        resolved = copy.deepcopy(job)
        container = resolved.manifest["spec"]["template"]["spec"]["containers"][0]
        container["env"] = [
            {"name": item["name"], "value": "test-token"}
            if "secretKeyRef" in item.get("valueFrom", {})
            else item
            for item in container["env"]
        ]
        deterministic_runner(name, resolved)
        job.phase = resolved.phase
        job.termination_message = resolved.termination_message
        job.logs = resolved.logs

    fake.on_observe = run_with_resolved_secrets
    request = _northwind_request(client, title)
    out = _tick_until(
        client, runner, request["id"], lambda item: item["gate"] == "approve_merge"
    )
    assert out["stage"] == "review" and not out["needs_human"]
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        graded = runner._last_graded_sha(db, req)
    github.set_head("northwind", workspace.work_branch(request["ref"]), graded)
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    monkeypatch.setattr(api_helpers, "_pipeline", runner)
    return request, runner, fake, github, graded


def _spawn_and_finish_build(client, monkeypatch, tmp_path, title):
    request, approved, runner, fake = _to_merge_gate(
        client, monkeypatch, tmp_path, title
    )
    assert approved["stage"] == "deploy" and approved["status"] == transitions.APPROVED
    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        assert build is not None and build.status == "running"
        build_name = build.job_name
    fake.finish(build_name, {}, phase="succeeded")
    fake.jobs[build_name].termination_message = DIGEST + "\n"
    with SessionLocal() as db:
        runner.tick(db)
    return request, runner, fake, build_name


def test_merge_disabled_still_ends_at_done(client, monkeypatch, tmp_path):
    request, approved, _runner, _fake = _to_merge_gate(
        client, monkeypatch, tmp_path, "B3 disabled merge", deploy=False
    )

    assert approved["status"] == transitions.DONE and approved["stage"] == "done"
    with SessionLocal() as db:
        roles = db.scalars(
            select(StageJob.role).where(StageJob.request_id == request["id"])
        ).all()
    assert "build" not in roles and "deploy" not in roles


def test_github_merge_resolves_pr_intent_before_fallback_lookup(
    client, monkeypatch, tmp_path
):
    request, _runner, _fake, github, _graded = _github_merge_ready(
        client, monkeypatch, tmp_path / "intent", "GitHub PR intent resolution"
    )
    response = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == transitions.DONE
    assert not any(call[0] == "find_open_pr" for call in github.calls)

    request, _runner, _fake, github, _graded = _github_merge_ready(
        client, monkeypatch, tmp_path / "fallback", "GitHub PR fallback resolution"
    )
    with SessionLocal() as db:
        pr_intent = db.get(Intent, f"pr:{request['ref']}")
        pr_intent.outcome_json = "{}"
        db.commit()
    response = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == transitions.DONE
    assert any(call[0] == "find_open_pr" for call in github.calls)


def test_github_pr_lookup_error_is_sanitized_and_escalated_once(
    client, monkeypatch, tmp_path
):
    request, _runner, _fake, github, _graded = _github_merge_ready(
        client, monkeypatch, tmp_path, "GitHub PR lookup failure"
    )
    with SessionLocal() as db:
        pr_intent = db.get(Intent, f"pr:{request['ref']}")
        pr_intent.outcome_json = "{}"
        db.commit()
    token = settings.GITHUB_TOKEN
    leaked_url = (
        f"https://x-access-token:{token}@github.com/octocat/sf-app-northwind.git"
    )
    monkeypatch.setattr(
        github,
        "find_open_pr",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError(f"lookup failed for {leaked_url}")
        ),
    )

    response = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["needs_human"]
    assert "Could not resolve GitHub PR: lookup failed" in body["needs_human_reason"]
    assert "No open GitHub PR" not in body["needs_human_reason"]
    assert token not in body["needs_human_reason"]
    assert "x-access-token:" not in body["needs_human_reason"]
    events = client.get(
        "/api/events", params={"request_id": request["id"]}
    ).json()
    assert len([event for event in events if event["kind"] == "escalation"]) == 1
    with SessionLocal() as db:
        merge_intent = db.get(Intent, f"merge:{request['ref']}")
        outcome = json.loads(merge_intent.outcome_json)
        assert merge_intent.status == "failed"
        assert "Could not resolve GitHub PR: lookup failed" in outcome["error"]
        assert token not in outcome["error"]
        assert "x-access-token:" not in outcome["error"]


def test_github_merge_uses_graded_sha_updates_mirror_and_raises_deploy_gate(
    client, monkeypatch, tmp_path
):
    request, _runner, _fake, github, graded = _github_merge_ready(
        client,
        monkeypatch,
        tmp_path,
        "GitHub merge happy path",
        deploy=True,
    )
    fetches = []
    monkeypatch.setattr(
        workspace,
        "fetch_main_from_github",
        lambda ws, slug: fetches.append((ws, slug)) or None,
    )

    response = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["gate"] == "approve_deploy" and body["stage"] == "deploy"
    merge_call = next(call for call in github.calls if call[0] == "merge_pr")
    assert merge_call[1] == "northwind" and merge_call[3] == graded
    assert fetches == [(settings.WORKSPACES / request["ref"].lower(), "northwind")]
    with SessionLocal() as db:
        merge_intent = db.get(Intent, f"merge:{request['ref']}")
        assert merge_intent.kind == "merge_pr" and merge_intent.status == "done"
        assert json.loads(merge_intent.outcome_json)["merge_sha"] == f"{merge_call[2]:040x}"


def test_github_merge_sha_mismatch_escalates_without_completion_or_tail(
    client, monkeypatch, tmp_path
):
    request, _runner, _fake, github, _graded = _github_merge_ready(
        client, monkeypatch, tmp_path, "GitHub stale head"
    )
    github.set_head(
        "northwind", workspace.work_branch(request["ref"]), "f" * 40
    )

    response = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["needs_human"] and body["needs_human_reason"].startswith("Merge refused:")
    assert body["stage"] == "review" and body["gate"] is None
    with SessionLocal() as db:
        merge_intent = db.get(Intent, f"merge:{request['ref']}")
        assert merge_intent.status == "failed"
    pr_number = next(call[2] for call in github.calls if call[0] == "merge_pr")
    assert not github.prs[pr_number]["merged"]


def test_github_merge_mirror_fetch_failure_escalates_without_completion_or_tail(
    client, monkeypatch, tmp_path
):
    request, runner, _fake, github, graded = _github_merge_ready(
        client, monkeypatch, tmp_path, "GitHub mirror fetch failure", deploy=True
    )
    monkeypatch.setattr(
        workspace,
        "fetch_main_from_github",
        lambda *_args, **_kwargs: "fetch main failed",
    )

    response = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["needs_human"]
    assert body["needs_human_reason"].startswith(
        "Merged on GitHub but mirror update failed:"
    )
    assert body["stage"] == "review" and body["gate"] is None
    with SessionLocal() as db:
        merge_intent = db.get(Intent, f"merge:{request['ref']}")
        assert merge_intent.status == "failed"
    pr_number = next(call[2] for call in github.calls if call[0] == "merge_pr")
    assert github.prs[pr_number]["merged"]

    retried = client.post(
        f"/api/requests/{request['id']}/retry",
        json={"operator_id": 1, "note": "refresh merged main"},
    )
    assert retried.status_code == 200, retried.text
    merge_calls_before = [call for call in github.calls if call[0] == "merge_pr"]

    def refresh_merged_main(ws, slug):
        assert slug == "northwind"
        _git(ws, "checkout", "-q", "main")
        merged = _git(ws, "merge", "--no-ff", "-q", "-m", "remote merge", graded)
        assert merged.returncode == 0, merged.stderr
        return None

    monkeypatch.setattr(workspace, "fetch_main_from_github", refresh_merged_main)
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner.approve_merge(db, req, "Kim Park")
        db.refresh(req)
        merge_intent = db.get(Intent, f"merge:{request['ref']}")
        assert merge_intent.status == "done"
        assert req.gate == "approve_deploy" and req.stage == "deploy"
    assert [call for call in github.calls if call[0] == "merge_pr"] == merge_calls_before


def test_incomplete_github_merge_refreshes_main_and_recovers_without_second_merge(
    client, monkeypatch, tmp_path
):
    request, _runner, _fake, github, graded = _github_merge_ready(
        client, monkeypatch, tmp_path, "GitHub merge crash recovery"
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        intents.begin(
            db,
            f"merge:{req.ref}",
            intents.MERGE_PR,
            req.id,
            {"slug": "northwind", "sha": graded},
        )
        db.commit()
    merge_calls_before = [call for call in github.calls if call[0] == "merge_pr"]

    def refresh_already_merged(ws, slug):
        assert slug == "northwind"
        _git(ws, "checkout", "-q", "main")
        merged = _git(ws, "merge", "--no-ff", "-q", "-m", "remote merge", graded)
        assert merged.returncode == 0, merged.stderr
        return None

    monkeypatch.setattr(workspace, "fetch_main_from_github", refresh_already_merged)
    response = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == transitions.DONE
    assert [call for call in github.calls if call[0] == "merge_pr"] == merge_calls_before
    with SessionLocal() as db:
        row = db.get(Intent, f"merge:{request['ref']}")
        assert row.status == "done"
        assert json.loads(row.outcome_json)["merge_sha"] == workspace.head_sha(
            workspace.workspace_for(db.get(Request, request["id"])), "main"
        )


def test_incomplete_github_merge_before_side_effect_still_merges(
    client, monkeypatch, tmp_path
):
    request, _runner, _fake, github, graded = _github_merge_ready(
        client, monkeypatch, tmp_path, "GitHub pending merge before side effect"
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        intents.begin(
            db,
            f"merge:{req.ref}",
            intents.MERGE_PR,
            req.id,
            {"slug": "northwind", "sha": graded},
        )
        db.commit()

    response = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == transitions.DONE
    merge_calls = [call for call in github.calls if call[0] == "merge_pr"]
    assert len(merge_calls) == 1 and merge_calls[0][3] == graded
    with SessionLocal() as db:
        assert db.get(Intent, f"merge:{request['ref']}").status == "done"


def test_merge_kicks_off_build_then_deploy_to_done(client, monkeypatch, tmp_path):
    request, approved, runner, fake = _to_merge_gate(
        client, monkeypatch, tmp_path, "B3 deploy happy path"
    )
    assert approved["stage"] == "deploy" and approved["status"] == transitions.APPROVED

    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        assert build is not None and build.status == "running"
        assert build.envelope and len(build.envelope["sha"]) == 40
        assert build.deadline_at.tzinfo is not None
        assert build.deadline_at > utcnow() + timedelta(
            seconds=settings.BUILD_WALL_CLOCK - 5
        )
        build_name = build.job_name

    fake.finish(build_name, {}, phase="succeeded")
    fake.jobs[build_name].termination_message = DIGEST + "\n"
    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        deploy = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "deploy"
            )
        )
        assert build.status == "succeeded" and build.envelope["digest"] == DIGEST
        assert deploy is not None and deploy.status == "running"
        assert deploy.envelope["digest"] == DIGEST
        assert deploy.deadline_at.tzinfo is not None
        assert deploy.deadline_at > utcnow() + timedelta(
            seconds=settings.DEPLOY_WALL_CLOCK - 5
        )
        actions = db.scalars(
            select(AuditEvent.action)
            .where(AuditEvent.request_id == request["id"])
            .order_by(AuditEvent.id)
        ).all()
        # B4: two human gates, in order — merge then deploy
        assert actions.index("approved_merge") < actions.index("approved_deploy")
        intent_rows = db.scalars(
            select(Intent).where(Intent.request_id == request["id"])
        ).all()
        assert any(
            row.kind == "trigger_build"
            and row.key == f"build:{request['ref']}:{build.envelope['sha']}"
            and row.status == "done"
            for row in intent_rows
        )
        assert any(
            row.kind == "apply_deploy"
            and row.key == f"deploy:northwind:{DIGEST}"
            and row.status == "done"
            for row in intent_rows
        )

    assert {obj["kind"] for obj in fake.applied} == {"Deployment", "Service", "Ingress"}
    app_name = deploy_manifests.app_name("northwind")
    fake.mark_ready(app_name)
    probes = []
    monkeypatch.setattr(kube_runner, "_http_ok", lambda url: probes.append(url) or True)
    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        deploy = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "deploy"
            )
        )
        assert req.status == transitions.DONE and req.stage == "done"
        assert deploy.status == "succeeded"
    assert probes == [
        f"http://{app_name}.{settings.KUBE_NAMESPACE}.svc:80/health"
    ]

    events = client.get("/api/events", params={"request_id": request["id"]}).json()
    finished = next(event for event in reversed(events) if event["title"].startswith("Merge approved"))
    assert finished["payload"]["digest"] == DIGEST
    assert finished["payload"]["url"] == f"http://northwind.{settings.APP_INGRESS_DOMAIN}"


def test_build_failure_escalates_with_capture(client, monkeypatch, tmp_path):
    request, approved, runner, fake = _to_merge_gate(
        client, monkeypatch, tmp_path, "B3 build failure"
    )
    assert approved["stage"] == "deploy"
    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        build_name, build_uid = build.job_name, build.job_uid
    fake.finish(build_name, {}, phase="failed", logs="kaniko: push denied")

    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        deploy = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "deploy"
            )
        )
        assert req.needs_human and "Build Job" in req.needs_human_reason
        assert build.status == "failed" and "push denied" in build.logs_tail
        assert deploy is None
    assert (build_name, build_uid) in fake.deletion_uids
    assert not fake.applied


def test_probe_failure_escalates_not_a_silent_half_deploy(
    client, monkeypatch, tmp_path
):
    monkeypatch.setattr(settings, "DEPLOY_WALL_CLOCK", -1)
    request, runner, fake, _build_name = _spawn_and_finish_build(
        client, monkeypatch, tmp_path, "B3 health probe failure"
    )
    fake.mark_ready(deploy_manifests.app_name("northwind"))
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: False)

    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        deploy = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "deploy"
            )
        )
        assert req.needs_human and req.stage == "deploy"
        assert "health probe" in req.needs_human_reason.lower()
        assert deploy.status == "timed_out"
    assert deploy_manifests.app_name("northwind") not in fake.observations


def test_cancel_during_deploy_tears_down_the_app(client, monkeypatch, tmp_path):
    request, runner, fake, build_name = _spawn_and_finish_build(
        client, monkeypatch, tmp_path, "B3 cancel teardown"
    )
    with SessionLocal() as db:
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        build_uid = build.job_uid
    deletion_count = fake.deletions.count(build_name)

    cancelled = client.post(
        f"/api/requests/{request['id']}/cancel", json={"operator_id": 1}
    ).json()
    assert cancelled["status"] == transitions.CANCELLED
    with SessionLocal() as db:
        runner.tick(db)
        runner.tick(db)  # teardown is safe to replay

    assert fake.deletions.count(build_name) >= deletion_count + 2
    assert (build_name, build_uid) in fake.deletion_uids
    assert fake.label_deletions[-2:] == [
        "sf/instance=northwind",
        "sf/instance=northwind",
    ]
    assert not fake.objects


def test_retry_after_deploy_timeout_reapplies(client, monkeypatch, tmp_path):
    # review HIGH: a dead deploy row (timed_out) must not dead-end the request —
    # after the human Retry the manifests are re-applied and a fresh row drives.
    monkeypatch.setattr(settings, "DEPLOY_WALL_CLOCK", -1)
    request, runner, fake, _build_name = _spawn_and_finish_build(
        client, monkeypatch, tmp_path, "B3 retry after deploy timeout"
    )
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: False)
    with SessionLocal() as db:
        runner.tick(db)  # deploy row times out, escalates
        req = db.get(Request, request["id"])
        assert req.needs_human and req.stage == "deploy"
    with SessionLocal() as db:
        runner.tick(db)  # escalated -> teardown (app deleted)
    assert not fake.objects

    monkeypatch.setattr(settings, "DEPLOY_WALL_CLOCK", 600)
    retried = client.post(
        f"/api/requests/{request['id']}/retry", json={"operator_id": 1}
    )
    assert retried.status_code == 200, retried.text
    fake.applied.clear()
    with SessionLocal() as db:
        runner.tick(db)
        rows = db.scalars(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "deploy"
            ).order_by(StageJob.id)
        ).all()
    assert {obj["kind"] for obj in fake.applied} == {"Deployment", "Service", "Ingress"}
    assert rows[-1].status == "running" and rows[-1].id != rows[0].id

    # and the fresh round can still finish
    fake.mark_ready(deploy_manifests.app_name("northwind"))
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: True)
    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        assert req.status == transitions.DONE and req.stage == "done"


def test_build_absent_respawns_bounded(client, monkeypatch, tmp_path):
    # review MEDIUM: crash-before-create (absent Job) is benign — re-spawn, not
    # a human interrupt; but 3 consecutive infra rounds DO end in a human.
    request, approved, runner, fake = _to_merge_gate(
        client, monkeypatch, tmp_path, "B3 absent build respawns"
    )
    assert approved["stage"] == "deploy"
    monkeypatch.setattr(settings, "BUILD_WALL_CLOCK", -1)  # observe immediately

    def one_absent_round(expected_rows):
        with SessionLocal() as db:
            runner.tick(db)  # spawn
            build_rows = db.scalars(
                select(StageJob).where(
                    StageJob.request_id == request["id"], StageJob.role == "build"
                ).order_by(StageJob.id)
            ).all()
            assert len(build_rows) == expected_rows
            name = build_rows[-1].job_name
        fake.jobs[name].deleted = True  # the Job vanished (crash window / external delete)
        with SessionLocal() as db:
            runner.tick(db)  # observe -> infra, NO escalation
            req = db.get(Request, request["id"])
            build_rows = db.scalars(
                select(StageJob).where(
                    StageJob.request_id == request["id"], StageJob.role == "build"
                ).order_by(StageJob.id)
            ).all()
            return req.needs_human, build_rows[-1].status

    for round_no in (1, 2, 3):
        needs_human, status = one_absent_round(round_no)
        assert status == "infra"
        assert not needs_human, f"round {round_no} escalated a benign absent Job"

    with SessionLocal() as db:
        runner.tick(db)  # 3 consecutive infra -> bounded escalation
        req = db.get(Request, request["id"])
        assert req.needs_human
        assert "infra loop" in req.needs_human_reason


def test_merge_raises_deploy_gate_and_it_holds(client, monkeypatch, tmp_path):
    # B4: after the merge approve the request WAITS; a tick must not build.
    with SessionLocal() as db:
        for old in db.scalars(select(Request).where(Request.stage == "deploy")).all():
            old.stage = "done"
        db.commit()
    _enable_deploy(monkeypatch, tmp_path)
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    honest_build(fake, settings.WORKSPACES)
    request = _northwind_request(client, "B4 deploy gate holds")
    _tick_until(client, runner, request["id"], lambda item: item["gate"] == "approve_merge")
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    monkeypatch.setattr(api_helpers, "_pipeline", runner)
    first = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    ).json()
    assert first["gate"] == "approve_deploy" and first["stage"] == "deploy"
    with SessionLocal() as db:
        runner.tick(db)
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        assert build is None, "build started before the deploy gate was approved"
    assert fake.applied == []

    # the second approve releases it and records the approver
    second = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    ).json()
    assert second["gate"] is None and second["stage"] == "deploy"
    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        assert build is not None and build.status == "running"
        audits = db.scalars(
            select(AuditEvent).where(AuditEvent.request_id == request["id"])
        ).all()
        actions = [a.action for a in audits]
        assert "deploy_claimed" in actions and "approved_deploy" in actions

    # replayed approve while building resolves cleanly, never double-fires
    replay = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert replay.status_code in (200, 409)
    with SessionLocal() as db:
        builds = db.scalars(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        ).all()
        assert len(builds) == 1


def test_cancel_at_deploy_gate_builds_nothing(client, monkeypatch, tmp_path):
    with SessionLocal() as db:
        for old in db.scalars(select(Request).where(Request.stage == "deploy")).all():
            old.stage = "done"
        db.commit()
    _enable_deploy(monkeypatch, tmp_path)
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    honest_build(fake, settings.WORKSPACES)
    request = _northwind_request(client, "B4 cancel at deploy gate")
    _tick_until(client, runner, request["id"], lambda item: item["gate"] == "approve_merge")
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    monkeypatch.setattr(api_helpers, "_pipeline", runner)
    first = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    ).json()
    assert first["gate"] == "approve_deploy"
    cancelled = client.post(
        f"/api/requests/{request['id']}/cancel", json={"operator_id": 1}
    ).json()
    assert cancelled["status"] == transitions.CANCELLED
    with SessionLocal() as db:
        runner.tick(db)
    assert fake.applied == []
    with SessionLocal() as db:
        assert db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"],
                StageJob.role.in_(("build", "deploy")),
            )
        ) is None
