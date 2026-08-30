/**
 * router.gs — AZ Contractor Pro, single Apps Script endpoint.
 *
 * One deployment serves every client and both site tiers. Requests are routed
 * on `action`, and every lead carries a `client_id` that the Registry sheet
 * maps to a destination. Adding a client means adding a row, not redeploying.
 *
 *   action=lead      POST   capture a quote request      -> Leads sheet + email
 *   action=gallery   GET    list photos for a client     -> Drive folder
 *   action=portal    GET    client's own leads           -> requires PIN
 *   action=claimed   POST   record a site claim          -> Claims sheet
 *   action=health    GET    deployment check
 *
 * ---------------------------------------------------------------------------
 * CORS, and why the client must post text/plain
 * ---------------------------------------------------------------------------
 * Apps Script web apps do not answer CORS preflight (OPTIONS) requests. Any
 * fetch that triggers preflight fails, and it fails silently from the visitor's
 * point of view — the form appears to submit and the lead is gone.
 *
 * A request avoids preflight only if it is a "simple request": no custom
 * headers, and Content-Type is text/plain, form-urlencoded, or multipart. So
 * the site posts a JSON *string* with Content-Type text/plain. Do not "fix"
 * this to application/json. See lead-form.js.
 * ---------------------------------------------------------------------------
 *
 * SETUP — see apps-script/README.md. In short:
 *   1. Create a spreadsheet with a `Registry` tab (headers below).
 *   2. Script Properties: REGISTRY_ID, ADMIN_EMAIL, optionally PORTAL_SALT.
 *   3. Deploy > New deployment > Web app > Execute as: Me,
 *      Who has access: Anyone. Copy the /exec URL.
 *   4. Put that URL in each client's integrations.lead_endpoint.
 */

// Registry tab columns, in order. Extra columns are ignored.
var REGISTRY_COLUMNS = [
  'client_id', 'business_name', 'notification_email', 'leads_sheet_id',
  'drive_folder_id', 'portal_pin', 'status'
];

var LEAD_COLUMNS = [
  'timestamp', 'client_id', 'name', 'phone', 'email', 'service',
  'message', 'page', 'source', 'user_agent', 'dedupe_key'
];

var MAX_FIELD = 2000;          // truncate anything longer; nothing legitimate is
var DEDUPE_WINDOW_MIN = 10;    // identical submissions inside this window drop


/* ============================================================ entry points */

function doPost(e) {
  return handle(e, 'POST');
}

function doGet(e) {
  return handle(e, 'GET');
}

function handle(e, method) {
  try {
    var params = (e && e.parameter) || {};
    var body = {};
    if (method === 'POST' && e && e.postData && e.postData.contents) {
      try {
        body = JSON.parse(e.postData.contents);
      } catch (err) {
        // Also accept form-encoded posts so a no-JS <form> fallback works.
        body = params;
      }
    }
    var action = String(body.action || params.action || 'lead').toLowerCase();

    switch (action) {
      case 'lead':    return json(handleLead(body, params));
      case 'gallery': return json(handleGalleryFromManifest(params));
      case 'portal':  return json(handlePortal(params));
      case 'claimed': return json(handleClaimed(body, params));
      case 'health':  return json({ ok: true, version: '1.1', time: nowIso() });
      default:        return json({ ok: false, error: 'unknown action: ' + action }, 400);
    }
  } catch (err) {
    // Never leak a stack trace to the page, but keep it in the execution log.
    console.error(err && err.stack ? err.stack : err);
    return json({ ok: false, error: 'server error' }, 500);
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ================================================================ registry */

function props() {
  return PropertiesService.getScriptProperties();
}

/** Registry rows keyed by client_id. Cached 5 min — it changes rarely. */
function getRegistry() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('registry');
  if (hit) return JSON.parse(hit);

  var id = props().getProperty('REGISTRY_ID');
  if (!id) throw new Error('REGISTRY_ID script property is not set');

  var sheet = SpreadsheetApp.openById(id).getSheetByName('Registry');
  if (!sheet) throw new Error('Registry tab not found in spreadsheet ' + id);

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};

  var header = values[0].map(function (h) {
    return String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  });

  var out = {};
  for (var i = 1; i < values.length; i++) {
    var row = {};
    for (var c = 0; c < header.length; c++) row[header[c]] = String(values[i][c] || '').trim();
    if (row.client_id) out[row.client_id] = row;
  }
  cache.put('registry', JSON.stringify(out), 300);
  return out;
}

/** Call after editing the Registry so the change takes effect immediately. */
function flushRegistryCache() {
  CacheService.getScriptCache().remove('registry');
}


/* ==================================================================== lead */

function handleLead(body, params) {
  var data = {};
  Object.keys(body || {}).forEach(function (k) { data[k] = body[k]; });
  Object.keys(params || {}).forEach(function (k) { if (data[k] === undefined) data[k] = params[k]; });

  // Honeypot. A real visitor never fills a hidden field. Return ok so the bot
  // sees success and does not retry with a different shape.
  if (String(data.company_website || data.hp || '').trim()) {
    return { ok: true, id: 'ignored' };
  }

  var clientId = clean(data.client_id);
  if (!clientId) return { ok: false, error: 'client_id is required' };

  var registry = getRegistry();
  var client = registry[clientId];
  if (!client) return { ok: false, error: 'unknown client_id' };
  if (client.status && client.status.toLowerCase() === 'disabled') {
    return { ok: false, error: 'client is not accepting leads' };
  }

  var name = clean(data.name);
  var phone = clean(data.phone);
  var email = clean(data.email);
  if (!name) return { ok: false, error: 'name is required' };
  if (!phone && !email) return { ok: false, error: 'a phone or email is required' };

  var record = {
    timestamp: nowIso(),
    client_id: clientId,
    name: name,
    phone: phone,
    email: email,
    service: clean(data.service),
    message: clean(data.message),
    page: clean(data.page),
    source: clean(data.source) || 'website',
    user_agent: clean(data.user_agent),
    dedupe_key: ''
  };
  record.dedupe_key = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
      [clientId, name, phone, email, record.message].join('|')));

  // A double-click must not create two leads. Lock so concurrent submissions
  // for the same client cannot interleave the read-then-append.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = leadsSheetFor(client);
    if (isDuplicate(sheet, record)) return { ok: true, id: 'duplicate' };
    sheet.appendRow(LEAD_COLUMNS.map(function (c) { return record[c]; }));
  } finally {
    lock.releaseLock();
  }

  notify(client, record);
  return { ok: true, id: record.dedupe_key.substring(0, 10) };
}

function leadsSheetFor(client) {
  // Each client can have their own spreadsheet; otherwise everything lands in
  // the registry spreadsheet on a per-client tab.
  var ssId = client.leads_sheet_id || props().getProperty('REGISTRY_ID');
  var ss = SpreadsheetApp.openById(ssId);
  var tabName = client.leads_sheet_id ? 'Leads' : ('Leads_' + client.client_id).substring(0, 99);

  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(LEAD_COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, LEAD_COLUMNS.length).setFontWeight('bold');
  }
  return sheet;
}

function isDuplicate(sheet, record) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var start = Math.max(2, last - 24);          // only the recent tail
  var rows = sheet.getRange(start, 1, last - start + 1, LEAD_COLUMNS.length).getValues();
  var keyCol = LEAD_COLUMNS.indexOf('dedupe_key');
  var cutoff = Date.now() - DEDUPE_WINDOW_MIN * 60 * 1000;

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyCol]) !== record.dedupe_key) continue;
    var t = Date.parse(rows[i][0]);
    if (!isNaN(t) && t >= cutoff) return true;
  }
  return false;
}

function notify(client, record) {
  var to = client.notification_email || props().getProperty('ADMIN_EMAIL');
  if (!to) return;

  var subject = 'New lead — ' + (client.business_name || client.client_id) +
    ' — ' + record.name;
  var lines = [
    'Name:    ' + record.name,
    'Phone:   ' + (record.phone || '—'),
    'Email:   ' + (record.email || '—'),
    'Service: ' + (record.service || '—'),
    '',
    record.message || '(no message)',
    '',
    '— from ' + (record.page || 'the website') + ' at ' + record.timestamp
  ];

  try {
    MailApp.sendEmail({
      to: to,
      subject: subject,
      body: lines.join('\n'),
      replyTo: record.email || undefined,
      name: 'AZ Contractor Pro'
    });
  } catch (err) {
    // A blown mail quota must never lose the lead — it is already in the sheet.
    console.error('notify failed for ' + client.client_id + ': ' + err);
  }
}


/* ================================================================= gallery */

// Gallery lives in photos.gs. It serves a vetted manifest instead of scanning
// Drive at request time: the client has write access to their photo folder, so
// a live scan of a public folder would publish anything they dropped in it.
// See the header of photos.gs for the full reasoning.

/* ================================================================= claimed */

/**
 * A contractor claimed their site. Posted by claimed.js in acp-backend.
 *
 * This used to fail silently: the old payload had no `action`, so it fell
 * through to the lead handler, which rejected it for having no client_id. Every
 * claim — the conversion event this whole funnel exists to produce — was lost.
 */
function handleClaimed(body, params) {
  var data = {};
  Object.keys(body || {}).forEach(function (k) { data[k] = body[k]; });
  Object.keys(params || {}).forEach(function (k) { if (data[k] === undefined) data[k] = params[k]; });

  var siteId = clean(data.site_id);
  if (!siteId) return { ok: false, error: 'site_id is required' };

  var ss = SpreadsheetApp.openById(props().getProperty('REGISTRY_ID'));
  var sheet = ss.getSheetByName('Claims');
  if (!sheet) {
    sheet = ss.insertSheet('Claims');
    sheet.appendRow(['claimed_at', 'client_id', 'business_name', 'site_id',
                     'destination_acc_id', 'logged_at']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  }

  // Netlify can retry a webhook. Don't double-log the same claim.
  var last = sheet.getLastRow();
  if (last > 1) {
    var existing = sheet.getRange(2, 4, last - 1, 1).getValues();
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i][0]) === siteId) return { ok: true, id: 'duplicate' };
    }
  }

  var clientId = clean(data.client_id);
  sheet.appendRow([
    clean(data.claimed_at) || nowIso(), clientId, clean(data.business_name),
    siteId, clean(data.destination_acc_id), nowIso()
  ]);

  var to = props().getProperty('ADMIN_EMAIL');
  if (to) {
    try {
      MailApp.sendEmail({
        to: to,
        subject: 'Site claimed — ' + (clean(data.business_name) || clientId || siteId),
        body: [
          'A contractor just claimed their site.',
          '',
          'Business: ' + (clean(data.business_name) || '(unknown)'),
          'Client:   ' + (clientId || '(not attributed)'),
          'Site ID:  ' + siteId,
          '',
          clientId ? '' : 'No client_id — this site was published without one, so ' +
            'nothing else can be attributed to it later.'
        ].join('\n'),
        name: 'AZ Contractor Pro'
      });
    } catch (err) {
      console.error('claim notify failed: ' + err);
    }
  }
  return { ok: true, client_id: clientId || null };
}


/* ================================================================== portal */

function handlePortal(params) {
  var clientId = clean(params.client_id);
  var pin = clean(params.pin);
  var client = getRegistry()[clientId];
  if (!client) return { ok: false, error: 'unknown client_id' };
  if (!client.portal_pin || pin !== client.portal_pin) {
    Utilities.sleep(600);                        // blunt the guessing rate
    return { ok: false, error: 'invalid pin' };
  }

  var sheet = leadsSheetFor(client);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: true, leads: [] };

  var start = Math.max(2, last - 199);
  var rows = sheet.getRange(start, 1, last - start + 1, LEAD_COLUMNS.length).getValues();
  var leads = rows.map(function (r) {
    var o = {};
    LEAD_COLUMNS.forEach(function (c, i) { o[c] = r[i]; });
    delete o.dedupe_key;
    delete o.user_agent;
    return o;
  }).reverse();

  return { ok: true, business_name: client.business_name, count: leads.length, leads: leads };
}


/* ================================================================== helpers */

function clean(v) {
  return String(v === undefined || v === null ? '' : v).trim().substring(0, MAX_FIELD);
}

function nowIso() {
  return new Date().toISOString();
}

/** Run once from the editor to create the Registry tab with correct headers. */
function setupRegistry() {
  var id = props().getProperty('REGISTRY_ID');
  if (!id) throw new Error('Set the REGISTRY_ID script property first.');
  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getSheetByName('Registry') || ss.insertSheet('Registry');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(REGISTRY_COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, REGISTRY_COLUMNS.length).setFontWeight('bold');
  }
  flushRegistryCache();
  return 'Registry ready: ' + ss.getUrl();
}
