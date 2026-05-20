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
  const languageToggle = document.getElementById("language-toggle");
  const i18n = globalThis.XFSI18n;
  const STORAGE_KEY = "xfs:userStatsCacheV2";
  const SETTINGS_KEY = "xfs:displaySettingsV1";
  const LANGUAGE_KEY = i18n ? i18n.LANGUAGE_KEY : "xfs:languagePreferenceV1";
  const FALLBACK_MESSAGES = {
    authorText: "Created by @liuqi",
    htmlLang: "en",
    popupCacheCleared: "Cache cleared.",
    popupCapturedStatus: "Captured $1 users, queue $2",
    popupScriptNotReady: "The extension script is not loaded in this tab yet. Refresh X and try again.",
    popupUseOnX: "Use this on x.com or twitter.com pages.",
    shortName: "X/Twitter Following Manager"
  };
  let languagePreference = null;

  rescanButton.addEventListener("click", () => sendToActiveTab("xfs:rescan"));
  clearButton.addEventListener("click", clearCache);
  openManagerButton.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("manager/manager.html") });
  });
  feedToggle.addEventListener("change", updateSettings);
  userListToggle.addEventListener("change", updateSettings);
  lockListToggle.addEventListener("change", updateSettings);
  languageToggle.addEventListener("change", updateLanguagePreference);

  initLanguage().then(refreshStatus);

  async function refreshStatus() {
    applySettings(await readSettings());
    const cacheSize = await readCacheSize();
    cacheCount.textContent = String(cacheSize);
    const response = await sendToActiveTab("xfs:status", {}, { quiet: true });
    if (!response || !response.ok) {
      visibleCount.textContent = "-";
      status.textContent = t("popupUseOnX");
      return;
    }
    renderStatus(response.status);
  }

  async function updateSettings() {
    const currentSettings = await readRawSettings();
    const settings = {
      ...currentSettings,
      feed: feedToggle.checked,
      userList: userListToggle.checked,
      updateOnlyExisting: lockListToggle.checked
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    await sendToActiveTab("xfs:updateSettings", { settings }, { quiet: true });
  }

  async function clearCache() {
    setBusy(true);
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: {} });
      await notifyActiveTab("xfs:clearCache");
      visibleCount.textContent = "-";
      cacheCount.textContent = "0";
      status.textContent = t("popupCacheCleared");
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
    if (nextStatus.settings) {
      applySettings(nextStatus.settings);
    }
    status.textContent = t("popupCapturedStatus", nextStatus.cachedUsers || 0, nextStatus.queued || 0);
  }

  function setBusy(isBusy) {
    rescanButton.disabled = isBusy;
    clearButton.disabled = isBusy;
    openManagerButton.disabled = isBusy;
    feedToggle.disabled = isBusy;
    userListToggle.disabled = isBusy;
    lockListToggle.disabled = isBusy;
  }

  async function initLanguage() {
    languagePreference = await readLanguagePreference();
    applyStaticI18n();
    applyLanguageToggle();
  }

  async function updateLanguagePreference() {
    languagePreference = languageToggle.checked ? "zh_CN" : "en";
    await chrome.storage.local.set({ [LANGUAGE_KEY]: languagePreference });
    applyStaticI18n();
    applyLanguageToggle();
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
  }

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      feed: source.feed !== false,
      userList: source.userList !== false,
      updateOnlyExisting: source.updateOnlyExisting === true
    };
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
