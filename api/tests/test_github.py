"""Contract tests for the in-memory GitHub REST seam fake."""

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
