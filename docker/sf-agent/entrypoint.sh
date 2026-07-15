#!/usr/bin/env bash
# sf-agent entrypoint (Plan B2; spec §5): clone the work branch, run the
# stage (or hand off to the gate script), report a status envelope in the
# termination message and structured NDJSON on stdout.
#
# Output contract (B1 parsers):
#   stage envelope: {"v":1,"outcome":"ok"|"fail","detail":str,"sha":str|null}
#   NDJSON logs:    {"type":"note"|"review"|"pytest","text":str} per line
set -uo pipefail

TERMLOG="${SF_TERMLOG:-/dev/termination-log}"
write_envelope() { printf '%s' "$1" > "$TERMLOG" 2>/dev/null || printf 'ENVELOPE %s\n' "$1"; }
note() { jq -cn --arg t "$1" '{type:"note",text:$t}'; }
die_stage() {
  note "$1"
  write_envelope "$(jq -cn --arg d "$1" '{v:1,outcome:"fail",detail:$d,sha:null}')"
  exit 1
}

: "${SF_REF:?}" "${SF_STAGE:?}" "${SF_ROLE:?}" "${SF_REPO_URL:?}" "${SF_BRANCH:?}"
REPO=/workspace/repo

note "cloning $SF_REPO_URL ($SF_BRANCH)"
git clone -q --branch "$SF_BRANCH" "$SF_REPO_URL" "$REPO" || die_stage "clone failed: $SF_REPO_URL"
cd "$REPO"
git config user.email agent@sf.local
git config user.name "sf-agent"

if [ "$SF_ROLE" = "gate" ]; then
  exec /opt/sf/gate.sh
fi

# ---------------- stage ----------------
PROMPT_FILE="/opt/sf/prompts/${SF_STAGE}.md"
[ -f "$PROMPT_FILE" ] || die_stage "unknown stage $SF_STAGE"
PROMPT="$(cat "$PROMPT_FILE")"
if [ -n "${SF_GATE_FEEDBACK:-}" ]; then
  PROMPT="$PROMPT

The previous attempt failed its gate. Gate feedback to fix in THIS attempt:
${SF_GATE_FEEDBACK}"
fi

OUT=/workspace/agent-output.txt
CLI="${SF_CLI:-codex}"
case "$CLI" in
  codex)
    export CODEX_HOME=/workspace/.codex
    mkdir -p "$CODEX_HOME"
    if [ -f /secrets/codex/auth.json ]; then
      # copied, not mounted: codex refreshes tokens in place and the mount is read-only
      cp /secrets/codex/auth.json "$CODEX_HOME/auth.json"
    else
      die_stage "SF_CLI=codex but no /secrets/codex/auth.json — run 'task sync-codex-auth'"
    fi
    SANDBOX=workspace-write
    [ "$SF_STAGE" = "review" ] && SANDBOX=read-only
    codex exec --skip-git-repo-check -s "$SANDBOX" --cd "$REPO" \
      ${SF_MODEL:+-m "$SF_MODEL"} "$PROMPT" > "$OUT" 2>&1 \
      || die_stage "codex exec failed: $(tail -c 400 "$OUT")"
    ;;
  opencode)
    CFG=/opt/sf/opencode/factory-write.json
    [ "$SF_STAGE" = "review" ] && CFG=/opt/sf/opencode/factory-readonly.json
    OPENCODE_CONFIG="$CFG" opencode run --format json --dir "$REPO" \
      ${SF_MODEL:+-m "$SF_MODEL"} "$PROMPT" > "$OUT" 2>&1 \
      || die_stage "opencode run failed: $(tail -c 400 "$OUT")"
    ;;
  *)
    die_stage "unsupported SF_CLI '$CLI'"
    ;;
esac
note "agent finished; output $(wc -c < "$OUT" | tr -d ' ') bytes"

if [ "$SF_STAGE" = "review" ]; then
  # read-only stage: NOTHING is pushed (spec §5) — the review reaches the
  # event log via captured NDJSON, its verdict via the envelope detail
  jq -cn --arg t "$(tail -c 20000 "$OUT")" '{type:"review",text:$t}'
  VERDICT="$(grep -m1 -oE 'APPROVE|REQUEST-CHANGES' "$OUT" || echo 'no explicit verdict')"
  SHA="$(git rev-parse HEAD)"
  write_envelope "$(jq -cn --arg d "$VERDICT" --arg s "$SHA" \
    '{v:1,outcome:"ok",detail:$d,sha:$s}')"
  exit 0
fi

git add -A
git commit -q -m "$SF_REF: $SF_STAGE (attempt ${SF_ATTEMPT:-1})" 2>/dev/null \
  || note "stage produced no changes — the gate will judge the unchanged SHA"
git push -q origin "HEAD:$SF_BRANCH" || die_stage "push to $SF_BRANCH failed"
SHA="$(git rev-parse HEAD)"
write_envelope "$(jq -cn --arg s "$SHA" '{v:1,outcome:"ok",detail:"stage complete",sha:$s}')"
