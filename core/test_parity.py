#!/usr/bin/env python3
"""
test_parity.py — proves acp_schema.py and acp-schema.js agree.

Every fixture is run through both implementations and the canonical JSON is
diffed byte for byte. Any divergence fails. Run this in CI on every commit that
touches either file; it is the only thing preventing the drift that produced
the KB-2 bug in the first place.

    python3 test_parity.py
"""

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from acp_schema import ACP, slugify, shade, format_phone  # noqa: E402

acp = ACP()

# ------------------------------------------------------------------ fixtures

ROC_ROWS = [
    {  # Luis Rojo — the KB-2 case. Must resolve to General, not Excavating.
        "Business Name": "Luis Rojo's Masonry LLC",
        "Qualifying Party": "Luis Rojo",
        "License Number": "337881",
        "Class": "KB-2",
        "Classification Description": "Dual Residential and Small Commercial",
        "License Status": "Active",
        "Phone": "520-481-7579",
        "Mailing City": "Tucson",
        "State": "AZ",
        "Zip Code": "85713",
        "Website": "",
    },
    {  # Clean specialty code.
        "DBA Name": "Sunrise Electric Co",
        "Owner": "Dana Ruiz",
        "ROC Number": "  412093 ",
        "License Class": "cr-11",
        "Class Description": "Electrical",
        "Status": "Active",
        "Business Phone": "(602) 555-0134",
        "City": "Mesa",
        "Zip": "85201-4402",
        "Email": "dana@sunriseelectric.com",
    },
    {  # No class at all — must fall through to description keywords.
        "Company Name": "Vista Roofing & Coatings",
        "Contact Name": "Marco Vela",
        "License No": "ROC-228841",
        "Classification": "",
        "Description": "Roofing contractor, tile and foam",
        "Phone Number": "9285551212",
        "Mailing City": "Flagstaff",
        "Postal Code": "86001",
        "Areas Served": "Flagstaff; Sedona, Cottonwood",
    },
    {  # Suspended license — must produce the roc_status warning.
        "Business Name": "Álvarez Landscaping, LLC",
        "License Number": "509112",
        "Class": "CR-21",
        "License Status": "Suspended",
        "Phone": "1-520-555-9090",
        "City": "Nogales",
        "Zip": "85621",
        "Specialties": "Irrigation, Artificial Turf, Irrigation",
    },
]

# Verbatim rows from ROC_New-Licenses-List_2024-05-22.csv — real headers,
# real values, including the fact that the export carries no contact columns.
REAL_ROSTER_HEADERS = ["License No", "Business Name", "Doing Business As", "Address",
                       "City", "State", "Zip", "Qualifying Party", "Class",
                       "Class Detail", "Issued Date", "Expiration Date", "Status"]
REAL_ROSTER_ROWS = [
    ["352345", "Josh Reynolds Construction LLC", "", "4670 N Paseo De Los Cerritos",
     "Tucson", "AZ", "85745", "Could not find QP Name", "KB-2",
     "KB-2 Dual Residential and Small Commercial", "2024-05-21", "2026-05-31", "Active"],
    ["352353", "Beltran Roofing LLC", "", "112 E Carter Rd", "PHOENIX", "AZ", "85042",
     "Could not find QP Name", "CR-42", "CR-42 Roofing", "2024-05-21", "2026-05-31", "Active"],
    ["352350", "SAFE HAVEN DEFENSE US, LLC", "", "22849 N 19th Ave", "Phoenix", "AZ", "85027",
     "Could not find QP Name", "CR-65", "CR-65 Glazing", "2024-05-21", "2026-05-31", "Active"],
]
ROC_ROWS += [dict(zip(REAL_ROSTER_HEADERS, r)) for r in REAL_ROSTER_ROWS]

INFO_BLOCK = """
BUSINESS_NAME:      Copper State Plumbing Inc.
OWNER_NAME:         Rita Mendes
OWNER_FIRST_NAME:   Rita
TRADE:              Plumbing
LICENSE_CLASS:      CR-37
ROC_NUMBER:         301447
ROC_STATUS:         Active
PHONE:              (520) 555-7788
CITY:               Tucson
STATE:              AZ
ZIP:                85719
SERVICE_AREA:       Tucson, Oro Valley, Marana
EMAIL:              rita@copperstateplumbing.com
WEBSITE_URL:        N/A
FACEBOOK_URL:       N/A
GOOGLE_PLACE_ID:    N/A
YEARS_IN_BUSINESS:  18
SPECIALTIES:        Drain Cleaning, Water Heaters, Repiping
TAGLINE:            auto
PRIMARY_COLOR_HEX:  auto
ACCENT_COLOR_HEX:   #00ffee
TARGET_CUSTOMER:    Both
EMERGENCY_SERVICE:  Yes
PAYMENT_PLANS:      No
GOOGLE_SHEET_URL:   TBD
NOTIFICATION_EMAIL: rita@copperstateplumbing.com
"""

BUILDER_FORM = {
    "businessName": "Ironwood Fence & Gate",
    "ownerName": "Sam Okafor",
    "trade": "",
    "licenseClass": "CR-14",
    "rocNumber": "288301",
    "phone": "5205550101",
    "city": "Vail",
    "zip": "85641",
    "serviceArea": "Vail, Corona de Tucson, Sahuarita",
    "email": "sam@ironwoodfence.com",
    "specialties": "Wrought Iron Fencing, Gates & Automation",
    "tier": "full",
    "theme": {"accent": "#123456"},
}

# Trade inference cases: (class, description, name, expected_trade)
# The A-* vs CR-* pairs are the regression guard: these codes share a numeric
# suffix but mean completely different trades. Suffix inference got them wrong.
INFER_CASES = [
    ("KB-2", "Dual Residential and Small Commercial", "Luis Rojo's Masonry LLC", "masonry"),
    ("KB-2", "Dual Residential and Small Commercial", "Josh Reynolds Construction LLC", "general"),
    ("KB-1", "Dual Building Contractor", "", "general"),
    ("B", "General Residential Contractor", "", "general"),
    ("B-3", "General Remodeling and Repair Contractor", "", "general"),
    ("B-5", "General Swimming Pool Contractor", "", "pools"),
    ("A", "General Engineering", "", "general"),
    ("A-11", "Steel and Aluminum Erection", "", "steel"),
    ("CR-11", "Electrical", "", "electrical"),
    ("A-14", "Asphalt Paving", "", "asphalt"),
    ("CR-14", "Fencing", "", "fencing"),
    ("A-12", "Sewers Drains and Pipe Laying", "", "plumbing"),
    ("C-12", "Elevators", "", "general"),
    ("A-5", "Excavating Grading and Oil Surfacing", "", "excavating"),
    ("CR-31", "Masonry", "", "masonry"),
    ("CR-34", "Painting and Wall Covering", "", "painting"),
    ("CR-36", "Plastering", "", "masonry"),
    ("R-62", "Minor Home Improvements", "", "handyman"),
    ("CR-48", "Ceramic, Plastic and Metal Tile", "", "tile"),
    ("CR-67", "Low Voltage Communication Systems", "", "lowvoltage"),
    ("R-39R", "Air Conditioning and Refrigeration", "", "hvac"),
    ("cr-37", "Plumbing", "", "plumbing"),
    ("ZZ-99", "", "", "general"),
    ("", "Roofing contractor, tile and foam", "", "roofing"),
    ("", "", "", "general"),
]

# (class, description, name, also_holds[], expected_trade) — the secondary-license
# signal. 98 businesses in the Dec-2025 sheet are general on paper and something
# specific in practice.
ALSO_HOLDS_CASES = [
    ("KB-2", "Dual Residential and Small Commercial", "Stark Contrast LLC", ["CR-21"], "landscaping"),
    ("B", "General Residential Contractor", "A & B Handyman, LLC", ["R-62", "R-62"], "handyman"),
    ("A", "General Engineering", "Kerns, Inc.", ["CR-11", "CR-37"], "electrical"),
    ("KB-1", "Dual Building Contractor", "MAHA LLC", ["R-2", "CR-57", "R-2"], "excavating"),
    ("B-1", "General Commercial Contractor", "MATRIX HG INC.", ["C-39"], "hvac"),
    ("KB-2", "Dual Residential and Small Commercial", "Generic Builders", [], "general"),
    ("KB-2", "Dual Residential and Small Commercial", "Generic Builders", ["KB-1"], "general"),
    ("CR-42", "Roofing", "Beltran Roofing LLC", ["CR-21"], "roofing"),
]

PRIMITIVE_CASES = {
    "slugify": ["Luis Rojo's Masonry LLC", "  A/C & Heating  ", "Álvarez Landscaping",
                "---double--dash---", "", "Paver Driveways & Patios"],
    "shade": [["#78350f", 0.18], ["#78350f", -0.22], ["#d97706", -0.18],
              ["#000", 0.5], ["#ffffff", -0.5], ["#7f7f7f", 0.5]],
    "format_phone": ["520-481-7579", "(602) 555-0134", "1-520-555-9090",
                     "9285551212", "555-1212", ""],
}


# ------------------------------------------------------------------- runners

def run_python():
    out = {"primitives": {}, "infer": [], "clients": {}, "validate": {}, "readiness": {}}

    out["primitives"]["slugify"] = [slugify(v) for v in PRIMITIVE_CASES["slugify"]]
    out["primitives"]["shade"] = [shade(a, b) for a, b in PRIMITIVE_CASES["shade"]]
    out["primitives"]["format_phone"] = [format_phone(v) for v in PRIMITIVE_CASES["format_phone"]]

    for cls, desc, name, _expected in INFER_CASES:
        trade, conf, reason = acp.infer_trade(cls, desc, name, "")
        out["infer"].append([trade, conf, reason])
    for cls, desc, name, also, _expected in ALSO_HOLDS_CASES:
        out["infer"].append(list(acp.infer_trade(cls, desc, name, "", also_holds=also)))

    for i, row in enumerate(ROC_ROWS):
        out["clients"][f"roc{i}"] = acp.resolve(acp.from_roc_row(row))
    out["clients"]["block"] = acp.resolve(acp.from_client_info_block(INFO_BLOCK))
    out["clients"]["form"] = acp.resolve(acp.from_builder_form(BUILDER_FORM))
    out["clients"]["roundtrip"] = acp.resolve(
        acp.from_client_info_block(acp.to_client_info_block(out["clients"]["block"])))

    for key, client in out["clients"].items():
        out["validate"][key] = acp.validate(client)
        out["readiness"][key] = list(acp.readiness(client))

    return out


JS_DRIVER = r"""
const path = require('path');
const { create } = require(path.join(__dirname, 'acp-schema.js'));
const defaults = require(path.join(__dirname, 'trade_defaults.json'));
const acp = create(defaults);
const F = JSON.parse(process.argv[2]);

const out = { primitives: {}, infer: [], clients: {}, validate: {}, readiness: {} };

out.primitives.slugify = F.PRIMITIVE_CASES.slugify.map(v => acp.slugify(v));
out.primitives.shade = F.PRIMITIVE_CASES.shade.map(([a, b]) => acp.shade(a, b));
out.primitives.format_phone = F.PRIMITIVE_CASES.format_phone.map(v => acp.formatPhone(v));

for (const [cls, desc, name] of F.INFER_CASES) {
  out.infer.push(acp.inferTrade(cls, desc, name, ''));
}
for (const [cls, desc, name, also] of F.ALSO_HOLDS_CASES) {
  out.infer.push(acp.inferTrade(cls, desc, name, '', also));
}

F.ROC_ROWS.forEach((row, i) => { out.clients['roc' + i] = acp.resolve(acp.fromRocRow(row)); });
out.clients.block = acp.resolve(acp.fromClientInfoBlock(F.INFO_BLOCK));
out.clients.form = acp.resolve(acp.fromBuilderForm(F.BUILDER_FORM));
out.clients.roundtrip = acp.resolve(
  acp.fromClientInfoBlock(acp.toClientInfoBlock(out.clients.block)));

for (const k of Object.keys(out.clients)) {
  out.validate[k] = acp.validate(out.clients[k]);
  out.readiness[k] = acp.readiness(out.clients[k]);
}

process.stdout.write(JSON.stringify(out));
"""


def run_js():
    driver = HERE / "_parity_driver.js"
    driver.write_text(JS_DRIVER, encoding="utf-8")
    fixtures = json.dumps({
        "PRIMITIVE_CASES": PRIMITIVE_CASES,
        "INFER_CASES": [list(c[:3]) for c in INFER_CASES],
        "ALSO_HOLDS_CASES": [list(c[:4]) for c in ALSO_HOLDS_CASES],
        "ROC_ROWS": ROC_ROWS,
        "INFO_BLOCK": INFO_BLOCK,
        "BUILDER_FORM": BUILDER_FORM,
    })
    try:
        res = subprocess.run([ "node", str(driver), fixtures ],
                             capture_output=True, text=True, check=True)
        return json.loads(res.stdout)
    finally:
        driver.unlink(missing_ok=True)


# -------------------------------------------------------------------- diffing

def walk(obj, prefix=""):
    """Flatten to {path: value} so a mismatch names the exact field."""
    if isinstance(obj, dict):
        for k in sorted(obj):
            yield from walk(obj[k], f"{prefix}.{k}" if prefix else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, f"{prefix}[{i}]")
    else:
        yield prefix, obj


def main():
    py = run_python()
    js = run_js()

    flat_py = dict(walk(py))
    flat_js = dict(walk(js))

    mismatches = []
    for key in sorted(set(flat_py) | set(flat_js)):
        a = flat_py.get(key, "<missing in py>")
        b = flat_js.get(key, "<missing in js>")
        if a != b:
            mismatches.append((key, a, b))

    print("=" * 70)
    print("PARITY: acp_schema.py  vs  acp-schema.js")
    print("=" * 70)
    print(f"  fields compared : {len(set(flat_py) | set(flat_js))}")
    print(f"  mismatches      : {len(mismatches)}")

    for key, a, b in mismatches[:40]:
        print(f"\n  ✗ {key}\n      py: {a!r}\n      js: {b!r}")

    # Correctness checks that parity alone would not catch — both could agree
    # and both be wrong. These assert the actual expected trade.
    print("\n" + "-" * 70)
    print("TRADE INFERENCE (correctness, not just parity)")
    print("-" * 70)
    wrong = []
    all_cases = [c for c in INFER_CASES] + [(c[0], c[1], c[2], c[4]) for c in ALSO_HOLDS_CASES]
    for (cls, desc, name, expected), got in zip(all_cases, py["infer"]):
        ok = got[0] == expected
        flag = "✓" if ok else "✗"
        label = cls or "(no class)"
        print(f"  {flag} {label:10} {desc[:34]:34} -> {got[0]:12} [{got[1]}]")
        if not ok:
            wrong.append((label, expected, got[0]))

    print("\n" + "-" * 70)
    print("VALIDATION SPOT CHECKS")
    print("-" * 70)
    checks = []
    checks.append(("KB-2 client resolves to masonry (name signal)",
                   py["clients"]["roc0"]["trade"] == "masonry"))
    checks.append(("suspended license raises a warning",
                   any(p["field"] == "roc_status" for p in py["validate"]["roc3"])))
    checks.append(("duplicate specialty deduped, no slug collision",
                   not any("duplicate service slug" in p["message"] for p in py["validate"]["roc3"])))
    checks.append(("tier=full without email/site_url errors",
                   any(p["level"] == "error" for p in py["validate"]["form"])))
    checks.append(("explicit accent color survives resolve()",
                   py["clients"]["block"]["theme"]["accent"] == "#00ffee"))
    checks.append(("trade default primary still applied alongside it",
                   py["clients"]["block"]["theme"]["primary"] == "#0369a1"))
    checks.append(("CLIENT INFO BLOCK round-trips without loss",
                   py["clients"]["roundtrip"]["trade"] == py["clients"]["block"]["trade"]
                   and py["clients"]["roundtrip"]["phone"] == py["clients"]["block"]["phone"]
                   and py["clients"]["roundtrip"]["service_area"] == py["clients"]["block"]["service_area"]))
    checks.append(("resolve() is idempotent",
                   ACP.dumps(acp.resolve(py["clients"]["block"])) == ACP.dumps(py["clients"]["block"])))
    for label, ok in checks:
        print(f"  {'✓' if ok else '✗'} {label}")

    failed = bool(mismatches) or bool(wrong) or not all(ok for _, ok in checks)
    print("\n" + "=" * 70)
    print("FAIL" if failed else "PASS — Python and JS agree, inference correct")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
