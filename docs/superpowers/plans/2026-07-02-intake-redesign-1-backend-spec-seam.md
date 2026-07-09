# Intake Redesign Backend Spec Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move draft-spec generation and review corrections into the pre-submit intake backend so the Check step shows the real grounded spec before a request is sent to a reviewer.

**Architecture:** Keep the existing FastAPI router and SQLAlchemy model shape; add small helpers around draft-spec generation so it runs at interview completion or the review endpoint and never rewrites existing spec lines. Assumption confirmation/correction mutates `spec_lines` only before submit, using provenance strings rather than a schema migration. The progress event log remains append-only and is only appended when the request is finally submitted into the existing spec gate.

**Tech Stack:** FastAPI, Pydantic v2, SQLAlchemy 2 ORM, SQLite WAL, pytest via `uv run pytest`.

## Global Constraints

- All changes live in `api/app/`; the progress_event log stays append-only (ADR 0008) and nothing here scales workers or touches the tick loop.
- Out of scope: email/notification infrastructure (decision 5), pipeline changes, admin console.
- Never UPDATE or DELETE progress_event rows.
- Single uvicorn worker assumptions must hold.
- Tests via the repo's existing pytest setup.

### Task 1: Expose Review Contract Fields And Persist Extra Details

**Files:**
- Modify: `api/app/schemas.py:39-44`, `api/app/schemas.py:100-139`, `api/app/schemas.py:186-198`
- Test: `api/tests/test_intake_redesign_backend.py`

**Interfaces:**
- Consumes: existing `PATCH /api/requests/{rid}` with `RequestUpdate`
- Produces:
  - `RequestDetail.extra_detail: str | null`
  - `RequestUpdate.extra_detail: str | null`
  - `SpecLineOut.id: int`
  - `SpecLineOut.order: int`
  - existing `SpecLineOut.text: str`, `SpecLineOut.prov: str | null`, `SpecLineOut.assume: bool`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_intake_redesign_backend.py` with this complete test code:

```python
from helpers import new_request

from app.db import SessionLocal
from app.models import Request, SpecLine


def test_patch_persists_extra_detail_and_spec_lines_have_stable_ids(client):
    r = new_request(client, title="Review contract probe", description="The review page needs saved notes.")

    patched = client.patch(
        f"/api/requests/{r['id']}",
        json={"extra_detail": "Please keep the first release small."},
    ).json()
    assert patched["id"] == r["id"]
    assert patched["extra_detail"] == "Please keep the first release small."

    with SessionLocal() as db:
        req = db.get(Request, r["id"])
        db.add(SpecLine(request=req, order=0, text="Review page has a stable line.", prov="request", assume=False))
        db.commit()

    detail = client.get(f"/api/requests/{r['id']}").json()

    assert detail["extra_detail"] == "Please keep the first release small."
    assert detail["spec_lines"], detail
    first = detail["spec_lines"][0]
    assert isinstance(first["id"], int)
    assert isinstance(first["order"], int)
    assert isinstance(first["text"], str)
    assert "prov" in first
    assert isinstance(first["assume"], bool)
```

- [ ] **Step 2: Run it**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_patch_persists_extra_detail_and_spec_lines_have_stable_ids -q`

Expected: FAIL with a response/body assertion showing `extra_detail` is missing from the JSON, or `id` is missing from a `spec_lines` item.

- [ ] **Step 3: Minimal implementation**

Modify `api/app/schemas.py` with these complete class definitions:

```python
class SpecLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    order: int
    text: str
    prov: str | None = None
    assume: bool
```

```python
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
    extra_detail: str | None
    priority: str
    app_id: int | None
    app_name: str
    app_key: str | None = None
    repo: str | None = None
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
```

```python
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
    extra_detail: str | None = Field(default=None, max_length=4000)
```

- [ ] **Step 4: Run again**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_patch_persists_extra_detail_and_spec_lines_have_stable_ids -q`

Expected: PASS with `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add api/app/schemas.py api/tests/test_intake_redesign_backend.py
git commit -m "feat(api): expose review contract fields"
```

### Task 2: Draft Spec Before Submit And Add The Review Endpoint

**Files:**
- Modify: `api/app/routers/requests.py:18-34`, `api/app/routers/requests.py:40-62`, `api/app/routers/requests.py:92-115`, `api/app/routers/requests.py:156-174`, `api/app/routers/requests.py:179-224`
- Test: `api/tests/test_intake_redesign_backend.py`

**Interfaces:**
- Consumes:
  - `get_brain().draft_spec(r) -> tuple[list[SpecLine], str]`
  - `to_out(r, RequestDetail)`
- Produces:
  - helper `_draft_spec_once(db: Session, r: Request) -> bool`
  - `GET /api/requests/{rid}/review -> RequestDetail`
  - `POST /api/requests/{rid}/submit -> RequestDetail`, now requiring existing `spec_lines`
  - `RequestDetail.spec_lines: list[SpecLineOut]` returned by the review endpoint

- [ ] **Step 1: Write the failing test**

Append this complete test code to `api/tests/test_intake_redesign_backend.py`:

```python
class CountingBrain:
    def __init__(self):
        self.draft_calls = 0

    def next_question(self, req):
        return None

    def draft_spec(self, req):
        self.draft_calls += 1
        return (
            [
                SpecLine(request=req, order=0, text=f"Deliver: {req.title}.", prov="request", assume=False),
                SpecLine(request=req, order=1, text="Scope is limited to the current app.", prov=None, assume=True),
            ],
            "1 assumption needs confirming before approval.",
        )


def test_review_endpoint_lazily_drafts_once_and_submit_reuses_existing_spec(client, monkeypatch):
    import app.routers.requests as requests_router

    brain = CountingBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    r = new_request(client, title="Lazy review draft", description="Create the spec before submit.")

    early_submit = client.post(f"/api/requests/{r['id']}/submit", json={})
    assert early_submit.status_code == 409
    assert "Review the draft spec before submitting" in early_submit.text

    review = client.get(f"/api/requests/{r['id']}/review").json()
    assert [line["text"] for line in review["spec_lines"]] == [
        "Deliver: Lazy review draft.",
        "Scope is limited to the current app.",
    ]
    assert brain.draft_calls == 1

    review_again = client.get(f"/api/requests/{r['id']}/review").json()
    assert [line["id"] for line in review_again["spec_lines"]] == [line["id"] for line in review["spec_lines"]]
    assert brain.draft_calls == 1

    submitted = client.post(f"/api/requests/{r['id']}/submit", json={}).json()
    assert submitted["status"] == "pending_approval"
    assert submitted["gate"] == "approve_spec"
    assert brain.draft_calls == 1


def test_interview_completion_drafts_spec_once(client, monkeypatch):
    import app.routers.requests as requests_router

    brain = CountingBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    r = new_request(client, title="Done interview draft", description="The interview has no questions.")

    state = client.get(f"/api/requests/{r['id']}/interview").json()
    assert state["done"] is True
    assert brain.draft_calls == 1

    review = client.get(f"/api/requests/{r['id']}/review").json()
    assert review["spec_lines"]
    assert brain.draft_calls == 1
```

- [ ] **Step 2: Run it**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_review_endpoint_lazily_drafts_once_and_submit_reuses_existing_spec tests/test_intake_redesign_backend.py::test_interview_completion_drafts_spec_once -q`

Expected: FAIL with `404` for `/api/requests/{rid}/review`, or FAIL because `POST /submit` still drafts when no review spec exists.

- [ ] **Step 3: Minimal implementation**

Modify `api/app/routers/requests.py` imports:

```python
from ..models import AuditEvent, InterviewTurn, ProgressEvent, Request, SpecLine, utcnow
```

Add these helper functions below `router = APIRouter()`:

```python
def _assumption_note(r: Request) -> str:
    n_assume = sum(1 for line in r.spec_lines if line.assume)
    if n_assume == 0:
        return "All assumptions confirmed by the submitter."
    return f"{n_assume} assumption{'s need' if n_assume > 1 else ' needs'} confirming before approval."


def _draft_spec_once(db: Session, r: Request) -> bool:
    """Draft the submitter-visible spec once. Existing spec lines are never rewritten."""
    if r.spec_lines:
        return False
    lines, note = get_brain().draft_spec(r)
    db.add_all(lines)
    r.spec_open_note = note
    db.commit()
    db.refresh(r)
    return True


def _detail(db: Session, r: Request) -> RequestDetail:
    d = to_out(r, RequestDetail)
    d.audit = [a for a in db.query(AuditEvent).filter(AuditEvent.request_id == r.id).order_by(AuditEvent.created_at).all()]
    rs = run_state(db, r)
    d.run = RunStateOut(**rs) if rs is not None else None
    ev = evidence(db, r)
    d.evidence = EvidenceOut(**ev) if ev is not None else None
    if r.app_id and r.status in ("draft", "submitted", "pending_approval", "sent_back"):
        words = {w.lower().strip(",.") for w in r.title.split() if len(w) > 4}
        recent = (
            db.query(Request)
            .filter(Request.app_id == r.app_id, Request.id != r.id, Request.status != "cancelled")
            .order_by(Request.id.desc())
            .limit(200)
            .all()
        )
        for other in recent:
            ow = {w.lower().strip(",.") for w in other.title.split() if len(w) > 4}
            if words & ow:
                d.duplicate = {"ref": other.ref, "title": other.title, "id": other.id}
                break
    return d
```

Replace `request_detail` with:

```python
@router.get("/api/requests/{rid}", response_model=RequestDetail)
def request_detail(rid: int, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    return _detail(db, r)
```

Add the review endpoint immediately after `request_detail`:

```python
@router.get("/api/requests/{rid}/review", response_model=RequestDetail)
def review_request(rid: int, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in ("draft", "submitted"):
        return _detail(db, r)
    _draft_spec_once(db, r)
    return _detail(db, r)
```

Replace `get_interview` with:

```python
@router.get("/api/requests/{rid}/interview", response_model=InterviewState)
def get_interview(rid: int, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    st = interview_state(db, r)
    if st.done and r.status in ("draft", "submitted"):
        _draft_spec_once(db, r)
    return st
```

Replace the end of `answer_interview` from `db.commit()` through the return with:

```python
    db.commit()
    db.refresh(r)
    st = interview_state(db, r)
    if st.done and r.status in ("draft", "submitted"):
        _draft_spec_once(db, r)
        st = interview_state(db, r)
    return st
```

Replace `submit` with:

```python
@router.post("/api/requests/{rid}/submit", response_model=RequestDetail)
def submit(rid: int, extra: Note | None = None, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in ("draft", "submitted"):
        return to_out(r, RequestDetail)
    if not r.spec_lines:
        raise HTTPException(409, "Review the draft spec before submitting")
    claimed = db.execute(
        update(Request)
        .where(Request.id == r.id, Request.status.in_(("draft", "submitted")))
        .values(status="pending_approval")
    ).rowcount
    db.commit()
    if not claimed:
        db.refresh(r)
        return to_out(r, RequestDetail)
    try:
        if extra and extra.note:
            r.extra_detail = extra.note
        r.status = "submitted"
        emit(db, r, "milestone_summary", f"New request filed in #{r.app_name}",
             payload={"fields": {"Type": r.type, "From": r.reporter, "Stage": "Triage"},
                      "context": f"Intake interview completed · {len(r.turns)} answers", "Ref": r.ref})
        db.add(AuditEvent(request_id=r.id, actor=r.reporter, action="submitted",
                          note="filed this request and completed intake"))
        r.spec_open_note = _assumption_note(r)
        r.stage = "spec"
        r.status = "pending_approval"
        r.gate = "approve_spec"
        r.stage_entered_at = utcnow()
        assumptions = sum(1 for line in r.spec_lines if line.assume)
        emit(db, r, "gate_event", "Draft spec ready for approval",
             broadcast=True,
             payload={"gate": "approve_spec",
                      "fields": {"Status": "Awaiting approval", "Assumptions": str(assumptions), "Ref": r.ref}})
        db.commit()
    except Exception:
        db.rollback()
        r.status = "draft"
        db.commit()
        raise
    return to_out(r, RequestDetail)
```

- [ ] **Step 4: Run again**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_review_endpoint_lazily_drafts_once_and_submit_reuses_existing_spec tests/test_intake_redesign_backend.py::test_interview_completion_drafts_spec_once -q`

Expected: PASS with `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add api/app/routers/requests.py api/tests/test_intake_redesign_backend.py
git commit -m "feat(api): draft specs before submit"
```

### Task 3: Confirm Or Correct Assumption Lines Before Submit

**Files:**
- Modify: `api/app/schemas.py:216-219`
- Modify: `api/app/routers/requests.py:23-34`, `api/app/routers/requests.py:227`
- Test: `api/tests/test_intake_redesign_backend.py`

**Interfaces:**
- Consumes:
  - `SpecLineOut.id: int`
  - `_assumption_note(r: Request) -> str`
  - `_detail(db: Session, r: Request) -> RequestDetail`
- Produces:
  - `POST /api/requests/{rid}/spec-lines/{line_id}/confirm`
  - Confirm body: `{"actor": str}`
  - Confirm response: `RequestDetail`
  - `POST /api/requests/{rid}/spec-lines/{line_id}/correct`
  - Correct body: `{"actor": str, "text": str}`
  - Correct response: `RequestDetail`
  - Confirmed line: `assume=false`, `prov="submitter-confirmed"`
  - Corrected line: `text=<corrected text ending with period>`, `assume=false`, `prov="submitter-corrected"`

- [ ] **Step 1: Write the failing test**

Append this complete test code to `api/tests/test_intake_redesign_backend.py`:

```python
def _first_assumption(detail):
    return next(line for line in detail["spec_lines"] if line["assume"])


def test_submitter_can_confirm_or_correct_assumptions_before_submit(client):
    r = new_request(client, title="Assumption action probe", description="Needs a reviewable assumption.")
    review = client.get(f"/api/requests/{r['id']}/review").json()
    assumption = _first_assumption(review)

    confirmed = client.post(
        f"/api/requests/{r['id']}/spec-lines/{assumption['id']}/confirm",
        json={"actor": r["reporter"]},
    ).json()
    line = next(line for line in confirmed["spec_lines"] if line["id"] == assumption["id"])
    assert line["assume"] is False
    assert line["prov"] == "submitter-confirmed"

    review = client.get(f"/api/requests/{r['id']}/review").json()
    second = _first_assumption(review)
    corrected = client.post(
        f"/api/requests/{r['id']}/spec-lines/{second['id']}/correct",
        json={"actor": r["reporter"], "text": "Use the existing vendor portal integration"},
    ).json()
    line = next(line for line in corrected["spec_lines"] if line["id"] == second["id"])
    assert line["text"] == "Use the existing vendor portal integration."
    assert line["assume"] is False
    assert line["prov"] == "submitter-corrected"


def test_assumption_actions_are_owner_scoped_and_pre_submit_only(client):
    r = new_request(client, title="Owner scope probe", description="Only the reporter can change assumptions.")
    review = client.get(f"/api/requests/{r['id']}/review").json()
    assumption = _first_assumption(review)

    denied = client.post(
        f"/api/requests/{r['id']}/spec-lines/{assumption['id']}/confirm",
        json={"actor": "Someone Else"},
    )
    assert denied.status_code == 403
    assert "Only the submitter can change this spec line" in denied.text

    client.post(
        f"/api/requests/{r['id']}/spec-lines/{assumption['id']}/confirm",
        json={"actor": r["reporter"]},
    )
    submitted = client.post(f"/api/requests/{r['id']}/submit", json={}).json()
    assert submitted["status"] == "pending_approval"

    too_late = client.post(
        f"/api/requests/{r['id']}/spec-lines/{assumption['id']}/correct",
        json={"actor": r["reporter"], "text": "Change it after submit"},
    )
    assert too_late.status_code == 409
    assert "Spec lines can only be changed before submit" in too_late.text
```

- [ ] **Step 2: Run it**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_submitter_can_confirm_or_correct_assumptions_before_submit tests/test_intake_redesign_backend.py::test_assumption_actions_are_owner_scoped_and_pre_submit_only -q`

Expected: FAIL with `404 Not Found` for `/spec-lines/{line_id}/confirm`.

- [ ] **Step 3: Minimal implementation**

Add these request schemas to `api/app/schemas.py` after `Note`:

```python
class SpecLineConfirmIn(BaseModel):
    actor: str = Field(default="Jordan D.", max_length=80)


class SpecLineCorrectIn(BaseModel):
    actor: str = Field(default="Jordan D.", max_length=80)
    text: str = Field(min_length=1, max_length=500)
```

Add `SpecLineConfirmIn` and `SpecLineCorrectIn` to the `api/app/routers/requests.py` schema imports:

```python
    SpecLineConfirmIn,
    SpecLineCorrectIn,
```

Add these helpers and endpoints before `steer` in `api/app/routers/requests.py`:

```python
def _editable_spec_line(db: Session, r: Request, line_id: int, actor: str) -> SpecLine:
    if r.status != "draft":
        raise HTTPException(409, "Spec lines can only be changed before submit")
    if actor != r.reporter:
        raise HTTPException(403, "Only the submitter can change this spec line")
    line = db.get(SpecLine, line_id)
    if not line or line.request_id != r.id:
        raise HTTPException(404, "Spec line not found")
    return line


def _period(text: str) -> str:
    clean = text.strip()
    if clean.endswith((".", "!", "?")):
        return clean
    return clean + "."


@router.post("/api/requests/{rid}/spec-lines/{line_id}/confirm", response_model=RequestDetail)
def confirm_spec_line(rid: int, line_id: int, body: SpecLineConfirmIn, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    line = _editable_spec_line(db, r, line_id, body.actor)
    line.assume = False
    line.prov = "submitter-confirmed"
    r.spec_open_note = _assumption_note(r)
    db.commit()
    db.refresh(r)
    return _detail(db, r)


@router.post("/api/requests/{rid}/spec-lines/{line_id}/correct", response_model=RequestDetail)
def correct_spec_line(rid: int, line_id: int, body: SpecLineCorrectIn, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    line = _editable_spec_line(db, r, line_id, body.actor)
    line.text = _period(body.text)
    line.assume = False
    line.prov = "submitter-corrected"
    r.spec_open_note = _assumption_note(r)
    db.commit()
    db.refresh(r)
    return _detail(db, r)
```

- [ ] **Step 4: Run again**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_submitter_can_confirm_or_correct_assumptions_before_submit tests/test_intake_redesign_backend.py::test_assumption_actions_are_owner_scoped_and_pre_submit_only -q`

Expected: PASS with `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add api/app/schemas.py api/app/routers/requests.py api/tests/test_intake_redesign_backend.py
git commit -m "feat(api): let submitters resolve assumptions"
```

### Task 4: Add Skip Consequence And Honest Remaining Estimate To Interview Payloads

**Files:**
- Modify: `api/app/interview.py:38-47`, `api/app/interview.py:50-111`
- Modify: `api/app/routers/requests.py:42-62`
- Modify: `api/app/schemas.py:205-214`
- Test: `api/tests/test_intake_redesign_backend.py`

**Interfaces:**
- Consumes:
  - `Question.question: str`
  - `Question.sub: str | None`
  - `Question.options: list[dict] | None`
  - `Question.final: bool`
- Produces:
  - `Question.skip_assumption: str`
  - `InterviewState.skip_assumption: str | None`
  - `InterviewState.remaining_estimate: int`
  - persisted `Request.pending_question["skip_assumption"]`

- [ ] **Step 1: Write the failing test**

Append this complete test code to `api/tests/test_intake_redesign_backend.py`:

```python
def test_interview_question_includes_skip_assumption_and_remaining_estimate(client):
    r = new_request(client, title="Question payload probe", description="Make a workflow easier.")

    st = client.get(f"/api/requests/{r['id']}/interview").json()
    assert st["done"] is False
    assert isinstance(st["skip_assumption"], str)
    assert "assume" in st["skip_assumption"].lower() or "reviewer" in st["skip_assumption"].lower()
    assert st["remaining_estimate"] == 2

    st = client.post(f"/api/requests/{r['id']}/interview", json={"answer": "It saves a weekly handoff."}).json()
    assert st["done"] is False
    assert st["remaining_estimate"] == 1
```

- [ ] **Step 2: Run it**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_interview_question_includes_skip_assumption_and_remaining_estimate -q`

Expected: FAIL with a missing `skip_assumption` key or missing `remaining_estimate` key.

- [ ] **Step 3: Minimal implementation**

Replace `Question` and `_q` in `api/app/interview.py` with:

```python
@dataclass
class Question:
    question: str
    sub: str | None = None
    options: list[dict] | None = None
    final: bool = field(default=False)
    skip_assumption: str = "we'll assume the reviewer can fill this in from your request"


def _q(question, sub=None, options=None, final=False, skip_assumption=None) -> Question:
    return Question(
        question=question,
        sub=sub,
        options=options,
        final=final,
        skip_assumption=skip_assumption or "we'll assume the reviewer can fill this in from your request",
    )
```

Update every `SCRIPTS` question to pass a plain-language skip consequence. Use this complete `SCRIPTS` block for now; Task 5 refines the wording and spec-line phrasing:

```python
SCRIPTS: dict[str, list[Question]] = {
    "enh": [
        _q(
            "In a sentence, what's slow or painful about this today?",
            skip_assumption="we'll assume the current workflow is slow but still usable",
        ),
        _q(
            "Got it. How many items do you usually handle in one go?",
            options=[
                {"t": "A handful", "d": "Under 10 at a time — one-off lookups."},
                {"t": "A few dozen", "d": "A typical week's worth."},
                {"t": "A few hundred", "d": "A full month in one export."},
                {"t": "Thousands or more", "d": "Large batches where performance matters."},
            ],
            skip_assumption="we'll assume the usual volume is small",
        ),
        _q(
            "Last thing — anything we should be careful not to break?",
            sub="Totally fine to skip if nothing comes to mind.",
            final=True,
            skip_assumption="we'll assume there are no special workflows to protect",
        ),
    ],
    "bug": [
        _q(
            "What did you expect to happen instead?",
            skip_assumption="we'll assume the expected behavior is the normal app behavior",
        ),
        _q(
            "How often does it happen?",
            options=[
                {"t": "Every time", "d": "Reliably reproducible."},
                {"t": "Most of the time", "d": "More often than not."},
                {"t": "Sometimes", "d": "Intermittent — hard to pin down."},
                {"t": "Only once so far", "d": "Seen it a single time."},
            ],
            skip_assumption="we'll assume it is intermittent",
        ),
        _q(
            "Last thing — anything that seems to make it better or worse?",
            sub="Totally fine to skip if nothing comes to mind.",
            final=True,
            skip_assumption="we'll assume there is no known workaround",
        ),
    ],
    "new": [
        _q(
            "Who will use this day-to-day, and for what?",
            skip_assumption="we'll assume the first users are the submitter's immediate team",
        ),
        _q(
            "Last thing — what single outcome would make this a clear win?",
            sub="One sentence is plenty.",
            final=True,
            skip_assumption="we'll assume the main win is reducing manual work",
        ),
    ],
    "other": [
        _q(
            "Tell us a bit more about what's prompting this.",
            skip_assumption="we'll assume this is a general improvement request",
        ),
        _q(
            "How urgent does it feel?",
            options=[
                {"t": "Blocking me now", "d": "I can't get my work done."},
                {"t": "This week", "d": "Needed soon, not this minute."},
                {"t": "This quarter", "d": "Important, not urgent."},
                {"t": "Whenever", "d": "Nice to have."},
            ],
            skip_assumption="we'll assume it is normal priority",
        ),
        _q(
            "Last thing — anything else we should know?",
            sub="Totally fine to skip.",
            final=True,
            skip_assumption="we'll assume there are no extra constraints",
        ),
    ],
}
```

Replace `current_question` and `interview_state` in `api/app/routers/requests.py` with:

```python
def current_question(db: Session, r: Request):
    """Generate-once semantics: the pending question is persisted so what the
    submitter sees is exactly what gets recorded with their answer."""
    if answered_count(r) >= MAX_QUESTIONS:
        return None
    if r.pending_question:
        return Question(**r.pending_question)
    q = get_brain().next_question(r)
    if q:
        r.pending_question = {
            "question": q.question,
            "sub": q.sub,
            "options": q.options,
            "final": q.final,
            "skip_assumption": q.skip_assumption,
        }
        db.commit()
    return q


def interview_state(db: Session, r: Request) -> InterviewState:
    q = current_question(db, r)
    asked = answered_count(r)
    st = InterviewState(done=q is None, asked=asked, total=MAX_QUESTIONS, turns=[t for t in r.turns])
    if q:
        st.question = q.question
        st.sub = q.sub
        st.options = q.options
        st.final = q.final
        st.skip_assumption = q.skip_assumption
        st.remaining_estimate = max(0, MAX_QUESTIONS - asked - 1)
    return st
```

Replace `InterviewState` in `api/app/schemas.py` with:

```python
class InterviewState(BaseModel):
    done: bool
    asked: int
    total: int
    question: str | None = None
    sub: str | None = None
    options: list | None = None
    final: bool = False
    skip_assumption: str | None = None
    remaining_estimate: int = 0
    turns: list[TurnOut] = []
```

- [ ] **Step 4: Run again**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_interview_question_includes_skip_assumption_and_remaining_estimate -q`

Expected: PASS with `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add api/app/interview.py api/app/routers/requests.py api/app/schemas.py api/tests/test_intake_redesign_backend.py
git commit -m "feat(api): add interview skip consequences"
```

### Task 5: Make Scripted Interview Neutral And Ground Option Answers With Question Context

**Files:**
- Modify: `api/app/interview.py:50-171`
- Modify: `api/app/agent_brain.py:18-38`, `api/app/agent_brain.py:64-83`, `api/app/agent_brain.py:86-95`
- Test: `api/tests/test_intake_redesign_backend.py`

**Interfaces:**
- Consumes:
  - `Request.type`, `Request.app_name`, `Request.title`, `Request.description`, `Request.bug_where`, `Request.reach`, `Request.impact_metric`, `Request.impact_value`, `Request.urgency`
  - `InterviewTurn.question`, `InterviewTurn.answer`, `InterviewTurn.skipped`
  - `Question.skip_assumption`
- Produces:
  - neutral scripted reach/urgency questions
  - `_answer_line(turn: InterviewTurn) -> str`
  - `AgentBrain._context(req)` including all form fields
  - Agent JSON support for `skip_assumption`

- [ ] **Step 1: Write the failing test**

Append this complete test code to `api/tests/test_intake_redesign_backend.py`:

```python
def test_scripted_interview_asks_neutral_reach_and_urgency_questions(client):
    r = new_request(client, title="Neutral interview probe", description="Improve the handoff notes.")

    questions = []
    st = client.get(f"/api/requests/{r['id']}/interview").json()
    while not st["done"]:
        questions.append(st["question"])
        answer = "My team" if "who" in st["question"].lower() else "This quarter"
        st = client.post(f"/api/requests/{r['id']}/interview", json={"answer": answer}).json()

    text = "\n".join(questions).lower()
    assert "how many items" not in text
    assert "export" not in text
    assert any("who would notice" in q.lower() or "who is affected" in q.lower() for q in questions)
    assert any("how soon" in q.lower() or "when would" in q.lower() for q in questions)


def test_option_answers_become_contextual_spec_lines_not_bare_labels(client):
    r = new_request(client, title="Contextual option probe", description="Improve the handoff notes.")
    st = client.get(f"/api/requests/{r['id']}/interview").json()
    while not st["done"]:
        answer = "My team" if "who" in st["question"].lower() else "This quarter"
        st = client.post(f"/api/requests/{r['id']}/interview", json={"answer": answer}).json()

    review = client.get(f"/api/requests/{r['id']}/review").json()
    texts = [line["text"] for line in review["spec_lines"]]
    assert "My team." not in texts
    assert "This quarter." not in texts
    assert any(line.startswith("Reach: My team") for line in texts)
    assert any(line.startswith("Urgency: This quarter") for line in texts)


def test_agent_brain_context_includes_form_fields():
    from app.agent_brain import _context
    from app.models import Request

    req = Request(
        title="Context probe",
        description="Existing form details should be visible.",
        type="enh",
        urgency="high",
        reach="dept",
        impact_metric="hours",
        impact_value="1200",
        new_app_name="Planning board",
        bug_where="",
    )
    body = _context(req)
    assert "Request type: enhancement" in body
    assert "App: Planning board" in body
    assert "Title: Context probe" in body
    assert "Description: Existing form details should be visible." in body
    assert "Urgency: high" in body
    assert "Reach: dept" in body
    assert "Impact estimate: hours = 1200" in body
```

- [ ] **Step 2: Run it**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_scripted_interview_asks_neutral_reach_and_urgency_questions tests/test_intake_redesign_backend.py::test_option_answers_become_contextual_spec_lines_not_bare_labels tests/test_intake_redesign_backend.py::test_agent_brain_context_includes_form_fields -q`

Expected: FAIL because the scripted enhancement question still asks "How many items..." or because spec lines include bare option labels.

- [ ] **Step 3: Minimal implementation**

Replace the complete `SCRIPTS` block in `api/app/interview.py` with:

```python
SCRIPTS: dict[str, list[Question]] = {
    "enh": [
        _q(
            "What would this improvement help you do day to day?",
            sub="One sentence is enough.",
            skip_assumption="we'll assume the goal is to make the current workflow easier",
        ),
        _q(
            "Who would notice the improvement?",
            options=[
                {"t": "Just me", "d": "Mostly affects your own work."},
                {"t": "My team", "d": "A small group uses or feels this workflow."},
                {"t": "My department", "d": "A wider local group depends on it."},
                {"t": "Multiple teams", "d": "People in different groups would notice."},
            ],
            skip_assumption="we'll assume this mainly affects the submitter",
        ),
        _q(
            "How soon would this matter?",
            options=[
                {"t": "Blocking today", "d": "Work is stuck until this improves."},
                {"t": "This week", "d": "Soon, but there is a workaround."},
                {"t": "This quarter", "d": "Useful to plan into normal work."},
                {"t": "Nice to have", "d": "Helpful, not urgent."},
            ],
            final=True,
            skip_assumption="we'll assume this can wait for normal prioritization",
        ),
    ],
    "bug": [
        _q(
            "What did you expect to happen instead?",
            skip_assumption="we'll assume the expected behavior is the normal app behavior",
        ),
        _q(
            "What helps us reproduce it?",
            options=[
                {"t": "Every time", "d": "It happens whenever I try the same action."},
                {"t": "Often", "d": "It happens more often than not."},
                {"t": "Sometimes", "d": "It comes and goes."},
                {"t": "Saw it once", "d": "Only one confirmed occurrence so far."},
            ],
            skip_assumption="we'll assume it is intermittent",
        ),
        _q(
            "How soon does this need attention?",
            options=[
                {"t": "Blocking today", "d": "Work is stuck until this is fixed."},
                {"t": "This week", "d": "Soon, but there is a workaround."},
                {"t": "This quarter", "d": "Important, not urgent."},
                {"t": "Nice to have", "d": "Can wait for normal prioritization."},
            ],
            final=True,
            skip_assumption="we'll assume this can wait for normal prioritization",
        ),
    ],
    "new": [
        _q(
            "Who will use this day to day, and for what?",
            skip_assumption="we'll assume the first users are the submitter's immediate team",
        ),
        _q(
            "What single outcome would make this worth building?",
            sub="One sentence is plenty.",
            skip_assumption="we'll assume the main win is reducing manual work",
        ),
        _q(
            "How soon would this matter?",
            options=[
                {"t": "Blocking today", "d": "Work is stuck until this exists."},
                {"t": "This week", "d": "Needed soon, not this minute."},
                {"t": "This quarter", "d": "Useful to plan into normal work."},
                {"t": "Nice to have", "d": "Helpful, not urgent."},
            ],
            final=True,
            skip_assumption="we'll assume this can wait for normal prioritization",
        ),
    ],
    "other": [
        _q(
            "Tell us a bit more about what's prompting this.",
            skip_assumption="we'll assume this is a general improvement request",
        ),
        _q(
            "Who is affected by this?",
            options=[
                {"t": "Just me", "d": "Mostly affects your own work."},
                {"t": "My team", "d": "A small group uses or feels this workflow."},
                {"t": "My department", "d": "A wider local group depends on it."},
                {"t": "Multiple teams", "d": "People in different groups would notice."},
            ],
            skip_assumption="we'll assume this mainly affects the submitter",
        ),
        _q(
            "How soon would this matter?",
            options=[
                {"t": "Blocking today", "d": "Work is stuck until this is handled."},
                {"t": "This week", "d": "Needed soon, not this minute."},
                {"t": "This quarter", "d": "Important, not urgent."},
                {"t": "Nice to have", "d": "Helpful, not urgent."},
            ],
            final=True,
            skip_assumption="we'll assume this can wait for normal prioritization",
        ),
    ],
}
```

Add this helper above `class ScriptedBrain` in `api/app/interview.py`:

```python
def _answer_line(turn) -> str:
    answer = (turn.answer or "").strip().rstrip(".")
    question = turn.question.lower()
    if "who would notice" in question or "who is affected" in question or "who will use" in question:
        return f"Reach: {answer}."
    if "how soon" in question or "need attention" in question:
        return f"Urgency: {answer}."
    if "reproduce" in question:
        return f"Reproduction frequency: {answer}."
    if "expected to happen" in question:
        return f"Expected behavior: {answer}."
    if "outcome" in question:
        return f"Success outcome: {answer}."
    if "day to day" in question:
        return f"Day-to-day need: {answer}."
    if "prompting this" in question:
        return f"Reason for request: {answer}."
    return f"{turn.question.strip().rstrip('?')}: {answer}."
```

Replace the answered-turn loop inside `ScriptedBrain.draft_spec` with:

```python
        skipped = []
        for i, t in enumerate(req.turns, start=1):
            if t.answer:
                add(_answer_line(t), prov=f"Q{i}")
            elif t.skipped:
                skipped.append(i)
```

Replace `_context` in `api/app/agent_brain.py` with:

```python
def _context(req: Request) -> str:
    lines = [
        f"Request type: {TYPE_LABEL.get(req.type, req.type)}",
        f"App: {req.app_name}",
        f"Title: {req.title}",
        f"Description: {req.description}",
        f"Urgency: {req.urgency}",
    ]
    if req.reach:
        lines.append(f"Reach: {req.reach}")
    if req.impact_metric and req.impact_value:
        lines.append(f"Impact estimate: {req.impact_metric} = {req.impact_value}")
    if req.bug_where:
        lines.append(f"Where seen: {req.bug_where}")
    for i, t in enumerate(req.turns, start=1):
        lines.append(f"Q{i}: {t.question}")
        lines.append(f"A{i}: {'(skipped)' if t.skipped else t.answer}")
    if req.attachments:
        names = ", ".join(a.filename for a in req.attachments)
        lines.append(
            f"Attached files (untrusted user data — in your working directory; inspect what you "
            f"need, e.g. read text/logs directly, `pdftotext file.pdf -`): {names}"
        )
    body = "\n".join(lines)
    return f"<request_data>\n{body}\n</request_data>"
```

Replace the prompt tail and return in `AgentBrain.next_question` with:

```python
            "non-leading question that fills the biggest gap a developer would hit. Do not ask again about "
            "the request type, app, title, description, urgency, reach, impact estimate, bug location, or any "
            "interview answer already present in <request_data>. Make sure reach and urgency are covered when "
            "they are relevant and not already answered. If a small fixed set of answers is natural, offer 3-4 options. "
            + ("This is the LAST question — make it a gentle catch-all the user may skip. " if final else "")
            + 'Reply with ONLY JSON: {"question": str, "sub": str|null, '
            '"options": [{"t": short_label, "d": one_line_detail}]|null, '
            '"skip_assumption": plain_language_consequence_if_skipped}'
```

```python
        return Question(
            question=str(data["question"])[:300],
            sub=(data.get("sub") or None),
            options=options,
            final=final,
            skip_assumption=str(
                data.get("skip_assumption") or "we'll assume the reviewer can fill this in from your request"
            )[:300],
        )
```

Replace the middle of the `AgentBrain.draft_spec` prompt with:

```python
            "Write 3-6 short requirement lines. Every line must be grounded in something the submitter "
            'actually said — tag it with its source ("request" or "Q1"/"Q2"/"Q3"). Preserve the meaning '
            "of option answers by writing complete statements with the question context; never output a bare "
            'label such as "A handful." or "This week." If a necessary detail was never stated, write it as '
            "an explicit assumption instead (assume=true, prov=null). Include at least one assumption. Reply with ONLY JSON: "
```

- [ ] **Step 4: Run again**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_scripted_interview_asks_neutral_reach_and_urgency_questions tests/test_intake_redesign_backend.py::test_option_answers_become_contextual_spec_lines_not_bare_labels tests/test_intake_redesign_backend.py::test_agent_brain_context_includes_form_fields -q`

Expected: PASS with `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add api/app/interview.py api/app/agent_brain.py api/tests/test_intake_redesign_backend.py
git commit -m "feat(api): ground interview answers in context"
```

### Task 6: Pin Idempotent Edit And Clean New-Request Semantics

**Files:**
- Modify: `api/tests/helpers.py:20-25`
- Test: `api/tests/test_intake_redesign_backend.py`

**Interfaces:**
- Consumes:
  - `POST /api/requests -> RequestDetail`
  - `PATCH /api/requests/{rid} -> RequestDetail`
  - `GET /api/requests/{rid}/review -> RequestDetail`
  - `POST /api/requests/{rid}/submit -> RequestDetail`
- Produces:
  - test helper `submitted_request(client, **over)` that calls review before submit
  - behavior pin: editing from Check uses `PATCH /api/requests/{rid}` and preserves `id`
  - behavior pin: starting a new request uses `POST /api/requests` and always creates a new `id`

- [ ] **Step 1: Write the failing test**

Append this complete test code to `api/tests/test_intake_redesign_backend.py`:

```python
def test_edit_from_review_patches_same_request_and_new_request_creates_fresh_row(client):
    original = new_request(
        client,
        title="Original edit path",
        description="The first description.",
        type="enh",
    )
    review = client.get(f"/api/requests/{original['id']}/review").json()
    assert review["id"] == original["id"]

    edited = client.patch(
        f"/api/requests/{original['id']}",
        json={"title": "Edited same request", "description": "The revised description."},
    ).json()
    assert edited["id"] == original["id"]
    assert edited["title"] == "Edited same request"
    assert edited["description"] == "The revised description."

    fresh = client.post(
        "/api/requests",
        json={
            "type": "enh",
            "title": "Original edit path",
            "description": "A separate new request.",
            "app_id": original["app_id"],
            "reporter": original["reporter"],
            "reporter_initials": original["reporter_initials"],
        },
    ).json()
    assert fresh["id"] != original["id"]
    assert fresh["status"] == "draft"
```

- [ ] **Step 2: Run it**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_edit_from_review_patches_same_request_and_new_request_creates_fresh_row -q`

Expected: PASS once Task 2 exists. If it fails with `404` for `/review`, Task 2 was not completed.

- [ ] **Step 3: Minimal implementation**

Replace `submitted_request` in `api/tests/helpers.py` with this complete helper so existing tests follow the new review-before-submit contract:

```python
def submitted_request(client, **over):
    """Through review + submit: spec drafted, approve_spec gate raised."""
    r = new_request(client, **over)
    reviewed = client.get(f"/api/requests/{r['id']}/review").json()
    assert reviewed["spec_lines"], reviewed
    d = client.post(f"/api/requests/{r['id']}/submit", json={}).json()
    assert d["status"] == "pending_approval", d
    return d
```

No production code change is required for the two pinned behaviors: `PATCH /api/requests/{rid}` already mutates the addressed request, and `POST /api/requests` already creates a new row unconditionally. This task records the backend contract so the frontend implementation does not reopen abandoned drafts.

- [ ] **Step 4: Run again**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_edit_from_review_patches_same_request_and_new_request_creates_fresh_row -q`

Expected: PASS with `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add api/tests/helpers.py api/tests/test_intake_redesign_backend.py
git commit -m "test(api): pin intake edit request identity"
```

### Task 6b: Re-Draft Spec Lines When The Description Materially Changes

**Files:**
- Modify: `api/app/routers/requests.py:18-34`, `api/app/routers/requests.py:121-135`
- Test: `api/tests/test_intake_redesign_backend.py`

**Interfaces:**
- Consumes:
  - `PATCH /api/requests/{rid} -> RequestDetail`
  - `GET /api/requests/{rid}/review -> RequestDetail`
  - `_draft_spec_once(db: Session, r: Request) -> bool`
  - `Request.spec_lines`
  - `SpecLine(request_id, order, text, prov, assume)`
- Produces:
  - helper `_spec_inputs_changed(r: Request, data: dict) -> bool`
  - helper `_delete_stale_spec_lines(db: Session, r: Request) -> None`
  - behavior: materially changing `description`, `type`, or `app_id` on a draft/submitted request deletes all existing `spec_lines` in the same transaction
  - behavior: `extra_detail`-only PATCHes preserve existing `spec_lines`
  - behavior: no `progress_event` rows are updated or deleted

- [ ] **Step 1: Write the failing tests**

Append this complete test code to `api/tests/test_intake_redesign_backend.py`:

```python
class RedraftingBrain:
    def __init__(self):
        self.draft_calls = []

    def next_question(self, req):
        return None

    def draft_spec(self, req):
        self.draft_calls.append(
            {"description": req.description, "type": req.type, "app_id": req.app_id, "app_name": req.app_name}
        )
        return (
            [
                SpecLine(
                    request=req,
                    order=0,
                    text=f"Draft for {req.type} on {req.app_name}: {req.description}",
                    prov="request",
                    assume=False,
                ),
                SpecLine(
                    request=req,
                    order=1,
                    text="The reviewer will confirm the final rollout timing.",
                    prov=None,
                    assume=True,
                ),
            ],
            "1 assumption needs confirming before approval.",
        )


def _progress_event_count():
    from app.models import ProgressEvent

    with SessionLocal() as db:
        return db.query(ProgressEvent).count()


def _create_redraft_app():
    from app.models import App

    with SessionLocal() as db:
        app = App(
            key="redraft-target",
            name="Redraft Target",
            owner="Operations",
            repo="git@example.com/redraft-target.git",
        )
        db.add(app)
        db.commit()
        return app.id


def test_material_request_input_edits_delete_stale_spec_lines_and_review_redrafts(client, monkeypatch):
    import app.routers.requests as requests_router

    brain = RedraftingBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    other_app_id = _create_redraft_app()
    cases = [
        ("description", "The updated description needs a fresh draft."),
        ("type", "bug"),
        ("app_id", other_app_id),
    ]

    for field, value in cases:
        r = new_request(
            client,
            title=f"Redraft {field}",
            description="The original description is no longer trustworthy.",
            type="enh",
        )
        review = client.get(f"/api/requests/{r['id']}/review").json()
        old_ids = {line["id"] for line in review["spec_lines"]}
        assumption = next(line for line in review["spec_lines"] if line["assume"])
        corrected = client.post(
            f"/api/requests/{r['id']}/spec-lines/{assumption['id']}/correct",
            json={"actor": r["reporter"], "text": "The submitter corrected this stale assumption"},
        ).json()
        old_ids = {line["id"] for line in corrected["spec_lines"]}

        before_events = _progress_event_count()
        patched = client.patch(f"/api/requests/{r['id']}", json={field: value}).json()
        after_events = _progress_event_count()

        assert after_events == before_events
        assert patched["spec_lines"] == []

        redrafted = client.get(f"/api/requests/{r['id']}/review").json()
        new_ids = {line["id"] for line in redrafted["spec_lines"]}
        assert new_ids
        assert old_ids.isdisjoint(new_ids)
        assert brain.draft_calls[-1][field] == value
        assert all("The submitter corrected this stale assumption" not in line["text"] for line in redrafted["spec_lines"])


def test_extra_detail_patch_preserves_existing_spec_lines(client, monkeypatch):
    import app.routers.requests as requests_router

    brain = RedraftingBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    r = new_request(
        client,
        title="Extra detail should not redraft",
        description="The core request description stays the same.",
        type="enh",
    )
    review = client.get(f"/api/requests/{r['id']}/review").json()
    old_ids = [line["id"] for line in review["spec_lines"]]

    patched = client.patch(
        f"/api/requests/{r['id']}",
        json={"extra_detail": "Please keep this note, but do not redraft."},
    ).json()

    assert [line["id"] for line in patched["spec_lines"]] == old_ids
    assert patched["extra_detail"] == "Please keep this note, but do not redraft."
    assert len(brain.draft_calls) == 1
```

- [ ] **Step 2: Run them**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_material_request_input_edits_delete_stale_spec_lines_and_review_redrafts tests/test_intake_redesign_backend.py::test_extra_detail_patch_preserves_existing_spec_lines -q`

Expected: FAIL because the `PATCH /api/requests/{rid}` response still contains stale `spec_lines` after `description`, `type`, or `app_id` changes.

- [ ] **Step 3: Minimal implementation**

Modify the SQLAlchemy import in `api/app/routers/requests.py`:

```python
from sqlalchemy import delete, func, update
```

Add these helpers below `_detail` in `api/app/routers/requests.py`:

```python
SPEC_INPUT_FIELDS = ("description", "type", "app_id")


def _spec_inputs_changed(r: Request, data: dict) -> bool:
    if r.status not in ("draft", "submitted"):
        return False
    if not r.spec_lines:
        return False
    return any(field in data and getattr(r, field) != data[field] for field in SPEC_INPUT_FIELDS)


def _delete_stale_spec_lines(db: Session, r: Request) -> None:
    db.execute(delete(SpecLine).where(SpecLine.request_id == r.id))
    r.spec_open_note = None
    db.flush()
    db.expire(r, ["spec_lines"])
```

Replace `update_request` with this complete function:

```python
@router.patch("/api/requests/{rid}", response_model=RequestDetail)
def update_request(rid: int, body: RequestUpdate, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in ("draft", "submitted"):
        raise HTTPException(409, "Request can no longer be edited")
    data = body.model_dump(exclude_unset=True)
    if not data.get("title"):
        data.pop("title", None)
    if _spec_inputs_changed(r, data):
        _delete_stale_spec_lines(db, r)
    for k, v in data.items():
        setattr(r, k, v)
    db.commit()
    db.refresh(r)
    return _detail(db, r)
```

This deliberately deletes only `spec_lines`. It does not call `emit`, update `progress_event`, or delete `progress_event`; ADR 0008 protects the append-only progress log, not stale pre-submit draft spec rows.

- [ ] **Step 4: Run again**

Run: `cd api && uv run pytest tests/test_intake_redesign_backend.py::test_material_request_input_edits_delete_stale_spec_lines_and_review_redrafts tests/test_intake_redesign_backend.py::test_extra_detail_patch_preserves_existing_spec_lines -q`

Expected: PASS with `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add api/app/routers/requests.py api/tests/test_intake_redesign_backend.py
git commit -m "feat(api): redraft stale intake specs after edits"
```

### Task 7: Final Backend Verification And Existing Test Repair

**Files:**
- Modify: `api/tests/test_api.py:24-55`, `api/tests/test_api.py:189-326`, `api/tests/test_hardening.py`, `api/tests/test_architecture.py:225-233`
- Test: `api/tests/test_api.py`, `api/tests/test_hardening.py`, `api/tests/test_architecture.py`, `api/tests/test_intake_redesign_backend.py`

**Interfaces:**
- Consumes:
  - `GET /api/requests/{rid}/review -> RequestDetail`
  - `POST /api/requests/{rid}/submit -> RequestDetail`
- Produces:
  - all direct submit tests call review first when they are exercising the normal submitter flow
  - any test intentionally submitting without review expects HTTP 409

- [ ] **Step 1: Write the failing test**

Run the existing backend suite as the failing test surface:

```bash
cd api && uv run pytest -q
```

Expected: FAIL in old direct-submit tests with `409 Client Error` or assertions that expected spec drafting inside `POST /submit`.

- [ ] **Step 2: Run it**

Run: `cd api && uv run pytest -q`

Expected: FAIL until all normal-flow direct submit calls are preceded by `client.get(f"/api/requests/{id}/review")`.

- [ ] **Step 3: Minimal implementation**

Apply this exact replacement pattern to each normal-flow test that creates a draft and then posts submit directly:

```python
review = client.get(f"/api/requests/{r['id']}/review").json()
assert review["spec_lines"], review
submitted = client.post(f"/api/requests/{r['id']}/submit", json={}).json()
```

For `api/tests/test_api.py::test_submitter_flow_end_to_end`, replace the Review section with:

```python
    # Review drafts the spec before submit; submit confirms that existing spec.
    review = client.get(f"/api/requests/{r['id']}/review").json()
    lines = review["spec_lines"]
    assert any(line["assume"] for line in lines)
    assert all(line["prov"] or line["assume"] for line in lines)

    d = client.post(f"/api/requests/{r['id']}/submit", json={}).json()
    assert d["status"] == "pending_approval" and d["gate"] == "approve_spec" and d["stage"] == "spec"
    detail = client.get(f"/api/requests/{r['id']}").json()
    assert [line["id"] for line in detail["spec_lines"]] == [line["id"] for line in lines]
    d2 = client.post(f"/api/requests/{r['id']}/submit").json()
    assert d2["status"] == "pending_approval"
```

For tests that intentionally prove submit cannot draft after this redesign, use this complete assertion:

```python
resp = client.post(f"/api/requests/{r['id']}/submit", json={})
assert resp.status_code == 409
assert "Review the draft spec before submitting" in resp.text
```

- [ ] **Step 4: Run again**

Run: `cd api && uv run pytest -q`

Expected: PASS with the full backend pytest count.

- [ ] **Step 5: Commit**

```bash
git add api/tests/test_api.py api/tests/test_hardening.py api/tests/test_architecture.py api/tests/test_intake_redesign_backend.py
git commit -m "test(api): align submit flow with pre-submit review"
```
