import os
import tempfile
import uuid as _uuid

# isolate DB + uploads before importing the app — setdefault: conftest.py already
# guarantees a value (and a pre-set CI MSSQL URL must win)
_tmp = tempfile.mkdtemp()
os.environ.setdefault("FACTORY_DB_URL", f"sqlite:///{_tmp}/test.db")
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


def test_sniff_downgrades_disguised_extension_to_generic_doc():
    # a PNG renamed .pdf is caught by magic bytes — accepted, but never as an image
    assert attachments.sniff(PNG, "evil.pdf") == ("application/octet-stream", "doc")


def test_sniff_accepts_unknown_binary_as_generic_doc():
    assert attachments.sniff(b"\x7fELF\x02\x01\x01", "a.bin") == ("application/octet-stream", "doc")


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


def test_build_workdir_dotdot_filename_does_not_escape(db):
    """A crafted '..' filename must not escape the workdir and must not raise."""
    import shutil as _shutil
    r = _req(db)
    att = attachments.save(db, r, filename="trace.log", data=b"x", source="describe")
    db.refresh(r)
    # Patch the row's filename to ".." after save (save validates by sniff, not name)
    att.filename = ".."
    db.commit()
    db.refresh(r)
    wd = attachments.build_workdir(r)
    assert wd is not None, "build_workdir must not raise"
    try:
        wd_path, _images = wd
        for fname in os.listdir(wd_path):
            copied = os.path.realpath(os.path.join(wd_path, fname))
            assert os.path.dirname(copied) == os.path.realpath(wd_path), (
                f"Copied file {fname!r} escaped the workdir"
            )
    finally:
        _shutil.rmtree(wd_path, ignore_errors=True)


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


def test_upload_accepts_disguised_extension_as_generic_doc(client):
    r = _draft(client)
    up = client.post(f"/api/requests/{r['id']}/attachments",
                     files={"file": ("evil.pdf", PNG, "application/pdf")}, data={"source": "describe"})
    assert up.status_code == 201, up.text
    assert up.json()["kind"] == "doc" and up.json()["mime"] == "application/octet-stream"


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
