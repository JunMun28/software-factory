"""Seed data — one coherent world state matching the design prototype's demo content.

The design screens each carried their own static demo data; here it is reconciled
into a single truth so every surface (board, list, queue, feed, inbox, submitter
views) reads from the same records.
"""
from datetime import timedelta

from sqlalchemy.orm import Session

from .events import emit
from .models import App, AuditEvent, Comment, InterviewTurn, Request, SpecLine, utcnow

KP = {"assignee": "Kim P.", "assignee_initials": "KP", "assignee_color": "#6E5A8A"}
RM = {"assignee": "Raj M.", "assignee_initials": "RM", "assignee_color": "#8A5A5A"}


def ago(**kw):
    return utcnow() - timedelta(**kw)


def seed(db: Session) -> None:
    if db.query(App).count():
        return

    apps = {
        "northwind": App(key="northwind", name="Northwind Expenses", owner="finance-eng", repo="micron/nw-expenses", provisioning="Auto"),
        "vendor": App(key="vendor", name="Vendor Portal", owner="proc-platform", repo="micron/vendor-portal", provisioning="Auto"),
        "fieldops": App(key="fieldops", name="FieldOps", owner="field-systems", repo="micron/fieldops-app", provisioning="Manual"),
        "inventory": App(key="inventory", name="Inventory Sync", owner="supply-eng", repo="micron/inv-sync", provisioning="Auto", muted=True),
        "billing": App(key="billing", name="Billing Portal", owner="rev-platform", repo="micron/billing-portal", provisioning="Manual"),
    }
    db.add_all(apps.values())
    db.flush()

    def req(ref, title, type_, app, *, stage, status, gate=None, reporter=("Jordan D.", "JD"),
            created=None, desc="", urgency="normal", **kw) -> Request:
        r = Request(
            ref=ref, title=title, type=type_, app_id=apps[app].id if app else None,
            stage=stage, status=status, gate=gate, reporter=reporter[0], reporter_initials=reporter[1],
            created_at=created or utcnow(), description=desc, urgency=urgency,
            stage_entered_at=kw.pop("entered", None) or created or utcnow(), **kw,
        )
        db.add(r)
        return r

    # --- Intake (Triage) ---
    req("REQ-2035", "Login button misaligned on iPad", "bug", "fieldops",
        stage="intake", status="submitted", created=ago(hours=2),
        desc="On iPad the login button sits half off-screen; you have to rotate to tap it.",
        bug_where="Login screen")
    req("REQ-2031", "Quarterly headcount dashboard", "new", None,
        stage="intake", status="submitted", created=ago(hours=5),
        new_app_name="Headcount Dashboard",
        desc="A simple dashboard showing quarterly headcount by org, fed from the HR extract.")
    req("REQ-2037", "Supplier onboarding flow", "new", None,
        stage="intake", status="submitted", reporter=("Priya S.", "PS"), created=ago(days=1),
        new_app_name="Supplier Onboarding",
        desc="Guided flow for new suppliers to register, upload docs, and get approved.")

    # --- Spec (awaiting approval — the gate workhorse) ---
    r_export = req("REQ-2041", "Faster expense export", "enh", "northwind",
                   stage="spec", status="pending_approval", gate="approve_spec",
                   created=ago(hours=3), entered=ago(hours=2, minutes=48), urgency="normal",
                   desc="Exporting a month of expenses is painfully slow — it takes about 5 minutes and "
                        "sometimes times out before it finishes. I just want one button that gives me the "
                        "whole month in CSV and Excel.",
                   labels=[{"name": "export", "color": "var(--a500)"}, {"name": "performance", "color": "var(--info)"}],
                   **KP)
    r_csv = req("REQ-2042", "CSV import for vendors", "enh", "vendor",
                stage="spec", status="pending_approval", gate="approve_spec",
                reporter=("Priya S.", "PS"), created=ago(hours=3), entered=ago(hours=2, minutes=30),
                desc="Let us bulk-import the vendor list from a CSV instead of keying entries one by one.",
                **KP)
    r_sync = req("REQ-2043", "Offline sync mode", "new", "fieldops",
                 stage="spec", status="submitted", needs_human=True,
                 needs_human_reason="Spec generation failed 3× — the request references a payments API the Factory can't reach.",
                 created=ago(hours=2), reporter=("Dana L.", "DL"), **RM)
    r_typo2 = req("REQ-2040", "Approval email typo", "bug", "northwind",
                  stage="spec", status="pending_approval", gate="approve_spec",
                  created=ago(days=1),
                  desc='The approval email says "you request has been approve" — two typos in one line.',
                  **KP)

    # --- Sent back (the S5 hero) ---
    r_vlist = req("REQ-2038", "Add CSV import to vendor list", "enh", "northwind",
                  stage="spec", status="sent_back", created=ago(days=3), entered=ago(days=2, hours=20),
                  send_back_question="Which systems should we import the CSV from? Concur, or your bank export too?",
                  send_back_rounds=1,
                  desc="Importing the vendor list by hand takes an hour a week — a CSV upload would remove it.",
                  **KP)

    # --- In flight (Building — gives board/feed life) ---
    r_sso = req("REQ-2029", "Migrate auth to SSO", "enh", "billing",
                stage="build", status="approved", reporter=("Dana L.", "DL"), created=ago(days=2), entered=ago(hours=20),
                repo_ready=True, spec_pr_open=True, stage2_fired=True, sim_step=1, **KP)

    # --- Done / cancelled history ---
    req("REQ-2044", "Fix typo in approval email", "bug", "northwind",
        stage="done", status="done", created=ago(weeks=1), repo_ready=True, spec_pr_open=True, stage2_fired=True, **KP)
    req("REQ-2017", "Monthly expense CSV", "enh", "northwind",
        stage="done", status="done", created=ago(weeks=3), repo_ready=True, spec_pr_open=True, stage2_fired=True, **KP)
    req("REQ-2030", "Old vendor sync (no longer needed)", "enh", None,
        stage="intake", status="cancelled", created=ago(weeks=3), new_app_name="Legacy")
    db.flush()

    # --- REQ-2041's grounded interview + draft spec (the design's exact content) ---
    qa = [
        ("What's slow today?", "A full month takes ~5 min and sometimes times out.", None),
        ("How many rows per export?", "A few hundred — a full month at once.",
         [{"t": "A handful", "d": "Under 10 at a time — one-off lookups."},
          {"t": "A few dozen", "d": "A typical week of receipts."},
          {"t": "A few hundred", "d": "A full month in one export — most common for your team."},
          {"t": "Thousands or more", "d": "Quarterly or annual pulls; performance matters most here."}]),
        ("Which formats?", "CSV and Excel.", None),
        ("Anything not to break?", None, None),
    ]
    for i, (q, a, opts) in enumerate(qa):
        db.add(InterviewTurn(request=r_export, order=i, question=q, answer=a, skipped=a is None, options=opts))
    spec = [
        ("Export a full month of expenses in one click.", "Q1", False),
        ("Output formats: CSV and Excel.", "Q3", False),
        ("Handle a few hundred rows per export without timing out.", "Q2", False),
        ("Exports run against the Concur connector only.", None, True),
    ]
    for i, (text, prov, assume) in enumerate(spec):
        db.add(SpecLine(request=r_export, order=i, text=text, prov=prov, assume=assume))
    r_export.spec_open_note = ("1 assumption needs confirming before approval — the bank-export source "
                               "was never stated by the submitter.")

    for r in (r_csv, r_typo2, r_vlist):
        for i, (text, prov, assume) in enumerate([
            (f"Deliver: {r.title}.", "request", False),
            (r.description, "request", False),
            ("Work is scoped to the existing app's current integrations only.", None, True),
        ]):
            db.add(SpecLine(request=r, order=i, text=text, prov=prov, assume=assume))
        r.spec_open_note = "1 assumption needs confirming before approval."

    # --- progress events (the feed's conversation, ADR 0008 log) ---
    e = lambda req_, kind, title, **kw: emit(db, req_, kind, title, **kw)  # noqa: E731
    ev1 = e(r_export, "milestone_summary", "New request filed in #Northwind Expenses",
            payload={"fields": {"Type": "Enhancement", "From": "Jordan D.", "Stage": "Triage"},
                     "context": "Intake interview completed · 4 answers", "Ref": r_export.ref})
    ev1.created_at = ago(hours=3)
    ev2 = e(r_export, "gate_event", "Draft spec generated — 1 open question before it can be approved",
            broadcast=True,
            payload={"gate": "approve_spec", "fields": {"Status": "Awaiting approval", "Assumptions": "1", "Ref": r_export.ref}})
    ev2.created_at = ago(hours=2, minutes=48)

    c1 = Comment(request=r_export, author="Kim P.", initials="KP", color="#6E5A8A",
                 body="Looks good — checking the bank-export assumption with Jordan before I approve.")
    c1.created_at = ago(hours=2, minutes=41)
    db.add(c1)

    ev3 = e(r_vlist, "milestone_summary", "Filed: Add CSV import to vendor list — now in Triage",
            payload={"Ref": r_vlist.ref})
    ev3.created_at = ago(days=3)
    ev4 = e(r_vlist, "escalation", "Retried spec generation 3× — last attempt timed out",
            payload={"folded": 3, "Ref": r_vlist.ref})
    ev4.created_at = ago(days=3)
    ev5 = e(r_vlist, "gate_event", "Sent back to the submitter — one question is blocking the spec",
            broadcast=True, actor="Kim P.", bot=False,
            payload={"gate": "send_back", "Ref": r_vlist.ref})
    ev5.created_at = ago(days=2, hours=20)

    ev6 = e(r_sync, "escalation", "Escalated — needs a human (spec generation failed 3×)",
            broadcast=True, payload={"Ref": r_sync.ref, "reason": r_sync.needs_human_reason})
    ev6.created_at = ago(hours=2)

    for _i, (kind, title, payload, dt) in enumerate([
        ("gate_event", "Spec approved by Kim P. — repo ready, SPEC.md PR open, Stage 2 started",
         {"gate": "approve_spec", "Ref": r_sso.ref}, ago(days=2)),
        ("milestone_summary", "Architecture plan drafted — PLAN.md committed",
         {"fields": {"Artifacts": "PLAN.md", "ADRs": "2 drafted"}, "Ref": r_sso.ref}, ago(days=1, hours=20)),
        ("milestone_summary", "ADRs signed; plan validated against SPEC.md",
         {"fields": {"Gate": "Sign ADRs · passed"}, "Ref": r_sso.ref}, ago(days=1, hours=16)),
        ("milestone_summary", "RED: 8 failing tests authored — fail for the right reason",
         {"fields": {"Tests": "8 added, 8 failing", "Gate": "RED · passed"}, "Ref": r_sso.ref}, ago(days=1)),
    ]):
        ev = e(r_sso, kind, title, payload=payload, bot=kind != "gate_event",
               actor="Factory" if kind != "gate_event" else "Kim P.", broadcast=kind == "gate_event")
        ev.created_at = dt

    db.add(AuditEvent(request_id=r_export.id, actor="Jordan D.", action="submitted",
                      note="filed this request and completed intake", created_at=ago(days=3)))
    db.add(AuditEvent(request_id=r_export.id, actor="Factory", action="spec_drafted",
                      note="generated the draft spec from 4 interview answers", created_at=ago(days=2)))
    db.commit()
