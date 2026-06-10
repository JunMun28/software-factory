"""Factory simulator — stands in for the Stage 2–6 CI agents.

Each tick advances every in-flight (approved) Work item one step through a
deterministic per-stage script, emitting the same milestone summaries /
gate events the real Copilot agents would post as PR comments (ADR 0004).
The Review→Done boundary is a human gate (approve_merge) — the simulator
stops there and waits for an Admin, exactly like the real Factory.
"""
from sqlalchemy.orm import Session

from .events import emit
from .models import Request

# (stage, steps) — each step is (title, fields-payload). After the last step of
# a stage the item advances to the next stage. Review ends at the merge gate.
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
        # second step raises the merge gate (handled in tick())
    ],
}


def tick(db: Session) -> list[str]:
    """Advance every in-flight Work item one step. Returns human-readable log lines."""
    moved: list[str] = []
    items = (
        db.query(Request)
        .filter(Request.status == "approved", Request.needs_human.is_(False))
        .filter(Request.stage.in_(["architecture", "build", "review"]))
        .order_by(Request.id)
        .all()
    )
    for req in items:
        script = STAGE_SCRIPTS[req.stage]
        step = req.sim_step
        if req.stage == "review" and step >= len(script):
            # raise the merge gate once, then wait for a human
            if req.gate != "approve_merge":
                req.gate = "approve_merge"
                emit(
                    db, req, "gate_event", "Waiting at the merge gate — review passed, approval needed",
                    broadcast=True, payload={"gate": "approve_merge", "Ref": req.ref},
                )
                moved.append(f"{req.ref}: merge gate raised")
            continue
        if step < len(script):
            title, fields = script[step]
            emit(db, req, "milestone_summary", title, payload={"fields": fields, "Ref": req.ref})
            req.sim_step += 1
            moved.append(f"{req.ref}: {req.stage} · {title}")
        if req.sim_step >= len(script) and req.stage != "review":
            nxt = {"architecture": "build", "build": "review"}[req.stage]
            req.stage = nxt
            req.sim_step = 0
            emit(db, req, "milestone_summary", f"Stage advanced — now in {nxt.capitalize()}",
                 payload={"Stage": nxt.capitalize(), "Ref": req.ref})
            moved.append(f"{req.ref}: advanced to {nxt}")
    db.commit()
    return moved


def approve_merge(db: Session, req: Request, actor: str) -> None:
    """The Stage 5/6 human gate: merge + deploy promotion (one protected-branch idea, ADR 0005)."""
    req.gate = None
    req.stage = "done"
    req.status = "done"
    emit(db, req, "gate_event", f"Merge approved by {actor} — PR merged to main",
         actor=actor, bot=False, broadcast=True, payload={"gate": "approve_merge", "Ref": req.ref})
    emit(db, req, "milestone_summary", "Deployed — production promotion merged",
         stage="done", payload={"Stage": "Done", "Ref": req.ref})
