import ACPSchema from "../../lib/acp-schema.cjs";
import tradeDefaults from "../../lib/trade-defaults.cjs";
import rocActive from "../../lib/roc-active.cjs";

/**
 * intake.js — the admin console's back end: add contractors one at a time or
 * from a dropped CSV.
 *
 * Two actions, and the split is the point:
 *
 *   preview   resolve every row against the ROC active list, build the record,
 *             run the schema, report what would be written. Writes nothing.
 *   commit    write the approved rows to the repo as clients/<id>/client.json,
 *             in ONE commit, on a branch that is not main.
 *
 * Nothing is published from here. The commit lands on INTAKE_BRANCH (default
 * "intake"); merging it to main is what wakes the existing deploy workflow. The
 * irreversible step stays a human one — which is the whole reason preview and
 * commit are separate calls rather than a flag.
 *
 * The licence gate is the same one the build path uses (core/roc_active.py,
 * mirrored in core/roc-active.js, parity enforced by core/test_parity_roc.py).
 * A contractor whose licence is not on the registrar's active list is refused
 * here, not at build time, so the operator finds out while they can still ask
 * about it rather than after a red Actions run.
 *
 * Env:
 *   BUILDER_KEY       shared secret, sent as x-builder-key (same gate as deploy.js)
 *   GITHUB_TOKEN      fine-grained PAT, Contents: Read and write
 *   GITHUB_REPO       owner/repo, default drojo21/Azcontractorpro
 *   INTAKE_BRANCH     branch to commit to, default "intake" — must NOT be main
 *   APPS_SCRIPT_URL   lead endpoint written into each record's integrations
 *   ALLOWED_ORIGIN    CORS origin; the console is same-origin so this is a fallback
 */

const acp = ACPSchema.create(tradeDefaults);
const { ROCActive } = rocActive;

const GH = "https://api.github.com";
const DEFAULT_REPO = "drojo21/Azcontractorpro";
const DEFAULT_BRANCH = "intake";

const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "Content-Type, x-builder-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const clean = (v, n = 300) =>
  String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

async function gh(path, opts = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set on the backend");
  const res = await fetch(GH + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).message || ""; } catch { /* non-JSON body */ }
    const err = new Error(`GitHub ${res.status}${msg ? ": " + msg : ""} (${path})`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Resolve one submitted row into a client record, or explain the refusal.
 *
 * Mirrors scripts/demo_request.py: licence facts come from the registrar, never
 * from the form — the operator can mistype a class or a city, and the whole
 * point of the posting list is that it does not.
 */
function resolveRow(roster, raw) {
  const name = clean(raw.name);
  const business = clean(raw.business);
  const city = clean(raw.city, 60);
  const phone = clean(raw.phone, 40);
  const email = clean(raw.email, 120);
  const tradeIn = clean(raw.service || raw.trade).toLowerCase();
  const trade = acp.normalizeTrade(tradeIn) || "";
  const tier = clean(raw.tier) === "full" ? "full" : "lite";
  // tier=full is a paying client, and the schema requires their own domain for
  // one. Collected here so choosing "full" cannot silently produce an invalid
  // record the operator has to decode from a validation message.
  const siteUrl = clean(raw.site_url || raw.website, 200);
  let roc = ACPSchema.digits(clean(raw.roc));

  if (!business && !roc) {
    return { status: "refused", reason: "needs a business name or a ROC number" };
  }

  let lic;
  if (roc) {
    lic = roster.get(roc);
    if (!lic) {
      return {
        status: "refused",
        reason: `ROC #${roc} is not on the Arizona ROC active list (snapshot ` +
                `${roster.snapshotDate}) — a site built from it would claim a licence ` +
                `that is not currently active`,
      };
    }
    lic = { ...lic, also_holds: [] };
  } else {
    lic = roster.findByName(business, { trade, city });
    if (!lic) {
      return {
        status: "refused",
        reason: `"${business}" does not resolve to exactly one active licence ` +
                `(snapshot ${roster.snapshotDate}). Either it is not on the active list, ` +
                `or the name is shared by different businesses — add the ROC number`,
      };
    }
    roc = lic.roc_number;
  }

  let client = acp.fromClientInfoBlock({
    BUSINESS_NAME: lic.business_name,
    OWNER_NAME: name || lic.qualifying_party,
    ROC_NUMBER: roc,
    LICENSE_CLASS: lic.license_class,
    PHONE: phone,
    EMAIL: email,
    CITY: lic.city || city,
    STATE: lic.state || "AZ",
    ZIP: lic.zip || "",
    TRADE: trade,
    TAGLINE: "auto",
    WEBSITE_URL: siteUrl,
  });

  // Registrar's facts win over anything typed into the form.
  client.business_name = lic.business_name || client.business_name;
  client.roc_number = roc;
  client.license_class = lic.license_class || client.license_class;
  client.license_class_description =
    lic.license_class_description || client.license_class_description;
  client.roc_status = lic.roc_status || "Active";
  client.tier = tier;
  if (trade) {
    client.trade = trade;
    client.trade_confidence = "high";
  }

  client.integrations = client.integrations || {};
  const endpoint = process.env.APPS_SCRIPT_URL || "";
  client.integrations.lead_endpoint = endpoint;
  client.integrations.gallery_endpoint = endpoint;
  client.integrations.notification_email = email || client.integrations.notification_email || "";

  client.roc_verified = {
    source: "azroc posting list",
    snapshot_date: roster.snapshotDate,
    verified_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    expiration_date: lic.expiration_date,
    also_holds: lic.also_holds || [],
    added_via: "admin console",
  };

  client = acp.resolve(client);
  const problems = acp.validate(client);
  const errors = problems.filter((p) => p.level === "error");

  return {
    status: errors.length ? "invalid" : "ready",
    reason: errors.length ? errors.map((e) => `${e.field}: ${e.message}`).join("; ") : "",
    client_id: client.client_id,
    client,
    problems,
    licence: {
      roc_number: roc,
      business_name: lic.business_name,
      license_class: lic.license_class,
      license_class_description: lic.license_class_description,
      city: lic.city,
      state: lic.state,
      zip: lic.zip,
      expiration_date: lic.expiration_date,
      also_holds: lic.also_holds || [],
    },
  };
}

/** Does clients/<id>/client.json already exist on the branch (or on main)? */
async function existsInRepo(repo, branch, clientId) {
  for (const ref of [branch, "main"]) {
    try {
      await gh(`/repos/${repo}/contents/clients/${encodeURIComponent(clientId)}` +
               `/client.json?ref=${encodeURIComponent(ref)}`);
      return ref;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  return null;
}

/**
 * Write every approved record in ONE commit.
 *
 * The contents API writes a file per call, which would make an N-row CSV into N
 * commits and N chances to half-finish. The git data API builds a tree and
 * commits it once, so a batch either lands whole or not at all.
 */
async function commitAll(repo, branch, files, message) {
  let baseSha;
  try {
    const ref = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    baseSha = ref.object.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
    // First use: branch the intake line off main rather than committing to it.
    const main = await gh(`/repos/${repo}/git/ref/heads/main`);
    baseSha = main.object.sha;
    await gh(`/repos/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
  }

  const baseCommit = await gh(`/repos/${repo}/git/commits/${baseSha}`);
  const tree = [];
  for (const f of files) {
    const blob = await gh(`/repos/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
    });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await gh(`/repos/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  const commit = await gh(`/repos/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }),
  });
  await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
  return commit;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  const key = process.env.BUILDER_KEY;
  if (!key) return json(500, { ok: false, error: "BUILDER_KEY is not set on the backend" });
  if (req.headers.get("x-builder-key") !== key) {
    return json(401, { ok: false, error: "bad or missing x-builder-key" });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "body must be JSON" });
  }

  const action = String(body.action || "preview").toLowerCase();
  const rows = Array.isArray(body.rows) ? body.rows : [body.row].filter(Boolean);
  if (!rows.length) return json(400, { ok: false, error: "no rows submitted" });
  if (rows.length > 500) return json(400, { ok: false, error: "more than 500 rows in one batch" });

  const repo = process.env.GITHUB_REPO || DEFAULT_REPO;
  const branch = process.env.INTAKE_BRANCH || DEFAULT_BRANCH;
  if (branch === "main" || branch === "master") {
    return json(500, {
      ok: false,
      error: `INTAKE_BRANCH is "${branch}" — the console must not commit to the ` +
             "default branch, because that publishes. Point it at a review branch.",
    });
  }

  let roster;
  try {
    roster = ROCActive.load();
  } catch (err) {
    return json(500, { ok: false, error: `ROC index unavailable: ${err.message}` });
  }

  const results = rows.map((raw, i) => {
    try {
      return { index: i, input: raw, ...resolveRow(roster, raw) };
    } catch (err) {
      return { index: i, input: raw, status: "error", reason: String(err.message || err) };
    }
  });

  // Flag collisions so preview shows them, rather than failing at commit time.
  for (const r of results) {
    if (r.status !== "ready") continue;
    try {
      const where = await existsInRepo(repo, branch, r.client_id);
      if (where) {
        r.exists_on = where;
        if (!body.overwrite) {
          r.status = "exists";
          r.reason = `clients/${r.client_id}/client.json already exists on ${where} — ` +
                     "tick overwrite to replace it";
        }
      }
    } catch (err) {
      r.status = "error";
      r.reason = `could not check the repo: ${err.message}`;
    }
  }

  const meta = {
    snapshot_date: roster.snapshotDate,
    snapshot_age_days: roster.ageDays(),
    licences: roster.size,
    repo,
    branch,
  };

  if (action === "preview") {
    return json(200, { ok: true, action, ...meta, results });
  }
  if (action !== "commit") {
    return json(400, { ok: false, error: `unknown action: ${action}` });
  }

  const ready = results.filter((r) => r.status === "ready");
  if (!ready.length) {
    return json(422, { ok: false, error: "nothing to commit", ...meta, results });
  }

  const files = ready.map((r) => ({
    path: `clients/${r.client_id}/client.json`,
    content: acp.dumps(r.client) + "\n",
  }));
  const message = ready.length === 1
    ? `Add ${ready[0].client.business_name} (ROC ${ready[0].client.roc_number}) via admin console`
    : `Add ${ready.length} contractors via admin console`;

  try {
    const commit = await commitAll(repo, branch, files, message);
    return json(200, {
      ok: true,
      action,
      ...meta,
      committed: ready.map((r) => r.client_id),
      commit_sha: commit.sha,
      commit_url: `https://github.com/${repo}/commit/${commit.sha}`,
      compare_url: `https://github.com/${repo}/compare/main...${branch}`,
      results,
    });
  } catch (err) {
    return json(502, { ok: false, error: `commit failed: ${err.message}`, ...meta, results });
  }
};
