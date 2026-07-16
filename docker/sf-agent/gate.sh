#!/usr/bin/env bash
# Gate Job (spec §6): deterministic, factory-owned checks at the PINNED SHA.
# No LLM, no push credential ever reaches this path. Verdicts are advisory
# input to the orchestrator; the frozen-surface decision is computed on the
# orchestrator's own git copy, so surface_hash here is always null.
set -uo pipefail
cd /workspace/repo

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

PYTEST_OUT=/workspace/pytest.txt
run_pytest() {
  python3 -m pytest -q --no-header > "$PYTEST_OUT" 2>&1
  echo $?
}
emit_pytest_log() {
  jq -cn --arg t "$(tail -c 8000 "$PYTEST_OUT")" '{type:"pytest",text:$t}'
}

case "${SF_STAGE:?}" in
  architecture)
    [ -s PLAN.md ] && verdict pass "PLAN.md present at the pinned SHA"
    verdict fail "architecture produced no PLAN.md"
    ;;
  red)
    rc="$(run_pytest)"; emit_pytest_log
    [ "$rc" = "0" ] && verdict fail "RED gate: new tests did not fail — nothing pins the new behavior"
    [ "$rc" = "1" ] && verdict pass "tests fail for the right reason"
    verdict fail "RED gate: tests broke instead of failing (pytest rc=$rc)"
    ;;
  green)
    rc="$(run_pytest)"; emit_pytest_log
    [ "$rc" = "0" ] && verdict pass "suite green at the pinned SHA"
    verdict fail "GREEN gate: suite still failing (rc=$rc): $(tail -c 300 "$PYTEST_OUT")"
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
    [ "$rc" = "0" ] && verdict pass "review gate metrics computed" "$METRICS"
    verdict fail "review gate: suite not green at the pinned SHA (rc=$rc)" "$METRICS"
    ;;
  *)
    verdict fail "unknown gate stage ${SF_STAGE}"
    ;;
esac
