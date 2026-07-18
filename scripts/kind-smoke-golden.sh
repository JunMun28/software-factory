#!/usr/bin/env bash
# E2E-4 golden-path smoke: a NEW app born from the golden Angular+FastAPI
# template, through the FULL approved product flow on the kind cluster:
#   intake → (spec gate auto) → REAL architecture agent → approve_architecture
#   gate (real PLAN.md evidence) → human approve → red/green/review agents on
#   the frontend/+backend/ layout → preview (kaniko multi-stage build) →
#   accept → merge → deploy gate → approve → DONE with /health live.
# One agent pass, no feedback rewind (that machinery is proven by
# kind-smoke.sh); this proves the E2E-2/E2E-3/E2E-4 deltas on real infra.
set -euo pipefail
NS=software-factory
API=http://api.localtest.me:8081/api
jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
fail() { echo "✗ FAIL: $1" >&2; exit 1; }
ok() { echo "  ✓ $1"; }

echo "▸ preflight: golden profile on the factory"
kubectl -n $NS get secret sf-codex-auth >/dev/null 2>&1 \
  || fail "Secret sf-codex-auth missing — run 'task sync-codex-auth' first"
kubectl -n $NS set env deployment/factory-api \
  FACTORY_PREVIEW=1 FACTORY_ARCH_GATE=on FACTORY_SPEC_GATE=auto \
  FACTORY_SAMPLE=/srv/templates/golden >/dev/null
kubectl -n $NS rollout status deployment/factory-api --timeout=180s >/dev/null \
  || fail "factory-api did not restart with the golden profile"
HEALTH=""
for _ in $(seq 1 30); do
  if HEALTH=$(curl -sf "$API/health" 2>/dev/null); then break; fi
  sleep 2
done
[ -n "$HEALTH" ] || fail "API unreachable at $API after 60s"
[ "$(echo "$HEALTH" | jqpy "print(d['runner'])")" = "kube" ] || fail "runner is not kube"
POD=$(kubectl -n $NS get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
kubectl -n $NS exec "$POD" -c api -- test -f /srv/templates/golden/frontend/package.json \
  || fail "golden template not baked into the api image"
ok "cluster healthy; golden template + arch gate + auto spec gate active"

echo "▸ new-app request (born from the golden template)"
RID=$(curl -s -X POST "$API/requests" -H 'content-type: application/json' \
  -d '{"type":"new","title":"Team tea roster","new_app_name":"Tea Roster","description":"A tea-break roster: team members pick Friday slots, the app rotates who brings snacks, and everyone sees the upcoming schedule."}' \
  | jqpy "print(d['id'])")
curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' \
  -d '{"answer":"Pick a slot, see the rotation, swap turns."}' >/dev/null
curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' \
  -d '{"skip":true}' >/dev/null
curl -s -X POST "$API/requests/$RID/submit" -H 'content-type: application/json' -d '{}' >/dev/null
OUT=$(curl -s "$API/requests/$RID")
REF=$(echo "$OUT" | jqpy "print(d['ref'])")
LREF=$(echo "$REF" | tr '[:upper:]' '[:lower:]')
STATUS=$(echo "$OUT" | jqpy "print(d['status'])")
[ "$STATUS" = "approved" ] \
  || fail "FACTORY_SPEC_GATE=auto did not auto-approve at submit (status=$STATUS)"
AUTO=$(curl -s "$API/requests/$RID" | jqpy "print(any(a['action']=='approved' for a in d['audit']))")
[ "$AUTO" = "True" ] || fail "auto-approval left no honest audit row"
ok "request $REF auto-approved into the pipeline (spec gate audit intact)"

echo "▸ REAL architecture agent on the golden workspace → architecture gate"
DEADLINE=$(( $(date +%s) + 1800 ))   # 30-minute ceiling for one agent stage
LAST=""
while :; do
  OUT=$(curl -s "$API/requests/$RID")
  GATE=$(echo "$OUT" | jqpy "print(d['gate'])")
  NH=$(echo "$OUT" | jqpy "print(d['needs_human'])")
  STAGE=$(echo "$OUT" | jqpy "print(d['stage'])")
  JOBS=$(kubectl -n $NS get jobs -l "sf/request=$LREF" -o name 2>/dev/null | sed 's|job.batch/||' | tr '\n' ' ')
  STATE="stage=$STAGE gate=$GATE jobs=[ $JOBS]"
  if [ "$STATE" != "$LAST" ]; then echo "  … $STATE"; LAST="$STATE"; fi
  [ "$NH" = "True" ] && fail "escalated: $(echo "$OUT" | jqpy "print(d['needs_human_reason'])")"
  [ "$GATE" = "approve_architecture" ] && break
  [ "$(date +%s)" -gt "$DEADLINE" ] && fail "architecture gate did not raise in 30 min"
  sleep 10
done
EVIDENCE=$(curl -s "$API/requests/$RID" | jqpy "print(json.dumps(d['evidence']))")
[ "$(echo "$EVIDENCE" | jqpy "print(d['kind'])")" = "architecture" ] \
  || fail "gate evidence is not kind=architecture"
EXCERPT=$(echo "$EVIDENCE" | jqpy "print(d.get('plan_excerpt') or '')")
[ -n "$EXCERPT" ] || fail "architecture gate has no real PLAN.md excerpt"
echo "$EXCERPT" | head -3 | sed 's/^/    │ /'
ok "architecture gate raised with a REAL plan excerpt"

echo "▸ human approves the architecture → red/green/review on the golden layout"
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
DEADLINE=$(( $(date +%s) + 3600 ))   # 60-minute ceiling for three agent stages + preview build
LAST=""
while :; do
  OUT=$(curl -s "$API/requests/$RID")
  GATE=$(echo "$OUT" | jqpy "print(d['gate'])")
  NH=$(echo "$OUT" | jqpy "print(d['needs_human'])")
  STAGE=$(echo "$OUT" | jqpy "print(d['stage'])")
  JOBS=$(kubectl -n $NS get jobs -l "sf/request=$LREF" -o name 2>/dev/null | sed 's|job.batch/||' | tr '\n' ' ')
  STATE="stage=$STAGE gate=$GATE jobs=[ $JOBS]"
  if [ "$STATE" != "$LAST" ]; then echo "  … $STATE"; LAST="$STATE"; fi
  [ "$NH" = "True" ] && fail "escalated: $(echo "$OUT" | jqpy "print(d['needs_human_reason'])")"
  [ "$GATE" = "accept_preview" ] && break
  [ "$(date +%s)" -gt "$DEADLINE" ] && fail "pipeline did not reach preview acceptance in 60 min"
  sleep 10
done
ok "red/green/review passed on the golden layout; preview built and deployed"

echo "▸ the preview is the REAL golden app (Angular static + FastAPI + /health)"
SLUG=$(curl -s "$API/requests/$RID" | jqpy "print(d['app_key'] or '$LREF')")
# --resolve everywhere a per-run subdomain appears: each run mints a brand-new
# *.localtest.me name, and one transient upstream DNS failure gets negatively
# cached by macOS for minutes — 90 straight probe misses on a live app (run 20)
PREVIEW_URL="http://$SLUG-preview.localtest.me:8081"
PREVIEW_RESOLVE="--resolve $SLUG-preview.localtest.me:8081:127.0.0.1"
curl -sf $PREVIEW_RESOLVE "$PREVIEW_URL/health" | grep -q '"status":"ok"' \
  || fail "preview /health did not answer"
curl -sf $PREVIEW_RESOLVE "$PREVIEW_URL/" | grep -qi "<!doctype html\|<html" \
  || fail "preview / did not serve the built Angular frontend"
ok "preview serves the Angular frontend AND the FastAPI health endpoint"

echo "▸ accept → merge → deploy gate → approve → done"
curl -sf -X POST "$API/requests/$RID/preview/accept" -H 'content-type: application/json' -d '{}' >/dev/null
[ "$(curl -s "$API/requests/$RID" | jqpy "print(d['gate'])")" = "approve_merge" ] \
  || fail "accept did not raise the merge gate"
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
for _ in $(seq 1 60); do
  GATE=$(curl -s "$API/requests/$RID" | jqpy "print(d['gate'])")
  [ "$GATE" = "approve_deploy" ] && break || sleep 2
done
[ "$GATE" = "approve_deploy" ] || fail "merge did not raise the deploy gate"
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
DEPLOY_DEADLINE=$(( $(date +%s) + 900 ))
LAST=""
while :; do
  OUT=$(curl -s "$API/requests/$RID")
  STATUS=$(echo "$OUT" | jqpy "print(d['status'])")
  NH=$(echo "$OUT" | jqpy "print(d['needs_human'])")
  JOBS=$(kubectl -n $NS get jobs -l "sf/request=$LREF" -o name 2>/dev/null | sed 's|job.batch/||' | tr '\n' ' ')
  STATE="status=$STATUS jobs=[ $JOBS]"
  if [ "$STATE" != "$LAST" ]; then echo "  … $STATE"; LAST="$STATE"; fi
  [ "$NH" = "True" ] && fail "escalated during build/deploy: $(echo "$OUT" | jqpy "print(d['needs_human_reason'])")"
  [ "$STATUS" = "done" ] && break
  [ "$(date +%s)" -gt "$DEPLOY_DEADLINE" ] && fail "build+deploy did not finish in 15 min"
  sleep 5
done
APP_URL="http://$SLUG.localtest.me:8081"
APP_RESOLVE="--resolve $SLUG.localtest.me:8081:127.0.0.1"
# `done` lands when the deploy is APPLIED; give the rollout up to 3 minutes
APP_OK=""
for _ in $(seq 1 90); do
  if curl -sf $APP_RESOLVE "$APP_URL/health" | grep -q '"status":"ok"'; then APP_OK=1; break; fi
  sleep 2
done
[ -n "$APP_OK" ] || fail "PROD app /health did not answer within 180s"
curl -sf $APP_RESOLVE "$APP_URL/" | grep -qi "<!doctype html\|<html" || fail "PROD app did not serve the frontend"
ok "request done — the golden app is LIVE at $APP_URL"

echo
echo "✓ GOLDEN SMOKE PASSED — new app born from the Angular+FastAPI template,"
echo "  architecture human-gated with real PLAN.md, built/reviewed by agents,"
echo "  previewed, merged, and deployed on the cluster"
