"""FakeKubeClient — the whole cluster in a dict for kube-runner tests."""

import json
from dataclasses import dataclass, field

from app.kube_client import JobView

SURFACE = "a" * 64
GOOD_METRICS = {
    "tests_passed": 3,
    "tests_total": 3,
    "diff_added": 40,
    "diff_removed": 2,
    "files_changed": 2,
    "reviewer_verdict": "APPROVE — implements the spec",
}


def pass_verdict(*, surface_hash: str = SURFACE, metrics: dict | None = None) -> dict:
    return {
        "v": 1,
        "outcome": "pass",
        "reason": "gate green",
        "surface_hash": surface_hash,
        "metrics": metrics or dict(GOOD_METRICS),
    }


def fail_verdict(reason: str) -> dict:
    return {
        "v": 1,
        "outcome": "fail",
        "reason": reason,
        "surface_hash": None,
        "metrics": None,
    }


def stage_ok(detail: str = "stage complete") -> dict:
    return {"v": 1, "outcome": "ok", "detail": detail}


@dataclass
class FakeJob:
    manifest: dict
    phase: str = "running"
    termination_message: str = ""
    logs: str = ""
    deleted: bool = False


@dataclass
class FakeKubeClient:
    jobs: dict[str, FakeJob] = field(default_factory=dict)
    creations: list[dict] = field(default_factory=list)
    deletions: list[str] = field(default_factory=list)
    observations: list[str] = field(default_factory=list)
    raise_once: set[str] = field(default_factory=set)
    raise_always: set[str] = field(default_factory=set)
    on_observe = None

    def create_job(self, manifest: dict) -> None:
        name = manifest["metadata"]["name"]
        existing = self.jobs.get(name)
        assert existing is None or existing.deleted, f"duplicate live job {name}"
        self.jobs[name] = FakeJob(manifest=manifest)
        self.creations.append(manifest)

    def get_job(self, name: str) -> JobView:
        self.observations.append(name)
        if name in self.raise_once:
            self.raise_once.remove(name)
            raise RuntimeError(f"one-shot observation failure for {name}")
        if name in self.raise_always:
            raise RuntimeError(f"persistent observation failure for {name}")
        job = self.jobs.get(name)
        if job is None or job.deleted:
            return JobView(name=name, phase="absent")
        if self.on_observe:
            self.on_observe(name, job)
        return JobView(
            name=name,
            phase=job.phase,
            termination_message=job.termination_message,
            logs=job.logs,
        )

    def delete_job(self, name: str) -> None:
        self.deletions.append(name)
        job = self.jobs.get(name)
        if job:
            job.deleted = True

    def finish(
        self,
        name: str,
        envelope: dict,
        *,
        phase: str = "succeeded",
        logs: str = "",
    ) -> None:
        job = self.jobs[name]
        assert not job.deleted, f"finishing a deleted job {name}"
        job.phase = phase
        job.termination_message = json.dumps(envelope)
        job.logs = logs


def _complete(job: FakeJob, envelope: dict) -> None:
    job.phase = "succeeded"
    job.termination_message = json.dumps(envelope)
    job.logs = '{"type":"note","text":"ndjson line"}\n'


def honest_cluster(fake: FakeKubeClient) -> None:
    """Make every agent Job succeed and every gate pass consistently."""

    def run(name: str, job: FakeJob) -> None:
        if job.phase != "running":
            return
        _complete(job, pass_verdict() if name.endswith("-gate") else stage_ok())

    fake.on_observe = run
