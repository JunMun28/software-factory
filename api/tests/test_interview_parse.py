"""The prose-first interview reply parser (`_parse_reply`).

The intake brain replies prose-first — the question text, then a ===META=== marker and a JSON
tail with sub/options — and this parser is what turns that into a Question (or the done signal),
including stripping options the model restated inline in the prose. Used by the batch
`AgentBrain.next_question`.
"""
from app.agent_brain import _parse_reply


def test_parse_prose_first():
    q, done = _parse_reply(
        'How often does it fail?\n===META===\n{"sub":"hint","options":[{"t":"a","d":"b"}]}',
        final=False,
    )
    assert done is False
    assert q.question == "How often does it fail?" and q.sub == "hint"
    assert q.options == [{"t": "a", "d": "b"}]


def test_parse_bare_json_legacy():
    q, done = _parse_reply('{"question":"Who uses it?","sub":null,"options":null}', final=True)
    assert q.question == "Who uses it?" and q.final is True and done is False


def test_parse_done_signal():
    q, done = _parse_reply('===META===\n{"done": true}', final=False)
    assert q is None and done is True


def test_parse_garbage_is_no_question():
    q, done = _parse_reply("...nothing parseable here...", final=False)
    assert q is None and done is False


def test_parse_strips_options_restated_in_prose():
    # the model leaked the options inline (a " - **t:/d:" run) before the marker
    reply = (
        "What platform should FretJourney run on? - **t: Web app**, d: anywhere "
        "- **t: Mobile app**, d: native feel\n"
        '===META===\n{"options":[{"t":"Web app","d":"anywhere"},{"t":"Mobile app","d":"native feel"}]}'
    )
    q, done = _parse_reply(reply, final=False)
    assert q.question == "What platform should FretJourney run on?"  # only the lead question
    assert [o["t"] for o in q.options] == ["Web app", "Mobile app"]
