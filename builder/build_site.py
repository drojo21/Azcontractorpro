#!/usr/bin/env python3
"""
build_site.py — client.json -> a deployable folder of static HTML.

    python3 builder/build_site.py clients/luis-rojos-masonry-llc/client.json
    python3 builder/build_site.py clients/<id>/client.json --out dist/<id> --tier full

Tiers
    lite   one page: index.html (everything on it). The prospect/preview site.
    full   multi-page: index, about, services/<slug>, gallery, reviews, faq,
           service-area/<city>. The paying-client site.

Design rules (why it looks the way it does)
    * Deterministic. Same client.json in, byte-identical HTML out. No AI calls
      here — copy lives in client.json (resolve() in core fills the blanks).
    * Self-contained pages. CSS and JS are inlined, so a page never depends on
      an asset that failed to upload. Fonts come from Google Fonts only.
    * Every page carries LocalBusiness JSON-LD; index/faq carry FAQPage;
      index/services carry the Service ItemList; subpages carry breadcrumbs.
    * Lead form posts to Apps Script as text/plain (see lead-form.js). The
      endpoint comes from client.integrations.lead_endpoint, falling back to
      config/acp.json. If neither is set the form is replaced by a call button
      so the page never *looks* like it captures leads when it doesn't.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))
from acp_schema import ACP, slugify, tel  # noqa: E402

try:
    from jinja2 import Environment, FileSystemLoader, select_autoescape
except ImportError:
    sys.exit("Jinja2 is required: pip install jinja2")

TEMPLATES = Path(__file__).parent / "templates"
CONFIG = ROOT / "config" / "acp.json"
ROC_URL = "https://azroc.my.site.com/AZRoc/s/contractor-search?licenseId="


def load_config() -> dict:
    return json.loads(CONFIG.read_text()) if CONFIG.exists() else {}


def hours_human(spec: str) -> str:
    """'Mo-Fr 07:00-17:00, Sa 08:00-14:00' -> 'Mon–Fri 7am–5pm, Sat 8am–2pm'"""
    days = {"Mo": "Mon", "Tu": "Tue", "We": "Wed", "Th": "Thu", "Fr": "Fri", "Sa": "Sat", "Su": "Sun"}

    def t(hm: str) -> str:
        h, m = hm.split(":")
        h = int(h)
        suffix = "am" if h < 12 else "pm"
        h12 = h % 12 or 12
        return f"{h12}{'' if m == '00' else ':' + m}{suffix}"

    out = []
    for part in str(spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            d, hrs = part.split(" ", 1)
            d = "–".join(days.get(x, x) for x in d.split("-"))
            a, b = hrs.split("-")
            out.append(f"{d} {t(a)}–{t(b)}")
        except ValueError:
            out.append(part)
    return ", ".join(out) or "By appointment"


def favicon(c: dict) -> str:
    letter = (c.get("short_name") or c.get("business_name") or "A")[0].upper()
    svg = (f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
           f"<rect width='64' height='64' rx='12' fill='{c['theme']['primary']}'/>"
           f"<text x='32' y='44' font-size='36' font-family='sans-serif' font-weight='700' "
           f"text-anchor='middle' fill='{c['theme']['accent']}'>{letter}</text></svg>")
    return quote(svg)


# ------------------------------------------------------------------ JSON-LD

def ld_address(c):
    return {"@type": "PostalAddress", "addressLocality": c["city"], "addressRegion": c["state"],
            "postalCode": c["zip"], "addressCountry": "US"}


def ld_local_business(c, base, trade_label):
    d = {
        "@context": "https://schema.org", "@type": "LocalBusiness", "@id": base + "/#business",
        "name": c["business_name"],
        "description": f"Licensed {trade_label.lower()} contractor in {c['city']}, AZ. "
                       + ", ".join(s["name"] for s in c["services"]) + ".",
        "url": base + "/", "telephone": c["phone"], "address": ld_address(c),
        "areaServed": [{"@type": "City", "name": a} for a in c["service_area"]],
        "hasCredential": {"@type": "EducationalOccupationalCredential",
                          "credentialCategory": "Arizona ROC License",
                          "name": c["license_class"], "identifier": c["roc_number"]},
        "priceRange": "$$", "openingHours": c["hours"],
    }
    if c.get("email"):
        d["email"] = c["email"]
    if c.get("owner"):
        d["founder"] = {"@type": "Person", "name": c["owner"]}
    same = [u for u in (c.get("facebook_url"),) if u]
    if same:
        d["sameAs"] = same
    return d


def ld_services(c, base):
    return {"@context": "https://schema.org", "@type": "ItemList", "name": f"{c['business_name']} Services",
            "itemListElement": [{"@type": "ListItem", "position": i + 1, "item": {
                "@type": "Service", "name": s["name"], "description": s["summary"],
                "provider": {"@id": base + "/#business"},
                "areaServed": c["service_area"]}} for i, s in enumerate(c["services"])]}


def ld_faq(c):
    return {"@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [{"@type": "Question", "name": f["q"],
                            "acceptedAnswer": {"@type": "Answer", "text": f["a"]}} for f in c["faqs"]]}


def ld_org(c, base):
    return {"@context": "https://schema.org", "@type": "Organization", "name": c["business_name"],
            "url": base + "/", "telephone": c["phone"], "address": ld_address(c),
            "contactPoint": {"@type": "ContactPoint", "telephone": c["phone"], "contactType": "Customer Service"}}


def ld_crumbs(base, items):
    return {"@context": "https://schema.org", "@type": "BreadcrumbList",
            "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": base + p}
                                for i, (n, p) in enumerate(items)]}


# ------------------------------------------------------------------ build

def build(client_path: Path, out: Path, tier: str | None = None, base_url: str = "") -> list[Path]:
    acp = ACP()
    raw = json.loads(client_path.read_text())
    c = acp.resolve(raw)
    problems = acp.validate(c)
    errs = [p for p in problems if p["level"] == "error"]
    if errs:
        for p in errs:
            print(f"  ERROR {p.get('field','')}: {p.get('message','')}", file=sys.stderr)
        raise SystemExit(f"{client_path}: {len(errs)} validation error(s)")

    tier = tier or c.get("tier") or "lite"
    full = tier == "full"
    cfg = load_config()
    base = (base_url or c["deploy"].get("custom_domain") or c["deploy"].get("netlify_url")
            or c.get("site_url") or "").rstrip("/")
    if base and not base.startswith("http"):
        base = "https://" + base

    lead_endpoint = c["integrations"].get("lead_endpoint") or cfg.get("apps_script_url", "")
    gallery_endpoint = c["integrations"].get("gallery_endpoint") or lead_endpoint
    trade_label = acp.trades[c["trade"]]["label"]

    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html"]),
                      trim_blocks=True, lstrip_blocks=True)
    lead_js = (TEMPLATES / "lead-form.js").read_text()

    def url(path: str) -> str:
        # Relative-root links work on Netlify previews and custom domains alike.
        return path if full else ("/" + path.lstrip("/#") if path.startswith("#") else path)

    if full:
        nav = [("Home", "/"), ("Services", "/services/"), ("About", "/about/"),
               ("Gallery", "/gallery/"), ("Reviews", "/reviews/"), ("FAQ", "/faq/"), ("Contact", "/#quote")]
    else:
        nav = [("Services", "#services"), ("About", "#about"), ("Gallery", "#gallery"),
               ("Reviews", "#reviews"), ("FAQ", "#faq"), ("Contact", "#quote")]

    common = dict(c=c, full=full, tel=tel(c["phone"]), trade_label=trade_label,
                  hours_human=hours_human(c["hours"]), roc_url=ROC_URL + c["roc_number"],
                  lead_endpoint=lead_endpoint, gallery_endpoint=gallery_endpoint,
                  lead_form_js=lead_js, favicon=favicon(c), year=date.today().year,
                  url=lambda p: p, slug=slugify)

    site_desc = (f"{c['business_name']} — licensed {trade_label.lower()} contractor in {c['city']}, AZ "
                 f"(ROC #{c['roc_number']}). {', '.join(s['name'] for s in c['services'][:3])}. "
                 f"Free written estimates.")

    pages: list[tuple[str, str, dict]] = []  # (template, out path, page ctx)

    def add(template, path, title, description, jsonld, **extra):
        pages.append((template, path, {"title": title, "description": description[:160],
                                       "canonical": base + path, "jsonld": jsonld, **extra}))

    lb = ld_local_business(c, base, trade_label)
    add("index.html", "/", f"{c['business_name']} | {trade_label} Contractor in {c['city']}, AZ | ROC #{c['roc_number']}",
        site_desc, [lb, ld_services(c, base), ld_faq(c), ld_org(c, base)])

    if full:
        add("services.html", "/services/", f"{trade_label} Services | {c['short_name']}",
            f"{trade_label} services in {c['city']}: " + ", ".join(s["name"] for s in c["services"]),
            [lb, ld_services(c, base), ld_crumbs(base, [("Home", "/"), ("Services", "/services/")])])
        for s in c["services"]:
            p = f"/services/{s['slug']}/"
            add("service.html", p, f"{s['name']} in {c['city']}, AZ | {c['short_name']}", s["summary"],
                [lb, {"@context": "https://schema.org", "@type": "Service", "name": s["name"],
                      "description": s["summary"], "provider": {"@id": base + "/#business"},
                      "areaServed": c["service_area"]},
                 ld_crumbs(base, [("Home", "/"), ("Services", "/services/"), (s["name"], p)])], service=s)
        add("about.html", "/about/", f"About {c['short_name']} | Licensed {trade_label} in {c['city']}",
            f"About {c['business_name']}: ROC #{c['roc_number']}, serving " + ", ".join(c["service_area"]),
            [lb, ld_org(c, base), ld_crumbs(base, [("Home", "/"), ("About", "/about/")])])
        add("gallery.html", "/gallery/", f"Project Gallery | {c['short_name']}",
            f"Recent {trade_label.lower()} projects by {c['business_name']} in {c['city']}.",
            [lb, ld_crumbs(base, [("Home", "/"), ("Gallery", "/gallery/")])])
        add("reviews.html", "/reviews/", f"Reviews | {c['short_name']}",
            f"Customer reviews for {c['business_name']}, {c['city']} AZ.",
            [lb, ld_crumbs(base, [("Home", "/"), ("Reviews", "/reviews/")])])
        add("faq.html", "/faq/", f"FAQ | {c['short_name']}",
            f"Answers about licensing, estimates and scheduling from {c['business_name']}.",
            [lb, ld_faq(c), ld_crumbs(base, [("Home", "/"), ("FAQ", "/faq/")])])
        for a in c["service_area"]:
            p = f"/service-area/{slugify(a)}/"
            add("area.html", p, f"{trade_label} Contractor in {a}, AZ | {c['short_name']}",
                f"{c['business_name']} serves {a}, AZ with licensed {trade_label.lower()} work. ROC #{c['roc_number']}.",
                [lb, ld_crumbs(base, [("Home", "/"), ("Service area", "/about/"), (a, p)])], area=a)

    out.mkdir(parents=True, exist_ok=True)
    written = []
    for template, path, page in pages:
        html = env.get_template(template).render(
            **common, page=page,
            nav=[{"label": l, "href": h, "current": h == path} for l, h in nav])
        dest = out / path.strip("/") / "index.html" if path != "/" else out / "index.html"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(html)
        written.append(dest)

    # Crawl helpers. Netlify serves /about/ -> /about/index.html natively.
    today = date.today().isoformat()
    (out / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{base}{p}</loc><lastmod>{today}</lastmod></url>\n" for _, p, _ in pages)
        + "</urlset>\n")
    (out / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {base}/sitemap.xml\n")
    (out / "404.html").write_text(
        f'<!doctype html><meta charset=utf-8><meta http-equiv="refresh" content="0; url=/">'
        f'<title>{c["short_name"]}</title><p>Page not found. <a href="/">Back to {c["short_name"]}</a>')
    (out / ".acp-build.json").write_text(json.dumps({
        "client_id": c["client_id"], "tier": tier, "pages": len(pages), "built": today,
        "warnings": [p for p in problems if p["level"] != "error"]}, indent=2))
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("client", help="path to client.json")
    ap.add_argument("--out", help="output folder (default dist/<client_id>)")
    ap.add_argument("--tier", choices=["lite", "full"], help="override client.tier")
    ap.add_argument("--base-url", default="", help="canonical base URL override")
    args = ap.parse_args()

    cp = Path(args.client)
    cid = json.loads(cp.read_text()).get("client_id") or cp.parent.name
    out = Path(args.out) if args.out else ROOT / "dist" / cid
    files = build(cp, out, args.tier, args.base_url)
    print(f"built {cid}: {len(files)} page(s) -> {out}")


if __name__ == "__main__":
    main()
