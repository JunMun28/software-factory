"""Contract tests for the in-memory GitHub REST seam fake."""

import json

import httpx
import pytest
from fake_github import FakeGitHub

import app.github as github


def test_ensure_repo_is_idempotent_and_private() -> None:
    fake = FakeGitHub(owner="acme")

    first = fake.ensure_repo("northwind")
    second = fake.ensure_repo("northwind")

    assert first == "https://github.com/acme/sf-app-northwind.git"
    assert second == first
    assert fake.repos["sf-app-northwind"] == {
        "private": True,
        "clone_url": first,
    }
    assert fake.calls.count(("ensure_repo", "northwind")) == 2


def test_open_pr_is_idempotent_by_head_branch() -> None:
    fake = FakeGitHub(owner="acme")
    fake.ensure_repo("northwind")

    first = fake.open_pr("northwind", "work/REQ-001", "Build it", "Details")
    second = fake.open_pr("northwind", "work/REQ-001", "Ignored", "Ignored")

    assert first == 1
    assert second == first
    assert fake.find_open_pr("northwind", "work/REQ-001") == first
    assert len(fake.prs) == 1


def test_merge_requires_the_graded_sha() -> None:
    fake = FakeGitHub(owner="acme")
    fake.ensure_repo("northwind")
    branch = "work/REQ-001"
    graded_sha = "b" * 40
    fake.set_head("northwind", branch, graded_sha)
    pr_number = fake.open_pr("northwind", branch, "Build it", "Details")

    with pytest.raises(github.MergeShaMismatch):
        fake.merge_pr("northwind", pr_number, "a" * 40)

    merge_sha = fake.merge_pr("northwind", pr_number, graded_sha)

    assert len(merge_sha) == 40
    assert fake.prs[pr_number]["merged"] is True


def test_find_open_pr_requires_an_existing_repo() -> None:
    fake = FakeGitHub(owner="acme")

    with pytest.raises(github.GitHubError, match="repo sf-app-northwind not found"):
        fake.find_open_pr("northwind", "work/REQ-001")


def test_open_pr_requires_an_existing_repo() -> None:
    fake = FakeGitHub(owner="acme")

    with pytest.raises(github.GitHubError, match="repo sf-app-northwind not found"):
        fake.open_pr("northwind", "work/REQ-001", "Build it", "Details")


def test_merge_pr_requires_an_existing_repo() -> None:
    fake = FakeGitHub(owner="acme")

    with pytest.raises(github.GitHubError, match="repo sf-app-northwind not found"):
        fake.merge_pr("northwind", 1, "b" * 40)


def test_fake_protect_main_records_call_and_ruleset() -> None:
    fake = FakeGitHub(owner="acme")
    fake.ensure_repo("northwind")

    assert fake.protect_main("northwind") is True
    assert fake.repos["sf-app-northwind"]["ruleset"] == "sf-protect-main"
    assert ("protect_main", "northwind") in fake.calls


def test_fake_protect_main_requires_an_existing_repo() -> None:
    fake = FakeGitHub(owner="acme")

    with pytest.raises(github.GitHubError, match="repo sf-app-northwind not found"):
        fake.protect_main("northwind")


def _mock_github(monkeypatch: pytest.MonkeyPatch, handler) -> github.GitHub:
    """A real GitHub seam whose _client() routes through an httpx MockTransport."""
    client = github.GitHub(token="t", owner="acme")

    def _client() -> httpx.Client:
        return httpx.Client(base_url=github.API, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(client, "_client", _client)
    return client


def test_protect_main_posts_expected_ruleset(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=[])
        seen["url"] = str(request.url)
        seen["payload"] = json.loads(request.content)
        return httpx.Response(201, json={"id": 1})

    client = _mock_github(monkeypatch, handler)
    assert client.protect_main("northwind") is True

    assert seen["url"].endswith("/repos/acme/sf-app-northwind/rulesets")
    payload = seen["payload"]
    assert payload["name"] == "sf-protect-main"
    assert payload["conditions"]["ref_name"]["include"] == ["refs/heads/main"]
    types = {r["type"] for r in payload["rules"]}
    assert {"deletion", "non_fast_forward", "pull_request"} <= types
    pr_rule = next(r for r in payload["rules"] if r["type"] == "pull_request")
    # 0 approvals: the factory's own SHA-precondition API merge must still land.
    assert pr_rule["parameters"]["required_approving_review_count"] == 0


def test_protect_main_is_idempotent_when_ruleset_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    posts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal posts
        if request.method == "GET":
            return httpx.Response(200, json=[{"name": "sf-protect-main", "id": 9}])
        posts += 1
        return httpx.Response(201, json={"id": 1})

    client = _mock_github(monkeypatch, handler)
    assert client.protect_main("northwind") is True
    assert posts == 0  # existing ruleset -> no second POST


def test_protect_main_never_raises_on_api_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=[])
        return httpx.Response(403, json={"message": "no rulesets on this plan"})

    client = _mock_github(monkeypatch, handler)
    # Best-effort: a rejected protection call returns False, never strands repo prep.
    assert client.protect_main("northwind") is False


def test_protect_main_swallows_transport_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    client = _mock_github(monkeypatch, handler)
    assert client.protect_main("northwind") is False
