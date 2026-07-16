"""FakeKubeClient — the whole cluster in a dict for kube-runner tests."""

import json
from dataclasses import dataclass, field
from pathlib import Path

from app.kube_client import JobView
from app.ws_exec import _git

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
    uid: str
    phase: str = "running"
    termination_message: str = ""
    logs: str = ""
    reason: str = ""
    exit_code: int | None = None
    scheduling_reason: str = ""
    deleted: bool = False


@dataclass
class FakeKubeClient:
    jobs: dict[str, FakeJob] = field(default_factory=dict)
    creations: list[dict] = field(default_factory=list)
    deletions: list[str] = field(default_factory=list)
    deletion_uids: list[tuple[str, str | None]] = field(default_factory=list)
    observations: list[str] = field(default_factory=list)
    raise_once: set[str] = field(default_factory=set)
    raise_always: set[str] = field(default_factory=set)
    conflicts: set[str] = field(default_factory=set)  # next create of NAME → 409 (None)
    on_observe = None
    _uid_seq: int = 0
    # --- Plan B3 additions: apply / rollout / label teardown ---
    applied: list = field(default_factory=list)
    objects: dict = field(default_factory=dict)  # "Kind/name" -> manifest
    _ready: set = field(default_factory=set)
    label_deletions: list[str] = field(default_factory=list)

    def _next_uid(self) -> str:
        self._uid_seq += 1
        return f"uid-{self._uid_seq}"

    def create_job(self, manifest: dict) -> str | None:
        name = manifest["metadata"]["name"]
        if name in self.conflicts:
            self.conflicts.remove(name)
            return None  # 409: a live same-name Job exists (self.jobs[name])
        existing = self.jobs.get(name)
        assert existing is None or existing.deleted, f"duplicate live job {name}"
        job = FakeJob(manifest=manifest, uid=self._next_uid())
        self.jobs[name] = job
        self.creations.append(manifest)
        return job.uid

    def get_job(
        self, name: str, *, capture: bool = False, probe: bool = False
    ) -> JobView:
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
        terminal = job.phase in ("succeeded", "failed")
        read_pods = capture or probe or terminal
        pending_reason = (
            job.scheduling_reason
            if read_pods and job.phase == "running"
            else ""
        )
        return JobView(
            name=name,
            phase=job.phase,
            uid=job.uid,
            termination_message=job.termination_message if terminal else "",
            logs=job.logs if (capture or terminal) else "",
            reason=job.reason if terminal else pending_reason,
            exit_code=job.exit_code if terminal else None,
        )

    def delete_job(self, name: str, *, uid: str | None = None) -> None:
        self.deletions.append(name)
        self.deletion_uids.append((name, uid))
        job = self.jobs.get(name)
        if job and (uid is None or job.uid == uid):
            job.deleted = True

    def apply(self, manifest: dict) -> None:
        key = f"{manifest['kind']}/{manifest['metadata']['name']}"
        self.applied.append(manifest)
        self.objects[key] = manifest

    def rollout_ready(self, name: str) -> bool:
        return f"Deployment/{name}" in self.objects and name in self._ready

    def delete_by_label(self, selector: str) -> None:
        self.label_deletions.append(selector)
        k, _, v = selector.partition("=")
        for key in list(self.objects):
            if self.objects[key].get("metadata", {}).get("labels", {}).get(k) == v:
                self.objects.pop(key)

    def mark_ready(self, name: str) -> None:  # test helper (a rolled-out Deployment)
        self._ready.add(name)

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

    def fail_infra(
        self,
        name: str,
        *,
        reason: str = "OOMKilled",
        exit_code: int | None = 137,
        message: str = "",
        logs: str = "",
    ) -> None:
        """A terminal infra fault whose failed pod is still observable."""
        job = self.jobs[name]
        job.phase = "failed"
        job.reason = reason
        job.exit_code = exit_code
        job.termination_message = message
        job.logs = logs

    def pending_unschedulable(
        self, name: str, *, reason: str = "Unschedulable"
    ) -> None:
        """A running Pending pod; only a probe/capture exposes its reason."""
        job = self.jobs[name]
        job.phase = "running"
        job.scheduling_reason = reason


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


def honest_build(fake: FakeKubeClient, workspace_root: Path) -> None:
    """Make the git-backed stage Jobs commit and every gate pass."""

    def commit_all(ws: Path, message: str) -> str:
        _git(ws, "add", "-A")
        _git(ws, "commit", "-q", "-m", message)
        return _git(ws, "rev-parse", "HEAD").stdout.strip()

    def run(name: str, job: FakeJob) -> None:
        if job.phase != "running":
            return
        role = job.manifest["metadata"]["labels"]["sf/role"]
        if role == "build":
            return
        if role == "gate":
            _complete(job, pass_verdict())
            return
        container = job.manifest["spec"]["template"]["spec"]["containers"][0]
        env = {item["name"]: item["value"] for item in container["env"]}
        ref, stage = env["SF_REF"], env["SF_STAGE"]
        ws = workspace_root / ref.lower()
        if stage == "architecture":
            (ws / "PLAN.md").write_text("# plan\n")
        elif stage == "red":
            (ws / "tests" / "test_b3.py").write_text(
                "def test_b3():\n    assert False\n"
            )
        elif stage == "green":
            (ws / "src" / "b3.py").write_text("done = True\n")
        sha = (
            commit_all(ws, f"{ref}: {stage}")
            if stage != "review"
            else _git(ws, "rev-parse", "HEAD").stdout.strip()
        )
        _complete(
            job,
            {
                "v": 1,
                "outcome": "ok",
                "detail": "APPROVE — looks right" if stage == "review" else "stage complete",
                "sha": sha,
            },
        )

    fake.on_observe = run
