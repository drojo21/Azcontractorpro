/**
 * demo.gs — the free-demo round trip for azcontractorpro.com.
 *
 *   1. Prospect submits the "Build my free demo site" form on the sales site.
 *      lead-form.js posts action=lead, client_id=azcontractorpro plus the extra
 *      fields business, roc, city, service (trade).
 *   2. router.gs logs the lead as usual, emails ADMIN_EMAIL, then calls
 *      startDemo(): the request is written to the Demos tab and a GitHub
 *      repository_dispatch (event "demo-request") is fired with the payload.
 *   3. GitHub Actions (deploy.yml) runs scripts/demo_request.py -> client.json,
 *      builds the tier=lite site with the demo banner + checkout buttons,
 *      publishes it through the backend, commits the URL back, then posts
 *      action=demo_ready here with client_id + url + claim_url.
 *   4. handleDemoReady() matches the Demos row, emails the prospect the live
 *      link with the three Square checkout buttons, and emails you.
 *
 * Script Properties (Project Settings -> Script properties):
 *   GITHUB_TOKEN        fine-grained PAT for the repo, permission
 *                       "Contents: Read and write" (repository_dispatch needs it)
 *   GITHUB_REPO         owner/repo, default drojo21/Azcontractorpro
 *   DEMO_SECRET         random string; the workflow sends it as `secret` on
 *                       demo_ready. Same value goes in the GitHub Actions secret
 *                       APPS_SCRIPT_SECRET. Without it anyone could trigger emails.
 *   SALES_CLIENT_ID     default azcontractorpro (must also be a Registry row)
 *   SALES_SITE_URL      default https://azcontractorpro.com
 *   SQUARE_LINK_STARTER, SQUARE_LINK_PRO, SQUARE_LINK_KIT
 *                       Square payment links. Empty -> buttons point at the
 *                       pricing section of the sales site instead.
 *   ADMIN_EMAIL         already used by router.gs
 */

var DEMO_COLUMNS = [
  'lead_id', 'requested_at', 'name', 'business', 'roc', 'trade', 'city',
  'phone', 'email', 'message', 'status', 'client_id', 'demo_url', 'claim_url',
  'dispatched_at', 'ready_at', 'emailed_at', 'notes'
];

function salesClientId() {
  return props().getProperty('SALES_CLIENT_ID') || 'azcontractorpro';
}

function salesSiteUrl() {
  return (props().getProperty('SALES_SITE_URL') || 'https://azcontractorpro.com').replace(/\/$/, '');
}

function demoSheet() {
  var ss = SpreadsheetApp.openById(props().getProperty('REGISTRY_ID'));
  var sheet = ss.getSheetByName('Demos');
  if (!sheet) {
    sheet = ss.insertSheet('Demos');
    sheet.appendRow(DEMO_COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, DEMO_COLUMNS.length).setFontWeight('bold');
  }
  return sheet;
}

/** Column index (1-based) by name. */
function demoCol(name) {
  return DEMO_COLUMNS.indexOf(name) + 1;
}


/* ================================================================ step 2 */

/**
 * Called by handleLead() for sales-site leads. `record` is the normalized lead,
 * `data` the raw form fields (business, roc, city, service...).
 */
function startDemo(leadId, record, data) {
  var row = {
    lead_id: leadId,
    requested_at: record.timestamp,
    name: record.name,
    business: clean(data.business),
    roc: clean(data.roc).replace(/[^0-9]/g, ''),
    trade: record.service,
    city: clean(data.city),
    phone: record.phone,
    email: record.email,
    message: record.message,
    status: 'requested',
    client_id: '', demo_url: '', claim_url: '',
    dispatched_at: '', ready_at: '', emailed_at: '', notes: ''
  };

  if (!row.business && !row.roc) {
    row.status = 'needs-info';
    row.notes = 'No business name or ROC number — build by hand or ask the prospect.';
    demoSheet().appendRow(DEMO_COLUMNS.map(function (c) { return row[c]; }));
    return;
  }

  var sheet = demoSheet();
  sheet.appendRow(DEMO_COLUMNS.map(function (c) { return row[c]; }));
  var r = sheet.getLastRow();

  var payload = {
    lead_id: leadId, name: row.name, business: row.business, roc: row.roc,
    service: row.trade, city: row.city, phone: row.phone, email: row.email,
    message: row.message
  };

  var result = dispatchDemoBuild(payload);
  if (result.ok) {
    sheet.getRange(r, demoCol('status')).setValue('building');
    sheet.getRange(r, demoCol('dispatched_at')).setValue(nowIso());
  } else {
    sheet.getRange(r, demoCol('status')).setValue('dispatch-failed');
    sheet.getRange(r, demoCol('notes')).setValue(result.error);
    var to = props().getProperty('ADMIN_EMAIL');
    if (to) {
      MailApp.sendEmail({
        to: to, name: 'AZ Contractor Pro',
        subject: 'Demo dispatch FAILED — ' + (row.business || row.roc),
        body: 'GitHub did not accept the demo-request dispatch.\n\n' + result.error +
          '\n\nRun it by hand:\n  python3 scripts/demo_request.py --payload \'' +
          JSON.stringify(payload) + '\'\n  git add clients && git commit -m "demo" && git push'
      });
    }
  }
}

/** POST https://api.github.com/repos/<repo>/dispatches */
function dispatchDemoBuild(payload) {
  var token = props().getProperty('GITHUB_TOKEN');
  var repo = props().getProperty('GITHUB_REPO') || 'drojo21/Azcontractorpro';
  if (!token) return { ok: false, error: 'GITHUB_TOKEN script property is not set' };

  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ event_type: 'demo-request', client_payload: payload }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 204) return { ok: true };
  return { ok: false, error: 'GitHub ' + code + ': ' + res.getContentText().substring(0, 300) };
}


/* ================================================================ step 4 */

function handleDemoReady(body, params) {
  var data = {};
  Object.keys(body || {}).forEach(function (k) { data[k] = body[k]; });
  Object.keys(params || {}).forEach(function (k) { if (data[k] === undefined) data[k] = params[k]; });

  var secret = props().getProperty('DEMO_SECRET');
  if (secret && clean(data.secret) !== secret) {
    Utilities.sleep(500);
    return { ok: false, error: 'bad secret' };
  }

  var clientId = clean(data.client_id);
  var leadId = clean(data.lead_id);
  var url = clean(data.url);
  var claimUrl = clean(data.claim_url);
  if (!url) return { ok: false, error: 'url is required' };
  if (!clientId && !leadId) return { ok: false, error: 'client_id or lead_id is required' };

  var sheet = demoSheet();
  var last = sheet.getLastRow();
  if (last < 2) return { ok: false, error: 'no demo requests on file' };

  // Match on lead_id first (exact), then the newest row still waiting that has
  // no client_id yet — that is the one this build was started for.
  var rows = sheet.getRange(2, 1, last - 1, DEMO_COLUMNS.length).getValues();
  var idx = -1;
  for (var i = rows.length - 1; i >= 0; i--) {
    var lid = String(rows[i][demoCol('lead_id') - 1]);
    var cid = String(rows[i][demoCol('client_id') - 1]);
    if (leadId && lid === leadId) { idx = i; break; }
    if (!leadId && clientId && cid === clientId) { idx = i; break; }
  }
  if (idx === -1 && clientId) {
    for (var j = rows.length - 1; j >= 0; j--) {
      var st = String(rows[j][demoCol('status') - 1]);
      if (st === 'building' && !String(rows[j][demoCol('client_id') - 1])) { idx = j; break; }
    }
  }
  if (idx === -1) return { ok: false, error: 'no matching demo request' };

  var r = idx + 2;
  var row = {};
  DEMO_COLUMNS.forEach(function (c, i) { row[c] = rows[idx][i]; });

  sheet.getRange(r, demoCol('client_id')).setValue(clientId || row.client_id);
  sheet.getRange(r, demoCol('demo_url')).setValue(url);
  sheet.getRange(r, demoCol('claim_url')).setValue(claimUrl);
  sheet.getRange(r, demoCol('ready_at')).setValue(nowIso());
  sheet.getRange(r, demoCol('status')).setValue('live');

  var emailed = false;
  if (row.email) {
    try {
      sendDemoEmail(row, url, claimUrl);
      sheet.getRange(r, demoCol('emailed_at')).setValue(nowIso());
      sheet.getRange(r, demoCol('status')).setValue('emailed');
      emailed = true;
    } catch (err) {
      console.error('demo email failed for ' + row.lead_id + ': ' + err);
      sheet.getRange(r, demoCol('notes')).setValue('email failed: ' + err);
    }
  } else {
    sheet.getRange(r, demoCol('notes')).setValue('no email on file — text or call ' + row.phone);
  }

  var admin = props().getProperty('ADMIN_EMAIL');
  if (admin) {
    try {
      MailApp.sendEmail({
        to: admin, name: 'AZ Contractor Pro',
        subject: 'Demo live — ' + (row.business || row.roc || clientId),
        body: [
          'Demo site is up' + (emailed ? ' and the prospect has been emailed.' : '. Prospect NOT emailed (see Demos tab).'),
          '',
          'Business: ' + row.business, 'Prospect: ' + row.name + ' · ' + row.phone + ' · ' + row.email,
          'Site:     ' + url, 'Claim:    ' + (claimUrl || '(no claim link)'),
          '', 'Follow up by phone within a day — that is where these close.'
        ].join('\n')
      });
    } catch (err) { console.error('admin demo notify failed: ' + err); }
  }
  return { ok: true, emailed: emailed, client_id: clientId || row.client_id };
}


/* =============================================================== the email */

function squareLinks() {
  var p = props();
  var sales = salesSiteUrl();
  function link(key) { return p.getProperty('SQUARE_LINK_' + key) || (sales + '/#pricing'); }
  return [
    { key: 'STARTER', name: 'Starter', setup: '$497', monthly: '$49/mo', href: link('STARTER'),
      blurb: 'This page on your own domain, quote form wired to your inbox.' },
    { key: 'PRO', name: 'Pro', setup: '$997', monthly: '$99/mo', href: link('PRO'),
      blurb: 'Service pages, service-area pages, photo gallery, reviews page, edit it yourself.', hot: true },
    { key: 'KIT', name: 'Full Marketing Kit', setup: '$1,997', monthly: '$199/mo', href: link('KIT'),
      blurb: 'Pro plus intro video, SMS lead alerts, Facebook ads and Google Business Profile setup.' }
  ];
}

function sendDemoEmail(row, url, claimUrl) {
  var first = String(row.name || '').split(' ')[0] || 'there';
  var biz = row.business || ('ROC #' + row.roc);
  var sales = salesSiteUrl();
  var offers = squareLinks();
  var admin = props().getProperty('ADMIN_EMAIL') || '';
  var hasSquare = offers.some(function (o) { return o.href.indexOf('#pricing') === -1; });

  function btn(o) {
    var bg = o.hot ? '#F2A900' : '#16181C';
    var fg = o.hot ? '#16181C' : '#FFFFFF';
    return '<td align="center" valign="top" width="33%" style="padding:6px">' +
      '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border:1px solid #D8DBE0;border-radius:8px">' +
      '<tr><td style="padding:16px 14px;font-family:Arial,Helvetica,sans-serif;text-align:center">' +
      '<div style="font-size:18px;font-weight:bold;color:#16181C">' + esc(o.name) + '</div>' +
      '<div style="font-size:26px;font-weight:bold;color:#16181C;margin:6px 0 2px">' + esc(o.setup) + '</div>' +
      '<div style="font-size:13px;color:#5C6068;margin-bottom:10px">setup, then ' + esc(o.monthly) + '</div>' +
      '<div style="font-size:13px;color:#5C6068;line-height:1.4;margin-bottom:14px">' + esc(o.blurb) + '</div>' +
      '<a href="' + esc(o.href) + '" style="display:inline-block;background:' + bg + ';color:' + fg +
      ';text-decoration:none;font-weight:bold;font-size:14px;padding:12px 18px;border-radius:6px">' +
      (hasSquare ? 'Buy ' + esc(o.name) : 'See ' + esc(o.name)) + '</a>' +
      '</td></tr></table></td>';
  }

  var html =
    '<div style="background:#EEF0F3;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#16181C">' +
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" width="600" style="max-width:600px;background:#FFFFFF;border-radius:10px">' +
    '<tr><td style="padding:28px 28px 8px">' +
    '<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8A5F00;font-weight:bold">AZ Contractor Pro</div>' +
    '<h1 style="font-size:26px;line-height:1.15;margin:10px 0 12px">' + esc(first) + ', your website is live.</h1>' +
    '<p style="font-size:16px;line-height:1.5;margin:0 0 18px">We built a site for <b>' + esc(biz) + '</b> from your ROC record. Open it on your phone — the quote form, the license verify link and the click-to-call button all work right now.</p>' +
    '<p style="margin:0 0 24px"><a href="' + esc(url) + '" style="display:inline-block;background:#F2A900;color:#16181C;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 22px;border-radius:6px">Open your demo site &rarr;</a></p>' +
    '<p style="font-size:14px;color:#5C6068;line-height:1.5;margin:0 0 8px">Link: <a href="' + esc(url) + '" style="color:#16181C">' + esc(url) + '</a></p>' +
    '</td></tr>' +
    '<tr><td style="padding:8px 28px 0">' +
    '<h2 style="font-size:20px;margin:16px 0 6px">Keep it. Pick a package.</h2>' +
    '<p style="font-size:14px;color:#5C6068;line-height:1.5;margin:0 0 12px">One-time setup, flat monthly, cancel any time and keep the files. Every package puts the site on your own domain and wires the quote form to your phone and inbox.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:0 22px 8px"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>' +
    offers.map(btn).join('') +
    '</tr></table></td></tr>' +
    '<tr><td style="padding:8px 28px 28px;font-size:14px;line-height:1.55;color:#5C6068">' +
    (claimUrl ? '<p style="margin:0 0 12px">Want to hold the site in your own Netlify account right away? <a href="' + esc(claimUrl) + '" style="color:#16181C">Claim it here</a> — we keep publishing access so updates still flow.</p>' : '') +
    '<p style="margin:0 0 12px">Everything that\'s included, itemized: <a href="' + esc(sales) + '/#features" style="color:#16181C">' + esc(sales.replace('https://', '')) + '</a>. Questions? Reply to this email' + (admin ? ' or write ' + esc(admin) : '') + '.</p>' +
    '<p style="margin:0;font-size:12px;color:#8C929C">If you didn\'t request this, ignore it — the demo expires on its own and nothing was charged. Not affiliated with the Arizona Registrar of Contractors.</p>' +
    '</td></tr></table></div>';

  var text = [
    first + ', your website is live.',
    '', 'We built a site for ' + biz + ' from your ROC record: ' + url,
    '', 'Keep it — pick a package (one-time setup, flat monthly, cancel any time):'
  ].concat(offers.map(function (o) { return '  ' + o.name + ' — ' + o.setup + ' setup, then ' + o.monthly + ': ' + o.href; }))
   .concat(claimUrl ? ['', 'Claim the site into your own account: ' + claimUrl] : [])
   .concat(['', 'Full feature list: ' + sales + '/#features', 'Reply to this email with questions.']).join('\n');

  MailApp.sendEmail({
    to: row.email,
    subject: 'Your website is live — ' + biz,
    body: text,
    htmlBody: html,
    name: 'AZ Contractor Pro',
    replyTo: admin || undefined
  });
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Run once from the editor to create the Demos tab. */
function setupDemos() {
  return 'Demos ready: ' + demoSheet().getParent().getUrl();
}

/** Editor helper: preview the prospect email to yourself. */
function testDemoEmail() {
  var admin = props().getProperty('ADMIN_EMAIL');
  sendDemoEmail({ name: 'Luis Rojo', business: "Luis Rojo's Masonry LLC", roc: '337881', email: admin, phone: '' },
    'https://luisrojosmasonry.com', '');
  return 'sent to ' + admin;
}
