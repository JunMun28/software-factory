import json
from types import SimpleNamespace

import httpx
import pytest
from anthropic import APIStatusError

from app import knowledge
from app.db import migrate
from app.models import InterviewTurn, Request

TEAM_REGISTRY = [
    {
        "team": "Data Platform",
        "scope": "MES event pipelines and governed manufacturing datasets",
        "contact": "data-platform@example.invalid",
        "queue": "DATA",
    },
    {
        "team": "Factory Apps",
        "scope": "Internal workflow applications built by AIRES",
        "contact": "factory-apps@example.invalid",
        "queue": "FACTORY",
    },
]


class _FakeMessages:
    def __init__(self, text: str = "", error: Exception | None = None):
        self.text = text
        self.error = error
        self.create_calls: list[dict] = []

    def create(self, **kwargs):
        self.create_calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=self.text)],
            usage=SimpleNamespace(input_tokens=23, output_tokens=11),
        )


class _FakeClient:
    def __init__(self, messages: _FakeMessages):
        self.messages = messages
        self.options_calls: list[dict] = []

    def with_options(self, **kwargs):
        self.options_calls.append(kwargs)
        return self


def _request() -> Request:
    req = Request(
        ref="REQ-TEAM-1",
        title="Overnight line-health alerting",
        description="Route MES line events into an overnight health report.",
        type="new",
        new_app_name="Line health",
    )
    req.turns = [
        InterviewTurn(
            order=0,
            question="Which source contains the line events?",
            answer="The MES event feed.",
            skipped=False,
        ),
        InterviewTurn(
            order=1,
            question="Who needs the report?",
            answer="Night-shift supervisors.",
            skipped=False,
        ),
    ]
    return req


def _install(monkeypatch, messages: _FakeMessages):
    from app import brain_api

    migrate()
    monkeypatch.setattr(brain_api, "_client", None)
    monkeypatch.setattr(brain_api, "_client_factory", lambda: _FakeClient(messages))

    monkeypatch.setattr(knowledge, "teams", lambda: TEAM_REGISTRY, raising=False)
    monkeypatch.setattr(brain_api, "knowledge", knowledge, raising=False)
    return brain_api


def _forbid_cli_fallback(monkeypatch, brain_api) -> list[Request]:
    calls: list[Request] = []

    def record_fallback(self, req):
        calls.append(req)
        return None

    monkeypatch.setattr(brain_api.AgentBrain, "propose_escalation", record_fallback)
    return calls


def test_known_team_proposal_uses_haiku_and_returns_existing_contract(monkeypatch):
    reason = "Data Platform owns the MES event feed and its governed reporting queue."
    messages = _FakeMessages(
        "===META===\n"
        + json.dumps(
            {
                "team": "Data Platform",
                "confidence": 0.97,
                "why": reason,
            }
        )
    )
    brain_api = _install(monkeypatch, messages)

    result = brain_api.ApiBrain().propose_escalation(_request())

    assert result == {"to_type": "other", "why": reason}
    assert len(messages.create_calls) == 1
    call = messages.create_calls[0]
    assert call["model"] == "claude-haiku-4-5"
    assert call["max_tokens"] == 512
    assert "tools" not in call
    serialized_call = json.dumps(call, default=str)
    assert "Route MES line events into an overnight health report." in serialized_call
    assert "Which source contains the line events?" in serialized_call
    assert "The MES event feed." in serialized_call
    assert "Night-shift supervisors." in serialized_call
    assert "Data Platform" in serialized_call
    assert "MES event pipelines and governed manufacturing datasets" in serialized_call


def test_escalation_disables_sdk_retries(monkeypatch):
    messages = _FakeMessages("null")
    brain_api = _install(monkeypatch, messages)
    client = _FakeClient(messages)
    monkeypatch.setattr(brain_api, "_client", client)

    assert brain_api.ApiBrain().propose_escalation(_request()) is None

    assert client.options_calls == [{"max_retries": 0}]


def test_unknown_team_is_rejected_without_cli_fallback(monkeypatch):
    messages = _FakeMessages(
        json.dumps(
            {
                "team": "Imaginary Routing Team",
                "confidence": 0.99,
                "why": "This team supposedly owns the work.",
            }
        )
    )
    brain_api = _install(monkeypatch, messages)
    fallback_calls = _forbid_cli_fallback(monkeypatch, brain_api)

    assert brain_api.ApiBrain().propose_escalation(_request()) is None
    assert messages.create_calls
    assert fallback_calls == []


@pytest.mark.parametrize("confidence", [float("nan"), float("inf"), 1.01, 0.89, True])
def test_invalid_confidence_is_rejected(monkeypatch, confidence):
    messages = _FakeMessages(
        json.dumps(
            {
                "team": "Data Platform",
                "confidence": confidence,
                "why": "Data Platform may own this work.",
            }
        )
    )
    brain_api = _install(monkeypatch, messages)

    assert brain_api.ApiBrain().propose_escalation(_request()) is None


@pytest.mark.parametrize(
    ("field", "value"),
    [("team", 123), ("why", 123), ("why", ["not", "a", "string"])],
)
def test_non_string_structured_fields_are_rejected(monkeypatch, field, value):
    payload = {
        "team": "Data Platform",
        "confidence": 0.98,
        "why": "Data Platform owns the governed event feed.",
    }
    payload[field] = value
    messages = _FakeMessages(json.dumps(payload))
    brain_api = _install(monkeypatch, messages)

    assert brain_api.ApiBrain().propose_escalation(_request()) is None


def test_explicit_null_is_a_valid_no_match(monkeypatch):
    messages = _FakeMessages("===META===\nnull")
    brain_api = _install(monkeypatch, messages)

    assert brain_api.ApiBrain().propose_escalation(_request()) is None
    assert len(messages.create_calls) == 1


def test_returned_reason_always_names_the_validated_team(monkeypatch):
    messages = _FakeMessages(
        json.dumps(
            {
                "team": "Data Platform",
                "confidence": 0.98,
                "why": "The governed event feed is outside the factory's scope.",
            }
        )
    )
    brain_api = _install(monkeypatch, messages)

    result = brain_api.ApiBrain().propose_escalation(_request())

    assert result is not None
    assert result["why"].startswith("Data Platform:")


def test_team_name_survives_reason_truncation(monkeypatch):
    messages = _FakeMessages(
        json.dumps(
            {
                "team": "Data Platform",
                "confidence": 0.98,
                "why": "x" * 220 + " because Data Platform owns the source.",
            }
        )
    )
    brain_api = _install(monkeypatch, messages)

    result = brain_api.ApiBrain().propose_escalation(_request())

    assert result is not None
    assert result["why"].startswith("Data Platform:")
    assert len(result["why"]) <= 200


def test_team_prefix_requires_an_exact_name_boundary(monkeypatch):
    messages = _FakeMessages(
        json.dumps(
            {
                "team": "IT",
                "confidence": 0.98,
                "why": "It belongs to another group.",
            }
        )
    )
    brain_api = _install(monkeypatch, messages)
    monkeypatch.setattr(
        knowledge,
        "teams",
        lambda: [
            {
                "team": "IT",
                "scope": "Identity and workplace technology",
                "contact": "it@example.invalid",
                "queue": "IT",
            }
        ],
    )

    result = brain_api.ApiBrain().propose_escalation(_request())

    assert result is not None
    assert result["why"].startswith("IT: It belongs")


def test_malformed_proposal_is_ignored_without_cli_fallback(monkeypatch):
    messages = _FakeMessages("===META===\nnot valid JSON")
    brain_api = _install(monkeypatch, messages)
    fallback_calls = _forbid_cli_fallback(monkeypatch, brain_api)

    assert brain_api.ApiBrain().propose_escalation(_request()) is None
    assert messages.create_calls
    assert fallback_calls == []


def test_api_failure_is_optional_enrichment_without_cli_fallback(monkeypatch):
    response = httpx.Response(
        503,
        request=httpx.Request("POST", "https://api.anthropic.test/v1/messages"),
    )
    messages = _FakeMessages(
        error=APIStatusError("unavailable", response=response, body=None)
    )
    brain_api = _install(monkeypatch, messages)
    fallback_calls = _forbid_cli_fallback(monkeypatch, brain_api)

    assert brain_api.ApiBrain().propose_escalation(_request()) is None
    assert messages.create_calls
    assert fallback_calls == []
