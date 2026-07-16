"""Pure secret scrubbing for durable Job logs and evidence payloads."""

import os
import re
from typing import Any

from . import settings

_SECRET_KEY = re.compile(
    r"(?i)(?:token|secret|password|passwd|api[_-]?key|auth)"
)
_AUTHED_GITHUB_URL = re.compile(
    r"(?i)https://x-access-token:[^@\s]+@github\.com/"
)
_AUTHORIZATION_BEARER = re.compile(
    r"(?i)\b(Authorization\s*:\s*Bearer)\s+[^\s\"']+"
)
_BARE_BEARER = re.compile(r"(?i)\b(Bearer)\s+[^\s\"']+")
_GITHUB_TOKEN = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b"
)
_LABELED_HEX_PAT = re.compile(
    r"(?i)\b(token|x-access-token)(\s*[:=]\s*)([0-9a-f]{40})\b"
)
_JSON_CREDENTIAL = re.compile(
    r'(?i)("(?:access_token|token|authorization)"\s*:\s*)'
    r'"(?:\\.|[^"\\])*"'
)
_COLON_TOKEN = re.compile(
    r"(?i)(?<![A-Za-z0-9_-])(access_token|token)(\s*:\s*)([^\s,\"']+)"
)
_PROVIDER_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_-])(?:sk-proj-|sk-|xox[bp]-)[A-Za-z0-9_-]{10,}"
    r"(?![A-Za-z0-9_-])"
)
_KEY_VALUE = re.compile(
    r"(?i)\b([A-Za-z_][A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|auth)"
    r"[A-Za-z0-9_-]*)(\s*=\s*)([^\s\"']+)"
)


def _known_secret_values() -> set[str]:
    values = {settings.GITHUB_TOKEN}
    values.update(
        value
        for key, value in os.environ.items()
        if value and _SECRET_KEY.search(key)
    )
    # Very short values create destructive false positives in ordinary prose.
    return {value for value in values if len(value) >= 8}


def scrub_secrets(text: str) -> str:
    """Redact credential shapes and configured secret values from text."""
    scrubbed = str(text or "")
    for value in sorted(_known_secret_values(), key=len, reverse=True):
        scrubbed = scrubbed.replace(value, "***")
    scrubbed = _AUTHED_GITHUB_URL.sub(
        "https://x-access-token:***@github.com/", scrubbed
    )
    scrubbed = _JSON_CREDENTIAL.sub(r'\1"***"', scrubbed)
    scrubbed = _AUTHORIZATION_BEARER.sub(r"\1 ***", scrubbed)
    scrubbed = _BARE_BEARER.sub(r"\1 ***", scrubbed)
    scrubbed = _GITHUB_TOKEN.sub("***", scrubbed)
    scrubbed = _PROVIDER_TOKEN.sub("***", scrubbed)
    scrubbed = _COLON_TOKEN.sub(r"\1\2***", scrubbed)
    scrubbed = _LABELED_HEX_PAT.sub(r"\1\2***", scrubbed)
    return _KEY_VALUE.sub(r"\1\2***", scrubbed)


def scrub_envelope(value: Any) -> Any:
    """Recursively scrub string leaves without changing JSON structure."""
    if isinstance(value, str):
        return scrub_secrets(value)
    if isinstance(value, dict):
        return {key: scrub_envelope(item) for key, item in value.items()}
    if isinstance(value, list):
        return [scrub_envelope(item) for item in value]
    if isinstance(value, tuple):
        return tuple(scrub_envelope(item) for item in value)
    return value
