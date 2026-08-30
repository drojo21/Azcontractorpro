#!/usr/bin/env python3
"""
publish.py — push dist/<client_id>/ to Netlify through the backend.

    BUILDER_KEY=... python3 scripts/publish.py                  # everything in dist/built.json
    BUILDER_KEY=... python3 scripts/publish.py --only some-id
    python3 scripts/publish.py --dry-run

Goes through backend /api/deploy on purpose (not straight to Netlify):
  * it validates the record and refuses non-Active ROC licences
  * it reuses the client's existing Netlify site (stored in Blobs), so a
    re-publish never orphans a claim link that's already been sent
  * it mints the claim link the contractor uses to take ownership
After a successful publish the site id / url / claim link are written back
into clients/<id>/client.json so the repo is the record.
"""
import argparse, json, os, sys, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))
from acp_schema import ACP  # noqa: E402

SKIP = {".acp-build.json"}


def files_of(folder: Path) -> dict:
    out = {}
    for f in folder.rglob("*"):
        if f.is_file() and f.name not in SKIP:
            out[str(f.relative_to(folder)).replace(os.sep, "/")] = f.read_text()
    return out


def post(url, key, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "x-builder-key": key or ""})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    cfg = json.loads((ROOT / "config" / "acp.json").read_text())
    backend = os.environ.get("BACKEND_URL") or cfg["backend_url"]
    key = os.environ.get("BUILDER_KEY", "")
    acp = ACP()

    ids = a.only
    if not ids:
        bj = ROOT / "dist" / "built.json"
        ids = json.loads(bj.read_text()) if bj.exists() else [p.name for p in (ROOT / "dist").iterdir() if p.is_dir()]
    if not ids:
        print("nothing to publish")
        return

    ok, bad = 0, 0
    for cid in ids:
        folder = ROOT / "dist" / cid
        cpath = ROOT / "clients" / cid / "client.json"
        if not folder.exists() or not cpath.exists():
            print(f"  skip {cid}: missing dist or client.json"); continue
        client = json.loads(cpath.read_text())
        files = files_of(folder)
        if a.dry_run:
            print(f"  would publish {cid}: {len(files)} files, tier={client.get('tier')}, "
                  f"site={client.get('deploy',{}).get('netlify_site_id') or 'NEW'}")
            continue
        status, res = post(f"{backend.rstrip('/')}/api/deploy", key, {"client": client, "files": files})
        if status == 200:
            d = client.setdefault("deploy", {})
            d.update({"netlify_site_id": res.get("siteId", ""), "netlify_url": res.get("url", ""),
                      "last_built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                      "last_tier_built": res.get("tier", client.get("tier", ""))})
            if res.get("claimUrl"):
                d["claim_url"] = res["claimUrl"]
            cpath.write_text(acp.dumps(client) + "\n")
            ok += 1
            print(f"  ok   {cid} -> {res.get('url')}  ({'reused' if res.get('reused') else 'new site'})")
        elif status == 409:
            print(f"  hold {cid}: {res.get('error')}")  # claimed by contractor — expected
            bad += 1
        else:
            print(f"  FAIL {cid} [{status}]: {res.get('error') or res}")
            bad += 1
    print(f"\npublished {ok}, problems {bad}")
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
