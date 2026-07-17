"""In-memory GitHub seam used by network-free runner tests."""

from typing import Any

from app.github import GitHubError, MergeShaMismatch, repo_name


class FakeGitHub:
    def __init__(self, owner: str) -> None:
        self.owner = owner
        self.repos: dict[str, dict[str, Any]] = {}
        self.prs: dict[int, dict[str, Any]] = {}
        self.calls: list[tuple[Any, ...]] = []
        self._heads: dict[tuple[str, str], str] = {}
        self._next_pr_number = 1

    def ensure_repo(self, slug: str) -> str:
        self.calls.append(("ensure_repo", slug))
        name = repo_name(slug)
        clone_url = f"https://github.com/{self.owner}/{name}.git"
        self.repos.setdefault(name, {"private": True, "clone_url": clone_url})
        return clone_url

    def protect_main(self, slug: str) -> bool:
        self.calls.append(("protect_main", slug))
        self._require_repo(slug)
        self.repos[repo_name(slug)]["ruleset"] = "sf-protect-main"
        return True

    def find_open_pr(self, slug: str, branch: str) -> int | None:
        self.calls.append(("find_open_pr", slug, branch))
        self._require_repo(slug)
        return self._find_open_pr(slug, branch)

    def open_pr(self, slug: str, branch: str, title: str, body: str) -> int:
        self.calls.append(("open_pr", slug, branch, title, body))
        self._require_repo(slug)
        existing = self._find_open_pr(slug, branch)
        if existing is not None:
            return existing

        number = self._next_pr_number
        self._next_pr_number += 1
        self.prs[number] = {
            "number": number,
            "slug": slug,
            "head": branch,
            "title": title,
            "body": body,
            "open": True,
            "merged": False,
        }
        return number

    def merge_pr(self, slug: str, pr_number: int, sha: str) -> str:
        self.calls.append(("merge_pr", slug, pr_number, sha))
        self._require_repo(slug)
        pull_request = self.prs.get(pr_number)
        if pull_request is None or pull_request["slug"] != slug or not pull_request["open"] or pull_request["merged"]:
            raise GitHubError(f"open PR {pr_number} not found for {repo_name(slug)}")

        branch = pull_request["head"]
        if self._heads.get((slug, branch)) != sha:
            raise MergeShaMismatch(f"merge refused — head != graded SHA {sha[:12]}")

        pull_request["open"] = False
        pull_request["merged"] = True
        merge_sha = f"{pr_number:040x}"
        pull_request["merge_sha"] = merge_sha
        return merge_sha

    def set_head(self, slug: str, branch: str, sha: str) -> None:
        self.calls.append(("set_head", slug, branch, sha))
        self._heads[(slug, branch)] = sha

    def _require_repo(self, slug: str) -> None:
        name = repo_name(slug)
        if name not in self.repos:
            raise GitHubError(f"repo {name} not found")

    def _find_open_pr(self, slug: str, branch: str) -> int | None:
        for number, pull_request in self.prs.items():
            if (
                pull_request["slug"] == slug
                and pull_request["head"] == branch
                and pull_request["open"]
                and not pull_request["merged"]
            ):
                return number
        return None
