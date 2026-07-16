"""The v3 seam additions (Plan B3): fake-backed apply / rollout_ready /
delete_by_label + build-digest parsing. RealKubeClient stays a thin mapping onto
the official client; the guarantees proven here are the FAKE's contract, which
the runner tests build on."""
from fake_kube import FakeKubeClient

from app.kube_jobs import parse_digest

DIGEST = "sha256:" + "c" * 64


def test_parse_digest_reads_kaniko_output_and_rejects_garbage():
    assert parse_digest(DIGEST + "\n") == DIGEST
    assert parse_digest("built ok") is None
    assert parse_digest("") is None


def test_apply_is_create_or_update_idempotent():
    f = FakeKubeClient()
    f.apply({"kind": "Deployment", "metadata": {"name": "sf-app-nw",
             "labels": {"sf/instance": "nw"}}, "spec": {"replicas": 1}})
    f.apply({"kind": "Deployment", "metadata": {"name": "sf-app-nw",
             "labels": {"sf/instance": "nw"}}, "spec": {"replicas": 2}})  # update, no dup
    assert f.objects["Deployment/sf-app-nw"]["spec"]["replicas"] == 2
    assert len(f.objects) == 1


def test_rollout_ready_gate_and_delete_by_label():
    f = FakeKubeClient()
    for o in ([{"kind": "Deployment", "metadata": {"name": "sf-app-nw",
                "labels": {"sf/instance": "nw"}}, "spec": {"replicas": 1}},
               {"kind": "Service", "metadata": {"name": "sf-app-nw",
                "labels": {"sf/instance": "nw"}}}]):
        f.apply(o)
    assert f.rollout_ready("sf-app-nw") is False
    f.mark_ready("sf-app-nw")
    assert f.rollout_ready("sf-app-nw") is True
    f.delete_by_label("sf/instance=nw")
    assert "Deployment/sf-app-nw" not in f.objects
    assert "Service/sf-app-nw" not in f.objects


def test_fake_probe_visibility_matches_real_rule():
    from app.kube_jobs import stage_job_manifest

    fake = FakeKubeClient()
    name = "sf-req-2999-red-1"
    fake.create_job(stage_job_manifest("REQ-2999", "red", 1))
    fake.jobs[name].logs = "pending logs must not leak through a probe"
    fake.pending_unschedulable(name)

    assert fake.get_job(name).reason == ""
    assert fake.get_job(name, probe=True).reason == "Unschedulable"
    assert fake.get_job(name, capture=True).reason == "Unschedulable"
    assert fake.get_job(name, probe=True).logs == ""

    fake.jobs[name].phase = "failed"
    assert fake.get_job(name).reason == ""  # deadline deleted Pending pod
    fake.fail_infra(name)
    terminal = fake.get_job(name)
    assert terminal.reason == "OOMKilled" and terminal.exit_code == 137
