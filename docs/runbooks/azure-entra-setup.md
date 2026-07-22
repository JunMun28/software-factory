# Azure / Entra setup plan — identity & access control for the factory

Goal: real sign-in for the two SPAs and a token-protected API.

| Piece | Today | Target |
|-------|-------|--------|
| Intake "Stream" SPA (`:4201`) | anonymous | Entra sign-in; any tenant user may submit |
| Console SPA (`:4202`) | picks an operator row | Entra sign-in; `viewer` / `admin` roles enforced |
| API (`:8000`) | trusts every caller | validates Entra JWTs; role wall from token |

The domain model already anticipates this: `Operator.email` is unique and
carries `role` (`admin` = may decide gates + rollbacks, `viewer` = read-only),
with the note "Entra auth (when it lands) resolves onto this same row"
(`api/app/models.py:74-86`). So the wiring is: **token → email claim →
Operator row → role**. No schema change needed.

Run the phases in order. Phase 0 is user-only. After that, the agent can
drive the portal clicks and write all the code.

> **Status 2026-07-18:** Phase 0 + Phase 1 DONE live in the personal dev
> tenant (all three registrations, scope, roles, admin consent, owner assigned
> `Factory.Admin`). Recorded values live in the gitignored `api/.env.azure` —
> never in the repo. Phase 2 **backend** built on branch `entra-auth`
> (`app/auth.py` + tests); SPA wiring pending.

---

## Phase 0 — get a tenant (user-only, one-time)

A registration needs a directory. The 2026-07-17 live attempt proved a bare
consumer Microsoft account cannot create one (see
[office-hardening-handoff.md](office-hardening-handoff.md) for the four blocked
routes). Pick ONE:

1. **Free Azure account** — `azure.microsoft.com/free`. Needs a credit card
   (identity check; free services are not charged). Gives a **Default
   Directory** AND an **Azure subscription** — the subscription is also what
   Azure SQL needs, so this is the most complete path. **(recommended)**
2. **M365 Developer Program** — `developer.microsoft.com/microsoft-365/dev-program`.
   No card if you qualify. Gives a free tenant only — no subscription, so
   Azure SQL still needs path 1 later.

For the office, the Micron tenant already exists; those steps go through IT
and a compliant device (Conditional Access blocks the automated browser).

**Record:** `AZURE_TENANT_ID` (Entra ID → Overview → Tenant ID).

---

## Phase 1 — three app registrations (portal; agent-drivable)

All under **Entra ID → App registrations**, all **single tenant**.

### 1a. `aires-api` (the resource)

1. New registration, name `aires-api`, no redirect URI.
2. **Expose an API** → set Application ID URI to the default
   `api://<api-client-id>` → add scope `access_as_user` (admins + users can
   consent).
3. **App roles** — create three, all assignable to Users/Groups:
   - `Factory.Submitter` (value `submitter`) — may use the intake app
   - `Factory.Viewer` (value `viewer`) — read-only console
   - `Factory.Admin` (value `admin`) — gates, rollbacks, operator management
4. No client secret needed — validating inbound tokens is secret-free.

### 1b. `software-factory-console` (SPA)

1. New registration, name `software-factory-console`.
2. **Authentication → Add a platform → Single-page application**. Redirect
   URIs: `http://localhost:4202` (dev) + the deployed console URL later.
   Auth code + PKCE is the default; leave implicit grant OFF.
3. **API permissions** → My APIs → `aires-api` → delegated
   `access_as_user` → **Grant admin consent**.

### 1c. `software-factory-intake` (SPA)

Same as 1b with name `software-factory-intake` and redirect URI
`http://localhost:4201` (+ deployed intake URL later).

### 1d. Assign people

**Enterprise applications → aires-api → Users and groups**: assign
each person a role from 1a. Console decision-makers get `Factory.Admin`;
read-only console users get `Factory.Viewer`; everyone who may submit gets
`Factory.Submitter`. (One person can hold several.)

**Record:**
- `AZURE_API_CLIENT_ID`, `AZURE_CONSOLE_CLIENT_ID`, `AZURE_INTAKE_CLIENT_ID`
- `AZURE_API_AUDIENCE` = `api://<api-client-id>`
- issuer = `https://login.microsoftonline.com/<tenant-id>/v2.0`

None of these are secrets (client IDs are public identifiers); they can live
in the ConfigMap. There is no client secret anywhere in this design.

---

## Phase 2 — code wiring (repo work; env-gated, `[kind]` unchanged until flipped)

### API

- New env gate `FACTORY_AUTH` (default `off`): `off` = today's behavior;
  `entra` = every `/api/*` request must carry `Authorization: Bearer <JWT>`.
- Validate against the tenant JWKS
  (`https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`): check
  signature, `iss`, `aud` = `AZURE_API_AUDIENCE`, expiry. Cache keys.
- Map the token to the domain: `preferred_username`/`email` claim →
  `Operator` row (the models.py seam). `roles` claim (from the 1a app roles)
  is the **source of truth**; sync it onto `Operator.role` at first request
  so existing role checks keep working. Unknown email + `submitter` role →
  auto-provision nothing (intake requests already carry requester identity);
  unknown email + console role → 403 until an admin creates the operator row.
- Health/metrics endpoints stay unauthenticated (probes need them).
- Tests: a fake JWKS + self-signed tokens; assert 401 (no/bad token),
  403 (viewer hitting an admin action), and the off-gate default.

### SPAs (both intake and console)

- `@azure/msal-angular`: `MsalInterceptor` acquires
  `api://<api-client-id>/access_as_user` and attaches it to every `/api` call.
- Console: route guard reads the `roles` claim — `viewer` sees read-only,
  `admin` sees gates/rollback controls (the server wall stays authoritative;
  the guard is UX only).
- Intake: sign-in required, no role gating beyond `submitter`.
- Env-gated the same way (`FACTORY_AUTH=off` builds skip MSAL entirely) so
  local dev and CI need no tenant.

### Deploy

- ConfigMap: tenant ID, three client IDs, audience (not secrets).
- No new Secret needed for auth. (DB URL stays in its Secret per the prod
  overlay.)

---

## Phase 3 — Azure SQL

Separate concern, same subscription from Phase 0 path 1. Follow
[azure-sql-dev.md](azure-sql-dev.md) for dev and
[office-hardening-handoff.md](office-hardening-handoff.md) §2 for the prod
cutover (gated migration Job + PITR).

---

## Phase 4 — office / Micron cutover

Re-run Phase 1 in the Micron tenant from a compliant device (IT may have to
approve the registrations). Swap the four recorded IDs in the office overlay;
code is unchanged — that is the point of the env seam. Conditional Access,
the GitHub App reviewer identity, and Kyverno live in
[office-hardening-handoff.md](office-hardening-handoff.md).

---

## Checklist of values to record

```
AZURE_TENANT_ID=
AZURE_API_CLIENT_ID=
AZURE_CONSOLE_CLIENT_ID=
AZURE_INTAKE_CLIENT_ID=
AZURE_API_AUDIENCE=api://<AZURE_API_CLIENT_ID>
# issuer derives from the tenant: https://login.microsoftonline.com/<AZURE_TENANT_ID>/v2.0
```

Do not put real IDs in this file or anywhere in the repo — env / ConfigMap
only.
