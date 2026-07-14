"""Pydantic response/request shapes for the web app."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AppOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    key: str
    name: str
    owner: str
    repo: str
    provisioning: str
    muted: bool
    open_requests: int = 0
    unread: bool = False


class AppIn(BaseModel):
    name: str
    owner: str = ""
    repo: str = ""
    provisioning: str = "Manual"
    muted: bool = False


class OperatorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    initials: str
    hue: str
    email: str
    created_at: datetime


class OperatorIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    initials: str = Field(min_length=1, max_length=4)
    hue: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")
    email: str = Field(min_length=3, max_length=200)


class AppSubscriptionOut(BaseModel):
    app_id: int
    key: str
    name: str
    subscribed: bool


class AppSubscriptionIn(BaseModel):
    subscribed: bool


class ConflictOut(BaseModel):
    detail: str
    acted_by: str
    acted_at: datetime
    resulting_state: str


class TurnOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    order: int
    question: str
    sub: str | None = None
    options: list | None = None
    answer: str | None = None
    skipped: bool


class SpecLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    text: str
    prov: str | None = None
    assume: bool


class CommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    author: str
    initials: str
    color: str
    body: str
    created_at: datetime


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    actor: str
    action: str
    note: str | None = None
    created_at: datetime


class RunStateOut(BaseModel):
    """Derived run-state for an in-flight build (spec §5 — never stored)."""
    step: int
    of: int
    label: str | None = None
    health: Literal["healthy", "slow", "no_signal"]
    seconds_since_event: int


class SteerStateOut(BaseModel):
    """Latest steer note state, derived from append-only progress events."""
    state: Literal["queued", "heard"]
    note: str
    at_step: int | None = None
    acked_at: datetime | None = None


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


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    filename: str
    mime: str
    kind: str
    size: int
    source: str
    created_at: datetime


class RequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ref: str
    title: str
    description: str
    type: str
    urgency: str
    reach: str | None
    impact_metric: str | None
    impact_value: str | None
    bug_where: str | None = None
    priority: str
    app_id: int | None
    app_name: str
    app_key: str | None = None
    repo: str | None = None
    # the repo Approve WILL create (app-less requests only) — server-derived
    # so the confirm dialog and the gate event can never disagree
    prospective_repo: str | None = None
    new_app_name: str | None
    stage: str
    status: str
    gate: str | None
    needs_human: bool
    needs_human_reason: str | None
    reporter: str
    reporter_initials: str
    labels: list | None
    send_back_question: str | None
    send_back_response: str | None
    send_back_rounds: int
    repo_ready: bool
    spec_pr_open: bool
    stage2_fired: bool
    spec_open_note: str | None
    created_at: datetime
    updated_at: datetime
    stage_entered_at: datetime | None = None
    last_event: str | None = None


class RequestDetail(RequestOut):
    turns: list[TurnOut] = []
    spec_lines: list[SpecLineOut] = []
    comments: list[CommentOut] = []
    audit: list[AuditOut] = []
    attachments: list[AttachmentOut] = []
    duplicate: dict | None = None
    run: RunStateOut | None = None
    evidence: EvidenceOut | None = None
    # Prototype step (new-app only) — the current mock + status, so Review renders it inline.
    prototype_html: str | None = None
    prototype_status: str = "none"


class MissionGate(BaseModel):
    request: RequestOut
    evidence: EvidenceOut | None = None  # None → UI shows "no evidence recorded"


class MissionRun(BaseModel):
    request: RequestOut
    run: RunStateOut
    steer: SteerStateOut | None = None


class MissionHumanOwned(BaseModel):
    request: RequestOut
    taken_over_by: str
    taken_over_at: datetime


class MissionRecent(BaseModel):
    request: RequestOut
    outcome: str
    decided_by: str
    decided_at: datetime


class MissionOut(BaseModel):
    """One poll for the Mission control home (spec §6)."""
    gates: list[MissionGate]
    runs: list[MissionRun]
    stalled: list[RequestOut]
    human_owned: list[MissionHumanOwned]
    recent: list[MissionRecent]
    cursor: int


class RequestCreate(BaseModel):
    type: Literal["bug", "enh", "new", "other"]
    title: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=5000)
    app_id: int | None = None
    new_app_name: str | None = Field(default=None, max_length=120)
    bug_where: str | None = Field(default=None, max_length=200)
    urgency: Literal["low", "normal", "high"] = "normal"
    reach: str | None = Field(default=None, max_length=120)  # me|team|dept|wider or free text
    impact_metric: Literal["hours", "cost", "other"] | None = None
    impact_value: str | None = Field(default=None, max_length=120)
    reporter: str = Field(default="Jordan D.", max_length=80)
    reporter_initials: str = Field(default="JD", max_length=4)


class ClassifyIn(BaseModel):
    description: str = Field(default="", max_length=5000)


class ClassifyOut(BaseModel):
    type: Literal["bug", "enh", "new", "other"]
    confidence: float


class RequestUpdate(BaseModel):
    """PATCH semantics for real: only fields the caller sent are applied."""
    type: Literal["bug", "enh", "new", "other"] | None = None
    title: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    app_id: int | None = None
    new_app_name: str | None = Field(default=None, max_length=120)
    bug_where: str | None = Field(default=None, max_length=200)
    urgency: Literal["low", "normal", "high"] | None = None
    reach: str | None = Field(default=None, max_length=120)
    impact_metric: Literal["hours", "cost", "other"] | None = None
    impact_value: str | None = Field(default=None, max_length=120)


class InterviewAnswer(BaseModel):
    answer: str | None = Field(default=None, max_length=2000)
    skip: bool = False


class EscalateIn(BaseModel):
    """Consent on a mid-interview type-change proposal (ADR 0023)."""
    accept: bool
    to_type: Literal["bug", "enh", "new", "other"]


class InterviewState(BaseModel):
    done: bool
    asked: int
    total: int
    thinking: bool = False  # the next question is generating in the background — poll until ready
    question: str | None = None
    sub: str | None = None
    options: list | None = None
    final: bool = False
    turns: list[TurnOut] = []
    escalation: dict | None = None  # {"to_type": str, "why": str} — a proposed type change (ADR 0023)


class SpecSection(BaseModel):
    """One section of the structured Review spec — a titled group of bullet points."""
    title: str
    items: list[str] = []


class ReviewSummary(BaseModel):
    """The AI-written Review-step spec: a plain-language overview plus structured sections
    (who it's for, features/scope, how it works, constraints, success measure). `thinking`
    → still generating; poll until it lands."""
    overview: str | None = None
    sections: list[SpecSection] = []
    thinking: bool = False


class PrototypeTurnOut(BaseModel):
    """One prototype exchange for the chat thread (the html itself rides on PrototypeState).
    `revision` → this turn produced a document (so the client can offer undo to it)."""
    order: int
    instruction: str | None = None
    annotation: dict | list | None = None
    mode: str
    note: str | None = None
    revision: bool = False


class PrototypeState(BaseModel):
    """The Prototype step's live state: the current document + the chat thread. `thinking`
    → a revision is generating in the background; poll or open the stream."""
    html: str | None = None
    status: str = "none"  # none | draft | edited | skipped
    thinking: bool = False
    turns: list[PrototypeTurnOut] = []


class PrototypeInstruction(BaseModel):
    """A chat turn on the Prototype step: an edit instruction, optionally scoped to one or
    more annotated elements the user pointed at (a list when multi-selected)."""
    instruction: str = Field(default="", max_length=2000)
    annotation: dict | list | None = None

    @field_validator("annotation")
    @classmethod
    def _bound_annotation(cls, v):
        """Bound the point-to-edit selection so a direct POST can't bloat the prompt or the stored
        JSON: at most 20 elements, only known keys, each string field truncated."""
        def clean(a):
            if not isinstance(a, dict):
                return None
            out: dict = {}
            for k in ("pid", "selector", "tag", "textSnippet", "outerHTML"):
                if a.get(k) is not None:
                    out[k] = str(a[k])[:800]
            if isinstance(a.get("rect"), dict):
                out["rect"] = a["rect"]
            return out or None
        if isinstance(v, list):
            return [c for a in v[:20] if (c := clean(a))]
        if isinstance(v, dict):
            return clean(v)
        return None


class PrototypeRestore(BaseModel):
    """Undo/restore: re-apply the document from the revision at `order` as a new latest revision."""
    order: int


class Note(BaseModel):
    note: str = Field(default="", max_length=4000)
    actor: str = Field(default="Kim P.", max_length=80)


class OperatorNote(BaseModel):
    operator_id: int
    note: str = Field(default="", max_length=4000)


class SendBackToStageIn(BaseModel):
    operator_id: int
    stage: str = Field(min_length=1, max_length=16)
    reason: str = Field(min_length=1, max_length=4000)


class SteerIn(BaseModel):
    """A mid-run course-correction note (spec §5): consumed by the runner at
    the next step boundary."""
    note: str = Field(min_length=1, max_length=1000)
    operator_id: int


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    operator_id: int


class FeedPage(BaseModel):
    items: list["EventOut"]
    cursor: int


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    request_id: int | None
    subject_id: int | None
    kind: str
    stage: str
    actor: str
    bot: bool
    broadcast: bool
    title: str
    body: str | None
    payload: dict | None
    created_at: datetime
    request_ref: str | None = None
    request_title: str | None = None
