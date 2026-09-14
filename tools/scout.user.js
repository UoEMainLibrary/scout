// ==UserScript==
// @name         SCOUT :: Little Forest (LEAF) Integration
// @description  Surfaces SCOUT Priority and Difficulty scores inside Little Forest (LEAF)
// @author       The University of Edinburgh, Heritage Collections
// @match        *://leaf.littleforest.co.uk/*
// @license      Apache 2.0
// @downloadURL  https://raw.githubusercontent.com/UoEMainLibrary/scout/main/tools/scout.user.js
// @updateURL    https://raw.githubusercontent.com/UoEMainLibrary/scout/main/tools/scout.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      archiveready.com
// ==/UserScript==

(() => {
  "use strict";

  /* ------------------- CSV Parser ------------------- */

  function parseCSV(text) {
    const rows = [];
    let field = "";
    let row = [];
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
        continue;
      }
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
      } else {
        field += c;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => !(r.length === 1 && r[0] === ""));
  }

  function stripBom(text) {
    return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function normaliseHost(raw) {
    if (!raw) return "";
    let h = String(raw).trim();
    const md = h.match(/^\[(.+?)\]\(.*\)$/);
    if (md) h = md[1];
    return h
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .trim()
      .toLowerCase();
  }

  function withoutWww(host) {
    return host.startsWith("www.") ? host.slice(4) : host;
  }

  /* ------------------- Grading ------------------- */

  function priorityGrade(score) {
    const s = Number(score) || 0;
    if (s >= 67) return "F";
    if (s >= 47) return "D";
    if (s >= 32) return "C";
    if (s >= 17) return "B";
    if (s >= 9) return "A";
    return "A+";
  }

  function difficultyGrade(score) {
    const s = Number(score) || 0;
    if (s >= 60) return "F";
    if (s >= 50) return "D";
    if (s >= 35) return "C";
    if (s >= 18) return "B";
    if (s >= 3) return "A";
    return "A+";
  }

  function getGrades(rec) {
    return {
      priorityGrade: rec.priorityGrade || "A+",
      difficultyGrade: rec.difficultyGrade || (rec.needsReview === "Yes" ? "D" : "A"),
    };
  }

  /* ------------------- Shared Style Tokens ------------------- */

  const TEXT = {
    tiny: "text-[10px]",
    xs: "text-xs",
    sm: "text-[13px]",
    base: "text-[15px]",
    stat: "text-2xl",
  };

  const TYPE = {
    title: `${TEXT.base} font-semibold`,
    subhead: `${TEXT.sm} font-semibold`,
    body: `${TEXT.sm} leading-snug`,
    meta: `${TEXT.xs} text-muted-foreground`,
    stat: `${TEXT.stat} tracking-tight`,
  };

  const STAT_TILE_CLASS = "rounded-md bg-muted/40 p-3 text-center";

  const ICON_BUTTON_CLASS =
    "inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  const GRADE_BADGE = {
    "A+": "bg-primary text-primary-foreground",
    A: "bg-green-500 text-white",
    B: "bg-blue-500 text-white",
    C: "bg-yellow-500 text-gray-900",
    D: "bg-orange-500 text-white",
    F: "bg-red-500 text-white",
  };
  function badgeClass(grade) {
    return GRADE_BADGE[grade] || GRADE_BADGE["A+"];
  }

  const BADGE_BASE = "inline-flex items-center justify-center rounded-full font-bold";
  const BADGE_SIZE = {
    sm: `h-5 min-w-5 px-1.5 ${TEXT.tiny}`,
    lg: `h-7 min-w-7 px-2 ${TEXT.xs}`,
  };
  function gradeBadgeHtml(grade, size) {
    return `<span class="${BADGE_BASE} ${BADGE_SIZE[size]} ${badgeClass(grade)}">${escapeHtml(grade)}</span>`;
  }

  const COLUMN_MAP = [
    ["URL", "url"],
    ["Priority Rank", "rank"],
    ["Priority Score", "score"],
    ["Priority Score (Before Difficulty Discount)", "scoreRaw"],
    ["Priority Grade", "priorityGrade"],
    ["Priority Why", "priorityWhy"],
    ["Difficulty Grade", "difficultyGrade"],
    ["Difficulty Score", "difficultyScore"],
    ["Difficulty Why", "difficultyWhy"],
    ["Fingerprint Stage", "fingerprintStage"],
    ["Needs Review?", "needsReview"],
    ["Review Type", "reviewType"],
    ["Why Flagged", "why"],
    ["Suggested Crawl Depth", "crawlDepth"],
    ["Suggested Crawl Frequency", "crawlFrequency"],
    ["Inferred Site Type", "siteType"],
    ["Evergreen?", "evergreen"],
    ["Institutional Area", "instArea"],
    ["Department / Division", "department"],
    ["Total Pages", "totalPages"],
    ["Total PDFs", "totalPdfs"],
    ["Last Status Code", "statusCode"],
    ["Domain", "domain"],
    ["Off Estate?", "offEstate"],
    ["Notes", "notes"],
  ];

  function scrubNaN(value) {
    if (!value) return value;
    if (/^(nan|none|null|undefined)$/i.test(value.trim())) return "";
    return value.replace(/\s*\(matched '(?:nan|none)'\)/gi, "");
  }

  function buildDataset(csvText) {
    const rows = parseCSV(stripBom(csvText));
    if (!rows.length) throw new Error("CSV appears to be empty.");
    const header = rows[0].map((h) => h.trim());
    const colIndex = {};
    COLUMN_MAP.forEach(([label, key]) => {
      const idx = header.indexOf(label);
      if (idx !== -1) colIndex[key] = idx;
    });
    if (colIndex.url === undefined) {
      throw new Error('Could not find a "URL" column in this CSV.');
    }

    const byHost = {};
    let count = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.length) continue;
      const rec = { source: "csv" };
      Object.keys(colIndex).forEach((key) => {
        rec[key] = scrubNaN((r[colIndex[key]] || "").trim());
      });
      const host = normaliseHost(rec.url);
      if (!host) continue;
      byHost[host] = rec;
      byHost[withoutWww(host)] = rec;
      count++;
    }
    return { byHost, count, loadedAt: new Date().toISOString() };
  }

  function lookup(dataset, hostRaw) {
    if (!dataset || !dataset.byHost) return null;
    const host = normaliseHost(hostRaw);
    return dataset.byHost[host] || dataset.byHost[withoutWww(host)] || null;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseCSV, stripBom, normaliseHost, withoutWww, buildDataset, lookup, COLUMN_MAP, scrubNaN,
      priorityGrade, difficultyGrade, getGrades, GRADE_BADGE, badgeClass,
    };
  }

  if (typeof document === "undefined") return;

  /* ------------------- Storage ------------------- */

  const hasGM = typeof GM_getValue === "function";
  const hasGMXHR = typeof GM_xmlhttpRequest === "function";

  function gmOrLocalGet(key) {
    try {
      const raw = hasGM ? GM_getValue(key, null) : localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn(`[SCOUT] couldn't read stored value for ${key}:`, e);
      return null;
    }
  }

  function gmOrLocalSet(key, value) {
    try {
      const raw = JSON.stringify(value);
      if (hasGM) GM_setValue(key, raw);
      else localStorage.setItem(key, raw);
      return true;
    } catch (e) {
      console.warn(`[SCOUT] couldn't store value for ${key}:`, e);
      return false;
    }
  }

  function gmOrLocalClear(key) {
    try {
      if (hasGM) GM_deleteValue(key);
      else localStorage.removeItem(key);
    } catch (e) {
      console.warn(`[SCOUT] couldn't clear stored value for ${key}:`, e);
    }
  }

  const STORE_KEY = "scout_dataset_v1";

  function storeGet() {
    return gmOrLocalGet(STORE_KEY);
  }

  function storeSet(dataset) {
    return gmOrLocalSet(STORE_KEY, dataset);
  }

  function storeClear() {
    gmOrLocalClear(STORE_KEY);
  }

  /* ------------------- Page Detection ------------------- */

  function findHostCells() {
    return Array.from(document.querySelectorAll("td.sticky-left-2"));
  }

  function looksLikeRegistryTable() {
    return findHostCells().length > 0;
  }

  /* ------------------- Tooltip ------------------- */

  let tooltipEl = null;

  function uploadIconHtml(loaded) {
    const dot = loaded ? '<span class="absolute -top-1 -right-2 h-2 w-2 rounded-full bg-green-500 border border-background"></span>' : "";
    return `<span class="relative inline-flex"><span>SCOUT</span>${dot}</span>`;
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function splitReasons(text) {
    if (!text) return [];
    return text
      .split(" | ")
      .map((s) => capitalize(s.trim()))
      .filter(Boolean);
  }

  function rankText(rec) {
    const total = currentDataset && currentDataset.count;
    if (!rec.rank || !total) return "";
    return `Ranked #${escapeHtml(rec.rank)} of ${escapeHtml(String(total))} overall`;
  }

  function formatScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return String(Math.round(n * 10) / 10);
  }

  function parseCategoryBreakdown(text) {
    if (!text) return [];
    return text
      .split(" | ")
      .map((part) => {
        const m = part.trim().match(/^(.+?):\s*([\d.]+|–)\s*\/\s*([\d.]+)$/);
        if (!m) return null;
        return { label: m[1].trim(), pts: m[2] === "–" ? 0 : parseFloat(m[2]), max: parseFloat(m[3]) };
      })
      .filter(Boolean);
  }

  function fadeIn(el) {
    const raf = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 16);
    raf(() => {
      if (el && el.isConnected) {
        el.classList.remove("opacity-0");
        el.classList.add("opacity-100");
      }
    });
  }

  function positionTooltip(el, anchorRect) {
    const ttWidth = el.offsetWidth;
    const ttHeight = el.offsetHeight;
    let left = anchorRect.right + 10;
    let top = anchorRect.top;
    if (left + ttWidth > window.innerWidth - 8) left = anchorRect.left - ttWidth - 10;
    if (top + ttHeight > window.innerHeight - 8) top = window.innerHeight - ttHeight - 8;
    if (top < 8) top = 8;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${top}px`;
    fadeIn(el);
  }

  const TOOLTIP_BASE_CLASS =
    "fixed z-[9999] rounded-xl border bg-popover text-popover-foreground shadow-lg shadow-black/5 p-4 pointer-events-none opacity-0 transition duration-150 ease-out";

  function showTooltip(anchorRect, rec, axis) {
    hideTooltip();
    tooltipEl = document.createElement("div");
    tooltipEl.className = `${TOOLTIP_BASE_CLASS} w-[34rem]`;

    const { priorityGrade, difficultyGrade } = getGrades(rec);
    const isPriority = axis === "priority";
    const grade = isPriority ? priorityGrade : difficultyGrade;
    const label = isPriority ? "Priority" : "Difficulty";
    const score = isPriority ? rec.score : rec.difficultyScore;

    const categories = parseCategoryBreakdown(isPriority ? rec.priorityWhy : rec.difficultyWhy);
    const rationale = isPriority ? [] : splitReasons(rec.why);

    const headHtml = `
      <div class="flex items-center justify-between gap-3 pb-3 border-b">
        <div class="min-w-0">
          <div class="${TYPE.title}">${escapeHtml(label)}</div>
          ${score ? `<div class="${TYPE.meta}">Score ${formatScore(score)}</div>` : ""}
        </div>
        <span class="flex-shrink-0">${gradeBadgeHtml(grade, "lg")}</span>
      </div>`;

    const gridHtml = categories.length
      ? `<div class="mt-3 grid grid-cols-4 gap-2">${categories
          .map(
            (c) => `
        <div class="${STAT_TILE_CLASS}">
          <div class="${TYPE.meta}">${escapeHtml(c.label)}</div>
          <div class="mt-0.5 ${TYPE.stat} font-bold">${c.pts != null ? formatScore(c.pts) : "–"}<span class="${TYPE.stat} font-medium text-muted-foreground">/${formatScore(c.max)}</span></div>
        </div>`
          )
          .join("")}</div>`
      : `<div class="mt-3 ${TYPE.body} text-muted-foreground">${escapeHtml(isPriority ? "No priority signal available for this site." : "No difficulty signal available for this site.")}</div>`;

    const rationaleHtml =
      !isPriority && categories.length
        ? rationale.length
          ? `<div class="mt-3 space-y-1.5 ${TYPE.body}">${rationale.map((r) => `<div>${escapeHtml(r)}</div>`).join("")}</div>`
          : `<div class="mt-3 ${TYPE.body} text-muted-foreground">No issues flagged.</div>`
        : "";

    const footBits = [rankText(rec)].filter(Boolean);
    const footHtml = footBits.length
      ? `<div class="mt-3 pt-3 border-t ${TYPE.meta} space-y-0.5">${footBits.map((t) => `<div>${t}</div>`).join("")}</div>`
      : "";

    tooltipEl.innerHTML = `${headHtml}${gridHtml}${rationaleHtml}${footHtml}`;
    document.body.appendChild(tooltipEl);
    positionTooltip(tooltipEl, anchorRect);
  }

  function showEmptyTooltip(anchorRect, reason) {
    hideTooltip();
    tooltipEl = document.createElement("div");
    tooltipEl.className = `${TOOLTIP_BASE_CLASS} w-72`;
    const msg =
      reason === "notInCsv"
        ? "This site isn't in the uploaded CSV — it may be new, or filtered out of that export."
        : "Upload a CSV from the SCOUT button in the toolbar above to see this site's Priority and Difficulty.";
    tooltipEl.innerHTML = `
      <div class="${TYPE.title}">No data for this site</div>
      <div class="mt-1.5 ${TYPE.body} text-muted-foreground">${escapeHtml(msg)}</div>`;
    document.body.appendChild(tooltipEl);
    positionTooltip(tooltipEl, anchorRect);
  }

  function hideTooltip() {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ------------------- CLEAR+ ------------------- */

  const DEEPDIVE_STORE_KEY = "scout_deepdive_v1";
  const DEEPDIVE_API = "https://archiveready.com/api";

  function deepDiveCacheGet() {
    return gmOrLocalGet(DEEPDIVE_STORE_KEY) || {};
  }

  function deepDiveCacheSet(cache) {
    gmOrLocalSet(DEEPDIVE_STORE_KEY, cache);
  }

  function deepDiveCacheGetHost(host) {
    return deepDiveCacheGet()[host] || null;
  }

  function deepDiveCacheSetHost(host, entry) {
    const cache = deepDiveCacheGet();
    cache[host] = entry;
    deepDiveCacheSet(cache);
  }

  let deepDiveInFlightCount = 0;

  function beginDeepDiveCursor() {
    deepDiveInFlightCount++;
    document.body.style.cursor = "progress";
  }

  function endDeepDiveCursor() {
    deepDiveInFlightCount = Math.max(0, deepDiveInFlightCount - 1);
    if (deepDiveInFlightCount === 0) document.body.style.removeProperty("cursor");
  }

  function requestDeepDive(host, { onDone }) {
    const targetUrl = `https://${host}`;
    const apiUrl = `${DEEPDIVE_API}?url=${encodeURIComponent(targetUrl)}`;
    const finish = (result) => {
      endDeepDiveCursor();
      onDone(result);
    };

    if (!hasGMXHR) {
      finish({ error: "This install can't make cross-origin requests (GM_xmlhttpRequest unavailable) - reinstall the userscript via Tampermonkey to enable the deep dive." });
      return;
    }

    beginDeepDiveCursor();

    GM_xmlhttpRequest({
      method: "GET",
      url: apiUrl,
      timeout: 90000,
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) {
          finish({ error: `archiveready.com returned HTTP ${res.status}.` });
          return;
        }
        let data;
        try {
          data = JSON.parse(res.responseText);
        } catch (e) {
          finish({ error: "Couldn't parse the response from archiveready.com." });
          return;
        }
        if (!data || !data.test) {
          finish({ error: "Unexpected response shape from archiveready.com." });
          return;
        }
        const entry = { data, checkedAt: new Date().toISOString(), targetUrl };
        deepDiveCacheSetHost(host, entry);
        finish({ entry });
      },
      onerror: () => finish({ error: "Network error contacting archiveready.com." }),
      ontimeout: () =>
        finish({ error: "archiveready.com took too long to respond (over 90s) - a genuinely heavy page can time out. Try again, or check the site by hand." }),
    });
  }

  const FACET_LABELS = {
    Accessibility: "Accessibility",
    Standards_Compliance: "Standards Compliance",
    Cohesion: "Cohesion",
    Metadata: "Metadata",
  };

  function levelClass(level) {
    const n = Number(level);
    if (!Number.isFinite(n) || n < 0) return "text-muted-foreground";
    if (n >= 70) return "text-green-600";
    if (n >= 30) return "text-yellow-600";
    return "text-red-600";
  }

  const LEVEL_TIERS = {
    bad: { key: "bad", label: "Issue", dot: "bg-red-500" },
    info: { key: "info", label: "Info", dot: "bg-muted-foreground/40" },
    good: { key: "good", label: "Good", dot: "bg-green-500" },
  };

  function levelTier(level) {
    const n = Number(level);
    if (n === 100) return LEVEL_TIERS.good;
    if (n === 0) return LEVEL_TIERS.bad;
    return LEVEL_TIERS.info;
  }

  function stripHtmlTags(s) {
    return String(s || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const DEEPDIVE_BACKDROP_CLASS =
    "fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-6 opacity-0 transition-opacity duration-150 ease-out";
  const DEEPDIVE_PANEL_CLASS =
    "flex h-[70vh] w-[70vw] max-h-[46rem] max-w-[60rem] flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl";

  let deepDiveBackdropEl = null;

  function onDeepDiveKeydown(e) {
    if (e.key === "Escape") hideDeepDivePanel();
  }

  function hideDeepDivePanel() {
    if (deepDiveBackdropEl) {
      deepDiveBackdropEl.remove();
      deepDiveBackdropEl = null;
      document.removeEventListener("keydown", onDeepDiveKeydown, true);
      document.body.style.removeProperty("overflow");
    }
  }

  function showDeepDivePanel(anchorRect, host, entry) {
    hideDeepDivePanel();
    hideTooltip();

    const backdrop = document.createElement("div");
    backdrop.className = DEEPDIVE_BACKDROP_CLASS;
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) hideDeepDivePanel();
    });

    const panel = document.createElement("div");
    panel.className = DEEPDIVE_PANEL_CLASS;

    const t = entry.data.test || {};
    const overall = t.website_archivability;

    const facetsHtml = Object.keys(FACET_LABELS)
      .map(
        (k) => `
        <div class="${STAT_TILE_CLASS}">
          <div class="${TYPE.meta}">${escapeHtml(FACET_LABELS[k])}</div>
          <div class="mt-0.5 ${TYPE.stat} font-bold ${levelClass(t[k])}">${t[k] != null ? formatScore(t[k]) : "–"}</div>
        </div>`
      )
      .join("");

    const tierOrder = { bad: 0, info: 1, good: 2 };
    const weightOrder = { HIGH: 0, MEDIUM: 1 };
    const messages = Array.isArray(entry.data.messages) ? entry.data.messages : [];
    const sorted = messages
      .map((m) => ({ m, tier: levelTier(m.level) }))
      .sort((a, b) => {
        const byTier = tierOrder[a.tier.key] - tierOrder[b.tier.key];
        if (byTier !== 0) return byTier;
        const aw = weightOrder[String(a.m.weight || "").toUpperCase()] ?? 2;
        const bw = weightOrder[String(b.m.weight || "").toUpperCase()] ?? 2;
        return aw - bw;
      });

    const tierCounts = {};
    sorted.forEach(({ tier }) => {
      tierCounts[tier.key] = (tierCounts[tier.key] || 0) + 1;
    });
    const summaryHtml = [LEVEL_TIERS.bad, LEVEL_TIERS.info, LEVEL_TIERS.good]
      .filter((tier) => tierCounts[tier.key])
      .map(
        (tier) =>
          `<span class="inline-flex items-center gap-1.5 ${TYPE.meta}"><span class="h-1.5 w-1.5 rounded-full ${tier.dot}"></span>${tierCounts[tier.key]} ${tier.label}</span>`
      )
      .join("");

    const findingRowHtml = ({ m, tier }) => `
        <div class="flex items-start gap-2.5 py-2">
          <span class="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${tier.dot}"></span>
          <span class="${TYPE.body}">${escapeHtml(stripHtmlTags(m.title))}</span>
          ${m.weight ? `<span class="ml-auto flex-shrink-0 ${TYPE.meta}">${escapeHtml(String(m.weight))}</span>` : ""}
        </div>`;
    const findingsHtml =
      sorted.map(findingRowHtml).join("") || `<div class="py-2 ${TYPE.body} text-muted-foreground">No findings returned.</div>`;

    const checkedAt = entry.checkedAt ? new Date(entry.checkedAt).toLocaleString() : "";

    panel.innerHTML = `
      <div class="flex flex-shrink-0 items-center justify-between gap-3 border-b px-6 py-4">
        <div class="min-w-0">
          <div class="${TYPE.title}">CLEAR+</div>
          <div class="truncate ${TYPE.meta}">${escapeHtml(host)}</div>
        </div>
        <button type="button" class="scout-deepdive-close ${ICON_BUTTON_CLASS} h-8 w-8 flex-shrink-0" aria-label="Close">&#10005;</button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div class="rounded-lg bg-muted/40 p-4">
          <div class="flex items-baseline justify-between">
            <div class="${TYPE.meta}">Website Archivability</div>
            <div class="${levelClass(overall)}"><span class="${TYPE.stat} font-bold">${overall != null ? formatScore(overall) : "–"}</span><span class="${TYPE.stat} font-medium text-muted-foreground">/100</span></div>
          </div>
          <div class="mt-3 grid grid-cols-4 gap-2">${facetsHtml}</div>
        </div>
        <div class="mt-2 ${TYPE.meta} leading-snug">Higher is more archivable here — the opposite direction from Difficulty above. A one-off check against archiveready.com, separate from the automated score.</div>
        <div class="mt-5 border-t pt-4">
          <div class="flex items-center justify-between gap-2">
            <div class="${TYPE.subhead}">Findings</div>
            ${summaryHtml ? `<div class="flex items-center gap-3">${summaryHtml}</div>` : ""}
          </div>
          <div class="mt-1 divide-y divide-border/60">${findingsHtml}</div>
        </div>
      </div>
      <div class="flex flex-shrink-0 items-center justify-between border-t px-6 py-3 ${TYPE.meta}">
        <span>Checked ${escapeHtml(checkedAt)}</span>
        <button type="button" class="scout-deepdive-recheck ${TYPE.body} font-semibold text-primary hover:underline">Recheck</button>
      </div>
    `;

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    deepDiveBackdropEl = backdrop;
    document.body.style.overflow = "hidden";
    fadeIn(backdrop);

    panel.querySelector(".scout-deepdive-close").addEventListener("click", hideDeepDivePanel);

    panel.querySelector(".scout-deepdive-recheck").addEventListener("click", (e) => {
      e.currentTarget.textContent = "Checking…";
      e.currentTarget.disabled = true;
      requestDeepDive(host, {
        onDone: (result) => {
          if (result.error) {
            alert("SCOUT deep dive failed: " + result.error);
            return;
          }
          showDeepDivePanel(anchorRect, host, result.entry);
        },
      });
    });

    document.addEventListener("keydown", onDeepDiveKeydown, true);
  }

  function deepDiveTriggerEl(host) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `scout-deepdive-btn ml-1 ${ICON_BUTTON_CLASS} h-5 w-5 border ${TEXT.tiny} leading-none`;
    const setIdleTitle = () => {
      const cached = deepDiveCacheGetHost(host);
      btn.title = cached
        ? `CLEAR+ deep dive - last checked ${new Date(cached.checkedAt).toLocaleString()}. Click to view, or recheck from the panel.`
        : "Run a one-off CLEAR+ archivability deep dive for this site (calls archiveready.com directly - not part of the automated score, may take up to a minute).";
    };
    setIdleTitle();
    btn.textContent = "\u{1F50D}";

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      const cached = deepDiveCacheGetHost(host);
      if (cached) {
        showDeepDivePanel(rect, host, cached);
        return;
      }
      btn.disabled = true;
      btn.textContent = "…";
      requestDeepDive(host, {
        onDone: (result) => {
          btn.disabled = false;
          btn.textContent = "\u{1F50D}";
          setIdleTitle();
          if (result.error) {
            alert("SCOUT deep dive failed: " + result.error);
            return;
          }
          showDeepDivePanel(btn.getBoundingClientRect(), host, result.entry);
        },
      });
    });

    return btn;
  }

  /* ------------------- Inventory Rows ------------------- */

  let currentDataset = null;

  function extractHostFromCell(cell) {
    if (!cell) return "";
    const buttons = Array.from(cell.querySelectorAll('button[aria-label^="View details for "]'));
    const primary = buttons.find((b) => !/redirect target:/i.test(b.getAttribute("aria-label") || ""));
    if (!primary) return "";
    return normaliseHost(primary.textContent || primary.getAttribute("aria-label").replace(/^View details for /, ""));
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports.extractHostFromCell = extractHostFromCell;
  }

  function chipEl(grade) {
    const chip = document.createElement("span");
    chip.className = `scout-chip ${BADGE_BASE} ${BADGE_SIZE.sm} ${badgeClass(grade)}`;
    chip.textContent = grade;
    chip.dataset.grade = grade;
    return chip;
  }

  function emptyChipEl(reason) {
    const chip = document.createElement("span");
    chip.className = `scout-chip ${BADGE_BASE} ${BADGE_SIZE.sm} border text-muted-foreground`;
    chip.textContent = reason === "notInCsv" ? "?" : "–";
    chip.dataset.scoutEmptyReason = reason;
    return chip;
  }

  /* ------------------- Sorting ------------------- */

  const SCOUT_COLUMNS = [
    { key: "priority", label: "Priority", direction: "F is most urgent, A+ is least urgent" },
    { key: "difficulty", label: "Difficulty", direction: "F is hardest to crawl, A+ is easiest" },
  ];
  let scoutSortState = { key: null, dir: null };

  const SORT_ICON = {
    none: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-down h-3 w-3 opacity-50" aria-hidden="true"><path d="m21 16-4 4-4-4"></path><path d="M17 20V4"></path><path d="m3 8 4-4 4 4"></path><path d="M7 4v16"></path></svg>',
    asc: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up h-3 w-3" aria-hidden="true"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg>',
    desc: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-down h-3 w-3" aria-hidden="true"><path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path></svg>',
  };

  function findSiteHeaderCell(headRow) {
    return headRow.querySelector("th.sticky-left-2");
  }

  function ensureSCOUTColumns() {
    const headRow = document.querySelector("thead tr");
    if (!headRow) return;
    if (!headRow.dataset.scoutNativeSortBound) {
      headRow.dataset.scoutNativeSortBound = "1";
      headRow.addEventListener(
        "click",
        (e) => {
          const th = e.target.closest("th");
          if (!th || th.classList.contains("scout-col-header") || !scoutSortState.key) return;
          scoutSortState = { key: null, dir: null };
          updateSCOUTSortArrows();
        },
        true
      );
    }

    if (headRow.querySelector(".scout-col-header")) return;
    const siteTh = findSiteHeaderCell(headRow);
    const insertBeforeEl = siteTh ? siteTh.nextElementSibling : headRow.children[1] || null;
    SCOUT_COLUMNS.forEach(({ key, label, direction }) => {
      const th = document.createElement("th");
      th.className =
        "h-10 px-3 text-left align-middle font-medium text-muted-foreground bg-muted table-header-cell relative hover-highlight cursor-pointer select-none scout-col-header";
      th.dataset.scoutKey = key;
      th.style.cssText = "width: 110px; min-width: 0px; max-width: 165px;";
      th.setAttribute("aria-sort", "none");
      th.title = `Sort this page by ${label} (${direction})`;
      th.innerHTML =
        `<div class="flex items-center w-full gap-2 flex-nowrap"><div class="min-w-0 truncate">${escapeHtml(label)}</div><div class="flex-shrink-0 ml-auto scout-sort-arrow">${SORT_ICON.none}</div></div>` +
        `<div class="column-resizer" aria-label="Resize ${escapeHtml(label)} column" role="separator" tabindex="0" aria-valuenow="110" aria-valuemin="50" aria-valuemax="165"></div>`;
      th.addEventListener("click", () => handleSCOUTSort(key));
      const resizer = th.querySelector(".column-resizer");
      if (resizer) bindColumnResizer(resizer, th);
      if (insertBeforeEl) headRow.insertBefore(th, insertBeforeEl);
      else headRow.appendChild(th);
    });
  }

  function bindColumnResizer(resizer, th) {
    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = th.getBoundingClientRect().width;
      const min = parseFloat(resizer.getAttribute("aria-valuemin")) || 50;
      const max = parseFloat(resizer.getAttribute("aria-valuemax")) || 165;

      const onMove = (moveEvent) => {
        const next = Math.min(max, Math.max(min, startWidth + (moveEvent.clientX - startX)));
        th.style.width = `${next}px`;
        resizer.setAttribute("aria-valuenow", String(Math.round(next)));
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  function ensureSCOUTCells(row, rec, reason, host) {
    const grades = rec ? getGrades(rec) : null;
    const siteTd = row.querySelector("td.sticky-left-2");
    const insertBeforeEl = siteTd ? siteTd.nextElementSibling : row.children[1] || null;
    SCOUT_COLUMNS.forEach(({ key }) => {
      let td = row.querySelector(`.scout-col-cell-${key}`);
      if (!td) {
        td = document.createElement("td");
        td.className = `p-3 align-middle table-data-cell text-center whitespace-nowrap scout-col-cell scout-col-cell-${key}`;
        if (insertBeforeEl) row.insertBefore(td, insertBeforeEl);
        else row.appendChild(td);
      }
      td.innerHTML = "";
      if (rec) {
        const grade = key === "priority" ? grades.priorityGrade : grades.difficultyGrade;
        const scoreNum = key === "priority" ? parseFloat(rec.score) || 0 : parseFloat(rec.difficultyScore) || 0;
        td.appendChild(chipEl(grade));
        td.dataset.scoutScore = String(scoreNum);
      } else {
        td.appendChild(emptyChipEl(reason));
        td.dataset.scoutScore = "";
      }
      if (key === "difficulty" && host) {
        td.appendChild(deepDiveTriggerEl(host));
      }
      td.dataset.scoutProcessed = "1";
    });
  }

  function updateSCOUTSortArrows() {
    document.querySelectorAll("th.scout-col-header").forEach((th) => {
      const iconWrap = th.querySelector(".scout-sort-arrow");
      if (!iconWrap) return;
      const active = th.dataset.scoutKey === scoutSortState.key;
      const dir = active ? scoutSortState.dir : null;
      th.setAttribute("aria-sort", dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none");
      iconWrap.innerHTML = dir === "asc" ? SORT_ICON.asc : dir === "desc" ? SORT_ICON.desc : SORT_ICON.none;
    });
  }

  function handleSCOUTSort(key) {
    scoutSortState = scoutSortState.key === key ? { key, dir: scoutSortState.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" };
    applySCOUTSort();
  }

  function applySCOUTSort() {
    updateSCOUTSortArrows();
    if (!scoutSortState.key) return;
    const key = scoutSortState.key;
    const anyCell = document.querySelector(`.scout-col-cell-${key}`);
    const table = anyCell && anyCell.closest("table");
    if (!table) return;
    const tbody = table.querySelector("tbody") || table;
    const rows = Array.from(tbody.children).filter((el) => el.tagName === "TR");
    if (rows.length < 2) return;

    const withScore = rows.map((r) => {
      const cell = r.querySelector(`.scout-col-cell-${key}`);
      const raw = cell ? cell.dataset.scoutScore : "";
      return { r, v: raw ? parseFloat(raw) : null };
    });

    withScore.sort((a, b) => {
      if (a.v === null && b.v === null) return 0;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return scoutSortState.dir === "desc" ? b.v - a.v : a.v - b.v;
    });

    const alreadyInOrder = withScore.every((x, i) => rows[i] === x.r);
    if (alreadyInOrder) return;

    const frag = document.createDocumentFragment();
    withScore.forEach((x) => frag.appendChild(x.r));
    tbody.appendChild(frag);
  }

  function processCell(cell) {
    if (cell.dataset.scoutDone === "1") return;
    const host = extractHostFromCell(cell);
    if (!host) return;
    cell.dataset.scoutDone = "1";

    const row = cell.closest("tr");
    if (!row) return;

    const rec = lookup(currentDataset, host);
    const reason = !currentDataset ? "noCsv" : !rec ? "notInCsv" : null;

    ensureSCOUTCells(row, rec, reason, host);

    const chipsByAxis = {
      priority: row.querySelector(".scout-col-cell-priority .scout-chip"),
      difficulty: row.querySelector(".scout-col-cell-difficulty .scout-chip"),
    };
    Object.keys(chipsByAxis).forEach((axis) => {
      const chip = chipsByAxis[axis];
      if (!chip || chip.dataset.scoutHoverBound === "1") return;
      chip.dataset.scoutHoverBound = "1";
      chip.addEventListener("mouseenter", () => {
        if (rec) showTooltip(chip.getBoundingClientRect(), rec, axis);
        else showEmptyTooltip(chip.getBoundingClientRect(), reason);
      });
      chip.addEventListener("mouseleave", hideTooltip);
    });
  }

  function processRegistryTable() {
    ensureSCOUTColumns();
    injectUploadButton();
    findHostCells().forEach(processCell);
    applySCOUTSort();
  }

  function reprocessRegistryTable() {
    findHostCells().forEach((c) => {
      delete c.dataset.scoutDone;
    });
    document.querySelectorAll(".scout-col-cell").forEach((td) => td.remove());
    processRegistryTable();
  }

  /* ------------------- Upload CSV ------------------- */

  function fmtCount(n) {
    return Number(n || 0).toLocaleString();
  }

  let fileInputEl = null;
  let toastHideTimer = null;
  let toastRemoveTimer = null;

  function showLoadedToast(dataset) {
    clearTimeout(toastHideTimer);
    clearTimeout(toastRemoveTimer);
    let toast = document.getElementById("scout-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "scout-toast";
      toast.className = `fixed right-4 z-[9999] flex items-center gap-2 rounded-xl bg-foreground text-background px-4 py-3 ${TEXT.sm} font-medium shadow-lg opacity-0 transition duration-150 ease-out pointer-events-none`;
      document.body.appendChild(toast);
    }
    const hasFallbackBtn = !!document.querySelector(".scout-fallback-btn");
    toast.style.bottom = hasFallbackBtn ? "72px" : "16px";
    const loaded = dataset.loadedAt ? new Date(dataset.loadedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    toast.innerHTML =
      '<span class="h-2 w-2 rounded-full bg-green-500"></span>' +
      `<span>Crawl and Priority Matrix data loaded: ${escapeHtml(fmtCount(dataset.count))} websites</span>` +
      (loaded ? `<span class="text-background opacity-70">${escapeHtml(loaded)}</span>` : "");
    setTimeout(() => {
      toast.classList.remove("opacity-0");
      toast.classList.add("opacity-100");
    }, 0);
    toastHideTimer = setTimeout(() => {
      toast.classList.remove("opacity-100");
      toast.classList.add("opacity-0");
      toastRemoveTimer = setTimeout(() => toast.remove(), 220);
    }, 3200);
  }

  function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const dataset = buildDataset(String(reader.result));
        dataset.fileName = file.name;
        currentDataset = dataset;
        storeSet(dataset);
        reprocessRegistryTable();
        refreshUploadButton();
        showLoadedToast(dataset);
      } catch (err) {
        console.warn("[SCOUT] couldn't parse that CSV:", err);
        alert("SCOUT couldn't read that CSV: " + err.message);
      }
    };
    reader.onerror = () => {
      console.warn("[SCOUT] couldn't read the file:", reader.error);
      alert("SCOUT couldn't read that file — please try again.");
    };
    reader.readAsText(file);
  }

  function ensureFileInput() {
    if (fileInputEl && document.body.contains(fileInputEl)) return fileInputEl;
    fileInputEl = document.createElement("input");
    fileInputEl.type = "file";
    fileInputEl.accept = ".csv,text/csv";
    fileInputEl.id = "scout-file";
    fileInputEl.style.display = "none";
    fileInputEl.addEventListener("change", handleFile);
    document.body.appendChild(fileInputEl);
    return fileInputEl;
  }

  function openFilePicker() {
    const input = ensureFileInput();
    input.value = "";
    input.click();
  }

  function findNativeToolbar() {
    const anchor =
      document.querySelector("button[aria-label='Import data']") ||
      document.querySelector("button[aria-label='Export options']") ||
      document.querySelector("button[aria-label='Share search']");
    return anchor ? { anchor, toolbar: anchor.parentElement } : null;
  }

  function uploadButtonLabelHtml() {
    const loadedText = currentDataset ? ` (${fmtCount(currentDataset.count)})` : "";
    return uploadIconHtml(!!currentDataset) + `<span class="font-semibold text-primary">SCOUT${loadedText}</span>`;
  }

  function uploadButtonLabel() {
    if (!currentDataset) return "SCOUT: upload a CSV to grade every site's Priority and Difficulty";
    const fileName = currentDataset.fileName || "a CSV";
    const loaded = currentDataset.loadedAt ? new Date(currentDataset.loadedAt).toLocaleDateString() : "";
    return `SCOUT: ${fmtCount(currentDataset.count)} sites loaded from ${fileName}${loaded ? " on " + loaded : ""}. Click to upload a different file.`;
  }

  function refreshUploadButton() {
    const btn = document.getElementById("scout-upload-btn");
    if (btn) {
      const isFallback = btn.classList.contains("scout-fallback-btn");
      btn.innerHTML = isFallback ? uploadButtonLabelHtml() : uploadIconHtml(!!currentDataset);
      btn.title = uploadButtonLabel();
      btn.setAttribute("aria-label", uploadButtonLabel());
      btn.dataset.scoutLoaded = currentDataset ? "1" : "0";
    }
  }

  function injectUploadButton() {
    ensureFileInput();
    const found = findNativeToolbar();
    const existing = document.getElementById("scout-upload-btn");

    if (existing) {
      if (found && found.toolbar && existing.classList.contains("scout-fallback-btn")) {
        existing.classList.remove("scout-fallback-btn");
        existing.className = found.anchor.className;
        existing.innerHTML = uploadIconHtml(!!currentDataset);
        found.toolbar.insertBefore(existing, found.anchor);
      }
      return;
    }

    const btn = document.createElement("button");
    btn.id = "scout-upload-btn";
    btn.type = "button";
    if (found && found.toolbar) {
      btn.className = found.anchor.className;
      btn.innerHTML = uploadIconHtml(!!currentDataset);
    } else {
      btn.className = `scout-fallback-btn fixed bottom-4 right-4 z-[9999] inline-flex items-center gap-2 rounded-full border bg-card px-4 py-2 ${TEXT.sm} font-semibold shadow-md`;
      btn.innerHTML = uploadButtonLabelHtml();
    }
    btn.title = uploadButtonLabel();
    btn.setAttribute("aria-label", uploadButtonLabel());
    btn.dataset.scoutLoaded = currentDataset ? "1" : "0";

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFilePicker();
    });

    if (found && found.toolbar) found.toolbar.insertBefore(btn, found.anchor);
    else document.body.appendChild(btn);
  }

  if (typeof module !== "undefined" && module.exports) {
    Object.assign(module.exports, {
      ensureSCOUTColumns,
      ensureSCOUTCells,
      handleSCOUTSort,
      applySCOUTSort,
      findNativeToolbar,
      injectUploadButton,
      openFilePicker,
      refreshUploadButton,
      showLoadedToast,
      deepDiveCacheGet,
      deepDiveCacheSet,
      deepDiveCacheGetHost,
      deepDiveCacheSetHost,
      requestDeepDive,
      showDeepDivePanel,
      hideDeepDivePanel,
      deepDiveTriggerEl,
    });
  }

  /* ------------------- Boot ------------------- */

  function tick() {
    if (looksLikeRegistryTable()) processRegistryTable();
  }

  function boot() {
    currentDataset = storeGet();
    tick();

    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        tick();
      }, 60);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
      if (scoutSortState.key) applySCOUTSort();
    }, 500);

    window.__scout = {
      getDataset: () => currentDataset,
      setDataset: (ds) => {
        currentDataset = ds;
        reprocessRegistryTable();
        refreshUploadButton();
      },
      clear: () => {
        currentDataset = null;
        storeClear();
        reprocessRegistryTable();
        refreshUploadButton();
      },
      debugSort: () => {
        const anyCell = document.querySelector(".scout-col-cell-priority");
        const table = anyCell && anyCell.closest("table");
        const tbody = table && (table.querySelector("tbody") || table);
        const rows = tbody ? Array.from(tbody.children).filter((el) => el.tagName === "TR") : [];
        return {
          sortState: scoutSortState,
          tableFound: !!table,
          rowCount: rows.length,
          sample: rows.slice(0, 8).map((r) => ({
            host: extractHostFromCell(r.querySelector("td.sticky-left-2")) || "(no host found)",
            priorityScore: r.querySelector(".scout-col-cell-priority")?.dataset.scoutScore,
            difficultyScore: r.querySelector(".scout-col-cell-difficulty")?.dataset.scoutScore,
          })),
        };
      },
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();