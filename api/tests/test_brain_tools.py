from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import brain_tools
from app.db import Base
from app.models import App, Request, SpecLine


@pytest.fixture
def db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


@pytest.mark.parametrize(
    ("surface", "query"),
    [
        ("title", "title compass"),
        ("description", "description lantern"),
        ("new_app", "quartz workspace"),
        ("registered_app", "atlas portal"),
        ("spec", "nebula audit history"),
    ],
    ids=["title", "description", "new-app", "registered-app", "spec-text"],
)
def test_search_past_apps_finds_each_request_surface(
    db: Session, surface: str, query: str
) -> None:
    request = Request(
        ref="REQ-SEARCH-1",
        title="Routine request",
        description="Routine description",
        type="new",
        new_app_name="Routine workspace",
    )
    spec_text = "Grounded baseline requirement"

    if surface == "title":
        request.title = "Build the Title Compass"
    elif surface == "description":
        request.description = "The Description Lantern should guide monthly reporting."
    elif surface == "new_app":
        request.new_app_name = "Quartz Workspace"
    elif surface == "registered_app":
        request.type = "enh"
        request.new_app_name = None
        request.app = App(
            key="atlas-portal",
            name="Atlas Portal",
            owner="Example owner",
            repo="example/atlas-portal",
        )
    elif surface == "spec":
        spec_text = "Retain Nebula Audit History for seven years."

    expected_title = request.title
    request.spec_lines.append(SpecLine(order=0, text=spec_text))
    db.add(request)
    db.commit()
    db.expunge_all()

    assert brain_tools.search_past_apps(query, db) == [
        {
            "ref": "REQ-SEARCH-1",
            "title": expected_title,
            "spec_excerpt": spec_text,
        }
    ]


def test_search_past_apps_orders_spec_excerpt_deterministically(db: Session) -> None:
    request = Request(
        ref="REQ-ORDERED",
        title="Chronology marker",
        description="Exercise stable specification ordering.",
        type="new",
    )
    request.spec_lines.extend(
        [
            SpecLine(order=20, text="Third requirement"),
            SpecLine(order=0, text="First requirement"),
            SpecLine(order=10, text="Second requirement"),
        ]
    )
    db.add(request)
    db.commit()
    db.expunge_all()

    expected = [
        {
            "ref": "REQ-ORDERED",
            "title": "Chronology marker",
            "spec_excerpt": (
                "First requirement\nSecond requirement\nThird requirement"
            ),
        }
    ]
    assert brain_tools.search_past_apps("chronology marker", db) == expected
    assert brain_tools.search_past_apps("chronology marker", db) == expected


def test_search_past_apps_returns_at_most_five_stable_results(db: Session) -> None:
    refs = {f"REQ-CAP-{index}" for index in range(6)}
    for index, ref in enumerate(sorted(refs)):
        request = Request(
            ref=ref,
            title=f"Shared copper search {index}",
            description="A request used to prove the result cap.",
            type="new",
        )
        request.spec_lines.append(
            SpecLine(order=0, text=f"Copper requirement {index}")
        )
        db.add(request)
    db.commit()
    db.expunge_all()

    first = brain_tools.search_past_apps("shared copper", db)
    second = brain_tools.search_past_apps("shared copper", db)

    assert len(first) == 5
    assert first == second
    assert len({item["ref"] for item in first}) == 5
    assert {item["ref"] for item in first} < refs
    assert all(set(item) == {"ref", "title", "spec_excerpt"} for item in first)


def test_get_data_source_is_an_exact_case_insensitive_lookup(monkeypatch) -> None:
    catalog = [
        {
            "name": "Factory Historian",
            "contains": "Example equipment events",
            "owner": "Example Data Team",
            "access_notes": "Example only",
        },
        {
            "name": "Finance Warehouse",
            "contains": "Example monthly totals",
            "owner": "Example Finance Team",
            "access_notes": "Example only",
        },
    ]
    monkeypatch.setattr(brain_tools.knowledge, "data_sources", lambda: catalog)

    assert brain_tools.get_data_source("FACTORY HISTORIAN") == catalog[0]
    assert brain_tools.get_data_source("Factory") is None
    assert brain_tools.get_data_source("Unknown source") is None


def test_check_team_ownership_returns_the_registry_in_stable_order(monkeypatch) -> None:
    registry = [
        {
            "team": "Example App Team",
            "scope": "Example business applications",
            "contact": "example-apps@example.invalid",
            "queue": "EXAMPLE-APPS",
        },
        {
            "team": "Example Data Team",
            "scope": "Example shared data products",
            "contact": "example-data@example.invalid",
            "queue": "EXAMPLE-DATA",
        },
    ]
    monkeypatch.setattr(brain_tools.knowledge, "teams", lambda: registry)

    assert brain_tools.check_team_ownership("Build a reporting workflow") == registry
    assert brain_tools.check_team_ownership("A completely different description") == registry
