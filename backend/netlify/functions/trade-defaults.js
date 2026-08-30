/**
 * trade-defaults.js — serves the one trade table to the browser builder.
 *
 * contractor-site-builder.html should fetch this on load instead of carrying
 * its own copy of the themes and trade inference. One table, one place.
 */
import tradeDefaults from "../../lib/trade-defaults.cjs";

export default async () =>
  new Response(JSON.stringify(tradeDefaults), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    },
  });

export const config = { path: "/api/trade-defaults" };
