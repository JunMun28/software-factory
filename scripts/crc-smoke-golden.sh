#!/usr/bin/env bash
# E2E-7: the golden-path smoke against OpenShift Local. Same journey, same
# assertions as kind-smoke-golden.sh — only the transport knobs differ.
set -euo pipefail
: "${KUBECONFIG:?set KUBECONFIG to the CRC kubeconfig (kubectl must answer the CRC API)}"
export SMOKE_API=http://api-software-factory.apps-crc.testing/api
export SMOKE_APP_DOMAIN=apps-crc.testing
export SMOKE_HOST_PORT=
export SMOKE_CONNECT_TO="::127.0.0.1:"
export SMOKE_PROD_TRIES=450   # CRC's router catches up after the build crunch frees the CPUs
exec bash "$(dirname "$0")/kind-smoke-golden.sh"
