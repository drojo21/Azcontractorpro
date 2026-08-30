# Deploying the router and the backend

Two deployments. Do the router first — until leads land somewhere, publishing a site is worse than not publishing one.

---

## 1. Apps Script lead router

**Files:** `apps-script/router.gs`, `apps-script/lead-form.js`

### Setup

1. Create a Google Sheet named something like `ACP Registry`. Copy its ID from the URL (`/spreadsheets/d/<THIS>/edit`).
2. Go to [script.google.com](https://script.google.com) → **New project**. Paste `router.gs` over `Code.gs`. Rename the project `ACP Router`.
3. **Project Settings → Script Properties**, add:

   | Property | Value |
   |---|---|
   | `REGISTRY_ID` | the spreadsheet ID from step 1 |
   | `ADMIN_EMAIL` | fallback notification address |

4. Back in the editor, select `setupRegistry` from the function dropdown and **Run**. Approve the OAuth prompt (it will warn "unverified app" — that's your own script; choose Advanced → Go to ACP Router). This creates the `Registry` tab with correct headers.
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** ← must be "Anyone", not "Anyone with a Google account"
   - Copy the `/exec` URL.
6. Verify: open `<EXEC_URL>?action=health` in a browser. You want `{"ok":true,...}`.

### Adding a client

One row in the `Registry` tab:

| client_id | business_name | notification_email | leads_sheet_id | drive_folder_id | portal_pin | status |
|---|---|---|---|---|---|---|
| `luis-rojos-masonry-llc` | Luis Rojo's Masonry LLC | info@… | *(blank)* | *(Drive folder ID)* | 4821 | active |

- `client_id` must match the value in `client.json`. That's the join key for the whole system.
- `leads_sheet_id` blank → leads go to a `Leads_<client_id>` tab in the registry spreadsheet. Set it to give a client their own spreadsheet.
- After editing the Registry, run `flushRegistryCache` (or wait 5 minutes) for changes to take effect.

Then set `integrations.lead_endpoint` on the client to the `/exec` URL.

### Three things that will bite you

**Re-deploy correctly.** Editing the script does *not* update the live web app. You must **Deploy → Manage deployments → edit → Version: New version**. Using "New deployment" instead gives you a *different* URL and every already-published site keeps posting to the old code.

**Don't change the Content-Type.** `lead-form.js` posts `text/plain` on purpose. Apps Script doesn't answer CORS preflight requests, and `application/json` triggers one. The form appears to submit and the lead is silently gone. This is the single most likely way to reintroduce the bug you're fixing.

**Mail quota is 100/day** on a consumer Gmail account (1,500 on Workspace). The lead is written to the sheet *before* the email is attempted, and a failed send is logged rather than thrown — so a blown quota costs you the notification, not the lead. Worth knowing before a campaign lands.

### What's built in

Honeypot field, 10-minute duplicate suppression (double-clicks don't create two leads), `LockService` around the read-then-append so concurrent submissions can't interleave, field truncation, and a gallery cache that deliberately **does not cache empty results** — a transient Drive error caching as "empty" is how a live gallery goes blank for an hour.

---

## 2. acp-backend

**Files:** `acp-backend/` — Netlify function, `lib/` vendored schema, tests.

### Setup

```bash
cd acp-backend
npm install
netlify deploy --prod        # or connect the repo in the Netlify UI
```

**Environment variables** (Site configuration → Environment variables):

| Variable | Purpose |
|---|---|
| `NETLIFY_API_TOKEN` | Personal access token, User settings → Applications |
| `ACP_ADMIN_KEY` | Shared secret for `publish` and `client/:id` — generate 32+ random chars |
| `ACP_CLAIM_SECRET` | HMAC secret for claim tokens — generate separately, don't reuse the admin key |
| `ACP_SITE_PREFIX` | Optional, defaults to `acp` |

Verify: `curl https://<backend>/api/health` → `{"ok":true,"trades":30,...}`

### Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | — | deployment check |
| `GET /api/trade-defaults` | — | the trade table, cached 1h — the builder fetches this |
| `POST /api/publish` | `x-acp-key` | validate, deploy, return URL + claim link |
| `GET /api/claim?token=` | token | claim page data (public-safe subset only) |
| `POST /api/claimed` | token | mark claimed |
| `GET /api/client/:id` | `x-acp-key` | full stored record |

### The part that matters

`publish` looks up `client_id → netlify_site_id` in Netlify Blobs and **redeploys the same site**. Upgrading lite → full keeps the URL and keeps the claim link you already sent alive. Previously that path created a new site and orphaned the link.

It also refuses to publish when `roc_status` isn't Active. A site claiming "Licensed, bonded, and insured" for a contractor whose license was suspended or revoked is the one failure mode here with real legal exposure, so it's a hard stop rather than a warning.

If a site is deleted in the Netlify UI, the next publish detects the 404 and creates a fresh one rather than failing forever.

### Tests

```bash
node --experimental-test-module-mocks test-api.mjs
```

24 checks with the Netlify API and blob store mocked — routing, auth, validation gates, the site-ID reuse path, and the full claim flow. No real sites are created.

---

## Order of operations for going live

1. Deploy the router. Confirm `?action=health`.
2. Add one Registry row for a test client. Submit a form. Confirm the row lands and the email arrives.
3. Deploy the backend. Confirm `/api/health`.
4. Publish **one** site. Click your own claim link end to end.
5. Only then run volume.

---

## 3. Per-client Drive provisioning

**File:** `apps-script/provision.gs` — add to the same Apps Script project as `router.gs`.

Creates, per client:

```
<Business Name>/                  internal — never shared
  Website-leads/                  internal — never shared
    Leads-spreadsheet — <name>    ← SHARED with the client, and only this
  Website-photos/                 gallery source
```

Then writes `leads_sheet_id`, `drive_folder_id`, and `company_folder_id` back into the Registry.

### Why this matters

With `leads_sheet_id` blank, the router puts leads in tabs inside the **Registry spreadsheet** — the one holding every client. Sharing that with one contractor exposes all of them. Provisioning flips each client onto their own spreadsheet, which is the actual isolation.

### Setup

1. Paste `provision.gs` into the project as a new file.
2. **Services → add Drive API** (the Advanced Drive Service). Needed to share without sending Drive's automated email.
3. Optional Script Property `DRIVE_ROOT_ID` — a parent folder to keep client folders out of My Drive root.
4. Edit `provisionOne()` with real values and Run.

### The sharing decisions, and why

**Only the spreadsheet is shared — not any folder.** Drive sharing flows downward and forward: share a folder and the person gets everything in it, including whatever you add later. Sharing just the file means the client can't traverse to a parent, can't browse siblings, and never sees the folder tree. It appears in their "Shared with me" as one item. Pass `shareFolder: true` only if you want a browsable drop-box, and then put nothing else in it.

**Editors can't re-share.** `setShareableByEditors(false)` — otherwise a contractor with edit access can hand the sheet to anyone. That's the leak vector most people miss.

**Link sharing is explicitly revoked** on every folder and file created, regardless of the account's default sharing setting.

**Sharing is silent by default** (`notify: false`) so the introduction comes from your outreach, not an automated Drive email.

**Client gets `writer`**, plus `Status` and `Notes` columns with a dropdown. Plumbing columns (`dedupe_key`, `user_agent`, `page`, `source`) are hidden, and the router's columns carry a note warning against edits. If you'd rather they can't delete leads, pass `role: 'reader'` — but then the Status column is useless to them.

### One genuine exposure to know about

`Website-photos` feeds the public gallery. For images to render on the site, those files **must be link-viewable**, which means anyone with the URL can open them. That's unavoidable for a public website gallery, but it means the photos folder is the one place where dropping the wrong file has real consequences. Keep it to job photos only — no scans, no contracts, no anything with an address or a signature on it.

### Before any campaign

```
auditSharing()
```

Lists every client's leads sheet, who can see it, and flags: a missing `leads_sheet_id` (leads going to the shared Registry), link sharing left on, or a file shared with someone who isn't the registered contact. Run it after any bulk change.

### Revoking

```
revokeClient('luis-rojos-masonry-llc', 'info@luisrojomasonry.com')
```


---

## 4. Photos

**File:** `apps-script/photos.gs` — same project. Replaces the gallery handler in `router.gs`.

The company folder holds both subfolders, which is the point of naming it after the contractor:

```
<Business Name>/
  Website-leads/     shared: the spreadsheet only, client can't browse the tree
  Website-photos/    shared: the FOLDER, client is a writer so they can upload
    Paver-driveways/     optional category subfolders
    Block-walls/
  gallery.json       manifest — internal, never shared
```

Folder-level sharing is correct for photos and wrong for leads. Uploading is the whole feature.

### The trap

For an image to show on a public website, it has to be publicly readable. The obvious move is to make `Website-photos` link-viewable and scan it when the gallery loads. **Don't.** The contractor has write access to that folder — so the moment it's public, anything they drop in is public too. A signed contract, an insurance certificate, a screenshot with a customer's address: public, permanently, at a URL you didn't choose.

So the folder stays private-to-the-client and publishing happens **per file**. `publishPhotos()` walks the folder and marks link-viewable only files that are actually images. Everything else is reported and left private. The gallery serves a manifest of vetted files, never a live directory listing — and if the manifest is missing it returns empty rather than falling back to a scan, because the fallback is the leak.

The failure mode inverts: a new photo is invisible until the next sweep, instead of a private document being exposed the second it's uploaded.

### Usage

```
setupPhotoFolders(clientId, ['Paver Driveways', 'Block Walls'], 'owner@example.com')
publishPhotos(clientId)          // or publishPhotosAll() on a daily trigger
auditPhotos()                    // what's public, and what shouldn't be in there
unpublishPhotos(clientId)        // pull everything back to private
```

Subfolder names become gallery categories, so a photo's folder decides which service page it appears on. Match them to service names in `client.json` and the site can filter per service.

### EXIF and job-site GPS

Phone photos carry GPS coordinates in EXIF. A gallery of job photos is therefore a map of customers' home addresses, published without those customers ever being asked. The manifest uses Google's resized variants (`=w600`, `=w1600`), which are re-encoded and drop the metadata — so the served images are clean. Don't swap those for `uc?export=view` or a direct file URL, which return the original bytes with EXIF intact.
