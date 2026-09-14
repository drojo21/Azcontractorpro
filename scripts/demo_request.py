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

The licence gate (core/roc_active.py) runs before anything is built. Every page
asserts "Licensed - Bonded - Insured", carries a ROC credential in its JSON-LD
and links to an azroc.gov verify URL, so the licence behind those claims has to
be real AND currently active. The ROC posting list is the registrar's complete
set of active licences, which makes absence from it a definitive answer rather
than a failed lookup:

  1. ROC number given     -> must be on the active list, or the request is refused
  2. business name only   -> must resolve to exactly one active licence
                             (a business holding several licences resolves to the
                             one matching the requested trade; a name shared by
                             different businesses fails closed)
  3. neither resolves     -> refused; the lead is already captured, so it becomes
                             a follow-up by hand rather than a false claim

Licence facts on the record come from the posting list. Contact data does not —
the posting list has no phone or email — so that is enriched from data/*.csv
(following the business, not just the one licence number) and from the payload.
What was verified, and against which snapshot, is written to client.roc_verified.

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
from roc_active import ROCActive, norm_business  # noqa: E402

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


def find_enrichment_by_name(business: str):
    """Enrichment row for a business name, when no licence number matches one.

    Unambiguous matches only, for the same reason name resolution is strict:
    a phone number from the wrong contractor is worse than no phone number.
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

    # ---------------------------------------------------------------- the gate
    # The posting list is the registrar's complete set of ACTIVE licences, so a
    # licence that is absent from it is not active. Nothing is built until this
    # resolves: every page asserts "Licensed - Bonded - Insured", carries a ROC
    # credential in its JSON-LD and links to an azroc.gov verify URL, so the
    # licence behind those claims has to be real AND current.
    roster = ROCActive()
    if roc:
        lic = roster.get(roc)
        if not lic:
            sys.exit(
                f"ROC #{roc} is not on the Arizona ROC active list "
                f"(snapshot {roster.snapshot_date}) — refusing to build a demo that would "
                "claim a licence that is not currently active. Check the number with the "
                "prospect, or refresh data/roc-active.csv.gz if it is out of date.")
        lic = dict(lic, also_holds=[])
    else:
        lic = roster.find_by_name(business, trade=trade, city=city)
        if not lic:
            sys.exit(
                f"{business or name}: no ROC number given, and the name does not resolve to "
                f"exactly one active licence (snapshot {roster.snapshot_date}) — refusing to "
                "build a demo that would claim licensure we cannot verify. Ask the prospect "
                "for their ROC number and re-run, or build it by hand.")
        roc = lic["roc_number"]

    # The posting list is licence data only — no phone, no email. Those come from
    # the enrichment CSVs when we have a row, and from the prospect otherwise.
    # Enrichment follows the BUSINESS, not the single licence: a contractor who
    # holds several licences may have been enriched under any one of them, so a
    # sibling licence or the name still finds their phone number.
    row = find_roc_row(roc)
    for alt in lic.get("also_holds", []):
        if row:
            break
        row = find_roc_row(alt["roc_number"])
    if not row:
        row = find_enrichment_by_name(lic["business_name"])
    if row:
        client = acp.from_roc_row(row)
        for k in ("client_id", "owner_first_name", "trade", "trade_confidence"):
            if row.get(k):
                client[k] = row[k]
        source = f"ROC active list + enrichment ({roc})"
    else:
        client = acp.from_client_info_block({
            "BUSINESS_NAME": lic["business_name"],
            "OWNER_NAME": name or lic["qualifying_party"],
            "ROC_NUMBER": roc,
            "LICENSE_CLASS": lic["license_class"],
            "PHONE": phone,
            "EMAIL": email,
            # The registrar's own address beats a guess from the city name.
            "CITY": lic["city"] or city,
            "STATE": lic["state"] or "AZ",
            "ZIP": lic["zip"] or CITY_ZIP.get(city.lower(), "85701"),
            "TRADE": trade,
            "TAGLINE": "auto",
        })
        source = f"ROC active list ({roc}, no enrichment row)"

    # Licence facts are the registrar's, not the enrichment sheet's or the form's.
    client["business_name"] = lic["business_name"] or client.get("business_name", "")
    client["roc_number"] = roc
    client["license_class"] = lic["license_class"] or client.get("license_class", "")
    client["license_class_description"] = (lic["license_class_description"]
                                           or client.get("license_class_description", ""))
    client["roc_status"] = lic["roc_status"] or "Active"

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

    # Provenance for the licensure claim on every page of this site. Without it
    # roc_status is just a string somebody typed; with it the publish gate in
    # backend/netlify/functions/deploy.js is checking a dated fact, and the
    # weekly re-verify knows what it is re-checking.
    client["roc_verified"] = {
        "source": "azroc posting list",
        "snapshot_date": str(roster.snapshot_date),
        "verified_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "expiration_date": lic["expiration_date"],
        "also_holds": lic.get("also_holds", []),
    }

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
    age = roster.age_days()
    if age > 30:
        print(f"  WARN  roc-active list is {age} days old (snapshot {roster.snapshot_date}) — "
              "refresh data/roc-active.csv.gz", file=sys.stderr)
    print(f"wrote {dest.relative_to(ROOT)} from {source} "
          f"(trade={client['trade']}, licence expires {lic['expiration_date']})", file=sys.stderr)

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            fh.write(f"client_id={client['client_id']}\n")
    print(client["client_id"])


if __name__ == "__main__":
    main()
