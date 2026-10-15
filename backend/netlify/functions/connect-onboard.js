/**
 * connect-onboard.js — "Take payments" setup for a contractor (the customer-packet piece).
 *
 * Model (from Stripe's Connect planner, SaaS platform shape):
 *   • each contractor = one Accounts v2 connected account with the full Stripe Dashboard
 *   • direct charges: the CONTRACTOR is merchant of record — their name on the
 *     homeowner's statement, their refunds, their disputes
 *   • Stripe collects processing fees from the contractor and owns loss liability,
 *     so a contractor's chargeback never lands on AZ Contractor Pro's balance
 *   • cards + ACH bank debit (verified instantly with Financial Connections)
 *
 * Three ways in:
 *
 *   POST /api/connect-onboard            x-builder-key required (admin console / curl)
 *        { client_id, email?, business_name?, trade?, site_url? }
 *        Creates the connected account if the client doesn't have one, and returns
 *        a signed setup link to drop in the packet / email:
 *        { account_id, setup_url, charges: "active" | "pending" | … }
 *
 *   GET  /api/connect-onboard?t=<token>  the setup link itself. Verifies the token,
 *        mints a fresh Stripe-hosted onboarding link and redirects to it. Safe to
 *        click again and again: Account Links are single-use and expire in minutes,
 *        so the packet carries THIS url, never a raw Stripe link.
 *
 *   GET  /api/connect-onboard?t=<token>&done=1   where Stripe sends them back.
 *        Shows "you're set up" or "a couple of things left" with a resume button.
 *
 * Before the first POST, the platform must be set up for Connect in the Dashboard
 * (Connect → Get started → "SaaS platform"). See docs/STRIPE.md.
 */

import { getClient, patchClient } from '../../lib/store.js';
import {
  stripe, CLIENT_ID_RE, signLink, verifyLink, backendUrl, html, esc,
} from '../../lib/stripe.js';

const MCC = {
  electrical: '1731', lowvoltage: '1731', plumbing: '1711', hvac: '1711', septic: '1711', welldrilling: '1711',
  masonry: '1740', tile: '1740', insulation: '1740', roofing: '1761', concrete: '1771', asphalt: '1771',
  carpentry: '1750', general: '1520', landscaping: '0780', pools: '1799', painting: '1799',
};

const INCLUDE = ['configuration.merchant', 'requirements'];

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export function chargesStatus(account) {
  return account?.configuration?.merchant?.capabilities?.card_payments?.status || 'pending';
}

function dueCount(account) {
  const entries = account?.requirements?.entries || [];
  return entries.filter((e) => ['currently_due', 'past_due'].includes(e?.minimum_deadline?.status)).length;
}

async function createAccount(client, body) {
  const trade = body.trade || client?.trade || '';
  const site = body.site_url || client?.deploy?.custom_domain || client?.deploy?.netlify_url || client?.site_url || '';
  const name = body.business_name || client?.business_name || '';
  const merchant = {
    capabilities: {
      card_payments: { requested: true },
      ach_debit_payments: { requested: true },
    },
  };
  if (MCC[trade]) merchant.mcc = MCC[trade];

  return stripe().v2.core.accounts.create({
    display_name: name || undefined,
    contact_email: body.email || client?.email || undefined,
    dashboard: 'full',
    identity: { country: 'us' },
    defaults: {
      currency: 'usd',
      locales: ['en-US'],
      responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
      profile: {
        business_url: /^https:\/\//.test(site) ? site : undefined,
        doing_business_as: name || undefined,
        product_description: trade ? `Licensed ${trade} contractor — residential and commercial jobs in Arizona.` : undefined,
      },
    },
    configuration: { merchant },
    metadata: { client_id: client?.client_id || body.client_id, platform: 'azcontractorpro' },
    include: INCLUDE,
  });
}

async function onboardingRedirect(req, token, accountId) {
  // Reuse the token the contractor clicked: refresh/return keep the same expiry
  // as the link in their packet instead of quietly minting a new one.
  const base = `${backendUrl(req)}/api/connect-onboard?t=${encodeURIComponent(token)}`;
  const account = await stripe().v2.core.accounts.retrieve(accountId, { include: INCLUDE });
  const done = chargesStatus(account) === 'active' && dueCount(account) === 0;
  const link = await stripe().v2.core.accountLinks.create({
    account: accountId,
    use_case: done
      ? { type: 'account_update', account_update: { refresh_url: base, return_url: `${base}&done=1` } }
      : {
          type: 'account_onboarding',
          account_onboarding: {
            refresh_url: base,
            return_url: `${base}&done=1`,
            collection_options: { fields: 'eventually_due' },
          },
        },
  });
  return Response.redirect(link.url, 303);
}

async function handlePost(req) {
  const KEY = process.env.BUILDER_KEY || process.env.ACP_ADMIN_KEY;
  if (!KEY) return json(503, { error: 'No admin key configured (BUILDER_KEY / ACP_ADMIN_KEY)' });
  if (req.headers.get('x-builder-key') !== KEY) return json(401, { error: 'Bad or missing x-builder-key' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad json' }); }
  const clientId = String(body.client_id || '').toLowerCase();
  if (!CLIENT_ID_RE.test(clientId)) return json(400, { error: 'client_id is required' });

  const client = await getClient(clientId);
  let accountId = client?.payments?.stripe_account || null;
  let account;

  if (accountId) {
    account = await stripe().v2.core.accounts.retrieve(accountId, { include: INCLUDE });
  } else {
    account = await createAccount(client || { client_id: clientId }, body);
    accountId = account.id;
  }

  const status = chargesStatus(account);
  await patchClient(clientId, {
    payments: {
      ...(client?.payments || {}),
      provider: 'stripe_connect',
      stripe_account: accountId,
      charges: status,
      requirements_due: dueCount(account),
      checked_at: new Date().toISOString(),
    },
  });

  const setupUrl = `${backendUrl(req)}/api/connect-onboard?t=${encodeURIComponent(signLink(clientId, 60))}`;
  return json(200, { client_id: clientId, account_id: accountId, charges: status, requirements_due: dueCount(account), setup_url: setupUrl });
}

async function handleGet(req) {
  const url = new URL(req.url);
  const clientId = verifyLink(url.searchParams.get('t'));
  if (!clientId) {
    return html(403, 'This setup link has expired',
      `<p>For your security, payment-setup links stop working after a while.</p>
       <p>Call or text AZ Contractor Pro at <a href="tel:+15204613937">520-461-3937</a> and we'll send a fresh one.</p>`);
  }
  const client = await getClient(clientId);
  const accountId = client?.payments?.stripe_account;
  if (!accountId) {
    return html(404, 'Payments aren\'t set up for this business yet',
      `<p>Call AZ Contractor Pro at <a href="tel:+15204613937">520-461-3937</a> and we'll get you started.</p>`);
  }

  if (url.searchParams.get('done')) {
    const account = await stripe().v2.core.accounts.retrieve(accountId, { include: INCLUDE });
    const status = chargesStatus(account);
    const due = dueCount(account);
    await patchClient(clientId, {
      payments: { ...(client.payments || {}), charges: status, requirements_due: due, checked_at: new Date().toISOString() },
    });
    const resume = `${backendUrl(req)}/api/connect-onboard?t=${encodeURIComponent(url.searchParams.get('t'))}`;
    if (status === 'active' && due === 0) {
      return html(200, 'You\'re ready to take payments',
        `<p><b>${esc(client.business_name || 'Your business')}</b> can now accept cards and bank (ACH) payments.
         Money lands in the bank account you just added, usually within 2 business days.</p>
         <p>Send invoices and see every payment in your own Stripe Dashboard:</p>
         <a class="btn" href="https://dashboard.stripe.com/">Open my Stripe Dashboard</a>`);
    }
    return html(200, 'Almost there',
      `<p>Stripe still needs ${due ? `${due} more item${due === 1 ? '' : 's'}` : 'a moment to review your details'} before you can take payments.
       ${status === 'pending' ? 'If you finished everything, this usually clears within a day.' : ''}</p>
       <a class="btn" href="${esc(resume)}">Continue setup</a>`);
  }

  try {
    return await onboardingRedirect(req, url.searchParams.get('t'), accountId);
  } catch (err) {
    console.error('[connect-onboard] link failed', clientId, err.message);
    return html(502, 'Stripe is having a moment', `<p>Try the link again in a minute.</p>`);
  }
}

export default async (req) => {
  try {
    if (req.method === 'POST') return await handlePost(req);
    if (req.method === 'GET') return await handleGet(req);
    return new Response('GET or POST', { status: 405 });
  } catch (err) {
    console.error('[connect-onboard]', err?.type || '', err.message);
    return json(502, { error: err.message });
  }
};

export const config = { path: '/api/connect-onboard' };
