/**
 * claimed.js — Netlify calls this when a contractor claims their site.
 *
 * Body from Netlify: { claimed: true, site_id, destination_acc_id }
 *
 * TWO FIXES over the original:
 *
 * 1. ATTRIBUTION. Netlify only tells us a site_id. The original logged that and
 *    nothing else, so a claim couldn't be tied back to a contractor. The store's
 *    reverse index turns site_id into the client record.
 *
 * 2. PAYLOAD SHAPE. The original posted { event, site_id, destination_acc_id }
 *    to LEAD_SHEET_URL. The Apps Script router routes on `action` and requires
 *    `client_id` for leads, so that body was rejected as a malformed lead and
 *    the claim vanished. It now posts action=claimed with a client_id, and as
 *    text/plain — application/json triggers a CORS preflight that Apps Script
 *    does not answer.
 *
 * Also records claimed_at on the client, which is what tells the publish path
 * that this site may no longer be deployable with our token.
 */

import { getClientBySiteId, patchClient } from "../../lib/store.js";

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  let body;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

  const siteId = body.site_id || null;
  const claimedAt = new Date().toISOString();

  let client = null;
  try {
    client = await getClientBySiteId(siteId);
  } catch (err) {
    console.error("[claimed] store lookup failed:", err.message);
  }

  const record = {
    event: "site_claimed",
    site_id: siteId,
    destination_acc_id: body.destination_acc_id || null,
    client_id: client?.client_id || null,
    business_name: client?.business_name || null,
    claimed_at: claimedAt,
  };
  console.log("[claimed]", JSON.stringify(record));

  if (client?.client_id) {
    try {
      await patchClient(client.client_id, {
        deploy: { claimed_at: claimedAt, destination_acc_id: record.destination_acc_id },
      });
    } catch (err) {
      console.error("[claimed] persist failed:", err.message);
    }
  } else if (siteId) {
    // Worth knowing about: it means a site was published without a client_id,
    // so nothing can be attributed to it later.
    console.warn(`[claimed] no client found for site_id ${siteId}`);
  }

  if (process.env.LEAD_SHEET_URL) {
    try {
      await fetch(process.env.LEAD_SHEET_URL, {
        method: "POST",
        // text/plain on purpose — see the header note.
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "claimed", ...record }),
      });
    } catch (err) {
      console.error("[claimed] sheet log failed:", err.message);
    }
  }

  // Always 200 — a failed side effect shouldn't make Netlify retry the claim.
  return new Response(JSON.stringify({ ok: true, client_id: record.client_id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = { path: "/api/claimed" };
