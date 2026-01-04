(() => {
  function toAbs(href) {
    try { return new URL(href, location.href).toString(); } catch { return ""; }
  }

  function isHttp(u) {
    return /^https?:\/\//i.test(u);
  }

  function getExtFromUrl(url) {
    try {
      const u = new URL(url);
      const p = u.pathname || "";
      const m = p.match(/\.([a-z0-9]{1,8})$/i);
      if (m) return m[1].toLowerCase();

      // params like ?file=...pdf
      const keys = ["file", "url", "document", "doc", "pdf", "uri"];
      for (const k of keys) {
        const v = u.searchParams.get(k);
        if (!v) continue;
        const vv = decodeURIComponent(v);
        const mm = vv.match(/\.([a-z0-9]{1,8})(\?|$)/i);
        if (mm) return mm[1].toLowerCase();
      }
    } catch {}
    return "";
  }

  function scanDom(options) {
    const fileTypes = (options.fileTypes || []).map(x => x.toLowerCase());
    const origin = location.origin;

    const anchors = Array.from(document.querySelectorAll("a[href], link[href]"));
    const embeds = Array.from(document.querySelectorAll("embed[src], iframe[src], object[data], source[src]"));

    const candidates = [];

    for (const el of anchors) {
      const href = el.getAttribute("href");
      if (!href) continue;
      const abs = toAbs(href);
      if (!isHttp(abs)) continue;
      const text = (el.textContent || "").trim();
      candidates.push({ url: abs, text, from: location.href });
    }

    for (const el of embeds) {
      const attr = el.getAttribute("src") || el.getAttribute("data");
      if (!attr) continue;
      const abs = toAbs(attr);
      if (!isHttp(abs)) continue;
      candidates.push({ url: abs, text: "[embedded]", from: location.href });
    }

    // Internal links (for crawling)
    const internalLinks = [];
    for (const c of candidates) {
      try {
        const u = new URL(c.url);
        if (options.sameOriginOnly && u.origin !== origin) continue;
        // crawl pages only (not direct file types)
        internalLinks.push(u.toString());
      } catch {}
    }

    // File links (detect by ext)
    const files = [];
    for (const c of candidates) {
      const ext = getExtFromUrl(c.url);
      if (!ext) continue;
      if (fileTypes.length && !fileTypes.includes(ext)) continue;
      files.push({ ...c, ext });
    }

    // unique
    const uniqInternal = Array.from(new Set(internalLinks));
    const uniqFilesMap = new Map();
    for (const f of files) if (!uniqFilesMap.has(f.url)) uniqFilesMap.set(f.url, f);
    const uniqFiles = Array.from(uniqFilesMap.values());

    return {
      pageUrl: location.href,
      pageTitle: document.title || "",
      internalLinks: uniqInternal,
      files: uniqFiles
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "SCAN_DOM") {
      try {
        const res = scanDom(msg.options || {});
        sendResponse({ ok: true, res });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return true;
    }
  });
})();
