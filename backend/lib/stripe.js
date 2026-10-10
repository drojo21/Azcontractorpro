/**
 * stripe.js — one Stripe client and the small helpers every Stripe function shares.
 *
 * Two jobs live on top of this:
 *
 *   1. AZ Contractor Pro's OWN billing (checkout.js, stripe-webhook.js).
 *      Each tier is a one-time setup price plus a monthly price on the platform
 *      account. Prices are found by lookup_key, never by id, so test mode, a
 *      sandbox and live mode all work with the same code once
 *      scripts/stripe_setup.mjs has run against each.
 *
 *   2. The contractor packet (connect-onboard.js, pay.js). Each contractor is a
 *      Connect connected account (Accounts v2, SaaS shape): direct charges, the
 *      contractor is merchant of record, Stripe collects fees and owns loss
 *      liability, contractor gets the full Stripe Dashboard.
 *
 * Env:
 *   STRIPE_SECRET_KEY              sk_live_… / sk_test_… (or a restricted key — see docs/STRIPE.md)
 *   STRIPE_WEBHOOK_SECRET          whsec_… for the "Your account" endpoint
 *   STRIPE_CONNECT_WEBHOOK_SECRET  whsec_… for the "Connected accounts" endpoint (optional)
 *   ACP_LINK_SECRET                signs onboarding refresh links; falls back to BUILDER_KEY
 *   ROUTER_KEY                     shared with Apps Script (STRIPE_ROUTER_KEY) so fake payment emails are refused
 */

import Stripe from 'stripe';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const TIERS = ['starter', 'pro', 'kit'];
export const TIER_NAMES = { starter: 'Starter', pro: 'Pro', kit: 'Full Marketing Kit' };

let _stripe = null;

/** Tests swap in a fake client here instead of patching the network. */
export function setStripeForTests(fake) { _stripe = fake; _priceCache = null; }

export function stripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set on this site');
  _stripe = new Stripe(key, {
    appInfo: { name: 'AZ Contractor Pro', url: 'https://azcontractorpro.net' },
    maxNetworkRetries: 2,
  });
  return _stripe;
}

export const isLiveKey = () => /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '');

/* --------------------------------------------------------------- prices */

let _priceCache = null;          // { at, byKey: { acp_pro_setup: price, … } }
const PRICE_TTL_MS = 5 * 60 * 1000;

/** { setup, monthly } Price objects for a tier, by lookup key. */
export async function tierPrices(tier) {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier: ${tier}`);
  if (!_priceCache || Date.now() - _priceCache.at > PRICE_TTL_MS) {
    const keys = TIERS.flatMap((t) => [`acp_${t}_setup`, `acp_${t}_monthly`]);
    const res = await stripe().prices.list({ lookup_keys: keys, active: true, limit: 20 });
    _priceCache = { at: Date.now(), byKey: Object.fromEntries(res.data.map((p) => [p.lookup_key, p])) };
  }
  const setup = _priceCache.byKey[`acp_${tier}_setup`];
  const monthly = _priceCache.byKey[`acp_${tier}_monthly`];
  if (!setup || !monthly) {
    throw new Error(`prices for "${tier}" not found — run scripts/stripe_setup.mjs against this Stripe account/mode`);
  }
  return { setup, monthly };
}

/** acp_pro_monthly → "pro". Used to work out the tier after a portal plan change. */
export function tierFromLookupKey(key) {
  const m = /^acp_(starter|pro|kit)_(setup|monthly)$/.exec(key || '');
  return m ? m[1] : null;
}

/* --------------------------------------------------------- billing store */

const billingStore = () => getStore({ name: 'acp-stripe', consistency: 'strong' });

export async function getBilling(key) {
  try { return await billingStore().get(key, { type: 'json' }); } catch { return null; }
}

export async function putBilling(key, value) {
  await billingStore().setJSON(key, { ...value, updated_at: new Date().toISOString() });
}

/**
 * Webhook dedupe. Stripe retries anything that isn't a 2xx and can deliver the
 * same event twice even when it is, so side effects (emails) check here first.
 */
export async function seenEvent(id) {
  const db = billingStore();
  try {
    if (await db.get(`evt:${id}`)) return true;
    await db.set(`evt:${id}`, '1');
  } catch (err) {
    console.error('[stripe] event dedupe store failed:', err.message);
  }
  return false;
}

/* -------------------------------------------------------------- helpers */

export const CLIENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;

export function salesUrl() {
  return (process.env.SALES_SITE_URL || 'https://azcontractorpro.net').replace(/\/+$/, '');
}

export function backendUrl(req) {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/+$/, '');
  return new URL(req.url).origin;
}

/**
 * Only send a buyer "back" to a page we host. Without this check, cancel_url
 * would be an open redirect hanging off a stripe.com page.
 */
export function safeReturnUrl(candidate, fallback) {
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'https:') return fallback;
    const ok = /(^|\.)azcontractorpro\.(net|com)$/.test(u.hostname) ||
      u.hostname.endsWith('.netlify.app') ||
      (process.env.EXTRA_RETURN_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)
        .some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
    return ok ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

/** Tell the Apps Script router (and so Daniel's inbox / the Registry sheet). */
export async function notifyRouter(payload) {
  const url = process.env.LEAD_SHEET_URL || process.env.APPS_SCRIPT_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      // text/plain on purpose: application/json triggers a CORS preflight Apps Script won't answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, router_key: process.env.ROUTER_KEY || '' }),
    });
  } catch (err) {
    console.error('[stripe] router notify failed:', err.message);
  }
}

/* ------------------------------------------------ signed onboarding links */

const linkSecret = () => process.env.ACP_LINK_SECRET || process.env.BUILDER_KEY || process.env.ACP_ADMIN_KEY || '';

/**
 * A token that lets ONE contractor re-open THEIR onboarding for a limited time.
 * Account Link refresh URLs can leak (forwarded emails, browser history), and an
 * unauthenticated refresh endpoint would let anyone who knows a client_id start
 * onboarding someone else's account with their own bank details.
 */
export function signLink(clientId, ttlDays = 30) {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  const body = `${clientId}.${exp}`;
  const sig = createHmac('sha256', linkSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyLink(token) {
  if (!linkSecret() || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [clientId, exp, sig] = parts;
  const want = createHmac('sha256', linkSecret()).update(`${clientId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return CLIENT_ID_RE.test(clientId) ? clientId : null;
}

export function html(status, title, bodyHtml) {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<meta name="robots" content="noindex"><style>
body{margin:0;font:17px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f4ef;color:#1c1c1c}
main{max-width:560px;margin:12vh auto;padding:0 20px}h1{font-size:26px;line-height:1.2}
a{color:#b4610f}.btn{display:inline-block;margin-top:12px;padding:12px 20px;background:#1c1c1c;color:#fff;border-radius:8px;text-decoration:none}
</style></head><body><main><h1>${title}</h1>${bodyHtml}</main></body></html>`;
  return new Response(page, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
