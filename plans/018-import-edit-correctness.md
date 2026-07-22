# Plan 018: Close two import-edit races — the shared temp ref, and the crash window that rejects applied edits

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5b9facb..HEAD -- api/app/routers/gates.py api/app/workspace.py api/app/kube_runner.py api/app/models.py api/tests/test_import_edit.py`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — this is the path that fast-forwards a work branch
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5b9facb`, 2026-07-21

## Why this matters

The ng-v0 bridge lets a requester edit their preview in a sandbox and send the
edits back: the factory fetches their git bundle onto a temp ref, re-proves it
under its own gate, and on green fast-forwards the work branch. It is the
newest feature in the repo and the one that carries the most user trust — the
requester is told, in plain language, whether the factory accepted their work.

Two defects make it lie:

1. **Two concurrent posts corrupt each other.** The "one in-flight import per
   request" rule is a plain `SELECT`, and the row is inserted ~60 lines later.
   Both racing posts pass the check, and both compute the *same* temp ref
   (derived from the round number alone), then each unconditionally deletes it
   and fetches into it. The second post unlinks the first bundle's commits, so
   the first row's gate job grades a SHA that no longer exists and fails as
   infra. **The requester is told the factory gate rejected their edit** — for
   work that was never graded.
2. **A crash after the branch moves reports an applied edit as rejected.** The
   transition CAS is deliberately left uncommitted while the irreversible
   `git checkout` + `reset --hard` + `clean -fdq` runs. If the process dies in
   that window, the work branch is permanently at the imported head while the
   DB rolled back. On the next tick the branch looks "moved", and the code
   rejects the import and emails the requester — while their code is in fact
   merged, with no `SpecLine` record, no review re-run, and the request still
   parked at the preview gate. Silent divergence between git and the database,
   on exactly the path that exists to make this trustworthy.

Both are currently unreachable in any deployed environment —
`FACTORY_IMPORT_EDIT` appears in no manifest (`grep -rn FACTORY_IMPORT_EDIT
deploy scripts docker` is empty). **That is precisely why this is worth doing
now:** fix them before the flag is flipped, not after a user hits them.

## Current state

### 1. `api/app/routers/gates.py:320-388` — check-then-act, and a shared ref

The guard:

```python
    # One in-flight import per request: a second post while one is pending/grading
    # is a client double-fire, not a new edit.
    if db.scalar(
        select(ImportEdit.id).where(
            ImportEdit.request_id == r.id,
            ImportEdit.status.in_(("pending", "grading")),
        )
    ) is not None:
        raise HTTPException(409, "An imported edit is already being graded")
```

Then, ~25 lines later, the destructive git work on a ref shared by any
concurrent caller:

```python
    round_number = r.preview_round
    temp_ref = workspace.import_ref(round_number)
    with tempfile.TemporaryDirectory() as tmp:
        bundle_path = Path(tmp) / "import.bundle"
        bundle_path.write_bytes(bundle_bytes)
        if not workspace.verify_bundle(ws, bundle_path):
            raise HTTPException(409, …)
        workspace.delete_ref(ws, temp_ref)  # clear a stale ref from a prior reject
        fetch_error = workspace.fetch_bundle(ws, bundle_path, temp_ref)
```

And only then, at `:377-388`, the row is created:

```python
    record = ImportEdit(
        request_id=r.id,
        round=round_number,
        base_sha=work_head,
        head_sha=imported_head,
        temp_ref=temp_ref,
        …
        status="pending",
    )
    db.add(record)
```

`api/app/workspace.py:472-474` — the ref depends on nothing unique:

```python
def import_ref(round_number: int) -> str:
    """The temp ref an imported bundle lands on — never the work branch."""
    return f"refs/import/round-{int(round_number)}"
```

`api/app/models.py:362-394` — `ImportEdit` has an index on `request_id`, but it
is **not** unique, and the class has no `__table_args__`:

```python
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"), index=True)
    # the preview_round the edit was seeded from (names the temp ref)
    round: Mapped[int] = mapped_column(Integer, default=0)
    …
    temp_ref: Mapped[str] = mapped_column(String(80))  # refs/import/round-<n>
    …
    # pending -> grading -> applied | rejected | superseded
    status: Mapped[str] = mapped_column(String(12), default="pending")
```

### 2. `api/app/kube_runner.py:1780-1809` — the crash window

```python
        if isinstance(res, transitions.Loss):
            db.rollback()
            …
            return
        # CAS won (staged). Move the branch as the external side effect; roll the
        # whole transaction back if it is no longer a clean fast-forward.
        ff_error = workspace.fast_forward_work_branch(
            ws, req.ref, imp.head_sha, imp.base_sha
        )
        if ff_error:
            db.rollback()
            reloaded = db.get(ImportEdit, imp.id)
            reloaded_req = db.get(Request, imp.request_id)
            if reloaded is not None and reloaded_req is not None:
                self._reject_import(db, reloaded_req, reloaded, ff_error, tail, moved)
            return
        imp.status = "applied"
        imp.gate_tail = tail
        workspace.delete_ref(ws, imp.temp_ref)
        db.commit()
        res.notify()
```

`api/app/workspace.py:524-546` — the error string the retry hits:

```python
def fast_forward_work_branch(
    ws: Path, ref: str, to_sha: str, base_sha: str
) -> str | None:
    """Move the work branch forward to the imported head — only when it is a
    real fast-forward from ``base_sha`` (still the current head). …"""
    br = work_branch(ref)
    current = head_sha(ws, br)
    if current != base_sha:
        return (
            f"work branch head {(current or 'missing')[:12]} moved from the "
            f"seed sha {base_sha[:12]} — re-seed"
        )
```

After a crash-window death, `current == imp.head_sha` — the move already
succeeded. The code cannot tell that apart from a genuine third-party move, so
it rejects.

### 3. The terminal-status sites (needed for Step 1)

`imp.status` becomes terminal in exactly four places, all in
`api/app/kube_runner.py`:

- `:1784` — `reloaded.status = "superseded"` (the transition-Loss path)
- `:1801` — `imp.status = "applied"` (`_land_import` success)
- `:1825` — `imp.status = "rejected"` (`_reject_import`)
- `:1850` — `imp.status = "superseded"` (`_abandon_import`)

### Conventions to match

- **Insert-and-catch is the house pattern for atomic claims** —
  `api/app/intents.py:41-49`:

```python
    row = Intent(key=key, kind=kind, request_id=request_id, payload_json=json.dumps(payload))
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        return None
    return row
```

- **Partial unique indexes must be dialect-portable** —
  `api/app/models.py:270-279` is the proven precedent, and its comment says why:

```python
    __table_args__ = (
        # SQL Server otherwise allows only one NULL in a regular UNIQUE index.
        Index(
            "uq_brain_calls_dedup_key",
            "dedup_key",
            unique=True,
            sqlite_where=text("dedup_key IS NOT NULL"),
            mssql_where=text("dedup_key IS NOT NULL"),
        ),
    )
```

  This shape — a nullable key column with an `IS NOT NULL` filter — is what
  this plan copies. Do **not** write a filtered index whose predicate is
  `status IN ('pending','grading')`: SQL Server's filtered-index predicate
  grammar is restrictive, and this repo already has a proven alternative.
- **Tests**: `api/tests/test_import_edit.py` (363 lines) builds tiny **real**
  git repos in `tmp_path` and grades with `FakeKubeClient` — fully offline, no
  pods. See `test_green_import_lands_and_resumes_at_review` and
  `test_red_import_is_rejected_branch_untouched_and_requester_notified`.
- Backend commands are `uv run …` — never `pip`, never `python -m pytest`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Backend tests | `cd api && uv run pytest -q` | `N passed` |
| This feature | `cd api && uv run pytest -q tests/test_import_edit.py` | all pass |
| Lint | `cd api && uv run ruff check .` | no errors |
| Alembic head | `cd api && uv run alembic heads` | exactly ONE head |
| Migration up | `cd api && uv run alembic upgrade head` | exit 0 |
| Full gate | `task verify` | `✓ VERIFY PASSED` |

**Do not point the test suite at a database you care about** — it truncates.
Leave `FACTORY_DB_URL` unset so it uses a local throwaway SQLite.

## Scope

**In scope** (the only files you should modify):
- `api/app/models.py` (add a column + `__table_args__` to `ImportEdit`)
- `api/alembic/versions/<new>.py` (create)
- `api/app/workspace.py` (`import_ref` signature)
- `api/app/routers/gates.py` (the import-edit handler)
- `api/app/kube_runner.py` (terminal-status sites + the crash-window recovery)
- `api/tests/test_import_edit.py` (update one assertion, add tests)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):
- **Enabling the feature.** Do not add `FACTORY_IMPORT_EDIT` or
  `FACTORY_PREVIEW` to any manifest, configmap, or smoke script. Flipping the
  flag is a separate operator decision that should follow, not accompany, this
  fix.
- The bundle-validation logic itself (`verify_bundle`, `commit_chain`, the
  1:1 version-chain check). It is correct and is the security boundary — leave
  it exactly as it is.
- `transitions.py` and the CAS/epoch machinery.
- The gate job name (`sf-<ref>-import-r<round>-gate`, `kube_runner.py:1690`).
  With one active import per request enforced, a round-derived job name can no
  longer collide.
- The orchestrator side (`app-preview/`) — it produces the bundle; this plan is
  entirely about the consumer.
- **The working tree has uncommitted changes from other work** (files under
  `apps/intake/`, `mockups/`, `plans/009`–`011`). Do not stage or commit them.

## Git workflow

- Branch: `advisor/018-import-edit-races`
- Conventional commits, e.g.
  `fix(import-edit): one active import per request, unique temp refs, crash-window recovery`
- Two commits (one per defect) is preferable — they are independent.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make "one active import per request" a database invariant

Add a nullable claim column plus a filtered unique index, copying the
`uq_brain_calls_dedup_key` pattern.

In `api/app/models.py`, inside `class ImportEdit`, add after `status`:

```python
    # The atomic "one active import per request" claim. Holds request_id while
    # this row is pending/grading, NULL once terminal — a filtered unique index
    # on it makes a second concurrent post fail at the DB instead of racing the
    # SELECT guard and clobbering the first bundle's temp ref (plans/018).
    # Nullable + IS NOT NULL filter, not `status IN (…)`: SQL Server's filtered
    # index predicate grammar is restrictive, and this shape is already proven
    # here (uq_brain_calls_dedup_key).
    active_request_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
```

and add to the class:

```python
    __table_args__ = (
        Index(
            "uq_import_edits_active",
            "active_request_id",
            unique=True,
            sqlite_where=text("active_request_id IS NOT NULL"),
            mssql_where=text("active_request_id IS NOT NULL"),
        ),
    )
```

Check that `Index` and `text` are already imported in `models.py` (they are —
`uq_brain_calls_dedup_key` uses both).

**Verify**: `cd api && uv run python -c "from app.models import ImportEdit; print([i.name for i in ImportEdit.__table__.indexes])"`
includes `uq_import_edits_active`.

### Step 2: Migration

Confirm the head first: `cd api && uv run alembic heads` — expect exactly one
(`a2f4c6e8b0d2` unless it has moved). More than one is a STOP condition.

Create `api/alembic/versions/<rev>_import_edit_active_claim.py`. Model the
filtered index on the brain_calls migration — find it with
`grep -rn "uq_brain_calls_dedup_key" api/alembic/versions/` and copy its
`op.create_index(...)` call shape exactly, including the `sqlite_where` /
`mssql_where` kwargs.

```python
def upgrade() -> None:
    op.add_column("import_edits", sa.Column("active_request_id", sa.Integer(), nullable=True))
    # Backfill: any row still in flight when this migration runs must keep its
    # claim, or two imports could go active for the same request.
    op.execute(
        "UPDATE import_edits SET active_request_id = request_id "
        "WHERE status IN ('pending', 'grading')"
    )
    op.create_index(
        "uq_import_edits_active",
        "import_edits",
        ["active_request_id"],
        unique=True,
        sqlite_where=sa.text("active_request_id IS NOT NULL"),
        mssql_where=sa.text("active_request_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_import_edits_active", table_name="import_edits")
    op.drop_column("import_edits", "active_request_id")
```

The backfill is safe: the table is brand new (created by `a2f4c6e8b0d2`) and
the feature has never been enabled, so in practice it updates zero rows — but
write it anyway, because correctness must not depend on that.

**Verify**:
- `cd api && uv run alembic heads` → one head, yours.
- `cd api && uv run alembic upgrade head` → exit 0.
- `cd api && uv run pytest -q tests/test_migrations.py` → passes (the existing
  model/Alembic parity guard).

### Step 3: Set and clear the claim

**Set it** in `api/app/routers/gates.py`, in the `ImportEdit(...)` construction:
add `active_request_id=r.id,` next to `request_id=r.id,`.

**Clear it** at all four terminal-status sites in `api/app/kube_runner.py`
(:1784, :1801, :1825, :1850 — find them with
`grep -n 'status = "applied"\|status = "rejected"\|status = "superseded"' api/app/kube_runner.py`).

Rather than four scattered pairs of lines, add one small helper near the other
import-edit methods and use it everywhere:

```python
    @staticmethod
    def _finish_import(imp: ImportEdit, status: str) -> None:
        """Terminal status for an imported edit. Releases the active claim in the
        same breath — the filtered unique index (uq_import_edits_active) is what
        stops a second post from racing in, so a status that goes terminal
        without clearing it would wedge the request forever (plans/018)."""
        imp.status = status
        imp.active_request_id = None
```

Replace each of the four assignments with `self._finish_import(imp, "...")`
(or `KubeJobRunner._finish_import(reloaded, "superseded")` at :1784, where the
variable is `reloaded`).

**Verify**:
`grep -n 'imp.status = "applied"\|imp.status = "rejected"\|\.status = "superseded"' api/app/kube_runner.py`
returns nothing (all four now go through the helper).

### Step 4: Convert the guard to an atomic claim

In `api/app/routers/gates.py`, the `SELECT` guard stays — it gives the common
double-click a clean 409 without doing git work. But the insert must now handle
the loser of a true race. Wrap the `db.add(record)` following the
`intents.begin` pattern:

```python
    db.add(record)
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        # Lost the race: another post claimed this request between our SELECT
        # guard and here. Our temp ref is ours alone (see import_ref), so
        # dropping it cannot disturb the winner's bundle.
        workspace.delete_ref(ws, temp_ref)
        raise HTTPException(409, "An imported edit is already being graded")
```

Place the `try` immediately after `db.add(record)` and **before** the `emit(...)`
call, so no progress event is written for a losing post. Import `IntegrityError`
from `sqlalchemy.exc` if it is not already imported in this module.

**Verify**: `cd api && uv run pytest -q tests/test_import_edit.py` → the
existing tests still pass except `test_happy_post_records_pending_import`'s ref
assertion, which Step 5 addresses.

### Step 5: Give every import its own temp ref

In `api/app/workspace.py`:

```python
def import_ref(round_number: int, token: str | None = None) -> str:
    """The temp ref an imported bundle lands on — never the work branch.

    The token makes the ref unique per POST. Two concurrent posts used to derive
    the SAME ref from the round alone and each unconditionally delete-then-fetch
    into it, so the second unlinked the first's commits and the first was graded
    against a SHA that no longer existed — and its requester was told the gate
    rejected their edit (plans/018).
    """
    base = f"refs/import/round-{int(round_number)}"
    return f"{base}-{token}" if token else base
```

In `api/app/routers/gates.py`, generate a token per request:

```python
    round_number = r.preview_round
    temp_ref = workspace.import_ref(round_number, secrets.token_hex(4))
```

Add `import secrets` to the module imports if absent.

Now the `delete_ref` at `:356` ("clear a stale ref from a prior reject") is
operating on a ref that is unique to this call and therefore always absent.
Keep the call (it is harmless and idempotent) but fix the stale comment — or
remove the call and say why in the commit message. Either is fine; do not leave
a comment that no longer describes the code.

**Note the knock-on**: `api/tests/test_import_edit.py:200` asserts
`imp.temp_ref == "refs/import/round-0"`. Update it to a prefix assertion, e.g.
`assert imp.temp_ref.startswith("refs/import/round-0-")`. That is the only
in-scope test edit; do not weaken any other assertion.

**Verify**: `cd api && uv run pytest -q tests/test_import_edit.py` → all pass.

### Step 6: Recover from the crash window instead of lying about it

In `api/app/kube_runner.py`, in `_land_import`, replace the `if ff_error:` block:

```python
        ff_error = workspace.fast_forward_work_branch(
            ws, req.ref, imp.head_sha, imp.base_sha
        )
        if ff_error:
            # Crash-window recovery. The branch move is an external side effect
            # performed while the CAS is still uncommitted, so a death in that
            # window leaves the branch AT the imported head with the DB rolled
            # back. On the retry the branch looks "moved" and we would reject an
            # edit that is in fact merged — telling the requester their landed
            # work failed. If the branch is already exactly where this import
            # wanted it, the move succeeded; finish the transaction instead.
            already_landed = (
                workspace.head_sha(ws, workspace.work_branch(req.ref)) == imp.head_sha
            )
            if not already_landed:
                db.rollback()
                reloaded = db.get(ImportEdit, imp.id)
                reloaded_req = db.get(Request, imp.request_id)
                if reloaded is not None and reloaded_req is not None:
                    self._reject_import(db, reloaded_req, reloaded, ff_error, tail, moved)
                return
            log.warning(
                "%s: work branch already at the imported head %s — completing a "
                "crash-interrupted import instead of rejecting it",
                req.ref,
                imp.head_sha[:12],
            )
        self._finish_import(imp, "applied")
        imp.gate_tail = tail
        workspace.delete_ref(ws, imp.temp_ref)
        db.commit()
        res.notify()
```

Read the whole method before editing so the fall-through lands correctly: when
`already_landed` is true, execution must continue into the same success path
the no-error case uses, with the staged transition still in the session.

Confirm `workspace.work_branch` is importable the way you call it — it is used
as `workspace.work_branch(r.ref)` in `api/app/routers/gates.py`.

**Verify**: `cd api && uv run pytest -q tests/test_import_edit.py` → all pass.

### Step 7: Tests

Add to `api/tests/test_import_edit.py`, matching its real-git + `FakeKubeClient`
style:

1. **`test_second_concurrent_import_is_rejected_and_leaves_the_first_intact`** —
   post one bundle, then post a second **without** advancing the first past
   `pending`. Expect 409, exactly one `ImportEdit` row, and — the assertion that
   matters — the first row's `temp_ref` still resolves to its `head_sha` in the
   repo (i.e. its commits were not unlinked). Use `workspace.head_sha(ws,
   imp.temp_ref)`.
2. **`test_active_claim_is_released_when_an_import_finishes`** — drive an import
   to `rejected` (the file's existing red-gate test shows how), assert
   `active_request_id is None`, and then post a fresh bundle successfully. This
   is the test that catches a missed `_finish_import` conversion, which would
   otherwise wedge the request permanently.
3. **`test_crash_after_fast_forward_completes_instead_of_rejecting`** — the
   crash-window case. Set up a green import, then simulate the interrupted
   attempt by moving the work branch to `imp.head_sha` yourself (with the
   `_git` helper the test module already imports) **before** driving the tick.
   Expect: status `applied`, a `SpecLine` recorded, the request resumed at
   review, and **no** `notify_import_rejected` call. Model the assertions on
   `test_green_import_lands_and_resumes_at_review`.

Test 3 must be seen to fail before Step 6 (it will reject instead of applying).
Test 1 must be seen to fail before Steps 4–5.

**Verify**: `cd api && uv run pytest -q tests/test_import_edit.py` → all pass,
including 3 new tests.

### Step 8: Full gate and index

**Verify**:
- `cd api && uv run pytest -q` → whole backend suite passes.
- `cd api && uv run ruff check .` → no errors.
- `task verify` → `✓ VERIFY PASSED`.
- `grep -n "018" plans/README.md` → your row.

## Test plan

- 3 new tests in `api/tests/test_import_edit.py` (concurrent-post rejection with
  the first bundle intact; claim released on finish; crash-window completion),
  plus one updated assertion at `:200` for the new ref shape.
- Structural patterns: `test_happy_post_records_pending_import` for the POST
  shape, `test_green_import_lands_and_resumes_at_review` for the landed
  assertions, `test_red_import_is_rejected_branch_untouched_and_requester_notified`
  for the reject assertions.
- Tests 1 and 3 must be seen to fail before their fixes.
- Regression: the full backend suite, plus `tests/test_migrations.py` for
  model/Alembic parity.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd api && uv run pytest -q` exits 0
- [ ] `cd api && uv run ruff check .` exits 0
- [ ] `cd api && uv run alembic heads` prints exactly one head, the new revision
- [ ] `cd api && uv run alembic upgrade head` exits 0
- [ ] `grep -c "uq_import_edits_active" api/app/models.py api/alembic/versions/*.py` shows a hit in the model and the migration
- [ ] `grep -n 'imp.status = "applied"\|imp.status = "rejected"\|\.status = "superseded"' api/app/kube_runner.py` returns nothing
- [ ] `grep -n "_finish_import" api/app/kube_runner.py` shows the helper plus 4 call sites
- [ ] `grep -n "secrets.token_hex" api/app/routers/gates.py` shows the per-post token
- [ ] `grep -n "already_landed" api/app/kube_runner.py` shows the recovery branch
- [ ] 3 new tests exist and pass
- [ ] `grep -rn "FACTORY_IMPORT_EDIT" deploy scripts docker` still returns nothing (the feature was NOT enabled)
- [ ] `task verify` exits 0
- [ ] `git status --porcelain` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `uv run alembic heads` shows more than one head before you start.
- The filtered unique index does not create on SQLite, or
  `tests/test_migrations.py` reports a model/migration mismatch you cannot
  resolve without changing the index shape. (If you find yourself wanting a
  `status IN (…)` predicate, stop — that is the dialect trap this plan avoids.)
- Test 3 (crash window) passes before Step 6, or test 1 passes before Step 5 —
  either means the test is not reproducing the race.
- Making `_land_import` fall through on `already_landed` requires restructuring
  the method beyond the shape shown in Step 6 — the staged-CAS-then-side-effect
  ordering is subtle and worth a human's eyes.
- You discover a *fifth* place that sets `ImportEdit.status` to a terminal
  value. Report it — a missed site wedges a request forever behind the unique
  index.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this next:

- **What a reviewer should scrutinise**: that every terminal-status path clears
  `active_request_id` (a missed one wedges that request's imports permanently —
  it is the one way this change can make things *worse* than before), and the
  fall-through in `_land_import` when `already_landed` is true.
- **The remaining structural hazard**, deliberately not fixed here: the branch
  move is still an external side effect performed against an uncommitted
  transaction. This plan makes the *retry* idempotent, which is the cheap and
  safe fix, but it does not remove the window. The stronger fix is to record an
  intent row (`api/app/intents.py`) for the branch move so the replay is
  explicitly recognisable rather than inferred from the branch position.
  Worth doing if this path ever grows a third outcome.
- **Before enabling the feature** (`FACTORY_IMPORT_EDIT` in a manifest), note
  that the import endpoint accepts a client-supplied git bundle and is the
  **first user-controlled input into the graded pipeline**. The validation
  chain — `git bundle verify`, temp-ref-only landing, and the 1:1 commit-chain
  match against the declared versions — is the trust boundary and looked
  correct at audit. It should still get an explicit security review before the
  flag goes on, and the orchestrator that produces these bundles has no
  authentication at all today.
- **Related, not fixed here**: `api/app/kube_runner.py` persists unscrubbed
  `str(exc)[:300]` into `intents.fail(...)` on several import paths, while the
  neighbouring git paths call `workspace.sanitize_github_git_error`. The event
  log is append-only, so anything unscrubbed there is permanent.
