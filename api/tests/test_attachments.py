import os
import tempfile
import uuid as _uuid

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
    r = Request(ref=f"REQ-{_uuid.uuid4().hex[:8]}", title="t", description="d", type="bug")
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
