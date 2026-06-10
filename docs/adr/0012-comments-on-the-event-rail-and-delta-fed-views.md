# Comments ride the progress_event rail; views consume the poll loop's delta

**Status:** accepted
**Refines:** ADR 0008 (two-axis log) · ADR 0007 (polling now, SSE later)

The per-app feed originally merged two sources client-side: progress events
(polled) and per-request comment fetches (N+1 HTTP calls every tick), with no use
of the keyset cursor the log was designed around. Another admin's comment never
woke the poll at all. Three changes make the channel production-shaped:

1. **Comments dual-write onto the one rail.** Posting a comment still stores the
   canonical `Comment` row (the Issue view's Activity reads it), and *also* emits a
   `progress_event` with `kind="comment"` (payload: comment_id, author chrome, body).
   The kind enum of ADR 0008 grows by one entry; everything else — cursor, axes,
   broadcast rules — is unchanged. A one-time startup backfill migrates existing
   comments onto the log. Consequence: every feed update, human or agent, flows
   through the **same `?after=` cursor**, so cross-client comments propagate with
   zero extra machinery.

2. **A real channel endpoint.** `GET /api/subjects/{key}/feed` returns the **latest
   N items ascending plus a cursor** (no `after` = tail page; with `after` = only
   newer rows). The event serializers use one joined query (no per-row Request
   lookups). This is the `GET /subjects/{id}/feed?after=` seam the original
   control-center design specified — and the exact seam SSE drops into later.

3. **One poll loop, delta-fed views.** The Poll service already fetched every new
   event each tick and threw them away; it now exposes that batch as a `delta`
   signal. The feed appends id-deduped deltas instead of refetching its whole
   projection: per tick the feed costs **zero additional HTTP requests** and renders
   O(new items), never a whole-feed flash (the ADR 0007 guardrail, finally honored
   mechanically). UI behavior follows Slack conventions: stick-to-bottom when the
   reader is at the bottom, a "New messages" pill when they've scrolled up
   (never yank), and optimistic sends that reconcile against their own
   `comment_id` when the event echoes back.

## Consequences

- Legacy DBs: backfilled comment events carry new (high) ids with old timestamps;
  the client orders messages by timestamp, so rendering is correct, and the tail
  page may interleave them once. Fresh databases are unaffected.
- Any future feed-like surface (request timeline, notifications) should consume
  `Poll.delta` the same way rather than adding refetch effects.
