# Supervision Revamp — Plan 1: Backend Foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the backend data the supervision-first UI needs — step-level trace events, derived run-state, gate evidence, and a steer verb — all additive, with `make verify` green at the end.

**Architecture:** Three new event kinds (`step_summary`, `verification`, `steer_note`) ride the existing append-only `progress_event` rail (ADR 0008 — never UPDATE/DELETE rows). Run-state and steer-note consumption are *derived* from the log at read time, never stored. New endpoints: `/api/requests/{rid}/trace`, `/api/requests/{rid}/steer`, `/api/mission`. The simulator gains per-stage step plans so the whole UI is demoable without real agents.

**Tech Stack:** FastAPI + SQLAlchemy + SQLite (api/), pytest. Run all api commands from the `api/` directory with `uv run`.

**Spec:** `docs/superpowers/specs/2026-06-12-ui-supervision-revamp-design.md` (§5 data model, §8 edge cases, §9 testing). This plan is phase 1 of 5 (spec §10 cutover step 1).

**Repo rules that bind every task:**
- `progress_event` rows are append-only — no UPDATE, no DELETE (ADR 0008, CLAUDE.md).
- Tests use the session-scoped `client` fixture (`tests/conftest.py`) and the factories in `tests/helpers.py`. The test DB is seeded (`FACTORY_SEED_DEMO` defaults on), and the simulator tick advances **every** in-flight item — assert on requests your test created, never on global counts.
- Commit messages: this repo uses `feat(api):` / `fix(api):` style prefixes.

---

### Task 1: Simulator step plans + verification event

The simulator currently emits 2 coarse milestones per stage. Give it per-stage step plans: each tick emits one `step_summary` (`{step, of, label, why}`); the legacy milestones still fire at fixed checkpoints so existing feed content is unchanged in spirit; a `verification` event (tests/diff/reviewer/assumptions) is written right before the merge gate is raised.

Stage lengths change: architecture 2→4 ticks, build 2→6, review 2→4 (3 steps + gate raise). Three existing tests and the smoke script assume the old counts — they are updated here too.

**Files:**
- Modify: `api/app/simulator.py`
- Modify: `api/tests/test_api.py:117` and `api/tests/test_api.py:167` (tick loops)
- Modify: `api/tests/test_hardening.py:102-110` (tick counts)
- Modify: `scripts/smoke.sh:69` (tick count)
- Create: `api/tests/test_supervision.py`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_supervision.py`:

```python
"""Supervision revamp backend (spec 2026-06-12): step events, run-state,
steer, trace, mission aggregate, gate evidence."""

from .helpers import approved_request, submitted_request


def _events(client, rid, kind=None):
    evs = client.get("/api/events", params={"request_id": rid}).json()
    return [e for e in evs if kind is None or e["kind"] == kind]


def test_tick_emits_step_summary(client):
    hero = approved_request(client, title="Step summary probe")
    client.post("/api/simulator/tick")
    steps = _events(client, hero["id"], "step_summary")
    assert steps, "first tick after approval must emit a step_summary"
    p = steps[0]["payload"]
    assert p["step"] == 1 and p["of"] == 4
    assert p["label"] == "reading SPEC.md"
    assert p["why"]
    assert steps[0]["stage"] == "architecture"


def test_stage_advances_after_full_step_plan(client):
    hero = approved_request(client, title="Full plan probe")
    for _ in range(4):
        client.post("/api/simulator/tick")
    d = client.get(f"/api/requests/{hero['id']}").json()
    assert d["stage"] == "build"
    titles = [e["title"] for e in _events(client, hero["id"], "milestone_summary")]
    assert any("Architecture plan drafted" in t for t in titles)
    assert any("ADRs signed" in t for t in titles)


def test_verification_emitted_at_merge_gate(client):
    hero = approved_request(client, title="Verification probe")
    for _ in range(16):
        client.post("/api/simulator/tick")
    d = client.get(f"/api/requests/{hero['id']}").json()
    assert d["stage"] == "review" and d["gate"] == "approve_merge"
    ver = _events(client, hero["id"], "verification")
    assert len(ver) == 1, "exactly one verification report at the gate"
    p = ver[0]["payload"]
    assert p["tests_passed"] == 8 and p["tests_total"] == 8
    assert p["reviewer_verdict"] == "no blocking findings"
    assert p["diff_added"] == 412 and p["files_changed"] == 9
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd api && uv run pytest tests/test_supervision.py -v`
Expected: 3 FAILED — no `step_summary` / `verification` events exist yet.

- [ ] **Step 3: Rewrite the simulator**

Replace the whole of `api/app/simulator.py` with:

```python
"""Factory simulator — stands in for the Stage 2–6 CI agents.

Each tick advances every in-flight (approved) Work item one STEP through a
deterministic per-stage plan, emitting a step_summary (the trace heartbeat
the supervision UI reads) plus the same milestone summaries / gate events
the real agents would post as PR comments (ADR 0004, ADR 0014).
The Review→Done boundary is a human gate (approve_merge) — the simulator
emits its verification report, raises the gate, and waits for an Admin.
"""
from sqlalchemy.orm import Session

from . import lifecycle
from .events import emit
from .models import PIPELINE_STAGES, Request, utcnow

# (stage, steps) — each step is (label, why). One step per tick; the stage
# advances when its plan is exhausted. Labels feed run-state and the
# submitter's plain-language activity line, so keep them human.
STEP_PLANS: dict[str, list[tuple[str, str]]] = {
    "architecture": [
        ("reading SPEC.md", "grounding the plan in the approved spec"),
        ("drafting PLAN.md", "smallest architecture that satisfies every spec line"),
        ("writing ADRs", "recording the decisions worth keeping"),
        ("validating plan against SPEC.md", "every spec line maps to a plan step"),
    ],
    "build": [
        ("authoring failing tests", "RED first — the tests define done"),
        ("running the RED gate", "new tests must fail for the right reason"),
        ("implementing the change", "smallest diff that turns RED to GREEN"),
        ("running the test suite", "expecting all green"),
        ("refactoring", "cleanup with the tests as a safety net"),
        ("running the test-isolation gate", "the implementer must not touch test files"),
    ],
    "review": [
        ("running the review pass", "an independent read of the full diff"),
        ("collecting findings", "blocking findings stop the line"),
        ("writing the verification report", "evidence for the merge gate"),
    ],
}

# Legacy milestone summaries (feed content) — unchanged text, now fired at a
# fixed checkpoint: MILESTONE_AFTER[stage][sim_step reached] = script index.
STAGE_SCRIPTS: dict[str, list[tuple[str, dict]]] = {
    "architecture": [
        ("Architecture plan drafted — PLAN.md committed", {"Artifacts": "PLAN.md", "ADRs": "2 drafted"}),
        ("ADRs signed; plan validated against SPEC.md", {"Gate": "Sign ADRs · passed", "Next": "Test authoring"}),
    ],
    "build": [
        ("RED: 8 failing tests authored — fail for the right reason", {"Tests": "8 added, 8 failing", "Gate": "RED · passed"}),
        ("GREEN: all tests pass; implementer touched no test files", {"Tests": "8/8 passing", "Gate": "Test-isolation · passed"}),
    ],
    "review": [
        ("Review report posted — no blocking findings", {"Findings": "0 blocking · 2 nits", "Diff": "+412 −38"}),
    ],
}
MILESTONE_AFTER: dict[str, dict[int, int]] = {
    "architecture": {2: 0, 4: 1},
    "build": {3: 0, 6: 1},
    "review": {3: 0},
}


def emit_verification(db: Session, req: Request) -> None:
    """The evidence the merge gate renders (spec §5) — fabricated by the sim
    from the same numbers its review script reports."""
    emit(db, req, "verification", "Verification report — ready for the merge gate",
         stage="review",
         payload={"tests_passed": 8, "tests_total": 8, "diff_added": 412,
                  "diff_removed": 38, "files_changed": 9,
                  "reviewer_verdict": "no blocking findings",
                  "assumptions": [line.text for line in req.spec_lines if line.assume],
                  "Ref": req.ref})


def tick(db: Session) -> list[str]:
    """Advance every in-flight Work item one step. Returns human-readable log lines."""
    moved: list[str] = []
    items = (
        db.query(Request)
        .filter(Request.status == "approved", Request.needs_human.is_(False))
        .filter(Request.stage.in_(PIPELINE_STAGES))
        .order_by(Request.id)
        .all()
    )
    for req in items:
        plan = STEP_PLANS[req.stage]
        step = req.sim_step
        if req.stage == "review" and step >= len(plan):
            # verification report, then raise the merge gate once, then wait for a human
            if req.gate != "approve_merge":
                emit_verification(db, req)
                lifecycle.raise_merge_gate(db, req)
                moved.append(f"{req.ref}: merge gate raised")
            continue
        if step < len(plan):
            label, why = plan[step]
            emit(db, req, "step_summary", f"{label} ({step + 1}/{len(plan)})",
                 payload={"step": step + 1, "of": len(plan), "label": label,
                          "why": why, "Ref": req.ref})
            req.sim_step += 1
            moved.append(f"{req.ref}: {req.stage} · {label}")
            mi = MILESTONE_AFTER[req.stage].get(req.sim_step)
            if mi is not None:
                title, fields = STAGE_SCRIPTS[req.stage][mi]
                emit(db, req, "milestone_summary", title,
                     payload={"fields": fields, "Ref": req.ref})
        if req.sim_step >= len(plan) and req.stage != "review":
            nxt = {"architecture": "build", "build": "review"}[req.stage]
            req.stage = nxt
            req.sim_step = 0
            req.stage_entered_at = utcnow()
            emit(db, req, "milestone_summary", f"Stage advanced — now in {nxt.capitalize()}",
                 payload={"Stage": nxt.capitalize(), "Ref": req.ref})
            moved.append(f"{req.ref}: advanced to {nxt}")
    db.commit()
    return moved


def approve_merge(db: Session, req: Request, actor: str) -> None:
    """The Stage 5/6 human gate: merge + deploy promotion (one protected-branch idea, ADR 0005)."""
    lifecycle.finish_done(db, req, actor,
                          merge_note="PR merged to main",
                          deploy_title="Deployed — production promotion merged")
```

- [ ] **Step 4: Update the three tick-count tests**

In `api/tests/test_api.py`, in `test_simulator_drives_stages_to_merge_gate` (~line 113) and `test_stage_clock_and_last_event` (~line 164), change both loops:

```python
    for _ in range(16):
        client.post("/api/simulator/tick")
```

(was `range(10)`; the path to the merge gate is now 4 + 6 + 3 steps + 1 gate-raise tick = 14.)

In `api/tests/test_hardening.py`, `test_stage_clock_advances_with_stages` (~line 102):

```python
    for _ in range(4):  # architecture is a 4-step plan → advance to build
        client.post("/api/simulator/tick")
```

(replaces the two single `client.post("/api/simulator/tick")` lines and their `# arch step` comments.)

In `scripts/smoke.sh` line 69, change `seq 1 8` to `seq 1 16`.

- [ ] **Step 5: Run the full backend suite**

Run: `cd api && uv run pytest -q`
Expected: ALL PASS (new supervision tests + updated legacy tests).

- [ ] **Step 6: Commit**

```bash
git add api/app/simulator.py api/tests/test_supervision.py api/tests/test_api.py api/tests/test_hardening.py scripts/smoke.sh
git commit -m "feat(api): simulator step plans — step_summary heartbeat + verification at the merge gate"
```

---

### Task 2: Derived run-state (`app/supervision.py` + settings knob)

Run-state is computed from the log: latest `step_summary` for the request's current stage gives `{step, of, label}`; health comes from time-since-last-event. Nothing is stored (spec §5). Also adds gate-evidence derivation (spec gates derive from spec lines; merge gates read the latest `verification` event).

**Files:**
- Modify: `api/app/settings.py` (one knob)
- Create: `api/app/supervision.py`
- Test: `api/tests/test_supervision.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_supervision.py`:

```python
def test_run_state_derivation(client):
    from app.db import SessionLocal
    from app.models import Request
    from app.supervision import run_state

    hero = approved_request(client, title="Run state probe")
    with SessionLocal() as db:
        r = db.get(Request, hero["id"])
        rs = run_state(db, r)
        assert rs == {"step": 0, "of": 4, "label": None, "health": "no_signal",
                      "seconds_since_event": rs["seconds_since_event"]}

    client.post("/api/simulator/tick")
    with SessionLocal() as db:
        r = db.get(Request, hero["id"])
        rs = run_state(db, r)
        assert rs["step"] == 1 and rs["of"] == 4
        assert rs["label"] == "reading SPEC.md"
        assert rs["health"] == "healthy"  # event written milliseconds ago


def test_run_state_none_unless_in_flight(client):
    from app.db import SessionLocal
    from app.models import Request
    from app.supervision import run_state

    gated = submitted_request(client, title="Gated probe")  # at the spec gate
    with SessionLocal() as db:
        r = db.get(Request, gated["id"])
        assert run_state(db, r) is None


def test_evidence_for_spec_gate(client):
    from app.db import SessionLocal
    from app.models import Request
    from app.supervision import evidence

    gated = submitted_request(client, title="Spec evidence probe")
    with SessionLocal() as db:
        r = db.get(Request, gated["id"])
        ev = evidence(db, r)
        assert ev is not None and ev["kind"] == "spec"
        assert ev["total_lines"] >= 1
        assert isinstance(ev["assumptions"], list)


def test_evidence_for_merge_gate(client):
    from app.db import SessionLocal
    from app.models import Request
    from app.supervision import evidence

    hero = approved_request(client, title="Merge evidence probe")
    for _ in range(16):
        client.post("/api/simulator/tick")
    with SessionLocal() as db:
        r = db.get(Request, hero["id"])
        assert r.gate == "approve_merge"
        ev = evidence(db, r)
        assert ev["kind"] == "merge"
        assert ev["tests_passed"] == 8 and ev["tests_total"] == 8
        assert ev["reviewer_verdict"] == "no blocking findings"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_supervision.py -v`
Expected: the 4 new tests FAIL with `ModuleNotFoundError: app.supervision`.

- [ ] **Step 3: Add the settings knob**

In `api/app/settings.py`, after the `SIM_INTERVAL` line, add:

```python
# run-state health (spec 2026-06-12 §5): a run with no step event for this
# long renders "slow". Default 3× the sim tick; fixed fallback when the
# interval is 0 (tests, manual ticking).
RUN_SLOW_AFTER_SECONDS = float(os.environ.get("RUN_SLOW_AFTER_SECONDS", "0") or 0) or (
    3 * SIM_INTERVAL if SIM_INTERVAL > 0 else 30.0
)
```

- [ ] **Step 4: Create `api/app/supervision.py`**

```python
"""Derived run-state, steer-note bookkeeping, and gate evidence (ADR 0014).

Everything here is DERIVED from the append-only progress_event log (ADR 0008)
at read time — no mutable run columns exist, and the log is never UPDATEd.
A steer note is "consumed" when a later step_summary lists its id in
payload.acked_steer_ids; pending notes are computed, never flagged in place.
"""
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from . import settings
from .models import PIPELINE_STAGES, ProgressEvent, Request, utcnow
from .simulator import STEP_PLANS


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; normalize before arithmetic."""
    if dt is None or dt.tzinfo:
        return dt
    return dt.replace(tzinfo=timezone.utc)


def in_flight(r: Request) -> bool:
    """Running autonomously right now: approved, in a pipeline stage, not
    parked at a gate, not escalated."""
    return (r.status == "approved" and r.stage in PIPELINE_STAGES
            and not r.needs_human and r.gate is None)


def run_state(db: Session, r: Request) -> dict | None:
    """{step, of, label, health, seconds_since_event} for an in-flight run,
    else None. health: healthy | slow | no_signal — never a false 'stalled'
    (stalled is the needs_human escalation, a different surface)."""
    if not in_flight(r):
        return None
    ev = (db.query(ProgressEvent)
          .filter(ProgressEvent.request_id == r.id,
                  ProgressEvent.kind == "step_summary",
                  ProgressEvent.stage == r.stage)
          .order_by(ProgressEvent.id.desc())
          .first())
    plan_len = len(STEP_PLANS.get(r.stage, []))
    last_at = _aware(ev.created_at) if ev else _aware(r.stage_entered_at)
    seconds = max(0, int((utcnow() - last_at).total_seconds())) if last_at else 0
    if ev is None:
        return {"step": 0, "of": plan_len, "label": None,
                "health": "no_signal", "seconds_since_event": seconds}
    p = ev.payload or {}
    health = "healthy" if seconds < settings.RUN_SLOW_AFTER_SECONDS else "slow"
    return {"step": p.get("step", 0), "of": p.get("of", plan_len),
            "label": p.get("label"), "health": health,
            "seconds_since_event": seconds}


def pending_steer_notes(db: Session, r: Request) -> list[ProgressEvent]:
    """Steer notes not yet acknowledged by a later step_summary."""
    rows = (db.query(ProgressEvent)
            .filter(ProgressEvent.request_id == r.id,
                    ProgressEvent.kind.in_(("steer_note", "step_summary")))
            .order_by(ProgressEvent.id)
            .all())
    acked: set[int] = set()
    for ev in rows:
        if ev.kind == "step_summary":
            acked.update((ev.payload or {}).get("acked_steer_ids") or [])
    return [ev for ev in rows if ev.kind == "steer_note" and ev.id not in acked]


def evidence(db: Session, r: Request) -> dict | None:
    """What the admin sees before approving (spec §6 'evidence strip').
    Spec gates derive from the grounded draft spec; merge gates read the
    latest verification event. None → the UI renders 'no evidence recorded'."""
    if r.gate == "approve_spec":
        lines = r.spec_lines
        return {"kind": "spec",
                "grounded_lines": sum(1 for ln in lines if ln.prov and not ln.assume),
                "total_lines": len(lines),
                "interview_count": sum(1 for t in r.turns if t.answer),
                "assumptions": [ln.text for ln in lines if ln.assume]}
    if r.gate == "approve_merge":
        ev = (db.query(ProgressEvent)
              .filter(ProgressEvent.request_id == r.id,
                      ProgressEvent.kind == "verification")
              .order_by(ProgressEvent.id.desc())
              .first())
        if not ev:
            return None
        p = ev.payload or {}
        return {"kind": "merge",
                "tests_passed": p.get("tests_passed"), "tests_total": p.get("tests_total"),
                "diff_added": p.get("diff_added"), "diff_removed": p.get("diff_removed"),
                "files_changed": p.get("files_changed"),
                "reviewer_verdict": p.get("reviewer_verdict"),
                "assumptions": p.get("assumptions") or []}
    return None
```

- [ ] **Step 5: Run the tests**

Run: `cd api && uv run pytest tests/test_supervision.py -v`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add api/app/settings.py api/app/supervision.py api/tests/test_supervision.py
git commit -m "feat(api): derived run-state, gate evidence, steer-note bookkeeping (app/supervision.py)"
```

---

### Task 3: Steer endpoint + simulator acknowledgment

`POST /api/requests/{rid}/steer {note, actor}` appends a `steer_note` (409 unless the run is in flight). The simulator consumes pending notes at the next step boundary: it lists their ids in the step's `acked_steer_ids` payload and appends `— honoring note: …` to the step's `why`. Consumption is derived (Task 2); the log is never mutated.

**Files:**
- Modify: `api/app/schemas.py` (SteerIn)
- Modify: `api/app/routers/requests.py` (endpoint)
- Modify: `api/app/simulator.py` (ack in `tick`)
- Test: `api/tests/test_supervision.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_supervision.py`:

```python
def test_steer_appends_and_is_acked_next_step(client):
    hero = approved_request(client, title="Steer probe")
    client.post("/api/simulator/tick")  # step 1 done, run clearly in flight

    resp = client.post(f"/api/requests/{hero['id']}/steer",
                       json={"note": "Prefer the existing CSV parser", "actor": "Kim P."})
    assert resp.status_code == 201
    note_id = resp.json()["id"]

    notes = _events(client, hero["id"], "steer_note")
    assert len(notes) == 1 and notes[0]["actor"] == "Kim P." and notes[0]["bot"] is False

    client.post("/api/simulator/tick")  # the very next step must acknowledge
    steps = _events(client, hero["id"], "step_summary")
    last = steps[-1]["payload"]
    assert note_id in last["acked_steer_ids"]
    assert "honoring note" in last["why"]

    client.post("/api/simulator/tick")  # acked notes are not re-acked
    steps = _events(client, hero["id"], "step_summary")
    assert "acked_steer_ids" not in (steps[-1]["payload"] or {})


def test_steer_409_when_not_in_flight(client):
    gated = submitted_request(client, title="Steer gate probe")  # spec gate
    resp = client.post(f"/api/requests/{gated['id']}/steer", json={"note": "x"})
    assert resp.status_code == 409

    hero = approved_request(client, title="Steer merge-gate probe")
    for _ in range(16):
        client.post("/api/simulator/tick")  # park it at the merge gate
    resp = client.post(f"/api/requests/{hero['id']}/steer", json={"note": "x"})
    assert resp.status_code == 409, "at a gate = waiting on a human, not steerable"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_supervision.py -k steer -v`
Expected: FAIL — 404/405 (endpoint missing).

- [ ] **Step 3: Add SteerIn to `api/app/schemas.py`**

After the `Note` class:

```python
class SteerIn(BaseModel):
    """A mid-run course-correction note (spec §5): consumed by the runner at
    the next step boundary."""
    note: str = Field(min_length=1, max_length=1000)
    actor: str = Field(default="Kim P.", max_length=80)
```

- [ ] **Step 4: Add the endpoint to `api/app/routers/requests.py`**

Add `SteerIn` to the existing `from ..schemas import (...)` block, add `AuditEvent` to the models import if absent, add `from ..supervision import in_flight`, and place after the `submit` endpoint:

```python
@router.post("/api/requests/{rid}/steer", status_code=201)
def steer(rid: int, body: SteerIn, db: Session = Depends(get_db)):
    """Append a steer note for a RUNNING build (spec §6). 409 anywhere else:
    at a gate the human verb is approve/send-back; stalled has Recovery."""
    r = get_request(db, rid)
    if not in_flight(r):
        raise HTTPException(409, "Steer is only available while a run is in flight")
    ev = emit(db, r, "steer_note", body.note[:300], actor=body.actor, bot=False, body=body.note)
    db.add(AuditEvent(request_id=r.id, actor=body.actor, action="steered", note=body.note[:300]))
    db.commit()
    return {"id": ev.id, "status": "queued"}
```

(`emit` and `HTTPException` are already imported in this router; verify and add if not.)

- [ ] **Step 5: Acknowledge notes in the simulator**

In `api/app/simulator.py`, add the import at top: `from .supervision import pending_steer_notes` — **no**: supervision imports simulator (STEP_PLANS), so import it lazily inside `tick()` to avoid the cycle. Inside `tick()`, replace the step-emission block:

```python
        if step < len(plan):
            from .supervision import pending_steer_notes  # local: avoids import cycle
            label, why = plan[step]
            payload = {"step": step + 1, "of": len(plan), "label": label,
                       "why": why, "Ref": req.ref}
            notes = pending_steer_notes(db, req)
            if notes:
                payload["acked_steer_ids"] = [n.id for n in notes]
                payload["why"] = f"{why} — honoring note: {notes[-1].body[:80]}"
            emit(db, req, "step_summary", f"{label} ({step + 1}/{len(plan)})",
                 payload=payload)
```

(the rest of the block — `req.sim_step += 1`, milestone checkpoint, stage advance — is unchanged.)

- [ ] **Step 6: Run the suite**

Run: `cd api && uv run pytest -q`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add api/app/schemas.py api/app/routers/requests.py api/app/simulator.py api/tests/test_supervision.py
git commit -m "feat(api): steer verb — mid-run notes appended to the rail, acked at the next step"
```

---

### Task 4: Trace endpoint + run/evidence on request detail

`GET /api/requests/{rid}/trace?after=` returns the request's full event history shaped like the subject feed (FeedPage: latest page on first load, keyset `?after=` for deltas). `GET /api/requests/{rid}` gains `run` and `evidence` blocks.

**Files:**
- Modify: `api/app/schemas.py` (RunStateOut, EvidenceOut; RequestDetail fields)
- Modify: `api/app/routers/events.py` (trace endpoint)
- Modify: `api/app/routers/requests.py` (detail blocks)
- Test: `api/tests/test_supervision.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_supervision.py`:

```python
def test_trace_keyset(client):
    hero = approved_request(client, title="Trace probe")
    client.post("/api/simulator/tick")

    page = client.get(f"/api/requests/{hero['id']}/trace").json()
    assert page["items"] and page["cursor"] > 0
    kinds = {e["kind"] for e in page["items"]}
    assert "step_summary" in kinds and "gate_event" in kinds
    ids = [e["id"] for e in page["items"]]
    assert ids == sorted(ids), "ascending within the page"

    cursor = page["cursor"]
    assert client.get(f"/api/requests/{hero['id']}/trace",
                      params={"after": cursor}).json()["items"] == []
    client.post("/api/simulator/tick")
    newer = client.get(f"/api/requests/{hero['id']}/trace",
                       params={"after": cursor}).json()
    assert newer["items"] and all(e["id"] > cursor for e in newer["items"])

    assert client.get("/api/requests/999999/trace").status_code == 404


def test_detail_carries_run_and_evidence(client):
    hero = approved_request(client, title="Detail blocks probe")
    client.post("/api/simulator/tick")
    d = client.get(f"/api/requests/{hero['id']}").json()
    assert d["run"]["step"] == 1 and d["run"]["label"] == "reading SPEC.md"
    assert d["evidence"] is None  # not at a gate

    gated = submitted_request(client, title="Detail evidence probe")
    d = client.get(f"/api/requests/{gated['id']}").json()
    assert d["run"] is None
    assert d["evidence"]["kind"] == "spec" and d["evidence"]["total_lines"] >= 1
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && uv run pytest tests/test_supervision.py -k "trace or detail" -v`
Expected: FAIL (404 on /trace; KeyError 'run').

- [ ] **Step 3: Add the schemas**

In `api/app/schemas.py`, after `AuditOut`:

```python
class RunStateOut(BaseModel):
    """Derived run-state for an in-flight build (spec §5 — never stored)."""
    step: int
    of: int
    label: str | None = None
    health: Literal["healthy", "slow", "no_signal"]
    seconds_since_event: int


class EvidenceOut(BaseModel):
    """What the admin sees before approving (spec §6). kind='spec' uses the
    grounded-lines fields; kind='merge' uses the verification fields."""
    kind: Literal["spec", "merge"]
    grounded_lines: int | None = None
    total_lines: int | None = None
    interview_count: int | None = None
    tests_passed: int | None = None
    tests_total: int | None = None
    diff_added: int | None = None
    diff_removed: int | None = None
    files_changed: int | None = None
    reviewer_verdict: str | None = None
    assumptions: list[str] = []
```

And extend `RequestDetail`:

```python
class RequestDetail(RequestOut):
    turns: list[TurnOut] = []
    spec_lines: list[SpecLineOut] = []
    comments: list[CommentOut] = []
    audit: list[AuditOut] = []
    duplicate: dict | None = None
    run: RunStateOut | None = None
    evidence: EvidenceOut | None = None
```

- [ ] **Step 4: Add the trace endpoint to `api/app/routers/events.py`**

Add `get_request` to the existing `from ..api_helpers import` line, then after `subject_feed`:

```python
@router.get("/api/requests/{rid}/trace", response_model=FeedPage)
def request_trace(rid: int, after: int = 0, limit: int = 200, db: Session = Depends(get_db)):
    """The per-request trace (ADR 0014): with no cursor, the LATEST `limit`
    items (ascending); with ?after=, only newer. Same keyset shape as the
    subject feed, so the poll seam is identical."""
    get_request(db, rid)  # 404 before reading the log
    limit = min(limit, 500)
    base = joined_events(db).filter(ProgressEvent.request_id == rid)
    if after > 0:
        rows = base.filter(ProgressEvent.id > after).order_by(ProgressEvent.id).limit(limit).all()
    else:
        rows = list(reversed(base.order_by(ProgressEvent.id.desc()).limit(limit).all()))
    items = serialize_events(rows)
    cursor = items[-1].id if items else after
    return FeedPage(items=items, cursor=cursor)
```

- [ ] **Step 5: Populate the detail blocks**

In `api/app/routers/requests.py`, add `from ..supervision import evidence, in_flight, run_state` (extend the Task 3 import), and in `request_detail`, after the `d.audit = ...` line:

```python
    d.run = run_state(db, r)
    d.evidence = evidence(db, r)
```

- [ ] **Step 6: Run the suite**

Run: `cd api && uv run pytest -q`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add api/app/schemas.py api/app/routers/events.py api/app/routers/requests.py api/tests/test_supervision.py
git commit -m "feat(api): per-request trace endpoint; run + evidence blocks on request detail"
```

---

### Task 5: `GET /api/mission` aggregate

One poll for the Mission control home (spec §5): gates with evidence, runs with run-state, stalled, recent (done/cancelled in the last 7 days + everything sent back), plus the global event cursor.

**Files:**
- Modify: `api/app/schemas.py` (MissionGate, MissionRun, MissionOut)
- Create: `api/app/routers/mission.py`
- Modify: `api/app/main.py` (router registration)
- Test: `api/tests/test_supervision.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_supervision.py`:

```python
def test_mission_aggregate(client):
    gated = submitted_request(client, title="Mission gate probe")
    running = approved_request(client, title="Mission run probe")
    client.post("/api/simulator/tick")

    m = client.get("/api/mission").json()
    assert set(m) == {"gates", "runs", "stalled", "recent", "cursor"}
    assert m["cursor"] > 0

    gate = next(g for g in m["gates"] if g["request"]["id"] == gated["id"])
    assert gate["request"]["gate"] == "approve_spec"
    assert gate["evidence"]["kind"] == "spec"

    run = next(r for r in m["runs"] if r["request"]["id"] == running["id"])
    assert run["run"]["step"] >= 1 and run["run"]["health"] in ("healthy", "slow")

    assert all(s["needs_human"] for s in m["stalled"])
    assert all(g["request"]["needs_human"] is False for g in m["gates"])
    open_ids = {g["request"]["id"] for g in m["gates"]} | {r["request"]["id"] for r in m["runs"]}
    recent_ids = {r["id"] for r in m["recent"]}
    assert not (open_ids & recent_ids), "an item appears in exactly one band"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_supervision.py -k mission -v`
Expected: FAIL — 404 (no /api/mission).

- [ ] **Step 3: Add the schemas**

In `api/app/schemas.py`, after `EvidenceOut`:

```python
class MissionGate(BaseModel):
    request: "RequestOut"
    evidence: EvidenceOut | None = None  # None → UI shows "no evidence recorded"


class MissionRun(BaseModel):
    request: "RequestOut"
    run: RunStateOut


class MissionOut(BaseModel):
    """One poll for the Mission control home (spec §6)."""
    gates: list[MissionGate]
    runs: list[MissionRun]
    stalled: list["RequestOut"]
    recent: list["RequestOut"]
    cursor: int
```

- [ ] **Step 4: Create `api/app/routers/mission.py`**

```python
"""Mission control aggregate (spec 2026-06-12 §5): the home surface polls
this one endpoint instead of five."""
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from ..api_helpers import to_out
from ..db import get_db
from ..models import ProgressEvent, Request, utcnow
from ..schemas import MissionGate, MissionOut, MissionRun, RunStateOut
from ..supervision import evidence, run_state

router = APIRouter()

CLOSED = ("cancelled", "done")


@router.get("/api/mission", response_model=MissionOut)
def mission(db: Session = Depends(get_db)):
    live = (db.query(Request)
            .filter(Request.status.notin_(CLOSED))
            .order_by(Request.stage_entered_at)
            .all())
    gates = [MissionGate(request=to_out(r), evidence=evidence(db, r))
             for r in live if r.gate and not r.needs_human]
    runs = []
    for r in live:
        rs = run_state(db, r)
        if rs:
            runs.append(MissionRun(request=to_out(r), run=RunStateOut(**rs)))
    stalled = [to_out(r) for r in live if r.needs_human]
    week_ago = utcnow() - timedelta(days=7)
    recent_rows = (db.query(Request)
                   .filter(or_(and_(Request.status.in_(CLOSED), Request.updated_at >= week_ago),
                               Request.status == "sent_back"))
                   .order_by(Request.updated_at.desc())
                   .limit(10)
                   .all())
    recent = [to_out(r) for r in recent_rows]
    cursor = db.query(func.max(ProgressEvent.id)).scalar() or 0
    return MissionOut(gates=gates, runs=runs, stalled=stalled, recent=recent, cursor=cursor)
```

- [ ] **Step 5: Register the router**

In `api/app/main.py`: add `from .routers import mission as mission_router` next to the other router imports, and `app.include_router(mission_router.router)` next to the other `include_router` calls.

- [ ] **Step 6: Run the suite**

Run: `cd api && uv run pytest -q`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add api/app/schemas.py api/app/routers/mission.py api/app/main.py api/tests/test_supervision.py
git commit -m "feat(api): GET /api/mission — one-poll aggregate for the supervision home"
```

---

### Task 6: Seed an in-flight run with step events

The seeded world has REQ-2029 (Migrate auth to SSO) mid-build but no step events, so Mission control would show "no signal" on first boot. Seed its trace so the demo reads alive: `sim_step=3` (the seeded RED milestone has fired) plus three step events.

**Files:**
- Modify: `api/app/seed.py`
- Test: `api/tests/test_supervision.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_supervision.py`:

```python
def test_seeded_run_has_step_trace(client):
    sso = next(r for r in client.get("/api/requests").json() if r["ref"] == "REQ-2029")
    if sso["status"] != "approved":
        return  # an earlier test already drove the seeded item past build
    steps = _events(client, sso["id"], "step_summary")
    assert len(steps) >= 3, "seed must include the in-flight step trace"
    assert steps[-1]["payload"]["label"] == "implementing the change"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_supervision.py -k seeded -v`
Expected: FAIL (0 step events) — unless the full suite ran first and the guard returned; verify with `-k seeded` alone, which runs against the already-seeded session DB. If the guard skipped, run just this file fresh: `uv run pytest tests/test_supervision.py -v` (fresh DB per pytest invocation).

- [ ] **Step 3: Update the seed**

In `api/app/seed.py`: in the `r_sso = req("REQ-2029", ...)` call, change `sim_step=1` to `sim_step=3`. Then, directly after the existing `for _i, (kind, title, payload, dt) in enumerate([...])` block that seeds r_sso's milestones, add:

```python
    for i, (label, why, dt) in enumerate([
        ("authoring failing tests", "RED first — the tests define done", ago(hours=20)),
        ("running the RED gate", "new tests must fail for the right reason", ago(hours=16)),
        ("implementing the change", "smallest diff that turns RED to GREEN", ago(minutes=2)),
    ]):
        ev = e(r_sso, "step_summary", f"{label} ({i + 1}/6)",
               payload={"step": i + 1, "of": 6, "label": label, "why": why, "Ref": r_sso.ref})
        ev.created_at = dt
```

(`e` and `ago` already exist in this file. The last event is 2 minutes old so the seeded run reads "healthy"… within the 30s default it reads "slow" — that is intentional: the demo shows one healthy-after-next-tick run and exercises the slow style. With `SIM_INTERVAL=8` dev ticking, the next tick refreshes it to healthy within seconds.)

- [ ] **Step 4: Run the suite**

Run: `cd api && uv run pytest -q`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add api/app/seed.py api/tests/test_supervision.py
git commit -m "feat(api): seed the in-flight run's step trace so mission control demos alive"
```

---

### Task 7: ADR 0014 — step-level trace events

**Files:**
- Create: `docs/adr/0014-step-level-trace-events.md`

- [ ] **Step 1: Write the ADR**

```markdown
# Step-level trace events on the progress rail, still never streaming

**Status:** accepted

The supervision revamp (spec 2026-06-12) needs three things ADR 0004's
stage-end milestone summaries cannot express: live run-state for the
"In flight" band, a per-request trace answering "what did the agent decide
and why", and a steer verb with visible acknowledgment.

We add three event kinds to the existing append-only progress_event log
(ADR 0008): `step_summary` (one short summary at the end of each agent step,
with step/of/label/why), `verification` (tests, diff stats, reviewer verdict,
assumptions — written when a run reaches a gate), and `steer_note` (a human
note consumed by the runner at the next step boundary, acknowledged by id in
the consuming step's payload — derived consumption, the log is never UPDATEd).
Run-state ({step, of, label, health}) is DERIVED from the latest step_summary
plus event recency at read time; nothing mutable is stored.

## Consequences

- Reporting granularity moves from stage boundaries to step boundaries.
  ADR 0004's core holds unchanged: no websockets, no agent phone-home API,
  no token-by-token narration — summaries on the same polled GitHub-event
  rail, just finer.
- The per-app feed stays milestone-level; step events render only in the
  per-request trace (`/api/requests/{rid}/trace`). This is the firehose
  guard: channel surfaces stay calm, drill-down gets detail.
- Health ("slow") is a derived threshold (RUN_SLOW_AFTER_SECONDS, default
  3× SIM_INTERVAL) — honest about signal recency, never a stored claim.
- Real (non-sim) runners must emit step_summary/verification to stay
  first-class on the supervision surfaces; the sim demonstrates the contract.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0014-step-level-trace-events.md
git commit -m "docs(adr): 0014 — step-level trace events; ADR 0004 no-streaming core holds"
```

---

### Task 8: Full verification

- [ ] **Step 1: Run the whole gate**

Run from the repo root: `make verify`
Expected: lint (ruff + eslint + prettier) PASS, pytest PASS, vitest PASS, Angular build PASS, smoke PASS, ending with `✓ VERIFY PASSED`.

The smoke script now ticks 16× (Task 1); it must reach `merge gate → approve merge → deployed` exactly as before.

- [ ] **Step 2: Manual spot-check (optional but recommended)**

```bash
cd api && SIM_INTERVAL=8 uv run uvicorn app.main:app --port 8001 --reload
```

Then: `curl -s localhost:8001/api/mission | python3 -m json.tool` — expect the seeded world: 3 spec gates with evidence, 1 run (REQ-2029, step 3/6, "implementing the change"), 1 stalled (REQ-2043), recent items, cursor > 0.

- [ ] **Step 3: Commit anything outstanding**

```bash
git status --short   # should be clean; commit stragglers if any
```

---

## Self-review notes (already applied)

- **Spec coverage (Plan 1 scope = spec §5 + §10 step 1):** step_summary ✓ (Task 1), verification ✓ (Task 1), steer_note + 409 + ack ✓ (Task 3), derived run-state + RUN_SLOW_AFTER_SECONDS ✓ (Task 2), trace endpoint ✓ (Task 4), mission endpoint ✓ (Task 5), evidence + run blocks on detail ✓ (Task 4), simulator + seed demoability ✓ (Tasks 1, 6), ADR ✓ (Task 7). The extended smoke flow (steer/trace asserts) and all UI work land in Plans 2–5.
- **Steer-at-gate "not consumed" rendering** (spec §8) is a UI concern — the data (pending note + request at gate) is fully derivable from this plan's endpoints.
- **Type consistency:** `run_state()` dict keys == `RunStateOut` fields; `evidence()` dict keys == `EvidenceOut` fields; `MissionOut` band names match the spec's four bands.
- **Known interaction:** the session-scoped test DB is shared; every new test asserts only on requests it created (and Task 6's test guards against earlier tests having advanced the seeded item).
