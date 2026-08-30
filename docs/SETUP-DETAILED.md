# AZ Contractor Pro — Detailed Setup Guide

Expanded version of `RUNBOOK.md`. Every click, every value, what you should see, and what to do when you don't.

Work through phases in order. Each ends with a **CHECK** — if it fails, fix it before moving on.

**Everything runs under acered73@gmail.com.** Before you start, open an incognito window, sign into that account only, and do all of this there. Mixed Google sessions are the most common cause of "it worked yesterday" problems.

---
---

# PHASE 0 — Prerequisites

**Time:** 10 minutes

### 0.1 Confirm your Google account

1. Open a new incognito/private browser window.
2. Go to `drive.google.com`.
3. Sign in as **acered73@gmail.com**.
4. Click your avatar, top right. Confirm it says `acered73@gmail.com` and **no other account is listed**.

Keep this window open. Use it for Phases 1, 2, and 3.

### 0.2 Generate your two secrets

Open a terminal:

```bash
openssl rand -hex 32
```

Run it **twice**. Label the outputs:

```
ACP_ADMIN_KEY    = <first output>
ACP_CLAIM_SECRET = <second output>
```

Paste both into a password manager or a local note now. You'll need them in Phase 4, and Netlify won't show them back to you after entry.

> Don't reuse one value for both. The admin key gates publishing; the claim secret signs contractor links. If one leaks, you want the other still holding.

### 0.3 Get a Netlify token

1. Go to `app.netlify.com`.
2. Avatar (top right) → **User settings**.
3. Left sidebar → **Applications**.
4. Under *Personal access tokens* → **New access token**.
5. Description: `acp-backend deploy`. Expiration: your call — 1 year is reasonable.
6. **Generate token** → copy it immediately. It's shown once.

```
NETLIFY_API_TOKEN = <the token>
```

### 0.4 Know your email ceiling

acered73@gmail.com is consumer Gmail, so Apps Script sends a maximum of **100 emails per day** (Google Workspace accounts get 1,500).

That's fine for a pilot. At 186 live sites, a busy day could hit it. Leads are always written to the spreadsheet *before* the email is attempted, so hitting the cap costs you notifications, not leads — but plan to move to Workspace before you scale.

**✅ CHECK 0:** You have four values written down — `ACP_ADMIN_KEY`, `ACP_CLAIM_SECRET`, `NETLIFY_API_TOKEN`, and confirmation you're signed in as acered73@gmail.com.

---
---

# PHASE 1 — The lead router

**Time:** 30 minutes
**Why first:** Publishing a site whose form goes nowhere is worse than publishing nothing. The contractor gets a lead, loses it, and never tells you.

### 1.1 Create the Registry spreadsheet

1. In your incognito window, go to `sheets.google.com`.
2. Click **Blank spreadsheet**.
3. Click "Untitled spreadsheet" top-left, rename to: `ACP Registry`
4. Look at the URL:
   ```
   https://docs.google.com/spreadsheets/d/1AbC...XyZ/edit
                                          ^^^^^^^^^^^ this part
   ```
5. Copy that ID into your notes as `REGISTRY_ID`.

### 1.2 Create the Apps Script project

1. Go to `script.google.com`.
2. Click **New project** (top left).
3. Click "Untitled project" at the top, rename to: `ACP Router`

### 1.3 Add the script files

You're adding **three** files. `lead-form.js` does **not** go here — it runs in the visitor's browser, not on Google's servers.

1. The editor opens with `Code.gs`. Select all its contents and delete them.
2. Paste the entire contents of **`router.gs`**.
3. In the left **Files** panel, click **+** → **Script**. Name it `provision` (Apps Script adds `.gs`).
4. Delete the placeholder function, paste all of **`provision.gs`**.
5. **+** → **Script** again. Name it `photos`. Paste all of **`photos.gs`**.
6. Press **Ctrl/Cmd + S**.

You should now see three files: `Code.gs`, `provision.gs`, `photos.gs`.

### 1.4 Enable the Advanced Drive Service

Without this, sharing without an email notification fails.

1. Left sidebar, find **Services**. Click the **+**.
2. Scroll the list to **Drive API**.
3. Leave the identifier as `Drive`.
4. Click **Add**.

**Verify:** "Drive" now appears under Services in the sidebar.

### 1.5 Set Script Properties

1. Left sidebar → **⚙ Project Settings**.
2. Scroll to **Script Properties** → **Add script property**.
3. Add these two:

| Property | Value |
|---|---|
| `REGISTRY_ID` | the ID from step 1.1 |
| `ADMIN_EMAIL` | `acered73@gmail.com` |

4. Click **Save script properties**.

> Optional third property: `DRIVE_ROOT_ID`, set to a folder ID, if you want client folders kept out of My Drive root. Skip it for now — Luis's folder already exists at root.

### 1.6 Initialize the Registry

1. Left sidebar → **< > Editor**.
2. Open `Code.gs`.
3. In the function dropdown at the top (it probably says `doPost`), select **`setupRegistry`**.
4. Click **▶ Run**.

**The OAuth prompt.** First run triggers authorization:

1. **Review permissions**
2. Choose **acered73@gmail.com**
3. You'll see *"Google hasn't verified this app."* This is your own script — expected.
4. Click **Advanced** (small link, bottom left)
5. Click **Go to ACP Router (unsafe)**
6. Review the permission list → **Allow**

**Verify:** the execution log at the bottom shows `Execution completed`. Open your Registry spreadsheet — there's now a **Registry** tab with bold headers: `client_id`, `business_name`, `notification_email`, `leads_sheet_id`, `drive_folder_id`, `portal_pin`, `status`.

### 1.7 Deploy as a web app

**Read this carefully — the settings matter and are easy to get wrong.**

1. Top right → **Deploy** → **New deployment**.
2. Next to "Select type", click the **⚙ gear** → **Web app**.
3. Fill in:
   - **Description:** `v1 initial`
   - **Execute as:** **Me (acered73@gmail.com)**
   - **Who has access:** **Anyone**
4. ⚠️ "Who has access" must be **Anyone** — *not* "Anyone with a Google account". Website visitors aren't signed into Google. The wrong setting sends every visitor to a login page instead of submitting their lead.
5. Click **Deploy**.
6. Copy the **Web app URL**. It ends in `/exec`.

Save it as `EXEC_URL`.

**✅ CHECK 1:** Paste this into a browser tab:

```
<EXEC_URL>?action=health
```

You want:
```json
{"ok":true,"version":"1.0","time":"2026-..."}
```

| What you see instead | Cause | Fix |
|---|---|---|
| A Google sign-in page | "Who has access" is wrong | Manage deployments → edit → set to **Anyone** |
| `Script function not found` | `router.gs` didn't paste fully | Re-paste, save, redeploy as new version |
| Authorization error | Step 1.6 not completed | Run `setupRegistry` again and approve |

---
---

# PHASE 2 — Provision Luis Rojo

**Time:** 10 minutes

The folders already exist in your Drive. This formats the sheet, shares it correctly, and fills in the Registry.

### 2.1 Run provisioning

1. In the Apps Script editor, open **`provision.gs`**.
2. Scroll to the bottom, to `provisionOne()`.
3. Replace it with:

```js
function provisionOne() {
  return provisionClient({
    clientId:     'luis-rojos-masonry-llc',
    businessName: "Luis Rojo's Masonry LLC",
    clientEmail:  'luisr@luisrojosmasonry.com',
    role:         'writer',
    notify:       false
  });
}
```

4. **Ctrl/Cmd + S**.
5. Function dropdown → **`provisionOne`** → **▶ Run**.
6. A second OAuth prompt appears (this needs Drive scopes). Approve it the same way.

> **If you see `Error: Registry tab not found`:** you're on an older `provision.gs`. The current one creates the tab on demand. Either re-paste it, or run `setupRegistry` from `Code.gs` first. Also confirm `REGISTRY_ID` points at the **ACP Registry** spreadsheet and not at a leads sheet — a valid ID for the wrong spreadsheet gives this same error.

**What it does:** finds the existing `Luis Rojo's Masonry LLC` folder rather than creating a duplicate, formats the leads sheet (bold headers, frozen row, hidden plumbing columns, Status dropdown), adds Luis as a writer **without sending him an email**, sets `setShareableByEditors(false)` so he can't forward the sheet on, and writes the Registry row.

**Verify:** the execution log prints JSON containing `"ok": true` and a `leads_sheet` URL. Open your Registry spreadsheet — row 2 is populated.

### 2.2 Create photo categories

1. In `photos.gs`, add this function at the bottom:

```js
function setupLuisPhotos() {
  return setupPhotoFolders(
    'luis-rojos-masonry-llc',
    ['Paver Driveways', 'Block Walls', 'Stamped Concrete', 'Outdoor Living'],
    'luisr@luisrojosmasonry.com'
  );
}
```

2. Save, select `setupLuisPhotos`, **▶ Run**.

**Verify:** open `Luis Rojo's Masonry LLC/Website-photos` in Drive. Four subfolders exist.

### 2.3 Finish the Registry row

Open the Registry spreadsheet and fill the two columns provisioning doesn't set:

| Column | Value |
|---|---|
| `portal_pin` | any 4–6 digits, e.g. `4821` |
| `status` | `active` |

Also confirm `notification_email` is `luisr@luisrojosmasonry.com`.

Then, back in Apps Script, run **`flushRegistryCache`** — Registry reads are cached for 5 minutes and your edit won't take effect until you do.

**✅ CHECK 2:** Run **`auditSharing`**, then **View → Execution log**.

Every line should read `[OK] luis-rojos-masonry-llc — shared with luisr@luisrojosmasonry.com`.

| Line you see | Meaning | Fix |
|---|---|---|
| `[HIGH] no leads_sheet_id` | Leads are still going to the shared Registry | Re-run `provisionOne` |
| `[HIGH] link sharing is ANYONE_WITH_LINK` | The sheet is publicly readable | Re-run `provisionOne`; it calls `lockDown()` |
| `[REVIEW] shared with <someone else>` | Wrong recipient | `revokeClient('luis-rojos-masonry-llc', '<that email>')` |

---
---

# PHASE 3 — Prove a lead actually arrives

**Time:** 15 minutes
**Do not skip this.** This is the bug you're fixing. Assuming it works is how it stayed broken.

### 3.1 Build the test page

1. Make a folder on your desktop called `acp-test`.
2. Copy **`lead-form.js`** into it.
3. Create `test-lead.html` in the same folder:

```html
<!doctype html>
<meta charset="utf-8">
<title>Lead test</title>
<style>
  body { font: 16px system-ui; max-width: 420px; margin: 40px auto; }
  input, textarea, button { display:block; width:100%; margin:8px 0; padding:8px; }
  .acp-hp { position:absolute; left:-9999px; width:1px; height:1px; }
  [data-state="success"] { color: green; }
  [data-state="error"]   { color: crimson; }
</style>

<h1>Lead capture test</h1>

<form data-acp-lead
      data-endpoint="PASTE_YOUR_EXEC_URL_HERE"
      data-client-id="luis-rojos-masonry-llc">
  <input name="name" placeholder="Your name" required>
  <input name="phone" placeholder="Phone" type="tel">
  <input name="email" placeholder="Email" type="email">
  <input name="service" placeholder="Service needed">
  <textarea name="message" placeholder="Tell us about the project"></textarea>
  <input name="company_website" class="acp-hp" tabindex="-1"
         autocomplete="off" aria-hidden="true">
  <button type="submit">Request a Free Estimate</button>
  <p data-acp-status role="status" aria-live="polite"></p>
</form>

<script src="lead-form.js"></script>
```

4. Replace `PASTE_YOUR_EXEC_URL_HERE` with your `EXEC_URL` from step 1.7.
5. Double-click `test-lead.html` to open it.

### 3.2 Submit a test lead

Fill in a plausible name and phone, then submit. You should see *"Thanks — we got it. We'll be in touch shortly."*

### 3.3 Verify all three

**a) The row lands.** Open the Leads spreadsheet. Within a few seconds a row appears with your test data. Timestamp populated, `client_id` = `luis-rojos-masonry-llc`.

**b) The email arrives.** Check `luisr@luisrojosmasonry.com`… actually, for the test, temporarily set `notification_email` in the Registry to your own address, run `flushRegistryCache`, and resubmit. You don't want test leads hitting your client's inbox. Set it back afterward.

**c) Duplicates collapse.** Submit the exact same values again immediately. **One** row total, not two. That's the 10-minute dedupe window working.

### 3.4 Test the honeypot

In DevTools console:

```js
document.querySelector('[name=company_website]').value = 'spam';
document.querySelector('form').requestSubmit();
```

You'll see the success message, but **no new row appears**. Correct — bots get told everything's fine so they don't retry with a different shape.

**✅ CHECK 3:** Row lands, email arrives, duplicates collapse, honeypot silently drops.

### Troubleshooting

Open DevTools → **Network** tab, submit, click the request.

| Symptom | Cause | Fix |
|---|---|---|
| CORS error in console | Content-Type isn't `text/plain` | **This is the silent-lead-loss bug.** Something changed the header in `lead-form.js`. Put it back. |
| `{"ok":false,"error":"unknown client_id"}` | Registry row missing, or cache stale | Check spelling, run `flushRegistryCache` |
| Redirected to accounts.google.com | Deployment access setting | Manage deployments → **Anyone** |
| Row lands, no email | Mail quota, or blank `notification_email` | Check the Apps Script execution log |

---
---

# PHASE 4 — The backend

**Time:** 20 minutes

### 4.1 Deploy

**Option A — Netlify CLI:**

```bash
cd acp-backend
npm install
npx netlify-cli login
npx netlify-cli sites:create --name acp-backend
npx netlify-cli deploy --prod
```

**Option B — Git:** push `acp-backend/` to a repo, then in Netlify: **Add new site → Import an existing project**, pick the repo, accept the settings from `netlify.toml`, deploy.

### 4.2 Set environment variables

1. Netlify → your site → **Site configuration** → **Environment variables**.
2. **Add a variable** → *Add a single variable*, four times:

| Key | Value |
|---|---|
| `NETLIFY_API_TOKEN` | from 0.3 |
| `ACP_ADMIN_KEY` | from 0.2 |
| `ACP_CLAIM_SECRET` | from 0.2 |
| `ACP_SITE_PREFIX` | `acp` |

3. ⚠️ **Redeploy.** Env vars don't apply to an existing build: **Deploys → Trigger deploy → Deploy site**.

### 4.3 Verify

```bash
curl https://<your-backend>.netlify.app/api/health
```
Expect:
```json
{"ok":true,"trades":30,"schema":"1.0"}
```

```bash
curl -s https://<your-backend>.netlify.app/api/trade-defaults | head -c 120
```
Expect JSON starting with `{"_meta":`.

Auth is enforced:
```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://<your-backend>.netlify.app/api/publish
```
Expect `401`.

### 4.4 Run the local suite

No real Netlify calls, no sites created:

```bash
cd acp-backend
node --experimental-test-module-mocks test-api.mjs
```

Expect `PASS — 24/24`.

**✅ CHECK 4:** health returns 30 trades, publish without a key returns 401, local suite passes.

| Problem | Fix |
|---|---|
| `missing env: NETLIFY_API_TOKEN` | Var not set, or you didn't redeploy after adding |
| `Cannot find package '@netlify/blobs'` | Run `npm install`, commit `package.json` |
| 404 on `/api/health` | Confirm `netlify/functions/api.js` deployed; check the function log |

---
---

# PHASE 5 — First site ⛔ BLOCKED

**Blocked on three files I haven't seen:**

- `contractor-site-builder.html`
- the `Acp-backend` repo
- the `site-builder/` folder — `build_site.py`, templates, `check_build.py`

I can write all three from scratch, but that discards roughly 24 fixes from your two audit rounds — the multi-client folder collision and the empty-feed crash that deletes local photos being the ones you'd hit first. Merging is the right move.

**Once uploaded, this is the sequence:**

1. Drop `acp_schema.py`, `trade_defaults.json` into `site-builder/`.
2. Delete `TRADE_THEME`, `shade()`, `tel()`, `resolve_theme()` from `build_site.py` — they live in `acp_schema` now.
3. Add `--tier {lite,full}`: `lite` renders `index.html` only from the existing home template; `full` renders all 18 pages.
4. Point the quote form at `integrations.lead_endpoint` and include `lead-form.js`.
5. Build Luis's site from `example-client-luis-rojo.json`.
6. `POST /api/publish` with `{client, files}` and the `x-acp-key` header.

---
---

# PHASE 6 — One contractor, end to end

**Time:** 30 minutes. Do this before any volume.

- [ ] **Publish.** `POST /api/publish` for Luis at `tier: lite`. Record the returned `url` and `site_id`.
- [ ] **Open the site.** Every section renders. Phone number correct. ROC number correct.
- [ ] **Claim link.** Open the `claim_url` from the response. It shows his business name and the site URL.
- [ ] **Live lead.** Submit the quote form *on the published site*, not the test page. Row lands, email arrives.
- [ ] **Photos.** Drop 3 images into `Website-photos/Paver Driveways`, run `publishPhotos('luis-rojos-masonry-llc')`, reload the site. They appear.
- [ ] **Photo audit.** Run `auditPhotos()`. Nothing unexpected is public.
- [ ] **The upgrade test.** Republish with `tier: "full"`. **The URL must be identical.** Response shows `"reused_site": true`.

That last one is the whole point of the merge. If the URL changes, the site-ID store isn't being read, and every claim link you've sent is dead.

---
---

# PHASE 7 — Refresh data, then scale

### 7.1 Re-run the ROC lookup

Your sheet is from 2025-12-30 — about eight months old. Licenses lapse, businesses fold, and some of these now have websites.

1. Re-run your lookup to produce a fresh `ROC Results` tab.
2. Process it:
```bash
python3 roc_results.py fresh.xlsx --sheet "ROC Results" --out ./fresh \
  --metro "Tucson,Oro Valley,Marana,Vail,Sahuarita,Green Valley,Catalina,Corona De Tucson"
```
3. Compare against December:
```bash
python3 - <<'EOF'
import json
old = {c['client_id']: c for c in json.load(open('./out/ready.json'))}
new = {c['client_id']: c for c in json.load(open('./fresh/ready.json'))}
print("gone:   ", len(set(old) - set(new)))
print("new:    ", len(set(new) - set(old)))
print("changed:", sum(1 for k in set(old) & set(new)
                      if old[k]['trade'] != new[k]['trade']))
EOF
```

### 7.2 Spot-check before volume

Call 20 at random. You're checking three things: the number connects, they don't already have a website, and the trade classification matches what they actually do. If more than a couple fail, fix the data before building 186 sites.

### 7.3 Set up the photo trigger

1. Apps Script → left sidebar → **⏰ Triggers** → **+ Add Trigger**.
2. Function: `publishPhotosAll`. Event source: **Time-driven** → **Day timer** → **4am to 5am**.
3. Save.

### 7.4 Pre-campaign checklist

- [ ] `auditSharing()` — every line `[OK]`
- [ ] `auditPhotos()` — nothing unexpected public
- [ ] Test lead from a live site works
- [ ] `notification_email` is the *client's* address, not yours
- [ ] Outreach plan reviewed — see below

### 7.5 One thing to sort out before the first send

Cold **email** is legal under CAN-SPAM provided you include a physical mailing address, an honest subject line, and a working opt-out you honor within 10 days.

Cold **texting** those scraped numbers is a different regime. TCPA carries per-message statutory damages and it's actively litigated. Many of these ROC numbers are mobile. If texting is part of the plan, get a definitive answer before volume rather than after — I'm not the right source for that call, but it's much cheaper to ask now.

---
---

# Reference: things that will bite you

**Re-deploying Apps Script.** Editing code does *not* update the live web app. Use **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy**. Clicking "New deployment" creates a **different URL**, and every published site keeps posting to the old code. This is the mistake most likely to cost you a day.

**Registry cache.** Edits take 5 minutes to apply. Run `flushRegistryCache()` after any change.

**Never share the Registry spreadsheet.** It holds every client. Each contractor gets their own sheet — that's what Phase 2 sets up.

**Never make `Website-photos` link-viewable.** The contractor has write access. Publishing is per-file through `publishPhotos()` precisely so a dropped contract doesn't become public.

**Keep `Content-Type: text/plain`** in `lead-form.js`. Apps Script doesn't answer CORS preflight. Changing it to `application/json` loses leads silently while showing visitors a success message.

**Don't swap the photo URLs.** The manifest uses `=w600` / `=w1600` resized variants, which are re-encoded and drop EXIF. Direct file URLs return original bytes — including the GPS coordinates of your contractor's customers' homes.
