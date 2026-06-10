"""Pydantic response/request shapes for the web app."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict


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


class RequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ref: str
    title: str
    description: str
    type: str
    urgency: str
    priority: str
    app_id: int | None
    app_name: str
    app_key: str | None = None
    repo: str | None = None
    new_app_name: str | None
    stage: str
    status: str
    gate: str | None
    needs_human: bool
    needs_human_reason: str | None
    reporter: str
    reporter_initials: str
    assignee: str | None
    assignee_initials: str | None
    assignee_color: str | None
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
    duplicate: dict | None = None


class RequestCreate(BaseModel):
    type: str
    title: str = ""
    description: str = ""
    app_id: int | None = None
    new_app_name: str | None = None
    bug_where: str | None = None
    urgency: str = "normal"
    reporter: str = "Jordan D."
    reporter_initials: str = "JD"


class InterviewAnswer(BaseModel):
    answer: str | None = None
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
    note: str = ""
    actor: str = "Kim P."


class CommentIn(BaseModel):
    body: str
    author: str = "Kim P."
    initials: str = "KP"
    color: str = "#6E5A8A"


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
