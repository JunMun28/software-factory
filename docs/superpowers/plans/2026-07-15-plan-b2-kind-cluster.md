# Plan B2: real kind cluster + sf-agent image + manifests overlay

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FakeKubeClient real — a kind cluster (Calico-enforced NetworkPolicy), the sf-agent image + entrypoint, kustomize base + `overlays/local`, git-as-workspace for the trusted frozen-surface check, the RealKubeClient running-pod-capture/UID fixes deferred from B1, and a one-request end-to-end smoke on kind.

**Architecture:** B1's `KubeJobRunner` is complete and tested against `FakeKubeClient`; B2 builds everything on the other side of the `KubeClient` seam. The orchestrator (factory-api pod) owns a per-request git repo under `FACTORY_WORKSPACES` and exports it to Jobs via a `git daemon` sidecar (`git://api:9418/<ref>`); agent Jobs clone the work branch, run the stage with codex/opencode, push, and report a status envelope (termination message) + NDJSON logs; gate Jobs clone the **pinned SHA** and run fixed factory-owned checks. Everything trust-critical (frozen-surface hash, SHA-precondition merge, branch reset per attempt) is computed by the orchestrator on its own git copy — never taken from a pod's word.

**Tech Stack:** kind v0.32.0 + Calico (OSS) + ingress-nginx, kustomize (`kubectl apply -k`), Docker (OrbStack), FastAPI + SQLAlchemy 2 + Alembic, official `kubernetes` python client behind the seam, bash entrypoints, pytest.

**Spec (binding):** `docs/superpowers/specs/2026-07-14-openshift-kubernetes-architecture-design.md` §2, §5, §6, §9 Phase 1.
**Repo baseline:** main @ 3928f07 (Plan B1 merged: KubeJobRunner behind `FACTORY_RUNNER=kube`, StageJob rows, FakeKubeClient tests).
**B1 deferred ledger this plan closes:** running-pod log capture (RealKubeClient only reads pod output for terminal Jobs); running-row supersede leak; UID tracking for same-name recreate 409s; git-as-workspace replacing the orchestrator-held `surface_hash` trust in gate envelopes.

## Verification legend (every task is tagged)

| Tag | Meaning |
|---|---|
| **(unit)** | pytest against SQLite + FakeKubeClient (and real `git` in tmp dirs). Runs in `task verify` / CI. |
| **(docker)** | needs local Docker to build/run an image; no cluster. NOT in `task verify`. |
| **(cluster)** | needs the running kind cluster; verified with `kubectl` assertions / scripts. NOT in `task verify`. |
| **(cluster+LLM)** | additionally needs the codex subscription (`~/.codex/auth.json` synced to a Secret). |

## Global Constraints

- Python deps via `uv add` / `uv run` only — never pip.
- `progress_event` rows are append-only — never UPDATE/DELETE (ADR 0008).
- Single uvicorn worker; the tick loop assumes one process (CLAUDE.md). The factory-api Deployment is `replicas: 1`.
- ALL Request state changes go through `transitions.apply()` / `apply_committed()`; machine callers pass `epoch=get_elector().epoch`.
- Spec §5 hard lines stay law: Job names `sf-<ref>-<stage>-<attempt>[-gate]`; `backoffLimit: 0`; `podFailurePolicy` ignores DisruptionTarget; `activeDeadlineSeconds` **plus** orchestrator wall clock; capture **before** delete; envelope ≤ 4 KB in the termination message, big payloads as NDJSON logs; `automountServiceAccountToken: false` on agent/gate pods.
- Spec §2: kind **with Calico** — kindnet silently does NOT enforce NetworkPolicy (the CRITICAL trap); enforcement is **proven by a smoke test**, never assumed.
- Spec §5: images built to **arbitrary-UID conventions** (root-group ownership, `chmod g=u`, `HOME=/workspace`); local pods run with a forced non-root UID.
- Spec §6: gate Jobs run **fixed factory-owned commands** (never repo-defined scripts), no LLM egress, no push credential; grading is orchestrator-side.
- `task verify` (lint + pytest + vitest + build + smoke) must stay green after every unit task and must NOT acquire a cluster dependency: cluster tests are opt-in via `FACTORY_KUBE_ITEST=1`.
- All existing B1 kube tests keep passing **unchanged in meaning**: with no git remote configured (`FACTORY_GIT_REMOTE_BASE` empty, the unit-test default) the runner behaves exactly like B1.
- Images are loaded into kind with `kind load docker-image` (`:dev` tags, `imagePullPolicy: IfNotPresent`) — no registry in B2.
- Keep `implementation-notes.md` updated: forced deviations go under `## Deviations` (conservative option, keep going).
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Out of scope (B3):** produced-app build/deploy (kaniko Job, local registry, static-template deploy of the merged app), GitHub repos/PR/merge (real remote + PAT/GitHub-App seam), steer-note injection into Job prompts, `overlays/openshift`/`overlays/aks`, Prometheus. The B2 smoke therefore ends at: request `done`, work branch merged into the workspace repo's `main` (today's definition of "deployed"), Jobs reaped, NetworkPolicy proven.

---

## File structure

| File | Responsibility |
|---|---|
| `api/app/kube_client.py` | seam v2: `JobView.uid`, `create_job -> uid \| None` (409 = None), `get_job(name, *, capture=False)` reads running-pod logs |
| `api/app/models.py` + `api/alembic/versions/b2c4e6a8d0f1_stage_job_uid.py` | `StageJob.job_uid` column (same-name recreate disambiguation) |
| `api/tests/fake_kube.py` | fake parity: uids, `conflicts` scripting, capture-gated logs |
| `api/app/kube_runner.py` | uid adoption/park on 409, stale-uid discard, capture-before-delete on timeout/reap/supersede, git-backed grading + `approve_merge` |
| `api/app/workspace.py` | NEW: git-as-workspace — `ensure_repo`, `surface_hash_at(ws, sha)`, `reset_branch`, `merge_graded`, `spec_md`, `repo_url` |
| `api/app/kube_jobs.py` | manifests v2: ServiceAccounts, securityContext, `/workspace` emptyDir + HOME, codex Secret mount (stage only), `SF_REPO_URL/SF_BRANCH/SF_CLI/SF_MODEL`, gate `SF_SHA`/`SF_REVIEW_VERDICT` |
| `api/app/settings.py` | + `GIT_REMOTE_BASE`, `KUBE_RUN_AS_UID`, `KUBE_AGENT_SA`, `KUBE_GATE_SA`, `CODEX_AUTH_SECRET` |
| `api/app/routers/gates.py` | merge approve dispatches to `pipeline().approve_merge` for kube mode too |
| `docker/sf-agent/{Dockerfile,entrypoint.sh,gate.sh,prompts/*.md}` | the sf-agent image (shared by stage AND gate Jobs) |
| `apps/console/{Dockerfile,nginx.conf}` | console SPA image (mirrors intake's) |
| `deploy/kind/cluster.yaml` | kind cluster: CNI disabled (Calico), ingress port mapping |
| `deploy/base/*` | kustomize base: namespace, SAs, RBAC, factory-api (+ git-daemon sidecar) with Service **named `api`**, intake, console, ConfigMap, NetworkPolicies |
| `deploy/overlays/local/*` | local overlay: ingress hosts on `*.localtest.me:8081` |
| `scripts/{calico-probe.sh,netpol-smoke.sh,kind-smoke.sh}` | enforcement probe · tier-wall smoke · one-request end-to-end smoke |
| `Taskfile.yml` | + `kind-up`, `kind-load`, `kind-deploy`, `sync-codex-auth`, `kind-smoke`, `kind-down` |
| `api/tests/test_workspace.py`, `api/tests/test_kube_runner.py` (append), `api/tests/test_kube_jobs.py` (append), `api/tests/test_real_kube_integration.py` | tests |

### Shared vocabulary added by B2 (on top of B1's)

- **Envelope v2 (backward compatible).** Agent Job: `{"v":1, "outcome":"ok"|"fail", "detail":str, "sha":str|null}` — `sha` is the commit the agent pushed (null/missing = B1 behavior). Gate Job envelope is unchanged; its `surface_hash` is now only a **fallback** — when a git workspace + stage SHAs exist, the orchestrator computes the frozen-surface hash itself.
- **Git plumbing.** Per-request repo at `settings.WORKSPACES/<ref>` (non-bare, `receive.denyCurrentBranch=updateInstead`); work branch `work/<ref>`; baseline tag `sf-baseline` at the SPEC.md commit; exported by the git-daemon sidecar as `${FACTORY_GIT_REMOTE_BASE}/<ref>`.
- **Job env contract (what the image reads):** `SF_REF, SF_STAGE, SF_ATTEMPT, SF_ROLE, SF_REPO_URL, SF_BRANCH, SF_CLI, SF_MODEL, SF_GATE_FEEDBACK` (stage, retry only), `SF_SHA` (gate: the pinned SHA), `SF_REVIEW_VERDICT` (review gate only), `SF_TERMLOG` (test hook, defaults `/dev/termination-log`).

---

### Task 1 (unit): KubeClient seam v2 — uid, 409 semantics, running-pod capture

Closes two B1 ledger items at the seam: `RealKubeClient.get_job` only read pod output for terminal Jobs, and a 409 on create was silently treated as "our replay" even when the live Job was a dying predecessor with the same deterministic name.

**Files:**
- Modify: `api/app/kube_client.py`
- Modify: `api/app/models.py` (StageJob gains `job_uid`)
- Create: `api/alembic/versions/b2c4e6a8d0f1_stage_job_uid.py`
- Modify: `api/tests/fake_kube.py`
- Test: `api/tests/test_kube_jobs.py` (append)

**Interfaces:**
- Produces: `JobView(name, phase, uid="", termination_message="", logs="")`; `KubeClient.create_job(manifest) -> str | None` (uid of the created Job; **None = 409, a live Job with that name already exists**); `KubeClient.get_job(name, *, capture=False) -> JobView` — termination message only for terminal pods, logs when `capture=True` **or** the Job is terminal (running-pod logs are now readable); `delete_job` unchanged.
- Produces: `models.StageJob.job_uid: str | None` (String(36), nullable).
- Produces fake: `FakeJob.uid`, `FakeKubeClient.conflicts: set[str]` (names whose next create returns None while the existing FakeJob stays live), capture-gated logs mirroring the real semantics.
- Tasks 2, 9 consume all of this.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_kube_jobs.py`:

```python
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
    fake.finish("sf-req-2051-red-1", {"v": 1, "outcome": "ok", "detail": "d"},
                logs='{"type":"note","text":"done"}\n')
    view = fake.get_job("sf-req-2051-red-1")
    assert view.logs != "" and view.termination_message != ""


def test_stage_job_uid_column_roundtrip():
    from app.db import SessionLocal, migrate
    from app.models import StageJob, utcnow

    migrate()
    with SessionLocal() as db:
        row = StageJob(request_id=1, stage="red", attempt=1, role="stage",
                       job_name="sf-req-9002-red-1", epoch=1, job_uid="uid-abc",
                       deadline_at=utcnow())
        db.add(row)
        db.commit()
        assert db.get(StageJob, row.id).job_uid == "uid-abc"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_kube_jobs.py -k "uid or capture" -v`
Expected: FAIL — `FakeKubeClient` has no `conflicts`, `create_job` returns None always, `StageJob` has no `job_uid`.

- [ ] **Step 3: Implement the seam v2 in `api/app/kube_client.py`**

Replace `JobView`, `KubeClient`, and `RealKubeClient`'s `create_job`/`get_job` with:

```python
@dataclass
class JobView:
    """One observation of a Job: phase + uid + the two capture channels
    (spec §5) — the ≤4KB termination-message envelope and NDJSON pod logs.
    uid disambiguates same-name recreates (deterministic names are reused
    across infra re-runs)."""

    name: str
    phase: str
    uid: str = ""
    termination_message: str = ""
    logs: str = ""


class KubeClient(Protocol):
    def create_job(self, manifest: dict) -> str | None: ...

    def get_job(self, name: str, *, capture: bool = False) -> JobView: ...

    def delete_job(self, name: str) -> None: ...
```

and in `RealKubeClient`:

```python
    def create_job(self, manifest: dict) -> str | None:
        """Returns the created Job's uid. None = 409: a live Job with this
        name already exists — the CALLER decides whether that is its own
        intent replay (adopt) or a dying predecessor (park and re-run)."""
        try:
            job = self._batch.create_namespaced_job(self.ns, manifest)
            return job.metadata.uid or ""
        except self._ApiException as e:
            if e.status != 409:
                raise
            return None

    def get_job(self, name: str, *, capture: bool = False) -> JobView:
        try:
            job = self._batch.read_namespaced_job(name, self.ns)
        except self._ApiException as e:
            if e.status == 404:
                return JobView(name=name, phase="absent")
            raise
        status = job.status
        phase = "succeeded" if status.succeeded else "failed" if status.failed else "running"
        uid = job.metadata.uid or ""
        termination_message, logs = "", ""
        if capture or phase != "running":
            pods = self._core.list_namespaced_pod(
                self.ns, label_selector=f"job-name={name}"
            ).items
            pods.sort(key=lambda p: p.metadata.creation_timestamp or 0)
            if pods:
                pod = pods[-1]
                for container_status in pod.status.container_statuses or []:
                    terminated = container_status.state.terminated
                    if terminated and terminated.message:
                        termination_message = terminated.message
                try:
                    # read_namespaced_pod_log works on RUNNING pods too — the
                    # B1 gap: wall-clock kills and reaps can now capture output
                    logs = self._core.read_namespaced_pod_log(pod.metadata.name, self.ns)
                except self._ApiException:
                    logs = ""
        return JobView(
            name=name,
            phase=phase,
            uid=uid,
            termination_message=termination_message,
            logs=logs,
        )
```

(`delete_job` unchanged. Update the module docstring's "running-pod capture is best-effort" sentence — it is now real.)

- [ ] **Step 4: Add `job_uid` to the model + migration**

`api/app/models.py`, inside `StageJob` after `job_name`:

```python
    # uid of the Kubernetes Job object this row spawned/adopted. Deterministic
    # names are REUSED across infra re-runs; the uid says which incarnation is
    # ours, so a same-name stranger is never polled or graded (B2, spec §5).
    job_uid: Mapped[str | None] = mapped_column(String(36), nullable=True)
```

Create `api/alembic/versions/b2c4e6a8d0f1_stage_job_uid.py` (confirm head with `cd api && uv run alembic heads` — expected `7f2a9c4d1e88`):

```python
"""stage_jobs.job_uid — same-name recreate disambiguation (Plan B2 task 1)

Revision ID: b2c4e6a8d0f1
Revises: 7f2a9c4d1e88
Create Date: 2026-07-15
"""
import sqlalchemy as sa
from alembic import op

revision = "b2c4e6a8d0f1"
down_revision = "7f2a9c4d1e88"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("stage_jobs", sa.Column("job_uid", sa.String(36), nullable=True))


def downgrade() -> None:
    op.drop_column("stage_jobs", "job_uid")
```

- [ ] **Step 5: Update `api/tests/fake_kube.py`**

Replace `FakeJob` and `FakeKubeClient` (keep the verdict helpers and `honest_cluster` as they are):

```python
@dataclass
class FakeJob:
    manifest: dict
    uid: str
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
    raise_once: set[str] = field(default_factory=set)
    raise_always: set[str] = field(default_factory=set)
    conflicts: set[str] = field(default_factory=set)  # next create of NAME → 409 (None)
    on_observe = None
    _uid_seq: int = 0

    def _next_uid(self) -> str:
        self._uid_seq += 1
        return f"uid-{self._uid_seq}"

    def create_job(self, manifest: dict) -> str | None:
        name = manifest["metadata"]["name"]
        if name in self.conflicts:
            self.conflicts.remove(name)
            return None  # 409: a live same-name Job exists (self.jobs[name])
        existing = self.jobs.get(name)
        assert existing is None or existing.deleted, f"duplicate live job {name}"
        job = FakeJob(manifest=manifest, uid=self._next_uid())
        self.jobs[name] = job
        self.creations.append(manifest)
        return job.uid

    def get_job(self, name: str, *, capture: bool = False) -> JobView:
        self.observations.append(name)
        if name in self.raise_once:
            self.raise_once.remove(name)
            raise RuntimeError(f"one-shot observation failure for {name}")
        if name in self.raise_always:
            raise RuntimeError(f"persistent observation failure for {name}")
        job = self.jobs.get(name)
        if job is None or job.deleted:
            return JobView(name=name, phase="absent")
        if self.on_observe:
            self.on_observe(name, job)
        terminal = job.phase in ("succeeded", "failed")
        return JobView(
            name=name,
            phase=job.phase,
            uid=job.uid,
            termination_message=job.termination_message if terminal else "",
            logs=job.logs if (capture or terminal) else "",
        )

    def delete_job(self, name: str) -> None:
        self.deletions.append(name)
        job = self.jobs.get(name)
        if job:
            job.deleted = True

    def finish(
        self,
        name: str,
        envelope: dict,
        *,
        phase: str = "succeeded",
        logs: str = "",
    ) -> None:
        job = self.jobs[name]
        assert not job.deleted, f"finishing a deleted job {name}"
        job.phase = phase
        job.termination_message = json.dumps(envelope)
        job.logs = logs
```

- [ ] **Step 6: Run the kube suites**

Run: `cd api && uv run pytest tests/test_kube_jobs.py tests/test_kube_runner.py tests/test_kube_wiring.py tests/test_migrations.py -q`
Expected: all green (the runner ignores the new return value for now — task 2 uses it; the migration test proves the alembic history builds `job_uid`).

- [ ] **Step 7: Full backend suite, then commit**

Run: `cd api && uv run pytest -q` — all green.

```bash
git add api/app/kube_client.py api/app/models.py api/alembic/versions/b2c4e6a8d0f1_stage_job_uid.py api/tests/fake_kube.py api/tests/test_kube_jobs.py
git commit -m "feat(kube): seam v2 — Job uids, 409 as a signal, running-pod log capture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2 (unit): Runner hardening — uid tracking, capture-before-delete everywhere, supersede leak

Closes the remaining B1 runner ledger items using the task-1 seam.

**Files:**
- Modify: `api/app/kube_runner.py`
- Test: `api/tests/test_kube_runner.py` (append)

**Interfaces:**
- Consumes: `create_job -> uid | None`, `get_job(name, capture=True)`, `StageJob.job_uid` (task 1).
- Behavior contract (what the tests pin):
  1. `_create` records the uid on the row; on 409 it adopts the live Job **only** when its uid matches no prior completed row for that name (our own intent replay); a dying predecessor parks the row as `infra` (no escalation — the next tick re-runs).
  2. `_observe` discards a same-name Job whose uid differs from the row's (`infra`, re-run) — a stranger is never graded.
  3. The wall-clock-timeout, reap, and supersede paths call `get_job(name, capture=True)` so running-pod output lands in `logs_tail` before deletion.
  4. `_supersede_rewound_rows` deletes (after capture) the live Job of any **running** row it supersedes — the leak fix.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_kube_runner.py`:

```python
# ---------- B2 task 2: uid tracking, capture-before-delete, supersede leak ----------
from datetime import timedelta

from app.models import utcnow


def test_create_records_uid_and_replay_adopts(client):
    """Intent replay: our own earlier create landed (409) — adopt its uid."""
    runner, fake = make_runner()
    d = _approved(client, "Kube uid adopt")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    # a previous leader's create landed, then it crashed before recording it
    from app.kube_jobs import stage_job_manifest
    pre_uid = fake.create_job(stage_job_manifest(d["ref"], "architecture", 1))
    fake.conflicts.add(name)  # our create will 409 against it
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name)
                        .order_by(StageJob.id.desc()))
        assert row.status == "running" and row.job_uid == pre_uid  # adopted


def test_create_conflict_with_dying_predecessor_parks_infra(client, monkeypatch):
    """A prior attempt's same-name Job is still terminating: never adopt it —
    park as infra and re-run once the name frees up (B1 ledger: 409s)."""
    monkeypatch.setattr(settings, "STAGE_WALL_CLOCK", -1)  # attempt 1 times out instantly
    runner, fake = make_runner()
    d = _approved(client, "Kube dying predecessor")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)   # spawn attempt 1
        runner.tick(db)   # wall clock fires: row1 timed_out, job deleted, retry queued
    monkeypatch.setattr(settings, "STAGE_WALL_CLOCK", 2100)
    # the kubelet is slow: the old attempt-1 Job object is STILL there when the
    # infra path recreates the same deterministic name for attempt... (attempt 2
    # has its own name; force the same-name case via an infra vanish instead)
    name2 = f"sf-{d['ref'].lower()}-architecture-2"
    with SessionLocal() as db:
        runner.tick(db)   # spawns attempt 2 (name2)
    fake.jobs[name2].deleted = True          # vanishes under us → infra re-run, SAME name
    with SessionLocal() as db:
        runner.tick(db)   # observes absent → row infra
    old_uid = fake.jobs[name2].uid
    fake.jobs[name2].deleted = False          # ...but the object lingers, dying
    fake.conflicts.add(name2)
    with SessionLocal() as db:
        runner.tick(db)   # re-create 409s against the dying predecessor
        rows = db.scalars(select(StageJob).where(StageJob.job_name == name2)
                          .order_by(StageJob.id)).all()
        assert rows[-1].status == "infra" and rows[-1].job_uid is None
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False        # parked, not escalated
    fake.jobs[name2].deleted = True           # predecessor finally reaped
    with SessionLocal() as db:
        runner.tick(db)
        fresh = db.scalar(select(StageJob).where(StageJob.job_name == name2)
                          .order_by(StageJob.id.desc()))
        assert fresh.status == "running" and fresh.job_uid not in (None, old_uid)


def test_observe_discards_same_name_stranger(client):
    """A same-name Job with a DIFFERENT uid is not ours: infra, re-run,
    never graded (B1 ledger: uid tracking)."""
    runner, fake = make_runner()
    d = _approved(client, "Kube uid stranger")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    # someone deleted + recreated the job out-of-band
    from app.kube_jobs import stage_job_manifest
    from fake_kube import FakeJob
    fake.jobs[name] = FakeJob(manifest=stage_job_manifest(d["ref"], "architecture", 1),
                              uid="uid-stranger")
    fake.finish(name, stage_ok())  # the stranger even "succeeds"
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name)
                        .order_by(StageJob.id))
        assert row.status == "infra"          # discarded, not graded
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False


def test_wall_clock_timeout_captures_running_logs(client, monkeypatch):
    monkeypatch.setattr(settings, "STAGE_WALL_CLOCK", -1)
    runner, fake = make_runner()
    d = _approved(client, "Kube timeout capture")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    fake.jobs[name].logs = '{"type":"note","text":"i was mid-flight"}\n'
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        assert row.status == "timed_out"
        assert "mid-flight" in (row.logs_tail or "")   # captured BEFORE delete
    assert name in fake.deletions


def test_reap_captures_running_logs(client):
    runner, fake = make_runner()
    d = _approved(client, "Kube reap capture")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    fake.jobs[name].logs = '{"type":"note","text":"cancelled mid-run"}\n'
    client.post(f"/api/requests/{d['id']}/cancel", json={"operator_id": 1})
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        assert row.status == "reaped" and "cancelled mid-run" in (row.logs_tail or "")


def test_supersede_deletes_running_job(client):
    """B1 ledger: a rewound request superseded LATER rows but left their live
    Jobs running forever. Superseding a running row now captures + deletes."""
    runner, fake = make_runner()
    d = _approved(client, "Kube supersede leak")
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        # fabricate a running review-stage job from BEFORE an operator rewind
        from app.kube_jobs import stage_job_manifest
        name = f"sf-{req.ref.lower()}-review-1"
        uid = fake.create_job(stage_job_manifest(req.ref, "review", 1))
        fake.jobs[name].logs = '{"type":"note","text":"stale reviewer"}\n'
        db.add(StageJob(request_id=req.id, stage="review", attempt=1, role="stage",
                        job_name=name, job_uid=uid, epoch=1,
                        deadline_at=utcnow() + timedelta(seconds=2100),
                        created_at=utcnow() - timedelta(hours=1)))
        req.stage = "architecture"           # the rewind target
        req.stage_entered_at = utcnow()      # newer than the row above
        db.commit()
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        assert row.status == "superseded"
        assert "stale reviewer" in (row.logs_tail or "")
    assert name in fake.deletions            # the leak is closed
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_kube_runner.py -k "uid or capture or supersede or predecessor or stranger" -v`
Expected: FAIL — uids never recorded, logs_tail empty on timeout/reap, superseded job never deleted.

- [ ] **Step 3: Implement in `api/app/kube_runner.py`**

(a) `_spawn_stage` and `_spawn_gate`: keep a handle to the row they add and pass it to `_create`. In `_spawn_stage`, replace `db.add(StageJob(...))` with:

```python
        row = StageJob(
            request_id=req.id,
            stage=stage,
            attempt=attempt,
            role="stage",
            job_name=name,
            epoch=get_elector().epoch,
            deadline_at=utcnow() + timedelta(seconds=settings.STAGE_WALL_CLOCK),
        )
        db.add(row)
```

and the final `return self._create(db, req, name, stage_job_manifest(...), moved)` with:

```python
        return self._create(
            db,
            req,
            row,
            stage_job_manifest(req.ref, stage, attempt, feedback=feedback),
            moved,
        )
```

Mirror the same two edits in `_spawn_gate` (its `row = StageJob(..., role="gate", deadline_at=... GATE_WALL_CLOCK)` and `self._create(db, req, row, gate_job_manifest(...), moved)`).

(b) Replace `_create` entirely:

```python
    def _create(
        self,
        db: Session,
        req: Request,
        row: StageJob,
        manifest: dict,
        moved: list[str],
    ) -> bool:
        name = row.job_name
        try:
            uid = self.client.create_job(manifest)
        except Exception as exc:
            log.exception("create_job %s failed", name)
            intents.fail(db, f"spawn:{name}", {"error": str(exc)[:300]})
            row.status = "infra"
            row.completed_at = utcnow()
            self._escalate(db, req, f"Could not create Job {name}: {exc}")
            return False
        if uid is None:
            # 409: a live Job with this deterministic name already exists.
            # Ours (intent replay after a crash) → adopt. A DYING PREDECESSOR
            # from an earlier row → park as infra; the next tick re-creates
            # once kubelet finishes tearing it down (B1 ledger: 409s).
            view = self.client.get_job(name)
            prior_uids = {
                r.job_uid
                for r in db.scalars(
                    select(StageJob).where(
                        StageJob.job_name == name, StageJob.id != row.id
                    )
                ).all()
                if r.job_uid
            }
            if view.phase != "absent" and view.uid and view.uid in prior_uids:
                intents.fail(db, f"spawn:{name}",
                             {"error": "same-name Job from a prior attempt still terminating"})
                row.status = "infra"
                row.completed_at = utcnow()
                db.commit()
                moved.append(f"{req.ref}: {name} blocked by a dying predecessor — will re-run")
                return False
            row.job_uid = view.uid or None
        else:
            row.job_uid = uid
        intents.complete(db, f"spawn:{name}", {"job": name, "uid": row.job_uid})
        db.commit()
        moved.append(f"{req.ref}: spawned {name}")
        return True
```

(c) `_observe`: right after `view = self.client.get_job(sj.job_name)` / `self._observe_failures.pop(...)`, add the stranger guard:

```python
        if view.phase != "absent" and sj.job_uid and view.uid and view.uid != sj.job_uid:
            # same name, different Job — not ours (out-of-band recreate).
            # Never grade a stranger: infra, re-run (spec §5 stale-discard).
            sj.status = "infra"
            sj.completed_at = utcnow()
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} uid changed under us — will re-run")
            return
```

(d) `_observe` running/overdue branch: replace the two capture lines with a capture=True re-fetch:

```python
            # orchestrator wall clock (spec §5): fires regardless of Job
            # status. Re-fetch WITH capture so the running pod's output is
            # preserved before the kill (B1 ledger: running-pod capture).
            view = self.client.get_job(sj.job_name, capture=True)
            sj.envelope = parse_envelope(view.termination_message)
            sj.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
```

(e) `_reap_dead_requests`: change its `view = self.client.get_job(sj.job_name)` to `view = self.client.get_job(sj.job_name, capture=True)` and update the docstring (running-pod capture is real now).

(f) `_supersede_rewound_rows`: drop `@staticmethod`, make it `def _supersede_rewound_rows(self, db, req, rows)` (the call site already reads `self._supersede_rewound_rows(db, req, all_rows)`), and replace the final mark loop with:

```python
        for row in rows:
            if (
                row.status != "superseded"
                and row.created_at < req.stage_entered_at
                and KUBE_STAGES.index(row.stage) >= target_index
            ):
                if row.status == "running":
                    # the leak fix: a superseded RUNNING row's live Job must be
                    # captured + deleted, or it runs (and bills) forever
                    try:
                        view = self.client.get_job(row.job_name, capture=True)
                        row.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
                        row.envelope = row.envelope or parse_envelope(view.termination_message)
                        self.client.delete_job(row.job_name)
                        row.completed_at = utcnow()
                    except Exception:
                        log.exception("supersede reap failed for %s", row.job_name)
                        continue  # stays running; the next tick retries — never a silent leak
                row.status = "superseded"
        db.commit()
```

- [ ] **Step 4: Run the runner suite**

Run: `cd api && uv run pytest tests/test_kube_runner.py -v`
Expected: new tests PASS; all B1 tests still PASS (adoption/park only changes the 409 path, which B1 tests never scripted).

- [ ] **Step 5: Full backend suite, then commit**

Run: `cd api && uv run pytest -q` — all green.

```bash
git add api/app/kube_runner.py api/tests/test_kube_runner.py
git commit -m "fix(kube): uid tracking on 409/recreate, capture-before-delete on every kill path, supersede leak closed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3 (unit): `api/app/workspace.py` — git-as-workspace primitives

The trusted git backbone: per-request repo the orchestrator owns and Jobs clone. Pure git + filesystem; unit-tested with real `git` in tmp dirs (git is in CI — only the *cluster* is not).

**Files:**
- Create: `api/app/workspace.py`
- Test: `api/tests/test_workspace.py` (new)

**Interfaces:**
- Produces: `workspace.workspace_for(req) -> Path` (validates ref, `settings.WORKSPACES / ref.lower()` — read dynamically so tests can monkeypatch), `work_branch(ref) -> str` (`work/<ref-lower>`), `spec_md(req) -> str`, `ensure_repo(req, spec_md) -> Path` (idempotent; NEVER touches an existing repo), `head_sha(ws, refname="HEAD") -> str | None`, `surface_hash_at(ws, sha) -> str | None` (frozen-surface hash at an exact SHA), `reset_branch(ws, ref, to_sha) -> bool`, `merge_graded(ws, ref, sha, actor) -> str | None` (error message, None = merged), `repo_url(ref) -> str` (`settings.GIT_REMOTE_BASE` + `/<ref-lower>`, `""` when unset), `BASELINE_TAG = "sf-baseline"`, `SURFACE_PATHS`.
- Tasks 5, 6 (entrypoint contract), 10 consume these.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_workspace.py`:

```python
"""Git-as-workspace primitives (Plan B2 task 3) — real git in tmp dirs.

Everything trust-critical about the kube pipeline's git backbone is proven
here without any cluster: repo creation, the push contract agent pods rely on
(updateInstead on a checked-out branch), the SHA-pinned frozen-surface hash,
attempt resets, and the SHA-precondition merge."""
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import settings, workspace
from app.ws_exec import _git


def _req(ref="REQ-7001"):
    line = SimpleNamespace(text="exports monthly totals", assume=False, prov="interview")
    return SimpleNamespace(ref=ref, title="Test subject", app_name="Northwind",
                           spec_lines=[line])


@pytest.fixture()
def ws_root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "workspaces")
    return tmp_path


def _commit_all(ws: Path, msg: str) -> str:
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", msg)
    return _git(ws, "rev-parse", "HEAD").stdout.strip()


def test_ensure_repo_builds_the_contract(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    assert (ws / ".git").exists() and (ws / "SPEC.md").exists()
    assert _git(ws, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() == "work/req-7001"
    assert _git(ws, "config", "receive.denyCurrentBranch").stdout.strip() == "updateInstead"
    assert _git(ws, "rev-parse", workspace.BASELINE_TAG).returncode == 0
    head = workspace.head_sha(ws)
    # idempotent: a second call never moves anything (pushed work is sacred)
    workspace.ensure_repo(req, "REPLACED — must not be written")
    assert workspace.head_sha(ws) == head
    assert "REPLACED" not in (ws / "SPEC.md").read_text()


def test_agent_push_contract_updateInstead(ws_root, tmp_path):
    """What an agent pod does: clone the work branch, commit, push back —
    against the orchestrator's NON-BARE repo with the branch checked out."""
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    clone = tmp_path / "podclone"
    subprocess.run(["git", "clone", "-q", "-b", "work/req-7001", str(ws), str(clone)], check=True)
    _git(clone, "config", "user.email", "agent@sf.local")
    _git(clone, "config", "user.name", "sf-agent")
    (clone / "PLAN.md").write_text("# plan\n")
    _commit_all(clone, "REQ-7001: architecture")
    push = _git(clone, "push", "-q", "origin", "HEAD:work/req-7001")
    assert push.returncode == 0, push.stderr
    assert (ws / "PLAN.md").exists()  # updateInstead refreshed the working tree
    assert workspace.head_sha(ws) == workspace.head_sha(clone)


def test_surface_hash_pins_the_test_surface(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    base = workspace.head_sha(ws)
    h0 = workspace.surface_hash_at(ws, base)
    (ws / "src" / "extra.py").write_text("x = 1\n")
    src_only = _commit_all(ws, "src change")
    assert workspace.surface_hash_at(ws, src_only) == h0      # src/ is free
    (ws / "tests" / "test_sneaky.py").write_text("def test_x():\n    assert True\n")
    tests_touched = _commit_all(ws, "tests change")
    assert workspace.surface_hash_at(ws, tests_touched) != h0  # tests/ is frozen
    assert workspace.surface_hash_at(ws, "0" * 40) is None     # unknown SHA = None


def test_reset_branch_discards_half_pushed_work(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    graded = workspace.head_sha(ws)
    (ws / "junk.py").write_text("broken = True\n")
    _commit_all(ws, "half-pushed work from a killed pod")
    assert workspace.reset_branch(ws, req.ref, graded)
    assert workspace.head_sha(ws) == graded
    assert not (ws / "junk.py").exists()


def test_merge_graded_enforces_the_sha_precondition(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    (ws / "src" / "feature.py").write_text("done = True\n")
    graded = _commit_all(ws, "REQ-7001: GREEN")
    # branch moved past the graded SHA → refuse
    (ws / "src" / "later.py").write_text("late = True\n")
    _commit_all(ws, "post-grade drift")
    err = workspace.merge_graded(ws, req.ref, graded, "op")
    assert err and "graded SHA" in err
    # rewind to the graded SHA → merge succeeds, main contains it
    workspace.reset_branch(ws, req.ref, graded)
    assert workspace.merge_graded(ws, req.ref, graded, "op") is None
    on_main = _git(ws, "merge-base", "--is-ancestor", graded, "main")
    assert on_main.returncode == 0
    assert _git(ws, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() == "main"


def test_repo_url_uses_the_remote_base(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    assert workspace.repo_url("REQ-7001") == "git://api:9418/req-7001"
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "")
    assert workspace.repo_url("REQ-7001") == ""
```

> `settings.GIT_REMOTE_BASE` does not exist yet — task 4 adds it. For THIS task add the
> one settings line early (step 3) so the module imports; the rest of task 4's knobs land there.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_workspace.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.workspace'`.

- [ ] **Step 3: Implement**

Append to `api/app/settings.py` (start of the B2 block; task 4 extends it):

```python
# ---------- git-as-workspace + cluster profile (Plan B2, spec §2/§5/§6) ----------
# Base URL agent/gate Jobs clone from (the git-daemon sidecar). Empty = no git
# backbone configured: the kube runner behaves exactly like B1 (unit tests).
GIT_REMOTE_BASE = os.environ.get("FACTORY_GIT_REMOTE_BASE", "").rstrip("/")
```

Create `api/app/workspace.py`:

```python
"""Git-as-workspace for the kube path (Plan B2; spec §5/§6).

The orchestrator OWNS one non-bare git repo per request under
settings.WORKSPACES; a git-daemon sidecar (deploy/base/factory-api.yaml)
exports the same directory to agent/gate Jobs as GIT_REMOTE_BASE/<ref>.
Everything trust-critical is computed HERE on the orchestrator's copy,
never taken from a pod's word:

  * surface_hash_at(): the frozen-test-surface hash at an exact SHA — the
    orchestrator-side pure-git check of spec §6 (config-based test
    deselection is covered by SURFACE_PATHS);
  * reset_branch(): a new attempt starts from the last graded SHA, so
    half-pushed work from a killed pod is never silently inherited (spec §5);
  * merge_graded(): merge exactly the graded SHA into main — the SHA
    precondition of spec §6, local edition (GitHub API merge is B3).

Push contract: the work branch stays checked out and the repo sets
receive.denyCurrentBranch=updateInstead, so an agent pod's push refreshes
the orchestrator's working tree in place (refused if that tree is dirty —
the orchestrator keeps it clean by construction).

settings.WORKSPACES / settings.SAMPLE / settings.GIT_REMOTE_BASE are read
at CALL time (not import) so tests can monkeypatch them.
"""
import hashlib
import re
import shutil
from pathlib import Path

from . import settings
from .ws_exec import _git

BASELINE_TAG = "sf-baseline"

# spec §6's frozen surface: tests plus every config file that could deselect
# them. Paths absent from a repo simply contribute nothing to the hash.
SURFACE_PATHS = (
    "tests",
    "conftest.py",
    "pyproject.toml",
    "pytest.ini",
    "setup.cfg",
    "tox.ini",
    "package.json",
    "vitest.config.ts",
    "angular.json",
)


def workspace_for(req) -> Path:
    if not re.fullmatch(r"REQ-\d+", req.ref or ""):
        raise ValueError(f"refusing workspace path for malformed ref {req.ref!r}")
    return Path(settings.WORKSPACES) / req.ref.lower()


def work_branch(ref: str) -> str:
    return f"work/{ref.lower()}"


def spec_md(req) -> str:
    lines = [f"# SPEC — {req.title}", "", f"Request {req.ref} · {req.app_name}", ""]
    for sl in req.spec_lines:
        tag = (
            "(ASSUMPTION — confirm before relying on it)"
            if sl.assume
            else f"(from: {sl.prov})"
        )
        lines.append(f"- {sl.text} {tag}")
    return "\n".join(lines) + "\n"


def repo_url(ref: str) -> str:
    base = settings.GIT_REMOTE_BASE
    return f"{base}/{ref.lower()}" if base else ""


def ensure_repo(req, spec: str) -> Path:
    """Create the per-request repo once; NEVER touch an existing one — agent
    pushes live there and must not be clobbered by a re-entrant tick."""
    ws = workspace_for(req)
    if (ws / ".git").exists():
        return ws
    ws.parent.mkdir(parents=True, exist_ok=True)
    if ws.exists():
        shutil.rmtree(ws)
    shutil.copytree(Path(settings.SAMPLE), ws)
    _git(ws, "init", "-b", "main")
    (ws / ".git" / "info" / "exclude").write_text(".factory/\n")
    _git(ws, "config", "user.email", "factory@local")
    _git(ws, "config", "user.name", "Factory Builder bot")
    _git(ws, "config", "receive.denyCurrentBranch", "updateInstead")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", "baseline: sample subject")
    (ws / "SPEC.md").write_text(spec)
    _git(ws, "checkout", "-q", "-B", work_branch(req.ref))
    _git(ws, "add", "SPEC.md")
    _git(ws, "commit", "-q", "-m", f"{req.ref}: approved SPEC.md")
    _git(ws, "tag", "-f", BASELINE_TAG)
    return ws


def head_sha(ws: Path, refname: str = "HEAD") -> str | None:
    out = _git(ws, "rev-parse", refname)
    return out.stdout.strip() if out.returncode == 0 else None


def surface_hash_at(ws: Path, sha: str) -> str | None:
    """sha256 over `git ls-tree <sha> -- SURFACE_PATHS` — the tree hash of
    tests/ covers every file under it; the config blobs cover deselection.
    None = the SHA does not resolve in this repo (never a pass)."""
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha or ""):
        return None
    if _git(ws, "cat-file", "-e", f"{sha}^{{commit}}").returncode != 0:
        return None
    out = _git(ws, "ls-tree", sha, "--", *SURFACE_PATHS)
    if out.returncode != 0:
        return None
    return hashlib.sha256(out.stdout.encode()).hexdigest()


def reset_branch(ws: Path, ref: str, to_sha: str) -> bool:
    """Forced: a new attempt starts from the last graded SHA (spec §5)."""
    _git(ws, "checkout", "-q", work_branch(ref))
    ok = _git(ws, "reset", "-q", "--hard", to_sha).returncode == 0
    _git(ws, "clean", "-fdq")
    return ok


def merge_graded(ws: Path, ref: str, sha: str, actor: str) -> str | None:
    """Merge exactly the graded SHA into main. Returns an error string, or
    None on success (main checked out — 'deployed' in the B2 sense)."""
    head = head_sha(ws, work_branch(ref))
    if head != sha:
        return (
            f"work branch head {(head or 'missing')[:12]} is not the graded "
            f"SHA {sha[:12]} — refusing to merge"
        )
    _git(ws, "checkout", "-q", "main")
    merge = _git(ws, "merge", "--no-ff", "-q", "-m",
                 f"{ref}: merge (approved by {actor})", sha)
    if merge.returncode != 0:
        _git(ws, "merge", "--abort")
        _git(ws, "checkout", "-q", work_branch(ref))
        return (merge.stderr or merge.stdout).strip()[:200] or "git merge error"
    return None
```

- [ ] **Step 4: Run the tests**

Run: `cd api && uv run pytest tests/test_workspace.py -v`
Expected: all PASS.

- [ ] **Step 5: Full backend suite, then commit**

Run: `cd api && uv run pytest -q` — all green.

```bash
git add api/app/workspace.py api/app/settings.py api/tests/test_workspace.py
git commit -m "feat(workspace): git-as-workspace primitives — ensure_repo, SHA-pinned surface hash, reset, SHA-precondition merge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4 (unit): Job manifests v2 — ServiceAccounts, securityContext, git + CLI env, secret mounts

The manifests must match what the sf-agent image (task 6) reads and what the cluster (tasks 7–8) provides. Everything here is pure-function and unit-tested.

**Files:**
- Modify: `api/app/settings.py` (extend the B2 block)
- Modify: `api/app/kube_jobs.py`
- Test: `api/tests/test_kube_jobs.py` (append)

**Interfaces:**
- Produces settings: `KUBE_RUN_AS_UID` (`FACTORY_KUBE_RUN_AS_UID`, `10101`), `KUBE_AGENT_SA` (`FACTORY_KUBE_AGENT_SA`, `"sf-agent"`), `KUBE_GATE_SA` (`FACTORY_KUBE_GATE_SA`, `"sf-gate"`), `CODEX_AUTH_SECRET` (`FACTORY_CODEX_AUTH_SECRET`, `"sf-codex-auth"`).
- Produces: `gate_job_manifest(ref, stage, attempt, *, sha="", review_verdict="") -> dict` (extended signature — B1 call sites keep working via the defaults).
- Manifest contract (pinned by tests):
  - pod securityContext: `runAsNonRoot: true`, `runAsUser: KUBE_RUN_AS_UID`, `runAsGroup: 0`, `fsGroup: 0`, `seccompProfile.type: RuntimeDefault`; container: `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]` — restricted-SCC compatibility proven locally (spec §2/§5);
  - `serviceAccountName`: `KUBE_AGENT_SA` for role=stage, `KUBE_GATE_SA` for role=gate (`automountServiceAccountToken: false` stays);
  - `imagePullPolicy: IfNotPresent` (kind-loaded `:dev` images);
  - an `emptyDir` volume mounted at `/workspace` + env `HOME=/workspace` (arbitrary-UID home, spec §5) on BOTH roles;
  - stage pods additionally mount Secret `CODEX_AUTH_SECRET` (optional) read-only at `/secrets/codex`; gate pods do NOT (no LLM credential in gates, spec §6);
  - env: both roles get `SF_REPO_URL` + `SF_BRANCH` **only when** `settings.GIT_REMOTE_BASE` is set; stage pods get `SF_CLI` (from `agent_cli()`) and `SF_MODEL`; gate pods get `SF_SHA` (may be empty) and, for the review gate, `SF_REVIEW_VERDICT`.
- Tasks 5, 6, 8 consume this contract.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_kube_jobs.py`:

```python
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
    assert c["securityContext"] == {"allowPrivilegeEscalation": False,
                                    "capabilities": {"drop": ["ALL"]}}
    assert c["imagePullPolicy"] == "IfNotPresent"
    assert pod["automountServiceAccountToken"] is False
    assert {"name": "workspace", "mountPath": "/workspace"} in c["volumeMounts"]
    assert {"name": "workspace", "emptyDir": {}} in pod["volumes"]
    assert _env(m)["HOME"] == "/workspace"


def test_service_accounts_split_by_role():
    assert _pod(stage_job_manifest("REQ-2052", "red", 1))["serviceAccountName"] == settings.KUBE_AGENT_SA
    assert _pod(gate_job_manifest("REQ-2052", "red", 1))["serviceAccountName"] == settings.KUBE_GATE_SA


def test_codex_secret_only_on_stage_pods():
    stage = _pod(stage_job_manifest("REQ-2052", "red", 1))
    gate = _pod(gate_job_manifest("REQ-2052", "red", 1))
    assert any(v.get("secret", {}).get("secretName") == settings.CODEX_AUTH_SECRET
               for v in stage["volumes"])
    assert {"name": "codex-auth", "mountPath": "/secrets/codex", "readOnly": True} \
        in stage["containers"][0]["volumeMounts"]
    assert not any("secret" in v for v in gate["volumes"])  # no LLM credential in gates (spec §6)


def test_git_env_rides_the_remote_base(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    env = _env(stage_job_manifest("REQ-2052", "green", 2))
    assert env["SF_REPO_URL"] == "git://api:9418/req-2052"
    assert env["SF_BRANCH"] == "work/req-2052"
    assert env["SF_CLI"] in ("codex", "opencode", "claude")
    genv = _env(gate_job_manifest("REQ-2052", "green", 2, sha="a" * 40))
    assert genv["SF_SHA"] == "a" * 40 and genv["SF_REPO_URL"] == "git://api:9418/req-2052"
    assert "SF_CLI" not in genv          # gates never run a CLI
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "")
    assert "SF_REPO_URL" not in _env(stage_job_manifest("REQ-2052", "green", 2))


def test_review_gate_carries_the_reviewer_verdict():
    env = _env(gate_job_manifest("REQ-2052", "review", 1, sha="b" * 40,
                                 review_verdict="APPROVE — implements the spec"))
    assert env["SF_REVIEW_VERDICT"].startswith("APPROVE")
    assert "SF_REVIEW_VERDICT" not in _env(gate_job_manifest("REQ-2052", "red", 1))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_kube_jobs.py -k "restricted or accounts or secret_only or remote_base or reviewer" -v`
Expected: FAIL — no securityContext/serviceAccountName/volumes in the manifests, `gate_job_manifest` rejects the new kwargs, settings knobs missing.

- [ ] **Step 3: Extend settings**

Append to the B2 block in `api/app/settings.py` (after `GIT_REMOTE_BASE`):

```python
# Forced non-root UID for agent/gate pods — restricted-SCC behavior is proven
# locally, not discovered at the office (spec §2). Any high UID works; the
# image is built to arbitrary-UID conventions (root group, g=u, HOME=/workspace).
KUBE_RUN_AS_UID = int(os.environ.get("FACTORY_KUBE_RUN_AS_UID", "10101"))
KUBE_AGENT_SA = os.environ.get("FACTORY_KUBE_AGENT_SA", "sf-agent")
KUBE_GATE_SA = os.environ.get("FACTORY_KUBE_GATE_SA", "sf-gate")
# Secret carrying the operator's ~/.codex/auth.json (task sync-codex-auth);
# mounted ONLY into stage pods — gates hold no LLM credential (spec §6).
CODEX_AUTH_SECRET = os.environ.get("FACTORY_CODEX_AUTH_SECRET", "sf-codex-auth")
```

- [ ] **Step 4: Implement the manifest changes in `api/app/kube_jobs.py`**

Add imports and a model helper near the top (after the existing imports):

```python
from .agent_exec import agent_cli


def _agent_model() -> str:
    cli = agent_cli()
    if cli == "codex":
        return settings.CODEX_MODEL
    if cli == "opencode":
        return settings.OPENCODE_MODEL
    if cli == "claude":
        return settings.CLAUDE_MODEL
    return ""
```

Replace `_base_job` with:

```python
def _base_job(
    name: str,
    *,
    role: str,
    ref: str,
    stage: str,
    attempt: int,
    deadline: int,
    env: dict,
) -> dict:
    env = {"HOME": "/workspace", **env}
    if settings.GIT_REMOTE_BASE:
        env.setdefault("SF_REPO_URL", f"{settings.GIT_REMOTE_BASE}/{ref.lower()}")
        env.setdefault("SF_BRANCH", f"work/{ref.lower()}")
    volumes: list[dict] = [{"name": "workspace", "emptyDir": {}}]
    mounts: list[dict] = [{"name": "workspace", "mountPath": "/workspace"}]
    if role == "stage":
        # optional: environments without the secret still schedule; the
        # entrypoint fails LOUDLY if the chosen CLI needs it and it is absent
        volumes.append({"name": "codex-auth",
                        "secret": {"secretName": settings.CODEX_AUTH_SECRET,
                                   "optional": True}})
        mounts.append({"name": "codex-auth", "mountPath": "/secrets/codex",
                       "readOnly": True})
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "labels": {
                "sf/tier": "agent",
                "sf/role": role,
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
                    {
                        "action": "Ignore",
                        "onPodConditions": [{"type": "DisruptionTarget"}],
                    },
                ],
            },
            "template": {
                "metadata": {
                    "labels": {
                        "sf/tier": "agent",
                        "sf/role": role,
                        "sf/request": ref.lower(),
                    }
                },
                "spec": {
                    "restartPolicy": "Never",
                    "automountServiceAccountToken": False,
                    "serviceAccountName": (
                        settings.KUBE_AGENT_SA if role == "stage" else settings.KUBE_GATE_SA
                    ),
                    "securityContext": {
                        # restricted-SCC emulation (spec §2): forced non-root
                        # UID + root group (the image is chmod g=u)
                        "runAsNonRoot": True,
                        "runAsUser": settings.KUBE_RUN_AS_UID,
                        "runAsGroup": 0,
                        "fsGroup": 0,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "volumes": volumes,
                    "containers": [
                        {
                            "name": "main",
                            "image": settings.AGENT_IMAGE,
                            "imagePullPolicy": "IfNotPresent",
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "env": [
                                {"name": key, "value": str(value)}
                                for key, value in env.items()
                            ],
                            "volumeMounts": mounts,
                            "resources": {
                                "requests": {"cpu": "500m", "memory": "1Gi"},
                                "limits": {"cpu": "2", "memory": "4Gi"},
                            },
                            "terminationMessagePolicy": "File",
                        }
                    ],
                },
            },
        },
    }
```

Extend `stage_job_manifest`'s env dict (the CLI contract):

```python
    env = {
        "SF_REF": ref,
        "SF_STAGE": stage,
        "SF_ATTEMPT": attempt,
        "SF_ROLE": "stage",
        "SF_CLI": agent_cli(),
        "SF_MODEL": _agent_model(),
    }
```

Replace `gate_job_manifest` with:

```python
def gate_job_manifest(
    ref: str, stage: str, attempt: int, *, sha: str = "", review_verdict: str = ""
) -> dict:
    env = {
        "SF_REF": ref,
        "SF_STAGE": stage,
        "SF_ATTEMPT": attempt,
        "SF_ROLE": "gate",
        "SF_SHA": sha,  # the PINNED SHA the gate grades (spec §6); "" = branch head
    }
    if stage == "review" and review_verdict:
        # the read-only review stage pushes nothing; its verdict reaches the
        # review gate's metrics via the orchestrator (spec §5)
        env["SF_REVIEW_VERDICT"] = review_verdict[:500]
    return _base_job(
        job_name(ref, stage, attempt, gate=True),
        role="gate",
        ref=ref,
        stage=stage,
        attempt=attempt,
        deadline=settings.GATE_ACTIVE_DEADLINE,
        env=env,
    )
```

- [ ] **Step 5: Run the kube suites**

Run: `cd api && uv run pytest tests/test_kube_jobs.py tests/test_kube_runner.py tests/test_kube_wiring.py -q`
Expected: all green (B1's manifest tests still pass — nothing they asserted was removed; `SF_GATE_FEEDBACK`/`SF_STAGE`/`SF_ATTEMPT`/`SF_ROLE` are unchanged).

- [ ] **Step 6: Full backend suite, then commit**

Run: `cd api && uv run pytest -q` — all green.

```bash
git add api/app/settings.py api/app/kube_jobs.py api/tests/test_kube_jobs.py
git commit -m "feat(kube): manifests v2 — per-tier ServiceAccounts, restricted securityContext, git/CLI env, codex secret on stage pods only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5 (unit): Runner git integration — trusted surface hash, attempt resets, SHA-precondition merge

Wires task 3's primitives into `KubeJobRunner`. **Activation rule:** everything in this task is gated on `settings.GIT_REMOTE_BASE` being non-empty; with it empty (the unit-test default) the runner behaves exactly like B1, so every existing test keeps passing.

**Files:**
- Modify: `api/app/kube_runner.py`
- Modify: `api/app/routers/gates.py:48-51`
- Test: `api/tests/test_kube_runner.py` (append)

**Interfaces:**
- Consumes: `workspace.*` (task 3), `gate_job_manifest(..., sha=, review_verdict=)` (task 4).
- Produces: `KubeJobRunner.approve_merge(db, req, actor: str) -> None` — kube-mode merge approve: with a git workspace + graded SHA it performs `workspace.merge_graded` then the `finish_done` transition; without them it delegates to `simulator.approve_merge` (B1-compatible). `gates.py` dispatches `pipeline().approve_merge` for `runner_mode() in ("agent", "kube")`.
- Behavior contract (pinned by tests):
  1. Before every stage-Job spawn (git mode): `workspace.ensure_repo` + `workspace.reset_branch` to the last graded SHA (or `BASELINE_TAG`) — half-pushed work is never inherited (spec §5).
  2. Gate spawns pin the SHA: `SF_SHA` = the succeeded stage row's `envelope["sha"]`; the review gate also gets `SF_REVIEW_VERDICT` from the review stage's `envelope["detail"]`.
  3. Green grading (git mode): the orchestrator compares `surface_hash_at(ws, red_sha)` vs `surface_hash_at(ws, green_sha)` — an unresolvable SHA is a **violation**, never a pass; without git/SHAs it falls back to B1's envelope comparison.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_kube_runner.py`:

```python
# ---------- B2 task 5: git-backed grading, resets, merge ----------
import shutil

from app import workspace
from app.ws_exec import _git


def _git_mode(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "kube-ws")


def _commit_all(ws, msg):
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", msg)
    return _git(ws, "rev-parse", "HEAD").stdout.strip()


def git_backed_cluster(fake, ws_root, *, green_cheats=False):
    """Agents that REALLY commit: each stage job writes to the request's
    workspace (standing in for the pod's clone+push) and reports its sha;
    gates pass verdicts whose envelope hashes are junk — proving the
    orchestrator now trusts only its OWN git computation."""
    import json as _json

    def run(name, job):
        if job.phase != "running":
            return
        if name.endswith("-gate"):
            v = pass_verdict(surface_hash="junk-" + name[-12:])  # untrusted + inconsistent
            job.phase = "succeeded"
            job.termination_message = _json.dumps(v)
            return
        env = {e["name"]: e["value"] for e in job.manifest["spec"]["template"]["spec"]["containers"][0]["env"]}
        ref, stage = env["SF_REF"], env["SF_STAGE"]
        ws = ws_root / ref.lower()
        if stage == "architecture":
            (ws / "PLAN.md").write_text("# plan\n")
        elif stage == "red":
            (ws / "tests" / "test_b2.py").write_text("def test_b2():\n    assert False\n")
        elif stage == "green":
            (ws / "src" / "b2.py").write_text("done = True\n")
            if green_cheats:
                (ws / "tests" / "test_b2.py").write_text("def test_b2():\n    assert True\n")
        sha = _commit_all(ws, f"{ref}: {stage}") if stage != "review" else \
            _git(ws, "rev-parse", "HEAD").stdout.strip()
        job.phase = "succeeded"
        job.termination_message = _json.dumps(
            {"v": 1, "outcome": "ok",
             "detail": "APPROVE — looks right" if stage == "review" else "stage complete",
             "sha": sha})

    fake.on_observe = run


def test_git_grading_passes_an_honest_run_and_pins_shas(client, monkeypatch, tmp_path):
    _git_mode(monkeypatch, tmp_path)
    runner, fake = make_runner()
    git_backed_cluster(fake, tmp_path / "kube-ws")
    d = _approved(client, "Kube git honest")
    out = tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")
    assert out["stage"] == "review" and not out["needs_human"]
    ref = out["ref"].lower()
    ws = tmp_path / "kube-ws" / ref
    assert (ws / ".git").exists() and (ws / "PLAN.md").exists()
    # gates were spawned WITH the pinned SHA of the stage they grade
    red_gate = next(m for m in fake.creations
                    if m["metadata"]["name"] == f"sf-{ref}-red-1-gate")
    env = {e["name"]: e["value"] for e in red_gate["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert len(env["SF_SHA"]) == 40
    review_gate = next(m for m in fake.creations
                       if m["metadata"]["name"] == f"sf-{ref}-review-1-gate")
    renv = {e["name"]: e["value"] for e in review_gate["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert renv["SF_REVIEW_VERDICT"].startswith("APPROVE")


def test_git_grading_catches_a_cheating_implementer(client, monkeypatch, tmp_path):
    """The gate pod says PASS with a junk hash both times; only the
    orchestrator's own git computation catches the frozen-surface change."""
    _git_mode(monkeypatch, tmp_path)
    runner, fake = make_runner()
    git_backed_cluster(fake, tmp_path / "kube-ws", green_cheats=True)
    d = _approved(client, "Kube git cheater")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    assert "Test-isolation gate" in out["needs_human_reason"]


def test_retry_resets_the_branch_to_the_last_graded_sha(client, monkeypatch, tmp_path):
    """Attempt 2 must not inherit attempt 1's half-pushed commit (spec §5)."""
    _git_mode(monkeypatch, tmp_path)
    runner, fake = make_runner()
    stray_holder = {}

    import json as _json

    def run(name, job):
        if job.phase != "running":
            return
        env = {e["name"]: e["value"] for e in job.manifest["spec"]["template"]["spec"]["containers"][0]["env"]}
        ref = env.get("SF_REF", "")
        ws = tmp_path / "kube-ws" / ref.lower()
        if name.endswith("-gate"):
            if "-architecture-1-gate" in name:
                v = fail_verdict("architecture gate: PLAN.md missing")
            else:
                v = pass_verdict()
            job.phase = "succeeded"
            job.termination_message = _json.dumps(v)
            return
        if name.endswith("-architecture-1"):
            (ws / "HALFDONE.md").write_text("junk\n")     # half-pushed work
            sha = _commit_all(ws, "half done")
            stray_holder["sha"] = sha
        else:
            (ws / "PLAN.md").write_text("# plan\n")
            sha = _commit_all(ws, "plan")
        job.phase = "succeeded"
        job.termination_message = _json.dumps({"v": 1, "outcome": "ok", "detail": "d", "sha": sha})

    fake.on_observe = run
    d = _approved(client, "Kube git reset")
    ref = d["ref"].lower()
    tick_until(client, runner, d["id"],
               lambda o: any(f"sf-{ref}-architecture-2" == m["metadata"]["name"]
                             for m in fake.creations), limit=12)
    ws = tmp_path / "kube-ws" / ref
    assert not (ws / "HALFDONE.md").exists()               # reset to sf-baseline
    assert workspace.head_sha(ws) != stray_holder["sha"]


def test_kube_approve_merge_merges_the_graded_sha(client, monkeypatch, tmp_path):
    _git_mode(monkeypatch, tmp_path)
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    from fastapi.testclient import TestClient

    from app.main import create_app

    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake)
    git_backed_cluster(fake, tmp_path / "kube-ws")
    app = create_app(auto_tick=0, runner=runner)
    with TestClient(app) as c:
        d = approved_request(
            c, title="Kube git merge",
            description="Add a monthly_export function that returns the export format name.")
        out = d
        for _ in range(40):
            if out["gate"] == "approve_merge":
                break
            c.post("/api/simulator/tick")
            out = c.get(f"/api/requests/{d['id']}").json()
        assert out["gate"] == "approve_merge"
        ws = tmp_path / "kube-ws" / d["ref"].lower()
        graded = workspace.head_sha(ws, f"work/{d['ref'].lower()}")
        done = c.post(f"/api/requests/{d['id']}/approve", json={"operator_id": 1}).json()
        assert done["status"] == "done" and done["stage"] == "done"
        assert _git(ws, "merge-base", "--is-ancestor", graded, "main").returncode == 0
    shutil.rmtree(tmp_path / "kube-ws", ignore_errors=True)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_kube_runner.py -k git -v`
Expected: FAIL — no workspace is ever created (`PLAN.md` write blows up on a missing dir), `SF_SHA` absent, merge approve routes to the simulator.

- [ ] **Step 3: Implement in `api/app/kube_runner.py`**

(a) Imports: add `from . import workspace` to the existing `from . import intents, settings, transitions, verification` line's neighborhood, and `from . import simulator` for the merge fallback:

```python
from . import intents, settings, simulator, transitions, verification, workspace
```

(b) Add two helpers to `KubeJobRunner` (below `_escalate`):

```python
    # ---------- git-as-workspace (B2): the trusted side of the pipeline ----------
    def _last_graded_sha(self, db: Session, req: Request) -> str | None:
        """The newest stage SHA whose gate succeeded — the only safe branch
        state for a fresh attempt (spec §5 attempt semantics)."""
        rows = db.scalars(
            select(StageJob)
            .where(StageJob.request_id == req.id)
            .order_by(StageJob.id)
        ).all()
        for gate in reversed(rows):
            if gate.role != "gate" or gate.status != "succeeded":
                continue
            stage_row = next(
                (r for r in reversed(rows)
                 if r.role == "stage" and r.status == "succeeded"
                 and r.stage == gate.stage and r.attempt == gate.attempt),
                None,
            )
            sha = (stage_row.envelope or {}).get("sha") if stage_row else None
            if sha:
                return sha
        return None

    def _prepare_workspace(self, db: Session, req: Request) -> None:
        """Before an agent Job clones: the repo exists and the work branch
        sits at the last graded SHA (or the SPEC baseline). A no-op between
        clean stages; the reset that matters happens on retries."""
        if not settings.GIT_REMOTE_BASE:
            return  # no git backbone configured: B1 behavior (unit fakes)
        ws = workspace.ensure_repo(req, workspace.spec_md(req))
        target = self._last_graded_sha(db, req) or workspace.BASELINE_TAG
        if not workspace.reset_branch(ws, req.ref, target):
            raise RuntimeError(f"could not reset {req.ref} work branch to {target}")
```

(c) `_spawn_stage`: first line of the body becomes:

```python
        self._prepare_workspace(db, req)
        name = job_name(req.ref, stage, attempt)
```

(The tick loop's existing per-request `except` turns a workspace failure into an escalation — same policy as AgentRunner's workspace failures.)

(d) `_spawn_gate`: pin the SHA. After `name = job_name(...)`, add:

```python
        stage_row = db.scalar(
            select(StageJob)
            .where(
                StageJob.request_id == req.id,
                StageJob.stage == stage,
                StageJob.attempt == attempt,
                StageJob.role == "stage",
                StageJob.status == "succeeded",
            )
            .order_by(StageJob.id.desc())
        )
        stage_env = (stage_row.envelope or {}) if stage_row else {}
        pinned_sha = stage_env.get("sha") or ""
        review_verdict = (stage_env.get("detail") or "") if stage == "review" else ""
```

and change the final `_create` call's manifest to:

```python
            gate_job_manifest(req.ref, stage, attempt, sha=pinned_sha,
                              review_verdict=review_verdict),
```

(e) `_grade`: replace the green frozen-surface block with a trusted-source-first version:

```python
        if verdict == "pass" and sj.stage == "green":
            source = self._surface_check(db, req, sj)
            if source == "violated":
                verdict = "fail"
                envelope = {
                    **envelope,
                    "reason": "Test-isolation gate: the frozen test surface changed after RED — change rejected",
                }
                sj.envelope = envelope
            elif source == "unavailable":
                # B1 fallback: no git backbone/SHAs — compare the (untrusted)
                # gate-envelope hashes, better than nothing
                red = db.scalar(
                    select(StageJob)
                    .where(
                        StageJob.request_id == req.id,
                        StageJob.stage == "red",
                        StageJob.role == "gate",
                        StageJob.status == "succeeded",
                    )
                    .order_by(StageJob.id.desc())
                )
                red_hash = (red.envelope or {}).get("surface_hash") if red else None
                if not red_hash or envelope.get("surface_hash") != red_hash:
                    verdict = "fail"
                    envelope = {
                        **envelope,
                        "reason": "Test-isolation gate: the frozen test surface changed after RED — change rejected",
                    }
                    sj.envelope = envelope
```

and add the helper below `_prepare_workspace`:

```python
    def _surface_check(self, db: Session, req: Request, sj: StageJob) -> str:
        """'ok' | 'violated' | 'unavailable'. The orchestrator computes the
        frozen-surface hash at red's and green's PUSHED SHAs on its own repo
        (spec §6) — the gate pod's claimed hash is never load-bearing here.
        A SHA that does not resolve is a violation, never a pass."""
        if not settings.GIT_REMOTE_BASE:
            return "unavailable"
        ws = workspace.workspace_for(req)
        if not (ws / ".git").exists():
            return "unavailable"

        def _stage_sha(stage: str, attempt: int | None) -> str | None:
            q = (
                select(StageJob)
                .where(
                    StageJob.request_id == req.id,
                    StageJob.stage == stage,
                    StageJob.role == "stage",
                    StageJob.status == "succeeded",
                )
                .order_by(StageJob.id.desc())
            )
            if attempt is not None:
                q = q.where(StageJob.attempt == attempt)
            row = db.scalar(q)
            return (row.envelope or {}).get("sha") if row else None

        red_sha = _stage_sha("red", None)
        green_sha = _stage_sha("green", sj.attempt)
        if not red_sha or not green_sha:
            return "unavailable"
        red_hash = workspace.surface_hash_at(ws, red_sha)
        green_hash = workspace.surface_hash_at(ws, green_sha)
        if red_hash is None or green_hash is None:
            return "violated"  # an agent claiming an unknown SHA never passes
        return "ok" if red_hash == green_hash else "violated"
```

(f) Add `approve_merge` (after `_finish_review`):

```python
    # ---------- the human merge gate (kube mode) ----------
    def approve_merge(self, db: Session, req: Request, actor: str) -> None:
        """SHA-precondition merge (spec §6, local edition): merge exactly the
        last graded SHA into main, or escalate. Without a git workspace (no
        GIT_REMOTE_BASE — B1-shaped runs) delegate to the simulator's
        finish_done, which was B1's contract."""
        ws = workspace.workspace_for(req)
        sha = self._last_graded_sha(db, req)
        if not settings.GIT_REMOTE_BASE or not (ws / ".git").exists() or not sha:
            simulator.approve_merge(db, req, actor)
            return
        err = workspace.merge_graded(ws, req.ref, sha, actor)
        if err:
            self._escalate(db, req, f"Merge failed: {err}")
            return
        res = transitions.apply(
            db,
            req,
            "finish_done",
            actor=transitions.Actor(name=actor),
            params={
                "merge_note": "work branch merged to main",
                "deploy_title": "Deployed — main updated in the Subject workspace",
                "payload_extra": {"merged": True, "workspace": str(ws), "sha": sha},
            },
        )
        if isinstance(res, transitions.Loss):
            log.info("%s: finish_done lost (%s)", req.ref, res.detail)
            return
        db.commit()
        log.info("%s merged to main at %s by %s", req.ref, sha[:12], actor)
```

- [ ] **Step 4: Dispatch kube merges in `api/app/routers/gates.py`**

Replace the two-line dispatch inside `approve` (lines 48–51):

```python
        if runner_mode() in ("agent", "kube"):
            pipeline().approve_merge(db, r, actor.name)
        else:
            simulator.approve_merge(db, r, actor.name)
```

(`KubeJobRunner.approve_merge` self-falls-back to the simulator when no git backbone is configured, so `test_kube_wiring.py`'s existing merge assertion keeps passing.)

- [ ] **Step 5: Run the kube + gates suites**

Run: `cd api && uv run pytest tests/test_kube_runner.py tests/test_kube_wiring.py tests/test_workspace.py -v`
Expected: all PASS — the four new git tests, and every B1 test untouched (empty `GIT_REMOTE_BASE` short-circuits everything new).

- [ ] **Step 6: Full backend suite + verify, then commit**

Run: `cd api && uv run pytest -q` — all green. Then from the repo root: `task verify` — green (show the output).

```bash
git add api/app/kube_runner.py api/app/routers/gates.py api/tests/test_kube_runner.py
git commit -m "feat(kube): git-backed grading — orchestrator-computed surface hash, attempt resets, SHA-precondition merge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6 (docker): the sf-agent image — Dockerfile, entrypoint, prompts, gate script

One image serves stage AND gate Jobs (spec §5; gates just get no LLM egress/credential). Built to arbitrary-UID conventions. Verified locally with `docker run --user 12345:0` against a fixture repo — no cluster, no LLM needed (one optional LLM step at the end).

**Files:**
- Create: `docker/sf-agent/Dockerfile`
- Create: `docker/sf-agent/entrypoint.sh`
- Create: `docker/sf-agent/gate.sh`
- Create: `docker/sf-agent/prompts/architecture.md`, `docker/sf-agent/prompts/red.md`, `docker/sf-agent/prompts/green.md`, `docker/sf-agent/prompts/review.md`

**Interfaces:**
- Consumes the Job env contract from task 4: `SF_REF, SF_STAGE, SF_ATTEMPT, SF_ROLE, SF_REPO_URL, SF_BRANCH, SF_CLI, SF_MODEL, SF_GATE_FEEDBACK, SF_SHA, SF_REVIEW_VERDICT, SF_TERMLOG(test hook), HOME=/workspace`, `/secrets/codex/auth.json` (stage pods).
- Produces the envelope/NDJSON contract B1's parsers already understand: agent envelope `{"v":1,"outcome":"ok"|"fail","detail":str,"sha":str|null}`; gate envelope `{"v":1,"outcome":"pass"|"fail","reason":str,"surface_hash":null,"metrics":{...}|null}`; NDJSON `{"type":...}` lines on stdout.
- The review stage is READ-ONLY: it pushes nothing; its verdict rides `detail` (→ `SF_REVIEW_VERDICT` on the review gate, task 5).

- [ ] **Step 1: Write the prompts**

`docker/sf-agent/prompts/architecture.md`:

```markdown
You are the architect stage of a software factory. Read SPEC.md and the code under src/.
Write PLAN.md: a short implementation plan — which functions in src/ change or get added,
what the public behavior must be, and which tests will prove it. Do NOT change any code.
Keep it under 40 lines. End by confirming PLAN.md is written.
You are headless: act now, in this one turn, and never ask for confirmation.
```

`docker/sf-agent/prompts/red.md`:

```markdown
You are the test-author stage. Read SPEC.md and PLAN.md. Write failing pytest tests under
tests/ ONLY (never touch src/) that pin the NEW behavior the spec demands. The existing
tests must stay green. Run pytest to confirm your new tests fail because the feature is
missing — assertion failures, not import errors.
You are headless: act now, in this one turn, and never ask for confirmation.
```

`docker/sf-agent/prompts/green.md`:

```markdown
You are the implementer stage. Make the failing tests pass by editing src/ ONLY. You are
FORBIDDEN from editing anything under tests/ or any pytest configuration — a CI gate rejects
any change there. Read PLAN.md, implement, run pytest until the whole suite is green.
You are headless: act now, in this one turn, and never ask for confirmation.
```

`docker/sf-agent/prompts/review.md`:

```markdown
You are the read-only reviewer stage. Review the work branch against SPEC.md and PLAN.md:
does the implementation honor the spec, are the tests meaningful, any risks. Do not modify
any file. Start your answer with a verdict line: APPROVE or REQUEST-CHANGES, then at most
20 lines of reasoning.
You are headless: act now, in this one turn, and never ask for confirmation.
```

- [ ] **Step 2: Write `docker/sf-agent/entrypoint.sh`**

```bash
#!/usr/bin/env bash
# sf-agent entrypoint (Plan B2; spec §5): clone the work branch, run the
# stage (or hand off to the gate script), report a status envelope in the
# termination message and structured NDJSON on stdout.
#
# Output contract (B1 parsers):
#   stage envelope: {"v":1,"outcome":"ok"|"fail","detail":str,"sha":str|null}
#   NDJSON logs:    {"type":"note"|"review"|"pytest","text":str} per line
set -uo pipefail

TERMLOG="${SF_TERMLOG:-/dev/termination-log}"
write_envelope() { printf '%s' "$1" > "$TERMLOG" 2>/dev/null || printf 'ENVELOPE %s\n' "$1"; }
note() { jq -cn --arg t "$1" '{type:"note",text:$t}'; }
die_stage() {
  note "$1"
  write_envelope "$(jq -cn --arg d "$1" '{v:1,outcome:"fail",detail:$d,sha:null}')"
  exit 1
}

: "${SF_REF:?}" "${SF_STAGE:?}" "${SF_ROLE:?}" "${SF_REPO_URL:?}" "${SF_BRANCH:?}"
REPO=/workspace/repo

note "cloning $SF_REPO_URL ($SF_BRANCH)"
git clone -q --branch "$SF_BRANCH" "$SF_REPO_URL" "$REPO" || die_stage "clone failed: $SF_REPO_URL"
cd "$REPO"
git config user.email agent@sf.local
git config user.name "sf-agent"

if [ "$SF_ROLE" = "gate" ]; then
  exec /opt/sf/gate.sh
fi

# ---------------- stage ----------------
PROMPT_FILE="/opt/sf/prompts/${SF_STAGE}.md"
[ -f "$PROMPT_FILE" ] || die_stage "unknown stage $SF_STAGE"
PROMPT="$(cat "$PROMPT_FILE")"
if [ -n "${SF_GATE_FEEDBACK:-}" ]; then
  PROMPT="$PROMPT

The previous attempt failed its gate. Gate feedback to fix in THIS attempt:
${SF_GATE_FEEDBACK}"
fi

OUT=/workspace/agent-output.txt
CLI="${SF_CLI:-codex}"
case "$CLI" in
  codex)
    export CODEX_HOME=/workspace/.codex
    mkdir -p "$CODEX_HOME"
    if [ -f /secrets/codex/auth.json ]; then
      # copied, not mounted: codex refreshes tokens in place and the mount is read-only
      cp /secrets/codex/auth.json "$CODEX_HOME/auth.json"
    else
      die_stage "SF_CLI=codex but no /secrets/codex/auth.json — run 'task sync-codex-auth'"
    fi
    SANDBOX=workspace-write
    [ "$SF_STAGE" = "review" ] && SANDBOX=read-only
    codex exec --skip-git-repo-check -s "$SANDBOX" --cd "$REPO" \
      ${SF_MODEL:+-m "$SF_MODEL"} "$PROMPT" > "$OUT" 2>&1 \
      || die_stage "codex exec failed: $(tail -c 400 "$OUT")"
    ;;
  opencode)
    CFG=/opt/sf/opencode/factory-write.json
    [ "$SF_STAGE" = "review" ] && CFG=/opt/sf/opencode/factory-readonly.json
    OPENCODE_CONFIG="$CFG" opencode run --format json --dir "$REPO" \
      ${SF_MODEL:+-m "$SF_MODEL"} "$PROMPT" > "$OUT" 2>&1 \
      || die_stage "opencode run failed: $(tail -c 400 "$OUT")"
    ;;
  *)
    die_stage "unsupported SF_CLI '$CLI'"
    ;;
esac
note "agent finished; output $(wc -c < "$OUT" | tr -d ' ') bytes"

if [ "$SF_STAGE" = "review" ]; then
  # read-only stage: NOTHING is pushed (spec §5) — the review reaches the
  # event log via captured NDJSON, its verdict via the envelope detail
  jq -cn --arg t "$(tail -c 20000 "$OUT")" '{type:"review",text:$t}'
  VERDICT="$(grep -m1 -oE 'APPROVE|REQUEST-CHANGES' "$OUT" || echo 'no explicit verdict')"
  SHA="$(git rev-parse HEAD)"
  write_envelope "$(jq -cn --arg d "$VERDICT" --arg s "$SHA" \
    '{v:1,outcome:"ok",detail:$d,sha:$s}')"
  exit 0
fi

git add -A
git commit -q -m "$SF_REF: $SF_STAGE (attempt ${SF_ATTEMPT:-1})" 2>/dev/null \
  || note "stage produced no changes — the gate will judge the unchanged SHA"
git push -q origin "HEAD:$SF_BRANCH" || die_stage "push to $SF_BRANCH failed"
SHA="$(git rev-parse HEAD)"
write_envelope "$(jq -cn --arg s "$SHA" '{v:1,outcome:"ok",detail:"stage complete",sha:$s}')"
```

- [ ] **Step 3: Write `docker/sf-agent/gate.sh`**

```bash
#!/usr/bin/env bash
# Gate Job (spec §6): deterministic, factory-owned checks at the PINNED SHA.
# No LLM, no push credential ever reaches this path. Verdicts are advisory
# input to the orchestrator; the frozen-surface decision is computed on the
# orchestrator's own git copy, so surface_hash here is always null.
set -uo pipefail
cd /workspace/repo

TERMLOG="${SF_TERMLOG:-/dev/termination-log}"
write_envelope() { printf '%s' "$1" > "$TERMLOG" 2>/dev/null || printf 'ENVELOPE %s\n' "$1"; }
note() { jq -cn --arg t "$1" '{type:"note",text:$t}'; }
verdict() { # outcome reason [metrics_json]
  write_envelope "$(jq -cn --arg o "$1" --arg r "$2" --argjson m "${3:-null}" \
    '{v:1,outcome:$o,reason:$r,surface_hash:null,metrics:$m}')"
  exit 0
}

if [ -n "${SF_SHA:-}" ]; then
  git checkout -q "$SF_SHA" || verdict fail "graded SHA $SF_SHA not found in the clone"
  note "grading pinned SHA $SF_SHA"
fi

PYTEST_OUT=/workspace/pytest.txt
run_pytest() {
  python3 -m pytest -q --no-header > "$PYTEST_OUT" 2>&1
  echo $?
}
emit_pytest_log() {
  jq -cn --arg t "$(tail -c 8000 "$PYTEST_OUT")" '{type:"pytest",text:$t}'
}

case "${SF_STAGE:?}" in
  architecture)
    [ -s PLAN.md ] && verdict pass "PLAN.md present at the pinned SHA"
    verdict fail "architecture produced no PLAN.md"
    ;;
  red)
    rc="$(run_pytest)"; emit_pytest_log
    [ "$rc" = "0" ] && verdict fail "RED gate: new tests did not fail — nothing pins the new behavior"
    [ "$rc" = "1" ] && verdict pass "tests fail for the right reason"
    verdict fail "RED gate: tests broke instead of failing (pytest rc=$rc)"
    ;;
  green)
    rc="$(run_pytest)"; emit_pytest_log
    [ "$rc" = "0" ] && verdict pass "suite green at the pinned SHA"
    verdict fail "GREEN gate: suite still failing (rc=$rc): $(tail -c 300 "$PYTEST_OUT")"
    ;;
  review)
    rc="$(run_pytest)"; emit_pytest_log
    passed="$(grep -oE '[0-9]+ passed' "$PYTEST_OUT" | grep -oE '[0-9]+' | head -1)"; passed="${passed:-0}"
    failed="$(grep -oE '[0-9]+ failed' "$PYTEST_OUT" | grep -oE '[0-9]+' | head -1)"; failed="${failed:-0}"
    total=$((passed + failed))
    read -r added removed <<EOF2
$(git diff --numstat origin/main...HEAD | awk '{a+=$1; r+=$2} END {print a+0, r+0}')
EOF2
    files="$(git diff --name-only origin/main...HEAD | wc -l | tr -d ' ')"
    METRICS="$(jq -cn \
      --argjson tp "$passed" --argjson tt "$total" \
      --argjson da "${added:-0}" --argjson dr "${removed:-0}" --argjson fc "$files" \
      --arg rv "${SF_REVIEW_VERDICT:-no review}" \
      '{tests_passed:$tp,tests_total:$tt,diff_added:$da,diff_removed:$dr,files_changed:$fc,reviewer_verdict:$rv}')"
    [ "$rc" = "0" ] && verdict pass "review gate metrics computed" "$METRICS"
    verdict fail "review gate: suite not green at the pinned SHA (rc=$rc)" "$METRICS"
    ;;
  *)
    verdict fail "unknown gate stage ${SF_STAGE}"
    ;;
esac
```

- [ ] **Step 4: Write `docker/sf-agent/Dockerfile`**

```dockerfile
# sf-agent — ONE image for agent (stage) and gate Jobs (spec §5).
# Contents: git, python+uv+pytest, node+Angular CLI, opencode + codex CLIs,
# factory-owned prompts + opencode configs. Built to ARBITRARY-UID
# conventions: root group ownership, chmod g=u, HOME=/workspace — restricted
# SCC compatibility is proven locally, not discovered at the office.
#   docker build -t sf-agent:dev -f docker/sf-agent/Dockerfile .
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# the two agent CLIs + the Angular CLI for the golden template's web half
RUN npm install -g opencode-ai @openai/codex @angular/cli \
  && npm cache clean --force

# the gate runs the factory-owned test command with the system interpreter
RUN uv pip install --system pytest

# arbitrary-UID pods and local fixture tests clone repos owned by OTHER uids;
# git's dubious-ownership check would refuse them (the pod uid never matches)
RUN git config --system safe.directory '*'

COPY docker/sf-agent/entrypoint.sh /opt/sf/entrypoint.sh
COPY docker/sf-agent/gate.sh /opt/sf/gate.sh
COPY docker/sf-agent/prompts /opt/sf/prompts
# the factory-owned opencode read-only/write configs (ADR 0024)
COPY api/app/opencode /opt/sf/opencode

# arbitrary-UID conventions: any UID in root group can read/execute/write
RUN chmod +x /opt/sf/entrypoint.sh /opt/sf/gate.sh \
  && mkdir -p /workspace \
  && chgrp -R 0 /opt/sf /workspace \
  && chmod -R g=u /opt/sf /workspace

ENV HOME=/workspace
WORKDIR /workspace
ENTRYPOINT ["/opt/sf/entrypoint.sh"]
```

> If `npm install -g opencode-ai @openai/codex` fails on a package name, check the
> canonical names with `npm view opencode-ai` / `npm view @openai/codex` — the build
> failing loudly here is the test. Do not substitute unofficial forks.

- [ ] **Step 5: Build the image**

Run from the repo root: `docker build -t sf-agent:dev -f docker/sf-agent/Dockerfile .`
Expected: image builds; `docker run --rm --entrypoint bash sf-agent:dev -c "git --version && python3 -m pytest --version && codex --version && opencode --version && jq --version && node --version"` prints all six versions.

- [ ] **Step 6: Verify the gate paths as an arbitrary UID (no cluster, no LLM)**

Run from the repo root:

```bash
FIX=$(mktemp -d)/repo && mkdir -p "$FIX" && cp -R sample/. "$FIX"
git -C "$FIX" init -q -b main
git -C "$FIX" -c user.email=t@t -c user.name=t add -A
git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm baseline
git -C "$FIX" config receive.denyCurrentBranch updateInstead
git -C "$FIX" checkout -q -b work/req-9100

run_gate() {  # stage → prints the envelope
  docker run --rm --user 12345:0 -v "$FIX":/remote:ro \
    -e SF_REF=REQ-9100 -e SF_STAGE="$1" -e SF_ROLE=gate \
    -e SF_REPO_URL=/remote -e SF_BRANCH=work/req-9100 -e SF_TERMLOG=/workspace/term.json \
    --entrypoint bash sf-agent:dev -c '/opt/sf/entrypoint.sh >/dev/null; cat /workspace/term.json; echo'
}

run_gate architecture       # expect: {"v":1,"outcome":"fail","reason":"architecture produced no PLAN.md",...}
echo "# plan" > "$FIX/PLAN.md"
git -C "$FIX" -c user.email=t@t -c user.name=t add -A
git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm plan
run_gate architecture       # expect: {"v":1,"outcome":"pass","reason":"PLAN.md present at the pinned SHA",...}
run_gate red                # expect: fail — "new tests did not fail" (sample suite is green)
cat > "$FIX/tests/test_b2_red.py" <<'EOF3'
def test_new_behavior_missing():
    assert False, "feature not implemented yet"
EOF3
git -C "$FIX" -c user.email=t@t -c user.name=t add -A
git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm red
run_gate red                # expect: {"v":1,"outcome":"pass","reason":"tests fail for the right reason",...}
run_gate green              # expect: fail — suite still failing
run_gate review             # expect: fail with metrics {...,"tests_total":>0,...}
```

Every expectation above must hold, all under UID 12345 with group 0 — this is the arbitrary-UID proof AND the envelope-contract proof (`app.kube_jobs.parse_envelope` must parse each printed line; sanity-check one with `cd api && uv run python -c "from app.kube_jobs import parse_envelope; print(parse_envelope('<paste>'))"`).

- [ ] **Step 7 (optional, LLM): one real codex stage in docker**

Only if you want early proof before the cluster smoke — requires the codex subscription:

```bash
docker run --rm --user 12345:0 -v "$FIX":/remote -v "$HOME/.codex":/secrets/codex:ro \
  -e SF_REF=REQ-9100 -e SF_STAGE=architecture -e SF_ROLE=stage -e SF_CLI=codex \
  -e SF_REPO_URL=/remote -e SF_BRANCH=work/req-9100 -e SF_TERMLOG=/workspace/term.json \
  --entrypoint bash sf-agent:dev -c '/opt/sf/entrypoint.sh; cat /workspace/term.json; echo'
```

Expected: NDJSON notes, then `{"v":1,"outcome":"ok","detail":"stage complete","sha":"<40 hex>"}`, and `git -C "$FIX" log --oneline` shows the agent's commit (updateInstead accepted the push).

- [ ] **Step 8: Commit**

```bash
git add docker/sf-agent
git commit -m "feat(image): sf-agent — clone/run/push entrypoint, deterministic gate script, arbitrary-UID build

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7 (cluster): kind cluster with Calico + ingress-nginx, image loading

**Files:**
- Create: `deploy/kind/cluster.yaml`
- Create: `scripts/calico-probe.sh`
- Modify: `Taskfile.yml` (append `kind-up`, `kind-load`, `kind-down`)

**Interfaces:**
- Produces a running kind cluster named `software-factory` where NetworkPolicy is **provably enforced** and `http://*.localtest.me:8081` reaches ingress-nginx. Tasks 8–10 consume it.

- [ ] **Step 1: Write `deploy/kind/cluster.yaml`**

```yaml
# kind cluster for the Software Factory (spec §2, local profile).
# CRITICAL: the default CNI (kindnet) silently DOES NOT enforce NetworkPolicy —
# it is disabled here and Calico installed by `task kind-up`; enforcement is
# then PROVEN by scripts/calico-probe.sh, never assumed.
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: software-factory
networking:
  disableDefaultCNI: true
  podSubnet: "192.168.0.0/16"   # calico.yaml's default IPv4 pool — keep equal
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80       # ingress-nginx hostPort
        hostPort: 8081          # http://<host>.localtest.me:8081
        protocol: TCP
```

- [ ] **Step 2: Write `scripts/calico-probe.sh`**

```bash
#!/usr/bin/env bash
# Prove NetworkPolicy is ENFORCED (spec §2: kindnet's silent no-op is the trap).
# A throwaway namespace gets an nginx pod; traffic works, then a deny-all
# policy lands and the same traffic must FAIL.
set -euo pipefail

kubectl create ns np-probe --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n np-probe run web --image=nginx:alpine --restart=Never >/dev/null 2>&1 || true
kubectl -n np-probe wait --for=condition=Ready pod/web --timeout=120s >/dev/null
kubectl -n np-probe expose pod web --port=80 >/dev/null 2>&1 || true

kubectl -n np-probe run probe-open --rm -i --restart=Never --image=busybox:1.36 -- \
  wget -T 5 -qO- http://web >/dev/null
echo "  open traffic flows (baseline)"

cat <<'EOF2' | kubectl -n np-probe apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
EOF2

if kubectl -n np-probe run probe-denied --rm -i --restart=Never --image=busybox:1.36 -- \
  wget -T 5 -qO- http://web >/dev/null 2>&1; then
  echo "✗ NetworkPolicy NOT enforced — is Calico actually running?" >&2
  exit 1
fi
kubectl delete ns np-probe --wait=false >/dev/null
echo "✓ NetworkPolicy enforcement proven (deny-all blocked the same traffic)"
```

Run `chmod +x scripts/calico-probe.sh`.

- [ ] **Step 3: Append the Taskfile recipes**

Append to the `tasks:` map in `Taskfile.yml`:

```yaml
  # ---------- Kubernetes local profile (Plan B2, spec §2/§9 Phase 1) ----------
  # kind + Calico (kindnet does NOT enforce NetworkPolicy) + ingress-nginx.
  kind-up:
    desc: Create the software-factory kind cluster (Calico CNI + ingress-nginx) and PROVE policy enforcement
    cmds:
      - kind get clusters | grep -qx software-factory || kind create cluster --config deploy/kind/cluster.yaml
      # server-side apply: calico.yaml's CRDs overflow the client-side last-applied annotation
      - kubectl apply --server-side --force-conflicts -f https://raw.githubusercontent.com/projectcalico/calico/v3.30.3/manifests/calico.yaml
      - kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s
      - kubectl wait --for=condition=Ready nodes --all --timeout=300s
      - kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.13.0/deploy/static/provider/kind/deploy.yaml
      - kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s
      - ./scripts/calico-probe.sh

  kind-load:
    desc: Build all four images and load them into the kind cluster
    cmds:
      - docker build -t sf-api:dev -f api/Dockerfile .
      - docker build -t sf-intake:dev -f apps/intake/Dockerfile .
      - docker build -t sf-console:dev -f apps/console/Dockerfile .
      - docker build -t sf-agent:dev -f docker/sf-agent/Dockerfile .
      - kind load docker-image sf-api:dev sf-intake:dev sf-console:dev sf-agent:dev --name software-factory

  kind-down:
    desc: Delete the software-factory kind cluster
    cmds:
      - kind delete cluster --name software-factory
```

> Version pins: Calico `v3.30.3` and ingress-nginx `controller-v1.13.0` are the pin of
> record; if kind v0.32.0's node Kubernetes version is newer than either supports, the
> rollout-status step fails loudly — bump to the nearest supported release and record the
> change in `implementation-notes.md` under Deviations.

- [ ] **Step 4: Bring the cluster up (the verification)**

Run: `task kind-up`
Expected tail:
```
  open traffic flows (baseline)
✓ NetworkPolicy enforcement proven (deny-all blocked the same traffic)
```
Then: `kubectl get nodes` → 1 node `Ready`; `kubectl -n kube-system get pods -l k8s-app=calico-node` → `Running`.

(`task kind-load` is exercised in task 8 once the console Dockerfile exists.)

- [ ] **Step 5: Commit**

```bash
git add deploy/kind/cluster.yaml scripts/calico-probe.sh Taskfile.yml
git commit -m "feat(deploy): kind cluster with Calico (enforcement proven, kindnet trap avoided) + ingress-nginx

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8 (cluster): kustomize base + overlays/local — factory on the cluster, walls proven

**Files:**
- Create: `apps/console/Dockerfile`, `apps/console/nginx.conf`
- Create: `deploy/base/kustomization.yaml`, `deploy/base/namespace.yaml`, `deploy/base/serviceaccounts.yaml`, `deploy/base/rbac.yaml`, `deploy/base/configmap.yaml`, `deploy/base/factory-api.yaml`, `deploy/base/intake.yaml`, `deploy/base/console.yaml`, `deploy/base/networkpolicies.yaml`
- Create: `deploy/overlays/local/kustomization.yaml`, `deploy/overlays/local/ingress.yaml`
- Create: `scripts/netpol-smoke.sh`
- Modify: `Taskfile.yml` (append `kind-deploy`, `sync-codex-auth`)

**Interfaces:**
- Produces: the factory running in namespace `software-factory` — factory-api (1 replica, SQLite on a PVC, `FACTORY_RUNNER=kube`) with a **git-daemon sidecar** exporting `/data/workspaces` on 9418; the backend Service is **named `api`** so the SPA images' baked `proxy_pass http://api:8000` resolves unchanged; intake + console SPAs; per-tier ServiceAccounts and RBAC exactly matching task 4's manifests; NetworkPolicies whose walls `scripts/netpol-smoke.sh` proves. Tasks 9–10 consume the running stack.

- [ ] **Step 1: Console image (mirrors intake's)**

`apps/console/Dockerfile`:

```dockerfile
# Built from the REPO ROOT context (ADR 0017 Phase 2) — same shape as
# apps/intake/Dockerfile: the multi-project Angular workspace needs the root.
#   docker build -f apps/console/Dockerfile -t sf-console .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx ng build console

FROM nginx:alpine
COPY --from=build /app/dist/console/browser /usr/share/nginx/html
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

`apps/console/nginx.conf` — copy `apps/intake/nginx.conf` verbatim (same SSE block, same `/api/` proxy to `http://api:8000`, same SPA fallback). Run:

```bash
cp apps/intake/nginx.conf apps/console/nginx.conf
```

- [ ] **Step 2: kustomize base**

`deploy/base/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: software-factory
resources:
  - namespace.yaml
  - serviceaccounts.yaml
  - rbac.yaml
  - configmap.yaml
  - factory-api.yaml
  - intake.yaml
  - console.yaml
  - networkpolicies.yaml
```

`deploy/base/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: software-factory
```

`deploy/base/serviceaccounts.yaml`:

```yaml
# Per-tier ServiceAccounts (spec §2): the factory-api SA is the ONLY one with
# RBAC; agent/gate SAs exist so pods bind to something with zero rights and
# never mount a token (the Job manifests also set automount false).
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sf-api
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sf-agent
automountServiceAccountToken: false
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sf-gate
automountServiceAccountToken: false
```

`deploy/base/rbac.yaml`:

```yaml
# factory-api owns the FULL Job lifecycle (spec §5): create/watch/delete Jobs,
# read pods and pod logs (envelope + NDJSON capture). Nothing else.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: sf-api-jobs
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "watch", "delete"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: sf-api-jobs
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: sf-api-jobs
subjects:
  - kind: ServiceAccount
    name: sf-api
    namespace: software-factory   # required for SA subjects — kustomize does not inject it
```

`deploy/base/configmap.yaml`:

```yaml
# The factory's env (spec §3.5). Azure SQL: once provisioned, override
# FACTORY_DB_URL via a Secret-backed patch in the overlay — one env swap.
apiVersion: v1
kind: ConfigMap
metadata:
  name: factory-config
data:
  FACTORY_RUNNER: "kube"
  FACTORY_CLI: "codex"                # local profile: codex on the subscription (spec §2)
  FACTORY_KUBE_NAMESPACE: "software-factory"
  FACTORY_AGENT_IMAGE: "sf-agent:dev"
  FACTORY_GIT_REMOTE_BASE: "git://api.software-factory.svc.cluster.local:9418"
  FACTORY_DB_URL: "sqlite:////data/factory.db"
  FACTORY_WORKSPACES: "/data/workspaces"
  FACTORY_UPLOADS: "/data/uploads"
  FACTORY_SEED_DEMO: "1"              # the smoke drives the seeded northwind app
  FACTORY_INTERVIEW_PREGEN: "sync"
  FACTORY_LOG_LEVEL: "INFO"
```

`deploy/base/factory-api.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sf-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 2Gi
---
# ONE replica, ONE uvicorn worker (CLAUDE.md hard rule): the tick loop and the
# kube runner assume a single process. strategy Recreate: the RWO volume can
# never deadlock a rolling update.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: factory-api
  labels:
    app: api
    sf/tier: factory
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
        sf/tier: factory
    spec:
      serviceAccountName: sf-api
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: sf-data
      initContainers:
        - name: init-dirs
          image: sf-api:dev
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "mkdir -p /data/workspaces /data/uploads"]
          volumeMounts:
            - name: data
              mountPath: /data
      containers:
        - name: api
          image: sf-api:dev
          imagePullPolicy: IfNotPresent
          envFrom:
            - configMapRef:
                name: factory-config
          ports:
            - containerPort: 8000
          readinessProbe:
            httpGet:
              path: /api/health
              port: 8000
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests: {cpu: 250m, memory: 512Mi}
            limits: {cpu: "1", memory: 1Gi}
          volumeMounts:
            - name: data
              mountPath: /data
        # The git backbone (Plan B2): exports /data/workspaces to agent/gate
        # Jobs as git://api:9418/<ref>. receive-pack is enabled — locally the
        # walls are NetworkPolicies (only sf/tier=agent pods reach 9418);
        # authenticated remotes (GitHub) replace this seam in B3.
        - name: git-daemon
          image: sf-api:dev
          imagePullPolicy: IfNotPresent
          command:
            - git
            - daemon
            - --reuseaddr
            - --verbose
            - --export-all
            - --enable=receive-pack
            - --base-path=/data/workspaces
            - /data/workspaces
          ports:
            - containerPort: 9418
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {cpu: 250m, memory: 256Mi}
          volumeMounts:
            - name: data
              mountPath: /data
---
# Named `api` ON PURPOSE: the SPA images bake `proxy_pass http://api:8000`
# (compose parity) — the Service name keeps those images unchanged.
apiVersion: v1
kind: Service
metadata:
  name: api
  labels:
    app: api
spec:
  selector:
    app: api
  ports:
    - name: http
      port: 8000
      targetPort: 8000
    - name: git
      port: 9418
      targetPort: 9418
```

`deploy/base/intake.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: intake
  labels:
    app: intake
    sf/tier: factory
spec:
  replicas: 1
  selector:
    matchLabels:
      app: intake
  template:
    metadata:
      labels:
        app: intake
        sf/tier: factory
    spec:
      containers:
        - name: web
          image: sf-intake:dev
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 80
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {cpu: 250m, memory: 128Mi}
---
apiVersion: v1
kind: Service
metadata:
  name: intake
spec:
  selector:
    app: intake
  ports:
    - port: 80
      targetPort: 80
```

`deploy/base/console.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: console
  labels:
    app: console
    sf/tier: factory
spec:
  replicas: 1
  selector:
    matchLabels:
      app: console
  template:
    metadata:
      labels:
        app: console
        sf/tier: factory
    spec:
      containers:
        - name: web
          image: sf-console:dev
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 80
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {cpu: 250m, memory: 128Mi}
---
apiVersion: v1
kind: Service
metadata:
  name: console
spec:
  selector:
    app: console
  ports:
    - port: 80
      targetPort: 80
```

`deploy/base/networkpolicies.yaml`:

```yaml
# The walls (spec §2), enforced by Calico and PROVEN by scripts/netpol-smoke.sh.
# Vanilla NetworkPolicy cannot express "github.com only" (FQDN rules are a
# Calico Enterprise/Cilium feature) — the local profile uses CIDR-shaped
# walls instead: stage pods may reach the internet (the LLM) but nothing
# in-cluster except git; gate pods reach ONLY git (no LLM, spec §6).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-walls
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes: [Ingress, Egress]
  ingress:
    - from:                             # the console door: ingress controller + SPAs
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
        - podSelector:
            matchLabels:
              app: intake
        - podSelector:
            matchLabels:
              app: console
      ports:
        - {protocol: TCP, port: 8000}
    - from:                             # the git door: agent tier ONLY, 9418 ONLY
        - podSelector:
            matchLabels:
              sf/tier: agent
      ports:
        - {protocol: TCP, port: 9418}
  egress:
    - {}                                # trusted control plane: kube API, Azure SQL, GitHub (B3)
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: spa-walls
spec:
  podSelector:
    matchExpressions:
      - {key: app, operator: In, values: [intake, console]}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - {protocol: TCP, port: 80}
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: api
      ports:
        - {protocol: TCP, port: 8000}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-stage-walls
spec:
  podSelector:
    matchLabels:
      sf/role: stage
  policyTypes: [Ingress, Egress]        # no ingress rules = nothing may dial in
  egress:
    - to:                               # git (clone + push)
        - podSelector:
            matchLabels:
              app: api
      ports:
        - {protocol: TCP, port: 9418}
    - to:                               # the LLM endpoint — internet yes, cluster no
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 192.168.0.0/16          # pod CIDR (deploy/kind/cluster.yaml)
              - 10.96.0.0/12            # service CIDR
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: gate-walls
spec:
  podSelector:
    matchLabels:
      sf/role: gate
  policyTypes: [Ingress, Egress]
  egress:
    - to:                               # gates reach git and NOTHING else — no LLM (spec §6)
        - podSelector:
            matchLabels:
              app: api
      ports:
        - {protocol: TCP, port: 9418}
```

> NOTE on `allow-dns`: it keys on the ambient `kubernetes.io/metadata.name` label
> (present on every supported Kubernetes). A broken DNS rule shows up in the smoke as
> clone failures inside agent pods — debug there first.

- [ ] **Step 3: overlays/local**

`deploy/overlays/local/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: software-factory
resources:
  - ../../base
  - ingress.yaml
```

`deploy/overlays/local/ingress.yaml`:

```yaml
# *.localtest.me resolves to 127.0.0.1; kind maps host:8081 → ingress :80.
#   intake:  http://intake.localtest.me:8081
#   console: http://console.localtest.me:8081
#   api:     http://api.localtest.me:8081/api/health
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: factory
spec:
  ingressClassName: nginx
  rules:
    - host: intake.localtest.me
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: {name: intake, port: {number: 80}}
    - host: console.localtest.me
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: {name: console, port: {number: 80}}
    - host: api.localtest.me
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: {name: api, port: {number: 8000}}
```

- [ ] **Step 4: Taskfile recipes + the netpol smoke script**

Append to `Taskfile.yml`:

```yaml
  kind-deploy:
    desc: Apply deploy/overlays/local and wait for every rollout
    cmds:
      - kubectl apply -k deploy/overlays/local
      - kubectl -n software-factory rollout status deployment/factory-api --timeout=300s
      - kubectl -n software-factory rollout status deployment/intake --timeout=180s
      - kubectl -n software-factory rollout status deployment/console --timeout=180s

  sync-codex-auth:
    desc: Sync ~/.codex/auth.json into the sf-codex-auth Secret (single-developer, spec §2)
    cmds:
      - kubectl -n software-factory create secret generic sf-codex-auth --from-file=auth.json=$HOME/.codex/auth.json --dry-run=client -o yaml | kubectl apply -f -
```

`scripts/netpol-smoke.sh`:

```bash
#!/usr/bin/env bash
# The tier-wall smoke (spec §2): "A NetworkPolicy smoke test (agent pod →
# factory-api must FAIL) runs in the deploy verify — enforcement is proven,
# never assumed." Probes run AS the tier (same labels + SA + non-root UID).
set -euo pipefail
NS=software-factory
OVR='{"spec":{"serviceAccountName":"sf-gate","automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":10101,"runAsGroup":0}}}'

probe() { # name labels command... → exit code of the pod
  local name=$1 labels=$2; shift 2
  kubectl -n "$NS" run "$name" --rm -i --restart=Never --image=sf-agent:dev \
    --labels="$labels" --overrides="$OVR" --command -- "$@" >/dev/null 2>&1
}

expect_ok() { # description name labels cmd...
  local desc=$1; shift
  if probe "$@"; then echo "  ✓ $desc"; else echo "✗ $desc (expected ALLOWED)"; exit 1; fi
}
expect_blocked() {
  local desc=$1; shift
  if probe "$@"; then echo "✗ $desc (expected BLOCKED)"; exit 1; else echo "  ✓ $desc"; fi
}

echo "▸ NetworkPolicy walls"
expect_blocked "stage pod → factory-api:8000 is BLOCKED (the spec §2 hard assertion)" \
  np-s-api "sf/tier=agent,sf/role=stage" \
  timeout 5 bash -c 'exec 3<>/dev/tcp/api/8000'
expect_ok "stage pod → git :9418 is allowed (clone/push door)" \
  np-s-git "sf/tier=agent,sf/role=stage" \
  timeout 5 bash -c 'exec 3<>/dev/tcp/api/9418'
expect_ok "stage pod → LLM endpoint :443 is allowed" \
  np-s-llm "sf/tier=agent,sf/role=stage" \
  timeout 10 bash -c 'exec 3<>/dev/tcp/api.openai.com/443'
expect_blocked "gate pod → LLM endpoint :443 is BLOCKED (no LLM in gates, spec §6)" \
  np-g-llm "sf/tier=agent,sf/role=gate" \
  timeout 10 bash -c 'exec 3<>/dev/tcp/api.openai.com/443'
expect_ok "gate pod → git :9418 is allowed" \
  np-g-git "sf/tier=agent,sf/role=gate" \
  timeout 5 bash -c 'exec 3<>/dev/tcp/api/9418'
expect_blocked "gate pod → factory-api:8000 is BLOCKED" \
  np-g-api "sf/tier=agent,sf/role=gate" \
  timeout 5 bash -c 'exec 3<>/dev/tcp/api/8000'
echo "✓ NETPOL SMOKE PASSED — the tier walls hold"
```

Run `chmod +x scripts/netpol-smoke.sh`.

- [ ] **Step 5: Build, load, deploy, verify (the cluster assertions)**

```bash
task kind-load        # four images build + load (console image is new — watch its build)
task sync-codex-auth  # Secret sf-codex-auth created
task kind-deploy
```

Expected: three `deployment ... successfully rolled out` lines. Then assert:

```bash
kubectl -n software-factory get pods
# factory-api-*  2/2 Running   (api + git-daemon)
# intake-*       1/1 Running
# console-*      1/1 Running

curl -sf http://api.localtest.me:8081/api/health
# {"status":"ok",...,"runner":"kube",...}

curl -sf -o /dev/null -w '%{http_code}\n' http://intake.localtest.me:8081/   # 200
curl -sf -o /dev/null -w '%{http_code}\n' http://console.localtest.me:8081/  # 200

./scripts/netpol-smoke.sh
# ✓ NETPOL SMOKE PASSED — the tier walls hold
```

If the git daemon crashloops on an empty `/data/workspaces`, that is a bug in the initContainer ordering — fix there, not by relaxing the manifest.

- [ ] **Step 6: Commit**

```bash
git add apps/console/Dockerfile apps/console/nginx.conf deploy/base deploy/overlays scripts/netpol-smoke.sh Taskfile.yml
git commit -m "feat(deploy): kustomize base + local overlay — factory-api with git-daemon sidecar, SPAs, per-tier SAs/RBAC, proven NetworkPolicy walls

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9 (cluster, opt-in): RealKubeClient integration tests — env-gated, never in CI

The one place the *real* client is exercised against a *real* API server. Skipped by default (`task verify`/CI have no cluster); opt in with `FACTORY_KUBE_ITEST=1`. Uses the already-loaded `sf-agent:dev` image with a command override — no LLM, no git needed.

**Files:**
- Create: `api/tests/test_real_kube_integration.py`

**Interfaces:**
- Consumes: `RealKubeClient` (task 1), the running cluster + namespace + `sf-gate` SA (tasks 7–8).
- Proves the exact assumptions the fakes encode: non-root termination-log writability (the envelope channel), running-pod log capture, uid on create, 409→None, idempotent delete.

- [ ] **Step 1: Write the test file**

Create `api/tests/test_real_kube_integration.py`:

```python
"""RealKubeClient against the live kind cluster — OPT-IN ONLY.

Skipped unless FACTORY_KUBE_ITEST=1: CI and `task verify` have no cluster and
must never acquire one. Prereqs: `task kind-up kind-load kind-deploy` and
`kubectl config use-context kind-software-factory`.

These pin the seam behaviors every unit test takes on faith from the fake:
  * a NON-ROOT (runAsUser 10101) pod can write /dev/termination-log and the
    client reads it back — the envelope channel is real;
  * get_job(capture=True) reads a RUNNING pod's logs (the B1 gap, closed);
  * create_job returns the uid; a same-name second create returns None (409);
  * delete_job is idempotent.
"""
import json
import os
import time
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("FACTORY_KUBE_ITEST") != "1",
    reason="needs a live kind cluster — opt in with FACTORY_KUBE_ITEST=1",
)

NS = os.environ.get("FACTORY_KUBE_NAMESPACE", "software-factory")


@pytest.fixture()
def real_client():
    from app.kube_client import RealKubeClient

    return RealKubeClient(namespace=NS)


def _manifest(name: str, script: str, *, deadline: int = 120) -> dict:
    """Minimal Job in the same pod shape kube_jobs emits (non-root, no token,
    sf labels) with a command override — the sf-agent image is already loaded
    into kind, so nothing pulls."""
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": name, "labels": {"sf/tier": "agent", "sf/role": "itest"}},
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": deadline,
            "template": {
                "metadata": {"labels": {"sf/tier": "agent", "sf/role": "itest"}},
                "spec": {
                    "restartPolicy": "Never",
                    "serviceAccountName": "sf-gate",
                    "automountServiceAccountToken": False,
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 10101,
                        "runAsGroup": 0,
                    },
                    "containers": [
                        {
                            "name": "main",
                            "image": "sf-agent:dev",
                            "imagePullPolicy": "IfNotPresent",
                            "command": ["bash", "-c", script],
                            "terminationMessagePolicy": "File",
                        }
                    ],
                },
            },
        },
    }


def _wait_phase(real_client, name: str, phase: str, timeout: int = 120):
    view = real_client.get_job(name)
    deadline = time.time() + timeout
    while time.time() < deadline:
        view = real_client.get_job(name)
        if view.phase == phase:
            return view
        time.sleep(2)
    raise AssertionError(f"{name} never reached {phase!r}; last={view.phase!r}")


def test_envelope_and_logs_from_a_nonroot_pod(real_client):
    name = f"sf-itest-{uuid.uuid4().hex[:8]}"
    script = (
        "echo '{\"type\":\"note\",\"text\":\"hello from the pod\"}'; "
        "printf '{\"v\":1,\"outcome\":\"ok\",\"detail\":\"itest\",\"sha\":null}'"
        " > /dev/termination-log"
    )
    assert real_client.create_job(_manifest(name, script))
    try:
        view = _wait_phase(real_client, name, "succeeded")
        envelope = json.loads(view.termination_message)
        assert envelope["outcome"] == "ok"           # non-root wrote the envelope
        assert "hello from the pod" in view.logs     # NDJSON captured
    finally:
        real_client.delete_job(name)


def test_running_pod_log_capture(real_client):
    name = f"sf-itest-{uuid.uuid4().hex[:8]}"
    script = "echo '{\"type\":\"note\",\"text\":\"mid-flight\"}'; sleep 300"
    assert real_client.create_job(_manifest(name, script, deadline=400))
    try:
        captured = ""
        deadline = time.time() + 120
        while time.time() < deadline:
            view = real_client.get_job(name, capture=True)
            if view.phase == "running" and "mid-flight" in view.logs:
                captured = view.logs
                break
            time.sleep(2)
        assert "mid-flight" in captured              # the B1 gap, closed for real
        assert real_client.get_job(name).logs == ""  # the cheap poll stays cheap
    finally:
        real_client.delete_job(name)


def test_create_conflict_and_idempotent_delete(real_client):
    name = f"sf-itest-{uuid.uuid4().hex[:8]}"
    uid = real_client.create_job(_manifest(name, "sleep 60", deadline=90))
    assert uid
    try:
        assert real_client.create_job(_manifest(name, "sleep 60")) is None  # 409 → None
        assert real_client.get_job(name).uid == uid
    finally:
        real_client.delete_job(name)
        real_client.delete_job(name)  # second delete must not raise (404-tolerant)
```

- [ ] **Step 2: Prove the default is skip (CI safety)**

Run: `cd api && uv run pytest tests/test_real_kube_integration.py -v`
Expected: `3 skipped` — no cluster contact, no `kubernetes` import.

- [ ] **Step 3: Run against the cluster**

```bash
kubectl config use-context kind-software-factory
cd api && FACTORY_KUBE_ITEST=1 uv run pytest tests/test_real_kube_integration.py -v
```

Expected: `3 passed` (allow ~2–4 minutes: real pods start). If `test_envelope_and_logs_from_a_nonroot_pod` fails on an empty termination message, the non-root-writability assumption broke — record it in `implementation-notes.md` and switch the manifests + entrypoint to `terminationMessagePolicy: FallbackToLogsOnError` with the envelope as the LAST log line (the parser already tolerates NDJSON noise).

- [ ] **Step 4: Full backend suite (still cluster-free), then commit**

Run: `cd api && uv run pytest -q` — all green, integration tests reported as skipped.

```bash
git add api/tests/test_real_kube_integration.py
git commit -m "test(kube): opt-in real-cluster integration suite — envelope channel, running-pod capture, 409/uid, delete idempotence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10 (cluster+LLM): one request end-to-end on kind — the Phase-1 walking-skeleton smoke

**Files:**
- Create: `scripts/kind-smoke.sh`
- Modify: `Taskfile.yml` (append `kind-smoke`)
- Modify: `AGENTS.md` §7 (runtime note)
- Modify: `implementation-notes.md` (B2 section)

**Interfaces:**
- Consumes everything: the cluster (7), the deployed stack (8), the image (6), git-backed grading + merge (5). Requires `task sync-codex-auth` (codex subscription) — each run spends real codex usage; expect 10–25 minutes.
- Produces the B2 milestone proof: intake → spec approve → agent Job + gate Job per stage on the real cluster → merge gate → SHA-precondition merge → `done`, workspace `main` updated, all Jobs reaped, NetworkPolicy walls re-proven in the same run.

- [ ] **Step 1: Write `scripts/kind-smoke.sh`**

```bash
#!/usr/bin/env bash
# One request END-TO-END on the kind cluster (Plan B2; spec §9 Phase 1
# walking skeleton): intake → spec gate → agent Jobs (codex on the
# subscription) + gate Jobs → merge gate → SHA-precondition merge → done,
# with the workspace repo's main updated ("deployed" in the B2 sense —
# produced-app build/deploy is B3) and every Job reaped.
#
# Prereqs: task kind-up && task kind-load && task kind-deploy && task sync-codex-auth
# Spends real codex usage; a clean run takes 10-25 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."

API="http://api.localtest.me:8081/api"
NS=software-factory

jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
fail() { echo "✗ $1"; exit 1; }
ok() { echo "  ✓ $1"; }

echo "▸ preflight"
kubectl -n $NS get secret sf-codex-auth >/dev/null 2>&1 \
  || fail "Secret sf-codex-auth missing — run 'task sync-codex-auth' first"
HEALTH=$(curl -sf "$API/health") || fail "API unreachable at $API (ingress up? task kind-deploy?)"
[ "$(echo "$HEALTH" | jqpy "print(d['runner'])")" = "kube" ] || fail "runner is not kube"
ok "cluster healthy, runner=kube"

echo "▸ submitter flow (mirrors scripts/smoke.sh)"
NW_ID=$(curl -s "$API/apps" | jqpy "print(next(a['id'] for a in d if a['key']=='northwind'))")
RID=$(curl -s -X POST "$API/requests" -H 'content-type: application/json' \
  -d "{\"type\":\"enh\",\"title\":\"Kind smoke: monthly export\",\"description\":\"Add a monthly_export function that returns the export format name.\",\"app_id\":$NW_ID}" \
  | jqpy "print(d['id'])")
curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' \
  -d '{"answer":"Finance closes the books monthly and needs an export."}' >/dev/null
curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' \
  -d '{"answer":"CSV is fine."}' >/dev/null
curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' \
  -d '{"skip":true}' >/dev/null
curl -s -X POST "$API/requests/$RID/submit" -H 'content-type: application/json' -d '{}' >/dev/null
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
REF=$(curl -s "$API/requests/$RID" | jqpy "print(d['ref'])")
LREF=$(echo "$REF" | tr '[:upper:]' '[:lower:]')
ok "request $REF approved into the pipeline"

echo "▸ pipeline on the cluster (slow: codex runs each stage; retries are normal, escalation is not)"
DEADLINE=$(( $(date +%s) + 2400 ))   # 40-minute ceiling
LAST=""
while :; do
  OUT=$(curl -s "$API/requests/$RID")
  GATE=$(echo "$OUT" | jqpy "print(d['gate'])")
  NH=$(echo "$OUT" | jqpy "print(d['needs_human'])")
  STAGE=$(echo "$OUT" | jqpy "print(d['stage'])")
  JOBS=$(kubectl -n $NS get jobs -o name 2>/dev/null | sed 's|job.batch/||' | tr '\n' ' ')
  STATE="stage=$STAGE gate=$GATE jobs=[ $JOBS]"
  if [ "$STATE" != "$LAST" ]; then echo "  … $STATE"; LAST="$STATE"; fi
  [ "$NH" = "True" ] && fail "escalated: $(echo "$OUT" | jqpy "print(d['needs_human_reason'])")"
  [ "$GATE" = "approve_merge" ] && break
  [ "$(date +%s)" -gt "$DEADLINE" ] && fail "pipeline did not reach the merge gate in 40 min"
  sleep 10
done
ok "all stages + gates green — waiting at the merge gate (humans gate the irreversible)"

echo "▸ merge gate → done"
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
FINAL=$(curl -s "$API/requests/$RID" | jqpy "print(d['status'], d['stage'])")
[ "$FINAL" = "done done" ] || fail "merge approval did not finish the request ($FINAL)"
ok "request done"

echo "▸ the merge is REAL: the workspace repo's main moved"
POD=$(kubectl -n $NS get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
kubectl -n $NS exec "$POD" -c api -- git -C "/data/workspaces/$LREF" log --oneline -1 main \
  | grep -qi merge || fail "workspace main does not end in a merge commit"
ok "main's tip is the merge commit ('deployed' in the B2 sense; app deploy is B3)"

echo "▸ the orchestrator owned the Job lifecycle: nothing left behind"
LEFT=$(kubectl -n $NS get jobs -o name 2>/dev/null | grep "sf-$LREF" || true)
[ -z "$LEFT" ] || fail "Jobs left behind: $LEFT"
ok "every sf-$LREF Job was reaped after capture"

./scripts/netpol-smoke.sh

echo ""
echo "✓ KIND SMOKE PASSED — one request end-to-end on the cluster (Plan B2 milestone)"
```

Run `chmod +x scripts/kind-smoke.sh`, and append to `Taskfile.yml`:

```yaml
  kind-smoke:
    desc: "One request end-to-end on kind (needs codex auth secret; ~10-25 min, spends codex usage)"
    cmds:
      - ./scripts/kind-smoke.sh
```

- [ ] **Step 2: Run it**

Run: `task kind-smoke`
Expected tail:

```
  ✓ all stages + gates green — waiting at the merge gate (humans gate the irreversible)
  ✓ request done
  ✓ main's tip is the merge commit ('deployed' in the B2 sense; app deploy is B3)
  ✓ every sf-req-XXXX Job was reaped after capture
✓ NETPOL SMOKE PASSED — the tier walls hold
✓ KIND SMOKE PASSED — one request end-to-end on the cluster (Plan B2 milestone)
```

Debugging map when it stalls: `kubectl -n software-factory get jobs,pods` (what's running) → `kubectl -n software-factory logs job/sf-<ref>-<stage>-<n>` (the agent's NDJSON) → `kubectl -n software-factory logs deploy/factory-api -c api` (runner decisions) → `kubectl -n software-factory logs deploy/factory-api -c git-daemon` (clone/push traffic). A gate failing then retrying once is the DESIGNED path (spec §4.6); only `needs_human` ends the smoke.

- [ ] **Step 3: Document the runtime**

`AGENTS.md` §7 — extend the kube paragraph added by B1 with:

```markdown
Plan B2 made the seam real: `deploy/` (kind + Calico + kustomize; `task kind-up
kind-load kind-deploy`), `docker/sf-agent/` (the stage/gate image), and
`api/app/workspace.py` (git-as-workspace: the orchestrator computes the
frozen-surface hash and merges the graded SHA on its own repo). Cluster tests
are opt-in (`FACTORY_KUBE_ITEST=1` for the integration suite, `task kind-smoke`
for the end-to-end run) — `task verify` stays cluster-free.
```

`implementation-notes.md` — add a `## Plan B2 — kind cluster (2026-07-15)` section recording: image/CLI version pins chosen at build time, the Calico/ingress-nginx versions actually installed, smoke duration + token cost of the run, plus any Deviations.

- [ ] **Step 4: Full verify + commit**

Run from the repo root: `task verify` — green (show the output; the new scripts are not in its chain, proving CI stays cluster-free).

```bash
git add scripts/kind-smoke.sh Taskfile.yml AGENTS.md implementation-notes.md
git commit -m "feat(deploy): kind end-to-end smoke — intake to merged main on the cluster, Jobs reaped, walls re-proven

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Design decisions made while planning (resolutions of spec/code gaps)

1. **"Deployed pod" ends at merged `main` in B2.** Spec §9's Phase-1 milestone chain ends in a deployed produced-app pod, but produced-app build/deploy (kaniko Job, local registry, static-template deploy) is the B3 ledger item everywhere else (B1 plan's out-of-scope; memory). The B2 smoke therefore asserts: `done` + the workspace repo's `main` tip is the merge commit + Jobs reaped + walls proven. Kaniko + registry are deliberately absent; images enter kind via `kind load docker-image`.
2. **The local git remote is a git-daemon sidecar, not GitHub and not a shared volume.** Spec §5's entrypoint contract ("shallow-clone work branch … push") needs a remote; GitHub repos are B3. A sidecar on the factory-api pod exporting `/data/workspaces` over `git://:9418` keeps the agent entrypoint production-shaped (URL + credential are env-driven; B3 swaps `SF_REPO_URL` to GitHub + a PAT behind the same seam). Push is unauthenticated locally; the wall is the NetworkPolicy (only `sf/tier=agent` pods reach 9418) — recorded as a local-profile trade-off, and the reason gate pods reaching 9418 is acceptable (they must clone the pinned SHA).
3. **`receive.denyCurrentBranch=updateInstead`.** The orchestrator's repo is non-bare with the work branch checked out (AgentRunner parity, and the merge needs a working tree). Agents push to that checked-out branch; `updateInstead` refreshes the clean working tree in place. Pinned by `test_agent_push_contract_updateInstead`.
4. **Calico OSS cannot do FQDN egress** — spec §2's "Calico/Cilium FQDN rules locally" is only true of Calico *Enterprise*. Resolution: CIDR-shaped walls — stage pods get internet-except-cluster (LLM reachable, cluster unreachable except git:9418), gate pods get git-only (stronger than the spec asked: no registries either, because the gate's deps are pre-baked in the image). The spec's own hard assertion (agent → factory-api:8000 FAILS) is exactly what `netpol-smoke.sh` proves. FQDN allowlisting stays a per-overlay mechanism for Phase 2 (OVN EgressFirewall).
5. **The review stage pushes nothing** (spec §5: no push credential). Its verdict rides the envelope `detail`; the orchestrator injects it into the review *gate* as `SF_REVIEW_VERDICT`, and the gate computes the five numeric metrics (pytest counts + `git diff --numstat origin/main...HEAD`). `payload_from_metrics` then keeps its B1 shape.
6. **Trusted surface hash = `git ls-tree` at the stage-envelope SHAs, computed by the orchestrator** (spec §6's "orchestrator-side, pure git tree-hash, fully trusted"). The gate envelope's `surface_hash` is demoted to a fallback used only when no git backbone is configured (unit fakes) — pinned by `test_git_grading_catches_a_cheating_implementer`, where BOTH gate verdicts lie and only the orchestrator catches it. An unresolvable claimed SHA is a violation, never a pass.
7. **Everything git-mode is gated on `settings.GIT_REMOTE_BASE`** being non-empty. Empty (unit-test default) = byte-for-byte B1 behavior, so the whole B1 suite survives untouched; the local overlay sets it, activating workspaces, SHA pinning, git grading, and the real merge.
8. **kube merge = local SHA-precondition merge** (`merge_graded`: refuse if the work branch moved past the graded SHA), falling back to `simulator.approve_merge` when no workspace exists — keeping B1's wiring test honest. The GitHub-API merge with the same precondition is B3's swap.
9. **The backend Service is named `api`** so the intake/console images' baked `proxy_pass http://api:8000` (compose parity) resolves without a k8s-specific nginx.conf; the ingress also routes `api.localtest.me` directly for the smoke.
10. **DB on kind = SQLite on the PVC by default.** The spec's Phase-1 milestone says "against Azure SQL", but Azure provisioning is a user handoff (memory: Plan A). `FACTORY_DB_URL` is one ConfigMap/Secret patch away; the smoke works with either. Recorded so nobody mistakes it for the production shape.
11. **`get_job` gets a `capture` flag instead of always fetching logs** — reading full logs on every poll of every running Job would be O(jobs) log transfers per tick; capture is explicit on the paths that are about to delete (timeout, reap, supersede) and implicit on terminal observations.
12. **409 semantics with uids:** create returns the uid; on 409 the runner adopts the live Job only when its uid matches no prior row for that name (own intent replay), otherwise parks the row as `infra` and lets a later tick recreate — a dying predecessor's late completion can no longer be graded as the new attempt.
13. **Codex auth: Secret → copy into pod-writable `CODEX_HOME`.** codex refreshes tokens in place, so the read-only Secret mount is copied to `/workspace/.codex` per run (`task sync-codex-auth` re-syncs the laptop's `auth.json`, per spec §2's single-developer note). Gate pods never mount it.
14. **Termination-log writability for non-root is assumed (kubelet 0666) and PROVEN in task 9**; the documented fallback (`FallbackToLogsOnError` + envelope-as-last-log-line) is pre-planned in case a runtime breaks the assumption.

## Task summary (tags)

| # | Task | Tag |
|---|---|---|
| 1 | KubeClient seam v2 — uid, 409, running-pod capture | unit |
| 2 | Runner hardening — uid tracking, capture-before-delete, supersede leak | unit |
| 3 | `workspace.py` git-as-workspace primitives | unit |
| 4 | Job manifests v2 — SAs, securityContext, git/CLI env, secret mounts | unit |
| 5 | Runner git integration — trusted surface hash, resets, SHA merge | unit |
| 6 | sf-agent image — Dockerfile, entrypoint, prompts, gate script | docker |
| 7 | kind + Calico + ingress-nginx, enforcement probe | cluster |
| 8 | kustomize base + overlays/local, netpol smoke | cluster |
| 9 | RealKubeClient integration tests (env-gated) | cluster, opt-in |
| 10 | End-to-end kind smoke + docs | cluster+LLM |

## Self-review (writing-plans checklist)

- **Spec coverage (B2 slice of §2/§5/§6/§9):** kind + Calico with proven enforcement → task 7 (`calico-probe.sh`) + task 8 (`netpol-smoke.sh`, including the spec's literal agent→factory-api-must-FAIL assertion); kustomize base + overlays/local → task 8; ingress-nginx → tasks 7–8; arbitrary-UID image + `HOME=/workspace` + forced non-root UID → tasks 4/6 (proven under `--user 12345:0` and again in-cluster in task 9); entrypoint clone→run→push→envelope+NDJSON → task 6; readonly/write opencode config split + `FACTORY_CLI=codex` on the subscription + `task sync-codex-auth` → tasks 6/8/10; gate Job with fixed factory-owned commands at the pinned SHA → tasks 5 (SF_SHA pinning) + 6 (gate.sh); frozen-surface check as orchestrator-side pure git → tasks 3/5; SHA-precondition merge → tasks 3/5; per-tier SAs with `automountServiceAccountToken: false` + factory-api RBAC → tasks 4/8; resources on every pod → tasks 4/8; running-pod log capture / supersede leak / UID-409 ledger items → tasks 1–2 (+9 for the real-cluster proof); one-request end-to-end milestone → task 10. Deliberately deferred with reasons: kaniko/registry/app-deploy, FQDN egress, Azure SQL default (decisions 1, 4, 10).
- **Placeholder scan:** every step carries full code, YAML, or exact commands with expected output; the two "verify at build time" notes (npm package names, Calico/ingress version pins) are loud-failure checks with a recorded fallback, not TBDs.
- **Type consistency:** `create_job(manifest) -> str | None` and `get_job(name, *, capture=False) -> JobView(name, phase, uid, termination_message, logs)` used identically in real client (task 1), fake (task 1), runner (task 2), and integration tests (task 9); `gate_job_manifest(ref, stage, attempt, *, sha="", review_verdict="")` defined in task 4, called with both kwargs in task 5; `workspace.ensure_repo/surface_hash_at/reset_branch/merge_graded/BASELINE_TAG/workspace_for/spec_md/repo_url` defined in task 3 and consumed with those exact names in task 5; env names (`SF_REPO_URL`, `SF_BRANCH`, `SF_SHA`, `SF_CLI`, `SF_MODEL`, `SF_REVIEW_VERDICT`, `SF_TERMLOG`) match between task 4 manifests and task 6 scripts; `StageJob.job_uid` (task 1) read/written in task 2; Service name `api` consistent across nginx.conf, ConfigMap `FACTORY_GIT_REMOTE_BASE`, NetworkPolicies, probes, and the ingress.
