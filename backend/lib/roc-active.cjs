/**
 * roc-active.js — JavaScript mirror of core/roc_active.py.
 *
 * Same contract, same answers: the Arizona ROC posting list is the registrar's
 * complete set of ACTIVE licences, so a licence absent from it is not active.
 * The backend gates on this before writing a contractor record, for the same
 * reason the build path does — every generated page asserts "Licensed · Bonded ·
 * Insured" and links to an azroc.gov verify URL.
 *
 * It reads core/roc-index.json.gz (scripts/build_roc_index.py), not the CSV:
 * the raw posting list is 12 MB and parsing it per cold start is not viable.
 * The index is produced THROUGH roc_active.py, so it can only contain what the
 * Python gate itself would have seen.
 *
 * Parity with the Python is enforced by core/test_parity_roc.py. If you change
 * a matching rule here, change it there in the same commit.
 *
 *   const roster = await ROCActive.load();
 *   roster.isActive("363002");                       // true
 *   roster.get("363002");                            // record or null
 *   roster.findByName("Acme Paving LLC", { trade, city });
 */

'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

// Entity suffixes carry no identifying information, so they are noise when
// matching a name a person typed against the registrar's spelling.
const SUFFIX = /\b(llc|l l c|inc|incorporated|co|company|corp|corporation|ltd|limited|lp|llp|pllc|dba)\b/g;

function digits(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '');
}

function normBusiness(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class ROCActive {
  constructor(payload) {
    this.snapshotDate = payload.snapshot_date || '';
    this.fields = payload.fields;
    this.records = new Map();
    this.byName = new Map();

    const F = payload.fields;
    for (const row of payload.rows) {
      const rec = {};
      for (let i = 0; i < F.length; i++) rec[F[i]] = row[i];
      this.records.set(rec.roc_number, rec);
      for (const n of new Set([normBusiness(rec.business_name), normBusiness(rec.dba)])) {
        if (!n) continue;
        if (!this.byName.has(n)) this.byName.set(n, []);
        this.byName.get(n).push(rec.roc_number);
      }
    }
  }

  /** Parsed once per container; warm invocations reuse it. */
  static load(indexPath) {
    if (ROCActive._cache) return ROCActive._cache;
    const p = indexPath || ROCActive.defaultPath();
    const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    ROCActive._cache = new ROCActive(payload);
    return ROCActive._cache;
  }

  static defaultPath() {
    for (const p of [
      path.join(__dirname, 'roc-index.json.gz'),          // core/, and backend/lib/
      path.join(process.cwd(), 'lib', 'roc-index.json.gz'),
    ]) {
      if (fs.existsSync(p)) return p;
    }
    throw new Error('roc-index.json.gz not found — run scripts/build_roc_index.py');
  }

  get size() {
    return this.records.size;
  }

  get(roc) {
    return this.records.get(digits(roc)) || null;
  }

  /** Membership is the answer: absence from the active list is not active. */
  isActive(roc) {
    return this.records.has(digits(roc));
  }

  /**
   * Resolve a business name to one licence record, or null.
   *
   * 81% of duplicated names are ONE business holding several licences at one
   * address — identity is not in doubt, only which licence to cite, so the
   * best-fitting one comes back primary with the rest in also_holds. The other
   * 19% are different businesses sharing a name and fail closed: attaching
   * another contractor's licence to someone is its own false claim.
   */
  findByName(name, opts = {}) {
    const { trade = '', city = '' } = opts;
    const ids = this.byName.get(normBusiness(name)) || [];
    if (ids.length === 0) return null;
    if (ids.length === 1) return { ...this.records.get(ids[0]), also_holds: [] };

    const hits = ids.map((id) => this.records.get(id));
    let groups = new Map();
    for (const rec of hits) {
      const key = `${String(rec.address || '').trim().toLowerCase()}|${rec.zip}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
    }

    if (groups.size > 1 && city) {
      const want = String(city).trim().toLowerCase();
      const narrowed = new Map();
      for (const [k, v] of groups) {
        if (v.some((r) => String(r.city).trim().toLowerCase() === want)) narrowed.set(k, v);
      }
      if (narrowed.size === 1) groups = narrowed;
    }

    if (groups.size !== 1) return null;          // different businesses — fail closed

    const same = [...groups.values()][0];
    let primary = same[0];
    for (const rec of same) {
      if (ROCActive.rank(rec, trade) > ROCActive.rank(primary, trade)) primary = rec;
    }
    const others = same
      .filter((r) => r.roc_number !== primary.roc_number)
      .map((r) => ({
        roc_number: r.roc_number,
        license_class: r.license_class,
        license_class_description: r.license_class_description,
        expiration_date: r.expiration_date,
      }));
    return { ...primary, also_holds: others };
  }

  /**
   * Which of one business's licences best describes the work being sold. A
   * specialty class says what a contractor actually does where a general one
   * does not; the requested trade outranks even that, and expiry breaks ties.
   * Returned as a comparable string so the ordering matches the Python tuple.
   */
  static rank(rec, trade) {
    const desc = `${rec.license_class_description} ${rec.license_class}`.toLowerCase();
    const t = String(trade || '').trim().toLowerCase();
    const tradeHit = !!t && (desc.includes(t) ||
      t.split(/\s+/).some((w) => w.length > 3 && desc.includes(w)));
    const specialty = String(rec.class_type || '').toLowerCase().startsWith('specialty');
    return `${tradeHit ? 1 : 0}${specialty ? 1 : 0}${rec.expiration_date}`;
  }

  expiresOn(roc) {
    const rec = this.get(roc);
    return rec && rec.expiration_date ? rec.expiration_date : null;
  }

  ageDays(today) {
    if (!this.snapshotDate) return -1;
    const t = today ? new Date(today) : new Date();
    const s = new Date(this.snapshotDate + 'T00:00:00Z');
    return Math.floor((t - s) / 86400000);
  }
}

ROCActive._cache = null;

module.exports = { ROCActive, normBusiness, digits };
