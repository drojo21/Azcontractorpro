/**
 * dev-admin.mjs — run the admin console locally against the real intake function.
 *
 *   BUILDER_KEY=dev node backend/dev-admin.mjs        # http://localhost:8899/admin/
 *
 * Serves backend/public and routes /.netlify/functions/intake to the actual
 * handler, so the licence gate, the schema and the resolver are the real ones.
 * Only GitHub is faked — set DEV_REAL_GITHUB=1 with a token to talk to it for
 * real, but then a commit really does write to the repo.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const PORT = Number(process.env.PORT || 8899);

process.env.BUILDER_KEY ||= "dev";
process.env.GITHUB_REPO ||= "drojo21/Azcontractorpro";
process.env.INTAKE_BRANCH ||= "intake";
process.env.APPS_SCRIPT_URL ||= "https://script.google.com/macros/s/DEV/exec";

if (!process.env.DEV_REAL_GITHUB) {
  process.env.GITHUB_TOKEN ||= "dev-token";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.github.com")) return realFetch(url, opts);
    const ok = (o, s = 200) =>
      new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
    const method = opts.method || "GET";
    if (u.includes("/contents/")) return new Response('{"message":"Not Found"}', { status: 404 });
    if (u.includes("/git/ref")) return method === "PATCH" ? ok({}) : ok({ object: { sha: "base" } });
    if (u.includes("/git/commits/") && method === "GET") return ok({ tree: { sha: "t" } });
    if (u.endsWith("/git/blobs")) return ok({ sha: "b" + Math.random().toString(16).slice(2, 8) });
    if (u.endsWith("/git/trees")) return ok({ sha: "newtree" });
    if (u.endsWith("/git/commits")) return ok({ sha: "dev0commit0sha" });
    return ok({});
  };
  console.log("GitHub is STUBBED — commits go nowhere. DEV_REAL_GITHUB=1 to change that.");
}

const { default: intake } = await import("./netlify/functions/intake.js");

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css",
                ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/.netlify/functions/intake") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost${url.pathname}`, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await intake(request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }

  let p = path.join(PUBLIC, url.pathname);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  res.end(fs.readFileSync(p));
}).listen(PORT, () => console.log(`admin console: http://localhost:${PORT}/admin/`));
