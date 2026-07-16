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
if [ -n "${SF_GITHUB_TOKEN:-}" ] && [[ "$SF_REPO_URL" == https://github.com/* ]]; then
  AUTHED_URL="https://x-access-token:${SF_GITHUB_TOKEN}@${SF_REPO_URL#https://}"
  git clone -q --branch "$SF_BRANCH" "$AUTHED_URL" "$REPO" >/dev/null 2>&1 || die_stage "clone failed"
  if [ "$SF_STAGE" = "review" ]; then
    # the read-only reviewer never pushes and its output is surfaced verbatim —
    # it keeps NO credentialed origin after the clone
    git -C "$REPO" remote set-url origin "$SF_REPO_URL" || die_stage "origin setup failed"
  else
    git -C "$REPO" remote set-url origin "$AUTHED_URL" || die_stage "origin setup failed"
  fi
else
  git clone -q --branch "$SF_BRANCH" "$SF_REPO_URL" "$REPO" || die_stage "clone failed: $SF_REPO_URL"
fi
cd "$REPO"
git config user.email agent@sf.local
git config user.name "sf-agent"

if [ "$SF_ROLE" = "clone" ]; then
  # Build-Job init (Plan B3): place the pinned SHA of main at /workspace/repo for
  # kaniko. No LLM, no push credential — a pure checkout (spec §7 build input =
  # repo + SHA).
  : "${SF_SHA:?}"
  git -C "$REPO" checkout -q "$SF_SHA" || die_stage "build clone: SHA $SF_SHA not found"
  note "build clone ready at $SF_SHA"
  exit 0
fi

if [ "$SF_ROLE" = "gate" ]; then
  exec /opt/sf/gate.sh
fi

# ---------------- stage ----------------
PROMPT_FILE="/opt/sf/prompts/${SF_STAGE}.md"
[ -f "$PROMPT_FILE" ] || die_stage "unknown stage $SF_STAGE"
PROMPT="$(cat "$PROMPT_FILE")"
if [ -n "${SF_GATE_FEEDBACK:-}" ]; then
  if [ "$SF_STAGE" = "review" ]; then
    PROMPT="$PROMPT

Your prior review requested changes for these reasons. Re-review the UNCHANGED code
honestly; repeat REQUEST-CHANGES if the concerns still apply. Do not approve merely
because this is a retry:
${SF_GATE_FEEDBACK}"
  else
    PROMPT="$PROMPT

The previous attempt failed its gate. Gate feedback to fix in THIS attempt:
${SF_GATE_FEEDBACK}"
  fi
fi
if [ -n "${SF_PREVIEW_FEEDBACK:-}" ]; then
  PROMPT="$PROMPT

The requester reviewed the LIVE preview and asked for changes. Revise PLAN.md so the
plan addresses this, then the pipeline re-runs from RED:
${SF_PREVIEW_FEEDBACK}"
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
    # THE POD IS THE SANDBOX: codex's own bwrap/landlock cannot create user
    # namespaces inside an unprivileged container (every exec/apply_patch fails,
    # codex exits 0 having written nothing — found live on kind). Isolation here
    # is the pod: non-root arbitrary UID, NetworkPolicy walls, ephemeral clone;
    # the review stage stays read-only by construction (nothing is pushed, and
    # the gate grades the pinned SHA on the orchestrator's own repo).
    SANDBOX=danger-full-access
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
  # anchored: the prompt demands the verdict START a line — prose mentions
  # ("I would not APPROVE") must not count as a verdict
  VERDICT="$(grep -m1 -oE '^(APPROVE|REQUEST-CHANGES)\b' "$OUT" || echo 'no explicit verdict')"
  SHA="$(git rev-parse HEAD)"
  write_envelope "$(jq -cn --arg d "$VERDICT" --arg s "$SHA" \
    '{v:1,outcome:"ok",detail:$d,sha:$s}')"
  exit 0
fi

git add -A
git commit -q -m "$SF_REF: $SF_STAGE (attempt ${SF_ATTEMPT:-1})" 2>/dev/null \
  || note "stage produced no changes — the gate will judge the unchanged SHA"
git push -q origin "HEAD:$SF_BRANCH" >/dev/null 2>&1 || die_stage "push to $SF_BRANCH failed"
SHA="$(git rev-parse HEAD)"
write_envelope "$(jq -cn --arg s "$SHA" '{v:1,outcome:"ok",detail:"stage complete",sha:$s}')"
