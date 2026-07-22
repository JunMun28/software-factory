"""Attachment storage + validation (ADR 0022, relaxed 2026-07-04).

Bytes live on the local filesystem under settings.UPLOADS/<request_id>/<stored>;
the DB row is metadata only. Any file type is accepted up to the size cap;
sniffing magic bytes — never the client-supplied extension — decides whether a
file is treated as an image (embedded for the model) or a generic document.
build_workdir() materialises a throwaway dir of friendly-named copies for the
Codex working directory.
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
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
# text formats have no signature — allow by extension if the bytes are UTF-8 text.
# The tabular/structured entries matter for sample data: a requester exporting a few rows
# to hand the prototype gets .csv/.tsv/.json far more often than anything else, and only a
# recognised text mime is inlined for models that cannot open files (see text_preview).
_TEXT_EXT = {".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown",
             ".csv": "text/csv", ".tsv": "text/tab-separated-values",
             ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml"}
_ZIP_EXT = {".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
_SAFE = re.compile(r"[^A-Za-z0-9._ -]+")


def _ext(filename: str) -> str:
    return Path(filename).suffix.lower()


_GENERIC = ("application/octet-stream", "doc")


def sniff(data: bytes, filename: str) -> tuple[str, str]:
    """Best-effort (mime, kind) from magic bytes; unknown types are accepted as
    generic documents rather than rejected. The "image" kind (embedded for the
    model) is only granted when bytes AND extension agree — a PNG renamed .pdf
    downgrades to a generic doc instead of being trusted (ADR 0022)."""
    head = data[:16]
    ext = _ext(filename)
    for sig, mime in _IMAGE_SIGS:
        if head.startswith(sig):
            return (mime, "image") if ext in _IMAGE_EXT else _GENERIC
    if head[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ("image/webp", "image") if ext in _IMAGE_EXT else _GENERIC
    if head[:5] == b"%PDF-":
        return "application/pdf", "doc"
    if head[:4] == b"PK\x03\x04" and ext in _ZIP_EXT:  # Office files are ZIP archives
        return _ZIP_EXT[ext], "doc"
    if ext in _TEXT_EXT:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return _GENERIC
        return _TEXT_EXT[ext], "doc"
    return _GENERIC


def path_of(att: Attachment) -> Path:
    return settings.UPLOADS / str(att.request_id) / att.stored


def is_inlinable_text(att: Attachment) -> bool:
    """Whether this attachment's bytes can be pasted into a prompt. Keyed off the sniffed
    mime, never the filename — the same trust anchor the image path uses. PDFs and Office
    files are ZIP/binary and stay out: guessing at their bytes would feed the model noise."""
    return att.kind != "image" and (
        att.mime.startswith("text/") or att.mime == "application/json"
    )


def text_preview(att: Attachment, limit: int) -> tuple[str, bool] | None:
    """(text, was_truncated) for an inlinable attachment, or None if it can't be read.

    The CLI brains get a working directory and open files themselves; the API brain has no
    filesystem, so without this a spreadsheet of sample data would reach the model as nothing
    but a filename — and a prototype built on "there is a file called orders.csv" is exactly
    the generic mock that asking for sample data was meant to avoid."""
    if not is_inlinable_text(att):
        return None
    try:
        raw = path_of(att).read_bytes()[: limit * 4]  # UTF-8 is at most 4 bytes per char
    except OSError:
        return None
    text = raw.decode("utf-8", errors="ignore")  # a byte-slice can split a character
    if not text.strip():
        return None
    return text[:limit], len(text) > limit or len(raw) == limit * 4


def save(db: Session, r: Request, *, filename: str, data: bytes, source: str) -> Attachment:
    """Validate size and persist bytes + row. Raises ValueError on reject."""
    if len(data) > settings.ATTACH_MAX_BYTES:
        raise ValueError("file too large")
    mime, kind = sniff(data, filename)
    stored = uuid.uuid4().hex + _ext(filename)
    dest = settings.UPLOADS / str(r.id) / stored
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    att = Attachment(request_id=r.id, filename=filename[:255], mime=mime, kind=kind,
                     size=len(data), stored=stored, source=source)
    db.add(att)
    try:
        db.commit()
    except Exception:
        dest.unlink(missing_ok=True)
        raise
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
        name = _SAFE.sub("_", att.filename).strip().strip(".")
        if not name or "/" in name or "\\" in name:
            name = att.stored
        while name in used:  # dedupe friendly names
            name = f"{uuid.uuid4().hex[:6]}-{name}"
        used.add(name)
        dst = Path(wd) / name
        shutil.copyfile(src, dst)
        if att.kind == "image":
            images.append(str(dst))
    return wd, images
