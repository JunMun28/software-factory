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
