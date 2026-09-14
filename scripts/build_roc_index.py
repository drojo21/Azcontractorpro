#!/usr/bin/env python3
"""
build_roc_index.py — compact the ROC posting list for the JavaScript side.

The backend cannot run core/roc_active.py, and it cannot parse a 12 MB CSV on
every cold start either. This writes the same data as a positional JSON array —
8.6 MB raw, 1.8 MB gzipped — that core/roc-active.js reads back.

    python3 scripts/build_roc_index.py

Python stays the source of truth: this reads through ROCActive, so the index can
only ever contain what the gate itself would have seen. Run it after refreshing
data/roc-active.csv.gz, then scripts/sync_core.sh to copy it into backend/lib.

Positional rather than keyed, because 57,994 repetitions of the key names is
about 5 MB of the raw size and none of the information.
"""
import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))
from roc_active import ROCActive  # noqa: E402

# Field order is the contract with core/roc-active.js. Append only — never
# reorder, or the JS reads the wrong column for every licence in the file.
# `address` is load-bearing, not decoration: find_by_name groups candidates by
# (address, zip) to tell one business holding several licences from different
# businesses sharing a name. Without it the JS would group on zip alone and be
# LESS strict than the Python gate.
FIELDS = ["roc_number", "business_name", "dba", "license_class",
          "license_class_description", "class_type", "address", "city", "state",
          "zip", "qualifying_party", "expiration_date", "roc_status"]

OUT = ROOT / "core" / "roc-index.json.gz"


def main():
    roster = ROCActive()
    payload = {
        "fields": FIELDS,
        "snapshot_date": str(roster.snapshot_date),
        "count": len(roster),
        "rows": [[rec[f] for f in FIELDS] for rec in roster.records.values()],
    }
    raw = json.dumps(payload, separators=(",", ":")).encode()
    OUT.write_bytes(gzip.compress(raw, 9))
    print(f"wrote {OUT.relative_to(ROOT)}: {len(payload['rows'])} licences, "
          f"snapshot {payload['snapshot_date']}, "
          f"{len(raw) / 1048576:.1f} MB raw -> {OUT.stat().st_size / 1048576:.2f} MB gz",
          file=sys.stderr)
    print("run scripts/sync_core.sh to copy it into backend/lib", file=sys.stderr)


if __name__ == "__main__":
    main()
