"""The declared agent-harness surface: one prompt store, lineage, failure vocabulary.

docker/sf-agent/prompts/*.md is the ONE source of stage-prompt text: the
sf-agent image bakes those files for pod runs (entrypoint.sh) and the
in-process AgentRunner reads them here at call time, so the two runners can
never silently drift (test_prompt_parity pins the contract).

HARNESS_VERSION is a short content digest over that prompt pack plus the
runtime-policy knobs that shape a run. Every stage StageJob row is stamped
with it, so any recorded outcome can be attributed to the harness that
produced it — the lineage that makes a before/after comparison of a prompt
edit possible at all (docs/reviews/self-harness-integration-analysis-2026-07-16.md).
The digest reflects THIS checkout's prompt files; a pod runs the copy baked
into AGENT_IMAGE, so rebuilding the image when prompts change is what keeps
the stamp honest.
"""
import hashlib
import logging
from pathlib import Path

from . import settings

log = logging.getLogger("factory.harness")

STAGES = ("architecture", "red", "green", "review")


def stage_prompt(stage: str) -> str:
    """The shared base prompt for one pipeline stage (both runners build on it)."""
    if stage not in STAGES:
        raise KeyError(f"unknown harness stage {stage!r}")
    return (settings.PROMPTS / f"{stage}.md").read_text().strip()


def governing_prompt(stage: str) -> str | None:
    """The repo file an operator edits to change this stage's behavior."""
    return f"docker/sf-agent/prompts/{stage}.md" if stage in STAGES else None


def compute_version(prompts_dir: Path | None = None) -> str:
    """12-hex digest of the prompt pack + policy knobs.

    FACTORY_CLI/FACTORY_RUNNER stay out on purpose: they are per-call reads
    (settings.py keeps them runtime-switchable for tests) and the Job manifest
    already records SF_CLI per attempt.
    """
    d = prompts_dir or settings.PROMPTS
    h = hashlib.sha256()
    for stage in STAGES:
        h.update(stage.encode())
        f = d / f"{stage}.md"
        if f.is_file():
            h.update(f.read_bytes())
        else:
            # a digest over missing files is a lineage LIE (it stops moving
            # with prompt edits) — deploys must ship the prompt store
            # (api/Dockerfile bakes it; FACTORY_PROMPTS points at it)
            log.warning("prompt store file missing: %s — HARNESS_VERSION is degraded", f)
            h.update(b"<missing>")
    knobs = (
        settings.AGENT_IMAGE,
        settings.KUBE_MAX_ATTEMPTS,
        settings.STAGE_TIMEOUT,
        settings.STAGE_WALL_CLOCK,
        settings.GATE_WALL_CLOCK,
        settings.CLAUDE_MODEL,
        settings.CODEX_MODEL,
        settings.OPENCODE_MODEL,
    )
    h.update(repr(knobs).encode())
    return h.hexdigest()[:12]


HARNESS_VERSION = compute_version()


# ---------- verifier-cause vocabulary (pressure report) ----------
# The reason strings are emitted from THREE places — docker/sf-agent/gate.sh,
# kube_runner (orchestrator-injected verdicts), and agent_runner (in-process
# gates) — so the map matches on substrings, first hit wins, and unknown text
# degrades to "other", never to a crash. test_harness_pressure pins every
# emitted literal to its bucket; extend both together.
_CAUSE_MARKERS: tuple[tuple[str, str], ...] = (
    ("no PLAN.md", "no_plan"),
    ("RED gate: new tests did not fail", "red_not_failing"),
    ("RED gate: tests broke", "red_broken"),
    ("RED gate cannot run", "gate_broken"),
    ("GREEN gate cannot run", "gate_broken"),
    ("GREEN gate: suite still failing", "green_suite_failing"),
    ("test-isolation gate", "test_isolation_violation"),
    ("frozen test surface", "test_isolation_violation"),
    ("review gate: suite not green", "review_not_green"),
    ("Reviewer stage produced no usable REVIEW.md", "review_no_artifact"),
    ("Verification could not be built", "verification_unbuildable"),
    ("produced no verdict", "gate_no_verdict"),
    ("graded SHA", "clone_infra"),
    ("rejected invalid stage SHA", "clone_infra"),
    ("unknown gate stage", "gate_broken"),
    ("could not be captured", "capture_miss"),
    ("envelope missing", "capture_miss"),
    ("Workspace preparation failed", "workspace_infra"),
    ("Workspace setup failed", "workspace_infra"),
)


def classify_reason(reason: str | None) -> str:
    """Bucket a free-text failure reason into the typed verifier-cause vocabulary."""
    text = (reason or "").strip().lower()
    if not text:
        return "other"
    for marker, cause in _CAUSE_MARKERS:
        if marker.lower() in text:
            return cause
    return "other"
