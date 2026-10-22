/**
 * autopilot.gs — the parts of the funnel that used to wait for Daniel.
 *
 *   action=demo_status  GET   the sales page polls this while a demo builds
 *   action=demo_failed  POST  deploy.yml: the build refused or crashed (DEMO_SECRET)
 *   action=onboarded    POST  acp-backend /api/onboard: buyer finished setup (STRIPE_ROUTER_KEY)
 *   action=site_live    POST  deploy.yml live_notify.py: a paid site published (DEMO_SECRET)
 *   action=unsubscribe  GET   link in demo follow-up emails
 *
 *   runAutopilot()      hourly trigger (installAutopilot() creates it):
 *                         • demo follow-ups at 1, 3, 7 and 14 days, until they buy
 *                           or unsubscribe
 *                         • "finish your setup" reminders at 1, 3 and 7 days for
 *                           buyers who paid but never sent the setup form
 *
 * Called from other files:
 *   autopilotOnPaid(body)      stripe.gs, kind=new_customer — stops follow-ups,
 *                              flips the Registry row from demo to active, emails
 *                              the buyer their setup link
 *   ensureDemoColumns(sheet)   demo.gs, whenever the Demos tab is opened
 *   upsertRegistry(...)        demo.gs, so a demo site's quote form has somewhere
 *                              to deliver (before this, demo forms answered
 *                              "unknown client_id")
 *
 * Script Properties used here (besides the ones demo.gs / stripe.gs document):
 *   MAILING_ADDRESS   REQUIRED for follow-ups. CAN-SPAM wants a physical postal
 *                     address in every commercial email; without it follow-ups
 *                     are skipped (and you're told once a day). Example:
 *                     "7090 N Oracle Rd, Ste 178 #3011, Tucson, AZ 85704"
 *   SIGNATURE         how follow-ups are signed. Default "Daniel Rojo · AZ Contractor Pro"
 *   PORTAL_URL        Stripe customer portal. Default is the live portal login link.
 *   AUTOPILOT_OFF     "true" pauses all scheduled emails (the endpoints keep working)
 *
 * Every scheduled email goes out between 7am and 6pm Arizona time, at most
 * MAX_EMAILS_PER_RUN per hourly run, so a backlog can never burn the MailApp
 * quota in one go.
 */

var FOLLOWUP_DAYS = [1, 3, 7, 14];
var REMINDER_DAYS = [1, 3, 7];
var MAX_EMAILS_PER_RUN = 25;
var SEND_FROM_HOUR = 7;        // America/Phoenix — no DST, so this never drifts
var SEND_UNTIL_HOUR = 18;

var ONB_COLUMNS = [
  'session_id', 'paid_at', 'client_id', 'business', 'plan', 'buyer_email', 'buyer_name',
  'phone', 'status', 'onboard_url', 'reminders_sent', 'last_reminder_at', 'onboarded_at',
  'lead_email', 'domain', 'dns', 'site_url', 'photos_url', 'live_at', 'notes'
];

var PLAN_NAMES = { starter: 'Starter', pro: 'Pro', kit: 'Full Marketing Kit' };


/* =========================================================== small helpers */

function apProp(name, fallback) {
  var v = props().getProperty(name);
  return v === null || v === undefined || v === '' ? fallback : v;
}

function merged(body, params) {
  var data = {};
  Object.keys(body || {}).forEach(function (k) { data[k] = body[k]; });
  Object.keys(params || {}).forEach(function (k) { if (data[k] === undefined) data[k] = params[k]; });
  return data;
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function portalUrl() {
  return apProp('PORTAL_URL', 'https://billing.stripe.com/p/login/28EaEX2E97Yj8dV2OqdZ600');
}

function signature() {
  return apProp('SIGNATURE', 'Daniel Rojo · AZ Contractor Pro');
}

function phoenixHour(now) {
  return Number(Utilities.formatDate(now, 'America/Phoenix', 'H'));
}

function inSendWindow(now) {
  var h = phoenixHour(now);
  return h >= SEND_FROM_HOUR && h < SEND_UNTIL_HOUR;
}

/** Sheets hands back ISO strings or Date objects depending on how a cell was parsed. */
function daysBetween(from, now) {
  if (from === '' || from === null || from === undefined) return -1;
  var t = from instanceof Date ? from.getTime() : Date.parse(String(from));
  return isNaN(t) ? -1 : (now.getTime() - t) / 86400000;
}

/** Short HMAC so an unsubscribe link can't be forged for someone else's lead. */
function signId(id) {
  var secret = props().getProperty('DEMO_SECRET') || props().getProperty('STRIPE_ROUTER_KEY') || 'acp';
  var raw = Utilities.computeHmacSha256Signature(String(id), secret);
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '').substring(0, 16);
}

function unsubscribeUrl(leadId) {
  var base = props().getProperty('ROUTER_URL') || ScriptApp.getService().getUrl() || '';
  return base + '?action=unsubscribe&id=' + encodeURIComponent(leadId) + '&sig=' + signId(leadId);
}


/* ============================================================ Demos tab */

/** demo.gs grew four columns; old sheets get their header cells added once. */
function ensureDemoColumns(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol >= DEMO_COLUMNS.length) return;
  for (var i = lastCol; i < DEMO_COLUMNS.length; i++) {
    sheet.getRange(1, i + 1).setValue(DEMO_COLUMNS[i]).setFontWeight('bold');
  }
}

/** Newest-first scan. Returns { sheet, r (1-based row), row } or null. */
function findDemo(match, limit) {
  var sheet = demoSheet();
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var n = Math.min(last - 1, limit || 2000);
  var start = last - n + 1;
  var values = sheet.getRange(start, 1, n, DEMO_COLUMNS.length).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var row = {};
    DEMO_COLUMNS.forEach(function (c, j) { row[c] = values[i][j]; });
    if (match(row)) return { sheet: sheet, r: start + i, row: row };
  }
  return null;
}

function setDemoField(sheet, r, field, value) {
  sheet.getRange(r, demoCol(field)).setValue(value);
}

/** What the sales page needs to know, and nothing else. */
function publicDemoStatus(s) {
  s = String(s || '');
  if (s === 'live' || s === 'emailed' || s === 'paid') return 'live';
  if (s === 'failed' || s === 'dispatch-failed' || s === 'needs-info') return 'failed';
  return 'building';
}

function handleDemoStatus(params) {
  var id = clean(params.id);
  if (!/^[A-Za-z0-9+\/=_-]{6,40}$/.test(id) || id === 'duplicate' || id === 'ignored') {
    return { ok: false, error: 'unknown id' };
  }
  var cache = CacheService.getScriptCache();
  var hit = cache.get('demo_status:' + id);
  if (hit) return JSON.parse(hit);

  var found = findDemo(function (row) { return String(row.lead_id) === id; }, 800);
  if (!found) return { ok: false, error: 'unknown id' };
  var status = publicDemoStatus(found.row.status);
  var out = {
    ok: true,
    status: status,
    business: String(found.row.business || ''),
    client_id: status === 'live' ? String(found.row.client_id || '') : '',
    demo_url: status === 'live' ? String(found.row.demo_url || '') : ''
  };
  // Polls arrive every few seconds while building; a final answer can sit longer.
  cache.put('demo_status:' + id, JSON.stringify(out), status === 'building' ? 4 : 300);
  return out;
}

function handleDemoFailed(body, params) {
  var data = merged(body, params);
  var secret = props().getProperty('DEMO_SECRET');
  if (secret && clean(data.secret) !== secret) {
    Utilities.sleep(500);
    return { ok: false, error: 'bad secret' };
  }
  var leadId = clean(data.lead_id);
  if (!leadId) return { ok: false, error: 'lead_id is required' };
  var kind = ['license', 'existing', 'error'].indexOf(clean(data.kind)) >= 0 ? clean(data.kind) : 'error';
  var reason = clean(data.reason).substring(0, 600);

  var found = findDemo(function (row) { return String(row.lead_id) === leadId; }, 800);
  if (!found) return { ok: false, error: 'no matching demo request' };
  var row = found.row;
  CacheService.getScriptCache().remove('demo_status:' + leadId);

  // A step after the email failed (e.g. recording results). The prospect already
  // has a working site, so this is the operator's problem only.
  var alreadyLive = ['live', 'emailed', 'paid'].indexOf(String(row.status)) >= 0;
  if (!alreadyLive) {
    setDemoField(found.sheet, found.r, 'status', 'failed');
    setDemoField(found.sheet, found.r, 'notes', (kind + ': ' + reason).substring(0, 450));
    if (row.email && !row.opted_out_at) {
      try { sendDemoFailedEmail(row, kind); } catch (err) { console.error('demo failed email: ' + err); }
    }
  }

  var admin = props().getProperty('ADMIN_EMAIL');
  if (admin) {
    try {
      MailApp.sendEmail({
        to: admin, name: 'AZ Contractor Pro',
        subject: (alreadyLive ? 'Demo run had an error after going live — ' : 'Demo FAILED (' + kind + ') — ') +
          (row.business || row.roc || leadId),
        body: [
          alreadyLive ? 'The prospect already has their site; something after that step failed.' :
            'The prospect was told: ' + ({ license: 'their ROC number did not match an active licence — reply with the right one, or we build by hand if it is brand new.',
              existing: 'that licence already has a site with us — reply and we sort it out.',
              error: 'we hit a snag and will finish the demo by hand within one business day.' })[kind],
          '',
          'Business: ' + (row.business || '—') + '   ROC: ' + (row.roc || '—'),
          'Prospect: ' + row.name + ' · ' + (row.phone || '—') + ' · ' + (row.email || '—'),
          '',
          'Reason: ' + (reason || '(none given)'),
          kind === 'license' ? '\nIf this is a brand-new licence, the ROC snapshot may predate it — refresh data/roc-active.csv.gz.' : '',
          data.run_url ? 'Run: ' + clean(data.run_url) : ''
        ].join('\n')
      });
    } catch (err) { console.error('admin demo-failed notify: ' + err); }
  }
  return { ok: true, prospect_emailed: !alreadyLive && !!row.email };
}

/** Called when a demo's site goes live — demo.gs handleDemoReady. */
function registerDemoClient(clientId, businessName, prospectEmail) {
  if (!clientId) return;
  try {
    upsertRegistry(clientId, {
      business_name: businessName || clientId,
      notification_email: prospectEmail || '',
      status: 'demo'
    }, []);
  } catch (err) {
    console.error('registry upsert for demo ' + clientId + ' failed: ' + err);
  }
}

function markDemoPaid(clientId, email) {
  var now = nowIso();
  var sheet = demoSheet();
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var values = sheet.getRange(2, 1, last - 1, DEMO_COLUMNS.length).getValues();
  var n = 0;
  for (var i = 0; i < values.length; i++) {
    var cid = String(values[i][demoCol('client_id') - 1]);
    var em = String(values[i][demoCol('email') - 1]).toLowerCase();
    var hit = (clientId && cid === clientId) || (!clientId && email && em === String(email).toLowerCase());
    if (!hit || String(values[i][demoCol('status') - 1]) === 'paid') continue;
    sheet.getRange(i + 2, demoCol('status')).setValue('paid');
    sheet.getRange(i + 2, demoCol('paid_at')).setValue(now);
    n++;
  }
  return n;
}


/* ======================================================== Registry upsert */

/**
 * Create the client's Registry row, or fill blanks on an existing one.
 * Keys named in `force` overwrite whatever is there (status, notification_email
 * when the buyer chooses where leads go); everything else only fills blanks, so
 * a hand-curated row is never silently rewritten. Uses provision.gs helpers.
 */
function upsertRegistry(clientId, values, force) {
  force = force || [];
  var sheet = registrySheet();
  var map = headerMap(sheet);
  var idCol = map.client_id;
  if (!idCol) throw new Error('Registry has no client_id column');
  var last = sheet.getLastRow();
  var ids = last > 1 ? sheet.getRange(2, idCol, last - 1, 1).getValues() : [];
  var rowIndex = -1;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === clientId) { rowIndex = i + 2; break; }
  }
  var created = rowIndex === -1;
  if (created) {
    rowIndex = last + 1;
    sheet.getRange(rowIndex, idCol).setValue(clientId);
  }
  Object.keys(values).forEach(function (key) {
    var v = values[key];
    if (v === undefined || v === null || v === '') return;
    var col = ensureColumn(sheet, map, key);
    var cell = sheet.getRange(rowIndex, col);
    if (created || force.indexOf(key) >= 0 || !String(cell.getValue()).trim()) cell.setValue(v);
  });
  flushRegistryCache();
  return rowIndex;
}


/* ====================================================== Onboarding tab */

function onboardingSheet() {
  var ss = SpreadsheetApp.openById(props().getProperty('REGISTRY_ID'));
  var sheet = ss.getSheetByName('Onboarding');
  if (!sheet) {
    sheet = ss.insertSheet('Onboarding');
    sheet.appendRow(ONB_COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, ONB_COLUMNS.length).setFontWeight('bold');
  }
  return sheet;
}

function onbCol(name) { return ONB_COLUMNS.indexOf(name) + 1; }

function findOnboarding(match) {
  var sheet = onboardingSheet();
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var values = sheet.getRange(2, 1, last - 1, ONB_COLUMNS.length).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var row = {};
    ONB_COLUMNS.forEach(function (c, j) { row[c] = values[i][j]; });
    if (match(row)) return { sheet: sheet, r: i + 2, row: row };
  }
  return null;
}

/** Write fields onto the Onboarding row for a session, creating it if needed. */
function putOnboarding(sessionId, fields) {
  var found = findOnboarding(function (row) { return String(row.session_id) === sessionId; });
  var sheet = found ? found.sheet : onboardingSheet();
  if (!found) {
    var row = {};
    ONB_COLUMNS.forEach(function (c) { row[c] = ''; });
    row.session_id = sessionId;
    Object.keys(fields).forEach(function (k) { if (ONB_COLUMNS.indexOf(k) >= 0) row[k] = fields[k]; });
    sheet.appendRow(ONB_COLUMNS.map(function (c) { return row[c]; }));
    return findOnboarding(function (r) { return String(r.session_id) === sessionId; });
  }
  Object.keys(fields).forEach(function (k) {
    if (ONB_COLUMNS.indexOf(k) < 0 || fields[k] === undefined) return;
    sheet.getRange(found.r, onbCol(k)).setValue(fields[k]);
    found.row[k] = fields[k];
  });
  return found;
}


/* ========================================================== the payment */

/** stripe.gs → kind=new_customer. */
function autopilotOnPaid(body) {
  var clientId = clean(body.client_id);
  var email = clean(body.email);
  var sessionId = clean(body.session_id);

  markDemoPaid(clientId, email);
  if (clientId) {
    try { upsertRegistry(clientId, { status: 'active' }, ['status']); } catch (err) { console.error('registry activate: ' + err); }
  }
  if (!sessionId) return;

  var found = putOnboarding(sessionId, {
    paid_at: nowIso(), client_id: clientId, business: clean(body.business_name),
    plan: clean(body.tier), buyer_email: email, buyer_name: clean(body.name), phone: clean(body.phone),
    status: 'paid', onboard_url: clean(body.onboard_url), reminders_sent: 0
  });
  if (email && body.livemode !== false) {
    try { sendSetupEmail(found.row, 0); } catch (err) { console.error('setup email: ' + err); }
  } else if (email) {
    // Test-mode purchases still email you, not the "buyer", so a test card run
    // never sends a stranger a setup link.
    var admin = props().getProperty('ADMIN_EMAIL');
    if (admin) { try { sendSetupEmail(found.row, 0, admin); } catch (err) { console.error('setup email (test): ' + err); } }
  }
}


/* ====================================================== setup received */

function handleOnboarded(body) {
  var want = props().getProperty('STRIPE_ROUTER_KEY');
  if (want && String(body.router_key || '') !== want) return { ok: false, error: 'unauthorized' };

  var sessionId = clean(body.session_id);
  var clientId = clean(body.client_id);
  if (!sessionId || !clientId) return { ok: false, error: 'session_id and client_id are required' };
  var plan = clean(body.plan);
  var leadEmail = clean(body.lead_email) || clean(body.buyer_email);
  var services = Array.isArray(body.services) ? body.services.map(clean).filter(String) : [];

  var found = putOnboarding(sessionId, {
    client_id: clientId, business: clean(body.business_name), plan: plan,
    status: 'onboarded', onboarded_at: nowIso(), lead_email: leadEmail,
    phone: clean(body.phone), domain: clean(body.domain), dns: clean(body.dns),
    site_url: clean(body.site_url), notes: clean(body.notes).substring(0, 1500)
  });
  var row = found.row;
  if (!row.buyer_email && clean(body.buyer_email)) {
    putOnboarding(sessionId, { buyer_email: clean(body.buyer_email) });
    row.buyer_email = clean(body.buyer_email);
  }

  // The site's quote form delivers through the Registry row — point it at the buyer.
  try {
    upsertRegistry(clientId, {
      business_name: clean(body.business_name), notification_email: leadEmail, status: 'active'
    }, ['notification_email', 'status']);
  } catch (err) { console.error('registry (onboarded): ' + err); }

  // Pro and Kit: their own leads spreadsheet and a photo drop folder, shared
  // with them. Publishing photos stays a reviewed step (photos.gs explains why).
  var provisionNote = '';
  if ((plan === 'pro' || plan === 'kit') && !row.photos_url) {
    try {
      provisionClient({ clientId: clientId, businessName: clean(body.business_name) || clientId,
                        clientEmail: row.buyer_email || leadEmail, role: 'writer', notify: false });
      var photos = setupPhotoFolders(clientId, services, row.buyer_email || leadEmail);
      putOnboarding(sessionId, { photos_url: photos.folder_url });
      provisionNote = 'Drive provisioned: ' + photos.folder_url;
    } catch (err) {
      provisionNote = 'Drive provisioning FAILED: ' + err + ' — run provisionClient()/setupPhotoFolders() by hand.';
      console.error(provisionNote);
    }
  }

  var admin = props().getProperty('ADMIN_EMAIL');
  if (admin) {
    try {
      MailApp.sendEmail({
        to: admin, name: 'AZ Contractor Pro',
        subject: (body.first_submit === false ? 'Setup updated — ' : 'Setup received — ') +
          (clean(body.business_name) || clientId) + ' (' + (PLAN_NAMES[plan] || plan) + ')',
        body: [
          'The site is rebuilding from these answers — nothing to do unless something below looks wrong.',
          '',
          'Client:    ' + clientId,
          'Plan:      ' + (PLAN_NAMES[plan] || plan),
          'Leads to:  ' + leadEmail,
          'Phone:     ' + clean(body.phone),
          'Services:  ' + services.join(', '),
          'Areas:     ' + (Array.isArray(body.service_area) ? body.service_area.join(', ') : ''),
          'Domain:    ' + (clean(body.domain) || '(' + (clean(body.domain_status) || 'later') + ')'),
          provisionNote ? '\n' + provisionNote : '',
          clean(body.notes) ? '\nNotes from the buyer:\n' + clean(body.notes) : ''
        ].join('\n')
      });
    } catch (err) { console.error('admin onboarded notify: ' + err); }
  }
  return { ok: true, provisioned: provisionNote.indexOf('Drive provisioned') === 0 };
}


/* ========================================================= site is live */

function handleSiteLive(body, params) {
  var data = merged(body, params);
  var secret = props().getProperty('DEMO_SECRET');
  if (secret && clean(data.secret) !== secret) {
    Utilities.sleep(500);
    return { ok: false, error: 'bad secret' };
  }
  var clientId = clean(data.client_id);
  var url = clean(data.url);
  if (!clientId || !url) return { ok: false, error: 'client_id and url are required' };

  var found = findOnboarding(function (row) { return String(row.client_id) === clientId; });
  var admin = props().getProperty('ADMIN_EMAIL');
  if (!found) {
    // Bought before the autopilot existed, or set up by hand: nobody to email.
    if (admin) {
      try {
        MailApp.sendEmail({ to: admin, name: 'AZ Contractor Pro',
          subject: 'Site live (no buyer on file) — ' + (clean(data.business_name) || clientId),
          body: 'Published: ' + url + '\nNo Onboarding row for ' + clientId + ', so nobody was emailed.' });
      } catch (err) { console.error(err); }
    }
    return { ok: true, emailed: false };
  }

  var row = found.row;
  if (row.live_at) return { ok: true, emailed: false, note: 'already announced' };
  var to = row.buyer_email || row.lead_email;
  var emailed = false;
  if (to) {
    try {
      sendSiteLiveEmail(row, {
        url: url,
        business: clean(data.business_name) || row.business,
        custom_domain: clean(data.custom_domain),
        netlify_subdomain: clean(data.netlify_subdomain)
      }, to);
      emailed = true;
    } catch (err) { console.error('site live email: ' + err); }
  }
  putOnboarding(String(row.session_id), { status: 'live', live_at: nowIso(), site_url: url });
  if (admin) {
    try {
      MailApp.sendEmail({ to: admin, name: 'AZ Contractor Pro',
        subject: 'Site live — ' + (clean(data.business_name) || row.business),
        body: 'Published: ' + url + '\nBuyer ' + (emailed ? 'emailed at ' + to : 'NOT emailed') + '.' +
          (clean(data.custom_domain) ? '\nDomain: ' + clean(data.custom_domain) + ' (waiting on their DNS)' : '') });
    } catch (err) { console.error(err); }
  }
  return { ok: true, emailed: emailed };
}


/* =========================================================== unsubscribe */

function handleUnsubscribe(params) {
  var id = clean(params.id);
  var ok = id && clean(params.sig) === signId(id);
  var msg;
  if (!ok) {
    msg = 'That unsubscribe link is incomplete. Reply to any of our emails with “unsubscribe” and we’ll take you off by hand.';
  } else {
    var found = findDemo(function (row) { return String(row.lead_id) === id; }, 5000);
    if (found && !found.row.opted_out_at) setDemoField(found.sheet, found.r, 'opted_out_at', nowIso());
    msg = 'Done — you won’t get any more follow-ups about your demo site.';
  }
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font:17px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#13242D">' +
    '<p style="font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:12px;color:#105A67">AZ Contractor Pro</p>' +
    '<h1 style="font-size:26px;line-height:1.2">' + esc(msg) + '</h1></div>'
  ).setTitle('AZ Contractor Pro');
}


/* ========================================================== the schedule */

/** Hourly trigger target. Safe to run by hand any time. */
function runAutopilot() {
  if (String(apProp('AUTOPILOT_OFF', 'false')).toLowerCase() === 'true') return 'paused (AUTOPILOT_OFF=true)';
  var now = new Date();
  if (!inSendWindow(now)) return 'outside the send window';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'another run is in progress';
  try {
    var budget = { left: MAX_EMAILS_PER_RUN };
    var reminders = remindOnboarding(now, budget);      // paid customers first
    var followups = nurtureDemos(now, budget);
    var out = 'reminders ' + reminders + ', follow-ups ' + followups;
    console.log(out);
    return out;
  } finally {
    lock.releaseLock();
  }
}

/** Index of the follow-up due for this Demos row, or -1. Pure — tested offline. */
function followupDue(row, now) {
  if (['emailed', 'live'].indexOf(String(row.status)) < 0) return -1;
  if (!row.email || row.opted_out_at || row.paid_at) return -1;
  var sent = Number(row.followups_sent || 0);
  if (sent >= FOLLOWUP_DAYS.length) return -1;
  var age = daysBetween(row.emailed_at || row.ready_at, now);
  if (age < 0 || age < FOLLOWUP_DAYS[sent]) return -1;
  var gap = daysBetween(row.last_followup_at, now);
  if (gap >= 0 && gap < 0.8) return -1;
  return sent;
}

/** Index of the setup reminder due for this Onboarding row, or -1. Pure — tested offline. */
function reminderDue(row, now) {
  if (String(row.status) !== 'paid' || !row.buyer_email || !row.onboard_url) return -1;
  var sent = Number(row.reminders_sent || 0);         // 0 = only the welcome email so far
  if (sent >= REMINDER_DAYS.length) return -1;
  var age = daysBetween(row.paid_at, now);
  if (age < 0 || age < REMINDER_DAYS[sent]) return -1;
  var gap = daysBetween(row.last_reminder_at, now);
  if (gap >= 0 && gap < 0.8) return -1;
  return sent;
}

function nurtureDemos(now, budget) {
  if (!apProp('MAILING_ADDRESS', '')) {
    var cache = CacheService.getScriptCache();
    if (!cache.get('warned_no_address')) {
      cache.put('warned_no_address', '1', 21600);
      var admin = props().getProperty('ADMIN_EMAIL');
      if (admin) {
        MailApp.sendEmail({ to: admin, name: 'AZ Contractor Pro',
          subject: 'Demo follow-ups are paused — set MAILING_ADDRESS',
          body: 'Follow-up emails are commercial email, so they need a physical postal address (CAN-SPAM).\n' +
            'Apps Script → Project Settings → Script properties → MAILING_ADDRESS.' });
      }
    }
    return 0;
  }
  var sheet = demoSheet();
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var values = sheet.getRange(2, 1, last - 1, DEMO_COLUMNS.length).getValues();
  var sent = 0;
  for (var i = 0; i < values.length && budget.left > 0; i++) {
    var row = {};
    DEMO_COLUMNS.forEach(function (c, j) { row[c] = values[i][j]; });
    var step = followupDue(row, now);
    if (step < 0) continue;
    try {
      sendFollowup(row, step);
      sheet.getRange(i + 2, demoCol('followups_sent')).setValue(step + 1);
      sheet.getRange(i + 2, demoCol('last_followup_at')).setValue(nowIso());
      sent++;
      budget.left--;
    } catch (err) {
      console.error('follow-up ' + (step + 1) + ' to ' + row.lead_id + ' failed: ' + err);
      if (/quota|limit/i.test(String(err))) break;
    }
  }
  return sent;
}

function remindOnboarding(now, budget) {
  var sheet = onboardingSheet();
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var values = sheet.getRange(2, 1, last - 1, ONB_COLUMNS.length).getValues();
  var sent = 0;
  for (var i = 0; i < values.length && budget.left > 0; i++) {
    var row = {};
    ONB_COLUMNS.forEach(function (c, j) { row[c] = values[i][j]; });
    var step = reminderDue(row, now);
    if (step < 0) continue;
    try {
      sendSetupEmail(row, step + 1);
      sheet.getRange(i + 2, onbCol('reminders_sent')).setValue(step + 1);
      sheet.getRange(i + 2, onbCol('last_reminder_at')).setValue(nowIso());
      sent++;
      budget.left--;
    } catch (err) {
      console.error('setup reminder to ' + row.session_id + ' failed: ' + err);
      if (/quota|limit/i.test(String(err))) break;
    }
  }
  return sent;
}

/** Run once from the editor. Creates the hourly trigger (and never a duplicate). */
function installAutopilot() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runAutopilot') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runAutopilot').timeBased().everyHours(1).create();
  ensureDemoColumns(demoSheet());
  onboardingSheet();
  return 'Autopilot installed: runAutopilot() every hour, emails 7am–6pm Arizona time.' +
    (apProp('MAILING_ADDRESS', '') ? '' : ' Set MAILING_ADDRESS before follow-ups will send.');
}


/* ================================================================ emails */

function emailShell(heading, bodyHtml, footerHtml) {
  return '<div style="background:#EEE6D9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#13242D">' +
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" width="600" style="max-width:600px;background:#FFFFFF;border-radius:10px">' +
    '<tr><td style="padding:28px 28px 8px">' +
    '<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#105A67;font-weight:bold">AZ Contractor Pro</div>' +
    '<h1 style="font-size:24px;line-height:1.2;margin:10px 0 14px">' + heading + '</h1>' +
    bodyHtml +
    '</td></tr>' +
    '<tr><td style="padding:8px 28px 26px;font-size:12px;line-height:1.5;color:#6B767A">' + (footerHtml || '') + '</td></tr>' +
    '</table></div>';
}

function btnHtml(href, label, primary) {
  return '<a href="' + esc(href) + '" style="display:inline-block;background:' + (primary ? '#105A67' : '#FFFFFF') +
    ';color:' + (primary ? '#FFFFFF' : '#13242D') + ';border:2px solid #105A67;text-decoration:none;font-weight:bold;' +
    'font-size:15px;padding:12px 18px;border-radius:8px;margin:4px 6px 4px 0">' + esc(label) + '</a>';
}

function p(html) { return '<p style="font-size:16px;line-height:1.55;margin:0 0 14px">' + html + '</p>'; }

function offersHtml(clientId) {
  return '<p style="margin:6px 0 16px">' + checkoutLinks(clientId).map(function (o) {
    return btnHtml(o.href, 'Keep it — ' + o.name + ' ' + o.setup, !!o.hot);
  }).join('') + '</p>' +
    '<p style="font-size:13px;color:#6B767A;margin:0 0 6px">Setup fee today, monthly starts after launch. No contract — cancel any time and keep your files.</p>';
}

function marketingFooter(row) {
  return 'You’re getting this because you asked for a free demo site at ' + esc(salesSiteUrl().replace('https://', '')) + '. ' +
    '<a href="' + esc(unsubscribeUrl(row.lead_id)) + '" style="color:#6B767A">Unsubscribe</a> · AZ Contractor Pro · ' +
    esc(apProp('MAILING_ADDRESS', '')) + '. Not affiliated with the Arizona Registrar of Contractors.';
}

/** The four demo follow-ups. step 0..3 */
function sendFollowup(row, step) {
  var first = firstName(row.name);
  var biz = row.business || ('ROC #' + row.roc);
  var url = String(row.demo_url || '');
  var subjects = [
    first + ', did you try the quote form on your site?',
    'What ' + biz + '’s site costs, next to the alternatives',
    'You pick the services, cities and hours',
    'Last note about ' + biz + '’s demo site'
  ];
  var bodies = [
    p('Your demo site for <b>' + esc(biz) + '</b> is live: <a href="' + esc(url) + '" style="color:#105A67">' + esc(url.replace('https://', '')) + '</a>') +
      p('Three things worth trying on your phone:') +
      '<ol style="font-size:16px;line-height:1.55;margin:0 0 14px;padding-left:20px">' +
      '<li>Tap the call button — it dials you.</li>' +
      '<li>Send yourself a quote request — it lands in this inbox within seconds.</li>' +
      '<li>Tap “Verify ROC #' + esc(row.roc) + '” — the check Arizona homeowners run before they call.</li></ol>' +
      offersHtml(row.client_id),
    p('Done-for-you website subscriptions commonly list at <b>$249–$449 a month</b>, and agency-built sites usually start around <b>$2,500</b>.') +
      p('Pro is <b>$997 to set up and $99 a month</b> — about <b>$2,185 for the first year</b>, then $1,188 a year. No contract, and if you ever leave you take the files and the domain with you.') +
      p('Most contractors weigh it against a single job: if the site brings in one decent project this year, it’s covered.') +
      offersHtml(row.client_id),
    p('Your demo was built from your public ROC record, so it guesses at your services and service area.') +
      p('When you keep it, a 3-minute setup form lets you choose your services, the cities you work in, your hours and your domain — and the site rebuilds itself in about four minutes. No calls, no back-and-forth.') +
      offersHtml(row.client_id),
    p('This is my last follow-up about your demo. It stays where it is for now: <a href="' + esc(url) + '" style="color:#105A67">' + esc(url.replace('https://', '')) + '</a>') +
      p('If you want it, the buttons below go straight to checkout. If not, there’s nothing to do — nothing is charged, and you won’t hear from us about it again.') +
      offersHtml(row.client_id)
  ];
  var sign = p('— ' + esc(signature()));
  var html = emailShell(esc(subjects[step]), bodies[step] + sign, marketingFooter(row));
  var text = [subjects[step], '', 'Your demo site: ' + url, '',
    'Keep it: ' + checkoutLinks(row.client_id).map(function (o) { return o.name + ' ' + o.setup + ' — ' + o.href; }).join('\n'),
    '', '— ' + signature(), '', 'Unsubscribe: ' + unsubscribeUrl(row.lead_id), apProp('MAILING_ADDRESS', '')].join('\n');
  MailApp.sendEmail({
    to: row.email, subject: subjects[step], body: text, htmlBody: html, name: 'AZ Contractor Pro',
    replyTo: props().getProperty('ADMIN_EMAIL') || undefined
  });
}

function sendDemoFailedEmail(row, kind) {
  var first = firstName(row.name);
  var biz = row.business || (row.roc ? 'ROC #' + row.roc : 'your business');
  var subject = kind === 'error' ? 'Your demo site is taking a little longer' : 'About your free demo site — quick question';
  var body = {
    license: p('We tried to build a demo site for <b>' + esc(biz) + '</b>, but ' +
        (row.roc ? 'ROC #' + esc(row.roc) + ' isn’t' : 'that business name isn’t') +
        ' on our copy of the Arizona ROC active-license list — and we won’t publish a site that says “licensed” unless the registrar backs it.') +
      p('If there’s a typo, reply with the right number. If your license was issued in the last few weeks, our copy may not have it yet — reply and we’ll build your demo by hand.'),
    existing: p('There’s already a site on file with us for that license. Reply to this email and we’ll sort out which one you want.'),
    error: p('We hit a snag building the demo for <b>' + esc(biz) + '</b> automatically. We’ve been notified and will finish it by hand — you’ll get the link by email within one business day.')
  }[kind];
  MailApp.sendEmail({
    to: row.email, subject: subject, name: 'AZ Contractor Pro',
    replyTo: props().getProperty('ADMIN_EMAIL') || undefined,
    htmlBody: emailShell(esc(first) + ', ' + (kind === 'error' ? 'almost there.' : 'one quick thing.'), body + p('— ' + esc(signature())), ''),
    body: subject + '\n\nReply to this email and we’ll take care of it.\n\n— ' + signature()
  });
}

/** step 0 = welcome right after payment; 1..3 = reminders. `to` overrides the recipient (test mode). */
function sendSetupEmail(row, step, to) {
  var first = firstName(row.buyer_name);
  var biz = row.business || 'your business';
  var plan = PLAN_NAMES[row.plan] || 'your plan';
  var subject = step === 0 ? 'You’re in — 3 minutes to finish ' + biz + '’s site'
    : (step === REMINDER_DAYS.length ? 'Last reminder: ' : '') + 'Your site is waiting on 3 minutes of answers';
  var intro = step === 0
    ? p('Thanks for choosing <b>' + esc(plan) + '</b>. ' + (row.client_id ? 'Your demo is already turning into your real site.' : 'Your site is next in line.')) +
      p('Tell us your services, the cities you work in, your hours and your domain, and the site rebuilds itself in about four minutes:')
    : p('Your ' + esc(plan) + ' site still has our best guesses for services and service area. Three minutes of answers and it rebuilds with yours:');
  var html = emailShell(step === 0 ? esc(first) + ', you’re in.' : 'Finish ' + esc(biz) + '’s setup',
    intro + '<p style="margin:6px 0 18px">' + btnHtml(row.onboard_url, 'Finish my setup', true) + '</p>' +
    p('<span style="font-size:14px;color:#6B767A">Billing, receipts and cancellation live here any time: <a href="' + esc(portalUrl()) + '" style="color:#105A67">manage my billing</a>. Questions? Just reply.</span>'),
    'AZ Contractor Pro · ' + esc(apProp('MAILING_ADDRESS', 'Tucson, AZ')));
  MailApp.sendEmail({
    to: to || row.buyer_email, subject: subject, name: 'AZ Contractor Pro',
    replyTo: props().getProperty('ADMIN_EMAIL') || undefined,
    htmlBody: html,
    body: subject + '\n\nFinish your setup: ' + row.onboard_url + '\n\nManage billing: ' + portalUrl()
  });
}

/** DNS records for a custom domain, per Netlify's external-DNS docs. */
function dnsRows(customDomain, netlifySub) {
  var host = String(customDomain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) return [];
  var www = host.indexOf('www.') === 0;
  var rows = [['CNAME', www ? 'www' : host.split('.')[0], netlifySub || '(your site).netlify.app']];
  if (www) rows.push(['A', '@ (blank)', '75.2.60.5']);
  return rows;
}

function sendSiteLiveEmail(row, site, to) {
  var plan = row.plan;
  var biz = site.business || 'Your business';
  var domainHtml = '';
  var rows = dnsRows(site.custom_domain, site.netlify_subdomain);
  if (rows.length) {
    var host = site.custom_domain.replace(/^https?:\/\//, '');
    domainHtml = p('<b>Put it on ' + esc(host) + '.</b> Sign in where you bought the domain, open its DNS settings, and add:') +
      '<table role="presentation" cellpadding="6" style="border-collapse:collapse;font-size:14px;margin:0 0 14px">' +
      '<tr style="background:#F3EEE6"><th align="left">Type</th><th align="left">Host / name</th><th align="left">Value / points to</th></tr>' +
      rows.map(function (r) {
        return '<tr><td style="border-top:1px solid #E2D9CB"><b>' + esc(r[0]) + '</b></td><td style="border-top:1px solid #E2D9CB">' + esc(r[1]) +
          '</td><td style="border-top:1px solid #E2D9CB;font-family:monospace">' + esc(r[2]) + '</td></tr>';
      }).join('') + '</table>' +
      p('<span style="font-size:14px;color:#6B767A">Delete any old A or CNAME records for the same names first. Changes can take up to a day to spread; HTTPS turns on by itself once they do. If your registrar offers ALIAS/ANAME, @ → apex-loadbalancer.netlify.com works instead of the A record.</span>');
  } else {
    domainHtml = p('Want it on your own domain? Open your setup link any time, enter the domain, and we’ll connect it and send you the two DNS records to add.');
  }
  var photos = row.photos_url ? p('<b>Photos:</b> drop job photos into <a href="' + esc(row.photos_url) + '" style="color:#105A67">your photo folder</a> from your phone — one subfolder per service. We review them and publish them to your gallery.') : '';
  var html = emailShell(esc(biz) + ' is live.',
    p('Your ' + esc(PLAN_NAMES[plan] || '') + ' site is published and working right now:') +
    '<p style="margin:6px 0 18px">' + btnHtml(site.url, 'Open my site', true) + '</p>' +
    p('<b>Quote requests</b> go to <b>' + esc(row.lead_email || row.buyer_email) + '</b> within seconds of being sent.') +
    domainHtml + photos +
    p('<span style="font-size:14px;color:#6B767A">Change your answers any time from your setup link: <a href="' + esc(row.onboard_url) + '" style="color:#105A67">update my site</a>. Billing: <a href="' + esc(portalUrl()) + '" style="color:#105A67">manage my billing</a>.</span>'),
    'AZ Contractor Pro · ' + esc(apProp('MAILING_ADDRESS', 'Tucson, AZ')));
  MailApp.sendEmail({
    to: to, subject: biz + ' is live', name: 'AZ Contractor Pro',
    replyTo: props().getProperty('ADMIN_EMAIL') || undefined,
    htmlBody: html,
    body: biz + ' is live: ' + site.url + '\n\n' + (rows.length ? 'DNS for ' + site.custom_domain + ':\n' +
      rows.map(function (r) { return r.join('  '); }).join('\n') + '\n\n' : '') +
      (row.photos_url ? 'Photo folder: ' + row.photos_url + '\n\n' : '') + 'Update your answers: ' + row.onboard_url
  });
}
