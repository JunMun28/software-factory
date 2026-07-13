"""Regression: correcting the Request type (the Basics Track chip, or an accepted
escalation) must not leave a question that was pre-generated for the OLD type. Found
in end-to-end acceptance testing of the adaptive-Tracks flow (ADR 0023): a request
classified as a bug, then corrected to an enhancement, was still asked the bug script's
first question."""


def _new(client, **body):
    return client.post("/api/requests", json=body).json()["id"]


def test_patch_type_change_drops_stale_pregenerated_question(client):
    rid = _new(client, type="bug", description="the export button is broken", title="Export")
    # generate the first (bug) question and confirm it's the bug script's opener
    q_bug = client.get(f"/api/requests/{rid}/interview").json()["question"]
    assert q_bug == "What did you expect to happen instead?"

    # correct the type to enhancement (the Basics chip PATCHes type)
    client.patch(f"/api/requests/{rid}", json={"type": "enh"})

    # the next question must be the enhancement script's opener, not the stale bug one
    q_enh = client.get(f"/api/requests/{rid}/interview").json()["question"]
    assert q_enh != "What did you expect to happen instead?"
    assert q_enh == "In a sentence, what's slow or painful about this today?"


def test_patch_same_type_keeps_the_pending_question(client):
    # a non-type edit (or re-sending the same type) must NOT discard a valid question
    rid = _new(client, type="enh", description="add bulk export", title="Bulk")
    q1 = client.get(f"/api/requests/{rid}/interview").json()["question"]
    client.patch(f"/api/requests/{rid}", json={"type": "enh", "reach": "team"})
    q2 = client.get(f"/api/requests/{rid}/interview").json()["question"]
    assert q2 == q1  # same type → the pre-generated question survives


def test_accepted_escalation_drops_stale_question(client):
    rid = _new(client, type="bug", description="grows into an app", title="Grows")
    client.get(f"/api/requests/{rid}/interview")  # pre-generate the bug question
    client.post(f"/api/requests/{rid}/interview/escalate", json={"accept": True, "to_type": "new"})
    q = client.get(f"/api/requests/{rid}/interview").json()["question"]
    assert q != "What did you expect to happen instead?"
