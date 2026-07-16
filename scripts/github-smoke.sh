#!/usr/bin/env bash
# Opt-in end-to-end over REAL GitHub (Plan B4b). Requires FACTORY_GITHUB_TOKEN +
# FACTORY_GITHUB_OWNER and a running kind cluster. CREATES REAL GITHUB RESOURCES
# (a private sf-app-<slug> repo + a PR) — set GITHUB_SMOKE_CONFIRMED=1 to
# acknowledge. Cleanup deletes the test repo at the end (best-effort: a
# fine-grained PAT may lack repo-delete; the script then prints the manual step).
#
# Prereqs: task kind-up kind-load kind-deploy sync-codex-auth sync-github-token
# Spends real codex usage; a clean run takes 15-30 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${FACTORY_GITHUB_TOKEN:?set FACTORY_GITHUB_TOKEN (fine-grained PAT)}"
: "${FACTORY_GITHUB_OWNER:?set FACTORY_GITHUB_OWNER (github username)}"

API="http://api.localtest.me:8081/api"
NS=software-factory
SLUG=northwind
REPO="sf-app-$SLUG"

jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
fail() { echo "✗ $1"; exit 1; }
ok() { echo "  ✓ $1"; }
gh_api() { curl -sf -H "Authorization: Bearer $FACTORY_GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" "https://api.github.com$1"; }

echo "‼ THIS WILL CREATE github.com/$FACTORY_GITHUB_OWNER/$REPO (private) + a PR"
[ "${GITHUB_SMOKE_CONFIRMED:-}" = "1" ] || { echo "set GITHUB_SMOKE_CONFIRMED=1 to proceed"; exit 2; }

echo "▸ preflight"
kubectl -n $NS get secret sf-github-token >/dev/null 2>&1 \
  || fail "Secret sf-github-token missing — run 'task sync-github-token' first"
kubectl -n $NS get secret sf-codex-auth >/dev/null 2>&1 \
  || fail "Secret sf-codex-auth missing — run 'task sync-codex-auth' first"
curl -sf "$API/health" | jqpy "print(d['runner'])" | grep -qx kube || fail "runner is not kube"
ok "cluster healthy, both Secrets present"

echo "▸ submitter flow"
NW_ID=$(curl -s "$API/apps" | jqpy "print(next(a['id'] for a in d if a['key']=='northwind'))")
RID=$(curl -s -X POST "$API/requests" -H 'content-type: application/json' \
  -d "{\"type\":\"enh\",\"title\":\"GitHub smoke: quarterly export\",\"description\":\"Add a quarterly_export function that returns the export format name.\",\"app_id\":$NW_ID}" \
  | jqpy "print(d['id'])")
for BODY in '{"answer":"Finance needs a quarterly export too."}' '{"answer":"CSV is fine."}' '{"skip":true}'; do
  curl -s -X POST "$API/requests/$RID/interview" -H 'content-type: application/json' -d "$BODY" >/dev/null
done
curl -s -X POST "$API/requests/$RID/submit" -H 'content-type: application/json' -d '{}' >/dev/null
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
REF=$(curl -s "$API/requests/$RID" | jqpy "print(d['ref'])")
LREF=$(echo "$REF" | tr '[:upper:]' '[:lower:]')
ok "request $REF approved into the pipeline"

echo "▸ pipeline over GitHub (repo + PR appear as the stages run)"
DEADLINE=$(( $(date +%s) + 2400 ))
LAST=""
while :; do
  OUT=$(curl -s "$API/requests/$RID")
  GATE=$(echo "$OUT" | jqpy "print(d['gate'])")
  NH=$(echo "$OUT" | jqpy "print(d['needs_human'])")
  STAGE=$(echo "$OUT" | jqpy "print(d['stage'])")
  STATE="stage=$STAGE gate=$GATE"
  if [ "$STATE" != "$LAST" ]; then echo "  … $STATE"; LAST="$STATE"; fi
  [ "$NH" = "True" ] && fail "escalated: $(echo "$OUT" | jqpy "print(d['needs_human_reason'])")"
  [ "$GATE" = "approve_merge" ] && break
  [ "$(date +%s)" -gt "$DEADLINE" ] && fail "pipeline did not reach the merge gate in 40 min"
  sleep 10
done
gh_api "/repos/$FACTORY_GITHUB_OWNER/$REPO" >/dev/null || fail "repo not created on GitHub"   # [REAL]
PR=$(gh_api "/repos/$FACTORY_GITHUB_OWNER/$REPO/pulls?state=open" | jqpy "print(d[0]['number'] if d else '')")
[ -n "$PR" ] || fail "PR not opened on GitHub"                                                # [REAL]
ok "repo $REPO exists on GitHub; PR #$PR open"

echo "▸ merge gate → merged ON GITHUB → deploy gate"
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
for _ in $(seq 1 30); do
  GATE=$(curl -s "$API/requests/$RID" | jqpy "print(d['gate'])")
  [ "$GATE" = "approve_deploy" ] && break || sleep 2
done
[ "$GATE" = "approve_deploy" ] || fail "request did not reach the deploy gate after the merge"
gh_api "/repos/$FACTORY_GITHUB_OWNER/$REPO/pulls/$PR" | jqpy "assert d['merged'] is True" \
  || fail "PR #$PR not merged on GitHub"                                                      # [REAL]
ok "PR #$PR merged on GitHub (SHA-precondition API merge); holding at the deploy gate"

echo "▸ deploy gate → built from the mirror → live pod"
curl -sf -X POST "$API/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null
DEPLOY_DEADLINE=$(( $(date +%s) + 900 ))
while :; do
  OUT=$(curl -s "$API/requests/$RID")
  STATUS=$(echo "$OUT" | jqpy "print(d['status'])")
  NH=$(echo "$OUT" | jqpy "print(d['needs_human'])")
  [ "$NH" = "True" ] && fail "escalated during build/deploy: $(echo "$OUT" | jqpy "print(d['needs_human_reason'])")"
  [ "$STATUS" = "done" ] && break
  [ "$(date +%s)" -gt "$DEPLOY_DEADLINE" ] && fail "build+deploy did not finish in 15 min"
  sleep 5
done
curl -sf "http://$SLUG.localtest.me:8081/health" | grep -q '"status":"ok"' \
  || fail "produced app /health did not answer through the ingress"
ok "request done — merged on GitHub, built from the mirror, live through the ingress"

echo ""
echo "✓ GITHUB SMOKE PASSED — one request → real GitHub repo → PR → API merge → deployed pod"

if [ "${GITHUB_SMOKE_CLEANUP:-1}" = "1" ]; then
  echo "▸ cleanup: deleting github.com/$FACTORY_GITHUB_OWNER/$REPO"
  curl -sf -X DELETE -H "Authorization: Bearer $FACTORY_GITHUB_TOKEN" \
    "https://api.github.com/repos/$FACTORY_GITHUB_OWNER/$REPO" \
    && echo "  ✓ test repo deleted" \
    || echo "  ⚠ could not auto-delete $REPO — delete it by hand (the PAT may lack repo-delete)"
fi
