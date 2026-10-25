(function installPopup() {
  "use strict";

  const status = document.getElementById("status");
  const visibleCount = document.getElementById("visible-count");
  const cacheCount = document.getElementById("cache-count");
  const rescanButton = document.getElementById("rescan");
  const clearButton = document.getElementById("clear");
  const openManagerButton = document.getElementById("open-manager");
  const feedToggle = document.getElementById("feed-toggle");
  const userListToggle = document.getElementById("user-list-toggle");
  const lockListToggle = document.getElementById("lock-list-toggle");
  const tzConvertToggle = document.getElementById("tz-convert-toggle");
  const tzConvertPanel = document.getElementById("tz-convert-panel");
  const tzConvertSelect = document.getElementById("tz-convert-select");
  const tzNowDate = document.getElementById("tz-now-date");
  const tzNowClock = document.getElementById("tz-now-clock");
  const targetDiffToggle = document.getElementById("target-diff-toggle");
  const targetDiffPanel = document.getElementById("target-diff-panel");
  const targetDiffTzSelect = document.getElementById("target-diff-tz-select");
  const targetDiffTimeInput = document.getElementById("target-diff-time-input");
  const targetDiffNowValue = document.getElementById("target-diff-now-value");
  const languageToggle = document.getElementById("language-toggle");
  const core = globalThis.XFollowStatsCore;
  const i18n = globalThis.XFSI18n;
  const storage = globalThis.XFSStorage;
  const STORAGE_KEY = "xfs:userStatsCacheV2";
  const SETTINGS_KEY = "xfs:displaySettingsV1";
  const LANGUAGE_KEY = i18n ? i18n.LANGUAGE_KEY : "xfs:languagePreferenceV1";
  const FALLBACK_MESSAGES = {
    authorText: "Created by @liuqi",
    htmlLang: "en",
    popupCacheCleared: "Cache cleared.",
    popupCapturedStatus: "Captured $1 users, queue $2",
    popupScriptNotReady: "The extension script is not loaded in this tab yet. Refresh X and try again.",
    popupTargetDiffLabel: "Target time diff",
    popupTargetDiffNowLabel: "Diff from now",
    popupTargetDiffUnset: "Not set",
    popupTzConvertLabel: "Timezone convert",
    popupUseOnX: "Use this on x.com or twitter.com pages.",
    shortName: "X/Twitter Following Manager"
  };
  let languagePreference = null;
  let settingsRevision = 0;
  let settingsSaveQueue = Promise.resolve();

  populateTimezoneSelects();

  rescanButton.addEventListener("click", () => sendToActiveTab("xfs:rescan"));
  clearButton.addEventListener("click", clearCache);
  openManagerButton.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("manager/manager.html") });
  });
  feedToggle.addEventListener("change", updateSettings);
  userListToggle.addEventListener("change", updateSettings);
  lockListToggle.addEventListener("change", updateSettings);
  tzConvertToggle.addEventListener("change", updateSettings);
  tzConvertSelect.addEventListener("change", updateSettings);
  targetDiffToggle.addEventListener("change", updateSettings);
  targetDiffTzSelect.addEventListener("change", updateSettings);
  targetDiffTimeInput.addEventListener("input", updateSettings);
  languageToggle.addEventListener("change", updateLanguagePreference);

  setInterval(renderLiveTimeDisplays, 15000);

  initLanguage().then(refreshStatus).catch(error => { status.textContent = t("storageSaveFailed", error.message); });

  async function refreshStorageUsage() {
    const result = await storage.request('status');
    document.getElementById('storage-usage').textContent = t('storageUsage', (result.bytesUsed / 1048576).toFixed(2), (result.budgetBytes / 1048576).toFixed(0));
    return result.status.error || '';
  }

  async function refreshStatus() {
    const revision = settingsRevision;
    const storageError = await refreshStorageUsage();
    await settingsSaveQueue;
    const settings = await readSettings();
    if (revision === settingsRevision) applySettings(settings);
    const cacheSize = await readCacheSize();
    cacheCount.textContent = String(cacheSize);
    const response = await sendToActiveTab("xfs:status", {}, { quiet: true });
    if (!response || !response.ok) {
      visibleCount.textContent = "-";
      status.textContent = storageError ? t("storageSaveFailed", storageError) : await isActiveTabOnX() ? t("popupScriptNotReady") : t("popupUseOnX");
      return;
    }
    renderStatus(response.status);
    if (storageError) status.textContent = t("storageSaveFailed", storageError);
  }

  async function updateSettings() {
    const revision = ++settingsRevision;
    const settings = normalizeSettings({
      feed: feedToggle.checked,
      userList: userListToggle.checked,
      updateOnlyExisting: lockListToggle.checked,
      convertTzEnabled: tzConvertToggle.checked,
      convertTzOffset: Number(tzConvertSelect.value),
      targetDiffEnabled: targetDiffToggle.checked,
      targetDiffTzOffset: Number(targetDiffTzSelect.value),
      targetDiffTime: targetDiffTimeInput.value
    });
    syncSubPanels();
    renderLiveTimeDisplays();
    const save = settingsSaveQueue.then(async () => {
      try {
        await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        return true;
      } catch (error) {
        if (revision === settingsRevision) status.textContent = t("storageSaveFailed", error.message);
        return false;
      }
    });
    settingsSaveQueue = save;
    if (await save && revision === settingsRevision) {
      // Content scripts receive settings through storage.onChanged. A delayed
      // message must not write an older settings snapshot back to storage.
      await sendToActiveTab("xfs:status", {}, { quiet: true });
    }
  }

  async function clearCache() {
    setBusy(true);
    try {
      await storage.request('clear');
      await refreshStorageUsage();
      visibleCount.textContent = "-";
      cacheCount.textContent = "0";
      status.textContent = t("popupCacheCleared");
    } catch (error) {
      status.textContent = t("storageSaveFailed", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function notifyActiveTab(type, payload) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        await chrome.tabs.sendMessage(tab.id, { type, ...(payload || {}) });
      }
    } catch {
      // The active tab may be the manager page or another extension page; storage is already cleared.
    }
  }

  async function sendToActiveTab(type, payload, options) {
    setBusy(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        return null;
      }
      const response = await chrome.tabs.sendMessage(tab.id, { type, ...(payload || {}) });
      if (response && response.status) {
        renderStatus(response.status);
      }
      return response;
    } catch (error) {
      if (!options?.quiet) {
        status.textContent = t("popupScriptNotReady");
      }
      return null;
    } finally {
      setBusy(false);
      cacheCount.textContent = String(await readCacheSize());
    }
  }

  function renderStatus(nextStatus) {
    visibleCount.textContent = String(nextStatus.visibleCells ?? "-");
    cacheCount.textContent = String(nextStatus.cachedUsers ?? "-");
    // Page status is observational; the saved settings and local edits own UI state.
    status.textContent = nextStatus.persistError ? t("storageSaveFailed", nextStatus.persistError) : t("popupCapturedStatus", nextStatus.cachedUsers || 0, nextStatus.queued || 0);
  }

  function setBusy(isBusy) {
    rescanButton.disabled = isBusy;
    clearButton.disabled = isBusy;
    openManagerButton.disabled = isBusy;
    feedToggle.disabled = isBusy;
    userListToggle.disabled = isBusy;
    lockListToggle.disabled = isBusy;
    tzConvertToggle.disabled = isBusy;
    targetDiffToggle.disabled = isBusy;
  }

  function populateTimezoneSelects() {
    const prevConv = tzConvertSelect.value || "-7";
    const prevRef = targetDiffTzSelect.value || "12";
    const locale = i18n && i18n.localeTag ? i18n.localeTag(languagePreference) : "en";
    tzConvertSelect.textContent = "";
    targetDiffTzSelect.textContent = "";
    for (let offset = -12; offset <= 14; offset += 1) {
      const label = core && core.formatUtcOffsetOptionLabel
        ? core.formatUtcOffsetOptionLabel(offset, locale)
        : offset === 0 ? "UTC+0" : offset > 0 ? `UTC+${offset}` : `UTC${offset}`;
      const value = String(offset);
      tzConvertSelect.add(new Option(label, value, value === prevConv, value === prevConv));
      targetDiffTzSelect.add(new Option(label, value, value === prevRef, value === prevRef));
    }
  }

  function syncSubPanels() {
    tzConvertPanel.hidden = !tzConvertToggle.checked;
    targetDiffPanel.hidden = !targetDiffToggle.checked;
    document.getElementById("tz-offset-hint").hidden = !tzConvertToggle.checked && !targetDiffToggle.checked;
  }

  function renderLiveTimeDisplays() {
    const locale = i18n && i18n.localeTag ? i18n.localeTag(languagePreference) : "en";
    const nowMs = Date.now();
    const convertOffset = Number(tzConvertSelect.value);
    if (core && core.formatShortClockInOffset) {
      const shortClock = core.formatShortClockInOffset(nowMs, convertOffset, locale);
      tzNowClock.textContent = shortClock.clock;
      tzNowDate.textContent = shortClock.date;
    }
    const refTime = targetDiffTimeInput.value;
    const refOffset = Number(targetDiffTzSelect.value);
    if (!refTime) {
      targetDiffNowValue.textContent = t("popupTargetDiffUnset");
      return;
    }
    if (core && core.computeTargetMomentDiff) {
      const diff = core.computeTargetMomentDiff(nowMs, refOffset, refTime, locale);
      targetDiffNowValue.textContent = diff ? diff.text : t("popupTargetDiffUnset");
    }
  }

  async function initLanguage() {
    languagePreference = await readLanguagePreference();
    applyStaticI18n();
    applyLanguageToggle();
    populateTimezoneSelects();
  }

  async function updateLanguagePreference() {
    languagePreference = languageToggle.checked ? "zh_CN" : "en";
    await chrome.storage.local.set({ [LANGUAGE_KEY]: languagePreference });
    applyStaticI18n();
    applyLanguageToggle();
    populateTimezoneSelects();
    renderLiveTimeDisplays();
    await notifyActiveTab("xfs:updateLanguage", { languagePreference });
    await refreshStatus();
  }

  function readCacheSize() {
    return new Promise(resolve => {
      chrome.storage.local.get(STORAGE_KEY, result => {
        const cache = result && result[STORAGE_KEY];
        resolve(cache && typeof cache === "object" ? Object.keys(cache).length : 0);
      });
    });
  }

  function readSettings() {
    return readRawSettings().then(normalizeSettings);
  }

  function readRawSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(SETTINGS_KEY, result => {
        const value = result && result[SETTINGS_KEY];
        resolve(value && typeof value === "object" ? value : {});
      });
    });
  }

  function readLanguagePreference() {
    return new Promise(resolve => {
      chrome.storage.local.get(LANGUAGE_KEY, result => {
        const value = result && result[LANGUAGE_KEY];
        resolve(i18n && i18n.normalizeLanguage ? i18n.normalizeLanguage(value) || null : null);
      });
    });
  }

  function applySettings(settings) {
    const normalized = normalizeSettings(settings);
    feedToggle.checked = normalized.feed;
    userListToggle.checked = normalized.userList;
    lockListToggle.checked = normalized.updateOnlyExisting;
    tzConvertToggle.checked = normalized.convertTzEnabled;
    tzConvertSelect.value = String(normalized.convertTzOffset);
    targetDiffToggle.checked = normalized.targetDiffEnabled;
    targetDiffTzSelect.value = String(normalized.targetDiffTzOffset);
    targetDiffTimeInput.value = normalized.targetDiffTime;
    syncSubPanels();
    renderLiveTimeDisplays();
  }

  function normalizeSettings(value) {
    if (core && core.normalizeDisplaySettings) {
      return core.normalizeDisplaySettings(value);
    }
    const source = value && typeof value === "object" ? value : {};
    return {
      feed: source.feed !== false,
      userList: source.userList !== false,
      updateOnlyExisting: source.updateOnlyExisting === true,
      convertTzEnabled: source.convertTzEnabled === true,
      convertTzOffset: Number.isFinite(Number(source.convertTzOffset)) ? Number(source.convertTzOffset) : -7,
      targetDiffEnabled: source.targetDiffEnabled === true,
      targetDiffTzOffset: Number.isFinite(Number(source.targetDiffTzOffset)) ? Number(source.targetDiffTzOffset) : 12,
      targetDiffTime: typeof source.targetDiffTime === "string" ? source.targetDiffTime : "14:00"
    };
  }

  async function isActiveTabOnX() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const url = new URL(tab && tab.url ? tab.url : "");
      return url.protocol === "https:" && (url.hostname === "x.com" || url.hostname === "twitter.com");
    } catch {
      return false;
    }
  }

  function applyStaticI18n() {
    if (i18n && i18n.applyStatic) {
      i18n.applyStatic(document, languagePreference);
      return;
    }
    document.documentElement.lang = t("htmlLang");
    document.title = t("shortName");
  }

  function applyLanguageToggle() {
    const language = i18n && i18n.resolveLanguage ? i18n.resolveLanguage(languagePreference) : "en";
    languageToggle.checked = language === "zh_CN";
  }

  function t(key, ...substitutions) {
    if (i18n && i18n.getMessage) {
      return i18n.getMessage(key, substitutions.map(value => String(value)), languagePreference);
    }
    const message = chrome.i18n && chrome.i18n.getMessage
      ? chrome.i18n.getMessage(key, substitutions.map(value => String(value)))
      : "";
    return message || FALLBACK_MESSAGES[key] || key;
  }
})();
