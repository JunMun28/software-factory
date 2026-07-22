import threading
import uuid
from datetime import timedelta
from types import SimpleNamespace

import httpx
from sqlalchemy import func, select

from app import settings
from app.db import SessionLocal, migrate
from app.models import Request


class _FakeStream:
    def __init__(
        self,
        chunks: list[str],
        *,
        final: SimpleNamespace | None = None,
        tokens_in: int = 17,
        tokens_out: int = 9,
    ):
        self.text_stream = iter(chunks)
        self._final = final if final is not None else SimpleNamespace(
            usage=SimpleNamespace(input_tokens=tokens_in, output_tokens=tokens_out)
        )

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def get_final_message(self):
        return self._final


class _FakeMessages:
    def __init__(
        self,
        *,
        chunks: list[str] | None = None,
        create_text: str | None = None,
        create_responses: list[SimpleNamespace] | None = None,
        stream_responses: list[tuple[list[str], SimpleNamespace]] | None = None,
    ):
        self.chunks = chunks or []
        self.create_text = create_text
        self.create_responses = list(create_responses or [])
        self.stream_responses = list(stream_responses or [])
        self.stream_calls: list[dict] = []
        self.create_calls: list[dict] = []
        self.create_error: Exception | None = None
        self.stream_error: Exception | None = None

    def stream(self, **kwargs):
        self.stream_calls.append(kwargs)
        if self.stream_responses:
            chunks, final = self.stream_responses.pop(0)
            return _FakeStream(chunks, final=final)
        if self.stream_error is not None:
            raise self.stream_error
        return _FakeStream(self.chunks)

    def create(self, **kwargs):
        self.create_calls.append(kwargs)
        if self.create_error is not None:
            raise self.create_error
        if self.create_responses:
            return self.create_responses.pop(0)
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=self.create_text or "")],
            stop_reason="end_turn",
            usage=SimpleNamespace(input_tokens=5, output_tokens=3),
        )


class _FakeClient:
    def __init__(self, messages: _FakeMessages):
        self.messages = messages
        self.options_calls: list[dict] = []

    def with_options(self, **kwargs):
        self.options_calls.append(kwargs)
        return self


def _request() -> Request:
    return Request(
        ref=f"REQ-{uuid.uuid4().hex[:8]}",
        title="Monthly report",
        description="Show finance the monthly numbers",
        type="new",
        new_app_name="Report helper",
    )


def _message(*blocks: dict, stop_reason: str = "end_turn") -> SimpleNamespace:
    return SimpleNamespace(
        content=list(blocks),
        stop_reason=stop_reason,
        usage=SimpleNamespace(input_tokens=5, output_tokens=3),
    )


def _tool_use(tool_id: str, name: str, input_: dict) -> dict:
    return {"type": "tool_use", "id": tool_id, "name": name, "input": input_}


def _tool_result_user_messages(messages: _FakeMessages) -> list[dict]:
    calls = messages.stream_calls[-1:]
    return [
        item
        for call in calls
        for item in call["messages"]
        if item.get("role") == "user"
        and isinstance(item.get("content"), list)
        and any(block.get("type") == "tool_result" for block in item["content"])
    ]


def _install_client(
    monkeypatch, messages: _FakeMessages, *, tools: bool | None = False
):
    from app import brain_api

    # Existing Phase 3 cases intentionally prove the byte-for-byte legacy path.
    # Tool-loop cases opt in explicitly until their production slice turns green.
    if tools is None:
        monkeypatch.delenv("FACTORY_BRAIN_TOOLS", raising=False)
    else:
        monkeypatch.setenv("FACTORY_BRAIN_TOOLS", "1" if tools else "0")
    monkeypatch.setattr(brain_api, "_client", None)
    monkeypatch.setattr(brain_api, "_client_factory", lambda: _FakeClient(messages))
    return brain_api


def test_get_brain_dispatches_api_mode(monkeypatch):
    monkeypatch.setenv("FACTORY_BRAIN", "api")

    from app.brain_api import ApiBrain
    from app.interview import get_brain

    assert isinstance(get_brain(), ApiBrain)


def test_classify_uses_haiku_api_tier(monkeypatch):
    messages = _FakeMessages(create_text='{"type":"enh","confidence":0.91}')
    brain_api = _install_client(monkeypatch, messages)

    result = brain_api.ApiBrain().classify("Please add export to the existing report")

    assert result == {"type": "enh", "confidence": 0.91}
    assert len(messages.create_calls) == 1
    call = messages.create_calls[0]
    assert call["model"] == "claude-haiku-4-5"
    assert call["max_tokens"] == 256
    assert "thinking" not in call
    assert "output_config" not in call


def test_api_status_error_falls_back_to_agent_cli(monkeypatch):
    from anthropic import APIStatusError

    messages = _FakeMessages()
    response = httpx.Response(
        503,
        request=httpx.Request("POST", "https://api.anthropic.test/v1/messages"),
    )
    messages.create_error = APIStatusError("unavailable", response=response, body=None)
    brain_api = _install_client(monkeypatch, messages)
    expected = {"type": "other", "confidence": 0.42}
    monkeypatch.setattr("app.agent_brain.AgentBrain.classify", lambda self, text: expected)

    assert brain_api.ApiBrain().classify("Something unusual") == expected


def test_malformed_question_metadata_falls_back_to_agent_cli(monkeypatch):
    from app.interview import Question

    messages = _FakeMessages(
        chunks=["What matters?\n===META===\n{\"sub\":null,\"options\":123}"]
    )
    brain_api = _install_client(monkeypatch, messages)
    expected = Question("Which export formats should work?")
    monkeypatch.setattr(
        "app.agent_brain.AgentBrain.next_question",
        lambda self, req: expected,
    )

    assert brain_api.ApiBrain().next_question(_request()) is expected


def test_malformed_summary_sections_fall_back_to_agent_cli(monkeypatch):
    messages = _FakeMessages(
        chunks=['{"overview":"A reporting helper.","sections":123}']
    )
    brain_api = _install_client(monkeypatch, messages)
    expected = {"overview": "CLI summary", "sections": []}
    monkeypatch.setattr(
        "app.agent_brain.AgentBrain.summarize",
        lambda self, req: expected,
    )

    assert brain_api.ApiBrain().summarize(_request()) == expected


def test_question_stream_relays_chunks_and_writes_telemetry(monkeypatch):
    migrate()
    messages = _FakeMessages(
        chunks=[
            "Which monthly numbers matter most?\n",
            '===META===\n{"sub":null,"options":null}',
        ]
    )
    brain_api = _install_client(monkeypatch, messages)
    req = _request()
    deltas: list[str] = []

    question = brain_api.ApiBrain().next_question(req, on_delta=deltas.append)

    assert question is not None
    assert question.question == "Which monthly numbers matter most?"
    assert deltas == messages.chunks
    call = messages.stream_calls[0]
    assert call["model"] == "claude-sonnet-5"
    assert call["max_tokens"] == 1024
    assert call["thinking"] == {"type": "disabled"}
    assert call["output_config"] == {"effort": "low"}

    from app.models import BrainCall

    with SessionLocal() as db:
        row = db.scalar(select(BrainCall).order_by(BrainCall.id.desc()).limit(1))
        assert row is not None
        assert (row.kind, row.model, row.status) == (
            "question",
            "claude-sonnet-5",
            "ok",
        )
        assert (row.tokens_in, row.tokens_out) == (17, 9)
        assert row.duration_ms is not None and row.duration_ms >= 0
        assert row.ttft_ms is not None and row.ttft_ms >= 0
        assert row.finished_at is not None


def test_question_tool_loop_streams_final_text_and_batches_tool_results(monkeypatch):
    migrate()
    messages = _FakeMessages(
        chunks=[
            "Which monthly numbers matter most?\n",
            '===META===\n{"sub":null,"options":null}',
        ],
        stream_responses=[
            (
                [],
                _message(
                    _tool_use("tool-1", "search_past_apps", {"query": "monthly reporting"}),
                    _tool_use(
                        "tool-2",
                        "check_team_ownership",
                        {"description": "Finance needs a monthly report"},
                    ),
                    stop_reason="tool_use",
                ),
            ),
        ],
    )
    brain_api = _install_client(monkeypatch, messages, tools=True)
    deltas: list[str] = []

    question = brain_api.ApiBrain().next_question(_request(), on_delta=deltas.append)

    assert question is not None
    assert question.question == "Which monthly numbers matter most?"
    assert messages.create_calls == []
    assert messages.stream_calls[0]["tools"]
    result_messages = _tool_result_user_messages(messages)
    assert len(result_messages) == 1
    result_blocks = [
        block for block in result_messages[0]["content"] if block["type"] == "tool_result"
    ]
    assert [block["tool_use_id"] for block in result_blocks] == ["tool-1", "tool-2"]
    assert len(messages.stream_calls) == 2
    assert messages.stream_calls[1]["tools"]
    assert any("checking past apps" in delta.lower() for delta in deltas)
    assert deltas[-len(messages.chunks) :] == messages.chunks


def test_question_tool_loop_caps_three_rounds_then_forces_tool_free_stream(monkeypatch):
    migrate()
    messages = _FakeMessages(
        chunks=["What should operators see first?\n===META===\n", '{"sub":null,"options":null}'],
        stream_responses=[
            (
                [],
                _message(
                    _tool_use(
                        f"tool-{round_number}",
                        "search_past_apps",
                        {"query": f"operator dashboard {round_number}"},
                    ),
                    stop_reason="tool_use",
                ),
            )
            for round_number in range(1, 4)
        ],
    )
    brain_api = _install_client(monkeypatch, messages, tools=True)
    deltas: list[str] = []

    question = brain_api.ApiBrain().next_question(_request(), on_delta=deltas.append)

    assert question is not None
    assert question.question == "What should operators see first?"
    assert messages.create_calls == []
    assert len(messages.stream_calls) == 4
    assert all("tools" in call for call in messages.stream_calls[:3])
    assert "tools" not in messages.stream_calls[3]
    assert sum("checking past apps" in delta.lower() for delta in deltas) == 3
    assert deltas[-len(messages.chunks) :] == messages.chunks


def test_question_tool_provider_failure_falls_back_to_agent_brain(monkeypatch):
    from app.interview import Question

    messages = _FakeMessages()
    messages.stream_error = RuntimeError("provider unavailable")
    brain_api = _install_client(monkeypatch, messages, tools=True)
    expected = Question("Which export formats should work?")
    monkeypatch.setattr(
        "app.agent_brain.AgentBrain.next_question",
        lambda self, req: expected,
    )

    assert brain_api.ApiBrain().next_question(_request()) is expected
    assert messages.create_calls == []
    assert len(messages.stream_calls) == 1


def test_question_tool_execution_failure_falls_back_to_agent_brain(monkeypatch):
    from app.interview import Question

    messages = _FakeMessages(
        stream_responses=[
            (
                [],
                _message(
                    _tool_use("tool-unknown", "unknown_read_tool", {}),
                    stop_reason="tool_use",
                ),
            )
        ]
    )
    brain_api = _install_client(monkeypatch, messages, tools=True)
    expected = Question("Who should use this report?")
    monkeypatch.setattr(
        "app.agent_brain.AgentBrain.next_question",
        lambda self, req: expected,
    )

    assert brain_api.ApiBrain().next_question(_request()) is expected
    assert messages.create_calls == []
    assert len(messages.stream_calls) == 1


def test_question_tool_final_stream_failure_falls_back_to_agent_brain(monkeypatch):
    from app.interview import Question

    messages = _FakeMessages(
        stream_responses=[
            (
                [],
                _message(
                    _tool_use("tool-1", "search_past_apps", {"query": "reports"}),
                    stop_reason="tool_use",
                ),
            )
        ]
    )
    messages.stream_error = RuntimeError("stream disconnected")
    brain_api = _install_client(monkeypatch, messages, tools=True)
    expected = Question("Who should use this report?")
    monkeypatch.setattr(
        "app.agent_brain.AgentBrain.next_question",
        lambda self, req: expected,
    )

    assert brain_api.ApiBrain().next_question(_request()) is expected
    assert messages.create_calls == []
    assert len(messages.stream_calls) == 2


def test_question_tool_plain_final_output_falls_back_to_agent_brain(monkeypatch):
    from app.interview import Question

    messages = _FakeMessages(chunks=["Who needs access?"])
    brain_api = _install_client(monkeypatch, messages, tools=True)
    expected = Question("Which roles need access?")
    monkeypatch.setattr(
        "app.agent_brain.AgentBrain.next_question",
        lambda self, req: expected,
    )

    assert brain_api.ApiBrain().next_question(_request()) is expected


def test_question_tool_round_count_is_recorded_in_telemetry(monkeypatch):
    migrate()
    messages = _FakeMessages(
        chunks=["Who needs access?\n===META===\n", '{"sub":null,"options":null}'],
        stream_responses=[
            (
                [],
                _message(
                    _tool_use(
                        "tool-team",
                        "check_team_ownership",
                        {"description": "Finance needs a monthly report"},
                    ),
                    stop_reason="tool_use",
                ),
            ),
        ],
    )
    brain_api = _install_client(monkeypatch, messages, tools=True)

    assert brain_api.ApiBrain().next_question(_request()) is not None

    from app.models import BrainCall

    with SessionLocal() as db:
        row = db.scalar(select(BrainCall).order_by(BrainCall.id.desc()).limit(1))
        assert row is not None
        assert getattr(row, "tool_rounds", None) == 1


def test_question_tool_kill_switch_keeps_the_legacy_stream_call(monkeypatch):
    messages = _FakeMessages(
        chunks=["Which monthly numbers matter most?\n===META===\n", '{"sub":null,"options":null}']
    )
    brain_api = _install_client(monkeypatch, messages, tools=False)

    question = brain_api.ApiBrain().next_question(_request())

    assert question is not None
    assert messages.create_calls == []
    assert len(messages.stream_calls) == 1
    assert "tools" not in messages.stream_calls[0]


def test_question_tools_are_enabled_by_default(monkeypatch):
    migrate()
    messages = _FakeMessages(
        chunks=["What outcome matters?\n===META===\n", '{"sub":null,"options":null}']
    )
    brain_api = _install_client(monkeypatch, messages, tools=None)

    assert brain_api.ApiBrain().next_question(_request()) is not None

    assert messages.create_calls == []
    assert len(messages.stream_calls) == 1
    assert messages.stream_calls[0]["tools"]


def test_api_call_uses_cached_knowledge_system_blocks(monkeypatch):
    migrate()
    messages = _FakeMessages(
        chunks=["What outcome matters?\n===META===\n", '{"sub":null,"options":null}']
    )
    brain_api = _install_client(monkeypatch, messages, tools=False)
    blocks = [
        {"type": "text", "text": brain_api._SYSTEM},
        {
            "type": "text",
            "text": "stable org context",
            "cache_control": {"type": "ephemeral"},
        },
    ]
    monkeypatch.setattr(brain_api.knowledge, "system_blocks", lambda: blocks)

    assert brain_api.ApiBrain().next_question(_request()) is not None

    assert messages.stream_calls[0]["system"] is blocks


def test_api_call_keeps_plain_system_string_when_knowledge_is_empty(monkeypatch):
    migrate()
    messages = _FakeMessages(create_text='{"type":"enh","confidence":0.9}')
    brain_api = _install_client(monkeypatch, messages)
    monkeypatch.setattr(
        brain_api.knowledge,
        "system_blocks",
        lambda: [{"type": "text", "text": brain_api._SYSTEM}],
    )

    assert brain_api.ApiBrain().classify("Improve the report") == {
        "type": "enh",
        "confidence": 0.9,
    }

    assert messages.create_calls[0]["system"] == brain_api._SYSTEM


def test_summary_uses_low_effort_sonnet_without_sampling_params(monkeypatch):
    messages = _FakeMessages(
        chunks=[
            '{"overview":"A monthly reporting helper.",'
            '"sections":[{"title":"Core features / scope","items":["Show monthly totals"]}]}'
        ]
    )
    brain_api = _install_client(monkeypatch, messages)

    result = brain_api.ApiBrain().summarize(_request())

    assert result["overview"] == "A monthly reporting helper."
    call = messages.stream_calls[0]
    assert (call["model"], call["max_tokens"]) == ("claude-sonnet-5", 2048)
    assert call["thinking"] == {"type": "disabled"}
    assert call["output_config"] == {"effort": "low"}
    assert not ({"temperature", "top_p", "top_k"} & call.keys())


def test_prototype_streams_with_large_sonnet_budget(monkeypatch):
    # These two exercise the API brain's own fenced-block prototype contract, which is
    # now the non-default path: FACTORY_PROTOTYPE_VIA defaults to "cli" so the mock is
    # built as a file by the agent CLI. Pin the setting rather than deleting the tests —
    # the API contract is still live as the escape hatch.
    monkeypatch.setattr(settings, "PROTOTYPE_VIA", "api")
    messages = _FakeMessages(
        chunks=[
            "Built the reporting screen.\n===PROTO===\n"
            '{"mode":"rewrite","note":"First screen"}\n'
            "```html\n<html><body>Report</body></html>\n```"
        ]
    )
    brain_api = _install_client(monkeypatch, messages)

    result = brain_api.ApiBrain().generate_prototype(_request())

    assert result["mode"] == "rewrite"
    assert result["html"] == "<html><body>Report</body></html>"
    call = messages.stream_calls[0]
    assert (call["model"], call["max_tokens"]) == ("claude-sonnet-5", 32000)
    assert call["thinking"] == {"type": "disabled"}
    assert call["output_config"] == {"effort": "low"}


def test_draft_spec_uses_high_effort_opus_without_thinking(monkeypatch):
    messages = _FakeMessages(
        chunks=[
            '{"lines":[{"text":"Show monthly totals.","prov":"request","assume":false},'
            '{"text":"Use current finance definitions.","prov":null,"assume":true}],'
            '"open_note":"Confirm the finance definitions."}'
        ]
    )
    brain_api = _install_client(monkeypatch, messages)

    lines, note = brain_api.ApiBrain().draft_spec(_request())

    assert [line.text for line in lines] == [
        "Show monthly totals.",
        "Use current finance definitions.",
    ]
    assert note == "Confirm the finance definitions."
    call = messages.stream_calls[0]
    assert call["model"] == "claude-opus-4-8"
    assert call["output_config"] == {"effort": "high"}
    assert "thinking" not in call
    assert not ({"temperature", "top_p", "top_k"} & call.keys())


def test_api_image_attachment_becomes_base64_content_block(monkeypatch, tmp_path):
    from app import settings
    from app.models import Attachment

    messages = _FakeMessages(
        chunks=["What should the screenshot show?\n===META===\n{\"sub\":null,\"options\":null}"]
    )
    brain_api = _install_client(monkeypatch, messages)
    monkeypatch.setattr(settings, "UPLOADS", tmp_path)
    req = _request()
    req.id = 7101
    image = Attachment(
        request_id=req.id,
        filename="screen.png",
        mime="image/png",
        kind="image",
        size=8,
        stored="stored.png",
        source="describe",
    )
    document = Attachment(
        request_id=req.id,
        filename="requirements.pdf",
        mime="application/pdf",
        kind="doc",
        size=8,
        stored="stored.pdf",
        source="describe",
    )
    req.attachments = [image, document]
    request_dir = tmp_path / str(req.id)
    request_dir.mkdir()
    (request_dir / image.stored).write_bytes(b"png-data")
    (request_dir / document.stored).write_bytes(b"pdf-data")

    assert brain_api.ApiBrain().next_question(req) is not None

    content = messages.stream_calls[0]["messages"][0]["content"]
    image_blocks = [block for block in content if block["type"] == "image"]
    assert image_blocks == [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": "cG5nLWRhdGE=",
            },
        }
    ]
    text = next(block["text"] for block in content if block["type"] == "text")
    assert "requirements.pdf" in text
    assert "not inlined" in text


def test_brain_call_claim_is_unique_across_two_threads():
    migrate()
    from app.brain_calls import claim_call
    from app.models import BrainCall

    dedup_key = f"question:7102:{uuid.uuid4().hex}"
    barrier = threading.Barrier(2)
    claimed: list[int | None] = []

    def compete():
        barrier.wait()
        claimed.append(
            claim_call(
                request_id=None,
                kind="question",
                dedup_key=dedup_key,
                model="claude-sonnet-5",
            )
        )

    threads = [threading.Thread(target=compete) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sum(call_id is not None for call_id in claimed) == 1
    with SessionLocal() as db:
        count = db.scalar(
            select(func.count()).select_from(BrainCall).where(BrainCall.dedup_key == dedup_key)
        )
        assert count == 1


def test_failed_brain_call_claim_can_be_reclaimed():
    migrate()
    from app.brain_calls import claim_call, finish_call

    dedup_key = f"summary:7103:{uuid.uuid4().hex}"
    first = claim_call(
        request_id=None,
        kind="summary",
        dedup_key=dedup_key,
        model="claude-sonnet-5",
    )
    assert first is not None
    finish_call(first, success=False)

    second = claim_call(
        request_id=None,
        kind="summary",
        dedup_key=dedup_key,
        model="claude-sonnet-5",
    )

    # SQLite may reuse the deleted integer PK; the contract is reclaimability,
    # not monotonic claim ids.
    assert second is not None


def test_stale_running_brain_call_claim_can_be_reclaimed():
    migrate()
    from app.brain_calls import claim_call
    from app.models import BrainCall, utcnow

    dedup_key = f"escalation:7104:{uuid.uuid4().hex}"
    first = claim_call(
        request_id=None,
        kind="escalation",
        dedup_key=dedup_key,
        model="claude-haiku-4-5",
    )
    assert first is not None
    with SessionLocal() as db:
        row = db.get(BrainCall, first)
        row.created_at = utcnow() - timedelta(seconds=60)
        db.commit()

    second = claim_call(
        request_id=None,
        kind="escalation",
        dedup_key=dedup_key,
        model="claude-haiku-4-5",
        stale_after_seconds=30,
    )

    assert second is not None
    assert second != first


def test_live_fallback_claim_is_not_reclaimed_by_default():
    migrate()
    from app.brain_calls import active_call, claim_call, finish_call, record_api_call
    from app.models import utcnow

    dedup_key = f"question:7105:{uuid.uuid4().hex}"
    first = claim_call(
        request_id=None,
        kind="question",
        dedup_key=dedup_key,
        model="claude-sonnet-5",
    )
    assert first is not None
    with active_call(first):
        record_api_call(
            request_id=None,
            kind="question",
            model="claude-sonnet-5",
            status="fallback",
            tokens_in=None,
            tokens_out=None,
            ttft_ms=None,
            duration_ms=1,
            tool_rounds=None,
            created_at=utcnow(),
        )

    second = claim_call(
        request_id=None,
        kind="question",
        dedup_key=dedup_key,
        model="claude-sonnet-5",
    )
    finish_call(first, success=True)

    assert second is None


def test_retry_preserves_failed_attempt_telemetry():
    migrate()
    from app.brain_calls import active_call, claim_call, finish_call, record_api_call
    from app.models import BrainCall, utcnow

    dedup_key = f"escalation:7106:{uuid.uuid4().hex}"
    first = claim_call(
        request_id=None,
        kind="escalation",
        dedup_key=dedup_key,
        model="claude-haiku-4-5",
    )
    assert first is not None
    with active_call(first):
        record_api_call(
            request_id=None,
            kind="escalation",
            model="claude-haiku-4-5",
            status="fallback",
            tokens_in=123,
            tokens_out=45,
            ttft_ms=None,
            duration_ms=1,
            tool_rounds=None,
            created_at=utcnow(),
        )
    finish_call(first, success=False)

    second = claim_call(
        request_id=None,
        kind="escalation",
        dedup_key=dedup_key,
        model="claude-haiku-4-5",
        retry_after_seconds=0,
    )

    assert second is not None
    assert second != first
    with SessionLocal() as db:
        old = db.get(BrainCall, first)
        assert (old.tokens_in, old.tokens_out) == (123, 45)


def test_failed_brain_call_claim_honors_retry_cooldown():
    migrate()
    from app.brain_calls import claim_call, finish_call
    from app.models import BrainCall, utcnow

    dedup_key = f"escalation:7107:{uuid.uuid4().hex}"
    first = claim_call(
        request_id=None,
        kind="escalation",
        dedup_key=dedup_key,
        model="claude-haiku-4-5",
    )
    assert first is not None
    finish_call(first, success=False)

    assert (
        claim_call(
            request_id=None,
            kind="escalation",
            dedup_key=dedup_key,
            model="claude-haiku-4-5",
            retry_after_seconds=30,
        )
        is None
    )
    with SessionLocal() as db:
        row = db.get(BrainCall, first)
        row.finished_at = utcnow() - timedelta(seconds=60)
        db.commit()

    assert (
        claim_call(
            request_id=None,
            kind="escalation",
            dedup_key=dedup_key,
            model="claude-haiku-4-5",
            retry_after_seconds=30,
        )
        is not None
    )


def test_prototype_retry_records_each_api_call_while_generation_is_claimed(monkeypatch):
    monkeypatch.setattr(settings, "PROTOTYPE_VIA", "api")
    migrate()
    from app.brain_calls import active_call, claim_call, finish_call
    from app.models import BrainCall

    class _RetryMessages(_FakeMessages):
        def __init__(self):
            super().__init__()
            self.replies = [
                [
                    "Tried a local edit.\n===PROTO===\n"
                    '{"mode":"patch","ops":[{"find":"NOPE","replace":"x"}]}'
                ],
                [
                    "Rewrote the screen.\n===PROTO===\n"
                    '{"mode":"rewrite","note":"Applied the edit"}\n'
                    "```html\n<html><body>Updated</body></html>\n```"
                ],
            ]

        def stream(self, **kwargs):
            self.stream_calls.append(kwargs)
            return _FakeStream(self.replies.pop(0))

    messages = _RetryMessages()
    brain_api = _install_client(monkeypatch, messages)
    dedup_key = f"prototype:7104:{uuid.uuid4().hex}"
    call_id = claim_call(
        request_id=None,
        kind="prototype",
        dedup_key=dedup_key,
        model="claude-sonnet-5",
    )
    assert call_id is not None
    with SessionLocal() as db:
        before = db.scalar(
            select(func.count()).select_from(BrainCall).where(BrainCall.kind == "prototype")
        )

    with active_call(call_id):
        result = brain_api.ApiBrain().generate_prototype(
            _request(),
            instruction="Update the heading",
            current_html="<html><body>Original</body></html>",
        )
    finish_call(call_id, success=True)

    assert result["html"] == "<html><body>Updated</body></html>"
    assert len(messages.stream_calls) == 2
    with SessionLocal() as db:
        rows = list(db.scalars(select(BrainCall).where(BrainCall.kind == "prototype")))
        assert len(rows) == before + 1
        claim = db.get(BrainCall, call_id)
        assert claim is not None and claim.dedup_key == dedup_key
        retry = max((row for row in rows if row.id != call_id), key=lambda row: row.id)
        assert retry.dedup_key is None
        assert retry.status == "ok"
