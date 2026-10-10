# Stripe — how money moves in AZ Contractor Pro

Two separate flows, one Stripe account (`acct_1UP2WkFIrmS5HqBY`, "Az Contractor Pro").

```
1. YOU GET PAID                                   2. YOUR CONTRACTORS GET PAID (the packet)
──────────────────                                ───────────────────────────────────────────
Buy button (demo site / sales site / email)       "Make a payment" form on the contractor's site
   │  /api/checkout?tier=pro&client=<id>             │  /api/pay?client=<id>&amount=…&ref=…
   ▼                                                 ▼
Stripe Checkout (hosted)                          Stripe Checkout on the CONTRACTOR's account
   setup fee today + monthly after 14 days           card or ACH bank debit (Financial Connections)
   │                                                 │  money → contractor's bank. Never touches yours.
   ▼                                                 ▼
/api/stripe-webhook → Blobs + client.billing      /api/stripe-webhook (Connect) → Payments sheet
   → Apps Script → Payments sheet + email to you
   │
Customer Portal (card, invoices, cancel)          Contractor's own Stripe Dashboard
https://billing.stripe.com/p/login/28EaEX2E97Yj8dV2OqdZ600   (invoices, refunds, payouts)
```

Design choices came from Stripe's integration planner: hosted Checkout, flat-rate tiers, pay up front, Customer Portal, Smart Retries for your billing; Connect as a **SaaS platform** for contractors — direct charges, Stripe collects processing fees from the contractor, **Stripe owns loss liability** (a contractor's chargeback can't hit your balance), full Stripe Dashboard for each contractor, Accounts v2.

## Already done (2026-10-10, live mode)

| What | Id / key |
|---|---|
| Products | `acp_starter`, `acp_pro`, `acp_kit` |
| Prices (lookup keys) | `acp_starter_setup` $497 · `acp_starter_monthly` $49/mo · `acp_pro_setup` $997 · `acp_pro_monthly` $99/mo · `acp_kit_setup` $1,997 · `acp_kit_monthly` $199/mo |
| Customer Portal | `bpc_1UP2mbFIrmS5HqBYoAbT43of` (default): update card, invoice history, edit contact info, cancel at period end. Plan switching is **off** — upgrades change the setup fee, so do those by hand. |
| Portal login link | https://billing.stripe.com/p/login/28EaEX2E97Yj8dV2OqdZ600 (on the sales-site footer and thank-you page) |

Change a price: edit `backend/stripe-setup.mjs` and run it. It moves the lookup key to the new price; existing subscribers keep theirs.

## One-time setup (≈20 min)

### 1. Netlify env vars — site `acp-backend-tucson`

Site configuration → Environment variables. Keys come from Stripe → Developers → API keys.

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…`. Better: a **restricted key** with write on Checkout Sessions, Customers, Connect (incl. `v2_account_storer_write`) and Account Links; read on Prices, Products, Subscriptions, Invoices. Never paste it in chat, the repo, or a site. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from step 2 (Your account endpoint) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `whsec_…` from step 2 (Connected accounts endpoint) |
| `ROUTER_KEY` | any long random string — same value as Apps Script `STRIPE_ROUTER_KEY` |
| `SALES_SITE_URL` | `https://azcontractorpro.net` |
| `MONTHLY_START_DELAY_DAYS` | `14` (default). Days between paying setup and the first monthly charge. `0` = first month charged at checkout. |
| `PLATFORM_FEE_BPS` | optional. Your cut of contractor payments in basis points (`50` = 0.5%). Unset = none. |
| `PLATFORM_FEE_CAP_CENTS` | optional, default `2500` ($25 max per payment) |

`LEAD_SHEET_URL`, `BUILDER_KEY` are already set and reused.

Redeploy the backend (push to `Main1` touching `backend/`, or Deploys → Trigger deploy) so `npm install` picks up the `stripe` package.

### 2. Webhooks — Stripe → Workbench → Webhooks → Add destination

Endpoint URL for both: `https://acp-backend-tucson.netlify.app/api/stripe-webhook`

- **Your account** — events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` → signing secret into `STRIPE_WEBHOOK_SECRET`
- **Connected accounts** — events: `checkout.session.completed`, `checkout.session.async_payment_succeeded` → signing secret into `STRIPE_CONNECT_WEBHOOK_SECRET`

### 3. Apps Script (the router project)

1. Add file `stripe.gs` (paste `apps-script/stripe.gs`), replace `router.gs` and `demo.gs` with the repo versions.
2. Script properties: `STRIPE_ROUTER_KEY` = the `ROUTER_KEY` value above. Remove the old `SQUARE_LINK_*` properties.
3. Deploy → Manage deployments → ✏️ → **New version** (never New deployment).

The Registry spreadsheet gets a **Payments** tab on the first event.

### 4. Stripe Dashboard settings (no code)

- **Billing → Revenue recovery**: Smart Retries on, "email customers about failed payments" on, card updater on. After all retries fail: cancel the subscription.
- **Settings → Business → Branding**: logo + `#F2A900` accent. Applies to Checkout, receipts, invoices, the portal.
- **Settings → Customer emails**: successful payments + refunds on.
- **Settings → Tax**: head-office address, then leave on free threshold monitoring. Website hosting may become taxable as you grow; Stripe alerts you.

### 5. Connect (the contractor packet)

1. Stripe → **Connect → Get started** → choose **SaaS platform** (businesses use your software to sell to their own customers). Fill in the platform profile.
2. **Settings → Connect → Branding**: name "AZ Contractor Pro", icon, color. Hosted onboarding won't open without it.
3. Accounts v2: if Connect asks, enable it under Settings → Early access.

Onboard a contractor (Luis Rojo's Masonry is the obvious first one):

```bash
curl -s -X POST https://acp-backend-tucson.netlify.app/api/connect-onboard \
  -H "x-builder-key: $BUILDER_KEY" -H "Content-Type: application/json" \
  -d '{"client_id":"luis-rojos-masonry-llc","email":"luisr@luisrojosmasonry.com"}'
# → { "account_id": "acct_…", "charges": "pending", "setup_url": "https://…/api/connect-onboard?t=…" }
```

Send them `setup_url` (it's in the packet guide too). It's signed, good for 60 days, and safe to click repeatedly — each click mints a fresh Stripe onboarding link. When they finish, Stripe sends them back to a "you're ready" page. Run the same POST again any time to refresh their status.

When `charges` is `active`, add this to their `client.json` and push:

```json
"payments": { "enabled": true }
```

Their site gets a **Make a payment** section (amount + invoice #/address → Stripe Checkout, card or ACH). Optional `"heading"` / `"note"` override the wording.

## Testing

Test mode and live mode have separate catalogs:

```bash
cd backend && npm install
STRIPE_SECRET_KEY=sk_test_… node stripe-setup.mjs     # creates the 6 test prices
node test-stripe.mjs                                   # offline tests, no key needed
```

Point a Netlify **deploy preview** (or `netlify dev`) at the test key and buy with `4242 4242 4242 4242`. For ACH, Checkout's test bank "Test Institution" succeeds instantly. Connect testing needs a **sandbox** (Accounts v2 doesn't run in plain test mode).

## Files

| File | Job |
|---|---|
| `backend/lib/stripe.js` | client, price lookup, Blobs billing store, signed setup links |
| `backend/netlify/functions/checkout.js` | `/api/checkout` — Buy button → Checkout |
| `backend/netlify/functions/stripe-webhook.js` | `/api/stripe-webhook` — records + notifications |
| `backend/netlify/functions/connect-onboard.js` | `/api/connect-onboard` — contractor Stripe setup |
| `backend/netlify/functions/pay.js` | `/api/pay` — contractor site "Make a payment" |
| `backend/stripe-setup.mjs` | create/confirm products + prices in any mode |
| `apps-script/stripe.gs` | Payments sheet + email for Stripe events |
| `docs/packet/stripe-payments-guide.md` | the contractor-facing guide for the packet |
