/**
 * stripe-webhook.js — Stripe tells us what happened; this keeps our records in step.
 *
 *   POST /api/stripe-webhook
 *
 * Point TWO endpoints in the Stripe Dashboard (Workbench → Webhooks) at this URL:
 *   • "Your account"        → STRIPE_WEBHOOK_SECRET          (your own billing)
 *   • "Connected accounts"  → STRIPE_CONNECT_WEBHOOK_SECRET  (contractor payments; optional)
 * The signature is checked against whichever secrets are set.
 *
 * Your billing — events and what they do:
 *   checkout.session.completed      new customer: record tier/customer/subscription,
 *                                   mark the client paid, email Daniel
 *   invoice.paid                    renewal (or first) payment landed → status active
 *   invoice.payment_failed          card failed → status past_due, email Daniel
 *                                   (Stripe's Smart Retries + emails do the chasing)
 *   customer.subscription.updated   plan change / cancel-at-period-end from the portal
 *   customer.subscription.deleted   subscription ended → status canceled, email Daniel
 *
 * Contractor payments (event.account set):
 *   checkout.session.completed      a homeowner paid a contractor through /api/pay → log + email
 *
 * Stripe sends the money and receipts itself; nothing here moves funds. All this
 * function does is bookkeeping and notifications, so it answers 200 for anything
 * it doesn't care about and never throws a 500 for a failed side effect (that
 * would make Stripe retry and re-send the emails).
 */

import { patchClient } from '../../lib/store.js';
import {
  stripe, getBilling, putBilling, seenEvent, notifyRouter, tierFromLookupKey, TIER_NAMES,
} from '../../lib/stripe.js';

const ok = (extra = {}) => new Response(JSON.stringify({ received: true, ...extra }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

function verify(raw, sig) {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean);
  if (!secrets.length) throw new Error('no webhook secret configured');
  let last;
  for (const secret of secrets) {
    try { return stripe().webhooks.constructEvent(raw, sig, secret); } catch (err) { last = err; }
  }
  throw last;
}

/** subscription metadata survives on invoices under parent.subscription_details. */
function invoiceSubscription(inv) {
  const d = inv?.parent?.subscription_details;
  const sub = d?.subscription || inv?.subscription || null;
  return { id: typeof sub === 'string' ? sub : sub?.id || null, metadata: d?.metadata || {} };
}

function monthlyTier(sub) {
  for (const item of sub?.items?.data || []) {
    const t = tierFromLookupKey(item?.price?.lookup_key);
    if (t && item?.price?.recurring) return t;
  }
  return sub?.metadata?.tier || null;
}

/** One place that writes subscription state, to the billing store and the client record. */
async function record(subId, patch) {
  if (!subId) return null;
  const prev = (await getBilling(`sub:${subId}`)) || {};
  // undefined means "not known from this event", not "erase what we had"
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== ''));
  const next = { ...prev, ...clean, subscription_id: subId };
  await putBilling(`sub:${subId}`, next);
  if (next.customer_id) await putBilling(`cus:${next.customer_id}`, { subscription_id: subId, client_id: next.client_id || '' });
  if (next.client_id) {
    try {
      await patchClient(next.client_id, {
        billing: {
          provider: 'stripe',
          tier: next.tier || null,
          status: next.status || null,
          customer_id: next.customer_id || null,
          subscription_id: subId,
          current_period_end: next.current_period_end || null,
          cancel_at_period_end: !!next.cancel_at_period_end,
        },
      });
    } catch (err) {
      console.error('[stripe-webhook] client patch failed:', err.message);
    }
  }
  return next;
}

async function onCheckoutCompleted(event) {
  const s = event.data.object;

  // A homeowner paying a contractor (direct charge on the connected account).
  if (event.account) {
    if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') {
      // ACH: the session completes when the bank debit is initiated; it settles days later.
      console.log('[stripe-webhook] contractor payment pending', event.account, s.id, s.payment_status);
    }
    await notifyRouter({
      action: 'stripe_event',
      kind: 'contractor_payment',
      client_id: s.metadata?.client_id || '',
      connected_account: event.account,
      amount: (s.amount_total || 0) / 100,
      payment_status: s.payment_status,
      reference: s.metadata?.reference || '',
      payer_email: s.customer_details?.email || '',
      session_id: s.id,
    });
    return;
  }

  if (s.mode !== 'subscription') return;
  const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
  const tier = s.metadata?.tier || null;
  const clientId = s.client_reference_id || s.metadata?.client_id || '';
  const rec = await record(subId, {
    tier,
    client_id: clientId,
    business_name: s.metadata?.business_name || '',
    customer_id: typeof s.customer === 'string' ? s.customer : s.customer?.id,
    email: s.customer_details?.email || '',
    name: s.customer_details?.name || '',
    phone: s.customer_details?.phone || '',
    status: s.payment_status === 'paid' ? 'active' : 'incomplete',
    started_at: new Date(event.created * 1000).toISOString(),
    source: s.metadata?.source || '',
  });

  await notifyRouter({
    action: 'stripe_event',
    kind: 'new_customer',
    client_id: clientId,
    tier,
    tier_name: TIER_NAMES[tier] || tier,
    amount: (s.amount_total || 0) / 100,
    email: rec?.email || '',
    name: rec?.name || '',
    phone: rec?.phone || '',
    business_name: rec?.business_name || '',
    customer_id: rec?.customer_id || '',
    subscription_id: subId,
    livemode: event.livemode,
  });
}

async function onInvoice(event, paid) {
  const inv = event.data.object;
  const { id: subId, metadata } = invoiceSubscription(inv);
  if (!subId) return; // a one-off Dashboard invoice — Stripe tracks it, nothing to sync
  const period = inv.lines?.data?.find((l) => l.period)?.period;
  const rec = await record(subId, {
    status: paid ? 'active' : 'past_due',
    tier: metadata.tier || undefined,
    client_id: metadata.client_id || undefined,
    customer_id: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id,
    current_period_end: period?.end ? new Date(period.end * 1000).toISOString() : undefined,
    last_invoice: inv.id,
  });
  if (!paid) {
    await notifyRouter({
      action: 'stripe_event',
      kind: 'payment_failed',
      client_id: rec?.client_id || '',
      business_name: rec?.business_name || '',
      email: inv.customer_email || rec?.email || '',
      amount: (inv.amount_due || 0) / 100,
      attempt: inv.attempt_count || 0,
      next_attempt: inv.next_payment_attempt ? new Date(inv.next_payment_attempt * 1000).toISOString() : '',
      invoice_url: inv.hosted_invoice_url || '',
    });
  }
}

async function onSubscription(event, deleted) {
  const sub = event.data.object;
  const prev = (await getBilling(`sub:${sub.id}`)) || {};
  const tier = monthlyTier(sub) || prev.tier || null;
  const rec = await record(sub.id, {
    status: deleted ? 'canceled' : sub.status,
    tier,
    client_id: sub.metadata?.client_id || prev.client_id || '',
    customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    cancel_at_period_end: !!sub.cancel_at_period_end,
  });
  const tierChanged = prev.tier && tier && prev.tier !== tier;
  const cancelNew = sub.cancel_at_period_end && !prev.cancel_at_period_end;
  if (deleted || tierChanged || cancelNew) {
    await notifyRouter({
      action: 'stripe_event',
      kind: deleted ? 'canceled' : tierChanged ? 'plan_changed' : 'cancel_scheduled',
      client_id: rec?.client_id || '',
      business_name: rec?.business_name || '',
      email: rec?.email || '',
      from_tier: prev.tier || '',
      tier: tier || '',
      subscription_id: sub.id,
    });
  }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const raw = await req.text(); // the raw body, byte for byte — signature checks fail on re-serialised JSON
  let event;
  try {
    event = verify(raw, req.headers.get('stripe-signature') || '');
  } catch (err) {
    console.warn('[stripe-webhook] rejected:', err.message);
    return new Response(`Webhook signature error: ${err.message}`, { status: 400 });
  }

  if (await seenEvent(event.id)) return ok({ duplicate: true });

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await onCheckoutCompleted(event);
        break;
      case 'invoice.paid':
        await onInvoice(event, true);
        break;
      case 'invoice.payment_failed':
        await onInvoice(event, false);
        break;
      case 'customer.subscription.updated':
        await onSubscription(event, false);
        break;
      case 'customer.subscription.deleted':
        await onSubscription(event, true);
        break;
      default:
        break;
    }
  } catch (err) {
    // Logged, not retried: replaying would only re-send notifications.
    console.error('[stripe-webhook]', event.type, event.id, err.message);
  }
  return ok();
};

export const config = { path: '/api/stripe-webhook' };
