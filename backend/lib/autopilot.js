/**
 * autopilot.js — the record changes that used to wait for a phone call.
 *
 * Pure functions, no I/O: given a client record and what Stripe or the buyer
 * told us, produce the next record. stripe-webhook.js and onboard.js do the
 * reading and writing; test-autopilot.mjs exercises all of this offline.
 *
 *   promote(client, plan, contact)      payment landed → paid tier, demo banner off
 *   sanitizeOnboarding(raw)             the setup form, checked field by field
 *   applyOnboarding(client, fields)     buyer's answers → their record
 *   suggestAreas(city)                  service-area checkboxes for the form
 *   normalizeDomain(input)              "Example.com/" → primary www.example.com
 *   dnsSteps(primary, netlifyHost)      the two records the buyer adds at their registrar
 *
 * Plans and tiers are different words for different things. A *plan* is what
 * was bought (starter / pro / kit — Stripe lookup keys). A *tier* is what the
 * builder makes (lite = one page, full = multi-page). Starter buys the one-page
 * site on the buyer's own domain; Pro and Kit buy the full build.
 */

import ACPSchema from './acp-schema.cjs';
import tradeDefaults from './trade-defaults.cjs';

export const acp = ACPSchema.create(tradeDefaults);

export const PLAN_TIER = { starter: 'lite', pro: 'full', kit: 'full' };
export const PLANS = Object.keys(PLAN_TIER);

/** Opening-hours presets. A free-text box would produce openingHours that fail schema validation. */
export const HOURS = {
  weekdays: 'Mo-Fr 07:00-17:00',
  weekdays_sat: 'Mo-Fr 07:00-17:00, Sa 08:00-14:00',
  six_days: 'Mo-Sa 07:00-18:00',
  every_day: 'Mo-Su 07:00-19:00',
  always: 'Mo-Su 00:00-23:59',
};

/** Communities a contractor in each metro usually serves. Checkbox suggestions only. */
export const METROS = [
  ['Tucson', 'Oro Valley', 'Marana', 'Vail', 'Sahuarita', 'Green Valley', 'Catalina Foothills',
    'Tanque Verde', 'Corona de Tucson', 'South Tucson'],
  ['Phoenix', 'Mesa', 'Chandler', 'Gilbert', 'Scottsdale', 'Tempe', 'Glendale', 'Peoria',
    'Surprise', 'Goodyear', 'Avondale', 'Buckeye', 'Queen Creek', 'San Tan Valley',
    'Fountain Hills', 'Cave Creek'],
  ['Casa Grande', 'Maricopa', 'Eloy', 'Coolidge', 'Florence', 'Arizona City'],
  ['Flagstaff', 'Sedona', 'Williams', 'Munds Park', 'Cottonwood'],
  ['Prescott', 'Prescott Valley', 'Chino Valley', 'Dewey-Humboldt', 'Cottonwood'],
  ['Yuma', 'San Luis', 'Somerton', 'Fortuna Foothills', 'Wellton'],
  ['Sierra Vista', 'Huachuca City', 'Benson', 'Bisbee', 'Tombstone', 'Douglas'],
  ['Kingman', 'Bullhead City', 'Lake Havasu City', 'Fort Mohave', 'Golden Valley'],
  ['Nogales', 'Rio Rico', 'Tubac', 'Patagonia'],
];

const LIMITS = { services: 12, areas: 15, name: 60, area: 40, tagline: 90, notes: 1500, owner: 80 };

const clean = (v, n = 300) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

export function suggestAreas(city) {
  const c = clean(city, 60).toLowerCase();
  const metro = METROS.find((m) => m.some((x) => x.toLowerCase() === c));
  if (metro) return [...metro];
  return c ? [titleCase(c)] : [];
}

/**
 * Domain typed by a buyer → { host, primary } or { error }.
 * Netlify recommends a subdomain as the primary domain on external DNS, and
 * adds the apex automatically when www is assigned, so "example.com" becomes
 * primary "www.example.com" with the bare domain redirecting to it.
 */
export function normalizeDomain(input) {
  let s = clean(input, 255).toLowerCase();
  if (!s) return { host: '', primary: '' };
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(s)) {
    return { error: 'That domain doesn’t look right — it should look like yourbusiness.com' };
  }
  if (/(^|\.)netlify\.app$|(^|\.)azcontractorpro\.(com|net)$/.test(s)) {
    return { error: 'Enter a domain you own (or leave it blank and use the free address for now).' };
  }
  const labels = s.split('.');
  const apex = labels.length === 2;
  return { host: s, primary: apex ? `www.${s}` : s, apex: apex ? s : labels.slice(-2).join('.') };
}

/** The records a buyer adds at their registrar. Values per Netlify's external-DNS docs. */
export function dnsSteps(primary, netlifyHost) {
  if (!primary) return null;
  const isWww = primary.startsWith('www.');
  const apex = isWww ? primary.slice(4) : primary;
  const target = netlifyHost || '<your-site>.netlify.app';
  const steps = [{ type: 'CNAME', host: isWww ? 'www' : primary.split('.')[0], value: target }];
  if (isWww) {
    steps.push({ type: 'A', host: '@', value: '75.2.60.5', note: 'or ALIAS/ANAME @ → apex-loadbalancer.netlify.com if your registrar offers it' });
  }
  return { primary, apex, steps };
}

/** Stripe's "+15204613937" → "(520) 461-3937"; anything else passes through trimmed. */
export const formatPhone = (p) => ACPSchema.formatPhone(clean(p, 40));

/* ------------------------------------------------------------------ promote */

/**
 * The payment just landed. Make the record a paying client's record:
 *   * tier the plan pays for, demo banner + noindex + checkout buttons off
 *   * a site_url so tier=full validates (the netlify address until a domain is set)
 *   * contact details from Checkout only where the record has none
 * Idempotent: promoting twice yields the same record (no new timestamps).
 */
export function promote(client, plan, contact = {}, now = new Date()) {
  if (!PLANS.includes(plan)) throw new Error(`unknown plan: ${plan}`);
  const c = structuredClone(client);
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

  c.tier = PLAN_TIER[plan];
  c.plan = plan;

  const d = (c.deploy = { ...(c.deploy || {}) });
  if (d.demo) {
    d.demo = false;
    d.demo_converted_at = d.demo_converted_at || iso;
  }

  if (!c.email && contact.email) c.email = clean(contact.email, 120);
  if (!c.phone && contact.phone) c.phone = formatPhone(contact.phone);
  if (!c.site_url) c.site_url = d.custom_domain || d.netlify_url || '';

  c.integrations = { ...(c.integrations || {}) };
  if (!c.integrations.notification_email && c.email) c.integrations.notification_email = c.email;

  const o = (c.onboarding = { ...(c.onboarding || {}) });
  if (!o.status) o.status = 'pending';
  if (!o.paid_at) o.paid_at = iso;
  return c;
}

/* --------------------------------------------------------------- onboarding */

/**
 * The setup form → validated fields. Unknown keys are dropped, every string is
 * length-capped, lists are de-duplicated and capped. Returns { fields, errors },
 * errors keyed by field so the page can point at the one to fix.
 */
export function sanitizeOnboarding(raw = {}) {
  const errors = {};
  const f = {};

  const phone = clean(raw.phone, 40);
  if (phone) {
    const d = ACPSchema.digits(phone);
    if (!(d.length === 10 || (d.length === 11 && d[0] === '1'))) errors.phone = 'Enter a 10-digit phone number.';
    else f.phone = formatPhone(phone);
  }

  const email = clean(raw.email, 120);
  if (email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = 'That email address looks incomplete.';
    else f.email = email;
  }

  const list = (v, max, n) => {
    const arr = Array.isArray(v) ? v : String(v || '').split(/[\n,]/);
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      const s = clean(x, n).replace(/[<>{}\\]/g, '');
      const k = s.toLowerCase();
      if (!s || seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      if (out.length >= max) break;
    }
    return out;
  };

  if (raw.services !== undefined) {
    f.services = list(raw.services, LIMITS.services, LIMITS.name);
    if (!f.services.length) errors.services = 'Pick at least one service.';
  }
  if (raw.service_area !== undefined) {
    f.service_area = list(raw.service_area, LIMITS.areas, LIMITS.area)
      .filter((a) => /^[A-Za-z][A-Za-z .'-]+$/.test(a))
      .map((a) => (a === a.toLowerCase() || a === a.toUpperCase() ? titleCase(a) : a));
    if (!f.service_area.length) errors.service_area = 'Pick at least one community you work in.';
  }

  if (raw.hours !== undefined && raw.hours !== '') {
    if (!HOURS[raw.hours]) errors.hours = 'Pick one of the listed schedules.';
    else f.hours = HOURS[raw.hours];
  }

  if (raw.years_in_business !== undefined && raw.years_in_business !== '') {
    const y = Number(raw.years_in_business);
    if (!Number.isInteger(y) || y < 0 || y > 99) errors.years_in_business = 'Years in business should be a whole number.';
    else f.years_in_business = y;
  }

  if (raw.owner !== undefined) f.owner = clean(raw.owner, LIMITS.owner).replace(/[<>{}\\]/g, '');
  if (raw.tagline !== undefined) f.tagline = clean(raw.tagline, LIMITS.tagline).replace(/[<>{}\\]/g, '');
  if (raw.target_customer !== undefined && raw.target_customer !== '') {
    if (!['residential', 'commercial', 'both'].includes(raw.target_customer)) errors.target_customer = 'Pick residential, commercial or both.';
    else f.target_customer = raw.target_customer;
  }
  if (raw.emergency_service !== undefined) f.emergency_service = raw.emergency_service === true || raw.emergency_service === 'yes' || raw.emergency_service === 'on';

  const fb = clean(raw.facebook_url, 200);
  if (fb) {
    if (!/^https:\/\/(www\.|m\.)?facebook\.com\/[A-Za-z0-9.\-_/?=&%]+$/.test(fb)) errors.facebook_url = 'Paste the full link to your Facebook page (https://facebook.com/…).';
    else f.facebook_url = fb;
  }

  const ds = clean(raw.domain_status, 10);
  f.domain_status = ['have', 'need', 'later'].includes(ds) ? ds : 'later';
  if (f.domain_status === 'have') {
    const dn = normalizeDomain(raw.domain);
    if (dn.error) errors.domain = dn.error;
    else if (!dn.host) errors.domain = 'Type the domain you own, or choose "use the free address for now".';
    else f.domain = dn;
  }

  if (raw.notes !== undefined) f.notes = String(raw.notes || '').trim().slice(0, LIMITS.notes);

  return { fields: f, errors };
}

/**
 * Apply sanitized answers to a record. Copy the generator wrote (FAQ, "why us",
 * hero line) is regenerated when the facts under it change — but only if it is
 * still the generated text, so nothing a person wrote by hand is overwritten.
 */
export function applyOnboarding(client, fields, now = new Date()) {
  const before = structuredClone(client);
  const c = structuredClone(client);
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

  if (fields.phone) c.phone = fields.phone;
  if (fields.email) {
    c.email = fields.email;
    c.integrations = { ...(c.integrations || {}), notification_email: fields.email };
  }
  if (fields.services) {
    const prev = new Map((c.services || []).map((s) => [s.slug || ACPSchema.slugify(s.name || ''), s]));
    c.services = fields.services.map((name) => {
      const slug = ACPSchema.slugify(name);
      const old = prev.get(slug);
      return old ? { ...old, name } : { name, slug };
    });
  }
  if (fields.service_area) c.service_area = fields.service_area;
  if (fields.hours) c.hours = fields.hours;
  if (fields.years_in_business !== undefined) c.years_in_business = fields.years_in_business;
  if (fields.owner) {
    c.owner = fields.owner;
    c.owner_first_name = fields.owner.split(' ')[0];
  }
  if (fields.tagline) c.tagline = fields.tagline;
  if (fields.target_customer) c.target_customer = fields.target_customer;
  if (fields.emergency_service !== undefined) c.emergency_service = fields.emergency_service;
  if (fields.facebook_url) c.facebook_url = fields.facebook_url;

  const d = (c.deploy = { ...(c.deploy || {}) });
  if (fields.domain && fields.domain.primary) {
    d.custom_domain = `https://${fields.domain.primary}`;
    c.site_url = d.custom_domain;
  }

  // Regenerate derived copy that is still exactly what the generator produced.
  const factsChanged = ['services', 'service_area', 'phone', 'owner', 'years_in_business']
    .some((k) => JSON.stringify(before[k]) !== JSON.stringify(c[k]));
  if (factsChanged) {
    const generated = acp.resolve({ ...before, faqs: [], why_us: [], hero_subhead: '' });
    for (const k of ['faqs', 'why_us', 'hero_subhead']) {
      if (JSON.stringify(before[k]) === JSON.stringify(generated[k])) {
        c[k] = k === 'hero_subhead' ? '' : [];
      }
    }
  }

  c.onboarding = {
    ...(c.onboarding || {}),
    status: 'submitted',
    submitted_at: iso,
    domain_status: fields.domain_status || (c.onboarding || {}).domain_status || 'later',
  };
  if (fields.domain && fields.domain.primary) c.onboarding.domain = fields.domain.primary;
  return acp.resolve(c);
}

/** What the form shows: current answers, with suggestions for the checkboxes. */
export function formContext(client) {
  const c = acp.resolve(client || {});
  const spec = acp.trades[c.trade] || acp.trades.general;
  const current = (c.services || []).map((s) => s.name);
  const suggested = [...new Set([...current, ...spec.default_services.map((s) => s.name)])];
  const areas = [...new Set([...(c.service_area || []), ...suggestAreas(c.city)])];
  const hoursKey = Object.keys(HOURS).find((k) => HOURS[k] === c.hours) || '';
  return {
    business_name: c.business_name || '',
    roc_number: c.roc_number || '',
    license_class: c.license_class || '',
    trade: c.trade,
    trade_label: spec.label,
    city: c.city || '',
    phone: c.phone || '',
    email: c.integrations?.notification_email || c.email || '',
    owner: c.owner || '',
    tagline: c.tagline || '',
    years_in_business: c.years_in_business ?? '',
    target_customer: c.target_customer || 'both',
    emergency_service: !!c.emergency_service,
    facebook_url: c.facebook_url || '',
    hours: hoursKey,
    services: current,
    suggested_services: suggested,
    service_area: c.service_area || [],
    suggested_areas: areas,
    domain: (c.onboarding || {}).domain || '',
    domain_status: (c.onboarding || {}).domain_status || '',
  };
}
