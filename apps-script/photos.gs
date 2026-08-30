/**
 * photos.gs — the Website-photos side of a client folder.
 *
 * Add to the same Apps Script project as router.gs and provision.gs.
 *
 *   <Business Name>/
 *     Website-leads/     shared: the spreadsheet only
 *     Website-photos/    shared: the FOLDER, with the client, as writer
 *       Paver-driveways/     optional category subfolders
 *       Block-walls/
 *     gallery.json       manifest, never shared
 *
 * ---------------------------------------------------------------------------
 * THE TRAP, AND WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * For an image to render on a public website it must be publicly readable.
 * The obvious approach is to make Website-photos link-viewable and scan it at
 * request time. Don't. The contractor has write access to that folder — that's
 * the whole feature — so the moment the folder is public, ANY file they drop in
 * is public too. A signed contract, an insurance certificate, a screenshot of a
 * customer's address: public, permanently, at a guessable URL.
 *
 * So the folder stays private-to-the-client, and publishing is per FILE:
 * publishPhotos() walks the folder, and marks link-viewable ONLY files that are
 * actually images. Everything else is reported and left alone. The gallery
 * endpoint serves a manifest of vetted files, never a live directory scan.
 *
 * The failure mode inverts: a new photo is invisible until the next sweep,
 * instead of a private document being exposed the instant it's uploaded.
 * ---------------------------------------------------------------------------
 *
 * Run publishPhotos() on a time trigger (daily is plenty), or call
 * publishPhotosAll() to sweep every client.
 */

var MANIFEST_NAME = 'gallery.json';
var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
var MAX_IMAGES = 300;


/* ========================================================== provisioning */

/**
 * Create category subfolders inside Website-photos, and share the folder with
 * the client so they can upload. Categories usually mirror the services on the
 * site, so a photo's folder decides which service page it appears on.
 *
 *   setupPhotoFolders('luis-rojos-masonry-llc',
 *     ['Paver Driveways & Patios', 'Block & Retaining Walls'],
 *     'owner@example.com');
 */
function setupPhotoFolders(clientId, categories, clientEmail) {
  var row = registryRow(clientId);
  if (!row || !row.drive_folder_id) {
    throw new Error('run provisionClient() for ' + clientId + ' first');
  }
  var photos = DriveApp.getFolderById(row.drive_folder_id);

  var made = (categories || []).map(function (name) {
    return getOrCreateFolder(photos, sanitizeName(name)).getName();
  });

  if (clientEmail) {
    // Folder-level share is correct HERE and wrong for leads: uploading is the
    // point. It stays private-to-them — publishing is per file, below.
    shareWith(photos, clientEmail, 'writer', false);
  }
  lockDown(photos);      // no link sharing on the folder itself, ever

  var result = {
    ok: true, client_id: clientId,
    folder_url: photos.getUrl(), categories: made,
    shared_with: clientEmail || null
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}


/* ============================================================ publishing */

/**
 * Walk a client's photo folder, publish images, report everything else.
 * Safe to run repeatedly; already-published files are left alone.
 */
function publishPhotos(clientId) {
  var row = registryRow(clientId);
  if (!row || !row.drive_folder_id) throw new Error('no photo folder for ' + clientId);

  var root = DriveApp.getFolderById(row.drive_folder_id);
  var images = [];
  var skipped = [];

  collectImages(root, '', images, skipped);

  images.sort(function (a, b) {
    return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
  });
  images = images.slice(0, MAX_IMAGES);

  images.forEach(function (img) {
    try {
      var file = DriveApp.getFileById(img.id);
      if (String(file.getSharingAccess()) !== 'ANYONE_WITH_LINK') {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      }
    } catch (err) {
      img.error = String(err);
    }
  });

  var published = images.filter(function (i) { return !i.error; }).map(function (i) {
    return {
      id: i.id,
      name: i.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim(),
      category: i.category,
      // The resized variants are served re-encoded, which drops EXIF — see the
      // note in publishPhotosAll() about GPS in job-site photos.
      thumb: 'https://lh3.googleusercontent.com/d/' + i.id + '=w600',
      full: 'https://lh3.googleusercontent.com/d/' + i.id + '=w1600',
      updated: i.updated
    };
  });

  writeManifest(row, {
    client_id: clientId,
    generated: new Date().toISOString(),
    count: published.length,
    categories: dedupe(published.map(function (p) { return p.category; })),
    images: published
  });

  var result = {
    ok: true, client_id: clientId,
    published: published.length,
    skipped_non_images: skipped.length,
    skipped: skipped.slice(0, 20),
    errors: images.filter(function (i) { return i.error; })
  };
  Logger.log(JSON.stringify(result, null, 2));
  if (skipped.length) {
    Logger.log('NOTE: ' + skipped.length + ' non-image file(s) are sitting in ' +
      clientId + "'s photo folder. They were NOT published, but they should " +
      'probably not be there. See auditPhotos().');
  }
  return result;
}

/** One level of subfolders becomes categories; deeper nesting is flattened. */
function collectImages(folder, category, images, skipped) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (f.getName() === MANIFEST_NAME) continue;
    if (IMAGE_TYPES.indexOf(f.getMimeType()) === -1) {
      skipped.push({ name: f.getName(), type: f.getMimeType(), category: category || '(root)' });
      continue;
    }
    images.push({
      id: f.getId(), name: f.getName(), category: category || 'General',
      updated: f.getLastUpdated().toISOString()
    });
  }
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    collectImages(sub, category || sub.getName(), images, skipped);
  }
}

function writeManifest(row, data) {
  var parentId = row.company_folder_id || row.drive_folder_id;
  var parent = DriveApp.getFolderById(parentId);
  var blob = Utilities.newBlob(JSON.stringify(data, null, 2), 'application/json', MANIFEST_NAME);

  var existing = parent.getFilesByName(MANIFEST_NAME);
  var file = existing.hasNext() ? existing.next().setContent(blob.getDataAsString())
                                : parent.createFile(blob);
  lockDown(file);      // the manifest is internal; never link-shared
  CacheService.getScriptCache().remove('gallery_' + data.client_id);
  return file.getId();
}

/** Sweep every client with a photo folder. Good on a daily trigger. */
function publishPhotosAll() {
  var out = [];
  allRegistryRows().forEach(function (row) {
    if (!row.drive_folder_id) return;
    if (String(row.status || '').toLowerCase() === 'disabled') return;
    try {
      out.push(publishPhotos(row.client_id));
    } catch (err) {
      out.push({ ok: false, client_id: row.client_id, error: String(err) });
    }
    Utilities.sleep(400);
  });
  Logger.log(JSON.stringify(out.map(function (o) {
    return o.client_id + ': ' + (o.ok ? o.published + ' published' : o.error);
  }), null, 2));
  return out;
}

/** Pull every image in a client's folder back to private, and empty the manifest. */
function unpublishPhotos(clientId) {
  var row = registryRow(clientId);
  if (!row || !row.drive_folder_id) throw new Error('no photo folder for ' + clientId);
  var images = [], skipped = [];
  collectImages(DriveApp.getFolderById(row.drive_folder_id), '', images, skipped);
  var n = 0;
  images.forEach(function (img) {
    try {
      DriveApp.getFileById(img.id).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      n++;
    } catch (err) { Logger.log('unpublish failed ' + img.id + ': ' + err); }
  });
  writeManifest(row, { client_id: clientId, generated: new Date().toISOString(), count: 0, categories: [], images: [] });
  return { ok: true, client_id: clientId, unpublished: n };
}


/* ================================================================= audit */

/**
 * What is publicly readable, and what shouldn't be in there at all.
 * Run alongside auditSharing() before a campaign.
 */
function auditPhotos() {
  var findings = [];
  allRegistryRows().forEach(function (row) {
    if (!row.drive_folder_id) return;
    var images = [], skipped = [];
    try {
      collectImages(DriveApp.getFolderById(row.drive_folder_id), '', images, skipped);
    } catch (err) {
      findings.push({ client_id: row.client_id, severity: 'HIGH', issue: 'photo folder unreadable: ' + err });
      return;
    }

    skipped.forEach(function (s) {
      findings.push({
        client_id: row.client_id, severity: 'REVIEW',
        issue: 'non-image in photo folder: "' + s.name + '" (' + s.type + ') — not published, but move it out'
      });
    });

    var publicCount = 0;
    images.forEach(function (img) {
      try {
        if (String(DriveApp.getFileById(img.id).getSharingAccess()) === 'ANYONE_WITH_LINK') publicCount++;
      } catch (err) { /* ignore */ }
    });
    findings.push({
      client_id: row.client_id, severity: 'OK',
      issue: images.length + ' image(s), ' + publicCount + ' published publicly'
    });
  });

  findings.forEach(function (f) { Logger.log('[' + f.severity + '] ' + f.client_id + ' — ' + f.issue); });
  return findings;
}

function dedupe(arr) {
  var seen = {}, out = [];
  arr.forEach(function (v) { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
  return out;
}


/* ====================================================== gallery endpoint */

/**
 * Replaces handleGallery() in router.gs. Serves the vetted manifest rather than
 * scanning Drive at request time, so an unpublished or non-image file can never
 * appear on a live site.
 *
 *   ?action=gallery&client_id=...&category=Block-walls
 */
function handleGalleryFromManifest(params) {
  var clientId = String(params.client_id || '').trim();
  var row = registryRow(clientId);
  if (!row) return { ok: false, error: 'unknown client_id' };

  var cache = CacheService.getScriptCache();
  var key = 'gallery_' + clientId;
  var hit = cache.get(key);
  var data;

  if (hit) {
    data = JSON.parse(hit);
  } else {
    var parentId = row.company_folder_id || row.drive_folder_id;
    if (!parentId) return { ok: true, count: 0, images: [] };
    var files = DriveApp.getFolderById(parentId).getFilesByName(MANIFEST_NAME);
    if (!files.hasNext()) {
      // No manifest means publishPhotos() has never run. Return empty rather
      // than falling back to a live scan — the fallback is what would leak.
      return { ok: true, count: 0, images: [], note: 'gallery not published yet' };
    }
    data = JSON.parse(files.next().getBlob().getDataAsString());
    if (data.count) cache.put(key, JSON.stringify(data), 900);
  }

  var category = String(params.category || '').trim();
  var images = category
    ? data.images.filter(function (i) { return i.category === category; })
    : data.images;

  return {
    ok: true,
    generated: data.generated,
    categories: data.categories || [],
    count: images.length,
    images: images
  };
}
