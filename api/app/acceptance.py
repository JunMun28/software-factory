"""Acceptance-criteria derivation and immutable contract snapshots (C4)."""

import hashlib
import json

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import settings, workspace
from .events import emit
from .models import AcceptanceCriterion, Request, SpecSnapshot


def _norm(text: str) -> str:
    return " ".join((text or "").strip().casefold().split())


def active_version(db: Session, req: Request) -> int:
    version = db.scalar(
        select(func.max(AcceptanceCriterion.version)).where(
            AcceptanceCriterion.request_id == req.id
        )
    )
    return int(version or 0)


def active(db: Session, req: Request) -> list[AcceptanceCriterion]:
    version = active_version(db, req)
    return list(
        db.scalars(
            select(AcceptanceCriterion)
            .where(
                AcceptanceCriterion.request_id == req.id,
                AcceptanceCriterion.version == version,
            )
            .order_by(AcceptanceCriterion.ordinal)
        ).all()
    )


def _source_shape(req: Request) -> list[tuple[str, str | None, bool, int]]:
    lines = sorted(req.spec_lines, key=lambda line: (line.order, line.id or 0))
    return [(_norm(line.text), line.prov, bool(line.assume), line.order) for line in lines]


def _criterion_shape(criteria: list[AcceptanceCriterion]) -> list[tuple[str, str | None, bool, int]]:
    ordered = sorted(criteria, key=lambda criterion: (criterion.source_order or 0, criterion.id or 0))
    return [
        (_norm(criterion.text), criterion.prov, bool(criterion.assume), criterion.source_order or 0)
        for criterion in ordered
    ]


def derive_and_snapshot(db: Session, req: Request) -> int:
    """Insert the current AC version and snapshot in the caller's transaction.

    The operation is deterministic under either brain: it reads persisted
    SpecLine rows only. Identical replays are no-ops. Changed contracts retain
    old rows and reuse codes for normalized text matches.
    """
    if not settings.acceptance_enabled():
        return active_version(db, req)

    current_spec = workspace.spec_md(req)
    latest_snapshot = db.scalar(
        select(SpecSnapshot)
        .where(SpecSnapshot.request_id == req.id)
        .order_by(SpecSnapshot.version.desc())
    )
    prior = active(db, req) if latest_snapshot is not None else []
    if (
        latest_snapshot is not None
        and latest_snapshot.spec_md == current_spec
        and _criterion_shape(prior) == _source_shape(req)
    ):
        return latest_snapshot.version

    version = 0 if latest_snapshot is None else latest_snapshot.version + 1
    prior_by_text: dict[str, list[int]] = {}
    for criterion in sorted(prior, key=lambda item: item.ordinal):
        prior_by_text.setdefault(_norm(criterion.text), []).append(
            criterion.ordinal
        )
    next_ordinal = max((criterion.ordinal for criterion in prior), default=0)
    criteria: list[AcceptanceCriterion] = []
    for line in sorted(req.spec_lines, key=lambda item: (item.order, item.id or 0)):
        key = _norm(line.text)
        matching_ordinals = prior_by_text.get(key) or []
        ordinal = matching_ordinals.pop(0) if matching_ordinals else None
        if ordinal is None:
            next_ordinal += 1
            ordinal = next_ordinal
        criterion = AcceptanceCriterion(
            request=req,
            version=version,
            ordinal=ordinal,
            code=f"AC-{ordinal}",
            text=line.text,
            prov=line.prov,
            assume=line.assume,
            source_order=line.order,
        )
        db.add(criterion)
        criteria.append(criterion)

    criteria_json = [
        {
            "code": criterion.code,
            "text": criterion.text,
            "prov": criterion.prov,
            "assume": criterion.assume,
        }
        for criterion in sorted(criteria, key=lambda item: item.ordinal)
    ]
    canonical = json.dumps(
        {"spec_md": current_spec, "criteria": criteria_json},
        sort_keys=True,
        ensure_ascii=False,
    )
    content_hash = hashlib.sha256(canonical.encode()).hexdigest()
    db.add(
        SpecSnapshot(
            request_id=req.id,
            version=version,
            spec_md=current_spec,
            criteria_json=criteria_json,
            content_hash=content_hash,
        )
    )
    emit(
        db,
        req,
        "spec_snapshot",
        f"Acceptance contract v{version} recorded — {len(criteria_json)} criteria",
        stage="spec",
        payload={
            "version": version,
            "ac_count": len(criteria_json),
            "content_hash": content_hash,
            "Ref": req.ref,
        },
    )
    return version
