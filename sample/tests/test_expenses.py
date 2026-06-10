from expenses import by_category, total


def test_total_sums_and_rounds():
    assert total([1.10, 2.205]) == 3.31


def test_by_category_groups():
    items = [
        {"category": "travel", "amount": 10.0},
        {"category": "meals", "amount": 5.5},
        {"category": "travel", "amount": 2.5},
    ]
    assert by_category(items) == {"travel": 12.5, "meals": 5.5}
