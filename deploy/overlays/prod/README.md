# Production database deployment sequence

> **NOTE(plan-008):** Any environment serving real users MUST use this production
> overlay with Azure SQL. The SQLite base, local, and CRC profiles are single-writer
> development/local-cluster profiles only.

The production overlay expects an externally managed Secret named `factory-db`
with a `url` key. Create it through the deployment secret manager; never commit
the URL:

```bash
kubectl -n software-factory create secret generic factory-db \
  --from-literal=url="$FACTORY_DB_URL" --dry-run=client -o yaml | kubectl apply -f -
```

Deployments are deliberately ordered rather than applying the migration Job and
API Deployment together:

1. Verify a fresh backup. For Azure SQL, record the current PITR restore point;
   for the kind/dev SQLite PVC, use `task backup` or the scheduled CronJob.
2. Export the backup reference and Unix timestamp, then run the gated migration:

   ```bash
   export FACTORY_BACKUP_REF="azure-pitr-2026-07-17T04:00:00Z"
   export FACTORY_BACKUP_EPOCH="$(date +%s)"
   task prod-migrate
   ```

3. Only after the Job reports success, deploy the application:

   ```bash
   kubectl apply -k deploy/overlays/prod
   ```

The app's startup `migrate()` remains for dev compatibility. Production uses
the backup-gated Job first, so the startup call finds the schema already at
Alembic head. Azure SQL PITR provisioning and cutover remain an office/user
handoff rather than something this overlay creates.

## SSE on ARO (plan 008 / ADR 0026)

The intake brain streams tokens over SSE (`/api/requests/*/interview/stream`,
`/api/requests/*/prototype/stream`). The API already sends
`X-Accel-Buffering: no` (any nginx hop honors it). For the OpenShift Route
in front of the API, set a timeout at least as long as the longest generation
(prototype = 240s) so HAProxy does not cut live streams:

    oc annotate route factory-api haproxy.router.openshift.io/timeout=300s

The Anthropic key rides an optional Secret (`sf-anthropic`, key `api-key`).
Without it the brain degrades api -> CLI -> scripted; the pod still schedules:

    oc create secret generic sf-anthropic --from-literal=api-key=<key>

## Enabling the Entra wall (SEC-01)

Auth is merged and env-gated (`FACTORY_AUTH=off` by default). One Secret is
the ON switch — no tenant or client IDs ever enter the repo:

    oc create secret generic sf-entra \
      --from-literal=mode=entra \
      --from-literal=tenant-id=<tenant> \
      --from-literal=api-audience=<audience> \
      --from-literal=api-client-id=<api-app-id> \
      --from-literal=console-client-id=<console-app-id> \
      --from-literal=intake-client-id=<intake-app-id>

Delete the secret (and roll the pod) to fall back to the open dev wall.
Note: per-user budgets key on the reporter identity, which is real only
once this wall is on.
