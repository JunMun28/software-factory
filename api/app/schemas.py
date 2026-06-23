"""Pydantic response/request shapes for the web app."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


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


class MissionGate(BaseModel):
    request: RequestOut
    evidence: EvidenceOut | None = None  # None → UI shows "no evidence recorded"


class MissionRun(BaseModel):
    request: RequestOut
    run: RunStateOut


class MissionOut(BaseModel):
    """One poll for the Mission control home (spec §6)."""
    gates: list[MissionGate]
    runs: list[MissionRun]
    stalled: list[RequestOut]
    recent: list[RequestOut]
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


class InterviewState(BaseModel):
    done: bool
    asked: int
    total: int
    question: str | None = None
    sub: str | None = None
    options: list | None = None
    final: bool = False
    turns: list[TurnOut] = []


class Note(BaseModel):
    note: str = Field(default="", max_length=4000)
    actor: str = Field(default="Kim P.", max_length=80)


class SteerIn(BaseModel):
    """A mid-run course-correction note (spec §5): consumed by the runner at
    the next step boundary."""
    note: str = Field(min_length=1, max_length=1000)
    actor: str = Field(default="Kim P.", max_length=80)


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    author: str = Field(default="Kim P.", max_length=80)
    initials: str = Field(default="KP", max_length=4)
    color: str = Field(default="#6E5A8A", max_length=12)


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
