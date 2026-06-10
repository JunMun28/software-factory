# Draft spec lives in the intake database until approval, not in a repo

**Status:** accepted

The AI's draft spec for a Request is stored in the **intake app's database** (and shown in the
Control center) until an Admin approves it. It becomes a `SPEC.md` file in a repo only *at*
approval. We did this because a **new-app Request has no repo yet** — there is nowhere to put a
spec file until the app exists — and because a pre-approval spec is a *living draft* the
dashboard shows and an Admin may send back, which a database models better than git.

## Consequences

- Approval is the bridge: it (1) creates/registers the repo for a new app or selects the
  existing one, (2) writes the approved spec as `SPEC.md` on a fresh branch + PR, (3) starts
  Stage 2. The Work item is born here.
- **No repo is ever created for a Request nobody approved** — no orphan repos.
- A future engineer who "simplifies" this by writing `SPEC.md` to a repo on submission would
  break the new-app flow and litter repos for rejected requests. That is why this is recorded.
