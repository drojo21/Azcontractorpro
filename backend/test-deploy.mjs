/**
 * test-deploy.mjs — the merged backend, with Netlify and the blob store mocked.
 *
 *   node --experimental-test-module-mocks test-deploy.mjs
 */

import { mock } from 'node:test';

process.env.NETLIFY_TOKEN = 'test-token';
process.env.BUILDER_KEY = 'test-builder-key';
process.env.OAUTH_CLIENT_ID = 'oauth-id';
process.env.OAUTH_CLIENT_SECRET = 'oauth-secret';
process.env.CLAIM_WEBHOOK = 'https://backend.test/api/claimed';
process.env.LEAD_SHEET_URL = 'https://script.google.com/macros/s/x/exec';

/* ---------------------------------------------------------- mock the store */

const blobs = new Map();
mock.module('@netlify/blobs', {
  namedExports: {
    getStore: () => ({
      get: async (k) => (blobs.has(k) ? JSON.parse(blobs.get(k)) : null),
      setJSON: async (k, v) => { blobs.set(k, JSON.stringify(v)); },
      list: async ({ prefix }) => ({
        blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      }),
    }),
  },
});

/* -------------------------------------------------------- mock Netlify API */

let siteCounter = 0;
const sites = new Map();
const claimedSites = new Set();
const sheetPosts = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const reply = (o, s = 200) => new Response(JSON.stringify(o), {
    status: s, headers: { 'content-type': 'application/json' },
  });

  if (u.startsWith('https://script.google.com')) {
    sheetPosts.push({
      contentType: (init.headers || {})['Content-Type'],
      body: JSON.parse(init.body),
    });
    return reply({ ok: true });
  }

  if (u.endsWith('/sites') && init.method === 'POST') {
    const id = `site-${++siteCounter}`;
    sites.set(id, { id, ssl_url: `https://${id}.netlify.app` });
    return reply(sites.get(id));
  }
  const get = u.match(/\/sites\/([^/]+)$/);
  if (get && !init.method) {
    const id = get[1];
    if (claimedSites.has(id)) return reply({ message: 'Forbidden' }, 403);
    return sites.has(id) ? reply(sites.get(id)) : reply({ message: 'Not Found' }, 404);
  }
  if (/\/sites\/[^/]+\/deploys$/.test(u) && init.method === 'POST') {
    const { files } = JSON.parse(init.body);
    return reply({ id: 'deploy-1', state: 'uploading', required: Object.values(files) });
  }
  if (/\/deploys\/[^/]+\/files\//.test(u)) return reply({ ok: true });
  if (/\/deploys\/[^/]+$/.test(u)) {
    return reply({ id: 'deploy-1', state: 'ready', ssl_url: 'https://site-1.netlify.app' });
  }
  return reply({ message: 'unmocked ' + u }, 500);
};

const { default: deploy } = await import('./netlify/functions/deploy.js');
const { default: claimed } = await import('./netlify/functions/claimed.js');

/* ------------------------------------------------------------------ tests */

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`);
};

const post = (body, key = 'test-builder-key') => deploy(new Request('https://x/api/deploy', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'x-builder-key': key } : {}) },
  body: JSON.stringify(body),
}));

const CLIENT = {
  client_id: 'luis-rojos-masonry-llc',
  business_name: "Luis Rojo's Masonry LLC",
  trade: 'masonry', license_class: 'KB-2', roc_number: '337881', roc_status: 'Active',
  phone: '(520) 481-7579', email: 'luisr@luisrojosmasonry.com',
  site_url: 'https://luisrojosmasonry.com',
  city: 'Tucson', state: 'AZ', zip: '85713', tier: 'lite',
  integrations: { lead_endpoint: 'https://script.google.com/macros/s/x/exec' },
};

console.log('\nBACKWARD COMPATIBILITY (the original call shape)');
{
  const b = await (await post({ html: '<h1>hi</h1>', businessName: 'Test Co' })).json();
  check('legacy { html, businessName } still deploys', Boolean(b.url && b.siteId));
  check('legacy call still returns a claimUrl', String(b.claimUrl).includes('app.netlify.com/claim'));
  check('legacy call is not persisted (no client_id)', b.persisted === false);
}
check('bad builder key is 401', (await post({ html: 'x' }, 'wrong')).status === 401);
check('missing index.html is 400', (await post({ files: { 'about.html': 'x' } })).status === 400);

console.log('\nVALIDATION');
{
  const r = await post({ client: { ...CLIENT, phone: '' }, files: { 'index.html': 'x' } });
  check('missing phone is rejected', r.status === 422);
}
{
  const r = await post({ client: { ...CLIENT, roc_status: 'Suspended' }, files: { 'index.html': 'x' } });
  const b = await r.json();
  check('suspended licence is refused', r.status === 422 && /ROC status/.test(b.error), b.error);
}

console.log('\nPERSISTENCE (the fix)');
let firstSite, firstUrl;
{
  const b = await (await post({ client: CLIENT, files: { 'index.html': '<h1>lite</h1>' } })).json();
  firstSite = b.siteId; firstUrl = b.url;
  check('first publish creates a site', Boolean(firstSite) && b.reused === false);
  check('record is persisted', b.persisted === true);
}
{
  // The key test: caller passes NO siteId, as if the browser tab was closed.
  const b = await (await post({ client: CLIENT, files: { 'index.html': '<h1>again</h1>' } })).json();
  check('second publish reuses the site WITHOUT the caller passing siteId',
    b.reused === true && b.siteId === firstSite, `got ${b.siteId}, expected ${firstSite}`);
}
{
  const full = { ...CLIENT, tier: 'full' };
  const b = await (await post({
    client: full,
    files: { 'index.html': '<h1>full</h1>', 'about/index.html': '<h1>about</h1>', 'services/masonry/index.html': '<h1>s</h1>' },
  })).json();
  check('tier=full multi-file publish works', b.files === 3);
  check('upgrade keeps the same site', b.siteId === firstSite);
  check('upgrade keeps the same URL', b.url === firstUrl);
  check('only one site ever created for this client', siteCounter === 2, `counter=${siteCounter}`);
}

console.log('\nA PINNED SITE THAT HAS GONE AWAY');
{
  // The caller pinning a siteId is how a build is aimed at the site holding
  // the custom domain. If that site 404s, inventing a replacement silently
  // abandons the domain and any claim link already sent — and because
  // publish.py then refuses to record the new id, the next run does it again.
  // Four runs of the real pipeline created four orphan sites this way.
  const before = siteCounter;
  const r = await post({
    client: { ...CLIENT, client_id: 'pinned-but-deleted' },
    files: { 'index.html': '<h1>x</h1>' },
    siteId: 'site-deleted-in-the-netlify-ui',
  });
  const b = await r.json();
  check('a pinned site that 404s is refused, not silently replaced',
    r.status === 409 && b.pinned === true, `status=${r.status} ${b.error}`);
  check('and no orphan site is created',
    siteCounter === before, `site counter went ${before} -> ${siteCounter}`);
  check('the error names the site and says how to fix it',
    /site-deleted-in-the-netlify-ui/.test(b.error) && /netlify_site_id/.test(b.error), b.error);
}

console.log('\nA STALE STORED SITE STILL RECOVERS');
{
  // Same 404, but the id came from our own Blobs cache rather than the caller.
  // That is us being stale, not a deliberate pin, so creating a replacement is
  // the right move and must keep working.
  const STALE = { ...CLIENT, client_id: 'stale-blobs-entry' };
  const first = await (await post({ client: STALE, files: { 'index.html': 'a' } })).json();
  sites.delete(first.siteId);                       // deleted out from under us
  const r = await post({ client: STALE, files: { 'index.html': 'b' } });
  const b = await r.json();
  check('a stale stored site is replaced rather than failing',
    r.status === 200 && b.siteId !== first.siteId && b.reused === false,
    `status=${r.status} siteId=${b.siteId} was=${first.siteId}`);
}

console.log('\nCLAIM ATTRIBUTION');
{
  const r = await claimed(new Request('https://x/api/claimed', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claimed: true, site_id: firstSite, destination_acc_id: 'acct-9' }),
  }));
  const b = await r.json();
  check('claim resolves site_id to the contractor', b.client_id === 'luis-rojos-masonry-llc',
    `got ${b.client_id}`);

  const posted = sheetPosts.at(-1);
  check('router payload carries action=claimed', posted.body.action === 'claimed');
  check('router payload carries client_id', posted.body.client_id === 'luis-rojos-masonry-llc');
  check('posted as text/plain, avoiding CORS preflight',
    String(posted.contentType).startsWith('text/plain'), posted.contentType);
}
{
  const r = await claimed(new Request('https://x/api/claimed', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claimed: true, site_id: 'site-unknown' }),
  }));
  check('unknown site_id degrades gracefully', r.status === 200);
}

console.log('\nPOST-CLAIM DEPLOY');
{
  claimedSites.add(firstSite);          // contractor now owns it
  const r = await post({ client: CLIENT, files: { 'index.html': 'x' } });
  const b = await r.json();
  check('claimed site returns a clear 409, not a raw Netlify error',
    r.status === 409 && /claimed by the contractor/.test(b.error), `${r.status} ${b.error}`);
}

const failed = results.filter((r) => !r).length;
console.log('\n' + '='.repeat(62));
console.log(failed ? `FAIL — ${failed}/${results.length}` : `PASS — ${results.length}/${results.length}`);
console.log('='.repeat(62));
process.exit(failed ? 1 : 0);
