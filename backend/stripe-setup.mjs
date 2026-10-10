/**
 * stripe-setup.mjs — create (or confirm) the three tiers in a Stripe account.
 *
 *   cd backend && STRIPE_SECRET_KEY=sk_test_... node stripe-setup.mjs
 *
 * Safe to run any number of times: products have fixed ids and prices are found
 * by lookup_key, so a second run changes nothing. If you CHANGE a price below,
 * the run creates the new price and moves the lookup_key onto it
 * (transfer_lookup_key) — new checkouts get the new price, existing
 * subscribers stay on what they signed up for until you migrate them.
 *
 * Live mode was set up through the Stripe connector on 2026-10-10 with exactly
 * these values; run this against test mode or a sandbox before testing there.
 */

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Set STRIPE_SECRET_KEY'); process.exit(1); }
const stripe = new Stripe(key);

// Mirrors config/acp.json → pricing. Amounts in cents.
const TIERS = {
  starter: { name: 'Starter Website', setup: 49700, monthly: 4900,
    description: 'One-page contractor website on your domain, lead form wired to your inbox, schema markup, hosting and SSL.' },
  pro: { name: 'Pro Website', setup: 99700, monthly: 9900,
    description: 'Multi-page contractor website: service pages, service-area pages, photo gallery, reviews page, browser editor. Hosting and SSL included.' },
  kit: { name: 'Full Marketing Kit', setup: 199700, monthly: 19900,
    description: 'Pro website plus video hero, SMS lead alerts, Facebook ad campaigns, Google Business Profile setup and post templates.' },
};

async function ensureProduct(tier, t) {
  const id = `acp_${tier}`;
  try {
    return await stripe.products.retrieve(id);
  } catch (err) {
    if (err?.statusCode !== 404) throw err;
    return stripe.products.create({ id, name: t.name, description: t.description, metadata: { tier } });
  }
}

async function ensurePrice(tier, kind, amount) {
  const lookup = `acp_${tier}_${kind}`;
  const existing = (await stripe.prices.list({ lookup_keys: [lookup], limit: 1 })).data[0];
  if (existing && existing.unit_amount === amount && existing.active) return { price: existing, action: 'ok' };
  const price = await stripe.prices.create({
    product: `acp_${tier}`,
    currency: 'usd',
    unit_amount: amount,
    ...(kind === 'monthly' ? { recurring: { interval: 'month' } } : {}),
    lookup_key: lookup,
    transfer_lookup_key: true,
    nickname: `${tier[0].toUpperCase()}${tier.slice(1)} ${kind === 'setup' ? 'setup (one-time)' : 'monthly'}`,
    metadata: { tier, kind },
  });
  return { price, action: existing ? 'replaced' : 'created' };
}

const mode = key.includes('_live_') ? 'LIVE' : 'test/sandbox';
console.log(`Stripe account mode: ${mode}\n`);
for (const [tier, t] of Object.entries(TIERS)) {
  await ensureProduct(tier, t);
  for (const kind of ['setup', 'monthly']) {
    const { price, action } = await ensurePrice(tier, kind, t[kind]);
    console.log(`${action.padEnd(8)} ${price.lookup_key.padEnd(20)} $${(price.unit_amount / 100).toFixed(2)}  ${price.id}`);
  }
}
