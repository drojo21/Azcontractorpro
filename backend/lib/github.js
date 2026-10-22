/**
 * github.js — read and write ONE client.json at a time through the GitHub
 * contents API, for the autopilot (stripe-webhook promotion, /api/onboard).
 *
 * These commits land on the repository's DEFAULT branch on purpose. A paying
 * customer changing their own record is the whole point, and the push is what
 * wakes deploy.yml so the site rebuilds itself. The admin console (intake.js)
 * keeps committing to a review branch — different input, different trust:
 * there an operator types in strangers by the hundred; here a verified Stripe
 * buyer edits the one record their payment is tied to.
 *
 * Every write is a compare-and-swap on the file's blob sha, so a deploy run
 * that committed `deploy.*` results a second earlier is never clobbered: the
 * write fails with 409, the caller re-reads, re-applies its change, retries.
 *
 * Env:
 *   GITHUB_TOKEN   fine-grained PAT on the repo, Contents: Read and write
 *   GITHUB_REPO    owner/repo, default drojo21/Azcontractorpro
 *   BASE_BRANCH    optional override; otherwise asked from the repo
 */

const GH = 'https://api.github.com';

export const repoName = () => process.env.GITHUB_REPO || 'drojo21/Azcontractorpro';

export async function gh(path, opts = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    const err = new Error('GITHUB_TOKEN is not set on the backend');
    err.status = 503;
    throw err;
  }
  const res = await fetch(GH + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* non-JSON body */ }
    const err = new Error(`GitHub ${res.status}${msg ? ': ' + msg : ''} (${path})`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/**
 * The repo's default branch, asked for rather than assumed. This repo's is
 * `Main1`, and a stale `main` still exists beside it — writing to the wrong one
 * would never trigger a build and nobody would notice.
 */
let _base = null;
export async function defaultBranch() {
  if (process.env.BASE_BRANCH) return process.env.BASE_BRANCH;
  if (_base) return _base;
  const info = await gh(`/repos/${repoName()}`);
  _base = info.default_branch;
  return _base;
}

/** Tests only. */
export function resetGithubCache() { _base = null; }

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

/** { sha, data } for a JSON file on the default branch, or null when it does not exist. */
export async function readJson(path) {
  const ref = await defaultBranch();
  try {
    const f = await gh(`/repos/${repoName()}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`);
    const text = Buffer.from(String(f.content || ''), 'base64').toString('utf8');
    return { sha: f.sha, data: JSON.parse(text) };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Create (sha omitted) or replace (sha given) one file in one commit. */
export async function writeJson(path, text, message, sha) {
  const branch = await defaultBranch();
  const body = {
    message,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch,
    committer: { name: 'acp-autopilot', email: 'acp-bot@users.noreply.github.com' },
  };
  if (sha) body.sha = sha;
  const res = await gh(`/repos/${repoName()}/contents/${enc(path)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return res?.commit?.sha || '';
}

/**
 * Read → mutate → write, retried once if someone else committed in between.
 *
 *   mutate(current|null) → { data, message } to write, or null to write nothing.
 *   serialize(data)      → the exact file text (acp.dumps + newline).
 *
 * Returns { written, commit, data, created }.
 */
export async function updateJson(path, mutate, serialize, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const cur = await readJson(path);
    const out = await mutate(cur ? cur.data : null);
    if (!out) return { written: false, commit: '', data: cur ? cur.data : null, created: false };
    try {
      const commit = await writeJson(path, serialize(out.data), out.message, cur ? cur.sha : undefined);
      return { written: true, commit, data: out.data, created: !cur };
    } catch (err) {
      // 409: sha moved under us. 422: "sha wasn't supplied" when a file appeared
      // between our read and our create. Both mean: read again and redo the change.
      if (err.status !== 409 && err.status !== 422) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error(`could not write ${path}`);
}
