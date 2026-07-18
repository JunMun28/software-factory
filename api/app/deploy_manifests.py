"""Factory-owned build + deploy manifests for PRODUCED apps (Plan B3; spec §7).

Pure functions — no I/O, no DB, no LLM — so every deterministic guarantee is
unit-testable with no cluster. The security model lives HERE:

  * ALLOWLIST BY CONSTRUCTION: only slug, digest, replicas are ever interpolated.
    The produced app's own `deploy/` directory is documentation, never input
    (spec §7). A validating renderer with request-supplied params is a later step.
  * DIGEST-PINNED: the Deployment references the image by @sha256 digest recorded
    from the build, never a mutable tag — the deployed bits are exactly what the
    gate graded and the merge merged.
  * app-tier labels (sf/tier: app, sf/instance: <slug>) so the app-walls
    NetworkPolicy and `delete -l sf/instance=<slug>` teardown key off them.
  * non-root arbitrary UID + dropped caps + no SA token, matching agent Jobs.

kaniko needs NO privileged mode (that is its point); it DOES need registry egress
(build-walls NetworkPolicy). The build Job is: initContainer `clone` (sf-agent,
git) -> main container `build` (kaniko, builds /workspace/repo, pushes by digest,
writes the digest to /dev/termination-log for the orchestrator to capture).
"""
import re
from copy import deepcopy

from . import settings

_SLUG = re.compile(r"^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")  # RFC1123 DNS label, <=40
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_SHA40 = re.compile(r"^[0-9a-f]{40}$")


def app_name(slug: str) -> str:
    if not _SLUG.fullmatch(slug or ""):
        raise ValueError(f"refusing non-DNS-label app slug {slug!r}")
    return f"sf-app-{slug}"


def preview_app_name(slug: str) -> str:
    app_name(slug)
    return f"sf-app-{slug}-preview"


def _validate(slug: str, digest: str, replicas: int) -> None:
    app_name(slug)  # slug guard
    if not _DIGEST.fullmatch(digest or ""):
        raise ValueError(f"refusing non-sha256 image digest {digest!r}")
    if not isinstance(replicas, int) or not (1 <= replicas <= 5):
        raise ValueError(f"replicas out of the allowed range 1..5: {replicas!r}")


# ---------- build Job (kaniko) ----------
def build_job_name(ref: str) -> str:
    if not re.fullmatch(r"REQ-\d+", ref or ""):
        raise ValueError(f"refusing build job name for malformed ref {ref!r}")
    return f"sf-{ref.lower()}-build"


def preview_build_job_name(ref: str, round: int) -> str:
    if not re.fullmatch(r"REQ-\d+", ref or ""):
        raise ValueError(f"refusing preview build job name for malformed ref {ref!r}")
    if not isinstance(round, int) or round < 0:
        raise ValueError(f"refusing preview build job name for bad round {round!r}")
    return f"sf-{ref.lower()}-pbuild-r{round}"


def build_job_manifest(ref: str, slug: str, sha: str) -> dict:
    app_name(slug)
    if not _SHA40.fullmatch(sha or ""):
        raise ValueError(f"refusing build at non-40-hex SHA {sha!r}")
    name = build_job_name(ref)
    lref = ref.lower()
    repo_url = f"{settings.GIT_REMOTE_BASE}/{lref}"
    destination = f"{settings.REGISTRY}/sf-app-{slug}:{sha[:12]}"
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "labels": {"sf/tier": "agent", "sf/role": "build",
                       "sf/request": lref, "sf/stage": "build"},
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": settings.BUILD_ACTIVE_DEADLINE,
            # backstop reaper (DEPLOY-03): explicit Foreground delete is primary.
            "ttlSecondsAfterFinished": settings.JOB_TTL_AFTER_FINISHED,
            "podFailurePolicy": {
                "rules": [{"action": "Ignore",
                           "onPodConditions": [{"type": "DisruptionTarget"}]}]
            },
            "template": {
                "metadata": {"labels": {"sf/tier": "agent", "sf/role": "build",
                                        "sf/request": lref}},
                "spec": {
                    "restartPolicy": "Never",
                    "automountServiceAccountToken": False,
                    "serviceAccountName": settings.KUBE_BUILD_SA,
                    # kaniko needs root: on SCC clusters the build SA rides
                    # the LEGACY anyuid SCC — it rejects the seccompProfile
                    # field (admission maps it to forbidden annotations), uid
                    # pinning is pointless under RunAsAny, and with no
                    # injected uid a root-defaulting image violates
                    # runAsNonRoot at kubelet time (all E2E-7 live findings).
                    # This build pod is the factory's one root seam by design.
                    "securityContext": (
                        {}
                        if settings.KUBE_SCC_MANAGED
                        else {
                            "runAsNonRoot": True,
                            "runAsUser": settings.KUBE_RUN_AS_UID,
                            "runAsGroup": 0,
                            "fsGroup": 0,
                            "seccompProfile": {"type": "RuntimeDefault"},
                        }
                    ),
                    "volumes": [{"name": "workspace", "emptyDir": {}}],
                    "initContainers": [{
                        "name": "clone",
                        "image": settings.AGENT_IMAGE,
                        "imagePullPolicy": "IfNotPresent",
                        "env": [
                            {"name": "HOME", "value": "/workspace"},
                            {"name": "SF_REF", "value": ref},
                            {"name": "SF_STAGE", "value": "build"},
                            {"name": "SF_ROLE", "value": "clone"},
                            {"name": "SF_REPO_URL", "value": repo_url},
                            {"name": "SF_BRANCH", "value": "main"},
                            {"name": "SF_SHA", "value": sha},
                        ],
                        "volumeMounts": [{"name": "workspace", "mountPath": "/workspace"}],
                        "securityContext": {"allowPrivilegeEscalation": False,
                                            "capabilities": {"drop": ["ALL"]}},
                        "resources": {"requests": {"cpu": "100m", "memory": "256Mi"},
                                      "limits": {"cpu": "500m", "memory": "512Mi"}},
                    }],
                    "containers": [{
                        "name": "build",
                        "image": settings.KANIKO_IMAGE,
                        "imagePullPolicy": "IfNotPresent",
                        "args": [
                            "--context=dir:///workspace/repo",
                            "--dockerfile=Dockerfile",
                            f"--destination={destination}",
                            "--digest-file=/dev/termination-log",
                            "--insecure", "--skip-tls-verify",
                            "--single-snapshot",
                            # base images come through the pull-through proxy —
                            # the only egress build-walls allow besides git+push
                            *(
                                [f"--registry-mirror={settings.REGISTRY_PROXY}",
                                 "--insecure-pull"]
                                if settings.REGISTRY_PROXY else []
                            ),
                        ],
                        "volumeMounts": [{"name": "workspace", "mountPath": "/workspace"}],
                        # kaniko MUST be in-container root to unpack base
                        # rootfs layers (chown) — proven live: UID 10101 dies
                        # with "chown /: operation not permitted". Still
                        # unprivileged: no privileged mode, no escalation.
                        # Restricted-SCC profiles use BuildConfig instead
                        # (plan deviation, pre-recorded fallback).
                        "securityContext": {"runAsNonRoot": False,
                                            "runAsUser": 0,
                                            "allowPrivilegeEscalation": False},
                        "resources": {"requests": {"cpu": "500m", "memory": "1Gi"},
                                      "limits": {"cpu": "2", "memory": "4Gi"}},
                        "terminationMessagePolicy": "File",
                    }],
                },
            },
        },
    }


def preview_build_job_manifest(ref: str, slug: str, sha: str, round: int) -> dict:
    manifest = deepcopy(build_job_manifest(ref, slug, sha))
    name = preview_build_job_name(ref, round)
    lref = ref.lower()
    labels = {
        "sf/tier": "agent",
        "sf/role": "build",
        "sf/request": lref,
        "sf/preview": "true",
    }
    manifest["metadata"]["name"] = name
    manifest["metadata"]["labels"] = labels
    manifest["spec"]["template"]["metadata"]["labels"] = labels
    pod_spec = manifest["spec"]["template"]["spec"]
    clone_env = pod_spec["initContainers"][0]["env"]
    for item in clone_env:
        if item["name"] == "SF_BRANCH":
            item["value"] = f"work/{lref}"
    destination = f"--destination={settings.REGISTRY}/sf-app-{slug}:preview-{sha[:12]}"
    args = pod_spec["containers"][0]["args"]
    args[args.index(next(arg for arg in args if arg.startswith("--destination=")))] = destination
    return manifest


# ---------- produced-app Deployment / Service / Ingress ----------
def app_deploy_manifests(slug: str, digest: str, replicas: int = 1) -> list[dict]:
    _validate(slug, digest, replicas)
    name = f"sf-app-{slug}"
    image = f"{settings.REGISTRY}/sf-app-{slug}@{digest}"
    labels = {"sf/tier": "app", "sf/instance": slug, "app": name}
    selector = {"app": name}
    deployment = {
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": name, "labels": labels},
        "spec": {
            "replicas": replicas,
            "strategy": {
                "type": "RollingUpdate",
                "rollingUpdate": {"maxUnavailable": 0, "maxSurge": 1},
            },
            "selector": {"matchLabels": selector},
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "serviceAccountName": settings.KUBE_APP_SA,
                    "automountServiceAccountToken": False,
                    "securityContext": {
                        "runAsNonRoot": True,
                        "seccompProfile": {"type": "RuntimeDefault"},
                        **(
                            {}
                            if settings.KUBE_SCC_MANAGED
                            else {
                                "runAsUser": settings.KUBE_RUN_AS_UID,
                                "runAsGroup": 0, "fsGroup": 0,
                            }
                        ),
                    },
                    "containers": [{
                        "name": "app",
                        "image": image,
                        "imagePullPolicy": "IfNotPresent",
                        "ports": [{"containerPort": 8000}],
                        "securityContext": {"allowPrivilegeEscalation": False,
                                            "capabilities": {"drop": ["ALL"]}},
                        "readinessProbe": {"httpGet": {"path": "/health", "port": 8000},
                                           "initialDelaySeconds": 3, "periodSeconds": 5},
                        "livenessProbe": {"httpGet": {"path": "/health", "port": 8000},
                                          "initialDelaySeconds": 10, "periodSeconds": 10},
                        "resources": {"requests": {"cpu": "100m", "memory": "128Mi"},
                                      "limits": {"cpu": "500m", "memory": "512Mi"}},
                    }],
                },
            },
        },
    }
    service = {
        "apiVersion": "v1", "kind": "Service",
        "metadata": {"name": name, "labels": labels},
        "spec": {"selector": selector,
                 "ports": [{"name": "http", "port": 80, "targetPort": 8000}]},
    }
    ingress = {
        "apiVersion": "networking.k8s.io/v1", "kind": "Ingress",
        "metadata": {"name": name, "labels": labels},
        "spec": {"ingressClassName": settings.APP_INGRESS_CLASS, "rules": [{
            "host": f"{slug}.{settings.APP_INGRESS_DOMAIN}",
            "http": {"paths": [{"path": "/", "pathType": "Prefix",
                                "backend": {"service": {"name": name,
                                                        "port": {"number": 80}}}}]},
        }]},
    }
    return [deployment, service, ingress]


def preview_manifests(
    slug: str, digest: str, request_ref: str | None = None
) -> list[dict]:
    """Factory-owned preview resources; request_ref supplies the teardown label."""
    manifests = deepcopy(app_deploy_manifests(slug, digest, replicas=1))
    name = preview_app_name(slug)
    lref = (request_ref or slug).lower()
    if request_ref is not None and not re.fullmatch(r"REQ-\d+", request_ref or ""):
        raise ValueError(f"refusing preview manifests for malformed ref {request_ref!r}")
    labels = {
        "sf/tier": "app",
        "sf/request": lref,
        "sf/preview": "true",
        "app": name,
    }
    selector = {"app": name}
    deployment, service, ingress = manifests
    deployment["metadata"] = {"name": name, "labels": labels}
    deployment["spec"]["replicas"] = 1
    deployment["spec"]["selector"]["matchLabels"] = selector
    deployment["spec"]["template"]["metadata"]["labels"] = labels
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    container["resources"]["requests"] = {"cpu": "50m", "memory": "64Mi"}
    service["metadata"] = {"name": name, "labels": labels}
    service["spec"]["selector"] = selector
    ingress["metadata"] = {"name": name, "labels": labels}
    rule = ingress["spec"]["rules"][0]
    rule["host"] = f"{slug}-preview.{settings.APP_INGRESS_DOMAIN}"
    rule["http"]["paths"][0]["backend"]["service"]["name"] = name
    return manifests
