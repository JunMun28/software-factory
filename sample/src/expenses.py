"""Northwind Expenses — the sample Subject's tiny domain module."""


def total(amounts: list[float]) -> float:
    """Sum a list of expense amounts."""
    return round(sum(amounts), 2)


def by_category(items: list[dict]) -> dict[str, float]:
    """Group expense items ({'category', 'amount'}) into per-category totals."""
    out: dict[str, float] = {}
    for item in items:
        out[item["category"]] = round(out.get(item["category"], 0.0) + item["amount"], 2)
    return out
