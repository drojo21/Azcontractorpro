/**
 * test-intake.mjs — exercise netlify/functions/intake.js without Netlify.
 *
 *   node backend/test-intake.mjs
 *
 * GitHub is stubbed: the fake records every call, so a commit can be asserted on
 * (one commit for N files, correct branch, correct paths) without a token and
 * without writing to the real repo. The ROC gate is NOT stubbed — it runs the
 * real posting-list index, because that is the part worth testing.
 */

process.env.BUILDER_KEY = "test-key";
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_REPO = "drojo21/Azcontractorpro";
process.env.INTAKE_BRANCH = "intake";
process.env.APPS_SCRIPT_URL = "https://script.google.com/macros/s/TEST/exec";

const calls = [];
let existingPaths = new Set();

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || "GET";
  calls.push({ method, url: u.replace("https://api.github.com", "") });
  const ok = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const notFound = () =>
    new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });

  if (u.includes("/contents/")) {
    const m = u.match(/\/contents\/(.+?)\?ref=/);
    return existingPaths.has(decodeURIComponent(m[1])) ? ok({ sha: "abc" }) : notFound();
  }
  if (u.includes("/git/ref/heads/") || u.includes("/git/refs/heads/")) {
    if (method === "PATCH") return ok({ ref: "ok" });
    return ok({ object: { sha: "basesha" } });
  }
  if (u.includes("/git/commits/") && method === "GET") return ok({ tree: { sha: "treesha" } });
  if (u.endsWith("/git/blobs")) return ok({ sha: "blob" + calls.length });
  if (u.endsWith("/git/trees")) return ok({ sha: "newtree" });
  if (u.endsWith("/git/commits")) return ok({ sha: "c0ffee" });
  if (u.endsWith("/git/refs")) return ok({ ref: "created" });
  return notFound();
};

const { default: intake } = await import("./netlify/functions/intake.js");

const post = (body, key = "test-key") =>
  intake(new Request("https://x/.netlify/functions/intake", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-builder-key": key },
    body: JSON.stringify(body),
  }));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? "  — " + extra : ""}`); }
};

console.log("\nauth");
check("no key is rejected", (await intake(new Request("https://x", {
  method: "POST", body: "{}" }))).status === 401);
check("wrong key is rejected", (await post({ rows: [] }, "nope")).status === 401);

console.log("\npreview — the licence gate");
let r = await (await post({ action: "preview", rows: [
  { business: "Silver Basin Remodeling LLC", roc: "363002", service: "Plumbing",
    city: "Tucson", phone: "(520) 235-4182", email: "a@b.com", name: "Jeremy" },
  { business: "Sunset State Pools LLC", roc: "362158", service: "Concrete",
    city: "Tucson", email: "a@b.com" },
  { business: "Jiancai Chen", service: "Roofing", city: "Tucson",
    phone: "(626) 554-4892", email: "a@b.com" },
  { business: "Totally Made Up Contracting LLC", service: "Concrete", city: "Mesa",
    phone: "(480) 555-0100", email: "a@b.com" },
  { business: "Lee Collins Air Conditioning Company", service: "HVAC",
    phone: "(602) 555-0100", email: "a@b.com" },
  { name: "Nobody", service: "Concrete", city: "Tucson", email: "a@b.com" },
] })).json();

check("active ROC resolves", r.results[0].status === "ready", r.results[0].reason);
check("inactive ROC refused", r.results[1].status === "refused", r.results[1].status);
check("name-only resolves", r.results[2].status === "ready", r.results[2].reason);
check("unknown business refused", r.results[3].status === "refused", r.results[3].status);
check("name shared by two businesses refused", r.results[4].status === "refused", r.results[4].status);
check("no business and no ROC refused", r.results[5].status === "refused", r.results[5].status);
check("snapshot date reported", r.snapshot_date === "2026-09-08", r.snapshot_date);
check("preview wrote nothing", !calls.some((c) => c.method === "POST" && c.url.includes("/git/")));

console.log("\npreview — registrar data wins over the form");
const withJunk = await (await post({ action: "preview", rows: [
  { business: "SILVER BASIN REMODELING, L.L.C.", roc: "363002", service: "Plumbing",
    city: "WrongCity", phone: "(520) 235-4182", email: "a@b.com" },
] })).json();
const c0 = withJunk.results[0].client;
check("registrar business name used", c0.business_name === "Silver Basin Remodeling LLC", c0.business_name);
check("registrar city used, not the form's", c0.city === "Tucson", c0.city);
check("registrar zip used", c0.zip === "85743", c0.zip);
check("registrar class used", c0.license_class === "CR-37", c0.license_class);
check("provenance recorded", c0.roc_verified.snapshot_date === "2026-09-08");
check("lead endpoint wired", c0.integrations.lead_endpoint.includes("script.google.com"));

console.log("\ncollision with an existing client");
existingPaths = new Set(["clients/silver-basin-remodeling-llc/client.json"]);
r = await (await post({ action: "preview", rows: [
  { business: "Silver Basin Remodeling LLC", roc: "363002", service: "Plumbing",
    city: "Tucson", phone: "(520) 235-4182", email: "a@b.com" },
] })).json();
check("existing client flagged, not overwritten", r.results[0].status === "exists", r.results[0].status);
r = await (await post({ action: "preview", overwrite: true, rows: [
  { business: "Silver Basin Remodeling LLC", roc: "363002", service: "Plumbing",
    city: "Tucson", phone: "(520) 235-4182", email: "a@b.com" },
] })).json();
check("overwrite flag allows it", r.results[0].status === "ready", r.results[0].status);
existingPaths = new Set();

console.log("\ncommit — one commit, N files, never main");
calls.length = 0;
r = await (await post({ action: "commit", rows: [
  { business: "Silver Basin Remodeling LLC", roc: "363002", service: "Plumbing",
    city: "Tucson", phone: "(520) 235-4182", email: "a@b.com" },
  { business: "Jiancai Chen", service: "Roofing", city: "Tucson",
    phone: "(626) 554-4892", email: "a@b.com" },
  { business: "Sunset State Pools LLC", roc: "362158", service: "Concrete", email: "a@b.com" },
] })).json();
check("two rows committed, refused one skipped", r.committed?.length === 2, JSON.stringify(r.committed));
check("exactly one commit object created",
  calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/commits")).length === 1);
check("one blob per committed file",
  calls.filter((c) => c.url.endsWith("/git/blobs")).length === 2);
check("ref updated is the intake branch",
  calls.some((c) => c.method === "PATCH" && c.url.includes("/git/refs/heads/intake")));
check("no write to main",
  !calls.some((c) => c.method === "PATCH" && c.url.includes("heads/main")));
check("compare url points at the review diff",
  (r.compare_url || "").includes("compare/main...intake"), r.compare_url);

console.log("\nrefusing to commit to the default branch");
process.env.INTAKE_BRANCH = "main";
const toMain = await post({ action: "commit", rows: [
  { business: "Jiancai Chen", service: "Roofing", city: "Tucson",
    phone: "(626) 554-4892", email: "a@b.com" }] });
check("INTAKE_BRANCH=main is refused", toMain.status === 500, String(toMain.status));
process.env.INTAKE_BRANCH = "intake";

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
