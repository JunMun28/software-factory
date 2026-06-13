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
