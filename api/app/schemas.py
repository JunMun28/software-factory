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
    type: Literal["bug", "enh", "new", "other"]
    title: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=5000)
    app_id: int | None = None
    new_app_name: str | None = Field(default=None, max_length=120)
    bug_where: str | None = Field(default=None, max_length=200)
    urgency: Literal["low", "normal", "high"] = "normal"
    reporter: str = Field(default="Jordan D.", max_length=80)
    reporter_initials: str = Field(default="JD", max_length=4)


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


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    author: str = Field(default="Kim P.", max_length=80)
    initials: str = Field(default="KP", max_length=4)
    color: str = Field(default="#6E5A8A", max_length=12)


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
