def test_health_reports_leadership(client):
    body = client.get("/api/health").json()
    assert body["leader"] is True  # sqlite: always leader
    assert isinstance(body["epoch"], int) and body["epoch"] >= 1
