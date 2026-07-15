# Plan B1: KubeJobRunner — pipeline stages as Kubernetes Jobs (backend only)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `KubeJobRunner` behind `FACTORY_RUNNER=kube` that creates, watches (by polling), grades, and reaps Kubernetes Jobs for the pipeline stages — fully testable with a `FakeKubeClient`, no cluster, no kind.

**Architecture:** The factory stays a DB state machine driven by the leader's tick loop (spec §4: the orchestrator *notices* work; no watch API, no push). Each pipeline stage becomes an agent Job (`sf-<ref>-<stage>-<attempt>`), each gate a gate Job graded from a structured verdict (spec §5/§6). All Request lifecycle changes go through `transitions.apply()` as epoch-fenced MACHINE transitions; Job creation is an external side effect and rides the intent log (spec §3.3). The Kubernetes API sits behind a 3-method `KubeClient` protocol so every test injects a fake — this is AGENTS.md §7's extension pattern (new runner behind `FACTORY_RUNNER`, verified by fake-executor-style gate tests).

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, official `kubernetes` python client (behind the seam, via uv), pytest.

**Spec (binding):** `docs/superpowers/specs/2026-07-14-openshift-kubernetes-architecture-design.md` §4, §5, §6, §9 Phase 1.
**Repo baseline:** main @ 36704f6 (Plan A merged: transitions TABLE + apply(), intent log, leader epochs).

## Global Constraints

- Python deps via `uv add` / `uv run` only — never pip.
- `progress_event` rows are append-only — never UPDATE/DELETE (ADR 0008).
- Single uvicorn worker; the tick loop assumes one process (CLAUDE.md).
- ALL Request state changes go through `transitions.apply()` (16-row TABLE); machine callers pass `epoch=get_elector().epoch`.
- Spec §5 hard lines, copied verbatim: Job names `sf-<ref>-<stage>-<attempt>`; `backoffLimit: 0`; `podFailurePolicy` ignores DisruptionTarget; `activeDeadlineSeconds` **plus** an orchestrator-side wall-clock per (stage, attempt); "completions from non-current attempts are discarded"; the orchestrator owns Job deletion **after log capture**; termination message = small status envelope (4 KB cap), large payloads = NDJSON pod logs; retry-with-feedback N=2 then `needs_human`.
- Spec §6: gate verdict absent = infra failure → gate re-runs **without consuming an attempt or escalating**.
- Concurrent-Job cap (start 10) + oldest-runnable-first fairness (spec §2, §3.6).
- No cluster anywhere in tests: every test runs against `FakeKubeClient` on SQLite.
- All existing tests stay green: `cd api && uv run pytest -q`. `task verify` green before merge.
- Working directory for commands: repo root unless stated; pytest commands run from `api/`.
- Keep `implementation-notes.md` updated: any forced deviation goes under `## Deviations` (conservative option, keep going).

**Out of scope (B2/B3):** real cluster/kind, sf-agent image + entrypoint, kustomize manifests, git-as-workspace, GitHub PR/merge, build/deploy Jobs, steer-note injection into Job prompts. In B1 the merge gate keeps the simulator's `finish_done` behavior.

---

## File structure

| File | Responsibility |
|---|---|
| `api/app/transitions.py` | + `apply_committed()` — apply + commit-on-Win + notify for machine callers |
| `api/app/intents.py` | + declared intent `KINDS` constants; `begin()` validates kind |
| `api/app/startup.py` | `escalate_orphans` becomes leader-only |
| `api/app/routers/system.py` | `POST /api/simulator/tick` becomes leader-only; later drives the kube tick |
| `api/app/settings.py` | + kube knobs (namespace, image, deadlines, wall clocks, attempts, job cap) |
| `api/app/models.py` | + `StageJob` — one row per spawned Job (the re-attach record, spec §3.4) |
| `api/migrations/versions/…_stage_jobs.py` | Alembic revision for `stage_jobs` |
| `api/app/kube_client.py` | `KubeClient` protocol + `JobView` + thin `RealKubeClient` (disposable seam) |
| `api/app/kube_jobs.py` | Pure functions: job names, Job manifests, envelope/NDJSON parsing |
| `api/app/kube_runner.py` | `KubeJobRunner` — tick-driven orchestration (spawn / observe / grade / reap) |
| `api/app/verification.py` | + `payload_from_metrics()` — verdict metrics → the 8-key payload |
| `api/app/main.py`, `api/app/routers/system.py` | wire `FACTORY_RUNNER=kube` |
| `api/tests/fake_kube.py` | `FakeKubeClient` + scripted clusters (the kube analog of the fake executors) |
| `api/tests/test_kube_jobs.py`, `api/tests/test_kube_runner.py`, `api/tests/test_kube_wiring.py` | tests |

### The kube pipeline model (shared vocabulary for every task)

- Kube stages: `KUBE_STAGES = ("architecture", "red", "green", "review")`. They map onto the 3-value `Request.stage` vocabulary via `REQUEST_STAGE = {"architecture": "architecture", "red": "build", "green": "build", "review": "review"}` (`models.PIPELINE_STAGES` is unchanged).
- Per stage, per attempt: one **agent Job** `sf-<ref>-<stage>-<attempt>`, then one **gate Job** `sf-<ref>-<stage>-<attempt>-gate`. A stage is *done* when a gate Job for it has `status="succeeded"`.
- `StageJob` rows are the single durable record: only rows with `status="running"` are ever polled or graded — anything else is a stale attempt and is discarded (spec §5).
- Envelope contract (termination message, JSON, ≤4 KB):
  - agent Job: `{"v": 1, "outcome": "ok"|"fail", "detail": "<str>"}`
  - gate Job: `{"v": 1, "outcome": "pass"|"fail", "reason": "<str>", "surface_hash": "<hex>"|null, "metrics": {...}|null}` — `metrics` carries the six verification numbers on the review gate; `surface_hash` is the frozen-test-surface hash on red/green gates.
- Grading is orchestrator-side and epoch-fenced; the frozen-surface rule: green's gate must report **exactly** the `surface_hash` red's succeeded gate recorded, else the attempt fails with a Test-isolation reason regardless of the (untrusted) gate pod's verdict.

---

### Task 1: `transitions.apply_committed()` — collapse the machine commit-notify idiom

Deferred item from the Plan A ledger; the kube runner uses it everywhere, so it lands first.

**Files:**
- Modify: `api/app/transitions.py` (after `apply()`, ~line 510)
- Modify: `api/app/agent_runner.py:175-193` (`_advance`, `_escalate`), `api/app/agent_runner.py:380-387` (`_review` merge-gate block)
- Modify: `api/app/simulator.py:101-108` (`_escalate`)
- Modify: `api/app/startup.py:48-58` (`escalate_orphans` loop)
- Test: `api/tests/test_transitions.py` (append)

**Interfaces:**
- Produces: `transitions.apply_committed(db, req, transition, *, actor, params=None, intent=None, epoch=None, expected_stage=None) -> Win | Loss`. Semantics: identical to `apply()`, except a `Win` is committed and its post-commit notification fired before returning; a `Loss` has already rolled back. Callers composing sibling writes into one larger transaction keep using `apply()`.
- Tasks 5-7 consume this from `kube_runner.py`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_transitions.py`:

```python
# ---------- apply_committed (Plan B1 task 1) ----------

def test_apply_committed_commits_win_and_fires_notify(client, monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr("app.notifications.notify_escalation",
                        lambda db, req: calls.append(req.id))
    d = approved_request(client, title="apply_committed win")
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        res = transitions.apply_committed(
            db, req, "escalate", actor=transitions.FACTORY,
            params={"reason": "helper witness"}, epoch=get_elector().epoch)
        assert isinstance(res, transitions.Win)
    with SessionLocal() as db:  # durable: a FRESH session sees the committed state
        assert db.get(Request, d["id"]).needs_human is True
    assert calls == [d["id"]]  # notify fired exactly once, after the commit


def test_apply_committed_returns_loss_untouched(client):
    d = approved_request(client, title="apply_committed loss")
    client.post(f"/api/requests/{d['id']}/cancel", json={"operator_id": 1})
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        res = transitions.apply_committed(
            db, req, "escalate", actor=transitions.FACTORY,
            params={"reason": "should lose"}, epoch=get_elector().epoch)
        assert isinstance(res, transitions.Loss)
        assert req.needs_human is False  # rolled back, nothing leaked
```

If `test_transitions.py` does not already import them, add at the top: `from helpers import approved_request`, `from app.db import SessionLocal`, `from app.models import Request`, `from app.leader import get_elector`, `from app import transitions`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_transitions.py -k apply_committed -v`
Expected: FAIL — `AttributeError: module 'app.transitions' has no attribute 'apply_committed'`.

- [ ] **Step 3: Implement the helper**

Append to `api/app/transitions.py`, directly after `apply()`:

```python
def apply_committed(
    db: Session,
    req: Request,
    transition: str,
    *,
    actor: Actor,
    params: dict | None = None,
    intent: IntentSpec | None = None,
    epoch: int | None = None,
    expected_stage: str | None = None,
) -> Win | Loss:
    """apply() for MACHINE callers that own no larger transaction: a Win is
    committed and its post-commit notification fired before returning; a Loss
    has already rolled back. Staged sibling writes ride the same commit.
    Callers composing a bigger transaction keep using apply() directly."""
    res = apply(db, req, transition, actor=actor, params=params, intent=intent,
                epoch=epoch, expected_stage=expected_stage)
    if isinstance(res, Win):
        db.commit()
        res.notify()
    return res
```

- [ ] **Step 4: Run the new tests**

Run: `cd api && uv run pytest tests/test_transitions.py -k apply_committed -v`
Expected: 2 PASS.

- [ ] **Step 5: Refactor the existing call sites**

`api/app/agent_runner.py` — replace `_advance` and `_escalate` bodies:

```python
    def _advance(self, db: Session, req: Request, stage: str) -> bool:
        """Machine transition: epoch-fenced so a deposed leader's thread stops here."""
        res = transitions.apply_committed(db, req, "advance_stage", actor=FACTORY,
                                          params={"stage": stage}, epoch=get_elector().epoch)
        if isinstance(res, transitions.Loss):
            log.info("%s: advance to %s lost (%s) — pipeline stops", req.ref, stage, res.detail)
            return False
        return True

    def _escalate(self, db: Session, req: Request, reason: str) -> None:
        res = transitions.apply_committed(db, req, "escalate", actor=FACTORY,
                                          params={"reason": reason}, epoch=get_elector().epoch)
        if isinstance(res, transitions.Loss):  # a Cancel raced us — it wins, nothing to flag
            log.info("escalation for %s dropped — request is %s", req.ref, req.status)
            return
        log.error("escalated %s: %s", req.ref, reason)
```

`api/app/agent_runner.py` `_review` — replace the final `raise_merge_gate` block (the `res = transitions.apply(...)` through `res.notify()` lines):

```python
        res = transitions.apply_committed(db, req, "raise_merge_gate", actor=FACTORY,
                                          epoch=get_elector().epoch)
        if isinstance(res, transitions.Loss):
            log.info("%s: merge gate raise lost (%s)", req.ref, res.detail)
            return False
        log.info("%s: review committed, verification emitted, merge gate raised", req.ref)
        return True
```

(The staged `emit_verification` event rides `apply_committed`'s commit — same behavior as before: flush-first, commit-on-Win.)

`api/app/simulator.py` — replace `_escalate` body:

```python
def _escalate(db: Session, req: Request, reason: str) -> None:
    db.rollback()
    res = transitions.apply_committed(db, req, "escalate", actor=FACTORY,
                                      params={"reason": reason}, epoch=get_elector().epoch)
    if isinstance(res, transitions.Loss):
        return  # closed (or fenced) meanwhile — nothing to flag
```

`api/app/startup.py` — replace the `escalate_orphans` loop body:

```python
    for r in orphans:
        res = transitions.apply_committed(
            db, r, "escalate", actor=transitions.FACTORY,
            params={"reason": "Pipeline orphaned by a server restart — Retry re-runs the stage"},
            epoch=epoch,
        )
        if isinstance(res, transitions.Loss):
            continue
        log.warning("startup: %s was orphaned mid-%s — escalated for Retry", r.ref, r.stage)
```

Do NOT touch `simulator._tick_request` (it defers commit/notify into the tick loop's batch — a different transaction shape) or any HTTP endpoint (human transitions own their commits).

- [ ] **Step 6: Run the full backend suite**

Run: `cd api && uv run pytest -q`
Expected: all green (the refactor is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add api/app/transitions.py api/app/agent_runner.py api/app/simulator.py api/app/startup.py api/tests/test_transitions.py
git commit -m "refactor(transitions): apply_committed() collapses the machine commit-notify idiom

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Intent KINDS constants + leader-only orphan escalation and tick endpoint

Two more deferred ledger items — cheap here, and the kube runner needs the kind constants.

**Files:**
- Modify: `api/app/intents.py`
- Modify: `api/app/startup.py:38-47` (`escalate_orphans` guard)
- Modify: `api/app/routers/system.py:41-45` (`sim_tick`)
- Modify: `api/tests/test_transitions.py:441` (replace the ad-hoc `"notify_submitter"` kind)
- Test: `api/tests/test_intents.py`, `api/tests/test_leader_wiring.py` (append)

**Interfaces:**
- Produces: `intents.KINDS` tuple and the constants `intents.CREATE_REPO / OPEN_PR / MERGE_PR / TRIGGER_BUILD / APPLY_DEPLOY / SPAWN_STAGE_JOB / SPAWN_GATE_JOB` (plain strings). `intents.begin()` raises `ValueError` on any kind not in `KINDS`.
- Tasks 5-6 consume `SPAWN_STAGE_JOB` / `SPAWN_GATE_JOB`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_intents.py`:

```python
def test_kinds_cover_the_spec_side_effects():
    # spec §3.3's external side effects + Plan B1's job spawning
    assert set(intents.KINDS) == {
        "create_repo", "open_pr", "merge_pr", "trigger_build",
        "apply_deploy", "spawn_stage_job", "spawn_gate_job",
    }


def test_begin_rejects_unknown_kind():
    with SessionLocal() as db:
        with pytest.raises(ValueError):
            intents.begin(db, f"k-{uuid.uuid4().hex}", "mystery_kind", 1, {})
```

Append to `api/tests/test_leader_wiring.py`:

```python
# ---------- leader-only guards (Plan B1 task 2) ----------

def test_escalate_orphans_is_leader_only(client, monkeypatch):
    """A standby replica must never escalate — it re-runs startup chores too."""
    from app import startup
    from app.db import SessionLocal
    from app.leader import LeaderElector
    from helpers import approved_request

    d = approved_request(client, title="Orphan gating")
    monkeypatch.setattr(LeaderElector, "is_leader", lambda self: False)
    with SessionLocal() as db:
        startup.escalate_orphans(db)
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False  # untouched: we were not the leader


def test_sim_tick_endpoint_is_leader_only(client, monkeypatch):
    from app.leader import LeaderElector

    monkeypatch.setattr(LeaderElector, "verify", lambda self: False)
    monkeypatch.setattr(LeaderElector, "try_acquire", lambda self: False)
    out = client.post("/api/simulator/tick").json()
    assert out["moved"] == []
    assert "leader" in out["note"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_intents.py tests/test_leader_wiring.py -v`
Expected: the four new tests FAIL (`KINDS` missing; no `ValueError`; orphan escalated anyway; tick has no `note`). Pre-existing tests stay green.

- [ ] **Step 3: Implement**

`api/app/intents.py` — add below the imports:

```python
# The declared vocabulary of external side effects (spec §3.3 + §5). A kind
# outside this tuple is a programming error, not data — fail loudly at begin().
CREATE_REPO = "create_repo"
OPEN_PR = "open_pr"
MERGE_PR = "merge_pr"
TRIGGER_BUILD = "trigger_build"
APPLY_DEPLOY = "apply_deploy"
SPAWN_STAGE_JOB = "spawn_stage_job"
SPAWN_GATE_JOB = "spawn_gate_job"
KINDS = (CREATE_REPO, OPEN_PR, MERGE_PR, TRIGGER_BUILD, APPLY_DEPLOY,
         SPAWN_STAGE_JOB, SPAWN_GATE_JOB)
```

and make `begin()` start with:

```python
def begin(db: Session, key: str, kind: str, request_id: int, payload: dict) -> Intent | None:
    if kind not in KINDS:
        raise ValueError(f"unknown intent kind {kind!r} — declare it in intents.KINDS")
    row = Intent(key=key, kind=kind, request_id=request_id, payload_json=json.dumps(payload))
    ...  # rest unchanged
```

`api/tests/test_transitions.py:441` — replace `kind="notify_submitter"` with `kind="open_pr"` (the test only needs *a* valid kind).

`api/app/startup.py` — guard `escalate_orphans`:

```python
def escalate_orphans(db: Session) -> None:
    """... (docstring unchanged) ..."""
    elector = get_elector()
    if not elector.is_leader():
        log.info("startup: not the leader — orphan escalation skipped")
        return
    epoch = elector.epoch
    ...  # rest unchanged
```

`api/app/routers/system.py` — replace `sim_tick`:

```python
@router.post("/api/simulator/tick")
def sim_tick(db: Session = Depends(get_db)):
    if runner_mode() == "agent":
        return {"moved": [], "note": "runner=agent — the real agents drive the stages"}
    elector = get_elector()
    if not (elector.verify() or elector.try_acquire()):
        # a manual tick from a standby would advance state with a stale epoch's
        # un-fenced event appends — only the leader ticks (spec §3.2)
        return {"moved": [], "note": "not the leader — tick skipped"}
    return {"moved": simulator.tick(db)}
```

- [ ] **Step 4: Run tests**

Run: `cd api && uv run pytest -q`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add api/app/intents.py api/app/startup.py api/app/routers/system.py api/tests/test_intents.py api/tests/test_leader_wiring.py api/tests/test_transitions.py
git commit -m "feat(intents): declared intent KINDS; leader-only orphan escalation + manual tick

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: kube settings, `kubernetes` dependency, `StageJob` model + migration

**Files:**
- Modify: `api/pyproject.toml` (via `uv add kubernetes`)
- Modify: `api/app/settings.py` (append kube block)
- Modify: `api/app/models.py` (append `StageJob` after `Intent`)
- Create: `api/migrations/versions/7f2a9c4d1e88_stage_jobs.py`
- Test: `api/tests/test_kube_jobs.py` (new file, model part)

**Interfaces:**
- Produces settings: `KUBE_NAMESPACE` (env `FACTORY_KUBE_NAMESPACE`, default `"software-factory"`), `AGENT_IMAGE` (`FACTORY_AGENT_IMAGE`, `"sf-agent:dev"`), `JOB_ACTIVE_DEADLINE` (`FACTORY_JOB_ACTIVE_DEADLINE`, `1800`), `GATE_ACTIVE_DEADLINE` (`FACTORY_GATE_ACTIVE_DEADLINE`, `900`), `STAGE_WALL_CLOCK` (`FACTORY_STAGE_WALL_CLOCK`, `2100`), `GATE_WALL_CLOCK` (`FACTORY_GATE_WALL_CLOCK`, `1200`), `KUBE_MAX_ATTEMPTS` (`FACTORY_MAX_ATTEMPTS`, `2`), `KUBE_JOB_CAP` (`FACTORY_JOB_CAP`, `10`). All ints except the two strings.
- Produces model: `models.StageJob` with columns `id, request_id, stage, attempt, role, job_name, epoch, status, envelope, logs_tail, deadline_at, created_at, completed_at` (exact types below). `job_name` is **indexed, not unique** — an infra re-run recreates the same deterministic name in a new row; "only one running row per name" is a runner invariant, not a DB constraint.

- [ ] **Step 1: Add the dependency**

```bash
cd api && uv add kubernetes
```

Expected: `kubernetes` appears in `api/pyproject.toml` dependencies and `uv.lock` updates. (It is only imported lazily inside `RealKubeClient` — tests never load it.)

- [ ] **Step 2: Write the failing test**

Create `api/tests/test_kube_jobs.py`:

```python
"""Kube building blocks: settings, StageJob rows, names, manifests, envelopes."""
import pytest

from app import settings
from app.db import SessionLocal, migrate
from app.models import StageJob, utcnow


def test_kube_settings_defaults():
    assert settings.KUBE_NAMESPACE == "software-factory"
    assert settings.AGENT_IMAGE == "sf-agent:dev"
    assert settings.STAGE_WALL_CLOCK > settings.JOB_ACTIVE_DEADLINE  # the backstop must outlast the in-cluster kill switch
    assert settings.GATE_WALL_CLOCK > settings.GATE_ACTIVE_DEADLINE
    assert settings.KUBE_MAX_ATTEMPTS == 2   # spec §4.6: one retry-with-feedback
    assert settings.KUBE_JOB_CAP == 10       # spec §2: concurrent-Job cap, start 10


def test_stage_job_row_roundtrip():
    migrate()
    with SessionLocal() as db:
        row = StageJob(request_id=1, stage="red", attempt=1, role="stage",
                       job_name="sf-req-9001-red-1", epoch=3,
                       deadline_at=utcnow())
        db.add(row)
        db.commit()
        got = db.get(StageJob, row.id)
        assert got.status == "running" and got.envelope is None
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_kube_jobs.py -v`
Expected: FAIL — `AttributeError: module 'app.settings' has no attribute 'KUBE_NAMESPACE'` / `ImportError: cannot import name 'StageJob'`.

- [ ] **Step 4: Implement settings**

Append to `api/app/settings.py`:

```python
# ---------- Kubernetes runner (Plan B1, spec §2/§5/§6) ----------
KUBE_NAMESPACE = os.environ.get("FACTORY_KUBE_NAMESPACE", "software-factory")
AGENT_IMAGE = os.environ.get("FACTORY_AGENT_IMAGE", "sf-agent:dev")  # one image for agent AND gate Jobs (spec §5); gates just get no LLM egress/key
# In-cluster kill switch per Job. The ORCHESTRATOR wall clocks below are the
# backstop a partitioned node cannot dodge (spec §5 "Bounds") — they MUST
# exceed the corresponding activeDeadlineSeconds so kubelet gets first shot.
JOB_ACTIVE_DEADLINE = int(os.environ.get("FACTORY_JOB_ACTIVE_DEADLINE", "1800"))
GATE_ACTIVE_DEADLINE = int(os.environ.get("FACTORY_GATE_ACTIVE_DEADLINE", "900"))
STAGE_WALL_CLOCK = int(os.environ.get("FACTORY_STAGE_WALL_CLOCK", "2100"))
GATE_WALL_CLOCK = int(os.environ.get("FACTORY_GATE_WALL_CLOCK", "1200"))
KUBE_MAX_ATTEMPTS = int(os.environ.get("FACTORY_MAX_ATTEMPTS", "2"))  # N=2: one retry-with-feedback, then needs_human (spec §4.6)
KUBE_JOB_CAP = int(os.environ.get("FACTORY_JOB_CAP", "10"))  # concurrent Jobs the orchestrator will run (spec §2)
```

- [ ] **Step 5: Implement the model**

Append to `api/app/models.py`, after the `Intent` class:

```python
class StageJob(Base):
    """One Kubernetes Job the orchestrator spawned (Plan B1; spec §3.4, §5).

    The deterministic job_name is the re-attach key after a leader restart;
    rows are the durable record of every attempt (what ran, what the envelope
    said, why it ended). RUNNER INVARIANT: only rows with status='running' are
    ever polled or graded — a late completion for any other row is a stale
    attempt and is discarded (spec §5). job_name is indexed, not unique: an
    infra re-run legitimately recreates the same name in a fresh row.
    """

    __tablename__ = "stage_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"), index=True)
    stage: Mapped[str] = mapped_column(String(16))        # architecture | red | green | review
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    role: Mapped[str] = mapped_column(String(8))          # stage | gate
    job_name: Mapped[str] = mapped_column(String(63), index=True)  # sf-<ref>-<stage>-<attempt>[-gate]
    epoch: Mapped[int] = mapped_column(Integer, default=0)         # spawning leader's epoch (observability)
    status: Mapped[str] = mapped_column(String(12), default="running")
    # running | succeeded | failed | timed_out | infra | reaped
    envelope: Mapped[dict | None] = mapped_column(JSON, nullable=True)   # parsed termination-message envelope
    logs_tail: Mapped[str | None] = mapped_column(Text, nullable=True)   # captured NDJSON tail (capture BEFORE delete)
    deadline_at: Mapped[datetime] = mapped_column(TZDateTime())          # orchestrator wall clock for this attempt
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
```

- [ ] **Step 6: Write the Alembic revision**

Create `api/migrations/versions/7f2a9c4d1e88_stage_jobs.py` (down_revision = the current head `b71c2e4f9a10`; confirm with `cd api && uv run alembic heads` and adjust if the head moved):

```python
"""stage_jobs — one row per spawned Kubernetes Job (Plan B1, spec §3.4)

Revision ID: 7f2a9c4d1e88
Revises: b71c2e4f9a10
Create Date: 2026-07-15
"""
import sqlalchemy as sa
from alembic import op

revision = "7f2a9c4d1e88"
down_revision = "b71c2e4f9a10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "stage_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("request_id", sa.Integer(), sa.ForeignKey("requests.id"), nullable=False),
        sa.Column("stage", sa.String(16), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("role", sa.String(8), nullable=False),
        sa.Column("job_name", sa.String(63), nullable=False),
        sa.Column("epoch", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(12), nullable=False, server_default="running"),
        sa.Column("envelope", sa.JSON(), nullable=True),
        sa.Column("logs_tail", sa.Text(), nullable=True),
        sa.Column("deadline_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_stage_jobs_request_id", "stage_jobs", ["request_id"])
    op.create_index("ix_stage_jobs_job_name", "stage_jobs", ["job_name"])


def downgrade() -> None:
    op.drop_index("ix_stage_jobs_job_name", table_name="stage_jobs")
    op.drop_index("ix_stage_jobs_request_id", table_name="stage_jobs")
    op.drop_table("stage_jobs")
```

- [ ] **Step 7: Run the tests (incl. the migration suite)**

Run: `cd api && uv run pytest tests/test_kube_jobs.py tests/test_migrations.py -v`
Expected: PASS — the migration test proves the alembic history alone builds the new table.

- [ ] **Step 8: Commit**

```bash
git add api/pyproject.toml api/uv.lock api/app/settings.py api/app/models.py api/migrations/versions/7f2a9c4d1e88_stage_jobs.py api/tests/test_kube_jobs.py
git commit -m "feat(kube): settings block, kubernetes dep, StageJob table + migration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: KubeClient seam, Job manifests, envelope parsing, FakeKubeClient

**Files:**
- Create: `api/app/kube_client.py`
- Create: `api/app/kube_jobs.py`
- Create: `api/tests/fake_kube.py`
- Test: `api/tests/test_kube_jobs.py` (append)

**Interfaces:**
- Produces `kube_client.JobView(name, phase, termination_message="", logs="")` where `phase ∈ {"running","succeeded","failed","absent"}`.
- Produces `kube_client.KubeClient` protocol: `create_job(manifest: dict) -> None`, `get_job(name: str) -> JobView`, `delete_job(name: str) -> None`.
- Produces `kube_jobs`: `KUBE_STAGES`, `REQUEST_STAGE`, `job_name(ref, stage, attempt, *, gate=False) -> str`, `stage_job_manifest(ref, stage, attempt, *, feedback="") -> dict`, `gate_job_manifest(ref, stage, attempt) -> dict`, `parse_envelope(msg: str) -> dict | None`, `ndjson_events(logs: str) -> list[dict]`.
- Produces `fake_kube.FakeKubeClient` (+ `honest_cluster(fake)`, `pass_verdict(...)`, `GOOD_METRICS`, `SURFACE`) — the kube analog of `honest_executor` in `test_agent_runner.py`. Tasks 5-7 consume all of these.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_kube_jobs.py`:

```python
from app.kube_jobs import (
    KUBE_STAGES, REQUEST_STAGE, gate_job_manifest, job_name, ndjson_events,
    parse_envelope, stage_job_manifest,
)


def test_job_name_is_deterministic_and_validated():
    assert job_name("REQ-2045", "red", 1) == "sf-req-2045-red-1"          # spec §5
    assert job_name("REQ-2045", "red", 2, gate=True) == "sf-req-2045-red-2-gate"
    with pytest.raises(ValueError):
        job_name("nope; rm -rf", "red", 1)     # malformed ref never reaches the API
    with pytest.raises(ValueError):
        job_name("REQ-2045", "deploy", 1)      # not a kube stage


def test_stage_manifest_carries_the_spec_hard_lines():
    m = stage_job_manifest("REQ-2045", "green", 2, feedback="RED gate said: tests passed")
    assert m["metadata"]["name"] == "sf-req-2045-green-2"
    labels = m["metadata"]["labels"]
    assert labels["sf/tier"] == "agent" and labels["sf/role"] == "stage"
    assert labels["sf/request"] == "req-2045" and labels["sf/stage"] == "green"
    spec = m["spec"]
    assert spec["backoffLimit"] == 0                                     # retries are DOMAIN decisions
    assert spec["activeDeadlineSeconds"] == settings.JOB_ACTIVE_DEADLINE
    rule = spec["podFailurePolicy"]["rules"][0]
    assert rule["action"] == "Ignore"
    assert rule["onPodConditions"] == [{"type": "DisruptionTarget"}]     # evictions don't consume attempts
    pod = spec["template"]["spec"]
    assert pod["restartPolicy"] == "Never"
    assert pod["automountServiceAccountToken"] is False                  # no SA token (spec §5)
    env = {e["name"]: e["value"] for e in pod["containers"][0]["env"]}
    assert env["SF_GATE_FEEDBACK"] == "RED gate said: tests passed"      # retry-with-feedback (spec §4.6)
    assert env["SF_STAGE"] == "green" and env["SF_ATTEMPT"] == "2"


def test_gate_manifest_differs_where_it_must():
    m = gate_job_manifest("REQ-2045", "red", 1)
    assert m["metadata"]["name"] == "sf-req-2045-red-1-gate"
    assert m["metadata"]["labels"]["sf/role"] == "gate"                  # gate pods get their own egress selector (spec §2)
    assert m["spec"]["activeDeadlineSeconds"] == settings.GATE_ACTIVE_DEADLINE
    env = {e["name"]: e["value"] for e in m["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["SF_ROLE"] == "gate"
    assert "SF_GATE_FEEDBACK" not in env


def test_parse_envelope_and_ndjson_are_tolerant():
    assert parse_envelope('{"v":1,"outcome":"ok","detail":"done"}') == {"v": 1, "outcome": "ok", "detail": "done"}
    assert parse_envelope("") is None
    assert parse_envelope("panic: exit 2") is None                       # garbage = absent verdict = infra
    assert parse_envelope('{"no_outcome": true}') is None
    logs = 'banner line\n{"type":"note","text":"a"}\nnot json\n{"type":"note","text":"b"}\n'
    assert [e["text"] for e in ndjson_events(logs)] == ["a", "b"]


def test_fake_kube_client_roundtrip():
    from fake_kube import FakeKubeClient

    fake = FakeKubeClient()
    fake.create_job(stage_job_manifest("REQ-2045", "architecture", 1))
    assert fake.get_job("sf-req-2045-architecture-1").phase == "running"
    fake.finish("sf-req-2045-architecture-1", {"v": 1, "outcome": "ok", "detail": "done"},
                logs='{"type":"note","text":"hi"}\n')
    view = fake.get_job("sf-req-2045-architecture-1")
    assert view.phase == "succeeded" and parse_envelope(view.termination_message)["outcome"] == "ok"
    fake.delete_job("sf-req-2045-architecture-1")
    assert fake.get_job("sf-req-2045-architecture-1").phase == "absent"
    assert fake.deletions == ["sf-req-2045-architecture-1"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_kube_jobs.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.kube_jobs'`.

- [ ] **Step 3: Implement `api/app/kube_client.py`**

```python
"""The Kubernetes seam (Plan B1; spec §5): everything cluster-shaped behind a
3-method protocol so the entire runner is testable with a fake — no kind, no
cluster, no kubeconfig in tests.

RealKubeClient is deliberately THIN (AGENTS.md: deterministic seams are
disposable, the domain model is not): it maps the protocol onto the official
client and holds zero domain logic. The `kubernetes` import is lazy — only a
process actually running FACTORY_RUNNER=kube ever pays it.
"""
from dataclasses import dataclass
from typing import Protocol

from . import settings


@dataclass
class JobView:
    """One observation of a Job: phase + the two capture channels (spec §5) —
    the ≤4KB termination-message envelope and the NDJSON pod logs."""
    name: str
    phase: str                     # "running" | "succeeded" | "failed" | "absent"
    termination_message: str = ""
    logs: str = ""


class KubeClient(Protocol):
    def create_job(self, manifest: dict) -> None: ...
    def get_job(self, name: str) -> JobView: ...
    def delete_job(self, name: str) -> None: ...


class RealKubeClient:
    """Official python client; in-cluster config first, kubeconfig fallback."""

    def __init__(self, namespace: str = settings.KUBE_NAMESPACE):
        from kubernetes import client, config  # lazy: see module docstring
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        self.ns = namespace
        self._batch = client.BatchV1Api()
        self._core = client.CoreV1Api()
        self._ApiException = client.exceptions.ApiException

    def create_job(self, manifest: dict) -> None:
        try:
            self._batch.create_namespaced_job(self.ns, manifest)
        except self._ApiException as e:
            if e.status != 409:  # already exists = an intent replay — idempotent by design
                raise

    def get_job(self, name: str) -> JobView:
        try:
            job = self._batch.read_namespaced_job(name, self.ns)
        except self._ApiException as e:
            if e.status == 404:
                return JobView(name=name, phase="absent")
            raise
        s = job.status
        phase = "succeeded" if s.succeeded else "failed" if s.failed else "running"
        term, logs = "", ""
        if phase != "running":
            pods = self._core.list_namespaced_pod(
                self.ns, label_selector=f"job-name={name}").items
            if pods:
                pod = pods[-1]
                for cs in (pod.status.container_statuses or []):
                    t = cs.state.terminated
                    if t and t.message:
                        term = t.message
                try:
                    logs = self._core.read_namespaced_pod_log(pod.metadata.name, self.ns)
                except self._ApiException:
                    logs = ""  # missing logs surface upstream as a capture failure
        return JobView(name=name, phase=phase, termination_message=term, logs=logs)

    def delete_job(self, name: str) -> None:
        try:
            self._batch.delete_namespaced_job(name, self.ns, propagation_policy="Foreground")
        except self._ApiException as e:
            if e.status != 404:  # already gone — deletion is idempotent
                raise
```

- [ ] **Step 4: Implement `api/app/kube_jobs.py`**

```python
"""Factory-owned Job manifests + output parsing (Plan B1; spec §5, §6).

Pure functions — no I/O, no DB — so every hard line is unit-testable:
  * deterministic names sf-<ref>-<stage>-<attempt> (gate Jobs add "-gate");
  * backoffLimit 0 — retries are DOMAIN decisions, never kubelet ones;
  * podFailurePolicy ignores DisruptionTarget — an eviction must not consume
    an attempt;
  * activeDeadlineSeconds as the in-cluster kill switch UNDER the
    orchestrator's wall clock;
  * no ServiceAccount token in any pod.

Envelope contract (termination message, JSON, kernel-capped at 4 KB):
  agent Job:  {"v": 1, "outcome": "ok"|"fail", "detail": str}
  gate Job:   {"v": 1, "outcome": "pass"|"fail", "reason": str,
               "surface_hash": str|null, "metrics": {...}|null}
Large payloads (review summaries, test reports) travel as NDJSON pod logs,
captured by the orchestrator BEFORE Job deletion (spec §5).
"""
import json
import re

from . import settings

KUBE_STAGES = ("architecture", "red", "green", "review")
# a kube stage maps onto the Request.stage vocabulary (models.PIPELINE_STAGES)
REQUEST_STAGE = {"architecture": "architecture", "red": "build", "green": "build", "review": "review"}

_FEEDBACK_CAP = 2000  # env-var payload, not a transcript — the gate's verdict reason only


def job_name(ref: str, stage: str, attempt: int, *, gate: bool = False) -> str:
    """sf-<ref>-<stage>-<attempt>[-gate] (spec §5) — validated so a malformed
    ref can never reach the Kubernetes API as an object name."""
    if not re.fullmatch(r"REQ-\d+", ref or ""):
        raise ValueError(f"refusing job name for malformed ref {ref!r}")
    if stage not in KUBE_STAGES:
        raise ValueError(f"unknown kube stage {stage!r}")
    name = f"sf-{ref.lower()}-{stage}-{int(attempt)}"
    return f"{name}-gate" if gate else name


def _base_job(name: str, *, role: str, ref: str, stage: str, attempt: int,
              deadline: int, env: dict) -> dict:
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "labels": {
                "sf/tier": "agent",
                "sf/role": role,  # stage vs gate pods get different egress selectors (spec §2)
                "sf/request": ref.lower(),
                "sf/stage": stage,
                "sf/attempt": str(attempt),
            },
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": deadline,
            "podFailurePolicy": {
                "rules": [
                    {"action": "Ignore", "onPodConditions": [{"type": "DisruptionTarget"}]},
                ],
            },
            "template": {
                "metadata": {"labels": {"sf/tier": "agent", "sf/role": role,
                                        "sf/request": ref.lower()}},
                "spec": {
                    "restartPolicy": "Never",
                    "automountServiceAccountToken": False,
                    "containers": [{
                        "name": "main",
                        "image": settings.AGENT_IMAGE,
                        "env": [{"name": k, "value": str(v)} for k, v in env.items()],
                        "resources": {
                            "requests": {"cpu": "500m", "memory": "1Gi"},
                            "limits": {"cpu": "2", "memory": "4Gi"},
                        },
                        "terminationMessagePolicy": "File",  # the envelope channel
                    }],
                },
            },
        },
    }


def stage_job_manifest(ref: str, stage: str, attempt: int, *, feedback: str = "") -> dict:
    env = {"SF_REF": ref, "SF_STAGE": stage, "SF_ATTEMPT": attempt, "SF_ROLE": "stage"}
    if feedback:
        env["SF_GATE_FEEDBACK"] = feedback[:_FEEDBACK_CAP]  # retry-with-feedback (spec §4.6)
    return _base_job(job_name(ref, stage, attempt), role="stage", ref=ref, stage=stage,
                     attempt=attempt, deadline=settings.JOB_ACTIVE_DEADLINE, env=env)


def gate_job_manifest(ref: str, stage: str, attempt: int) -> dict:
    env = {"SF_REF": ref, "SF_STAGE": stage, "SF_ATTEMPT": attempt, "SF_ROLE": "gate"}
    return _base_job(job_name(ref, stage, attempt, gate=True), role="gate", ref=ref,
                     stage=stage, attempt=attempt,
                     deadline=settings.GATE_ACTIVE_DEADLINE, env=env)


def parse_envelope(msg: str) -> dict | None:
    """The termination-message status envelope. None = absent or garbled —
    for a gate Job that means INFRA failure, never a verdict (spec §6)."""
    try:
        env = json.loads(msg or "")
    except json.JSONDecodeError:
        return None
    return env if isinstance(env, dict) and "outcome" in env else None


def ndjson_events(logs: str) -> list[dict]:
    """Structured NDJSON events out of a pod log, tolerant of banner noise."""
    out: list[dict] = []
    for line in (logs or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(ev, dict):
            out.append(ev)
    return out
```

- [ ] **Step 5: Implement `api/tests/fake_kube.py`**

```python
"""FakeKubeClient — the whole cluster in a dict, so every kube-runner test runs
without kind or a cluster. Scripted like the fake executors in
test_agent_runner.py: `on_observe` (if set) decides what a running job does the
next time the orchestrator polls it; `finish()` drives a job by hand."""
import json
from dataclasses import dataclass, field

from app.kube_client import JobView

# a consistent frozen-test-surface hash + healthy review metrics for honest runs
SURFACE = "a" * 64
GOOD_METRICS = {
    "tests_passed": 3, "tests_total": 3, "diff_added": 40, "diff_removed": 2,
    "files_changed": 2, "reviewer_verdict": "APPROVE — implements the spec",
}


def pass_verdict(*, surface_hash: str = SURFACE, metrics: dict | None = None) -> dict:
    return {"v": 1, "outcome": "pass", "reason": "gate green",
            "surface_hash": surface_hash, "metrics": metrics or dict(GOOD_METRICS)}


def fail_verdict(reason: str) -> dict:
    return {"v": 1, "outcome": "fail", "reason": reason, "surface_hash": None, "metrics": None}


def stage_ok(detail: str = "stage complete") -> dict:
    return {"v": 1, "outcome": "ok", "detail": detail}


@dataclass
class FakeJob:
    manifest: dict
    phase: str = "running"
    termination_message: str = ""
    logs: str = ""
    deleted: bool = False


@dataclass
class FakeKubeClient:
    jobs: dict[str, FakeJob] = field(default_factory=dict)
    creations: list[dict] = field(default_factory=list)
    deletions: list[str] = field(default_factory=list)
    observations: list[str] = field(default_factory=list)
    on_observe = None  # callable(name: str, job: FakeJob) -> None

    def create_job(self, manifest: dict) -> None:
        name = manifest["metadata"]["name"]
        existing = self.jobs.get(name)
        assert existing is None or existing.deleted, f"duplicate live job {name}"
        self.jobs[name] = FakeJob(manifest=manifest)
        self.creations.append(manifest)

    def get_job(self, name: str) -> JobView:
        self.observations.append(name)
        job = self.jobs.get(name)
        if job is None or job.deleted:
            return JobView(name=name, phase="absent")
        if self.on_observe:
            self.on_observe(name, job)
        return JobView(name=name, phase=job.phase,
                       termination_message=job.termination_message, logs=job.logs)

    def delete_job(self, name: str) -> None:
        self.deletions.append(name)
        job = self.jobs.get(name)
        if job:
            job.deleted = True

    # ---------- test drivers ----------
    def finish(self, name: str, envelope: dict, *, phase: str = "succeeded", logs: str = "") -> None:
        job = self.jobs[name]
        assert not job.deleted, f"finishing a deleted job {name}"
        job.phase = phase
        job.termination_message = json.dumps(envelope)
        job.logs = logs


def _complete(job: FakeJob, envelope: dict) -> None:
    job.phase = "succeeded"
    job.termination_message = json.dumps(envelope)
    job.logs = '{"type":"note","text":"ndjson line"}\n'


def honest_cluster(fake: FakeKubeClient) -> None:
    """Every agent Job succeeds; every gate passes with consistent hashes and
    healthy review metrics — the kube analog of honest_executor."""
    def run(name: str, job: FakeJob) -> None:
        if job.phase != "running":
            return
        _complete(job, pass_verdict() if name.endswith("-gate") else stage_ok())
    fake.on_observe = run
```

- [ ] **Step 6: Run the tests**

Run: `cd api && uv run pytest tests/test_kube_jobs.py -v`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add api/app/kube_client.py api/app/kube_jobs.py api/tests/fake_kube.py api/tests/test_kube_jobs.py
git commit -m "feat(kube): KubeClient seam, factory-owned Job manifests, envelope parsing, FakeKubeClient

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: KubeJobRunner — spawn / observe / grade, happy path to the merge gate

**Files:**
- Create: `api/app/kube_runner.py`
- Modify: `api/app/verification.py` (append `payload_from_metrics`)
- Test: `api/tests/test_kube_runner.py` (new file)

**Interfaces:**
- Produces `KubeJobRunner(client: KubeClient | None = None)` with `tick(db: Session) -> list[str]`. `client=None` lazily constructs `RealKubeClient` on first use (never at import or app startup).
- Produces `verification.payload_from_metrics(req, metrics: dict) -> dict` — shapes a gate verdict's six metrics through the one 8-key payload builder.
- Task 6 extends `kube_runner.py`'s failure paths (they are written here in full; task 6 adds their witness tests). Task 7 wires `tick` into the app.

- [ ] **Step 1: Write the failing happy-path test**

Create `api/tests/test_kube_runner.py`:

```python
"""KubeJobRunner tests — FakeKubeClient stands in for the cluster, so these
prove the ORCHESTRATOR's guarantees (spawn/observe/grade/reap, gates,
escalation, fencing), not any container. The kube reimplementation of the four
AGENTS.md §7 witness behaviors lives here."""
import pytest
from fake_kube import (
    GOOD_METRICS, SURFACE, FakeKubeClient, fail_verdict, honest_cluster,
    pass_verdict, stage_ok,
)
from helpers import approved_request
from sqlalchemy import select

from app import settings, transitions
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import Request, StageJob


def make_runner() -> tuple[KubeJobRunner, FakeKubeClient]:
    fake = FakeKubeClient()
    return KubeJobRunner(client=fake), fake


def tick_until(client, runner, rid: int, pred, limit: int = 40):
    """Drive the tick loop until pred(request_json) — the kube runner is
    tick-driven (spec §4): nothing advances without a tick."""
    out = client.get(f"/api/requests/{rid}").json()
    for _ in range(limit):
        if pred(out):
            return out
        with SessionLocal() as db:
            runner.tick(db)
        out = client.get(f"/api/requests/{rid}").json()
    raise AssertionError(f"condition not reached after {limit} ticks: {out}")


def _approved(client, title):
    return approved_request(
        client, title=title,
        description="Add a monthly_export function that returns the export format name.")


def test_full_pipeline_to_merge_gate(client):
    runner, fake = make_runner()
    honest_cluster(fake)
    d = _approved(client, "Kube happy path")

    out = tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")
    assert out["stage"] == "review" and not out["needs_human"]

    ref = out["ref"].lower()
    # every stage ran as agent Job + gate Job, attempt 1, deterministic names (spec §5)
    names = [m["metadata"]["name"] for m in fake.creations]
    assert names == [
        f"sf-{ref}-architecture-1", f"sf-{ref}-architecture-1-gate",
        f"sf-{ref}-red-1", f"sf-{ref}-red-1-gate",
        f"sf-{ref}-green-1", f"sf-{ref}-green-1-gate",
        f"sf-{ref}-review-1", f"sf-{ref}-review-1-gate",
    ]
    # the orchestrator owns the full Job lifecycle: everything it created it deleted (spec §5)
    assert sorted(fake.deletions) == sorted(names)

    # feed parity: the same milestone shape the other runners emit
    titles = [e["title"] for e in client.get("/api/events", params={"request_id": d["id"]}).json()]
    assert any(t.startswith("Architecture plan committed") for t in titles)
    assert any(t.startswith("RED: failing tests authored") for t in titles)
    assert any("touched no test files" in t for t in titles)
    assert any("merge gate" in t for t in titles)

    with SessionLocal() as db:
        rows = db.scalars(select(StageJob).where(StageJob.request_id == d["id"])).all()
        assert len(rows) == 8 and all(r.status == "succeeded" for r in rows)
        assert all(r.logs_tail for r in rows)  # logs captured BEFORE deletion
        # spawning was intent-logged and completed
        from app.models import Intent
        intents_rows = db.scalars(select(Intent).where(Intent.request_id == d["id"])).all()
        assert len(intents_rows) == 8 and all(i.status == "done" for i in intents_rows)

    # the human merge gate still closes the loop (B1: simulator finish_done path)
    done = client.post(f"/api/requests/{d['id']}/approve", json={"operator_id": 1}).json()
    assert done["status"] == "done" and done["stage"] == "done"


def test_review_gate_metrics_become_merge_evidence(client):
    from app import supervision

    runner, fake = make_runner()
    honest_cluster(fake)
    d = _approved(client, "Kube verification evidence")
    tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")

    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        ev = supervision.evidence(db, req)
    assert ev is not None and ev["kind"] == "merge"
    assert ev["tests_passed"] == GOOD_METRICS["tests_passed"]
    assert ev["tests_total"] == GOOD_METRICS["tests_total"]
    assert ev["files_changed"] == GOOD_METRICS["files_changed"]
    assert "APPROVE" in (ev["reviewer_verdict"] or "")


def test_review_escalates_when_gate_reports_no_evidence(client):
    """A green suite with no tests or an empty diff is not honest evidence —
    the merge gate must not be raised on it (mirrors the AgentRunner guard)."""
    runner, fake = make_runner()

    def run(name, job):
        if job.phase != "running":
            return
        if name.endswith("-gate") and "-review-" in name:
            v = pass_verdict(metrics={**GOOD_METRICS, "tests_total": 0, "tests_passed": 0})
        elif name.endswith("-gate"):
            v = pass_verdict()
        else:
            v = stage_ok()
        import json as _json
        job.phase = "succeeded"
        job.termination_message = _json.dumps(v)
    fake.on_observe = run

    d = _approved(client, "Kube empty evidence")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    assert "Verification could not be built" in out["needs_human_reason"]
    assert out["gate"] != "approve_merge"


def test_fairness_and_job_cap(client, monkeypatch):
    """Oldest-runnable-first under the concurrent-Job cap (spec §2, §3.6)."""
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 1)
    runner, fake = make_runner()  # nothing completes: jobs stay running
    a = _approved(client, "Kube fairness A")
    b = _approved(client, "Kube fairness B")
    with SessionLocal() as db:
        runner.tick(db)
        runner.tick(db)
    spawned = [m["metadata"]["name"] for m in fake.creations]
    assert len(spawned) == 1                       # the cap held across ticks
    assert f"sf-{a['ref'].lower()}-" in spawned[0]  # and the OLDEST request won
    assert b["ref"]  # (b exists, still queued)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_kube_runner.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.kube_runner'`.

- [ ] **Step 3: Add the verification helper**

Append to `api/app/verification.py`:

```python
def payload_from_metrics(req: Request, metrics: dict) -> dict:
    """Kube path (Plan B1): the review GATE Job's verdict carries the six
    metrics (spec §6); shape them through the one payload builder so the
    contract with supervision.evidence() cannot drift here either."""
    return _payload(
        req,
        tests_passed=int(metrics.get("tests_passed") or 0),
        tests_total=int(metrics.get("tests_total") or 0),
        diff_added=int(metrics.get("diff_added") or 0),
        diff_removed=int(metrics.get("diff_removed") or 0),
        files_changed=int(metrics.get("files_changed") or 0),
        reviewer_verdict=str(metrics.get("reviewer_verdict") or "no review")[:120],
    )
```

- [ ] **Step 4: Implement `api/app/kube_runner.py` (complete file — failure paths included; task 6 adds their witness tests)**

```python
"""KubeJobRunner — pipeline stages as Kubernetes Jobs (Plan B1; spec §4-§6).

FACTORY_RUNNER=kube. The factory stays a DB state machine driven by the
leader's tick: nothing pushes work — each tick the runner *notices* runnable
requests and running Jobs and advances them one step (spec §4; poll from the
tick loop, no watch API). All Request lifecycle writes go through
transitions.apply()/apply_committed() as MACHINE transitions (epoch-fenced);
Job creation is an external side effect and rides the intent log (spec §3.3).

Orchestrator-owned hard lines (spec §5/§6):
  * wall clock per (stage, attempt) — a partitioned node cannot strand a request;
  * only StageJob rows with status='running' are ever polled or graded — late
    completions of superseded attempts are discarded;
  * the orchestrator owns Job deletion, ALWAYS after capturing envelope + logs;
  * gate verdict absent = infra failure: the gate re-runs, no attempt consumed,
    no escalation;
  * frozen surface: green's gate must report exactly the surface_hash red's
    succeeded gate recorded — a weakened test surface fails the attempt even
    when the (untrusted) gate pod claims a pass;
  * a failed attempt retries ONCE with the gate's reason as feedback
    (KUBE_MAX_ATTEMPTS=2), then escalates. Human Retry grants exactly one
    fresh attempt (attempts only ever increment — names stay unique).

Tick order matters: reap (cancel wins) → observe running Jobs → spawn next
work oldest-first under the Job cap.
"""
import logging
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import intents, settings, transitions, verification
from .events import emit
from .kube_client import KubeClient
from .kube_jobs import (
    KUBE_STAGES, REQUEST_STAGE, gate_job_manifest, job_name, parse_envelope,
    stage_job_manifest,
)
from .leader import get_elector
from .models import PIPELINE_STAGES, Request, StageJob, utcnow
from .transitions import FACTORY, IntentSpec

log = logging.getLogger("factory.kube")

LOGS_TAIL = 20_000  # chars of captured NDJSON persisted per Job

# feed parity with AgentRunner's milestone texts (test_agent_runner asserts these prefixes)
MILESTONES = {
    "architecture": ("Architecture plan committed — graded at the pinned SHA",
                     {"Gate": "Architecture · passed", "Agent": "Factory agent"}),
    "red": ("RED: failing tests authored — fail for the right reason",
            {"Gate": "RED · passed", "Agent": "Factory agent"}),
    "green": ("GREEN: gate passed; implementer touched no test files",
              {"Gate": "GREEN + Test-isolation · passed", "Agent": "Factory agent"}),
    "review": ("Review report committed — graded at the pinned SHA",
               {"Artifacts": "review summary", "Agent": "Factory agent"}),
}


class KubeJobRunner:
    def __init__(self, client: KubeClient | None = None):
        self._client = client

    @property
    def client(self) -> KubeClient:
        if self._client is None:  # first USE, never import/startup: tests and sim mode never pay kubeconfig loading
            from .kube_client import RealKubeClient
            self._client = RealKubeClient()
        return self._client

    # ---------- tick ----------
    def tick(self, db: Session) -> list[str]:
        moved: list[str] = []
        self._reap_dead_requests(db, moved)
        for sj in db.scalars(select(StageJob).where(StageJob.status == "running")
                             .order_by(StageJob.id)).all():
            req = db.get(Request, sj.request_id)
            try:
                self._observe(db, req, sj, moved)
            except Exception as exc:  # one broken Job stalls only its request (ADR 0013)
                log.exception("kube observe failed for %s", sj.job_name)
                db.rollback()
                self._escalate(db, req, f"Job observation failed for {sj.job_name}: {exc}")
        running = db.scalars(select(StageJob).where(StageJob.status == "running")).all()
        busy = {r.request_id for r in running}
        capacity = settings.KUBE_JOB_CAP - len(running)
        runnable = db.scalars(
            select(Request)
            .where(Request.status == transitions.APPROVED, ~Request.needs_human,
                   Request.gate.is_(None), Request.stage.in_(PIPELINE_STAGES))
            .order_by(Request.id)  # oldest-runnable-first fairness (spec §3.6)
        ).all()
        for req in runnable:
            if capacity <= 0:
                break
            if req.id in busy:
                continue
            try:
                if self._spawn_next(db, req, moved):
                    capacity -= 1
            except Exception as exc:
                log.exception("kube spawn failed for %s", req.ref)
                db.rollback()
                self._escalate(db, req, f"Pipeline spawn failed: {exc}")
        return moved

    # ---------- reap: cancel (or any exit from the runnable set) wins ----------
    def _reap_dead_requests(self, db: Session, moved: list[str]) -> None:
        """Running Jobs of non-runnable requests are captured, deleted, closed
        (spec §4 'Cancel wins'). Capture still precedes deletion — a cancelled
        run's logs are evidence too."""
        for sj in db.scalars(select(StageJob).where(StageJob.status == "running")).all():
            req = db.get(Request, sj.request_id)
            if req and req.status == transitions.APPROVED and not req.needs_human:
                continue
            view = self.client.get_job(sj.job_name)
            sj.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
            sj.envelope = parse_envelope(view.termination_message)
            self.client.delete_job(sj.job_name)
            sj.status = "reaped"
            sj.completed_at = utcnow()
            db.commit()
            moved.append(f"{req.ref if req else sj.request_id}: reaped {sj.job_name}")

    # ---------- observe one running Job ----------
    def _observe(self, db: Session, req: Request, sj: StageJob, moved: list[str]) -> None:
        view = self.client.get_job(sj.job_name)
        now = utcnow()
        if view.phase == "running":
            if now < sj.deadline_at:
                return
            # orchestrator wall clock (spec §5): fires regardless of Job status —
            # a partitioned node cannot strand the request
            self.client.delete_job(sj.job_name)
            sj.status = "timed_out"
            sj.completed_at = now
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} exceeded its wall clock")
            self._after_failure(db, req, sj,
                                f"{sj.stage} {sj.role} Job exceeded its wall clock (attempt {sj.attempt})",
                                moved)
            return
        if view.phase == "absent":
            # vanished under us (external deletion / create replay that never landed):
            # infra, not a domain failure — the same attempt re-runs
            sj.status = "infra"
            sj.completed_at = now
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} vanished — will re-run")
            return
        # terminal: capture BEFORE deletion — the orchestrator owns the Job
        # lifecycle and never loses an outcome (spec §5, §8)
        envelope = parse_envelope(view.termination_message)
        sj.envelope = envelope
        sj.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
        self.client.delete_job(sj.job_name)
        sj.completed_at = now
        if sj.role == "gate":
            self._grade(db, req, sj, view.phase, envelope, moved)
        else:
            self._finish_stage_job(db, req, sj, view.phase, envelope, moved)

    def _finish_stage_job(self, db: Session, req: Request, sj: StageJob,
                          phase: str, envelope: dict | None, moved: list[str]) -> None:
        if phase == "succeeded" and envelope is None:
            # log/envelope-capture failure is its own escalation reason (spec §5)
            sj.status = "infra"
            db.commit()
            self._escalate(db, req,
                           f"Stage output could not be captured for {sj.job_name} — envelope missing")
            moved.append(f"{req.ref}: escalated — capture failed for {sj.job_name}")
            return
        if phase == "succeeded" and envelope.get("outcome") == "ok":
            sj.status = "succeeded"
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} succeeded")
            self._spawn_gate(db, req, sj.stage, sj.attempt, moved)
            return
        sj.status = "failed"
        db.commit()
        detail = (envelope or {}).get("detail") or f"agent Job {sj.job_name} failed"
        self._after_failure(db, req, sj, detail, moved)

    # ---------- grade a gate verdict (orchestrator-side, trusted) ----------
    def _grade(self, db: Session, req: Request, sj: StageJob,
               phase: str, envelope: dict | None, moved: list[str]) -> None:
        if envelope is None:
            # absent verdict = INFRA failure: re-run, no attempt consumed,
            # no escalation (spec §6)
            sj.status = "infra"
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} produced no verdict — gate re-runs")
            return
        verdict = envelope.get("outcome")
        if verdict == "pass" and sj.stage == "green":
            red = db.scalar(
                select(StageJob)
                .where(StageJob.request_id == req.id, StageJob.stage == "red",
                       StageJob.role == "gate", StageJob.status == "succeeded")
                .order_by(StageJob.id.desc()))
            red_hash = (red.envelope or {}).get("surface_hash") if red else None
            if not red_hash or envelope.get("surface_hash") != red_hash:
                # the load-bearing rule, enforced on the RECORD the trusted side
                # holds — an untrusted gate pod's "pass" cannot override it
                verdict = "fail"
                envelope = {**envelope, "reason":
                            "Test-isolation gate: the frozen test surface changed after RED — change rejected"}
                sj.envelope = envelope
        if verdict == "pass" and sj.stage == "review":
            # evidence that can't be derived would be a lie — treat it as a
            # gate failure (retry machinery, then a human) rather than raising
            # a blind merge gate OR dead-ending a later Retry
            payload = verification.payload_from_metrics(req, envelope.get("metrics") or {})
            if payload["tests_total"] == 0 or payload["files_changed"] == 0:
                verdict = "fail"
                envelope = {**envelope, "reason":
                            "Verification could not be built — the review gate reported no test/diff evidence"}
                sj.envelope = envelope
        if verdict != "pass":
            sj.status = "failed"
            db.commit()
            self._after_failure(db, req, sj,
                                envelope.get("reason") or f"{sj.stage} gate failed", moved)
            return
        sj.status = "succeeded"
        title, fields = MILESTONES[sj.stage]
        emit(db, req, "milestone_summary", title, payload={"fields": fields, "Ref": req.ref})
        db.commit()
        moved.append(f"{req.ref}: {sj.stage} gate passed")
        if sj.stage == "review":
            self._finish_review(db, req, envelope, moved)

    def _finish_review(self, db: Session, req: Request, envelope: dict, moved: list[str]) -> None:
        # metrics were validated in _grade before the verdict counted as a pass
        payload = verification.payload_from_metrics(req, envelope.get("metrics") or {})
        verification.emit_verification(db, req, payload=payload)
        res = transitions.apply_committed(db, req, "raise_merge_gate", actor=FACTORY,
                                          epoch=get_elector().epoch)
        if isinstance(res, transitions.Loss):
            log.info("%s: merge gate raise lost (%s)", req.ref, res.detail)
            return
        moved.append(f"{req.ref}: merge gate raised")

    # ---------- failure policy: retry-with-feedback (N=2), then a human ----------
    def _after_failure(self, db: Session, req: Request, sj: StageJob,
                       reason: str, moved: list[str]) -> None:
        if sj.attempt >= settings.KUBE_MAX_ATTEMPTS:
            self._escalate(db, req, f"{sj.stage} failed after {sj.attempt} attempts: {reason}")
            moved.append(f"{req.ref}: escalated at {sj.stage}")
            return
        # every attempt is an event (spec §5) — the next tick spawns attempt+1
        # with this reason injected as feedback
        emit(db, req, "milestone_summary",
             f"Attempt {sj.attempt} failed at {sj.stage} — retrying with the gate's feedback",
             payload={"Ref": req.ref, "stage": sj.stage, "attempt": sj.attempt,
                      "reason": reason[:300]})
        db.commit()
        moved.append(f"{req.ref}: {sj.stage} attempt {sj.attempt} failed — retry queued")

    def _escalate(self, db: Session, req: Request, reason: str) -> None:
        res = transitions.apply_committed(db, req, "escalate", actor=FACTORY,
                                          params={"reason": reason}, epoch=get_elector().epoch)
        if isinstance(res, transitions.Loss):  # a Cancel raced us — it wins
            log.info("escalation for %s dropped — %s", req.ref, res.detail)
            return
        log.error("escalated %s: %s", req.ref, reason)

    # ---------- decide + spawn the next Job for a runnable request ----------
    def _next_work(self, db: Session, req: Request):
        """What to spawn right now, derived ONLY from StageJob rows — the
        durable record a recovering leader re-attaches to (spec §3.4).
        Returns ("stage", kube_stage, attempt, feedback) | ("gate", kube_stage,
        attempt) | None (busy, or waiting at the merge gate)."""
        for stage in KUBE_STAGES:
            rows = db.scalars(
                select(StageJob)
                .where(StageJob.request_id == req.id, StageJob.stage == stage)
                .order_by(StageJob.attempt, StageJob.id)).all()
            if any(r.role == "gate" and r.status == "succeeded" for r in rows):
                continue  # stage fully graded — look at the next one
            if not rows:
                return ("stage", stage, 1, "")
            if any(r.status == "running" for r in rows):
                return None  # the observe pass owns it
            attempt = max(r.attempt for r in rows)
            latest = [r for r in rows if r.attempt == attempt]
            stage_row = next((r for r in latest if r.role == "stage"), None)
            gate_row = next((r for r in reversed(latest) if r.role == "gate"), None)
            if gate_row is not None and gate_row.status == "infra":
                return ("gate", stage, attempt)   # verdict absent: re-run, attempt kept (spec §6)
            if stage_row is not None and stage_row.status == "succeeded" and gate_row is None:
                return ("gate", stage, attempt)   # crashed between stage success and gate spawn
            if stage_row is not None and stage_row.status == "infra":
                return ("stage", stage, attempt, "")  # Job vanished/never landed: same attempt
            # failed / timed_out / reaped → next attempt (escalation, if due,
            # already happened at failure time; a human Retry cleared it)
            return ("stage", stage, attempt + 1, self._feedback(rows))
        return None  # every stage graded — review grading raised the merge gate

    @staticmethod
    def _feedback(rows: list[StageJob]) -> str:
        for r in reversed(rows):
            if r.status in ("failed", "timed_out"):
                env = r.envelope or {}
                return (env.get("reason") or env.get("detail")
                        or f"{r.stage} attempt {r.attempt} {r.status}")
        return ""

    def _spawn_next(self, db: Session, req: Request, moved: list[str]) -> bool:
        work = self._next_work(db, req)
        if work is None:
            return False
        if work[0] == "stage":
            _, stage, attempt, feedback = work
            return self._spawn_stage(db, req, stage, attempt, feedback, moved)
        _, stage, attempt = work
        return self._spawn_gate(db, req, stage, attempt, moved)

    def _spawn_stage(self, db: Session, req: Request, stage: str, attempt: int,
                     feedback: str, moved: list[str]) -> bool:
        name = job_name(req.ref, stage, attempt)
        # the fenced CAS + intent + StageJob row + heartbeat event land in ONE
        # transaction (spec §3.3); the external create happens after commit
        res = transitions.apply(
            db, req, "advance_stage", actor=FACTORY,
            params={"stage": REQUEST_STAGE[stage]},
            epoch=get_elector().epoch,
            intent=IntentSpec(key=f"spawn:{name}", kind=intents.SPAWN_STAGE_JOB,
                              payload={"job": name, "attempt": attempt}),
        )
        if isinstance(res, transitions.Loss):
            log.info("%s: spawn of %s lost (%s)", req.ref, name, res.detail)
            return False
        db.add(StageJob(request_id=req.id, stage=stage, attempt=attempt, role="stage",
                        job_name=name, epoch=get_elector().epoch,
                        deadline_at=utcnow() + timedelta(seconds=settings.STAGE_WALL_CLOCK)))
        emit(db, req, "step_summary",
             f"{stage} agent Job spawned — attempt {attempt} ({name})",
             payload={"step": 1, "of": 2, "label": f"{stage} agent running",
                      "Ref": req.ref, "job": name, "attempt": attempt,
                      "with_feedback": bool(feedback)})
        db.commit()
        return self._create(db, req, name,
                            stage_job_manifest(req.ref, stage, attempt, feedback=feedback),
                            moved)

    def _spawn_gate(self, db: Session, req: Request, stage: str, attempt: int,
                    moved: list[str]) -> bool:
        name = job_name(req.ref, stage, attempt, gate=True)
        # No Request-lifecycle CAS fits "spawn a gate" (the stage column does
        # not move). The epoch fence bites at GRADING instead: a stale leader's
        # stray gate Job loses its grade transition and gets reaped. The intent
        # row still records the side effect (idempotent begin: a replay is None).
        intents.begin(db, f"spawn:{name}", intents.SPAWN_GATE_JOB, req.id, {"job": name})
        db.add(StageJob(request_id=req.id, stage=stage, attempt=attempt, role="gate",
                        job_name=name, epoch=get_elector().epoch,
                        deadline_at=utcnow() + timedelta(seconds=settings.GATE_WALL_CLOCK)))
        emit(db, req, "step_summary", f"{stage} gate Job spawned ({name})",
             payload={"step": 2, "of": 2, "label": f"{stage} gate grading",
                      "Ref": req.ref, "job": name, "attempt": attempt})
        db.commit()
        return self._create(db, req, name, gate_job_manifest(req.ref, stage, attempt), moved)

    def _create(self, db: Session, req: Request, name: str, manifest: dict,
                moved: list[str]) -> bool:
        try:
            self.client.create_job(manifest)
        except Exception as exc:
            log.exception("create_job %s failed", name)
            intents.fail(db, f"spawn:{name}", {"error": str(exc)[:300]})
            row = db.scalar(select(StageJob)
                            .where(StageJob.job_name == name, StageJob.status == "running")
                            .order_by(StageJob.id.desc()))
            if row:
                row.status = "infra"
            self._escalate(db, req, f"Could not create Job {name}: {exc}")
            return False
        intents.complete(db, f"spawn:{name}", {"job": name})
        moved.append(f"{req.ref}: spawned {name}")
        return True
```

- [ ] **Step 5: Run the task's tests**

Run: `cd api && uv run pytest tests/test_kube_runner.py tests/test_kube_jobs.py -v`
Expected: all PASS. If `test_full_pipeline_to_merge_gate` loops past the tick limit, print `moved` per tick — the usual culprit is `_next_work` returning None because a gate row status was never updated.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd api && uv run pytest -q`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add api/app/kube_runner.py api/app/verification.py api/tests/test_kube_runner.py
git commit -m "feat(kube): KubeJobRunner tick — spawn/observe/grade to the merge gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Failure semantics — the four witness behaviors on the kube path

The failure code already exists (task 5); this task pins it with the kube reimplementation of the AGENTS.md §7 witness tests plus the spec's kube-specific bounds. If any test exposes a gap, fix `kube_runner.py` — the tests are the contract.

**Files:**
- Test: `api/tests/test_kube_runner.py` (append)
- Modify (only if a test fails): `api/app/kube_runner.py`

**Interfaces:**
- Consumes everything task 5 produced. No new public surface.

- [ ] **Step 1: Write the witness tests**

Append to `api/tests/test_kube_runner.py`:

```python
# ---------- the four AGENTS.md §7 witness behaviors, kube edition ----------

def _scripted(fake, decide):
    """decide(name) -> envelope dict for any running job the runner polls."""
    import json as _json

    def run(name, job):
        if job.phase != "running":
            return
        job.phase = "succeeded"
        job.termination_message = _json.dumps(decide(name))
    fake.on_observe = run


def test_red_gate_rejects_non_failing_tests_and_escalates_after_retry(client):
    """Witness 1 + 3: a bad verdict fails the attempt; retry-with-feedback runs
    ONCE (spec §4.6, N=2); then the request escalates — never silently stranded."""
    runner, fake = make_runner()
    _scripted(fake, lambda name: (
        fail_verdict("RED gate: new tests did not fail — nothing pins the new behavior")
        if name.endswith("-gate") and "-red-" in name
        else pass_verdict() if name.endswith("-gate") else stage_ok()))

    d = _approved(client, "Kube lazy test author")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    assert "RED gate" in out["needs_human_reason"]
    assert "after 2 attempts" in out["needs_human_reason"]
    ref = out["ref"].lower()
    # attempt 2 existed and carried the gate's feedback into the agent Job (spec §4.6)
    second = next(m for m in fake.creations if m["metadata"]["name"] == f"sf-{ref}-red-2")
    env = {e["name"]: e["value"] for e in second["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert "new tests did not fail" in env["SF_GATE_FEEDBACK"]
    # every attempt is an event (spec §5)
    titles = [e["title"] for e in client.get("/api/events", params={"request_id": d["id"]}).json()]
    assert any(t.startswith("Attempt 1 failed at red") for t in titles)


def test_isolation_gate_catches_cheating_implementer(client):
    """Witness 2: green's gate reports a DIFFERENT frozen-surface hash than
    red recorded — the orchestrator rejects the attempt even though the
    (untrusted) gate pod claimed a pass."""
    runner, fake = make_runner()
    _scripted(fake, lambda name: (
        pass_verdict(surface_hash=("b" * 64 if "-green-" in name else SURFACE))
        if name.endswith("-gate") else stage_ok()))

    d = _approved(client, "Kube cheater detection")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    assert "Test-isolation gate" in out["needs_human_reason"]
    assert out["stage"] == "build"  # green maps onto build (REQUEST_STAGE)
    with SessionLocal() as db:
        attempts = db.scalars(select(StageJob).where(
            StageJob.request_id == d["id"], StageJob.stage == "green",
            StageJob.role == "stage")).all()
        assert [a.attempt for a in attempts] == [1, 2]  # it got its one retry, then a human


def test_cancel_wins_over_a_running_pipeline(client):
    """Witness 4: cancel CAS-transitions the request and the running Job is
    reaped (deleted after capture); a late completion changes nothing."""
    runner, fake = make_runner()  # nothing completes: the job stays running
    d = _approved(client, "Kube cancel wins")
    with SessionLocal() as db:
        runner.tick(db)  # spawns sf-<ref>-architecture-1
    name = f"sf-{d['ref'].lower()}-architecture-1"
    assert fake.jobs[name].phase == "running"

    out = client.post(f"/api/requests/{d['id']}/cancel",
                      json={"operator_id": 1, "note": "changed my mind"}).json()
    assert out["status"] == "cancelled"

    with SessionLocal() as db:
        runner.tick(db)  # reap pass
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        assert row.status == "reaped"
    assert name in fake.deletions
    creations_after_cancel = len(fake.creations)

    # a stale completion for the reaped job is DISCARDED (spec §5): the row is
    # no longer 'running', so it is never polled or graded again
    fake.jobs[name].deleted = False
    fake.finish(name, stage_ok())
    polls_before = fake.observations.count(name)
    with SessionLocal() as db:
        runner.tick(db)
        runner.tick(db)
    assert fake.observations.count(name) == polls_before  # never looked at again
    assert len(fake.creations) == creations_after_cancel  # and nothing new spawned
    final = client.get(f"/api/requests/{d['id']}").json()
    assert final["status"] == "cancelled" and not final["needs_human"]


# ---------- kube-specific bounds (spec §5/§6) ----------

def test_wall_clock_timeout_retries_then_escalates(client, monkeypatch):
    monkeypatch.setattr(settings, "STAGE_WALL_CLOCK", -1)  # every attempt is instantly overdue
    runner, fake = make_runner()  # jobs never complete
    d = _approved(client, "Kube partitioned node")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"], limit=10)
    assert "wall clock" in out["needs_human_reason"]
    ref = d["ref"].lower()
    assert f"sf-{ref}-architecture-1" in fake.deletions  # the orchestrator killed it
    assert f"sf-{ref}-architecture-2" in fake.deletions  # retry got the same backstop
    with SessionLocal() as db:
        rows = db.scalars(select(StageJob).where(StageJob.request_id == d["id"])
                          .order_by(StageJob.id)).all()
        assert [r.status for r in rows] == ["timed_out", "timed_out"]


def test_absent_gate_verdict_reruns_without_consuming_attempt(client):
    """Gate infra failure (spec §6): absent verdict → the gate re-runs, same
    attempt, no escalation, no retry consumed."""
    runner, fake = make_runner()
    d = _approved(client, "Kube gate infra")
    ref = d["ref"].lower()
    name = f"sf-{ref}-architecture-1"
    gname = f"{name}-gate"

    with SessionLocal() as db:
        runner.tick(db)                       # spawns the agent Job
    fake.finish(name, stage_ok())
    with SessionLocal() as db:
        runner.tick(db)                       # observes success → spawns the gate
    fake.jobs[gname].phase = "succeeded"      # …but the pod wrote NO termination message
    with SessionLocal() as db:
        runner.tick(db)                       # absent verdict → infra, job deleted
        runner.tick(db)                       # gate re-spawned, SAME name, SAME attempt
    assert [m["metadata"]["name"] for m in fake.creations] == [name, gname, gname]

    fake.finish(gname, pass_verdict())        # the re-run grades clean
    with SessionLocal() as db:
        runner.tick(db)

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False
    titles = [e["title"] for e in client.get("/api/events", params={"request_id": d["id"]}).json()]
    assert any(t.startswith("Architecture plan committed") for t in titles)
    assert not any(t.startswith("Attempt") for t in titles)  # no attempt was consumed


def test_capture_failure_on_agent_job_escalates(client):
    """A SUCCEEDED agent Job whose envelope cannot be read is a capture
    failure — its own escalation reason (spec §5), never a silent pass."""
    runner, fake = make_runner()
    d = _approved(client, "Kube capture failure")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    fake.jobs[name].phase = "succeeded"       # no termination message written
    with SessionLocal() as db:
        runner.tick(db)
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "could not be captured" in out["needs_human_reason"]


def test_human_retry_grants_one_fresh_attempt(client):
    """After escalation, Retry re-enters the runnable set; the runner spawns
    attempt+1 (names stay unique — spec §5 attempt semantics) and a further
    failure escalates again."""
    runner, fake = make_runner()
    _scripted(fake, lambda name: (
        fail_verdict("RED gate: new tests did not fail")
        if name.endswith("-gate") and "-red-" in name
        else pass_verdict() if name.endswith("-gate") else stage_ok()))
    d = _approved(client, "Kube human retry")
    tick_until(client, runner, d["id"], lambda o: o["needs_human"])

    client.post(f"/api/requests/{d['id']}/retry", json={"operator_id": 1, "note": "try once more"})
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    ref = d["ref"].lower()
    red_attempts = [m["metadata"]["name"] for m in fake.creations
                    if m["metadata"]["name"].startswith(f"sf-{ref}-red-")
                    and not m["metadata"]["name"].endswith("-gate")]
    assert red_attempts == [f"sf-{ref}-red-1", f"sf-{ref}-red-2", f"sf-{ref}-red-3"]
    assert out["needs_human"] is True  # the fresh attempt also failed → back to a human
```

- [ ] **Step 2: Run the new tests**

Run: `cd api && uv run pytest tests/test_kube_runner.py -v`
Expected: all PASS against the task-5 implementation. If one fails, fix `kube_runner.py` to the test's contract (they encode the spec) — likely spots: `_next_work`'s ordering of the infra/failed branches, and the reap pass running before observe.

- [ ] **Step 3: Run the whole backend suite**

Run: `cd api && uv run pytest -q`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add api/tests/test_kube_runner.py api/app/kube_runner.py
git commit -m "test(kube): the four gate-behavior witnesses + wall clock, infra re-run, capture failure, retry semantics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire `FACTORY_RUNNER=kube` into the app + docs + verify

**Files:**
- Modify: `api/app/main.py:25-30` (`_tick_once`), `api/app/main.py:49-58` (interval), `api/app/main.py:83-84` (pipeline construction)
- Modify: `api/app/routers/system.py` (`sim_tick` kube branch)
- Modify: `AGENTS.md` §7 (runtime table gains the kube runner)
- Test: `api/tests/test_kube_wiring.py` (new file)

**Interfaces:**
- Consumes `KubeJobRunner` (task 5), the leader-only tick guard (task 2).
- Behavior contract: with `FACTORY_RUNNER=kube` — the background tick loop drives `KubeJobRunner.tick` (the simulator stands down); `POST /api/simulator/tick` drives the same tick manually (leader-only); approve/retry/send-back-to-stage do NOT thread-start anything (the next tick notices the runnable request — spec §4.3); `escalate_orphans` does NOT run (a recovering leader re-attaches via `StageJob` rows — spec §3.4); the merge-gate approve keeps the simulator's `finish_done` path (GitHub merge is B2/B3).

- [ ] **Step 1: Write the failing wiring test**

Create `api/tests/test_kube_wiring.py`:

```python
"""FACTORY_RUNNER=kube wiring: the tick endpoint/loop drives the KubeJobRunner,
gates endpoints stay hands-off, and the whole loop closes end-to-end."""
from fastapi.testclient import TestClient
from fake_kube import FakeKubeClient, honest_cluster
from helpers import approved_request

from app.kube_runner import KubeJobRunner
from app.main import create_app


def test_kube_mode_end_to_end_via_tick_endpoint(client, monkeypatch):
    # `client` (session app) holds no exclusive lock on SQLite; a second app
    # over the same DB is safe and mirrors how a real deploy would restart.
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    fake = FakeKubeClient()
    honest_cluster(fake)
    app = create_app(auto_tick=0, runner=KubeJobRunner(client=fake))
    with TestClient(app) as c:
        d = approved_request(
            c, title="Kube wiring e2e",
            description="Add a monthly_export function that returns the export format name.")
        out = d
        for _ in range(30):
            if out["gate"] == "approve_merge":
                break
            moved = c.post("/api/simulator/tick").json()["moved"]
            assert isinstance(moved, list)
            out = c.get(f"/api/requests/{d['id']}").json()
        assert out["gate"] == "approve_merge" and out["stage"] == "review"
        assert len(fake.creations) == 8  # 4 stages × (agent Job + gate Job)

        # approve-merge closes the loop on the B1 finish_done path
        done = c.post(f"/api/requests/{d['id']}/approve", json={"operator_id": 1}).json()
        assert done["status"] == "done" and done["stage"] == "done"


def test_kube_mode_approve_does_not_thread_start(client, monkeypatch):
    """Spec §4.3: pick-up is the TICK's job — approve must not push work."""
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    fake = FakeKubeClient()
    app = create_app(auto_tick=0, runner=KubeJobRunner(client=fake))
    with TestClient(app) as c:
        approved_request(c, title="Kube no-push approve")
        assert fake.creations == []  # nothing spawned until a tick notices it
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_kube_wiring.py -v`
Expected: FAIL — the tick endpoint answers with the SIMULATOR's `moved` (it advances `sim_step`, never creating Jobs), so `fake.creations` stays empty and the gate never rises.

- [ ] **Step 3: Wire main.py**

`api/app/main.py` — replace `_tick_once`:

```python
def _tick_once(elector: LeaderElector) -> None:
    if not (elector.verify() or elector.try_acquire()):
        return
    with SessionLocal() as db:
        if runner_mode() == "kube":
            api_helpers.pipeline().tick(db)  # the tick loop IS the kube orchestrator (spec §4)
        else:
            simulator.tick(db)
```

`api/app/main.py` — in `create_app`'s lifespan, replace the interval block:

```python
        task = None
        interval = auto_tick if auto_tick is not None else settings.SIM_INTERVAL
        if runner_mode() == "agent":
            interval = 0  # the real runner drives itself; the simulator stands down
        if runner_mode() == "kube" and auto_tick is None and interval <= 0:
            interval = 5.0  # kube is tick-driven: without a heartbeat nothing ever runs
```

(`escalate_orphans` stays agent-only — in kube mode a recovering leader re-attaches to running Jobs through their `StageJob` rows instead of escalating, spec §3.4. Leave the existing `if runner_mode() == "agent":` guard as is.)

`api/app/main.py` — replace the pipeline construction:

```python
    if runner is not None:
        agent_pipeline = runner
    elif runner_mode() == "kube":
        from .kube_runner import KubeJobRunner
        agent_pipeline = KubeJobRunner()  # client is lazy: kubeconfig loads on first tick, not import
    else:
        agent_pipeline = AgentRunner()
    api_helpers.set_pipeline(agent_pipeline)
```

- [ ] **Step 4: Wire the tick endpoint**

`api/app/routers/system.py` — `sim_tick` gets the kube branch (after the leader guard from task 2):

```python
@router.post("/api/simulator/tick")
def sim_tick(db: Session = Depends(get_db)):
    if runner_mode() == "agent":
        return {"moved": [], "note": "runner=agent — the real agents drive the stages"}
    elector = get_elector()
    if not (elector.verify() or elector.try_acquire()):
        return {"moved": [], "note": "not the leader — tick skipped"}
    if runner_mode() == "kube":
        return {"moved": pipeline().tick(db)}
    return {"moved": simulator.tick(db)}
```

Add `pipeline` to the existing `..api_helpers` import (or add `from ..api_helpers import pipeline`).

- [ ] **Step 5: Run the wiring tests, then everything**

Run: `cd api && uv run pytest tests/test_kube_wiring.py -v && uv run pytest -q`
Expected: all green (the gates endpoints need no changes: their `runner_mode() == "agent"` guards already skip in kube mode, and the merge approve falls through to `simulator.approve_merge` = `finish_done`, which is B1's intended behavior).

- [ ] **Step 6: Document the runtime**

`AGENTS.md` §7 — append after the existing 4-step list:

```markdown
The pattern has been exercised twice: `FACTORY_RUNNER=agent` (AgentRunner,
subprocess CLI seam) and `FACTORY_RUNNER=kube` (KubeJobRunner, Kubernetes
Jobs behind the `KubeClient` seam in `api/app/kube_client.py`; its four
witness tests live in `api/tests/test_kube_runner.py` against a
`FakeKubeClient` — no cluster needed).
```

- [ ] **Step 7: Full verify**

Run from the repo root: `task verify`
Expected: lint + pytest + vitest + Angular build + smoke all green. Show the output before merging (repo rule). Fix anything red — including ruff import-order nits in the new files.

- [ ] **Step 8: Commit**

```bash
git add api/app/main.py api/app/routers/system.py api/tests/test_kube_wiring.py AGENTS.md
git commit -m "feat(kube): FACTORY_RUNNER=kube wired into the tick loop and tick endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Design decisions made while planning (resolutions of spec/code gaps)

1. **Tick-driven, not thread-driven.** AgentRunner runs pipeline threads fired from endpoints; the spec (§4) makes the kube orchestrator poll from the tick loop. KubeJobRunner therefore exposes `tick(db)` and NO `start()`; the gates endpoints' `runner_mode() == "agent"` guards already make them hands-off in kube mode.
2. **Kube stage vocabulary.** RED/GREEN are separate Jobs (spec §4.5) but `Request.stage` keeps its 3-value vocabulary; `REQUEST_STAGE` maps red/green → build. Job progress is derived from `StageJob` rows, never from `sim_step`.
3. **Frozen-surface check without git (B1).** The orchestrator-side pure-git tree-hash (spec §6) needs git-as-workspace (B2). B1 keeps the *decision* trusted: red's gate records `surface_hash`; green's gate must report the identical hash or the attempt fails with a Test-isolation reason — the state machine and witness test are complete now; B2 swaps the hash SOURCE to the orchestrator's own git computation.
4. **Test-isolation violations get the standard retry.** AgentRunner escalates a cheater immediately; spec §4.6 says failed stages retry once with feedback. The kube path applies retry-with-feedback uniformly (the witness test scripts both attempts to cheat, then asserts escalation). The same uniformity applies to a review gate that "passes" without usable evidence (tests_total or files_changed = 0): it is graded as a gate FAILURE, not a direct escalation — otherwise a later human Retry would dead-end on an already-succeeded review gate row.
5. **Gate-spawn is not CAS-fenced; grading is.** No TABLE row moves Request state when a gate spawns. Rather than invent a no-op transition, the fence bites where it matters — a stale leader's stray gate Job loses its epoch-fenced grade transition and is reaped. Single-replica operation (spec §3.2) makes this residual acceptable; noted for Phase 2.
6. **Gate timeout consumes the attempt** (bounded), unlike an absent verdict (infra, re-run, unbounded only by the wall clock per run). A hung gate and a hung agent look the same to the orchestrator; boundedness wins.
7. **`StageJob.job_name` indexed, not unique** — an infra re-run legitimately recreates the same deterministic name in a fresh row; "one running row per name" is a runner invariant.
8. **Human Retry = exactly one fresh attempt** (attempt N+1, unique names, spec §5 attempt semantics); a further failure re-escalates without a second automatic retry.
9. **Merge approve in B1 = `finish_done`** via the existing simulator path (no git/GitHub in scope). `intents.MERGE_PR` is declared now (task 2) and gets wired when the GitHub merge lands (B2/B3).
10. **Steer notes are NOT injected into Jobs in B1** — prompts live in the B2 image entrypoint. Recorded as a deferred item; step_summary heartbeats still keep run-state health alive.
11. **`kubernetes` import is lazy** (inside `RealKubeClient.__init__`, reached only on the runner's first real tick), so tests, CI, and sim/agent modes never load it or a kubeconfig.

## Self-review (writing-plans checklist)

- **Spec coverage (§5/§6/§9-Phase-1 B1 slice):** deterministic names → task 4; activeDeadline + orchestrator wall clock → tasks 4/5/6; backoffLimit 0 + podFailurePolicy + no SA token → task 4; orchestrator owns deletion after capture → task 5 (+ full-lifecycle assertion in the happy path); envelope + NDJSON → task 4; capture-failure escalation → task 6; gate = no-LLM Job with pinned-SHA grading → modeled as the gate Job + orchestrator grading (SHA pinning itself is git, B2); absent verdict = infra re-run → task 6; retry-with-feedback N=2 → tasks 5/6; stale-attempt discard → task 6 (cancel + timeout tests); cancel wins → task 6; fairness + job cap → task 5; intents on spawn → tasks 2/5; epoch fencing → tasks 1/5; leader-only tick/orphans → task 2; re-attach after restart → `_next_work` derives from rows (task 5) and orphan escalation stays off in kube mode (task 7).
- **Placeholders:** none — every step carries full code or an exact command.
- **Type consistency:** `job_name(ref, stage, attempt, *, gate=False)`, `KubeClient.create_job/get_job/delete_job`, `JobView(name, phase, termination_message, logs)`, `tick(db) -> list[str]`, `apply_committed(...) -> Win | Loss`, `intents.SPAWN_STAGE_JOB/SPAWN_GATE_JOB` used exactly as defined.
