"""Secret scrubbing for durable Job logs and evidence payloads."""

from app import settings
from app.log_scrub import scrub_envelope, scrub_secrets


def test_scrub_secrets_redacts_supported_credentials(monkeypatch):
    configured = "configured-github-token-value"
    ghp = "ghp_" + "A" * 36
    github_pat = "github_pat_" + "B" * 50
    service = "ghs_" + "C" * 36
    hex_pat = "d" * 40
    monkeypatch.setattr(settings, "GITHUB_TOKEN", configured)
    monkeypatch.setenv("INTERNAL_API_KEY", "environment-api-key-value")
    raw = (
        f"clone https://x-access-token:{ghp}@github.com/acme/private.git\n"
        f"Authorization: Bearer bearer-value\nBearer another-value\n"
        f"SF_GITHUB_TOKEN={github_pat}\nSERVICE_SECRET={service}\n"
        f"token={hex_pat}\nconfigured={configured}\n"
        "api_key=environment-api-key-value\nordinary line stays"
    )

    scrubbed = scrub_secrets(raw)

    for secret in (
        ghp,
        github_pat,
        service,
        hex_pat,
        configured,
        "bearer-value",
        "another-value",
        "environment-api-key-value",
    ):
        assert secret not in scrubbed
    assert "https://x-access-token:***@github.com/acme/private.git" in scrubbed
    assert "ordinary line stays" in scrubbed


def test_scrub_envelope_recurses_through_json_leaves():
    token = "ghp_" + "Z" * 36
    envelope = {
        "reason": f"failed with {token}",
        "metrics": {"notes": ["safe", f"Bearer {token}"]},
        "count": 2,
    }

    scrubbed = scrub_envelope(envelope)

    assert token not in str(scrubbed)
    assert scrubbed["metrics"]["notes"][0] == "safe"
    assert scrubbed["count"] == 2
