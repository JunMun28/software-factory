# Plan B3 — Build & Deploy: the produced app runs as a pod on the cluster

**Spec:** `docs/superpowers/specs/2026-07-14-openshift-kubernetes-architecture-design.md` (§2 topology, §4.9–4.10 lifecycle, §7 build+deploy, §9 Phase 1).
**Predecessors:** B1 (`docs/superpowers/plans/2026-07-15-plan-b1-kube-job-runner.md`), B2 (`docs/superpowers/plans/2026-07-15-plan-b2-kind-cluster.md`).
**Milestone:** close spec §9 Phase 1's true endpoint — a request goes intake → gates → merged `main` → **kaniko-built image** → **produced-app Deployment** whose pod is `Running` and whose HTTP endpoint answers **through the ingress**, with `sf/tier: app` walls proven and every factory Job reaped.

B2 stopped at merged `main` ("deployed in the B2 sense"). B3 swaps in the four seams B2 promised: (1) a golden template that actually containerizes, (2) a kaniko build Job → local registry, (3) factory-owned deploy manifests + a post-merge deploy step, (4) runner integration on the existing StageJob/observe/reap machinery.

---

## What I verified by reading the code (load-bearing facts)

- `intents.KINDS` **already contains** `TRIGGER_BUILD = "trigger_build"` and `APPLY_DEPLOY = "apply_deploy"` (`api/app/intents.py:26-37`) — B3 only wires them; no migration to the intents vocabulary.
- `kube_runner.approve_merge` (`api/app/kube_runner.py:383-419`) currently: `simulator.approve_merge` when `GIT_REMOTE_BASE` unset, else `workspace.merge_graded(...)` then `transitions.apply("finish_done", ...)` → `stage="done", status="done"`. B3 forks the tail of this method.
- **Caller gotcha (`api/app/routers/gates.py:42-56`):** after `pipeline().approve_merge(...)`, the endpoint records the audit outcome as `"approved_merge" if r.status == DONE else "merge_approval_failed"`, and the replay-routing guard is `r.gate == GATE_APPROVE_MERGE or r.stage in ("review", "done")`. If B3 leaves the request in `status=approved, stage=deploy` (deploy pending) rather than `done`, this **misrecords a successful merge as a failure** and mis-routes a replayed approve. Both must change (Task 5).
- The generic runner loops select `StageJob.status == "running"` with no role filter (`kube_runner.py:97-99, 127, 161`). B3 adds `role in ("stage","gate")` so build/deploy rows are invisible to B1/B2 machinery and owned entirely by the new `_drive_deploys` pass — this is what keeps `GIT_REMOTE_BASE`-unset behavior **byte-for-byte B1**.
- `StageJob.role` is `String(8)` and `.stage` is `String(16)` — `"build"`, `"deploy"` fit; `Request.stage` is `String(16)` — new stage `"deploy"` fits. No schema/migration change needed to reuse StageJob (roles/stages are free-text columns already).
- `RealKubeClient` (`api/app/kube_client.py`) holds **only** BatchV1Api/CoreV1Api and 3 methods; B3 adds AppsV1Api + NetworkingV1Api + apply/rollout/delete-by-label to the same thin seam, and the `FakeKubeClient` (`api/tests/fake_kube.py`) mirrors them.
- `sample/` today is a **library** (`src/expenses.py` + `tests/`), not a runnable app. It has no Dockerfile, no web surface. Task 1 makes it containerize while keeping the RED/GREEN/review pipeline (which only touches `tests/` + `src/expenses.py`) unchanged — the new files are **not** in `workspace.SURFACE_PATHS`, so the frozen-surface hash is unaffected.
- `settings.GIT_REMOTE_BASE` empty ⇒ B1; the local overlay sets it. B3 adds `FACTORY_REGISTRY` + `FACTORY_APP_DEPLOY` gated the same way.

---

## Registry research (the crux — decided)

The task asks to decide in-cluster registry vs the `kind` containerd-registry pattern. I fetched the kind local-registry guide and confirmed the split-brain problem: the official recipe references images as `localhost:5001/...` in pod specs (redirected by containerd) but tells in-cluster **builders** to push to `kind-registry:5000` directly — **two different image-name hosts**, and a pod can only reach the registry if `kind-registry` resolves through CoreDNS→node resolver (fragile) and NetworkPolicy can't select a host docker container by pod label.

**Decision — in-cluster registry with a containerd node-mirror, single image name both sides:**

- Registry runs **in-cluster**: `Deployment sf-registry` (image `registry:2`) + `Service sf-registry` (ClusterIP `:5000`, `nodePort: 30500`), labeled `app: registry`.
- **One** image reference everywhere: `sf-registry:5000/sf-app-<slug>@<digest>`.
  - **kaniko push** (a pod): resolves `sf-registry` via CoreDNS in-namespace short name → Service → pushes over HTTP (`--insecure`). NetworkPolicy `build-walls` allows egress to `app: registry` — clean, label-selectable.
  - **kubelet/containerd pull** (the node): the kind cluster config adds a containerd mirror so the host string `sf-registry:5000` maps to `http://localhost:30500` (the node reaches its own NodePort). The node never needs cluster DNS; the image name is just a key.
- This gives a **single, self-consistent image name** for both push and deploy, keeps the registry NetworkPolicy-selectable, and needs only a `containerdConfigPatches` block in `deploy/kind/cluster.yaml`.
- `FACTORY_REGISTRY=sf-registry:5000` (empty ⇒ build/deploy disabled = B2 behavior).

The host-container `kind-registry` variant is recorded as the rejected alternative (Design decision 2). Exact registry wiring and kaniko flags are marked **verify at build time** in the cluster tasks with precise commands.

---

## Scope

**In (B3):**
1. Golden template that containerizes: `sample/` gains a FastAPI surface (`/health` probe + domain routes), a `Dockerfile`, and `requirements.txt`. The built artifact is a container image running `uvicorn app:app` on `:8000`.
2. kaniko build Job — fourth Job kind, `sf/role: build`, tier walls = git + registry only, no LLM. Builds the merged-`main` SHA, pushes to `sf-registry`, reports the pushed **digest**.
3. Factory-owned deploy manifests (allowlisted params only: `slug`, `digest`, `replicas`) + a post-merge deploy step; wire `trigger_build`/`apply_deploy` intents; RBAC additions for `sf-api` (Deployments/Services/Ingresses/NetworkPolicies create + deletecollection in-namespace).
4. Runner integration: after `approve_merge`, drive build → deploy on StageJob/observe/reap; escalation + capture-before-delete on failure; teardown on cancel.
5. Extend `kind-smoke`: after `done`, assert the produced-app pod is `Running` and its HTTP endpoint answers through the ingress; prove `sf/tier: app` walls.

**Out (B4/later — explicitly deferred):** GitHub repos/PRs/GitHub-App and GitHub-API merge (local git-daemon + `merge_graded` stay); a **second human `approve-deploy` gate** (spec §4.10 — B3 drives build→deploy automatically after the merge gate, noted in Design decision 8); steer-note prompt injection; `overlays/openshift` + `overlays/aks` and their build seams (BuildConfig, Actions→ACR); Prometheus/`/metrics`; Azure SQL cutover; gitleaks-per-gate; per-request token budgets.

---

## Constraints honored (every task)

- `GIT_REMOTE_BASE` unset **and** `FACTORY_REGISTRY` unset ⇒ byte-for-byte B1/B2; `FACTORY_REGISTRY` + `FACTORY_APP_DEPLOY` are the new env gates.
- `task verify` + CI stay cluster-free: all B3 unit tests run against `FakeKubeClient`; cluster tasks are opt-in (kind + registry + kaniko image).
- Append-only `progress_event`; single uvicorn worker; MSSQL portability (no new columns; reuse existing `String(N)`/`TZDateTime` columns; `~col` not `.is_(bool)`; migrations import no live app code).
- Every factory Job (incl. build): `backoffLimit 0`, `activeDeadlineSeconds` under an orchestrator wall clock, resources, non-root arbitrary-UID `securityContext`, `automountServiceAccountToken: false`, deterministic name, capture-before-delete.
- kaniko needs **no** privileged mode (its point) but **does** need registry egress — `build-walls` NetworkPolicy designed explicitly (git:9418 for the clone init-container + `app: registry` for push + DNS; nothing else, no LLM).
- Produced-app pods get `sf/tier: app` + `sf/instance: <slug>` labels and `app-walls` (ingress from ingress-nginx only; egress DNS only — no factory, no peers, per spec §2).

---

## Task summary

| # | Task | Tag |
|---|------|-----|
| 1 | Golden template containerizes — FastAPI surface + Dockerfile + deps in `sample/` | unit + docker |
| 2 | `deploy_manifests.py` — build Job + app Deployment/Service/Ingress, allowlist guards | unit |
| 3 | KubeClient seam v3 — `apply`/`rollout_ready`/`delete_by_label` + digest capture; FakeKubeClient | unit |
| 4 | settings + intents + transitions — `FACTORY_REGISTRY`/`FACTORY_APP_DEPLOY`, `begin_deploy`, `deploy` stage | unit |
| 5 | Runner `_drive_deploys` + `approve_merge` fork + gates.py caller fix | unit |
| 6 | Build Job image path — sf-agent `clone` mode + kaniko contract | docker |
| 7 | kind in-cluster registry + containerd mirror + kaniko image load | cluster |
| 8 | Deploy YAML — registry, app SA, sf-api RBAC, `build-walls`/`app-walls`, ConfigMap gates | cluster |
| 9 | Extend `kind-smoke` — pod Running + HTTP via ingress + app-wall proof | cluster+LLM |
| 10 | Docs + full verify + commit | docs |

Tasks 1–6 are the **autonomous half** (unit/docker — runnable with no cluster and no user). Tasks 7–10 are the **interactive half** (kind cluster + a codex-spending end-to-end run).

---

# AUTONOMOUS HALF (unit / docker)

## Task 1 — Golden template that containerizes (unit + docker)

**Goal:** `sample/` becomes a runnable FastAPI app with a `Dockerfile`, while the RED/GREEN/review pipeline (tests + `expenses.py`) and the frozen-surface hash stay unchanged.

**Files:** `sample/app.py` (new), `sample/requirements.txt` (new), `sample/Dockerfile` (new), `api/tests/test_golden_template.py` (new).

### Step 1 (RED) — `api/tests/test_golden_template.py`

```python
"""The golden template (sample/) must containerize AND stay pipeline-safe.

Plan B3 turns the merged main of a per-request workspace into a container image.
This pins: (1) the FastAPI surface imports and exposes /health; (2) the domain
tests still pass under the gate's fixed pytest command; (3) the new files are
NOT under the frozen surface, so adding them never changes surface_hash_at().
"""
from pathlib import Path

from app import workspace

SAMPLE = Path(__file__).resolve().parents[2] / "sample"


def test_dockerfile_and_requirements_present():
    assert (SAMPLE / "Dockerfile").is_file()
    reqs = (SAMPLE / "requirements.txt").read_text()
    assert "fastapi" in reqs and "uvicorn" in reqs


def test_app_module_exposes_health_and_imports_domain():
    src = (SAMPLE / "app.py").read_text()
    assert "FastAPI(" in src
    assert "/health" in src
    assert "from expenses import" in src  # the domain module the pipeline builds


def test_new_files_are_not_in_the_frozen_surface():
    # spec §6: the frozen surface is tests + test-config only. Dockerfile/app.py
    # must not leak into it, or every build would falsely trip test-isolation.
    for name in ("Dockerfile", "requirements.txt", "app.py"):
        assert name not in workspace.SURFACE_PATHS


def test_domain_tests_still_pass():
    import subprocess, sys
    r = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "tests"],
        cwd=SAMPLE, capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
```

Run (expect the first two/three to fail — files absent):

```bash
cd api && uv run pytest -q tests/test_golden_template.py
# EXPECT: FAILED test_dockerfile_and_requirements_present, ..._app_module_exposes_health...
```

### Step 2 (GREEN) — `sample/app.py`

```python
"""Northwind Expenses — a tiny FastAPI surface over the domain module.

Plan B3 containerizes THIS: `GET /health` is the deploy-verify probe the factory
hits through the ingress; the domain routes exercise expenses.py. The pipeline
(RED/GREEN/review) operates on expenses.py + tests/ only — this module, the
Dockerfile, and requirements.txt are inert to the gate (not under SURFACE_PATHS)
and consumed solely by the kaniko build Job.
"""
from expenses import by_category, total
from fastapi import FastAPI

app = FastAPI(title="Northwind Expenses")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/")
def root() -> dict:
    return {"app": "northwind-expenses", "endpoints": ["/health", "/total", "/by-category"]}


@app.post("/total")
def total_endpoint(amounts: list[float]) -> dict:
    return {"total": total(amounts)}


@app.post("/by-category")
def by_category_endpoint(items: list[dict]) -> dict:
    return {"by_category": by_category(items)}
```

### Step 3 (GREEN) — `sample/requirements.txt`

```
fastapi>=0.115,<0.116
uvicorn[standard]>=0.32,<0.33
```
*(verify at build time: `docker build sample/` resolves these on the build platform; bump the pins if the resolver complains.)*

### Step 4 (GREEN) — `sample/Dockerfile`

```dockerfile
# Produced-app image (Plan B3). The factory's kaniko build Job turns the merged
# main of a per-request workspace into this image. Arbitrary-UID conventions
# (root group ownership, chmod g=u, HOME=/app) so app pods run non-root under a
# forced UID, matching the factory's restricted-SCC emulation (spec §2).
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PYTHONPATH=/app/src HOME=/app
RUN chgrp -R 0 /app && chmod -R g=u /app
EXPOSE 8000
USER 10101
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

Run (expect green). Then confirm the non-kube smoke and workspace tests are unaffected:

```bash
cd api && uv run pytest -q tests/test_golden_template.py tests/test_workspace.py
# EXPECT: all passed
```

**Note (verify at build time):** the arbitrary-UID `USER 10101` in the Dockerfile is a template default; the deploy manifest (Task 2) *also* sets `runAsUser` at the pod level (spec §2 forced UID), which is what actually binds under restricted SCC. The Dockerfile `USER` line makes `docker run sample` behave the same locally.

---

## Task 2 — `deploy_manifests.py`: build Job + app manifests (unit)

**Goal:** pure, I/O-free, unit-testable factory-owned manifests, mirroring `kube_jobs.py`. **Allowlist enforced by construction:** only `slug`, `digest`, `replicas` reach the app template; the app repo's own `deploy/` is never read (spec §7).

**Files:** `api/app/deploy_manifests.py` (new), `api/tests/test_deploy_manifests.py` (new).

### Step 1 (RED) — `api/tests/test_deploy_manifests.py`

```python
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
    # kaniko is NOT privileged (its whole point) — prove no privilege escalation
    kaniko = next(c for c in pod["containers"] if c["name"] == "build")
    assert kaniko["securityContext"]["allowPrivilegeEscalation"] is False
    assert "privileged" not in kaniko["securityContext"]
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
```

```bash
cd api && uv run pytest -q tests/test_deploy_manifests.py   # EXPECT: import error / all fail (module absent)
```

### Step 2 (GREEN) — `api/app/deploy_manifests.py`

```python
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
git) → main container `build` (kaniko, builds /workspace/repo, pushes by digest,
writes the digest to /dev/termination-log for the orchestrator to capture).
"""
import re

from . import settings

_SLUG = re.compile(r"^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")  # RFC1123 DNS label, <=40
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_SHA40 = re.compile(r"^[0-9a-f]{40}$")


def app_name(slug: str) -> str:
    if not _SLUG.fullmatch(slug or ""):
        raise ValueError(f"refusing non-DNS-label app slug {slug!r}")
    return f"sf-app-{slug}"


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
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": settings.KUBE_RUN_AS_UID,
                        "runAsGroup": 0,
                        "fsGroup": 0,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "volumes": [{"name": "workspace", "emptyDir": {}}],
                    "initContainers": [{
                        "name": "clone",
                        "image": settings.AGENT_IMAGE,
                        "imagePullPolicy": "IfNotPresent",
                        "env": [
                            {"name": "HOME", "value": "/workspace"},
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
                        ],
                        "volumeMounts": [{"name": "workspace", "mountPath": "/workspace"}],
                        "securityContext": {"allowPrivilegeEscalation": False,
                                            "capabilities": {"drop": ["ALL"]}},
                        "resources": {"requests": {"cpu": "500m", "memory": "1Gi"},
                                      "limits": {"cpu": "2", "memory": "4Gi"}},
                        "terminationMessagePolicy": "File",
                    }],
                },
            },
        },
    }


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
            "selector": {"matchLabels": selector},
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "serviceAccountName": settings.KUBE_APP_SA,
                    "automountServiceAccountToken": False,
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": settings.KUBE_RUN_AS_UID,
                        "runAsGroup": 0, "fsGroup": 0,
                        "seccompProfile": {"type": "RuntimeDefault"},
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
        "spec": {"ingressClassName": "nginx", "rules": [{
            "host": f"{slug}.{settings.APP_INGRESS_DOMAIN}",
            "http": {"paths": [{"path": "/", "pathType": "Prefix",
                                "backend": {"service": {"name": name,
                                                        "port": {"number": 80}}}}]},
        }]},
    }
    return [deployment, service, ingress]
```

```bash
cd api && uv run pytest -q tests/test_deploy_manifests.py   # EXPECT: all passed
```

**Design note in-code:** the build destination is a **tag** (`:sha[:12]`) for a human-readable push target; the *deploy* references the **digest** kaniko reports (immutable). This matches spec §7 ("output: image digest recorded in the DB").

---

## Task 3 — KubeClient seam v3: apply / rollout / delete-by-label + digest (unit)

**Goal:** extend the thin seam so the runner can apply the app manifests, wait for rollout, tear down by label, and capture the build digest — all still fake-backed in tests.

**Files:** `api/app/kube_client.py` (edit), `api/tests/fake_kube.py` (edit), `api/tests/test_kube_client_seam.py` (new).

### Interfaces added to `KubeClient` Protocol

```python
def apply(self, manifest: dict) -> None: ...          # server-side apply, create-or-update
def rollout_ready(self, name: str) -> bool: ...       # Deployment: observed==updated==available==spec.replicas
def delete_by_label(self, selector: str) -> None: ... # teardown: delete Deployments/Services/Ingresses by label
```

`get_job` is unchanged; the build digest rides the **termination message** (`--digest-file=/dev/termination-log`), captured by the existing `get_job(..., capture=True)` path. Add a parser next to `parse_envelope`:

`api/app/kube_jobs.py` — add:

```python
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")

def parse_digest(msg: str) -> str | None:
    """A build Job's termination message is kaniko's --digest-file output: a bare
    `sha256:<64hex>` (kaniko may append a trailing newline). Returns the digest or
    None for garbage (missing-digest is its own escalation reason, like a missing
    envelope for stage Jobs)."""
    m = _DIGEST.search(msg or "")
    return m.group(0) if m else None
```

### Step 1 (RED) — `api/tests/test_kube_client_seam.py`

```python
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
    assert len([o for o in f.applied if o["metadata"]["name"] == "sf-app-nw"]) == 1
    assert f.objects["Deployment/sf-app-nw"]["spec"]["replicas"] == 2


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
```

### Step 2 (GREEN) — `FakeKubeClient` additions (`api/tests/fake_kube.py`)

```python
    # --- Plan B3 additions ---
    applied: list = field(default_factory=list)
    objects: dict = field(default_factory=dict)          # "Kind/name" -> manifest
    _ready: set = field(default_factory=set)

    def apply(self, manifest: dict) -> None:
        key = f"{manifest['kind']}/{manifest['metadata']['name']}"
        self.applied.append(manifest)
        self.objects[key] = manifest

    def rollout_ready(self, name: str) -> bool:
        return f"Deployment/{name}" in self.objects and name in self._ready

    def delete_by_label(self, selector: str) -> None:
        k, _, v = selector.partition("=")
        for key in list(self.objects):
            if self.objects[key].get("metadata", {}).get("labels", {}).get(k) == v:
                self.objects.pop(key)

    def mark_ready(self, name: str) -> None:  # test helper (a rolled-out Deployment)
        self._ready.add(name)
```

### Step 3 (GREEN) — `RealKubeClient` additions (`api/app/kube_client.py`)

```python
    # __init__ additions:
        self._apps = client.AppsV1Api()
        self._net = client.NetworkingV1Api()

    def apply(self, manifest: dict) -> None:
        """Server-side apply (create-or-update, factory field-manager). Covers the
        four kinds the deploy template emits; force=True resolves our own re-applies."""
        kind = manifest["kind"]
        name = manifest["metadata"]["name"]
        api, patch = {
            "Deployment": (self._apps, self._apps.patch_namespaced_deployment),
            "Service": (self._core, self._core.patch_namespaced_service),
            "Ingress": (self._net, self._net.patch_namespaced_ingress),
            "NetworkPolicy": (self._net, self._net.patch_namespaced_network_policy),
        }[kind][0:2]
        try:
            patch(name, self.ns, manifest,
                  field_manager="software-factory", force=True,
                  _content_type="application/apply-patch+yaml")
        except self._ApiException:
            raise

    def rollout_ready(self, name: str) -> bool:
        try:
            d = self._apps.read_namespaced_deployment_status(name, self.ns)
        except self._ApiException as e:
            if e.status == 404:
                return False
            raise
        s, spec = d.status, d.spec
        want = spec.replicas or 0
        return (
            (s.updated_replicas or 0) >= want
            and (s.available_replicas or 0) >= want
            and (s.observed_generation or 0) >= (d.metadata.generation or 0)
        )

    def delete_by_label(self, selector: str) -> None:
        self._apps.delete_collection_namespaced_deployment(self.ns, label_selector=selector)
        for item in self._core.list_namespaced_service(self.ns, label_selector=selector).items:
            self._core.delete_namespaced_service(item.metadata.name, self.ns)
        self._net.delete_collection_namespaced_ingress(self.ns, label_selector=selector)
```

*(verify at build time: server-side apply via `patch_*` with `application/apply-patch+yaml` on the installed `kubernetes` client version — the integration test in Task 7's opt-in suite exercises it. Fallback recorded: create-then-replace on 409/404 if apply-patch content-type is rejected.)*

```bash
cd api && uv run pytest -q tests/test_kube_client_seam.py   # EXPECT: all passed
```

---

## Task 4 — settings + intents + transitions (unit)

**Goal:** the env gates, the `deploy` stage, and the `begin_deploy` transition — all preserving B1/B2 when unset.

**Files:** `api/app/settings.py` (edit), `api/app/transitions.py` (edit), `api/tests/test_transitions.py` (edit — add cases), `api/tests/test_deploy_settings.py` (new).

### Step 1 — `settings.py` additions (append to the Kubernetes section)

```python
# ---------- produced-app build + deploy (Plan B3, spec §7) ----------
# Registry the build Job pushes to AND the deploy pulls from — ONE image name for
# both (kaniko reaches it via cluster DNS; the node reaches it via a containerd
# mirror to a NodePort). Empty = build/deploy disabled: approve_merge behaves
# exactly like B2 (merge -> done). This is the B3 env gate, mirroring GIT_REMOTE_BASE.
REGISTRY = os.environ.get("FACTORY_REGISTRY", "").rstrip("/")
# Master switch for the post-merge deploy flow. Requires REGISTRY + GIT_REMOTE_BASE.
APP_DEPLOY = os.environ.get("FACTORY_APP_DEPLOY", "").lower() in ("1", "true", "yes")
KANIKO_IMAGE = os.environ.get("FACTORY_KANIKO_IMAGE", "gcr.io/kaniko-project/executor:latest")
APP_INGRESS_DOMAIN = os.environ.get("FACTORY_APP_INGRESS_DOMAIN", "localtest.me")
KUBE_BUILD_SA = os.environ.get("FACTORY_KUBE_BUILD_SA", "sf-build")
KUBE_APP_SA = os.environ.get("FACTORY_KUBE_APP_SA", "sf-app")
BUILD_ACTIVE_DEADLINE = int(os.environ.get("FACTORY_BUILD_ACTIVE_DEADLINE", "900"))
BUILD_WALL_CLOCK = int(os.environ.get("FACTORY_BUILD_WALL_CLOCK", "1200"))
DEPLOY_WALL_CLOCK = int(os.environ.get("FACTORY_DEPLOY_WALL_CLOCK", "600"))


def app_deploy_enabled() -> bool:
    """B3 build+deploy is active only with a git backbone AND a registry AND the
    switch. Any one unset -> B2 behavior (merge ends at main)."""
    return bool(GIT_REMOTE_BASE and REGISTRY and APP_DEPLOY)
```

### Step 2 — `transitions.py`: the `deploy` stage + `begin_deploy` transition

Add a `_ev_begin_deploy` event and a transition to `TABLE`:

```python
def _ev_begin_deploy(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "milestone_summary",
         "Merged to main — building and deploying the app",
         stage="deploy", payload={"Stage": "Deploy", "Ref": req.ref, "sha": params.get("sha")})
```

```python
    Transition(
        name="begin_deploy",
        pre=Pre(status_in=(APPROVED,)),
        effects=lambda p: {"gate": None, "stage": "deploy", "status": APPROVED,
                           "stage_entered_at": utcnow()},
        events=_ev_begin_deploy,
        conflict_detail=lambda r: f"Cannot begin deploy from status '{r.status}'",
    ),
```

`finish_done` already accepts `status_in=(APPROVED,)` and any stage → it works from `stage="deploy"` unchanged.

**MSSQL/portability check:** `deploy` is a value in the existing `Request.stage String(16)` and `StageJob.stage String(16)`; `build`/`deploy` fit `StageJob.role String(8)`. No new columns, no migration, no `create_all` change.

### Step 3 (RED→GREEN) — `api/tests/test_deploy_settings.py`

```python
import importlib
from app import settings


def test_deploy_disabled_by_default(monkeypatch):
    for k in ("FACTORY_GIT_REMOTE_BASE", "FACTORY_REGISTRY", "FACTORY_APP_DEPLOY"):
        monkeypatch.delenv(k, raising=False)
    importlib.reload(settings)
    assert settings.app_deploy_enabled() is False


def test_deploy_requires_all_three(monkeypatch):
    monkeypatch.setenv("FACTORY_GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setenv("FACTORY_REGISTRY", "sf-registry:5000")
    monkeypatch.setenv("FACTORY_APP_DEPLOY", "1")
    importlib.reload(settings)
    assert settings.app_deploy_enabled() is True
    monkeypatch.delenv("FACTORY_REGISTRY")
    importlib.reload(settings)
    assert settings.app_deploy_enabled() is False
```

Add to `test_transitions.py`: a case that `begin_deploy` moves `approved/review` → `approved/deploy` and that `finish_done` still closes from `deploy`. Then:

```bash
cd api && uv run pytest -q tests/test_deploy_settings.py tests/test_transitions.py   # EXPECT: all passed
```

**Reload caveat (verify at build time):** `settings` values are module-level reads; other tests already reload/monkeypatch env — the conftest resets env between tests. Confirm `test_deploy_settings.py` restores the default module state (add an autouse reload-back fixture if any downstream test reads `settings.REGISTRY`).

---

## Task 5 — Runner `_drive_deploys` + `approve_merge` fork + gates.py caller fix (unit)

**Goal:** after a real merge, drive **build → deploy → done** on StageJob/observe/reap, env-gated, with escalation + capture-before-delete + cancel teardown. This is the heart of B3.

**Files:** `api/app/kube_runner.py` (edit), `api/app/routers/gates.py` (edit), `api/tests/fake_kube.py` (edit — deploy helpers already added in Task 3; add `honest_build`), `api/tests/test_deploy_runner.py` (new).

### Interfaces / behavior

1. **`approve_merge` fork** — after `merge_graded` succeeds:
   - if `settings.app_deploy_enabled()`: `transitions.apply("begin_deploy", sha=sha)` (stays `approved`, `stage="deploy"`); the merge SHA is the produced-app source and is stored on the first build StageJob's `envelope`.
   - else: current B2 `finish_done` path unchanged.

2. **Generic loops role-filtered** — the three `select(StageJob).where(StageJob.status == "running")` sites gain `.where(StageJob.role.in_(("stage", "gate")))`. Build/deploy rows are owned solely by `_drive_deploys`.

3. **`tick()` gains `self._drive_deploys(db, moved)`** right after `_reap_dead_requests`.

4. **`_drive_deploys`** — for each `Request` with `stage == "deploy"`:
   - cancelled / `needs_human` → `_teardown_app(req)` (delete build Job + `delete_by_label(f"sf/instance={slug}")`), best-effort; return.
   - drive a two-step mini-machine over StageJob rows `role in ("build","deploy")`:
     - no live build row → `_spawn_build` (intent `TRIGGER_BUILD`, key `build:<ref>:<sha>`).
     - build running → observe via `get_job`; wall-clock/absent/fail → capture-before-delete + `_escalate`; success → `parse_digest(termination_message)`; missing digest → escalate ("build image digest could not be captured"); good digest → mark build row `succeeded`, store digest.
     - build succeeded, no deploy row → `_apply_deploy` (intent `APPLY_DEPLOY`, key `deploy:<slug>:<digest>`): `client.apply` each of `deploy_manifests.app_deploy_manifests(slug, digest, replicas)`; create a `role="deploy"` StageJob (deadline = now + `DEPLOY_WALL_CLOCK`).
     - deploy row running → `client.rollout_ready(app_name)`? not yet & past deadline → escalate (capture pod logs via label). ready → `_http_ok(probe_url)`? ok → `finish_done` with `deploy_title="Deployed — <url> is live"` and `payload_extra={"image": ..., "digest": ..., "url": ...}`; probe fail past deadline → escalate.

5. **`_http_ok(url)`** — module-level, `urllib.request.urlopen(url, timeout=5)` → 200; monkeypatchable in tests. Probe URL = in-cluster Service `http://sf-app-<slug>.<ns>.svc:80/health` (factory-api egress is `{}` — allowed).

6. **`gates.py` fix** — audit outcome no longer keys off `status == DONE`:

```python
        if runner_mode() in ("agent", "kube"):
            pipeline().approve_merge(db, r, actor.name)
        else:
            simulator.approve_merge(db, r, actor.name)
        # merge succeeded iff it did not escalate; DONE (B2) or deploy-pending (B3)
        outcome = ("merge_approval_failed" if r.needs_human else "approved_merge")
```

and the replay-routing guard gains `"deploy"`:

```python
    if r.gate == transitions.GATE_APPROVE_MERGE or r.stage in ("review", "deploy", "done"):
```

### Step 1 (RED) — `api/tests/test_deploy_runner.py` (representative cases)

```python
"""B3 build+deploy driver — FakeKubeClient stands in for the cluster, so these
prove the ORCHESTRATOR's guarantees: merge -> build Job -> digest capture ->
factory-owned deploy apply -> rollout wait -> health probe -> done, plus
escalation + capture-before-delete + cancel teardown. Env-gated: unset REGISTRY
keeps B2 (merge -> done) exactly."""
import json

from fake_kube import FakeKubeClient, honest_cluster
from helpers import approved_request
from sqlalchemy import select

from app import deploy_manifests, kube_runner, settings, transitions
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import Request, StageJob

DIGEST = "sha256:" + "d" * 64


def _enable_deploy(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)


def test_merge_disabled_still_ends_at_done(client, monkeypatch):
    # REGISTRY unset -> B2 behavior: no build/deploy rows, request goes straight to done.
    ...  # drive to merge gate, approve, assert status==done and no role=build StageJob


def test_merge_kicks_off_build_then_deploy_to_done(client, monkeypatch, tmp_path):
    _enable_deploy(monkeypatch)
    runner, fake = KubeJobRunner(client=fake := FakeKubeClient()), None
    # ... drive the pipeline to the merge gate with honest_cluster + a real workspace ...
    # approve merge:
    with SessionLocal() as db:
        req = db.scalar(select(Request))
        runner.approve_merge(db, req, "Ada")
        assert req.stage == "deploy" and req.status == transitions.APPROVED

    # tick: spawns the build Job (role=build)
    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(select(StageJob).where(StageJob.role == "build"))
        assert build.status == "running"
    # kaniko reports the digest on the termination message
    fake.finish(f"sf-{req.ref.lower()}-build", {}, phase="succeeded")
    fake.jobs[f"sf-{req.ref.lower()}-build"].termination_message = DIGEST + "\n"

    # tick: captures digest, applies deploy manifests, creates role=deploy row
    with SessionLocal() as db:
        runner.tick(db)
        assert any(o["kind"] == "Deployment" for o in fake.applied)
        deprow = db.scalar(select(StageJob).where(StageJob.role == "deploy"))
        assert deprow.status == "running"
        assert deprow.envelope["digest"] == DIGEST

    # rollout becomes ready + health probe answers -> done
    fake.mark_ready(deploy_manifests.app_name(slug))
    monkeypatch.setattr(kube_runner, "_http_ok", lambda url: True)
    with SessionLocal() as db:
        runner.tick(db)
        req = db.scalar(select(Request))
        assert req.status == transitions.DONE and req.stage == "done"


def test_build_failure_escalates_with_capture(client, monkeypatch):
    _enable_deploy(monkeypatch)
    # build Job phase=failed -> capture-before-delete, needs_human, no deploy applied
    ...


def test_probe_failure_escalates_not_a_silent_half_deploy(client, monkeypatch):
    _enable_deploy(monkeypatch)
    # rollout ready but _http_ok False past the wall clock -> needs_human, app not marked done
    ...


def test_cancel_during_deploy_tears_down_the_app(client, monkeypatch):
    _enable_deploy(monkeypatch)
    # cancel while stage=deploy -> build Job deleted + delete_by_label('sf/instance=<slug>')
    ...
```

(Full bodies mirror the existing `test_kube_runner.py` `tick_until`/`honest_cluster` helpers; the ellipses are filled following the first two concrete cases.)

### Step 2 (GREEN) — `kube_runner.py` additions

`approve_merge` tail change:

```python
        err = workspace.merge_graded(ws, req.ref, sha, actor)
        if err:
            self._escalate(db, req, f"Merge failed: {err}")
            return
        if settings.app_deploy_enabled():
            res = transitions.apply(db, req, "begin_deploy",
                                    actor=transitions.Actor(name=actor), params={"sha": sha})
            if isinstance(res, transitions.Loss):
                log.info("%s: begin_deploy lost (%s)", req.ref, res.detail)
                return
            db.commit()
            log.info("%s merged; build+deploy queued at %s", req.ref, sha[:12])
            return
        # B2 path (unchanged): finish_done ...
```

New methods (abbreviated signatures; full bodies follow the observe/capture patterns already in the file):

```python
import urllib.request

def _http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=5) as r:   # nosec: in-cluster probe
            return 200 <= r.status < 400
    except Exception:
        return False


class KubeJobRunner:
    ...
    def _app_slug(self, req: Request) -> str:
        return (req.app.key if req.app else req.ref.lower())

    def _drive_deploys(self, db, moved):
        if not settings.app_deploy_enabled():
            return
        for req in db.scalars(select(Request).where(Request.stage == "deploy")).all():
            try:
                self._drive_one_deploy(db, req, moved)
            except Exception as exc:
                db.rollback()
                log.exception("deploy driver failed for %s", req.ref)
                self._escalate(db, req, f"Build/deploy failed: {exc}")

    def _drive_one_deploy(self, db, req, moved):
        slug = self._app_slug(req)
        if req.status != transitions.APPROVED or req.needs_human:
            self._teardown_app(db, req, slug)
            return
        rows = db.scalars(select(StageJob).where(
            StageJob.request_id == req.id,
            StageJob.role.in_(("build", "deploy"))).order_by(StageJob.id)).all()
        build = next((r for r in reversed(rows) if r.role == "build"), None)
        deploy = next((r for r in reversed(rows) if r.role == "deploy"), None)
        if build is None or build.status in ("failed", "timed_out", "infra"):
            self._spawn_build(db, req, slug, moved); return
        if build.status == "running":
            self._observe_build(db, req, build, moved); return
        if build.status == "succeeded" and deploy is None:
            self._apply_deploy(db, req, slug, build.envelope["digest"], moved); return
        if deploy is not None and deploy.status == "running":
            self._observe_deploy(db, req, deploy, slug, moved)
    # _spawn_build / _observe_build / _apply_deploy / _observe_deploy / _teardown_app
    # follow the existing _create / capture-before-delete / _escalate / _finish patterns.
```

`_spawn_build` records `TRIGGER_BUILD` (key `build:<ref>:<sha>`), creates a `role="build"` StageJob with the merge SHA stashed on its `envelope={"sha": sha}` (read from the `begin_deploy` milestone event or recomputed via `workspace.head_sha(ws, "main")`), and calls `client.create_job(deploy_manifests.build_job_manifest(...))` through the same `_create` 409/uid ledger.

`_observe_build` uses `get_job(..., capture=True)` on wall-clock/terminal, `parse_digest` on success (missing → escalate), and `delete_job(uid=...)` before recording — capture-before-delete preserved.

`_apply_deploy` records `APPLY_DEPLOY` (key `deploy:<slug>:<digest>`), applies each manifest, and creates the `role="deploy"` StageJob (`envelope={"digest": digest, "image": ...}`).

`_observe_deploy` gates on `rollout_ready` + `_http_ok(f"http://sf-app-{slug}.{settings.KUBE_NAMESPACE}.svc:80/health")`, then `finish_done` with the live URL, else escalates past `DEPLOY_WALL_CLOCK` after capturing pod logs by label.

`_teardown_app` deletes the build Job (by name+uid) and `client.delete_by_label(f"sf/instance={slug}")`.

```bash
cd api && uv run pytest -q tests/test_deploy_runner.py tests/test_kube_runner.py tests/test_api.py
# EXPECT: all passed — the role filter keeps every B1/B2 runner test green
```

**Design note:** the deploy step is a StageJob **without** a k8s Job (it tracks an apply + rollout). It is excluded from `_reap_dead_requests`'s `get_job`/`delete_job` path by the `role in ("stage","gate")` filter, so no phantom `absent` grading — teardown is explicit in `_teardown_app`.

---

## Task 6 — Build Job image path: sf-agent `clone` mode + kaniko contract (docker)

**Goal:** the build Job's `clone` init-container reuses the proven sf-agent image (git, arbitrary-UID) to place the merged-`main` SHA at `/workspace/repo`; kaniko builds it. No new image; one small entrypoint branch.

**Files:** `docker/sf-agent/entrypoint.sh` (edit), `api/tests/test_kube_jobs.py` (edit — assert the build manifest shape via `deploy_manifests`, cross-checked in Task 2), `scripts/build-smoke.sh` (new, opt-in local docker check).

### Step 1 — `entrypoint.sh`: add a `clone` role before the gate branch

```bash
if [ "$SF_ROLE" = "clone" ]; then
  # Build-Job init: place the pinned SHA of main at /workspace/repo for kaniko.
  # No LLM, no push credential — a pure checkout (spec §7 build input = repo+SHA).
  : "${SF_SHA:?}"
  git -C "$REPO" checkout -q "$SF_SHA" || die_stage "build clone: SHA $SF_SHA not found"
  note "build clone ready at $SF_SHA"
  exit 0
fi
```

(placed right after the shared `git clone --branch "$SF_BRANCH"` block, before the `SF_ROLE = gate` branch — `SF_BRANCH=main` is set by the build manifest).

### Step 2 — `scripts/build-smoke.sh` (opt-in; proves the image path with plain docker, no cluster)

```bash
#!/usr/bin/env bash
# Local proof (no kind) that the golden template containerizes and runs its
# /health probe. Not in `task verify` — opt-in, like netpol-smoke.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -t sf-app-smoke:dev sample/
CID=$(docker run -d -p 18000:8000 --user 10101:0 sf-app-smoke:dev)
trap 'docker rm -f "$CID" >/dev/null' EXIT
for _ in $(seq 1 30); do
  curl -sf http://localhost:18000/health && break || sleep 1
done
curl -sf http://localhost:18000/health | grep -q '"status":"ok"' \
  && echo "✓ golden template builds and answers /health as an arbitrary UID"
```

```bash
chmod +x scripts/build-smoke.sh && ./scripts/build-smoke.sh
# EXPECT: ✓ golden template builds and answers /health as an arbitrary UID
```

**Verify at build time:**
- kaniko `--context=dir://` + `--digest-file=/dev/termination-log` + `--insecure --skip-tls-verify` against `sf-registry:5000` — proven in Task 7's cluster run; if kaniko rejects non-root arbitrary UID (layer extraction), fallbacks in order: add `--ignore-path=/var/run`, then `--use-new-run`, then (documented deviation) drop the kaniko container to `runAsUser` matching its writable `/kaniko` while keeping `allowPrivilegeEscalation:false, drop:ALL` — still unprivileged.
- The `clone` init and `build` container share an `emptyDir`; the init writes `/workspace/repo` as UID 10101 (root group, g=u) and kaniko reads it as the same UID — confirm no permission gap.

---

# INTERACTIVE HALF (cluster / LLM)

## Task 7 — kind in-cluster registry + containerd mirror + kaniko load (cluster)

**Goal:** a registry reachable in-cluster for kaniko push and node-side for kubelet pull, using the single image name `sf-registry:5000/...`.

**Files:** `deploy/kind/cluster.yaml` (edit), `deploy/base/registry.yaml` (new), `Taskfile.yml` (edit).

### Step 1 — `deploy/kind/cluster.yaml`: containerd mirror to the in-cluster registry NodePort

Append under the existing config:

```yaml
# Plan B3: the produced-app image name is sf-registry:5000/... for BOTH kaniko
# (push, via cluster DNS) and the kubelet (pull). The node cannot do cluster DNS,
# so redirect that host to the registry's NodePort on localhost.
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."sf-registry:5000"]
      endpoint = ["http://localhost:30500"]
    [plugins."io.containerd.grpc.v1.cri".registry.configs."sf-registry:5000".tls]
      insecure_skip_verify = true
```

### Step 2 — `deploy/base/registry.yaml`: in-cluster registry (ClusterIP + NodePort 30500)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: {name: sf-registry, labels: {app: registry, sf/tier: factory}}
spec:
  replicas: 1
  selector: {matchLabels: {app: registry}}
  template:
    metadata: {labels: {app: registry, sf/tier: factory}}
    spec:
      containers:
        - name: registry
          image: registry:2
          ports: [{containerPort: 5000}]
          resources: {requests: {cpu: 50m, memory: 128Mi}, limits: {cpu: 500m, memory: 512Mi}}
---
apiVersion: v1
kind: Service
metadata: {name: sf-registry, labels: {app: registry}}
spec:
  type: NodePort
  selector: {app: registry}
  ports: [{name: registry, port: 5000, targetPort: 5000, nodePort: 30500}]
```

### Step 3 — `Taskfile.yml`: add kaniko + registry image loads, add registry to base

- `kind-load`: add `docker pull gcr.io/kaniko-project/executor:latest` + `registry:2` then `kind load docker-image ... --name software-factory` (or rely on IfNotPresent + node pull for these two — but pre-loading avoids build-time egress). Also build+load `sf-app` deps are not needed (kaniko builds in-cluster).
- `registry.yaml` is added to `deploy/base/kustomization.yaml` in Task 8.

**Verify at build time (exact commands + expected):**

```bash
task kind-down && task kind-up && task kind-load && task kind-deploy
kubectl -n software-factory rollout status deploy/sf-registry --timeout=120s
# prove push (from an in-cluster pod) + pull (node) with one image name:
kubectl -n software-factory run kaniko-probe --restart=Never --rm -i \
  --image=gcr.io/kaniko-project/executor:latest --overrides='{"spec":{"serviceAccountName":"sf-build"}}' -- \
  --context=... --destination=sf-registry:5000/probe:1 --insecure --skip-tls-verify
kubectl -n software-factory run pull-probe --image=sf-registry:5000/probe:1 --restart=Never
kubectl -n software-factory get pod pull-probe -w   # EXPECT: Running (node pulled via the mirror)
```

If push fails to resolve `sf-registry`: confirm CoreDNS in-namespace short-name resolution (`kubectl -n software-factory exec deploy/sf-registry -- getent hosts sf-registry`); if node pull fails: `docker exec software-factory-control-plane cat /etc/containerd/config.toml | grep -A2 sf-registry` and confirm the mirror patch landed. Fallback recorded: the official host-container `kind-registry` recipe with `--destination=kind-registry:5000` for kaniko and `localhost:5001/...` in deploy manifests (two-name variant), if the NodePort mirror proves flaky.

---

## Task 8 — Deploy YAML: registry, SAs, RBAC, build-walls / app-walls, ConfigMap gates (cluster)

**Files:** `deploy/base/serviceaccounts.yaml` (edit), `deploy/base/rbac.yaml` (edit), `deploy/base/networkpolicies.yaml` (edit), `deploy/base/configmap.yaml` (edit), `deploy/base/kustomization.yaml` (edit).

### Step 1 — ServiceAccounts: add `sf-build`, `sf-app` (zero RBAC, no token)

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata: {name: sf-build}
automountServiceAccountToken: false
---
apiVersion: v1
kind: ServiceAccount
metadata: {name: sf-app}
automountServiceAccountToken: false
```

### Step 2 — RBAC: sf-api gains factory-owned deploy (in-namespace, label-scoped teardown)

Append rules to the `sf-api-jobs` Role (or a new `sf-api-deploy` Role bound to `sf-api`):

```yaml
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["create", "get", "list", "watch", "patch", "delete", "deletecollection"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["create", "get", "list", "patch", "delete"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["create", "get", "list", "patch", "delete", "deletecollection"]
```

**Note (documented, per constraint "still label-scoped as far as k8s allows"):** k8s RBAC cannot restrict `create` by label; scoping is by **namespace + resource type**. Teardown uses `deletecollection` with a `labelSelector` (`sf/instance=<slug>`), which *is* label-scoped. The factory only ever applies `sf-app-<slug>` names from `deploy_manifests` (allowlisted), so the blast radius is the produced-app objects it owns.

### Step 3 — NetworkPolicies: `build-walls` + `app-walls` (+ registry ingress)

```yaml
---
# build pods: git (clone init) + registry (kaniko push) + DNS. NO LLM, no peers.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: build-walls}
spec:
  podSelector: {matchLabels: {sf/role: build}}
  policyTypes: [Ingress, Egress]     # no ingress rules = nothing dials in
  egress:
    - to: [{podSelector: {matchLabels: {app: api}}}]        # git-daemon clone
      ports: [{protocol: TCP, port: 9418}]
    - to: [{podSelector: {matchLabels: {app: registry}}}]   # kaniko push
      ports: [{protocol: TCP, port: 5000}]
---
# produced-app pods: ingress from ingress-nginx ONLY; egress DNS ONLY.
# spec §2: no factory, no peers.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: app-walls}
spec:
  podSelector: {matchLabels: {sf/tier: app}}
  policyTypes: [Ingress, Egress]
  ingress:
    - from: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: ingress-nginx}}}]
      ports: [{protocol: TCP, port: 8000}]
  egress: []                          # DNS is granted by the shared allow-dns policy
---
# the registry accepts pushes from build pods and pulls from the node (NodePort).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: registry-walls}
spec:
  podSelector: {matchLabels: {app: registry}}
  policyTypes: [Ingress]
  ingress:
    - from: [{podSelector: {matchLabels: {sf/role: build}}}]
      ports: [{protocol: TCP, port: 5000}]
    - {ports: [{protocol: TCP, port: 5000}]}   # node NodePort pull (source is off-mesh)
```

**Note:** `allow-dns` (existing, `podSelector: {}`) already grants DNS to app/build pods. The `factory-api` probe to the produced app relies on `api-walls` `egress: [{}]` (already all-allow) — no change.

### Step 4 — ConfigMap: turn B3 on for the local overlay

Add to `factory-config`:

```yaml
  FACTORY_REGISTRY: "sf-registry:5000"
  FACTORY_APP_DEPLOY: "1"
  FACTORY_KANIKO_IMAGE: "gcr.io/kaniko-project/executor:latest"
  FACTORY_APP_INGRESS_DOMAIN: "localtest.me"
```

### Step 5 — kustomization: add `registry.yaml`

Add `registry.yaml` to `deploy/base/kustomization.yaml` `resources:`.

**Verify at build time:**

```bash
kubectl apply -k deploy/overlays/local && ./scripts/netpol-smoke.sh
# EXPECT: netpol smoke still green (existing walls unaffected)
# add to netpol-smoke (Task 9): a build pod -> factory-api:8000 must FAIL;
#                                an app pod  -> git-daemon:9418 must FAIL.
```

---

## Task 9 — Extend `kind-smoke`: pod Running + HTTP via ingress + app walls (cluster+LLM)

**Files:** `scripts/kind-smoke.sh` (edit), `scripts/netpol-smoke.sh` (edit).

### Step 1 — `kind-smoke.sh`: after `done`, prove the produced app runs and answers

Replace the B2 tail ("the merge is REAL … main moved") assertion set with the B3 milestone (keep the merge-commit check, add build/deploy):

```bash
echo "▸ the produced app was built and deployed (Plan B3)"
SLUG=northwind
# 1) the build Job ran and was reaped (capture-before-delete)
kubectl -n $NS get jobs -o name | grep -q "sf-$LREF-build" \
  && fail "build Job left behind (not reaped)"
# 2) the app Deployment rolled out
kubectl -n $NS rollout status deploy/sf-app-$SLUG --timeout=180s \
  || fail "produced-app Deployment did not become available"
kubectl -n $NS get pod -l sf/instance=$SLUG \
  -o jsonpath='{.items[0].status.phase}' | grep -qx Running \
  || fail "produced-app pod is not Running"
# 3) it answers HTTP THROUGH THE INGRESS
for _ in $(seq 1 30); do
  curl -sf "http://$SLUG.localtest.me:8081/health" >/dev/null && break || sleep 2
done
curl -sf "http://$SLUG.localtest.me:8081/health" | jqpy 'assert d["status"]=="ok"' \
  || fail "produced app /health did not answer through the ingress"
ok "produced app pod Running and /health answers through the ingress"
# 4) the image is digest-pinned to what the factory built
kubectl -n $NS get deploy/sf-app-$SLUG -o jsonpath='{.spec.template.spec.containers[0].image}' \
  | grep -q "sf-registry:5000/sf-app-$SLUG@sha256:" \
  || fail "app image is not digest-pinned to the local registry"
ok "app image is digest-pinned (sf-registry:5000/sf-app-$SLUG@sha256:…)"
```

Update the final banner to `✓ KIND SMOKE PASSED — one request end-to-end: intake → merged main → built image → live pod (Plan B3 / spec §9 Phase-1 milestone)`.

### Step 2 — `netpol-smoke.sh`: prove the two new walls

Add: a throwaway pod labeled `sf/tier: app` must **fail** to reach `api:9418` and `api:8000`; a pod labeled `sf/role: build` must **fail** to reach `api:8000` (factory) but **succeed** to `sf-registry:5000`. These mirror the existing "agent → factory-api must FAIL" assertion (spec §2 deploy-verify).

```bash
task kind-smoke
# EXPECT (10-25 min, spends codex): every ✓, ending in the Plan B3 banner
```

---

## Task 10 — Docs + full verify + commit (docs)

**Files:** `AGENTS.md` (edit §7), `implementation-notes.md` (append `## Plan B3`), `Taskfile.yml` (add `build-smoke`), plan self-review.

- `AGENTS.md` §7: extend the kube paragraph — B3 made the produced app run: `deploy_manifests.py` (factory-owned build+deploy manifests, allowlist), the in-cluster `sf-registry` + containerd mirror, `sf/role: build` + `sf/tier: app` walls, and the deploy driver (`kube_runner._drive_deploys`). Cluster + build tests remain opt-in (`scripts/build-smoke.sh`, `task kind-smoke`); `task verify` stays cluster-free.
- `implementation-notes.md`: record kaniko/registry versions actually used, the kaniko-arbitrary-UID resolution taken (or deviation), smoke duration + codex cost, and any containerd-mirror deviation.

```bash
task verify
# EXPECT: green — the new unit suites (test_golden_template, test_deploy_manifests,
# test_kube_client_seam, test_deploy_settings, test_deploy_runner) run under it;
# build-smoke/kind-smoke are NOT in the chain (CI stays cluster-free)
```

Commit (branch first — on `main`):

```bash
git add sample/ api/app/deploy_manifests.py api/app/kube_client.py api/app/kube_jobs.py \
  api/app/kube_runner.py api/app/settings.py api/app/transitions.py api/app/routers/gates.py \
  api/tests/ deploy/ scripts/build-smoke.sh scripts/kind-smoke.sh scripts/netpol-smoke.sh \
  Taskfile.yml AGENTS.md implementation-notes.md
git commit -m "feat(deploy): produced-app build+deploy — kaniko Job to a local registry, factory-owned digest-pinned manifests, live pod through the ingress (Plan B3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Design decisions made while planning (resolutions of spec/code gaps)

1. **The built artifact is a container image of a FastAPI app.** `sample/` gains `app.py` (`/health` + domain routes), `requirements.txt`, and a `Dockerfile`; these are **not** under `workspace.SURFACE_PATHS`, so the frozen-surface hash and the RED/GREEN/review pipeline (which only touch `tests/` + `src/expenses.py`) are unchanged. `/health` is the deploy-verify probe.

2. **In-cluster registry with a containerd NodePort mirror — single image name both sides.** Rejected the official kind host-container recipe because it forces two different image-name hosts (`kind-registry:5000` for in-cluster push vs `localhost:5001` for pull) and can't be NetworkPolicy-selected by pod label. The in-cluster `sf-registry` Service is cluster-DNS-reachable by kaniko and node-reachable via a `containerdConfigPatches` mirror to its NodePort, so **one** name `sf-registry:5000/...` works for push, pull, and NetworkPolicy. The host-container variant is the recorded fallback.

3. **kaniko in a normal (non-privileged) Job, digest via the termination message.** kaniko's premise is no privileged mode; the build container keeps `allowPrivilegeEscalation:false, drop:ALL`, arbitrary UID. The pushed **digest** is captured with `--digest-file=/dev/termination-log` and parsed by `parse_digest` (a sibling of `parse_envelope`) — reusing the exact capture-before-delete machinery, no new channel. Arbitrary-UID kaniko is the one item flagged **verify at build time** with an ordered fallback.

4. **Build reuses the sf-agent image as a `clone` init-container.** No new base image and no new clone logic — a five-line `SF_ROLE=clone` branch in the proven entrypoint places the merged-`main` SHA at `/workspace/repo`; kaniko builds `--context=dir://`. The build Job is `clone (sf-agent) → build (kaniko)`.

5. **Deploy is a StageJob with `role="deploy"` but no k8s Job** — it tracks an apply + rollout + probe. Build/deploy rows are hidden from every B1/B2 loop by a `role in ("stage","gate")` filter, so `GIT_REMOTE_BASE`/`FACTORY_REGISTRY` unset is byte-for-byte B1/B2. This satisfies "reuse StageJob/observe/reap" without a phantom `absent`-grading path.

6. **New `deploy` Request stage + `begin_deploy` transition; `finish_done` reused.** No schema change (`stage`/`role` are free-text `String` columns already sized for `"deploy"`/`"build"`). After a real merge the request sits in `approved/deploy` while build+deploy run, then `finish_done` closes it with the live URL.

7. **Allowlist by construction.** `deploy_manifests` interpolates only `slug` (RFC1123 label regex), `digest` (`sha256:` + 64 hex), and `replicas` (clamped 1–5); the app repo's own `deploy/` is never read (spec §7 "documentation, not input"). A validating renderer with request-supplied params is deferred.

8. **B3 drives build→deploy automatically after the single merge gate — no second `approve-deploy` human gate yet.** Spec §4.10 lists a second console gate; the B3 task scope explicitly says "after `approve_merge`, drive build → deploy." Adding the second gate is a small later transition (`begin_deploy` becomes gate-raising) and is deferred to keep B3 to one behavioral change. Recorded so nobody mistakes its absence for an oversight.

9. **Caller audit/replay fix (found in code).** `routers/gates.py` recorded merge success as `status == DONE`; with a deploy-pending state that misfires. Changed to `merge_approval_failed` iff `needs_human`, and added `"deploy"` to the merge-replay stage guard. Without this fix a successful B3 merge would be audited as a failure.

10. **Factory-api does the deploy apply (no separate deploy SA locally).** Spec §7 mentions a scoped deploy SA; the task scope says "RBAC additions for the sf-api SA." Local profile keeps one SA (`sf-api`) with namespaced Deployment/Service/Ingress verbs + label-scoped `deletecollection` for teardown. The dedicated deploy SA is an OpenShift-overlay refinement (Phase 2).

11. **`FACTORY_REGISTRY` + `FACTORY_APP_DEPLOY` are the env gates**, mirroring `GIT_REMOTE_BASE`. `app_deploy_enabled()` requires all three; any unset ⇒ B2 (merge ends at main). CI/`task verify` never set them, so they stay cluster-free.

12. **The runner's health probe hits the in-cluster Service; the smoke hits the ingress.** `factory-api` egress is already all-allowed (`api-walls`), so `_http_ok(http://sf-app-<slug>.<ns>.svc/health)` is the runner's verify; the external ingress path (`<slug>.localtest.me:8081`) is the smoke's independent proof (spec §7 "health probe through ingress").

---

## Self-review (writing-plans checklist)

- **Spec coverage (B3 slice of §2/§4/§7/§9):** golden template that containerizes (Dockerfile + tests layout versioned together) → Task 1; kaniko build Job at the merge SHA, digest recorded via intent log (`TRIGGER_BUILD`) → Tasks 2/5/6; factory-owned deploy, allowlisted params, applied by the factory SA, app `deploy/` ignored (`APPLY_DEPLOY`) → Tasks 2/5/8; verify = rollout wait + health probe through ingress, failure → `needs_human` with logs, never a silent half-deploy → Tasks 5/9; `sf/tier: app` + `sf/instance` labels, app-walls (no factory/peers, DNS only), build-walls (registry+git, no LLM) → Tasks 2/8; per-tier SAs with `automountServiceAccountToken:false` + factory-api RBAC (namespaced + label-scoped teardown) → Task 8; backoffLimit0/activeDeadline/resources/non-root/capture-before-delete on the build Job → Tasks 2/5; one-request end-to-end to a **live pod** → Task 9. Deferred with reasons: GitHub flow, second approve-deploy gate, openshift/aks build seams, Prometheus, Azure SQL, gitleaks (decisions 8, 10; Scope-out list).
- **Autonomous/interactive split:** Tasks 1–6 need no cluster and no user (unit + local docker); Tasks 7–10 need kind + a codex-spending run — mirrors B2's split.
- **Placeholder scan:** every unit task carries full RED tests + GREEN source; cluster tasks carry exact YAML + commands + expected output. The **verify-at-build-time** items are explicit and bounded: kaniko arbitrary-UID (ordered fallback), server-side apply content-type (create/replace fallback), registry DNS/mirror resolution (host-container fallback), requirements.txt pins — each a loud-failure check, not a TBD.
- **Type consistency:** `apply(manifest)->None`, `rollout_ready(name)->bool`, `delete_by_label(selector)->None` defined in Task 3 (Protocol + Fake + Real) and consumed identically in Task 5; `parse_digest(msg)->str|None` defined in Task 3, used in Task 5; `build_job_manifest(ref,slug,sha)` / `app_deploy_manifests(slug,digest,replicas)` defined in Task 2, called in Task 5; `settings.REGISTRY/APP_DEPLOY/app_deploy_enabled()/KANIKO_IMAGE/KUBE_BUILD_SA/KUBE_APP_SA/APP_INGRESS_DOMAIN/BUILD_*` defined in Task 4, referenced in Tasks 2/5/8; env names (`SF_ROLE=clone`, `SF_SHA`, `SF_BRANCH=main`, `--digest-file=/dev/termination-log`) match between Task 2 manifest, Task 6 entrypoint, and Task 3 parser; the image name `sf-registry:5000/sf-app-<slug>@<digest>` is identical in Task 2 (destination/deploy), Task 7 (mirror key), and Task 9 (smoke assertion); `StageJob.role` values `"build"`/`"deploy"` and `Request.stage="deploy"` are consistent across Tasks 4/5 and the loop filters.

---

### Critical Files for Implementation
- api/app/kube_runner.py (approve_merge fork + `_drive_deploys` build/deploy driver + role-filtered loops)
- api/app/deploy_manifests.py (new — factory-owned build Job + app Deployment/Service/Ingress, allowlist)
- api/app/kube_client.py (seam v3: apply / rollout_ready / delete_by_label + `parse_digest` in kube_jobs.py)
- deploy/base/networkpolicies.yaml (build-walls + app-walls + registry-walls) and deploy/base/registry.yaml + deploy/kind/cluster.yaml (containerd mirror)
- scripts/kind-smoke.sh (extend: produced-app pod Running + HTTP through the ingress) with sample/ (Dockerfile + app.py) as the containerized template
