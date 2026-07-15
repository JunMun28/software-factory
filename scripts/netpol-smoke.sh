#!/usr/bin/env bash
# The tier-wall smoke (spec §2): "A NetworkPolicy smoke test (agent pod →
# factory-api must FAIL) runs in the deploy verify — enforcement is proven,
# never assumed." Probes run AS the tier (same labels + SA + non-root UID).
set -euo pipefail
NS=software-factory
OVR='{"spec":{"serviceAccountName":"sf-gate","automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":10101,"runAsGroup":0}}}'

probe() { # name labels command... → exit code of the pod
  local name=$1 labels=$2; shift 2
  kubectl -n "$NS" run "$name" --rm -i --restart=Never --image=sf-agent:dev \
    --labels="$labels" --overrides="$OVR" --command -- "$@" >/dev/null 2>&1
}

expect_ok() { # description name labels cmd...
  local desc=$1; shift
  if probe "$@"; then echo "  ✓ $desc"; else echo "✗ $desc (expected ALLOWED)"; exit 1; fi
}
expect_blocked() {
  local desc=$1; shift
  if probe "$@"; then echo "✗ $desc (expected BLOCKED)"; exit 1; else echo "  ✓ $desc"; fi
}

echo "▸ NetworkPolicy walls"
expect_blocked "stage pod → factory-api:8000 is BLOCKED (the spec §2 hard assertion)" \
  np-s-api "sf/tier=agent,sf/role=stage" \
  timeout 5 bash -c 'exec 3<>/dev/tcp/api/8000'
expect_ok "stage pod → git :9418 is allowed (clone/push door)" \
  np-s-git "sf/tier=agent,sf/role=stage" \
  timeout 5 bash -c 'exec 3<>/dev/tcp/api/9418'
expect_ok "stage pod → LLM endpoint :443 is allowed" \
  np-s-llm "sf/tier=agent,sf/role=stage" \
  timeout 10 bash -c 'exec 3<>/dev/tcp/api.openai.com/443'
expect_blocked "gate pod → LLM endpoint :443 is BLOCKED (no LLM in gates, spec §6)" \
  np-g-llm "sf/tier=agent,sf/role=gate" \
  timeout 10 bash -c 'exec 3<>/dev/tcp/api.openai.com/443'
expect_ok "gate pod → git :9418 is allowed" \
  np-g-git "sf/tier=agent,sf/role=gate" \
  timeout 5 bash -c 'exec 3<>/dev/tcp/api/9418'
expect_blocked "gate pod → factory-api:8000 is BLOCKED" \
  np-g-api "sf/tier=agent,sf/role=gate" \
  timeout 5 bash -c 'exec 3<>/dev/tcp/api/8000'
echo "✓ NETPOL SMOKE PASSED — the tier walls hold"
