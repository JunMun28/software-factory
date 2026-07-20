import importlib
import importlib.util


def _load_knowledge(monkeypatch, root):
    from app import settings

    monkeypatch.setattr(settings, "KNOWLEDGE_DIR", root, raising=False)
    spec = importlib.util.find_spec("app.knowledge")
    assert spec is not None, "app.knowledge must provide the Phase 5 knowledge loader"
    module = importlib.import_module("app.knowledge")
    return importlib.reload(module)


def test_missing_knowledge_files_keep_plain_system_context(monkeypatch, tmp_path):
    from app.brain_api import _SYSTEM

    knowledge = _load_knowledge(monkeypatch, tmp_path / "missing")

    assert knowledge.system_blocks() == [{"type": "text", "text": _SYSTEM}]
    assert knowledge.teams() == []
    assert knowledge.data_sources() == []


def test_knowledge_loader_parses_yaml_and_marks_last_system_block_cacheable(
    monkeypatch, tmp_path
):
    root = tmp_path / "knowledge"
    root.mkdir()
    (root / "glossary.md").write_text(
        "## FOUP\nA generic carrier example.\n", encoding="utf-8"
    )
    (root / "teams.yaml").write_text(
        """\
- team: Data Platform
  scope: Shared datasets
  contact: data@example.test
  queue: DATA
""",
        encoding="utf-8",
    )
    (root / "data-sources.yaml").write_text(
        """\
- name: Orders Warehouse
  contains: Fulfilment history
  owner: Analytics
  access_notes: Request read access
""",
        encoding="utf-8",
    )

    knowledge = _load_knowledge(monkeypatch, root)

    assert knowledge.teams() == [
        {
            "team": "Data Platform",
            "scope": "Shared datasets",
            "contact": "data@example.test",
            "queue": "DATA",
        }
    ]
    assert knowledge.data_sources() == [
        {
            "name": "Orders Warehouse",
            "contains": "Fulfilment history",
            "owner": "Analytics",
            "access_notes": "Request read access",
        }
    ]
    blocks = knowledge.system_blocks()
    assert len(blocks) == 2
    assert blocks[0]["text"]
    assert "glossary.md\n## FOUP" in blocks[1]["text"]
    assert "teams.yaml\n- team: Data Platform" in blocks[1]["text"]
    assert "data-sources.yaml\n- name: Orders Warehouse" in blocks[1]["text"]
    assert blocks[1]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in blocks[0]


def test_system_context_is_stable_for_the_process_after_first_load(monkeypatch, tmp_path):
    root = tmp_path / "knowledge"
    root.mkdir()
    glossary = root / "glossary.md"
    glossary.write_text("## MES\nFirst stable definition.\n", encoding="utf-8")
    knowledge = _load_knowledge(monkeypatch, root)

    first = knowledge.system_blocks()
    glossary.write_text("## MES\nChanged on disk.\n", encoding="utf-8")
    second = knowledge.system_blocks()

    assert second == first
    assert "First stable definition" in second[-1]["text"]
    assert "Changed on disk" not in second[-1]["text"]
