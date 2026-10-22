/**
 * test-autopilot.mjs — /api/roc, /api/onboard, webhook promotion and the
 * custom-domain step in /api/deploy, offline.
 *
 *   node --experimental-test-module-mocks test-autopilot.mjs
 *
 * Stripe is faked (setStripeForTests). GitHub is an in-memory repo that
 * enforces the contents API's compare-and-swap on blob shas, so the retry path
 * is real. The ROC gate is NOT faked — it reads the real posting-list index.
 */

import { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Stripe from 'stripe';

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_platform';
process.env.GITHUB_TOKEN = 'gh-test';
process.env.GITHUB_REPO = 'drojo21/Azcontractorpro';
process.env.ROUTER_KEY = 'router-secret';
process.env.LEAD_SHEET_URL = 'https://script.google.com/macros/s/x/exec';
process.env.SALES_SITE_URL = 'https://azcontractorpro.net';
process.env.NETLIFY_TOKEN = 'nf-test';
process.env.BUILDER_KEY = 'builder-key';

/* ------------------------------------------------------------- blobs */
const blobs = new Map();
mock.module('@netlify/blobs', {
  namedExports: {
    getStore: ({ name }) => ({
      get: async (k) => { const v = blobs.get(`${name}/${k}`); return v === undefined ? null : JSON.parse(v); },
      set: async (k, v) => { blobs.set(`${name}/${k}`, JSON.stringify(v)); },
      setJSON: async (k, v) => { blobs.set(`${name}/${k}`, JSON.stringify(v)); },
      list: async ({ prefix }) => ({ blobs: [...blobs.keys()].filter((k) => k.startsWith(`${name}/${prefix}`)).map((k) => ({ key: k.slice(name.length + 1) })) }),
    }),
  },
});

/* ------------------------------------------ fake GitHub + router + Netlify */
const repo = new Map();          // path -> { sha, text }
const ghCalls = [];
const routerPosts = [];
const nfCalls = [];
let conflictOnce = false;
let netlifySite = { id: 'site-1', name: 'desert-pavers-ab12', custom_domain: null, domain_aliases: [] };

const sha = (t) => crypto.createHash('sha1').update(t).digest('hex');
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  if (u.startsWith('https://script.google.com/')) {
    routerPosts.push(JSON.parse(opts.body));
    return new Response('{"ok":true}');
  }
  if (u.startsWith('https://api.github.com/')) {
    const p = u.replace('https://api.github.com', '');
    ghCalls.push({ method, p, body: opts.body ? JSON.parse(opts.body) : null });
    if (p === '/repos/drojo21/Azcontractorpro') return jsonRes({ default_branch: 'Main1' });
    const m = p.match(/^\/repos\/drojo21\/Azcontractorpro\/contents\/(.+?)(\?ref=(.+))?$/);
    if (!m) throw new Error('unexpected GitHub call ' + p);
    const file = decodeURIComponent(m[1]);
    if (method === 'GET') {
      assert.equal(m[3], 'Main1', 'reads the default branch');
      const f = repo.get(file);
      return f ? jsonRes({ sha: f.sha, content: Buffer.from(f.text).toString('base64') }) : jsonRes({ message: 'Not Found' }, 404);
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      assert.equal(body.branch, 'Main1', 'writes the default branch');
      const cur = repo.get(file);
      if (conflictOnce) { conflictOnce = false; return jsonRes({ message: 'sha does not match' }, 409); }
      if (cur && body.sha !== cur.sha) return jsonRes({ message: 'sha does not match' }, 409);
      if (!cur && body.sha) return jsonRes({ message: 'Not Found' }, 404);
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      repo.set(file, { sha: sha(text), text });
      return jsonRes({ commit: { sha: 'commit-' + repo.size + '-' + ghCalls.length } });
    }
  }
  if (u.startsWith('https://api.netlify.com/api/v1')) {
    const p = u.replace('https://api.netlify.com/api/v1', '');
    nfCalls.push({ method, p, body: opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    if (p === `/sites/${netlifySite.id}` && method === 'GET') return jsonRes(netlifySite);
    if (p === `/sites/${netlifySite.id}` && method === 'PATCH') { Object.assign(netlifySite, JSON.parse(opts.body)); return jsonRes(netlifySite); }
    if (p === `/sites/${netlifySite.id}/deploys` && method === 'POST') return jsonRes({ id: 'dep-1', required: [] });
    if (p === '/deploys/dep-1') return jsonRes({ id: 'dep-1', state: 'ready', ssl_url: `https://${netlifySite.name}.netlify.app` });
  }
  throw new Error(`unexpected fetch ${method} ${u}`);
};

/* ------------------------------------------------------- fake Stripe */
const real = new Stripe('sk_test_dummy');
const sessions = new Map();
const stripeCalls = [];
const { setStripeForTests } = await import('./lib/stripe.js');
setStripeForTests({
  webhooks: real.webhooks,
  checkout: { sessions: { retrieve: async (id) => {
    stripeCalls.push(['sessions.retrieve', id]);
    if (!sessions.has(id)) { const e = new Error('No such checkout.session'); e.statusCode = 404; throw e; }
    return sessions.get(id);
  } } },
  subscriptions: { update: async (id, p) => { stripeCalls.push(['subscriptions.update', id, p]); return { id }; } },
});

function addSession(id, over = {}) {
  sessions.set(id, {
    id, mode: 'subscription', status: 'complete', payment_status: 'paid', created: Math.floor(Date.now() / 1000) - 60,
    metadata: { tier: 'pro', client_id: 'desert-pavers-llc' }, client_reference_id: 'desert-pavers-llc',
    subscription: 'sub_123', customer_details: { email: 'ana@example.com', phone: '+15205550100', name: 'Ana Prospect' },
    ...over,
  });
}

/* ---------------------------------------------------- the code under test */
const { acp, promote, sanitizeOnboarding, applyOnboarding, normalizeDomain, dnsSteps, suggestAreas, formContext } = await import('./lib/autopilot.js');
const roc = (await import('./netlify/functions/roc.js')).default;
const onboard = (await import('./netlify/functions/onboard.js')).default;
const webhook = (await import('./netlify/functions/stripe-webhook.js')).default;
const deploy = (await import('./netlify/functions/deploy.js')).default;

/* A demo record exactly as demo_request.py writes it. */
function demoRecord() {
  const c = acp.resolve(acp.fromClientInfoBlock({
    BUSINESS_NAME: 'Desert Pavers LLC', OWNER_NAME: 'Ana Prospect', ROC_NUMBER: '337881', LICENSE_CLASS: 'KB-2',
    PHONE: '(520) 555-0100', EMAIL: 'ana@example.com', CITY: 'Tucson', STATE: 'AZ', ZIP: '85706', TRADE: 'masonry', TAGLINE: 'auto',
  }));
  c.client_id = 'desert-pavers-llc';
  c.roc_status = 'Active';
  c.integrations = { ...c.integrations, lead_endpoint: process.env.LEAD_SHEET_URL };
  c.deploy = { ...c.deploy, demo: true, netlify_site_id: 'site-1', netlify_url: 'https://desert-pavers-ab12.netlify.app' };
  return acp.resolve(c);
}
const putRepo = (path, obj) => { const text = acp.dumps(obj) + '\n'; repo.set(path, { sha: sha(text), text }); };
const readRepo = (path) => JSON.parse(repo.get(path).text);

/* ------------------------------------------------------------------ tests */
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (err) { failures.push([name, err]); console.log('  ✗', name, '\n     ', err.stack.split('\n').slice(0, 3).join('\n      ')); }
}
const call = async (fn, url, init) => { const res = await fn(new Request(url, init)); return { status: res.status, body: await res.json(), headers: res.headers }; };
const reset = () => { repo.clear(); ghCalls.length = 0; routerPosts.length = 0; stripeCalls.length = 0; nfCalls.length = 0; blobs.clear(); conflictOnce = false; };

console.log('\nautopilot — pure record changes');

await test('promote: demo → paid Pro: full tier, banner off, site_url from the demo address, idempotent', () => {
  const c = promote(demoRecord(), 'pro', { email: 'x@y.co' }, new Date('2026-10-21T00:00:00Z'));
  assert.equal(c.tier, 'full');
  assert.equal(c.plan, 'pro');
  assert.equal(c.deploy.demo, false);
  assert.equal(c.site_url, 'https://desert-pavers-ab12.netlify.app');
  assert.equal(c.email, 'ana@example.com', 'existing email kept');
  assert.equal(c.onboarding.status, 'pending');
  assert.deepEqual(acp.validate(c).filter((p) => p.level === 'error'), []);
  const again = promote(c, 'pro', {}, new Date('2026-11-01T00:00:00Z'));
  assert.equal(acp.dumps(again), acp.dumps(c), 'second promotion changes nothing');
  assert.equal(promote(demoRecord(), 'starter').tier, 'lite');
});

await test('sanitizeOnboarding: per-field errors; lists capped, de-duplicated, stripped', () => {
  const { errors } = sanitizeOnboarding({ phone: '555', email: 'nope', services: [], service_area: ['<b>'], hours: 'x', domain_status: 'have', domain: 'not a domain', years_in_business: '2.5' });
  assert.deepEqual(Object.keys(errors).sort(), ['domain', 'email', 'hours', 'phone', 'service_area', 'services', 'years_in_business']);
  const { fields, errors: none } = sanitizeOnboarding({
    phone: '520.555.0100', email: 'jobs@desertpavers.com', services: ['Paver Patios', 'paver patios', '<script>Walls</script>'],
    service_area: ['TUCSON', 'oro valley', 'Marana'], hours: 'weekdays_sat', years_in_business: '12', domain_status: 'have', domain: 'https://DesertPavers.com/',
    facebook_url: 'https://facebook.com/desertpavers', emergency_service: 'yes',
  });
  assert.deepEqual(none, {});
  assert.equal(fields.phone, '(520) 555-0100');
  assert.deepEqual(fields.services, ['Paver Patios', 'scriptWalls/script']);
  assert.deepEqual(fields.service_area, ['Tucson', 'Oro Valley', 'Marana']);
  assert.equal(fields.hours, 'Mo-Fr 07:00-17:00, Sa 08:00-14:00');
  assert.equal(fields.domain.primary, 'www.desertpavers.com');
  assert.equal(fields.emergency_service, true);
});

await test('normalizeDomain / dnsSteps follow Netlify external-DNS guidance', () => {
  assert.equal(normalizeDomain('desertpavers.com').primary, 'www.desertpavers.com');
  assert.equal(normalizeDomain('www.desertpavers.com').primary, 'www.desertpavers.com');
  assert.ok(normalizeDomain('foo.netlify.app').error);
  assert.ok(normalizeDomain('azcontractorpro.net').error);
  const d = dnsSteps('www.desertpavers.com', 'desert-pavers-ab12.netlify.app');
  assert.deepEqual(d.steps.map((s) => [s.type, s.host, s.value]), [['CNAME', 'www', 'desert-pavers-ab12.netlify.app'], ['A', '@', '75.2.60.5']]);
});

await test('applyOnboarding: answers land, generated FAQ regenerates, hand-written FAQ survives', () => {
  const base = promote(demoRecord(), 'pro');
  const { fields } = sanitizeOnboarding({ services: ['Paver Patios', 'Block Walls'], service_area: ['Tucson', 'Marana'], domain_status: 'have', domain: 'desertpavers.com', owner: 'Ana Rojo' });
  const c = applyOnboarding(base, fields);
  assert.deepEqual(c.services.map((s) => s.name), ['Paver Patios', 'Block Walls']);
  assert.ok(c.services.every((s) => s.summary), 'resolve() filled summaries');
  assert.deepEqual(c.service_area, ['Tucson', 'Marana']);
  assert.equal(c.site_url, 'https://www.desertpavers.com');
  assert.equal(c.deploy.custom_domain, 'https://www.desertpavers.com');
  assert.equal(c.onboarding.status, 'submitted');
  assert.match(JSON.stringify(c.faqs), /Tucson and Marana|Tucson, Marana/, 'FAQ now names the new areas');
  const custom = { ...base, faqs: [{ q: 'Do you do pools?', a: 'No.' }] };
  assert.deepEqual(applyOnboarding(custom, fields).faqs, [{ q: 'Do you do pools?', a: 'No.' }]);
  assert.deepEqual(acp.validate(c).filter((p) => p.level === 'error'), []);
});

await test('suggestAreas / formContext give the form sensible checkboxes', () => {
  assert.ok(suggestAreas('TUCSON').includes('Oro Valley'));
  assert.ok(suggestAreas('Mesa').includes('Gilbert'));
  assert.deepEqual(suggestAreas('Ajo'), ['Ajo']);
  const f = formContext(demoRecord());
  assert.ok(f.suggested_services.length >= f.services.length);
  assert.ok(f.suggested_areas.includes('Marana'));
});

console.log('\n/api/roc');

await test('active licence → business, class and city; cacheable', async () => {
  const r = await call(roc, 'https://x/api/roc?n=337881');
  assert.equal(r.status, 200);
  assert.equal(r.body.active, true);
  assert.equal(r.body.license_class, 'KB-2');
  assert.equal(r.body.city, 'Tucson');
  assert.ok(r.body.suggested_areas.includes('Marana'));
  assert.match(r.headers.get('cache-control'), /max-age/);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

await test('unknown number → active:false; junk → 400', async () => {
  const r = await call(roc, 'https://x/api/roc?n=1234');
  assert.deepEqual([r.status, r.body.active, r.body.business_name], [200, false, undefined]);
  assert.equal((await call(roc, 'https://x/api/roc?n=12')).status, 400);
  assert.equal((await call(roc, 'https://x/api/roc?n=abc')).status, 400);
});

console.log('\n/api/onboard');

await test('GET: paid demo purchase → prefilled form; unpaid → 402; bad id → 400; unknown → 404', async () => {
  reset();
  putRepo('clients/desert-pavers-llc/client.json', demoRecord());
  addSession('cs_test_paid0001');
  const r = await call(onboard, 'https://x/api/onboard?session_id=cs_test_paid0001', { headers: { origin: 'https://azcontractorpro.net' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.plan, 'pro');
  assert.equal(r.body.needs_roc, false);
  assert.equal(r.body.form.business_name, 'Desert Pavers LLC');
  assert.equal(r.body.site_url, 'https://desert-pavers-ab12.netlify.app');
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://azcontractorpro.net');
  addSession('cs_test_unpaid001', { payment_status: 'unpaid', status: 'open' });
  assert.equal((await call(onboard, 'https://x/api/onboard?session_id=cs_test_unpaid001')).status, 402);
  assert.equal((await call(onboard, 'https://x/api/onboard?session_id=../../etc')).status, 400);
  assert.equal((await call(onboard, 'https://x/api/onboard?session_id=cs_test_missing01')).status, 404);
});

await test('POST: bad answers → 422 with per-field errors, nothing written', async () => {
  reset();
  putRepo('clients/desert-pavers-llc/client.json', demoRecord());
  addSession('cs_test_paid0002');
  const r = await call(onboard, 'https://x/api/onboard', { method: 'POST', body: JSON.stringify({ session_id: 'cs_test_paid0002', phone: '12', services: [] }) });
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.phone && r.body.errors.services);
  assert.equal(ghCalls.filter((c) => c.method === 'PUT').length, 0);
});

await test('POST: demo buyer → one commit to Main1 (full, banner off, answers in), router told, retries a 409', async () => {
  reset();
  putRepo('clients/desert-pavers-llc/client.json', demoRecord());
  addSession('cs_test_paid0003');
  conflictOnce = true;      // a deploy run committed a second earlier
  const r = await call(onboard, 'https://x/api/onboard', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({
    session_id: 'cs_test_paid0003', phone: '520-555-0100', email: 'jobs@desertpavers.com', services: ['Paver Patios', 'Block Walls'],
    service_area: ['Tucson', 'Marana'], hours: 'weekdays', domain_status: 'have', domain: 'desertpavers.com', notes: 'Logo coming',
  }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const puts = ghCalls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 2, 'one 409, then the retry');
  assert.match(puts[1].body.message, /\[autopilot\]/);
  const saved = readRepo('clients/desert-pavers-llc/client.json');
  assert.equal(saved.tier, 'full');
  assert.equal(saved.deploy.demo, false);
  assert.equal(saved.integrations.notification_email, 'jobs@desertpavers.com');
  assert.equal(saved.deploy.custom_domain, 'https://www.desertpavers.com');
  assert.equal(saved.onboarding.status, 'submitted');
  assert.equal(r.body.dns.steps[0].value, 'desert-pavers-ab12.netlify.app');
  const note = routerPosts.find((p) => p.action === 'onboarded');
  assert.equal(note.router_key, 'router-secret');
  assert.equal(note.lead_email, 'jobs@desertpavers.com');
  assert.equal(note.domain, 'www.desertpavers.com');
  assert.equal(note.first_submit, true);
});

await test('POST: straight-to-checkout buyer → new record through the ROC gate, one-page first, subscription tagged', async () => {
  reset();
  addSession('cs_test_paid0004', { metadata: { tier: 'kit' }, client_reference_id: null });
  const r = await call(onboard, 'https://x/api/onboard', { method: 'POST', body: JSON.stringify({
    session_id: 'cs_test_paid0004', roc_number: '337881', trade: 'masonry', services: ['Pavers'], service_area: ['Tucson'], domain_status: 'later',
  }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.client_id;
  assert.ok(id);
  const saved = readRepo(`clients/${id}/client.json`);
  assert.equal(saved.roc_number, '337881');
  assert.equal(saved.plan, 'kit');
  assert.equal(saved.tier, 'lite', 'no address yet → one page first');
  assert.equal(saved.onboarding.full_pending, true);
  assert.equal(saved.roc_verified.added_via, 'self-serve onboarding');
  assert.deepEqual(stripeCalls.find((c) => c[0] === 'subscriptions.update').slice(1), ['sub_123', { metadata: { client_id: id } }]);
  // the same purchase edits the same record next time, not a second one
  const again = await call(onboard, 'https://x/api/onboard', { method: 'POST', body: JSON.stringify({ session_id: 'cs_test_paid0004', services: ['Pavers', 'Walls'], service_area: ['Tucson'] }) });
  assert.equal(again.body.client_id, id);
});

await test('POST: straight-to-checkout with an inactive licence → 422 on roc_number, nothing written', async () => {
  reset();
  addSession('cs_test_paid0005', { metadata: { tier: 'starter' }, client_reference_id: null });
  const r = await call(onboard, 'https://x/api/onboard', { method: 'POST', body: JSON.stringify({ session_id: 'cs_test_paid0005', roc_number: '1234', services: ['X'], service_area: ['Tucson'] }) });
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.roc_number);
  assert.equal(ghCalls.filter((c) => c.method === 'PUT').length, 0);
});

console.log('\nstripe-webhook promotion');

await test('checkout.session.completed from a demo → client.json promoted in the repo; router gets setup link', async () => {
  reset();
  putRepo('clients/desert-pavers-llc/client.json', demoRecord());
  const event = {
    id: 'evt_promo_1', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { id: 'cs_test_paid0006', mode: 'subscription', payment_status: 'paid', subscription: 'sub_9', customer: 'cus_9',
      client_reference_id: 'desert-pavers-llc', amount_total: 99700, metadata: { tier: 'pro', client_id: 'desert-pavers-llc', business_name: 'Desert Pavers LLC' },
      customer_details: { email: 'ana@example.com', name: 'Ana', phone: '+15205550100' } } },
  };
  const payload = JSON.stringify(event);
  const sig = real.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const res = await webhook(new Request('https://x/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': sig }, body: payload }));
  assert.equal(res.status, 200);
  const saved = readRepo('clients/desert-pavers-llc/client.json');
  assert.equal(saved.tier, 'full');
  assert.equal(saved.deploy.demo, false);
  const note = routerPosts.find((p) => p.kind === 'new_customer');
  assert.equal(note.promoted, true);
  assert.equal(note.onboard_url, 'https://azcontractorpro.net/thanks.html?session_id=cs_test_paid0006');
});

console.log('\n/api/deploy custom domain');

function siteFiles() { return { 'index.html': '<!doctype html><title>x</title>' }; }

await test('client with a custom_domain and a site without one → domain set; default host returned', async () => {
  reset();
  netlifySite = { id: 'site-1', name: 'desert-pavers-ab12', custom_domain: null, domain_aliases: [] };
  const client = promote(demoRecord(), 'pro');
  client.deploy.custom_domain = 'https://www.desertpavers.com';
  const r = await call(deploy, 'https://x/api/deploy', { method: 'POST', headers: { 'x-builder-key': 'builder-key' }, body: JSON.stringify({ client, files: siteFiles(), siteId: 'site-1' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const patch = nfCalls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { custom_domain: 'www.desertpavers.com' });
  assert.equal(r.body.defaultUrl, 'https://desert-pavers-ab12.netlify.app');
  assert.match(r.body.domainNote, /custom domain set/);
});

await test('a site that already has a different domain is never repointed', async () => {
  reset();
  netlifySite = { id: 'site-1', name: 'luis', custom_domain: 'luisrojosmasonry.com', domain_aliases: ['www.luisrojosmasonry.com'] };
  const client = promote(demoRecord(), 'pro');
  client.deploy.custom_domain = 'https://www.somethingelse.com';
  const r = await call(deploy, 'https://x/api/deploy', { method: 'POST', headers: { 'x-builder-key': 'builder-key' }, body: JSON.stringify({ client, files: siteFiles(), siteId: 'site-1' }) });
  assert.equal(r.status, 200);
  assert.equal(nfCalls.filter((c) => c.method === 'PATCH').length, 0);
  assert.match(r.body.domainNote, /left it alone/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
