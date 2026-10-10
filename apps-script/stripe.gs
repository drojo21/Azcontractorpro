/**
 * stripe.gs — action=stripe_event, posted by acp-backend's stripe-webhook.js.
 *
 * Stripe already handles the money and the customer-facing receipts. This is
 * only for you: a row in the Registry spreadsheet's "Payments" tab and an email
 * for the events worth knowing about the moment they happen.
 *
 *   kind=new_customer       someone bought a tier                 → email + row
 *   kind=payment_failed     a monthly charge failed               → email + row
 *   kind=plan_changed       upgraded/downgraded in the portal     → email + row
 *   kind=cancel_scheduled   will cancel at period end             → email + row
 *   kind=canceled           subscription ended                    → email + row
 *   kind=contractor_payment a homeowner paid a contractor client  → row only
 *
 * Script property STRIPE_ROUTER_KEY (recommended): set it to the same value as
 * ROUTER_KEY on the Netlify backend. The /exec URL is public, so without it
 * anyone could post a fake "new customer" email at you.
 */

var PAYMENT_COLUMNS = ['logged_at', 'kind', 'client_id', 'business_name', 'tier', 'amount',
                       'email', 'phone', 'detail', 'stripe_id'];

function handleStripeEvent(body) {
  var want = props().getProperty('STRIPE_ROUTER_KEY');
  if (want && String(body.router_key || '') !== want) return { ok: false, error: 'unauthorized' };

  var kind = clean(body.kind);
  var detail = '';
  if (kind === 'payment_failed') detail = 'attempt ' + clean(body.attempt) + (body.next_attempt ? ', retry ' + clean(body.next_attempt) : ', no more retries');
  if (kind === 'plan_changed') detail = clean(body.from_tier) + ' → ' + clean(body.tier);
  if (kind === 'contractor_payment') detail = clean(body.reference) + ' (' + clean(body.payment_status) + ')';

  var row = [nowIso(), kind, clean(body.client_id), clean(body.business_name || body.name),
             clean(body.tier_name || body.tier), body.amount || '', clean(body.email || body.payer_email),
             clean(body.phone), detail,
             clean(body.subscription_id || body.session_id || body.connected_account)];
  try {
    var ss = SpreadsheetApp.openById(props().getProperty('REGISTRY_ID'));
    var sheet = ss.getSheetByName('Payments');
    if (!sheet) {
      sheet = ss.insertSheet('Payments');
      sheet.appendRow(PAYMENT_COLUMNS);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, PAYMENT_COLUMNS.length).setFontWeight('bold');
    }
    sheet.appendRow(row);
  } catch (err) {
    console.error('payments sheet failed: ' + err);
  }

  var subjects = {
    new_customer: '💵 New ' + clean(body.tier_name || body.tier) + ' customer — ' + (clean(body.business_name || body.name) || clean(body.email)),
    payment_failed: '⚠️ Payment failed — ' + (clean(body.business_name) || clean(body.email) || clean(body.client_id)),
    plan_changed: 'Plan changed — ' + (clean(body.business_name) || clean(body.client_id)) + ' (' + detail + ')',
    cancel_scheduled: 'Cancellation scheduled — ' + (clean(body.business_name) || clean(body.email) || clean(body.client_id)),
    canceled: 'Subscription ended — ' + (clean(body.business_name) || clean(body.email) || clean(body.client_id))
  };
  var to = props().getProperty('ADMIN_EMAIL');
  if (to && subjects[kind]) {
    var lines = [
      'Business: ' + (clean(body.business_name || body.name) || '(not given)'),
      'Client:   ' + (clean(body.client_id) || '(bought from the sales site — no demo attached)'),
      'Tier:     ' + clean(body.tier_name || body.tier),
      'Amount:   ' + (body.amount ? '$' + Number(body.amount).toFixed(2) : ''),
      'Email:    ' + clean(body.email),
      'Phone:    ' + clean(body.phone),
      detail ? 'Detail:   ' + detail : '',
      body.invoice_url ? 'Invoice:  ' + clean(body.invoice_url) : '',
      '',
      kind === 'new_customer' && !body.client_id
        ? 'No client_id: create their client.json (scripts/new_client.py) and add the Stripe customer ' + clean(body.customer_id) + ' to your notes.'
        : '',
      kind === 'payment_failed' ? 'Stripe retries automatically and emails them a link to update their card. Nothing to do unless retries run out.' : '',
      '',
      'Stripe Dashboard: https://dashboard.stripe.com/' + (body.livemode === false ? 'test/' : '') + 'subscriptions/' + clean(body.subscription_id)
    ];
    try {
      MailApp.sendEmail({ to: to, subject: subjects[kind], body: lines.filter(function (l, i, a) {
        return l !== '' || (i > 0 && a[i - 1] !== '');
      }).join('\n'), name: 'AZ Contractor Pro' });
    } catch (err) {
      console.error('stripe notify failed: ' + err);
    }
  }
  return { ok: true };
}
