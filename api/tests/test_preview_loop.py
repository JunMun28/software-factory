"""C1 preview and requester-feedback loop."""

from datetime import timedelta

from fake_kube import FakeKubeClient, pass_verdict
from helpers import approved_request
from sqlalchemy import select

from app import api_helpers, deploy_manifests, kube_runner, models, settings, transitions
from app.db import SessionLocal
from app.kube_jobs import stage_job_manifest
from app.kube_runner import KubeJobRunner
from app.models import AuditEvent, Intent, ProgressEvent, Request, StageJob, utcnow

DIGEST = "sha256:" + "d" * 64
SHA = "a" * 40


def _enable_preview(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "preview-ws")
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)
    monkeypatch.setattr(settings, "PREVIEW", True)
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: True)


def _put_at_preview_gate(client, title: str, *, needs_human: bool = False):
    request = approved_request(client, title=title)
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage = "preview"
        req.gate = transitions.GATE_ACCEPT_PREVIEW
        req.needs_human = needs_human
        req.needs_human_reason = "Preview acceptance timed out" if needs_human else None
        req.stage_entered_at = utcnow() - timedelta(days=4)
        db.commit()
    return request


def _graded_preview_request(client, title: str):
    request = approved_request(client, title=title)
    now = utcnow()
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage = "preview"
        req.gate = None
        req.stage_entered_at = now
        db.add_all(
            [
                StageJob(
                    request_id=req.id,
                    stage="review",
                    attempt=1,
                    role="stage",
                    job_name=f"{req.ref.lower()}-review",
                    status="succeeded",
                    envelope={"sha": SHA},
                    deadline_at=now,
                    completed_at=now,
                ),
                StageJob(
                    request_id=req.id,
                    stage="review",
                    attempt=1,
                    role="gate",
                    job_name=f"{req.ref.lower()}-review-gate",
                    status="succeeded",
                    deadline_at=now,
                    completed_at=now,
                ),
            ]
        )
        db.commit()
    return request


def _drive_to_accept_gate(client, runner, fake, request):
    moved: list[str] = []
    with SessionLocal() as db:
        runner._drive_previews(db, moved)
        pbuild = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "pbuild"
            )
        )
        assert pbuild is not None
        build_name = pbuild.job_name
    fake.finish(build_name, {}, phase="succeeded")
    fake.jobs[build_name].termination_message = DIGEST + "\n"
    with SessionLocal() as db:
        runner._drive_previews(db, moved)
    fake.mark_ready(deploy_manifests.preview_app_name("northwind"))
    with SessionLocal() as db:
        runner._drive_previews(db, moved)
    return moved


def test_preview_models_and_settings_are_backend_gated(monkeypatch):
    assert hasattr(models, "PreviewFeedback")
    assert "preview" in models.STAGES
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "REGISTRY", "registry")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)
    monkeypatch.setattr(settings, "PREVIEW", False)
    assert settings.preview_enabled() is False
    monkeypatch.setattr(settings, "PREVIEW", True)
    assert settings.preview_enabled() is True


def test_preview_manifests_are_round_scoped_and_request_labeled(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    build = deploy_manifests.preview_build_job_manifest("REQ-2001", "northwind", SHA, 2)
    assert build["metadata"]["name"] == "sf-req-2001-pbuild-r2"
    assert build["metadata"]["labels"]["sf/preview"] == "true"
    init_env = {
        item["name"]: item["value"]
        for item in build["spec"]["template"]["spec"]["initContainers"][0]["env"]
    }
    assert init_env["SF_BRANCH"] == "work/req-2001"
    assert init_env["SF_SHA"] == SHA
    destination = build["spec"]["template"]["spec"]["containers"][0]["args"][2]
    assert destination.endswith(f"sf-app-northwind:preview-{SHA[:12]}")

    manifests = deploy_manifests.preview_manifests("northwind", DIGEST, "REQ-2001")
    for manifest in manifests:
        labels = manifest["metadata"]["labels"]
        assert labels["sf/request"] == "req-2001"
        assert labels["sf/preview"] == "true"
        assert "sf/instance" not in labels
    deployment = manifests[0]
    assert deployment["spec"]["replicas"] == 1
    assert deployment["spec"]["template"]["spec"]["containers"][0]["image"].endswith(
        "@" + DIGEST
    )
    assert manifests[2]["spec"]["rules"][0]["host"] == "northwind-preview.localtest.me"


def test_preview_feedback_is_injected_only_into_architecture_job():
    architecture = stage_job_manifest(
        "REQ-2002", "architecture", 1, preview_feedback="- Make filters sticky"
    )
    env = {
        item["name"]: item["value"]
        for item in architecture["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert env["SF_PREVIEW_FEEDBACK"] == "- Make filters sticky"


def test_preview_transitions_clear_ttl_escalation_on_recovery(client):
    request = _put_at_preview_gate(client, "Preview transition recovery", needs_human=True)
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        accepted = transitions.apply(
            db, req, "claim_accept", actor=transitions.Actor("Kim", operator_id=1)
        )
        assert isinstance(accepted, transitions.Win)
        assert req.needs_human is False
        assert req.needs_human_reason is None
        db.rollback()

        req = db.get(Request, request["id"])
        changed = transitions.apply(
            db, req, "request_changes", actor=transitions.Actor("Kim", operator_id=1)
        )
        assert isinstance(changed, transitions.Win)
        assert req.stage == "architecture"
        assert req.preview_round == 1
        assert req.needs_human is False
        assert req.needs_human_reason is None


def test_preview_off_preserves_review_to_merge_flow(client, monkeypatch, tmp_path):
    _enable_preview(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "PREVIEW", False)
    request = approved_request(client, title="Preview disabled B4 flow")
    runner = KubeJobRunner(client=FakeKubeClient())
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage = "review"
        db.commit()
        runner._finish_review(db, req, {"metrics": {}}, [])
        assert req.stage == "review"
        assert req.gate == transitions.GATE_APPROVE_MERGE
        assert not db.scalars(
            select(StageJob).where(
                StageJob.request_id == req.id, StageJob.stage == "preview"
            )
        ).all()
    client.post(
        f"/api/requests/{request['id']}/cancel",
        json={"operator_id": 1, "note": "test cleanup"},
    )


def test_merge_claim_terminal_audit_blocks_whole_preview_machine(client, monkeypatch, tmp_path):
    _enable_preview(monkeypatch, tmp_path)
    request = _graded_preview_request(client, "Preview merge claim CAS")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    now = utcnow()
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        pdeploy = StageJob(
            request_id=req.id,
            stage="preview",
            attempt=1,
            role="pdeploy",
            job_name=deploy_manifests.preview_app_name("northwind"),
            status="running",
            envelope={"round": 0, "sha": SHA, "digest": DIGEST},
            deadline_at=now + timedelta(minutes=5),
        )
        db.add_all(
            [
                pdeploy,
                AuditEvent(
                    request_id=req.id,
                    actor="Kim",
                    operator_id=1,
                    action="merge_claimed",
                ),
            ]
        )
        db.commit()
        runner._drive_previews(db, [])
        db.refresh(pdeploy)
        assert pdeploy.status == "running"
        assert req.gate is None
        assert fake.applied == []

        raised = transitions.apply(
            db,
            req,
            "raise_deploy_gate",
            actor=transitions.FACTORY,
            params={"sha": SHA},
        )
        assert isinstance(raised, transitions.Win)
        db.commit()
        assert req.gate == transitions.GATE_APPROVE_DEPLOY


def test_preview_accept_gate_is_raised_once_and_status_route_is_ready(
    client, monkeypatch, tmp_path
):
    _enable_preview(monkeypatch, tmp_path)
    request = _graded_preview_request(client, "Preview once latch")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    _drive_to_accept_gate(client, runner, fake, request)
    with SessionLocal() as db:
        runner._drive_previews(db, [])
        events = db.scalars(
            select(ProgressEvent).where(
                ProgressEvent.request_id == request["id"],
                ProgressEvent.kind == "gate_event",
            )
        ).all()
        accept_events = [
            event
            for event in events
            if (event.payload or {}).get("gate") == transitions.GATE_ACCEPT_PREVIEW
        ]
        assert len(accept_events) == 1
        pdeploy = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "pdeploy"
            )
        )
        assert pdeploy.status == "succeeded"

    status = client.get(f"/api/requests/{request['id']}/preview")
    assert status.status_code == 200, status.text
    assert status.json()["state"] == "ready"
    assert status.json()["round"] == 1
    assert status.json()["digest"] == DIGEST


def test_operator_accept_after_ttl_clears_escalation_and_prod_is_not_torn_down(
    client, monkeypatch, tmp_path
):
    _enable_preview(monkeypatch, tmp_path)
    request = _put_at_preview_gate(client, "TTL accept recovery", needs_human=True)
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    monkeypatch.setattr(api_helpers, "_pipeline", runner)

    accepted = client.post(
        f"/api/requests/{request['id']}/preview/accept", json={"operator_id": 1}
    )
    assert accepted.status_code == 200, accepted.text
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        assert req.gate == transitions.GATE_APPROVE_MERGE
        assert req.needs_human is False
        claim = transitions.apply(
            db, req, "claim_merge", actor=transitions.Actor("Kim", operator_id=1)
        )
        assert isinstance(claim, transitions.Win)
        raised = transitions.apply(
            db, req, "raise_deploy_gate", actor=transitions.FACTORY, params={"sha": SHA}
        )
        assert isinstance(raised, transitions.Win)
        claimed = transitions.apply(
            db, req, "claim_deploy", actor=transitions.Actor("Kim", operator_id=1)
        )
        assert isinstance(claimed, transitions.Win)
        begun = transitions.apply(
            db, req, "begin_deploy", actor=transitions.Actor("Kim", operator_id=1)
        )
        assert isinstance(begun, transitions.Win)
        db.commit()
        monkeypatch.setattr(runner, "_spawn_build", lambda *_args: None)
        runner._drive_one_deploy(db, req, [])
        assert fake.label_deletions == []


def test_operator_request_changes_clears_escalation_records_round_and_reruns_architecture(
    client, monkeypatch, tmp_path
):
    _enable_preview(monkeypatch, tmp_path)
    request = _put_at_preview_gate(client, "TTL changes recovery", needs_human=True)
    changed = client.post(
        f"/api/requests/{request['id']}/preview/request-changes",
        json={"operator_id": 1, "feedback": "Keep the filters visible", "page_path": "/orders"},
    )
    assert changed.status_code == 200, changed.text
    runner = KubeJobRunner(client=FakeKubeClient())
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        assert req.stage == "architecture"
        assert req.preview_round == 1
        assert req.needs_human is False
        feedback_type = models.PreviewFeedback
        feedback = db.scalar(
            select(feedback_type).where(feedback_type.request_id == req.id)
        )
        assert feedback.round == req.preview_round
        assert runner._preview_feedback_text(db, req) == "- Keep the filters visible (on /orders)"
        runner.tick(db)
        architecture = db.scalar(
            select(StageJob).where(
                StageJob.request_id == req.id,
                StageJob.stage == "architecture",
                StageJob.role == "stage",
            )
        )
        assert architecture is not None and architecture.status == "running"
        manifest = runner.client.jobs[architecture.job_name].manifest
        env = {
            item["name"]: item["value"]
            for item in manifest["spec"]["template"]["spec"]["containers"][0]["env"]
        }
        assert env["SF_PREVIEW_FEEDBACK"] == "- Keep the filters visible (on /orders)"


def test_round_two_review_request_changes_escalates_at_shared_attempt_cap(
    client, monkeypatch, tmp_path
):
    """The review retry budget is request-wide, including superseded preview rounds."""
    _enable_preview(monkeypatch, tmp_path)
    request = _put_at_preview_gate(client, "Round two shared review budget")
    now = utcnow() - timedelta(minutes=5)
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        db.add_all(
            [
                StageJob(
                    request_id=req.id,
                    stage="review",
                    attempt=1,
                    role=role,
                    job_name=f"{req.ref.lower()}-review-1-{role}",
                    status="succeeded",
                    envelope={"detail": "APPROVE"} if role == "stage" else {},
                    logs_tail='{"type":"review","text":"First round approved."}',
                    deadline_at=now,
                    completed_at=now,
                    created_at=now,
                )
                for role in ("stage", "gate")
            ]
        )
        db.commit()
    changed = client.post(
        f"/api/requests/{request['id']}/preview/request-changes",
        json={"feedback": "Make the filters sticky"},
    )
    assert changed.status_code == 200, changed.text
    runner = KubeJobRunner(client=FakeKubeClient())
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage = "review"
        stage = StageJob(
            request_id=req.id,
            stage="review",
            attempt=2,
            role="stage",
            job_name=f"{req.ref.lower()}-review-2",
            status="succeeded",
            envelope={"detail": "REQUEST-CHANGES"},
            logs_tail='{"type":"review","text":"The filter state is still lost."}',
            deadline_at=utcnow() + timedelta(minutes=5),
        )
        gate = StageJob(
            request_id=req.id,
            stage="review",
            attempt=2,
            role="gate",
            job_name=f"{req.ref.lower()}-review-2-gate",
            deadline_at=utcnow() + timedelta(minutes=5),
        )
        db.add_all([stage, gate])
        db.commit()

        runner._grade(db, req, gate, "succeeded", pass_verdict(), [])
        db.refresh(req)

        assert req.needs_human is True
        assert req.gate is None
        assert "after 2 attempts" in req.needs_human_reason
        assert not db.scalars(
            select(StageJob).where(
                StageJob.request_id == req.id,
                StageJob.stage == "review",
                StageJob.attempt == 3,
            )
        ).all()


def test_identical_digest_in_next_round_gets_a_fresh_accept_gate(
    client, monkeypatch, tmp_path
):
    _enable_preview(monkeypatch, tmp_path)
    request = _graded_preview_request(client, "Preview identical digest rounds")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    _drive_to_accept_gate(client, runner, fake, request)

    changed = client.post(
        f"/api/requests/{request['id']}/preview/request-changes",
        json={"feedback": "Use the same bits but explain the export"},
    )
    assert changed.status_code == 200, changed.text
    now = utcnow()
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage = "review"
        db.add_all(
            [
                StageJob(
                    request_id=req.id,
                    stage="review",
                    attempt=2,
                    role="stage",
                    job_name=f"{req.ref.lower()}-review-2",
                    status="succeeded",
                    envelope={"sha": SHA},
                    deadline_at=now,
                    completed_at=now,
                ),
                StageJob(
                    request_id=req.id,
                    stage="review",
                    attempt=2,
                    role="gate",
                    job_name=f"{req.ref.lower()}-review-2-gate",
                    status="succeeded",
                    deadline_at=now,
                    completed_at=now,
                ),
            ]
        )
        db.commit()
        runner._finish_review(db, req, {"metrics": {}}, [])
        runner._drive_previews(db, [])
        second_build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == req.id,
                StageJob.role == "pbuild",
                StageJob.envelope["round"].as_integer() == 1,
            )
        )
        second_name = second_build.job_name
    fake.finish(second_name, {}, phase="succeeded")
    fake.jobs[second_name].termination_message = DIGEST + "\n"
    with SessionLocal() as db:
        runner._drive_previews(db, [])
    fake.mark_ready(deploy_manifests.preview_app_name("northwind"))
    with SessionLocal() as db:
        runner._drive_previews(db, [])
        req = db.get(Request, request["id"])
        assert req.gate == transitions.GATE_ACCEPT_PREVIEW
        gate_events = db.scalars(
            select(ProgressEvent).where(
                ProgressEvent.request_id == req.id,
                ProgressEvent.kind == "gate_event",
            )
        ).all()
        rounds = [
            (event.payload or {}).get("round")
            for event in gate_events
            if event.title.startswith("Preview round")
        ]
        assert rounds == [1, 2]
        keys = db.scalars(select(Intent.key)).all()
        assert f"deploy_preview:northwind:{DIGEST}:r0" in keys
        assert f"deploy_preview:northwind:{DIGEST}:r1" in keys


def test_cancel_mid_preview_build_reaps_request_resources_but_not_prod(
    client, monkeypatch, tmp_path
):
    _enable_preview(monkeypatch, tmp_path)
    request = _graded_preview_request(client, "Preview cancel reaping")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    with SessionLocal() as db:
        runner._drive_previews(db, [])
        pbuild = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "pbuild"
            )
        )
        pbuild_name = pbuild.job_name
    for manifest in deploy_manifests.app_deploy_manifests("northwind", DIGEST):
        fake.apply(manifest)
    cancelled = client.post(
        f"/api/requests/{request['id']}/cancel", json={"operator_id": 1}
    )
    assert cancelled.status_code == 200
    with SessionLocal() as db:
        runner._reap_dead_requests(db, [])
        runner._drive_previews(db, [])
        pbuild = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "pbuild"
            )
        )
        marker = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "pteardown"
            )
        )
        assert pbuild.status == "reaped"
        assert marker is not None and marker.status == "succeeded"
    assert pbuild_name in fake.deletions
    assert f"sf/request={request['ref'].lower()}" in fake.label_deletions
    assert "Deployment/sf-app-northwind" in fake.objects
    assert "sf/instance=northwind" not in fake.label_deletions


def test_preview_ttl_escalates_without_tearing_down_live_environment(
    client, monkeypatch, tmp_path
):
    _enable_preview(monkeypatch, tmp_path)
    request = _graded_preview_request(client, "Preview TTL keep environment")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    _drive_to_accept_gate(client, runner, fake, request)
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage_entered_at = utcnow() - timedelta(seconds=settings.PREVIEW_TTL + 1)
        db.commit()
        runner._sweep_preview_ttl(db, [])
        assert req.needs_human is True
        assert req.gate == transitions.GATE_ACCEPT_PREVIEW
        assert "Deployment/sf-app-northwind-preview" in fake.objects
        assert fake.label_deletions == []


def test_request_changes_at_round_cap_records_feedback_then_parks_for_operator(
    client, monkeypatch
):
    request = _put_at_preview_gate(client, "Preview feedback cap")
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.preview_round = settings.PREVIEW_MAX_ROUNDS
        db.commit()
    changed = client.post(
        f"/api/requests/{request['id']}/preview/request-changes",
        json={"feedback": "One final change"},
    )
    assert changed.status_code == 200, changed.text
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        assert req.stage == "architecture"
        assert req.preview_round == settings.PREVIEW_MAX_ROUNDS + 1
        assert req.needs_human is True
        feedback = db.scalar(
            select(models.PreviewFeedback).where(
                models.PreviewFeedback.request_id == req.id,
                models.PreviewFeedback.round == req.preview_round,
            )
        )
        assert feedback is not None and feedback.body == "One final change"


def test_apply_preview_commits_pdeploy_intent_before_cluster_apply(
    client, monkeypatch, tmp_path
):
    _enable_preview(monkeypatch, tmp_path)
    request = _graded_preview_request(client, "Preview row before apply")

    class ObservingFake(FakeKubeClient):
        saw_pdeploy = False

        def apply(self, manifest):
            with SessionLocal() as check:
                self.saw_pdeploy = check.scalar(
                    select(StageJob.id).where(
                        StageJob.request_id == request["id"],
                        StageJob.role == "pdeploy",
                        StageJob.status == "running",
                    )
                ) is not None
            super().apply(manifest)

    runner = KubeJobRunner(client=(fake := ObservingFake()))
    now = utcnow()
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        db.add(
            StageJob(
                request_id=req.id,
                stage="preview",
                attempt=1,
                role="pbuild",
                job_name=f"{req.ref.lower()}-pbuild",
                status="succeeded",
                envelope={"round": 0, "sha": SHA, "digest": DIGEST},
                deadline_at=now,
                completed_at=now,
            )
        )
        db.commit()
        runner._apply_preview(db, req, "northwind", DIGEST, 0, [])
    assert fake.saw_pdeploy is True


def test_deploy_gate_preview_evidence_survives_a_later_merge_claim(
    client, monkeypatch, tmp_path
):
    # regression (found live, kind-smoke): the deploy gate's preview evidence
    # (url/round/acceptor) must be read from the preview_accepted audit, NOT the
    # newest decisive audit — which by merge time is merge_claimed and would
    # leave the deploy gate with no preview URL. The acceptor must be the
    # requester who accepted, never the operator who claimed the merge.
    _enable_preview(monkeypatch, tmp_path)
    request = _put_at_preview_gate(client, "deploy gate preview evidence")
    runner = KubeJobRunner(client=FakeKubeClient())
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        db.add_all(
            [
                AuditEvent(
                    request_id=req.id,
                    actor="Ada",
                    operator_id=1,
                    action="preview_accepted",
                ),
                StageJob(
                    request_id=req.id,
                    stage="preview",
                    attempt=1,
                    role="pbuild",
                    job_name=f"{req.ref.lower()}-pbuild",
                    status="succeeded",
                    envelope={
                        "round": req.preview_round,
                        "sha": SHA,
                        "digest": DIGEST,
                    },
                    deadline_at=utcnow(),
                    completed_at=utcnow(),
                ),
            ]
        )
        db.commit()
        # claim_merge runs AFTER the accept, so this is the newest decisive audit
        db.add(AuditEvent(request_id=req.id, actor="Kim",
                          operator_id=1, action="merge_claimed"))
        db.commit()
        params = runner._accepted_preview_params(db, req)
    assert params["preview_url"].endswith(f"-preview.{settings.APP_INGRESS_DOMAIN}")
    assert params["accepted_by"] == "Ada"  # the acceptor, never the merge claimer
    assert "preview_round" in params
    assert params["preview_digest"] == DIGEST
    assert "built_digest" not in params


def test_ai_review_retry_and_requester_preview_rewind_use_distinct_feedback(
    client,
):
    runner = KubeJobRunner(client=FakeKubeClient())
    ai_request = approved_request(client, title="AI review feedback lane")
    preview_request = _put_at_preview_gate(client, "Requester preview feedback lane")
    old = utcnow() - timedelta(minutes=5)

    with SessionLocal() as db:
        ai = db.get(Request, ai_request["id"])
        ai.stage = "review"
        for stage_name in ("architecture", "red", "green"):
            for role in ("stage", "gate"):
                db.add(
                    StageJob(
                        request_id=ai.id,
                        stage=stage_name,
                        attempt=1,
                        role=role,
                        job_name=f"{ai.ref.lower()}-{stage_name}-1-{role}",
                        status="succeeded",
                        envelope={"detail": "complete"},
                        created_at=old,
                        deadline_at=old,
                        completed_at=old,
                    )
                )
        ai_stage = StageJob(
            request_id=ai.id,
            stage="review",
            attempt=1,
            role="stage",
            job_name=f"{ai.ref.lower()}-review-1",
            status="succeeded",
            envelope={"detail": "REQUEST-CHANGES"},
            logs_tail='{"type":"review","text":"Handle the race."}',
            created_at=old,
            deadline_at=old,
            completed_at=old,
        )
        ai_gate = StageJob(
            request_id=ai.id,
            stage="review",
            attempt=1,
            role="gate",
            job_name=f"{ai.ref.lower()}-review-1-gate",
            deadline_at=utcnow(),
        )
        preview = db.get(Request, preview_request["id"])
        for stage_name in ("architecture", "red", "green", "review"):
            for role in ("stage", "gate"):
                db.add(
                    StageJob(
                        request_id=preview.id,
                        stage=stage_name,
                        attempt=1,
                        role=role,
                        job_name=f"{preview.ref.lower()}-{stage_name}-1-{role}",
                        status="succeeded",
                        envelope={"detail": "APPROVE"},
                        created_at=old,
                        deadline_at=old,
                        completed_at=old,
                    )
                )
        db.add_all([ai_stage, ai_gate])
        db.commit()
        runner._grade(db, ai, ai_gate, "succeeded", pass_verdict(), [])

    changed = client.post(
        f"/api/requests/{preview_request['id']}/preview/request-changes",
        json={"feedback": "Keep the filters visible", "page_path": "/orders"},
    )
    assert changed.status_code == 200, changed.text

    with SessionLocal() as db:
        ai = db.get(Request, ai_request["id"])
        preview = db.get(Request, preview_request["id"])
        assert runner._spawn_next(db, ai, [])
        assert runner._spawn_next(db, preview, [])

    ai_manifest = runner.client.jobs[f"sf-{ai_request['ref'].lower()}-review-2"].manifest
    preview_manifest = runner.client.jobs[
        f"sf-{preview_request['ref'].lower()}-architecture-2"
    ].manifest
    ai_env = {
        item["name"]: item["value"]
        for item in ai_manifest["spec"]["template"]["spec"]["containers"][0]["env"]
        if "value" in item
    }
    preview_env = {
        item["name"]: item["value"]
        for item in preview_manifest["spec"]["template"]["spec"]["containers"][0]["env"]
        if "value" in item
    }
    assert "Handle the race" in ai_env["SF_GATE_FEEDBACK"]
    assert "SF_PREVIEW_FEEDBACK" not in ai_env
    assert preview_env["SF_PREVIEW_FEEDBACK"] == "- Keep the filters visible (on /orders)"
    assert "SF_GATE_FEEDBACK" not in preview_env
