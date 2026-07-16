#!/usr/bin/env bash
set -euo pipefail

source_db="${1:-api/factory.db}"
backup_dir="${2:-backups}"

if [[ ! -f "${source_db}" ]]; then
  echo "backup source does not exist: ${source_db}" >&2
  exit 1
fi

python3 - "${source_db}" "${backup_dir}" <<'PY'
import datetime
import os
import sqlite3
import sys
from pathlib import Path

source_path = Path(sys.argv[1])
backup_dir = Path(sys.argv[2])
backup_dir.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%d-%H%M%S-%f")
output_path = backup_dir / f"factory-{stamp}.db"

source = sqlite3.connect(f"{source_path.resolve().as_uri()}?mode=ro", uri=True)
target = sqlite3.connect(output_path)
try:
    source.backup(target)
    result = target.execute("PRAGMA quick_check").fetchone()
    if result != ("ok",):
        raise RuntimeError(f"backup integrity check failed: {result!r}")
finally:
    target.close()
    source.close()

os.chmod(output_path, 0o600)
print(output_path)
PY
