"""Human-needed email pings with a safe log-only fallback."""

import logging
import os
import smtplib
from email.message import EmailMessage

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Operator, OperatorAppMute, Request

log = logging.getLogger("factory.notifications")


def smtp_status() -> str:
    """Whether enough transport configuration exists to attempt delivery."""
    return "configured" if _env("SMTP_HOST") and _env("SMTP_FROM") else "log-only"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def send_email(message: EmailMessage) -> None:
    """Patchable transport seam; callers keep gate transitions independent of it."""
    if smtp_status() == "log-only":
        log.info(
            "email (log-only) to=%s subject=%s body=%s",
            message["To"],
            message["Subject"],
            message.get_content().strip(),
        )
        return
    host = _env("SMTP_HOST")
    port = int(_env("SMTP_PORT", "25"))
    with smtplib.SMTP(host, port, timeout=10) as smtp:
        user = _env("SMTP_USER")
        password = _env("SMTP_PASSWORD")
        if user and password:
            smtp.login(user, password)
        smtp.send_message(message)


def _recipients(db: Session, req: Request) -> list[Operator]:
    if req.app_id is None:
        return []
    muted_ids = select(OperatorAppMute.operator_id).where(
        OperatorAppMute.app_id == req.app_id
    )
    return list(
        db.scalars(
            select(Operator)
            .where(Operator.email.isnot(None), Operator.email != "")
            .where(Operator.id.not_in(muted_ids))
            .order_by(Operator.id)
        ).all()
    )


def _notify(db: Session, req: Request, subject: str, body: str) -> None:
    try:
        recipients = _recipients(db, req)
    except Exception:
        log.exception("could not resolve notification recipients for %s", req.ref)
        return
    # Deep link into the CONSOLE (where /requests/:id lives), not the intake app.
    link = f"{_env('CONSOLE_BASE_URL', 'http://localhost:4202').rstrip('/')}/requests/{req.id}"
    for operator in recipients:
        message = EmailMessage()
        message["From"] = _env("SMTP_FROM", "software-factory@localhost")
        message["To"] = operator.email
        message["Subject"] = subject
        message.set_content(f"{body} {link}")
        try:
            send_email(message)
        except Exception:
            log.exception(
                "email delivery failed; gate state preserved (to=%s subject=%s)",
                operator.email,
                subject,
            )


def _notify_requester(req: Request, subject: str, body: str) -> None:
    """Send the requester-owned preview gate to the reporter, not operators."""
    link = (
        f"{_env('INTAKE_BASE_URL', 'http://localhost:4201').rstrip('/')}"
        f"/submit/{req.id}"
    )
    message = EmailMessage()
    message["From"] = _env("SMTP_FROM", "software-factory@localhost")
    message["To"] = req.reporter
    message["Subject"] = subject
    message.set_content(f"{body} {link}")
    try:
        send_email(message)
    except Exception:
        log.exception(
            "email delivery failed; preview gate state preserved (to=%s subject=%s)",
            req.reporter,
            subject,
        )


def notify_gate_raised(db: Session, req: Request) -> None:
    if req.gate == "accept_preview":
        _notify_requester(
            req,
            "Software Factory: preview needs your review",
            f"{req.ref} {req.title} has a live preview ready for review.",
        )
        return
    gate_name = {
        "approve_architecture": "architecture gate",
        "approve_merge": "merge gate",
        "approve_deploy": "deploy gate",
        "accept_preview": "preview",
    }.get(req.gate, "spec gate")
    _notify(
        db,
        req,
        f"Software Factory: {gate_name} needs approval",
        f"{req.ref} {req.title} is waiting at the {gate_name}.",
    )


def notify_escalation(db: Session, req: Request) -> None:
    _notify(
        db,
        req,
        "Software Factory: a request needs a human",
        f"{req.ref} {req.title} needs a human: {req.needs_human_reason or 'the run stalled'}.",
    )
