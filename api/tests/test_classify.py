from app.interview import ScriptedBrain

brain = ScriptedBrain()


def test_bug_keywords_classify_as_bug_with_confidence():
    r = brain.classify("The export button is broken and throws an error every time")
    assert r["type"] == "bug"
    assert r["confidence"] >= 0.6


def test_enhancement_keywords_classify_as_enh():
    r = brain.classify("Please add a bulk-export option to the existing reports page")
    assert r["type"] == "enh"


def test_new_app_keywords_classify_as_new():
    r = brain.classify("Build a brand-new tool to track warehouse inventory from scratch")
    assert r["type"] == "new"


def test_vague_description_is_low_confidence():
    r = brain.classify("not sure yet, need to think about it")
    assert 0.0 <= r["confidence"] <= 0.5


def test_empty_description_defaults_to_new_low_confidence():
    r = brain.classify("")
    assert r["type"] == "new"
    assert r["confidence"] == 0.0
