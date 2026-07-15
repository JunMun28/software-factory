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
    import subprocess
    import sys

    r = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "tests"],
        cwd=SAMPLE, capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
