# Autopilot — from "type your ROC number" to "your site is live", nobody in the loop

Everything below runs on its own once the one-time setup at the bottom is done.
The only steps left for a person are the ones kept human on purpose (see
"What stays human").

```
azcontractorpro.net  hero work order
   │  1. ROC # typed → GET /api/roc  (instant "✓ Luis Rojo Masonry LLC · KB-2 · Tucson")
   │  2. Build → POST action=lead to the Apps Script router  → { id }
   ▼
router (demo.gs) ── Demos row, GitHub repository_dispatch ──► deploy.yml builds + publishes the demo
   │                                                            │ success → demo_ready (email + Registry row, status=demo)
   │                                                            │ failure → demo_failed (honest note to prospect + reason to you)
   │  3. page polls GET action=demo_status&id=… every 5 s → "Your site is live" + Keep-it buttons
   ▼
runAutopilot() hourly  ── follow-ups at day 1, 3, 7, 14 until they buy or unsubscribe
   │
Keep it → /api/checkout → Stripe Checkout
   ▼
stripe-webhook.js  checkout.session.completed
   │  • promoteInRepo(): one commit to clients/<id>/client.json on Main1
   │    (paid tier, demo banner + noindex off) → deploy.yml republishes it as the paid site
   │  • router stripe_event new_customer → autopilotOnPaid():
   │    Demos row = paid (follow-ups stop), Registry status = active,
   │    Onboarding row, "finish your 3-minute setup" email with the setup link
   ▼
azcontractorpro.net/thanks.html?session_id=…  (the self-serve setup sheet)
   │  GET  /api/onboard → prefilled answers
   │  POST /api/onboard → validated → ONE commit to clients/<id>/client.json on Main1
   │        (services, cities, hours, phone, lead email, domain, …)
   │        straight-to-checkout buyers: built from their ROC # through the same licence gate
   │  router action=onboarded → leads re-pointed at the buyer, Drive provisioned (Pro/Kit)
   ▼
deploy.yml  build → publish (deploy.js also sets their custom domain on the Netlify site)
   │  live_notify.py → router action=site_live → "your site is live" + DNS records + photo folder
   ▼
runAutopilot() hourly  ── "finish your setup" reminders at day 1, 3, 7 for anyone who paid but didn't
```

Typical timings: demo live ≈ 3 minutes after Build; paid site rebuilt ≈ 3–4 minutes
after checkout or after the setup form.

## What changed, file by file

| File | What it does now |
|---|---|
| `backend/netlify/functions/roc.js` | `GET /api/roc?n=…` — instant licence check for the sales page, same gate as the build |
| `backend/netlify/functions/onboard.js` | `GET/POST /api/onboard` — the setup sheet behind `thanks.html` |
| `backend/lib/autopilot.js` | pure record changes: `promote`, `sanitizeOnboarding`, `applyOnboarding`, DNS steps |
| `backend/lib/github.js`, `lib/promote.js` | one-file commits to the default branch, compare-and-swap with retry |
| `backend/netlify/functions/stripe-webhook.js` | promotes the demo on payment; sends the setup link to the router |
| `backend/netlify/functions/deploy.js` | sets the client's custom domain on their Netlify site (never replaces one) and returns the `*.netlify.app` address |
| `scripts/publish.py` | records `netlify_subdomain`; finishes "one page first" Pro/Kit sites (see below) |
| `scripts/live_notify.py`, `scripts/demo_failed.py` | tell the router a paid site went live / a demo build failed |
| `.github/workflows/deploy.yml` | runs both of the above; rebases and retries its results commit |
| `apps-script/autopilot.gs` | new router actions, follow-ups, setup reminders, unsubscribe, emails |
| `apps-script/router.gs`, `demo.gs`, `stripe.gs` | hook the above in; demo sites now get a Registry row |

**Bug fixed on the way:** demo sites' quote forms answered `unknown client_id`, because
nothing added a Registry row for a demo. The demo email says the form "works right now".
`handleDemoReady` now registers the demo (`status=demo`): quote requests go to the
prospect, with a "keep the site" line, and you get a blind copy — a real lead arriving on
a demo is the best sales moment there is.

**One page first.** A brand-new Pro/Kit buyer (no demo) has no web address until their
first publish, and a `tier=full` record needs one for its canonical tags. `/api/onboard`
writes those as `tier=lite` with `onboarding.full_pending`; `publish.py` flips them to
`full` the moment Netlify returns the address and publishes again in the same run.

## One-time setup (≈15 minutes)

### 1. Netlify — site `acp-backend-tucson` → Environment variables

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT on `drojo21/Azcontractorpro`, **Contents: Read and write**. The admin console already uses this name; if it's set, nothing to do. |
| `GITHUB_REPO` | `drojo21/Azcontractorpro` (the default) |

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ROUTER_KEY`, `LEAD_SHEET_URL`,
`SALES_SITE_URL`, `NETLIFY_TOKEN` are already set and reused. Merging to `Main1`
redeploys the backend with the two new functions.

### 2. Apps Script — the router project

1. Add a file **autopilot.gs** and paste `apps-script/autopilot.gs`.
2. Replace **router.gs**, **demo.gs** and **stripe.gs** with the repo versions.
3. **Project Settings → Script properties**, add:

   | Property | Value |
   |---|---|
   | `MAILING_ADDRESS` | Your postal address for the email footer (CAN-SPAM). Without it, follow-ups stay paused and you get one reminder a day. |
   | `SIGNATURE` | optional — how follow-ups are signed. Default `Daniel Rojo · AZ Contractor Pro` |

4. Run **`installAutopilot()`** once from the editor (creates the hourly trigger, adds the
   new Demos columns, creates the Onboarding tab). Approve the trigger permission.
5. **Deploy → Manage deployments → ✏️ → Version: New version.** Never "New deployment" —
   that mints a new `/exec` URL and every site keeps posting to the old one.

Check: `<exec URL>?action=health` → `{"ok":true,"version":"1.3"}`.

### 3. Sales site

Merge the `v2-autopilot` PR in `drojo21/azcontractorprowebsite`; Netlify publishes
azcontractorpro.net from `main`.

### 4. Nothing else

No new GitHub secrets (`APPS_SCRIPT_SECRET` and `BUILDER_KEY` are reused), no Stripe
changes (Checkout already returns buyers to `/thanks.html?session_id=…`).

## Testing it end to end

1. On azcontractorpro.net, type a ROC number from `data/buildable-tucson.csv` and your own
   email. Watch the work order: about three minutes to "Your site is live".
2. Submit a quote request on that demo site: it arrives at your test email, and the
   owner copy lands in `ADMIN_EMAIL`.
3. Point a Netlify deploy preview of the backend at a **test** Stripe key, buy with
   `4242 4242 4242 4242`. Test-mode purchases email the setup link to `ADMIN_EMAIL`, never
   to the address typed at checkout.
4. Fill the setup sheet. The commit shows up on `Main1` as
   `Update … from self-serve setup [autopilot]`; a few minutes later the "site is live"
   email arrives with DNS steps if you gave a domain.
5. Run `runAutopilot()` from the editor between 7am and 6pm Arizona time to force a
   follow-up pass (it only sends what is due).

Offline tests:

```bash
cd backend && npm install
node --experimental-test-module-mocks test-autopilot.mjs   # roc, onboard, promotion, domains
node apps-script/test/run-tests.mjs                          # router: status, failures, follow-ups, setup, live
```

## What stays human, on purpose

* **Publishing customer photos.** The photo folder is shared with the buyer automatically;
  `publishPhotos()` stays a reviewed step so a photo of a contract can't go public.
* **Refreshing the ROC active list** (`data/roc-active.csv.gz`, then
  `scripts/build_roc_index.py`). It backs every licensure claim, so replacing it stays
  deliberate. **Do it at least monthly**: newly licensed contractors are the market, and
  anyone licensed after the snapshot date gets "we'll build it by hand" instead of a
  three-minute demo. The snapshot in this repo is dated 2026-09-08.
* **A demo that fails** (licence not on the list, ambiguous name, crash): the prospect gets
  an honest note and you get the reason. Those are the leads to call.
* **"Need a domain"** buyers: the setup sheet tells them to buy one and come back to the
  same link; the autopilot connects it when they do.

## Where to look when something looks off

| Symptom | Look at |
|---|---|
| Work order spins past 9 minutes | Actions run for that dispatch; Demos tab `status`/`notes` |
| Paid demo still shows the demo banner | `new_customer` email "Upgrade:" line; `GITHUB_TOKEN` on the backend |
| Setup sheet says "couldn't open" | backend function log for `onboard`; the session's payment status in Stripe |
| No "site is live" email | Actions log step "Notify paying customers"; Onboarding tab row |
| Follow-ups not sending | `MAILING_ADDRESS` set? trigger installed? `AUTOPILOT_OFF` not `true`? |
