/**
 * onboard.js — the 3-minute setup form a buyer fills in after paying.
 *
 *   GET  /api/onboard?session_id=cs_…   what the form should show (prefilled)
 *   POST /api/onboard                    { session_id, …answers } → their site rebuilds
 *
 * This replaces "Daniel calls you within one business day". The Stripe Checkout
 * session id on thanks.html is the buyer's key: it is long, random, only ever
 * shown to the person who paid, and it names exactly one plan and (when the
 * purchase came from a demo) exactly one client. Every request re-asks Stripe
 * whether that session is complete and paid — nothing here trusts the page.
 *
 * What a POST does, in order:
 *   1. checks the answers (autopilot.sanitizeOnboarding) — 422 with per-field errors
 *   2. finds the client record: the demo the purchase came from, or — for a buyer
 *      who went straight to checkout — a new record built from their ROC number
 *      through the same licence gate as every demo (refused if not active)
 *   3. promote() + applyOnboarding() and ONE commit to clients/<id>/client.json on
 *      the default branch; that push is what makes deploy.yml rebuild and publish
 *   4. tells the Apps Script router (action=onboarded), which provisions the
 *      Drive folders, points the site's quote form at the buyer, and emails them
 *      when deploy.yml reports the site live (action=site_live)
 *
 * Env: STRIPE_SECRET_KEY, GITHUB_TOKEN (+ GITHUB_REPO), LEAD_SHEET_URL, ROUTER_KEY,
 *      SALES_SITE_URL, APPS_SCRIPT_URL (optional; falls back to LEAD_SHEET_URL)
 */

import ACPSchema from '../../lib/acp-schema.cjs';
import rocActive from '../../lib/roc-active.cjs';
import { getClient } from '../../lib/store.js';
import { readJson, updateJson } from '../../lib/github.js';
import {
  stripe, getBilling, putBilling, notifyRouter, TIER_NAMES, salesUrl, CLIENT_ID_RE,
} from '../../lib/stripe.js';
import {
  acp, promote, sanitizeOnboarding, applyOnboarding, formContext, dnsSteps, formatPhone, PLANS, PLAN_TIER,
} from '../../lib/autopilot.js';

const { ROCActive } = rocActive;

const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{8,240}$/;
const MAX_AGE_DAYS = 400;     // a buyer can come back and change their answers for this long
const MAX_SUBMITS = 40;       // edits per purchase; well past any honest use
const MAX_BODY = 24 * 1024;

function corsHeaders(req) {
  const origin = req.headers.get('origin') || '';
  const allowed = [salesUrl(), 'https://azcontractorpro.com', 'https://www.azcontractorpro.com',
    'https://www.azcontractorpro.net', ...(process.env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : salesUrl(),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

const reply = (req, status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(req) },
});

class Refusal extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/** The paid Checkout session behind this request, or a Refusal. */
async function paidSession(id) {
  if (!SESSION_RE.test(String(id || ''))) throw new Refusal(400, 'This setup link is incomplete. Open it from your receipt email.');
  let s;
  try {
    s = await stripe().checkout.sessions.retrieve(id);
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === 'resource_missing') throw new Refusal(404, 'We couldn’t find that purchase. Open the link from your receipt email.');
    throw err;
  }
  if (s.mode !== 'subscription') throw new Refusal(400, 'That purchase isn’t a website plan.');
  if (s.status !== 'complete' || !['paid', 'no_payment_required'].includes(s.payment_status)) {
    throw new Refusal(402, 'This checkout hasn’t been paid yet. If you just paid, wait a minute and refresh.');
  }
  if ((Date.now() / 1000 - Number(s.created || 0)) > MAX_AGE_DAYS * 86400) {
    throw new Refusal(410, 'This setup link has expired. Reply to your receipt email and we’ll send a fresh one.');
  }
  const plan = String(s.metadata?.tier || '').toLowerCase();
  if (!PLANS.includes(plan)) throw new Refusal(400, 'That purchase has no website plan attached.');
  const sub = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id || '';
  const fromSession = String(s.client_reference_id || s.metadata?.client_id || '').toLowerCase();
  return {
    session: s,
    plan,
    subscriptionId: sub,
    sessionClientId: CLIENT_ID_RE.test(fromSession) ? fromSession : '',
    contact: {
      email: s.customer_details?.email || '',
      phone: s.customer_details?.phone || '',
      name: s.customer_details?.name || '',
    },
  };
}

const clientPath = (id) => `clients/${id}/client.json`;
const serialize = (c) => acp.dumps(c) + '\n';

/** The URL a site can be opened at right now, and the *.netlify.app host for DNS. */
function siteHosts(record, stored) {
  const urls = [stored?.deploy?.netlify_url, record?.deploy?.netlify_url].filter(Boolean);
  const netlify = urls.map((u) => { try { return new URL(u).host; } catch { return ''; } })
    .find((h) => h.endsWith('.netlify.app')) || record?.deploy?.netlify_subdomain || '';
  return { netlifyHost: netlify, openUrl: netlify ? `https://${netlify}` : (urls[0] || '') };
}

/** A brand-new record for a buyer who went straight to checkout, through the licence gate. */
function recordFromRoc(rocInput, extra) {
  const roc = ACPSchema.digits(rocInput);
  if (!roc) throw new Refusal(422, 'Enter your ROC license number.', { errors: { roc_number: 'Enter your ROC license number.' } });
  const roster = ROCActive.load();
  const lic = roster.get(roc);
  if (!lic) {
    throw new Refusal(422, `ROC #${roc} isn’t on the Arizona ROC active list, so we can’t publish licensure claims for it. Check the number, or reply to your receipt and we’ll sort it out.`,
      { errors: { roc_number: 'Not on the ROC active list — check the number.' } });
  }
  const endpoint = process.env.APPS_SCRIPT_URL || process.env.LEAD_SHEET_URL || '';
  let c = acp.fromClientInfoBlock({
    BUSINESS_NAME: lic.business_name,
    OWNER_NAME: extra.owner || lic.qualifying_party,
    ROC_NUMBER: roc,
    LICENSE_CLASS: lic.license_class,
    PHONE: extra.phone || '',
    EMAIL: extra.email || '',
    CITY: lic.city,
    STATE: lic.state || 'AZ',
    ZIP: lic.zip || '85701',
    TRADE: acp.normalizeTrade(extra.trade || '') || '',
    TAGLINE: 'auto',
  });
  const title = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Llc|Inc|Lp|Llp|Pllc|Dba|Ii|Iii|Hvac|Az)\b/g, (m) => m.toUpperCase());
  const name = String(lic.business_name || '');
  c.business_name = name && name === name.toUpperCase() ? title(name) : name;
  c.short_name = '';                      // re-derived from the corrected name by resolve()
  c.city = title(lic.city);
  c.roc_number = roc;
  c.license_class = lic.license_class || c.license_class;
  c.license_class_description = lic.license_class_description || c.license_class_description;
  c.roc_status = lic.roc_status || 'Active';
  c.integrations = { ...(c.integrations || {}), lead_endpoint: endpoint, gallery_endpoint: endpoint };
  c.roc_verified = {
    source: 'azroc posting list',
    snapshot_date: roster.snapshotDate,
    verified_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    expiration_date: lic.expiration_date,
    also_holds: [],
    added_via: 'self-serve onboarding',
  };
  return acp.resolve(c);
}

async function handleGet(req, url) {
  const ctx = await paidSession(url.searchParams.get('session_id'));
  const saved = (await getBilling(`onb:${ctx.session.id}`)) || {};
  const clientId = ctx.sessionClientId || saved.client_id || '';

  let record = null;
  if (clientId) {
    const file = await readJson(clientPath(clientId));
    record = file ? file.data : await getClient(clientId);
  }
  const stored = clientId ? await getClient(clientId) : null;
  const { openUrl } = siteHosts(record, stored);

  const form = record ? formContext(record) : formContext({
    phone: ctx.contact.phone ? formatPhone(ctx.contact.phone) : '',
    email: ctx.contact.email, owner: ctx.contact.name,
  });
  let tradeOptions;
  if (!record) {
    // Straight-to-checkout buyer: the page asks for the ROC number and trade
    // first, then offers that trade's services and the licence city's metro.
    form.business_name = '';
    form.services = [];
    form.suggested_services = [];
    form.service_area = [];
    form.suggested_areas = [];
    tradeOptions = Object.entries(acp.trades).map(([value, t]) => ({
      value, label: t.label, services: t.default_services.map((s) => s.name),
    }));
  }

  return reply(req, 200, {
    ...(tradeOptions ? { trade_options: tradeOptions } : {}),
    ok: true,
    plan: ctx.plan,
    plan_name: TIER_NAMES[ctx.plan],
    tier: PLAN_TIER[ctx.plan],
    client_id: clientId,
    needs_roc: !record,
    submitted_at: saved.submitted_at || (record?.onboarding?.submitted_at) || '',
    site_url: openUrl,
    buyer_email: ctx.contact.email,
    form,
  });
}

async function handlePost(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Refusal(413, 'That form is too large.');
  let body;
  try { body = JSON.parse(text); } catch { throw new Refusal(400, 'Send the form as JSON.'); }

  const ctx = await paidSession(body.session_id);
  const key = `onb:${ctx.session.id}`;
  const saved = (await getBilling(key)) || {};
  if ((saved.count || 0) >= MAX_SUBMITS) {
    throw new Refusal(429, 'This setup form has been sent many times already. Reply to your receipt email with any other changes.');
  }

  const { fields, errors } = sanitizeOnboarding(body);
  if (Object.keys(errors).length) throw new Refusal(422, 'A few answers need another look.', { errors });

  // Which record? The demo this purchase came from, an earlier submit, or a new one.
  let clientId = ctx.sessionClientId || saved.client_id || '';
  let fresh = null;
  if (!clientId) {
    fresh = recordFromRoc(body.roc_number, {
      owner: fields.owner, phone: fields.phone || ctx.contact.phone, email: fields.email || ctx.contact.email, trade: body.trade,
    });
    clientId = fresh.client_id;
    const clash = await readJson(clientPath(clientId));
    if (clash && ACPSchema.digits(clash.data.roc_number) !== fresh.roc_number) {
      clientId = `${clientId}-${fresh.roc_number}`.slice(0, 80);
      fresh.client_id = clientId;
    }
  }
  if (!CLIENT_ID_RE.test(clientId)) throw new Refusal(400, 'That purchase points at an unknown site.');

  let problems = [];
  const result = await updateJson(clientPath(clientId), (cur) => {
    let c = cur || fresh;
    if (!c) throw new Refusal(404, 'We couldn’t find the demo site this purchase belongs to. Reply to your receipt email and we’ll connect it.');
    c = promote(c, ctx.plan, ctx.contact);
    c = applyOnboarding(c, fields);
    // A full build needs an address to put in its canonical tags. A brand-new site
    // has none until its first publish, so it goes out one-page first and
    // publish.py flips it to full the moment Netlify hands back the address.
    if (c.tier === 'full' && !c.site_url) {
      c.tier = 'lite';
      c.onboarding = { ...c.onboarding, full_pending: true };
    }
    problems = acp.validate(c).filter((p) => p.level === 'error');
    if (problems.length) return null;
    return {
      data: c,
      message: `${cur ? 'Update' : 'Add'} ${c.business_name} (${TIER_NAMES[ctx.plan]}) from self-serve setup [autopilot]`,
    };
  }, serialize);

  if (problems.length) {
    console.error('[onboard] record would not validate', clientId, problems);
    throw new Refusal(422, 'Something in these answers doesn’t fit the site builder. Check the highlighted fields.', {
      errors: Object.fromEntries(problems.map((p) => [p.field.split('.')[0], p.message])),
    });
  }

  const record = result.data;
  await putBilling(key, {
    client_id: clientId,
    count: (saved.count || 0) + 1,
    submitted_at: new Date().toISOString(),
    commit: result.commit,
  });

  // A straight-to-checkout buyer's subscription has no client_id yet; give it one
  // so renewal and cancellation events find the right site later.
  if (!ctx.sessionClientId && ctx.subscriptionId) {
    try {
      const prev = (await getBilling(`sub:${ctx.subscriptionId}`)) || {};
      await putBilling(`sub:${ctx.subscriptionId}`, { ...prev, client_id: clientId, subscription_id: ctx.subscriptionId });
      await stripe().subscriptions.update(ctx.subscriptionId, { metadata: { client_id: clientId } });
    } catch (err) {
      console.error('[onboard] could not tag subscription', ctx.subscriptionId, err.message);
    }
  }

  const stored = await getClient(clientId);
  const { netlifyHost, openUrl } = siteHosts(record, stored);
  const primary = fields.domain?.primary || '';
  const dns = primary ? dnsSteps(primary, netlifyHost) : null;

  await notifyRouter({
    action: 'onboarded',
    session_id: ctx.session.id,
    client_id: clientId,
    business_name: record.business_name,
    plan: ctx.plan,
    plan_name: TIER_NAMES[ctx.plan],
    buyer_email: ctx.contact.email,
    buyer_name: ctx.contact.name,
    lead_email: record.integrations?.notification_email || record.email || '',
    phone: record.phone || '',
    services: (record.services || []).map((s) => s.name),
    service_area: record.service_area || [],
    domain_status: fields.domain_status,
    domain: primary,
    dns: dns ? JSON.stringify(dns) : '',
    site_url: openUrl,
    notes: fields.notes || '',
    first_submit: !saved.count,
  });

  return reply(req, 200, {
    ok: true,
    client_id: clientId,
    business_name: record.business_name,
    plan_name: TIER_NAMES[ctx.plan],
    site_url: openUrl,
    custom_domain: primary ? `https://${primary}` : '',
    dns,
    rebuild_minutes: 4,
    changed: result.written,
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders(req) });
  const url = new URL(req.url);
  try {
    if (req.method === 'GET') return await handleGet(req, url);
    if (req.method === 'POST') return await handlePost(req);
    return reply(req, 405, { ok: false, error: 'GET or POST' });
  } catch (err) {
    if (err instanceof Refusal) return reply(req, err.status, { ok: false, error: err.message, ...err.extra });
    console.error('[onboard]', err?.status || '', err?.message);
    const status = err?.status === 503 ? 503 : 502;
    return reply(req, status, {
      ok: false,
      error: 'Setup is having a moment — nothing was lost. Try again in a minute, or call 520-461-3937.',
    });
  }
};

export const config = { path: '/api/onboard' };
