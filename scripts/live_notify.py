#!/usr/bin/env python3
"""
live_notify.py — after publish, tell the router which paying customers' sites
just went live so it can email them (action=site_live).

    APPS_SCRIPT_SECRET=... python3 scripts/live_notify.py            # everything in dist/built.json
    APPS_SCRIPT_SECRET=... python3 scripts/live_notify.py --only id

A client qualifies once: onboarding.status == "submitted" (they finished the
setup form), no onboarding.live_notified_at yet, not a demo, and a published
URL on record. On success the timestamp is written into client.json, and the
workflow's "Record site ids" step commits it with everything else — so a
rebuild next month never re-sends "your site is live".

Like demo_notify.py, this never sends an email address: the router emails the
buyer address it captured itself from the onboarded event.
"""
import argparse, json, os, sys, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))
from acp_schema import ACP  # noqa: E402


def due(client: dict) -> bool:
    onb = client.get("onboarding") or {}
    dep = client.get("deploy") or {}
    return (onb.get("status") == "submitted" and not onb.get("live_notified_at")
            and not onb.get("full_pending") and not dep.get("demo") and bool(dep.get("netlify_url")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    cfg = json.loads((ROOT / "config" / "acp.json").read_text())
    acp = ACP()
    ids = a.only
    if not ids:
        bj = ROOT / "dist" / "built.json"
        ids = json.loads(bj.read_text()) if bj.exists() else []

    sent = 0
    for cid in ids:
        cpath = ROOT / "clients" / cid / "client.json"
        if not cpath.exists():
            continue
        client = json.loads(cpath.read_text())
        if not due(client):
            continue
        dep = client.get("deploy") or {}
        sub = dep.get("netlify_subdomain", "")
        body = {
            "action": "site_live",
            "secret": os.environ.get("APPS_SCRIPT_SECRET", ""),
            "client_id": cid,
            "business_name": client.get("business_name", ""),
            "plan": client.get("plan", ""),
            "tier": dep.get("last_tier_built", client.get("tier", "")),
            "url": f"https://{sub}" if sub else dep.get("netlify_url", ""),
            "custom_domain": dep.get("custom_domain", ""),
            "netlify_subdomain": sub,
            "claim_url": dep.get("claim_url", ""),
        }
        if a.dry_run:
            print(f"  would notify {cid}: {body['url']}")
            continue
        req = urllib.request.Request(cfg["apps_script_url"], data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "text/plain;charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                res = json.loads(r.read() or b"{}")
        except Exception as e:
            print(f"  FAIL {cid}: could not reach the router ({e}) — will retry on the next publish")
            continue
        if not res.get("ok"):
            print(f"  FAIL {cid}: router said {res} — will retry on the next publish")
            continue
        client.setdefault("onboarding", {})["live_notified_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        cpath.write_text(acp.dumps(client) + "\n")
        sent += 1
        print(f"  live {cid} -> {body['url']}")
    print(f"live notifications sent: {sent}")


if __name__ == "__main__":
    main()
