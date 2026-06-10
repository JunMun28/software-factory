# Copilot CLI as primary runtime, with the test-isolation guarantee enforced at the CI/git layer

**Status:** accepted

We chose **GitHub Copilot CLI** over OpenCode as the Factory's primary agent runtime because
not all users have OpenCode access and Copilot is GitHub-native. The trade-off: Copilot's
context isolation is explicitly **not a security sandbox**, so — unlike OpenCode's
`deny`-based permission system — it cannot *physically* prevent the implementer agent from
editing its own tests. Since that anti-reward-hacking rule is the load-bearing guarantee of
the whole design, we **move enforcement to the orchestration / git layer**: CODEOWNERS on the
test directory, branch protection, and a CI check that rejects any implementer diff touching
test files. This is runtime-agnostic and checks the *artifact* rather than trusting the
agent's behavior.

## Consequences

- The **canonical execution path is CI**. A purely local interactive Copilot run is an
  *unenforced draft* — the test-isolation gate does not bite there.
- **OpenCode is deferred**, not rejected. Its permission model remains a future *second*
  enforcement layer that would also protect local runs, layered under the CI gate.
- Every gate (human and automated) lives in the same place — GitHub PR + Actions — keeping
  the enforcement story in one system.
