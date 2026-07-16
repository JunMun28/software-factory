# Plan B4 — GitHub as the real remote + the approve-deploy human gate

**Spec:** `docs/superpowers/specs/2026-07-14-openshift-kubernetes-architecture-design.md` (§4 lifecycle steps 8–10, §5 push credential seam, §6 GitHub + gates, §7 build/deploy, §4.10 approve-deploy).
**Predecessors:** B1 (`plan-b1-kube-job-runner.md`), B2 (`plan-b2-kind-cluster.md`), B3 (`plan-b3-build-deploy.md`) — merged at `7ee9643`, CI green, proven live on kind.
**Milestone:** close the last two gaps between the local profile and spec §4/§6: (A) the **second human gate** (`approve-deploy`) so a merged request *waits* before it builds+deploys, with the approver recorded; (B) **GitHub** as the real remote behind the same `SF_REPO_URL`/push-credential seam B2 built — one produced app = one private `sf-app-<slug>` repo, PR opened at first stage push, merged via the GitHub API with a graded-SHA precondition, then built+deployed by B3's untouched path.

B3 stopped at: after the merge gate, the runner drives build→deploy automatically (Design decision 8 — the second gate deferred), and the "remote" is the in-cluster git-daemon (B2 Design decision 2 — GitHub deferred). B4 swaps in exactly those two deferred seams and nothing else.

---

## What I verified by reading the code (load-bearing facts)

- **`begin_deploy` already exists** (`transitions.py:270-280`) and `_ev_begin_deploy` (`transitions.py:154-158`). B3 wired `approve_merge → merge → begin_deploy (stage=deploy, gate=None) → _drive_deploys builds`. B4 inserts a *gate* between merge and `begin_deploy`: `approve_merge → merge → raise_deploy_gate (stage=deploy, gate=approve_deploy)`, then human approve → `claim_deploy` + `begin_deploy` → `_drive_deploys` builds.
- **`_drive_deploys` selects `Request.stage == "deploy"` with no gate filter** (`kube_runner.py:477`). With a real deploy gate this would drive an *unapproved* request. B4 adds `Request.gate.is_(None)` to that WHERE — the single behavioral guard that makes the gate actually hold.
- **`intents.KINDS` already contains `CREATE_REPO`, `OPEN_PR`, `MERGE_PR`** (`intents.py:22-37`) — Half B only wires them, no vocabulary migration.
- **`httpx>=0.28.1` is already a dependency** (`api/pyproject.toml`) — `github.py` uses it, **no new heavy dep**.
- **The approve endpoint's routing guard** (`routers/gates.py:42`) is `r.gate == GATE_APPROVE_MERGE or r.stage in ("review", "deploy", "done")` — B3 folded `"deploy"` into the *merge* family. B4 must **peel `"deploy"` off into the deploy family**, or an approve at the deploy gate mis-routes to `claim_merge`. This is the delicate change (Task A3).
- **The gate type is a closed union** `gate: 'approve_spec' | 'approve_merge' | null` (`packages/shared/src/lib/models.ts:98`), consumed by `confirmSteps`/`gateLabel` (`util.ts:87-116`), `ApproveModal` (`gate-modals.ts:27,53`), `floor-view.ts:103-106,190-194`, and `notify_gate_raised` (`notifications.py:86`). B4 adds `'approve_deploy'` to the union and one branch at each site — additive only.
- **The push/clone credential is already env-driven** (`kube_jobs.py:70-93` mounts `CODEX_AUTH_SECRET` into *stage* pods only; the entrypoint composes the clone URL from `SF_REPO_URL`). B4 mounts a GitHub-token Secret the same way and the entrypoint injects the token into the GitHub URL. **Gate/build pods get neither the token nor github egress** (`gate-walls`/`build-walls` reach only git-daemon:9418 + registry) — confirmed at `networkpolicies.yaml:115-165`.
- **`api-walls` egress is `- {}`** (all-allow, `networkpolicies.yaml:61-62`, comment already says "GitHub (B3)") — the **orchestrator can reach github.com** to create repos, open/merge PRs, and fetch. **`agent-stage-walls`** grants internet egress (`0.0.0.0/0` except cluster CIDRs) — stage pods can clone/push github.com. This asymmetry is the whole basis of the mirror design below.
- **The agent pushes to `SF_REPO_URL` `HEAD:$SF_BRANCH`** and the local git-daemon repo uses `receive.denyCurrentBranch=updateInstead` (`entrypoint.sh` tail; `workspace.py:91`). In GitHub mode the agent pushes to **GitHub**, so the orchestrator's local mirror no longer auto-updates — **the orchestrator must `git fetch` from GitHub before it grades or merges** (surface_hash_at and merge_graded both read the local repo). This is the precise flow Task B3 designs.
- **`workspace.merge_graded`** (`workspace.py:130-153`) does a local `--no-ff` merge with a head==graded-SHA precondition. In GitHub mode the merge moves to `github.merge_pr(..., sha=...)` (same precondition, API-side); the local mirror is then fast-forwarded so **B3's build clone (`git://api:9418/<ref>` at merged main) is byte-for-byte untouched**.
- **`_app_slug(req)`** already exists (`kube_runner.py:471`): `req.app.key if req.app else req.ref.lower()` — the produced-app slug and the `sf-app-<slug>` repo name share one source.
- `Request.stage`/`gate` are the CAS columns; no schema change — `"deploy"` already fits `String(16)`, `approve_deploy` fits the `gate String` column (same width as `approve_merge`).

---

## Design shape (the two seams, precisely)

**A — the deploy gate** is a pure lifecycle change, mirroring the merge gate row-for-row:

```
review ──raise_merge_gate──▶ [approve_merge gate]
   │ human approve
   ▼ claim_merge → (kube) merge → raise_deploy_gate
stage=deploy, gate=approve_deploy   ◀── the request WAITS here (B4 new)
   │ human approve (second gate)
   ▼ claim_deploy → begin_deploy (gate=None)
stage=deploy, gate=None  ──▶ _drive_deploys: build → deploy → finish_done
```

When `app_deploy_enabled()` is **false**, `approve_merge` still calls `finish_done` (B3-disabled = B2 = merge ends at `done`) — **no deploy gate is ever raised**. The simulator path is untouched (the deploy gate only exists in kube+app_deploy mode).

**B — GitHub mirror topology** (why gate/build pods never touch github):

```
        push (github token)              fetch (orchestrator, api-walls egress = *)
 stage pod ───────────────▶ github.com/OWNER/sf-app-<slug> ───────────────▶ orchestrator local repo
   (agent-stage-walls:                  (private repo)                        (settings.WORKSPACES/<ref>)
    internet egress)                                                                    │ git-daemon sidecar
                                                                                        ▼ git://api:9418/<ref>
                                                                          gate pod / build pod clone the PINNED SHA
                                                                          (gate-walls/build-walls: git-daemon ONLY)
```

Agents push to GitHub; the orchestrator fetches from GitHub into the local mirror that git-daemon serves; **gate and build pods clone the mirror over `git://api:9418` exactly as in B2/B3** — they stay walled from the internet, and B3's build path is unchanged. `FACTORY_GITHUB_TOKEN` unset ⇒ the agent pushes to git-daemon as today, byte-for-byte B2/B3.

---

## Scope

**In (B4):**
- **Half A (autonomous, unit):** `GATE_APPROVE_DEPLOY` + `raise_deploy_gate`/`claim_deploy` transitions; `approve_merge` raises the deploy gate instead of auto-driving; `_drive_deploys` gains the `gate IS NULL` guard; the approve endpoint peels `deploy` into a new claim + `begin_deploy` (approver in audit + event); minimal additive console surfacing; `kind-smoke` approves the deploy gate as a second call.
- **Half B (interactive, GitHub+PAT):** `github.py` seam (`ensure_repo`/`open_pr`/`merge_pr` + `FakeGitHub`), all env-gated on `FACTORY_GITHUB_TOKEN`; `workspace.py` GitHub push/fetch plumbing; runner integration (create repo + open PR at first stage; fetch-before-grade; GitHub-API merge with SHA precondition; mirror fast-forward); stage-pod GitHub-token Secret + `sync-github-token` task + `FACTORY_GITHUB_OWNER` ConfigMap; a `FACTORY_GITHUB_TOKEN`-gated `github-smoke.sh` with a repo-cleanup path.

**Out (later — explicitly deferred):** GitHub **App** installation tokens (the office/Phase-2 swap behind the same `get_push_credential()` seam — B4 uses a personal fine-grained PAT); `overlays/openshift`/`aks` build seams (BuildConfig, Actions→ACR); repo *flip-to-public* on merge (spec §4.8 "if desired" — B4 keeps repos private); gitleaks-per-gate + automatic key revocation (spec §5); branch protection on GitHub `main`; template-sync request type (spec §7 Phase 3); Prometheus/`/metrics`; Azure SQL cutover.

---

## Constraints honored (every task)

- **`FACTORY_GITHUB_TOKEN` unset ⇒ B2/B3 byte-for-byte** (git-daemon remote, local `merge_graded`). **`app_deploy_enabled()` false ⇒ B2 byte-for-byte** (merge → done, no deploy gate). These are the two independent env gates; either can ship alone.
- **`task verify` + CI stay cluster-free AND github-free:** every Half-A test runs on the existing fakes; every Half-B unit test runs against `FakeGitHub` + a local temp git repo (no network). `github-smoke.sh` is opt-in and gated on `FACTORY_GITHUB_TOKEN`, like `kind-smoke`.
- **Append-only `progress_event`; single uvicorn worker; MSSQL portability:** no new columns (reuse `Request.stage`/`gate` `String`, `Intent` rows for repo/PR/merge outcomes); `~col`/truthiness not `.is_(bool)`; migrations import no live app code.
- **Intent log around every external side effect** (`CREATE_REPO`, `OPEN_PR`, `MERGE_PR`) with deterministic keys and idempotent `begin()` — a replayed tick never double-creates a repo or PR.
- **Writer never grades; grader never writes; merger checks the grade** (spec §6): the GitHub merge keeps the head==graded-SHA precondition; gate pods hold no push credential and clone only the pinned SHA from the mirror.
- **Approver identity is recorded** (spec §4.10): `deploy_claimed` + `approved_deploy` audit rows carry `operator_id`, and the `begin_deploy` milestone names the approver.

---

## Task summary

| # | Task | Tag |
|---|------|-----|
| A1 | `transitions.py` — `GATE_APPROVE_DEPLOY`, `raise_deploy_gate`/`claim_deploy`, `begin_deploy`+event rework, DECISIVE_ACTIONS, notify | unit |
| A2 | Runner — `approve_merge` raises the deploy gate; `_drive_deploys` gains `gate IS NULL`; cancel-from-gate teardown is a no-op | unit |
| A3 | `routers/gates.py` — peel `deploy` into `claim_deploy` + `begin_deploy` (approver audit/event); replay routing | unit |
| A4 | Console (minimal, additive) — `approve_deploy` in the gate union + one branch per render site; run in a clean worktree | interactive (console) |
| A5 | `kind-smoke` — second approve call at the deploy gate; assert the gate held (status/stage/gate before approve) | cluster+LLM |
| B1 | `github.py` seam + `FakeGitHub` — `ensure_repo`/`open_pr`/`merge_pr`, env-gated on `FACTORY_GITHUB_TOKEN` | unit |
| B2 | `settings` + `workspace.py` GitHub git-plumbing — `github_enabled()`, authed push/fetch, mirror fast-forward | unit |
| B3 | Runner/workspace integration — create repo + open PR at first stage; fetch-before-grade; API merge; build path untouched | unit |
| B4 | Deploy wiring — stage-pod GitHub-token Secret + entrypoint URL injection, `sync-github-token`, `FACTORY_GITHUB_OWNER` | cluster |
| B5 | `github-smoke.sh` — real repo → PR → merged on GitHub → deployed pod; marked real-GitHub steps + cleanup | cluster+LLM+GitHub |
| B6 | Docs + full verify + commit | docs |

Tasks A1–A3, B1–B3 are the **autonomous half** (unit — no cluster, no GitHub, no user). A4 is a small clean-worktree console edit. A5, B4, B5, B6 are the **interactive half** (kind + a fine-grained PAT + a codex-spending run; the coordinator pauses before any real repo is created).

---

# AUTONOMOUS HALF (unit)

## Task A1 — transitions: the deploy gate (unit)

**Goal:** `approve_deploy` becomes a first-class gate mirroring `approve_merge` — raised by the machine after a real merge, claimed by a human, then `begin_deploy` releases it to the driver. Pure table + event changes; no schema.

**Files:** `api/app/transitions.py` (edit), `api/app/notifications.py` (edit), `api/tests/test_transitions.py` (edit).

### Step 1 — `transitions.py` constants + DECISIVE_ACTIONS

```python
GATE_APPROVE_SPEC = "approve_spec"
GATE_APPROVE_MERGE = "approve_merge"
GATE_APPROVE_DEPLOY = "approve_deploy"   # B4: the second human gate (spec §4.10)

DECISIVE_ACTIONS = (
    "approved",
    "merge_claimed",
    "approved_merge",
    "merge_approval_failed",
    "deploy_claimed",        # B4
    "approved_deploy",       # B4
    "deploy_approval_failed", # B4
    "sent_back",
    "retried",
    "taken_over",
    "sent_back_to_stage",
    "cancelled",
)
```

### Step 2 — the two new transitions + `begin_deploy`/event rework

`raise_deploy_gate` is the machine transition `approve_merge` fires after the merge lands. It moves the request into `stage="deploy"` **with the gate set**, so `_drive_deploys` (which now requires `gate IS NULL`) leaves it alone until a human approves:

```python
def _ev_raise_deploy_gate(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "gate_event",
         "Waiting at the deploy gate — merged to main, deploy needs approval",
         broadcast=True,
         payload={"gate": GATE_APPROVE_DEPLOY, "Ref": req.ref, "sha": params.get("sha")})
```

`_ev_begin_deploy` gains the approver (it now runs on the *approve* path, not the auto path):

```python
def _ev_begin_deploy(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "milestone_summary",
         f"Deploy approved by {actor.name} — building and deploying the app",
         stage="deploy",
         payload={"Stage": "Deploy", "Ref": req.ref, "sha": params.get("sha")})
```

TABLE additions (place next to `claim_merge`/`begin_deploy`):

```python
    Transition(
        # B4 (machine, epoch-fenced via the caller): after a real merge, the
        # request WAITS at the deploy gate instead of auto-building. Pre mirrors
        # raise_merge_gate but also stamps stage=deploy so _drive_deploys' new
        # `gate IS NULL AND stage==deploy` guard holds it until a human approves.
        name="raise_deploy_gate",
        pre=Pre(status_in=(APPROVED,), gate=None),
        effects=lambda p: {"gate": GATE_APPROVE_DEPLOY, "stage": "deploy",
                           "stage_entered_at": utcnow()},
        events=_ev_raise_deploy_gate,
        notify=_notify_gate_raised,
        conflict_detail=lambda r: f"Cannot raise the deploy gate (status={r.status!r}, gate={r.gate!r})",
    ),
    Transition(
        # B4 (HTTP): the human claims the deploy gate, mirroring claim_merge.
        name="claim_deploy",
        pre=Pre(status_in=(APPROVED,), gate=GATE_APPROVE_DEPLOY),
        effects=lambda p: {"gate": None},
        audit_action="deploy_claimed",
        replay_actions=("deploy_claimed", "approved_deploy", "deploy_approval_failed"),
        conflict_detail=lambda r: f"Cannot approve deploy on a {r.status} request",
    ),
```

`begin_deploy` stays as-is (`Pre(status_in=(APPROVED,))`, `effects` sets `gate=None, stage="deploy"`); it is now applied on the **approve path** (Task A3) to emit the approver-attributed milestone. Its effects are a no-op over the post-`claim_deploy` state except the event, which is the point.

### Step 3 — `notifications.py`: name the deploy gate

```python
def notify_gate_raised(db: Session, req: Request) -> None:
    gate_name = {
        "approve_merge": "merge gate",
        "approve_deploy": "deploy gate",
    }.get(req.gate, "spec gate")
    _notify(db, req,
            f"Software Factory: {gate_name} needs approval",
            f"{req.ref} {req.title} is waiting at the {gate_name}.")
```

### Step 4 (RED→GREEN) — `test_transitions.py` additions

```python
def test_raise_deploy_gate_holds_at_deploy_stage(db, approved_review_request):
    r = approved_review_request  # status=approved, stage=review, gate=None (post-merge-claim)
    res = transitions.apply(db, r, "raise_deploy_gate",
                            actor=transitions.FACTORY, params={"sha": "a"*40},
                            epoch=1)
    assert isinstance(res, transitions.Win)
    db.commit()
    assert r.gate == transitions.GATE_APPROVE_DEPLOY and r.stage == "deploy"
    assert r.status == transitions.APPROVED

def test_claim_then_begin_deploy_releases_to_driver(db, deploy_gated_request):
    r = deploy_gated_request  # approved/deploy/gate=approve_deploy
    a = transitions.Actor(name="Ada", operator_id=7)
    assert isinstance(transitions.apply(db, r, "claim_deploy", actor=a), transitions.Win)
    assert isinstance(transitions.apply(db, r, "begin_deploy", actor=a,
                                        params={"sha": "a"*40}), transitions.Win)
    db.commit()
    assert r.gate is None and r.stage == "deploy" and r.status == transitions.APPROVED
    # approver recorded
    row = db.scalar(select(AuditEvent).where(AuditEvent.action == "deploy_claimed"))
    assert row.operator_id == 7

def test_deploy_gate_replay_resolves_to_the_winner(db, deploy_gated_request):
    r = deploy_gated_request
    a = transitions.Actor(name="Ada", operator_id=7)
    transitions.apply(db, r, "claim_deploy", actor=a); db.commit()
    loss = transitions.apply(db, r, "claim_deploy", actor=a)  # replay: gate consumed
    assert isinstance(loss, transitions.Loss) and loss.replay is True
```

```bash
cd api && uv run pytest -q tests/test_transitions.py
# EXPECT: green; add the two fixtures (approved_review_request, deploy_gated_request)
# following the existing request-factory helpers in conftest.
```

---

## Task A2 — runner: raise the gate, guard the driver (unit)

**Goal:** `approve_merge` (kube, `app_deploy_enabled()`) merges then **raises the deploy gate** instead of `begin_deploy`; `_drive_deploys` only drives **approved** (gate-cleared) deploy requests; a cancel *from* the deploy gate tears down nothing (nothing built yet).

**Files:** `api/app/kube_runner.py` (edit), `api/tests/test_deploy_runner.py` (edit).

### Step 1 — `approve_merge` tail: `begin_deploy` → `raise_deploy_gate`

Replace the `if settings.app_deploy_enabled():` block in `approve_merge` (`kube_runner.py:434-447`):

```python
        if settings.app_deploy_enabled():
            # B4: merge landed — WAIT at the deploy gate (spec §4.10). The build
            # is driven only after a human clears the gate (Task A3). Fenced +
            # notified like the merge gate; a raced Cancel wins the CAS.
            res = transitions.apply_committed(
                db, req, "raise_deploy_gate",
                actor=transitions.Actor(name=actor),
                params={"sha": sha},
                epoch=get_elector().epoch,
            )
            if isinstance(res, transitions.Loss):
                log.info("%s: raise_deploy_gate lost (%s)", req.ref, res.detail)
                return
            log.info("%s merged at %s — waiting at the deploy gate", req.ref, sha[:12])
            return
```

`raise_deploy_gate.Pre` is `status_in=(APPROVED,), gate=None` — valid because `claim_merge` (run by the approve endpoint before `approve_merge`) already set `gate=None`. `apply_committed` fires `_notify_gate_raised` after commit.

### Step 2 — `_drive_deploys`: the gate guard (the one behavioral line)

```python
    def _drive_deploys(self, db: Session, moved: list[str]) -> None:
        if not settings.app_deploy_enabled():
            return
        # B4: only APPROVED (gate-cleared) deploy requests build. A request at
        # gate=approve_deploy is WAITING for a human — never drive it.
        requests = db.scalars(
            select(Request).where(Request.stage == "deploy", Request.gate.is_(None))
        ).all()
        for req in requests:
            ...  # body unchanged
```

`_drive_one_deploy`'s existing head — `if req.status != transitions.APPROVED or req.needs_human: self._teardown_app(...)` — already handles a cancel that lands after the build started. A cancel *at the gate* (nothing built) hits `_teardown_app` with **no build/deploy StageJob rows and no applied objects**, so `delete_job`/`delete_by_label` are best-effort no-ops — teardown of nothing, as required.

### Step 3 (RED→GREEN) — `test_deploy_runner.py` additions

```python
def test_merge_raises_deploy_gate_not_auto_build(client, monkeypatch):
    _enable_deploy(monkeypatch)
    # drive to the merge gate, approve merge:
    ... runner.approve_merge(db, req, "Ada")
    assert req.stage == "deploy" and req.gate == transitions.GATE_APPROVE_DEPLOY
    # a tick must NOT spawn a build while the gate is up
    runner.tick(db)
    assert db.scalar(select(StageJob).where(StageJob.role == "build")) is None

def test_gate_cleared_then_build_runs(client, monkeypatch):
    _enable_deploy(monkeypatch)
    ... # after approve_merge → deploy gate; clear it like the endpoint does:
    transitions.apply(db, req, "claim_deploy", actor=Actor(name="Ada", operator_id=7))
    transitions.apply(db, req, "begin_deploy", actor=Actor(name="Ada"), params={"sha": sha})
    db.commit()
    runner.tick(db)
    assert db.scalar(select(StageJob).where(StageJob.role == "build")).status == "running"

def test_cancel_at_deploy_gate_tears_down_nothing(client, monkeypatch):
    _enable_deploy(monkeypatch)
    ... # at gate=approve_deploy, cancel:
    transitions.apply(db, req, "cancel", actor=Actor(name="Ada")); db.commit()
    runner.tick(db)  # _drive_deploys skips it (gate was set; now cancelled/stage moves)
    assert fake.applied == [] and req.status == transitions.CANCELLED
```

```bash
cd api && uv run pytest -q tests/test_deploy_runner.py tests/test_kube_runner.py
# EXPECT: green — the gate guard leaves every B3 deploy-driver test intact
# because those tests reach stage=deploy via begin_deploy (gate already None).
```

**Note:** the existing B3 tests that call `begin_deploy` directly still pass — they land at `gate=None, stage=deploy`, which the new WHERE still selects.

---

## Task A3 — approve endpoint: peel deploy into its own claim (unit)

**Goal:** the approve endpoint routes a request at `approve_deploy` to `claim_deploy` + `begin_deploy`, recording the approver; the routing/replay guard distinguishes the deploy family from the merge family.

**Files:** `api/app/routers/gates.py` (edit), `api/tests/test_api.py` (edit).

### Step 1 — routing (the delicate part)

The current guard folds `"deploy"` into the merge branch. Split it so a live deploy gate — and a *consumed* deploy gate (replay while building) — routes to `claim_deploy`:

```python
@router.post("/api/requests/{rid}/approve", response_model=RequestDetail)
def approve(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = _operator_actor(db, body.operator_id)

    # B4: the deploy gate (spec §4.10). A live gate, OR a consumed gate whose
    # request still sits at stage=deploy (a replay while the build runs), is the
    # deploy family. `stage=="deploy"` can ONLY arise post-merge, so it never
    # collides with the merge/spec routing.
    if r.gate == transitions.GATE_APPROVE_DEPLOY or (r.gate is None and r.stage == "deploy"):
        res = transitions.apply(db, r, "claim_deploy", actor=actor)
        if isinstance(res, transitions.Loss):
            return conflict_response(r, res)
        # release to the driver + record the approver in one transaction
        transitions.apply(db, r, "begin_deploy", actor=actor,
                          params={"sha": r.needs_human_reason and None})  # sha read below
        db.add(AuditEvent(request_id=r.id, operator_id=body.operator_id,
                          actor=actor.name, action="approved_deploy"))
        db.commit()
        return to_out(r, RequestDetail)

    # merge family (B3's guard, with "deploy" removed)
    if r.gate == transitions.GATE_APPROVE_MERGE or r.stage in ("review", "done"):
        res = transitions.apply(db, r, "claim_merge", actor=actor)
        ...  # unchanged
    ...  # approve_spec unchanged
```

**On the `sha` for the `begin_deploy` event:** the endpoint doesn't hold the merge SHA. Read it from the `raise_deploy_gate` gate event payload, or simplest — drop `sha` from the milestone (the driver re-reads `workspace.head_sha(ws, "main")` at build time anyway, `kube_runner.py:536`). Plan: pass `params={}`; `_ev_begin_deploy` renders "Deploy approved by {actor.name} — building…" without the sha. Keep the sha only in the earlier `raise_deploy_gate` event.

**Why `stage=="deploy"` is a safe discriminator:** a request only ever reaches `stage=="deploy"` *after* a merge (via `raise_deploy_gate`/`begin_deploy`). `approve_spec` requests are at `stage in (spec, architecture)`; merge-gate requests at `stage=="review"`. So the `deploy` branch can never swallow a spec or merge approval. The one residual edge — a deploy approval replayed *after* the request reached `done` — falls through to the merge branch (`r.stage in ("review","done")`), produces a `claim_merge` Loss, and `conflict_response` still resolves it against the persisted `approved_deploy` winner (a sane 409). No approve UI is shown on `done` requests, so this is replay-hygiene only. Documented in Design decision 4.

### Step 2 (RED→GREEN) — `test_api.py`

```python
def test_approve_at_deploy_gate_records_approver_and_releases(client, deploy_gated):
    r = client.post(f"/api/requests/{deploy_gated}/approve", json={"operator_id": 7})
    body = r.json()
    assert body["gate"] is None and body["stage"] == "deploy" and body["status"] == "approved"
    # audit trail: deploy_claimed + approved_deploy, both operator 7
    ...

def test_approve_replay_at_deploy_gate_is_a_clean_409(client, deploy_gated):
    client.post(f"/api/requests/{deploy_gated}/approve", json={"operator_id": 7})
    r2 = client.post(f"/api/requests/{deploy_gated}/approve", json={"operator_id": 7})
    assert r2.status_code in (200, 409)  # replay resolves to the same winner, no double-fire
```

```bash
cd api && uv run pytest -q tests/test_api.py tests/test_transitions.py tests/test_deploy_runner.py
# EXPECT: green
```

---

## Task A4 — console surfacing (minimal, additive) — interactive, clean worktree

**Goal:** the deploy gate renders like the merge gate with the smallest additive diff. **Evidence is PRE-build:** the merge evidence (already shown) plus *what will be deployed* — slug, replicas, target URL.

> **Coordination flag:** another session has **uncommitted console work in the main checkout** (`git status` shows `apps/intake/**` modified). Implement this task in a **clean worktree** (`git worktree add` off `7ee9643`) so these edits don't tangle with theirs, then land as a focused commit. Every edit below is a single additive branch — no refactors.

**Files (one branch each):** `packages/shared/src/lib/models.ts`, `packages/shared/src/lib/util.ts`, `apps/console/src/app/shared/gate-modals.ts`, `apps/console/src/app/floor/floor-view.ts`, plus `.spec.ts` peers.

### Edits

1. **`models.ts:98`** — widen the union:
   ```ts
   gate: 'approve_spec' | 'approve_merge' | 'approve_deploy' | null;
   ```

2. **`util.ts` `gateLabel`** (add before the `null` return):
   ```ts
   if (r.gate === 'approve_deploy') return 'Approve deploy';
   ```

3. **`util.ts` `confirmSteps`** — a deploy branch (evidence = what *will* deploy, no build yet):
   ```ts
   if (r.gate === 'approve_deploy') {
     return [
       ['Build the image from merged main', r.repo ?? ''],
       ['Deploy to the cluster', `${r.app_key ?? r.ref.toLowerCase()} · 1 replica`],
       ['Publish the live URL', `${r.app_key ?? r.ref.toLowerCase()}.localtest.me`],
     ];
   }
   ```
   *(The target host mirrors `settings.APP_INGRESS_DOMAIN`; if that ever leaves the projection, thread it through — for the local profile it is `localtest.me`.)*

4. **`gate-modals.ts` `ApproveModal`** — extend the two ternaries to a small map so `approve_deploy` gets its own title/button (title `Approve this deploy?`, button `Approve & deploy`); `confirmSteps` already returns the deploy steps, so the `<ul>` needs no change.

5. **`floor-view.ts`** — two additive branches:
   - `deriveCard` (`:103-106`): `if (r.gate === 'approve_deploy') return { ...base, tone: 'gate', glyph: null, state: 'Approval deploys it' };`
   - `deriveQueue` headline/consequence (`:190-194`): `approve_deploy` → headline `Approve to deploy`, consequence `builds and deploys ${app_name}`.

6. **`.spec.ts`** peers: add an `approve_deploy` case to `gate-modals.spec.ts`, `util.spec.ts` (`gateLabel`/`confirmSteps`), `floor.spec.ts`.

```bash
# in the clean worktree:
npx nx test shared && npx nx test console   # EXPECT: green (additive cases)
```

**Note:** the shared package's `public-surface.spec.ts` locks the *value* export surface, not type unions — widening `gate` needs no public-api change. Confirm `confirmSteps`/`gateLabel` signatures are unchanged (they are — same `FactoryRequest` in, same shape out).

---

## Task A5 — kind-smoke: prove the deploy gate held (cluster+LLM)

**Files:** `scripts/kind-smoke.sh` (edit).

After the existing merge-approval call, the smoke must (1) observe the request **parked at the deploy gate** and (2) make a **second** approve call to release it, before the B3 build/deploy assertions run:

```bash
echo "▸ the request WAITS at the deploy gate (Plan B4, spec §4.10)"
# after approving the MERGE gate, the request must be at deploy/approve_deploy —
# NOT already building. Poll the projection:
for _ in $(seq 1 30); do
  read STATUS STAGE GATE < <(req_state "$RID")   # helper: jq status/stage/gate
  [ "$GATE" = "approve_deploy" ] && break || sleep 2
done
[ "$STATUS" = "approved" ] && [ "$STAGE" = "deploy" ] && [ "$GATE" = "approve_deploy" ] \
  || fail "request did not hold at the deploy gate (status=$STATUS stage=$STAGE gate=$GATE)"
# prove it is HELD: no build Job exists yet
kubectl -n "$NS" get jobs -o name | grep -q "sf-$LREF-build" \
  && fail "build started before the deploy gate was approved — gate did not hold"
ok "request held at the deploy gate; nothing built yet"

echo "▸ approve the deploy gate (second human gate)"
curl -sf -X POST "$API/api/requests/$RID/approve" -H 'content-type: application/json' \
  -d '{"operator_id":1}' >/dev/null || fail "deploy-gate approve failed"
ok "deploy gate approved — build+deploy now proceeds"
# … then the B3 build/deploy/ingress assertions run unchanged …
```

Update the banner to reference **two** gates. `req_state`/`RID` reuse the smoke's existing request-tracking helpers.

```bash
task kind-smoke   # EXPECT (10-25 min, spends codex): holds at deploy gate, second approve, live pod
```

---

# INTERACTIVE HALF (GitHub + PAT)

## Task B1 — `github.py` seam + `FakeGitHub` (unit)

**Goal:** a thin REST seam over the GitHub API for the three side effects, plus a `FakeGitHub` for tests. **Env-gated on `FACTORY_GITHUB_TOKEN`:** unset ⇒ never constructed, current behavior byte-for-byte.

**Files:** `api/app/github.py` (new), `api/tests/fake_github.py` (new), `api/tests/test_github.py` (new).

### Interface (both `GitHub` and `FakeGitHub` satisfy this)

```python
def ensure_repo(slug: str) -> str: ...                        # -> https clone_url; idempotent create
def open_pr(slug: str, branch: str, title: str, body: str) -> int: ...   # -> pr_number; idempotent
def find_open_pr(slug: str, branch: str) -> int | None: ...   # resolve number by head branch
def merge_pr(slug: str, pr_number: int, sha: str) -> str: ...  # SHA-precondition merge -> merge_sha
```

### Step 1 (RED) — `api/tests/test_github.py`

```python
"""github.py seam (Plan B4) — the REST calls are exercised against FakeGitHub so
CI is network-free; the SHA-precondition and idempotency guarantees are the
FAKE's contract, which the runner tests build on. The REAL client's wire shapes
are marked verify-at-build-time (Task B5's opt-in github-smoke)."""
import pytest
from fake_github import FakeGitHub

SHA = "b" * 40


def test_ensure_repo_is_idempotent_and_private():
    gh = FakeGitHub(owner="acme")
    url = gh.ensure_repo("northwind")
    assert url == "https://github.com/acme/sf-app-northwind.git"
    assert gh.ensure_repo("northwind") == url          # no duplicate create
    assert gh.repos["sf-app-northwind"]["private"] is True

def test_open_pr_idempotent_by_head_branch():
    gh = FakeGitHub(owner="acme"); gh.ensure_repo("northwind")
    n = gh.open_pr("northwind", "work/req-1", "REQ-1", "body")
    assert gh.open_pr("northwind", "work/req-1", "REQ-1", "body") == n  # same PR
    assert gh.find_open_pr("northwind", "work/req-1") == n

def test_merge_requires_the_graded_sha():
    gh = FakeGitHub(owner="acme"); gh.ensure_repo("northwind")
    n = gh.open_pr("northwind", "work/req-1", "REQ-1", "body")
    gh.set_head("northwind", "work/req-1", SHA)         # test helper: branch tip
    with pytest.raises(github.MergeShaMismatch):
        gh.merge_pr("northwind", n, "a" * 40)           # stale SHA refused
    merge_sha = gh.merge_pr("northwind", n, SHA)
    assert len(merge_sha) == 40 and gh.prs[n]["merged"] is True
```

### Step 2 (GREEN) — `api/app/github.py`

```python
"""GitHub REST seam for the produced-app repos (Plan B4; spec §5/§6).

Thin, httpx-based (no new dep), env-gated on FACTORY_GITHUB_TOKEN — unset means
the runner never constructs this and behaves exactly like B2/B3 (git-daemon
remote, local merge). Local profile: a personal github.com account + a
fine-grained PAT (FACTORY_GITHUB_TOKEN, FACTORY_GITHUB_OWNER). The office/Phase-2
swap (a GitHub App issuing per-Job installation tokens) sits behind this same
four-method surface — callers never learn which produced the token.

Only three side effects, each behind an intent row (spec §3.3): create the
private repo, open the PR at first stage push, merge with the graded-SHA
precondition. Writer never grades; grader never writes; the merge checks the
grade (the `sha` param is GitHub's server-side head==sha precondition — a moved
branch 409s, exactly the local merge_graded rule).
"""
import httpx

from . import settings

API = "https://api.github.com"
_HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}


class GitHubError(RuntimeError): ...
class MergeShaMismatch(GitHubError): ...


def repo_name(slug: str) -> str:
    return f"sf-app-{slug}"


class GitHub:
    def __init__(self, token: str | None = None, owner: str | None = None):
        self._token = token or settings.GITHUB_TOKEN
        self._owner = owner or settings.GITHUB_OWNER
        if not (self._token and self._owner):
            raise GitHubError("FACTORY_GITHUB_TOKEN and FACTORY_GITHUB_OWNER are required")

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=API, timeout=20,
                            headers={**_HEADERS, "Authorization": f"Bearer {self._token}"})

    def ensure_repo(self, slug: str) -> str:
        name = repo_name(slug)
        with self._client() as c:
            got = c.get(f"/repos/{self._owner}/{name}")
            if got.status_code == 200:
                return got.json()["clone_url"]
            if got.status_code != 404:
                raise GitHubError(f"repo lookup failed: {got.status_code} {got.text[:200]}")
            made = c.post("/user/repos",
                          json={"name": name, "private": True, "auto_init": False})
            if made.status_code not in (201,):
                raise GitHubError(f"repo create failed: {made.status_code} {made.text[:200]}")
            return made.json()["clone_url"]

    def find_open_pr(self, slug: str, branch: str) -> int | None:
        with self._client() as c:
            r = c.get(f"/repos/{self._owner}/{repo_name(slug)}/pulls",
                      params={"head": f"{self._owner}:{branch}", "state": "open"})
            r.raise_for_status()
            data = r.json()
            return data[0]["number"] if data else None

    def open_pr(self, slug: str, branch: str, title: str, body: str) -> int:
        existing = self.find_open_pr(slug, branch)
        if existing is not None:
            return existing
        with self._client() as c:
            r = c.post(f"/repos/{self._owner}/{repo_name(slug)}/pulls",
                       json={"title": title, "head": branch, "base": "main", "body": body})
            if r.status_code == 422:      # PR already exists (race) — resolve it
                again = self.find_open_pr(slug, branch)
                if again is not None:
                    return again
            if r.status_code != 201:
                raise GitHubError(f"open PR failed: {r.status_code} {r.text[:200]}")
            return r.json()["number"]

    def merge_pr(self, slug: str, pr_number: int, sha: str) -> str:
        with self._client() as c:
            r = c.put(f"/repos/{self._owner}/{repo_name(slug)}/pulls/{pr_number}/merge",
                      json={"sha": sha, "merge_method": "merge"})
            if r.status_code == 409:       # head moved past the graded SHA (spec §6)
                raise MergeShaMismatch(f"merge refused — head != graded SHA {sha[:12]}")
            if r.status_code != 200:
                raise GitHubError(f"merge failed: {r.status_code} {r.text[:200]}")
            return r.json()["sha"]
```

### Step 3 (GREEN) — `api/tests/fake_github.py`

In-memory repos/PRs mirroring the four methods, a `set_head(slug, branch, sha)` test helper, and `MergeShaMismatch` raised when `sha != head`. Deterministic PR numbers (incrementing). Records `calls` for assertion.

```bash
cd api && uv run pytest -q tests/test_github.py   # EXPECT: green
```

**Verify at build time (Task B5, opt-in):** the exact REST shapes — `POST /user/repos` accepting `private:true` on a **fine-grained** PAT, the `head` filter format `owner:branch`, and the `409` on SHA mismatch (vs `405 not mergeable`). Fallback recorded: if the fine-grained PAT cannot `POST /user/repos` (see PAT permissions below), the coordinator creates each repo by hand once and `ensure_repo` degrades to lookup-only.

---

## Task B2 — settings + workspace GitHub git-plumbing (unit)

**Goal:** `github_enabled()` gate; and the git commands that move data between the local mirror and GitHub — **all pure git via the existing `_git` seam**, testable against a temp repo with no network.

**Files:** `api/app/settings.py` (edit), `api/app/workspace.py` (edit), `api/tests/test_workspace.py` (edit).

### Step 1 — `settings.py` additions (append to the git-workspace section)

```python
# ---------- GitHub as the real remote (Plan B4, spec §5/§6) ----------
# Local profile: a personal github.com account + a fine-grained PAT. Empty token
# = no GitHub: agents push to the git-daemon and the merge is local (B2/B3),
# byte-for-byte. The office/Phase-2 GitHub App swaps in behind github.py's seam.
GITHUB_TOKEN = os.environ.get("FACTORY_GITHUB_TOKEN", "").strip()
GITHUB_OWNER = os.environ.get("FACTORY_GITHUB_OWNER", "").strip()
GITHUB_API = os.environ.get("FACTORY_GITHUB_API", "https://api.github.com").rstrip("/")


def github_enabled() -> bool:
    """GitHub mode needs a git backbone (the local mirror the orchestrator fetches
    into) AND a token AND an owner. Any unset -> git-daemon remote + local merge."""
    return bool(GIT_REMOTE_BASE and GITHUB_TOKEN and GITHUB_OWNER)
```

### Step 2 — `workspace.py` GitHub plumbing

The orchestrator's local repo is the mirror. New functions (token injected per-command, **never stored in `git config`** so it can't leak into the working tree or a pushed ref):

```python
def github_https_url(slug: str) -> str:
    """The public https URL of the produced-app repo (no credential)."""
    return f"https://github.com/{settings.GITHUB_OWNER}/sf-app-{slug}.git"


def _authed_url(slug: str) -> str:
    # x-access-token is GitHub's convention for a bearer/PAT over https.
    return (f"https://x-access-token:{settings.GITHUB_TOKEN}"
            f"@github.com/{settings.GITHUB_OWNER}/sf-app-{slug}.git")


def push_branch_to_github(ws: Path, slug: str, ref: str, *, force: bool = False) -> str | None:
    """Push the local work branch to GitHub. force (rewind to last-graded SHA on a
    retry) uses --force-with-lease so a concurrent push is never clobbered. Returns
    an error string or None. The authed URL is passed per-command, never persisted."""
    br = work_branch(ref)
    args = ["push"] + (["--force-with-lease"] if force else []) + [_authed_url(slug), f"{br}:{br}"]
    out = _git(ws, *args)
    return None if out.returncode == 0 else (out.stderr or out.stdout).strip()[:200]


def fetch_ref_from_github(ws: Path, slug: str, ref: str, sha: str | None = None) -> str | None:
    """Fetch the work branch (agent pushed to GitHub) into the LOCAL mirror so
    git-daemon serves the pinned SHA to gate/build pods and surface_hash_at can
    resolve it. Fast-forwards the local work branch; a rewind updates it hard.
    Returns an error string or None."""
    br = work_branch(ref)
    if _git(ws, "fetch", _authed_url(slug), f"{br}").returncode != 0:
        return f"fetch {br} from github failed"
    # move the local work branch to FETCH_HEAD without checking it out (main stays out)
    if _git(ws, "branch", "-f", br, "FETCH_HEAD").returncode != 0:
        return f"could not update local {br} to fetched head"
    if sha and head_sha(ws, br) != sha:
        return f"fetched head is not the reported SHA {sha[:12]}"
    return None


def fetch_main_from_github(ws: Path, slug: str) -> str | None:
    """After a GitHub-API merge: pull merged main into the local mirror so the
    build clone (git://api:9418/<ref>) sees the merge commit — B3's build path
    is byte-for-byte unchanged."""
    if _git(ws, "fetch", _authed_url(slug), "main").returncode != 0:
        return "fetch main from github failed"
    _git(ws, "checkout", "-q", "main")
    if _git(ws, "reset", "-q", "--hard", "FETCH_HEAD").returncode != 0:
        return "could not fast-forward local main to merged head"
    return None
```

### Step 3 (RED→GREEN) — `test_workspace.py`

Test these against **two local temp repos** (one plays "GitHub" as a bare repo, the other the mirror) with `_authed_url` monkeypatched to return the bare repo path — proving the branch-move/fast-forward/force-with-lease logic **with no network and no token**:

```python
def test_push_then_fetch_roundtrips_the_work_branch(tmp_path, monkeypatch):
    remote = _bare_repo(tmp_path / "gh"); ws = _mirror_repo(tmp_path / "ws")
    monkeypatch.setattr(workspace, "_authed_url", lambda slug: str(remote))
    # agent-equivalent: advance work branch, push to "github"
    ... assert workspace.push_branch_to_github(ws, "nw", "REQ-1") is None
    # orchestrator fetches it back into a fresh mirror; git-daemon would now serve it
    ... assert workspace.fetch_ref_from_github(ws2, "nw", "REQ-1", sha) is None
    assert workspace.surface_hash_at(ws2, sha) is not None   # resolves locally

def test_fetch_main_fast_forwards_the_mirror(tmp_path, monkeypatch):
    ...  # a merge commit on the bare "github" main appears on the local mirror's main
```

```bash
cd api && uv run pytest -q tests/test_workspace.py tests/test_deploy_settings.py
# EXPECT: green; github_enabled() False by default (no token)
```

---

## Task B3 — runner/workspace integration (unit)

**Goal:** wire GitHub mode into the runner at four points, each behind `settings.github_enabled()` so the unset path is untouched: (1) create the repo + push baseline at first stage; (2) push→fetch the work branch around each stage so the gate clones the pinned SHA from the mirror; (3) open the PR at the first stage push; (4) merge via the GitHub API with the SHA precondition, then fast-forward the mirror for B3's build.

**Files:** `api/app/kube_runner.py` (edit), `api/tests/test_deploy_runner.py` + `api/tests/test_kube_runner.py` (edit).

### Interfaces / behavior

The runner holds a lazily-constructed GitHub client mirroring the `client` property:

```python
@property
def github(self):
    if self._github is None:
        from .github import GitHub
        self._github = GitHub()
    return self._github
```

Tests inject `FakeGitHub` via `KubeJobRunner(github=FakeGitHub(owner="acme"))`.

1. **`_prepare_workspace` (first stage)** — after `workspace.ensure_repo(...)`, in GitHub mode:
   - `intents.begin(db, f"repo:{ref}", intents.CREATE_REPO, req.id, {"slug": slug})`; on a fresh begin, `github.ensure_repo(slug)` → push baseline + work branch (`workspace.push_branch_to_github(ws, slug, ref)` for both `main` and the work branch on first creation); `intents.complete(...)`. Idempotent: a replay's `begin` returns `None` → skip.
   - The retry rewind (`workspace.reset_branch` to last-graded) is followed, in GitHub mode, by `push_branch_to_github(ws, slug, ref, force=True)` so the agent (which clones **GitHub**) starts the fresh attempt at the graded SHA.

2. **Stage-pod `SF_REPO_URL`** — in GitHub mode, `stage_job_manifest` env sets `SF_REPO_URL = workspace.github_https_url(slug)` and the entrypoint injects the token (Task B4). Gate/build manifests keep `git://api:9418/<ref>` (unchanged). This is a small branch in `kube_jobs._base_job` keyed on `settings.github_enabled()` **for `role == "stage"` only**.

3. **Fetch-before-grade** — in `_observe`'s stage-success path (before `_spawn_gate` runs next tick), or at the top of `_spawn_gate` when GitHub mode: `workspace.fetch_ref_from_github(ws, slug, ref, sha=pinned_sha)`. This lands the agent's pushed SHA in the local mirror so (a) git-daemon serves it to the gate pod, and (b) `_surface_check`/`surface_hash_at` resolve it. A fetch error → `_escalate("could not fetch <sha> from GitHub before grading")`.

4. **Open the PR** — after the **architecture** stage's first successful push (once per request): `intents.begin(db, f"pr:{ref}", intents.OPEN_PR, ...)`; `github.open_pr(slug, work_branch(ref), req.ref, spec-derived body)` → store the number in the intent outcome. Idempotent by intent key + `open_pr`'s own head-branch idempotency.

5. **Merge** — `approve_merge` branches: when `github_enabled()`, replace `workspace.merge_graded(...)` with:
   ```python
   pr = self._resolve_pr(db, req, slug, ref)     # from the OPEN_PR intent outcome, else github.find_open_pr
   try:
       merge_sha = self.github.merge_pr(slug, pr, sha)   # SHA precondition, API-side
   except github.MergeShaMismatch as e:
       self._escalate(db, req, f"Merge refused: {e}"); return
   err = workspace.fetch_main_from_github(ws, slug)      # mirror now has merged main
   if err:
       self._escalate(db, req, f"Merged on GitHub but mirror update failed: {err}"); return
   intents.complete(db, f"merge:{ref}", {"merge_sha": merge_sha})
   ```
   Then the **existing** `if settings.app_deploy_enabled(): raise_deploy_gate` tail runs unchanged — so GitHub mode and the deploy gate compose. Build clones `git://api:9418/<ref>` at merged main (B3 untouched).

### Step 1 (RED) — `test_deploy_runner.py` / `test_kube_runner.py` additions

```python
def test_github_mode_creates_repo_and_opens_pr(client, monkeypatch, tmp_path):
    _enable_github(monkeypatch)   # sets GIT_REMOTE_BASE + GITHUB_TOKEN + GITHUB_OWNER
    fgh = FakeGitHub(owner="acme")
    runner = KubeJobRunner(client=FakeKubeClient(), github=fgh)
    ... # drive architecture stage to success against a temp mirror + bare "github"
    assert "sf-app-northwind" in fgh.repos
    assert fgh.find_open_pr("northwind", "work/req-1") is not None

def test_github_merge_uses_sha_precondition_then_mirror_has_main(client, monkeypatch):
    _enable_github(monkeypatch); _enable_deploy(monkeypatch)
    ... runner.approve_merge(db, req, "Ada")
    # merged on "github" AND the local mirror's main now carries the merge commit
    assert fgh.prs[pr]["merged"] is True
    assert workspace.head_sha(ws, "main") == fgh.merge_sha
    # composes with B4 Half A: now waiting at the deploy gate
    assert req.gate == transitions.GATE_APPROVE_DEPLOY

def test_stale_head_merge_escalates_never_merges(client, monkeypatch):
    _enable_github(monkeypatch)
    fgh.set_head("northwind", "work/req-1", "c"*40)  # head moved past graded sha
    runner.approve_merge(db, req, "Ada")
    assert req.needs_human and fgh.prs[pr]["merged"] is False

def test_token_unset_is_byte_for_byte_b3(client, monkeypatch):
    # GITHUB_TOKEN unset: no repo/PR calls, merge is local merge_graded (B3)
    _enable_deploy(monkeypatch)  # but NOT github
    ...
    assert fgh.calls == [] and workspace_merge_was_local
```

```bash
cd api && uv run pytest -q tests/test_deploy_runner.py tests/test_kube_runner.py tests/test_workspace.py
# EXPECT: green — the token-unset test locks byte-for-byte B3
```

**Design note:** the PR number lives in the `OPEN_PR` intent outcome (append-only, MSSQL-safe) — no new column. `_resolve_pr` reads it, falling back to `github.find_open_pr` (self-healing if the intent row predates the merge). Repo/PR/merge are all intent-guarded so a re-driven tick never double-creates.

---

## Task B4 — deploy wiring: GitHub-token Secret + entrypoint (cluster)

**Goal:** stage pods get the PAT the same way they get codex auth — a mounted Secret, optional so unset-token clusters still schedule; the entrypoint injects it into the GitHub clone/push URL. Gate/build pods get nothing.

**Files:** `api/app/kube_jobs.py` (edit), `docker/sf-agent/entrypoint.sh` (edit), `deploy/base/configmap.yaml` (edit), `Taskfile.yml` (edit), `api/tests/test_kube_jobs.py` (edit).

### Step 1 — `kube_jobs._base_job`: mount the token into stage pods only

Alongside the existing `codex-auth` block (`kube_jobs.py:75-93`), when `role == "stage"` add an **optional** Secret env (not a file — a single value is cleaner as `secretKeyRef`):

```python
    if role == "stage" and settings.github_enabled():
        # the produced-app repo lives on GitHub; the entrypoint composes the authed
        # URL from this token. Optional so a token-less cluster still schedules.
        container_env["SF_GITHUB_TOKEN"] = None  # rendered as a secretKeyRef below
```

Render it as `valueFrom: {secretKeyRef: {name: settings.GITHUB_TOKEN_SECRET, key: token, optional: true}}` in the container `env` list (a small branch in the env-materialization loop, since existing envs are plain `value`). `SF_REPO_URL` for stage pods is already GitHub's https URL (Task B3, item 2). Gate/build manifests are unchanged — they never see the token and clone git-daemon.

`settings.py`: `GITHUB_TOKEN_SECRET = os.environ.get("FACTORY_GITHUB_TOKEN_SECRET", "sf-github-token")`.

### Step 2 — `entrypoint.sh`: inject the token into the GitHub URL

At the top of the clone block, if `SF_GITHUB_TOKEN` is set and `SF_REPO_URL` is an https GitHub URL, rewrite it to the authed form (kept out of logs):

```bash
if [ -n "${SF_GITHUB_TOKEN:-}" ] && printf '%s' "$SF_REPO_URL" | grep -q '^https://github.com/'; then
  # inject the PAT; never echo the composed URL
  AUTHED_URL="https://x-access-token:${SF_GITHUB_TOKEN}@${SF_REPO_URL#https://}"
  git clone -q --branch "$SF_BRANCH" "$AUTHED_URL" "$REPO" || die_stage "clone failed"
  git -C "$REPO" remote set-url origin "$AUTHED_URL"   # push target (token stays in-pod)
else
  git clone -q --branch "$SF_BRANCH" "$SF_REPO_URL" "$REPO" || die_stage "clone failed: $SF_REPO_URL"
fi
```

The push tail (`git push -q origin "HEAD:$SF_BRANCH"`) is unchanged — `origin` now points at the authed GitHub URL in GitHub mode, git-daemon otherwise. The `note "cloning $SF_REPO_URL"` line already prints the **token-free** URL — leave it; never print `$AUTHED_URL`.

### Step 3 — Taskfile + ConfigMap

```yaml
  sync-github-token:
    desc: Sync a fine-grained PAT into the sf-github-token Secret (single-developer, spec §5)
    cmds:
      - kubectl -n software-factory create secret generic sf-github-token
          --from-literal=token="$FACTORY_GITHUB_TOKEN" --dry-run=client -o yaml | kubectl apply -f -
```

`deploy/base/configmap.yaml`: add `FACTORY_GITHUB_OWNER: "<your-gh-username>"` (the **token** is never in the ConfigMap — Secret only). Leave `FACTORY_GITHUB_TOKEN` **unset in base** so the base profile stays git-daemon-only; GitHub mode is opt-in by creating the Secret + setting owner + a small overlay patch, mirroring how codex auth is a task, not a checked-in value.

### Step 4 — test

```python
def test_stage_pod_gets_github_token_secret_ref_when_enabled(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "x"); monkeypatch.setattr(settings, "GITHUB_OWNER", "acme")
    m = stage_job_manifest("REQ-1", "architecture", 1)
    env = m["spec"]["template"]["spec"]["containers"][0]["env"]
    tok = next(e for e in env if e["name"] == "SF_GITHUB_TOKEN")
    assert tok["valueFrom"]["secretKeyRef"]["optional"] is True
    assert any(e["name"] == "SF_REPO_URL" and e["value"].startswith("https://github.com/") for e in env)

def test_gate_pod_never_gets_the_token(monkeypatch):
    ... m = gate_job_manifest(...); assert no SF_GITHUB_TOKEN in env
```

```bash
cd api && uv run pytest -q tests/test_kube_jobs.py   # EXPECT: green
```

**Fine-grained PAT permissions (verify at build time in B5):** repository access = the `sf-app-*` repos (or "All repositories" so `ensure_repo` can create new ones), with **Repository permissions**: **Contents: Read and write** (clone/push/merge commit), **Pull requests: Read and write** (open/merge PR), **Administration: Read and write** (create the repo — *verify: fine-grained PATs create personal repos via `POST /user/repos`; if the account/policy disallows it, fall back to pre-creating repos and running `ensure_repo` lookup-only*), **Metadata: Read-only** (mandatory, auto-selected). No org/webhook/workflow scopes. The coordinator generates this PAT interactively before B5.

---

## Task B5 — `github-smoke.sh`: one request to a real deployed pod (cluster+LLM+GitHub)

**Files:** `scripts/github-smoke.sh` (new), `Taskfile.yml` (add `github-smoke`).

A separate opt-in script (not folded into `kind-smoke`, so the default smoke stays GitHub-free), gated on `FACTORY_GITHUB_TOKEN`. It drives one request through **both** new seams end-to-end and **clearly marks every step that creates real GitHub state** so the coordinator can pause:

```bash
#!/usr/bin/env bash
# Opt-in end-to-end over REAL GitHub (Plan B4). Requires FACTORY_GITHUB_TOKEN +
# FACTORY_GITHUB_OWNER and a running kind cluster with the sf-github-token Secret.
# CREATES REAL GITHUB RESOURCES (a private sf-app-<slug> repo + a PR). The
# coordinator confirms before the first repo is created. Cleanup at the end.
set -euo pipefail
: "${FACTORY_GITHUB_TOKEN:?}" "${FACTORY_GITHUB_OWNER:?}"
SLUG=northwind ; REPO="sf-app-$SLUG"

echo "‼ THIS WILL CREATE github.com/$FACTORY_GITHUB_OWNER/$REPO (private) + a PR"
[ "${GITHUB_SMOKE_CONFIRMED:-}" = "1" ] || { echo "set GITHUB_SMOKE_CONFIRMED=1 to proceed"; exit 2; }

task sync-github-token
# … drive intake → spec approve → architecture → the PR appears on GitHub …
gh repo view "$FACTORY_GITHUB_OWNER/$REPO" >/dev/null || fail "repo not created on GitHub"   # [REAL]
PR=$(gh pr list -R "$FACTORY_GITHUB_OWNER/$REPO" --json number -q '.[0].number')             # [REAL]
[ -n "$PR" ] || fail "PR not opened on GitHub"
# … approve the MERGE gate → PR merged ON GITHUB via the API SHA precondition …
gh pr view "$PR" -R "$FACTORY_GITHUB_OWNER/$REPO" --json state -q .state | grep -qx MERGED \
  || fail "PR not merged on GitHub"                                                          # [REAL]
# … approve the DEPLOY gate (Half A) → built from merged main → live pod through the ingress …
curl -sf "http://$SLUG.localtest.me:8081/health" | jqpy 'assert d["status"]=="ok"' \
  || fail "produced app /health did not answer"
ok "one request → real GitHub repo → PR → merged on GitHub → deployed pod"

# ---- cleanup (deletes the test repo; needs delete_repo scope or manual) ----
if [ "${GITHUB_SMOKE_CLEANUP:-1}" = "1" ]; then
  gh repo delete "$FACTORY_GITHUB_OWNER/$REPO" --yes || \
    echo "⚠ could not auto-delete $REPO — delete it by hand (fine-grained PATs may lack repo-delete)"
fi
```

Steps marked `[REAL]` are the ones the coordinator pauses on. `gh repo delete` needs the `delete_repo` classic scope or the fine-grained "Administration: write" + org allowance — if the PAT can't delete, the script prints the manual step rather than failing the run.

```bash
GITHUB_SMOKE_CONFIRMED=1 task github-smoke
# EXPECT (15-30 min, spends codex + creates a real private repo): every ✓, repo cleaned up
```

---

## Task B6 — docs + full verify + commit (docs)

**Files:** `AGENTS.md` (edit §6/§7), `implementation-notes.md` (append `## Plan B4`), plan self-review.

- `AGENTS.md`: the factory now has **two** human gates (approve-merge **and** approve-deploy) and a real **GitHub** remote behind the `SF_REPO_URL`/push-credential seam — agents push to `sf-app-<slug>` on GitHub; the orchestrator fetches into the local mirror that git-daemon serves; gate/build pods stay walled to `git://api:9418`. `FACTORY_GITHUB_TOKEN`/`FACTORY_APP_DEPLOY` are independent opt-in gates; `task verify` stays cluster- and GitHub-free (`github-smoke`/`kind-smoke` are opt-in).
- `implementation-notes.md`: record the actual fine-grained PAT permission set that worked (esp. whether `POST /user/repos` succeeded), the merge `409` shape, smoke duration + codex cost, and any repo-delete manual step.

```bash
cd api && uv run pytest -q                 # every new unit suite runs; no cluster, no GitHub
task verify                                 # EXPECT: green (github-smoke/kind-smoke NOT in the chain)
```

Commit (branch first — on `main`; do the console edits from the clean worktree of Task A4):

```bash
git commit -m "feat(gates,github): approve-deploy human gate + GitHub as the real remote — merged PR via API SHA-precondition, private sf-app-<slug> repos, second console gate; git-daemon stays the walled mirror for gate/build pods (Plan B4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Design decisions made while planning (resolutions of spec/code gaps)

1. **The deploy gate is `raise_deploy_gate` (machine) + `claim_deploy` (human) + `begin_deploy` (release), a row-for-row mirror of the merge gate.** `approve_merge` swaps its `begin_deploy` call for `raise_deploy_gate`; the request then *waits* at `stage=deploy, gate=approve_deploy`. The only new behavioral guard is `_drive_deploys` gaining `Request.gate.is_(None)` — that single clause is what makes the gate hold. Every B3 deploy-driver test still passes because those tests reach `stage=deploy` via `begin_deploy` (gate already `None`).

2. **`begin_deploy` is retained and moved to the approve path.** Rather than delete it, B4 keeps `begin_deploy` as the release step the endpoint applies after `claim_deploy`, so its milestone event now carries the **approver's name** (spec §4.10) and the effects (`gate=None`) are the idempotent release. This is the smallest diff and keeps the transition table's shape stable.

3. **`stage=="deploy"` is the routing discriminator in the approve endpoint.** A request only reaches `stage=="deploy"` after a merge, so B3's `r.stage in ("review","deploy","done") → claim_merge` guard is split: `deploy` peels off to `claim_deploy`, leaving `review`/`done` on the merge family. This never collides with spec (`stage in spec/architecture`) or merge (`stage=="review"`) approvals. A deploy-approval replay landing on a `done` request falls through to the merge branch and resolves cleanly via `conflict_response` against the persisted `approved_deploy` audit winner (no double-fire, no approve UI on `done`).

4. **GitHub mode is a mirror, not a cutover: agents push to GitHub, the orchestrator fetches into the local git-daemon repo, gate/build pods clone the mirror unchanged.** Justified by the walls: `api-walls` egress is all-allow (orchestrator reaches github.com) and `agent-stage-walls` grants internet (stage pods reach github.com), but `gate-walls`/`build-walls` reach only `git://api:9418`. Opening github IPs to gate/build pods would widen the wall for no benefit; instead the orchestrator (which already owns the repo locally, B2) fetches each pushed SHA and merged main into the mirror, and git-daemon serves them. **B3's build path (`git://api:9418/<ref>` at merged main) is byte-for-byte untouched.**

5. **Personal github.com + a fine-grained PAT is the local profile; the GitHub App is the Phase-2 swap behind `github.py`'s four-method seam.** The office edition (installation tokens per Job) changes only how the token is minted — `ensure_repo`/`open_pr`/`merge_pr` and the `SF_GITHUB_TOKEN` Secret mount are identical. The PAT is mounted into **stage pods only** (mirroring codex auth), optional so token-less clusters still schedule, and never enters the ConfigMap, logs, or `git config`.

6. **The GitHub-API merge keeps the graded-SHA precondition** (spec §6): `merge_pr(slug, pr, sha)` passes GitHub's server-side `sha` head-check; a moved branch `409`s → `MergeShaMismatch` → escalate, never merge. This is the exact rule `workspace.merge_graded` enforced locally in B2/B3, moved to the API. After the merge, the orchestrator fast-forwards the mirror's `main` so the build sees the merge commit.

7. **Repo/PR/merge are all intent-guarded** (`CREATE_REPO`/`OPEN_PR`/`MERGE_PR`, keys `repo:<ref>`/`pr:<ref>`/`merge:<ref>`), and `ensure_repo`/`open_pr` are additionally idempotent server-side (lookup-before-create, head-branch PR dedupe). A re-driven tick or a replayed approve never double-creates a repo or PR. The PR number lives in the `OPEN_PR` intent **outcome** (append-only, MSSQL-safe) with a `find_open_pr` fallback — no new column.

8. **Two independent env gates.** `app_deploy_enabled()` (B3) governs the deploy gate + build; `github_enabled()` (B4) governs the remote + merge. Either ships alone: deploy-gate-only (git-daemon remote + human deploy gate), or GitHub-only with `FACTORY_APP_DEPLOY=0` (real repos/PRs/merge, ending at `done`). Both unset ⇒ B2. `task verify`/CI set neither.

9. **The retry rewind force-pushes to GitHub.** `_prepare_workspace` resets the local work branch to the last-graded SHA (spec §5); in GitHub mode the agent clones **GitHub**, so the reset is force-pushed (`--force-with-lease`) to GitHub's work branch so the fresh attempt starts clean. This is a rewind of a per-request `work/<ref>` branch (never `main`), recorded as a local-profile trade-off; branch protection on `main` (spec §5 "force-push denied on sf/*") is a Phase-2 GitHub-settings item, deferred.

10. **Console stays minimal and additive, implemented in a clean worktree.** The gate union widens by one value and each render site gains one branch — no refactor — because a second session holds uncommitted `apps/intake/**` edits in the main checkout. The deploy gate's evidence is deliberately **pre-build** (merge evidence + slug/replicas/target URL), since nothing is built when the human decides.

---

## Self-review (writing-plans checklist)

- **Spec coverage (§4.8–4.10, §5, §6):** two console gates with recorded approver identity → A1/A3/A4 (`deploy_claimed`+`approved_deploy` carry `operator_id`; the milestone names the approver); private `sf-app-<slug>` repos via the intent log → B1/B3; PR opened after architecture, stage results as commits → B3; merge only via the GitHub API SHA precondition, writer≠grader≠merger → B1/B3/B6; frozen-surface check still orchestrator-side on the mirror (fetch-before-grade lands the pushed SHA locally) → B2/B3; push credential behind a seam, gate pods hold none → B4; build+deploy unchanged after the second gate → A2 composes with B3. Deferred with reasons: GitHub App, repo flip-to-public, gitleaks/revocation, branch protection, openshift/aks (Scope-out + decisions 5, 9).
- **Autonomous/interactive split:** A1–A3, B1–B3 are unit-only (fakes: `FakeKubeClient`, `FakeGitHub`, temp git repos) — no cluster, no GitHub, no user. A4 is a clean-worktree console edit. A5, B4, B5, B6 need kind + a PAT + a codex run; the coordinator pauses before the first real repo (`GITHUB_SMOKE_CONFIRMED`, the `[REAL]`-marked steps).
- **Byte-for-byte guards:** `test_token_unset_is_byte_for_byte_b3` (B3) and the `app_deploy_enabled()` false path (A2) lock the two unset-env behaviors; `github_enabled()`/`app_deploy_enabled()` both require all their inputs; the gate/build manifests are asserted token-free (B4).
- **Placeholder scan:** every unit task carries full RED tests + GREEN source (`github.py` in full; the transition rows, endpoint routing, workspace plumbing, and manifest branches in full). Verify-at-build-time items are bounded and loud: the fine-grained PAT's `POST /user/repos` capability (fallback: pre-create + lookup-only), the merge `409` shape, and `gh repo delete` scope (fallback: manual) — each a named check in B5, not a TBD.
- **Type/interface consistency:** `ensure_repo(slug)->str`, `open_pr(slug,branch,title,body)->int`, `find_open_pr(slug,branch)->int|None`, `merge_pr(slug,pr,sha)->str` are identical across `GitHub`, `FakeGitHub` (B1), and the runner callers (B3); `github_https_url`/`push_branch_to_github`/`fetch_ref_from_github`/`fetch_main_from_github` defined in B2 and consumed in B3; `GATE_APPROVE_DEPLOY`/`raise_deploy_gate`/`claim_deploy`/`begin_deploy` defined in A1, consumed in A2/A3; `Request.gate.is_(None)` guard in A2 matches the `gate=None` set by `begin_deploy`; the gate union value `'approve_deploy'` is identical across `models.ts`, `util.ts`, `gate-modals.ts`, `floor-view.ts`, `notifications.py`, and the smoke assertions; `SF_GITHUB_TOKEN`/`SF_REPO_URL` env names match between the B4 manifest branch and the entrypoint.

---

### Critical Files for Implementation
- /Users/wongjunmun/development/ai-development/software-factory/api/app/transitions.py (`GATE_APPROVE_DEPLOY`, `raise_deploy_gate`/`claim_deploy`, `begin_deploy`+event rework, DECISIVE_ACTIONS)
- /Users/wongjunmun/development/ai-development/software-factory/api/app/kube_runner.py (`approve_merge` raises the deploy gate + GitHub merge; `_drive_deploys` `gate IS NULL` guard; repo/PR/fetch integration)
- /Users/wongjunmun/development/ai-development/software-factory/api/app/routers/gates.py (peel `deploy` into `claim_deploy` + `begin_deploy` with approver audit; replay routing)
- /Users/wongjunmun/development/ai-development/software-factory/api/app/github.py (new — `ensure_repo`/`open_pr`/`merge_pr` + `FakeGitHub`) and /Users/wongjunmun/development/ai-development/software-factory/api/app/workspace.py (GitHub push/fetch mirror plumbing)
- /Users/wongjunmun/development/ai-development/software-factory/packages/shared/src/lib/models.ts + apps/console/src/app/shared/gate-modals.ts (additive `approve_deploy` gate surfacing; implement in a clean worktree) and /Users/wongjunmun/development/ai-development/software-factory/docker/sf-agent/entrypoint.sh + api/app/kube_jobs.py (stage-pod GitHub-token Secret + URL injection)
