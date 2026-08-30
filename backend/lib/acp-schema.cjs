/**
 * acp-schema.js — AZ Contractor Pro canonical client record (JS twin).
 *
 * Mirrors acp_schema.py exactly. The builder and the acp-backend Netlify
 * function use this; build_site.py and the marketing generator use the Python
 * one. test_parity.py runs both against the same fixtures and fails CI on any
 * divergence — so if you change logic here, change it there in the same commit.
 *
 * Node:
 *     const { create } = require('./acp-schema.js');
 *     const acp = create(require('./trade_defaults.json'));
 *
 * Browser:
 *     const defaults = await (await fetch(BACKEND + '/trade-defaults')).json();
 *     const acp = ACPSchema.create(defaults);
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ACPSchema = factory();
  // `this` is undefined at the top level of an ES module, so fall back to
  // globalThis — otherwise loading this file as ESM throws before it exports.
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  const SCHEMA_VERSION = '1.0';
  const REQUIRED = ['business_name', 'trade', 'phone', 'city', 'state', 'zip'];
  const REQUIRED_FULL = ['email', 'roc_number', 'license_class', 'site_url'];
  const TIERS = ['lite', 'full'];

  /* ------------------------------------------------------------ primitives */

  function slugify(value) {
    let s = String(value == null ? '' : value).normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')          // strip combining marks
      .replace(/[^\x00-\x7F]/g, '')             // ascii only, same as Python
      .toLowerCase().trim();
    s = s.replace(/[^a-z0-9\s-]/g, '');
    s = s.replace(/[\s-]+/g, '-');
    return s.replace(/^-+|-+$/g, '');
  }

  function shade(hexColor, pct) {
    let h = String(hexColor || '#000000').replace(/^#/, '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    const out = rgb.map(c => {
      const v = pct > 0 ? c + (255 - c) * pct : c * (1 + pct);
      return Math.max(0, Math.min(255, Math.round(v)));
    });
    return '#' + out.map(c => c.toString(16).padStart(2, '0')).join('');
  }

  const digits = v => String(v == null ? '' : v).replace(/\D/g, '');

  function tel(phone) {
    const d = digits(phone);
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return d ? '+' + d : '';
  }

  function formatPhone(phone) {
    let d = digits(phone);
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    return String(phone == null ? '' : phone).trim();
  }

  function splitList(value) {
    const items = Array.isArray(value)
      ? value.map(v => String(v).trim())
      : String(value == null ? '' : value).split(/[;,|]|\n/).map(p => p.trim());
    const seen = new Set(); const out = [];
    for (const item of items) {
      if (item && !seen.has(item.toLowerCase())) { seen.add(item.toLowerCase()); out.push(item); }
    }
    return out;
  }

  const normKey = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');

  function truthy(v) {
    if (typeof v === 'boolean') return v;
    return ['yes', 'y', 'true', '1', 'on'].includes(String(v == null ? '' : v).trim().toLowerCase());
  }

  const clone = o => JSON.parse(JSON.stringify(o));

  /** Stable serialization — sorted keys, matching Python's json.dumps(sort_keys=True). */
  function dumps(obj) {
    const sort = v => {
      if (Array.isArray(v)) return v.map(sort);
      if (v && typeof v === 'object') {
        return Object.keys(v).sort().reduce((a, k) => { a[k] = sort(v[k]); return a; }, {});
      }
      return v;
    };
    return JSON.stringify(sort(obj), null, 2);
  }

  /* ------------------------------------------------------- roster mapping */

  const ROC_HEADER_ALIASES = {
    business_name: ['businessname', 'dbaname', 'doingbusinessas', 'companyname', 'name', 'licensename'],
    owner: ['qualifyingparty', 'qualifier', 'ownername', 'owner', 'principal', 'contactname'],
    roc_number: ['rocnumber', 'licensenumber', 'licenseno', 'license', 'roc', 'licensenum'],
    license_class: ['class', 'licenseclass', 'classification', 'classcode', 'licensetype'],
    license_class_description: ['classificationdescription', 'classdescription', 'licensedescription', 'description'],
    roc_status: ['licensestatus', 'status', 'rocstatus'],
    phone: ['phone', 'phonenumber', 'businessphone', 'telephone', 'primaryphone', 'mainphone'],
    email: ['email', 'emailaddress', 'businessemail', 'contactemail'],
    city: ['city', 'mailingcity', 'businesscity', 'addresscity'],
    state: ['state', 'mailingstate', 'businessstate'],
    zip: ['zip', 'zipcode', 'postalcode', 'mailingzip', 'businesszip'],
    site_url: ['website', 'websiteurl', 'url', 'weburl', 'homepage', 'siteurl'],
    facebook_url: ['facebook', 'facebookurl', 'facebookpage'],
    service_area: ['servicearea', 'areasserved', 'citiesserved', 'coverage'],
    specialties: ['specialties', 'services', 'specialty', 'trades'],
    years_in_business: ['yearsinbusiness', 'years', 'established', 'yearestablished'],
    trade: ['trade', 'primarytrade'],
  };

  function mapHeaders(headers) {
    const out = {}; const used = new Set();
    const normalized = headers.map(h => [h, normKey(h)]);
    const mapped = new Set();
    for (const field of Object.keys(ROC_HEADER_ALIASES)) {
      for (const alias of ROC_HEADER_ALIASES[field]) {
        const hit = normalized.find(([h, n]) => n === alias && !used.has(h));
        if (hit) { out[hit[0]] = field; used.add(hit[0]); mapped.add(field); break; }
      }
    }
    for (const field of Object.keys(ROC_HEADER_ALIASES)) {
      if (mapped.has(field)) continue;
      for (const alias of ROC_HEADER_ALIASES[field]) {
        const hit = normalized.find(([h, n]) =>
          !used.has(h) && n.length > 2 && (n.includes(alias) || alias.includes(n)));
        if (hit) { out[hit[0]] = field; used.add(hit[0]); mapped.add(field); break; }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ main class */

  function create(defaults) {
    if (!defaults || !defaults.trades) throw new Error('acp-schema: trade_defaults.json required');
    const TRADES = defaults.trades;
    const ROC = defaults.roc;

    function normalizeTrade(value) {
      const v = String(value == null ? '' : value).trim().toLowerCase();
      if (!v) return null;
      if (TRADES[v]) return v;
      for (const key of Object.keys(TRADES)) {
        if (v === TRADES[key].label.toLowerCase()) return key;
      }
      for (const key of Object.keys(TRADES)) {
        if (TRADES[key].keywords.some(kw => v.includes(kw))) return key;
      }
      return null;
    }

    /**
     * Returns [trade, confidence, reason].
     * General classes match as WHOLE CODES before any numeric-suffix lookup.
     * That ordering is the KB-2 fix: 'KB-2' is a dual general license, and
     * reading its '-2' as a specialty suffix produced 'Excavating'.
     */
    function inferTrade(licenseClass, description, businessName, specialties, alsoHolds) {
      const cls = String(licenseClass || '').trim().toUpperCase().replace(/\s/g, '');
      const blob = [description, businessName, specialties]
        .filter(Boolean).join(' ').trim();

      const hit = ROC.class_map[cls];
      if (hit) {
        if (hit.trade === 'general') {
          const byKw = normalizeTrade(blob);
          if (byKw && byKw !== 'general') {
            return [byKw, 'medium', `general class ${cls}, narrowed by name/description`];
          }
          // A general licensee holding a specialty license is telling you what
          // they actually do. See acp_schema.py for the tie-break rule.
          const held = specialtiesHeld(alsoHolds);
          if (held.length) {
            const [trade, n] = held[0];
            const conf = (n > 1 || held.length === 1) ? 'medium' : 'low';
            return [trade, conf, `general class ${cls}, sharpened by secondary license`];
          }
        }
        return [hit.trade, hit.confidence, `class ${cls}`];
      }

      const byKw = normalizeTrade(blob);
      if (byKw) return [byKw, 'low', 'keyword match, class code unrecognized'];

      const held = specialtiesHeld(alsoHolds);
      if (held.length) return [held[0][0], 'low', 'secondary license only'];

      return ['general', 'low', 'no signal, defaulted'];
    }

    /** [[trade, count]] for non-general secondary licenses, most-held first. */
    function specialtiesHeld(alsoHolds) {
      const counts = new Map();
      for (const code of (alsoHolds || [])) {
        const hit = ROC.class_map[String(code).trim().toUpperCase()];
        if (!hit || hit.trade === 'general') continue;
        counts.set(hit.trade, (counts.get(hit.trade) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }

    /** (state, missing[]) — see acp_schema.py readiness() for the rationale. */
    function readiness(client) {
      const c = client || {};
      const missing = ['phone', 'city', 'zip', 'business_name'].filter(f => !c[f]);
      if (missing.length) return ['prospect', missing];
      const missingFull = REQUIRED_FULL.filter(f => !c[f]);
      if (!missingFull.length && (c.integrations || {}).lead_endpoint) return ['ready_full', []];
      return ['ready_lite', missingFull];
    }

    function blank() {
      return {
        schema_version: SCHEMA_VERSION, client_id: '', tier: 'lite',
        business_name: '', short_name: '', owner: '', owner_first_name: '',
        trade: '', trade_confidence: '',
        roc_number: '', license_class: '', license_class_description: '', roc_status: 'Active',
        phone: '', email: '', site_url: '', facebook_url: '',
        city: '', state: 'AZ', zip: '', service_area: [],
        years_in_business: null, hours: '', tagline: '', hero_subhead: '',
        target_customer: 'both', emergency_service: false, payment_plans: '',
        theme: {}, services: [], why_us: [], faqs: [], reviews: [],
        integrations: {
          lead_endpoint: '', gallery_endpoint: '', portal_url: '',
          google_place_id: '', facebook_page_id: '', notification_email: '',
        },
        deploy: {
          netlify_site_id: '', netlify_url: '', custom_domain: '', repo: '',
          claim_link_sent_at: '', claimed_at: '', last_built_at: '', last_tier_built: '',
        },
        marketing: {},
      };
    }

    function fromRocRow(row, headerMap) {
      const hm = headerMap || mapHeaders(Object.keys(row));
      const picked = {};
      for (const header of Object.keys(hm)) {
        const val = row[header];
        if (val !== undefined && val !== null && val !== '') {
          const field = hm[header];
          if (picked[field] === undefined) picked[field] = String(val).trim();
        }
      }
      const g = k => picked[k] || '';

      const c = blank();
      c.business_name = g('business_name');
      c.owner = g('owner');
      c.roc_number = digits(g('roc_number'));
      c.license_class = g('license_class').trim().toUpperCase();
      c.license_class_description = g('license_class_description');
      c.roc_status = g('roc_status') || 'Active';
      c.phone = formatPhone(g('phone'));
      c.email = g('email');
      c.site_url = g('site_url');
      c.facebook_url = g('facebook_url');
      c.city = g('city');
      c.state = (g('state') || 'AZ').toUpperCase().slice(0, 2);
      c.zip = digits(g('zip')).slice(0, 5);
      c.service_area = splitList(g('service_area'));
      if (!c.service_area.length && c.city) c.service_area = [c.city];

      const years = digits(g('years_in_business'));
      c.years_in_business = years ? parseInt(years, 10) : null;

      const [trade, conf] = inferTrade(
        c.license_class, c.license_class_description, c.business_name, g('specialties'));
      c.trade = normalizeTrade(g('trade')) || trade;
      c.trade_confidence = conf;

      if (g('specialties')) {
        c.services = splitList(g('specialties')).map(s => ({ slug: slugify(s), name: s, summary: '' }));
      }
      return c;
    }

    function fromClientInfoBlock(text) {
      const raw = {};
      if (text && typeof text === 'object') {
        for (const k of Object.keys(text)) raw[normKey(k)] = String(text[k] == null ? '' : text[k]).trim();
      } else {
        for (const line of String(text || '').split('\n')) {
          const i = line.indexOf(':');
          if (i === -1) continue;
          raw[normKey(line.slice(0, i))] = line.slice(i + 1).trim();
        }
      }
      const g = (key, dflt) => {
        const v = raw[normKey(key)] !== undefined ? raw[normKey(key)] : (dflt || '');
        return ['n/a', 'na', 'tbd', 'none'].includes(String(v).toLowerCase()) ? '' : v;
      };

      const c = blank();
      c.business_name = g('BUSINESS_NAME');
      c.owner = g('OWNER_NAME');
      c.owner_first_name = g('OWNER_FIRST_NAME') || c.owner.split(' ')[0];
      c.roc_number = digits(g('ROC_NUMBER'));
      c.license_class = g('LICENSE_CLASS').toUpperCase();
      c.roc_status = g('ROC_STATUS') || 'Active';
      c.phone = formatPhone(g('PHONE'));
      c.email = g('EMAIL');
      c.site_url = g('WEBSITE_URL');
      c.facebook_url = g('FACEBOOK_URL');
      c.city = g('CITY');
      c.state = (g('STATE') || 'AZ').toUpperCase().slice(0, 2);
      c.zip = digits(g('ZIP')).slice(0, 5);
      c.service_area = splitList(g('SERVICE_AREA'));
      if (!c.service_area.length && c.city) c.service_area = [c.city];
      const years = digits(g('YEARS_IN_BUSINESS'));
      c.years_in_business = years ? parseInt(years, 10) : null;
      c.target_customer = (g('TARGET_CUSTOMER') || 'both').toLowerCase();
      c.emergency_service = truthy(g('EMERGENCY_SERVICE'));
      const pp = g('PAYMENT_PLANS');
      c.payment_plans = ['no', ''].includes(pp.toLowerCase()) ? '' : pp;

      const tagline = g('TAGLINE');
      c.tagline = tagline.toLowerCase() === 'auto' ? '' : tagline;

      const primary = g('PRIMARY_COLOR_HEX');
      const accent = g('ACCENT_COLOR_HEX');
      const theme = {};
      if (primary && primary.toLowerCase() !== 'auto') theme.primary = primary;
      if (accent && accent.toLowerCase() !== 'auto') theme.accent = accent;
      c.theme = theme;

      let trade = normalizeTrade(g('TRADE'));
      if (!trade) {
        const [t, conf] = inferTrade(c.license_class, '', c.business_name, g('SPECIALTIES'));
        trade = t; c.trade_confidence = conf;
      } else {
        c.trade_confidence = 'high';
      }
      c.trade = trade;

      if (g('SPECIALTIES')) {
        c.services = splitList(g('SPECIALTIES')).map(s => ({ slug: slugify(s), name: s, summary: '' }));
      }

      c.integrations.lead_endpoint = g('GOOGLE_SHEET_URL');
      c.integrations.notification_email = g('NOTIFICATION_EMAIL') || c.email;
      c.integrations.google_place_id = g('GOOGLE_PLACE_ID');
      c.integrations.facebook_page_id = g('FACEBOOK_PAGE_ID');
      return c;
    }

    const FORM_ALIAS = {
      businessName: 'business_name', business: 'business_name',
      ownerName: 'owner', owner_name: 'owner',
      rocNumber: 'roc_number', roc: 'roc_number',
      licenseClass: 'license_class', class: 'license_class',
      serviceArea: 'service_area', cities: 'service_area',
      websiteUrl: 'site_url', website: 'site_url',
      notificationEmail: 'notification_email',
      leadEndpoint: 'lead_endpoint', sheetUrl: 'lead_endpoint',
      yearsInBusiness: 'years_in_business',
      emergencyService: 'emergency_service',
      targetCustomer: 'target_customer',
    };

    function fromBuilderForm(form) {
      const flat = {};
      for (const k of Object.keys(form || {})) flat[FORM_ALIAS[k] || k] = form[k];

      const c = fromClientInfoBlock({
        BUSINESS_NAME: flat.business_name || '',
        OWNER_NAME: flat.owner || '',
        TRADE: flat.trade || '',
        LICENSE_CLASS: flat.license_class || '',
        ROC_NUMBER: flat.roc_number || '',
        PHONE: flat.phone || '',
        CITY: flat.city || '',
        STATE: flat.state || 'AZ',
        ZIP: flat.zip || '',
        SERVICE_AREA: flat.service_area || '',
        EMAIL: flat.email || '',
        WEBSITE_URL: flat.site_url || '',
        FACEBOOK_URL: flat.facebook_url || '',
        YEARS_IN_BUSINESS: flat.years_in_business || '',
        SPECIALTIES: flat.specialties || '',
        TAGLINE: flat.tagline || '',
        TARGET_CUSTOMER: flat.target_customer || '',
        EMERGENCY_SERVICE: flat.emergency_service || '',
        GOOGLE_SHEET_URL: flat.lead_endpoint || '',
        NOTIFICATION_EMAIL: flat.notification_email || '',
      });

      for (const key of ['hero_subhead', 'why_us', 'faqs', 'reviews', 'hours']) {
        if (flat[key]) c[key] = flat[key];
      }
      if (Array.isArray(flat.services) && flat.services.length) c.services = flat.services;
      if (flat.theme && typeof flat.theme === 'object') {
        for (const k of Object.keys(flat.theme)) if (flat.theme[k]) c.theme[k] = flat.theme[k];
      }
      if (TIERS.includes(flat.tier)) c.tier = flat.tier;
      return c;
    }

    function toClientInfoBlock(client) {
      const c = client;
      const spec = TRADES[c.trade || 'general'] || TRADES.general;
      const theme = c.theme || {};
      const integ = c.integrations || {};
      const rows = [
        ['BUSINESS_NAME', c.business_name || ''],
        ['OWNER_NAME', c.owner || ''],
        ['OWNER_FIRST_NAME', c.owner_first_name || ''],
        ['TRADE', spec.label],
        ['LICENSE_CLASS', c.license_class || ''],
        ['ROC_NUMBER', c.roc_number || ''],
        ['ROC_STATUS', c.roc_status || 'Active'],
        ['PHONE', c.phone || ''],
        ['CITY', c.city || ''],
        ['STATE', c.state || 'AZ'],
        ['ZIP', c.zip || ''],
        ['SERVICE_AREA', (c.service_area || []).join(', ')],
        ['EMAIL', c.email || 'N/A'],
        ['WEBSITE_URL', c.site_url || 'N/A'],
        ['FACEBOOK_URL', c.facebook_url || 'N/A'],
        ['GOOGLE_PLACE_ID', integ.google_place_id || 'N/A'],
        ['FACEBOOK_PAGE_ID', integ.facebook_page_id || 'N/A'],
        ['YEARS_IN_BUSINESS', c.years_in_business || 'N/A'],
        ['SPECIALTIES', (c.services || []).map(s => s.name).join(', ')],
        ['TAGLINE', c.tagline || 'auto'],
        ['PRIMARY_COLOR_HEX', theme.primary || 'auto'],
        ['ACCENT_COLOR_HEX', theme.accent || 'auto'],
        ['TARGET_CUSTOMER', titleCase(c.target_customer || 'both')],
        ['EMERGENCY_SERVICE', c.emergency_service ? 'Yes' : 'No'],
        ['PAYMENT_PLANS', c.payment_plans || 'No'],
        ['GOOGLE_SHEET_URL', integ.lead_endpoint || 'TBD'],
        ['NOTIFICATION_EMAIL', integ.notification_email || c.email || ''],
      ];
      const width = Math.max(...rows.map(r => r[0].length)) + 2;
      return rows.map(([k, v]) => (k + ':').padEnd(width) + String(v)).join('\n');
    }

    function titleCase(s) {
      return String(s).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
    }

    function whyUs(c, spec) {
      const out = [];
      if (c.roc_number) {
        out.push(`Licensed, bonded, and insured — ROC #${c.roc_number}, `
          + 'verifiable at azroc.gov in about thirty seconds');
      } else {
        out.push('Licensed, bonded, and insured in the State of Arizona');
      }
      out.push('Free on-site estimates, written before any work starts');
      out.push('The same crew from the first day to the final walkthrough');
      if (c.years_in_business) {
        const area = (c.service_area && c.service_area[0]) || c.city || 'Arizona';
        out.push(`${c.years_in_business} years of ${area} `
          + `${spec.label.toLowerCase()} work still standing`);
      }
      if (c.emergency_service) out.push("Emergency service available when something can't wait");
      return out;
    }

    function faqs(c, spec) {
      const name = c.business_name || 'We';
      const areas = (c.service_area || []).join(', ') || c.city || 'Arizona';
      const svc = (c.services || []).slice(0, 4).map(s => s.name.toLowerCase()).join(', ');
      const lic = c.roc_number
        ? `Yes. ${name} holds Arizona ROC license #${c.roc_number}`
          + (c.license_class ? `, a ${c.license_class} classification` : '')
          + ', and carries liability insurance. You can verify it at azroc.gov.'
        : `Yes. ${name} is a licensed and insured Arizona contractor.`;
      return [
        { q: `Is ${name} licensed and insured?`, a: lic },
        { q: 'What areas do you serve?', a: `We serve ${areas} and the surrounding communities.` },
        {
          q: 'Do you charge for estimates?',
          a: 'No. Estimates are free and done on site, and you get the scope and price '
            + `in writing before anyone starts work. Call ${c.phone || 'us'} to schedule.`,
        },
        {
          q: `What ${spec.label.toLowerCase()} services do you offer?`,
          a: svc ? `We handle ${svc}.` : `We handle a full range of ${spec.label.toLowerCase()} work.`,
        },
        {
          q: 'How long does a typical project take?',
          a: 'It depends on scope, but you get a schedule in writing with the estimate — '
            + 'including what happens if weather or inspections move a date.',
        },
        {
          q: 'How do I verify your contractor license?',
          a: `Search ROC #${c.roc_number || ''} at azroc.gov. It takes about thirty seconds `
            + 'and shows license status, classification, and any complaint history.',
        },
      ];
    }

    function resolve(client) {
      const c = clone(client);

      const trade = normalizeTrade(c.trade) || 'general';
      c.trade = trade;
      const spec = TRADES[trade];

      if (!c.client_id) c.client_id = slugify(c.business_name || '') || ('roc-' + (c.roc_number || ''));
      if (!TIERS.includes(c.tier)) c.tier = 'lite';
      if (!c.short_name) {
        c.short_name = String(c.business_name || '')
          .replace(/(\s*,?\s*(LLC|L\.L\.C\.|Inc\.?|Incorporated|Co\.?|Corp\.?))+$/i, '').trim();
      }
      if (!c.owner_first_name && c.owner) c.owner_first_name = c.owner.split(' ')[0];

      const t = Object.assign({}, spec.theme);
      for (const k of Object.keys(c.theme || {})) if (c.theme[k]) t[k] = c.theme[k];
      t.primary_light = shade(t.primary, 0.18);
      t.primary_dark = shade(t.primary, -0.22);
      t.accent_dark = shade(t.accent, -0.18);
      t.google_fonts = [defaults.fonts[t.display_font] || '', defaults.fonts[t.body_font] || '']
        .filter(Boolean).join('|');
      c.theme = t;

      if (!c.tagline) c.tagline = spec.tagline;
      if (!c.hours) c.hours = defaults._meta.hours_default;
      if (!c.service_area || !c.service_area.length) c.service_area = c.city ? [c.city] : [];
      if (!c.hero_subhead) {
        const area = c.service_area[0] || c.city || 'Arizona';
        c.hero_subhead = `Licensed ${spec.label.toLowerCase()} work in ${area} — free written estimates, `
          + 'and the same crew from first day to final walkthrough.';
      }

      if (!c.services || !c.services.length) {
        c.services = spec.default_services.map(s => Object.assign({}, s));
      } else {
        const bySlug = {};
        spec.default_services.forEach(s => { bySlug[s.slug] = s; });
        for (const svc of c.services) {
          if (!svc.slug) svc.slug = slugify(svc.name || '');
          if (!svc.summary) {
            const match = bySlug[svc.slug];
            svc.summary = match ? match.summary
              : `${svc.name || ''} for ${c.city || ''} homeowners, done by a licensed crew.`.trim();
          }
        }
      }

      if (!c.why_us || !c.why_us.length) c.why_us = whyUs(c, spec);
      if (!c.faqs || !c.faqs.length) c.faqs = faqs(c, spec);

      c.marketing = Object.assign({
        gbp_primary_category: spec.gbp.primary,
        gbp_secondary_category: spec.gbp.secondary,
        fb_interests: spec.fb_interests.slice(),
      }, c.marketing || {});

      c.integrations = c.integrations || {};
      if (!c.integrations.notification_email) c.integrations.notification_email = c.email || '';
      if (!c.deploy) c.deploy = blank().deploy;
      c.schema_version = SCHEMA_VERSION;
      return c;
    }

    function validate(client) {
      const p = []; const c = client || {};
      const push = (level, field, message) => p.push({ level, field, message });

      for (const f of REQUIRED) if (!c[f]) push('error', f, `${f} is required`);
      if (!TIERS.includes(c.tier)) push('error', 'tier', `tier must be one of ${TIERS.join(', ')}`);
      if (c.trade && !TRADES[c.trade]) push('error', 'trade', `unknown trade '${c.trade}'`);

      const d = digits(c.phone);
      if (c.phone && d.length !== 10 && d.length !== 11) {
        push('error', 'phone', `phone has ${d.length} digits, expected 10`);
      }
      if (c.zip && digits(c.zip).length !== 5) push('warn', 'zip', 'zip is not 5 digits');
      if (c.email && !String(c.email).includes('@')) push('error', 'email', 'email is not an address');

      for (const f of ['site_url', 'facebook_url']) {
        const v = c[f];
        if (v && !/^https?:\/\//.test(String(v))) push('warn', f, `${f} is missing the scheme`);
      }
      if (!((c.integrations || {}).lead_endpoint)) {
        push('warn', 'integrations.lead_endpoint',
          'no lead endpoint — the quote form will not deliver leads');
      }
      if (c.trade_confidence === 'low') {
        push('warn', 'trade', 'trade was inferred with low confidence — check before publishing');
      }
      if (c.roc_status && !['active', 'current'].includes(String(c.roc_status).toLowerCase())) {
        push('warn', 'roc_status',
          `ROC status is '${c.roc_status}' — do not publish claims of licensure`);
      }
      if (c.tier === 'full') {
        for (const f of REQUIRED_FULL) {
          if (!c[f]) push('error', f, `${f} is required for a tier=full site`);
        }
        const integ = c.integrations || {};
        for (const f of ['gallery_endpoint', 'portal_url']) {
          if (!integ[f]) push('warn', `integrations.${f}`, `tier=full without ${f} — client cannot self-serve`);
        }
      }
      const slugs = (c.services || []).map(s => s.slug);
      const dupes = [...new Set(slugs.filter(s => slugs.filter(x => x === s).length > 1))].sort();
      for (const s of dupes) {
        push('error', 'services', `duplicate service slug '${s}' — pages would overwrite each other`);
      }
      return p;
    }

    function stamp(client, tier, siteId, url) {
      const c = Object.assign({}, client);
      const d = Object.assign({}, c.deploy || {});
      d.last_built_at = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
      d.last_tier_built = tier;
      if (siteId) d.netlify_site_id = siteId;
      if (url) d.netlify_url = url;
      c.deploy = d;
      return c;
    }

    return {
      SCHEMA_VERSION, TIERS, defaults, trades: TRADES,
      slugify, shade, tel, digits, formatPhone, splitList, normKey, truthy, dumps, mapHeaders,
      normalizeTrade, inferTrade, blank,
      fromRocRow, fromClientInfoBlock, fromBuilderForm, toClientInfoBlock,
      resolve, validate, stamp, readiness,
    };
  }

  return { create, slugify, shade, tel, digits, formatPhone, splitList, normKey, truthy, dumps, mapHeaders, SCHEMA_VERSION, TIERS };
}));
