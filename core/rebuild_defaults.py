#!/usr/bin/env python3
"""
rebuild_defaults.py — regenerate trade_defaults.json from a real ROC export.

The first version of trade_defaults.json inferred trade from the numeric suffix
of a license class. The real ROC file proves that is unsound: the same suffix
means different things under different class prefixes.

    A-11  Steel and Aluminum Erection      vs   CR-11  Electrical
    A-14  Asphalt Paving                   vs   CR-14  Fencing
    A-12  Sewers Drains and Pipe Laying    vs   C-12   Elevators

So the key is the FULL class code. This script writes that map, and prints
coverage against the source file so a miss is visible instead of silent.

    python3 rebuild_defaults.py ROC_export.csv --out trade_defaults.json
"""

import argparse
import collections
import csv
import json
import re
from pathlib import Path

HERE = Path(__file__).parent

# --------------------------------------------------------------- new trades
# Trades the real roster contains that the first table had no entry for. Volume
# in the 2024-05-22 file is noted so the long tail is a deliberate choice.

NEW_TRADES = {
    "pools": {  # ~143 records
        "label": "Swimming Pools",
        "theme": {"primary": "#075985", "accent": "#22d3ee", "display_font": "Outfit", "body_font": "DM Sans"},
        "icon": "water", "tagline": "Water Done Right. Season After Season.",
        "gbp": {"primary": "Swimming Pool Contractor", "secondary": "Swimming Pool Repair Service"},
        "fb_interests": ["Outdoor living", "Home improvement", "Swimming pools", "Backyard design"],
        "keywords": ["pool", "swimming pool", "spa", "hot tub"],
        "default_services": [
            ["pool-construction", "Pool Construction", "New pools engineered, permitted, and built from excavation through startup."],
            ["pool-remodeling", "Pool Remodeling", "Resurfacing, retiling, and coping replacement on pools that have aged out."],
            ["equipment-repair", "Equipment Repair", "Pumps, filters, heaters, and automation diagnosed and replaced."],
            ["pool-service", "Pool Service", "Scheduled cleaning and chemistry that keeps the water clear through summer."],
        ],
    },
    "handyman": {  # 179 records — R-62 Minor Home Improvements, third-largest class
        "label": "Home Improvements",
        "theme": {"primary": "#334155", "accent": "#f59e0b", "display_font": "Inter", "body_font": "Source Sans 3"},
        "icon": "toolbox", "tagline": "The List You've Been Putting Off.",
        "gbp": {"primary": "Handyman", "secondary": "Home Improvement Service"},
        "fb_interests": ["Home improvement", "DIY home projects", "Home renovation", "Homeowners"],
        "keywords": ["handyman", "home improvement", "minor home", "repairs"],
        "default_services": [
            ["repairs", "Home Repairs", "The backlog of small fixes, handled in one licensed visit."],
            ["installations", "Installations & Mounting", "Fixtures, shelving, TVs, and hardware mounted into something solid."],
            ["door-window", "Doors & Windows", "Doors that stick, windows that won't latch, and hardware that's given up."],
            ["punch-lists", "Punch Lists", "Pre-sale and post-move-in lists cleared before your deadline."],
        ],
    },
    "tile": {  # ~45
        "label": "Tile",
        "theme": {"primary": "#3f3f46", "accent": "#0d9488", "display_font": "Oswald", "body_font": "Lato"},
        "icon": "tile", "tagline": "Straight Lines. Tight Grout.",
        "gbp": {"primary": "Tile Contractor", "secondary": "Tile Installation Service"},
        "fb_interests": ["Home improvement", "Interior design", "Home renovation", "Bathroom design"],
        "keywords": ["tile", "ceramic", "porcelain", "grout"],
        "default_services": [
            ["floor-tile", "Floor Tile", "Large-format and standard floor tile set flat with proper movement joints."],
            ["showers-baths", "Showers & Baths", "Waterproofed shower systems built to last, not just to look right on day one."],
            ["backsplashes", "Backsplashes", "Kitchen and bar backsplashes cut clean around outlets and corners."],
            ["tile-repair", "Tile & Grout Repair", "Cracked tile replacement and regrouting matched to the existing work."],
        ],
    },
    "lowvoltage": {  # ~74
        "label": "Low Voltage",
        "theme": {"primary": "#1e293b", "accent": "#38bdf8", "display_font": "Outfit", "body_font": "DM Sans"},
        "icon": "signal", "tagline": "Wired Clean. Working Always.",
        "gbp": {"primary": "Security System Installer", "secondary": "Home Automation Company"},
        "fb_interests": ["Smart home", "Home security", "Home theater", "Home improvement"],
        "keywords": ["low voltage", "security system", "structured wiring", "network", "audio visual"],
        "default_services": [
            ["security-cameras", "Security Cameras", "Camera systems placed for real coverage, with the recorder somewhere safe."],
            ["structured-wiring", "Structured Wiring", "Data and coax runs terminated and labeled in a proper panel."],
            ["access-control", "Access Control", "Gate, door, and intercom systems installed and integrated."],
            ["audio-video", "Audio & Video", "Distributed audio and theater wiring done before the drywall closes."],
        ],
    },
    "welding": {  # ~32 — ornamental metals + welding
        "label": "Welding & Ornamental Metal",
        "theme": {"primary": "#292524", "accent": "#f97316", "display_font": "Oswald", "body_font": "Lato"},
        "icon": "spark", "tagline": "Steel That Holds. Work That Shows.",
        "gbp": {"primary": "Welder", "secondary": "Metal Fabricator"},
        "fb_interests": ["Home improvement", "Outdoor living", "Home security", "Custom design"],
        "keywords": ["welding", "ornamental metal", "wrought iron", "fabrication", "metalwork"],
        "default_services": [
            ["custom-gates", "Custom Gates & Railings", "Fabricated iron gates, railings, and security doors built to the opening."],
            ["mobile-welding", "Mobile Welding", "On-site repair welding for equipment, trailers, and structures."],
            ["shade-structures", "Shade Structures", "Steel ramadas and carports engineered for desert wind loads."],
            ["metal-repair", "Metal Repair", "Rust repair, re-welding, and refinishing on existing ironwork."],
        ],
    },
    "steel": {  # ~28
        "label": "Steel Erection",
        "theme": {"primary": "#3f3f46", "accent": "#eab308", "display_font": "Oswald", "body_font": "Lato"},
        "icon": "beam", "tagline": "Plumb, Square, and Signed Off.",
        "gbp": {"primary": "Structural Engineer", "secondary": "Steel Erector"},
        "fb_interests": ["Construction", "Commercial real estate", "New home", "Home renovation"],
        "keywords": ["steel erection", "structural steel", "aluminum erection", "steel and aluminum"],
        "default_services": [
            ["structural-steel", "Structural Steel", "Beam, column, and joist erection to stamped drawings."],
            ["metal-buildings", "Metal Buildings", "Pre-engineered building assembly from slab to sheeting."],
            ["retrofit", "Structural Retrofit", "Load-bearing modifications and beam replacement in existing structures."],
            ["misc-metals", "Miscellaneous Metals", "Stairs, catwalks, and embeds fabricated and set."],
        ],
    },
    "insulation": {  # ~19
        "label": "Insulation",
        "theme": {"primary": "#7c2d12", "accent": "#facc15", "display_font": "Inter", "body_font": "Source Sans 3"},
        "icon": "layers", "tagline": "Lower Bills. Quieter Rooms.",
        "gbp": {"primary": "Insulation Contractor", "secondary": "Energy Efficiency Service"},
        "fb_interests": ["Energy efficiency", "Home improvement", "Home renovation", "Utility savings"],
        "keywords": ["insulation", "spray foam", "blown-in", "radiant barrier"],
        "default_services": [
            ["attic-insulation", "Attic Insulation", "Blown-in attic insulation brought up to current R-value."],
            ["spray-foam", "Spray Foam", "Closed and open cell foam for walls, attics, and crawl spaces."],
            ["radiant-barrier", "Radiant Barrier", "Attic radiant barrier that cuts summer heat gain measurably."],
            ["removal", "Removal & Remediation", "Old, contaminated, or rodent-damaged insulation removed and replaced."],
        ],
    },
    "demolition": {  # ~24
        "label": "Demolition",
        "theme": {"primary": "#450a0a", "accent": "#f97316", "display_font": "Oswald", "body_font": "Lato"},
        "icon": "wrecking", "tagline": "Down Fast. Hauled Clean.",
        "gbp": {"primary": "Demolition Contractor", "secondary": "Debris Removal Service"},
        "fb_interests": ["Construction", "Home renovation", "Real estate development", "Land clearing"],
        "keywords": ["demolition", "wrecking", "teardown", "debris removal"],
        "default_services": [
            ["structure-demolition", "Structure Demolition", "Full and partial teardowns with utilities disconnected first."],
            ["interior-demolition", "Interior Demolition", "Selective interior strip-out that protects what stays."],
            ["concrete-removal", "Concrete Removal", "Driveway, patio, and slab removal with hauling included."],
            ["cleanup-hauling", "Cleanup & Hauling", "Debris loaded, hauled, and disposed of with the site left clear."],
        ],
    },
    "fireprotection": {  # ~25
        "label": "Fire Protection",
        "theme": {"primary": "#7f1d1d", "accent": "#f87171", "display_font": "Inter", "body_font": "Source Sans 3"},
        "icon": "flame", "tagline": "Inspected. Certified. Ready.",
        "gbp": {"primary": "Fire Protection Service", "secondary": "Fire Sprinkler System Contractor"},
        "fb_interests": ["Commercial real estate", "Property management", "Business services", "Construction"],
        "keywords": ["fire protection", "fire sprinkler", "fire alarm", "suppression"],
        "default_services": [
            ["sprinkler-systems", "Sprinkler Systems", "Design, installation, and hydro testing to NFPA standards."],
            ["fire-alarms", "Fire Alarm Systems", "Alarm and monitoring systems installed and commissioned."],
            ["inspections", "Inspections & Testing", "Annual and quarterly testing with the paperwork your AHJ wants."],
            ["suppression", "Suppression Systems", "Kitchen hood and special hazard suppression service."],
        ],
    },
    "asphalt": {  # ~27
        "label": "Asphalt Paving",
        "theme": {"primary": "#27272a", "accent": "#fbbf24", "display_font": "Oswald", "body_font": "Lato"},
        "icon": "road", "tagline": "Smooth Lots. Straight Stripes.",
        "gbp": {"primary": "Asphalt Contractor", "secondary": "Paving Contractor"},
        "fb_interests": ["Commercial real estate", "Property management", "Home improvement", "Construction"],
        "keywords": ["asphalt", "paving", "seal coating", "sealcoat", "striping"],
        "default_services": [
            ["paving", "Asphalt Paving", "New asphalt and overlays placed over a properly prepared base."],
            ["seal-coating", "Seal Coating", "Seal coat applied on a real schedule to extend surface life."],
            ["crack-repair", "Crack & Pothole Repair", "Routed and filled cracks before water gets into the base."],
            ["striping", "Striping & ADA", "Layout and striping including compliant accessible spaces."],
        ],
    },
    "welldrilling": {  # ~16
        "label": "Well Drilling",
        "theme": {"primary": "#164e63", "accent": "#84cc16", "display_font": "Inter", "body_font": "Source Sans 3"},
        "icon": "drill", "tagline": "Water Found. Water Flowing.",
        "gbp": {"primary": "Water Well Drilling Service", "secondary": "Pump Service"},
        "fb_interests": ["Rural property", "New home", "Land development", "Homesteading"],
        "keywords": ["well drilling", "water well", "drilling", "pump"],
        "default_services": [
            ["well-drilling", "Well Drilling", "Permitted domestic and irrigation wells drilled and cased."],
            ["pump-systems", "Pump Systems", "Submersible pumps, pressure tanks, and controls sized correctly."],
            ["well-rehab", "Well Rehabilitation", "Yield restoration and casing repair on underperforming wells."],
            ["water-testing", "Water Testing", "Potability and mineral testing with results explained plainly."],
        ],
    },
    "septic": {  # ~14
        "label": "Septic Systems",
        "theme": {"primary": "#365314", "accent": "#a3e635", "display_font": "Inter", "body_font": "Source Sans 3"},
        "icon": "tank", "tagline": "Designed, Permitted, Passing.",
        "gbp": {"primary": "Septic System Service", "secondary": "Excavating Contractor"},
        "fb_interests": ["Rural property", "New home", "Home improvement", "Real estate"],
        "keywords": ["septic", "leach field", "onsite wastewater"],
        "default_services": [
            ["septic-install", "Septic Installation", "New systems designed, permitted, and installed to county spec."],
            ["repairs", "Septic Repair", "Failed tanks, lines, and leach fields diagnosed before they're dug up."],
            ["inspections", "Transfer Inspections", "Real-estate transfer inspections and the report your escrow needs."],
            ["pumping", "Pumping & Maintenance", "Scheduled pumping that keeps a system from becoming a replacement."],
        ],
    },
    "awnings": {  # ~19
        "label": "Awnings & Patio Covers",
        "theme": {"primary": "#7c2d12", "accent": "#fb923c", "display_font": "Oswald", "body_font": "Lato"},
        "icon": "shade", "tagline": "Shade Where You Actually Sit.",
        "gbp": {"primary": "Awning Supplier", "secondary": "Patio Enclosure Supplier"},
        "fb_interests": ["Outdoor living", "Home improvement", "Patio design", "Home renovation"],
        "keywords": ["awning", "canopy", "carport", "patio cover", "ramada"],
        "default_services": [
            ["patio-covers", "Patio Covers", "Attached and freestanding covers engineered for wind and sun."],
            ["carports", "Carports", "Vehicle covers that meet setback and permit requirements."],
            ["awnings", "Awnings & Canopies", "Fixed and retractable awnings sized to the opening they shade."],
            ["screen-rooms", "Screen Rooms", "Screened enclosures that make a patio usable in monsoon season."],
        ],
    },
    "signs": {  # ~17
        "label": "Signs",
        "theme": {"primary": "#312e81", "accent": "#f472b6", "display_font": "Poppins", "body_font": "Open Sans"},
        "icon": "sign", "tagline": "Seen From the Street.",
        "gbp": {"primary": "Sign Shop", "secondary": "Commercial Sign Installer"},
        "fb_interests": ["Small business", "Business services", "Commercial real estate", "Marketing"],
        "keywords": ["sign", "signage", "channel letter", "monument sign"],
        "default_services": [
            ["channel-letters", "Channel Letters", "Illuminated storefront letters fabricated, permitted, and installed."],
            ["monument-signs", "Monument Signs", "Ground and monument signs built to the center's design standards."],
            ["vehicle-wraps", "Vehicle Graphics", "Fleet lettering and wraps that stay legible at speed."],
            ["sign-service", "Sign Service", "Lighting repair, face replacement, and maintenance on existing signs."],
        ],
    },
    "glass": {  # ~28
        "label": "Glass & Glazing",
        "theme": {"primary": "#155e75", "accent": "#67e8f9", "display_font": "Outfit", "body_font": "DM Sans"},
        "icon": "pane", "tagline": "Clear Views. Clean Installs.",
        "gbp": {"primary": "Glass Repair Service", "secondary": "Window Installation Service"},
        "fb_interests": ["Home improvement", "Interior design", "Energy efficiency", "Home renovation"],
        "keywords": ["glazing", "glass", "window replacement", "shower door", "mirror"],
        "default_services": [
            ["window-replacement", "Window Replacement", "Dual-pane replacement windows installed and sealed correctly."],
            ["shower-enclosures", "Shower Enclosures", "Frameless and framed glass enclosures templated to the opening."],
            ["storefront-glass", "Storefront Glass", "Commercial storefront systems and door glass repair."],
            ["mirrors", "Mirrors & Custom Glass", "Wall mirrors, tabletops, and custom-cut glass to order."],
        ],
    },
}

# ------------------------------------------------------- authoritative map
# Full class code -> trade. Taken from the Class Detail column of a real ROC
# export, NOT from the numeric suffix. Confidence is about the trade *mapping*
# being a good fit for a marketing site, not about the code's meaning.

CLASS_MAP = {
    # --- A: general engineering / commercial heavy ---
    "A":     ("general", "high"),
    "A-4":   ("welldrilling", "high"),
    "A-5":   ("excavating", "high"),
    "A-7":   ("concrete", "medium"),
    "A-11":  ("steel", "high"),
    "A-12":  ("plumbing", "medium"),
    "A-14":  ("asphalt", "high"),
    "A-15":  ("asphalt", "high"),
    "A-16":  ("plumbing", "medium"),
    "A-17":  ("electrical", "high"),
    # --- B: general building ---
    "B":     ("general", "high"),
    "B-1":   ("general", "high"),
    "B-2":   ("general", "high"),
    "B-3":   ("general", "high"),
    "B-4":   ("general", "high"),
    "B-5":   ("pools", "high"),
    "B-6":   ("pools", "high"),
    "B-10":  ("pools", "high"),
    # --- K: dual (residential + commercial) ---
    "KA":    ("general", "high"),
    "KA-5":  ("pools", "high"),
    "KA-6":  ("pools", "high"),
    "KB":    ("general", "high"),
    "KB-1":  ("general", "high"),
    "KB-2":  ("general", "high"),
    # --- specialty suffixes shared across C / CR / R ---
    "*-1":   ("sheetrock", "medium"),
    "*-2":   ("excavating", "high"),
    "*-3":   ("awnings", "high"),
    "*-4":   ("plumbing", "medium"),
    "*-5":   ("general", "low"),
    "*-6":   ("pools", "high"),
    "*-7":   ("carpentry", "high"),
    "*-8":   ("flooring", "high"),
    "*-9":   ("concrete", "high"),
    "*-10":  ("sheetrock", "high"),
    "*-11":  ("electrical", "high"),
    "*-12":  ("general", "low"),
    "*-13":  ("asphalt", "high"),
    "*-14":  ("fencing", "high"),
    "*-16":  ("fireprotection", "high"),
    "*-17":  ("steel", "high"),
    "*-21":  ("landscaping", "high"),
    "*-24":  ("welding", "high"),
    "*-29":  ("general", "low"),
    "*-31":  ("masonry", "high"),
    "*-34":  ("painting", "high"),
    "*-36":  ("masonry", "medium"),
    "*-37":  ("plumbing", "high"),
    "*-37R": ("plumbing", "high"),
    "*-38":  ("signs", "high"),
    "*-39":  ("hvac", "high"),
    "*-39R": ("hvac", "high"),
    "*-40":  ("insulation", "high"),
    "*-41":  ("septic", "high"),
    "*-42":  ("roofing", "high"),
    "*-45":  ("hvac", "medium"),
    "*-48":  ("tile", "high"),
    "*-49":  ("hvac", "high"),
    "*-53":  ("welldrilling", "high"),
    "*-54":  ("plumbing", "medium"),
    "*-56":  ("welding", "high"),
    "*-57":  ("demolition", "high"),
    "*-58":  ("hvac", "high"),
    "*-60":  ("carpentry", "high"),
    "*-61":  ("carpentry", "high"),
    "*-62":  ("handyman", "high"),
    "*-65":  ("glass", "high"),
    "*-67":  ("lowvoltage", "high"),
    "*-69":  ("asphalt", "high"),
    "*-70":  ("concrete", "high"),
    "*-77":  ("plumbing", "high"),
    "*-79":  ("hvac", "high"),
    "*-80":  ("plumbing", "high"),
}

SPECIALTY_PREFIXES = ["C", "CR", "R"]


def expand(class_map):
    """Turn the '*-NN' shorthand into explicit C-NN / CR-NN / R-NN entries."""
    out = {}
    for code, (trade, conf) in class_map.items():
        if code.startswith("*-"):
            suffix = code[2:]
            for p in SPECIALTY_PREFIXES:
                out[f"{p}-{suffix}"] = {"trade": trade, "confidence": conf}
        else:
            out[code] = {"trade": trade, "confidence": conf}
    return out


def build_trade(key, spec):
    return {
        "label": spec["label"],
        "theme": spec["theme"],
        "icon": spec["icon"],
        "tagline": spec["tagline"],
        "gbp": spec["gbp"],
        "fb_interests": spec["fb_interests"],
        "keywords": spec["keywords"],
        "default_services": [
            {"slug": s, "name": n, "summary": d} for s, n, d in spec["default_services"]
        ],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="?", help="ROC export to measure coverage against")
    ap.add_argument("--base", default=str(HERE / "trade_defaults.json"))
    ap.add_argument("--out", default=str(HERE / "trade_defaults.json"))
    args = ap.parse_args()

    defaults = json.loads(Path(args.base).read_text(encoding="utf-8"))

    for key, spec in NEW_TRADES.items():
        defaults["trades"][key] = build_trade(key, spec)

    expanded = expand(CLASS_MAP)
    defaults["roc"] = {
        "_note": (
            "class_map is keyed on the FULL license class code, taken from the "
            "Class Detail column of a real ROC export. Suffix-based inference is "
            "unsound: A-11 is Steel Erection while CR-11 is Electrical, and A-14 "
            "is Asphalt Paving while CR-14 is Fencing. Inference order: "
            "(1) exact class_map hit, (2) description keywords, (3) business-name "
            "keywords, (4) 'general' at low confidence."
        ),
        "source": "ROC New Licenses List, 2024-05-22, 3876 records, 129 distinct class codes",
        "class_map": dict(sorted(expanded.items())),
    }
    defaults["_meta"]["version"] = "2.0.0"
    defaults["_meta"]["verify"] = (
        "roc.class_map is derived from real ROC data, not guesswork. Re-run "
        "rebuild_defaults.py against a newer export when ROC adds classifications."
    )

    Path(args.out).write_text(
        json.dumps(defaults, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {args.out}: {len(defaults['trades'])} trades, "
          f"{len(expanded)} class codes")

    if not args.csv:
        return
    rows = list(csv.DictReader(
        Path(args.csv).read_text(encoding="utf-8-sig").splitlines()[1:]))
    hits = collections.Counter()
    misses = collections.Counter()
    for r in rows:
        code = r["Class"].strip().upper()
        hit = expanded.get(code)
        if hit:
            hits[hit["trade"]] += 1
        else:
            misses[f'{code} :: {r["Class Detail"].strip()}'] += 1

    total = len(rows)
    covered = sum(hits.values())
    print(f"\nCOVERAGE: {covered}/{total} rows mapped ({100 * covered // total}%)")
    print("\nrows by trade:")
    for trade, n in hits.most_common():
        print(f"  {trade:16} {n:5}  ({100 * n / total:4.1f}%)")
    if misses:
        print(f"\nUNMAPPED ({sum(misses.values())} rows):")
        for m, n in misses.most_common(30):
            print(f"  {n:5}  {m}")


if __name__ == "__main__":
    main()
