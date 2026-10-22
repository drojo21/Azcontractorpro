/**
 * run-tests.mjs — the Apps Script router, offline.
 *
 *   node apps-script/test/run-tests.mjs
 *
 * Apps Script can't be unit-tested where it runs, and a mistake there fails
 * silently (a lead that never arrives, a follow-up that never sends). So the
 * real .gs files are loaded into a Node vm with in-memory fakes for the Google
 * services they touch — Sheets, Mail, Cache, Properties, Lock, Utilities — and
 * driven through doGet/doPost exactly the way the sales page, GitHub Actions
 * and the Netlify backend call them.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------ fake Sheets */

class Range {
  constructor(sheet, r, c, nr = 1, nc = 1) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sheet.cell(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  getValue() { return this.sheet.cell(this.r, this.c); }
  setValue(v) { this.sheet.set(this.r, this.c, v); return this; }
  setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v))); return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setNote() { return this; }
  setNumberFormat() { return this; }
  setDataValidation() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  cell(r, c) { const v = (this.rows[r - 1] || [])[c - 1]; return v === undefined || v === null ? '' : v; }
  set(r, c, v) { while (this.rows.length < r) this.rows.push([]); this.rows[r - 1][c - 1] = v; }
  appendRow(vals) { this.rows.push(vals.map((v) => (v === undefined ? '' : v))); return this; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  setFrozenRows() { return this; }
  setColumnWidth() { return this; }
  hideColumns() { return this; }
  getMaxRows() { return 1000; }
}

class Spreadsheet {
  constructor(id) { this.id = id; this.sheets = [new Sheet('Sheet1')]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}`; }
}

/* ------------------------------------------------------- the environment */

function makeEnv(propsInit = {}) {
  const spreadsheets = new Map();
  const outbox = [];
  const fetches = [];
  const cache = new Map();
  const properties = { ...propsInit };
  const triggers = [];

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    JSON, Date, Math, String, Number, Array, Object, RegExp, Error, isNaN, encodeURIComponent, decodeURIComponent,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in properties ? properties[k] : null),
      setProperty: (k, v) => { properties[k] = v; },
    }) },
    SpreadsheetApp: {
      openById: (id) => { if (!spreadsheets.has(id)) spreadsheets.set(id, new Spreadsheet(id)); return spreadsheets.get(id); },
      newDataValidation: () => ({ requireValueInList() { return this; }, setAllowInvalid() { return this; }, build() { return {}; } }),
    },
    CacheService: { getScriptCache: () => ({
      get: (k) => (cache.has(k) ? cache.get(k) : null),
      put: (k, v) => { cache.set(k, v); },
      remove: (k) => { cache.delete(k); },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: (o) => { outbox.push(o); } },
    UrlFetchApp: { fetch: (url, opts) => { fetches.push({ url, opts }); return { getResponseCode: () => 204, getContentText: () => '' }; } },
    Utilities: {
      DigestAlgorithm: { MD5: 'md5' },
      computeDigest: (alg, s) => crypto.createHash(alg).update(String(s)).digest(),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      computeHmacSha256Signature: (v, k) => crypto.createHmac('sha256', String(k)).update(String(v)).digest(),
      formatDate: (d, tz, fmt) => {
        if (fmt !== 'H') throw new Error('fake formatDate only knows H');
        return String(Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(d)));
      },
      sleep() {},
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } }),
    },
    HtmlService: { createHtmlOutput: (h) => ({ html: h, setTitle() { return this; }, getContent() { return this.html; } }) },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }),
      getProjectTriggers: () => triggers,
      deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: (fn) => ({ timeBased: () => ({ everyHours: () => ({ create: () => { triggers.push({ getHandlerFunction: () => fn }); } }) }) }),
    },
    DriveApp: {}, Drive: {},
  };
  vm.createContext(ctx);
  for (const f of ['router.gs', 'demo.gs', 'stripe.gs', 'provision.gs', 'photos.gs', 'autopilot.gs']) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  }
  // Drive provisioning is out of scope here — record the calls instead.
  const provisioned = [];
  ctx.provisionClient = (o) => { provisioned.push(['provisionClient', o]); ctx.updateRegistry(o.clientId, { leads_sheet_id: 'sheet-' + o.clientId }); return { ok: true }; };
  ctx.setupPhotoFolders = (id, cats, email) => { provisioned.push(['setupPhotoFolders', id, cats, email]); return { ok: true, folder_url: 'https://drive.google.com/drive/folders/PHOTOS-' + id }; };
  return { ctx, spreadsheets, outbox, fetches, cache, properties, triggers, provisioned };
}

const post = (env, body) => JSON.parse(env.ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).getContent());
const get = (env, params) => env.ctx.doGet({ parameter: params });
const getJson = (env, params) => JSON.parse(get(env, params).getContent());

function sheetRows(env, name) {
  const sh = env.spreadsheets.get('REG').getSheetByName(name);
  const [h, ...rows] = sh.rows;
  return rows.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
}

/* ------------------------------------------------------------------ tests */

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); } catch (err) { failures.push([name, err]); console.log('  ✗', name, '\n     ', err.message); }
}

const PROPS = {
  REGISTRY_ID: 'REG', ADMIN_EMAIL: 'owner@example.com', DEMO_SECRET: 'demo-secret',
  STRIPE_ROUTER_KEY: 'router-key', GITHUB_TOKEN: 'gh', GITHUB_REPO: 'drojo21/Azcontractorpro',
  SALES_SITE_URL: 'https://azcontractorpro.net', MAILING_ADDRESS: 'PO Box 1, Tucson, AZ 85704',
};

function seededEnv(extra = {}) {
  const env = makeEnv({ ...PROPS, ...extra });
  // Registry with the sales site's own row, as the setup docs require.
  const reg = env.ctx.SpreadsheetApp.openById('REG');
  const sh = reg.getSheets()[0].setName('Registry');
  sh.appendRow(['client_id', 'business_name', 'notification_email', 'leads_sheet_id', 'drive_folder_id', 'portal_pin', 'status']);
  sh.appendRow(['azcontractorpro', 'AZ Contractor Pro', 'owner@example.com', '', '', '', 'active']);
  return env;
}

function requestDemo(env, over = {}) {
  return post(env, {
    action: 'lead', client_id: 'azcontractorpro', name: 'Ana Prospect', email: 'ana@example.com',
    phone: '520-555-0100', business: 'Desert Pavers LLC', roc: '337881', city: 'Tucson',
    service: 'Masonry / hardscape', ...over,
  });
}

console.log('\nApps Script router — autopilot');

test('sales-site lead → Demos row, GitHub dispatch, id returned for polling', () => {
  const env = seededEnv();
  const res = requestDemo(env);
  assert.equal(res.ok, true);
  assert.ok(res.id && res.id.length === 10);
  const demos = sheetRows(env, 'Demos');
  assert.equal(demos.length, 1);
  assert.equal(demos[0].status, 'building');
  assert.equal(demos[0].lead_id, res.id);
  assert.equal(env.fetches.length, 1);
  assert.match(env.fetches[0].url, /\/repos\/drojo21\/Azcontractorpro\/dispatches$/);
  // the header grew the autopilot columns
  assert.ok(env.spreadsheets.get('REG').getSheetByName('Demos').rows[0].includes('opted_out_at'));
});

test('demo_status: building → live with url + client id once demo_ready lands', () => {
  const env = seededEnv();
  const { id } = requestDemo(env);
  let st = getJson(env, { action: 'demo_status', id });
  assert.deepEqual([st.ok, st.status, st.demo_url], [true, 'building', '']);
  const ready = post(env, { action: 'demo_ready', secret: 'demo-secret', client_id: 'desert-pavers-llc', lead_id: id,
    business_name: 'Desert Pavers LLC', url: 'https://desert-pavers-ab12.netlify.app', claim_url: '' });
  assert.equal(ready.ok, true);
  st = getJson(env, { action: 'demo_status', id });
  assert.deepEqual([st.status, st.demo_url, st.client_id], ['live', 'https://desert-pavers-ab12.netlify.app', 'desert-pavers-llc']);
});

test('demo_status: unknown or placeholder ids are refused', () => {
  const env = seededEnv();
  assert.equal(getJson(env, { action: 'demo_status', id: 'duplicate' }).ok, false);
  assert.equal(getJson(env, { action: 'demo_status', id: 'nope123456' }).ok, false);
  assert.equal(getJson(env, { action: 'demo_status', id: '<script>' }).ok, false);
});

test('demo site gets a Registry row, so its quote form delivers (was "unknown client_id")', () => {
  const env = seededEnv();
  const { id } = requestDemo(env);
  post(env, { action: 'demo_ready', secret: 'demo-secret', client_id: 'desert-pavers-llc', lead_id: id,
    business_name: 'Desert Pavers LLC', url: 'https://x.netlify.app' });
  const reg = sheetRows(env, 'Registry').find((r) => r.client_id === 'desert-pavers-llc');
  assert.ok(reg, 'registry row exists');
  assert.equal(reg.status, 'demo');
  assert.equal(reg.notification_email, 'ana@example.com');
  env.outbox.length = 0;
  const lead = post(env, { action: 'lead', client_id: 'desert-pavers-llc', name: 'Homeowner Hal', phone: '5205550199', message: 'Need a patio' });
  assert.equal(lead.ok, true, JSON.stringify(lead));
  const mail = env.outbox.find((m) => /New lead/.test(m.subject));
  assert.equal(mail.to, 'ana@example.com');
  assert.equal(mail.bcc, 'owner@example.com', 'owner gets a copy of demo-site leads');
  assert.match(mail.body, /came through your free demo site/);
});

test('demo_failed (licence) → row failed, honest prospect note, reason to the owner, page sees "failed"', () => {
  const env = seededEnv();
  const { id } = requestDemo(env);
  env.outbox.length = 0;
  const bad = post(env, { action: 'demo_failed', secret: 'wrong', lead_id: id, kind: 'license' });
  assert.equal(bad.ok, false);
  const res = post(env, { action: 'demo_failed', secret: 'demo-secret', lead_id: id, kind: 'license',
    reason: 'ROC #337881 is not on the Arizona ROC active list (snapshot 2026-09-08)', run_url: 'https://github.com/x/actions/runs/1' });
  assert.equal(res.ok, true);
  assert.equal(sheetRows(env, 'Demos')[0].status, 'failed');
  const toProspect = env.outbox.find((m) => m.to === 'ana@example.com');
  assert.ok(toProspect, 'prospect emailed');
  assert.match(toProspect.htmlBody, /issued in the last few weeks/);
  assert.doesNotMatch(toProspect.htmlBody, /snapshot 2026/, 'internal reason never reaches the prospect');
  const toOwner = env.outbox.find((m) => m.to === 'owner@example.com');
  assert.match(toOwner.body, /snapshot 2026-09-08/);
  assert.equal(getJson(env, { action: 'demo_status', id }).status, 'failed');
});

test('new_customer → demo marked paid, Registry active, Onboarding row, setup email to the buyer', () => {
  const env = seededEnv();
  const { id } = requestDemo(env);
  post(env, { action: 'demo_ready', secret: 'demo-secret', client_id: 'desert-pavers-llc', lead_id: id, business_name: 'Desert Pavers LLC', url: 'https://x.netlify.app' });
  env.outbox.length = 0;
  const bad = post(env, { action: 'stripe_event', kind: 'new_customer', router_key: 'nope' });
  assert.equal(bad.ok, false);
  post(env, { action: 'stripe_event', router_key: 'router-key', kind: 'new_customer', client_id: 'desert-pavers-llc',
    tier: 'pro', tier_name: 'Pro', amount: 997, email: 'ana@example.com', name: 'Ana Prospect', phone: '+15205550100',
    business_name: 'Desert Pavers LLC', subscription_id: 'sub_1', session_id: 'cs_live_abc123',
    onboard_url: 'https://azcontractorpro.net/thanks.html?session_id=cs_live_abc123', promoted: true, promotion_note: 'committed', livemode: true });
  assert.equal(sheetRows(env, 'Demos')[0].status, 'paid');
  assert.equal(sheetRows(env, 'Registry').find((r) => r.client_id === 'desert-pavers-llc').status, 'active');
  const onb = sheetRows(env, 'Onboarding');
  assert.equal(onb.length, 1);
  assert.equal(onb[0].status, 'paid');
  const setup = env.outbox.find((m) => m.to === 'ana@example.com');
  assert.match(setup.subject, /3 minutes to finish/);
  assert.match(setup.htmlBody, /thanks\.html\?session_id=cs_live_abc123/);
  const owner = env.outbox.find((m) => m.to === 'owner@example.com');
  assert.match(owner.body, /Upgrade:\s+done/);
});

test('test-mode purchase never emails the "buyer" — the setup email goes to the owner', () => {
  const env = seededEnv();
  post(env, { action: 'stripe_event', router_key: 'router-key', kind: 'new_customer', client_id: '', tier: 'starter',
    email: 'stranger@example.com', session_id: 'cs_test_x1', onboard_url: 'https://azcontractorpro.net/thanks.html?session_id=cs_test_x1', livemode: false });
  assert.equal(env.outbox.some((m) => m.to === 'stranger@example.com'), false);
  assert.ok(env.outbox.some((m) => m.to === 'owner@example.com' && /3 minutes to finish/.test(m.subject)));
});

test('followupDue / reminderDue schedule (pure)', () => {
  const env = seededEnv();
  const { followupDue, reminderDue } = env.ctx;
  const now = new Date('2026-10-21T18:00:00Z');
  const ago = (d) => new Date(now.getTime() - d * 86400000).toISOString();
  const row = { status: 'emailed', email: 'a@b.co', emailed_at: ago(0.5), followups_sent: '' };
  assert.equal(followupDue(row, now), -1, 'too soon');
  assert.equal(followupDue({ ...row, emailed_at: ago(1.1) }, now), 0);
  assert.equal(followupDue({ ...row, emailed_at: ago(3.2), followups_sent: 1 }, now), 1);
  assert.equal(followupDue({ ...row, emailed_at: ago(3.2), followups_sent: 1, last_followup_at: ago(0.2) }, now), -1, 'min gap');
  assert.equal(followupDue({ ...row, emailed_at: ago(30), followups_sent: 4 }, now), -1, 'all sent');
  assert.equal(followupDue({ ...row, emailed_at: ago(5), paid_at: ago(1) }, now), -1, 'paid');
  assert.equal(followupDue({ ...row, emailed_at: ago(5), opted_out_at: ago(1) }, now), -1, 'opted out');
  assert.equal(followupDue({ ...row, status: 'failed', emailed_at: ago(5) }, now), -1);
  assert.equal(followupDue({ ...row, emailed_at: new Date(now.getTime() - 2 * 86400000) }, now), 0, 'Date objects from Sheets work');
  const onb = { status: 'paid', buyer_email: 'b@c.co', onboard_url: 'https://x', paid_at: ago(1.5), reminders_sent: 0 };
  assert.equal(reminderDue(onb, now), 0);
  assert.equal(reminderDue({ ...onb, status: 'onboarded' }, now), -1);
  assert.equal(reminderDue({ ...onb, reminders_sent: 3, paid_at: ago(20) }, now), -1);
});

test('runAutopilot sends follow-up #1 with unsubscribe + postal address, once', () => {
  const env = seededEnv();
  const { id } = requestDemo(env);
  post(env, { action: 'demo_ready', secret: 'demo-secret', client_id: 'desert-pavers-llc', lead_id: id, business_name: 'Desert Pavers LLC', url: 'https://desert.netlify.app' });
  // age the demo email by a day
  const sh = env.spreadsheets.get('REG').getSheetByName('Demos');
  const col = (n) => sh.rows[0].indexOf(n);
  sh.rows[1][col('emailed_at')] = new Date(Date.now() - 1.2 * 86400000).toISOString();
  env.outbox.length = 0;
  const RealDate = Date;
  // pin "now" inside the send window (10am Phoenix = 17:00Z)
  const fixed = new RealDate(new RealDate().toISOString().slice(0, 10) + 'T17:00:00Z');
  sh.rows[1][col('emailed_at')] = new RealDate(fixed.getTime() - 1.2 * 86400000).toISOString();
  env.ctx.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); } static now() { return fixed.getTime(); } };
  const out = env.ctx.runAutopilot();
  assert.match(out, /follow-ups 1/);
  const mail = env.outbox.find((m) => m.to === 'ana@example.com');
  assert.match(mail.subject, /did you try the quote form/);
  assert.match(mail.htmlBody, /action=unsubscribe&amp;id=/, 'escaped in the href');
  assert.match(mail.htmlBody, /PO Box 1, Tucson, AZ 85704/);
  assert.match(mail.htmlBody, /api\/checkout\?tier=pro&amp;client=desert-pavers-llc/);
  env.outbox.length = 0;
  assert.match(env.ctx.runAutopilot(), /follow-ups 0/, 'nothing twice');
});

test('no MAILING_ADDRESS → follow-ups paused, owner told once', () => {
  const env = seededEnv({ MAILING_ADDRESS: '' });
  const { id } = requestDemo(env);
  post(env, { action: 'demo_ready', secret: 'demo-secret', client_id: 'd', lead_id: id, url: 'https://d.netlify.app' });
  const sh = env.spreadsheets.get('REG').getSheetByName('Demos');
  const col = (n) => sh.rows[0].indexOf(n);
  const RealDate = Date;
  const fixed = new RealDate(new RealDate().toISOString().slice(0, 10) + 'T17:00:00Z');
  sh.rows[1][col('emailed_at')] = new RealDate(fixed.getTime() - 2 * 86400000).toISOString();
  env.ctx.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); } static now() { return fixed.getTime(); } };
  env.outbox.length = 0;
  env.ctx.runAutopilot();
  env.ctx.runAutopilot();
  assert.equal(env.outbox.filter((m) => m.to === 'ana@example.com').length, 0);
  assert.equal(env.outbox.filter((m) => /paused/.test(m.subject)).length, 1);
});

test('unsubscribe: signed link opts out, forged link does not', () => {
  const env = seededEnv();
  const { id } = requestDemo(env);
  const forged = get(env, { action: 'unsubscribe', id, sig: 'AAAAAAAAAAAAAAAA' }).getContent();
  assert.match(forged, /incomplete/);
  assert.equal(sheetRows(env, 'Demos')[0].opted_out_at, '');
  const sig = env.ctx.signId(id);
  const page = get(env, { action: 'unsubscribe', id, sig }).getContent();
  assert.match(page, /won.t get any more follow-ups/);
  assert.notEqual(sheetRows(env, 'Demos')[0].opted_out_at, '');
});

test('onboarded → leads re-pointed at the buyer, Drive provisioned for Pro, owner summary', () => {
  const env = seededEnv();
  post(env, { action: 'stripe_event', router_key: 'router-key', kind: 'new_customer', client_id: 'desert-pavers-llc', tier: 'pro',
    email: 'ana@example.com', name: 'Ana', session_id: 'cs_live_s1', onboard_url: 'https://azcontractorpro.net/thanks.html?session_id=cs_live_s1', livemode: true });
  env.outbox.length = 0;
  assert.equal(post(env, { action: 'onboarded', router_key: 'bad', session_id: 'cs_live_s1', client_id: 'x' }).ok, false);
  const res = post(env, { action: 'onboarded', router_key: 'router-key', session_id: 'cs_live_s1', client_id: 'desert-pavers-llc',
    business_name: 'Desert Pavers LLC', plan: 'pro', buyer_email: 'ana@example.com', lead_email: 'jobs@desertpavers.com',
    phone: '(520) 555-0100', services: ['Paver Patios', 'Block Walls'], service_area: ['Tucson', 'Marana'],
    domain_status: 'have', domain: 'www.desertpavers.com', site_url: 'https://desert.netlify.app', first_submit: true });
  assert.equal(res.ok, true);
  assert.equal(res.provisioned, true);
  const reg = sheetRows(env, 'Registry').find((r) => r.client_id === 'desert-pavers-llc');
  assert.equal(reg.notification_email, 'jobs@desertpavers.com');
  assert.equal(reg.status, 'active');
  assert.deepEqual(env.provisioned.map((p) => p[0]), ['provisionClient', 'setupPhotoFolders']);
  assert.deepEqual(env.provisioned[1][2], ['Paver Patios', 'Block Walls']);
  const row = sheetRows(env, 'Onboarding')[0];
  assert.equal(row.status, 'onboarded');
  assert.match(row.photos_url, /PHOTOS-desert-pavers-llc/);
  assert.ok(env.outbox.some((m) => m.to === 'owner@example.com' && /Setup received/.test(m.subject)));
});

test('site_live → buyer gets the link, DNS records for their domain, photo folder; only once', () => {
  const env = seededEnv();
  post(env, { action: 'stripe_event', router_key: 'router-key', kind: 'new_customer', client_id: 'desert-pavers-llc', tier: 'pro',
    email: 'ana@example.com', name: 'Ana', session_id: 'cs_live_s2', onboard_url: 'https://azcontractorpro.net/thanks.html?session_id=cs_live_s2', livemode: true });
  post(env, { action: 'onboarded', router_key: 'router-key', session_id: 'cs_live_s2', client_id: 'desert-pavers-llc', business_name: 'Desert Pavers LLC',
    plan: 'pro', lead_email: 'jobs@desertpavers.com', services: ['Patios'], domain: 'www.desertpavers.com' });
  env.outbox.length = 0;
  assert.equal(post(env, { action: 'site_live', secret: 'nope', client_id: 'desert-pavers-llc', url: 'https://x' }).ok, false);
  const res = post(env, { action: 'site_live', secret: 'demo-secret', client_id: 'desert-pavers-llc', business_name: 'Desert Pavers LLC',
    url: 'https://desert-pavers-ab12.netlify.app', custom_domain: 'https://www.desertpavers.com', netlify_subdomain: 'desert-pavers-ab12.netlify.app' });
  assert.equal(res.emailed, true);
  const mail = env.outbox.find((m) => m.to === 'ana@example.com');
  assert.match(mail.subject, /is live/);
  assert.match(mail.htmlBody, /desert-pavers-ab12\.netlify\.app/);
  assert.match(mail.htmlBody, /75\.2\.60\.5/);
  assert.match(mail.htmlBody, /PHOTOS-desert-pavers-llc/);
  assert.match(mail.htmlBody, /jobs@desertpavers\.com/);
  env.outbox.length = 0;
  const again = post(env, { action: 'site_live', secret: 'demo-secret', client_id: 'desert-pavers-llc', url: 'https://desert-pavers-ab12.netlify.app' });
  assert.equal(again.emailed, false);
  assert.equal(env.outbox.filter((m) => m.to === 'ana@example.com').length, 0);
});

test('installAutopilot creates exactly one hourly trigger', () => {
  const env = seededEnv();
  env.ctx.installAutopilot();
  env.ctx.installAutopilot();
  assert.equal(env.triggers.length, 1);
  assert.equal(env.triggers[0].getHandlerFunction(), 'runAutopilot');
});

test('health reports 1.3', () => {
  const env = seededEnv();
  assert.equal(getJson(env, { action: 'health' }).version, '1.3');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
