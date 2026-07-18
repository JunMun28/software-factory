"""Factory simulator — stands in for the Stage 2–6 CI agents.

Each tick advances every in-flight (approved) Work item one STEP through a
deterministic per-stage plan, emitting a step_summary (the trace heartbeat
the supervision UI reads) plus the same milestone summaries / gate events
the real agents would post as PR comments (ADR 0004, ADR 0014).
The Review→Done boundary is a human gate (approve_merge) — the simulator
emits its verification report, raises the gate, and waits for an Admin.

Lifecycle writes go through transitions.apply() as MACHINE transitions:
epoch-fenced, so a deposed leader's tick quietly loses (spec §3.2).
"""
import logging
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import settings, transitions, verification
from .events import emit
from .leader import get_elector
from .models import PIPELINE_STAGES, STEP_PLANS, Request
from .supervision import pending_steer_notes
from .transitions import FACTORY, GATE_APPROVE_MERGE

log = logging.getLogger("factory.simulator")

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
for _s in PIPELINE_STAGES:
    assert set(MILESTONE_AFTER[_s]) <= set(range(1, len(STEP_PLANS[_s]) + 1))
    assert all(i < len(STAGE_SCRIPTS[_s]) for i in MILESTONE_AFTER[_s].values())


def emit_verification(db: Session, req: Request) -> None:
    """The evidence the merge gate renders (spec §5) — fabricated by the sim
    matching the numbers its review script reports. Delegates to the single
    source of truth (verification.py): ws=None → the fabricated payload."""
    verification.emit_verification(db, req)


def _tick_request(db: Session, req: Request, moved: list[str],
                  after_commit: list[Callable[[], None]]) -> None:
    plan = STEP_PLANS[req.stage]
    step = req.sim_step
    if req.stage == "review" and step >= len(plan):
        # verification report, then raise the merge gate once, then wait for a human
        if req.gate != GATE_APPROVE_MERGE:
            emit_verification(db, req)
            res = transitions.apply(db, req, "raise_merge_gate", actor=FACTORY,
                                    epoch=get_elector().epoch)
            if isinstance(res, transitions.Win):
                moved.append(f"{req.ref}: merge gate raised")
                after_commit.append(res.notify)
        return
    if step < len(plan):
        label, why = plan[step]
        payload = {"step": step + 1, "of": len(plan), "label": label,
                   "why": why, "Ref": req.ref}
        notes = pending_steer_notes(db, req)
        if notes:
            payload["acked_steer_ids"] = [n.id for n in notes]
            payload["why"] = f"{why} — honoring note: {notes[-1].body[:80]}"
        emit(db, req, "step_summary", f"{label} ({step + 1}/{len(plan)})",
             payload=payload)
        req.sim_step += 1
        moved.append(f"{req.ref}: {req.stage} · {label}")
        mi = MILESTONE_AFTER[req.stage].get(req.sim_step)
        if mi is not None:
            title, fields = STAGE_SCRIPTS[req.stage][mi]
            emit(db, req, "milestone_summary", title,
                 payload={"fields": fields, "Ref": req.ref})
    if req.sim_step >= len(plan) and req.stage != "review":
        # E2E-3 parity with the kube runner: with FACTORY_ARCH_GATE on, a
        # finished architecture pass raises the human gate instead of rolling
        # into build. Approve is the ONLY way past (then this branch advances);
        # reject resets sim_step via the transition, so the stage re-walks and
        # this raise fires again — the refine loop.
        if req.stage == "architecture" and settings.arch_gate_enabled():
            if req.gate is not None:
                return  # waiting at the gate
            newest = transitions.newest_decisive(db, req)
            if newest is None or newest.action != "approved_architecture":
                res = transitions.apply(db, req, "raise_architecture_gate",
                                        actor=FACTORY, epoch=get_elector().epoch)
                if isinstance(res, transitions.Win):
                    moved.append(f"{req.ref}: architecture gate raised")
                    after_commit.append(res.notify)
                return
        nxt = {"architecture": "build", "build": "review"}[req.stage]
        res = transitions.apply(db, req, "advance_stage", actor=FACTORY,
                                params={"stage": nxt, "announce": True},
                                expected_stage=req.stage,
                                epoch=get_elector().epoch)
        if isinstance(res, transitions.Win):
            moved.append(f"{req.ref}: advanced to {nxt}")


def _escalate(db: Session, req: Request, reason: str) -> None:
    db.rollback()
    res = transitions.apply_committed(db, req, "escalate", actor=FACTORY,
                                      params={"reason": reason}, epoch=get_elector().epoch)
    if isinstance(res, transitions.Loss):
        return  # closed (or fenced) meanwhile — nothing to flag


def tick(db: Session) -> list[str]:
    """Advance each in-flight item; one broken simulation stalls only that item."""
    moved: list[str] = []
    items = db.scalars(
        select(Request)
        .where(Request.status == transitions.APPROVED, ~Request.needs_human)
        .where(Request.stage.in_(PIPELINE_STAGES))
        .order_by(Request.id)
    ).all()
    for req in items:
        item_moved: list[str] = []
        after_commit: list[Callable[[], None]] = []
        try:
            _tick_request(db, req, item_moved, after_commit)
            db.commit()
            for notify in after_commit:  # emails only after the gate state is durable
                notify()
            moved.extend(item_moved)
        except Exception as exc:
            log.exception("simulator stalled for %s", req.ref)
            _escalate(db, req, f"Simulator stalled: {exc}")
            moved.append(f"{req.ref}: escalated — simulator stalled")
    return moved


def approve_merge(db: Session, req: Request, actor: str) -> None:
    """The Stage 5/6 human gate: merge + deploy promotion (one protected-branch idea, ADR 0005).

    HTTP-initiated (called from the approve endpoint after claim_merge): no epoch.
    A Loss means the request closed between the claim and here — the endpoint
    records merge_approval_failed; nothing to do."""
    transitions.apply(db, req, "finish_done", actor=transitions.Actor(name=actor),
                      params={"merge_note": "PR merged to main",
                              "deploy_title": "Deployed — production promotion merged"})
