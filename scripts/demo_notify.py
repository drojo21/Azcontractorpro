#!/usr/bin/env python3
"""
demo_notify.py — after a demo site is published, tell the Apps Script router.

    APPS_SCRIPT_SECRET=... python3 scripts/demo_notify.py <client_id>

Posts action=demo_ready with the live URL and claim link. The router matches
client_id against its Demos tab (where the original form submission was logged)
and emails the prospect. The prospect's address is deliberately NOT sent here —
the router only ever emails addresses it captured itself.
"""
import json, os, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: demo_notify.py <client_id>")
    cid = sys.argv[1]
    cfg = json.loads((ROOT / "config" / "acp.json").read_text())
    client = json.loads((ROOT / "clients" / cid / "client.json").read_text())
    dep = client.get("deploy") or {}
    if not dep.get("netlify_url"):
        sys.exit(f"{cid}: no netlify_url recorded — publish must have failed")

    body = {
        "action": "demo_ready",
        "secret": os.environ.get("APPS_SCRIPT_SECRET", ""),
        "client_id": cid,
        "lead_id": (dep.get("demo_contact") or {}).get("lead_id", ""),
        "business_name": client.get("business_name", ""),
        "url": dep.get("netlify_url", ""),
        "claim_url": dep.get("claim_url", ""),
        "tier": dep.get("last_tier_built", client.get("tier", "lite")),
    }
    # text/plain on purpose — Apps Script web apps don't answer CORS preflight
    # (irrelevant server-side) but they also redirect POSTs; urllib follows it.
    req = urllib.request.Request(cfg["apps_script_url"], data=json.dumps(body).encode(),
                                 method="POST", headers={"Content-Type": "text/plain;charset=utf-8"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.loads(r.read() or b"{}")
    print(json.dumps(res))
    if not res.get("ok"):
        sys.exit(f"router rejected demo_ready: {res}")


if __name__ == "__main__":
    main()
