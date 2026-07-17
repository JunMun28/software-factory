"""GitHub REST seam for the produced-app repos (Plan B4; spec §5/§6).

Thin, httpx-based (no new dep), env-gated on FACTORY_GITHUB_TOKEN — unset means
the runner never constructs this and behaves exactly like B2/B3 (git-daemon
remote, local merge). Local profile: a personal github.com account + a
fine-grained PAT (FACTORY_GITHUB_TOKEN, FACTORY_GITHUB_OWNER). The office/Phase-2
swap (a GitHub App issuing per-Job installation tokens) sits behind this same
four-method surface — callers never learn which produced the token.

Only three side effects, each behind an intent row (spec §3.3): create the
private repo, open the PR at first stage push, merge with the graded-SHA
precondition. Writer never grades; grader never writes; the merge checks the
grade (the `sha` param is GitHub's server-side head==sha precondition — a moved
branch 409s, exactly the local merge_graded rule).
"""

import logging

import httpx

from . import settings

log = logging.getLogger("factory")

API = "https://api.github.com"
_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


class GitHubError(RuntimeError):
    """GitHub rejected or could not complete an API operation."""


class MergeShaMismatch(GitHubError):
    """The pull request head no longer matches the graded commit."""


def repo_name(slug: str) -> str:
    return f"sf-app-{slug}"


class GitHub:
    def __init__(self, token: str | None = None, owner: str | None = None) -> None:
        self._token = token or settings.GITHUB_TOKEN
        self._owner = owner or settings.GITHUB_OWNER
        if not (self._token and self._owner):
            raise GitHubError("FACTORY_GITHUB_TOKEN and FACTORY_GITHUB_OWNER are required")

    def _client(self) -> httpx.Client:
        return httpx.Client(
            base_url=API,
            timeout=20,
            headers={**_HEADERS, "Authorization": f"Bearer {self._token}"},
        )

    def ensure_repo(self, slug: str) -> str:
        name = repo_name(slug)
        with self._client() as client:
            got = client.get(f"/repos/{self._owner}/{name}")
            if got.status_code == 200:
                return got.json()["clone_url"]
            if got.status_code != 404:
                raise GitHubError(f"repo lookup failed: {got.status_code} {got.text[:200]}")
            made = client.post(
                "/user/repos",
                json={"name": name, "private": True, "auto_init": False},
            )
            if made.status_code != 201:
                raise GitHubError(f"repo create failed: {made.status_code} {made.text[:200]}")
            return made.json()["clone_url"]

    def protect_main(self, slug: str) -> bool:
        """Best-effort branch protection for `main` via the Rulesets API (MERGE-05).
        Rulesets are free on PRIVATE personal repos (classic branch protection is
        not), so this is the durable [kind] control. Block deletion + force-push,
        and require a PR (0 approvals — the factory's own SHA-precondition API
        merge still lands, and the merge checks the grade, not a human). Genuine
        independent review ("cannot approve your own work") needs the office
        GitHub App issuing a per-request identity — Phase-2, same seam. NEVER
        fatal: protection is defense-in-depth, not on the request's happy path,
        so any failure logs and returns False rather than stranding repo prep.
        Idempotent: skips if the sf-protect-main ruleset already exists."""
        name = repo_name(slug)
        ruleset = {
            "name": "sf-protect-main",
            "target": "branch",
            "enforcement": "active",
            "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
            "rules": [
                {"type": "deletion"},
                {"type": "non_fast_forward"},
                {
                    "type": "pull_request",
                    "parameters": {
                        "required_approving_review_count": 0,
                        "dismiss_stale_reviews_on_push": False,
                        "require_code_owner_review": False,
                        "require_last_push_approval": False,
                        "required_review_thread_resolution": False,
                    },
                },
            ],
        }
        try:
            with self._client() as client:
                existing = client.get(f"/repos/{self._owner}/{name}/rulesets")
                if existing.status_code == 200 and any(
                    r.get("name") == "sf-protect-main" for r in existing.json()
                ):
                    return True
                made = client.post(
                    f"/repos/{self._owner}/{name}/rulesets", json=ruleset
                )
                if made.status_code not in (200, 201):
                    log.warning(
                        "branch protection not set on %s: %s %s",
                        name, made.status_code, made.text[:160],
                    )
                    return False
                return True
        except Exception as exc:  # protection must never break repo prep
            log.warning("branch protection call failed for %s (non-fatal): %s", name, exc)
            return False

    def find_open_pr(self, slug: str, branch: str) -> int | None:
        with self._client() as client:
            response = client.get(
                f"/repos/{self._owner}/{repo_name(slug)}/pulls",
                params={"head": f"{self._owner}:{branch}", "state": "open"},
            )
            response.raise_for_status()
            data = response.json()
            return data[0]["number"] if data else None

    def open_pr(self, slug: str, branch: str, title: str, body: str) -> int:
        existing = self.find_open_pr(slug, branch)
        if existing is not None:
            return existing
        with self._client() as client:
            response = client.post(
                f"/repos/{self._owner}/{repo_name(slug)}/pulls",
                json={"title": title, "head": branch, "base": "main", "body": body},
            )
            if response.status_code == 422:
                again = self.find_open_pr(slug, branch)
                if again is not None:
                    return again
            if response.status_code != 201:
                raise GitHubError(f"open PR failed: {response.status_code} {response.text[:200]}")
            return response.json()["number"]

    def merge_pr(self, slug: str, pr_number: int, sha: str) -> str:
        with self._client() as client:
            response = client.put(
                f"/repos/{self._owner}/{repo_name(slug)}/pulls/{pr_number}/merge",
                json={"sha": sha, "merge_method": "merge"},
            )
            if response.status_code == 409:
                raise MergeShaMismatch(f"merge refused — head != graded SHA {sha[:12]}")
            if response.status_code != 200:
                raise GitHubError(f"merge failed: {response.status_code} {response.text[:200]}")
            return response.json()["sha"]
