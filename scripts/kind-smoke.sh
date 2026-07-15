#!/usr/bin/env bash
# One request END-TO-END on the kind cluster (Plan B2; spec §9 Phase 1
# walking skeleton): intake → spec gate → agent Jobs (codex on the
# subscription) + gate Jobs → merge gate → SHA-precondition merge → done,
# with the workspace repo's main updated ("deployed" in the B2 sense —
# produced-app build/deploy is B3) and every Job reaped.
#
# Prereqs: task kind-up && task kind-load && task kind-deploy && task sync-codex-auth
# Spends real codex usage; a clean run takes 10-25 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."

API="http://api.localtest.me:8081/api"
NS=software-factory

jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
fail() { echo "✗ $1"; exit 1; }
ok() { echo "  ✓ $1"; }

echo "▸ preflight"
kubectl -n $NS get secret sf-codex-auth >/dev/null 2>&1 \
  || fail "Secret sf-codex-auth missing — run 'task sync-codex-auth' first"
HEALTH=$(curl -sf "$API/health") || fail "API unreachable at $API (ingress up? task kind-deploy?)"
[ "$(echo "$HEALTH" | jqpy "print(d['runner'])")" = "kube" ] || fail "runner is not kube"
ok "cluster healthy, runner=kube"

echo "▸ submitter flow (mirrors scripts/smoke.sh)"
NW_ID=$(curl -s "$API/apps" | jqpy "print(next(a['id'] for a in d if a['key']=='northwind'))")
RID=$(curl -s -X POST "$API/requests" -H 'content-type: application/json' \
  -d "{\"type\":\"enh\",\"title\":\"Kind smoke: monthly export\",\"description\":\"Add a monthly_export function that returns the export format name.\",\"app_id\":$NW_ID}" \
  | jqpy "print(d['id'])")
curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' \
  -d '{"answer":"Finance closes the books monthly and needs an export."}' >/dev/null
curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' \
  -d '{"answer":"CSV is fine."}' >/dev/null
curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' \
  -d '{"skip":true}' >/dev/null
curl -s -X POST "$API/requests/$RID/submit" -H 'content-type: application/json' -d '{}' >/dev/null
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
REF=$(curl -s "$API/requests/$RID" | jqpy "print(d['ref'])")
LREF=$(echo "$REF" | tr '[:upper:]' '[:lower:]')
ok "request $REF approved into the pipeline"

echo "▸ pipeline on the cluster (slow: codex runs each stage; retries are normal, escalation is not)"
DEADLINE=$(( $(date +%s) + 2400 ))   # 40-minute ceiling
LAST=""
while :; do
  OUT=$(curl -s "$API/requests/$RID")
  GATE=$(echo "$OUT" | jqpy "print(d['gate'])")
  NH=$(echo "$OUT" | jqpy "print(d['needs_human'])")
  STAGE=$(echo "$OUT" | jqpy "print(d['stage'])")
  JOBS=$(kubectl -n $NS get jobs -o name 2>/dev/null | sed 's|job.batch/||' | tr '\n' ' ')
  STATE="stage=$STAGE gate=$GATE jobs=[ $JOBS]"
  if [ "$STATE" != "$LAST" ]; then echo "  … $STATE"; LAST="$STATE"; fi
  [ "$NH" = "True" ] && fail "escalated: $(echo "$OUT" | jqpy "print(d['needs_human_reason'])")"
  [ "$GATE" = "approve_merge" ] && break
  [ "$(date +%s)" -gt "$DEADLINE" ] && fail "pipeline did not reach the merge gate in 40 min"
  sleep 10
done
ok "all stages + gates green — waiting at the merge gate (humans gate the irreversible)"

echo "▸ merge gate → done"
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
FINAL=$(curl -s "$API/requests/$RID" | jqpy "print(d['status'], d['stage'])")
[ "$FINAL" = "done done" ] || fail "merge approval did not finish the request ($FINAL)"
ok "request done"

echo "▸ the merge is REAL: the workspace repo's main moved"
POD=$(kubectl -n $NS get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
kubectl -n $NS exec "$POD" -c api -- git -C "/data/workspaces/$LREF" log --oneline -1 main \
  | grep -qi merge || fail "workspace main does not end in a merge commit"
ok "main's tip is the merge commit ('deployed' in the B2 sense; app deploy is B3)"

echo "▸ the orchestrator owned the Job lifecycle: nothing left behind"
LEFT=$(kubectl -n $NS get jobs -o name 2>/dev/null | grep "sf-$LREF" || true)
[ -z "$LEFT" ] || fail "Jobs left behind: $LEFT"
ok "every sf-$LREF Job was reaped after capture"

./scripts/netpol-smoke.sh

echo ""
echo "✓ KIND SMOKE PASSED — one request end-to-end on the cluster (Plan B2 milestone)"
