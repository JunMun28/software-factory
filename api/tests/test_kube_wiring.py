"""FACTORY_RUNNER=kube wiring: the tick endpoint/loop drives the KubeJobRunner,
gates endpoints stay hands-off, and the whole loop closes end-to-end."""

from fake_kube import FakeKubeClient, honest_cluster
from fastapi.testclient import TestClient
from helpers import approved_request

from app.kube_runner import KubeJobRunner
from app.leader import get_elector
from app.main import _tick_once, create_app


def test_kube_mode_end_to_end_via_tick_endpoint(client, monkeypatch):
    # `client` (session app) holds no exclusive lock on SQLite; a second app
    # over the same DB is safe and mirrors how a real deploy would restart.
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    fake = FakeKubeClient()
    honest_cluster(fake)
    app = create_app(auto_tick=0, runner=KubeJobRunner(client=fake))
    with TestClient(app) as c:
        assert c.get("/api/health").json()["runner"] == "kube"
        d = approved_request(
            c,
            title="Kube wiring e2e",
            description="Add a monthly_export function that returns the export format name.",
        )
        out = d
        for _ in range(30):
            if out["gate"] == "approve_merge":
                break
            moved = c.post("/api/simulator/tick").json()["moved"]
            assert isinstance(moved, list)
            out = c.get(f"/api/requests/{d['id']}").json()
        assert out["gate"] == "approve_merge" and out["stage"] == "review"
        request_jobs = [
            job for job in fake.creations
            if job["metadata"]["labels"]["sf/request"] == d["ref"].lower()
        ]
        assert len(request_jobs) == 8  # 4 stages × (agent Job + gate Job)

        # approve-merge closes the loop on the B1 finish_done path
        done = c.post(f"/api/requests/{d['id']}/approve", json={"operator_id": 1}).json()
        assert done["status"] == "done" and done["stage"] == "done"


def test_kube_mode_approve_does_not_thread_start(client, monkeypatch):
    """Spec §4.3: pick-up is the TICK's job — approve must not push work."""
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    fake = FakeKubeClient()
    app = create_app(auto_tick=0, runner=KubeJobRunner(client=fake))
    with TestClient(app) as c:
        d = approved_request(c, title="Kube no-push approve")
        assert fake.creations == []  # nothing spawned until a tick notices it
        _tick_once(get_elector())
        request_jobs = [
            job for job in fake.creations
            if job["metadata"]["labels"]["sf/request"] == d["ref"].lower()
        ]
        assert len(request_jobs) == 1
