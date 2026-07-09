"""Prototype step (new-app only): generation seam + endpoints.

The step drafts a self-contained HTML mock from the interview, then the user chats to edit it
(rewrite/patch/chat), can annotate an element to scope a change, undo, or skip. Brain calls run
through the deterministic ScriptedBrain here; SYNC mode (conftest) resolves revisions inline.
"""
from app.agent_brain import _apply_ops, _parse_prototype_reply
from app.agent_exec import extract_html_block
from app.interview import ScriptedBrain, scripted_prototype_html
from app.models import Request

DOC = "<!doctype html><html><body><h1 data-pid=\"t\">Hi</h1></body></html>"


# ── pure helpers ──

def test_extract_html_block_from_fence_and_bare():
    assert "<body>" in extract_html_block("```html\n" + DOC + "\n```")
    assert extract_html_block("no document here") is None
    assert extract_html_block(DOC) == DOC  # bare fallback


def test_apply_ops_requires_unique_match():
    assert _apply_ops("<body>x</body>", [{"find": "x", "replace": "y"}]) == "<body>y</body>"
    assert _apply_ops("<body>a a</body>", [{"find": "a", "replace": "b"}]) is None  # matches twice
    assert _apply_ops("<body>x</body>", [{"find": "zz", "replace": "y"}]) is None  # no match
    assert _apply_ops("just text", [{"find": "just", "replace": "no"}]) is None  # result isn't a doc


def test_parse_reply_patch_rewrite_chat():
    patch = 'Retitled it.\n===PROTO===\n{"mode":"patch","note":"retitle","ops":[{"find":">Hi<","replace":">Hey<"}]}'
    r = _parse_prototype_reply(patch, DOC)
    assert r["mode"] == "patch" and ">Hey<" in r["html"]

    miss = 'Tried.\n===PROTO===\n{"mode":"patch","ops":[{"find":"NOPE","replace":"x"}]}'
    r = _parse_prototype_reply(miss, DOC)
    assert r["mode"] == "patch" and r["html"] is None  # patch-miss signals a forced rewrite

    rewrite = 'Rebuilt.\n===PROTO===\n{"mode":"rewrite","note":"x"}\n```html\n' + \
              '<html><body><p>Fresh</p></body></html>\n```'
    r = _parse_prototype_reply(rewrite, DOC)
    assert r["mode"] == "rewrite" and "Fresh" in r["html"]

    chat = 'It uses a serif display face.\n===PROTO===\n{"mode":"chat","note":"answered"}'
    r = _parse_prototype_reply(chat, DOC)
    assert r["mode"] == "chat" and r["html"] is None


def test_parse_reply_scrubs_external_refs():
    reply = ('Done.\n===PROTO===\n{"mode":"rewrite","note":"x"}\n```html\n'
             '<html><body><script src="https://evil.example/x.js"></script>ok</body></html>\n```')
    r = _parse_prototype_reply(reply, None)
    assert "https://evil.example" not in r["html"]  # external src neutralized


# ── scripted brain (offline floor) ──

def _new_req() -> Request:
    return Request(ref="REQ-P", title="Track habits", description="a habit tracker",
                   type="new", new_app_name="Streaks")


def test_scripted_first_draft_and_edit():
    r = _new_req()
    first = ScriptedBrain().generate_prototype(r)
    assert first["mode"] == "rewrite"
    assert "<!doctype html" in first["html"].lower() and "Streaks" in first["html"]
    edit = ScriptedBrain().generate_prototype(r, instruction="make it dark", current_html=first["html"])
    assert edit["html"] != first["html"] and "make it dark" in edit["html"]


def test_scripted_prototype_html_is_csp_safe():
    html = scripted_prototype_html(_new_req())
    assert "http://" not in html and "https://" not in html  # no network refs
    assert "data-pid" in html and "data-screen-label" in html  # inspector anchors present


# ── endpoints (SYNC brain via the test client) ──

def _new(client, type="new") -> int:
    body = {"type": type, "title": "Streaks", "description": "a habit tracker", "new_app_name": "Streaks"}
    return client.post("/api/requests", json=body).json()["id"]


def test_prototype_autodrafts_on_entry(client):
    rid = _new(client)
    st = client.get(f"/api/requests/{rid}/prototype").json()
    assert st["thinking"] is False
    assert st["status"] == "draft"
    assert st["html"] and "Streaks" in st["html"]
    assert sum(1 for t in st["turns"] if t["revision"]) == 1


def test_prototype_edit_then_restore(client):
    rid = _new(client)
    first = client.get(f"/api/requests/{rid}/prototype").json()["html"]
    edited = client.post(f"/api/requests/{rid}/prototype",
                         json={"instruction": "add a settings screen"}).json()
    assert edited["status"] == "edited"
    assert edited["html"] != first and "add a settings screen" in edited["html"]
    restored = client.post(f"/api/requests/{rid}/prototype/restore", json={"order": 0}).json()
    assert restored["html"] == first  # undo re-applies the first revision as a new latest


def test_prototype_annotation_rides_with_instruction(client):
    rid = _new(client)
    client.get(f"/api/requests/{rid}/prototype")
    st = client.post(f"/api/requests/{rid}/prototype", json={
        "instruction": "make this bigger",
        "annotation": {"pid": "headline", "selector": "h1", "textSnippet": "Track habits"},
    }).json()
    annotated = next(t for t in st["turns"] if t["instruction"] == "make this bigger")
    assert annotated["annotation"]["pid"] == "headline"


def test_prototype_multi_annotation_rides_as_list(client):
    rid = _new(client)
    client.get(f"/api/requests/{rid}/prototype")
    st = client.post(f"/api/requests/{rid}/prototype", json={
        "instruction": "align these",
        "annotation": [{"pid": "a", "selector": "#a"}, {"pid": "b", "selector": "#b"}],
    }).json()
    turn = next(t for t in st["turns"] if t["instruction"] == "align these")
    assert isinstance(turn["annotation"], list) and len(turn["annotation"]) == 2


def test_prototype_skip_stops_autodraft(client):
    rid = _new(client)
    st = client.post(f"/api/requests/{rid}/prototype/skip").json()
    assert st["status"] == "skipped"
    again = client.get(f"/api/requests/{rid}/prototype").json()
    assert again["status"] == "skipped" and again["html"] is None  # never auto-drafts after skip


def test_prototype_only_for_new_type(client):
    rid = _new(client, type="bug")
    st = client.get(f"/api/requests/{rid}/prototype").json()
    assert st["status"] == "none" and st["html"] is None and st["turns"] == []


def test_request_detail_carries_prototype(client):
    rid = _new(client)
    client.get(f"/api/requests/{rid}/prototype")  # draft it
    d = client.get(f"/api/requests/{rid}").json()
    assert d["prototype_status"] == "draft" and d["prototype_html"]
