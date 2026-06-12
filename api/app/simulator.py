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
for _s in PIPELINE_STAGES:
    assert set(MILESTONE_AFTER[_s]) <= set(range(1, len(STEP_PLANS[_s]) + 1))
    assert all(i < len(STAGE_SCRIPTS[_s]) for i in MILESTONE_AFTER[_s].values())


def emit_verification(db: Session, req: Request) -> None:
    """The evidence the merge gate renders (spec §5) — fabricated by the sim
    matching the numbers its review script reports."""
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
