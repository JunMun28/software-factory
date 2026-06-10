# PR-centric, event-driven orchestration with gates as native GitHub controls

**Status:** accepted

The Factory orchestrates Stages as an **event-driven chain anchored on a branch + pull
request** (the Work item), rather than a monolithic script that stops and resumes. Stages
write their Artifacts as commits; **human gates map to native GitHub controls** (PR review /
CODEOWNERS for spec & ADR sign-off, branch protection for merge, and — see ADR 0005 — a
protected `production` branch for prod deploy), and automated gates are CI checks. The "pause"
at a human gate is just the PR sitting in a state — no process stays alive waiting.

We picked this over a simpler stop-and-resume driver because it makes gates **enforced by the
platform** instead of by an operator remembering to halt, and it co-locates the human gates
and the test-isolation gate in one system (see ADR 0001).

## Consequences

- The unit of work is a branch + PR; this is the atom the Factory processes.
- We build the **inner loop first** (Stages 3→4→5: RED → GREEN → review), where the
  load-bearing automated gates bite. Stages 1–2 and 6 are wired as PR / protected-branch gates
  afterward.
- A thin local shell driver exists only as off-CI "draft mode" while iterating.
