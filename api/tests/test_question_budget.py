from app.interview import question_budget


def test_bug_ceiling_is_three():
    assert question_budget("bug") == (2, 3)


def test_enhancement_ceiling_is_four():
    assert question_budget("enh") == (2, 4)


def test_other_ceiling_is_four():
    assert question_budget("other") == (2, 4)


def test_new_app_is_effectively_uncapped():
    floor, ceiling = question_budget("new")
    assert floor == 3
    assert ceiling >= 50  # the model's judgment + conversational stop are the real limits
