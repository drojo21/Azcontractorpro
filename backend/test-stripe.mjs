/**
 * test-stripe.mjs — checkout, webhook, Connect onboarding and pay, offline.
 *
 *   node --experimental-test-module-mocks test-stripe.mjs
 *
 * Stripe's API is faked (every call is recorded so the exact parameters sent
 * can be asserted); webhook signatures are REAL — generated and verified with
 * the stripe package — because a signature check that passes everything is the
 * bug worth catching. Netlify Blobs and the Apps Script router are in-memory.
 */

import { mock } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_platform';
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_test_connect';
process.env.BUILDER_KEY = 'test-builder-key';
process.env.ROUTER_KEY = 'router-secret';
process.env.LEAD_SHEET_URL = 'https://script.google.com/macros/s/x/exec';
process.env.SALES_SITE_URL = 'https://azcontractorpro.net';
process.env.BACKEND_URL = 'https://acp-backend-tucson.netlify.app';

/* ------------------------------------------------------------- blobs */
const blobs = new Map();
mock.module('@netlify/blobs', {
  namedExports: {
    getStore: ({ name }) => ({
      get: async (k) => { const v = blobs.get(`${name}/${k}`); return v === undefined ? null : JSON.parse(v); },
      set: async (k, v) => { blobs.set(`${name}/${k}`, JSON.stringify(v)); },
      setJSON: async (k, v) => { blobs.set(`${name}/${k}`, JSON.stringify(v)); },
      list: async ({ prefix }) => ({
        blobs: [...blobs.keys()].filter((k) => k.startsWith(`${name}/${prefix}`)).map((k) => ({ key: k.slice(name.length + 1) })),
      }),
    }),
  },
});

/* ------------------------------------------------------- router (fetch) */
const routerPosts = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://script.google.com/')) {
    routerPosts.push(JSON.parse(opts.body));
    return new Response('{"ok":true}');
  }
  throw new Error('unexpected fetch ' + url);
};

/* ------------------------------------------------------- fake Stripe */
const real = new Stripe('sk_test_dummy');
const calls = [];
const PRICES = ['starter', 'pro', 'kit'].flatMap((t, i) => [
  { id: `price_${t}_setup`, lookup_key: `acp_${t}_setup`, unit_amount: [49700, 99700, 199700][i], recurring: null },
  { id: `price_${t}_monthly`, lookup_key: `acp_${t}_monthly`, unit_amount: [4900, 9900, 19900][i], recurring: { interval: 'month' } },
]);
const accounts = new Map();
let caps = { card_payments: { status: 'active' }, ach_debit_payments: { status: 'active' } };
let requirements = { entries: [] };

const fake = {
  webhooks: real.webhooks,
  prices: { list: async (p) => { calls.push(['prices.list', p]); return { data: PRICES.filter((x) => p.lookup_keys.includes(x.lookup_key)) }; } },
  checkout: {
    sessions: {
      create: async (p, opts) => {
        calls.push(['checkout.sessions.create', p, opts]);
        return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
      },
    },
  },
  v2: {
    core: {
      accounts: {
        create: async (p) => {
          calls.push(['v2.accounts.create', p]);
          const acct = { id: 'acct_test_contractor', configuration: { merchant: { capabilities: { card_payments: { status: 'pending' } } } }, requirements: { entries: [{ minimum_deadline: { status: 'currently_due' } }] } };
          accounts.set(acct.id, acct);
          return acct;
        },
        retrieve: async (id, p) => {
          calls.push(['v2.accounts.retrieve', id, p]);
          return { id, configuration: { merchant: { capabilities: caps } }, requirements };
        },
      },
      accountLinks: {
        create: async (p) => { calls.push(['v2.accountLinks.create', p]); return { url: 'https://connect.stripe.com/setup/s/abc' }; },
      },
    },
  },
};

const lib = await import('./lib/stripe.js');
lib.setStripeForTests(fake);
const store = await import('./lib/store.js');
const checkout = (await import('./netlify/functions/checkout.js')).default;
const webhook = (await import('./netlify/functions/stripe-webhook.js')).default;
const onboard = (await import('./netlify/functions/connect-onboard.js')).default;
const payMod = await import('./netlify/functions/pay.js');
const pay = payMod.default;

const last = (name) => [...calls].reverse().find((c) => c[0] === name);
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.error('  ✗', name, '\n   ', err.message); process.exitCode = 1; }
}

function signed(event, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = real.webhooks.generateTestHeaderString({ payload, secret });
  return new Request('https://x/api/stripe-webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': header } });
}

await store.putClient({
  client_id: 'luis-rojos-masonry-llc', business_name: "Luis Rojo's Masonry LLC", email: 'luisr@luisrojosmasonry.com',
  trade: 'masonry', phone: '(520) 481-7579',
  deploy: { custom_domain: 'https://luisrojosmasonry.com', netlify_url: 'https://luis-rojo-masonry.netlify.app' },
});

console.log('\ncheckout');

await test('demo-site buy → 303 to Checkout, setup + monthly, tied to the client', async () => {
  const res = await checkout(new Request('https://x/api/checkout?tier=pro&client=luis-rojos-masonry-llc', {
    headers: { referer: 'https://luis-rojo-masonry.netlify.app/' },
  }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_1');
  const p = last('checkout.sessions.create')[1];
  assert.equal(p.mode, 'subscription');
  assert.deepEqual(p.line_items.map((l) => l.price), ['price_pro_monthly', 'price_pro_setup']);
  assert.equal(p.client_reference_id, 'luis-rojos-masonry-llc');
  assert.equal(p.customer_email, 'luisr@luisrojosmasonry.com');
  assert.equal(p.subscription_data.metadata.tier, 'pro');
  assert.equal(p.subscription_data.metadata.client_id, 'luis-rojos-masonry-llc');
  assert.equal(p.subscription_data.billing_mode.type, 'flexible');
  assert.equal(p.subscription_data.trial_period_days, 14, 'monthly starts after the default 14 days');
  assert.equal(p.cancel_url, 'https://luis-rojo-masonry.netlify.app/');
  assert.match(p.success_url, /^https:\/\/azcontractorpro\.net\/thanks\.html\?session_id=\{CHECKOUT_SESSION_ID\}$/);
});

await test('MONTHLY_START_DELAY_DAYS=0 charges the first month at checkout', async () => {
  process.env.MONTHLY_START_DELAY_DAYS = '0';
  await checkout(new Request('https://x/api/checkout?tier=kit'));
  const p = last('checkout.sessions.create')[1];
  assert.equal(p.subscription_data.trial_period_days, undefined);
  assert.deepEqual(p.line_items.map((l) => l.price), ['price_kit_monthly', 'price_kit_setup']);
  assert.equal(p.client_reference_id, undefined);
  delete process.env.MONTHLY_START_DELAY_DAYS;
});

await test('unknown tier → back to pricing, no session', async () => {
  const before = calls.length;
  const res = await checkout(new Request('https://x/api/checkout?tier=platinum'));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://azcontractorpro.net/#pricing');
  assert.equal(calls.filter((c) => c[0] === 'checkout.sessions.create').length,
    calls.slice(0, before).filter((c) => c[0] === 'checkout.sessions.create').length);
});

await test('foreign back= / referer is not an open redirect', async () => {
  await checkout(new Request('https://x/api/checkout?tier=starter&back=https://evil.example/phish'));
  assert.equal(last('checkout.sessions.create')[1].cancel_url, 'https://azcontractorpro.net/#pricing');
});

await test('garbage client id is dropped, not passed to Stripe', async () => {
  await checkout(new Request('https://x/api/checkout?tier=starter&client=../../etc'));
  assert.equal(last('checkout.sessions.create')[1].client_reference_id, undefined);
});

console.log('\nwebhook');

await test('bad signature → 400, nothing recorded', async () => {
  const res = await webhook(new Request('https://x/api/stripe-webhook', {
    method: 'POST', body: '{"id":"evt_x"}', headers: { 'stripe-signature': 't=1,v1=deadbeef' },
  }));
  assert.equal(res.status, 400);
});

const completed = {
  id: 'evt_completed_1', type: 'checkout.session.completed', created: 1791650000, livemode: false,
  data: { object: {
    id: 'cs_1', mode: 'subscription', payment_status: 'paid', amount_total: 99700,
    client_reference_id: 'luis-rojos-masonry-llc', customer: 'cus_1', subscription: 'sub_1',
    metadata: { tier: 'pro', client_id: 'luis-rojos-masonry-llc', business_name: "Luis Rojo's Masonry LLC", source: 'demo' },
    customer_details: { email: 'luisr@luisrojosmasonry.com', name: 'Luis Rojo', phone: '+15204817579' },
  } },
};

await test('checkout.session.completed → client marked paid + one email', async () => {
  const res = await webhook(signed(completed));
  assert.equal(res.status, 200);
  const c = await store.getClient('luis-rojos-masonry-llc');
  assert.equal(c.billing.tier, 'pro');
  assert.equal(c.billing.status, 'active');
  assert.equal(c.billing.subscription_id, 'sub_1');
  assert.equal(c.billing.customer_id, 'cus_1');
  assert.equal(routerPosts.length, 1);
  assert.equal(routerPosts[0].action, 'stripe_event');
  assert.equal(routerPosts[0].kind, 'new_customer');
  assert.equal(routerPosts[0].amount, 997);
  assert.equal(routerPosts[0].router_key, 'router-secret');
});

await test('same event delivered twice → no second email', async () => {
  const res = await webhook(signed(completed));
  assert.equal(JSON.parse(await res.text()).duplicate, true);
  assert.equal(routerPosts.length, 1);
});

await test('invoice.payment_failed → past_due + email, keeps tier', async () => {
  await webhook(signed({
    id: 'evt_fail_1', type: 'invoice.payment_failed', created: 1791700000, livemode: false,
    data: { object: {
      id: 'in_2', customer: 'cus_1', amount_due: 9900, attempt_count: 1, next_payment_attempt: 1791800000,
      customer_email: 'luisr@luisrojosmasonry.com', hosted_invoice_url: 'https://invoice.stripe.com/i/x',
      parent: { subscription_details: { subscription: 'sub_1', metadata: { tier: 'pro', client_id: 'luis-rojos-masonry-llc' } } },
      lines: { data: [{ period: { start: 1791700000, end: 1794300000 } }] },
    } },
  }));
  const c = await store.getClient('luis-rojos-masonry-llc');
  assert.equal(c.billing.status, 'past_due');
  assert.equal(c.billing.tier, 'pro');
  assert.equal(routerPosts.at(-1).kind, 'payment_failed');
  assert.equal(routerPosts.at(-1).amount, 99);
});

await test('invoice.paid → active again, period end recorded, no email', async () => {
  const n = routerPosts.length;
  await webhook(signed({
    id: 'evt_paid_1', type: 'invoice.paid', created: 1791710000, livemode: false,
    data: { object: { id: 'in_2', customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1', metadata: {} } },
      lines: { data: [{ period: { start: 1791700000, end: 1794300000 } }] } } },
  }));
  const c = await store.getClient('luis-rojos-masonry-llc');
  assert.equal(c.billing.status, 'active');
  assert.equal(c.billing.current_period_end, new Date(1794300000 * 1000).toISOString());
  assert.equal(routerPosts.length, n);
});

await test('subscription.updated to Kit price → tier changes + plan_changed email', async () => {
  await webhook(signed({
    id: 'evt_upd_1', type: 'customer.subscription.updated', created: 1791720000, livemode: false,
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, metadata: { client_id: 'luis-rojos-masonry-llc', tier: 'pro' },
      items: { data: [{ price: { lookup_key: 'acp_kit_monthly', recurring: { interval: 'month' } } }] } } },
  }));
  const c = await store.getClient('luis-rojos-masonry-llc');
  assert.equal(c.billing.tier, 'kit');
  assert.equal(routerPosts.at(-1).kind, 'plan_changed');
  assert.equal(routerPosts.at(-1).from_tier, 'pro');
});

await test('subscription.deleted → canceled + email', async () => {
  await webhook(signed({
    id: 'evt_del_1', type: 'customer.subscription.deleted', created: 1791730000, livemode: false,
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: {}, items: { data: [] } } },
  }));
  assert.equal((await store.getClient('luis-rojos-masonry-llc')).billing.status, 'canceled');
  assert.equal(routerPosts.at(-1).kind, 'canceled');
});

await test('Connect event (other signing secret) → contractor_payment row', async () => {
  const ev = {
    id: 'evt_conn_1', type: 'checkout.session.completed', account: 'acct_test_contractor', created: 1791740000, livemode: false,
    data: { object: { id: 'cs_c1', mode: 'payment', payment_status: 'unpaid', amount_total: 1200000,
      metadata: { client_id: 'luis-rojos-masonry-llc', reference: '123 E Main St' }, customer_details: { email: 'home@owner.test' } } },
  };
  const res = await webhook(signed(ev, process.env.STRIPE_CONNECT_WEBHOOK_SECRET));
  assert.equal(res.status, 200);
  assert.equal(routerPosts.at(-1).kind, 'contractor_payment');
  assert.equal(routerPosts.at(-1).amount, 12000);
  assert.equal(routerPosts.at(-1).payment_status, 'unpaid'); // ACH initiated, settles later
});

console.log('\nconnect onboarding');

await test('POST without admin key → 401, no account created', async () => {
  const res = await onboard(new Request('https://x/api/connect-onboard', { method: 'POST', body: '{"client_id":"luis-rojos-masonry-llc"}' }));
  assert.equal(res.status, 401);
  assert.equal(calls.filter((c) => c[0] === 'v2.accounts.create').length, 0);
});

let setupUrl;
await test('POST creates a SaaS-shaped v2 account and returns a signed setup link', async () => {
  const res = await onboard(new Request('https://x/api/connect-onboard', {
    method: 'POST', headers: { 'x-builder-key': 'test-builder-key' }, body: '{"client_id":"luis-rojos-masonry-llc"}',
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.account_id, 'acct_test_contractor');
  assert.equal(body.charges, 'pending');
  setupUrl = body.setup_url;
  assert.match(setupUrl, /^https:\/\/acp-backend-tucson\.netlify\.app\/api\/connect-onboard\?t=/);
  const p = last('v2.accounts.create')[1];
  assert.equal(p.dashboard, 'full');
  assert.deepEqual(p.defaults.responsibilities, { fees_collector: 'stripe', losses_collector: 'stripe' });
  assert.equal(p.configuration.merchant.capabilities.card_payments.requested, true);
  assert.equal(p.configuration.merchant.capabilities.ach_debit_payments.requested, true);
  assert.equal(p.configuration.merchant.mcc, '1740');
  assert.equal(p.identity.country, 'us');
  assert.equal(p.defaults.profile.business_url, 'https://luisrojosmasonry.com');
  const c = await store.getClient('luis-rojos-masonry-llc');
  assert.equal(c.payments.stripe_account, 'acct_test_contractor');
  assert.equal(c.billing.tier, 'kit', 'billing record left alone');
});

await test('second POST reuses the account', async () => {
  const n = calls.filter((c) => c[0] === 'v2.accounts.create').length;
  await onboard(new Request('https://x/api/connect-onboard', {
    method: 'POST', headers: { 'x-builder-key': 'test-builder-key' }, body: '{"client_id":"luis-rojos-masonry-llc"}',
  }));
  assert.equal(calls.filter((c) => c[0] === 'v2.accounts.create').length, n);
});

await test('setup link → fresh onboarding Account Link (eventually_due)', async () => {
  caps = { card_payments: { status: 'pending' } };
  requirements = { entries: [{ minimum_deadline: { status: 'currently_due' } }] };
  const res = await onboard(new Request(setupUrl));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://connect.stripe.com/setup/s/abc');
  const p = last('v2.accountLinks.create')[1];
  assert.equal(p.account, 'acct_test_contractor');
  assert.equal(p.use_case.type, 'account_onboarding');
  assert.equal(p.use_case.account_onboarding.collection_options.fields, 'eventually_due');
  assert.equal(p.use_case.account_onboarding.refresh_url, setupUrl);
  assert.equal(p.use_case.account_onboarding.return_url, setupUrl + '&done=1');
});

await test('tampered or expired token → 403', async () => {
  const t = new URL(setupUrl).searchParams.get('t');
  const forged = t.replace('luis-rojos-masonry-llc', 'someone-else-llc');
  assert.equal((await onboard(new Request(`https://x/api/connect-onboard?t=${encodeURIComponent(forged)}`))).status, 403);
  assert.equal((await onboard(new Request('https://x/api/connect-onboard?t=nope'))).status, 403);
  const [cid, , sig] = t.split('.');
  assert.equal((await onboard(new Request(`https://x/api/connect-onboard?t=${cid}.1000.${sig}`))).status, 403);
});

await test('return page says ready once card_payments is active', async () => {
  caps = { card_payments: { status: 'active' }, ach_debit_payments: { status: 'active' } };
  requirements = { entries: [] };
  const res = await onboard(new Request(setupUrl + '&done=1'));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ready to take payments/);
  assert.equal((await store.getClient('luis-rojos-masonry-llc')).payments.charges, 'active');
});

await test('finished account → setup link opens account_update, not onboarding', async () => {
  await onboard(new Request(setupUrl));
  assert.equal(last('v2.accountLinks.create')[1].use_case.type, 'account_update');
});

console.log('\npay');

await test('amount parsing', () => {
  assert.equal(payMod.parseAmount('2500'), 250000);
  assert.equal(payMod.parseAmount('$12,000.50'), 1200050);
  assert.equal(payMod.parseAmount('0.50'), null);
  assert.equal(payMod.parseAmount('100000.01'), null);
  assert.equal(payMod.parseAmount('12.345'), null);
  assert.equal(payMod.parseAmount('abc'), null);
});

await test('pay → direct charge on the contractor account, card + ACH, back to their own site', async () => {
  const res = await pay(new Request('https://x/api/pay?client=luis-rojos-masonry-llc&amount=12%2C000&ref=123%20E%20Main%20St', {
    headers: { referer: 'https://luisrojosmasonry.com/services/' },
  }));
  assert.equal(res.status, 303);
  const [, p, opts] = last('checkout.sessions.create');
  assert.deepEqual(opts, { stripeAccount: 'acct_test_contractor' });
  assert.equal(p.mode, 'payment');
  assert.equal(p.line_items[0].price_data.unit_amount, 1200000);
  assert.deepEqual(p.payment_method_types, ['card', 'us_bank_account']);
  assert.deepEqual(p.payment_method_options.us_bank_account.financial_connections.permissions, ['payment_method']);
  assert.equal(p.payment_intent_data.application_fee_amount, undefined, 'no platform fee unless configured');
  assert.equal(p.success_url, 'https://luisrojosmasonry.com/services/?paid=1#pay');
  assert.equal(p.metadata.reference, '123 E Main St');
});

await test('PLATFORM_FEE_BPS → capped application fee', async () => {
  process.env.PLATFORM_FEE_BPS = '50';
  await pay(new Request('https://x/api/pay?client=luis-rojos-masonry-llc&amount=12000'));
  assert.equal(last('checkout.sessions.create')[1].payment_intent_data.application_fee_amount, 2500, '0.5% of $12k = $60, capped at $25');
  await pay(new Request('https://x/api/pay?client=luis-rojos-masonry-llc&amount=1000'));
  assert.equal(last('checkout.sessions.create')[1].payment_intent_data.application_fee_amount, 500);
  delete process.env.PLATFORM_FEE_BPS;
});

await test('ACH not enabled yet → card only', async () => {
  caps = { card_payments: { status: 'active' }, ach_debit_payments: { status: 'pending' } };
  await pay(new Request('https://x/api/pay?client=luis-rojos-masonry-llc&amount=300'));
  const p = last('checkout.sessions.create')[1];
  assert.deepEqual(p.payment_method_types, ['card']);
  assert.equal(p.payment_method_options, undefined);
});

await test('evil referer → returns to the contractor domain, not the attacker', async () => {
  caps = { card_payments: { status: 'active' }, ach_debit_payments: { status: 'active' } };
  await pay(new Request('https://x/api/pay?client=luis-rojos-masonry-llc&amount=300', { headers: { referer: 'https://evil.example/x' } }));
  assert.equal(last('checkout.sessions.create')[1].success_url, 'https://luisrojosmasonry.com/?paid=1#pay');
});

await test('restricted account → 503 page, no session', async () => {
  caps = { card_payments: { status: 'restricted' } };
  const n = calls.filter((c) => c[0] === 'checkout.sessions.create').length;
  const res = await pay(new Request('https://x/api/pay?client=luis-rojos-masonry-llc&amount=300'));
  assert.equal(res.status, 503);
  assert.equal(calls.filter((c) => c[0] === 'checkout.sessions.create').length, n);
});

await test('bad amount → 400 page; unknown client → 404 page', async () => {
  caps = { card_payments: { status: 'active' } };
  assert.equal((await pay(new Request('https://x/api/pay?client=luis-rojos-masonry-llc&amount=-5'))).status, 400);
  assert.equal((await pay(new Request('https://x/api/pay?client=nobody-llc&amount=50'))).status, 404);
});

console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
