# Progress reporting via milestone summaries over GitHub events, not a live agent-callback stream

**Status:** accepted

The Control center shows each agent's progress as a **timeline of milestone summaries**: at the
end of each stage, the agent's last action is to write a short summary (what it did, how it
went), posted as a **PR comment**. A GitHub webhook delivers that comment to the Control center,
which adds it to the Work item's card. We deliberately did **not** build a live, moment-to-moment
agent-callback/streaming system (websockets, an agent phone-home API).

## Consequences

- Reporting rides the **same GitHub-event rail as the Gate events**, so there is one source of
  truth and no separate live-status infrastructure to build, secure, or keep consistent.
- The trade-off accepted: you see rich milestone updates, not token-by-token narration. Live
  streaming remains a possible future add-on, not the foundation.
- A future engineer building a "live control center" would naturally reach for websockets and an
  agent callback API. This records that we chose the cheaper, sturdier rail on purpose.
