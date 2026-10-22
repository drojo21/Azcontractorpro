/**
 * roc.js — instant licence check for the sales page.
 *
 *   GET /api/roc?n=337881
 *
 * The demo form asks for a ROC number first. Answering "✓ Luis Rojo Masonry LLC
 * · KB-2 · Tucson" while the contractor is still typing does two jobs: it proves
 * we are talking about their business before they hand over an email, and it
 * catches a typo before a build is dispatched and refused three minutes later.
 *
 * Same gate as the build (core/roc_active.py, mirrored in roc-active.cjs, parity
 * enforced in CI): a number absent from the registrar's active posting list is
 * not active. The answer is public record — azroc.gov shows the same — so this
 * is open (CORS *) and cacheable. Only active licences return business details.
 */

import rocActive from '../../lib/roc-active.cjs';
import { suggestAreas } from '../../lib/autopilot.js';

const { ROCActive } = rocActive;

const titleCase = (s) => String(s || '')
  .toLowerCase()
  .replace(/\b([a-z])/g, (m) => m.toUpperCase())
  .replace(/\b(Llc|Inc|Lp|Llp|Pllc|Dba|Ii|Iii|Hvac|Az)\b/g, (m) => m.toUpperCase());

const json = (status, obj, cache = 'no-store') => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cache,
  },
});

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' } });
  }
  if (req.method !== 'GET') return json(405, { ok: false, error: 'GET only' });

  const n = String(new URL(req.url).searchParams.get('n') || '').replace(/[^0-9]/g, '');
  if (n.length < 4 || n.length > 9) {
    return json(400, { ok: false, error: 'Enter the digits of your ROC license number.' });
  }

  let roster;
  try {
    roster = ROCActive.load();
  } catch (err) {
    console.error('[roc] index unavailable:', err.message);
    return json(503, { ok: false, error: 'License lookup is unavailable right now.' });
  }

  const lic = roster.get(n);
  const base = { ok: true, roc_number: n, snapshot_date: roster.snapshotDate };
  if (!lic) return json(200, { ...base, active: false }, 'public, max-age=600');

  return json(200, {
    ...base,
    active: true,
    business_name: lic.business_name && lic.business_name === lic.business_name.toUpperCase()
      ? titleCase(lic.business_name) : lic.business_name,
    dba: lic.dba ? titleCase(lic.dba) : '',
    license_class: lic.license_class || '',
    license_class_description: lic.license_class_description || '',
    city: titleCase(lic.city),
    state: lic.state || 'AZ',
    expiration_date: lic.expiration_date || '',
    suggested_areas: suggestAreas(lic.city),
  }, 'public, max-age=3600');
};

export const config = { path: '/api/roc' };
