"""ORM models.

Vocabulary follows CONTEXT.md: Request, Work item stages, Gates, progress_event
(ADR 0008: one append-only two-axis log — request axis + subject/app axis).
"""
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TZDateTime(TypeDecorator[datetime]):
    """Store datetimes as naive UTC and always return aware UTC values."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("TZDateTime requires a timezone-aware datetime")
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


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
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)


class OperatorAppMute(Base):
    """An explicit opt-out; no row means the operator follows the app."""

    __tablename__ = "operator_app_mutes"

    operator_id: Mapped[int] = mapped_column(
        ForeignKey("operators.id", ondelete="CASCADE"), primary_key=True
    )
    app_id: Mapped[int] = mapped_column(
        ForeignKey("apps.id", ondelete="CASCADE"), primary_key=True
    )


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
    stage_entered_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, onupdate=utcnow)

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
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

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
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"))
    author: Mapped[str] = mapped_column(String(80))
    initials: Mapped[str] = mapped_column(String(4))
    color: Mapped[str] = mapped_column(String(12), default="#6E5A8A")
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

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
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    request: Mapped["Request"] = relationship(back_populates="attachments")


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"))
    operator_id: Mapped[int | None] = mapped_column(ForeignKey("operators.id"), nullable=True)
    actor: Mapped[str] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(40))  # submitted | approved | sent_back | cancelled | responded | commented
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)


class LeaderEpoch(Base):
    """Single-row fencing counter (spec §3.2).

    Writes that go through transitions.cas_status are guarded by
    ``AND epoch = :mine``. Pipeline state changes are wired through cas_status
    in Plan B (Job execution).
    """

    __tablename__ = "leader_epochs"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)  # always 1
    epoch: Mapped[int] = mapped_column(nullable=False, default=0)


class Intent(Base):
    """Intent log for external side effects (spec §3.3). Written in the SAME
    transaction as the state change that implies the effect; completed after
    the external call returns. Recovery (a startup scan replaying pending rows
    idempotently) lands with the Plan B orchestrator; open_intents() is the
    query it will use.
    """

    __tablename__ = "intents"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)  # idempotency key
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    request_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")  # pending|done|failed
    outcome_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)


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
    stage: Mapped[str] = mapped_column(String(16))  # architecture | red | green | review
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    role: Mapped[str] = mapped_column(String(8))  # stage | gate
    job_name: Mapped[str] = mapped_column(String(63), index=True)
    epoch: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(12), default="running")
    # running | succeeded | failed | timed_out | infra | reaped
    envelope: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    logs_tail: Mapped[str | None] = mapped_column(Text, nullable=True)
    deadline_at: Mapped[datetime] = mapped_column(TZDateTime())
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)


def job_name(ref: str, stage: str, attempt: int, gate: bool = False) -> str:
    """Return the stable Kubernetes Job name used to re-attach after restart."""
    suffix = "-gate" if gate else ""
    return f"sf-{ref.lower()}-{stage.lower()}-{attempt}{suffix}"
