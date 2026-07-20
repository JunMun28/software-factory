"""Deterministic, read-only tools available to intake-question generation."""

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from . import knowledge
from .models import App, Request, SpecLine

TOOL_DEFINITIONS = [
    {
        "name": "search_past_apps",
        "description": (
            "Call when the request may overlap an app the factory already built, "
            "or when a past functional specification could prevent a repeated question."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Short app, capability, or requirement search phrase.",
                }
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_data_source",
        "description": (
            "Call when the request names or appears to depend on an organizational "
            "data source and its contents, owner, or access constraints may shape the question."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Exact catalog name of the data source.",
                }
            },
            "required": ["name"],
        },
    },
    {
        "name": "check_team_ownership",
        "description": (
            "Call when the request may belong to another team's documented scope. "
            "The result is the full candidate registry; compare scopes yourself."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "Brief description of the work whose ownership is unclear.",
                }
            },
            "required": ["description"],
        },
    },
]

_STATUS = {
    "search_past_apps": "checking past apps…\n",
    "get_data_source": "checking the data catalog…\n",
    "check_team_ownership": "checking team ownership…\n",
}


def search_past_apps(query: str, db: Session) -> list[dict]:
    """Find up to five prior requests whose app or grounded spec overlaps query."""
    term = (query or "").strip()
    if not term:
        return []
    pattern = f"%{term}%"
    statement = (
        select(Request)
        .outerjoin(Request.app)
        .outerjoin(Request.spec_lines)
        .where(
            or_(
                Request.title.ilike(pattern),
                Request.description.ilike(pattern),
                Request.new_app_name.ilike(pattern),
                Request.bug_where.ilike(pattern),
                App.key.ilike(pattern),
                App.name.ilike(pattern),
                App.repo.ilike(pattern),
                SpecLine.text.ilike(pattern),
            )
        )
        .options(selectinload(Request.spec_lines))
        .distinct()
        .order_by(Request.updated_at.desc(), Request.id.desc())
        .limit(5)
    )
    requests = db.scalars(statement).unique().all()
    results: list[dict] = []
    for request in requests:
        lines = sorted(request.spec_lines, key=lambda line: (line.order, line.id or 0))
        excerpt = "\n".join(line.text.strip() for line in lines if line.text.strip())
        if len(excerpt) > 600:
            excerpt = excerpt[:597].rstrip() + "..."
        results.append(
            {
                "ref": request.ref,
                "title": request.title,
                "spec_excerpt": excerpt,
            }
        )
    return results


def get_data_source(name: str) -> dict | None:
    """Look up one catalog row by exact, case-insensitive name."""
    wanted = (name or "").strip().casefold()
    if not wanted:
        return None
    for source in knowledge.data_sources():
        if str(source.get("name") or "").strip().casefold() == wanted:
            return dict(source)
    return None


def check_team_ownership(description: str) -> list[dict]:
    """Return every routing candidate; the model, not this tool, matches scope."""
    del description
    return [dict(team) for team in knowledge.teams()]


def status_for(name: str) -> str:
    return _STATUS.get(name, "checking organizational context…\n")


def execute(name: str, arguments: dict[str, Any], db: Session) -> Any:
    """Dispatch one provider tool request without granting any write capability."""
    if name == "search_past_apps":
        return search_past_apps(str(arguments.get("query") or ""), db)
    if name == "get_data_source":
        return get_data_source(str(arguments.get("name") or ""))
    if name == "check_team_ownership":
        return check_team_ownership(str(arguments.get("description") or ""))
    raise ValueError(f"unknown intake brain tool: {name}")
