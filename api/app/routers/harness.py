"""Harness pressure report — the read-only half of the feedback loop.

GET /api/harness/pressure groups the machine failure record (StageJob rows,
previously exposed by no router) and the human gate feedback (rejected_merge /
rejected_deploy / sent_back_to_stage audits) by verifier cause, per stage and
harness version, and names the prompt file that governs each bucket. The
"improve" step stays human: read the report, edit the ~400-byte prompt file,
ship it through ordinary review, and compare the buckets across the
harness_version bump (docs/reviews/self-harness-integration-analysis-2026-07-16.md §4).
No new table — a read-time projection over rows the factory already keeps.
"""
import re
from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import harness
from ..db import get_db
from ..models import AuditEvent, Request, StageJob, utcnow

router = APIRouter()

_HUMAN_ACTIONS = ("rejected_merge", "rejected_deploy", "sent_back_to_stage")
# ONLY rejected_* audit notes carry the "(reason_code) free text" format;
# send-back notes are raw operator prose, so the prefix parse must not touch
# them — an operator writing "(perf) too slow" is not declaring a reason_code
_CODE_ACTIONS = ("rejected_merge", "rejected_deploy")
_CODE_PREFIX = re.compile(r"^\((\w+)\)\s")


@router.get("/api/harness/pressure")
def pressure(
    days: int = Query(14, ge=1, le=365),
    db: Session = Depends(get_db),
):
    since = utcnow() - timedelta(days=days)

    # ---------- machine: every failed/timed-out/infra attempt, bucketed ----------
    rows = db.scalars(
        select(StageJob)
        .where(
            StageJob.created_at >= since,
            StageJob.status.in_(("failed", "timed_out", "infra")),
        )
        .order_by(StageJob.id)
    ).all()
    machine: dict[tuple[str, str], dict] = {}
    for row in rows:
        env = row.envelope or {}
        reason = env.get("reason") or env.get("detail") or ""
        if row.status == "timed_out":
            cause = "timeout"
        elif row.status == "infra":
            # infra rows that carry a typed reason (workspace prep, capture
            # miss) keep their specific cause; bare infra stays "infra"
            cause = harness.classify_reason(reason)
            if cause == "other":
                cause = "infra"
        else:
            cause = harness.classify_reason(reason)
        bucket = machine.setdefault((row.stage, cause), {
            "stage": row.stage,
            "cause": cause,
            "count": 0,
            "prompt_file": harness.governing_prompt(row.stage),
            "harness_versions": {},
            "sample_reason": None,
            "last_seen": None,
        })
        bucket["count"] += 1
        if row.harness_version:
            versions = bucket["harness_versions"]
            versions[row.harness_version] = versions.get(row.harness_version, 0) + 1
        if reason:
            bucket["sample_reason"] = reason[:300]
        bucket["last_seen"] = row.completed_at or row.created_at

    # ---------- human: typed gate rejects + send-backs ----------
    audits = db.scalars(
        select(AuditEvent)
        .where(
            AuditEvent.created_at >= since,
            AuditEvent.action.in_(_HUMAN_ACTIONS),
        )
        .order_by(AuditEvent.id)
    ).all()
    refs = {
        r.id: r.ref
        for r in db.scalars(
            select(Request).where(Request.id.in_({a.request_id for a in audits}))
        ).all()
    } if audits else {}
    human: dict[tuple[str, str], dict] = {}
    for audit in audits:
        note = audit.note or ""
        match = _CODE_PREFIX.match(note) if audit.action in _CODE_ACTIONS else None
        code = match.group(1) if match else "-"
        bucket = human.setdefault((audit.action, code), {
            "action": audit.action,
            "reason_code": None if code == "-" else code,
            "count": 0,
            "sample_note": None,
            "sample_ref": None,
            "last_seen": None,
        })
        bucket["count"] += 1
        if note:
            bucket["sample_note"] = (match and note[match.end():] or note)[:300]
        bucket["sample_ref"] = refs.get(audit.request_id)
        bucket["last_seen"] = audit.created_at

    by_count = lambda b: -b["count"]  # noqa: E731
    return {
        "harness_version": harness.HARNESS_VERSION,
        "window_days": days,
        "machine": sorted(machine.values(), key=by_count),
        "human": sorted(human.values(), key=by_count),
        "totals": {
            "machine_failures": len(rows),
            "human_feedback": len(audits),
        },
    }
