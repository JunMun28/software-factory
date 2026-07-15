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


class KubeClient(Protocol):
    def create_job(self, manifest: dict) -> str | None: ...

    def get_job(self, name: str, *, capture: bool = False) -> JobView: ...

    def delete_job(self, name: str, *, uid: str | None = None) -> None: ...


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
        self._types = client
        self._ApiException = client.exceptions.ApiException

    def create_job(self, manifest: dict) -> str | None:
        """Returns the created Job's uid. None = 409: a live Job with this
        name already exists — the CALLER decides whether that is its own
        intent replay (adopt) or a dying predecessor (park and re-run)."""
        try:
            job = self._batch.create_namespaced_job(self.ns, manifest)
            return job.metadata.uid or ""
        except self._ApiException as e:
            if e.status != 409:
                raise
            return None

    def get_job(self, name: str, *, capture: bool = False) -> JobView:
        try:
            job = self._batch.read_namespaced_job(name, self.ns)
        except self._ApiException as e:
            if e.status == 404:
                return JobView(name=name, phase="absent")
            raise
        status = job.status
        phase = "succeeded" if status.succeeded else "failed" if status.failed else "running"
        uid = job.metadata.uid or ""
        termination_message, logs = "", ""
        if capture or phase != "running":
            pods = self._core.list_namespaced_pod(
                self.ns, label_selector=f"job-name={name}"
            ).items
            pods.sort(key=lambda p: p.metadata.creation_timestamp or 0)
            if pods:
                pod = pods[-1]
                for container_status in pod.status.container_statuses or []:
                    terminated = container_status.state.terminated
                    if terminated and terminated.message:
                        termination_message = terminated.message
                try:
                    # read_namespaced_pod_log works on RUNNING pods too — the
                    # B1 gap: wall-clock kills and reaps can now capture output
                    logs = self._core.read_namespaced_pod_log(pod.metadata.name, self.ns)
                except self._ApiException:
                    logs = ""
        return JobView(
            name=name,
            phase=phase,
            uid=uid,
            termination_message=termination_message,
            logs=logs,
        )

    def delete_job(self, name: str, *, uid: str | None = None) -> None:
        kwargs = {"propagation_policy": "Foreground"}
        if uid:
            kwargs["body"] = self._types.V1DeleteOptions(
                preconditions=self._types.V1Preconditions(uid=uid)
            )
        try:
            self._batch.delete_namespaced_job(name, self.ns, **kwargs)
        except self._ApiException as e:
            if e.status != 404:
                raise
