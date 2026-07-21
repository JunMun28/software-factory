#!/usr/bin/env bash
set -euo pipefail
if [[ -f .gate-fail ]]; then
  echo "GATE RED: intentional failure" >&2
  exit 1
fi
echo "GATE GREEN"
