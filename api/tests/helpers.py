"""Shared request factories — every test builds its own state, so any test
runs alone (pytest -k), in any order, without feeding off seed mutations."""


def new_request(client, **over):
    """A draft request (persist-first); interview not started."""
    body = {
        "type": over.pop("type", "enh"),
        "title": over.pop("title", "Fixture request"),
        "description": over.pop("description", "A fixture request."),
        **over,
    }
    if "app_id" not in body:
        body["app_id"] = client.get("/api/apps").json()[0]["id"]
    resp = client.post("/api/requests", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def submitted_request(client, **over):
    """Through submit: spec drafted, approve_spec gate raised."""
    r = new_request(client, **over)
    d = client.post(f"/api/requests/{r['id']}/submit", json={}).json()
    assert d["status"] == "pending_approval", d
    return d


def approved_request(client, **over):
    """Spec approved: status=approved, stage=architecture."""
    r = submitted_request(client, **over)
    d = client.post(f"/api/requests/{r['id']}/approve", json={"operator_id": 1}).json()
    assert d["status"] == "approved", d
    return d
