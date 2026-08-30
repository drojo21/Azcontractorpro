# AZ Contractor Pro — Setup Runbook

Do these in order. Each phase ends with a check — if the check fails, stop there rather than continuing, because everything downstream depends on it.

Everything runs under **acered73@gmail.com**. Using a different account for Apps Script than for Drive is the single most common way this breaks.

---

## Phase 0 — Before you start (10 min)

- [ ] Confirm you're signed into Google as **acered73@gmail.com** in the browser you'll use throughout.
- [ ] Netlify account with the `acp-backend` site (or ability to create one).
- [ ] Generate two secrets and put them somewhere safe:
  ```bash
  openssl rand -hex 32    # ACP_ADMIN_KEY
  openssl rand -hex 32    # ACP_CLAIM_SECRET
  ```
- [ ] Netlify personal access token: **User settings → Applications → New access token**.

**Note:** acered73@gmail.com is consumer Gmail, so lead-notification emails cap at **100/day** (Workspace is 1,500). Fine for a pilot. Worth revisiting before 186 sites are live.

---

## Phase 1 — The lead router (30 min)

Nothing gets published until leads land somewhere.

1. **Create the Registry spreadsheet.** New Google Sheet, name it `ACP Registry`. Copy the ID from the URL — the part between `/d/` and `/edit`.

2. **Create the Apps Script project.** Go to [script.google.com](https://script.google.com) → **New project** → rename it `ACP Router`.

3. **Add the four files.** Paste `router.gs` over the default `Code.gs`, then **+ → Script** three times for `provision.gs`, `photos.gs`, and `lead-form.js` (paste that last one as a script file — it's served to sites, not run here; or keep it in your site repo instead).

4. **Add the Advanced Drive Service.** Left sidebar → **Services → +** → select **Drive API** → Add. Without this, silent sharing fails.

5. **Set Script Properties.** ⚙ **Project Settings → Script Properties → Add**:

   | Property | Value |
   |---|---|
   | `REGISTRY_ID` | the spreadsheet ID from step 1 |
   | `ADMIN_EMAIL` | your address, for fallback notifications |

6. **Initialize the Registry.** Function dropdown → `setupRegistry` → **Run**. Approve the OAuth prompt (it warns "unverified app" — it's your own script: **Advanced → Go to ACP Router**).

7. **Deploy.** **Deploy → New deployment → ⚙ → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** ← must be "Anyone", *not* "Anyone with a Google account"
   - **Deploy**, then copy the `/exec` URL.

**✅ Check:** open `<EXEC_URL>?action=health` in a browser. You want `{"ok":true,...}`. A login page means step 7's access setting is wrong.

---

## Phase 2 — Provision Luis Rojo (10 min)

The folders already exist in your Drive. This wires them up and shares them.

1. In the Apps Script editor, open `provision.gs` and edit `provisionOne()`:
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
2. Run `provisionOne`. It reuses the existing folders rather than duplicating them, formats the sheet, blocks re-sharing, and writes the Registry row.

3. Set up photo categories:
   ```js
   setupPhotoFolders('luis-rojos-masonry-llc',
     ['Paver Driveways', 'Block Walls', 'Stamped Concrete', 'Outdoor Living'],
     'luisr@luisrojosmasonry.com');
   ```

4. Open the Registry sheet and fill in `portal_pin` (any 4–6 digits) and `status` = `active`.

**✅ Check:** run `auditSharing()`. View → Logs. Every line should be `[OK]`. Any `[HIGH]` means leads are still going somewhere shared.

---

## Phase 3 — Prove a lead works (15 min)

Do not skip this. This is the bug you're fixing.

1. Save this as `test-lead.html` on your desktop and open it in a browser:
   ```html
   <form data-acp-lead
         data-endpoint="PASTE_YOUR_EXEC_URL"
         data-client-id="luis-rojos-masonry-llc">
     <input name="name" placeholder="Name" required>
     <input name="phone" placeholder="Phone">
     <textarea name="message" placeholder="Message"></textarea>
     <input name="company_website" tabindex="-1" aria-hidden="true"
            style="position:absolute;left:-9999px">
     <button type="submit">Send</button>
     <p data-acp-status></p>
   </form>
   <script src="lead-form.js"></script>
   ```
2. Submit it with a real-looking name and phone.

**✅ Check, all three:**
- A row appears in the Leads spreadsheet within seconds
- The notification email arrives
- Submitting the identical form twice creates **one** row, not two

**If the form hangs or errors:** open DevTools → Network. A CORS error means something changed the `Content-Type` off `text/plain`. That's the silent-lead-loss bug — fix it there, not in the router.

---

## Phase 4 — The backend (20 min)

1. Push `acp-backend/` to a repo, or `cd acp-backend && npm install && netlify deploy --prod`.

2. **Netlify → Site configuration → Environment variables**, add all four:

   | Variable | Value |
   |---|---|
   | `NETLIFY_API_TOKEN` | from Phase 0 |
   | `ACP_ADMIN_KEY` | from Phase 0 |
   | `ACP_CLAIM_SECRET` | from Phase 0 |
   | `ACP_SITE_PREFIX` | `acp` |

3. Redeploy after adding env vars — they don't apply to an existing build.

**✅ Check:**
```bash
curl https://<your-backend>/api/health
# {"ok":true,"trades":30,"schema":"1.0"}

curl https://<your-backend>/api/trade-defaults | head -c 200
```

Run the local suite too — it needs no real Netlify calls:
```bash
cd acp-backend && node --experimental-test-module-mocks test-api.mjs
# PASS — 24/24
```

---

## Phase 5 — First site ⛔ BLOCKED

**This needs files I haven't seen.** To build `build_site.py --tier lite` I need:

- `contractor-site-builder.html`
- the `Acp-backend` repo (so the new one merges rather than replaces)
- the `site-builder/` folder (`build_site.py`, templates, `check_build.py`)

Rewriting from scratch would discard the ~24 fixes from your two audit rounds, including the multi-client folder collision and the empty-feed crash that deletes local photos. Not worth it.

Once uploaded:
1. Add `--tier lite` to `build_site.py`, reading from `acp_schema`
2. Delete `TRADE_THEME`, `shade`, `tel`, `resolve_theme` — they're in `acp_schema` now
3. Build Luis's site from `example-client-luis-rojo.json`
4. `POST /api/publish` with the client + files

---

## Phase 6 — One real site, end to end (30 min)

Before any volume, walk one contractor's full path yourself.

- [ ] Publish Luis's site. Note the URL and site ID.
- [ ] Open the claim link from the publish response. Confirm it shows his business.
- [ ] Submit the quote form **on the live site**. Confirm the lead lands and emails.
- [ ] Drop 3 photos into a `Website-photos` category, run `publishPhotos('luis-rojos-masonry-llc')`, confirm they appear.
- [ ] Run `auditPhotos()` — confirm nothing unexpected is public.
- [ ] Republish as `tier: full`. **Confirm the URL is unchanged.** That's the upgrade path working.

---

## Phase 7 — Refresh the data, then scale

The ROC sheet is from 2025-12-30 — about eight months stale.

1. Re-run your lookup to produce a fresh `ROC Results` tab.
2. `python3 roc_results.py fresh.xlsx --out ./fresh --metro "Tucson,Oro Valley,Marana,Vail,Sahuarita,Green Valley,Catalina,Corona De Tucson"`
3. Diff `ready.json` against the December run to see who lapsed, who's new, and who changed classification.
4. Spot-check 20 by phone before building 186.
5. Add a daily trigger for `publishPhotosAll()` — **Triggers → + → Time-driven → Day timer**.

**Before the first campaign:**
- [ ] `auditSharing()` — all `[OK]`
- [ ] `auditPhotos()` — nothing unexpected public
- [ ] Confirm your outreach plan. Cold **email** is fine under CAN-SPAM with a physical address and opt-out. Cold **texting** these scraped numbers is TCPA territory with per-message penalties — check that before volume, not after.

---

## Things that will bite you

**Re-deploying Apps Script.** Editing the script does *not* update the live web app. You must use **Deploy → Manage deployments → ✏️ → Version: New version**. Clicking "New deployment" gives a **different URL**, and every already-published site keeps posting to the old code. This is the mistake most likely to cost you a day.

**Registry edits are cached 5 minutes.** Run `flushRegistryCache()` after editing, or wait.

**Never share the Registry spreadsheet.** It holds every client. Clients get their own spreadsheet, which is what Phase 2 sets up.

**Never make `Website-photos` link-viewable.** The contractor has write access. Publishing is per-file via `publishPhotos()` for exactly this reason.
