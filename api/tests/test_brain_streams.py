import asyncio

from app.routers import requests as requests_router


def test_meta_marker_is_never_relayed_even_when_split_across_chunks():
    from app import brain_streams

    events: list[dict] = []
    unsubscribe = brain_streams.subscribe("interview", 73, events.append)
    relay = brain_streams.prose_relay("interview", 73, "===META===")
    try:
        relay.feed("What matters most?\n===ME")
        relay.feed('TA===\n{"sub":null}')
        relay.finish()
    finally:
        unsubscribe()

    assert "".join(event["text"] for event in events) == "What matters most?\n"
    assert all(event["type"] == "delta" for event in events)
    assert "===META===" not in str(events)


def test_sse_response_relays_delta_events_before_terminal_state():
    from app import brain_streams

    def worker(rid, queue, loop):
        brain_streams.publish_delta("interview", rid, "Hello ")
        brain_streams.publish_delta("interview", rid, "there")
        loop.call_soon_threadsafe(
            queue.put_nowait,
            {"type": "state", "state": {"question": "Hello there", "thinking": False}},
        )

    async def collect() -> str:
        response = requests_router._sse_response(74, worker, stream_kind="interview")
        chunks: list[str] = []
        async for chunk in response.body_iterator:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
        return "".join(chunks)

    body = asyncio.run(collect())

    assert body.index("event: delta") < body.index("event: state")
    assert 'data: {"text": "Hello "}' in body
    assert 'data: {"text": "there"}' in body
    assert 'data: {"question": "Hello there", "thinking": false}' in body
