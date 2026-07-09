# Intake App — Purpose & Redesign Brief

A self-contained brief for redesigning the **Intake app** (the submitter front door
of the Software Factory). Written for a designer who knows nothing about this system.
It describes **what each screen is for and why** — not how it's currently built — plus
the few rules a redesign must not break.

---

## 1. What this app is, in one breath

The Intake app is the **front door** of an autonomous-but-governed "software factory."
A non-technical employee comes here with a problem or an idea ("the expense export is
broken", "I want a headcount dashboard"), describes it in plain words, answers a few
short AI follow-up questions, and submits. That submission becomes a structured
**Request** that kicks off an automated pipeline (requirements → architecture → build →
review → deploy), with humans approving the irreversible steps.

The submitter **never sees GitHub, never sees code, never sees factory jargon.** Their
whole world is: *say what you need → answer a few questions → see it understood →
track it.*

## 2. Who uses it (and how they feel)

**Submitters** — non-technical Micron staff. They are not engineers and shouldn't have
to think like one. They arrive with a need and a bit of uncertainty: *"I don't know how
to ask engineers for this. Will I say it right? Will anyone actually do it?"*

The app's job is to make them feel **heard, guided, and unintimidated** — and to quietly
extract enough structure from their plain-language request that the factory can act on
it. Calm, generous spacing, 16px body text, plain language, one step at a time. This is
**novice, occasional use** — the opposite of a dense power-tool. (The admin-facing
Control center is a separate app with the opposite design language; don't borrow from it.)

## 3. The core insight the design serves

Non-technical people can't write a spec — but they *can* describe a problem and answer
good questions about it. So the product turns "a vague ask" into "a buildable, grounded
mini-spec" through **a short AI conversation**, and then shows the submitter what was
understood **before** any human reviewer or machine touches it. The emotional arc to
design for: *uncertain → guided → understood → reassured → able to track.*

---

## 4. The flow, screen by screen (purpose of each)

The submitter moves through a short linear flow, then can track afterward.

### S0 · Sign in (`/login`)
**Purpose:** the front step — establish who they are with zero friction.
Single "Sign in with Microsoft" button, no new password (corporate SSO). Sets the tone:
*"Tell us what you need built."* Warm, welcoming, brand-forward. This is the first
impression — it should feel calm and trustworthy, not like a login wall.

### S1 · New Request — *the submission form* (`/submit/new`)
**Purpose:** capture the raw need with the **least possible friction**, while collecting
*just enough* structure for the AI to do its job next.

The key idea is **type-first progressive disclosure**: the submitter first picks *what
kind* of thing this is —
- **Bug fix** (something's broken in an existing app),
- **Enhancement** (improve an existing app),
- **New app** (build something new) —

…and only then do the relevant fields appear. The form should never show a wall of
inputs. By type, it asks for things like: *which app?* (a dropdown of registered apps),
*what should we call it?* (new app), a **plain-language description** ("Describe it in your
own words…"), and for bugs, light context (*where did you see it?*, *how often?*).

The promise printed on the form is the whole philosophy: *"A sentence or two is plenty —
we'll ask follow-ups next."* The form is deliberately **shallow**; depth comes from the
interview. Do not turn this into a long structured intake — its job is to lower the
barrier to starting.

### S2 · AI interview — *the adaptive conversation* (`/submit/:id/interview`)
**Purpose:** fill the gaps a developer would hit — **while the submitter is still
here** — so the eventual spec is grounded in real answers instead of guesses. This is
**enrichment, never a gate**: it makes the request better; it can never block it.

Behavior the design must support:
- A **short, adaptive chat** — at most ~3–4 follow-up questions, then it stops. It reads
  the request and asks the *most useful* next question, one at a time.
- Each question is **warm, plain, and non-leading**. When a small fixed set of answers is
  natural, it offers **2–4 pickable options** (with one-line explanations); otherwise the
  submitter types a free answer.
- Every question is **skippable** — the user is never trapped.
- A visible sense of **progress** (how far along, how many left) and gentle "thinking…"
  moments between questions so it feels like a real, considered conversation.
- It ends with reassurance: *"Thanks — that's everything I need. Next, check the summary
  before it goes to a reviewer."*

Tone target: a knowledgeable, friendly colleague asking smart clarifying questions — **not**
an interrogation, a survey, or a form wearing a chat costume. Short and adaptive.

### S3 · Review the draft spec — *"did we understand you?"* (`/submit/:id/review`)
**Purpose:** show the submitter, in plain terms, **what the AI understood**, so they can
catch misunderstandings *before* the request goes to a human reviewer and the factory
starts work. This is the **trust-and-accuracy moment**.

The draft spec is a short list of requirement lines, and critically, each line is
**grounded** — tagged with where it came from (the original request, or a specific
interview answer) — and any detail the AI had to **assume** (because nobody stated it) is
**explicitly flagged as an assumption** to be confirmed. The redesign should make this
provenance feel reassuring, not bureaucratic: *"here's what we heard, here's what we're
guessing — does this look right?"* Honesty about assumptions is a deliberate feature.

### S4 · Confirmation — *close the loop* (`/submit/:id/done`)
**Purpose:** end the submission calmly and set expectations: it's in, a **human will
review it next**, and they can track it. The submitter should leave feeling the thing is
handled and visible — not dropped into a void.

### Tracking · My Requests + Request detail (`/requests`, `/requests/:id`)
**Purpose:** answer the only question a submitter has after submitting — ***"where is my
thing?"*** — **without** ever exposing GitHub, PRs, or factory internals.

- **My Requests:** a calm list of *their own* requests with a clear, plain-language status
  (in review / being built / done / needs more info), most recent first.
- **Request detail:** the human-readable story of one request — what they asked, what was
  understood, and where it is now. Plain milestone language, never raw logs or code.

---

## 5. Design intent, voice, and brand (must survive a redesign)

From the product's design principles:
- **Quiet by default, loud only when it matters.** Calm surfaces; reserve emphasis for the
  one thing that needs the submitter's attention.
- **Guided and generous for submitters** — 16px body, roomy spacing, one decision at a
  time, plain language. (Contrast: the admin app is dense and keyboard-first — *not* the
  model here.)
- **Brand:** Micron Atlas lineage — light, near-white warm canvas, a single purple accent
  (`#BD03F7`), Micron Basis type, JetBrains Mono only for technical refs. Mission-control
  restraint: precise, fast, unflashy. *(Note: today's login screen uses a dark gradient —
  treat brand direction as a redesign question, not a fixed constraint, but stay within
  Micron's identity.)*
- **Anti-references — please avoid:** Jira's configurability sprawl; Slack's notification
  volume; consumer-SaaS gradients / glassmorphism / marketing gloss; "tool aesthetic"
  dark-mode-by-default.

## 6. Load-bearing rules a redesign must NOT break

These encode the product's logic, not just its looks. Change the pixels freely; keep
these true:

1. **The sequence is form → interview → review → submit.** Each step depends on the
   previous (the form seeds the interview; the interview grounds the spec; the review is
   the last human check before it leaves the submitter).
2. **The form stays shallow; the interview carries the depth.** Don't move interview-style
   questioning onto the form, or vice-versa.
3. **The interview is enrichment, never a blocker** — always skippable, always short,
   always degrades gracefully if the AI is unavailable.
4. **The draft spec shows provenance and flags assumptions.** That honesty is the feature;
   don't hide it for the sake of a cleaner card.
5. **Submitters never see GitHub, code, PRs, or factory/admin vocabulary** — anywhere,
   including status and tracking. Plain language only.
6. **A human approves before anything is built.** The confirmation/tracking copy must set
   that expectation honestly (no "your app is being built now" the instant they submit).

---

## 7. One-line summary for the designer

> Redesign a calm, guided front door where a non-technical employee describes a need in
> plain words, a short AI conversation sharpens it into a grounded mini-spec they can
> verify, and then they can track it — without ever meeting the machinery behind it.
