/**
 * checkout.js — the "Buy" button. Replaces the Square payment links.
 *
 *   GET /api/checkout?tier=pro                       from the sales site
 *   GET /api/checkout?tier=pro&client=<client_id>    from a demo site or demo email
 *
 * Responds with a 303 to a Stripe-hosted Checkout page that charges the tier's
 * one-time setup fee and starts its monthly subscription in one go. A plain
 * link (not a form or fetch) on purpose: it works the same from a static demo
 * site, the sales site, and a Gmail button, and needs no JS.
 *
 * client= ties the purchase back to the demo site that sold it. It rides on
 * client_reference_id and on the subscription's metadata, which is what
 * stripe-webhook.js reads to mark that client paid.
 *
 * Optional: back=<url> — where "← Back" on the Checkout page goes. Only our own
 * hosts are honoured (see safeReturnUrl).
 *
 * Env: MONTHLY_START_DELAY_DAYS (default 14) — days between paying setup and the
 * first monthly charge, matching the sales page's "monthly begins when the site
 * goes live". Stripe shows it on the Checkout page as the date billing starts.
 */

import { getClient } from '../../lib/store.js';
import {
  stripe, tierPrices, TIERS, TIER_NAMES, CLIENT_ID_RE, salesUrl, safeReturnUrl, html, esc,
} from '../../lib/stripe.js';

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') return new Response('GET or POST', { status: 405 });

  const url = new URL(req.url);
  let params = url.searchParams;
  if (req.method === 'POST') {
    try { params = new URLSearchParams(await req.text()); } catch { /* fall back to query */ }
  }

  const tier = String(params.get('tier') || '').toLowerCase();
  const clientRaw = String(params.get('client') || '').toLowerCase();
  const clientId = CLIENT_ID_RE.test(clientRaw) ? clientRaw : null;
  const sales = salesUrl();

  if (!TIERS.includes(tier)) {
    return Response.redirect(`${sales}/#pricing`, 303);
  }

  let client = null;
  if (clientId) {
    try { client = await getClient(clientId); } catch { client = null; }
  }

  try {
    const { setup, monthly } = await tierPrices(tier);

    const meta = {
      tier,
      client_id: clientId || '',
      business_name: (client?.business_name || '').slice(0, 450),
      source: clientId ? 'demo' : 'sales_site',
    };

    // The sales page promises "pay setup now; monthly begins when the site goes live".
    // The setup fee (a one-time price) is charged at checkout; the monthly starts after
    // this many days. 0 = charge the first month today too.
    const delayDays = Math.max(0, Math.min(90, Number(process.env.MONTHLY_START_DELAY_DAYS ?? 14) || 0));
    const firstMonth = delayDays
      ? `Your ${TIER_NAMES[tier]} monthly plan starts ${delayDays} days from today, after your site is live.`
      : 'Your first month is included in today\'s charge.';

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        { price: monthly.id, quantity: 1 },
        // A one-time price in subscription mode is billed once, on the first invoice.
        { price: setup.id, quantity: 1 },
      ],
      client_reference_id: clientId || undefined,
      customer_email: client?.email || undefined,
      metadata: meta,
      subscription_data: {
        metadata: meta,
        description: `${TIER_NAMES[tier]} website${client?.business_name ? ` — ${client.business_name}` : ''}`,
        billing_mode: { type: 'flexible' },
        ...(delayDays ? { trial_period_days: delayDays } : {}),
      },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
      custom_text: {
        submit: {
          message: `Today you pay the one-time ${TIER_NAMES[tier]} setup fee. ${firstMonth} Cancel the monthly any time from the link in your receipt.`,
        },
      },
      success_url: `${sales}/thanks.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: safeReturnUrl(params.get('back') || req.headers.get('referer') || '', `${sales}/#pricing`),
    });

    return Response.redirect(session.url, 303);
  } catch (err) {
    console.error('[checkout]', tier, clientId, err?.type || '', err?.message);
    return html(502, 'Checkout is having a moment',
      `<p>We couldn't open the payment page just now. Nothing was charged.</p>
       <p>Try again in a minute, or call <a href="tel:+15204613937">520-461-3937</a> and we'll set it up with you.</p>
       <a class="btn" href="${esc(sales)}/#pricing">Back to pricing</a>`);
  }
};

export const config = { path: '/api/checkout' };
