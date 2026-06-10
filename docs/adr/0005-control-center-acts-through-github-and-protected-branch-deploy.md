# Control center acts through GitHub gates; deploy via a protected `production` branch (Team plan)

**Status:** accepted
**Verified:** against current docs.github.com (2026-06), with adversarial cross-checks. See notes.

The Control center lets Admins approve the human gates (merge, production deploy) from the web
app, but **every action goes through GitHub's real gates — it never bypasses them.** Because the
org is on the **GitHub Team plan with private app repos**, the deploy gate is *not* a GitHub
Environment "required reviewer": those (and custom deployment protection rules) are unavailable
for private repos without GitHub Enterprise. Instead, **both human gates are protected-branch
required approvals** — merge into `main`, and a promotion PR `main` → a protected `production`
branch whose merge triggers the deploy. Required status checks (RED/GREEN/Test-isolation) are
enforced by GitHub independently of the approval.

## Identity

- **Submitters** authenticate with Microsoft SSO only and never touch GitHub.
- **Admins** link a GitHub account once (OAuth on top of SSO) and approve **as themselves**, so
  GitHub records the real human and natively enforces "can't approve your own work."
- The **Factory Builder bot** (a dedicated GitHub App, not the Actions `GITHUB_TOKEN`) only
  *writes* — branches, PRs, progress comments — and never approves.

## Why recorded (all three ADR tests met)

- **Hard to reverse** — the gate mechanism and identity model thread through the whole orchestration.
- **Surprising** — a future engineer would reach for GitHub Environments + required reviewers for
  the deploy gate (the "textbook" path) and be puzzled by a `production` branch instead. The
  reason is a verified Team-plan limitation, invisible in the code.
- **Real trade-off** — the alternative is upgrading to GitHub Enterprise to unlock environment
  reviewers / custom protection rules for private repos. We chose the no-cost protected-branch
  promotion, which keeps enforcement native in GitHub.

## Verified facts behind this

- A dedicated GitHub App's approving review **counts** toward branch-protection required
  approvals (the Actions `GITHUB_TOKEN` bot's reviews never do); an App can't approve a PR it
  authored — hence Builder writes, Admin approves.
- GitHub Environment "required reviewers" and "custom deployment protection rules" are **public-repo-only
  on Free/Pro/Team**; private repos need GitHub Enterprise. Branch protection / rulesets
  "require N approvals" + required status checks **do** work on Team + private. → protected-branch
  promotion is the deploy gate that works on the current plan.

## Supersedes

Refines ADR 0002's deploy gate: the Stage 6 human gate is a protected `production` branch, not a
GitHub Environment with required reviewers.
