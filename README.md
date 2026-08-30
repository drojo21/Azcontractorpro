# AZ Contractor Pro

One repo. Push to `main` and every contractor site gets built and published.

```
clients/<client_id>/client.json   ← the ONLY thing you touch per site
        │
        │  git push
        ▼
GitHub Actions ─── builder/build_site.py ──► dist/<client_id>/  (HTML)
        │
        │  POST /api/deploy  (x-builder-key)
        ▼
backend/ on Netlify ─── creates or reuses the client's Netlify site,
                        uploads only changed files, mints the claim link,
                        remembers client_id → site_id in Blobs
        │
        ▼
clients/<client_id>/client.json gets the site URL + claim link committed back
```

Leads, gallery and claim events all go through the Apps Script router
(`apps-script/`), same as before. Nothing about that changed.

## Layout

| Folder | What | You edit it? |
|---|---|---|
| `clients/` | one folder per contractor, `client.json` inside | **yes — this is the job** |
| `config/acp.json` | Apps Script URL, backend URL, default tier | when those change |
| `builder/` | `build_site.py` + Jinja templates. `client.json` → HTML | to change how sites look |
| `core/` | schema, trade table, ROC adapters, parity test | rarely |
| `backend/` | Netlify Functions (`/api/deploy`, `/api/claimed`, `/api/trade-defaults`) + Blobs store | rarely |
| `apps-script/` | `router.gs`, `provision.gs`, `photos.gs` — paste into script.google.com | rarely |
| `scripts/` | `new_client.py`, `build_all.py`, `publish.py`, `sync_core.sh` | no |
| `data/` | processed ROC rosters (186 Tucson, 1,652 statewide) | when you re-pull ROC |
| `docs/` | the older step-by-step guides, kept for reference | no |

## One-time setup (≈15 min)

1. **Push this folder to GitHub** as a new repo (or replace the contents of the old one).
2. **GitHub → Settings → Secrets → Actions → New secret:** `BUILDER_KEY` = the same value already set on the Netlify backend.
3. **Netlify → acp-backend-tucson → Site configuration → Build & deploy → Link repository** → pick this repo, branch `main`, base directory `backend`. Netlify now redeploys the backend whenever `backend/` changes. The env vars you already set (`NETLIFY_TOKEN`, `BUILDER_KEY`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `CLAIM_WEBHOOK`, `LEAD_SHEET_URL`, …) stay as they are.
4. `pip install -r requirements.txt` locally.

That's it. Apps Script is already live; nothing to redo there.

## Adding a contractor

```bash
python3 scripts/new_client.py --search "rojo"       # find them in the ROC data
python3 scripts/new_client.py --roc 362558           # writes clients/rojo-construction-llc/client.json
# optional: open the JSON, fix services / tagline / email
git add clients && git commit -m "add rojo-construction-llc" && git push
```

About a minute later the Actions run finishes and `client.json` has `deploy.netlify_url` and `deploy.claim_url` filled in. Send the claim link to the contractor.

Not in the ROC data? Write a CLIENT INFO BLOCK (see `core/README.md`) and use `--block info.txt`.

## Upgrading lite → full

Change `"tier": "lite"` to `"tier": "full"` in the client's JSON, push. Same Netlify site, same URL, same claim link — the backend reuses the stored site id. Then in Apps Script run `provisionClient(...)` and `setupPhotoFolders(...)` for Drive/leads/gallery (see `apps-script/provision.gs` header).

## Previewing locally

```bash
python3 builder/build_site.py clients/luis-rojos-masonry-llc/client.json --tier full
python3 -m http.server -d dist/luis-rojos-masonry-llc 8000     # open http://localhost:8000
```

## Publishing manually / everything at once

```bash
python3 scripts/build_all.py                          # all clients → dist/
BUILDER_KEY=xxx python3 scripts/publish.py --dry-run  # see what would happen
BUILDER_KEY=xxx python3 scripts/publish.py            # do it
```

Or GitHub → Actions → *Build and publish contractor sites* → **Run workflow** → tick *all*.

## What a site is

- **lite** — one page (`index.html`): hero, services, about, gallery, reviews, FAQ, service area, quote form. ~55 KB. This is the preview you send prospects.
- **full** — 18 pages: home, services index, one page per service, about, gallery, reviews, FAQ, one page per service-area city. Gallery pulls from the contractor's Drive folder through the router. Service pages filter the gallery by category.

Every page carries `LocalBusiness` JSON-LD; the home page adds `ItemList` (services), `FAQPage` and `Organization`; subpages add `BreadcrumbList`. Sitemap, robots and 404 are generated. CSS and JS are inlined so a page never depends on an asset that failed to upload.

The quote form posts to the Apps Script router as `text/plain` (see the comment in `builder/templates/lead-form.js` — changing that silently loses leads). If a client has no lead endpoint the form is replaced by a call button rather than a form that looks like it works.

## Things that will bite you (carried over)

- **Apps Script:** editing code does not update the live URL. Deploy → Manage deployments → ✏️ → *New version*. Never *New deployment* — that mints a new `/exec` URL and every site keeps hitting the old one.
- **After a contractor claims their site**, this backend can't deploy to it any more (Netlify returns 403, publish.py shows `hold`). Decide lite→full *before* sending the claim link, or ask them to add you as a collaborator.
- **`backend/lib/`** carries copies of `core/trade_defaults.json` and `core/acp-schema.js` because Netlify can't import outside its base directory. `scripts/sync_core.sh` keeps them identical; CI fails if they drift.
- **Never share the Registry spreadsheet. Never make `Website-photos` link-viewable.** See `apps-script/photos.gs` for why.
