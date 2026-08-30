/**
 * provision.gs — per-client Drive setup, with isolation as the default.
 *
 * Creates this, once per client:
 *
 *   <Business Name>/                      internal — never shared
 *     Website-leads/                      internal — never shared
 *       Leads-spreadsheet                 SHARED with the client, and only this
 *     Website-photos/                     gallery source (see warning below)
 *
 * Then writes leads_sheet_id / drive_folder_id / company_folder_id back into the
 * Registry, which flips that client from "leads in a shared tab" to "leads in
 * their own spreadsheet". That is the isolation fix: with a blank
 * leads_sheet_id, leads land in tabs inside the Registry spreadsheet — which
 * holds every client — so sharing it would expose everyone's leads at once.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILE IS SHARED AND NOT THE FOLDER
 * ---------------------------------------------------------------------------
 * Drive sharing flows downward and forward: share a folder and the person gets
 * everything in it, including whatever you drop in six months from now. Sharing
 * only the spreadsheet means the client cannot traverse to a parent, cannot
 * browse siblings, and cannot see the folder tree at all — the file appears in
 * their "Shared with me" as a single item. Nothing you later add to the
 * company folder is exposed by accident.
 *
 * Pass shareFolder:true only if you deliberately want a drop-box the client can
 * browse, and then put nothing else in it.
 * ---------------------------------------------------------------------------
 *
 * SETUP — Script Properties:
 *   REGISTRY_ID        the Registry spreadsheet (same one router.gs uses)
 *   DRIVE_ROOT_ID      optional; parent folder for all client folders.
 *                      Leave unset to use My Drive root.
 *
 * USAGE — from the Apps Script editor, edit and run provisionOne():
 *
 *   function provisionOne() {
 *     return provisionClient({
 *       clientId:     'luis-rojos-masonry-llc',
 *       businessName: "Luis Rojo's Masonry LLC",
 *       clientEmail:  'info@luisrojomasonry.com',
 *       role:         'writer'
 *     });
 *   }
 */

var LEAD_HEADERS = [
  'timestamp', 'client_id', 'name', 'phone', 'email', 'service',
  'message', 'page', 'source', 'user_agent', 'dedupe_key'
];

// Columns the client is meant to fill in. Kept out of LEAD_HEADERS so the
// router's appendRow() never collides with them.
var CLIENT_COLUMNS = ['status', 'notes'];

var FOLDER_LEADS = 'Website-leads';
var FOLDER_PHOTOS = 'Website-photos';


/* ============================================================== provisioning */

/**
 * @param {Object} opts
 *   clientId      {string}  required, matches client.json and the Registry
 *   businessName  {string}  required, used as the folder name
 *   clientEmail   {string}  optional; omit to create everything unshared
 *   role          {string}  'writer' (default) or 'reader'
 *   shareFolder   {boolean} share the Website-leads folder instead of just the
 *                           file. Default false. Read the note above first.
 *   notify        {boolean} send Drive's share email. Default false — you
 *                           probably want to introduce it in your own words.
 */
function provisionClient(opts) {
  opts = opts || {};
  var clientId = String(opts.clientId || '').trim();
  var businessName = String(opts.businessName || '').trim();
  var clientEmail = String(opts.clientEmail || '').trim();
  var role = (opts.role === 'reader') ? 'reader' : 'writer';

  if (!clientId) throw new Error('clientId is required');
  if (!businessName) throw new Error('businessName is required');
  if (clientEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clientEmail)) {
    throw new Error('clientEmail does not look like an address: ' + clientEmail);
  }

  var root = rootFolder();
  var company = getOrCreateFolder(root, sanitizeName(businessName));
  var leadsFolder = getOrCreateFolder(company, FOLDER_LEADS);
  var photosFolder = getOrCreateFolder(company, FOLDER_PHOTOS);

  var sheetName = 'Leads-spreadsheet — ' + businessName;
  var sheetFile = findChildFile(leadsFolder, sheetName);
  var created = false;
  if (!sheetFile) {
    sheetFile = createLeadsSheet(sheetName, leadsFolder, clientId, businessName);
    created = true;
  }

  // Belt and braces: make sure nothing here is link-shared, whatever the
  // account's default sharing setting happens to be.
  [company, leadsFolder].forEach(lockDown);
  lockDown(sheetFile);

  var sharedWith = [];
  if (clientEmail) {
    var target = opts.shareFolder ? leadsFolder : sheetFile;
    shareWith(target, clientEmail, role, opts.notify === true);
    sharedWith.push(clientEmail + ' (' + role + ' on ' +
      (opts.shareFolder ? FOLDER_LEADS + ' folder' : 'the spreadsheet') + ')');
  }

  updateRegistry(clientId, {
    business_name: businessName,
    leads_sheet_id: sheetFile.getId(),
    drive_folder_id: photosFolder.getId(),
    company_folder_id: company.getId()
  });

  var result = {
    ok: true,
    client_id: clientId,
    created_sheet: created,
    company_folder: company.getUrl(),
    leads_sheet: sheetFile.getUrl(),
    leads_sheet_id: sheetFile.getId(),
    photos_folder_id: photosFolder.getId(),
    shared_with: sharedWith,
    note: created ? 'new spreadsheet created' : 'existing spreadsheet reused'
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Provision many at once from [[clientId, businessName, email], ...]. */
function provisionBatch(rows) {
  var out = [];
  (rows || []).forEach(function (r) {
    try {
      out.push(provisionClient({ clientId: r[0], businessName: r[1], clientEmail: r[2] }));
    } catch (err) {
      out.push({ ok: false, client_id: r[0], error: String(err) });
    }
    Utilities.sleep(300);       // stay clear of Drive rate limits
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}


/* ================================================================== drive */

function rootFolder() {
  var id = PropertiesService.getScriptProperties().getProperty('DRIVE_ROOT_ID');
  return id ? DriveApp.getFolderById(id) : DriveApp.getRootFolder();
}

function sanitizeName(name) {
  // Slashes create nothing dangerous in Drive but make folders hard to
  // reference in scripts and URLs. Collapse them.
  return String(name).replace(/[\/\\]+/g, '-').replace(/\s+/g, ' ').trim().substring(0, 120);
}

function getOrCreateFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function findChildFile(folder, name) {
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function createLeadsSheet(name, folder, clientId, businessName) {
  var ss = SpreadsheetApp.create(name);
  var sheet = ss.getSheets()[0];
  sheet.setName('Leads');

  var headers = LEAD_HEADERS.concat(CLIENT_COLUMNS);
  sheet.appendRow(headers);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#f1f3f4');
  sheet.getRange(1, 1, 1, LEAD_HEADERS.length)
    .setNote('Written by the lead router. Editing these can break lead capture.');

  // Hide the plumbing. The client sees a clean list, not dedupe hashes.
  ['user_agent', 'dedupe_key', 'page', 'source'].forEach(function (col) {
    var i = headers.indexOf(col);
    if (i >= 0) sheet.hideColumns(i + 1);
  });

  sheet.setColumnWidth(headers.indexOf('name') + 1, 180);
  sheet.setColumnWidth(headers.indexOf('message') + 1, 340);
  sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');

  var status = sheet.getRange(2, headers.indexOf('status') + 1, sheet.getMaxRows() - 1, 1);
  status.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['New', 'Contacted', 'Quoted', 'Won', 'Lost'], true)
    .setAllowInvalid(false).build());

  var about = ss.insertSheet('About');
  about.getRange('A1:B6').setValues([
    ['Business', businessName],
    ['Client ID', clientId],
    ['Created', new Date()],
    ['', ''],
    ['What this is', 'Every quote request from your website lands here automatically.'],
    ['Note', 'Add your own notes in the Status and Notes columns. Leave the rest alone.']
  ]);
  about.getRange('A1:A6').setFontWeight('bold');
  about.setColumnWidth(1, 130);
  about.setColumnWidth(2, 460);

  DriveApp.getFileById(ss.getId()).moveTo(folder);
  return DriveApp.getFileById(ss.getId());
}


/* =============================================================== sharing */

/** Remove any link-based access. Explicit grants only. */
function lockDown(item) {
  try {
    item.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (err) {
    Logger.log('lockDown skipped for ' + item.getName() + ': ' + err);
  }
}

function shareWith(item, email, role, notify) {
  // Apps Script's addEditor/addViewer always emails. The Advanced Drive
  // service is the only way to add someone silently, which is what you want
  // when the introduction is coming from your own outreach instead.
  if (!notify) {
    Drive.Permissions.create(
      { role: role === 'reader' ? 'reader' : 'writer', type: 'user', emailAddress: email },
      item.getId(),
      { sendNotificationEmail: false, supportsAllDrives: true }
    );
  } else if (role === 'reader') {
    item.addViewer(email);
  } else {
    item.addEditor(email);
  }

  // An editor can otherwise re-share the file with anyone they like, which
  // defeats the point of controlling access. Owner can still share.
  try {
    item.setShareableByEditors(false);
  } catch (err) {
    Logger.log('setShareableByEditors unsupported here: ' + err);
  }
}

/** Pull a client's access without touching anything else. */
function revokeClient(clientId, email) {
  var row = registryRow(clientId);
  if (!row) throw new Error('no Registry row for ' + clientId);
  var removed = [];
  [row.leads_sheet_id, row.company_folder_id].forEach(function (id) {
    if (!id) return;
    try {
      var item = DriveApp.getFileById(id);
      item.removeEditor(email);
      item.removeViewer(email);
      removed.push(id);
    } catch (err) {
      try {
        var folder = DriveApp.getFolderById(id);
        folder.removeEditor(email);
        folder.removeViewer(email);
        removed.push(id);
      } catch (e2) { Logger.log('revoke skipped ' + id + ': ' + e2); }
    }
  });
  return { ok: true, client_id: clientId, revoked_from: removed };
}

/**
 * Who can actually see each client's leads. Run this before a campaign and
 * after any bulk change — it is the cheapest way to catch a file that ended up
 * link-shared or shared with the wrong contractor.
 */
function auditSharing() {
  var me = Session.getEffectiveUser().getEmail();
  var rows = allRegistryRows();
  var findings = [];

  rows.forEach(function (row) {
    if (!row.leads_sheet_id) {
      findings.push({
        client_id: row.client_id,
        severity: 'HIGH',
        issue: 'no leads_sheet_id — leads are going into the shared Registry spreadsheet'
      });
      return;
    }
    var file;
    try {
      file = DriveApp.getFileById(row.leads_sheet_id);
    } catch (err) {
      findings.push({ client_id: row.client_id, severity: 'HIGH', issue: 'leads sheet not found: ' + err });
      return;
    }

    var access = String(file.getSharingAccess());
    if (access !== 'PRIVATE') {
      findings.push({
        client_id: row.client_id, severity: 'HIGH',
        issue: 'link sharing is ' + access + ' — anyone with the URL can open it'
      });
    }

    var people = file.getEditors().concat(file.getViewers())
      .map(function (u) { return u.getEmail(); })
      .filter(function (e) { return e && e !== me; });

    var expected = String(row.notification_email || '').toLowerCase();
    people.forEach(function (email) {
      if (expected && email.toLowerCase() !== expected) {
        findings.push({
          client_id: row.client_id, severity: 'REVIEW',
          issue: 'shared with ' + email + ', which is not the registered contact'
        });
      }
    });

    findings.push({
      client_id: row.client_id, severity: 'OK',
      issue: people.length ? 'shared with ' + people.join(', ') : 'not shared with anyone yet'
    });
  });

  var problems = findings.filter(function (f) { return f.severity !== 'OK'; });
  Logger.log('=== SHARING AUDIT: ' + rows.length + ' clients, ' +
    problems.length + ' to look at ===');
  findings.forEach(function (f) {
    Logger.log('[' + f.severity + '] ' + f.client_id + ' — ' + f.issue);
  });
  return findings;
}


/* ============================================================== registry */

var REGISTRY_HEADERS = [
  'client_id', 'business_name', 'notification_email', 'leads_sheet_id',
  'drive_folder_id', 'company_folder_id', 'portal_pin', 'status'
];

/**
 * The Registry tab, created on demand.
 *
 * This used to throw "Registry tab not found" if setupRegistry() hadn't been
 * run first, which made provisioning depend on the order you happened to run
 * things in. There's no reason for that — if the tab is missing, make it.
 */
function registrySheet() {
  var id = PropertiesService.getScriptProperties().getProperty('REGISTRY_ID');
  if (!id) {
    throw new Error(
      'REGISTRY_ID script property is not set. ' +
      'Project Settings > Script Properties > Add script property.');
  }

  var ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (err) {
    throw new Error(
      'REGISTRY_ID "' + id + '" could not be opened. Check it is the ACP ' +
      'Registry spreadsheet ID (the part of the URL between /d/ and /edit), ' +
      'and that it belongs to this Google account. Underlying error: ' + err);
  }

  var sheet = ss.getSheetByName('Registry');
  if (sheet) return sheet;

  // A brand-new spreadsheet has one empty tab called Sheet1. Reuse it rather
  // than leaving a stray empty sheet behind.
  var sheets = ss.getSheets();
  if (sheets.length === 1 && sheets[0].getLastRow() === 0) {
    sheet = sheets[0].setName('Registry');
  } else {
    sheet = ss.insertSheet('Registry');
  }

  sheet.appendRow(REGISTRY_HEADERS);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, REGISTRY_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#f1f3f4');
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 240);
  sheet.setColumnWidth(3, 240);

  Logger.log('Created the Registry tab in: ' + ss.getUrl());
  return sheet;
}

function headerMap(sheet) {
  var header = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  var map = {};
  header.forEach(function (h, i) {
    var key = String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (key) map[key] = i + 1;
  });
  return map;
}

function ensureColumn(sheet, map, name) {
  if (map[name]) return map[name];
  var col = sheet.getLastColumn() + 1;
  sheet.getRange(1, col).setValue(name).setFontWeight('bold');
  map[name] = col;
  return col;
}

function updateRegistry(clientId, values) {
  var sheet = registrySheet();
  var map = headerMap(sheet);
  var idCol = map.client_id;
  if (!idCol) throw new Error('Registry has no client_id column — run setupRegistry() first');

  var last = sheet.getLastRow();
  var ids = last > 1 ? sheet.getRange(2, idCol, last - 1, 1).getValues() : [];
  var rowIndex = -1;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === clientId) { rowIndex = i + 2; break; }
  }
  if (rowIndex === -1) {
    rowIndex = last + 1;
    sheet.getRange(rowIndex, idCol).setValue(clientId);
    if (map.status) sheet.getRange(rowIndex, map.status).setValue('active');
  }

  Object.keys(values).forEach(function (key) {
    var col = ensureColumn(sheet, map, key);
    // Don't overwrite a notification_email or business_name already curated
    // by hand; only fill blanks for those.
    var cell = sheet.getRange(rowIndex, col);
    if (key === 'business_name' && String(cell.getValue()).trim()) return;
    cell.setValue(values[key]);
  });

  if (typeof flushRegistryCache === 'function') flushRegistryCache();
  return rowIndex;
}

function allRegistryRows() {
  var sheet = registrySheet();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0].map(function (h) {
    return String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  });
  return values.slice(1).map(function (r) {
    var o = {};
    header.forEach(function (h, i) { if (h) o[h] = String(r[i] || '').trim(); });
    return o;
  }).filter(function (o) { return o.client_id; });
}

function registryRow(clientId) {
  return allRegistryRows().filter(function (r) { return r.client_id === clientId; })[0] || null;
}


/* ================================================================ example */

function provisionOne() {
  return provisionClient({
    clientId: 'luis-rojos-masonry-llc',
    businessName: "Luis Rojo's Masonry LLC",
    clientEmail: 'info@luisrojomasonry.com',
    role: 'writer',
    notify: false
  });
}
