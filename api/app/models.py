"""ORM models.

Vocabulary follows CONTEXT.md: Request, Work item stages, Gates, progress_event
(ADR 0008: one append-only two-axis log — request axis + subject/app axis).
"""
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class App(Base):
    """App registry entry — maps a friendly app name to its repo (the Subject)."""

    __tablename__ = "apps"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(40), unique=True)  # slug, e.g. "northwind"
    name: Mapped[str] = mapped_column(String(120))
    owner: Mapped[str] = mapped_column(String(120))
    repo: Mapped[str] = mapped_column(String(200))
    provisioning: Mapped[str] = mapped_column(String(12), default="Manual")  # Auto | Manual
    muted: Mapped[bool] = mapped_column(Boolean, default=False)

    requests: Mapped[list["Request"]] = relationship(back_populates="app")


class Operator(Base):
    """A named console operator. Authentication can later resolve this same row."""

    __tablename__ = "operators"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    initials: Mapped[str] = mapped_column(String(4))
    hue: Mapped[str] = mapped_column(String(12))
    email: Mapped[str] = mapped_column(String(200), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# Stage columns (fixed, Jira-style): the Work item's position in the Factory.
STAGES = ["intake", "spec", "architecture", "build", "review", "done"]
# The post-approval stages the runner/simulator drive autonomously — the one
# definition every module shares (orphan rescan, Retry re-drive, sim tick).
PIPELINE_STAGES = ("architecture", "build", "review")

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


class Request(Base):
    __tablename__ = "requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    ref: Mapped[str] = mapped_column(String(12), unique=True)  # REQ-2041
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    type: Mapped[str] = mapped_column(String(8))  # bug | enh | new | other
    urgency: Mapped[str] = mapped_column(String(8), default="normal")
    reach: Mapped[str | None] = mapped_column(String(120), nullable=True)  # me | team | dept | wider | free text — null for bugs/unstated
    impact_metric: Mapped[str | None] = mapped_column(String(12), nullable=True)  # hours | cost | other
    impact_value: Mapped[str | None] = mapped_column(String(120), nullable=True)
    priority: Mapped[str] = mapped_column(String(8), default="Normal")

    app_id: Mapped[int | None] = mapped_column(ForeignKey("apps.id"), nullable=True)
    new_app_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    bug_where: Mapped[str | None] = mapped_column(String(200), nullable=True)
    extra_detail: Mapped[str | None] = mapped_column(Text, nullable=True)

    stage: Mapped[str] = mapped_column(String(16), default="intake")
    status: Mapped[str] = mapped_column(String(20), default="draft")
    gate: Mapped[str | None] = mapped_column(String(20), nullable=True)  # approve_spec | approve_merge
    needs_human: Mapped[bool] = mapped_column(Boolean, default=False)
    needs_human_reason: Mapped[str | None] = mapped_column(String(300), nullable=True)

    reporter: Mapped[str] = mapped_column(String(80), default="Jordan D.")
    reporter_initials: Mapped[str] = mapped_column(String(4), default="JD")
    labels: Mapped[list | None] = mapped_column(JSON, nullable=True)

    send_back_question: Mapped[str | None] = mapped_column(Text, nullable=True)
    send_back_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    send_back_rounds: Mapped[int] = mapped_column(Integer, default=0)

    # Per-step Approve ledger (PRD hardening #3, ADR 0006 resumability)
    repo_ready: Mapped[bool] = mapped_column(Boolean, default=False)
    spec_pr_open: Mapped[bool] = mapped_column(Boolean, default=False)
    stage2_fired: Mapped[bool] = mapped_column(Boolean, default=False)

    spec_open_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    sim_step: Mapped[int] = mapped_column(Integer, default=0)
    # the generated-but-unanswered interview question — persisted so the question the
    # submitter sees is exactly the one recorded with their answer (and the brain runs once)
    pending_question: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # AI-written review spec ({overview, sections, at_turns}); cached and regenerated
    # when the interview grows. at_turns is the answered-count it was written for (freshness key).
    summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # when "Add more detail" reopens a finished interview, this overrides the type's question
    # ceiling with a small allowance from where it resumed (~1-2 follow-ups), so a deep
    # budget (new app) doesn't restart a long grill. Null until the first reopen.
    reopen_ceiling: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Prototype step (new-app only) — the current self-contained HTML mock and its status.
    # Denormalized cache (mirrors `summary`); the append-only PrototypeTurn rows are the log,
    # and the current prototype = the latest turn with non-null html.
    prototype_html: Mapped[str | None] = mapped_column(Text, nullable=True)
    prototype_status: Mapped[str] = mapped_column(String(10), default="none")  # none|draft|edited|skipped
    # when the Work item entered its current stage (or its current gate was raised) —
    # powers the Pipeline view's time-in-stage / "is it stuck?" readout
    stage_entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    app: Mapped[App | None] = relationship(back_populates="requests")
    turns: Mapped[list["InterviewTurn"]] = relationship(
        back_populates="request", order_by="InterviewTurn.order", cascade="all, delete-orphan"
    )
    prototype_turns: Mapped[list["PrototypeTurn"]] = relationship(
        back_populates="request", order_by="PrototypeTurn.order", cascade="all, delete-orphan"
    )
    spec_lines: Mapped[list["SpecLine"]] = relationship(
        back_populates="request", order_by="SpecLine.order", cascade="all, delete-orphan"
    )
    comments: Mapped[list["Comment"]] = relationship(
        back_populates="request", order_by="Comment.created_at", cascade="all, delete-orphan"
    )
    attachments: Mapped[list["Attachment"]] = relationship(
        back_populates="request", order_by="Attachment.created_at", cascade="all, delete-orphan"
    )

    @property
    def app_name(self) -> str:
        if self.app:
            return self.app.name
        return self.new_app_name or "No app yet"


class InterviewTurn(Base):
    __tablename__ = "interview_turns"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"))
    order: Mapped[int] = mapped_column(Integer, default=0)
    question: Mapped[str] = mapped_column(Text)
    sub: Mapped[str | None] = mapped_column(Text, nullable=True)
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)  # [{t, d}]
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    skipped: Mapped[bool] = mapped_column(Boolean, default=False)

    request: Mapped[Request] = relationship(back_populates="turns")


class PrototypeTurn(Base):
    """One prototype exchange (append-only, ordered) — modeled on InterviewTurn.

    A turn whose `html` is non-null is a *revision* (a full self-contained document produced
    by a rewrite or an applied patch); a `chat` turn answers a question and adds no revision.
    `mode` is 'pending' while generation is in flight, then 'rewrite' | 'patch' | 'chat'.
    The current prototype = the latest turn with non-null html.
    """

    __tablename__ = "prototype_turns"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"))
    order: Mapped[int] = mapped_column(Integer, default=0)
    instruction: Mapped[str | None] = mapped_column(Text, nullable=True)  # user chat msg; null for the auto first draft
    annotation: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # {pid, selector, tag, textSnippet, ...}
    mode: Mapped[str] = mapped_column(String(8), default="pending")  # pending | rewrite | patch | chat
    note: Mapped[str | None] = mapped_column(Text, nullable=True)  # assistant prose preamble (the streamed part)
    html: Mapped[str | None] = mapped_column(Text, nullable=True)  # resulting document; null on chat/pending
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    request: Mapped[Request] = relationship(back_populates="prototype_turns")


class SpecLine(Base):
    """One grounded Draft-spec line with its provenance tag."""

    __tablename__ = "spec_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"))
    order: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text)
    prov: Mapped[str | None] = mapped_column(String(20), nullable=True)  # "Q1" … ; None+assume=True
    assume: Mapped[bool] = mapped_column(Boolean, default=False)

    request: Mapped[Request] = relationship(back_populates="spec_lines")


class ProgressEvent(Base):
    """ADR 0008: append-only, typed, two-axis progress log.

    kind: milestone_summary | gate_event | escalation | recovery_action | comment | step_summary | verification | steer_note
    """

    __tablename__ = "progress_events"

    id: Mapped[int] = mapped_column(primary_key=True)  # monotonic; doubles as keyset/poll cursor
    request_id: Mapped[int | None] = mapped_column(ForeignKey("requests.id"), nullable=True, index=True)
    subject_id: Mapped[int | None] = mapped_column(ForeignKey("apps.id"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(20))
    stage: Mapped[str] = mapped_column(String(16), default="intake")
    actor: Mapped[str] = mapped_column(String(80), default="Factory")
    bot: Mapped[bool] = mapped_column(Boolean, default=True)
    broadcast: Mapped[bool] = mapped_column(Boolean, default=False)
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"))
    author: Mapped[str] = mapped_column(String(80))
    initials: Mapped[str] = mapped_column(String(4))
    color: Mapped[str] = mapped_column(String(12), default="#6E5A8A")
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    request: Mapped[Request] = relationship(back_populates="comments")


class Attachment(Base):
    """A file a Submitter uploads to a Request as evidence (ADR 0022).
    Bytes live on disk at settings.UPLOADS/<request_id>/<stored>; this row is metadata.
    """

    __tablename__ = "attachments"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"))
    filename: Mapped[str] = mapped_column(String(255))  # original name — display only
    mime: Mapped[str] = mapped_column(String(100))      # sniffed, not the client's claim
    kind: Mapped[str] = mapped_column(String(8))        # image | doc
    size: Mapped[int] = mapped_column(Integer)
    stored: Mapped[str] = mapped_column(String(72))     # on-disk name: <uuid4hex><ext>
    source: Mapped[str] = mapped_column(String(10), default="describe")  # describe | interview
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    request: Mapped["Request"] = relationship(back_populates="attachments")


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"))
    operator_id: Mapped[int | None] = mapped_column(ForeignKey("operators.id"), nullable=True)
    actor: Mapped[str] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(40))  # submitted | approved | sent_back | cancelled | responded | commented
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
