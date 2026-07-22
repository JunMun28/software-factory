"""Getting back to an intake you walked away from.

Every answer is already on the server the moment it is given — the gap was that
nothing would list an unfinished request back to you. /api/requests hides drafts on
purpose (an unsubmitted request is not work anybody should act on), which left a
half-finished interview unreachable once you closed the tab.
"""


def _start(client, who="Ada Lovelace", desc="operators swap shifts without emailing"):
    return client.post("/api/requests", json={
        "type": "new", "title": "Shift swap tool", "description": desc,
        "reporter": who, "reporter_initials": "AL",
    }).json()


def test_an_unfinished_intake_can_be_found_again(client):
    started = _start(client)
    drafts = client.get("/api/requests/drafts", params={"mine": "Ada Lovelace"}).json()
    assert [d["ref"] for d in drafts] == [started["ref"]]
    assert drafts[0]["step"] == "interview"  # nothing answered yet


def test_drafts_are_scoped_to_their_owner(client):
    _start(client, who="Ada Lovelace")
    _start(client, who="Bo Chen")
    ada = client.get("/api/requests/drafts", params={"mine": "Ada Lovelace"}).json()
    assert ada and all(d["ref"] for d in ada)
    bo_refs = {d["ref"] for d in client.get("/api/requests/drafts", params={"mine": "Bo Chen"}).json()}
    assert bo_refs.isdisjoint({d["ref"] for d in ada})


def test_an_empty_shell_is_not_offered_as_resumable(client):
    """Opening the page and leaving creates a row. That is not work in progress."""
    empty = client.post("/api/requests", json={
        "type": "new", "title": "", "description": "",
        "reporter": "Ghost User", "reporter_initials": "GU",
    }).json()
    refs = {d["ref"] for d in client.get("/api/requests/drafts", params={"mine": "Ghost User"}).json()}
    assert empty["ref"] not in refs


def test_a_submitted_request_stops_being_a_draft(client):
    started = _start(client)
    rid = started["id"]
    for _ in range(12):
        state = client.get(f"/api/requests/{rid}/interview").json()
        if state.get("done"):
            break
        if state.get("question"):
            client.post(f"/api/requests/{rid}/interview", json={"answer": "post, browse, claim"})
    client.post(f"/api/requests/{rid}/submit")
    refs = {d["ref"] for d in client.get("/api/requests/drafts", params={"mine": "Ada Lovelace"}).json()}
    assert started["ref"] not in refs, "a submitted request is no longer unfinished"


def test_the_resume_step_comes_from_the_server_not_the_client(client):
    """A tab restored from yesterday must not route someone into a step they never
    reached, so the step is derived from what is persisted."""
    from app.db import SessionLocal
    from app.interview import DONE_SENTINEL
    from app.models import Request

    started = _start(client, who="Step Walker")
    with SessionLocal() as db:
        r = db.get(Request, started["id"])
        r.pending_question = DONE_SENTINEL  # interview finished
        db.commit()
    drafts = client.get("/api/requests/drafts", params={"mine": "Step Walker"}).json()
    # a New-track request designs a mock before Review
    assert drafts[0]["step"] == "prototype"


def test_drafts_is_matched_as_a_literal_not_a_request_id(client):
    """Declared before /api/requests/{rid}; a regression would 422 on int parsing."""
    assert client.get("/api/requests/drafts").status_code == 200
