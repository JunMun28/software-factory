#!/usr/bin/env bash
# End-to-end smoke test against a REAL server process (fresh throwaway DB).
# Exercises the full Request lifecycle the way the web app drives it:
#   create → interview ×3 → submit → spec gate → approve (+ replay) →
#   simulator ticks → merge gate → approve merge → deployed.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8911
DB="$(mktemp -d)/smoke.db"
API="http://localhost:$PORT/api"

echo "▸ booting API on :$PORT (db: $DB)"
(cd api && FACTORY_DB_URL="sqlite:///$DB" uv run uvicorn app.main:app --port $PORT >/dev/null 2>&1) &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for i in $(seq 1 40); do
  curl -sf "$API/apps" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "$API/apps" >/dev/null || { echo "✗ API did not come up"; exit 1; }

jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
fail() { echo "✗ $1"; exit 1; }
ok() { echo "  ✓ $1"; }

echo "▸ submitter flow"
NW_ID=$(curl -s "$API/apps" | jqpy "print(next(a['id'] for a in d if a['key']=='northwind'))")
RID=$(curl -s -X POST "$API/requests" -H 'content-type: application/json' \
  -d "{\"type\":\"enh\",\"title\":\"Smoke: bulk receipt upload\",\"description\":\"Uploads are one at a time.\",\"app_id\":$NW_ID}" \
  | jqpy "print(d['id'])")
ok "request created (id $RID, persist-first)"

curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' -d '{"answer":"It takes 15 minutes of clicking."}' >/dev/null
Q2=$(curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' -d '{"answer":"A few dozen"}' | jqpy "print(d['final'])")
[ "$Q2" = "True" ] || fail "interview did not reach the final question"
DONE=$(curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' -d '{"skip":true}' | jqpy "print(d['done'])")
[ "$DONE" = "True" ] || fail "interview did not finish after 3 turns"
ok "scripted interview: 2 answers + 1 skip → done"

STATUS=$(curl -s -X POST "$API/requests/$RID/submit" -H 'content-type: application/json' -d '{}' | jqpy "print(d['status'], d['gate'])")
[ "$STATUS" = "pending_approval approve_spec" ] || fail "submit did not raise the spec gate ($STATUS)"
ok "submit → draft spec + approve_spec gate"

ASSUME=$(curl -s "$API/requests/$RID" | jqpy "print(any(l['assume'] for l in d['spec_lines']))")
[ "$ASSUME" = "True" ] || fail "draft spec has no explicit ASSUMPTION line"
ok "grounded spec carries an explicit ASSUMPTION"

INBOX=$(curl -s "$API/inbox" | jqpy "print(any(r['id']==$RID for r in d))")
[ "$INBOX" = "True" ] || fail "gate item missing from needs-me inbox"
ok "gate shows in the needs-me inbox"

echo "▸ admin gates + factory run"
curl -s -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' -d '{"actor":"Kim P."}' >/dev/null
ST=$(curl -s "$API/requests/$RID" | jqpy "print(d['status'], d['stage'], d['repo_ready'], d['spec_pr_open'], d['stage2_fired'])")
[ "$ST" = "approved architecture True True True" ] || fail "approve ledger wrong ($ST)"
ok "approve: status=approved, stage=architecture, 3-step ledger complete"

EVENTS_BEFORE=$(curl -s "$API/events?request_id=$RID" | jqpy "print(len(d))")
curl -s -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' -d '{"actor":"Kim P."}' >/dev/null
EVENTS_AFTER=$(curl -s "$API/events?request_id=$RID" | jqpy "print(len(d))")
[ "$EVENTS_BEFORE" = "$EVENTS_AFTER" ] || fail "approve replay emitted duplicate events"
ok "approve replay is idempotent (ADR 0006)"

for i in $(seq 1 8); do curl -s -X POST "$API/simulator/tick" >/dev/null; done
GATE=$(curl -s "$API/requests/$RID" | jqpy "print(d['stage'], d['gate'])")
[ "$GATE" = "review approve_merge" ] || fail "simulator did not stop at the merge gate ($GATE)"
ok "stages 2-5 ran; factory waits at the merge gate (humans gate the irreversible)"

curl -s -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' -d '{"actor":"Kim P."}' >/dev/null
FINAL=$(curl -s "$API/requests/$RID" | jqpy "print(d['status'], d['stage'])")
[ "$FINAL" = "done done" ] || fail "merge approval did not deploy ($FINAL)"
DEPLOYED=$(curl -s "$API/events?request_id=$RID" | jqpy "print(any('Deployed' in e['title'] for e in d))")
[ "$DEPLOYED" = "True" ] || fail "no Deployed milestone in the event log"
ok "merge approved → deployed, milestone in the two-axis log"

echo "▸ event log (ADR 0008)"
CURSOR_OK=$(curl -s "$API/events?after=3" | jqpy "print(all(e['id']>3 for e in d) and d==sorted(d,key=lambda e:e['id']))")
[ "$CURSOR_OK" = "True" ] || fail "keyset cursor broken"
ok "keyset ?after= cursor holds"

echo ""
echo "✓ SMOKE PASSED — full lifecycle verified against a live server"
