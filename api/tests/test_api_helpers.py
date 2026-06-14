"""Unit tests for the stateless API helpers (api_helpers.py).

prospective_repo is the ONE shared derivation of the repo name an admin confirms
before irreversible repo creation — the gate event and the UI confirmation both
read it, and the frontend deliberately never derives it client-side. These tests
pin its slug contract. A Request is built in memory (pure attribute read, no DB).
"""

from app.api_helpers import prospective_repo
from app.models import Request


def _req(title: str = "t", new_app_name: str | None = None) -> Request:
    return Request(title=title, new_app_name=new_app_name)


def test_slugifies_the_title_under_the_micron_owner():
    assert prospective_repo(_req(title="Faster Expense Export")) == "micron/faster-expense-export"


def test_prefers_new_app_name_over_title():
    r = _req(title="Ignored Title", new_app_name="Vendor Portal")
    assert prospective_repo(r) == "micron/vendor-portal"


def test_lowercases_and_dashes_spaces():
    assert prospective_repo(_req(new_app_name="My Cool APP")) == "micron/my-cool-app"


def test_truncates_the_slug_to_30_chars():
    slug = prospective_repo(_req(new_app_name="a" * 50)).split("/", 1)[1]
    assert slug == "a" * 30


# --- GitHub-safe slugging (a malformed name is created at an irreversible step) ---


def test_collapses_slashes_and_punctuation_to_a_single_dash():
    # a '/' must NOT create a nested path (micron/a/b would be a different repo)
    assert prospective_repo(_req(new_app_name="A/B  C!")) == "micron/a-b-c"


def test_strips_leading_and_trailing_separators():
    assert prospective_repo(_req(new_app_name="  Spaces  ")) == "micron/spaces"


def test_falls_back_to_app_when_empty_after_slugging():
    assert prospective_repo(_req(title="", new_app_name="")) == "micron/app"
    assert prospective_repo(_req(new_app_name="!!!")) == "micron/app"


def test_truncation_does_not_leave_a_trailing_dash():
    slug = prospective_repo(_req(new_app_name="a" * 29 + " bbb")).split("/", 1)[1]
    assert slug == "a" * 29
    assert not slug.endswith("-")
