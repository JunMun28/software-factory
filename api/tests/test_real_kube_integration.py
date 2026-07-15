"""RealKubeClient against the live kind cluster — OPT-IN ONLY.

Skipped unless FACTORY_KUBE_ITEST=1: CI and `task verify` have no cluster and
must never acquire one. Prereqs: `task kind-up kind-load kind-deploy` and
`kubectl config use-context kind-software-factory`.

These pin the seam behaviors every unit test takes on faith from the fake:
  * a NON-ROOT (runAsUser 10101) pod can write /dev/termination-log and the
    client reads it back — the envelope channel is real;
  * get_job(capture=True) reads a RUNNING pod's logs (the B1 gap, closed);
  * create_job returns the uid; a same-name second create returns None (409);
  * delete_job is idempotent.
"""
import json
import os
import time
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("FACTORY_KUBE_ITEST") != "1",
    reason="needs a live kind cluster — opt in with FACTORY_KUBE_ITEST=1",
)

NS = os.environ.get("FACTORY_KUBE_NAMESPACE", "software-factory")


@pytest.fixture()
def real_client():
    from app.kube_client import RealKubeClient

    return RealKubeClient(namespace=NS)


def _manifest(name: str, script: str, *, deadline: int = 120) -> dict:
    """Minimal Job in the same pod shape kube_jobs emits (non-root, no token,
    sf labels) with a command override — the sf-agent image is already loaded
    into kind, so nothing pulls."""
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": name, "labels": {"sf/tier": "agent", "sf/role": "itest"}},
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": deadline,
            "template": {
                "metadata": {"labels": {"sf/tier": "agent", "sf/role": "itest"}},
                "spec": {
                    "restartPolicy": "Never",
                    "serviceAccountName": "sf-gate",
                    "automountServiceAccountToken": False,
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 10101,
                        "runAsGroup": 0,
                    },
                    "containers": [
                        {
                            "name": "main",
                            "image": "sf-agent:dev",
                            "imagePullPolicy": "IfNotPresent",
                            "command": ["bash", "-c", script],
                            "terminationMessagePolicy": "File",
                        }
                    ],
                },
            },
        },
    }


def _wait_phase(real_client, name: str, phase: str, timeout: int = 120):
    view = real_client.get_job(name)
    deadline = time.time() + timeout
    while time.time() < deadline:
        view = real_client.get_job(name)
        if view.phase == phase:
            return view
        time.sleep(2)
    raise AssertionError(f"{name} never reached {phase!r}; last={view.phase!r}")


def test_envelope_and_logs_from_a_nonroot_pod(real_client):
    name = f"sf-itest-{uuid.uuid4().hex[:8]}"
    script = (
        "echo '{\"type\":\"note\",\"text\":\"hello from the pod\"}'; "
        "printf '{\"v\":1,\"outcome\":\"ok\",\"detail\":\"itest\",\"sha\":null}'"
        " > /dev/termination-log"
    )
    assert real_client.create_job(_manifest(name, script))
    try:
        view = _wait_phase(real_client, name, "succeeded")
        envelope = json.loads(view.termination_message)
        assert envelope["outcome"] == "ok"           # non-root wrote the envelope
        assert "hello from the pod" in view.logs     # NDJSON captured
    finally:
        real_client.delete_job(name)


def test_running_pod_log_capture(real_client):
    name = f"sf-itest-{uuid.uuid4().hex[:8]}"
    script = "echo '{\"type\":\"note\",\"text\":\"mid-flight\"}'; sleep 300"
    assert real_client.create_job(_manifest(name, script, deadline=400))
    try:
        captured = ""
        deadline = time.time() + 120
        while time.time() < deadline:
            view = real_client.get_job(name, capture=True)
            if view.phase == "running" and "mid-flight" in view.logs:
                captured = view.logs
                break
            time.sleep(2)
        assert "mid-flight" in captured              # the B1 gap, closed for real
        assert real_client.get_job(name).logs == ""  # the cheap poll stays cheap
    finally:
        real_client.delete_job(name)


def test_create_conflict_and_idempotent_delete(real_client):
    name = f"sf-itest-{uuid.uuid4().hex[:8]}"
    uid = real_client.create_job(_manifest(name, "sleep 60", deadline=90))
    assert uid
    try:
        assert real_client.create_job(_manifest(name, "sleep 60")) is None  # 409 → None
        assert real_client.get_job(name).uid == uid
    finally:
        real_client.delete_job(name)
        real_client.delete_job(name)  # second delete must not raise (404-tolerant)
