#!/usr/bin/env python3
"""
demo_notify.py — after a demo site is published, tell the Apps Script router.

    APPS_SCRIPT_SECRET=... python3 scripts/demo_notify.py <client_id>
    APPS_SCRIPT_SECRET=... python3 scripts/demo_notify.py <client_id> --allow-no-claim

Posts action=demo_ready with the live URL and claim link. The router matches
client_id against its Demos tab (where the original form submission was logged)
and emails the prospect. The prospect's address is deliberately NOT sent here —
the router only ever emails addresses it captured itself.
"""
import argparse, json, os, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser(description="tell the Apps Script router a demo is live")
    ap.add_argument("client_id")
    ap.add_argument("--allow-no-claim", action="store_true",
                    help="exit 0 even when the demo went out with no claim link")
    a = ap.parse_args()
    cid = a.client_id
    cfg = json.loads((ROOT / "config" / "acp.json").read_text())
    client = json.loads((ROOT / "clients" / cid / "client.json").read_text())
    dep = client.get("deploy") or {}
    if not dep.get("netlify_url"):
        sys.exit(f"{cid}: no netlify_url recorded — publish must have failed")

    # Checked before the send, reported after it. demo.gs renders its "Claim it
    # here" paragraph off claim_url alone and drops the paragraph when it is
    # empty, so this is a degraded email — but the site link and the checkout
    # buttons are the real payload, and refusing to send would lose the lead
    # outright. Send first, then fail the run.
    no_claim = not dep.get("claim_url") and not dep.get("claimed_at")

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

    # The email is out by this point, so this costs nothing but a red run — and
    # a red run is the only thing that was missing. This used to pass silently.
    if no_claim and not a.allow_no_claim:
        sys.exit(f"\n{cid}: demo email SENT, but with NO claim link in it — the prospect "
                 f"has their\n"
                 f"  site and checkout buttons, but no way to take ownership of the site.\n"
                 f"  Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET on the backend function, "
                 f"re-run\n"
                 f"  scripts/publish.py, then re-send with scripts/demo_notify.py {cid}.\n"
                 f"  Pass --allow-no-claim to treat a claim-less send as success.")


if __name__ == "__main__":
    main()
