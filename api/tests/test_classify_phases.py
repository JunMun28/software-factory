"""classify(): the one derivation of a Request's supervision phase (spec D6)."""

from app import transitions as t
from app.models import Request
from app.supervision import classify, in_flight


def _req(**kw):
    base = dict(
        ref="REQ-1",
        title="x",
        type="enh",
        status=t.APPROVED,
        stage="build",
        gate=None,
        needs_human=False,
    )
    base.update(kw)
    return Request(**base)


def test_in_flight_phase():
    c = classify(_req())
    assert c == {"phase": "in_flight", "at_gate": False, "in_flight": True, "stalled": False}
    assert in_flight(_req()) is True


def test_at_gate_phase():
    c = classify(_req(status=t.PENDING_APPROVAL, stage="spec", gate=t.GATE_APPROVE_SPEC))
    assert c["phase"] == "at_gate" and c["at_gate"] is True and c["in_flight"] is False
    c = classify(_req(stage="review", gate=t.GATE_APPROVE_MERGE))
    assert c["phase"] == "at_gate"
    assert in_flight(_req(stage="review", gate=t.GATE_APPROVE_MERGE)) is False


def test_stalled_beats_gate():
    c = classify(_req(needs_human=True, gate=t.GATE_APPROVE_SPEC, status=t.PENDING_APPROVAL))
    assert c["phase"] == "stalled" and c["stalled"] is True and c["at_gate"] is False


def test_human_owned_phase_keeps_the_stalled_flag_independent():
    c = classify(_req(status=t.HUMAN_OWNED))
    assert c["phase"] == "human_owned" and c["in_flight"] is False
    c = classify(_req(status=t.HUMAN_OWNED, needs_human=True))
    assert c["phase"] == "human_owned" and c["stalled"] is True  # bands read flags, not phase


def test_closed_phases():
    assert classify(_req(status=t.DONE, stage="done"))["phase"] == "closed"
    assert classify(_req(status=t.CANCELLED))["phase"] == "closed"


def test_closed_phase_zeroes_all_flags():
    """Adopters no longer need a CLOSED prefilter for correctness."""
    c = classify(_req(status=t.CANCELLED, gate=t.GATE_APPROVE_MERGE, needs_human=True))
    assert c == {"phase": "closed", "at_gate": False, "in_flight": False, "stalled": False}


def test_intake_phase():
    c = classify(_req(status=t.DRAFT, stage="intake"))
    assert c == {"phase": "intake", "at_gate": False, "in_flight": False, "stalled": False}
    assert classify(_req(status=t.SENT_BACK, stage="spec"))["phase"] == "intake"
