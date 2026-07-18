#!/usr/bin/env bash
# Gate Job (spec §6): deterministic, factory-owned checks at the PINNED SHA.
# No LLM, no push credential ever reaches this path. Verdicts are advisory
# input to the orchestrator; the frozen-surface decision is computed on the
# orchestrator's own git copy, so surface_hash here is always null.
set -uo pipefail
cd "${SF_REPO_DIR:-/workspace/repo}"

TERMLOG="${SF_TERMLOG:-/dev/termination-log}"
write_envelope() { printf '%s' "$1" > "$TERMLOG" 2>/dev/null || printf 'ENVELOPE %s\n' "$1"; }
note() { jq -cn --arg t "$1" '{type:"note",text:$t}'; }
verdict() { # outcome reason [metrics_json]
  write_envelope "$(jq -cn --arg o "$1" --arg r "$2" --argjson m "${3:-null}" \
    '{v:1,outcome:$o,reason:$r,surface_hash:null,metrics:$m}')"
  exit 0
}

if [ -n "${SF_SHA:-}" ]; then
  git checkout -q "$SF_SHA" || verdict fail "graded SHA $SF_SHA not found in the clone"
  note "grading pinned SHA $SF_SHA"
fi

GATE_WORK="${SF_GATE_WORK_DIR:-$(dirname "$PWD")}" # /workspace in the gate pod
PYTEST_OUT="$GATE_WORK/pytest.txt"
BACKEND_DIR="."
if [ -f backend/pyproject.toml ]; then
  BACKEND_DIR="backend"
fi
run_pytest() {
  if [ "$BACKEND_DIR" = "backend" ]; then
    uv run --directory backend pytest -q --no-header > "$PYTEST_OUT" 2>&1
  else
    python3 -m pytest -q --no-header > "$PYTEST_OUT" 2>&1
  fi
  echo $?
}
emit_pytest_log() {
  jq -cn --arg t "$(tail -c 8000 "$PYTEST_OUT")" '{type:"pytest",text:$t}'
}
frontend_build_gate() { # [metrics_json]
  [ -f frontend/package.json ] || return 0
  NPM_CI_OUT="$GATE_WORK/npm-ci.txt"
  (cd frontend && npm ci) > "$NPM_CI_OUT" 2>&1
  npm_ci_rc=$?
  if [ "$npm_ci_rc" != "0" ]; then
    if grep -Eqi 'EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|network.*(unreachable|timeout)|registry.*unreachable' "$NPM_CI_OUT"; then
      note "frontend build skipped: npm registry unreachable in gate pod"
      return 0
    fi
    verdict fail "frontend dependency install failed (npm ci rc=$npm_ci_rc): $(tail -c 300 "$NPM_CI_OUT")" "${1:-null}"
  fi
  NPM_BUILD_OUT="$GATE_WORK/npm-build.txt"
  (cd frontend && npm run build) > "$NPM_BUILD_OUT" 2>&1
  npm_build_rc=$?
  [ "$npm_build_rc" = "0" ] || \
    verdict fail "frontend build failed (rc=$npm_build_rc): $(tail -c 300 "$NPM_BUILD_OUT")" "${1:-null}"
  note "frontend build passed"
}
pytest_problem() {
  rc="$1"
  if grep -Eq 'ERROR collecting|ImportError|ModuleNotFoundError|error during collection' "$PYTEST_OUT"; then
    printf 'test collection/import error'
  elif [ "$rc" = "5" ]; then
    printf 'no tests were collected'
  elif [ "$rc" -ge 2 ]; then
    printf 'pytest collection/infrastructure error'
  else
    printf 'test assertions failed'
  fi
}
scan_committed_diff() {
  if ! command -v gitleaks >/dev/null 2>&1; then
    note "WARNING: gitleaks unavailable — committed-diff secret scan skipped"
    return
  fi
  GITLEAKS_OUT="$GATE_WORK/gitleaks.txt"
  gitleaks git --no-banner --redact --log-opts="origin/main...HEAD" . >"$GITLEAKS_OUT" 2>&1
  gl_rc=$?
  if [ "$gl_rc" = "0" ]; then
    note "gitleaks committed-diff scan passed"
    return
  fi
  # gitleaks exit 1 == leaks found (block); any OTHER nonzero == scanner/infra
  # error (missing ref, bad config) — must NOT false-block a green run.
  if [ "$gl_rc" = "1" ]; then
    verdict fail "secret gate: committed secret detected (gitleaks); remove it before merge"
  fi
  note "WARNING: gitleaks errored (rc=$gl_rc) — committed-diff scan inconclusive, skipped"
}

scan_committed_diff

case "${SF_STAGE:?}" in
  architecture)
    [ -s PLAN.md ] && verdict pass "PLAN.md present at the pinned SHA"
    verdict fail "architecture produced no PLAN.md"
    ;;
  red)
    rc="$(run_pytest)"; emit_pytest_log
    [ "$rc" = "0" ] && verdict fail "RED gate: new tests did not fail — nothing pins the new behavior"
    # rc=1 must be a GENUINE assertion FAILURE, not a collection/import/fixture
    # ERROR (which also exits nonzero and would falsely satisfy RED). Require the
    # summary to report >=1 real 'failed' before passing.
    red_failed="$(grep -oE '[0-9]+ failed' "$PYTEST_OUT" | grep -oE '[0-9]+' | head -1)"; red_failed="${red_failed:-0}"
    { [ "$rc" = "1" ] && [ "$red_failed" -ge 1 ]; } \
      && verdict pass "tests fail for the right reason ($red_failed failed)"
    verdict fail "RED gate: $(pytest_problem "$rc") (pytest rc=$rc): $(tail -c 300 "$PYTEST_OUT")"
    ;;
  green)
    rc="$(run_pytest)"; emit_pytest_log
    if [ "$rc" = "0" ]; then
      frontend_build_gate
      verdict pass "suite green at the pinned SHA"
    fi
    [ "$rc" = "1" ] && verdict fail "GREEN gate: suite still failing (rc=$rc): $(tail -c 300 "$PYTEST_OUT")"
    verdict fail "GREEN gate: $(pytest_problem "$rc") (pytest rc=$rc): $(tail -c 300 "$PYTEST_OUT")"
    ;;
  review)
    rc="$(run_pytest)"; emit_pytest_log
    passed="$(grep -oE '[0-9]+ passed' "$PYTEST_OUT" | grep -oE '[0-9]+' | head -1)"; passed="${passed:-0}"
    failed="$(grep -oE '[0-9]+ failed' "$PYTEST_OUT" | grep -oE '[0-9]+' | head -1)"; failed="${failed:-0}"
    total=$((passed + failed))
    read -r added removed <<EOF2
$(git diff --numstat origin/main...HEAD | awk '{a+=$1; r+=$2} END {print a+0, r+0}')
EOF2
    files="$(git diff --name-only origin/main...HEAD | wc -l | tr -d ' ')"
    METRICS="$(jq -cn \
      --argjson tp "$passed" --argjson tt "$total" \
      --argjson da "${added:-0}" --argjson dr "${removed:-0}" --argjson fc "$files" \
      --arg rv "${SF_REVIEW_VERDICT:-no review}" \
      '{tests_passed:$tp,tests_total:$tt,diff_added:$da,diff_removed:$dr,files_changed:$fc,reviewer_verdict:$rv}')"
    [ "${SF_REVIEW_VERDICT:-}" = "APPROVE" ] || \
      verdict fail "review gate: reviewer did not APPROVE (${SF_REVIEW_VERDICT:-no review})" "$METRICS"
    if [ "$rc" = "0" ]; then
      frontend_build_gate "$METRICS"
      verdict pass "review gate metrics computed" "$METRICS"
    fi
    [ "$rc" = "1" ] && verdict fail "review gate: suite not green at the pinned SHA (rc=$rc)" "$METRICS"
    verdict fail "review gate: $(pytest_problem "$rc") (pytest rc=$rc)" "$METRICS"
    ;;
  *)
    verdict fail "unknown gate stage ${SF_STAGE}"
    ;;
esac
