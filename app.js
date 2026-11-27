/* =========================================================
   QSL LOGBOOK — local-first QSL card manager
   Vanilla JS, no network, no dependencies.
   ========================================================= */

(function () {
  "use strict";

  const STORAGE_KEY = "qsl-logbook-v1";
  const THEME_KEY = "qsl-theme";
  const APP_VERSION = "1.3.0";
  const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  const MAX_NOTES = 1000;
  const ADIF_PROGRAM_ID = "QSLLOGBOOK";

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector));

  const ICON_FALLBACK = "#i-info";

  let records = [];
  let activeTab = "main";
  let filters = {
    q: "",
    dateField: "qso",
    from: "",
    to: "",
    status: "all",
    planKind: "all",
  };

  let draft = null;
  let draftStep = 1;
  let editingId = null;
  let draftDirty = false;
  let pendingImport = null;
  let confirmState = null;
  let deferredInstallPrompt = null;
  let persistRequested = false;
  let storageErrorShown = false;
  let toastId = 0;
  let sortOrder = "desc";
  let selectionMode = false;
  const selectedIds = new Set();

  const els = {};

  /* =========================================================
     Utilities
     ========================================================= */

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      switch (ch) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        case "'":
          return "&#39;";
        default:
          return ch;
      }
    });
  }

  function icon(name, className) {
    return '<svg class="' + (className || "icon") + '" aria-hidden="true"><use href="#' + name + '"/></svg>';
  }

  function uid() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (error) {
      /* fall through */
    }
    return "rec_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function todayISO() {
    const now = new Date();
    return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
  }

  function nowHM() {
    const now = new Date();
    return pad2(now.getHours()) + ":" + pad2(now.getMinutes());
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function isISODate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parts = value.split("-").map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return (
      date.getFullYear() === parts[0] &&
      date.getMonth() === parts[1] - 1 &&
      date.getDate() === parts[2]
    );
  }

  function normalizeDateValue(value) {
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return "";
      return value.getFullYear() + "-" + pad2(value.getMonth() + 1) + "-" + pad2(value.getDate());
    }
    if (value === null || value === undefined) return "";
    const text = String(value).trim();
    if (!text) return "";
    const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (match) {
      const candidate = match[1] + "-" + pad2(Number(match[2])) + "-" + pad2(Number(match[3]));
      return isISODate(candidate) ? candidate : "";
    }
    const date = new Date(text);
    if (isNaN(date.getTime())) return "";
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  function normalizeTimeValue(value) {
    if (value === null || value === undefined) return "";
    const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (!match) return "";
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return "";
    return pad2(hours) + ":" + pad2(minutes);
  }

  function parseBool(value) {
    if (value === true || value === 1) return true;
    if (typeof value === "string") {
      const text = value.trim().toLowerCase();
      return ["1", "true", "yes", "y", "是", "已收妥", "已收", "收到"].indexOf(text) !== -1;
    }
    if (typeof value === "number") return value === 1;
    return false;
  }

  function normalizePlannedKind(value, otherReceived) {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (["reply", "return", "incoming", "回寄", "待回寄", "已收卡"].indexOf(text) !== -1) {
      return "reply";
    }
    if (["send", "outgoing", "先寄出", "待寄出", "寄出"].indexOf(text) !== -1) {
      return "send";
    }
    return otherReceived ? "reply" : "send";
  }

  function plannedKindOf(record) {
    return record && record.plannedKind === "reply" ? "reply" : "send";
  }

  function plannedKindLabel(record) {
    return plannedKindOf(record) === "reply" ? "待回寄" : "待寄出";
  }

  function safeIso(value) {
    if (!value) return null;
    const date = new Date(value);
    if (isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  function normalizeRecord(raw) {
    if (!raw || typeof raw !== "object") return null;

    let qsoDate = normalizeDateValue(raw.qsoDate != null ? raw.qsoDate : raw.date);
    let qsoTime = normalizeTimeValue(raw.qsoTime != null ? raw.qsoTime : raw.time);

    if ((!qsoDate || !qsoTime) && typeof raw.qsoAt === "string") {
      const parts = raw.qsoAt.split(/[T ]/);
      if (!qsoDate) qsoDate = normalizeDateValue(parts[0]);
      if (!qsoTime) qsoTime = normalizeTimeValue(parts[1] ? parts[1].slice(0, 5) : "");
    }
    if ((!qsoDate || !qsoTime) && typeof raw.datetime === "string") {
      const parts = raw.datetime.split(/[T ]/);
      if (!qsoDate) qsoDate = normalizeDateValue(parts[0]);
      if (!qsoTime) qsoTime = normalizeTimeValue(parts[1] ? parts[1].slice(0, 5) : "");
    }

    let callsign = raw.callsign != null ? raw.callsign : raw.call != null ? raw.call : raw["呼号"];
    callsign = String(callsign == null ? "" : callsign).trim().toUpperCase().slice(0, 24);

    let band = raw.band != null ? raw.band : raw.bandSatellite != null ? raw.bandSatellite : raw.frequency != null ? raw.frequency : raw.freq != null ? raw.freq : raw["频段"];
    band = String(band == null ? "" : band).trim().slice(0, 40);

    if (!isISODate(qsoDate) || !qsoTime || !callsign || !band) return null;

    const sentAt = normalizeDateValue(
      raw.sentAt != null ? raw.sentAt :
      raw.sentDate != null ? raw.sentDate :
      raw.sent_at != null ? raw.sent_at :
      raw["发卡日期"]
    );

    let mode = raw.mode != null ? raw.mode : raw.qsoMode != null ? raw.qsoMode : raw["模式"];
    mode = String(mode == null ? "" : mode).trim().slice(0, 24);

    let notes = raw.notes != null ? raw.notes : raw.note != null ? raw.note : raw.remark != null ? raw.remark : raw["备注"];
    notes = String(notes == null ? "" : notes).replace(/\r\n/g, "\n").slice(0, MAX_NOTES);

    const ownReceived = sentAt ? parseBool(raw.ownReceived != null ? raw.ownReceived : raw.ownCardReceived) : false;
    let otherReceived = parseBool(raw.otherReceived != null ? raw.otherReceived : raw.otherCardReceived);
    let plannedKind = "";
    if (!sentAt) {
      plannedKind = normalizePlannedKind(
        raw.plannedKind != null ? raw.plannedKind :
        raw.planKind != null ? raw.planKind :
        raw.pendingKind != null ? raw.pendingKind :
        raw["计划类型"],
        otherReceived
      );
      if (plannedKind === "reply" || otherReceived) plannedKind = "reply";
      if (plannedKind === "reply") otherReceived = true;
    }

    const created = safeIso(raw.createdAt) || nowISO();
    const updated = safeIso(raw.updatedAt) || created;

    let id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,90}$/.test(raw.id) ? raw.id : uid();

    return {
      id: id,
      qsoDate: qsoDate,
      qsoTime: qsoTime,
      callsign: callsign,
      band: band,
      mode: mode,
      sentAt: sentAt || "",
      plannedKind: plannedKind,
      ownReceived: ownReceived,
      otherReceived: otherReceived,
      notes: notes,
      createdAt: created,
      updatedAt: updated,
    };
  }

  function isMain(record) {
    return Boolean(record && record.sentAt);
  }

  function compareRecords(a, b) {
    const aKey = a.qsoDate + "T" + a.qsoTime;
    const bKey = b.qsoDate + "T" + b.qsoTime;
    if (aKey !== bKey) {
      return sortOrder === "asc" ? aKey.localeCompare(bKey) : bKey.localeCompare(aKey);
    }
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  }

  function compareQsoDesc(a, b) {
    const aKey = a.qsoDate + "T" + a.qsoTime;
    const bKey = b.qsoDate + "T" + b.qsoTime;
    if (aKey !== bKey) return bKey.localeCompare(aKey);
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  }

  function findDuplicate(record) {
    const key = recordIdentity(record);
    return records.find(function (item) {
      return item.id !== record.id && recordIdentity(item) === key;
    });
  }

  function getMainRecords() {
    return records.filter(isMain).sort(compareRecords);
  }

  function getPlannedRecords() {
    return records.filter(function (record) {
      return !isMain(record);
    }).sort(compareRecords);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function fileStamp(date) {
    const d = date || new Date();
    return (
      String(d.getFullYear()) +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      "-" +
      pad2(d.getHours()) +
      pad2(d.getMinutes())
    );
  }

  /* =========================================================
     Theme
     ========================================================= */

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function applyTheme(theme, options) {
    const opts = options || {};
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);

    if (opts.save !== false) {
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (error) {
        /* private mode: theme still applies for this session */
      }
    }

    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute("content", next === "light" ? "#eef2f1" : "#0a0d10");
    }

    if (els.themeBtn) {
      const label = next === "light" ? "切换到深色主题" : "切换到浅色主题";
      els.themeBtn.setAttribute("aria-label", label);
      els.themeBtn.setAttribute("title", label);
      const use = els.themeBtn.querySelector("use");
      if (use) use.setAttribute("href", next === "light" ? "#i-moon" : "#i-sun");
    }
  }

  function toggleTheme() {
    const next = currentTheme() === "light" ? "dark" : "light";
    applyTheme(next);
    showToast(next === "light" ? "已切换到浅色主题" : "已切换到深色主题", { duration: 1800 });
  }

  /* =========================================================
     ADIF helpers
     ========================================================= */

  function recordIdentity(record) {
    return [
      String(record.callsign || "").toUpperCase(),
      record.qsoDate || "",
      record.qsoTime || "",
      String(record.band || "").trim().toLowerCase(),
    ].join("|");
  }

  function bandToAdif(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*(m|cm|mm)$/i);
    if (match) return match[1] + match[2].toUpperCase();
    return raw.toUpperCase();
  }

  function bandFromAdif(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*(m|cm|mm)$/i);
    if (match) return match[1] + match[2].toLowerCase();
    return raw;
  }

  function isAmateurBand(value) {
    return /^\d+(?:\.\d+)?\s*(?:m|cm|mm)$/i.test(String(value || "").trim());
  }

  function adifDateToISO(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length !== 8) return "";
    const iso = digits.slice(0, 4) + "-" + digits.slice(4, 6) + "-" + digits.slice(6, 8);
    return isISODate(iso) ? iso : "";
  }

  function adifTimeToHM(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length < 4) return "";
    return normalizeTimeValue(digits.slice(0, 2) + ":" + digits.slice(2, 4));
  }

  function adifField(name, value) {
    const raw = String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim();
    if (!raw) return "";
    const bytes = new TextEncoder().encode(raw);
    return "<" + name + ":" + bytes.length + ">" + raw + " ";
  }

  function buildAdif() {
    const lines = [];
    lines.push("ADIF export from QSL LOGBOOK " + APP_VERSION);
    lines.push(
      "<adif_ver:5>3.1.4" +
      "<programid:" + ADIF_PROGRAM_ID.length + ">" + ADIF_PROGRAM_ID +
      "<programversion:" + APP_VERSION.length + ">" + APP_VERSION +
      "<created_timestamp:15>" + isoStampForAdif() +
      "<eoh>"
    );
    sortedForExport().forEach(function (record) {
      const main = isMain(record);
      const plannedKind = plannedKindOf(record);
      let chunk = "";
      chunk += adifField("qso_date", String(record.qsoDate || "").replace(/-/g, ""));
      chunk += adifField("time_on", String(record.qsoTime || "00:00").replace(/:/g, "") + "00");
      chunk += adifField("call", record.callsign);
      if (isAmateurBand(record.band)) {
        chunk += adifField("band", bandToAdif(record.band));
      } else if (record.band) {
        chunk += adifField("sat_name", String(record.band).trim());
      }
      if (record.mode) chunk += adifField("mode", String(record.mode).toUpperCase());
      chunk += adifField("qsl_sent", main ? "Y" : "N");
      if (main) {
        chunk += adifField("qslsdate", String(record.sentAt || "").replace(/-/g, ""));
        chunk += adifField("qsl_sent_via", "D");
      }
      chunk += adifField("qsl_rcvd", record.otherReceived ? "Y" : "N");
      if (main) chunk += adifField("app_qsllogbook_ownrcvd", record.ownReceived ? "Y" : "N");
      if (!main) chunk += adifField("app_qsllogbook_planned", plannedKind === "reply" ? "reply" : "send");
      chunk += adifField("notes", record.notes);
      lines.push(chunk.trim() + " <eor>");
    });
    return lines.join("\n") + "\n";
  }

  function isoStampForAdif() {
    const d = new Date();
    return (
      String(d.getFullYear()) +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      " " +
      pad2(d.getHours()) +
      pad2(d.getMinutes()) +
      pad2(d.getSeconds())
    );
  }

  function findByte(bytes, target, start) {
    for (let i = start; i < bytes.length; i++) {
      if (bytes[i] === target) return i;
    }
    return -1;
  }

  function parseAdif(text) {
    const bytes = new TextEncoder().encode(String(text || ""));
    const decoder = new TextDecoder("utf-8");
    const rows = [];
    let current = null;
    let i = 0;

    while (i < bytes.length) {
      if (bytes[i] !== 0x3c) {
        i++;
        continue;
      }
      const gt = findByte(bytes, 0x3e, i + 1);
      if (gt === -1) break;
      const spec = decoder.decode(bytes.subarray(i + 1, gt)).trim();
      i = gt + 1;
      const lower = spec.toLowerCase();
      if (lower === "eoh") continue;
      if (lower === "eor") {
        if (current) {
          rows.push(current);
          current = null;
        }
        continue;
      }
      const match = spec.match(/^([A-Za-z0-9_]+)(?::(\d+))?(?::([A-Za-z]))?$/);
      if (!match) continue;
      const name = match[1].toUpperCase();
      const length = match[2] ? Number(match[2]) : 0;
      if (!current) current = {};
      if (length > 0) {
        const end = Math.min(i + length, bytes.length);
        current[name] = decoder.decode(bytes.subarray(i, end)).trim();
        i = end;
      } else {
        current[name] = "";
      }
    }
    if (current) rows.push(current);
    return rows;
  }

  function adifRowToRecord(row) {
    const qsoDate = adifDateToISO(row.QSO_DATE);
    const qsoTime = adifTimeToHM(row.TIME_ON || row.TIME_OFF);
    const callsign = String(row.CALL || "").trim().toUpperCase();
    const band = bandFromAdif(row.SAT_NAME || row.BAND);
    if (!qsoDate || !qsoTime || !callsign || !band) return null;

    const sentFlag = String(row.QSL_SENT || "").trim().toUpperCase();
    const sentDate = adifDateToISO(row.QSLSDATE) || qsoDate;
    const otherReceived = String(row.QSL_RCVD || "").trim().toUpperCase() === "Y" || Boolean(row.QSLRDATE);
    const ownReceived = String(row.APP_QSLLOGBOOK_OWNRCVD || "").trim().toUpperCase() === "Y";
    const sentAt = sentFlag === "Y" ? sentDate : "";
    const plannedKind = sentAt ? (String(row.APP_QSLLOGBOOK_PLANNED || "").toLowerCase() === "reply" ? "reply" : "") : (otherReceived ? "reply" : "send");
    const now = nowISO();

    return normalizeRecord({
      id: uid(),
      qsoDate: qsoDate,
      qsoTime: qsoTime,
      callsign: callsign,
      band: band,
      mode: row.MODE || row.SUBMODE || "",
      sentAt: sentAt,
      plannedKind: plannedKind,
      ownReceived: sentAt ? ownReceived : false,
      otherReceived: otherReceived,
      notes: row.NOTES || row.COMMENT || "",
      createdAt: now,
      updatedAt: now,
    });
  }

  function adifRecordKey(record) {
    return recordIdentity(record);
  }


  function setSaveState(mode) {
    if (!els.saveState) return;
    els.saveState.classList.toggle("is-error", mode === "error");
    els.saveState.classList.toggle("is-saving", mode === "saving");
    els.saveStateText.textContent = mode === "error" ? "保存失败" : "已存本机";
  }

  function showToast(message, options) {
    const opts = options || {};
    const tone = opts.tone || "default";
    const duration = Number(opts.duration) > 0 ? Number(opts.duration) : 3400;
    const region = els.toastRegion;
    if (!region) return;

    while (region.children.length >= 3) {
      region.removeChild(region.firstElementChild);
    }

    const toast = document.createElement("div");
    toast.className = "toast" + (tone === "error" ? " is-error" : "");
    toast.dataset.toastId = String(++toastId);
    const iconName = tone === "error" ? "i-info" : "i-check";
    toast.innerHTML =
      '<svg class="icon" aria-hidden="true"><use href="#' + iconName + '"/></svg>' +
      '<span class="toast-text"></span>';
    toast.querySelector(".toast-text").textContent = message;

    if (opts.action && typeof opts.onAction === "function") {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "toast-action";
      action.textContent = opts.action;
      action.addEventListener("click", function () {
        dismissToast(toast);
        opts.onAction();
      });
      toast.appendChild(action);
    }

    region.appendChild(toast);
    const timer = window.setTimeout(function () {
      dismissToast(toast);
    }, duration);
    toast.addEventListener("mouseenter", function () {
      window.clearTimeout(timer);
    }, { once: true });
    toast.addEventListener("mouseleave", function () {
      window.setTimeout(function () {
        dismissToast(toast);
      }, 1200);
    }, { once: true });
  }

  function dismissToast(toast) {
    if (!toast || !toast.parentNode || toast.dataset.leaving === "1") return;
    toast.dataset.leaving = "1";
    toast.classList.add("is-leaving");
    window.setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 190);
  }

  /* =========================================================
     Storage
     ========================================================= */

  function parseStoredRecords(text) {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.records) ? parsed.records : null;
    if (!list) throw new Error("数据格式无法识别。");
    const seen = new Set();
    const clean = [];
    let skipped = 0;
    for (const raw of list) {
      const record = normalizeRecord(raw);
      if (!record || seen.has(record.id)) {
        skipped++;
        continue;
      }
      seen.add(record.id);
      clean.push(record);
    }
    return { records: clean, skipped: skipped };
  }

  function loadRecords() {
    let text;
    try {
      text = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      setSaveState("error");
      window.setTimeout(function () {
        showToast("浏览器禁止了本机存储，记录可能无法保存。", { tone: "error", duration: 6000 });
      }, 300);
      return [];
    }
    if (!text) return [];

    try {
      const result = parseStoredRecords(text);
      if (result.skipped > 0) {
        window.setTimeout(function () {
          showToast("已忽略 " + result.skipped + " 条不完整的本机记录。", { tone: "error", duration: 5000 });
        }, 300);
      }
      return result.records;
    } catch (error) {
      try {
        localStorage.setItem(STORAGE_KEY + "-corrupt-" + Date.now(), text);
      } catch (backupError) {
        /* ignore */
      }
      window.setTimeout(function () {
        showToast("本机数据读取失败，原始内容已另存为备份副本。", { tone: "error", duration: 6000 });
      }, 300);
      return [];
    }
  }

  function requestPersistentStorage() {
    if (persistRequested) return;
    persistRequested = true;
    try {
      if (navigator.storage && typeof navigator.storage.persist === "function") {
        navigator.storage.persist().catch(function () {
          /* not critical */
        });
      }
    } catch (error) {
      /* ignore */
    }
  }

  function persist() {
    setSaveState("saving");
    try {
      const payload = {
        app: "QSL LOGBOOK",
        schemaVersion: 1,
        appVersion: APP_VERSION,
        updatedAt: nowISO(),
        records: records,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      setSaveState("saved");
      requestPersistentStorage();
      return true;
    } catch (error) {
      setSaveState("error");
      if (!storageErrorShown) {
        storageErrorShown = true;
        showToast("无法写入本机存储，请检查浏览器空间或隐私设置。", { tone: "error", duration: 6000 });
      }
      return false;
    }
  }

  /* =========================================================
     Filtering & rendering
     ========================================================= */

  function filtersActive() {
    return Boolean(
      filters.q ||
      filters.from ||
      filters.to ||
      (filters.status && filters.status !== "all") ||
      (filters.planKind && filters.planKind !== "all")
    );
  }

  function isStatusMatch(record) {
    switch (filters.status) {
      case "any-pending":
        return !record.ownReceived || !record.otherReceived;
      case "own-pending":
        return !record.ownReceived;
      case "other-pending":
        return !record.otherReceived;
      case "both-received":
        return record.ownReceived && record.otherReceived;
      default:
        return true;
    }
  }

  function filterRecords(source) {
    const query = filters.q.trim().toLowerCase();
    return source.filter(function (record) {
      if (query) {
        const planText = record.sentAt
          ? ""
          : plannedKindOf(record) === "reply"
            ? "待回寄 回寄 已收卡 已收到对方卡片"
            : "待寄出 先寄出 等待寄卡";
        const haystack = [
          record.callsign,
          record.band,
          record.mode,
          record.notes,
          record.qsoDate,
          record.qsoTime,
          record.sentAt,
          planText,
        ].join("\n").toLowerCase();
        if (haystack.indexOf(query) === -1) return false;
      }

      if (filters.from || filters.to) {
        const value = filters.dateField === "sent" ? record.sentAt : record.qsoDate;
        if (!value) return false;
        if (filters.from && value < filters.from) return false;
        if (filters.to && value > filters.to) return false;
      }

      if (activeTab === "main" && !isStatusMatch(record)) return false;

      if (activeTab === "planned" && filters.planKind && filters.planKind !== "all") {
        if (plannedKindOf(record) !== filters.planKind) return false;
      }

      return true;
    });
  }

  function renderStats() {
    const main = getMainRecords();
    const planned = getPlannedRecords();
    const own = main.filter(function (record) {
      return record.ownReceived;
    }).length;
    const other = main.filter(function (record) {
      return record.otherReceived;
    }).length;

    els.statMain.textContent = String(main.length);
    els.statPlanned.textContent = String(planned.length);
    const plannedSend = planned.filter(function (record) {
      return plannedKindOf(record) === "send";
    }).length;
    const plannedReply = planned.length - plannedSend;

    els.statOwn.textContent = String(own);
    els.statOther.textContent = String(other);
    els.statOwnTotal.textContent = String(main.length);
    els.statOtherTotal.textContent = String(main.length);
    els.statPlannedBreakdown.textContent = "待寄出 " + plannedSend + " · 待回寄 " + plannedReply;
  }

  function renderTabs() {
    const mainCount = getMainRecords().length;
    const plannedCount = getPlannedRecords().length;
    els.tabMainCount.textContent = String(mainCount);
    els.tabPlannedCount.textContent = String(plannedCount);
    els.tabMain.classList.toggle("is-active", activeTab === "main");
    els.tabPlanned.classList.toggle("is-active", activeTab === "planned");
    els.tabMain.setAttribute("aria-selected", activeTab === "main" ? "true" : "false");
    els.tabPlanned.setAttribute("aria-selected", activeTab === "planned" ? "true" : "false");
  }

  function refreshFilterUI() {
    const sentOption = els.dateField.querySelector('option[value="sent"]');
    if (activeTab === "planned") {
      if (sentOption) sentOption.disabled = true;
      if (filters.dateField === "sent") {
        filters.dateField = "qso";
        els.dateField.value = "qso";
      }
    } else if (sentOption) {
      sentOption.disabled = false;
    }

    els.statusFilter.classList.toggle("is-hidden", activeTab === "planned");
    els.planFilter.classList.toggle("is-hidden", activeTab !== "planned");
    if (els.dateField.value !== filters.dateField) els.dateField.value = filters.dateField;
    if (els.statusFilter.value !== filters.status) els.statusFilter.value = filters.status;
    if (els.planFilter.value !== filters.planKind) els.planFilter.value = filters.planKind;
    if (els.filterFrom.value !== filters.from) els.filterFrom.value = filters.from;
    if (els.filterTo.value !== filters.to) els.filterTo.value = filters.to;
    if (els.searchInput.value !== filters.q) els.searchInput.value = filters.q;
    els.clearSearch.hidden = !filters.q;
    els.resetFilters.hidden = !filtersActive();
  }

  function receiveButton(record, field, label, sublabel, action) {
    const on = Boolean(record[field]);
    return (
      '<button class="receive-btn' + (on ? " is-on" : "") + '" type="button" data-action="' + action + '" aria-pressed="' + (on ? "true" : "false") + '">' +
        '<span class="receive-indicator" aria-hidden="true">' + (on ? icon("i-check") : "") + "</span>" +
        '<span class="receive-copy">' +
          "<span>" + escapeHTML(label) + "</span>" +
          "<small>" + escapeHTML(on ? "已收妥" : sublabel) + "</small>" +
        "</span>" +
      "</button>"
    );
  }

  function recordCardHTML(record) {
    const planned = !isMain(record);
    const kind = planned ? plannedKindOf(record) : "";
    const reply = kind === "reply";
    const selecting = selectionMode;
    const selected = selecting && selectedIds.has(record.id);
    const notes = record.notes
      ? '<p class="record-notes">' + escapeHTML(record.notes) + "</p>"
      : "";

    const meta = [];
    if (record.mode) {
      meta.push('<span class="meta-item">' + icon("i-radio") + "<strong>" + escapeHTML(record.mode) + "</strong></span>");
    }
    if (!planned) {
      meta.push('<span class="meta-item">' + icon("i-send") + "发卡 <strong>" + escapeHTML(record.sentAt) + "</strong></span>");
    } else if (record.otherReceived) {
      meta.push('<span class="meta-item is-received">' + icon("i-check") + "对方卡片已收妥</span>");
    }

    const footer = planned
      ? '<div class="planned-foot">' +
          '<p class="planned-hint">' + icon(reply ? "i-reply" : "i-info") + "<span>" +
            (reply
              ? "已收到对方卡片 · 填写回寄日期后移入主记录"
              : "填写发卡日期后自动移入主记录") +
          "</span></p>" +
          '<div class="send-form">' +
            '<input class="send-date" type="date" data-role="send-date" aria-label="' + (reply ? "回寄日期" : "发卡日期") + '">' +
            '<button class="btn btn-primary btn-sm" type="button" data-action="complete">' + icon("i-check") + "<span>" +
              (reply ? "确认回寄" : "确认寄出") +
            "</span></button>" +
          "</div>" +
          '<p class="send-error" hidden>请选择' + (reply ? "回寄" : "发卡") + '日期</p>' +
        "</div>"
      : '<div class="receive-row">' +
          receiveButton(record, "ownReceived", "己方卡片", "待收妥", "toggle-own") +
          receiveButton(record, "otherReceived", "对方卡片", "待收妥", "toggle-other") +
        "</div>";

    const cardClasses = "record-card" +
      (planned ? " is-planned" : "") +
      (planned && reply ? " is-reply" : "") +
      (selecting ? " is-selectable" : "") +
      (selected ? " is-selected" : "");

    return (
      '<article class="' + cardClasses + '" data-id="' + escapeHTML(record.id) + '">' +
        '<div class="record-top">' +
          (selecting
            ? '<button class="select-box" type="button" data-action="select" aria-pressed="' + (selected ? "true" : "false") + '" aria-label="选择 ' + escapeHTML(record.callsign) + ' 的记录">' + icon("i-check") + "</button>"
            : "") +
          '<div class="record-identity">' +
            '<div class="record-call-line">' +
              '<h3 class="record-callsign">' + escapeHTML(record.callsign) + "</h3>" +
              (record.band ? '<span class="band-pill">' + escapeHTML(record.band) + "</span>" : "") +
              (planned
                ? '<span class="pending-pill' + (reply ? " is-reply" : "") + '">' +
                    (reply ? "待回寄" : "待寄出") +
                  "</span>"
                : "") +
            "</div>" +
            '<p class="record-qso">' + icon("i-clock") + escapeHTML(record.qsoDate) + " · " + escapeHTML(record.qsoTime) + "</p>" +
          "</div>" +
          '<div class="record-actions">' +
            '<button class="icon-btn" type="button" data-action="edit" aria-label="编辑 ' + escapeHTML(record.callsign) + ' 的记录" title="编辑">' + icon("i-edit") + "</button>" +
            '<button class="icon-btn danger" type="button" data-action="delete" aria-label="删除 ' + escapeHTML(record.callsign) + ' 的记录" title="删除">' + icon("i-trash") + "</button>" +
          "</div>" +
        "</div>" +
        (meta.length ? '<div class="record-meta">' + meta.join("") + "</div>" : "") +
        notes +
        footer +
      "</article>"
    );
  }

  function renderEmptyState(sourceLength, resultLength) {
    if (resultLength > 0) {
      els.emptyState.hidden = true;
      return;
    }

    els.emptyState.hidden = false;
    if (filtersActive()) {
      els.emptyTitle.textContent = "没有匹配的记录";
      els.emptyText.textContent = "换个呼号或关键词，或者调整一下日期范围。";
      els.emptyAction.dataset.action = "reset";
      els.emptyActionText.textContent = "清除筛选";
      return;
    }

    if (activeTab === "main") {
      els.emptyTitle.textContent = "还没有主记录";
      els.emptyText.textContent = "从一条通联日志开始，建立你的第一张 QSL 卡片。";
      els.emptyAction.dataset.action = "add-main";
      els.emptyActionText.textContent = "记录第一条通联";
    } else {
      els.emptyTitle.textContent = "计划里还没有记录";
      els.emptyText.textContent = "先记录通联，选择「先寄出」或「待回寄」；寄出后补上日期，就会自动移入主记录。";
      els.emptyAction.dataset.action = "add-planned";
      els.emptyActionText.textContent = "添加待发卡记录";
    }
  }

  function renderList() {
    const source = activeTab === "main" ? getMainRecords() : getPlannedRecords();
    const visible = filterRecords(source);

    els.recordList.innerHTML = visible.map(recordCardHTML).join("");
    els.recordList.setAttribute("aria-labelledby", activeTab === "main" ? "tabMain" : "tabPlanned");
    els.resultMeta.textContent = filtersActive()
      ? "筛选出 " + visible.length + " 条 · 共 " + source.length + " 条"
      : "共 " + source.length + " 条记录";
    renderEmptyState(source.length, visible.length);
    syncBatchBar(visible);
  }

  function getVisibleRecords() {
    const source = activeTab === "main" ? getMainRecords() : getPlannedRecords();
    return filterRecords(source);
  }

  function selectedRecords() {
    return records.filter(function (record) {
      return selectedIds.has(record.id);
    });
  }

  function setSelectionMode(on) {
    selectionMode = Boolean(on);
    if (!selectionMode) selectedIds.clear();
    document.body.classList.toggle("selection-mode", selectionMode);
    els.selectModeBtn.setAttribute("aria-pressed", selectionMode ? "true" : "false");
    els.selectModeText.textContent = selectionMode ? "完成" : "多选";
    if (selectionMode && !els.batchSendDate.value) els.batchSendDate.value = todayISO();
    els.batchBar.hidden = !selectionMode;
    renderAll();
  }

  function toggleSelected(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    syncSelectionUI();
  }

  function syncSelectionUI() {
    $$(".record-card", els.recordList).forEach(function (card) {
      const id = card.getAttribute("data-id");
      const on = selectedIds.has(id);
      card.classList.toggle("is-selected", on);
      const box = card.querySelector('[data-action="select"]');
      if (box) box.setAttribute("aria-pressed", on ? "true" : "false");
    });
    syncBatchBar(getVisibleRecords());
  }

  function syncBatchBar(visible) {
    const validIds = new Set(records.map(function (record) {
      return record.id;
    }));
    Array.from(selectedIds).forEach(function (id) {
      if (!validIds.has(id)) selectedIds.delete(id);
    });

    const count = selectedIds.size;
    const mainTab = activeTab === "main";

    els.batchBar.hidden = !selectionMode;
    els.batchCount.textContent = String(count);

    [els.batchOwn, els.batchOther].forEach(function (button) {
      button.hidden = !mainTab;
    });
    [els.batchDateSep, els.batchSendDate, els.batchComplete].forEach(function (element) {
      element.hidden = mainTab;
    });

    [els.batchOwn, els.batchOther, els.batchComplete, els.batchDelete, els.batchClear].forEach(function (button) {
      button.disabled = count === 0;
    });

    const allSelected = visible.length > 0 && visible.every(function (record) {
      return selectedIds.has(record.id);
    });
    els.batchSelectAll.textContent = allSelected ? "取消全选" : "全选";
    els.batchSelectAll.disabled = visible.length === 0;
  }

  function batchToggleReceived(field) {
    const items = selectedRecords().filter(isMain);
    if (!items.length) return;
    const allOn = items.every(function (record) {
      return Boolean(record[field]);
    });
    items.forEach(function (record) {
      record[field] = !allOn;
      record.updatedAt = nowISO();
    });
    persist();
    renderAll();
    showToast(
      (field === "ownReceived" ? "己方" : "对方") + "卡片已批量标记为" + (allOn ? "未收妥" : "已收妥") + " · " + items.length + " 条"
    );
  }

  async function batchCompletePlanned() {
    const items = selectedRecords().filter(function (record) {
      return !isMain(record);
    });
    if (!items.length) {
      showToast("请先选中计划中的记录", { tone: "error" });
      return;
    }
    const date = normalizeDateValue(els.batchSendDate.value) || todayISO();
    const ok = await showConfirm({
      title: "确认 " + items.length + " 条记录已发卡？",
      message: "发卡日期：" + date + "。确认后这些记录会移入主记录。",
      okLabel: "确认发卡",
    });
    if (!ok) return;

    items.forEach(function (record) {
      if (plannedKindOf(record) === "reply") record.otherReceived = true;
      record.sentAt = date;
      record.plannedKind = "";
      record.updatedAt = nowISO();
    });
    selectedIds.clear();
    persist();
    renderAll();
    showToast("已确认发卡 " + items.length + " 条");
  }

  async function batchDeleteSelected() {
    const items = selectedRecords();
    if (!items.length) return;
    const ok = await showConfirm({
      title: "删除选中的 " + items.length + " 条记录？",
      message: "这些记录将被永久删除，删除后仍可在提示条中撤销。",
      okLabel: "删除 " + items.length + " 条",
      danger: true,
    });
    if (!ok) return;

    const removed = items.slice();
    const removedIds = new Set(removed.map(function (record) {
      return record.id;
    }));
    records = records.filter(function (record) {
      return !removedIds.has(record.id);
    });
    selectedIds.clear();
    persist();
    renderAll();
    showToast("已删除 " + removed.length + " 条记录", {
      action: "撤销",
      duration: 7000,
      onAction: function () {
        removed.forEach(function (record) {
          records.push(record);
        });
        persist();
        renderAll();
        showToast("已恢复 " + removed.length + " 条记录");
      },
    });
  }

  function renderAll() {
    renderStats();
    renderTabs();
    refreshFilterUI();
    renderList();
  }

  function switchTab(tab, options) {
    const opts = options || {};
    if (tab !== "main" && tab !== "planned") return;
    activeTab = tab;
    if (selectionMode) {
      selectionMode = false;
      selectedIds.clear();
      document.body.classList.remove("selection-mode");
      els.selectModeBtn.setAttribute("aria-pressed", "false");
      els.selectModeText.textContent = "多选";
      els.batchBar.hidden = true;
    }
    if (tab === "planned") {
      // 发卡日期筛选和收妥状态筛选只适用于主记录；
      // 切页时清掉，避免隐藏的筛选条件影响结果或让“重置”显得莫名出现。
      if (filters.dateField === "sent") {
        filters.dateField = "qso";
        filters.from = "";
        filters.to = "";
      }
      filters.status = "all";
    } else {
      filters.planKind = "all";
    }
    renderAll();
    if (opts.focus) {
      (tab === "main" ? els.tabMain : els.tabPlanned).focus({ preventScroll: true });
    }
  }

  /* =========================================================
     Dialogs / confirmation
     ========================================================= */

  function updateModalLock() {
    const anyOpen = $$("dialog[open]").length > 0;
    document.body.classList.toggle("modal-open", anyOpen);
  }

  function openModal(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === "function" && !dialog.open) {
      try {
        dialog.showModal();
      } catch (error) {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    updateModalLock();
  }

  function closeModal(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) {
      try {
        dialog.close();
      } catch (error) {
        dialog.removeAttribute("open");
      }
    } else {
      dialog.removeAttribute("open");
    }
    updateModalLock();
  }

  function showConfirm(options) {
    const opts = options || {};
    return new Promise(function (resolve) {
      if (confirmState) {
        const previous = confirmState;
        confirmState = null;
        previous.resolve(false);
      }
      confirmState = { resolve: resolve };
      els.confirmTitle.textContent = opts.title || "确认操作";
      els.confirmMessage.textContent = opts.message || "";
      els.confirmOk.textContent = opts.okLabel || "确认";
      els.confirmOk.className = "btn " + (opts.danger ? "btn-danger" : "btn-primary");
      els.confirmCancel.textContent = opts.cancelLabel || "取消";
      els.confirmIcon.classList.toggle("is-danger", Boolean(opts.danger));
      const use = els.confirmIcon.querySelector("use");
      if (use) use.setAttribute("href", opts.danger ? "#i-trash" : "#i-info");
      openModal(els.confirmDialog);
      window.setTimeout(function () {
        els.confirmCancel.focus();
      }, 20);
    });
  }

  function finishConfirm(result) {
    if (!confirmState) return;
    const state = confirmState;
    confirmState = null;
    closeModal(els.confirmDialog);
    state.resolve(Boolean(result));
  }

  /* =========================================================
     Record form
     ========================================================= */

  const fieldMap = {};

  function cacheFieldMap() {
    fieldMap.qsoDate = { input: els.qsoDate, error: els.errQsoDate, label: "通联日期" };
    fieldMap.qsoTime = { input: els.qsoTime, error: els.errQsoTime, label: "通联时间" };
    fieldMap.callsign = { input: els.callsign, error: els.errCallsign, label: "对方呼号" };
    fieldMap.band = { input: els.band, error: els.errBand, label: "频段 / 卫星" };
    fieldMap.sentAt = { input: els.sentAt, error: els.errSentAt, label: "发卡日期" };
  }

  function setFieldError(name, message) {
    const field = fieldMap[name];
    if (!field) return;
    if (message) {
      field.input.setAttribute("aria-invalid", "true");
      field.error.textContent = message;
      field.error.hidden = false;
    } else {
      field.input.removeAttribute("aria-invalid");
      field.error.textContent = "";
      field.error.hidden = true;
    }
  }

  function clearAllErrors() {
    Object.keys(fieldMap).forEach(function (name) {
      setFieldError(name, "");
    });
  }

  function getSelectedMode() {
    const checked = $('input[name="recordMode"]:checked', els.recordForm);
    return checked && checked.value === "planned" ? "planned" : "main";
  }

  function getPlannedKind() {
    const checked = $('input[name="plannedKind"]:checked', els.recordForm);
    return checked && checked.value === "reply" ? "reply" : "send";
  }

  function setPlannedKind(kind) {
    $$('input[name="plannedKind"]', els.recordForm).forEach(function (radio) {
      radio.checked = radio.value === (kind === "reply" ? "reply" : "send");
    });
  }

  function syncReceivedState() {
    const planned = getSelectedMode() === "planned";
    const hasDate = Boolean(els.sentAt.value);
    const kind = getPlannedKind();
    const canMarkOwn = hasDate;
    const canMarkOther = hasDate || planned;

    els.receivedFieldset.disabled = !(canMarkOwn || canMarkOther);
    els.ownReceived.disabled = !canMarkOwn;
    els.otherReceived.disabled = !canMarkOther;
    if (!canMarkOwn) els.ownReceived.checked = false;
    if (planned && kind === "reply") els.otherReceived.checked = true;

    if (planned) {
      els.receivedHint.textContent = kind === "reply"
        ? "已标记收到对方卡片；寄回本台卡片后，可在主记录确认己方收妥。"
        : "如已收到对方卡片，可勾选“对方卡片收妥”，计划类型会自动变为“待回寄”。";
    } else if (hasDate) {
      els.receivedHint.textContent = "记录己方与对方卡片的收妥情况。";
    } else {
      els.receivedHint.textContent = "填写发卡日期后，即可标记收妥状态。";
    }
  }

  function syncModeUI() {
    const mode = getSelectedMode();
    const planned = mode === "planned";
    const kind = getPlannedKind();
    const reply = planned && kind === "reply";
    const hasDate = Boolean(els.sentAt.value);

    els.planKindField.hidden = !planned;
    els.sentLabelText.textContent = reply ? "回寄日期" : "发卡日期";
    els.sentRequired.hidden = planned;
    els.plannedBanner.hidden = !planned;
    els.plannedBanner.classList.toggle("is-reply", reply);

    if (planned) {
      if (hasDate) {
        els.sentHint.textContent = reply
          ? "已填写回寄日期，保存后将自动移入主记录。"
          : "已填写发卡日期，保存后将自动归入主记录。";
      } else {
        els.sentHint.textContent = reply
          ? "可留空；之后补充回寄日期即可移入主记录。"
          : "可留空；之后补充发卡日期即可移入主记录。";
      }

      const bannerIcon = els.plannedBanner.querySelector("use");
      if (bannerIcon) bannerIcon.setAttribute("href", reply ? "#i-reply" : "#i-clock");
      const bannerText = els.plannedBanner.querySelector("p");
      if (bannerText) {
        if (hasDate) {
          bannerText.innerHTML = reply
            ? "<strong>已填写回寄日期</strong>保存后将自动归入主记录。"
            : "<strong>已填写发卡日期</strong>保存后将自动归入主记录。";
        } else if (reply) {
          bannerText.innerHTML = "<strong>待回寄</strong>已收到对方卡片，填写回寄日期后自动移入主记录。";
        } else {
          bannerText.innerHTML = "<strong>待寄出</strong>先寄出本台卡片，之后补充发卡日期即可移入主记录。";
        }
      }
    } else {
      els.sentHint.textContent = "本台卡片寄出的日期，主记录必填。";
    }

    syncReceivedState();
  }

  function populateForm() {
    els.qsoDate.value = draft.qsoDate || "";
    els.qsoTime.value = draft.qsoTime || "";
    els.callsign.value = draft.callsign || "";
    els.band.value = draft.band || "";
    els.qsoMode.value = draft.mode || "";
    els.sentAt.value = draft.sentAt || "";
    els.ownReceived.checked = Boolean(draft.ownReceived);
    els.otherReceived.checked = Boolean(draft.otherReceived);
    const draftKind = draft.plannedKind === "reply" || (!draft.sentAt && draft.otherReceived) ? "reply" : "send";
    setPlannedKind(draftKind);
    els.notes.value = draft.notes || "";
    els.notesCount.textContent = Array.from(els.notes.value).length + " / " + MAX_NOTES;

    const mode = draft.sentAt ? "main" : draft.modeChoice === "planned" ? "planned" : "main";
    $$('input[name="recordMode"]', els.recordForm).forEach(function (radio) {
      radio.checked = radio.value === mode;
    });
    syncModeUI();
    clearAllErrors();
    els.recordDialog.querySelector(".modal-body").scrollTop = 0;
  }

  function showStep(step) {
    draftStep = step === 2 ? 2 : 1;
    $$("[data-step-panel]", els.recordForm).forEach(function (panel) {
      panel.hidden = Number(panel.getAttribute("data-step-panel")) !== draftStep;
    });
    $$("[data-goto-step]", els.recordForm).forEach(function (button) {
      const buttonStep = Number(button.getAttribute("data-goto-step"));
      button.classList.toggle("is-active", buttonStep === draftStep);
      button.classList.toggle("is-done", buttonStep < draftStep);
    });
    els.prevStep.hidden = draftStep === 1;
    els.nextStep.hidden = draftStep === 2;
    els.saveRecord.hidden = draftStep !== 2;
    els.recordDialog.querySelector(".modal-body").scrollTop = 0;
  }

  function openAddDialog(mode) {
    editingId = null;
    draft = {
      qsoDate: todayISO(),
      qsoTime: nowHM(),
      callsign: "",
      band: "",
      mode: "",
      sentAt: "",
      ownReceived: false,
      otherReceived: false,
      plannedKind: "send",
      notes: "",
      modeChoice: mode === "planned" ? "planned" : "main",
    };
    draftDirty = false;
    els.recordEyebrow.textContent = "新建记录";
    els.recordTitle.textContent = "记录一次通联";
    els.saveRecordText.textContent = "保存记录";
    populateForm();
    showStep(1);
    openModal(els.recordDialog);
    window.setTimeout(function () {
      let finePointer = false;
      try {
        finePointer = window.matchMedia("(pointer: fine)").matches;
      } catch (error) {
        finePointer = false;
      }
      if (finePointer && window.innerWidth >= 900) els.callsign.focus();
    }, 30);
  }

  function openEditDialog(id) {
    const record = records.find(function (item) {
      return item.id === id;
    });
    if (!record) return;
    editingId = record.id;
    draft = Object.assign({}, record);
    draft.modeChoice = isMain(record) ? "main" : "planned";
    draftDirty = false;
    els.recordEyebrow.textContent = "编辑记录";
    els.recordTitle.textContent = "编辑 " + record.callsign;
    els.saveRecordText.textContent = "保存修改";
    populateForm();
    showStep(1);
    openModal(els.recordDialog);
  }

  async function requestCloseRecordDialog() {
    if (!draftDirty) {
      closeModal(els.recordDialog);
      return;
    }
    const discard = await showConfirm({
      title: "放弃未保存的修改？",
      message: "当前填写的内容还没有保存，关闭后将丢失。",
      okLabel: "放弃修改",
      cancelLabel: "继续填写",
      danger: true,
    });
    if (discard) {
      draftDirty = false;
      closeModal(els.recordDialog);
    }
  }

  function validateStep1(focus) {
    let firstInvalid = null;
    const qsoDate = normalizeDateValue(els.qsoDate.value);
    const qsoTime = normalizeTimeValue(els.qsoTime.value);
    const callsign = els.callsign.value.trim();
    const band = els.band.value.trim();

    if (!isISODate(qsoDate)) {
      setFieldError("qsoDate", "请选择通联日期。");
      firstInvalid = firstInvalid || els.qsoDate;
    } else {
      setFieldError("qsoDate", "");
    }
    if (!qsoTime) {
      setFieldError("qsoTime", "请填写通联时间。");
      firstInvalid = firstInvalid || els.qsoTime;
    } else {
      setFieldError("qsoTime", "");
    }
    if (!callsign) {
      setFieldError("callsign", "请填写对方呼号。");
      firstInvalid = firstInvalid || els.callsign;
    } else {
      setFieldError("callsign", "");
    }
    if (!band) {
      setFieldError("band", "请填写频段或卫星。");
      firstInvalid = firstInvalid || els.band;
    } else {
      setFieldError("band", "");
    }

    if (firstInvalid && focus !== false) firstInvalid.focus();
    return !firstInvalid;
  }

  function validateStep2(focus) {
    const mode = getSelectedMode();
    const sent = normalizeDateValue(els.sentAt.value);
    let invalid = null;

    if (els.sentAt.value && !sent) {
      setFieldError("sentAt", "发卡日期格式不正确。");
      invalid = els.sentAt;
    } else if (mode === "main" && !sent) {
      setFieldError("sentAt", "主记录必须填写发卡日期；如果尚未发卡，请选“计划中”。");
      invalid = els.sentAt;
    } else {
      setFieldError("sentAt", "");
    }

    if (invalid && focus !== false) invalid.focus();
    return !invalid;
  }

  function saveRecord() {
    const step1Ok = validateStep1(false);
    if (!step1Ok) {
      showStep(1);
      validateStep1(true);
      return;
    }
    const step2Ok = validateStep2(false);
    if (!step2Ok) {
      showStep(2);
      validateStep2(true);
      return;
    }

    const mode = getSelectedMode();
    const sentAt = normalizeDateValue(els.sentAt.value);
    const finalStatus = sentAt ? "main" : "planned";
    if (mode === "main" && !sentAt) {
      showStep(2);
      validateStep2(true);
      return;
    }

    const now = nowISO();
    const isNew = !editingId;
    const oldRecord = editingId
      ? records.find(function (record) {
          return record.id === editingId;
        })
      : null;
    const wasMain = oldRecord ? isMain(oldRecord) : false;
    let plannedKind = finalStatus === "planned" ? getPlannedKind() : "";
    let otherReceived = els.otherReceived.checked;
    if (finalStatus === "planned" && otherReceived) plannedKind = "reply";
    if (finalStatus === "planned" && plannedKind === "reply") otherReceived = true;

    const next = {
      id: editingId || uid(),
      qsoDate: normalizeDateValue(els.qsoDate.value),
      qsoTime: normalizeTimeValue(els.qsoTime.value),
      callsign: els.callsign.value.trim().toUpperCase(),
      band: els.band.value.trim(),
      mode: els.qsoMode.value.trim(),
      sentAt: sentAt,
      plannedKind: plannedKind,
      ownReceived: finalStatus === "planned" ? false : els.ownReceived.checked,
      otherReceived: otherReceived,
      notes: els.notes.value.replace(/\r\n/g, "\n").slice(0, MAX_NOTES),
      createdAt: oldRecord ? oldRecord.createdAt : now,
      updatedAt: now,
    };

    if (isNew) {
      const duplicate = findDuplicate(next);
      if (duplicate) {
        showConfirm({
          title: "可能重复的记录",
          message: "已存在 " + duplicate.callsign + " · " + duplicate.qsoDate + " " + duplicate.qsoTime + " · " + duplicate.band + " 的记录。仍然继续保存吗？",
          okLabel: "仍然保存",
          cancelLabel: "返回修改",
        }).then(function (ok) {
          if (ok) commitRecord(next, isNew, oldRecord, finalStatus);
        });
        return;
      }
    }

    commitRecord(next, isNew, oldRecord, finalStatus);
  }

  function commitRecord(next, isNew, oldRecord, finalStatus) {
    if (isNew) {
      records.push(next);
    } else {
      const index = records.findIndex(function (record) {
        return record.id === next.id;
      });
      if (index === -1) return;
      records[index] = next;
    }

    const success = persist();
    draftDirty = false;
    closeModal(els.recordDialog);

    if (isNew && activeTab !== finalStatus) {
      activeTab = finalStatus;
    }
    renderAll();

    if (!success) {
      showToast("记录已保留在当前页面，但写入本机存储失败。", { tone: "error", duration: 5000 });
      return;
    }

    let message;
    let action = "";
    let onAction = null;
    if (oldRecord) {
      if (!wasMain && finalStatus === "main") {
        message = next.callsign + " 已移入主记录";
        action = "查看";
        onAction = function () {
          switchTab("main", { focus: true });
        };
      } else if (wasMain && finalStatus === "planned") {
        message = next.callsign + " 已移入计划中";
        action = "查看";
        onAction = function () {
          switchTab("planned", { focus: true });
        };
      } else {
        message = "记录已更新";
      }
    } else {
      message = finalStatus === "main" ? "已保存到主记录" : "已保存到计划中";
    }
    showToast(message, { action: action, onAction: onAction });
  }

  /* =========================================================
     Record actions
     ========================================================= */

  function toggleReceived(id, field) {
    const record = records.find(function (item) {
      return item.id === id;
    });
    if (!record || !isMain(record)) return;
    record[field] = !record[field];
    record.updatedAt = nowISO();
    persist();
    const action = field === "ownReceived" ? "toggle-own" : "toggle-other";
    renderAll();
    const selector = '.record-card[data-id="' + id.replace(/"/g, '\\"') + '"] [data-action="' + action + '"]';
    const button = $(selector);
    if (button) button.focus({ preventScroll: true });
  }

  function completePlanned(id, card) {
    const record = records.find(function (item) {
      return item.id === id;
    });
    if (!record || isMain(record)) return;
    const input = card.querySelector('[data-role="send-date"]');
    const error = card.querySelector(".send-error");
    const date = normalizeDateValue(input ? input.value : "");
    if (!date) {
      if (input) {
        input.classList.add("has-error");
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
      if (error) error.hidden = false;
      return;
    }

    const wasReply = plannedKindOf(record) === "reply";
    record.sentAt = date;
    record.plannedKind = "";
    if (wasReply) record.otherReceived = true;
    record.updatedAt = nowISO();
    persist();
    renderAll();
    showToast(record.callsign + (wasReply ? " 已回寄，移入主记录" : " 已移入主记录"), {
      action: "查看",
      onAction: function () {
        switchTab("main", { focus: true });
      },
    });
  }

  async function deleteRecord(id) {
    const record = records.find(function (item) {
      return item.id === id;
    });
    if (!record) return;
    const status = isMain(record) ? "主记录" : "计划中";
    const ok = await showConfirm({
      title: "删除这条记录？",
      message: record.callsign + " · " + record.qsoDate + " " + record.qsoTime + "（" + status + "）将被删除，删除后可在提示条中撤销。",
      okLabel: "删除记录",
      danger: true,
    });
    if (!ok) return;
    const snapshot = Object.assign({}, record);
    records = records.filter(function (item) {
      return item.id !== id;
    });
    persist();
    renderAll();
    showToast("记录已删除", {
      action: "撤销",
      duration: 6000,
      onAction: function () {
        records.push(snapshot);
        persist();
        renderAll();
        showToast("已恢复 " + snapshot.callsign + " 的记录");
      },
    });
  }

  /* =========================================================
     Backup: export
     ========================================================= */

  function sortedForExport() {
    return records.slice().sort(compareQsoDesc);
  }

  function backupObject() {
    const exportedAt = nowISO();
    return {
      app: "QSL LOGBOOK",
      schemaVersion: 1,
      appVersion: APP_VERSION,
      exportedAt: exportedAt,
      records: sortedForExport().map(function (record) {
        return {
          id: record.id,
          status: isMain(record) ? "main" : "planned",
          qsoDate: record.qsoDate,
          qsoTime: record.qsoTime,
          callsign: record.callsign,
          band: record.band,
          mode: record.mode,
          sentAt: record.sentAt,
          plannedKind: record.plannedKind || "",
          ownReceived: record.ownReceived,
          otherReceived: record.otherReceived,
          notes: record.notes,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
      }),
    };
  }

  function buildCsv() {
    const header = [
      "通联日期",
      "通联时间",
      "对方呼号",
      "频段/卫星",
      "模式",
      "记录状态",
      "计划类型",
      "本台发卡日期",
      "己方卡片收妥",
      "对方卡片收妥",
      "备注",
      "记录ID",
      "创建时间",
      "更新时间",
    ];
    const rows = sortedForExport().map(function (record) {
      const main = isMain(record);
      return [
        record.qsoDate,
        record.qsoTime,
        record.callsign,
        record.band,
        record.mode,
        main ? "主记录" : "计划中",
        main ? "-" : plannedKindLabel(record),
        record.sentAt,
        main ? (record.ownReceived ? "是" : "否") : "-",
        record.otherReceived ? "是" : "否",
        record.notes,
        record.id,
        record.createdAt,
        record.updatedAt,
      ];
    });
    const lines = [header].concat(rows).map(function (row) {
      return row.map(function (cell) {
        return '"' + String(cell == null ? "" : cell).replace(/"/g, '""') + '"';
      }).join(",");
    });
    return "\ufeff" + lines.join("\r\n") + "\r\n";
  }

  function buildReadme() {
    const mainCount = getMainRecords().length;
    const plannedCount = getPlannedRecords().length;
    return [
      "QSL LOGBOOK 备份包",
      "==================",
      "",
      "导出时间：" + new Date().toLocaleString("zh-CN"),
      "记录总数：" + records.length + " 条（主记录 " + mainCount + " / 计划中 " + plannedCount + "）",
      "",
      "文件说明：",
      "  qsl-backup.json  完整备份，可以在应用内导入恢复。",
      "  qsl-records.csv  表格版本，可用 Excel、Numbers 等打开查看。",
      "  README.txt       本说明文件。",
      "",
      "如何恢复：",
      "  1. 打开 QSL LOGBOOK。",
      "  2. 点击右上角「数据」进入备份与导入。",
      "  3. 选择本 .zip 压缩包或其中的 qsl-backup.json。",
      "  4. 选择「合并到现有记录」或「替换全部记录」，然后导入。",
      "",
      "提示：数据只保存在本机浏览器中。清理浏览器数据或更换设备前，请先导出备份。",
      "",
      "QSL LOGBOOK · LOCAL ONLY",
    ].join("\r\n");
  }

  function saveBlobOnAndroid(blob, filename) {
    if (!window.QSLAndroid || typeof window.QSLAndroid.saveFile !== "function") return false;
    try {
      const reader = new FileReader();
      reader.onload = function () {
        try {
          const result = String(reader.result || "");
          const comma = result.indexOf(",");
          const base64 = comma >= 0 ? result.slice(comma + 1) : "";
          if (!base64) {
            showToast("导出失败：无法编码文件。", { tone: "error" });
            return;
          }
          const message = String(window.QSLAndroid.saveFile(
            filename,
            blob.type || "application/octet-stream",
            base64
          ) || "");
          if (message.indexOf("已保存") === 0) {
            showToast(message, { duration: 5200 });
          } else {
            showToast(message || "保存到手机失败。", { tone: "error", duration: 6000 });
          }
        } catch (error) {
          showToast("保存到手机失败：" + (error && error.message ? error.message : "未知错误"), { tone: "error" });
        }
      };
      reader.onerror = function () {
        showToast("读取导出文件失败。", { tone: "error" });
      };
      reader.readAsDataURL(blob);
      return true;
    } catch (error) {
      showToast("当前环境无法导出文件。", { tone: "error" });
      return false;
    }
  }

  function downloadBlob(blob, filename) {
    if (saveBlobOnAndroid(blob, filename)) {
      // Android 壳层会直接保存到系统的“下载/QSL LOGBOOK”，
      // 由该路径自行提示结果，因此这里不再弹“已生成”提示。
      return false;
    }
    let url;
    try {
      url = URL.createObjectURL(blob);
    } catch (error) {
      showToast("当前浏览器无法生成下载文件。", { tone: "error" });
      return false;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () {
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        /* ignore */
      }
    }, 4000);
    return true;
  }

  function exportJSON() {
    const text = JSON.stringify(backupObject(), null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    if (downloadBlob(blob, "qsl-backup-" + fileStamp() + ".json")) {
      showToast("完整备份文件已生成");
    }
  }

  function exportCSV() {
    const blob = new Blob([buildCsv()], { type: "text/csv;charset=utf-8" });
    if (downloadBlob(blob, "qsl-records-" + fileStamp() + ".csv")) {
      showToast("表格文件已生成");
    }
  }

  function exportADIF() {
    const blob = new Blob([buildAdif()], { type: "text/plain;charset=utf-8" });
    if (downloadBlob(blob, "qsl-logbook-" + fileStamp() + ".adi")) {
      showToast("ADIF 文件已生成");
    }
  }

  function exportZIP() {
    if (!window.QSLZip || typeof window.QSLZip.createZip !== "function") {
      showToast("打包组件加载失败，请改用 JSON 备份。", { tone: "error" });
      return;
    }
    try {
      const json = JSON.stringify(backupObject(), null, 2);
      const csv = buildCsv();
      const readme = buildReadme();
      const bytes = window.QSLZip.createZip([
        { name: "qsl-backup.json", data: json },
        { name: "qsl-records.csv", data: csv },
        { name: "README.txt", data: readme },
      ]);
      const blob = new Blob([bytes], { type: "application/zip" });
      if (downloadBlob(blob, "qsl-logbook-" + fileStamp() + ".zip")) {
        showToast("备份压缩包已生成");
      }
    } catch (error) {
      showToast(error && error.message ? error.message : "打包失败，请改用 JSON 备份。", { tone: "error" });
    }
  }

  function renderBackupStats() {
    const mainCount = getMainRecords().length;
    const plannedCount = getPlannedRecords().length;
    let size = 0;
    try {
      size = new TextEncoder().encode(JSON.stringify(records)).length;
    } catch (error) {
      size = 0;
    }
    els.backupCount.textContent = String(records.length);
    els.backupBreakdown.textContent = mainCount + " / " + plannedCount;
    els.backupSize.textContent = formatBytes(size);
  }

  function resetImportUI() {
    pendingImport = null;
    els.importFile.value = "";
    els.importPreview.hidden = true;
    els.importMessage.hidden = true;
    els.importMessage.classList.remove("is-ok");
    els.dropzoneTitle.textContent = "选择备份或 ADIF 文件";
    els.dropzoneHint.textContent = "点击选择，或将 .json / .zip / .adi 拖到这里";
    els.importConfirmBtn.textContent = "导入";
    els.importConfirmBtn.classList.add("btn-primary");
    els.importConfirmBtn.classList.remove("btn-danger");
    $$('input[name="importMode"]').forEach(function (radio) {
      radio.checked = radio.value === "merge";
    });
  }

  function openBackupDialog() {
    resetImportUI();
    renderBackupStats();
    openModal(els.backupDialog);
  }

  function showImportMessage(message, ok) {
    els.importMessage.textContent = message;
    els.importMessage.classList.toggle("is-ok", Boolean(ok));
    els.importMessage.hidden = false;
  }

  function getImportMode() {
    const checked = $('input[name="importMode"]:checked');
    return checked && checked.value === "replace" ? "replace" : "merge";
  }

  function updateImportButton() {
    if (!pendingImport) return;
    const mode = getImportMode();
    const count = pendingImport.records.length;
    if (mode === "replace") {
      els.importConfirmBtn.textContent = "替换并导入 " + count + " 条";
    } else {
      els.importConfirmBtn.textContent = pendingImport.kind === "adif" ? "导入 " + count + " 条通联" : "导入 " + count + " 条";
    }
    els.importConfirmBtn.classList.toggle("btn-danger", mode === "replace");
    els.importConfirmBtn.classList.toggle("btn-primary", mode !== "replace");
  }

  function applyAdifText(text, fileName) {
    const rows = parseAdif(text);
    if (!rows.length) throw new Error("ADIF 文件中没有找到记录。");

    const existingKeys = new Set(records.map(adifRecordKey));
    const seenKeys = new Set();
    const incoming = [];
    let skipped = 0;
    let duplicates = 0;

    rows.forEach(function (row) {
      const record = adifRowToRecord(row);
      if (!record) {
        skipped++;
        return;
      }
      const key = adifRecordKey(record);
      if (existingKeys.has(key) || seenKeys.has(key)) {
        duplicates++;
        return;
      }
      seenKeys.add(key);
      incoming.push(record);
    });

    if (!incoming.length) {
      throw new Error("ADIF 中没有新的通联记录" + (duplicates ? "（" + duplicates + " 条已存在）" : "") + "。");
    }

    pendingImport = {
      kind: "adif",
      records: incoming,
      fileName: fileName,
      skipped: skipped,
      duplicates: duplicates,
      total: rows.length,
    };

    els.dropzoneTitle.textContent = "已读取 ADIF";
    els.dropzoneHint.textContent = fileName;
    els.importFileName.textContent = fileName;
    els.importSummary.textContent = "可导入 " + incoming.length + " 条" +
      (duplicates ? " · 已存在 " + duplicates + " 条" : "") +
      (skipped ? " · 无效 " + skipped + " 条" : "");
    els.importPreview.hidden = false;
    updateImportButton();
    showImportMessage(
      "已读取 " + incoming.length + " 条通联记录" +
        (duplicates ? "；" + duplicates + " 条按呼号、日期、时间与频段判定为重复，将跳过。" : "。"),
      true
    );
  }

  async function handleImportFile(file) {
    if (!file) return;
    resetImportUI();
    els.dropzoneTitle.textContent = "正在读取备份…";
    els.dropzoneHint.textContent = file.name;
    els.importFile.value = "";

    if (file.size > MAX_IMPORT_BYTES) {
      els.dropzoneTitle.textContent = "文件过大";
      els.dropzoneHint.textContent = "请选择小于 20 MB 的备份文件";
      showImportMessage("备份文件超过 20 MB，无法读取。", false);
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
      let text;
      if (isZip) {
        if (!window.QSLZip || typeof window.QSLZip.readTextFromZip !== "function") {
          throw new Error("打包组件加载失败，请改用 .json 备份。");
        }
        const entry = await window.QSLZip.readTextFromZip(buffer, "qsl-backup.json");
        text = entry.text;
      } else {
        text = new TextDecoder("utf-8").decode(bytes);
      }

      text = text.replace(/^\uFEFF/, "").trim();
      if (!text) throw new Error("文件内容为空。");

      const adifLike = /\.(adi|adif)$/i.test(String(file.name || "")) || /<(adif_ver|eoh|qso_date)[: >]/i.test(text);
      if (adifLike) {
        applyAdifText(text, file.name);
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error("文件不是有效的 JSON 备份。");
      }

      const rawList = Array.isArray(data) ? data : data && Array.isArray(data.records) ? data.records : null;
      if (!rawList) throw new Error("没有找到记录数据。");

      let skipped = 0;
      const byId = new Map();
      for (const raw of rawList) {
        const record = normalizeRecord(raw);
        if (!record) {
          skipped++;
          continue;
        }
        const existing = byId.get(record.id);
        if (existing) {
          skipped++;
          if (String(record.updatedAt) > String(existing.updatedAt)) byId.set(record.id, record);
        } else {
          byId.set(record.id, record);
        }
      }

      const valid = Array.from(byId.values());
      if (valid.length === 0) {
        throw new Error("文件中没有可识别的记录。");
      }

      pendingImport = {
        records: valid,
        fileName: file.name,
        skipped: skipped,
        total: rawList.length,
      };

      els.dropzoneTitle.textContent = "已读取备份";
      els.dropzoneHint.textContent = file.name;
      els.importFileName.textContent = file.name;
      els.importSummary.textContent = "可导入 " + valid.length + " 条" + (skipped > 0 ? " · 跳过 " + skipped + " 条" : "");
      els.importPreview.hidden = false;
      updateImportButton();
      showImportMessage(
        skipped > 0
          ? "已读取 " + valid.length + " 条记录；" + skipped + " 条不完整或重复的记录将被跳过。"
          : "已读取 " + valid.length + " 条记录，可以导入。",
        true
      );
    } catch (error) {
      console.error(error);
      pendingImport = null;
      els.dropzoneTitle.textContent = "读取失败，重新选择";
      els.dropzoneHint.textContent = "支持 .json / .zip 备份，或 .adi / .adif 日志";
      showImportMessage(error && error.message ? error.message : "读取文件失败。", false);
    }
  }

  function applyPendingImport() {
    if (!pendingImport) return;
    const importData = pendingImport;
    const mode = getImportMode();

    if (mode === "replace") {
      showConfirm({
        title: "替换全部记录？",
        message: "当前 " + records.length + " 条记录会被清空，并导入 " + importData.records.length + " 条记录。此操作不可撤销。",
        okLabel: "替换并导入",
        danger: true,
      }).then(function (ok) {
        if (!ok) return;
        records = importData.records.map(function (record) {
          return Object.assign({}, record);
        });
        persist();
        renderAll();
        closeModal(els.backupDialog);
        pendingImport = null;
        showToast("已替换为 " + records.length + " 条记录");
      });
      return;
    }

    const byId = new Map();
    records.forEach(function (record) {
      byId.set(record.id, record);
    });
    const identityKeys = new Set(records.map(recordIdentity));
    const isAdif = importData.kind === "adif";
    let added = 0;
    let updated = 0;
    let kept = 0;

    importData.records.forEach(function (incoming) {
      if (isAdif) {
        const key = recordIdentity(incoming);
        if (identityKeys.has(key)) {
          kept++;
          return;
        }
        identityKeys.add(key);
        records.push(Object.assign({}, incoming));
        added++;
        return;
      }
      const existing = byId.get(incoming.id);
      if (!existing) {
        records.push(Object.assign({}, incoming));
        byId.set(incoming.id, incoming);
        added++;
        return;
      }
      const existingTime = Date.parse(existing.updatedAt) || 0;
      const incomingTime = Date.parse(incoming.updatedAt) || 0;
      if (incomingTime > existingTime) {
        const index = records.findIndex(function (record) {
          return record.id === existing.id;
        });
        if (index !== -1) {
          records[index] = Object.assign({}, incoming, { createdAt: existing.createdAt, id: existing.id });
          updated++;
        }
      } else {
        kept++;
      }
    });

    persist();
    renderAll();
    closeModal(els.backupDialog);
    pendingImport = null;

    if (added === 0 && updated === 0) {
      showToast("没有需要更新的记录，现有数据保持不变" + (kept ? "（" + kept + " 条跳过）" : ""));
    } else {
      const parts = [];
      if (added) parts.push("新增 " + added + " 条");
      if (updated) parts.push("更新 " + updated + " 条");
      if (kept) parts.push("跳过 " + kept + " 条");
      showToast("导入完成：" + parts.join("，"));
    }
  }

  /* =========================================================
     Service worker / install
     ========================================================= */

  function handleLaunchAction() {
    let action = "";
    try {
      action = new URLSearchParams(window.location.search).get("action") || "";
    } catch (error) {
      action = "";
    }
    if (action !== "add-main" && action !== "add-planned" && action !== "backup") return;
    if (action === "backup") openBackupDialog();
    else openAddDialog(action === "add-planned" ? "planned" : "main");
    try {
      const cleanUrl = window.location.pathname + (window.location.hash || "");
      window.history.replaceState(null, "", cleanUrl);
    } catch (error) {
      /* ignore */
    }
  }

  function setupServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function (error) {
        console.warn("Service worker 注册失败：", error);
      });
    });
  }

  function setupInstallPrompt() {
    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      deferredInstallPrompt = event;
      els.installBtn.hidden = false;
      document.body.classList.add("can-install");
    });
    window.addEventListener("appinstalled", function () {
      deferredInstallPrompt = null;
      els.installBtn.hidden = true;
      document.body.classList.remove("can-install");
      showToast("QSL LOGBOOK 已安装到桌面");
    });
    els.installBtn.addEventListener("click", async function () {
      if (!deferredInstallPrompt) {
        els.installBtn.hidden = true;
        return;
      }
      const prompt = deferredInstallPrompt;
      deferredInstallPrompt = null;
      els.installBtn.hidden = true;
      document.body.classList.remove("can-install");
      try {
        prompt.prompt();
        await prompt.userChoice;
      } catch (error) {
        /* user cancelled */
      }
    });
  }

  /* =========================================================
     Event bindings
     ========================================================= */

  function cacheElements() {
    const ids = [
      "installBtn", "backupBtn", "addBtn", "themeBtn",
      "statMain", "statPlanned", "statOwn", "statOther", "statOwnTotal", "statOtherTotal", "statPlannedBreakdown",
      "tabMain", "tabPlanned", "tabMainCount", "tabPlannedCount",
      "saveState", "saveStateText",
      "searchInput", "clearSearch", "dateField", "filterFrom", "filterTo", "statusFilter", "planFilter", "resetFilters",
      "resultMeta", "recordList", "emptyState", "emptyTitle", "emptyText", "emptyAction", "emptyActionText",
      "sortToggle", "sortToggleText", "selectModeBtn", "selectModeText",
      "batchBar", "batchCount", "batchSelectAll", "batchClear", "batchOwn", "batchOther",
      "batchDateSep", "batchSendDate", "batchComplete", "batchDelete", "batchExit",
      "recordDialog", "recordForm", "recordEyebrow", "recordTitle", "closeRecord",
      "qsoDate", "qsoTime", "callsign", "band", "qsoMode", "sentAt",
      "errQsoDate", "errQsoTime", "errCallsign", "errBand", "errSentAt",
      "plannedBanner", "planKindField", "sentLabelText", "sentRequired", "sentHint",
      "receivedFieldset", "receivedHint", "ownReceived", "otherReceived",
      "notes", "notesCount", "recordCancel", "prevStep", "nextStep", "saveRecord", "saveRecordText",
      "backupDialog", "closeBackup", "backupDone", "backupCount", "backupBreakdown", "backupSize",
      "dropzone", "importFile", "dropzoneTitle", "dropzoneHint", "importPreview", "importFileName",
      "importSummary", "importConfirmBtn", "importMessage",
      "confirmDialog", "confirmTitle", "confirmMessage", "confirmIcon", "confirmCancel", "confirmOk",
      "toastRegion",
    ];
    ids.forEach(function (id) {
      const element = document.getElementById(id);
      if (!element) throw new Error("缺少页面元素 #" + id);
      els[id] = element;
    });
  }

  function bindEvents() {
    els.addBtn.addEventListener("click", function () {
      openAddDialog(activeTab);
    });

    els.themeBtn.addEventListener("click", toggleTheme);

    els.sortToggle.addEventListener("click", function () {
      sortOrder = sortOrder === "desc" ? "asc" : "desc";
      els.sortToggleText.textContent = sortOrder === "desc" ? "最新优先" : "最早优先";
      renderList();
    });

    els.selectModeBtn.addEventListener("click", function () {
      setSelectionMode(!selectionMode);
    });

    els.tabMain.addEventListener("click", function () {
      switchTab("main");
    });
    els.tabPlanned.addEventListener("click", function () {
      switchTab("planned");
    });

    [els.tabMain, els.tabPlanned].forEach(function (tab, index) {
      tab.addEventListener("keydown", function (event) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = index === 0 ? els.tabPlanned : els.tabMain;
        switchTab(index === 0 ? "planned" : "main");
        next.focus();
      });
    });

    els.searchInput.addEventListener("input", function () {
      filters.q = els.searchInput.value;
      renderList();
      refreshFilterUI();
    });
    els.searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && els.searchInput.value) {
        event.preventDefault();
        filters.q = "";
        els.searchInput.value = "";
        renderList();
        refreshFilterUI();
      }
    });
    els.clearSearch.addEventListener("click", function () {
      filters.q = "";
      els.searchInput.value = "";
      renderList();
      refreshFilterUI();
      els.searchInput.focus();
    });

    els.dateField.addEventListener("change", function () {
      filters.dateField = els.dateField.value === "sent" ? "sent" : "qso";
      if (activeTab === "planned") filters.dateField = "qso";
      renderList();
      refreshFilterUI();
    });
    els.filterFrom.addEventListener("change", function () {
      filters.from = els.filterFrom.value;
      renderList();
      refreshFilterUI();
    });
    els.filterTo.addEventListener("change", function () {
      filters.to = els.filterTo.value;
      renderList();
      refreshFilterUI();
    });
    els.statusFilter.addEventListener("change", function () {
      filters.status = els.statusFilter.value;
      renderList();
      refreshFilterUI();
    });
    els.planFilter.addEventListener("change", function () {
      filters.planKind = els.planFilter.value === "reply" ? "reply" : els.planFilter.value === "send" ? "send" : "all";
      renderList();
      refreshFilterUI();
    });
    els.resetFilters.addEventListener("click", function () {
      resetFilters();
    });

    els.emptyAction.addEventListener("click", function () {
      const action = els.emptyAction.dataset.action;
      if (action === "reset") {
        resetFilters();
      } else if (action === "add-planned") {
        openAddDialog("planned");
      } else {
        openAddDialog("main");
      }
    });

    els.recordList.addEventListener("click", function (event) {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const card = button.closest(".record-card");
      if (!card) return;
      const id = card.getAttribute("data-id");
      const action = button.getAttribute("data-action");
      if (action === "select") {
        toggleSelected(id);
        return;
      }
      if (action === "edit") openEditDialog(id);
      else if (action === "delete") deleteRecord(id);
      else if (action === "toggle-own") toggleReceived(id, "ownReceived");
      else if (action === "toggle-other") toggleReceived(id, "otherReceived");
      else if (action === "complete") completePlanned(id, card);
    });

    els.recordList.addEventListener("click", function (event) {
      if (!selectionMode) return;
      if (event.target.closest("button")) return;
      const card = event.target.closest(".record-card");
      if (card) toggleSelected(card.getAttribute("data-id"));
    });

    els.recordList.addEventListener("input", function (event) {
      if (!event.target.matches('[data-role="send-date"]')) return;
      event.target.classList.remove("has-error");
      event.target.removeAttribute("aria-invalid");
      const error = event.target.closest(".planned-foot").querySelector(".send-error");
      if (error) error.hidden = true;
    });

    els.recordList.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || !event.target.matches('[data-role="send-date"]')) return;
      event.preventDefault();
      const card = event.target.closest(".record-card");
      if (card) completePlanned(card.getAttribute("data-id"), card);
    });

    els.recordForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (draftStep === 1) {
        if (validateStep1(true)) showStep(2);
        return;
      }
      saveRecord();
    });

    $$('input[name="recordMode"]', els.recordForm).forEach(function (radio) {
      radio.addEventListener("change", function () {
        if (radio.value === "planned") {
          if (els.sentAt.value) els.sentAt.value = "";
          els.ownReceived.checked = false;
          setPlannedKind(els.otherReceived.checked ? "reply" : "send");
        }
        draftDirty = true;
        clearAllErrors();
        syncModeUI();
      });
    });

    els.qsoDate.addEventListener("input", function () {
      clearFieldError("qsoDate");
      draftDirty = true;
    });
    els.qsoTime.addEventListener("input", function () {
      clearFieldError("qsoTime");
      draftDirty = true;
    });
    els.callsign.addEventListener("input", function () {
      clearFieldError("callsign");
      draftDirty = true;
    });
    els.callsign.addEventListener("blur", function () {
      const upper = els.callsign.value.trim().toUpperCase();
      if (upper !== els.callsign.value) els.callsign.value = upper;
    });
    els.band.addEventListener("input", function () {
      clearFieldError("band");
      draftDirty = true;
    });
    els.qsoMode.addEventListener("input", function () {
      draftDirty = true;
    });
    els.sentAt.addEventListener("input", function () {
      clearFieldError("sentAt");
      draftDirty = true;
      syncModeUI();
    });
    $$('input[name="plannedKind"]', els.recordForm).forEach(function (radio) {
      radio.addEventListener("change", function () {
        const kind = getPlannedKind();
        els.otherReceived.checked = kind === "reply";
        draftDirty = true;
        syncModeUI();
      });
    });
    els.ownReceived.addEventListener("change", function () {
      draftDirty = true;
    });
    els.otherReceived.addEventListener("change", function () {
      draftDirty = true;
      if (getSelectedMode() === "planned") {
        setPlannedKind(els.otherReceived.checked ? "reply" : "send");
        syncModeUI();
      }
    });
    els.notes.addEventListener("input", function () {
      draftDirty = true;
      els.notesCount.textContent = Array.from(els.notes.value).length + " / " + MAX_NOTES;
    });

    els.recordForm.addEventListener("change", function () {
      draftDirty = true;
    });

    els.nextStep.addEventListener("click", function () {
      if (validateStep1(true)) showStep(2);
    });
    els.prevStep.addEventListener("click", function () {
      showStep(1);
    });
    $$("[data-goto-step]", els.recordForm).forEach(function (button) {
      button.addEventListener("click", function () {
        const target = Number(button.getAttribute("data-goto-step"));
        if (target === 2) {
          if (validateStep1(true)) showStep(2);
        } else {
          showStep(1);
        }
      });
    });

    els.recordCancel.addEventListener("click", requestCloseRecordDialog);
    els.closeRecord.addEventListener("click", requestCloseRecordDialog);
    els.recordDialog.addEventListener("cancel", function (event) {
      event.preventDefault();
      requestCloseRecordDialog();
    });
    els.recordDialog.addEventListener("click", function (event) {
      if (event.target === els.recordDialog) requestCloseRecordDialog();
    });
    els.recordDialog.addEventListener("close", function () {
      draft = null;
      editingId = null;
      draftDirty = false;
      updateModalLock();
    });

    els.backupBtn.addEventListener("click", openBackupDialog);
    els.closeBackup.addEventListener("click", function () {
      closeModal(els.backupDialog);
    });
    els.backupDone.addEventListener("click", function () {
      closeModal(els.backupDialog);
    });
    els.backupDialog.addEventListener("cancel", function () {
      closeModal(els.backupDialog);
    });
    els.backupDialog.addEventListener("click", function (event) {
      if (event.target === els.backupDialog) closeModal(els.backupDialog);
    });
    els.backupDialog.addEventListener("close", function () {
      updateModalLock();
    });

    $$("[data-export]").forEach(function (button) {
      button.addEventListener("click", function () {
        const kind = button.getAttribute("data-export");
        if (kind === "json") exportJSON();
        else if (kind === "zip") exportZIP();
        else if (kind === "csv") exportCSV();
        else if (kind === "adif") exportADIF();
      });
    });

    els.batchExit.addEventListener("click", function () {
      setSelectionMode(false);
    });
    els.batchSelectAll.addEventListener("click", function () {
      const visible = getVisibleRecords();
      const allSelected = visible.length > 0 && visible.every(function (record) {
        return selectedIds.has(record.id);
      });
      if (allSelected) {
        visible.forEach(function (record) {
          selectedIds.delete(record.id);
        });
      } else {
        visible.forEach(function (record) {
          selectedIds.add(record.id);
        });
      }
      syncSelectionUI();
    });
    els.batchClear.addEventListener("click", function () {
      selectedIds.clear();
      syncSelectionUI();
    });
    els.batchOwn.addEventListener("click", function () {
      batchToggleReceived("ownReceived");
    });
    els.batchOther.addEventListener("click", function () {
      batchToggleReceived("otherReceived");
    });
    els.batchComplete.addEventListener("click", batchCompletePlanned);
    els.batchDelete.addEventListener("click", batchDeleteSelected);

    els.dropzone.addEventListener("click", function (event) {
      if (event.target === els.importFile) return;
      els.importFile.click();
    });
    els.dropzone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        els.importFile.click();
      }
    });
    els.importFile.addEventListener("change", function () {
      const file = els.importFile.files && els.importFile.files[0];
      if (file) handleImportFile(file);
    });

    ["dragenter", "dragover"].forEach(function (eventName) {
      els.dropzone.addEventListener(eventName, function (event) {
        event.preventDefault();
        event.stopPropagation();
        els.dropzone.classList.add("is-dragging");
      });
    });
    ["dragleave", "dragend"].forEach(function (eventName) {
      els.dropzone.addEventListener(eventName, function (event) {
        event.preventDefault();
        event.stopPropagation();
        els.dropzone.classList.remove("is-dragging");
      });
    });
    els.dropzone.addEventListener("drop", function (event) {
      event.preventDefault();
      event.stopPropagation();
      els.dropzone.classList.remove("is-dragging");
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleImportFile(file);
    });

    $$('input[name="importMode"]').forEach(function (radio) {
      radio.addEventListener("change", updateImportButton);
    });
    els.importConfirmBtn.addEventListener("click", applyPendingImport);

    els.confirmOk.addEventListener("click", function () {
      finishConfirm(true);
    });
    els.confirmCancel.addEventListener("click", function () {
      finishConfirm(false);
    });
    els.confirmDialog.addEventListener("cancel", function (event) {
      event.preventDefault();
      finishConfirm(false);
    });
    els.confirmDialog.addEventListener("click", function (event) {
      if (event.target === els.confirmDialog) finishConfirm(false);
    });
    els.confirmDialog.addEventListener("close", function () {
      if (confirmState) {
        const state = confirmState;
        confirmState = null;
        state.resolve(false);
      }
      updateModalLock();
    });

    document.addEventListener("keydown", function (event) {
      const openDialog = document.querySelector("dialog[open]");
      const target = event.target;
      const typing = target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      );
      if (openDialog) return;
      if (event.key === "Escape" && selectionMode && !typing) {
        event.preventDefault();
        setSelectionMode(false);
        return;
      }
      if (event.key === "/" && !typing) {
        event.preventDefault();
        els.searchInput.focus();
        els.searchInput.select();
      } else if ((event.key === "n" || event.key === "N") && !typing && !selectionMode && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        openAddDialog(activeTab);
      }
    });

    window.addEventListener("storage", function (event) {
      if (event.key !== STORAGE_KEY || event.newValue == null) return;
      try {
        const loaded = parseStoredRecords(event.newValue);
        records = loaded.records;
        renderAll();
        showToast("已同步其他窗口中的修改");
      } catch (error) {
        /* ignore malformed external writes */
      }
    });

    window.addEventListener("beforeunload", function () {
      /* localStorage is synchronous, nothing to flush */
    });
  }

  function clearFieldError(name) {
    setFieldError(name, "");
  }

  function resetFilters() {
    filters = { q: "", dateField: "qso", from: "", to: "", status: "all", planKind: "all" };
    els.searchInput.value = "";
    els.filterFrom.value = "";
    els.filterTo.value = "";
    els.statusFilter.value = "all";
    els.planFilter.value = "all";
    els.dateField.value = "qso";
    renderList();
    refreshFilterUI();
  }

  /* =========================================================
     Init
     ========================================================= */

  function init() {
    cacheElements();
    cacheFieldMap();
    records = loadRecords();
    bindEvents();

    applyTheme(currentTheme(), { save: false });
    els.batchSendDate.value = todayISO();
    els.sortToggleText.textContent = sortOrder === "desc" ? "最新优先" : "最早优先";

    renderAll();

    window.QSLAndroidBack = function () {
      try {
        if (els.confirmDialog && els.confirmDialog.open) {
          finishConfirm(false);
          return true;
        }
        if (els.recordDialog && els.recordDialog.open) {
          requestCloseRecordDialog();
          return true;
        }
        if (els.backupDialog && els.backupDialog.open) {
          closeModal(els.backupDialog);
          return true;
        }
        return false;
      } catch (error) {
        return false;
      }
    };

    setupServiceWorker();
    setupInstallPrompt();
    handleLaunchAction();

    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
      els.installBtn.hidden = true;
    }
  }

  if (window.__QSL_TEST_HOOKS__) {
    window.__QSL_TEST_HOOKS__.api = {
      buildAdif: buildAdif,
      buildCsv: buildCsv,
      parseAdif: parseAdif,
      adifRowToRecord: adifRowToRecord,
      adifRecordKey: adifRecordKey,
      recordIdentity: recordIdentity,
      bandToAdif: bandToAdif,
      bandFromAdif: bandFromAdif,
      applyAdifText: applyAdifText,
      applyPendingImport: applyPendingImport,
      getPendingImport: function () {
        return pendingImport;
      },
      setRecords: function (list) {
        records = list.slice();
        persist();
        renderAll();
      },
      getRecords: function () {
        return records.slice();
      },
      findDuplicate: findDuplicate,
      getSortOrder: function () {
        return sortOrder;
      },
      getSelected: function () {
        return Array.from(selectedIds);
      },
      isSelectionMode: function () {
        return selectionMode;
      },
      setSelectionMode: setSelectionMode,
      batchToggleReceived: batchToggleReceived,
      getTheme: currentTheme,
      getEls: function () {
        return els;
      },
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
