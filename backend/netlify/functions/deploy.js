import crypto from "node:crypto";
import ACPSchema from "../../lib/acp-schema.cjs";
import tradeDefaults from "../../lib/trade-defaults.cjs";
import { getClient, patchClient } from "../../lib/store.js";

/**
 * deploy.js — publish a contractor site.
 *
 * Merged from the original. Kept as-is: the hand-rolled HS256 JWT and Netlify
 * OAuth claim flow (which transfers real site ownership, and is better than
 * anything custom), CDN readiness polling, deploy_origin links, CORS shape,
 * and the x-builder-key gate.
 *
 * Added:
 *   1. PERSISTENCE. `siteId` reuse already worked but nothing stored the ID, so
 *      it lived in browser state. Close the tab and the next publish made a new
 *      site and orphaned the claim link. Now client_id -> netlify_site_id is
 *      looked up server-side; the caller no longer has to remember anything.
 *   2. MULTI-FILE. `html` published one page, which caps this at tier=lite.
 *      `files` accepts a map, so the 18-page full build uses the same path.
 *   3. VALIDATION. Runs the canonical schema before spending a site.
 *   4. LICENCE GATE. Refuses to publish when ROC status is not Active —
 *      "Licensed, bonded and insured" on a suspended licence is the one failure
 *      here with real legal exposure.
 *
 * Body (both shapes accepted):
 *   { client: {...}, files: { "index.html": "...", "about/index.html": "..." } }
 *   { html: "...", businessName: "...", siteId, sessionId }      // legacy
 */

const NF = "https://api.netlify.com/api/v1";
const acp = ACPSchema.create(tradeDefaults);

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** HS256 JWT, hand-rolled so this function stays lean. */
function signJWT(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

const sha1 = (bytes) => crypto.createHash("sha1").update(bytes).digest("hex");

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

async function nf(path, opts, token) {
  const res = await fetch(NF + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).message || ""; } catch { /* non-JSON error body */ }
    const err = new Error(`Netlify ${res.status}${msg ? ": " + msg : ""} (${path})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const slugify = (s, fallback) =>
  (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback).slice(0, 34);

/** Normalise both body shapes to a file map with leading slashes. */
function normaliseFiles(body) {
  if (body.files && typeof body.files === "object") {
    const out = {};
    for (const [path, content] of Object.entries(body.files)) {
      if (typeof content !== "string") continue;
      out["/" + String(path).replace(/^\/+/, "")] = content;
    }
    return out;
  }
  if (typeof body.html === "string") return { "/index.html": body.html };
  return {};
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const { NETLIFY_TEAM_SLUG, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, CLAIM_WEBHOOK, TOOL_URL } = process.env;

  // Two names for the same two things. The site was configured with the ACP_*
  // / NETLIFY_API_TOKEN names before this function was merged in; accepting
  // both means nothing has to be renamed in the Netlify UI, where a typo costs
  // a debugging session.
  const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_TOKEN;
  const BUILDER_KEY = process.env.BUILDER_KEY || process.env.ACP_ADMIN_KEY;

  if (!NETLIFY_TOKEN) {
    return json(500, { error: "No Netlify token: set NETLIFY_TOKEN (or NETLIFY_API_TOKEN) on this function" });
  }
  // Fail CLOSED. This endpoint spends sites on a real Netlify account, so an
  // unset key must refuse rather than wave everyone through.
  if (!BUILDER_KEY) {
    return json(503, { error: "No builder key configured: set BUILDER_KEY (or ACP_ADMIN_KEY) on this function" });
  }
  if (req.headers.get("x-builder-key") !== BUILDER_KEY) {
    return json(401, { error: "Bad or missing x-builder-key" });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }

  const files = normaliseFiles(body);
  if (!files["/index.html"]) return json(400, { error: "index.html is required" });

  const total = Object.values(files).reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0);
  if (total > 12_000_000) return json(413, { error: "payload is too large" });

  /* ---------- resolve the client ---------- */

  let client = null;
  if (body.client) {
    client = acp.resolve(body.client);
    const problems = acp.validate(client);
    const errors = problems.filter((p) => p.level === "error");
    if (errors.length) return json(422, { error: "validation failed", problems });

    // Hard stop. A site claiming licensure for a contractor whose licence is
    // suspended, expired or cancelled is the real exposure in this pipeline.
    if (String(client.roc_status || "").toLowerCase() !== "active") {
      return json(422, { error: `refusing to publish: ROC status is "${client.roc_status}"` });
    }
  }

  const clientId = client?.client_id || body.clientId || null;
  const businessName = client?.business_name || body.businessName || "";
  const tier = client?.tier || body.tier || "lite";

  /* ---------- reuse the existing site ---------- */

  // Priority: what the caller passed, then what we stored. The stored value is
  // what makes this survive a closed browser tab.
  const stored = clientId ? await getClient(clientId) : null;
  let siteId = body.siteId || stored?.deploy?.netlify_site_id || null;
  let reused = Boolean(siteId);

  const sessionId =
    body.sessionId ||
    stored?.deploy?.session_id ||
    `acp-${slugify(businessName, "site")}-${crypto.randomUUID().slice(0, 8)}`;

  const bytes = Object.fromEntries(
    Object.entries(files).map(([p, c]) => [p, Buffer.from(c, "utf8")]),
  );

  try {
    /* 1 — site */
    if (siteId) {
      try {
        await nf(`/sites/${siteId}`, {}, NETLIFY_TOKEN);
      } catch (err) {
        // 404: deleted in the UI. 401/403: almost certainly claimed, so the
        // site now belongs to the contractor and this token can't touch it.
        if (err.status === 401 || err.status === 403) {
          return json(409, {
            error: "This site has been claimed by the contractor and can no longer be " +
                   "deployed to with this token. Ask them to add you as a collaborator, " +
                   "or publish to a new site.",
            siteId, clientId,
          });
        }
        if (err.status !== 404) throw err;
        siteId = null;
        reused = false;
      }
    }

    if (!siteId) {
      const payload = {
        created_via: "az-contractor-pro",
        name: `${slugify(businessName, "contractor")}-${crypto.randomUUID().slice(0, 4)}`,
        session_id: sessionId,
      };
      if (NETLIFY_TEAM_SLUG) payload.account_slug = NETLIFY_TEAM_SLUG;
      if (TOOL_URL) {
        payload.deploy_origin = {
          name: "AZ Contractor Pro",
          deploy_links: [{ url: TOOL_URL, name: "Open in Site Builder", primary: true }],
        };
      }
      const site = await nf("/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, NETLIFY_TOKEN);
      siteId = site.id;
    }

    /* 2 — digests for every file */
    const digests = {};
    for (const [path, buf] of Object.entries(bytes)) digests[path] = sha1(buf);

    const deploy = await nf(`/sites/${siteId}/deploys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: digests }),
    }, NETLIFY_TOKEN);

    /* 3 — upload only what Netlify doesn't already have */
    const required = new Set(deploy.required || []);
    for (const [path, buf] of Object.entries(bytes)) {
      if (!required.has(digests[path])) continue;
      const up = await fetch(`${NF}/deploys/${deploy.id}/files${path}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${NETLIFY_TOKEN}`,
          "Content-Type": "application/octet-stream",
        },
        body: buf,
      });
      if (!up.ok) throw new Error(`Upload failed for ${path} (${up.status})`);
    }

    /* 4 — wait for the CDN */
    let url = "", state = "";
    for (let i = 0; i < 40; i++) {
      const d = await nf(`/deploys/${deploy.id}`, {}, NETLIFY_TOKEN);
      state = d.state;
      url = d.ssl_url || d.url || url;
      if (state === "ready") break;
      if (state === "error") throw new Error("Netlify reported a deploy error");
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (state !== "ready") throw new Error("Timed out waiting for the CDN");

    /* 5 — claim link, so the contractor can take ownership */
    let claimUrl = null;
    if (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET) {
      const claim = { client_id: OAUTH_CLIENT_ID, session_id: sessionId };
      if (CLAIM_WEBHOOK) claim.claim_webhook = CLAIM_WEBHOOK;
      claimUrl = `https://app.netlify.com/claim?utm_source=az-contractor-pro#${signJWT(claim, OAUTH_CLIENT_SECRET)}`;
    }

    /* 6 — persist, so the next publish finds this site instead of making one */
    if (clientId) {
      await patchClient(clientId, {
        ...(client || {}),
        client_id: clientId,
        business_name: businessName,
        deploy: {
          netlify_site_id: siteId,
          netlify_url: url,
          session_id: sessionId,
          last_deploy_id: deploy.id,
          last_built_at: new Date().toISOString(),
          last_tier_built: tier,
          claim_url: claimUrl,
          claimed_at: stored?.deploy?.claimed_at || "",
        },
      });
    }

    return json(200, {
      url, siteId, deployId: deploy.id, sessionId, claimUrl,
      clientId, tier, reused,
      files: Object.keys(files).length,
      warnings: client ? acp.validate(client).filter((p) => p.level === "warn") : [],
      persisted: Boolean(clientId),
    });
  } catch (err) {
    return json(502, { error: String(err.message || err) });
  }
};

export const config = { path: "/api/deploy" };
