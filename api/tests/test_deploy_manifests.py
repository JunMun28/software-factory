"""Factory-owned build+deploy manifests (Plan B3; spec §7). Pure functions, so
every hard line (allowlist, digest pinning, non-root, walls-compatible labels)
is unit-testable with no cluster."""
import pytest

from app import deploy_manifests as dm

DIGEST = "sha256:" + "a" * 64


def test_build_job_is_backofflimit0_nonroot_no_llm():
    job = dm.build_job_manifest("REQ-2050", "northwind", "b" * 40)
    spec = job["spec"]
    assert spec["backoffLimit"] == 0
    assert spec["activeDeadlineSeconds"] > 0
    assert job["metadata"]["labels"]["sf/role"] == "build"
    assert job["metadata"]["labels"]["sf/tier"] == "agent"
    pod = spec["template"]["spec"]
    assert pod["automountServiceAccountToken"] is False
    assert pod["securityContext"]["runAsNonRoot"] is True
    # kaniko is NOT privileged (its whole point) — no privileged mode, no
    # escalation. It IS in-container root: rootfs unpacking chowns files
    # (proven live; the clone init and every other tier stay non-root).
    kaniko = next(c for c in pod["containers"] if c["name"] == "build")
    assert kaniko["securityContext"]["allowPrivilegeEscalation"] is False
    assert "privileged" not in kaniko["securityContext"]
    assert kaniko["securityContext"]["runAsUser"] == 0
    clone = next(c for c in pod["initContainers"] if c["name"] == "clone")
    assert "runAsUser" not in clone.get("securityContext", {})  # inherits 10101
    # a clone init-container (git) precedes kaniko; kaniko never clones over the LLM path
    assert any(c["name"] == "clone" for c in pod["initContainers"])


def test_build_job_destination_pins_registry_and_sha():
    job = dm.build_job_manifest("REQ-2050", "northwind", "b" * 40)
    kaniko = next(
        c for c in job["spec"]["template"]["spec"]["containers"] if c["name"] == "build"
    )
    args = " ".join(kaniko["args"])
    assert f"{dm.settings.REGISTRY}/sf-app-northwind:" in args
    assert "--digest-file=/dev/termination-log" in args
    assert "--no-push" not in args and "--insecure" in args
    # base images must route through the pull-through proxy (build pods have no
    # internet); empty REGISTRY_PROXY drops the flag for open-egress profiles
    assert f"--registry-mirror={dm.settings.REGISTRY_PROXY}" in args
    assert "--insecure-pull" in args


def test_deploy_manifests_are_digest_pinned_app_tier_nonroot():
    objs = dm.app_deploy_manifests("northwind", DIGEST, replicas=2)
    kinds = {o["kind"] for o in objs}
    assert kinds == {"Deployment", "Service", "Ingress"}
    dep = next(o for o in objs if o["kind"] == "Deployment")
    assert dep["metadata"]["labels"]["sf/tier"] == "app"
    assert dep["metadata"]["labels"]["sf/instance"] == "northwind"
    assert dep["spec"]["replicas"] == 2
    c = dep["spec"]["template"]["spec"]["containers"][0]
    assert c["image"] == f"{dm.settings.REGISTRY}/sf-app-northwind@{DIGEST}"  # BY DIGEST
    assert dep["spec"]["template"]["spec"]["securityContext"]["runAsNonRoot"] is True
    assert dep["spec"]["template"]["spec"]["automountServiceAccountToken"] is False
    assert c["readinessProbe"]["httpGet"]["path"] == "/health"


def test_ingress_host_is_the_slug():
    ing = next(o for o in dm.app_deploy_manifests("northwind", DIGEST) if o["kind"] == "Ingress")
    assert ing["spec"]["rules"][0]["host"] == f"northwind.{dm.settings.APP_INGRESS_DOMAIN}"


@pytest.mark.parametrize("bad", ["Northwind", "north_wind", "a/b", "", "x" * 64])
def test_slug_allowlist_rejects_non_dns_labels(bad):
    with pytest.raises(ValueError):
        dm.app_deploy_manifests(bad, DIGEST)


@pytest.mark.parametrize("bad", ["sha256:zz", "b" * 40, "", "latest"])
def test_digest_must_be_a_real_sha256(bad):
    with pytest.raises(ValueError):
        dm.app_deploy_manifests("northwind", bad)


@pytest.mark.parametrize("bad", [0, -1, 99])
def test_replicas_clamped_to_a_sane_range(bad):
    with pytest.raises(ValueError):
        dm.app_deploy_manifests("northwind", DIGEST, replicas=bad)
