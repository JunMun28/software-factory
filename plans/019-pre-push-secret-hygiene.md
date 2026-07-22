# Plan 019: Clear the two pre-push disclosures — templated runbook identifiers, no hardcoded CI password

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat a487e33..HEAD -- .github/workflows/ci.yml docs/runbooks/azure-sql-dev.md docs/runbooks/office-hardening-handoff.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" descriptions against the live files before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **HANDLING RULE — read before anything else.** This plan is *about* sensitive
> strings. You will be reading and replacing a live server hostname, an admin
> login name, and a password literal. **Never copy any of those values into a
> commit message, a report, a comment, a new file, or any output you produce.**
> Refer to them only by `file:line`. Every example in this plan is deliberately
> written with placeholders for that reason. When you report back, describe
> what you changed by location and shape, never by value.

## Status

- **Priority**: P1 (it gates a push to a public repo)
- **Effort**: S for Part A, M for Part B
- **Risk**: LOW for Part A, MED for Part B
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `a487e33`, 2026-07-22

## Why this matters

`JunMun28/software-factory` is a **public** GitHub repo. Local `main` is ~23
commits ahead of `origin` and has never been pushed. A full secret scan of that
range came back clean — no credential files, no `ghp_`/`sk-`/`AKIA` tokens, no
private keys, no JWTs, and every password in the runbooks is already a
placeholder.

Two things are *not* clean, and both become permanent the moment they are
pushed, because deleting them later does not remove them from public history:

1. **A live Azure SQL server hostname and its admin login name** sit in prose in
   two runbooks. Not credentials — but on a public repo they hand an attacker
   the exact hostname, region, database name, and half the login for an
   internet-reachable database, leaving the firewall rules as the only
   remaining control.
2. **A hardcoded SQL Server SA password** appears four times in the CI
   workflow. The practical risk is near zero — it authenticates to an ephemeral
   service container on `localhost` that exists for the duration of one job —
   but it is a literal password in a public repo, and it will trip secret
   scanners, **including this repo's own gitleaks gate** (`docker/sf-agent/gate.sh:139`
   runs `gitleaks git --log-opts="origin/main...HEAD"`, with no config file and
   therefore default rules and no allowlist).

Doing this before the first push is the entire point. After a push, this plan
is worth much less.

## Current state

### Part A — the runbook identifiers

`docs/runbooks/azure-sql-dev.md`:

- **line 4** — a status blockquote naming the **literal** server FQDN, its
  Azure region, and the database name. This is the only place the real
  hostname appears in full.
- **line 5** — the same blockquote names the **literal** admin login. The very
  next line (6) already says credentials live only in `api/.env` (gitignored)
  and the `factory-db` Secret — so the file's own convention is already
  "identifiers here, secrets elsewhere"; this plan extends that convention to
  the identifiers themselves.
- **line 17** — the admin login again.
- **line 30** — a `FACTORY_DB_URL` example. Its host is **already templated**
  (`sf-dev-sql-<suffix>.database.windows.net`) and its password is already
  `<pw>`, but the admin login is still literal.

`docs/runbooks/office-hardening-handoff.md`:

- **line 121** — a connection-string example whose host is already templated
  (`sf-prod-sql-<suffix>....`) and whose password is `<pw>`, but the admin
  login is still literal.

So: the FQDN is literal in exactly **one** place (`azure-sql-dev.md:4`); the
admin login is literal in **four** places (`azure-sql-dev.md:5,17,30` and
`office-hardening-handoff.md:121`). Passwords are correctly placeholdered
everywhere already — do not "fix" those.

The real values live in gitignored files. Confirmed:
`git check-ignore -v api/.env.azure` → matched by `.gitignore:11` (`.env.*`),
same for `app-preview/orchestrator/.env.azure`.

### Part B — the CI password

`.github/workflows/ci.yml`, the `test-mssql` job. The same literal appears at
**four** locations:

- **line 90** — `MSSQL_SA_PASSWORD:` in the `services.mssql.env` block
- **line 93** — inside `services.mssql.options`, in the `--health-cmd` sqlcmd
  invocation (`-P <literal>`)
- **line 112** — inside the "Create database" step's inline `python -c`, in a
  pyodbc DSN (`PWD=<literal>`)
- **line 116** — inside the "Run suite against MSSQL" step's `FACTORY_DB_URL`
  env (`mssql+pyodbc://sa:<literal>@localhost:1433/...`)

The constraint that makes this awkward: **service containers start before any
step runs**, so the password must exist at container-creation time. It cannot
be generated by a step and then used by `services:`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| YAML validity | `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(d['jobs']))"` | `['test-mssql', 'verify', 'verify-appview']` |
| Full gate | `task verify` | `✓ VERIFY PASSED` |
| Leak re-check (Part A) | see Step 3 | no literal hostname/login outside gitignored files |

`task verify` does **not** exercise the `test-mssql` job — that job only runs on
GitHub, against a real SQL Server service container. This is the plan's central
verification problem; see STOP conditions.

## Scope

**In scope**:
- `docs/runbooks/azure-sql-dev.md`
- `docs/runbooks/office-hardening-handoff.md`
- `.github/workflows/ci.yml` (Part B only)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):
- **Any gitignored file** — `api/.env`, `api/.env.azure`,
  `app-preview/orchestrator/.env.azure`. They are where the real values are
  *supposed* to live. Do not read them, do not edit them, do not echo them.
- **Rewriting git history.** Nothing in the unpushed range needs a rebase or a
  filter-branch; the values have never been pushed, so simply changing them in
  the working tree before the first push is sufficient. Do not attempt an
  interactive rebase to "clean" earlier commits — it would rewrite 23 commits
  for no benefit.
- **The password placeholders that already exist** (`<pw>` on
  `azure-sql-dev.md:30` and `office-hardening-handoff.md:121`). Correct as-is.
- **Rotating anything.** No credential is being disclosed by this plan's
  targets, so no rotation is required. (If you discover an actual credential
  value in a tracked file, that IS a STOP condition — report the `file:line`
  and the credential type, never the value, and recommend rotation.)
- **Pushing.** This plan does not push. That is a separate operator decision.
- **The working tree has substantial uncommitted changes from other sessions**
  (files under `apps/`, `mockups/`, `plans/009`–`011`, fonts, `journey.png`).
  Do not stage or commit them.

## Git workflow

- Branch: `advisor/019-pre-push-hygiene`
- Conventional commits. **Commit Part A and Part B separately** — Part A must
  be able to land even if Part B is abandoned (see below).
  - Part A: `docs(runbooks): template the Azure server and login identifiers`
  - Part B: `ci(mssql): stop hardcoding the SA password for the test container`
- Commit messages must not contain any of the replaced values.
- Do NOT push or open a PR.

## Steps

### Part A — runbook identifiers (do this first; it is the real disclosure)

#### Step 1: Template the server FQDN

In `docs/runbooks/azure-sql-dev.md:4`, replace the literal server hostname with
the same placeholder style the file already uses at line 30
(`sf-dev-sql-<suffix>.database.windows.net`). Keep the region and database name
if you judge them useful — they are far less identifying than the hostname —
but the hostname itself must become a placeholder.

Add a short pointer so the runbook stays usable, e.g.:

```markdown
> the exact server name and login live in `api/.env.azure` (gitignored) and in
> the Azure portal — deliberately not recorded here, since this repo is public
```

**Verify**: `grep -c 'database\.windows\.net' docs/runbooks/azure-sql-dev.md`
still returns 2 (the lines still exist), and
`grep -nE '[a-z0-9-]+\.database\.windows\.net' docs/runbooks/azure-sql-dev.md | grep -v '<'`
returns **nothing** (no un-templated hostname remains).

#### Step 2: Template the admin login

Replace the literal admin login at `azure-sql-dev.md:5`, `:17`, `:30` and
`office-hardening-handoff.md:121` with a placeholder such as `<admin-login>`,
matching the surrounding placeholder style in each spot.

**Verify**: `grep -rn "<the literal login>" docs/` returns nothing — but do
**not** put the literal into your shell history in a way that ends up in your
report. Instead verify structurally:
`grep -rnE '://[a-z0-9]+:<pw>@' docs/runbooks/` should show only
placeholder-shaped users (i.e. the user part starts with `<`).

#### Step 3: Prove the repo is clean of both identifiers

Derive the literals from the gitignored env file **without printing them**, and
check whether they appear in any tracked file. A safe shape:

```sh
# reads the value into a shell var; never echoes it
SRV=$(grep -oE '[a-z0-9-]+\.database\.windows\.net' api/.env.azure | head -1)
[ -n "$SRV" ] && git grep -l -F "$SRV" -- . | grep -v '^\.env' || echo "server name: not present in tracked files"
```

If `api/.env.azure` does not exist on this machine, skip this step and say so —
Steps 1 and 2's structural greps are then the verification.

**Verify**: the command reports that neither identifier appears in any tracked
file.

#### Step 4: Commit Part A

**Verify**: `git status --porcelain` shows only the two runbook files;
`git log -1 --format=%s` contains no sensitive value.

### Part B — the CI password (recommended, but abandonable)

Read this whole section before starting. Part B has a verification gap that
Part A does not: **`task verify` cannot exercise the `test-mssql` job**, which
only runs on GitHub against a real service container. So a mistake here is not
caught locally — it is caught by a red CI run after the push.

#### The approach, and why

Three options were considered:

- **A GitHub Actions secret** (`${{ secrets.CI_MSSQL_SA_PASSWORD }}`). Clean,
  but it needs the operator to create the secret in repo settings first, and if
  the secret is absent the value resolves to empty, SQL Server refuses to
  start, and the job breaks. Rejected as the default because it makes CI depend
  on external state that this plan cannot create or verify.
- **Centralising the literal into one workflow-level `env:`.** Cosmetic — the
  value is still public. Rejected.
- **Generating the password at runtime (CHOSEN).** Drop the `services:` block
  and start SQL Server with `docker run` inside a step, using a password
  generated by `openssl rand`. Self-contained: no repo secret, no operator
  action, and no literal anywhere. The cost is that the container's readiness
  wait moves from `--health-cmd` into an explicit poll loop in the step.

#### Step 5: Replace the service container with a generated-password container

In `.github/workflows/ci.yml`'s `test-mssql` job:

1. **Delete** the `services:` block (the `mssql` service, its `env`, `ports`,
   and `options`) — that removes the literals at lines 90 and 93.
2. Add a step, before "Install ODBC driver 18", that generates the password and
   starts the container. Export the password to later steps via `$GITHUB_ENV`,
   and mask it so it can never appear in logs:

```yaml
      # The SA password is generated per run: nothing is hardcoded, so there is
      # no password literal in this public repo (plans/019). ::add-mask:: keeps
      # it out of the log even if a later command echoes a connection string.
      - name: Start SQL Server
        run: |
          PW="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)Aa1!"
          echo "::add-mask::$PW"
          echo "MSSQL_SA_PASSWORD=$PW" >> "$GITHUB_ENV"
          docker run -d --name mssql \
            -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=$PW" \
            -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
```

   The trailing `Aa1!` guarantees SQL Server's complexity requirement (upper,
   lower, digit, symbol) regardless of what `openssl rand` produced — without
   it the container silently refuses to start, which is the most likely way
   this step goes wrong.

3. Add a readiness poll after the ODBC driver install and the `uv sync`, since
   it needs `pyodbc`:

```yaml
      - name: Wait for SQL Server
        working-directory: api
        run: |
          for i in $(seq 1 30); do
            if uv run python -c "
          import os, pyodbc
          pyodbc.connect(
              'DRIVER={ODBC Driver 18 for SQL Server};SERVER=localhost,1433;UID=sa;'
              'PWD=' + os.environ['MSSQL_SA_PASSWORD'] + ';TrustServerCertificate=yes',
              timeout=5,
          )" 2>/dev/null; then echo "ready after ${i} attempt(s)"; exit 0; fi
            sleep 5
          done
          echo "SQL Server did not become ready"; docker logs mssql | tail -50; exit 1
```

   Note it prints `docker logs` on failure — without that, a startup problem in
   CI is undiagnosable.

4. Rewrite the two remaining literal sites to read the env var instead of
   embedding the password:
   - the **"Create database"** step (was line 112): build the DSN from
     `os.environ['MSSQL_SA_PASSWORD']` exactly as the poll above does.
   - the **"Run suite against MSSQL"** step (was line 116): `FACTORY_DB_URL`
     must be assembled in `run:` rather than in `env:`, because the password
     needs URL-encoding inside a connection string. Use
     `python -c "import urllib.parse, os; print(urllib.parse.quote(os.environ['MSSQL_SA_PASSWORD'], safe=''))"`
     to encode it, then export `FACTORY_DB_URL` via `$GITHUB_ENV`. **This is
     the subtlest part of Part B**: the generated password can contain
     characters that are legal in a password but break a URL. The existing
     runbook at `azure-sql-dev.md:30` warns about exactly this
     (`a raw @, /, #, or : silently breaks the URL`). The `tr -d '/+='` in the
     generator removes the worst offenders, but URL-encode anyway — belt and
     braces, because a failure here looks like an authentication error, not a
     parsing error.

**Verify**:
- `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(d['jobs']))"`
  → `['test-mssql', 'verify', 'verify-appview']`
- `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print('services' in d['jobs']['test-mssql'])"`
  → `False`
- No password literal remains anywhere in the workflow. Check this
  **structurally**, so you never have to type the value:
  `grep -nE 'PWD=[A-Za-z0-9]|-P [A-Za-z0-9]|sa:[A-Za-z0-9]|MSSQL_SA_PASSWORD: *"' .github/workflows/ci.yml`
  → returns **nothing**. A literal starts with an alphanumeric; every legitimate
  remaining reference starts with `$`, `'`, `{`, or `+` (a variable expansion or
  a Python string concatenation), so this catches exactly the case you care
  about without naming it.
- `task verify` → `✓ VERIFY PASSED` (proves you did not break the *other* two
  jobs' YAML).

#### Step 6: Commit Part B separately

**Verify**: `git log --oneline -2` shows two commits, Part A and Part B, in
that order.

## Test plan

There are no unit tests here. Verification is structural and evidential:

- **Part A**: no un-templated hostname or login remains in any tracked file
  (Steps 1–3's greps).
- **Part B**: the workflow still parses, the `test-mssql` job no longer has a
  `services` block, the literal is gone, and `task verify` still passes.
- **The gap you must state plainly in your report**: the `test-mssql` job
  itself cannot be run locally. Part B is verified structurally only. The first
  real proof is a CI run after the push.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -nE '[a-z0-9-]+\.database\.windows\.net' docs/runbooks/*.md | grep -v '<'` returns nothing
- [ ] `grep -rnE '://[a-z0-9]+:<pw>@' docs/runbooks/` shows only placeholder-shaped user parts
- [ ] `grep -nE 'PWD=[A-Za-z0-9]|-P [A-Za-z0-9]|sa:[A-Za-z0-9]|MSSQL_SA_PASSWORD: *"' .github/workflows/ci.yml` returns nothing (Part B only)
- [ ] `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(d['jobs']))"` → `['test-mssql', 'verify', 'verify-appview']`
- [ ] `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print('services' in d['jobs']['test-mssql'])"` → `False` (Part B only)
- [ ] `task verify` exits 0
- [ ] Two separate commits, Part A before Part B
- [ ] No sensitive value appears in any commit message, comment, or report
- [ ] `git status --porcelain` shows no modified files outside the in-scope list

## STOP conditions

Stop and report back (do not improvise) if:

- **You find an actual credential value** (not a hostname or login — a real
  password, key, or token) in any tracked file. Report `file:line` and the
  credential type only, never the value, and recommend rotation. That changes
  the push decision entirely and is the operator's call.
- Part B's rewrite starts requiring changes beyond the `test-mssql` job — the
  other two jobs must not be touched.
- You cannot make the readiness poll deterministic, or you find yourself adding
  more than ~20 lines of shell to make the container start. **Abandon Part B,
  keep Part A, and report.** Part A is the disclosure that actually matters;
  Part B is hardening a near-zero-risk literal, and a flaky CI job is a worse
  outcome than a public throwaway password.
- `task verify` fails.
- Any in-scope file does not match the "Current state" description.

## Maintenance notes

For whoever owns this next:

- **What a reviewer should scrutinise**: that no replaced value leaked into a
  commit message or comment; and, for Part B, the URL-encoding of the generated
  password in `FACTORY_DB_URL` — that is the single most likely place for this
  to fail in CI, and it fails looking like an auth error rather than a parse
  error.
- **This plan is time-sensitive.** Its entire value is that these values have
  never been pushed. Once `main` reaches `origin`, Part A becomes cosmetic —
  the hostname and login are then in public history permanently and the honest
  follow-up is to rename the server or tighten its firewall, not to edit
  Markdown.
- **Part B has a known verification gap**: the `test-mssql` job runs only on
  GitHub. Expect to watch the first CI run after the push, and be ready to
  revert the Part B commit alone (it is deliberately a separate commit) if the
  container fails to start.
- **Related, deliberately not in this plan**: the repo's own gitleaks gate
  (`docker/sf-agent/gate.sh:139`) runs with default rules and no config file,
  so it has no allowlist. Once Part B lands there is nothing for it to flag —
  but if a future test fixture needs a credential-shaped constant, a
  `.gitleaks.toml` allowlist will be needed rather than deleting the fixture.
