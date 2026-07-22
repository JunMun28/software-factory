"""Routing the API brain through a model gateway (LiteLLM).

The gateway is the seam where model choice, keys, budgets and cross-provider
fallback stop being this codebase's problem. What matters here is that turning it
on changes exactly two things — the base URL and the signing key — and that a
half-configured gateway can never silently fall back to billing Anthropic direct.
"""
import pytest

from app import brain_api, settings


class _Recorder:
    """Stands in for the Anthropic SDK constructor; records what it was handed."""

    def __init__(self):
        self.kwargs = None

    def __call__(self, **kwargs):
        self.kwargs = kwargs
        return object()


@pytest.fixture
def build(monkeypatch):
    recorder = _Recorder()
    monkeypatch.setattr(brain_api, "Anthropic", recorder)
    return recorder


def test_no_gateway_talks_to_anthropic_directly(build, monkeypatch):
    """The default. The SDK resolves ANTHROPIC_API_KEY itself — we pass nothing."""
    monkeypatch.setattr(settings, "LLM_BASE_URL", "")
    monkeypatch.setattr(settings, "LLM_KEY", "")
    brain_api._build_client()
    assert build.kwargs == {}


def test_gateway_receives_base_url_and_virtual_key(build, monkeypatch):
    monkeypatch.setattr(settings, "LLM_BASE_URL", "http://localhost:4000/anthropic")
    monkeypatch.setattr(settings, "LLM_KEY", "sk-factory-local")
    brain_api._build_client()
    assert build.kwargs == {
        "base_url": "http://localhost:4000/anthropic",
        "api_key": "sk-factory-local",
    }


def test_gateway_without_a_key_does_not_forge_one(build, monkeypatch):
    """A keyless gateway must reach the SDK keyless, so its own env fallback either
    authenticates the gateway or fails loudly — never signs gateway traffic with a
    key we invented here."""
    monkeypatch.setattr(settings, "LLM_BASE_URL", "http://gateway.internal/anthropic")
    monkeypatch.setattr(settings, "LLM_KEY", "")
    brain_api._build_client()
    assert build.kwargs == {"base_url": "http://gateway.internal/anthropic"}
    assert "api_key" not in build.kwargs


def test_a_bare_key_without_a_gateway_is_not_enough_to_reroute(build, monkeypatch):
    """FACTORY_LLM_KEY alone must not change where traffic goes — otherwise a
    leftover key in an env file silently signs Anthropic calls with a gateway key."""
    monkeypatch.setattr(settings, "LLM_BASE_URL", "")
    monkeypatch.setattr(settings, "LLM_KEY", "sk-factory-local")
    brain_api._build_client()
    assert build.kwargs == {}


def test_the_client_is_built_lazily_and_cached(monkeypatch):
    """Credentials resolve at call time, not import time, so a missing key degrades
    to the CLI/scripted fallback instead of refusing to boot."""
    calls = {"n": 0}

    def factory():
        calls["n"] += 1
        return object()

    monkeypatch.setattr(brain_api, "_client", None)
    monkeypatch.setattr(brain_api, "_client_factory", factory)
    first = brain_api._get_client()
    assert brain_api._get_client() is first
    assert calls["n"] == 1
