from app.interview import question_budget


def test_bug_ceiling_is_three():
    assert question_budget("bug") == (2, 3)


def test_enhancement_ceiling_is_four():
    assert question_budget("enh") == (2, 4)


def test_other_ceiling_is_four():
    assert question_budget("other") == (2, 4)


def test_new_app_is_capped_at_ten():
    # Was uncapped (a 99 sentinel). Capped because the New track continues in the
    # Prototype step — the interview only has to reach a first mock, and a grill that
    # outlasts the submitter costs more than the detail it collects.
    assert question_budget("new") == (3, 10)
