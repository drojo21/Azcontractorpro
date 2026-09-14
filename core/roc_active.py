#!/usr/bin/env python3
"""
roc_active.py — the Arizona ROC "Current Active Contractor Licenses" posting list.

This file is the licence gate. It is the registrar's complete list of licences
that are active as of the day it was published, so membership answers the only
question that has to be true before a generated site says "Licensed · Bonded ·
Insured": a licence number that is not in this file is not active. That is a
definitive answer, not a failed lookup, which is what makes a local snapshot
enough here — there is nothing a live query would add to a negative.

    from roc_active import ROCActive
    roc = ROCActive()
    roc.is_active("363002")        -> True
    roc.get("363002")              -> {...license_class, expiration_date, ...}
    roc.find_by_name("Acme Paving LLC")  -> record, or None if ambiguous/absent

What it does NOT carry: phone, email, website. The posting list is licence data
only. Contact enrichment is a separate pass (see roc_results.py and data/*.csv)
— that is the division of labour between this file and the scraper, not an
overlap.

Refreshing: download a newer posting list and replace data/roc-active.csv.gz.
Everything keyed off `snapshot_date` then moves with it, and a licence that has
lapsed since the last snapshot disappears from the file, so re-verifying live
sites is a set difference rather than 57,000 lookups.

File shape (as published):
    line 1   "Current Active Contractor Licenses - File created: Sep 08, 2026 - 57994 Records"
    line 2   "#","License No","Business Name","Doing Business As","Class",...
    line 3+  one row per licence; License No is unique across the file.

Two parsing quirks are load-bearing:
  * Quotes inside a business name are backslash-escaped (\\") rather than
    doubled (""), which is not standard CSV. Without escapechar the affected row
    parses one field short and every column after the name shifts by one —
    silently, into a row that still looks plausible. escapechar="\\" fixes it.
  * A business name may therefore arrive still wrapped in literal quotes; they
    are stripped on load.
"""

import csv
import gzip
import re
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATHS = [ROOT / "data" / "roc-active.csv.gz", ROOT / "data" / "roc-active.csv"]

# Columns as published, in order.
COLUMNS = ["#", "License No", "Business Name", "Doing Business As", "Class",
           "Class Detail", "Class Type", "Address", "City", "State", "Zip",
           "Qualifying Party", "Issued Date", "Expiration Date", "Status"]

# "... - File created: Sep 08, 2026 - 57994 Records"
_TITLE_DATE = re.compile(r"File created:\s*([A-Za-z]{3}\s+\d{1,2},\s*\d{4})", re.I)
_TITLE_COUNT = re.compile(r"-\s*(\d+)\s+Records", re.I)

# Entity suffixes carry no identifying information, so they are noise when
# matching a name a prospect typed against the registrar's spelling.
_SUFFIX = re.compile(
    r"\b(llc|l l c|inc|incorporated|co|company|corp|corporation|ltd|limited|lp|llp|pllc|dba)\b")


def digits(v) -> str:
    return re.sub(r"[^0-9]", "", str(v or ""))


def norm_business(name: str) -> str:
    """Normalized business name for matching: case, punctuation and the entity
    suffix are noise ("Vega Custom Concrete, LLC." == "VEGA CUSTOM CONCRETE LLC")."""
    n = re.sub(r"[^a-z0-9 ]", " ", str(name or "").lower())
    n = _SUFFIX.sub(" ", n)
    return re.sub(r"\s+", " ", n).strip()


class ROCActive:
    """Indexed view of the posting list. Built once, queried many times."""

    def __init__(self, path=None):
        self.path = Path(path) if path else self._default_path()
        self.snapshot_date = None
        self.declared_count = None
        self.records = {}          # licence number -> record
        self._by_name = {}         # normalized name -> [licence number, ...]
        self._load()

    @staticmethod
    def _default_path():
        for p in DEFAULT_PATHS:
            if p.exists():
                return p
        raise FileNotFoundError(
            "no ROC posting list found. Expected one of: "
            + ", ".join(str(p.relative_to(ROOT)) for p in DEFAULT_PATHS)
            + ". Download the current list from azroc.gov and place it there.")

    def _open(self):
        if self.path.suffix == ".gz":
            return gzip.open(self.path, "rt", encoding="utf-8-sig", newline="")
        return self.path.open("rt", encoding="utf-8-sig", newline="")

    def _load(self):
        with self._open() as fh:
            title = fh.readline()
            m = _TITLE_DATE.search(title)
            if m:
                self.snapshot_date = datetime.strptime(
                    re.sub(r"\s+", " ", m.group(1)), "%b %d, %Y").date()
            m = _TITLE_COUNT.search(title)
            if m:
                self.declared_count = int(m.group(1))

            # escapechar is not optional here — see the module docstring.
            reader = csv.DictReader(fh, escapechar="\\")
            for row in reader:
                lic = digits(row.get("License No"))
                if not lic:
                    continue
                rec = {
                    "roc_number": lic,
                    "business_name": self._clean_name(row.get("Business Name")),
                    "dba": self._clean_name(row.get("Doing Business As")),
                    "license_class": (row.get("Class") or "").strip().upper(),
                    "license_class_description": self._class_desc(row.get("Class Detail")),
                    "class_type": (row.get("Class Type") or "").strip(),
                    "address": (row.get("Address") or "").strip(),
                    "city": (row.get("City") or "").strip(),
                    "state": (row.get("State") or "").strip(),
                    "zip": (row.get("Zip") or "").strip(),
                    "qualifying_party": (row.get("Qualifying Party") or "").strip(),
                    "issued_date": (row.get("Issued Date") or "").strip(),
                    "expiration_date": (row.get("Expiration Date") or "").strip(),
                    "roc_status": (row.get("Status") or "").strip(),
                }
                self.records[lic] = rec
                for n in {norm_business(rec["business_name"]), norm_business(rec["dba"])}:
                    if n:
                        self._by_name.setdefault(n, []).append(lic)

    @staticmethod
    def _clean_name(v):
        # A backslash-escaped name arrives still wrapped in literal quotes.
        return str(v or "").strip().strip('"').strip()

    @staticmethod
    def _class_desc(v):
        """'B-3 General Remodeling and Repair Contractor' -> the description part."""
        v = str(v or "").strip()
        parts = v.split(" ", 1)
        return parts[1].strip() if len(parts) > 1 else ""

    # ---------------------------------------------------------------- queries

    def get(self, roc):
        return self.records.get(digits(roc))

    def is_active(self, roc) -> bool:
        """Membership is the answer: this is the complete active list, so a
        licence that is absent is not active."""
        return digits(roc) in self.records

    def find_by_name(self, name, trade=None, city=None):
        """Resolve a business name to one licence record, or None.

        8,254 names in the posting list are held by more than one licence, but
        those split two ways and only one of them is a real ambiguity:

          * 81% are ONE business holding several licences at the same address —
            Silver Basin Remodeling LLC is R-61 Carpentry and CR-37 Plumbing.
            Identity is not in doubt, only which licence to cite, so the record
            comes back with the best-fitting licence primary and the rest in
            `also_holds`.
          * 19% are genuinely different businesses that happen to share a name.
            Those fail closed: attaching another contractor's licence to a
            prospect is its own false claim, and a worse one than building
            nothing.

        `trade` and `city`, when the request carries them, are used to pick the
        licence and to separate same-name businesses — never to loosen a match.
        """
        hits = [self.records[x] for x in self._by_name.get(norm_business(name), [])]
        if not hits:
            return None
        if len(hits) == 1:
            return dict(hits[0], also_holds=[])

        groups = {}
        for rec in hits:
            groups.setdefault((rec["address"].lower().strip(), rec["zip"]), []).append(rec)

        if len(groups) > 1 and city:
            want = str(city).strip().lower()
            narrowed = {k: v for k, v in groups.items()
                        if any(r["city"].strip().lower() == want for r in v)}
            if len(narrowed) == 1:
                groups = narrowed

        if len(groups) != 1:
            return None                      # different businesses — fail closed

        same = next(iter(groups.values()))
        primary = max(same, key=lambda r: self._licence_rank(r, trade))
        others = [r for r in same if r["roc_number"] != primary["roc_number"]]
        return dict(primary, also_holds=[
            {"roc_number": r["roc_number"], "license_class": r["license_class"],
             "license_class_description": r["license_class_description"],
             "expiration_date": r["expiration_date"]} for r in others])

    @staticmethod
    def _licence_rank(rec, trade=None):
        """Which of one business's licences best describes the work being sold.

        A specialty class says what a contractor actually does where a general
        one does not — the reason roc_results.py digs specialty licences out of
        general-class businesses. The trade the prospect picked outranks even
        that, and expiry only breaks ties.
        """
        desc = f"{rec['license_class_description']} {rec['license_class']}".lower()
        t = str(trade or "").strip().lower()
        trade_hit = bool(t) and (t in desc or any(
            w in desc for w in t.split() if len(w) > 3))
        specialty = rec["class_type"].lower().startswith("specialty")
        return (trade_hit, specialty, rec["expiration_date"])

    def expires_on(self, roc):
        rec = self.get(roc)
        if not rec:
            return None
        try:
            return date.fromisoformat(rec["expiration_date"])
        except (ValueError, TypeError):
            return None

    def age_days(self, today=None) -> int:
        """How stale the snapshot is. The caller decides what is too old."""
        if not self.snapshot_date:
            return -1
        return ((today or date.today()) - self.snapshot_date).days

    def __len__(self):
        return len(self.records)

    def __repr__(self):
        return (f"<ROCActive {len(self.records)} licences, "
                f"snapshot {self.snapshot_date}, {self.path.name}>")


def main():
    """Look up licences from the command line: roc_active.py 363002 'Acme LLC'"""
    roc = ROCActive()
    print(f"{roc}  (declared {roc.declared_count}, {roc.age_days()} days old)",
          file=sys.stderr)
    for q in sys.argv[1:]:
        rec = roc.get(q) if digits(q) else None
        how = "licence"
        if not rec:
            rec = roc.find_by_name(q)
            how = "name"
        if not rec:
            print(f"{q}: NOT on the active list")
            continue
        print(f"{q}: ACTIVE via {how} — {rec['business_name']} "
              f"({rec['license_class']} {rec['license_class_description']}) "
              f"{rec['city']}, {rec['state']} — expires {rec['expiration_date']}")


if __name__ == "__main__":
    main()
