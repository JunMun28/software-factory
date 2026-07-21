"""ng-v0 bridge, piece 2: POST /api/requests/{rid}/preview/import-edit.

Bundles are just files — every test builds tiny REAL git repos in tmp_path and
grades the factory gate with the FakeKubeClient, fully offline (no pods)."""

import base64

import pytest
from fake_kube import FakeKubeClient, fail_verdict, pass_verdict
from helpers import approved_request
from sqlalchemy import select

from app import notifications, settings, transitions, workspace
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import AuditEvent, ImportEdit, ProgressEvent, Request, SpecLine, StageJob, utcnow
from app.ws_exec import _git


@pytest.fixture(autouse=True)
def _fresh_pool(monkeypatch):
    monkeypatch.setattr(settings, "PER_APP_CAP", 10_000)


def _enable(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "ws")
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)
    monkeypatch.setattr(settings, "PREVIEW", True)
    monkeypatch.setenv("FACTORY_IMPORT_EDIT", "1")


def _init_repo(ws):
    ws.mkdir(parents=True, exist_ok=True)
    _git(ws, "init", "-b", "main")
    _git(ws, "config", "user.email", "factory@local")
    _git(ws, "config", "user.name", "Factory bot")
    _git(ws, "config", "receive.denyCurrentBranch", "updateInstead")
    (ws / "app.txt").write_text("v0\n")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", "baseline")


def _seed(client, monkeypatch, tmp_path, *, n_edits=2, add_review_row=True):
    """An approved request parked at the preview-accept gate with a real repo
    whose work branch sits at the previewed sha, plus a sandbox bundle of
    ``n_edits`` commits built on top of it."""
    request = approved_request(client, title="ng-v0 sandbox import")
    ref = request["ref"]
    ws = settings.WORKSPACES / ref.lower()
    _init_repo(ws)
    _git(ws, "checkout", "-q", "-B", workspace.work_branch(ref))
    prev_sha = workspace.head_sha(ws, workspace.work_branch(ref))

    # sandbox = a clone; its edits are children of the previewed sha
    sandbox = tmp_path / f"{ref.lower()}-sandbox"
    _git(tmp_path, "clone", "-q", str(ws), str(sandbox))
    _git(sandbox, "config", "user.email", "user@local")
    _git(sandbox, "config", "user.name", "Sandbox user")
    _git(sandbox, "checkout", "-q", "-B", "sandbox", prev_sha)
    for i in range(n_edits):
        (sandbox / f"edit{i}.txt").write_text(f"edit {i}\n")
        _git(sandbox, "add", "-A")
        _git(sandbox, "commit", "-q", "-m", f"sandbox edit {i}")
    log = _git(
        sandbox, "log", "--reverse", "--format=%H", f"{prev_sha}..sandbox"
    ).stdout.split()
    bundle = tmp_path / f"{ref.lower()}.bundle"
    assert (
        _git(sandbox, "bundle", "create", str(bundle), f"{prev_sha}..sandbox").returncode
        == 0
    )

    now = utcnow()
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage = "preview"
        req.gate = transitions.GATE_ACCEPT_PREVIEW
        req.preview_round = 0
        req.stage_entered_at = now
        if add_review_row:
            db.add_all(
                StageJob(
                    request_id=req.id,
                    stage="review",
                    attempt=1,
                    role=role,
                    job_name=f"{req.ref.lower()}-review-1-{role}",
                    status="succeeded",
                    envelope={"sha": prev_sha, "detail": "APPROVE"},
                    deadline_at=now,
                    completed_at=now,
                )
                for role in ("stage", "gate")
            )
        db.commit()

    versions = [{"sha": sha, "message": f"sandbox edit {i}"} for i, sha in enumerate(log)]
    body = {
        "bundle": base64.b64encode(bundle.read_bytes()).decode(),
        "summary": "Made the filters sticky",
        "versions": versions,
    }
    return request, ref, ws, prev_sha, log, body


def _post(client, rid, body):
    return client.post(f"/api/requests/{rid}/preview/import-edit", json=body)


# ---------- validation / behavior table ----------

def test_flag_off_is_404(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    monkeypatch.delenv("FACTORY_IMPORT_EDIT", raising=False)
    resp = _post(client, request["id"], body)
    assert resp.status_code == 404, resp.text


def test_preview_disabled_is_404(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "PREVIEW", False)
    resp = _post(client, request["id"], body)
    assert resp.status_code == 404, resp.text


def test_not_at_accept_gate_is_409(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.gate = None  # no longer waiting at the accept gate
        db.commit()
    resp = _post(client, request["id"], body)
    assert resp.status_code == 409, resp.text
    assert "preview-acceptance gate" in resp.json()["detail"]


def test_commit_chain_mismatch_is_422(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    body = {**body, "versions": body["versions"][:1]}  # drop a checkpoint
    resp = _post(client, request["id"], body)
    assert resp.status_code == 422, resp.text
    assert "does not match" in resp.json()["detail"]
    with SessionLocal() as db:
        # rejected synchronously — no pending row, temp ref cleaned up
        assert not db.scalars(
            select(ImportEdit).where(ImportEdit.request_id == request["id"])
        ).all()


def test_branch_moved_is_409(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    # a feedback round landed: the work branch moved off the seed sha
    (ws / "app.txt").write_text("moved\n")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", "another round")
    resp = _post(client, request["id"], body)
    assert resp.status_code == 409, resp.text
    assert "re-seed" in resp.json()["detail"]


def test_bad_base64_is_422(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    resp = _post(client, request["id"], {**body, "bundle": "!!!not base64!!!"})
    assert resp.status_code == 422, resp.text


def test_empty_versions_rejected_by_schema(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    resp = _post(client, request["id"], {**body, "versions": []})
    assert resp.status_code == 422, resp.text


# ---------- accepted → pending record ----------

def test_happy_post_records_pending_import(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    resp = _post(client, request["id"], body)
    assert resp.status_code == 202, resp.text
    out = resp.json()
    assert out["status"] == "pending"
    assert out["head_sha"] == log[-1]
    assert out["versions"] == len(log)
    with SessionLocal() as db:
        imp = db.scalar(
            select(ImportEdit).where(ImportEdit.request_id == request["id"])
        )
        assert imp.status == "pending"
        assert imp.base_sha == prev
        assert imp.head_sha == log[-1]
        assert imp.temp_ref == "refs/import/round-0"
        # a second post while one is grading is a client double-fire
    assert _post(client, request["id"], body).status_code == 409


def test_preview_status_exposes_seed_when_editable(client, monkeypatch, tmp_path):
    """The requester's preview payload advertises the ng-v0 seed source only when
    import-edit is on and a previewed head sha exists; flag off hides both."""
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    # preview_status reads the previewed sha off the pdeploy envelope; add a
    # succeeded one at the previewed head so the status route has a live sha.
    now = utcnow()
    with SessionLocal() as db:
        db.add(
            StageJob(
                request_id=request["id"],
                stage="preview",
                attempt=1,
                role="pdeploy",
                job_name=f"{ref.lower()}-pdeploy-1",
                status="succeeded",
                envelope={"sha": prev, "digest": "sha256:abc"},
                deadline_at=now,
                completed_at=now,
            )
        )
        db.commit()

    try:
        out = client.get(f"/api/requests/{request['id']}/preview").json()
        assert out["editable"] is True
        assert out["seed"] == {"url": f"git://api:9418/{ref.lower()}", "ref": prev}

        # Flag off -> not editable, seed withheld (no clone source leaked).
        monkeypatch.delenv("FACTORY_IMPORT_EDIT", raising=False)
        off = client.get(f"/api/requests/{request['id']}/preview").json()
        assert off["editable"] is False
        assert off["seed"] is None
    finally:
        # The `client` DB is session-scoped: neutralize this "ready preview" so a
        # later global preview sweep (drive/ttl) never acts on our leftover.
        with SessionLocal() as db:
            for job in db.scalars(
                select(StageJob).where(StageJob.request_id == request["id"])
            ):
                db.delete(job)
            req = db.get(Request, request["id"])
            req.gate = None
            req.stage = "done"
            req.needs_human = False
            db.commit()


# ---------- async gate: green lands, red rejects ----------

def test_green_import_lands_and_resumes_at_review(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    assert _post(client, request["id"], body).status_code == 202
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    gate_name = f"sf-{ref.lower()}-import-r0-gate"

    with SessionLocal() as db:  # tick 1: spawn the import gate
        runner._drive_import_edits(db, [])
    assert gate_name in fake.jobs
    fake.finish(gate_name, pass_verdict())
    with SessionLocal() as db:  # tick 2: grade green → land
        runner._drive_import_edits(db, [])
        req = db.get(Request, request["id"])
        assert req.stage == "review"
        assert req.gate is None
        assert req.preview_round == 1
        imp = db.scalar(
            select(ImportEdit).where(ImportEdit.request_id == req.id)
        )
        assert imp.status == "applied"
        # spec record written in the same transaction as the branch move
        spec = db.scalar(
            select(SpecLine).where(
                SpecLine.request_id == req.id, SpecLine.prov == "import 0"
            )
        )
        assert spec is not None and "sandbox edit 1" in spec.text
        # the requester is the audited actor, never Factory
        audit = db.scalar(
            select(AuditEvent).where(
                AuditEvent.request_id == req.id, AuditEvent.action == "import_edited"
            )
        )
        assert audit is not None and audit.actor == req.reporter
        # review re-runs: the old review rows are superseded
        review_rows = db.scalars(
            select(StageJob).where(
                StageJob.request_id == req.id, StageJob.stage == "review"
            )
        ).all()
        assert review_rows and all(r.status == "superseded" for r in review_rows)

    # the work branch fast-forwarded to the imported head; temp ref cleaned up
    assert workspace.head_sha(ws, workspace.work_branch(ref)) == log[-1]
    assert workspace.head_sha(ws, "refs/import/round-0") is None


def test_red_import_is_rejected_branch_untouched_and_requester_notified(
    client, monkeypatch, tmp_path
):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    assert _post(client, request["id"], body).status_code == 202
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    gate_name = f"sf-{ref.lower()}-import-r0-gate"

    notified: list[str] = []
    # kube_runner calls notifications.notify_import_rejected at the module attr,
    # so patching the module here is what the runner sees.
    monkeypatch.setattr(
        notifications,
        "notify_import_rejected",
        lambda req, reason: notified.append(reason),
    )

    with SessionLocal() as db:
        runner._drive_import_edits(db, [])
    fake.finish(gate_name, fail_verdict("a test regressed under the factory gate"))
    with SessionLocal() as db:
        runner._drive_import_edits(db, [])
        req = db.get(Request, request["id"])
        # work branch untouched: still at the accept gate, previewed sha
        assert req.stage == "preview"
        assert req.gate == transitions.GATE_ACCEPT_PREVIEW
        assert req.preview_round == 0
        imp = db.scalar(select(ImportEdit).where(ImportEdit.request_id == req.id))
        assert imp.status == "rejected"
        assert "regressed" in (imp.gate_tail or "")
        event = db.scalar(
            select(ProgressEvent)
            .where(
                ProgressEvent.request_id == req.id, ProgressEvent.kind == "gate_event"
            )
            .order_by(ProgressEvent.id.desc())
        )
        assert event is not None and "rejected by the factory gate" in event.title
        assert (event.payload or {}).get("import_id") == imp.id

    assert notified and "regressed" in notified[0]
    assert workspace.head_sha(ws, workspace.work_branch(ref)) == prev
    assert workspace.head_sha(ws, "refs/import/round-0") is None


def test_import_abandoned_when_requester_leaves_the_gate(client, monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    request, ref, ws, prev, log, body = _seed(client, monkeypatch, tmp_path)
    assert _post(client, request["id"], body).status_code == 202
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.gate = None  # requester accepted meanwhile
        db.commit()
    runner = KubeJobRunner(client=FakeKubeClient())
    with SessionLocal() as db:
        runner._drive_import_edits(db, [])
        imp = db.scalar(select(ImportEdit).where(ImportEdit.request_id == request["id"]))
        assert imp.status == "superseded"
    assert workspace.head_sha(ws, workspace.work_branch(ref)) == prev
