#!/usr/bin/env bash
# Prove NetworkPolicy is ENFORCED (spec §2: kindnet's silent no-op is the trap).
# A throwaway namespace gets an nginx pod; traffic works, then a deny-all
# policy lands and the same traffic must FAIL.
set -euo pipefail

kubectl create ns np-probe --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n np-probe run web --image=nginx:alpine --restart=Never >/dev/null 2>&1 || true
kubectl -n np-probe wait --for=condition=Ready pod/web --timeout=120s >/dev/null
kubectl -n np-probe expose pod web --port=80 >/dev/null 2>&1 || true

kubectl -n np-probe run probe-open --rm -i --restart=Never --image=busybox:1.36 -- \
  wget -T 5 -qO- http://web >/dev/null
echo "  open traffic flows (baseline)"

cat <<'EOF2' | kubectl -n np-probe apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
EOF2

if kubectl -n np-probe run probe-denied --rm -i --restart=Never --image=busybox:1.36 -- \
  wget -T 5 -qO- http://web >/dev/null 2>&1; then
  echo "✗ NetworkPolicy NOT enforced — is Calico actually running?" >&2
  exit 1
fi
kubectl delete ns np-probe --wait=false >/dev/null
echo "✓ NetworkPolicy enforcement proven (deny-all blocked the same traffic)"
