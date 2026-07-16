#!/usr/bin/env bash
set -euo pipefail

if [[ "${RESTORE_CONFIRMED:-}" != "1" ]]; then
  echo "restore refused: stop the API, then set RESTORE_CONFIRMED=1" >&2
  exit 2
fi

force=0
if [[ "${1:-}" == "--force" ]]; then
  force=1
  shift
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: RESTORE_CONFIRMED=1 $0 [--force] BACKUP_DB [LIVE_DB]" >&2
  exit 2
fi

backup_db="$1"
live_db="${2:-/data/factory.db}"

if [[ ! -f "${backup_db}" ]]; then
  echo "backup does not exist: ${backup_db}" >&2
  exit 1
fi

writer_evidence=""
if [[ -e "${live_db}-wal" || -e "${live_db}-shm" ]]; then
  writer_evidence="WAL/SHM files are present"
elif command -v lsof >/dev/null 2>&1 && lsof "${live_db}" >/dev/null 2>&1; then
  writer_evidence="the live database is open by another process"
fi

if [[ -n "${writer_evidence}" && ${force} -ne 1 ]]; then
  echo "restore refused: ${writer_evidence}; stop the API/writers and retry" >&2
  echo "use --force only after confirming those files/processes are stale" >&2
  exit 2
fi
if [[ ${force} -eq 1 ]]; then
  echo "WARNING: --force bypasses the active-writer/WAL safety check; an active API can lose data" >&2
fi

python3 - "${backup_db}" "${live_db}" <<'PY'
import os
import sqlite3
import sys
from pathlib import Path

backup_path = Path(sys.argv[1])
live_path = Path(sys.argv[2])
live_path.parent.mkdir(parents=True, exist_ok=True)
temp_path = live_path.with_name(f".{live_path.name}.restore-{os.getpid()}")
failed_path = live_path.with_name(f".{live_path.name}.restore-failed-{os.getpid()}")


def check_database(path: Path, label: str) -> None:
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        result = connection.execute("PRAGMA quick_check").fetchone()
        if result != ("ok",):
            raise RuntimeError(f"{label} integrity check failed: {result!r}")
    finally:
        connection.close()


def fsync_directory() -> None:
    directory_fd = os.open(live_path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)

source = sqlite3.connect(f"{backup_path.resolve().as_uri()}?mode=ro", uri=True)
try:
    result = source.execute("PRAGMA quick_check").fetchone()
    if result != ("ok",):
        raise RuntimeError(f"backup integrity check failed: {result!r}")

    target = sqlite3.connect(temp_path)
    try:
        source.backup(target)
        restored = target.execute("PRAGMA quick_check").fetchone()
        if restored != ("ok",):
            raise RuntimeError(f"restored database integrity check failed: {restored!r}")
    finally:
        target.close()
finally:
    source.close()

try:
    mode = live_path.stat().st_mode & 0o777
except FileNotFoundError:
    mode = 0o600
os.chmod(temp_path, mode)

originals = [Path(f"{live_path}{suffix}") for suffix in ("", "-wal", "-shm")]
old_paths = [
    live_path.with_name(f".{live_path.name}.restore-old-{os.getpid()}{suffix}")
    for suffix in ("", "-wal", "-shm")
]
moved: list[tuple[Path, Path]] = []
swapped = False
try:
    # Keep the complete old SQLite trio until the replacement is installed and
    # validated. Every rename is same-directory and therefore atomic.
    for original, old in zip(originals, old_paths, strict=True):
        if original.exists():
            os.replace(original, old)
            moved.append((original, old))

    if os.environ.get("RESTORE_FAILPOINT") == "after_move_aside":
        raise RuntimeError("restore drill failpoint: swap failed after move-aside")

    os.replace(temp_path, live_path)
    swapped = True
    fsync_directory()
    check_database(live_path, "swapped database")
except BaseException:
    print("restore failed; rolling back the original database trio", file=sys.stderr)
    if swapped and live_path.exists():
        os.replace(live_path, failed_path)
    for original, old in moved:
        if old.exists():
            os.replace(old, original)
    fsync_directory()
    if failed_path.exists():
        failed_path.unlink()
    raise
else:
    # The swap is successful only after the installed copy passes quick_check.
    # Old files are cleanup now, not rollback state; a cleanup error leaves the
    # move-aside copy in place rather than endangering the validated live DB.
    for _original, old in moved:
        try:
            old.unlink()
        except OSError as error:
            print(f"warning: could not remove old restore file {old}: {error}", file=sys.stderr)
    fsync_directory()
finally:
    if temp_path.exists():
        temp_path.unlink()

print(f"restored {live_path} from {backup_path}")
PY
