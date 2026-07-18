"""Produced-app template contracts for both the default and E2E-2 profiles."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from test_workspace import _req

from app import settings, workspace
from app.ws_exec import _git

REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN = REPO_ROOT / "templates" / "golden"
SAMPLE = REPO_ROOT / "sample"


def test_default_sample_dockerfile_and_requirements_present():
    assert (SAMPLE / "Dockerfile").is_file()
    reqs = (SAMPLE / "requirements.txt").read_text()
    assert "fastapi" in reqs and "uvicorn" in reqs


def test_default_sample_app_exposes_health_and_imports_domain():
    source = (SAMPLE / "app.py").read_text()
    assert "FastAPI(" in source
    assert "/health" in source
    assert "from expenses import" in source


def test_default_sample_container_files_are_not_in_the_frozen_surface():
    for name in ("Dockerfile", "requirements.txt", "app.py"):
        assert name not in workspace.SURFACE_PATHS


def test_default_sample_domain_tests_still_pass():
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "tests"],
        cwd=SAMPLE,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_golden_workspace_baseline_tracks_sources_but_not_local_artifacts(
    tmp_path, monkeypatch
):
    source = tmp_path / "golden-source"
    shutil.copytree(
        GOLDEN,
        source,
        ignore=shutil.ignore_patterns("node_modules", ".venv", "__pycache__"),
    )
    for artifact in (
        source / "frontend" / "node_modules" / "cached.js",
        source / "backend" / ".venv" / "marker",
        source / "backend" / "app" / "__pycache__" / "main.pyc",
    ):
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text("must not be copied\n")

    monkeypatch.setenv("FACTORY_SAMPLE", str(source))
    monkeypatch.setattr(settings, "SAMPLE", source)
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "workspaces")

    ws = workspace.ensure_repo(req := _req(), workspace.spec_md(req))
    baseline = _git(ws, "ls-tree", "-r", "--name-only", "main")
    assert baseline.returncode == 0, baseline.stderr
    tracked = set(baseline.stdout.splitlines())

    assert (ws / ".git").is_dir()
    assert "frontend/package.json" in tracked
    assert "backend/pyproject.toml" in tracked
    assert not any(
        component in {"node_modules", ".venv", "__pycache__"}
        for path in tracked
        for component in Path(path).parts
    )
    assert not any(
        path.name in {"node_modules", ".venv", "__pycache__"}
        for path in ws.rglob("*")
        if path.is_dir()
    )


@pytest.mark.skipif(
    not os.environ.get("FACTORY_TEST_GOLDEN_STANDALONE"),
    reason="cold `uv sync` of the template venv takes minutes; opt in with "
    "FACTORY_TEST_GOLDEN_STANDALONE=1 (the e2e/kind smoke path runs it)",
)
def test_golden_backend_suite_passes_standalone():
    env = {**os.environ, "UV_NO_PROGRESS": "1"}
    env.pop("UV_PROJECT_ENVIRONMENT", None)
    result = subprocess.run(
        ["uv", "run", "--directory", str(GOLDEN / "backend"), "pytest", "-q"],
        check=False,
        capture_output=True,
        text=True,
        timeout=600,
        env=env,
    )

    assert result.returncode == 0, result.stdout + result.stderr


def test_golden_produced_app_image_contract_is_plain_and_non_root():
    dockerfile = (GOLDEN / "Dockerfile").read_text()
    gitignore = (GOLDEN / ".gitignore").read_text().splitlines()
    main = (GOLDEN / "backend" / "app" / "main.py").read_text()

    assert "FROM node:24-slim" in dockerfile
    assert "FROM python:3.12-slim" in dockerfile
    assert "npm ci" in dockerfile and "npm run build" in dockerfile
    assert "uv sync --frozen --no-dev" in dockerfile
    assert "EXPOSE 8000" in dockerfile
    assert "USER 10101" in dockerfile
    assert "--mount=" not in dockerfile
    assert ".pytest_cache/" in gitignore
    assert 'StaticFiles(directory=STATIC_DIR, html=True)' in main
    assert main.index('@app.get("/api/items"') < main.index('app.mount("/"')
