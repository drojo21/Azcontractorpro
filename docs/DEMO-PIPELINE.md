# Free-demo pipeline (azcontractorpro.com → live site → email with checkout)

```
azcontractorpro.com  "Build my free demo site" form
        │  action=lead, client_id=azcontractorpro (+ business, roc, city, service)
        ▼
Apps Script router (router.gs → demo.gs)
        │  logs lead + Demos row, emails you,
        │  POST github.com/repos/<repo>/dispatches  event=demo-request
        ▼
GitHub Actions deploy.yml (repository_dispatch)
        │  scripts/demo_request.py  → clients/<id>/client.json  (tier=lite, deploy.demo=true)
        │  build_all.py --only <id> → demo banner + "Keep this site" + 3 checkout buttons + noindex
        │  publish.py               → backend /api/deploy → Netlify site + claim link
        │  commit results           → client.json gets netlify_url / claim_url
        │  scripts/demo_notify.py   → POST action=demo_ready (+secret) to the router
        ▼
Apps Script handleDemoReady()
        │  matches the Demos row, emails the prospect:
        │  live link + Starter / Pro / Kit buttons (Square links) + claim link
        ▼
Prospect buys through Square, or replies. You call them.
```

Typical latency: form → email in about 2–3 minutes (Actions spin-up + Netlify CDN).

## One-time setup

### 1. Apps Script (script.google.com, the existing router project)

1. Add a new file `demo.gs` and paste `apps-script/demo.gs`. Replace `router.gs` with the updated one.
2. **Project Settings → Script properties**, add:

   | Property | Value |
   |---|---|
   | `GITHUB_TOKEN` | Fine-grained PAT on `drojo21/Azcontractorpro` with **Contents: Read and write** (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained) |
   | `GITHUB_REPO` | `drojo21/Azcontractorpro` |
   | `DEMO_SECRET` | any long random string (same value goes into GitHub secret `APPS_SCRIPT_SECRET`) |
   | `SQUARE_LINK_STARTER` / `SQUARE_LINK_PRO` / `SQUARE_LINK_KIT` | Square payment links (leave blank until you have them — buttons fall back to azcontractorpro.com/#pricing) |
   | `SALES_SITE_URL` | `https://azcontractorpro.com` |

3. **Registry tab** — add a row: `client_id = azcontractorpro`, `business_name = AZ Contractor Pro`, `notification_email = <your email>`, `status = active`. Then run `flushRegistryCache()` once.
4. Run `setupDemos()` once from the editor (creates the Demos tab). Optionally run `testDemoEmail()` to see the prospect email in your own inbox.
5. **Deploy → Manage deployments → Edit → Version: New** so the running web app picks up the new code. The `/exec` URL does not change.

### 2. GitHub

1. Push this branch / merge to `main`.
2. **Settings → Secrets and variables → Actions**: add `APPS_SCRIPT_SECRET` = the same value as `DEMO_SECRET` above. (`BUILDER_KEY` and `GOOGLE_SERVICE_ACCOUNT_JSON` already exist.)
3. The workflow already has `permissions: contents: write`; nothing else to enable.

### 3. Square links (when ready)

Put the three payment links in `config/acp.json → square_links` (so demo sites get real Buy buttons) **and** in the Script properties above (so emails do). Commit + push; existing demos get the buttons the next time they rebuild.

### 4. Sales site

`sales/` holds the azcontractorpro.com homepage (single file, form already pointed at the router). It is deployed as the Netlify project `azcontractorpro`. To redeploy after edits, drag the folder onto Netlify or link the project to this repo with base directory `sales`.

## Testing without a real prospect

Submit the form on azcontractorpro.com with your own email and a ROC number from `data/buildable-tucson.csv`. Watch: Demos tab → `building`, Actions run, then `emailed` and the email arrives.

Or trigger the build by hand, skipping the form:

```bash
gh api repos/drojo21/Azcontractorpro/dispatches -f event_type=demo-request \
  -F 'client_payload[name]=Test' -F 'client_payload[business]=Test Concrete LLC' \
  -F 'client_payload[roc]=' -F 'client_payload[service]=Concrete' \
  -F 'client_payload[city]=Tucson' -F 'client_payload[email]=you@example.com'
```

(Without a matching Demos row the `demo_ready` step logs "no matching demo request" — expected.)

## Safety rails built in

* A demo never overwrites a real client: `demo_request.py` refuses if a non-demo `client.json` exists for that id **or** that ROC number.
* Demo pages carry `noindex` so a prospect's temporary URL never competes with the real site later.
* `demo_ready` only emails addresses the router captured itself; the workflow never sends an email address, and the call is gated by `DEMO_SECRET`.
* Publish still goes through the backend's ROC-status gate; a non-Active licence is refused.
* **A demo is only built when a real ROC number can be cited.** Every built page asserts
  "Licensed · Bonded · Insured", carries a ROC credential in its JSON-LD and links to an
  azroc.gov verify URL, so the licence has to be real. `demo_request.py` resolves the
  request against `data/*.csv` by ROC number first, then by business name; if neither
  resolves and the prospect gave no ROC number, the request is **refused** rather than
  built with an invented licence. The lead is already captured either way — it just
  becomes a follow-up by hand.
* Rebuilding a demo (same business submits twice) reuses the same Netlify site, so the link in the first email keeps working.

## Converting a demo to a paying client

Set `tier` to `full` (and drop `deploy.demo`) in the client's JSON, fill in email / site_url / license_class, push. Same Netlify site, same claim link. Then `provisionClient(...)` in Apps Script as before.
