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
kubectl -n $NS set env deployment/factory-api FACTORY_PREVIEW=1 >/dev/null
kubectl -n $NS rollout status deployment/factory-api --timeout=180s >/dev/null \
  || fail "factory-api did not restart with FACTORY_PREVIEW=1"
# the restart re-points the ingress endpoint; give it a moment to propagate
# before declaring the API unreachable (single-shot curl races 503s).
HEALTH=""
for _ in $(seq 1 30); do
  if HEALTH=$(curl -sf "$API/health" 2>/dev/null); then break; fi
  sleep 2
done
[ -n "$HEALTH" ] || fail "API unreachable at $API after 60s (ingress up? task kind-deploy?)"
[ "$(echo "$HEALTH" | jqpy "print(d['runner'])")" = "kube" ] || fail "runner is not kube"
POD=$(kubectl -n $NS get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
dbpy() { kubectl -n "$NS" exec "$POD" -c api -- uv run --no-sync python -c "$1"; }
ok "cluster healthy, runner=kube, preview loop enabled"
PVC_MODE=$(kubectl -n $NS get pvc sf-registry-data -o jsonpath='{.spec.accessModes[0]}')
[ "$PVC_MODE" = "ReadWriteOnce" ] || fail "registry PVC is not ReadWriteOnce"
PVC_SIZE=$(kubectl -n $NS get pvc sf-registry-data -o jsonpath='{.spec.resources.requests.storage}')
[ "$PVC_SIZE" = "5Gi" ] || fail "registry PVC is not the expected durable 5Gi volume"
REGISTRY_STRATEGY=$(kubectl -n $NS get deploy sf-registry -o jsonpath='{.spec.strategy.type}')
[ "$REGISTRY_STRATEGY" = "Recreate" ] || fail "RWO registry Deployment is not Recreate"
BUILD_CAP=$(kubectl -n $NS get configmap factory-config -o jsonpath='{.data.FACTORY_BUILD_CAP}')
[ "$BUILD_CAP" = "4" ] || fail "FACTORY_BUILD_CAP is not configured to 4"
ok "registry PVC is durable/Recreate; build capacity is bounded"

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
  [ "$GATE" = "accept_preview" ] && break
  [ "$(date +%s)" -gt "$DEADLINE" ] && fail "pipeline did not reach preview acceptance in 40 min"
  sleep 10
done
SLUG=northwind
PREVIEW_NAME=sf-app-$SLUG-preview
PREVIEW_URL="http://$SLUG-preview.localtest.me:8081"
kubectl -n $NS rollout status deployment/$PREVIEW_NAME --timeout=180s >/dev/null \
  || fail "round-1 preview Deployment did not become available"
curl -sf "$PREVIEW_URL/health" | grep -q '"status":"ok"' \
  || fail "round-1 preview /health did not answer"
LABELS=$(kubectl -n $NS get deployment/$PREVIEW_NAME -o json)
[ "$(echo "$LABELS" | jqpy "print(d['metadata']['labels'].get('sf/request',''))")" = "$LREF" ] \
  || fail "preview is missing sf/request=$LREF"
[ "$(echo "$LABELS" | jqpy "print(d['metadata']['labels'].get('sf/preview',''))")" = "true" ] \
  || fail "preview is missing sf/preview=true"
[ "$(echo "$LABELS" | jqpy "print('sf/instance' in d['metadata']['labels'])")" = "False" ] \
  || fail "preview must never carry sf/instance"
PREVIEW1=$(curl -sf "$API/requests/$RID/preview")
DIGEST1=$(echo "$PREVIEW1" | jqpy "print(d['digest'])")
[ "$(echo "$PREVIEW1" | jqpy "print(d['round'])")" = "1" ] \
  || fail "first preview did not report display round 1"
ok "round-1 preview is live, healthy, and request-scoped"

echo "▸ requester feedback → architecture re-plan → full re-grade"
curl -sf -X POST "$API/requests/$RID/preview/request-changes" \
  -H 'content-type: application/json' \
  -d '{"feedback":"Keep the export action visible and explain the CSV result.","page_path":"/"}' >/dev/null
CHANGED=$(curl -sf "$API/requests/$RID")
[ "$(echo "$CHANGED" | jqpy "print(d['stage'])")" = "architecture" ] \
  || fail "feedback did not rewind the request to architecture"
FEEDBACK=$(curl -sf "$API/requests/$RID/preview")
[ "$(echo "$FEEDBACK" | jqpy "print(d['round'])")" = "2" ] \
  || fail "feedback did not increment preview_round"
[ "$(echo "$FEEDBACK" | jqpy "print(d['feedback'][-1]['round'])")" = "1" ] \
  || fail "PreviewFeedback row was not filed at round 1"

ARCH_JOB=""
for _ in $(seq 1 60); do
  ARCH_JOB=$(kubectl -n $NS get jobs -l "sf/request=$LREF,sf/stage=architecture" \
    -o jsonpath='{.items[-1:].metadata.name}' 2>/dev/null || true)
  [ -n "$ARCH_JOB" ] && break || sleep 2
done
[ -n "$ARCH_JOB" ] || fail "rewound architecture Job did not start"
ARCH=$(kubectl -n $NS get job "$ARCH_JOB" -o json)
INJECTED=$(echo "$ARCH" | jqpy "print(next((e.get('value','') for e in d['spec']['template']['spec']['containers'][0]['env'] if e['name']=='SF_PREVIEW_FEEDBACK'),''))")
echo "$INJECTED" | grep -q "Keep the export action visible" \
  || fail "architecture Job did not receive SF_PREVIEW_FEEDBACK"
SUPERSEDED=$(dbpy "from app.db import SessionLocal; from app.models import StageJob; from sqlalchemy import select; db=SessionLocal(); print(sum(1 for r in db.scalars(select(StageJob).where(StageJob.request_id==$RID, StageJob.stage.in_(['red','green','review']))).all() if r.status=='superseded'))")
[ "$SUPERSEDED" -ge 3 ] || fail "round-1 red/green/review rows were not superseded"
ok "feedback persisted, prior grade superseded, architecture received the requester brief"

DEADLINE=$(( $(date +%s) + 2400 ))
while :; do
  OUT=$(curl -s "$API/requests/$RID")
  GATE=$(echo "$OUT" | jqpy "print(d['gate'])")
  NH=$(echo "$OUT" | jqpy "print(d['needs_human'])")
  [ "$NH" = "True" ] && fail "feedback round escalated: $(echo "$OUT" | jqpy "print(d['needs_human_reason'])")"
  [ "$GATE" = "accept_preview" ] && break
  [ "$(date +%s)" -gt "$DEADLINE" ] && fail "round-2 preview did not become ready in 40 min"
  sleep 10
done
PREVIEW2=$(curl -sf "$API/requests/$RID/preview")
DIGEST2=$(echo "$PREVIEW2" | jqpy "print(d['digest'])")
ACCEPTED_SHA=$(echo "$PREVIEW2" | jqpy "print(d['sha'])")
[ "$(echo "$PREVIEW2" | jqpy "print(d['round'])")" = "2" ] \
  || fail "second preview did not report display round 2"
[ "$DIGEST2" != "$DIGEST1" ] || fail "round-2 preview did not roll to a new digest"
curl -sf "$PREVIEW_URL/health" >/dev/null || fail "stable preview URL stopped answering"
ok "round-2 preview rolled in place at the same URL with a new digest"

echo "▸ requester accepts exactly the previewed SHA → merge gate → deploy gate"
curl -sf -X POST "$API/requests/$RID/preview/accept" -H 'content-type: application/json' \
  -d '{}' >/dev/null
[ "$(curl -s "$API/requests/$RID" | jqpy "print(d['gate'])")" = "approve_merge" ] \
  || fail "accept did not raise the merge gate"
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
for _ in $(seq 1 30); do
  GATE=$(curl -s "$API/requests/$RID" | jqpy "print(d['gate'])")
  [ "$GATE" = "approve_deploy" ] && break || sleep 2
done
OUT=$(curl -s "$API/requests/$RID")
STATUS=$(echo "$OUT" | jqpy "print(d['status'])"); STAGE=$(echo "$OUT" | jqpy "print(d['stage'])")
GATE=$(echo "$OUT" | jqpy "print(d['gate'])")
[ "$STATUS $STAGE $GATE" = "approved deploy approve_deploy" ] \
  || fail "request did not hold at the deploy gate (status=$STATUS stage=$STAGE gate=$GATE)"
MERGE_SHA=$(dbpy "import json; from app.db import SessionLocal; from app.models import Intent; db=SessionLocal(); print(json.loads(db.get(Intent,'merge:$REF').payload_json)['sha'])")
[ "$MERGE_SHA" = "$ACCEPTED_SHA" ] || fail "merge was not preconditioned on the accepted preview SHA"
EVENTS=$(curl -sf "$API/events?request_id=$RID&limit=500")
EVENT_URL=$(echo "$EVENTS" | jqpy "p=next(e['payload'] for e in reversed(d) if (e.get('payload') or {}).get('gate')=='approve_deploy'); print(p.get('preview_url',''))")
EVENT_ROUND=$(echo "$EVENTS" | jqpy "p=next(e['payload'] for e in reversed(d) if (e.get('payload') or {}).get('gate')=='approve_deploy'); print(p.get('preview_round',''))")
EVENT_ACCEPTOR=$(echo "$EVENTS" | jqpy "p=next(e['payload'] for e in reversed(d) if (e.get('payload') or {}).get('gate')=='approve_deploy'); print(p.get('accepted_by',''))")
[ "$EVENT_URL" = "http://$SLUG-preview.localtest.me" ] \
  || fail "deploy gate event lost the accepted preview URL"
[ "$EVENT_ROUND" = "1" ] || fail "deploy gate event lost preview_round=1"
[ -n "$EVENT_ACCEPTOR" ] || fail "deploy gate event lost accepted_by"
curl -sf "$PREVIEW_URL/health" >/dev/null || fail "preview was reaped before deploy approval"
kubectl -n $NS get jobs -o name 2>/dev/null | grep -q "sf-$LREF-build" \
  && fail "prod build started before the deploy gate was approved"
ok "merge used the accepted SHA; deploy gate retains its preview evidence"

echo "▸ deploy gate → build → deploy → done (second human gate approved)"
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
DEPLOY_DEADLINE=$(( $(date +%s) + 900 ))   # 15-minute ceiling for build+deploy
LAST=""
while :; do
  OUT=$(curl -s "$API/requests/$RID")
  STATUS=$(echo "$OUT" | jqpy "print(d['status'])")
  STAGE=$(echo "$OUT" | jqpy "print(d['stage'])")
  NH=$(echo "$OUT" | jqpy "print(d['needs_human'])")
  JOBS=$(kubectl -n $NS get jobs -o name 2>/dev/null | sed 's|job.batch/||' | tr '\n' ' ')
  STATE="status=$STATUS stage=$STAGE jobs=[ $JOBS]"
  if [ "$STATE" != "$LAST" ]; then echo "  … $STATE"; LAST="$STATE"; fi
  [ "$NH" = "True" ] && fail "escalated during build/deploy: $(echo "$OUT" | jqpy "print(d['needs_human_reason'])")"
  [ "$STATUS" = "done" ] && break
  [ "$(date +%s)" -gt "$DEPLOY_DEADLINE" ] && fail "build+deploy did not finish in 15 min"
  sleep 5
done
ok "request done (merged, built, deployed)"

echo "▸ the merge is REAL: the workspace repo's main moved"
kubectl -n $NS exec "$POD" -c api -- git -C "/data/workspaces/$LREF" log --oneline -1 main \
  | grep -qi merge || fail "workspace main does not end in a merge commit"
ok "main's tip is the merge commit ('deployed' in the B2 sense; app deploy is B3)"

echo "▸ the produced app was built and deployed (Plan B3)"
# the app Deployment rolled out from the kaniko-built image
kubectl -n $NS rollout status deploy/sf-app-$SLUG --timeout=180s >/dev/null \
  || fail "produced-app Deployment did not become available"
kubectl -n $NS get pod -l sf/instance=$SLUG \
  -o jsonpath='{.items[0].status.phase}' | grep -qx Running \
  || fail "produced-app pod is not Running"
# it answers HTTP THROUGH THE INGRESS
for _ in $(seq 1 30); do
  curl -sf "http://$SLUG.localtest.me:8081/health" >/dev/null && break || sleep 2
done
curl -sf "http://$SLUG.localtest.me:8081/health" | grep -q '"status":"ok"' \
  || fail "produced app /health did not answer through the ingress"
ok "produced app pod Running and /health answers through the ingress"
# the image is digest-pinned to what the factory built
kubectl -n $NS get deploy/sf-app-$SLUG -o jsonpath='{.spec.template.spec.containers[0].image}' \
  | grep -q "sf-registry:5000/sf-app-$SLUG@sha256:" \
  || fail "app image is not digest-pinned to the local registry"
ok "app image is digest-pinned (sf-registry:5000/sf-app-$SLUG@sha256:…)"

# DEPLOY-02: force a zero-retention online manifest-GC pass. The live digest
# must be in the factory-computed protection set and therefore never selected.
LIVE_IMAGE=$(kubectl -n $NS get deploy/sf-app-$SLUG -o jsonpath='{.spec.template.spec.containers[0].image}')
LIVE_DIGEST=${LIVE_IMAGE##*@}
GC_RESULT=$(dbpy "import json; from app import registry, settings; from app.db import SessionLocal; from app.kube_client import RealKubeClient; settings.REGISTRY_RETENTION='0s'; db=SessionLocal(); result=registry.gc_unreferenced(db, RealKubeClient()); print(json.dumps({'protected': sorted(result.protected), 'deleted': result.deleted, 'skipped_reason': result.skipped_reason})); db.close()")
[ "$(echo "$GC_RESULT" | jqpy "print(d['skipped_reason'])")" = "None" ] \
  || fail "registry GC failed closed during smoke: $GC_RESULT"
echo "$GC_RESULT" | jq -e --arg digest "$LIVE_DIGEST" '.protected | index($digest) != null' >/dev/null \
  || fail "live Deployment digest was absent from the GC protection set"
echo "$GC_RESULT" | jq -e --arg digest "$LIVE_DIGEST" 'all(.deleted[]?; .[1] != $digest)' >/dev/null \
  || fail "registry GC selected the live Deployment digest"
MANIFEST_STATUS=$(dbpy "import urllib.request; request=urllib.request.Request('http://sf-registry:5000/v2/sf-app-$SLUG/manifests/$LIVE_DIGEST', method='HEAD', headers={'Accept':'application/vnd.docker.distribution.manifest.v2+json'}); print(urllib.request.urlopen(request, timeout=10).status)")
[ "$MANIFEST_STATUS" = "200" ] || fail "live registry manifest disappeared after GC"
ok "zero-retention GC preserved the live digest"

echo "▸ the orchestrator owned the Job lifecycle: nothing left behind"
LEFT=$(kubectl -n $NS get jobs -o name 2>/dev/null | grep "sf-$LREF" || true)
[ -z "$LEFT" ] || fail "Jobs left behind (incl. build): $LEFT"
ok "every sf-$LREF Job (stages, gates, build) was reaped after capture"
# DEPLOY-03: Jobs being gone is not enough — a Job deleted without Foreground GC
# orphans its pods (found live: 31 ownerless sf-req-* pods after 15h). Assert the
# pods cascaded too, scoped by label (robust to slug/name overlap).
PODS_LEFT=$(kubectl -n $NS get pods -l sf/request=$LREF -o name 2>/dev/null | wc -l | tr -d ' ')
[ "$PODS_LEFT" = "0" ] || fail "orphaned pods after Job reap (DEPLOY-03): $PODS_LEFT left"
ok "no orphaned pods — Foreground GC cascaded the reaped Jobs' pods"

PREVIEW_LEFT=$(kubectl -n $NS get deployment,service,ingress -l sf/request=$LREF \
  -o name 2>/dev/null || true)
[ -z "$PREVIEW_LEFT" ] || fail "preview resources left after finish_done: $PREVIEW_LEFT"
PTEARDOWN=$(dbpy "from app.db import SessionLocal; from app.models import StageJob; from sqlalchemy import select; db=SessionLocal(); print(db.scalar(select(StageJob.id).where(StageJob.request_id==$RID, StageJob.role=='pteardown')) or '')")
[ -n "$PTEARDOWN" ] || fail "preview teardown did not write its durable pteardown marker"
REAP_EVENT=$(echo "$EVENTS" | jqpy "print(any(e['kind']=='recovery_action' and e['title'].startswith('Preview reaped') for e in d))")
if [ "$REAP_EVENT" != "True" ]; then
  EVENTS=$(curl -sf "$API/events?request_id=$RID&limit=500")
  REAP_EVENT=$(echo "$EVENTS" | jqpy "print(any(e['kind']=='recovery_action' and e['title'].startswith('Preview reaped') for e in d))")
fi
[ "$REAP_EVENT" = "True" ] || fail "preview reap recovery_action was not emitted"
kubectl -n $NS get deployment -l sf/instance=$SLUG -o name \
  | grep -qx "deployment.apps/sf-app-$SLUG" \
  || fail "preview teardown touched the production app"
ok "preview reaped with durable evidence; production instance is untouched"

./scripts/netpol-smoke.sh

echo ""
echo "✓ KIND SMOKE PASSED — one feedback round: preview → re-plan/re-grade → accepted SHA → deploy → preview reaped"
