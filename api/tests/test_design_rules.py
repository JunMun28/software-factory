"""The one design rule this codebase keeps breaking, made enforceable.

CLAUDE.md says:

    Never use the pale purple tint (--a50) as a background fill for
    selected/active/hover states (nav items, segmented controls, tabs, list
    rows, cards, drop zones). Use neutral surfaces instead: --surface-2
    background + --fg1 text, optionally inset 0 0 0 1px var(--border). Purple
    is reserved for the brand mark's dot, primary action buttons, and small
    semantic tags (.pill.purple, bot badges, toggle ON state).

It was written down and then violated in six places anyway, because a prose
rule in a docs file cannot fail a build. This can.

It lives in pytest rather than vitest for a boring reason worth recording: the
Angular unit-test builder intercepts `.css` imports and hands back an empty
string even with `?raw`, so a vitest guard could read component styles but not
the global stylesheets — where most of the violations were. pytest has plain
filesystem access and already scans repo files this way (see test_deploy_yaml).

The allowlist is exact and deliberate. A new purple fill fails this test until
someone comes here and justifies it, which is the point: tinting something
should be a conscious edit, not an accident.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIRS = [
    ROOT / "apps/intake/src",
    ROOT / "apps/console/src",
    ROOT / "packages/shared/src",
]

# `background` / `background-color` declarations only — not border, box-shadow,
# stroke or fill, which may legitimately carry the accent.
_BACKGROUND = re.compile(r"(?:^|[;{\s])background(?:-color)?\s*:[^;}]*")
# the pale purple tints; --accent-tint-bd is a BORDER token and must not match
_PURPLE = re.compile(r"--(?:a50|a100|accent-tint)\s*\)")

# repo-relative path -> (how many permitted fills, why)
ALLOWED: dict[str, tuple[int, str]] = {
    "apps/intake/src/styles.css": (
        3,
        ".pill.purple, .toggle.on, .smsg__bot — all three named in the rule",
    ),
    "apps/console/src/styles.css": (1, ".pill.purple — named in the rule"),
    "apps/console/src/app/dossier/dossier-page.ts": (
        1,
        ".app — a small read-only semantic tag",
    ),
    "apps/intake/src/app/submitter/my-requests.ts": (
        1,
        ".stage — a small read-only semantic tag",
    ),
    "apps/console/src/app/shared/gate-modals.ts": (
        1,
        "20px icon disc in a modal step list — decorative, not a state",
    ),
}


def _purple_backgrounds() -> list[tuple[str, int, str]]:
    """Every purple background fill in the frontend, as (file, line, text)."""
    hits: list[tuple[str, int, str]] = []
    for source_dir in SOURCE_DIRS:
        for path in sorted(source_dir.rglob("*")):
            if path.suffix not in {".css", ".ts"} or path.name.endswith(".spec.ts"):
                continue
            rel = str(path.relative_to(ROOT))
            for number, line in enumerate(path.read_text().splitlines(), start=1):
                for declaration in _BACKGROUND.findall(line):
                    if _PURPLE.search(declaration):
                        hits.append((rel, number, declaration.strip()))
    return hits


def test_scanner_actually_reads_source():
    """A broken scanner would make the rule check below vacuously green."""
    files = [p for d in SOURCE_DIRS for p in d.rglob("*") if p.suffix in {".css", ".ts"}]
    assert len(files) > 20, "found almost no frontend source — the paths are wrong"
    assert _purple_backgrounds(), "found no purple fills at all — the regex is wrong"


def test_purple_is_never_a_background_fill_for_ui_states():
    budget = {path: count for path, (count, _) in ALLOWED.items()}
    unexplained = []
    for rel, number, text in _purple_backgrounds():
        if budget.get(rel, 0) > 0:
            budget[rel] -= 1
        else:
            unexplained.append(f"{rel}:{number}  {text}")

    assert not unexplained, (
        "\nPurple background fill(s) not covered by the allowlist.\n\n"
        "CLAUDE.md: purple is reserved for the brand mark dot, primary action\n"
        "buttons, and small semantic tags. Selected / active / hover states use\n"
        "neutral surfaces — var(--surface-2) with var(--fg1) text, optionally\n"
        "box-shadow: inset 0 0 0 1px var(--border).\n\n"
        "If yours is genuinely a permitted semantic tag, add it to ALLOWED in\n"
        "api/tests/test_design_rules.py with the reason.\n\n" + "\n".join(unexplained)
    )


def test_allowlist_has_no_stale_entries():
    """Removing a tinted element should also require editing the allowlist."""
    found: dict[str, int] = {}
    for rel, _, _ in _purple_backgrounds():
        found[rel] = found.get(rel, 0) + 1
    stale = [
        f"{path} — allowlisted {count}, found {found.get(path, 0)}"
        for path, (count, _) in ALLOWED.items()
        if found.get(path, 0) < count
    ]
    assert not stale, "\nAllowlist entries no longer match reality; trim them:\n" + "\n".join(stale)


# ── the same rule, aimed at generated prototypes ──
#
# The tests above scan OUR source. A prototype is written by a model at runtime, so the
# only place the rule can be stated is the harness prompt. A live mock came back with a
# stat card filled in --accent-tint (2026-07-22) because the palette handed the model that
# token without ever saying what it was for.

def test_prototype_harness_forbids_purple_as_a_background_fill():
    from app.agent_brain import PROTOTYPE_HARNESS

    assert "PURPLE IS NEVER A BACKGROUND FILL" in PROTOTYPE_HARNESS
    # names the surfaces that ARE allowed, so "not purple" has an answer
    for token in ("--bg", "--surface", "--surface-2"):
        assert token in PROTOTYPE_HARNESS
    # and names the element that actually went wrong
    assert "stat" in PROTOTYPE_HARNESS.lower()


def test_prototype_harness_says_what_accent_tint_is_for():
    """An unexplained token in the palette is an invitation to misuse it."""
    from app.agent_brain import PROTOTYPE_HARNESS

    tint = PROTOTYPE_HARNESS[PROTOTYPE_HARNESS.index("--accent-tint exists"):][:200]
    assert "tag or badge" in tint


# ── and enforced, because the prompt alone did not hold ──

def test_purple_tint_fills_are_demoted_to_a_neutral_surface():
    """Live evidence (2026-07-22): even with the rule spelled out in the harness, a
    generated mock came back with three stat cards filled in --accent-tint."""
    from app.agent_brain import _scrub_html

    out = _scrub_html(
        "<style>.stat{background:var(--accent-tint);}"
        ".panel{background-color: var( --accent-tint );}"
        ".dark{background:#2a1140}.light{background:#fbe9fe}</style>"
    )
    assert "--accent-tint" not in out
    assert "#2a1140" not in out and "#fbe9fe" not in out
    assert out.count("var(--surface-2)") == 4


def test_the_primary_action_keeps_its_accent():
    """--accent reads as an ACTION, not a surface — one primary button is exactly where
    the accent is meant to be spent, so it must survive the scrub."""
    from app.agent_brain import _scrub_html

    out = _scrub_html("<style>.btn{background:var(--accent);}.btn:hover{background:var(--accent-strong)}</style>")
    assert "var(--accent)" in out and "var(--accent-strong)" in out


def test_accent_survives_where_it_is_not_a_fill():
    """Text, borders and shadows may carry the accent — only fills are the problem."""
    from app.agent_brain import _scrub_html

    css = "<style>.n{color:var(--accent-tx);border:1px solid var(--accent-tint)}</style>"
    assert _scrub_html(css) == css
