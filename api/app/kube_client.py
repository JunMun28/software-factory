"""The Kubernetes seam (Plan B1; spec §5): everything cluster-shaped behind a
3-method protocol so the entire runner is testable with a fake — no kind, no
cluster, no kubeconfig in tests.

RealKubeClient is deliberately THIN (AGENTS.md: deterministic seams are
disposable, the domain model is not): it maps the protocol onto the official
client and holds zero domain logic. The `kubernetes` import is lazy — only a
process actually running FACTORY_RUNNER=kube ever pays it.

Running-pod capture is best-effort but real: callers can opt into pod-log
transfer before a Job reaches a terminal phase.
"""

import contextlib
from dataclasses import dataclass
from typing import Protocol

from . import settings


@dataclass
class JobView:
    """One observation of a Job: phase + uid + the two capture channels
    (spec §5) — the ≤4KB termination-message envelope and NDJSON pod logs.
    uid disambiguates same-name recreates (deterministic names are reused
    across infra re-runs)."""

    name: str
    phase: str
    uid: str = ""
    termination_message: str = ""
    logs: str = ""
    reason: str = ""
    exit_code: int | None = None


class KubeTimeout(Exception):
    """A cluster API call returned no usable answer within its client bound."""


class KubeClient(Protocol):
    def create_job(self, manifest: dict) -> str | None: ...

    def get_job(
        self, name: str, *, capture: bool = False, probe: bool = False
    ) -> JobView: ...

    def delete_job(self, name: str, *, uid: str | None = None) -> None: ...

    # --- Plan B3: factory-owned deploy of produced apps ---
    def apply(self, manifest: dict) -> None: ...  # server-side apply, create-or-update

    def rollout_ready(self, name: str) -> bool: ...  # Deployment fully rolled out

    def delete_by_label(self, selector: str) -> None: ...  # produced-app teardown


class RealKubeClient:
    """Official python client; in-cluster config first, kubeconfig fallback."""

    def __init__(self, namespace: str = settings.KUBE_NAMESPACE):
        from kubernetes import client, config

        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        self.ns = namespace
        self._batch = client.BatchV1Api()
        self._core = client.CoreV1Api()
        self._apps = client.AppsV1Api()
        self._net = client.NetworkingV1Api()
        self._types = client
        self._ApiException = client.exceptions.ApiException

        import urllib3

        self._request_timeout = (
            settings.KUBE_CONNECT_TIMEOUT,
            settings.KUBE_READ_TIMEOUT,
        )
        self._timeout_excs = (
            urllib3.exceptions.TimeoutError,
            urllib3.exceptions.MaxRetryError,
            urllib3.exceptions.ProtocolError,
            TimeoutError,
        )

    @contextlib.contextmanager
    def _bounded(self, op: str):
        try:
            yield
        except self._timeout_excs as exc:
            raise KubeTimeout(
                f"kube {op} exceeded client timeout {self._request_timeout}: "
                f"{type(exc).__name__}"
            ) from exc

    def create_job(self, manifest: dict) -> str | None:
        """Returns the created Job's uid. None = 409: a live Job with this
        name already exists — the CALLER decides whether that is its own
        intent replay (adopt) or a dying predecessor (park and re-run)."""
        try:
            with self._bounded("create_job"):
                job = self._batch.create_namespaced_job(
                    self.ns,
                    manifest,
                    _request_timeout=self._request_timeout,
                )
            return job.metadata.uid or ""
        except self._ApiException as e:
            if e.status != 409:
                raise
            return None

    def get_job(
        self, name: str, *, capture: bool = False, probe: bool = False
    ) -> JobView:
        with self._bounded("read_job"):
            try:
                job = self._batch.read_namespaced_job(
                    name,
                    self.ns,
                    _request_timeout=self._request_timeout,
                )
            except self._ApiException as e:
                if e.status == 404:
                    return JobView(name=name, phase="absent")
                raise
        status = job.status
        phase = "succeeded" if status.succeeded else "failed" if status.failed else "running"
        uid = job.metadata.uid or ""
        termination_message, logs, reason, exit_code = "", "", "", None
        read_pods = capture or probe or phase != "running"
        read_logs = capture or phase != "running"
        if read_pods:
            with self._bounded("list_pods"):
                pods = self._core.list_namespaced_pod(
                    self.ns,
                    label_selector=f"job-name={name}",
                    _request_timeout=self._request_timeout,
                ).items
            pods.sort(key=lambda p: p.metadata.creation_timestamp or 0)
            if pods:
                pod = pods[-1]
                for cs in pod.status.container_statuses or []:
                    state = cs.state
                    if state.terminated:
                        if state.terminated.message:
                            termination_message = state.terminated.message
                        if state.terminated.reason and not reason:
                            reason = state.terminated.reason
                        if (
                            state.terminated.exit_code is not None
                            and exit_code is None
                        ):
                            exit_code = state.terminated.exit_code
                    elif state.waiting and state.waiting.reason and not reason:
                        reason = state.waiting.reason
                if not reason:
                    for cond in pod.status.conditions or []:
                        if (
                            cond.type == "PodScheduled"
                            and cond.status != "True"
                            and cond.reason
                        ):
                            reason = cond.reason
                            break
                if read_logs:
                    try:
                        with self._bounded("read_pod_log"):
                            logs = self._core.read_namespaced_pod_log(
                                pod.metadata.name,
                                self.ns,
                                _request_timeout=self._request_timeout,
                            )
                    except (self._ApiException, KubeTimeout):
                        logs = ""
        return JobView(
            name=name,
            phase=phase,
            uid=uid,
            termination_message=termination_message,
            logs=logs,
            reason=reason,
            exit_code=exit_code,
        )

    def delete_job(self, name: str, *, uid: str | None = None) -> None:
        # Foreground GC must live INSIDE V1DeleteOptions: when a body is present
        # the apiserver ignores the propagation_policy query param, and batch/v1
        # Jobs then default to Orphan GC — which strands the pods (found live:
        # 31 ownerless sf-req-* pods after 15h). The uid precondition still
        # guards against deleting a same-named replacement Job.
        body = self._types.V1DeleteOptions(propagation_policy="Foreground")
        if uid:
            body.preconditions = self._types.V1Preconditions(uid=uid)
        try:
            with self._bounded("delete_job"):
                self._batch.delete_namespaced_job(
                    name,
                    self.ns,
                    body=body,
                    _request_timeout=self._request_timeout,
                )
        except self._ApiException as e:
            if e.status != 404:
                raise

    # ---------- Plan B3: factory-owned deploy of produced apps ----------
    def apply(self, manifest: dict) -> None:
        """Server-side apply (create-or-update, factory field-manager) for the
        kinds the deploy template emits. force=True resolves our own re-applies."""
        kind = manifest["kind"]
        name = manifest["metadata"]["name"]
        patch = {
            "Deployment": self._apps.patch_namespaced_deployment,
            "Service": self._core.patch_namespaced_service,
            "Ingress": self._net.patch_namespaced_ingress,
            "NetworkPolicy": self._net.patch_namespaced_network_policy,
        }[kind]
        with self._bounded("apply"):
            patch(
                name,
                self.ns,
                manifest,
                field_manager="software-factory",
                force=True,
                _content_type="application/apply-patch+yaml",
                _request_timeout=self._request_timeout,
            )

    def rollout_ready(self, name: str) -> bool:
        try:
            with self._bounded("rollout_ready"):
                d = self._apps.read_namespaced_deployment_status(
                    name,
                    self.ns,
                    _request_timeout=self._request_timeout,
                )
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
        # Same Orphan-default trap as delete_job (DEPLOY-03): a collection delete
        # without Foreground propagation orphans the Deployment's ReplicaSets and
        # Pods. Pass it in the body so the produced-app teardown actually reaps.
        fg = self._types.V1DeleteOptions(propagation_policy="Foreground")
        with self._bounded("delete_by_label"):
            self._apps.delete_collection_namespaced_deployment(
                self.ns,
                label_selector=selector,
                body=fg,
                _request_timeout=self._request_timeout,
            )
            services = self._core.list_namespaced_service(
                self.ns,
                label_selector=selector,
                _request_timeout=self._request_timeout,
            ).items
            for item in services:
                self._core.delete_namespaced_service(
                    item.metadata.name,
                    self.ns,
                    _request_timeout=self._request_timeout,
                )
            self._net.delete_collection_namespaced_ingress(
                self.ns,
                label_selector=selector,
                body=fg,
                _request_timeout=self._request_timeout,
            )
