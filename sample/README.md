# Sample Subject

The embedded sample project the Factory operates on when the Claude Code runner is
enabled (CONTEXT.md: "The MVP gate spike uses an embedded sample project").
Each approved Request gets its own git workspace copied from this template;
stages commit onto a work branch and the merge gate merges it to main.

Layout: `src/` is the implementer's territory, `tests/` is the test-author's —
the test-isolation gate hashes `tests/` between RED and GREEN and escalates if
the implementer touched it.
