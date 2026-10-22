#!/usr/bin/env python3
"""
demo_failed.py — a demo build stopped; tell the Apps Script router why.

    APPS_SCRIPT_SECRET=... python3 scripts/demo_failed.py --lead-id abc123 --log /tmp/demo-err.txt

Runs from deploy.yml when a repository_dispatch (free-demo) run fails at any
step. Before this, a refused or crashed build left the prospect's Demos row at
"building" forever: the sales page kept spinning, nobody was emailed, and the
lead went cold. Now the router marks the row failed, the sales page switches
to "we'll finish it by hand", the prospect gets a short honest note, and you
get the reason.

`kind` decides the prospect's note (the raw log never reaches them):
    license   the ROC number is not on the active list, or the name is ambiguous
    existing  that licence already belongs to a paying client's site
    error     anything else — a crash, a publish failure, a timeout
"""
import argparse, json, os, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def classify(log: str) -> str:
    low = log.lower()
    if "is not on the arizona roc active list" in low or "does not resolve to exactly one active licence" in low:
        return "license"
    if "already belongs to real client" in low or "is not a demo — refusing" in low:
        return "existing"
    return "error"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lead-id", default="")
    ap.add_argument("--log", default="")
    a = ap.parse_args()
    if not a.lead_id:
        print("no lead_id on this run — nothing to report")
        return

    log = ""
    if a.log and Path(a.log).exists():
        log = Path(a.log).read_text(errors="replace")
    reason = " ".join(log.split())[-600:] or "the build failed after the demo request was accepted (see the Actions log)"

    cfg = json.loads((ROOT / "config" / "acp.json").read_text())
    body = {
        "action": "demo_failed",
        "secret": os.environ.get("APPS_SCRIPT_SECRET", ""),
        "lead_id": a.lead_id,
        "kind": classify(log),
        "reason": reason,
        "run_url": "{}/{}/actions/runs/{}".format(os.environ.get("GITHUB_SERVER_URL", "https://github.com"),
                                                  os.environ.get("GITHUB_REPOSITORY", ""),
                                                  os.environ.get("GITHUB_RUN_ID", "")),
    }
    req = urllib.request.Request(cfg["apps_script_url"], data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "text/plain;charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            print(r.read().decode()[:300])
    except Exception as e:  # reporting the failure must never mask the failure itself
        print(f"could not reach the router: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
