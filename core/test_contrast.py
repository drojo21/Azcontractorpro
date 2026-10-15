#!/usr/bin/env python3
"""
test_contrast.py — every trade theme has to stay readable.

The templates used to hardcode `color:#111` on the accent and `color:#fff` on
the primary, and painted accent text straight onto primary backgrounds. Across
the 30 trades in trade_defaults.json that produced 52 colour pairs below the
4.5:1 WCAG AA bar for normal text: the eyebrow colour failed on 19 of 30, as
low as 2.18:1, and `#111` on the flooring accent was 3.84:1.

resolve() now derives on_primary / on_primary_dark / on_accent / accent_on_light
/ accent_on_dark instead of assuming. This checks two things:

  1. every trade clears 4.5:1 on every pair the templates actually paint, and
  2. base.html has not gone back to hardcoding ink on a brand background,

because (2) is how (1) would silently come undone.

    python3 core/test_contrast.py
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from acp_schema import ACP, contrast_ratio  # noqa: E402

AA_NORMAL = 4.5
TEMPLATE = HERE.parent / "builder" / "templates" / "base.html"

# (label, foreground theme key, background theme key or literal). Each one is a
# place base.html actually puts text on a coloured ground.
PAIRS = [
    ("ink on accent (.btn-accent, .call, .mcall, .checks)", "on_accent", "accent"),
    ("ink on primary (.btn-primary, .chip, .totop, .hero)", "on_primary", "primary"),
    ("ink on primary-dark (header, .stat div, .contact)", "on_primary_dark", "primary_dark"),
    ("accent as text on white (.eyebrow, summary, .stars)", "accent_on_light", "#ffffff"),
    ("accent as text on primary-dark (.stat strong, .contact-info a, .hero .tag)",
     "accent_on_dark", "primary_dark"),
]


def main() -> int:
    acp = ACP()
    failures = []
    trades = sorted(acp.defaults["trades"])

    for trade in trades:
        client = acp.resolve({
            "business_name": f"{trade} test", "trade": trade, "roc_number": "123456",
            "phone": "(602) 555-0100", "city": "Mesa", "zip": "85201",
            "roc_status": "Active", "tier": "lite",
        })
        theme = client["theme"]
        for label, fg_key, bg_key in PAIRS:
            fg = theme[fg_key]
            bg = bg_key if bg_key.startswith("#") else theme[bg_key]
            ratio = contrast_ratio(fg, bg)
            if ratio < AA_NORMAL:
                failures.append(f"{trade:<15} {ratio:>5.2f}:1  {label}  ({fg} on {bg})")

    print(f"  {len(trades)} trades x {len(PAIRS)} pairs = {len(trades) * len(PAIRS)} combinations")

    # A future edit putting #fff or #111 back on a brand background would undo
    # all of the above without failing anything else, so look for it directly.
    hardcoded = []
    if TEMPLATE.exists():
        css = TEMPLATE.read_text(encoding="utf-8")
        for m in re.finditer(r"var\(--(?:primary|accent)[a-z-]*\);color:#(?:fff|111|000|ffffff|111111)\b", css):
            line = css[:m.start()].count("\n") + 1
            hardcoded.append(f"base.html:{line}  {m.group(0)}")
    else:
        print(f"  ! {TEMPLATE} not found, skipping the template check")

    print()
    if failures:
        print(f"FAIL — {len(failures)} pair(s) below {AA_NORMAL}:1")
        for f in failures:
            print(f"  {f}")
    if hardcoded:
        print(f"FAIL — ink hardcoded on a brand background in {len(hardcoded)} place(s).")
        print("       Use var(--on-accent) / var(--on-primary) / var(--on-primary-dark).")
        for h in hardcoded:
            print(f"  {h}")

    if failures or hardcoded:
        return 1

    print("=" * 62)
    print(f"PASS — every trade clears {AA_NORMAL}:1 on every painted pair")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
