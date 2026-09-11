#!/usr/bin/env python3
"""
test_parity_roc.py — core/roc_active.py and core/roc-active.js must agree.

The admin console gates on the JavaScript copy and the build gates on the
Python one. If they disagree, the console accepts a contractor the build then
refuses — or worse, accepts one the build would have refused for cause, and the
operator has no way to tell which answer was right.

    python3 core/test_parity_roc.py

Samples across the whole posting list rather than a handful of hand-picked
licences: the interesting cases (a name held by several licences at one address,
a name held by different businesses) are exactly the ones nobody thinks to pick.
"""
import json
import random
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))
from roc_active import ROCActive  # noqa: E402

SAMPLE = 400
TRADES = ["", "plumbing", "roofing", "carpentry", "electrical", "concrete"]

JS_DRIVER = r"""
const { ROCActive } = require(process.argv[2]);
const queries = JSON.parse(require('node:fs').readFileSync(process.argv[3], 'utf8'));
const roster = ROCActive.load(process.argv[4]);
const out = queries.map((q) => {
  if (q.kind === 'active') return { active: roster.isActive(q.roc) };
  const r = roster.findByName(q.name, { trade: q.trade, city: q.city });
  return r === null ? { rec: null }
                    : { rec: { roc: r.roc_number, also: r.also_holds.map((a) => a.roc_number).sort() } };
});
process.stdout.write(JSON.stringify(out));
"""


def main():
    roster = ROCActive()
    rnd = random.Random(20260911)

    all_rocs = list(roster.records)
    names = list(roster._by_name)
    ambiguous = [n for n, v in roster._by_name.items() if len(v) > 1]

    queries = []
    for roc in rnd.sample(all_rocs, SAMPLE):
        queries.append({"kind": "active", "roc": roc})
    # Licences that do not exist must answer the same way too.
    for _ in range(50):
        queries.append({"kind": "active", "roc": str(rnd.randint(900000, 999999))})
    # Plain names, then deliberately over-sample the ambiguous ones.
    for n in rnd.sample(names, SAMPLE):
        rec = roster.records[roster._by_name[n][0]]
        queries.append({"kind": "name", "name": rec["business_name"],
                        "trade": rnd.choice(TRADES), "city": ""})
    for n in rnd.sample(ambiguous, min(SAMPLE, len(ambiguous))):
        rec = roster.records[roster._by_name[n][0]]
        queries.append({"kind": "name", "name": rec["business_name"],
                        "trade": rnd.choice(TRADES),
                        "city": rnd.choice(["", rec["city"]])})

    qfile = ROOT / "core" / ".parity-queries.json"
    dfile = ROOT / "core" / ".parity-driver.cjs"
    qfile.write_text(json.dumps(queries))
    dfile.write_text(JS_DRIVER)
    try:
        proc = subprocess.run(
            ["node", str(dfile), str(ROOT / "core" / "roc-active.js"), str(qfile),
             str(ROOT / "core" / "roc-index.json.gz")],
            capture_output=True, text=True)
        if proc.returncode != 0:
            print(proc.stderr, file=sys.stderr)
            return 2
        js = json.loads(proc.stdout)
    finally:
        qfile.unlink(missing_ok=True)
        dfile.unlink(missing_ok=True)

    fails = []
    for q, got in zip(queries, js):
        if q["kind"] == "active":
            want = {"active": roster.is_active(q["roc"])}
        else:
            r = roster.find_by_name(q["name"], trade=q["trade"], city=q["city"])
            want = {"rec": None} if r is None else {
                "rec": {"roc": r["roc_number"],
                        "also": sorted(a["roc_number"] for a in r["also_holds"])}}
        if want != got:
            fails.append((q, want, got))

    print(f"{len(queries)} queries: {len(queries) - len(fails)} agree, {len(fails)} differ")
    for q, want, got in fails[:10]:
        print(f"  {q}\n     python={want}\n     js    ={got}")
    if len(fails) > 10:
        print(f"  ... and {len(fails) - 10} more")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
