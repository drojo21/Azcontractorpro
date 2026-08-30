#!/usr/bin/env python3
"""
new_client.py — create clients/<id>/client.json from the ROC data.

    python3 scripts/new_client.py --roc 337881
    python3 scripts/new_client.py --search "rojo"            # find the row first
    python3 scripts/new_client.py --roc 337881 --tier full
    python3 scripts/new_client.py --block info.txt           # CLIENT INFO BLOCK file

Then edit the JSON if you want (services, tagline, email...), commit, push.
The deploy workflow does the rest.
"""
import argparse, csv, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))
from acp_schema import ACP, digits  # noqa: E402

DATA = [ROOT / "data" / "buildable-tucson.csv", ROOT / "data" / "buildable-statewide.csv",
        ROOT / "data" / "tucson-prospects.csv"]


def rows():
    for f in DATA:
        if f.exists():
            with f.open(newline="", encoding="utf-8-sig") as fh:
                for r in csv.DictReader(fh):
                    yield f.name, r


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--roc", help="ROC licence number")
    ap.add_argument("--search", help="substring of the business name")
    ap.add_argument("--block", help="path to a CLIENT INFO BLOCK text file")
    ap.add_argument("--tier", choices=["lite", "full"])
    ap.add_argument("--force", action="store_true", help="overwrite an existing client.json")
    a = ap.parse_args()

    acp = ACP()
    cfg = json.loads((ROOT / "config" / "acp.json").read_text())
    tier = a.tier or cfg.get("default_tier", "lite")

    if a.search:
        hits = [(src, r) for src, r in rows() if a.search.lower() in r.get("business_name", "").lower()]
        for src, r in hits[:25]:
            print(f"{r.get('roc_number',''):>8}  {r.get('license_class',''):<6} {r.get('city',''):<14} {r.get('business_name','')}   [{src}]")
        if not hits:
            print("no matches")
        return

    if a.block:
        client = acp.from_client_info_block(Path(a.block).read_text())
    elif a.roc:
        want = digits(a.roc)
        match = next((r for _, r in rows() if digits(r.get("roc_number", "")) == want), None)
        if not match:
            sys.exit(f"ROC #{want} not found in data/*.csv — try --search, or --block for a hand-built record")
        client = acp.from_roc_row(match)
        # Columns the roster already resolved — keep them.
        for k in ("client_id", "owner_first_name", "trade", "trade_confidence"):
            if match.get(k):
                client[k] = match[k]
    else:
        ap.error("give --roc, --search or --block")

    # ROC exports shout. "D.E.A.L.S ENTERPRISES LLC" -> "D.E.A.L.S Enterprises LLC"
    name = client.get("business_name", "")
    if name.isupper():
        keep = {"LLC", "INC", "INC.", "CO", "CO.", "L.L.C.", "DBA", "HVAC", "AZ", "II", "III"}
        client["business_name"] = " ".join(w if w in keep or "." in w[:-1] else w.capitalize() for w in name.split())
    client["tier"] = tier
    client = acp.resolve(client)
    # Platform-level integrations, so every site posts leads to the router.
    integ = client.setdefault("integrations", {})
    integ["lead_endpoint"] = integ.get("lead_endpoint") or cfg.get("apps_script_url", "")
    integ["gallery_endpoint"] = integ.get("gallery_endpoint") or cfg.get("apps_script_url", "")

    dest = ROOT / "clients" / client["client_id"] / "client.json"
    if dest.exists() and not a.force:
        sys.exit(f"{dest} already exists (use --force to overwrite)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(acp.dumps(client) + "\n")

    for p in acp.validate(client):
        print(f"  {p['level'].upper():5} {p['field']}: {p['message']}")
    print(f"\nwrote {dest.relative_to(ROOT)}  (tier={tier}, trade={client['trade']}/{client.get('trade_confidence','')})")
    print("next: edit if needed, then  git add clients && git commit -m 'add", client["client_id"], "' && git push")


if __name__ == "__main__":
    main()
