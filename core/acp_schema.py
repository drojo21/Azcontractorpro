#!/usr/bin/env python3
"""
acp_schema.py — AZ Contractor Pro canonical client record.

One shape for a contractor, everywhere. Everything that used to invent its own
format now converts through here:

    ROC roster row        --\
    CLIENT INFO BLOCK     ---+--> client.json (canonical) --> build_site.py --tier lite|full
    Builder work order    --/                              --> marketing deliverables
                                                           --> Apps Script lead router

The JS twin (acp-schema.js) implements the identical logic for the browser
builder and the Netlify function. test_parity.py proves they agree — run it in
CI on every change to either file.

Usage:
    from acp_schema import ACP
    acp = ACP()                                   # loads trade_defaults.json alongside
    client = acp.from_roc_row(row)
    client = acp.resolve(client)
    problems = acp.validate(client)
"""

from __future__ import annotations

import collections
import csv
import json
import math
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = "1.0"
DEFAULTS_PATH = Path(__file__).with_name("trade_defaults.json")

# Fields every site needs before it can go in front of a real contractor.
REQUIRED = ["business_name", "trade", "phone", "city", "state", "zip"]

# Fields required only for a paying (tier=full) client.
REQUIRED_FULL = ["email", "roc_number", "license_class", "site_url"]

TIERS = ("lite", "full")


# --------------------------------------------------------------- primitives

def slugify(value: str) -> str:
    """URL-safe slug. Must match slugify() in acp-schema.js exactly."""
    s = unicodedata.normalize("NFKD", str(value or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.encode("ascii", "ignore").decode("ascii").lower().strip()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"[\s-]+", "-", s)
    return s.strip("-")


def shade(hex_color: str, pct: float) -> str:
    """Lighten (pct>0) or darken (pct<0) a hex color. Matches acp-schema.js."""
    h = str(hex_color or "#000000").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    rgb = [int(h[i:i + 2], 16) for i in (0, 2, 4)]
    out = []
    for c in rgb:
        c = c + (255 - c) * pct if pct > 0 else c * (1 + pct)
        # floor(x+0.5), not round(), so this matches JS Math.round exactly.
        # Python's banker's rounding would differ by one on .5 boundaries.
        out.append(max(0, min(255, int(math.floor(c + 0.5)))))
    return "#%02x%02x%02x" % tuple(out)


def digits(value: str) -> str:
    return re.sub(r"\D", "", str(value or ""))


def tel(phone: str) -> str:
    """E.164-ish tel: href value."""
    d = digits(phone)
    if len(d) == 10:
        return "+1" + d
    if len(d) == 11 and d.startswith("1"):
        return "+" + d
    return "+" + d if d else ""


def format_phone(phone: str) -> str:
    d = digits(phone)
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    if len(d) == 10:
        return f"({d[0:3]}) {d[3:6]}-{d[6:]}"
    return str(phone or "").strip()


def split_list(value) -> list:
    """'Tucson, Marana; Vail' -> ['Tucson','Marana','Vail']"""
    if isinstance(value, list):
        items = [str(v).strip() for v in value]
    else:
        items = [p.strip() for p in re.split(r"[;,|]|\n", str(value or ""))]
    seen, out = set(), []
    for item in items:
        if item and item.lower() not in seen:
            seen.add(item.lower())
            out.append(item)
    return out


def norm_key(value: str) -> str:
    """Loose key for fuzzy CSV header matching."""
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in ("yes", "y", "true", "1", "on")


# --------------------------------------------------------- ROC roster mapping

# Fuzzy header aliases for ROC exports and hand-built CSVs. Keys are canonical
# client fields; values are normalized header candidates in priority order.
ROC_HEADER_ALIASES = {
    "business_name":     ["businessname", "dbaname", "doingbusinessas", "companyname", "name", "licensename"],
    "owner":             ["qualifyingparty", "qualifier", "ownername", "owner", "principal", "contactname"],
    "roc_number":        ["rocnumber", "licensenumber", "licenseno", "license", "roc", "licensenum"],
    "license_class":     ["class", "licenseclass", "classification", "classcode", "licensetype"],
    "license_class_description": ["classificationdescription", "classdescription", "licensedescription", "description"],
    "roc_status":        ["licensestatus", "status", "rocstatus"],
    "phone":             ["phone", "phonenumber", "businessphone", "telephone", "primaryphone", "mainphone"],
    "email":             ["email", "emailaddress", "businessemail", "contactemail"],
    "city":              ["city", "mailingcity", "businesscity", "addresscity"],
    "state":             ["state", "mailingstate", "businessstate"],
    "zip":               ["zip", "zipcode", "postalcode", "mailingzip", "businesszip"],
    "site_url":          ["website", "websiteurl", "url", "weburl", "homepage", "siteurl"],
    "facebook_url":      ["facebook", "facebookurl", "facebookpage"],
    "service_area":      ["servicearea", "areasserved", "citiesserved", "coverage"],
    "specialties":       ["specialties", "services", "specialty", "trades"],
    "years_in_business": ["yearsinbusiness", "years", "established", "yearestablished"],
    "trade":             ["trade", "primarytrade"],
}


def map_headers(headers: list) -> dict:
    """Map raw CSV headers -> canonical field names. Returns {header: field}."""
    out = {}
    used = set()
    normalized = {h: norm_key(h) for h in headers}
    for field, aliases in ROC_HEADER_ALIASES.items():
        for alias in aliases:
            hit = next((h for h, n in normalized.items() if n == alias and h not in used), None)
            if hit:
                out[hit] = field
                used.add(hit)
                break
    # Second pass: substring match for anything still unmapped.
    for field, aliases in ROC_HEADER_ALIASES.items():
        if field in out.values():
            continue
        for alias in aliases:
            hit = next((h for h, n in normalized.items()
                        if h not in used and (alias in n or n in alias) and len(n) > 2), None)
            if hit:
                out[hit] = field
                used.add(hit)
                break
    return out


# ----------------------------------------------------------------- main class

class ACP:
    def __init__(self, defaults_path: Path | str = DEFAULTS_PATH):
        self.defaults = json.loads(Path(defaults_path).read_text(encoding="utf-8"))
        self.trades = self.defaults["trades"]
        self.roc = self.defaults["roc"]

    # -- trade resolution -------------------------------------------------

    def normalize_trade(self, value: str) -> str | None:
        """'Masonry' / 'masonry ' / 'brick work' -> 'masonry'. None if no match."""
        v = str(value or "").strip().lower()
        if not v:
            return None
        if v in self.trades:
            return v
        for key, spec in self.trades.items():
            if v == spec["label"].lower():
                return key
        for key, spec in self.trades.items():
            if any(kw in v for kw in spec["keywords"]):
                return key
        return None

    def infer_trade(self, license_class="", description="", business_name="",
                    specialties="", also_holds=None):
        """
        Returns (trade_key, confidence, reason).

        Keyed on the FULL class code. Suffix-based inference is unsound — the
        real ROC data shows the same number means different things under
        different prefixes:

            A-11 Steel Erection   vs  CR-11 Electrical
            A-14 Asphalt Paving   vs  CR-14 Fencing
            A-12 Sewers/Pipe      vs  C-12  Elevators

        A general class with a clear trade signal in the name or description is
        narrowed one step — that is what puts 'Luis Rojo's Masonry LLC, KB-2'
        on a masonry site instead of a generic contractor site.
        """
        cls = str(license_class or "").strip().upper().replace(" ", "")
        desc = str(description or "")
        blob = f"{desc} {business_name} {specialties}".strip()

        hit = self.roc["class_map"].get(cls)
        if hit:
            if hit["trade"] == "general":
                by_kw = self.normalize_trade(blob)
                if by_kw and by_kw != "general":
                    return by_kw, "medium", f"general class {cls}, narrowed by name/description"
                # A general licensee holding a specialty license is telling you
                # what they actually do. Most-held specialty wins; a tie goes to
                # the first listed, so the result is deterministic.
                held = self._specialties_held(also_holds)
                if held:
                    trade, n = held[0]
                    conf = "medium" if n > 1 or len(held) == 1 else "low"
                    return trade, conf, f"general class {cls}, sharpened by secondary license"
            return hit["trade"], hit["confidence"], f"class {cls}"

        by_kw = self.normalize_trade(blob)
        if by_kw:
            return by_kw, "low", "keyword match, class code unrecognized"

        held = self._specialties_held(also_holds)
        if held:
            return held[0][0], "low", "secondary license only"

        return "general", "low", "no signal, defaulted"

    def _specialties_held(self, also_holds):
        """[(trade, count)] for non-general secondary licenses, most-held first."""
        counts = collections.OrderedDict()
        for code in (also_holds or []):
            hit = self.roc["class_map"].get(str(code).strip().upper())
            if not hit or hit["trade"] == "general":
                continue
            counts[hit["trade"]] = counts.get(hit["trade"], 0) + 1
        return sorted(counts.items(), key=lambda kv: -kv[1])

    def readiness(self, client: dict):
        """
        (state, missing[]) — what this record can actually become.

        A ROC roster row has no phone, email, or website, so it cannot produce a
        publishable site on its own. This separates 'needs enrichment' from
        'broken', which the batch UI needs in order to route work.
        """
        c = client or {}
        missing = [f for f in ("phone", "city", "zip", "business_name") if not c.get(f)]
        if missing:
            return "prospect", missing
        missing_full = [f for f in REQUIRED_FULL if not c.get(f)]
        if not missing_full and (c.get("integrations") or {}).get("lead_endpoint"):
            return "ready_full", []
        return "ready_lite", missing_full

    # -- adapters ---------------------------------------------------------

    def blank(self) -> dict:
        return {
            "schema_version": SCHEMA_VERSION,
            "client_id": "",
            "tier": "lite",
            "business_name": "",
            "short_name": "",
            "owner": "",
            "owner_first_name": "",
            "trade": "",
            "trade_confidence": "",
            "roc_number": "",
            "license_class": "",
            "license_class_description": "",
            "roc_status": "Active",
            "phone": "",
            "email": "",
            "site_url": "",
            "facebook_url": "",
            "city": "",
            "state": "AZ",
            "zip": "",
            "service_area": [],
            "years_in_business": None,
            "hours": "",
            "tagline": "",
            "hero_subhead": "",
            "target_customer": "both",
            "emergency_service": False,
            "payment_plans": "",
            "theme": {},
            "services": [],
            "why_us": [],
            "faqs": [],
            "reviews": [],
            "integrations": {
                "lead_endpoint": "",
                "gallery_endpoint": "",
                "portal_url": "",
                "google_place_id": "",
                "facebook_page_id": "",
                "notification_email": "",
            },
            "deploy": {
                "netlify_site_id": "",
                "netlify_url": "",
                "custom_domain": "",
                "repo": "",
                "claim_link_sent_at": "",
                "claimed_at": "",
                "last_built_at": "",
                "last_tier_built": "",
            },
            "marketing": {},
        }

    def from_roc_row(self, row: dict, header_map: dict | None = None) -> dict:
        """One ROC roster row -> canonical client (unresolved)."""
        hm = header_map or map_headers(list(row.keys()))
        picked = {}
        for header, field in hm.items():
            val = row.get(header)
            if val not in (None, ""):
                picked.setdefault(field, str(val).strip())

        c = self.blank()
        c["business_name"] = picked.get("business_name", "")
        c["owner"] = picked.get("owner", "")
        c["roc_number"] = digits(picked.get("roc_number", ""))
        c["license_class"] = picked.get("license_class", "").strip().upper()
        c["license_class_description"] = picked.get("license_class_description", "")
        c["roc_status"] = picked.get("roc_status", "Active") or "Active"
        c["phone"] = format_phone(picked.get("phone", ""))
        c["email"] = picked.get("email", "")
        c["site_url"] = picked.get("site_url", "")
        c["facebook_url"] = picked.get("facebook_url", "")
        c["city"] = picked.get("city", "")
        c["state"] = (picked.get("state") or "AZ").upper()[:2]
        c["zip"] = digits(picked.get("zip", ""))[:5]
        c["service_area"] = split_list(picked.get("service_area", "")) or ([c["city"]] if c["city"] else [])

        years = digits(picked.get("years_in_business", ""))
        c["years_in_business"] = int(years) if years else None

        trade, conf, _reason = self.infer_trade(
            c["license_class"], c["license_class_description"],
            c["business_name"], picked.get("specialties", ""),
        )
        c["trade"] = self.normalize_trade(picked.get("trade", "")) or trade
        c["trade_confidence"] = conf

        if picked.get("specialties"):
            c["services"] = [{"slug": slugify(s), "name": s, "summary": ""}
                             for s in split_list(picked["specialties"])]
        return c

    def from_client_info_block(self, text) -> dict:
        """The flat KEY: VALUE block used by both skills -> canonical client."""
        if isinstance(text, dict):
            raw = {norm_key(k): str(v).strip() for k, v in text.items()}
        else:
            raw = {}
            for line in str(text).splitlines():
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                raw[norm_key(k)] = v.strip()

        def g(key, default=""):
            v = raw.get(norm_key(key), default)
            return "" if str(v).lower() in ("n/a", "na", "tbd", "none") else v

        c = self.blank()
        c["business_name"] = g("BUSINESS_NAME")
        c["owner"] = g("OWNER_NAME")
        c["owner_first_name"] = g("OWNER_FIRST_NAME") or c["owner"].split(" ")[0]
        c["roc_number"] = digits(g("ROC_NUMBER"))
        c["license_class"] = g("LICENSE_CLASS").upper()
        c["roc_status"] = g("ROC_STATUS") or "Active"
        c["phone"] = format_phone(g("PHONE"))
        c["email"] = g("EMAIL")
        c["site_url"] = g("WEBSITE_URL")
        c["facebook_url"] = g("FACEBOOK_URL")
        c["city"] = g("CITY")
        c["state"] = (g("STATE") or "AZ").upper()[:2]
        c["zip"] = digits(g("ZIP"))[:5]
        c["service_area"] = split_list(g("SERVICE_AREA")) or ([c["city"]] if c["city"] else [])
        years = digits(g("YEARS_IN_BUSINESS"))
        c["years_in_business"] = int(years) if years else None
        c["target_customer"] = (g("TARGET_CUSTOMER") or "both").lower()
        c["emergency_service"] = truthy(g("EMERGENCY_SERVICE"))
        c["payment_plans"] = "" if g("PAYMENT_PLANS").lower() in ("no", "") else g("PAYMENT_PLANS")

        tagline = g("TAGLINE")
        c["tagline"] = "" if tagline.lower() == "auto" else tagline

        primary = g("PRIMARY_COLOR_HEX")
        accent = g("ACCENT_COLOR_HEX")
        theme = {}
        if primary and primary.lower() != "auto":
            theme["primary"] = primary
        if accent and accent.lower() != "auto":
            theme["accent"] = accent
        c["theme"] = theme

        trade = self.normalize_trade(g("TRADE"))
        if not trade:
            trade, conf, _ = self.infer_trade(c["license_class"], "", c["business_name"], g("SPECIALTIES"))
            c["trade_confidence"] = conf
        else:
            c["trade_confidence"] = "high"
        c["trade"] = trade

        if g("SPECIALTIES"):
            c["services"] = [{"slug": slugify(s), "name": s, "summary": ""}
                             for s in split_list(g("SPECIALTIES"))]

        c["integrations"]["lead_endpoint"] = g("GOOGLE_SHEET_URL")
        c["integrations"]["notification_email"] = g("NOTIFICATION_EMAIL") or c["email"]
        c["integrations"]["google_place_id"] = g("GOOGLE_PLACE_ID")
        c["integrations"]["facebook_page_id"] = g("FACEBOOK_PAGE_ID")
        return c

    def from_builder_form(self, form: dict) -> dict:
        """
        Builder work-order state -> canonical client. Accepts either the
        canonical field names or the loose form names, so it survives the
        builder's field renames.
        """
        alias = {
            "businessName": "business_name", "business": "business_name",
            "ownerName": "owner", "owner_name": "owner",
            "rocNumber": "roc_number", "roc": "roc_number",
            "licenseClass": "license_class", "class": "license_class",
            "serviceArea": "service_area", "cities": "service_area",
            "websiteUrl": "site_url", "website": "site_url",
            "notificationEmail": "notification_email",
            "leadEndpoint": "lead_endpoint", "sheetUrl": "lead_endpoint",
            "yearsInBusiness": "years_in_business",
            "emergencyService": "emergency_service",
            "targetCustomer": "target_customer",
        }
        flat = {}
        for k, v in (form or {}).items():
            flat[alias.get(k, k)] = v

        block = {
            "BUSINESS_NAME": flat.get("business_name", ""),
            "OWNER_NAME": flat.get("owner", ""),
            "TRADE": flat.get("trade", ""),
            "LICENSE_CLASS": flat.get("license_class", ""),
            "ROC_NUMBER": flat.get("roc_number", ""),
            "PHONE": flat.get("phone", ""),
            "CITY": flat.get("city", ""),
            "STATE": flat.get("state", "AZ"),
            "ZIP": flat.get("zip", ""),
            "SERVICE_AREA": flat.get("service_area", ""),
            "EMAIL": flat.get("email", ""),
            "WEBSITE_URL": flat.get("site_url", ""),
            "FACEBOOK_URL": flat.get("facebook_url", ""),
            "YEARS_IN_BUSINESS": flat.get("years_in_business", ""),
            "SPECIALTIES": flat.get("specialties", ""),
            "TAGLINE": flat.get("tagline", ""),
            "TARGET_CUSTOMER": flat.get("target_customer", ""),
            "EMERGENCY_SERVICE": flat.get("emergency_service", ""),
            "GOOGLE_SHEET_URL": flat.get("lead_endpoint", ""),
            "NOTIFICATION_EMAIL": flat.get("notification_email", ""),
        }
        c = self.from_client_info_block(block)
        # Carry through anything the form already holds in canonical form.
        for key in ("hero_subhead", "why_us", "faqs", "reviews", "hours"):
            if flat.get(key):
                c[key] = flat[key]
        if isinstance(flat.get("services"), list) and flat["services"]:
            c["services"] = flat["services"]
        if isinstance(flat.get("theme"), dict):
            c["theme"].update({k: v for k, v in flat["theme"].items() if v})
        if flat.get("tier") in TIERS:
            c["tier"] = flat["tier"]
        return c

    def to_client_info_block(self, client: dict) -> str:
        """Canonical client -> the flat block the skills document. Round-trips."""
        c = client
        spec = self.trades.get(c.get("trade", "general"), self.trades["general"])
        theme = c.get("theme") or {}
        integ = c.get("integrations") or {}
        rows = [
            ("BUSINESS_NAME", c.get("business_name", "")),
            ("OWNER_NAME", c.get("owner", "")),
            ("OWNER_FIRST_NAME", c.get("owner_first_name", "")),
            ("TRADE", spec["label"]),
            ("LICENSE_CLASS", c.get("license_class", "")),
            ("ROC_NUMBER", c.get("roc_number", "")),
            ("ROC_STATUS", c.get("roc_status", "Active")),
            ("PHONE", c.get("phone", "")),
            ("CITY", c.get("city", "")),
            ("STATE", c.get("state", "AZ")),
            ("ZIP", c.get("zip", "")),
            ("SERVICE_AREA", ", ".join(c.get("service_area") or [])),
            ("EMAIL", c.get("email", "") or "N/A"),
            ("WEBSITE_URL", c.get("site_url", "") or "N/A"),
            ("FACEBOOK_URL", c.get("facebook_url", "") or "N/A"),
            ("GOOGLE_PLACE_ID", integ.get("google_place_id", "") or "N/A"),
            ("FACEBOOK_PAGE_ID", integ.get("facebook_page_id", "") or "N/A"),
            ("YEARS_IN_BUSINESS", c.get("years_in_business") or "N/A"),
            ("SPECIALTIES", ", ".join(s["name"] for s in c.get("services") or [])),
            ("TAGLINE", c.get("tagline", "") or "auto"),
            ("PRIMARY_COLOR_HEX", theme.get("primary", "") or "auto"),
            ("ACCENT_COLOR_HEX", theme.get("accent", "") or "auto"),
            ("TARGET_CUSTOMER", (c.get("target_customer") or "both").title()),
            ("EMERGENCY_SERVICE", "Yes" if c.get("emergency_service") else "No"),
            ("PAYMENT_PLANS", c.get("payment_plans", "") or "No"),
            ("GOOGLE_SHEET_URL", integ.get("lead_endpoint", "") or "TBD"),
            ("NOTIFICATION_EMAIL", integ.get("notification_email", "") or c.get("email", "")),
        ]
        width = max(len(k) for k, _ in rows) + 2
        return "\n".join(f"{k}:".ljust(width) + str(v) for k, v in rows)

    # -- resolution -------------------------------------------------------

    def resolve(self, client: dict) -> dict:
        """Fill every 'auto' / empty field from trade defaults. Idempotent."""
        c = json.loads(json.dumps(client))  # deep copy, no aliasing surprises

        trade = self.normalize_trade(c.get("trade", "")) or "general"
        c["trade"] = trade
        spec = self.trades[trade]

        if not c.get("client_id"):
            c["client_id"] = slugify(c.get("business_name", "")) or f"roc-{c.get('roc_number','')}"
        if c.get("tier") not in TIERS:
            c["tier"] = "lite"
        if not c.get("short_name"):
            c["short_name"] = re.sub(r"\s*(,?\s*(LLC|L\.L\.C\.|Inc\.?|Incorporated|Co\.?|Corp\.?))+$",
                                     "", c.get("business_name", ""), flags=re.I).strip()
        if not c.get("owner_first_name") and c.get("owner"):
            c["owner_first_name"] = c["owner"].split(" ")[0]

        # Theme: explicit values win, trade defaults fill the rest, shades derived.
        t = dict(spec["theme"])
        t.update({k: v for k, v in (c.get("theme") or {}).items() if v})
        t["primary_light"] = shade(t["primary"], 0.18)
        t["primary_dark"] = shade(t["primary"], -0.22)
        t["accent_dark"] = shade(t["accent"], -0.18)
        fonts = self.defaults["fonts"]
        t["google_fonts"] = "|".join(filter(None, [
            fonts.get(t["display_font"], ""), fonts.get(t["body_font"], ""),
        ]))
        c["theme"] = t

        if not c.get("tagline"):
            c["tagline"] = spec["tagline"]
        if not c.get("hours"):
            c["hours"] = self.defaults["_meta"]["hours_default"]
        if not c.get("service_area"):
            c["service_area"] = [c["city"]] if c.get("city") else []
        if not c.get("hero_subhead"):
            area = c["service_area"][0] if c["service_area"] else c.get("city", "Arizona")
            c["hero_subhead"] = (
                f"Licensed {spec['label'].lower()} work in {area} — free written estimates, "
                f"and the same crew from first day to final walkthrough."
            )

        # Services: names from the roster get summaries; empty lists get defaults.
        if not c.get("services"):
            c["services"] = [dict(s) for s in spec["default_services"]]
        else:
            by_slug = {s["slug"]: s for s in spec["default_services"]}
            for svc in c["services"]:
                svc.setdefault("slug", slugify(svc.get("name", "")))
                if not svc.get("summary"):
                    match = by_slug.get(svc["slug"])
                    svc["summary"] = match["summary"] if match else (
                        f"{svc.get('name','')} for {c.get('city','')} homeowners, "
                        f"done by a licensed crew."
                    ).strip()

        if not c.get("why_us"):
            c["why_us"] = self._why_us(c, spec)
        if not c.get("faqs"):
            c["faqs"] = self._faqs(c, spec)

        c["marketing"] = {
            "gbp_primary_category": spec["gbp"]["primary"],
            "gbp_secondary_category": spec["gbp"]["secondary"],
            "fb_interests": list(spec["fb_interests"]),
            **(c.get("marketing") or {}),
        }

        integ = c.setdefault("integrations", {})
        # NB: setdefault is wrong here — blank() already seeds the key with "",
        # so it would never fall back to email. Check for falsiness instead.
        if not integ.get("notification_email"):
            integ["notification_email"] = c.get("email", "")
        if not c.get("deploy"):
            c["deploy"] = self.blank()["deploy"]
        c["schema_version"] = SCHEMA_VERSION
        return c

    def _why_us(self, c, spec):
        out = []
        if c.get("roc_number"):
            out.append(f"Licensed, bonded, and insured — ROC #{c['roc_number']}, "
                       f"verifiable at azroc.gov in about thirty seconds")
        else:
            out.append("Licensed, bonded, and insured in the State of Arizona")
        out.append("Free on-site estimates, written before any work starts")
        out.append("The same crew from the first day to the final walkthrough")
        if c.get("years_in_business"):
            area = c["service_area"][0] if c.get("service_area") else c.get("city", "Arizona")
            out.append(f"{c['years_in_business']} years of {area} "
                       f"{spec['label'].lower()} work still standing")
        if c.get("emergency_service"):
            out.append("Emergency service available when something can't wait")
        return out

    def _faqs(self, c, spec):
        name = c.get("business_name", "We")
        areas = ", ".join(c.get("service_area") or []) or c.get("city", "Arizona")
        svc = ", ".join(s["name"].lower() for s in (c.get("services") or [])[:4])
        lic = (f"Yes. {name} holds Arizona ROC license #{c['roc_number']}"
               + (f", a {c['license_class']} classification" if c.get("license_class") else "")
               + ", and carries liability insurance. You can verify it at azroc.gov."
               ) if c.get("roc_number") else \
              f"Yes. {name} is a licensed and insured Arizona contractor."
        return [
            {"q": f"Is {name} licensed and insured?", "a": lic},
            {"q": "What areas do you serve?", "a": f"We serve {areas} and the surrounding communities."},
            {"q": "Do you charge for estimates?",
             "a": f"No. Estimates are free and done on site, and you get the scope and price "
                  f"in writing before anyone starts work. Call {c.get('phone') or 'us'} to schedule."},
            {"q": f"What {spec['label'].lower()} services do you offer?",
             "a": f"We handle {svc}." if svc else f"We handle a full range of {spec['label'].lower()} work."},
            {"q": "How long does a typical project take?",
             "a": "It depends on scope, but you get a schedule in writing with the estimate — "
                  "including what happens if weather or inspections move a date."},
            {"q": "How do I verify your contractor license?",
             "a": f"Search ROC #{c.get('roc_number','')} at azroc.gov. It takes about thirty seconds "
                  f"and shows license status, classification, and any complaint history."},
        ]

    # -- validation -------------------------------------------------------

    def validate(self, client: dict) -> list:
        """Returns [{level, field, message}]. level: 'error' | 'warn'."""
        p = []
        c = client or {}

        for f in REQUIRED:
            if not c.get(f):
                p.append({"level": "error", "field": f, "message": f"{f} is required"})

        if c.get("tier") not in TIERS:
            p.append({"level": "error", "field": "tier",
                      "message": f"tier must be one of {', '.join(TIERS)}"})

        if c.get("trade") and c["trade"] not in self.trades:
            p.append({"level": "error", "field": "trade",
                      "message": f"unknown trade '{c['trade']}'"})

        d = digits(c.get("phone", ""))
        if c.get("phone") and len(d) not in (10, 11):
            p.append({"level": "error", "field": "phone",
                      "message": f"phone has {len(d)} digits, expected 10"})

        if c.get("zip") and len(digits(c["zip"])) != 5:
            p.append({"level": "warn", "field": "zip", "message": "zip is not 5 digits"})

        if c.get("email") and "@" not in str(c["email"]):
            p.append({"level": "error", "field": "email", "message": "email is not an address"})

        for f in ("site_url", "facebook_url"):
            v = c.get(f)
            if v and not str(v).startswith(("http://", "https://")):
                p.append({"level": "warn", "field": f, "message": f"{f} is missing the scheme"})

        if not (c.get("integrations") or {}).get("lead_endpoint"):
            p.append({"level": "warn", "field": "integrations.lead_endpoint",
                      "message": "no lead endpoint — the quote form will not deliver leads"})

        if c.get("trade_confidence") == "low":
            p.append({"level": "warn", "field": "trade",
                      "message": "trade was inferred with low confidence — check before publishing"})

        if c.get("roc_status") and str(c["roc_status"]).lower() not in ("active", "current"):
            p.append({"level": "warn", "field": "roc_status",
                      "message": f"ROC status is '{c['roc_status']}' — do not publish claims of licensure"})

        if c.get("tier") == "full":
            for f in REQUIRED_FULL:
                if not c.get(f):
                    p.append({"level": "error", "field": f,
                              "message": f"{f} is required for a tier=full site"})
            integ = c.get("integrations") or {}
            for f in ("gallery_endpoint", "portal_url"):
                if not integ.get(f):
                    p.append({"level": "warn", "field": f"integrations.{f}",
                              "message": f"tier=full without {f} — client cannot self-serve"})

        slugs = [s.get("slug") for s in c.get("services") or []]
        dupes = {s for s in slugs if slugs.count(s) > 1}
        for s in sorted(dupes):
            p.append({"level": "error", "field": "services",
                      "message": f"duplicate service slug '{s}' — pages would overwrite each other"})

        return p

    # -- serialization ----------------------------------------------------

    def stamp(self, client: dict, tier: str, site_id="", url="") -> dict:
        c = dict(client)
        d = dict(c.get("deploy") or {})
        d["last_built_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        d["last_tier_built"] = tier
        if site_id:
            d["netlify_site_id"] = site_id
        if url:
            d["netlify_url"] = url
        c["deploy"] = d
        return c

    @staticmethod
    def dumps(client: dict) -> str:
        """Stable serialization — sorted keys, so git diffs stay readable."""
        return json.dumps(client, indent=2, sort_keys=True, ensure_ascii=False)


# ---------------------------------------------------------------------- CLI

def _main():
    import argparse
    ap = argparse.ArgumentParser(description="AZ Contractor Pro schema tool")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("convert", help="ROC CSV or CLIENT INFO BLOCK -> client.json")
    c.add_argument("input")
    c.add_argument("--out", default="-")
    c.add_argument("--tier", choices=TIERS, default="lite")

    v = sub.add_parser("validate", help="check a client.json")
    v.add_argument("input")

    args = ap.parse_args()
    acp = ACP()

    if args.cmd == "validate":
        client = json.loads(Path(args.input).read_text())
        problems = acp.validate(acp.resolve(client))
        for p in problems:
            print(f"{p['level'].upper():5} {p['field']}: {p['message']}")
        errors = [p for p in problems if p["level"] == "error"]
        print(f"\n{len(errors)} error(s), {len(problems) - len(errors)} warning(s)")
        raise SystemExit(1 if errors else 0)

    path = Path(args.input)
    text = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() in (".csv", ".tsv"):
        delim = "\t" if path.suffix.lower() == ".tsv" else ","
        rows = list(csv.DictReader(text.splitlines(), delimiter=delim))
        hm = map_headers(list(rows[0].keys())) if rows else {}
        clients = [acp.resolve({**acp.from_roc_row(r, hm), "tier": args.tier}) for r in rows]
        out = clients if len(clients) != 1 else clients[0]
    else:
        out = acp.resolve({**acp.from_client_info_block(text), "tier": args.tier})

    blob = ACP.dumps(out)
    if args.out == "-":
        print(blob)
    else:
        Path(args.out).write_text(blob, encoding="utf-8")
        print(f"wrote {args.out}")


if __name__ == "__main__":
    _main()
