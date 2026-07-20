"""Small, file-backed organizational context for the intake brain."""

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from . import settings

log = logging.getLogger("factory.brain")
_FILES = ("glossary.md", "teams.yaml", "data-sources.yaml")


@dataclass(frozen=True)
class _Snapshot:
    directory: Path
    assembled: str
    teams: tuple[dict[str, Any], ...]
    data_sources: tuple[dict[str, Any], ...]


_snapshot: _Snapshot | None = None
_snapshot_lock = threading.Lock()


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except OSError as exc:
        log.warning("could not read knowledge file %s: %s", path, exc)
        return ""


def _yaml_rows(raw: str, source: Path) -> tuple[dict[str, Any], ...]:
    if not raw:
        return ()
    try:
        value = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        log.warning("could not parse knowledge file %s: %s", source, exc)
        return ()
    if not isinstance(value, list):
        log.warning("knowledge file %s must contain a YAML list", source)
        return ()
    return tuple(dict(row) for row in value if isinstance(row, dict))


def _load(directory: Path) -> _Snapshot:
    raw = {name: _read(directory / name) for name in _FILES}
    sections = [f"{name}\n{text}" for name, text in raw.items() if text]
    assembled = ""
    if sections:
        assembled = (
            "<organizational_knowledge>\n"
            + "\n\n".join(sections)
            + "\n</organizational_knowledge>"
        )
    return _Snapshot(
        directory=directory,
        assembled=assembled,
        teams=_yaml_rows(raw["teams.yaml"], directory / "teams.yaml"),
        data_sources=_yaml_rows(
            raw["data-sources.yaml"], directory / "data-sources.yaml"
        ),
    )


def _current() -> _Snapshot:
    global _snapshot
    directory = Path(settings.KNOWLEDGE_DIR)
    if _snapshot is None or _snapshot.directory != directory:
        with _snapshot_lock:
            if _snapshot is None or _snapshot.directory != directory:
                _snapshot = _load(directory)
    return _snapshot


def system_blocks() -> list[dict[str, Any]]:
    """Return the stable Anthropic system prefix, caching org files in-process."""
    # Lazy import avoids a module cycle: brain_api delegates its system value here.
    from .brain_api import _SYSTEM

    blocks: list[dict[str, Any]] = [{"type": "text", "text": _SYSTEM}]
    assembled = _current().assembled
    if assembled:
        blocks.append(
            {
                "type": "text",
                "text": assembled,
                "cache_control": {"type": "ephemeral"},
            }
        )
    return blocks


def teams() -> list[dict]:
    """Return a copy of the configured team registry."""
    return [dict(row) for row in _current().teams]


def data_sources() -> list[dict]:
    """Return a copy of the configured data-source catalog."""
    return [dict(row) for row in _current().data_sources]
