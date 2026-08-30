#!/usr/bin/env python3
"""
build_all.py — build every clients/*/client.json into dist/<client_id>/.

    python3 scripts/build_all.py                 # all
    python3 scripts/build_all.py --only a-id b-id
    python3 scripts/build_all.py --changed       # only clients touched in the last commit
"""
import argparse, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "builder"))
from build_site import build  # noqa: E402


def changed_ids():
    try:
        out = subprocess.check_output(["git", "diff", "--name-only", "HEAD~1", "HEAD"], cwd=ROOT, text=True)
    except subprocess.CalledProcessError:
        return None
    files = out.split()
    # Builder/core/config changes affect every site.
    if any(f.startswith(("builder/", "core/", "config/")) for f in files):
        return None
    return sorted({f.split("/")[1] for f in files if f.startswith("clients/") and f.count("/") >= 2})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--changed", action="store_true")
    a = ap.parse_args()

    ids = a.only
    if a.changed and not ids:
        ids = changed_ids()
        if ids == []:
            print("no client changes in last commit; nothing to build")
            (ROOT / "dist").mkdir(exist_ok=True)
            (ROOT / "dist" / "built.json").write_text("[]")
            return

    paths = sorted((ROOT / "clients").glob("*/client.json"))
    if ids:
        paths = [p for p in paths if p.parent.name in ids]
    if not paths:
        sys.exit("nothing to build")

    built, failed = [], []
    for p in paths:
        cid = p.parent.name
        try:
            files = build(p, ROOT / "dist" / cid)
            built.append(cid)
            print(f"  ok   {cid}  ({len(files)} pages)")
        except SystemExit as e:
            failed.append(cid)
            print(f"  FAIL {cid}: {e}")
    (ROOT / "dist").mkdir(exist_ok=True)
    (ROOT / "dist" / "built.json").write_text(json.dumps(built))
    print(f"\nbuilt {len(built)}, failed {len(failed)}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
