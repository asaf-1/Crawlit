// sw.js — FULL FILE (drop-in)

const STORE_KEYS = {
  OPTS: "opts",
  ROWS: "csv_rows",
  SEEN_URLS: "seen_urls",
  SCANNED: "scanned_files"
};

const STATE = {
  mode: "idle",
  running: false,
  currentUrl: "",
  queue: 0,
  visited: 0,
  found: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  last: ""
};

let STOP_FLAG = false;

// crawl context
let crawlTabId = null;
let crawlWindowId = null;

// runtime data
let queue = [];                // { url, depth, from }
let visited = new Set();       // urls visited this run
let foundUrls = new Set();     // found file urls this run (for UI)

// persisted
let SEEN_URLS = new Set();     // persisted dedupe by URL
let CSV_ROWS = [];             // persisted rows
let SCANNED_FILES = [];        // persisted scan-only list: {url,text,from,discovered_at}

function notify() {
  chrome.runtime.sendMessage({ type: "STATE", state: { ...STATE } }).catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sanitizeFileName(raw, fallback="file") {
  const base = (raw || fallback)
    .replace(/[\u0000-\u001F<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (base || fallback).slice(0, 180);
}

async function loadStorage() {
  const data = await chrome.storage.local.get([
    STORE_KEYS.SEEN_URLS,
    STORE_KEYS.ROWS,
    STORE_KEYS.OPTS,
    STORE_KEYS.SCANNED
  ]);

  const arr = Array.isArray(data[STORE_KEYS.SEEN_URLS]) ? data[STORE_KEYS.SEEN_URLS] : [];
  SEEN_URLS = new Set(arr);

  CSV_ROWS = Array.isArray(data[STORE_KEYS.ROWS]) ? data[STORE_KEYS.ROWS] : [];

  SCANNED_FILES = Array.isArray(data[STORE_KEYS.SCANNED]) ? data[STORE_KEYS.SCANNED] : [];

  return data[STORE_KEYS.OPTS] || {};
}

async function saveSeenUrls() {
  await chrome.storage.local.set({ [STORE_KEYS.SEEN_URLS]: Array.from(SEEN_URLS) });
}

async function saveRows() {
  await chrome.storage.local.set({ [STORE_KEYS.ROWS]: CSV_ROWS });
}

async function saveScanned() {
  await chrome.storage.local.set({ [STORE_KEYS.SCANNED]: SCANNED_FILES });
}

function toAbs(url) {
  try { return new URL(url).toString(); } catch { return ""; }
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

function makeMatcher(input) {
  const s = (input || "").trim();
  if (!s) return null;

  // regex style: /.../i
  if (s.startsWith("/") && s.lastIndexOf("/") > 0) {
    const last = s.lastIndexOf("/");
    const pat = s.slice(1, last);
    const flags = s.slice(last + 1) || "i";
    try { return new RegExp(pat, flags); } catch { return null; }
  }

  // plain substring
  return s.toLowerCase();
}

function matchesIncludeExclude(text, includeM, excludeM) {
  const t = (text || "").toLowerCase();

  if (excludeM) {
    if (excludeM instanceof RegExp) { if (excludeM.test(text)) return false; }
    else { if (t.includes(excludeM)) return false; }
  }

  if (includeM) {
    if (includeM instanceof RegExp) return includeM.test(text);
    return t.includes(includeM);
  }

  return true;
}

/**
 * IMPORTANT FIX:
 * chrome.downloads.download does NOT return a promise reliably.
 * This wrapper lets us capture chrome.runtime.lastError and show real reason.
 */
function downloadsDownload(opts) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(opts, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (downloadId == null) return reject(new Error("downloadId is null/undefined"));
      resolve(downloadId);
    });
  });
}

async function ensureCrawlTab(startUrl, opts) {
  if (crawlTabId != null) return crawlTabId;

  // Option: "hide tab" using minimized popup window (not fully invisible)
  if (opts?.hideTab) {
    const win = await chrome.windows.create({
      url: startUrl,
      focused: false,
      type: "popup",
      state: "minimized",
      width: 600,
      height: 600
    });
    crawlWindowId = win.id;
    crawlTabId = win.tabs?.[0]?.id ?? null;
    return crawlTabId;
  }

  const tab = await chrome.tabs.create({ url: startUrl, active: false });
  crawlTabId = tab.id;
  return crawlTabId;
}

async function closeCrawlContext() {
  if (crawlWindowId != null) {
    try { await chrome.windows.remove(crawlWindowId); } catch {}
    crawlWindowId = null;
    crawlTabId = null;
    return;
  }
  if (crawlTabId != null) {
    try { await chrome.tabs.remove(crawlTabId); } catch {}
    crawlTabId = null;
  }
}

async function waitTabComplete(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t && t.status === "complete") return true;
    await sleep(200);
  }
  return false;
}

async function navigateAndScan(url, options) {
  const tabId = await ensureCrawlTab(url, options);

  // Navigate
  await chrome.tabs.update(tabId, { url, active: false });

  // Wait load complete (polling avoids race)
  const ok = await waitTabComplete(tabId, options.navTimeoutMs || 45000);
  if (!ok) throw new Error("timeout waiting tab load");

  // Give a moment for late JS
  await sleep(options.renderWaitMs || 400);

  // Ask content script to scan DOM (retry if not ready)
  for (let i = 0; i < 8; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "SCAN_DOM", options });
      if (resp?.ok) return resp.res;
    } catch (e) {
      await sleep(250);
    }
  }
  throw new Error("content script not responding (SCAN_DOM)");
}

async function downloadFile(fileUrl, fileTitle, folder, fromPageUrl, forceDownload=false) {
  // dedupe by URL (persistent) unless force
  if (!forceDownload && SEEN_URLS.has(fileUrl)) return { skipped: true };

  const urlObj = new URL(fileUrl);
  const baseName = sanitizeFileName(fileTitle || urlObj.pathname.split("/").pop() || "file");

  let filename = baseName;
  const urlExt = (urlObj.pathname.match(/\.([a-z0-9]{1,8})$/i)?.[0] || "");
  if (urlExt && !filename.toLowerCase().endsWith(urlExt.toLowerCase())) filename += urlExt;

  const sub = (folder || "UniversalDownloader").replace(/\\/g, "/").replace(/^\/+/, "");
  const finalName = `${sub}/${filename}`;

  // IMPORTANT: capture real download errors
  await downloadsDownload({
    url: fileUrl,
    filename: finalName,
    conflictAction: "uniquify"
  });

  // persist dedupe only if the download request succeeded
  SEEN_URLS.add(fileUrl);
  await saveSeenUrls();

  // CSV row
  CSV_ROWS.push({
    file_name: filename,
    download_filename: finalName,
    file_url: fileUrl,
    parent_page_url: fromPageUrl || "",
    discovered_at: new Date().toISOString()
  });
  await saveRows();

  return { skipped: false };
}

function enqueue(url, depth, from, opts, startOrigin) {
  const abs = toAbs(url);
  if (!abs) return;
  if (visited.has(abs)) return;

  if (opts.sameOriginOnly && startOrigin && !sameOrigin(abs, startOrigin)) return;

  queue.push({ url: abs, depth, from });
}

async function crawlLoop(opts) {
  STOP_FLAG = false;

  const includeM = makeMatcher(opts.include);
  const excludeM = makeMatcher(opts.exclude);

  const startUrl = opts.startUrl;
  const startOrigin = startUrl;

  STATE.mode = "site-crawl";
  STATE.running = true;
  STATE.currentUrl = startUrl;
  STATE.queue = queue.length;
  STATE.visited = 0;
  STATE.found = 0;
  STATE.done = 0;
  STATE.skipped = 0;
  STATE.failed = 0;
  STATE.last = "starting";
  notify();

  while (queue.length && !STOP_FLAG) {
    if (STATE.visited >= (opts.maxPages || 200)) break;

    const item = queue.shift();
    STATE.queue = queue.length;

    const url = item.url;
    if (visited.has(url)) continue;

    visited.add(url);
    STATE.visited = visited.size;
    STATE.currentUrl = url;
    STATE.last = `visiting: ${url}`;
    notify();

    try {
      const scan = await navigateAndScan(url, {
        fileTypes: opts.fileTypes,
        sameOriginOnly: !!opts.sameOriginOnly,
        navTimeoutMs: opts.navTimeoutMs || 45000,
        renderWaitMs: opts.renderWaitMs || 500,
        hideTab: !!opts.hideTab
      });

      // handle files
      for (const f of (scan.files || [])) {
        const hay = `${f.url} ${f.text || ""} ${scan.pageTitle || ""}`;
        if (!matchesIncludeExclude(hay, includeM, excludeM)) continue;

        if (!foundUrls.has(f.url)) {
          foundUrls.add(f.url);
          STATE.found = foundUrls.size;
          notify();
        }

        try {
          const r = await downloadFile(f.url, f.text || scan.pageTitle || "file", opts.folder, scan.pageUrl, false);
          if (r.skipped) STATE.skipped += 1;
          else STATE.done += 1;

          STATE.last = `file: ${f.url}`;
          notify();
          await sleep(opts.slowPauseMs || 150);
        } catch (e) {
          STATE.failed += 1;
          STATE.last = `failed download: ${(e?.message || String(e)).slice(0, 180)}`;
          notify();
        }
      }

      // enqueue internal links
      const nextDepth = item.depth + 1;
      if (nextDepth <= (opts.maxDepth || 2)) {
        for (const link of (scan.internalLinks || [])) {
          enqueue(link, nextDepth, url, opts, startOrigin);
          if (queue.length >= (opts.maxQueue || 5000)) break;
        }
      }
    } catch (e) {
      STATE.failed += 1;
      STATE.last = `failed page: ${(e?.message || String(e)).slice(0, 180)}`;
      notify();
    }
  }

  STATE.running = false;
  STATE.queue = queue.length;
  STATE.last = STOP_FLAG ? "stopped" : "done";
  notify();

  await closeCrawlContext();
}

async function scanSinglePage(opts) {
  await loadStorage();

  const includeM = makeMatcher(opts.include);
  const excludeM = makeMatcher(opts.exclude);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("No active tab");

  STATE.mode = "single-page-scan";
  STATE.running = true;
  STATE.currentUrl = tab.url;
  STATE.queue = 0;
  STATE.visited = 1;
  STATE.found = 0;
  STATE.done = 0;
  STATE.skipped = 0;
  STATE.failed = 0;
  STATE.last = "scanning current page...";
  notify();

  let resp;
  for (let i = 0; i < 6; i++) {
    try {
      resp = await chrome.tabs.sendMessage(tab.id, {
        type: "SCAN_DOM",
        options: {
          fileTypes: opts.fileTypes,
          sameOriginOnly: !!opts.sameOriginOnly
        }
      });
      if (resp?.ok) break;
    } catch {
      await sleep(200);
    }
  }

  if (!resp?.ok) {
    STATE.running = false;
    STATE.failed = 1;
    STATE.last = "SCAN_DOM failed (no response). Check Site access / content script.";
    notify();
    throw new Error("SCAN_DOM failed");
  }

  const scan = resp.res;
  const now = new Date().toISOString();

  // add to scanned list (dedupe by url)
  const existing = new Set(SCANNED_FILES.map(x => x.url));
  let added = 0;

  for (const f of (scan.files || [])) {
    const hay = `${f.url} ${f.text || ""} ${scan.pageTitle || ""}`;
    if (!matchesIncludeExclude(hay, includeM, excludeM)) continue;

    if (!existing.has(f.url)) {
      SCANNED_FILES.push({ url: f.url, text: f.text || "", from: scan.pageUrl, discovered_at: now });
      existing.add(f.url);
      added++;
    }
  }

  await saveScanned();

  STATE.running = false;
  STATE.found = SCANNED_FILES.length;
  STATE.last = `single scan done. added: ${added}`;
  notify();

  return added;
}

async function downloadScanned(folder, forceDownload=false) {
  await loadStorage();

  STATE.mode = "download-scanned";
  STATE.running = true;
  STATE.queue = 0;
  STATE.visited = 0;
  STATE.currentUrl = "";
  STATE.done = 0;
  STATE.skipped = 0;
  STATE.failed = 0;
  STATE.last = `downloading ${SCANNED_FILES.length} scanned files... (force=${forceDownload})`;
  notify();

  for (const it of SCANNED_FILES) {
    if (STOP_FLAG) break;

    try {
      const r = await downloadFile(it.url, it.text || "file", folder, it.from, forceDownload);
      if (r.skipped) STATE.skipped += 1;
      else STATE.done += 1;

      STATE.last = `file: ${it.url}`;
      notify();
      await sleep(120);
    } catch (e) {
      STATE.failed += 1;
      STATE.last = `failed: ${(e?.message || String(e)).slice(0, 180)}`;
      notify();
    }
  }

  STATE.running = false;
  STATE.last = STOP_FLAG ? "download scanned stopped" : "download scanned done";
  notify();
}

async function clearResults() {
  await loadStorage();

  // clear only results lists; keep SEEN_URLS so we still dedupe downloads
  SCANNED_FILES = [];
  CSV_ROWS = [];
  foundUrls = new Set();

  await saveScanned();
  await saveRows();

  STATE.mode = "idle";
  STATE.running = false;
  STATE.currentUrl = "";
  STATE.queue = 0;
  STATE.visited = 0;
  STATE.found = 0;
  STATE.done = 0;
  STATE.skipped = 0;
  STATE.failed = 0;
  STATE.last = "cleared";
  notify();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "START_SITE_CRAWL") {
      const opts = msg.opts || {};
      await loadStorage();

      STOP_FLAG = false;
      visited = new Set();
      foundUrls = new Set();
      queue = [];

      enqueue(opts.startUrl, 0, "", opts, opts.startUrl);

      crawlLoop(opts).catch((e) => {
        STATE.failed += 1;
        STATE.running = false;
        STATE.last = `site-crawl ERROR: ${(e?.message || String(e)).slice(0, 180)}`;
        notify();
      });

      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "SCAN_SINGLE_PAGE") {
      try {
        const opts = msg.opts || {};
        const added = await scanSinglePage(opts);
        sendResponse({ ok: true, added });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return;
    }

    if (msg?.type === "DOWNLOAD_SCANNED") {
      STOP_FLAG = false;

      const folder = msg.folder || "UniversalDownloader";
      const force = !!msg.forceDownload;

      STATE.last = `download-scanned start (force=${force})`;
      notify();

      downloadScanned(folder, force).catch((e) => {
        STATE.failed += 1;
        STATE.running = false;
        STATE.last = `download-scanned ERROR: ${(e?.message || String(e)).slice(0, 180)}`;
        notify();
      });

      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "STOP") {
      STOP_FLAG = true;
      STATE.running = false;
      STATE.last = "stop requested";
      notify();
      await closeCrawlContext();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "GET_STATE") {
      sendResponse({ ok: true, state: { ...STATE } });
      return;
    }

    if (msg?.type === "GET_ROWS") {
      await loadStorage();
      sendResponse({ ok: true, rows: CSV_ROWS });
      return;
    }

    if (msg?.type === "CLEAR_RESULTS") {
      await clearResults();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown message" });
  })();

  return true;
});
