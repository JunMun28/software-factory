# Request Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Submitter attach images and documents (error screenshots, logs, PDF/Word/Excel) to a Request as evidence, which the Stage 1 brain (Codex) reads first-class when drafting the spec, and an Admin can open while reviewing.

**Architecture:** Bytes live on the local filesystem (`api/uploads/<request_id>/<uuid>.<ext>`); metadata in a new `attachments` table. The brain copies a Request's attachments into a fresh **throwaway working dir**, runs `codex exec` with `cwd` set to it and images passed via `--image`, and lets Codex self-explore (read text directly, `pdftotext` for PDF, stdlib zip+xml for docx/xlsx). No pre-extraction, no new Python parsing dependency. Governed by **ADR 0022**.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (SQLite, auto-migrate) · Codex CLI (`codex exec --image`) · Angular 22 (standalone, signals) · `@sf/shared` lib · pytest + vitest.

## Global Constraints

- **ADR 0022 governs this feature** — Codex self-explores raw files in a **read-only**, isolated throwaway dir; no pre-extraction; reversible at the one brain chokepoint.
- **Never UPDATE or DELETE `progress_event` rows** (ADR 0008, append-only). Attachments live in their own table — deleting an attachment row is fine; it is **not** an event.
- **Single uvicorn worker only** — do not add background threads or workers.
- **`make verify` (or `task verify`) must stay green** before merge: ruff + pytest + vitest + Angular build + smoke. `make verify` runs on `FACTORY_BRAIN=scripted` (no CLI, no tokens) — the brain wiring must not break the scripted path.
- **No new Python dependency.** PDF reading is a **runtime** dependency (`pdftotext` / `poppler-utils` on the host + in `api/Dockerfile`), not a pip package. docx/xlsx/text need nothing.
- **Limits (exact values):** max **5** attachments per Request · **10 MB** each (`10*1024*1024`) · max **4** images passed to `codex --image` · content-type **sniffed by magic bytes**, not trusted from the extension · UUID on-disk names.
- **Mutability:** attachments are editable (add/remove) only while `request.status in ("draft", "submitted")`; frozen otherwise (mirrors `update_request`).
- **No server-side auth scoping** — the API has no auth layer today (identity is a client-supplied `reporter` string); serving an attachment is open, consistent with every existing endpoint. SSO scoping is out of scope for this plan.
- **Angular:** standalone components, signals, control-flow (`@if/@for`), imports from `@sf/shared`. Run prettier (`npm run format`) before committing TS/CSS.
- **Injection posture 1 (accepted):** raw file content reaches Codex outside the `<request_data>` wrapper; blast radius is a poisoned Draft spec a human must approve. No scanner in v1.

---

## File Structure

**Backend (`api/`)**
- `api/app/settings.py` — *modify*: uploads dir + limit knobs.
- `api/app/models.py` — *modify*: `Attachment` model + `Request.attachments` relationship.
- `api/app/attachments.py` — *create*: storage + magic-byte validation + throwaway working-dir builder (the deep module that isolates filesystem + sniffing).
- `api/app/schemas.py` — *modify*: `AttachmentOut`; embed `attachments` in `RequestDetail`.
- `api/app/routers/attachments.py` — *create*: `POST/GET/DELETE` request-scoped + `GET …/raw` serve.
- `api/app/main.py` — *modify*: mount the new router.
- `api/app/agent_exec.py` — *modify*: thread `images` through `run_agent`/`_codex_cmd`/`_run_codex_cli`.
- `api/app/agent_brain.py` — *modify*: build a working dir, pass `cwd`+`images`, name attachments in `_context`.

**Backend tests**
- `api/tests/test_attachments.py` — *create*: storage/validation + endpoint tests.
- `api/tests/test_agent_exec.py` — *modify*: `--image` cmd-builder test.
- `api/tests/test_agent_brain_attachments.py` — *create*: brain passes `cwd`+`images`.
- `scripts/probe_codex_attachment.py` — *create*: live Codex probe (manual, not in verify).

**Shared lib (`packages/shared/`)**
- `packages/shared/src/lib/models.ts` — *modify*: `Attachment` type; `RequestDetail.attachments`.
- `packages/shared/src/lib/api.service.ts` — *modify*: upload/delete/raw-url methods.

**Intake UI (`apps/intake/`)**
- `apps/intake/src/app/submitter/attach-field.ts` — *create*: reusable uploader + chips.
- `apps/intake/src/app/submitter/intake-draft.service.ts` — *modify*: pending files + `uploadPending`.
- `apps/intake/src/app/submitter/intake-draft.service.spec.ts` — *modify*: pending-upload tests.
- `apps/intake/src/app/submitter/new-request.ts` — *modify*: mount on Describe; upload on Continue.
- `apps/intake/src/app/submitter/interview.ts` — *modify*: mount in the composer.
- `apps/intake/src/styles.css` — *modify*: chip styles (extend the existing `/* attachments */` block).

**Console UI (`apps/console/`)**
- `apps/console/src/app/admin/request-detail.ts` — *modify*: read-only attachments strip.
- `apps/console/src/styles.css` — *modify*: viewer styles.

---

### Task 1: Attachment model, storage module, settings

**Files:**
- Modify: `api/app/settings.py`
- Modify: `api/app/models.py:116-125` (add relationship), append `Attachment` class after `App`/`Request`
- Create: `api/app/attachments.py`
- Test: `api/tests/test_attachments.py`

**Interfaces:**
- Produces:
  - `models.Attachment(id, request_id, filename, mime, kind, size, stored, source, created_at)`
  - `Request.attachments: list[Attachment]`
  - `attachments.sniff(data: bytes, filename: str) -> tuple[str, str] | None` → `(mime, kind)` or `None` if disallowed
  - `attachments.save(db, r, *, filename, data, source) -> Attachment` (raises `ValueError` on bad type/size)
  - `attachments.path_of(att) -> Path`
  - `attachments.remove(db, att) -> None`
  - `attachments.build_workdir(r) -> tuple[str, list[str]] | None` → `(dir, image_paths)`; caller `rmtree`s `dir`
  - `settings.UPLOADS: Path`, `settings.ATTACH_MAX_BYTES: int`, `settings.ATTACH_MAX_COUNT: int`, `settings.ATTACH_MAX_IMAGES: int`

- [ ] **Step 1: Add settings knobs**

In `api/app/settings.py`, after the `SAMPLE = …` line:

```python
# Attachments (ADR 0022) — bytes on the local FS, metadata in the DB.
UPLOADS = Path(os.environ.get("FACTORY_UPLOADS", str(API_DIR / "uploads")))
ATTACH_MAX_BYTES = int(os.environ.get("FACTORY_ATTACH_MAX_BYTES", str(10 * 1024 * 1024)))  # 10 MB
ATTACH_MAX_COUNT = int(os.environ.get("FACTORY_ATTACH_MAX_COUNT", "5"))
ATTACH_MAX_IMAGES = int(os.environ.get("FACTORY_ATTACH_MAX_IMAGES", "4"))  # passed to codex --image
```

- [ ] **Step 2: Add the `Attachment` model + relationship**

In `api/app/models.py`, add to `Request`'s relationships (after the `comments` relationship, ~line 125):

```python
    attachments: Mapped[list["Attachment"]] = relationship(
        back_populates="request", order_by="Attachment.created_at", cascade="all, delete-orphan"
    )
```

Append a new class after the `Comment` class:

```python
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
```

- [ ] **Step 3: Write the failing storage tests**

Create `api/tests/test_attachments.py`:

```python
import os
import tempfile

# isolate DB + uploads before importing the app
_tmp = tempfile.mkdtemp()
os.environ["FACTORY_DB_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["FACTORY_UPLOADS"] = f"{_tmp}/uploads"

import pytest  # noqa: E402

from app import attachments, settings  # noqa: E402
from app.db import SessionLocal, migrate  # noqa: E402
from app.models import Attachment, Request  # noqa: E402

PNG = bytes.fromhex("89504E470D0A1A0A") + b"\x00" * 32  # PNG magic + filler
PDF = b"%PDF-1.4\n" + b"x" * 32


@pytest.fixture(scope="module")
def db():
    migrate()
    s = SessionLocal()
    yield s
    s.close()


def _req(db) -> Request:
    r = Request(ref=f"REQ-{id(object()) % 9000 + 1000}", title="t", description="d", type="bug")
    db.add(r)
    db.commit()
    return r


def test_sniff_accepts_png_as_image():
    assert attachments.sniff(PNG, "shot.png") == ("image/png", "image")


def test_sniff_accepts_pdf_as_doc():
    assert attachments.sniff(PDF, "spec.pdf") == ("application/pdf", "doc")


def test_sniff_accepts_utf8_text_by_extension():
    assert attachments.sniff(b"NullReferenceError at line 5", "error.log") == ("text/plain", "doc")


def test_sniff_rejects_disguised_extension():
    # a PNG renamed .pdf must be caught by magic bytes, not trusted as pdf
    assert attachments.sniff(PNG, "evil.pdf") is None


def test_sniff_rejects_unknown_binary():
    assert attachments.sniff(b"\x7fELF\x02\x01\x01", "a.bin") is None


def test_save_writes_file_and_row(db):
    r = _req(db)
    att = attachments.save(db, r, filename="shot.png", data=PNG, source="describe")
    assert att.kind == "image" and att.mime == "image/png" and att.size == len(PNG)
    p = attachments.path_of(att)
    assert p.exists() and p.read_bytes() == PNG
    assert att.stored.endswith(".png") and att.stored != "shot.png"


def test_save_rejects_oversize(db):
    r = _req(db)
    big = PNG + b"\x00" * settings.ATTACH_MAX_BYTES
    with pytest.raises(ValueError):
        attachments.save(db, r, filename="big.png", data=big, source="describe")


def test_remove_deletes_file_and_row(db):
    r = _req(db)
    att = attachments.save(db, r, filename="x.log", data=b"hello", source="describe")
    p = attachments.path_of(att)
    aid = att.id
    attachments.remove(db, att)
    assert not p.exists()
    assert db.get(Attachment, aid) is None


def test_build_workdir_copies_friendly_names_and_lists_images(db):
    r = _req(db)
    attachments.save(db, r, filename="My Error.png", data=PNG, source="describe")
    attachments.save(db, r, filename="trace.log", data=b"boom", source="interview")
    db.refresh(r)
    wd = attachments.build_workdir(r)
    assert wd is not None
    import os as _os
    import shutil
    try:
        files = set(_os.listdir(wd[0]))
        assert "My Error.png" in files and "trace.log" in files
        assert len(wd[1]) == 1 and wd[1][0].endswith("My Error.png")  # only the image
    finally:
        shutil.rmtree(wd[0], ignore_errors=True)


def test_build_workdir_none_when_empty(db):
    r = _req(db)
    db.refresh(r)
    assert attachments.build_workdir(r) is None
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_attachments.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.attachments'`.

- [ ] **Step 5: Implement the storage module**

Create `api/app/attachments.py`:

```python
"""Attachment storage + validation (ADR 0022).

Bytes live on the local filesystem under settings.UPLOADS/<request_id>/<stored>;
the DB row is metadata only. Type is decided by sniffing magic bytes — never by
the client-supplied extension — and text formats (no signature) are accepted by
extension only if the bytes decode as UTF-8. build_workdir() materialises a
throwaway dir of friendly-named copies for the Codex working directory.
"""
import re
import shutil
import tempfile
import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from . import settings
from .models import Attachment, Request

# magic-byte signatures → (mime, kind). ZIP covers docx/xlsx (Office Open XML).
_IMAGE_SIGS: list[tuple[bytes, str]] = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
]
# text formats have no signature — allow by extension if the bytes are UTF-8 text.
_TEXT_EXT = {".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown", ".csv": "text/csv"}
_ZIP_EXT = {".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
_SAFE = re.compile(r"[^A-Za-z0-9._ -]+")


def _ext(filename: str) -> str:
    return Path(filename).suffix.lower()


def sniff(data: bytes, filename: str) -> tuple[str, str] | None:
    """Return (mime, kind) if the bytes are an allowed type, else None."""
    head = data[:16]
    for sig, mime in _IMAGE_SIGS:
        if head.startswith(sig):
            return mime, "image"
    if head[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "image"
    if head[:5] == b"%PDF-":
        return "application/pdf", "doc"
    ext = _ext(filename)
    if head[:4] == b"PK\x03\x04" and ext in _ZIP_EXT:  # Office files are ZIP archives
        return _ZIP_EXT[ext], "doc"
    if ext in _TEXT_EXT:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return None
        return _TEXT_EXT[ext], "doc"
    return None


def path_of(att: Attachment) -> Path:
    return settings.UPLOADS / str(att.request_id) / att.stored


def save(db: Session, r: Request, *, filename: str, data: bytes, source: str) -> Attachment:
    """Validate (size + magic bytes) and persist bytes + row. Raises ValueError on reject."""
    if len(data) > settings.ATTACH_MAX_BYTES:
        raise ValueError("file too large")
    sniffed = sniff(data, filename)
    if sniffed is None:
        raise ValueError("unsupported file type")
    mime, kind = sniffed
    stored = uuid.uuid4().hex + _ext(filename)
    dest = settings.UPLOADS / str(r.id) / stored
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    att = Attachment(request_id=r.id, filename=filename[:255], mime=mime, kind=kind,
                     size=len(data), stored=stored, source=source)
    db.add(att)
    db.commit()
    db.refresh(att)
    return att


def remove(db: Session, att: Attachment) -> None:
    path_of(att).unlink(missing_ok=True)
    db.delete(att)
    db.commit()


def build_workdir(r: Request) -> tuple[str, list[str]] | None:
    """Copy a Request's attachments into a fresh temp dir under sanitised original
    names; return (dir, [image paths]) or None if there are none. Caller rmtrees dir."""
    if not r.attachments:
        return None
    wd = tempfile.mkdtemp(prefix=f"sf-att-{r.id}-")
    images: list[str] = []
    used: set[str] = set()
    for att in r.attachments:
        src = path_of(att)
        if not src.exists():
            continue
        name = _SAFE.sub("_", att.filename).strip() or att.stored
        while name in used:  # dedupe friendly names
            name = f"{uuid.uuid4().hex[:6]}-{name}"
        used.add(name)
        dst = Path(wd) / name
        shutil.copyfile(src, dst)
        if att.kind == "image":
            images.append(str(dst))
    return wd, images
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd api && uv run pytest tests/test_attachments.py -q`
Expected: PASS (10 passed).

- [ ] **Step 7: Commit**

```bash
git add api/app/settings.py api/app/models.py api/app/attachments.py api/tests/test_attachments.py
git commit -m "feat(attachments): Attachment model + filesystem storage/validation (ADR 0022)"
```

---

### Task 2: Attachment API — upload, list, delete, serve

**Files:**
- Modify: `api/app/schemas.py` (add `AttachmentOut`; embed in `RequestDetail`)
- Create: `api/app/routers/attachments.py`
- Modify: `api/app/main.py:14-17` (import) and `:76-81` (mount)
- Test: `api/tests/test_attachments.py` (append endpoint tests)

**Interfaces:**
- Consumes: Task 1's `attachments.save/remove/path_of`, `get_request` from `api_helpers`.
- Produces:
  - `POST   /api/requests/{rid}/attachments` (multipart: `file`, `source`) → `AttachmentOut` 201
  - `GET    /api/requests/{rid}/attachments` → `list[AttachmentOut]`
  - `DELETE /api/requests/{rid}/attachments/{aid}` → 204
  - `GET    /api/attachments/{aid}/raw` → `FileResponse`
  - `RequestDetail.attachments: list[AttachmentOut]`

- [ ] **Step 1: Add the schema**

In `api/app/schemas.py`, add near the other small `*Out` models (before `RequestOut`):

```python
class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    filename: str
    mime: str
    kind: str
    size: int
    source: str
    created_at: datetime
```

Then add to `RequestDetail` (alongside `turns`, `comments`, …):

```python
    attachments: list[AttachmentOut] = []
```

- [ ] **Step 2: Write the failing endpoint tests**

Append to `api/tests/test_attachments.py`:

```python
import tempfile as _tf

from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    app = create_app(auto_tick=0)
    with TestClient(app) as c:
        yield c


def _draft(client) -> dict:
    body = {"type": "bug", "title": "Export crashes", "description": "boom",
            "app_id": client.get("/api/apps").json()[0]["id"]}
    return client.post("/api/requests", json=body).json()


def test_upload_list_and_embed(client):
    r = _draft(client)
    up = client.post(f"/api/requests/{r['id']}/attachments",
                     files={"file": ("shot.png", PNG, "image/png")}, data={"source": "describe"})
    assert up.status_code == 201, up.text
    assert up.json()["kind"] == "image"
    lst = client.get(f"/api/requests/{r['id']}/attachments").json()
    assert len(lst) == 1 and lst[0]["filename"] == "shot.png"
    detail = client.get(f"/api/requests/{r['id']}").json()
    assert len(detail["attachments"]) == 1


def test_upload_rejects_bad_type(client):
    r = _draft(client)
    up = client.post(f"/api/requests/{r['id']}/attachments",
                     files={"file": ("evil.pdf", PNG, "application/pdf")}, data={"source": "describe"})
    assert up.status_code == 415


def test_upload_enforces_count_cap(client):
    r = _draft(client)
    for i in range(settings.ATTACH_MAX_COUNT):
        client.post(f"/api/requests/{r['id']}/attachments",
                    files={"file": (f"f{i}.log", b"x", "text/plain")}, data={"source": "describe"})
    over = client.post(f"/api/requests/{r['id']}/attachments",
                       files={"file": ("extra.log", b"x", "text/plain")}, data={"source": "describe"})
    assert over.status_code == 409


def test_delete_removes(client):
    r = _draft(client)
    up = client.post(f"/api/requests/{r['id']}/attachments",
                     files={"file": ("a.log", b"x", "text/plain")}, data={"source": "describe"}).json()
    d = client.delete(f"/api/requests/{r['id']}/attachments/{up['id']}")
    assert d.status_code == 204
    assert client.get(f"/api/requests/{r['id']}/attachments").json() == []


def test_serve_raw_returns_bytes(client):
    r = _draft(client)
    up = client.post(f"/api/requests/{r['id']}/attachments",
                     files={"file": ("shot.png", PNG, "image/png")}, data={"source": "describe"}).json()
    raw = client.get(f"/api/attachments/{up['id']}/raw")
    assert raw.status_code == 200 and raw.content == PNG
    assert raw.headers["content-type"].startswith("image/png")
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_attachments.py -q -k "upload or delete or serve"`
Expected: FAIL — 404 (routes not mounted).

- [ ] **Step 4: Implement the router**

Create `api/app/routers/attachments.py`:

```python
"""Attachment endpoints (ADR 0022): request-scoped upload/list/delete + raw serve."""
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import attachments as store
from .. import settings
from ..api_helpers import get_request
from ..db import get_db
from ..models import Attachment
from ..schemas import AttachmentOut

router = APIRouter()

_EDITABLE = ("draft", "submitted")


@router.post("/api/requests/{rid}/attachments", response_model=AttachmentOut, status_code=201)
def upload(rid: int, file: UploadFile = File(...), source: str = Form("describe"),
           db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in _EDITABLE:
        raise HTTPException(409, "Request can no longer be edited")
    if len(r.attachments) >= settings.ATTACH_MAX_COUNT:
        raise HTTPException(409, f"At most {settings.ATTACH_MAX_COUNT} attachments per request")
    data = file.file.read(settings.ATTACH_MAX_BYTES + 1)
    src = source if source in ("describe", "interview") else "describe"
    try:
        return store.save(db, r, filename=file.filename or "file", data=data, source=src)
    except ValueError as e:
        raise HTTPException(415, str(e))


@router.get("/api/requests/{rid}/attachments", response_model=list[AttachmentOut])
def list_attachments(rid: int, db: Session = Depends(get_db)):
    return get_request(db, rid).attachments


@router.delete("/api/requests/{rid}/attachments/{aid}", status_code=204)
def delete(rid: int, aid: int, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in _EDITABLE:
        raise HTTPException(409, "Request can no longer be edited")
    att = db.get(Attachment, aid)
    if att is None or att.request_id != rid:
        raise HTTPException(404, "No such attachment")
    store.remove(db, att)


@router.get("/api/attachments/{aid}/raw")
def raw(aid: int, db: Session = Depends(get_db)):
    att = db.get(Attachment, aid)
    if att is None:
        raise HTTPException(404, "No such attachment")
    path = store.path_of(att)
    if not path.exists():
        raise HTTPException(404, "File missing")
    return FileResponse(path, media_type=att.mime, filename=att.filename)
```

- [ ] **Step 5: Mount the router**

In `api/app/main.py`, add to the `from .routers import …` block:

```python
from .routers import attachments as attachments_router
```

and after `app.include_router(requests_router.router)`:

```python
    app.include_router(attachments_router.router)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd api && uv run pytest tests/test_attachments.py -q`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add api/app/schemas.py api/app/routers/attachments.py api/app/main.py api/tests/test_attachments.py
git commit -m "feat(attachments): upload/list/delete/serve API + RequestDetail.attachments"
```

---

### Task 3: Live Codex probe — validate the load-bearing assumption

> ADR 0022's premise: `codex exec --sandbox read-only` reads files in its `cwd` and runs `pdftotext`/stdlib to stdout. Prove it **before** wiring the brain. This task gates Tasks 4–5: if the probe fails, stop and reconsider (fall back to pre-extraction).

**Files:**
- Create: `scripts/probe_codex_attachment.py`

- [ ] **Step 1: Write the probe**

Create `scripts/probe_codex_attachment.py`:

```python
#!/usr/bin/env python3
"""Manual probe for ADR 0022 — NOT part of `make verify` (needs codex auth).

Proves codex, in a read-only sandbox, will read a text file in its working dir
and run pdftotext on a PDF placed beside it. Run:  python scripts/probe_codex_attachment.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    wd = Path(tempfile.mkdtemp(prefix="codex-probe-"))
    (wd / "error.log").write_text("FATAL: NullReferenceException at ExportService.run line 88\n")
    # a tiny valid one-page PDF containing the word CANARY-PDF-OK
    (wd / "doc.pdf").write_bytes(_minimal_pdf("CANARY-PDF-OK"))
    prompt = (
        "Two files are in your working directory: error.log and doc.pdf. "
        "Read error.log and extract the PDF's text (pdftotext doc.pdf - works). "
        "Reply with ONLY the exception class name from the log and the single "
        "all-caps token inside the PDF, space-separated."
    )
    last = wd / "_last.md"
    cmd = ["codex", "exec", "--skip-git-repo-check", "--color", "never",
           "--sandbox", "read-only", "--output-last-message", str(last), prompt]
    print("running:", " ".join(cmd[:-1]), "<prompt>")
    proc = subprocess.run(cmd, cwd=str(wd), capture_output=True, text=True, timeout=180)
    out = last.read_text().strip() if last.exists() else proc.stdout
    print("\n--- codex reply ---\n", out)
    ok = "NullReferenceException" in out and "CANARY-PDF-OK" in out
    print("\nRESULT:", "PASS ✅ (codex read both files in read-only cwd)" if ok
          else "FAIL ❌ — see ADR 0022 fallback (pre-extract sidecars)")
    return 0 if ok else 1


def _minimal_pdf(text: str) -> bytes:
    body = (
        b"%PDF-1.1\n"
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]"
        b"/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
        b"4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 100 Td (" + text.encode() + b") Tj ET\nendstream endobj\n"
        b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
        b"trailer<</Root 1 0 R>>\n%%EOF"
    )
    return body


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the probe and capture the verdict**

Run: `python scripts/probe_codex_attachment.py`
Expected: prints `RESULT: PASS ✅`. (If it prints FAIL, **stop** — record the failure and switch to ADR 0022's pre-extraction fallback before continuing.)

- [ ] **Step 3: Commit**

```bash
git add scripts/probe_codex_attachment.py
git commit -m "test(attachments): live Codex read-only working-dir probe (ADR 0022 gate)"
```

---

### Task 4: Thread images through the Codex runtime seam

**Files:**
- Modify: `api/app/agent_exec.py:65-77` (`_codex_cmd`), `:104-111` (`run_agent`), `:133-156` (`_run_codex_cli`)
- Test: `api/tests/test_agent_exec.py`

**Interfaces:**
- Produces: `run_agent(prompt, *, cwd=None, allow_edits=False, timeout=300, max_turns=25, images: list[str] = ())` — Codex path appends `--image <p>` per entry; the claude path ignores `images`.

- [ ] **Step 1: Write the failing cmd-builder test**

Add to `api/tests/test_agent_exec.py`:

```python
def test_codex_cmd_appends_image_flags():
    from app.agent_exec import _codex_cmd

    cmd = _codex_cmd("hi", allow_edits=False, last_message="/tmp/last.md",
                     images=["/tmp/a.png", "/tmp/b.jpg"])
    assert cmd.count("--image") == 2
    ai = cmd.index("--image")
    assert cmd[ai + 1] == "/tmp/a.png"
    assert cmd[-1] == "hi"  # the prompt stays last
    assert "--sandbox" in cmd and cmd[cmd.index("--sandbox") + 1] == "read-only"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_agent_exec.py::test_codex_cmd_appends_image_flags -q`
Expected: FAIL — `_codex_cmd() got an unexpected keyword argument 'images'`.

- [ ] **Step 3: Implement the plumbing**

In `api/app/agent_exec.py`, change `_codex_cmd`:

```python
def _codex_cmd(prompt: str, *, allow_edits: bool, last_message: str,
               images: list[str] = ()) -> list[str]:
    # codex exec has no turn cap — the stage timeout is the autonomy bound
    cmd = [
        CODEX_BIN, "exec",
        "--skip-git-repo-check",  # the brain runs outside a repo; workspaces are throwaway repos
        "--color", "never",
        "--sandbox", "workspace-write" if allow_edits else "read-only",
        "--output-last-message", last_message,
    ]
    if CODEX_MODEL:
        cmd += ["--model", CODEX_MODEL]
    for img in images:
        cmd += ["--image", img]  # ADR 0022: image attachments → native vision
    cmd.append(prompt)
    return cmd
```

Change `run_agent`'s signature + Codex branch:

```python
def run_agent(prompt: str, *, cwd: str | None = None, allow_edits: bool = False,
               timeout: int = 300, max_turns: int = 25, images: list[str] = ()) -> AgentResult:
    """Run the agent CLI headless; returns its final text. Bounded autonomy:
    timeout always; max_turns additionally caps claude (codex has no turn cap).
    images attach to codex via --image (ADR 0022); the claude path ignores them."""
    if agent_cli() == "claude":
        return _run_claude_cli(prompt, cwd=cwd, allow_edits=allow_edits,
                               timeout=timeout, max_turns=max_turns)
    return _run_codex_cli(prompt, cwd=cwd, allow_edits=allow_edits, timeout=timeout, images=images)
```

Change `_run_codex_cli` to accept and forward `images`:

```python
def _run_codex_cli(prompt: str, *, cwd: str | None, allow_edits: bool,
                   timeout: int, images: list[str] = ()) -> AgentResult:
    # codex streams its whole event log to stdout; the agent's final message —
    # the part the brain/runner actually consume — arrives via -o <file>
    fd, last_path = tempfile.mkstemp(prefix="codex-last-", suffix=".md")
    os.close(fd)
    try:
        cmd = _codex_cmd(prompt, allow_edits=allow_edits, last_message=last_path, images=images)
        rc, out, err = _communicate(cmd, cwd, timeout)
```

(The remainder of `_run_codex_cli` is unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && uv run pytest tests/test_agent_exec.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/app/agent_exec.py api/tests/test_agent_exec.py
git commit -m "feat(attachments): pass image attachments to codex exec --image (ADR 0022)"
```

---

### Task 5: Brain reads attachments (working dir + images + context manifest)

**Files:**
- Modify: `api/app/agent_brain.py:14-28` (`_context`), `:34-58` (`next_question`), `:60-89` (`draft_spec`)
- Test: `api/tests/test_agent_brain_attachments.py`

**Interfaces:**
- Consumes: `attachments.build_workdir` (Task 1), `run_agent(..., cwd=, images=)` (Task 4).
- Produces: when `FACTORY_BRAIN=agent`, both brain calls run Codex with `cwd` = a throwaway dir of the Request's attachments and `images` = its image paths (capped at `settings.ATTACH_MAX_IMAGES`); `_context` names the attachments. The scripted path is untouched.

- [ ] **Step 1: Write the failing brain test**

Create `api/tests/test_agent_brain_attachments.py`:

```python
import os
import tempfile

_tmp = tempfile.mkdtemp()
os.environ["FACTORY_DB_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["FACTORY_UPLOADS"] = f"{_tmp}/uploads"

import pytest  # noqa: E402

from app import attachments  # noqa: E402
from app.db import SessionLocal, migrate  # noqa: E402
from app.models import Request  # noqa: E402

PNG = bytes.fromhex("89504E470D0A1A0A") + b"\x00" * 32


@pytest.fixture(scope="module")
def db():
    migrate()
    s = SessionLocal()
    yield s
    s.close()


def test_draft_spec_passes_workdir_and_images(db, monkeypatch):
    r = Request(ref="REQ-7777", title="Export crash", description="boom", type="bug")
    db.add(r)
    db.commit()
    attachments.save(db, r, filename="shot.png", data=PNG, source="describe")
    db.refresh(r)

    seen = {}

    def fake_run_agent(prompt, **kw):
        seen["cwd"] = kw.get("cwd")
        seen["images"] = kw.get("images")
        seen["prompt"] = prompt
        from app.agent_exec import AgentResult
        return AgentResult(ok=True, text='{"lines":[{"text":"Fix export.","prov":"request","assume":false}],"open_note":"x"}')

    monkeypatch.setattr("app.agent_brain.run_agent", fake_run_agent)
    from app.agent_brain import AgentBrain

    lines, note = AgentBrain().draft_spec(r)
    assert seen["cwd"] and os.path.isdir(seen["cwd"]) is False  # rmtree'd after the call
    assert seen["images"] and seen["images"][0].endswith("shot.png")
    assert "shot.png" in seen["prompt"]
    assert lines and lines[0].text == "Fix export."
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_agent_brain_attachments.py -q`
Expected: FAIL — the fake sees `cwd=None`, `images=None`.

- [ ] **Step 3: Implement the brain wiring**

In `api/app/agent_brain.py`, update the imports and `_context`:

```python
import shutil

from . import settings
from .agent_exec import extract_json, run_agent
from .attachments import build_workdir
from .interview import MAX_QUESTIONS, Question, ScriptedBrain, answered_count
from .models import Request, SpecLine
```

Add to the end of `_context`'s `lines` assembly (before `body = "\n".join(lines)`):

```python
    if req.attachments:
        names = ", ".join(a.filename for a in req.attachments)
        lines.append(
            f"Attached files (untrusted user data — in your working directory; inspect what you "
            f"need, e.g. read text/logs directly, `pdftotext file.pdf -`): {names}"
        )
```

Add a private helper after `_context`:

```python
def _run_with_attachments(req: Request, prompt: str, *, timeout: int) -> "object":
    """Run the agent with the Request's attachments in a throwaway working dir
    (ADR 0022). Images go to codex --image; the dir is removed afterwards."""
    wd = build_workdir(req)
    cwd, images = (wd[0], wd[1][: settings.ATTACH_MAX_IMAGES]) if wd else (None, [])
    try:
        return run_agent(prompt, timeout=timeout, cwd=cwd, images=images)
    finally:
        if wd:
            shutil.rmtree(wd[0], ignore_errors=True)
```

In `next_question`, replace `res = run_agent(prompt, timeout=60, max_turns=1)` with:

```python
        res = _run_with_attachments(req, prompt, timeout=60)
```

In `draft_spec`, replace `res = run_agent(prompt, timeout=90, max_turns=1)` with:

```python
        res = _run_with_attachments(req, prompt, timeout=90)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && uv run pytest tests/test_agent_brain_attachments.py -q`
Expected: PASS.

- [ ] **Step 5: Run the full API suite (scripted path must be untouched)**

Run: `cd api && uv run pytest -q`
Expected: PASS (no regressions; `make verify`'s scripted brain still drafts specs without attachments).

- [ ] **Step 6: Commit**

```bash
git add api/app/agent_brain.py api/tests/test_agent_brain_attachments.py
git commit -m "feat(attachments): brain runs codex over a throwaway attachment workdir (ADR 0022)"
```

---

### Task 6: Shared lib — Attachment type + Api methods

**Files:**
- Modify: `packages/shared/src/lib/models.ts`
- Modify: `packages/shared/src/lib/api.service.ts:44-49`

**Interfaces:**
- Produces:
  - `Attachment { id; filename; mime; kind: 'image'|'doc'; size; source: 'describe'|'interview'; created_at }`
  - `RequestDetail.attachments?: Attachment[]`
  - `Api.uploadAttachment(rid, file, source) → Observable<Attachment>`
  - `Api.deleteAttachment(rid, aid) → Observable<void>`
  - `Api.attachmentRawUrl(aid) → string`

- [ ] **Step 1: Add the type**

In `packages/shared/src/lib/models.ts`, add:

```typescript
export interface Attachment {
  id: number;
  filename: string;
  mime: string;
  kind: 'image' | 'doc';
  size: number;
  source: 'describe' | 'interview';
  created_at: string;
}
```

and add `attachments?: Attachment[];` to the `RequestDetail` interface.

- [ ] **Step 2: Add the Api methods**

In `packages/shared/src/lib/api.service.ts`, import `Attachment` in the models import block, then add after `updateRequest`:

```typescript
  uploadAttachment(rid: number, file: File, source: 'describe' | 'interview') {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('source', source);
    return this.http.post<Attachment>(`${BASE}/requests/${rid}/attachments`, fd);
  }
  deleteAttachment(rid: number, aid: number) {
    return this.http.delete<void>(`${BASE}/requests/${rid}/attachments/${aid}`);
  }
  attachmentRawUrl(aid: number) {
    return `${BASE}/attachments/${aid}/raw`;
  }
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build -- console 2>&1 | tail -5` (any app build typechecks `@sf/shared`)
Expected: build succeeds, no TS errors.

- [ ] **Step 4: Commit**

```bash
npm run format
git add packages/shared/src/lib/models.ts packages/shared/src/lib/api.service.ts
git commit -m "feat(attachments): shared Attachment type + Api upload/delete/raw-url"
```

---

### Task 7: Intake draft service — pending files + upload-on-Continue

**Files:**
- Modify: `apps/intake/src/app/submitter/intake-draft.service.ts`
- Test: `apps/intake/src/app/submitter/intake-draft.service.spec.ts`

**Interfaces:**
- Produces (on `IntakeDraft`):
  - `attachments = signal<Attachment[]>([])` — already-uploaded
  - `pending = signal<File[]>([])` — staged before the Request exists
  - `addFiles(files: File[], source: 'describe'|'interview'): Promise<void>` — uploads if `requestId` set, else stages
  - `removeAttachment(aid: number): Promise<void>`
  - `removePending(index: number): void`
  - `uploadPending(rid: number): Promise<void>` — flush staged files after create
  - `loadAttachments(rid: number): Promise<void>`
  - client-side guards: `MAX_FILES = 5`, `MAX_BYTES = 10*1024*1024`, accept set
- Also: `reset()` clears `attachments`/`pending`.

- [ ] **Step 1: Write failing tests**

Add to `apps/intake/src/app/submitter/intake-draft.service.spec.ts` (follow the file's existing TestBed/Api-mock pattern):

```typescript
it('stages files when no request exists yet, then uploads on uploadPending', async () => {
  const uploaded: { rid: number; name: string }[] = [];
  apiMock.uploadAttachment = (rid: number, file: File) => {
    uploaded.push({ rid, name: file.name });
    return of({ id: uploaded.length, filename: file.name, mime: 'text/plain', kind: 'doc',
                size: file.size, source: 'describe', created_at: '' } as Attachment);
  };
  draft.requestId = null;
  await draft.addFiles([new File(['x'], 'a.log')], 'describe');
  expect(draft.pending().length).toBe(1);
  expect(uploaded.length).toBe(0);

  await draft.uploadPending(42);
  expect(uploaded).toEqual([{ rid: 42, name: 'a.log' }]);
  expect(draft.pending().length).toBe(0);
  expect(draft.attachments().length).toBe(1);
});

it('uploads immediately when a request already exists', async () => {
  let called = 0;
  apiMock.uploadAttachment = () => { called++; return of({ id: 1, filename: 'a.log', mime: 'text/plain',
    kind: 'doc', size: 1, source: 'interview', created_at: '' } as Attachment); };
  draft.requestId = 7;
  await draft.addFiles([new File(['x'], 'a.log')], 'interview');
  expect(called).toBe(1);
  expect(draft.attachments().length).toBe(1);
});

it('rejects a file over the size cap without calling the api', async () => {
  let called = 0;
  apiMock.uploadAttachment = () => { called++; return of({} as Attachment); };
  draft.requestId = 7;
  const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png');
  await draft.addFiles([big], 'describe');
  expect(called).toBe(0);
  expect(draft.lastError()).toContain('too large');
});
```

(Add `Attachment` to the file's `@sf/shared` import and `uploadAttachment`/`deleteAttachment` to the existing `apiMock`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/intake/src/app/submitter/intake-draft.service.spec.ts`
Expected: FAIL — `addFiles is not a function`.

- [ ] **Step 3: Implement on `IntakeDraft`**

Add imports and members to `apps/intake/src/app/submitter/intake-draft.service.ts`:

```typescript
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Api, Attachment } from '@sf/shared';
import { Session } from '../core/session.service';
```

Add fields + methods inside the class:

```typescript
  readonly MAX_FILES = 5;
  readonly MAX_BYTES = 10 * 1024 * 1024;
  private readonly ACCEPT = /\.(png|jpe?g|gif|webp|txt|log|md|csv|pdf|docx|xlsx)$/i;

  attachments = signal<Attachment[]>([]);
  pending = signal<File[]>([]);
  lastError = signal('');

  private validate(f: File): string | null {
    if (!this.ACCEPT.test(f.name)) return `${f.name}: unsupported type`;
    if (f.size > this.MAX_BYTES) return `${f.name}: file too large (max 10 MB)`;
    return null;
  }

  async addFiles(files: File[], source: 'describe' | 'interview'): Promise<void> {
    this.lastError.set('');
    for (const f of files) {
      if (this.attachments().length + this.pending().length >= this.MAX_FILES) {
        this.lastError.set(`At most ${this.MAX_FILES} attachments`);
        return;
      }
      const err = this.validate(f);
      if (err) {
        this.lastError.set(err);
        continue;
      }
      if (this.requestId == null) {
        this.pending.update((p) => [...p, f]);
      } else {
        await this.uploadOne(this.requestId, f, source);
      }
    }
  }

  private async uploadOne(rid: number, f: File, source: 'describe' | 'interview'): Promise<void> {
    try {
      const att = await firstValueFrom(this.api.uploadAttachment(rid, f, source));
      this.attachments.update((a) => [...a, att]);
    } catch {
      this.lastError.set(`${f.name}: upload failed`);
    }
  }

  async uploadPending(rid: number): Promise<void> {
    const staged = this.pending();
    this.pending.set([]);
    for (const f of staged) await this.uploadOne(rid, f, 'describe');
  }

  removePending(index: number): void {
    this.pending.update((p) => p.filter((_, i) => i !== index));
  }

  async removeAttachment(aid: number): Promise<void> {
    if (this.requestId == null) return;
    await firstValueFrom(this.api.deleteAttachment(this.requestId, aid));
    this.attachments.update((a) => a.filter((x) => x.id !== aid));
  }

  async loadAttachments(rid: number): Promise<void> {
    const d = await firstValueFrom(this.api.request(rid));
    this.attachments.set(d.attachments ?? []);
  }
```

Add to the existing `reset()` body:

```typescript
    this.attachments.set([]);
    this.pending.set([]);
    this.lastError.set('');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/intake/src/app/submitter/intake-draft.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add apps/intake/src/app/submitter/intake-draft.service.ts apps/intake/src/app/submitter/intake-draft.service.spec.ts
git commit -m "feat(attachments): intake draft holds pending files + uploads on continue"
```

---

### Task 8: Intake UI — `attach-field` component on Describe + interview

**Files:**
- Create: `apps/intake/src/app/submitter/attach-field.ts`
- Modify: `apps/intake/src/app/submitter/new-request.ts` (mount on Describe; upload on Continue)
- Modify: `apps/intake/src/app/submitter/interview.ts` (mount in composer)
- Modify: `apps/intake/src/styles.css` (extend the `/* attachments */` block near line 1983)

**Interfaces:**
- Consumes: `IntakeDraft` (Task 7), `Api.attachmentRawUrl` (Task 6), `Icon` from `@sf/shared`.
- Produces: `<sf-attach-field [source]="'describe'|'interview'" />` — a button + drag/drop + paste zone rendering pending + uploaded chips with remove.

- [ ] **Step 1: Create the component**

Create `apps/intake/src/app/submitter/attach-field.ts`:

```typescript
import { Component, ElementRef, inject, input, viewChild } from '@angular/core';

import { Api, Icon } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';

/** Reusable attachment uploader — button + drag/drop + paste, with removable chips.
 *  Reads/writes the shared IntakeDraft so pending (pre-requestId) and uploaded
 *  files render together. (ADR 0022) */
@Component({
  selector: 'sf-attach-field',
  imports: [Icon],
  template: `
    <div
      class="attach"
      (dragover)="$event.preventDefault()"
      (drop)="onDrop($event)"
      (paste)="onPaste($event)"
    >
      <button type="button" class="attach__btn focusable" (click)="picker().nativeElement.click()">
        <sf-icon name="plus" [size]="14" /> Attach files
      </button>
      <span class="attach__hint">images, logs, PDF/Word/Excel · up to 5 · 10 MB each</span>
      <input
        #picker
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.gif,.webp,.txt,.log,.md,.csv,.pdf,.docx,.xlsx"
        hidden
        (change)="onPick($event)"
      />

      @if (draft.attachments().length || draft.pending().length) {
        <div class="attach__chips">
          @for (a of draft.attachments(); track a.id) {
            <span class="attach__chip" [class.attach__chip--img]="a.kind === 'image'">
              @if (a.kind === 'image') {
                <img class="attach__thumb" [src]="api.attachmentRawUrl(a.id)" alt="" />
              } @else {
                <sf-icon name="app" [size]="14" color="var(--muted)" />
              }
              <span class="attach__name">{{ a.filename }}</span>
              <button type="button" class="attach__x" (click)="draft.removeAttachment(a.id)" aria-label="Remove">
                <sf-icon name="x" [size]="12" />
              </button>
            </span>
          }
          @for (f of draft.pending(); track $index) {
            <span class="attach__chip attach__chip--pending">
              <sf-icon name="clock" [size]="13" color="var(--faint)" />
              <span class="attach__name">{{ f.name }}</span>
              <button type="button" class="attach__x" (click)="draft.removePending($index)" aria-label="Remove">
                <sf-icon name="x" [size]="12" />
              </button>
            </span>
          }
        </div>
      }
      @if (draft.lastError()) {
        <p class="attach__err">{{ draft.lastError() }}</p>
      }
    </div>
  `,
})
export class AttachField {
  draft = inject(IntakeDraft);
  api = inject(Api);
  source = input<'describe' | 'interview'>('describe');
  picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');

  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) this.draft.addFiles(Array.from(input.files), this.source());
    input.value = '';
  }
  onDrop(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer?.files.length) this.draft.addFiles(Array.from(e.dataTransfer.files), this.source());
  }
  onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) this.draft.addFiles(files, this.source());
  }
}
```

> **Icon check:** confirm `x`, `clock`, `plus`, `app` exist in the `Icon` set (`packages/shared/src/lib/icon.ts`). If `x`/`clock` are missing, use an existing close glyph (e.g. `back`) and drop the clock, or add the icons in the same commit.

- [ ] **Step 2: Mount on the Describe step + upload on Continue**

In `apps/intake/src/app/submitter/new-request.ts`:
- add `AttachField` to the component `imports` array;
- inside the revealed `@else` block (after the description `<textarea>` field, before the urgency block), add:

```html
            <div>
              <label class="field-label">Attachments <span style="font-weight:400;color:var(--faint)">(optional)</span></label>
              <span class="field-help">Screenshots, logs, or docs help the AI understand faster.</span>
              <sf-attach-field source="describe" />
            </div>
```

- in `continue_()`, upload staged files after the Request is created:

```typescript
  async continue_() {
    this.saving.set(true);
    try {
      const id = await this.draft.save();
      await this.draft.uploadPending(id);
      this.router.navigateByUrl(`/submit/${id}/interview`);
    } finally {
      this.saving.set(false);
    }
  }
```

- [ ] **Step 3: Mount in the interview composer**

In `apps/intake/src/app/submitter/interview.ts`:
- add `AttachField` to `imports`;
- in `ngOnInit`/constructor where the request id is known, call `this.draft.loadAttachments(id)` so prior attachments show;
- inside the `.dcomposer` block, add `<sf-attach-field source="interview" />` above the answer textarea.

- [ ] **Step 4: Add chip styles**

In `apps/intake/src/styles.css`, extend the `/* attachments */` section (~line 1983):

```css
.attach {
  margin-top: 8px;
}
.attach__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease);
}
.attach__btn:hover {
  border-color: var(--a500);
}
.attach__hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--faint);
}
.attach__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.attach__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  font-size: 12px;
  max-width: 220px;
}
.attach__chip--pending {
  border-style: dashed;
}
.attach__thumb {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  object-fit: cover;
}
.attach__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attach__x {
  display: inline-flex;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--faint);
  padding: 2px;
  border-radius: 4px;
}
.attach__x:hover {
  color: var(--fg1);
  background: var(--hover);
}
.attach__err {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--danger, #c0392b);
}
```

- [ ] **Step 5: Verify in the running app (preview)**

Start/confirm the intake server and verify at desktop + mobile, light + dark:
1. `/submit/new` → pick a type → attach a PNG + a `.log` → both chips render (image shows a thumbnail).
2. Click Continue → confirm the files POST (`preview_network` shows `201` on `/attachments`) and the interview loads with the chips still present.
3. In the interview, attach a second file → it uploads immediately (request exists).
4. Remove a chip → `204` and it disappears.
Capture a screenshot of the Describe step with two chips (light + dark).

- [ ] **Step 6: Commit**

```bash
npm run format
git add apps/intake/src/app/submitter/attach-field.ts apps/intake/src/app/submitter/new-request.ts apps/intake/src/app/submitter/interview.ts apps/intake/src/styles.css
git commit -m "feat(attachments): intake attach-field on Describe + interview"
```

---

### Task 9: Console — read-only attachments strip for the Admin

**Files:**
- Modify: `apps/console/src/app/admin/request-detail.ts`
- Modify: `apps/console/src/styles.css`

**Interfaces:**
- Consumes: `RequestDetail.attachments` (Task 6), `Api.attachmentRawUrl`.
- Produces: a read-only strip (image thumbnails open the raw URL in a new tab; docs are download links) shown while the Admin reviews the Draft spec. No upload/delete in the console.

- [ ] **Step 1: Add the markup**

In `apps/console/src/app/admin/request-detail.ts`, ensure `Api` is injected (it already is for detail loading) and the loaded detail object is available (e.g. `req()` / `detail()`). Add, right after the request description/header block in the template:

```html
    @if (detail()?.attachments?.length) {
      <div class="att-strip">
        <div class="att-strip__hd">Attachments ({{ detail()!.attachments!.length }})</div>
        <div class="att-strip__items">
          @for (a of detail()!.attachments!; track a.id) {
            <a class="att-item" [href]="api.attachmentRawUrl(a.id)" target="_blank" rel="noopener"
               [title]="a.filename">
              @if (a.kind === 'image') {
                <img class="att-item__thumb" [src]="api.attachmentRawUrl(a.id)" alt="" />
              } @else {
                <span class="att-item__doc"><sf-icon name="app" [size]="18" color="var(--muted)" /></span>
              }
              <span class="att-item__name">{{ a.filename }}</span>
            </a>
          }
        </div>
      </div>
    }
```

(Replace `detail()` with the file's actual signal/field name for the loaded `RequestDetail`. Confirm `sf-icon`/`Icon` is in the component `imports`.)

- [ ] **Step 2: Add styles**

In `apps/console/src/styles.css`:

```css
.att-strip {
  margin: 14px 0;
}
.att-strip__hd {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 8px;
}
.att-strip__items {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.att-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  text-decoration: none;
  color: var(--fg2);
  max-width: 240px;
  transition: border-color var(--dur) var(--ease);
}
.att-item:hover {
  border-color: var(--a500);
}
.att-item__thumb {
  width: 30px;
  height: 30px;
  border-radius: 4px;
  object-fit: cover;
}
.att-item__doc {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  background: var(--hover);
  border-radius: 4px;
}
.att-item__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
```

- [ ] **Step 3: Verify in the console preview**

Open a submitted request that has attachments in the console request detail; confirm thumbnails render and clicking opens the raw file in a new tab. Screenshot light + dark.

- [ ] **Step 4: Commit**

```bash
npm run format
git add apps/console/src/app/admin/request-detail.ts apps/console/src/styles.css
git commit -m "feat(attachments): console shows a read-only attachments strip"
```

---

### Task 10: Ship-readiness — Dockerfile + full verify

**Files:**
- Modify: `api/Dockerfile` (add `poppler-utils`)

- [ ] **Step 1: Ensure `pdftotext` ships in the image**

In `api/Dockerfile`, in the system-package step (Debian/Ubuntu base):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
```

(If the base is Alpine, use `RUN apk add --no-cache poppler-utils`.)

- [ ] **Step 2: Run the whole gate**

Run: `task verify` (or `make verify`)
Expected: ruff + pytest + vitest + Angular build + smoke all green.

- [ ] **Step 3: Commit**

```bash
git add api/Dockerfile
git commit -m "build(attachments): ship poppler-utils for codex PDF self-read (ADR 0022)"
```

---

## Self-Review

**Spec coverage** (decision log → task):
- AI primary reader → Tasks 4–5. Humans secondary → Task 9 (console), Task 8 (intake chips). ✅
- Codex self-explore, working dir, `--image` → Tasks 4–5; validated by Task 3. ✅
- Both entry points (Describe + interview) → Task 8; orphan-free pre-`requestId` staging → Task 7. ✅
- Local uploads dir + metadata table → Tasks 1–2. ✅
- Formats images+text+PDF+Office → `sniff()` Task 1. ✅
- Feed whole / no truncation → Task 5 (no cap; timeout-bounded). ✅
- Read-only isolated dir → `build_workdir` (temp dir) Task 1 + `allow_edits=False` default Task 5. ✅
- Injection posture 1 (no scanner; human gate) → encoded as Global Constraint; `_context` marks files untrusted (Task 5). ✅
- Request-scoped flat set, mutable-while-draft → `_EDITABLE` guard Tasks 2/ status checks; `source` field Task 1. ✅
- Limits (5 / 10 MB / 4 images) → settings Task 1, enforced Task 2 (count/size/type) + Task 7 (client). ✅
- `poppler-utils` in image → Task 10. ✅

**Gaps intentionally deferred (not in this plan):** `.docx/.xlsx` were chosen in Q5 and are *accepted + stored + Codex-readable* (stdlib), but no server-side text preview; mid-interview turn-binding (we chose flat set); SSO auth scoping (no auth layer exists); vision/OCR for scanned PDFs (stored, Codex may get nothing — acceptable).

**Type consistency:** `Attachment` fields match across `models.py` (Task 1) → `AttachmentOut` (Task 2) → TS `Attachment` (Task 6). `run_agent(..., images=)` defined Task 4, called Task 5. `IntakeDraft.addFiles/uploadPending/attachments/pending` defined Task 7, used Task 8. `attachmentRawUrl` defined Task 6, used Tasks 8–9. ✅

**Open confirmations for the implementer (cheap, do at the step):** icon names (`x`, `clock`) in the shared `Icon` set; the console detail's loaded-`RequestDetail` signal name; `api/Dockerfile` base distro.
