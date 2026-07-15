"""Factory-owned Job manifests + output parsing (Plan B1; spec §5, §6).

Pure functions — no I/O, no DB — so every hard line is unit-testable:
  * deterministic names sf-<ref>-<stage>-<attempt> (gate Jobs add "-gate");
  * backoffLimit 0 — retries are DOMAIN decisions, never kubelet ones;
  * podFailurePolicy ignores DisruptionTarget — an eviction must not consume
    an attempt;
  * activeDeadlineSeconds as the in-cluster kill switch UNDER the
    orchestrator's wall clock;
  * no ServiceAccount token in any pod.

Envelope contract (termination message, JSON, kernel-capped at 4 KB):
  agent Job:  {"v": 1, "outcome": "ok"|"fail", "detail": str}
  gate Job:   {"v": 1, "outcome": "pass"|"fail", "reason": str,
               "surface_hash": str|null, "metrics": {...}|null}
Large payloads (review summaries, test reports) travel as NDJSON pod logs,
captured by the orchestrator BEFORE Job deletion (spec §5).
"""

import json
import re

from . import settings

KUBE_STAGES = ("architecture", "red", "green", "review")
REQUEST_STAGE = {
    "architecture": "architecture",
    "red": "build",
    "green": "build",
    "review": "review",
}

_FEEDBACK_CAP = 2000


def job_name(ref: str, stage: str, attempt: int, *, gate: bool = False) -> str:
    """Build a validated sf-<ref>-<stage>-<attempt>[-gate] Job name."""
    if not re.fullmatch(r"REQ-\d+", ref or ""):
        raise ValueError(f"refusing job name for malformed ref {ref!r}")
    if stage not in KUBE_STAGES:
        raise ValueError(f"unknown kube stage {stage!r}")
    name = f"sf-{ref.lower()}-{stage}-{int(attempt)}"
    return f"{name}-gate" if gate else name


def _base_job(
    name: str,
    *,
    role: str,
    ref: str,
    stage: str,
    attempt: int,
    deadline: int,
    env: dict,
) -> dict:
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "labels": {
                "sf/tier": "agent",
                "sf/role": role,
                "sf/request": ref.lower(),
                "sf/stage": stage,
                "sf/attempt": str(attempt),
            },
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": deadline,
            "podFailurePolicy": {
                "rules": [
                    {
                        "action": "Ignore",
                        "onPodConditions": [{"type": "DisruptionTarget"}],
                    },
                ],
            },
            "template": {
                "metadata": {
                    "labels": {
                        "sf/tier": "agent",
                        "sf/role": role,
                        "sf/request": ref.lower(),
                    }
                },
                "spec": {
                    "restartPolicy": "Never",
                    "automountServiceAccountToken": False,
                    "containers": [
                        {
                            "name": "main",
                            "image": settings.AGENT_IMAGE,
                            "env": [
                                {"name": key, "value": str(value)}
                                for key, value in env.items()
                            ],
                            "resources": {
                                "requests": {"cpu": "500m", "memory": "1Gi"},
                                "limits": {"cpu": "2", "memory": "4Gi"},
                            },
                            "terminationMessagePolicy": "File",
                        }
                    ],
                },
            },
        },
    }


def stage_job_manifest(
    ref: str, stage: str, attempt: int, *, feedback: str = ""
) -> dict:
    env = {
        "SF_REF": ref,
        "SF_STAGE": stage,
        "SF_ATTEMPT": attempt,
        "SF_ROLE": "stage",
    }
    if feedback:
        env["SF_GATE_FEEDBACK"] = feedback[:_FEEDBACK_CAP]
    return _base_job(
        job_name(ref, stage, attempt),
        role="stage",
        ref=ref,
        stage=stage,
        attempt=attempt,
        deadline=settings.JOB_ACTIVE_DEADLINE,
        env=env,
    )


def gate_job_manifest(ref: str, stage: str, attempt: int) -> dict:
    env = {
        "SF_REF": ref,
        "SF_STAGE": stage,
        "SF_ATTEMPT": attempt,
        "SF_ROLE": "gate",
    }
    return _base_job(
        job_name(ref, stage, attempt, gate=True),
        role="gate",
        ref=ref,
        stage=stage,
        attempt=attempt,
        deadline=settings.GATE_ACTIVE_DEADLINE,
        env=env,
    )


def parse_envelope(msg: str) -> dict | None:
    """Parse the termination-message envelope, or return None for garbage."""
    try:
        envelope = json.loads(msg or "")
    except json.JSONDecodeError:
        return None
    return envelope if isinstance(envelope, dict) and "outcome" in envelope else None


def ndjson_events(logs: str) -> list[dict]:
    """Parse structured NDJSON events while tolerating banner noise."""
    events: list[dict] = []
    for line in (logs or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events
