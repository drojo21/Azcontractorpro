# acp-core

The shared layer both AZ Contractor Pro systems now sit on. One contractor record, one trade table, one trade-inference implementation.

```
acp-core/
  trade_defaults.json   Themes, taglines, GBP categories, FB interests,
                        default services, ROC class inference rules.
                        The ONLY copy. Delete the others.
  acp_schema.py         Canonical record + adapters + validation (Python).
  acp-schema.js         Identical logic for the browser and Netlify function.
  test_parity.py        Proves the two agree. Run in CI.
```

## Why this exists

The same contractor existed in three incompatible shapes — the flat `CLIENT INFO BLOCK` in the skills, the nested `client.json` in the site pipeline, and the builder's form state. The trade/theme table existed in three places and trade inference in two, which is how the KB-2 bug shipped in one and not the other.

Everything now converts through one record:

```
ROC roster row      ─┐
CLIENT INFO BLOCK   ─┼─→ client.json ─┬─→ build_site.py --tier lite  (single file)
Builder work order  ─┘                ├─→ build_site.py --tier full  (18 pages)
                                      ├─→ marketing deliverables 2-7
                                      └─→ Apps Script lead router
```

## Usage

**Python**

```python
from acp_schema import ACP
acp = ACP()

client = acp.resolve(acp.from_roc_row(csv_row))
problems = acp.validate(client)
if any(p["level"] == "error" for p in problems):
    ...  # don't publish
```

**Node / Netlify function**

```js
const { create } = require('./acp-schema.js');
const acp = create(require('./trade_defaults.json'));
const client = acp.resolve(acp.fromBuilderForm(req.body));
```

**Browser (builder)**

```js
const defaults = await (await fetch(BACKEND + '/trade-defaults')).json();
const acp = ACPSchema.create(defaults);
```

**CLI**

```bash
python3 acp_schema.py convert roster.csv --tier lite --out clients.json
python3 acp_schema.py convert client-info.txt --tier full --out client.json
python3 acp_schema.py validate client.json      # exits 1 on any error
```

## The record

Deliberately a superset of the existing `client.json`, so `build_site.py` needs almost no changes. New fields:

| Field | Why it's new |
|---|---|
| `schema_version` | so a future change can migrate old records |
| `client_id` | stable key across Netlify, the lead router, and the portal |
| `tier` | `lite` (prospect, single file) or `full` (paying, 18 pages) |
| `trade_confidence` | `low` blocks batch auto-publish |
| `license_class_description`, `roc_status` | ROC roster carries them; suspended licenses must not get "Licensed" copy |
| `service_area[]` | was a comma string in one system, a list in the other |
| `deploy{}` | **`netlify_site_id` is the key to the whole upgrade path** |
| `marketing{}` | GBP categories + FB interests, so deliverables 3–5 stop re-deriving them |
| `reviews[]` | was builder-only |

### `deploy.netlify_site_id` is the important one

Today a lite→full upgrade means a new Netlify site, a new URL, and a dead claim link. Once the backend writes `netlify_site_id` at first publish, the full build deploys to that *same* site. The contractor's URL and claim link survive the upgrade. That's the piece that turns two products into one funnel.

## Validation levels

`error` blocks publish. `warn` is advisory. Notable rules:

- **`roc_status` not Active → warn.** Do not publish licensure claims for a suspended contractor. This did not exist before and is the one with actual legal exposure.
- **`trade_confidence == "low"` → warn.** Batch mode should skip these for manual review rather than guessing a theme and services.
- **duplicate service slug → error.** In `--tier full` two services with the same slug silently overwrite each other's page.
- **no `lead_endpoint` → warn.** This is your currently-open bug, now surfaced automatically on every build.

## Wiring it in — migration order

1. **`acp-backend`** — vendor these three files. Add `GET /trade-defaults` serving `trade_defaults.json` (cache it hard). Add `client_id` and `netlify_site_id` to whatever store the claim JWTs use.
2. **`contractor-site-builder.html`** — delete its trade table and `inferTrade`; fetch `/trade-defaults` on load and call `ACPSchema`. The Roster tab uses `mapHeaders` + `fromRocRow` instead of its own fuzzy matcher. Show `validate()` warnings in the UI before the publish button.
3. **`build_site.py`** — delete `TRADE_THEME`, `shade`, `tel`, `resolve_theme`; import from `acp_schema`. Add `--tier`, with `lite` rendering only `index.html` from the existing home template.
4. **Apps Script router** — accept `client_id` in the lead payload and fan out to the right sheet. Both tiers then post the same shape.
5. **The two skills** — replace the inline color/tagline/GBP tables with a pointer to `trade_defaults.json`, and merge into one skill with a tier parameter.
6. **CI** — `python3 test_parity.py` on every commit touching `acp_schema.py`, `acp-schema.js`, or `trade_defaults.json`.

## Before you batch-run a real roster

`trade_defaults.json → roc.*` was reconstructed from known ROC classification patterns, not scraped from the source. Entries marked `"confidence": "low"` are guesses:

`4` (boilers→hvac), `5` (carpentry), `22` (masonry), `34` (plastering→masonry), `61` (carpentry), `A-12`, `A-14`

Check these against the official classification list at azroc.gov and correct the file. Everything reads from it, so one edit fixes every system at once — which is the whole point.

`test_parity.py` guards agreement between the two implementations, not correctness of the table. Both can be wrong together.
