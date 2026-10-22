/**
 * promote.js — "they paid" → their record in the repo says so.
 *
 * Called by stripe-webhook.js the moment Checkout completes for a purchase that
 * came from a demo. One commit to clients/<id>/client.json on the default branch:
 * the paid tier, the demo banner off. The push wakes deploy.yml, so the buyer's
 * demo turns into their real site a few minutes after they pay — before they
 * have even opened the setup form. The setup form (onboard.js) runs the same
 * promote() again, which is a no-op by then, so whichever lands first wins and
 * neither can undo the other.
 */

import { updateJson } from './github.js';
import { acp, promote } from './autopilot.js';

/**
 * @returns {Promise<{ promoted: boolean, reason: string, commit?: string }>}
 *   Never throws for an expected condition — the webhook reports the reason
 *   in the "new customer" email instead.
 */
export async function promoteInRepo(clientId, plan, contact = {}) {
  if (!clientId) return { promoted: false, reason: 'no client_id on the purchase' };
  if (!process.env.GITHUB_TOKEN) return { promoted: false, reason: 'GITHUB_TOKEN is not set on the backend' };

  let problems = [];
  let missing = false;
  let unchanged = false;
  const res = await updateJson(`clients/${clientId}/client.json`, (cur) => {
    if (!cur) { missing = true; return null; }
    const next = promote(cur, plan, contact);
    if (acp.dumps(next) === acp.dumps(cur)) { unchanged = true; return null; }
    problems = acp.validate(next).filter((p) => p.level === 'error');
    if (problems.length) return null;
    return { data: next, message: `Promote ${next.business_name} to ${plan} after payment [autopilot]` };
  }, (d) => acp.dumps(d) + '\n');

  if (missing) return { promoted: false, reason: `clients/${clientId}/client.json is not in the repo` };
  if (unchanged) return { promoted: true, reason: 'already promoted' };
  if (problems.length) {
    return { promoted: false, reason: 'record would not validate: ' + problems.map((p) => `${p.field}: ${p.message}`).join('; ') };
  }
  return { promoted: !!res.written, reason: res.written ? 'committed' : 'nothing written', commit: res.commit };
}
