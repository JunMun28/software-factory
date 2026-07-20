"""Production-parity invariants carried by the Kubernetes base manifests."""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "deploy/base"
PROD = ROOT / "deploy/overlays/prod"


def _objects(name: str) -> list[dict]:
    return [item for item in yaml.safe_load_all((BASE / name).read_text()) if item]


def test_registry_is_durable_delete_enabled_and_blob_gc_is_safely_suspended():
    objects = _objects("registry.yaml")
    pvc = next(item for item in objects if item["kind"] == "PersistentVolumeClaim")
    registry = next(
        item
        for item in objects
        if item["kind"] == "Deployment" and item["metadata"]["name"] == "sf-registry"
    )
    cron = next(item for item in objects if item["kind"] == "CronJob")

    assert pvc["metadata"]["name"] == "sf-registry-data"
    assert pvc["spec"]["accessModes"] == ["ReadWriteOnce"]
    assert pvc["spec"]["resources"]["requests"]["storage"] == "5Gi"
    assert registry["spec"]["strategy"]["type"] == "Recreate"
    pod = registry["spec"]["template"]["spec"]
    assert pod["volumes"][0]["persistentVolumeClaim"]["claimName"] == "sf-registry-data"
    container = pod["containers"][0]
    assert container["volumeMounts"] == [
        {"name": "registry-data", "mountPath": "/var/lib/registry"}
    ]
    assert {item["name"]: item["value"] for item in container["env"]}[
        "REGISTRY_STORAGE_DELETE_ENABLED"
    ] == "true"
    assert cron["spec"]["suspend"] is True


def test_quota_and_limit_range_leave_room_for_control_plane_and_bounded_jobs():
    objects = _objects("quota.yaml")
    quota = next(item for item in objects if item["kind"] == "ResourceQuota")
    limits = next(item for item in objects if item["kind"] == "LimitRange")

    hard = quota["spec"]["hard"]
    assert hard["requests.cpu"] == "12"
    assert hard["requests.memory"] == "24Gi"
    assert hard["limits.cpu"] == "40"
    assert hard["limits.memory"] == "64Gi"
    defaults = limits["spec"]["limits"][0]
    assert defaults["type"] == "Container"
    assert defaults["defaultRequest"] == {"cpu": "100m", "memory": "128Mi"}
    assert defaults["default"] == {"cpu": "500m", "memory": "512Mi"}
    kustomization = yaml.safe_load((BASE / "kustomization.yaml").read_text())
    assert "quota.yaml" in kustomization["resources"]


def test_kaniko_is_version_pinned_consistently_in_config_and_kind_load():
    config = _objects("configmap.yaml")[0]
    image = config["data"]["FACTORY_KANIKO_IMAGE"]
    taskfile = (ROOT / "Taskfile.yml").read_text()

    assert image == "gcr.io/kaniko-project/executor:v1.23.2"
    assert "gcr.io/kaniko-project/executor:latest" not in taskfile
    assert taskfile.count(image) >= 2


def test_api_pod_reverted_to_lean_profile_after_api_brain_flip():
    """Plan 008 Phase 3.7: api-tier brain calls are sockets, so the Phase-1
    headroom bump is gone; the CLI fallback tier is bounded by FACTORY_CLI_CAP."""
    objects = _objects("factory-api.yaml")
    deployment = next(item for item in objects if item["kind"] == "Deployment")
    containers = deployment["spec"]["template"]["spec"]["containers"]
    api = next(container for container in containers if container["name"] == "api")

    assert api["resources"] == {
        "requests": {"cpu": "250m", "memory": "512Mi"},
        "limits": {"cpu": "1", "memory": "1Gi"},
    }


def test_prod_overlay_ships_the_api_brain_with_async_pregen():
    """ADR 0026 flip: real users stream from the direct API; the base profile
    stays scripted+sync for the kind/CRC smoke."""
    text = (
        Path(__file__).resolve().parents[2]
        / "deploy" / "overlays" / "prod" / "prod-patch.yaml"
    ).read_text()
    docs = [d for d in yaml.safe_load_all(text) if d]
    config = next(d for d in docs if d["kind"] == "ConfigMap")
    assert config["data"]["FACTORY_BRAIN"] == "api"
    assert config["data"]["FACTORY_INTERVIEW_PREGEN"] == "async"
    deployment = next(d for d in docs if d["kind"] == "Deployment")
    env = deployment["spec"]["template"]["spec"]["containers"][0]["env"]
    anthropic = next(e for e in env if e["name"] == "ANTHROPIC_API_KEY")
    assert anthropic["valueFrom"]["secretKeyRef"]["optional"] is True


def test_prod_nulls_sqlite_url_and_secret_sources_azure_sql():
    objects = [
        item
        for item in yaml.safe_load_all((PROD / "prod-patch.yaml").read_text())
        if item
    ]
    config = next(item for item in objects if item["kind"] == "ConfigMap")
    deployment = next(item for item in objects if item["kind"] == "Deployment")
    api = next(
        item
        for item in deployment["spec"]["template"]["spec"]["containers"]
        if item["name"] == "api"
    )
    db_url = next(item for item in api["env"] if item["name"] == "FACTORY_DB_URL")

    assert config["data"]["FACTORY_DB_URL"] is None
    assert db_url == {
        "name": "FACTORY_DB_URL",
        "valueFrom": {
            "secretKeyRef": {
                "name": "factory-db",
                "key": "url",
            }
        },
    }
