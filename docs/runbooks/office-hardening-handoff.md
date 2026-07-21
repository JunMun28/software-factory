# Office hardening handoff (SEC-01 · DATA-01 prod cutover · PSA restricted)

These steps are a **user handoff** — they need a payment method or a program
enrollment that an agent cannot supply. Each step ends with the concrete
**values to bring back** so the rest of the pipeline (already coded) can be
pointed at them.

**Which account.** Two tenants are in play:
- **Personal (do this first):** the owner's personal Microsoft account. No
  Conditional Access, so the portal is reachable from the browser — this is
  where we stand the pipeline up first.
- **Micron (office, later):** blocked from the automated browser by Conditional
  Access ("your sign-in was successful but does not meet the criteria… a
  browser/app/location restricted by your admin"). Do Micron steps from a
  managed compliant laptop when the app graduates to the office tenant.

**Findings from the 2026-07-17 live attempt (personal account).** The personal
Microsoft account is a **consumer MSA with no Azure directory and no
subscription**, and Entra app registration REQUIRES a directory. Every portal
route to a directory was empirically blocked without an action an agent can't
perform:

| Route tried | Result |
|-------------|--------|
| Entra ID → App registrations → New registration | "Ability to create apps outside a directory is deprecated" — only a **Cancel** button |
| Sign up for a free Azure account | Requires a **credit card** on file (identity check, even for free tier) |
| M365 Developer Program | Enrollment, now typically needs a qualifying paid Visual Studio subscription |
| Create an Entra tenant directly (`CreateDirectoryBlade`) | **HTTP 401 "You don't have access"** (needs an existing directory/subscription) |

So **Step 0 below (get a directory) is a hard prerequisite** the user must
complete once; everything after it is drivable in the browser.

---

## 1. SEC-01 — Entra ID (Azure AD) app registration for API auth

> **Superseded by the fuller plan:** [azure-entra-setup.md](azure-entra-setup.md)
> covers this API registration PLUS the intake and console SPA registrations,
> the role mapping onto the existing `Operator` rows, and the code wiring.
> Use that doc; the section below remains as the original API-only sketch.

The API today trusts an unauthenticated caller in `[kind]`. Office profile puts
Entra OIDC in front of it. Register the app and hand back the IDs; the API's
auth guard reads them from env.

**Step 0 (prerequisite — user only): get a directory.** Per the findings above,
the personal MSA has none. Pick ONE, then re-run this section:
- **Free Azure account** (`azure.microsoft.com/free`) — needs a credit card, not
  charged for free services. Creates a "Default Directory" tenant AND an Azure
  subscription (which §2's SQL database also needs). **Most complete path.**
- **M365 Developer Program** (`developer.microsoft.com/microsoft-365/dev-program`)
  — no card if you qualify; gives a free E5 tenant (directory only, no Azure
  subscription, so §2 SQL still needs a paid account later).

Once a directory exists, the agent can drive steps 1–5 in the browser.

1. **portal.azure.com → Microsoft Entra ID → App registrations → New
   registration.**
   - Name: `software-factory-api`
   - Supported account types: **Single tenant** (this directory only).
   - Redirect URI: leave blank for now (API is a resource server, not a web
     client) — add the console SPA's URI later if you wire interactive login.
2. On the new app's **Overview**, copy:
   - **Application (client) ID**
   - **Directory (tenant) ID**
3. **Expose an API → Application ID URI**: accept the default
   `api://<client-id>`. **Add a scope** `access_as_user` (admin + user consent,
   enabled).
4. **App roles** (for OPERATE-04 role wall to line up with Entra, optional but
   recommended): add `operator` and `admin` app roles, assignable to Users.
   Assign the right people under **Enterprise applications → software-factory-api
   → Users and groups**.
5. **Certificates & secrets**: only if the API must call Graph/Entra back —
   otherwise skip (validating inbound tokens needs no client secret).

**Bring back:**
- `AZURE_TENANT_ID` = Directory (tenant) ID
- `AZURE_API_CLIENT_ID` = Application (client) ID
- `AZURE_API_AUDIENCE` = `api://<client-id>`
- (issuer is `https://login.microsoftonline.com/<tenant-id>/v2.0`)

These become env for the API's JWT validator (Phase-2 code — the guard seam
exists; it's env-gated off in `[kind]`). Store them in the API's Secret, not the
ConfigMap.

---

## 2. DATA-01 — Azure SQL **production** database + cutover

The dev database runbook is [azure-sql-dev.md](azure-sql-dev.md); prod differs on
tier, backup, and the cutover being **online** (the DATA-01 Unicode migration
must run against a non-empty prod DB without corrupting existing rows).

1. Follow azure-sql-dev.md steps 1–5, but:
   - Resource group `sf-prod`, server `sf-prod-sql-<suffix>`.
   - Database tier **S0 or higher** (not Basic) — the tick loop + build fleet
     need headroom.
   - Enable **Point-in-Time Restore** (on by default) and confirm the backup
     retention (7–35 days). This is the DATA-03 prod path; the SQLite backup
     CronJob is dev-only.
   - Firewall: allow the **cluster's egress IP**, not a laptop IP.
2. **Cutover sequence (DATA-06 gated migration — never auto-migrate on the sole
   replica):**
   1. Take a fresh PITR checkpoint / note the timestamp.
   2. Scale the API to 0 (or hold the tick — single replica, so a brief window
      is fine) so nothing writes mid-migration.
   3. Run the **pre-deploy migration Job** (`deploy/overlays/prod`, the
      `alembic upgrade head` Job) against the prod connection string. It brings
      the schema — including the DATA-01 `NVARCHAR` columns — up to head. On a
      DB that already has rows, MSSQL widens `VARCHAR`→`NVARCHAR` in place; the
      Unicode round-trip test in `api/tests` documents the intent.
   4. Verify `alembic current` == head and spot-check a row with non-ASCII text
      (emoji/CJK) survives round-trip.
   5. Scale the API back up. Confirm `/health` and one live tick.
3. Put the prod connection string in the API's **Secret** (referenced by
   `deploy/overlays/prod`), never the ConfigMap, never committed. URL-encode
   password specials (see the dev runbook note).

**Bring back:**
- `FACTORY_DB_URL` (prod) →
  `mssql+pyodbc://<admin-login>:<pw>@sf-prod-sql-<suffix>.database.windows.net:1433/factory?driver=ODBC+Driver+18+for+SQL+Server`
- Confirmation that PITR retention is set.

---

## 3. Pod Security Admission — moving `[kind]` `baseline` → office `restricted`

`deploy/base/namespace.yaml` **enforces `baseline`** today and **warns/audits at
`restricted`**, so the gap is already visible. `restricted` forbids running as
root, which the **kaniko** build pods need (they write image layers as uid 0).

To reach `restricted` in the office:
1. Switch the build path to a **rootless** builder — rootless kaniko, or Buildah
   with user namespaces — so build pods no longer need uid 0.
2. Add `securityContext: { runAsNonRoot: true, seccompProfile: RuntimeDefault,
   allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }` to every
   Job/Deployment pod spec (the control plane, gate, build, and produced-app
   pods).
3. Flip the namespace label
   `pod-security.kubernetes.io/enforce: baseline` → `restricted`, redeploy, and
   confirm no pod is rejected (the audit annotations from the current `restricted`
   audit level tell you in advance what will break).
4. Office adds **Kyverno** (or Gatekeeper) for policy that PSA can't express
   (registry allow-list, required labels, signed-image enforcement). PSA is the
   built-in floor; Kyverno is the office ceiling.

No values to bring back — this is a deploy-side change once rootless build lands.

---

## 4. Branch protection — `[kind]` ruleset → office GitHub App

`api/app/github.py::protect_main` sets a **Rulesets** policy on each produced repo
(block deletion + force-push, require a PR) using the existing personal PAT.
Rulesets are free on private personal repos, so this is live in `[kind]`.

What it does **not** give you is a real *independent* reviewer: the factory
merges via its own SHA-precondition API call (0 required approvals), so the writer
identity and the merger identity are the same token. Genuine "cannot approve your
own work" needs the **office GitHub App**:
1. Create a GitHub App in the Micron org; grant it Contents + Pull requests +
   Administration (rulesets) on the app repos.
2. Have it issue **per-request installation tokens** — the review stage gets a
   token scoped to *review*, the merge stage a token scoped to *merge*, so the
   grader and the writer are distinct identities.
3. Raise `required_approving_review_count` to 1 and require the review to come
   from the reviewer identity.

The four-method `GitHub` seam (`ensure_repo`/`open_pr`/`merge_pr`/`protect_main`)
is unchanged by this swap — only the token source moves from PAT to App. No
handoff values until the org App is created.

---

## Status summary

| Item | `[kind]` state (coded, live) | Office step (this doc) |
|------|------------------------------|------------------------|
| API auth (SEC-01) | open caller | Entra app reg → env |
| DB (DATA-01) | SQLite on PVC, Unicode columns | Azure SQL prod + gated cutover |
| Pod security | PSA `baseline` enforced, `restricted` audited | rootless build → `restricted` + Kyverno |
| Branch protection (MERGE-05) | Rulesets via PAT | GitHub App, independent reviewer |
