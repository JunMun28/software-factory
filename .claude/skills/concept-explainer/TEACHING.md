# Teaching: making it stick

An explainer is read once and remembered later, or it failed. These are the
moves that get it remembered.

## Difficulty is a tool, but not here

Two different jobs need opposite settings:

- **Acquiring knowledge** — difficulty is the enemy. It consumes the working
  memory the reader needs for understanding. An explainer is mostly this: make
  it easy.
- **Retaining knowledge** — difficulty is the tool. Effortful retrieval builds
  durable memory.

So write the page for easy acquisition, then plant one or two retrieval hooks
(a question the reader must answer from memory, a "before you scroll, what
would you expect here?") rather than dressing the whole page as a quiz.

## Shape

1. **Thesis first.** One sentence that is the whole idea. If the reader stops
   after it, they still gained something. Everything after is elaboration.
2. **The cast.** Name the moving parts before describing their interactions.
   Readers cannot follow a story whose characters are unintroduced.
3. **The path.** Walk the concept the way it actually happens: in order, one
   step at a time, each step saying who acts and what proves it worked.
4. **Why it holds.** The guarantees, invariants, or reasons this design is
   trustworthy. This is where a sceptical reader is won or lost.
5. **The words.** A short glossary. Once a term is defined, use it consistently
   everywhere on the page.
6. **Where this came from.** The sources. This is what makes the page
   trustworthy rather than merely confident.

## Ground every claim

Cite the real thing: a file path, an ADR, a test that proves the behavior, a
primary source. Prefer the highest-trust source available, and prefer one the
reader can open themselves.

If something is true only in one environment, say which. If something is
aspirational, say so. An explainer that quietly overstates costs more trust
than it buys.

## Recommend one primary source

Close with the single best thing to read or watch next — not a list of ten. For
a system, the executable version of the page (the end-to-end test) is usually
the best possible source, because it cannot go stale silently.

## Leave the door open

End with an invitation to ask follow-up questions, with two or three *concrete*
examples of good ones. "Ask me anything" produces nothing; "ask what the red
gate actually checks" produces a conversation.

Where a question needs judgment rather than facts — is this a good design, will
this scale — point at a community or a practitioner, not just at the docs.

## Scope discipline

Working memory is small. One tangible win per page.

If the concept genuinely needs more, write a second page and link it, rather
than doubling this one. A page the reader finishes beats a page that covers
everything.
