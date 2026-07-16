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
Large payloads (review summaries, test reports) travel as NDJSON pod logs.
Output capture is attempted before every deletion, including from running pods;
log transfer failures remain best-effort.
"""

import json
import re

from . import settings, workspace
from .agent_exec import agent_cli
from .log_scrub import scrub_secrets


def _agent_model() -> str:
    cli = agent_cli()
    if cli == "codex":
        return settings.CODEX_MODEL
    if cli == "opencode":
        return settings.OPENCODE_MODEL
    if cli == "claude":
        return settings.CLAUDE_MODEL
    return ""

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
    repo_slug: str | None = None,
) -> dict:
    env = {"HOME": "/workspace", **env}
    if settings.GIT_REMOTE_BASE:
        env.setdefault("SF_REPO_URL", f"{settings.GIT_REMOTE_BASE}/{ref.lower()}")
        env.setdefault("SF_BRANCH", f"work/{ref.lower()}")
    if role == "stage" and settings.github_enabled():
        env["SF_REPO_URL"] = workspace.github_https_url(repo_slug or ref.lower())
        env["SF_GITHUB_TOKEN"] = {
            "valueFrom": {
                "secretKeyRef": {
                    "name": settings.GITHUB_TOKEN_SECRET,
                    "key": "token",
                    "optional": True,
                }
            }
        }
    volumes: list[dict] = [{"name": "workspace", "emptyDir": {}}]
    mounts: list[dict] = [{"name": "workspace", "mountPath": "/workspace"}]
    if role == "stage":
        # optional: environments without the secret still schedule; the
        # entrypoint fails LOUDLY if the chosen CLI needs it and it is absent
        volumes.append(
            {
                "name": "codex-auth",
                "secret": {
                    "secretName": settings.CODEX_AUTH_SECRET,
                    "optional": True,
                },
            }
        )
        mounts.append(
            {
                "name": "codex-auth",
                "mountPath": "/secrets/codex",
                "readOnly": True,
            }
        )
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
            # backstop reaper (DEPLOY-03): the orchestrator's Foreground delete is
            # primary; this only collects Jobs a crashed orchestrator abandoned.
            "ttlSecondsAfterFinished": settings.JOB_TTL_AFTER_FINISHED,
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
                    "serviceAccountName": (
                        settings.KUBE_AGENT_SA
                        if role == "stage"
                        else settings.KUBE_GATE_SA
                    ),
                    "securityContext": {
                        # restricted-SCC emulation (spec §2): forced non-root
                        # UID + root group (the image is chmod g=u)
                        "runAsNonRoot": True,
                        "runAsUser": settings.KUBE_RUN_AS_UID,
                        "runAsGroup": 0,
                        "fsGroup": 0,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "volumes": volumes,
                    "containers": [
                        {
                            "name": "main",
                            "image": settings.AGENT_IMAGE,
                            "imagePullPolicy": "IfNotPresent",
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "env": [
                                (
                                    {"name": key, **value}
                                    if isinstance(value, dict)
                                    else {"name": key, "value": str(value)}
                                )
                                for key, value in env.items()
                            ],
                            "volumeMounts": mounts,
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
    ref: str,
    stage: str,
    attempt: int,
    *,
    feedback: str = "",
    preview_feedback: str = "",
    repo_slug: str | None = None,
) -> dict:
    env = {
        "SF_REF": ref,
        "SF_STAGE": stage,
        "SF_ATTEMPT": attempt,
        "SF_ROLE": "stage",
        "SF_CLI": agent_cli(),
        "SF_MODEL": _agent_model(),
    }
    if feedback:
        env["SF_GATE_FEEDBACK"] = feedback[:_FEEDBACK_CAP]
    if preview_feedback:
        env["SF_PREVIEW_FEEDBACK"] = preview_feedback[:8192]
    return _base_job(
        job_name(ref, stage, attempt),
        role="stage",
        ref=ref,
        stage=stage,
        attempt=attempt,
        deadline=settings.JOB_ACTIVE_DEADLINE,
        env=env,
        repo_slug=repo_slug,
    )


def gate_job_manifest(
    ref: str, stage: str, attempt: int, *, sha: str = "", review_verdict: str = ""
) -> dict:
    env = {
        "SF_REF": ref,
        "SF_STAGE": stage,
        "SF_ATTEMPT": attempt,
        "SF_ROLE": "gate",
        "SF_SHA": sha,  # the PINNED SHA the gate grades (spec §6); "" = branch head
    }
    if stage == "review" and review_verdict:
        # the read-only review stage pushes nothing; its verdict reaches the
        # review gate's metrics via the orchestrator (spec §5)
        env["SF_REVIEW_VERDICT"] = review_verdict[:500]
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


_VERDICT_RE = re.compile(r"^(APPROVE|REQUEST-CHANGES)\b")


def parse_review_report(stage_row) -> dict:
    """Parse and scrub the captured review stage's verdict and reasoning.

    Scrubbing happens here, before the report can reach an append-only event,
    merge evidence, the jobs API, or a retry prompt.
    """
    detail = ((stage_row.envelope or {}).get("detail") or "").strip()
    match = _VERDICT_RE.match(detail)
    raw_verdict = (
        match.group(1)
        if match
        else (detail.split("\n", 1)[0][:120] or "no explicit verdict")
    )
    verdict = scrub_secrets(raw_verdict)
    reasoning = ""
    for event in ndjson_events(stage_row.logs_tail or ""):
        if event.get("type") == "review":
            reasoning = scrub_secrets(str(event.get("text") or "").strip())[:4000]
            break
    approved = verdict == "APPROVE"
    feedback = ""
    if not approved:
        feedback = scrub_secrets(
            "Your prior review requested changes for these reasons; re-review "
            "the unchanged code honestly. The code SHA is unchanged, so repeat "
            "REQUEST-CHANGES if the concerns still apply.\n"
            f"Verdict: {verdict}\n{reasoning}"
        ).strip()[:_FEEDBACK_CAP]
    return {
        "verdict": verdict,
        "approved": approved,
        "reasoning": reasoning,
        "feedback": feedback,
    }


_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def parse_digest(msg: str) -> str | None:
    """A build Job's termination message is kaniko's --digest-file output: a bare
    `sha256:<64hex>` (kaniko may append a trailing newline). Returns the digest or
    None for garbage (missing-digest is its own escalation reason, like a missing
    envelope for stage Jobs)."""
    m = _DIGEST.search(msg or "")
    return m.group(0) if m else None
