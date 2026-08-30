#!/usr/bin/env python3
"""
triage_roster.py — run a full ROC export through the schema and sort it.

A ROC export carries no phone, email, or website column, so no row in it can
produce a publishable site as-is. This script makes that concrete: it converts
every row, classifies readiness, and writes the work queues.

    python3 triage_roster.py ROC_export.csv --out ./triage \
        --metro tucson --exclude-out-of-state

Outputs
    prospects.csv      needs contact enrichment before anything can be built
    ready.json         records that could be built today (rare from raw ROC)
    review.json        low-confidence trade inference — check before publishing
    summary.txt        counts by trade, city, and readiness
"""

import argparse
import collections
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from acp_schema import ACP, map_headers  # noqa: E402

METROS = {
    "tucson": ["Tucson", "Oro Valley", "Marana", "Vail", "Sahuarita", "Green Valley",
               "Catalina", "Catalina Foothills", "Corona De Tucson", "Rio Rico",
               "Nogales", "Benson", "Sierra Vista", "Tubac", "Continental Ranch"],
    "phoenix": ["Phoenix", "Mesa", "Glendale", "Scottsdale", "Gilbert", "Chandler",
                "Peoria", "Tempe", "Surprise", "Goodyear", "Avondale", "Buckeye",
                "Queen Creek", "Maricopa", "Apache Junction", "Sun City"],
}


def read_roc(path: Path):
    """ROC exports carry a title line above the real header row."""
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    start = 0
    for i, line in enumerate(lines[:5]):
        if line.count(",") >= 5:
            start = i
            break
    return list(csv.DictReader(lines[start:]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--out", default="./triage")
    ap.add_argument("--metro", choices=sorted(METROS), help="restrict to one metro")
    ap.add_argument("--exclude-out-of-state", action="store_true")
    ap.add_argument("--trade", action="append", help="restrict to trade(s)")
    ap.add_argument("--tier", choices=["lite", "full"], default="lite")
    args = ap.parse_args()

    acp = ACP()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = read_roc(Path(args.csv))
    if not rows:
        sys.exit("no rows parsed — check the header row")
    hm = map_headers(list(rows[0].keys()))

    kept, dropped = [], collections.Counter()
    metro_cities = {c.lower() for c in METROS[args.metro]} if args.metro else None

    for row in rows:
        client = acp.from_roc_row(row, hm)

        if args.exclude_out_of_state and client["state"] != "AZ":
            dropped["out of state"] += 1
            continue
        if metro_cities and client["city"].strip().lower() not in metro_cities:
            dropped["outside metro"] += 1
            continue
        if args.trade and client["trade"] not in args.trade:
            dropped["trade filter"] += 1
            continue

        client["tier"] = args.tier
        kept.append(acp.resolve(client))

    prospects, ready, review = [], [], []
    for c in kept:
        state, missing = acp.readiness(c)
        c["_readiness"] = state
        c["_missing"] = missing
        if c.get("trade_confidence") == "low":
            review.append(c)
        elif state == "prospect":
            prospects.append(c)
        else:
            ready.append(c)

    # Prospect queue is a CSV because the next step is human/vendor enrichment.
    with (out_dir / "prospects.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["client_id", "business_name", "trade", "license_class",
                    "roc_number", "city", "zip", "owner", "issued",
                    "missing", "phone", "email", "website"])
        for c in prospects:
            owner = c["owner"] if "could not find" not in c["owner"].lower() else ""
            w.writerow([c["client_id"], c["business_name"], c["trade"],
                        c["license_class"], c["roc_number"], c["city"], c["zip"],
                        owner, "", "|".join(c["_missing"]), "", "", ""])

    (out_dir / "ready.json").write_text(ACP.dumps(ready), encoding="utf-8")
    (out_dir / "review.json").write_text(ACP.dumps(review), encoding="utf-8")

    by_trade = collections.Counter(c["trade"] for c in kept)
    by_city = collections.Counter(c["city"].title() for c in kept)
    lines = [
        f"source            {args.csv}",
        f"rows in file      {len(rows)}",
        f"rows kept         {len(kept)}",
        *[f"  dropped: {k:16} {v}" for k, v in dropped.most_common()],
        "",
        f"prospects (need contact info)  {len(prospects)}",
        f"ready to build                 {len(ready)}",
        f"needs trade review             {len(review)}",
        "",
        "by trade:",
        *[f"  {t:16} {n}" for t, n in by_trade.most_common()],
        "",
        "top cities:",
        *[f"  {c:20} {n}" for c, n in by_city.most_common(15)],
    ]
    summary = "\n".join(lines)
    (out_dir / "summary.txt").write_text(summary + "\n", encoding="utf-8")
    print(summary)


if __name__ == "__main__":
    main()
