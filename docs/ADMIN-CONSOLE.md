# Contractor intake console

A page on the backend site for adding contractors — one at a time, or by dropping a CSV.
It lives at `/admin/` on the backend Netlify site (same origin as the function it calls, so
there is no CORS to configure).

```
admin console  (backend/public/admin/index.html)
      │  x-builder-key
      ▼
intake.js  ──  preview   resolve against the ROC active list, build the record,
      │                  run the schema, report. WRITES NOTHING.
      │
      └──────  commit    one commit, N files, onto INTAKE_BRANCH (never main)
                              │
                              ▼
                    you review the diff and merge
                              │
                              ▼
              deploy.yml on main → build → publish
```

**Nothing here publishes.** The console writes `clients/<id>/client.json` to a review branch.
Merging that branch is what wakes the existing deploy workflow. That separation is the point:
the licence claim on a generated site is not something to ship by accident.

## Setup

On the backend Netlify site (`acp-backend-tucson`), **Site configuration → Environment
variables**:

| Variable | Value |
|---|---|
| `BUILDER_KEY` | already set — the console reuses the publish endpoint's key |
| `GITHUB_TOKEN` | fine-grained PAT on the repo, **Contents: Read and write** |
| `GITHUB_REPO` | `drojo21/Azcontractorpro` (default) |
| `INTAKE_BRANCH` | `intake` (default). Must not be `main` — the function refuses to start otherwise |
| `APPS_SCRIPT_URL` | the `/exec` URL, written into each record's `integrations.lead_endpoint` |

Deploy the backend as usual. The console is at `https://<backend-site>/admin/`.

## Using it

**Add one.** Business name and ROC number. With a ROC number the licence is looked up
directly; leave it blank and the business name is resolved instead, which only works when the
name matches exactly one active licence. `tier=full` also needs the contractor's own domain —
the schema will not accept a paying client without one.

**Drop a CSV.** Needs a header row. Recognised columns, with the obvious aliases:

```
business   roc   trade   city   phone   email   owner   tier   site_url
```

(`business_name`, `roc_number`, `service`, `name`, `website`, `company` … all map too.
Unrecognised columns are ignored, so exports with extra fields are fine.)

Every row is checked and shown with its status before anything is written:

| Status | Means |
|---|---|
| `ready` | resolved to an active licence and passes the schema — selected for commit |
| `refused` | the licence gate said no; the reason says which case |
| `invalid` | resolved, but the schema rejected the record (usually a `tier=full` missing `site_url`) |
| `exists` | `clients/<id>/client.json` is already there — tick *replace* to overwrite |
| `error` | something broke; the reason has the detail |

Untick any row you do not want. **Commit selected** writes them in a single commit and links
you to both the commit and the diff against `main`.

## What it will not do

The console runs the same licence gate as the build path, so it refuses the same things —
but it refuses them *while you are still looking at the screen*, rather than in a failed
Actions run twenty minutes later:

* a ROC number that is not on the registrar's active list
* a business name that resolves to no active licence, or to several different businesses
  (add the ROC number to disambiguate)
* a row with neither a business name nor a ROC number

Licence facts — business name, class, city, ZIP, status — always come from the registrar,
never from what was typed. A mistyped city does not reach the record.

## The two copies of the gate

The build path gates in Python (`core/roc_active.py`); the console gates in JavaScript
(`core/roc-active.js`), because a Netlify function cannot run the Python. If those two ever
disagreed, the console would accept a contractor the build then refuses — so
`core/test_parity_roc.py` samples 1,250 queries across the whole posting list, weighted
towards the ambiguous names, and CI fails on any difference.

The JS reads `core/roc-index.json.gz`, a compact form of the posting list built **through**
the Python gate by `scripts/build_roc_index.py`, so it cannot contain anything the Python
would not have seen. After refreshing `data/roc-active.csv.gz`:

```bash
python3 scripts/build_roc_index.py     # rebuild the index
./scripts/sync_core.sh                 # copy core/ into backend/lib
python3 core/test_parity_roc.py        # confirm the two agree
```

## Running it locally

```bash
BUILDER_KEY=dev node backend/dev-admin.mjs      # http://localhost:8899/admin/
```

Serves the real page against the real function with the real licence gate; only GitHub is
stubbed, so commits go nowhere. `DEV_REAL_GITHUB=1` with a token talks to GitHub for real —
and then a commit really does write to the repo.

`node backend/test-intake.mjs` runs the function's own tests (auth, the gate, registrar
precedence, collisions, one-commit batching, and the refusal to commit to `main`).

## Access

The console is gated by `BUILDER_KEY` — one shared secret, the same one the publish endpoint
uses, held in `sessionStorage` for the tab. That is a deliberate match to what already exists
rather than a considered access model: there are no individual accounts, no audit of who added
what, and anyone with the key can commit to the review branch. It is adequate for one or two
operators and a review step before anything publishes. If more people need it, or you want to
know who added a record, that wants real auth (Netlify Identity) before it wants more features.
