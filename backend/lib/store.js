/**
 * store.js — the persistence deploy.js never had.
 *
 * Site reuse already worked: deploy.js accepts `siteId` and passes it through.
 * What was missing was anywhere to KEEP it. The builder held it in browser
 * state, so closing the tab, switching machines, or a second operator meant the
 * next publish created a brand new site and orphaned the claim link already
 * sent to the contractor.
 *
 * Two indexes:
 *   client:<client_id>   the full record, including deploy.netlify_site_id
 *   site:<site_id>       reverse lookup, so the claim webhook can work out
 *                        which contractor a Netlify site_id belongs to
 *
 * This adds @netlify/blobs, the first dependency in this project. Worth it:
 * without persistence the funnel leaks sites.
 */

import { getStore } from '@netlify/blobs';

const store = () => getStore({ name: 'acp-clients', consistency: 'strong' });

export async function getClient(clientId) {
  if (!clientId) return null;
  try {
    return await store().get(`client:${clientId}`, { type: 'json' });
  } catch {
    return null;
  }
}

/** Reverse lookup for the claim webhook, which only ever sees a site_id. */
export async function getClientBySiteId(siteId) {
  if (!siteId) return null;
  try {
    const pointer = await store().get(`site:${siteId}`, { type: 'json' });
    return pointer?.client_id ? getClient(pointer.client_id) : null;
  } catch {
    return null;
  }
}

export async function putClient(record) {
  if (!record?.client_id) throw new Error('client_id is required to store a record');
  const db = store();
  record.updated_at = new Date().toISOString();
  await db.setJSON(`client:${record.client_id}`, record);

  const siteId = record?.deploy?.netlify_site_id;
  if (siteId) {
    await db.setJSON(`site:${siteId}`, {
      client_id: record.client_id,
      business_name: record.business_name || '',
    });
  }
  return record;
}

/** Shallow-merge a patch into the stored record, creating it if absent. */
export async function patchClient(clientId, patch) {
  const existing = (await getClient(clientId)) || { client_id: clientId };
  const merged = { ...existing, ...patch };
  if (patch.deploy) merged.deploy = { ...(existing.deploy || {}), ...patch.deploy };
  return putClient(merged);
}

export async function listClients(limit = 500) {
  try {
    const { blobs } = await store().list({ prefix: 'client:' });
    return blobs.slice(0, limit).map((b) => b.key.replace(/^client:/, ''));
  } catch {
    return [];
  }
}
