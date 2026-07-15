#!/usr/bin/env bash
# The tier-wall smoke (spec §2): "A NetworkPolicy smoke test (agent pod →
# factory-api must FAIL) runs in the deploy verify — enforcement is proven,
# never assumed." Probes run AS the tier (same labels + SA + non-root UID).
#
# The probe pod always exits 0 and prints SF_OPEN or SF_BLOCKED — so a pod
# that failed to schedule/start prints NEITHER and the smoke fails loudly,
# instead of an infra failure masquerading as a blocked wall.
set -euo pipefail
NS=software-factory
OVR='{"spec":{"serviceAccountName":"sf-gate","automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":10101,"runAsGroup":0}}}'

probe() { # name labels timeout host port → prints SF_OPEN | SF_BLOCKED
  local name=$1 labels=$2 tmo=$3 host=$4 port=$5
  kubectl -n "$NS" run "$name" --rm -i --restart=Never --image=sf-agent:dev \
    --labels="$labels" --overrides="$OVR" --quiet --command -- \
    bash -c "timeout $tmo bash -c 'exec 3<>/dev/tcp/$host/$port' 2>/dev/null && echo SF_OPEN || echo SF_BLOCKED" \
    2>/dev/null
}

expect_ok() { # description name labels timeout host port
  local desc=$1; shift
  case "$(probe "$@")" in
    *SF_OPEN*) echo "  ✓ $desc" ;;
    *SF_BLOCKED*) echo "✗ $desc (expected ALLOWED)"; exit 1 ;;
    *) echo "✗ $desc (probe pod never ran — infra failure, wall UNPROVEN)"; exit 1 ;;
  esac
}
expect_blocked() {
  local desc=$1; shift
  case "$(probe "$@")" in
    *SF_BLOCKED*) echo "  ✓ $desc" ;;
    *SF_OPEN*) echo "✗ $desc (expected BLOCKED)"; exit 1 ;;
    *) echo "✗ $desc (probe pod never ran — infra failure, wall UNPROVEN)"; exit 1 ;;
  esac
}

echo "▸ NetworkPolicy walls"
expect_blocked "stage pod → factory-api:8000 is BLOCKED (the spec §2 hard assertion)" \
  np-s-api "sf/tier=agent,sf/role=stage" 5 api 8000
expect_ok "stage pod → git :9418 is allowed (clone/push door)" \
  np-s-git "sf/tier=agent,sf/role=stage" 5 api 9418
expect_ok "stage pod → LLM endpoint :443 is allowed" \
  np-s-llm "sf/tier=agent,sf/role=stage" 10 api.openai.com 443
expect_blocked "stage pod → link-local metadata/IMDS is BLOCKED (SSRF wall)" \
  np-s-imds "sf/tier=agent,sf/role=stage" 5 169.254.169.254 80
expect_blocked "gate pod → LLM endpoint :443 is BLOCKED (no LLM in gates, spec §6)" \
  np-g-llm "sf/tier=agent,sf/role=gate" 10 api.openai.com 443
expect_ok "gate pod → git :9418 is allowed" \
  np-g-git "sf/tier=agent,sf/role=gate" 5 api 9418
expect_blocked "gate pod → factory-api:8000 is BLOCKED" \
  np-g-api "sf/tier=agent,sf/role=gate" 5 api 8000
# Plan B3 tiers: build pods reach ONLY git + registry; app pods reach nothing.
expect_blocked "build pod → factory-api:8000 is BLOCKED" \
  np-b-api "sf/tier=agent,sf/role=build" 5 api 8000
expect_blocked "build pod → LLM endpoint :443 is BLOCKED (no LLM in builds)" \
  np-b-llm "sf/tier=agent,sf/role=build" 10 api.openai.com 443
expect_ok "build pod → registry :5000 is allowed (kaniko push door)" \
  np-b-reg "sf/tier=agent,sf/role=build" 5 sf-registry 5000
expect_ok "build pod → git :9418 is allowed (clone door)" \
  np-b-git "sf/tier=agent,sf/role=build" 5 api 9418
expect_blocked "app pod → factory-api:8000 is BLOCKED (apps never dial the factory)" \
  np-a-api "sf/tier=app,sf/instance=np-probe" 5 api 8000
expect_blocked "app pod → git :9418 is BLOCKED" \
  np-a-git "sf/tier=app,sf/instance=np-probe" 5 api 9418
echo "✓ NETPOL SMOKE PASSED — the tier walls hold"
