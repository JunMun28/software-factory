"""The Kubernetes seam (Plan B1; spec §5): everything cluster-shaped behind a
3-method protocol so the entire runner is testable with a fake — no kind, no
cluster, no kubeconfig in tests.

RealKubeClient is deliberately THIN (AGENTS.md: deterministic seams are
disposable, the domain model is not): it maps the protocol onto the official
client and holds zero domain logic. The `kubernetes` import is lazy — only a
process actually running FACTORY_RUNNER=kube ever pays it.
"""

from dataclasses import dataclass
from typing import Protocol

from . import settings


@dataclass
class JobView:
    """One observation of a Job: phase + the two capture channels (spec §5) —
    the ≤4KB termination-message envelope and the NDJSON pod logs."""

    name: str
    phase: str
    termination_message: str = ""
    logs: str = ""


class KubeClient(Protocol):
    def create_job(self, manifest: dict) -> None: ...

    def get_job(self, name: str) -> JobView: ...

    def delete_job(self, name: str) -> None: ...


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
        self._ApiException = client.exceptions.ApiException

    def create_job(self, manifest: dict) -> None:
        try:
            self._batch.create_namespaced_job(self.ns, manifest)
        except self._ApiException as e:
            if e.status != 409:
                raise

    def get_job(self, name: str) -> JobView:
        try:
            job = self._batch.read_namespaced_job(name, self.ns)
        except self._ApiException as e:
            if e.status == 404:
                return JobView(name=name, phase="absent")
            raise
        status = job.status
        phase = "succeeded" if status.succeeded else "failed" if status.failed else "running"
        termination_message, logs = "", ""
        if phase != "running":
            pods = self._core.list_namespaced_pod(
                self.ns, label_selector=f"job-name={name}"
            ).items
            if pods:
                pod = pods[-1]
                for container_status in pod.status.container_statuses or []:
                    terminated = container_status.state.terminated
                    if terminated and terminated.message:
                        termination_message = terminated.message
                try:
                    logs = self._core.read_namespaced_pod_log(pod.metadata.name, self.ns)
                except self._ApiException:
                    logs = ""
        return JobView(
            name=name,
            phase=phase,
            termination_message=termination_message,
            logs=logs,
        )

    def delete_job(self, name: str) -> None:
        try:
            self._batch.delete_namespaced_job(
                name, self.ns, propagation_policy="Foreground"
            )
        except self._ApiException as e:
            if e.status != 404:
                raise
