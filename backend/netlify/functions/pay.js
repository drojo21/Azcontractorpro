/**
 * pay.js — the "Make a payment" form on a contractor's site.
 *
 *   GET /api/pay?client=<client_id>&amount=2500&ref=Invoice%201042
 *
 * Opens a Stripe-hosted Checkout page on the CONTRACTOR's connected account
 * (a direct charge): the homeowner pays the contractor, the contractor's name
 * is on the statement, the money goes to the contractor's bank. AZ Contractor
 * Pro never holds the funds.
 *
 * Payment methods: card always; ACH bank debit when the contractor's account has
 * it enabled. ACH runs through Financial Connections (instant bank login, with
 * micro-deposits as the fallback), and on a $12,000 patio it costs the
 * contractor ~$5 instead of ~$350 on a card — which is the reason it's here.
 *
 * Optional platform fee: PLATFORM_FEE_BPS (basis points, 50 = 0.5%) with
 * PLATFORM_FEE_CAP_CENTS (default 2500 = $25). Unset = no fee. It is charged on
 * top of Stripe's own fee and shows as a separate line in the contractor's Dashboard.
 *
 * For invoices the contractor writes themselves, they don't need this at all —
 * Stripe Dashboard → Invoices → Create sends the homeowner a pay link directly.
 * This form is for "pay your deposit / pay the balance" from the website.
 */

import { getClient } from '../../lib/store.js';
import { stripe, CLIENT_ID_RE, html, esc } from '../../lib/stripe.js';

const MIN_CENTS = 100;            // $1
const MAX_CENTS = 100_000_00;     // $100,000 — above this, send a Dashboard invoice / wire

function platformFee(cents) {
  const bps = Number(process.env.PLATFORM_FEE_BPS || 0);
  if (!bps || bps < 0) return 0;
  const cap = Number(process.env.PLATFORM_FEE_CAP_CENTS || 2500);
  return Math.min(Math.round((cents * bps) / 10000), cap);
}

function clientHosts(client) {
  const d = client?.deploy || {};
  return [d.custom_domain, d.netlify_url, client?.site_url]
    .filter(Boolean)
    .map((u) => { try { return new URL(u).hostname; } catch { return null; } })
    .filter(Boolean);
}

/** Return to the contractor's own site, never anywhere else. */
function siteReturn(client, candidate) {
  const hosts = clientHosts(client);
  try {
    const u = new URL(candidate);
    if (u.protocol === 'https:' && hosts.includes(u.hostname)) return `${u.origin}${u.pathname}`;
  } catch { /* fall through */ }
  const first = client?.deploy?.custom_domain || client?.deploy?.netlify_url || client?.site_url;
  return first ? first.replace(/\/+$/, '') + '/' : 'https://azcontractorpro.net/';
}

export function parseAmount(raw) {
  const s = String(raw ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents >= MIN_CENTS && cents <= MAX_CENTS ? cents : null;
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') return new Response('GET or POST', { status: 405 });
  const url = new URL(req.url);
  let p = url.searchParams;
  if (req.method === 'POST') {
    try { p = new URLSearchParams(await req.text()); } catch { /* query only */ }
  }

  const clientId = String(p.get('client') || '').toLowerCase();
  if (!CLIENT_ID_RE.test(clientId)) return html(400, 'Payment link is incomplete', '<p>Please go back and try again.</p>');

  const client = await getClient(clientId);
  const accountId = client?.payments?.stripe_account;
  const name = client?.business_name || 'this business';
  const back = siteReturn(client, p.get('back') || req.headers.get('referer') || '');
  const phone = client?.phone ? `<a href="tel:${esc(client.phone.replace(/[^\d+]/g, ''))}">${esc(client.phone)}</a>` : 'the office';

  if (!accountId) {
    return html(404, `${esc(name)} isn't taking online payments yet`, `<p>Please call ${phone} to pay.</p><a class="btn" href="${esc(back)}">Back</a>`);
  }

  const cents = parseAmount(p.get('amount'));
  if (!cents) {
    return html(400, 'Check the amount',
      `<p>Enter an amount between $1 and $100,000 — numbers only, like <b>2500</b> or <b>2500.00</b>.</p>
       <a class="btn" href="${esc(back)}#pay">Back</a>`);
  }
  const ref = String(p.get('ref') || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);

  try {
    // Check the account can take money before sending anyone to a page that would fail.
    const account = await stripe().v2.core.accounts.retrieve(accountId, { include: ['configuration.merchant'] });
    const caps = account?.configuration?.merchant?.capabilities || {};
    if (caps.card_payments?.status !== 'active') {
      return html(503, `${esc(name)} can't take online payments right now`, `<p>Please call ${phone}.</p><a class="btn" href="${esc(back)}">Back</a>`);
    }
    const methods = ['card'];
    if (caps.ach_debit_payments?.status === 'active') methods.push('us_bank_account');

    const fee = platformFee(cents);
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: {
            name: ref ? `${ref}` : `Payment to ${name}`,
            description: ref ? `Payment to ${name}` : undefined,
          },
        },
      }],
      payment_method_types: methods,
      payment_method_options: methods.includes('us_bank_account')
        ? { us_bank_account: { verification_method: 'automatic', financial_connections: { permissions: ['payment_method'] } } }
        : undefined,
      payment_intent_data: {
        description: `${name}${ref ? ` — ${ref}` : ''}`.slice(0, 1000),
        application_fee_amount: fee || undefined,
        metadata: { client_id: clientId, reference: ref, source: 'contractor_site' },
      },
      invoice_creation: { enabled: true, invoice_data: { description: ref || undefined, metadata: { client_id: clientId } } },
      customer_creation: 'always',
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
      metadata: { client_id: clientId, reference: ref },
      submit_type: 'pay',
      success_url: `${back}?paid=1#pay`,
      cancel_url: `${back}#pay`,
    }, { stripeAccount: accountId });

    return Response.redirect(session.url, 303);
  } catch (err) {
    console.error('[pay]', clientId, err?.type || '', err.message);
    return html(502, 'The payment page didn\'t open', `<p>Nothing was charged. Try again in a minute, or call ${phone}.</p><a class="btn" href="${esc(back)}">Back</a>`);
  }
};

export const config = { path: '/api/pay' };
