#!/usr/bin/env python3
"""
demo_request.py — turn a free-demo request from azcontractorpro.com into
clients/<id>/client.json so the normal build → publish flow ships it.

    python3 scripts/demo_request.py --payload '{"name":"Luis Rojo","business":"...","roc":"337881",...}'
    python3 scripts/demo_request.py --payload-file request.json

The payload is what the sales-site demo form posts to the Apps Script router,
forwarded verbatim through a GitHub `repository_dispatch` (event type
`demo-request`). Fields used: lead_id, name, business, roc, service (trade),
city, phone, email, message.

Resolution order for the business record:
  1. ROC number found in data/*.csv        -> acp.from_roc_row (real ROC data)
  2. business name resolves in data/*.csv  -> acp.from_roc_row (real ROC data)
  3. a ROC number was given but is unknown -> CLIENT INFO BLOCK built from the payload
  4. neither                               -> refused, see below

Licensure: every built page asserts "Licensed, bonded and insured" and carries a
ROC credential in its JSON-LD, so a demo is only built when a ROC number can be
cited — from the roster or from the prospect. A request with no ROC number that
the roster cannot resolve is refused rather than published with an invented one.

The result is a tier=lite site with deploy.demo=true, which makes the builder
add the demo banner, the "keep this site" section with checkout buttons, and
noindex. The prospect's contact is kept in deploy.demo_contact so the workflow
can tell the Apps Script who to email when the site is live.

Safety: an existing client.json that is NOT a demo is never overwritten — a
paying client's record wins over a stray form submission with the same name.
Prints the client_id on stdout (last line) for the workflow to pick up.
"""
import argparse, csv, json, os, re, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))
from acp_schema import ACP, digits, slugify  # noqa: E402

DATA = [ROOT / "data" / "buildable-tucson.csv", ROOT / "data" / "buildable-statewide.csv",
        ROOT / "data" / "tucson-prospects.csv"]

# Central ZIP per city, used only when the request carries no ZIP. The schema
# requires one for LocalBusiness schema; the demo copy never shows it.
CITY_ZIP = {
    "tucson": "85701", "oro valley": "85737", "marana": "85653", "vail": "85641",
    "sahuarita": "85629", "green valley": "85614", "catalina foothills": "85718",
    "phoenix": "85004", "mesa": "85201", "chandler": "85224", "gilbert": "85234",
    "scottsdale": "85251", "tempe": "85281", "glendale": "85301", "peoria": "85345",
    "surprise": "85374", "goodyear": "85338", "avondale": "85323", "buckeye": "85326",
    "queen creek": "85142", "casa grande": "85122", "flagstaff": "86001",
    "prescott": "86301", "yuma": "85364", "sierra vista": "85635", "kingman": "86401",
    "lake havasu city": "86403", "bullhead city": "86442", "nogales": "85621",
}

TRADE_WORDS = {
    "masonry / hardscape": "masonry", "masonry": "masonry", "concrete": "concrete",
    "landscaping": "landscaping", "electrical": "electrical", "plumbing": "plumbing",
    "hvac": "hvac", "roofing": "roofing", "painting": "painting", "flooring": "flooring",
    "fencing": "fencing", "general contracting": "general", "handyman (exempt)": "general",
}


def find_roc_row(roc: str):
    want = digits(roc)
    if not want:
        return None
    for f in DATA:
        if not f.exists():
            continue
        with f.open(newline="", encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                if digits(r.get("roc_number", "")) == want:
                    return r
    return None


def norm_business(name: str) -> str:
    """Normalized business name for roster matching: case, punctuation and the
    entity suffix are noise ("Vega Custom Concrete, LLC." == "VEGA CUSTOM CONCRETE LLC")."""
    n = re.sub(r"[^a-z0-9 ]", " ", str(name or "").lower())
    n = re.sub(r"\b(llc|l l c|inc|incorporated|co|company|corp|corporation|ltd|dba)\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def find_business_row(business: str):
    """Resolve a name-only request against the ROC roster.

    Strict on purpose: only an exact normalized match counts, and an ambiguous
    name (two licensees normalizing the same) returns nothing. Attaching the
    wrong contractor's licence to a prospect is its own honesty problem, so a
    near-miss must fail closed rather than guess.
    """
    want = norm_business(business)
    if not want:
        return None
    hits = []
    for f in DATA:
        if not f.exists():
            continue
        with f.open(newline="", encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                if norm_business(r.get("business_name", "")) == want:
                    hits.append(r)
    # The rosters overlap (a Tucson licensee is also in the statewide file), so
    # collapse on the licence number first: same ROC means one licensee, not an
    # ambiguity. Genuinely different licensees sharing a name still fail closed.
    if hits and len({digits(h.get("roc_number", "")) for h in hits}) == 1:
        return hits[0]
    return None


def title_case(name: str) -> str:
    if not name.isupper():
        return name
    keep = {"LLC", "INC", "INC.", "CO", "CO.", "L.L.C.", "DBA", "HVAC", "AZ", "II", "III"}
    return " ".join(w if w in keep or "." in w[:-1] else w.capitalize() for w in name.split())


def clean(v, n=300):
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--payload", help="JSON string")
    g.add_argument("--payload-file", help="path to a JSON file")
    ap.add_argument("--force", action="store_true", help="overwrite even a non-demo client.json")
    a = ap.parse_args()

    payload = json.loads(a.payload if a.payload else Path(a.payload_file).read_text())
    acp = ACP()
    cfg = json.loads((ROOT / "config" / "acp.json").read_text())

    name = clean(payload.get("name"))
    business = clean(payload.get("business"))
    roc = digits(clean(payload.get("roc")))
    phone = clean(payload.get("phone"), 40)
    email = clean(payload.get("email"), 120)
    city = clean(payload.get("city"), 60) or "Tucson"
    trade_in = clean(payload.get("service") or payload.get("trade")).lower()
    trade = TRADE_WORDS.get(trade_in) or acp.normalize_trade(trade_in) or ""
    if not (business or roc):
        sys.exit("demo request needs a business name or a ROC number")

    # A prospect who types only their business name still gets a demo built from
    # their real ROC record, provided the roster resolves the name unambiguously.
    row = find_roc_row(roc) if roc else None
    if row is None and business:
        row = find_business_row(business)
    if row:
        client = acp.from_roc_row(row)
        for k in ("client_id", "owner_first_name", "trade", "trade_confidence"):
            if row.get(k):
                client[k] = row[k]
        source = f"ROC data ({row.get('roc_number')})"
        # The prospect's own contact beats whatever the roster had.
        if phone:
            client["phone"] = phone
        if email:
            client["email"] = email
        if name and not client.get("owner"):
            client["owner"] = name
        if trade:
            client["trade"] = trade
            client["trade_confidence"] = "high"
    else:
        block = {
            "BUSINESS_NAME": business or f"ROC #{roc}",
            "OWNER_NAME": name,
            "ROC_NUMBER": roc,
            "PHONE": phone,
            "EMAIL": email,
            "CITY": city,
            "STATE": "AZ",
            "ZIP": clean(payload.get("zip"), 10) or CITY_ZIP.get(city.lower(), "85701"),
            "TRADE": trade,
            "TAGLINE": "auto",
        }
        client = acp.from_client_info_block(block)
        source = "form (not in ROC data)"
        if not roc:
            # No licence number, and the roster does not know this business. Every
            # page the builder emits asserts licensure — "Licensed, bonded and
            # insured", a ROC credential in the JSON-LD, and an azroc.gov verify
            # link — so building here would publish a claim about a real, named
            # business that nobody has checked. Forcing roc_status to "Active" to
            # satisfy the publish gate is exactly the exposure that gate exists to
            # stop (backend/netlify/functions/deploy.js). Refuse instead: the lead
            # is already captured, so this becomes a follow-up by hand.
            sys.exit(
                f"{business or name}: no ROC number given and the business is not in the ROC "
                "roster — refusing to build a demo that would claim licensure we cannot verify. "
                "Ask the prospect for their ROC number and re-run, or build it by hand."
            )

    if not client.get("zip"):
        client["zip"] = CITY_ZIP.get(str(client.get("city", "")).lower(), "85701")
    if not client.get("phone") and phone:
        client["phone"] = phone
    client["business_name"] = title_case(client.get("business_name") or business)
    client["tier"] = "lite"
    client = acp.resolve(client)

    integ = client.setdefault("integrations", {})
    integ["lead_endpoint"] = cfg.get("apps_script_url", "")
    integ["gallery_endpoint"] = cfg.get("apps_script_url", "")
    # Demo leads go to the prospect AND to us, so nothing is lost while they decide.
    integ["notification_email"] = email or integ.get("notification_email", "")

    dep = client.setdefault("deploy", {})
    dep["demo"] = True
    dep["demo_source"] = source
    dep["demo_requested_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    dep["demo_contact"] = {"lead_id": clean(payload.get("lead_id"), 40), "name": name,
                           "email": email, "phone": phone}

    # A real (non-demo) client with this ROC number already exists under any id:
    # never spin up a demo that competes with a paying customer's site.
    if roc and not a.force:
        for other in (ROOT / "clients").glob("*/client.json"):
            try:
                o = json.loads(other.read_text())
            except json.JSONDecodeError:
                continue
            if digits(o.get("roc_number", "")) == roc and not (o.get("deploy") or {}).get("demo"):
                sys.exit(f"ROC #{roc} already belongs to real client {o.get('client_id')} — refusing to build a demo")

    dest = ROOT / "clients" / client["client_id"] / "client.json"
    if dest.exists() and not a.force:
        existing = json.loads(dest.read_text())
        if not (existing.get("deploy") or {}).get("demo"):
            sys.exit(f"{dest} exists and is not a demo — refusing to overwrite a real client")
        # Rebuilding an existing demo: keep its Netlify site so the URL stays stable.
        for k in ("netlify_site_id", "netlify_url", "claim_url", "session_id"):
            if existing.get("deploy", {}).get(k):
                dep[k] = existing["deploy"][k]

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(acp.dumps(client) + "\n")
    for p in acp.validate(client):
        print(f"  {p['level'].upper():5} {p['field']}: {p['message']}", file=sys.stderr)
    print(f"wrote {dest.relative_to(ROOT)} from {source} (trade={client['trade']})", file=sys.stderr)

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            fh.write(f"client_id={client['client_id']}\n")
    print(client["client_id"])


if __name__ == "__main__":
    main()
