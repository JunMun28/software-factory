#!/usr/bin/env bash
set -euo pipefail

: "${FACTORY_BACKUP_REF:?set FACTORY_BACKUP_REF to the verified backup/PITR restore-point reference}"
: "${FACTORY_BACKUP_EPOCH:?set FACTORY_BACKUP_EPOCH to that backup's Unix timestamp}"

namespace="${FACTORY_NAMESPACE:-software-factory}"
max_age="${FACTORY_BACKUP_MAX_AGE:-3600}"
now="$(date +%s)"

if [[ ! "${FACTORY_BACKUP_EPOCH}" =~ ^[0-9]+$ ]]; then
  echo "FACTORY_BACKUP_EPOCH must be Unix seconds" >&2
  exit 2
fi

age=$((now - FACTORY_BACKUP_EPOCH))
if (( age < -300 || age > max_age )); then
  echo "backup gate failed: ${FACTORY_BACKUP_REF} is ${age}s old (limit ${max_age}s)" >&2
  exit 1
fi

kubectl -n "${namespace}" get secret factory-db >/dev/null
kubectl -n "${namespace}" delete job factory-db-migrate --ignore-not-found
kubectl -n "${namespace}" apply -f deploy/overlays/prod/migration-job.yaml
kubectl -n "${namespace}" wait --for=condition=complete job/factory-db-migrate --timeout=300s
kubectl -n "${namespace}" logs job/factory-db-migrate
echo "migration complete after backup ${FACTORY_BACKUP_REF}"
