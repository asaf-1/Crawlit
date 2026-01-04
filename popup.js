// popup.js — updates UI + active button based on real SW STATE

function qs(id) {
  return document.getElementById(id);
}

function parseFileTypes(s) {
  return (s || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((x) => x.replace(/^\./, ""));
}

function setActiveButtonFromState(state) {
  const mode = state?.mode || "idle";
  const running = !!state?.running;

  // which button should be "ON" while running
  const map = {
    "site-crawl": "crawlSite",
    "single-page-scan": "scanPage",
    "download-scanned": "downloadScanned",
  };

  const activeId = running ? (map[mode] || null) : null;

  const all = ["scanPage", "crawlSite", "downloadScanned", "stop", "exportCsv", "clearResults"];
  for (const id of all) {
    const el = qs(id);
    if (!el) continue;
    el.classList.toggle("is-active", id === activeId);
  }
}

function renderStatus(state) {
  const s = state || {};
  const box = qs("status");
  if (!box) return;

  box.textContent =
`mode: ${s.mode}
running: ${s.running}
current: ${s.currentUrl || ""}
queue: ${s.queue}
visited: ${s.visited}
found: ${s.found}
downloaded: ${s.done} | skipped: ${s.skipped} | failed: ${s.failed}
last: ${s.last}`;
}

// ---- Actions ----
async function scanCurrentPage() {
  const opts = {
    fileTypes: parseFileTypes(qs("fileTypes")?.value || "pdf"),
    include: qs("include")?.value || "",
    exclude: qs("exclude")?.value || "",
    sameOriginOnly: !!qs("sameOrigin")?.checked,
  };

  await chrome.runtime.sendMessage({ type: "SCAN_SINGLE_PAGE", opts });
}

async function crawlSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const startUrl = tab?.url;
  if (!startUrl) return;

  const opts = {
    startUrl,
    fileTypes: parseFileTypes(qs("fileTypes")?.value || "pdf"),
    include: qs("include")?.value || "",
    exclude: qs("exclude")?.value || "",
    folder: qs("folder")?.value || "UniversalDownloader",
    maxPages: parseInt(qs("maxPages")?.value || "200", 10) || 200,
    maxDepth: parseInt(qs("maxDepth")?.value || "2", 10) || 2,
    sameOriginOnly: !!qs("sameOrigin")?.checked,
    hideTab: !!qs("hideTab")?.checked,

    // tuning
    navTimeoutMs: 45000,
    renderWaitMs: 500,
    slowPauseMs: 150,
    maxQueue: 5000
  };

  await chrome.runtime.sendMessage({ type: "START_SITE_CRAWL", opts });
}

async function downloadScanned() {
  const folder = qs("folder")?.value || "UniversalDownloader";
  await chrome.runtime.sendMessage({ type: "DOWNLOAD_SCANNED", folder });
}

async function stop() {
  await chrome.runtime.sendMessage({ type: "STOP" });
}

async function exportCsv() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_ROWS" });
    if (!resp?.ok) return;

    const headers = ["file_name", "download_filename", "file_url", "parent_page_url", "discovered_at"];
    const lines = [headers.join(",")];

    for (const r of resp.rows || []) {
      lines.push(headers.map(h => `"${String(r?.[h] ?? "").replace(/"/g, '""')}"`).join(","));
    }

    const csv = "\uFEFF" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const folder = (qs("folder")?.value || "UniversalDownloader")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    const filename = `${folder}/results.${new Date().toISOString().slice(0, 10)}.csv`;

    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });

    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) {
    console.warn("Export CSV failed:", e);
  }
}

async function clearResults() {
  await chrome.runtime.sendMessage({ type: "CLEAR_RESULTS" });
}

// Live status updates from service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STATE") {
    renderStatus(msg.state);
    setActiveButtonFromState(msg.state);
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  qs("scanPage")?.addEventListener("click", scanCurrentPage);
  qs("crawlSite")?.addEventListener("click", crawlSite);
  qs("downloadScanned")?.addEventListener("click", downloadScanned);
  qs("stop")?.addEventListener("click", stop);
  qs("exportCsv")?.addEventListener("click", exportCsv);
  qs("clearResults")?.addEventListener("click", clearResults);

  // Initial pull
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (resp?.ok && resp.state) {
      renderStatus(resp.state);
      setActiveButtonFromState(resp.state);
    }
  } catch {}
});
