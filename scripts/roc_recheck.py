#!/usr/bin/env python3
"""
roc_recheck.py — re-verify the licence behind every site we have published.

A site published today for a valid licence keeps saying "Licensed · Bonded ·
Insured" long after that licence lapses. Nothing in the build path catches it:
the claim was true when it shipped and nobody looks again. This is that second
look, and it is the reason the posting list beats a live lookup for this job —
a licence that has lapsed since the last snapshot simply is not in the new file,
so re-verification is a set difference rather than one query per client.

    python3 scripts/roc_recheck.py                 # report, exit 1 on a problem
    python3 scripts/roc_recheck.py --update        # also write status back
    python3 scripts/roc_recheck.py --expiring 60   # widen the warning window

Exit status is 1 when any published client's licence is no longer active, so a
scheduled run fails loudly instead of reporting into an empty room.
"""
import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))
from roc_active import ROCActive, digits  # noqa: E402


def is_published(client) -> bool:
    dep = client.get("deploy") or {}
    return bool(dep.get("netlify_url") or dep.get("netlify_site_id"))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--update", action="store_true",
                    help="write the re-checked status back into client.json")
    ap.add_argument("--expiring", type=int, default=45, metavar="DAYS",
                    help="warn when a licence expires within this many days (default 45)")
    ap.add_argument("--all", action="store_true",
                    help="check every client, not just published ones")
    a = ap.parse_args()

    roster = ROCActive()
    today = date.today()
    soon = today + timedelta(days=a.expiring)
    age = roster.age_days(today)

    print(f"ROC active list: {len(roster)} licences, snapshot {roster.snapshot_date} "
          f"({age} days old)")
    if age > 30:
        print(f"  WARNING: snapshot is {age} days old — refresh data/roc-active.csv.gz "
              "before trusting a clean result")
    print()

    lapsed, expiring, ok, skipped = [], [], [], []
    for path in sorted((ROOT / "clients").glob("*/client.json")):
        try:
            c = json.loads(path.read_text())
        except json.JSONDecodeError as e:
            skipped.append((path.parent.name, f"unreadable client.json: {e}"))
            continue
        if not (a.all or is_published(c)):
            continue
        roc = digits(c.get("roc_number", ""))
        if not roc:
            skipped.append((c.get("client_id", path.parent.name), "no roc_number on record"))
            continue

        rec = roster.get(roc)
        entry = (c.get("client_id", path.parent.name), roc, c.get("business_name", ""),
                 (c.get("deploy") or {}).get("netlify_url", ""))
        if not rec:
            lapsed.append(entry)
            if a.update:
                c["roc_status"] = "Not on active list"
                c.setdefault("roc_verified", {}).update(
                    {"source": "azroc posting list", "snapshot_date": str(roster.snapshot_date),
                     "verified_at": today.isoformat(), "result": "absent"})
                path.write_text(json.dumps(c, indent=2, ensure_ascii=False) + "\n")
            continue

        exp = roster.expires_on(roc)
        if exp and exp <= soon:
            expiring.append(entry + (exp,))
        else:
            ok.append(entry)
        if a.update:
            c["roc_status"] = rec["roc_status"] or "Active"
            c.setdefault("roc_verified", {}).update(
                {"source": "azroc posting list", "snapshot_date": str(roster.snapshot_date),
                 "verified_at": today.isoformat(), "expiration_date": rec["expiration_date"],
                 "result": "active"})
            path.write_text(json.dumps(c, indent=2, ensure_ascii=False) + "\n")

    if lapsed:
        print(f"NOT ON THE ACTIVE LIST — {len(lapsed)} published site(s) claiming licensure:")
        for cid, roc, biz, url in lapsed:
            print(f"   ROC {roc:>8}  {biz[:38]:40} {cid}")
            if url:
                print(f"{'':13}{url}")
        print("   Take these down or correct them: each one asserts 'Licensed · Bonded ·")
        print("   Insured' and links to an azroc.gov page that no longer backs the claim.\n")

    if expiring:
        print(f"EXPIRING within {a.expiring} days — {len(expiring)}:")
        for cid, roc, biz, url, exp in sorted(expiring, key=lambda x: x[4]):
            print(f"   ROC {roc:>8}  expires {exp}  {biz[:34]:36} {cid}")
        print()

    for cid, why in skipped:
        print(f"SKIPPED  {cid}: {why}")
    if skipped:
        print()

    print(f"checked {len(ok) + len(expiring) + len(lapsed)} client(s): "
          f"{len(ok)} active, {len(expiring)} expiring soon, {len(lapsed)} lapsed")
    if a.update:
        print("status written back into client.json")
    return 1 if lapsed else 0


if __name__ == "__main__":
    sys.exit(main())
