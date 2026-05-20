(function installXUserManager() {
  "use strict";

  const core = window.XFollowStatsCore;
  const i18n = window.XFSI18n;
  const STORAGE_KEY = "xfs:userStatsCacheV2";
  const DISPLAY_SETTINGS_KEY = "xfs:displaySettingsV1";
  const MANAGER_SETTINGS_KEY = "xfs:managerSettingsV1";
  const LANGUAGE_KEY = i18n ? i18n.LANGUAGE_KEY : "xfs:languagePreferenceV1";
  const SEQUENTIAL_STEP_PAUSE_MIN_MS = 900;
  const SEQUENTIAL_STEP_PAUSE_MAX_MS = 2200;
  const SEQUENTIAL_MESSAGE_RETRY_MS = 650;
  const SEQUENTIAL_STEP_TIMEOUT_MS = 26000;
  const SEQUENTIAL_TAB_EDIT_RETRY_MS = 700;
  const SEQUENTIAL_TAB_EDIT_TIMEOUT_MS = 12000;
  const FALLBACK_MESSAGES = {
    authorText: "Created by @liuqi",
    htmlLang: "en",
    managerNoImportUsers: "No importable users were found in this file.",
    managerNoPostGeneric: "No browsed post yet",
    managerNoPostImport: "Imported from user file, no browsed post yet",
    managerNoPostUserList: "From user list, no browsed post yet",
    managerOpenLink: "Open",
    managerSelectUserAria: "Select @$1",
    managerSequentialInterrupted: "Sequential update interrupted: $1",
    managerSequentialStop: "Stopping sequential update after the current account finishes.",
    managerSequentialStopTitle: "Stop sequential update",
    managerSequentialUpdateTitle: "Sequentially update selected accounts",
    managerSelectUsersFirst: "Select accounts to update first.",
    managerSummary: "$1 users total, $2 current results, $3 selected.",
    managerUpdatingSequential: "Sequentially updating $1/$2: @$3",
    postKindComment: "Reply",
    postKindImport: "Import",
    postKindOriginal: "Original",
    postKindRetweet: "Repost",
    shortName: "X/Twitter Following Manager",
    sourceComment: "Reply list",
    sourceFeed: "Feed",
    sourceImport: "Import",
    sourceUserList: "User lists",
    tooltipLockList: "Lock the manager to accounts already captured or imported. While this is on, browsing X only updates existing rows and does not add newly seen accounts to the manager.",
    tooltipPreferComments: "When an account has both posts and replies recorded, show the latest reply first. This only changes the displayed post, not which users appear.",
    tooltipSequentialStop: "Stop after the current account finishes.",
    tooltipSequentialUpdate: "Open one selected profile at a time to refresh follower and following counts. The account list is locked during the run; closing the updater tab stops it.",
    tooltipShowComments: "Show accounts captured only from reply lists. Accounts also seen in the Feed or user lists stay visible when this is off."
  };
  const selected = new Set();
  let users = [];
  let visibleUsers = [];
  let statusMessage = "";
  let languagePreference = null;
  const sequentialUpdate = {
    cancelRequested: false,
    running: false,
    tabId: 0
  };

  const rows = document.getElementById("rows");
  const empty = document.getElementById("empty");
  const summary = document.getElementById("summary");
  const search = document.getElementById("search");
  const showCommentsToggle = document.getElementById("show-comments");
  const preferCommentsToggle = document.getElementById("prefer-comments");
  const sourceFilter = document.getElementById("source-filter");
  const format = document.getElementById("format");
  const exportButton = document.getElementById("export");
  const sequentialUpdateButton = document.getElementById("sequential-update");
  const importButton = document.getElementById("import-users");
  const importFileInput = document.getElementById("import-file");
  const openProfilesButton = document.getElementById("open-selected-profiles");
  const lockListToggle = document.getElementById("lock-list-toggle");
  const selectVisibleButton = document.getElementById("select-visible");
  const selectMissingButton = document.getElementById("select-missing");
  const invertSelectionButton = document.getElementById("invert-selection");
  const clearSelectionButton = document.getElementById("clear-selection");
  const refreshButton = document.getElementById("refresh");
  const toggleVisible = document.getElementById("toggle-visible");

  applyStaticI18n();
  loadLanguagePreference();

  search.addEventListener("input", render);
  showCommentsToggle.addEventListener("change", updateManagerSettings);
  preferCommentsToggle.addEventListener("change", updateManagerSettings);
  sourceFilter.addEventListener("change", render);
  exportButton.addEventListener("click", exportSelected);
  sequentialUpdateButton.addEventListener("click", startSequentialUpdate);
  importButton.addEventListener("click", () => importFileInput.click());
  importFileInput.addEventListener("change", importUsersFromFile);
  openProfilesButton.addEventListener("click", openSelectedProfiles);
  lockListToggle.addEventListener("change", updateLockListSetting);
  selectVisibleButton.addEventListener("click", () => {
    visibleUsers.forEach(user => selected.add(user.username));
    render();
  });
  selectMissingButton.addEventListener("click", selectMissingVisible);
  invertSelectionButton.addEventListener("click", invertVisibleSelection);
  clearSelectionButton.addEventListener("click", () => {
    selected.clear();
    render();
  });
  refreshButton.addEventListener("click", loadUsers);
  toggleVisible.addEventListener("change", () => {
    if (toggleVisible.checked) {
      visibleUsers.forEach(user => selected.add(user.username));
    } else {
      visibleUsers.forEach(user => selected.delete(user.username));
    }
    render();
  });
  chrome.storage.onChanged.addListener(changes => {
    if (changes[STORAGE_KEY]) {
      loadUsers();
    }
    if (changes[DISPLAY_SETTINGS_KEY]) {
      applyDisplaySettings(changes[DISPLAY_SETTINGS_KEY].newValue);
    }
    if (changes[LANGUAGE_KEY]) {
      languagePreference = i18n && i18n.normalizeLanguage
        ? i18n.normalizeLanguage(changes[LANGUAGE_KEY].newValue) || null
        : null;
      applyStaticI18n();
      render();
    }
  });

  applyManagerSettings(readManagerSettings());
  loadDisplaySettings();
  loadUsers();

  function loadUsers() {
    chrome.storage.local.get(STORAGE_KEY, result => {
      const cache = result && result[STORAGE_KEY] && typeof result[STORAGE_KEY] === "object" ? result[STORAGE_KEY] : {};
      users = Object.values(cache)
        .filter(user => user && core.normalizeUsername(user.username))
        .map(normalizeStoredUser)
        .filter(user => user.sources.length > 0 || (core.userHasCommentSource && core.userHasCommentSource(user)));
      pruneSelection();
      render();
    });
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const source = sourceFilter.value;
    const includeComments = showCommentsToggle.checked || preferCommentsToggle.checked;
    visibleUsers = users.filter(
      user => matchesQuery(user, query, includeComments) && matchesSource(user, source) && matchesCommentVisibility(user)
    );
    rows.textContent = "";
    const fragment = document.createDocumentFragment();
    for (const user of visibleUsers) {
      fragment.appendChild(renderRow(user));
    }
    rows.appendChild(fragment);
    empty.hidden = users.length !== 0;
    const selectedVisibleCount = visibleUsers.filter(user => selected.has(user.username)).length;
    toggleVisible.checked = visibleUsers.length > 0 && selectedVisibleCount === visibleUsers.length;
    toggleVisible.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleUsers.length;
    exportButton.disabled = selected.size === 0;
    openProfilesButton.disabled = selected.size === 0;
    sequentialUpdateButton.disabled = selected.size === 0 && !sequentialUpdate.running;
    sequentialUpdateButton.classList.toggle("is-running", sequentialUpdate.running);
    sequentialUpdateButton.setAttribute(
      "aria-label",
      sequentialUpdate.running ? t("managerSequentialStopTitle") : t("managerSequentialUpdateTitle")
    );
    sequentialUpdateButton.dataset.tooltip = sequentialUpdate.running ? t("tooltipSequentialStop") : t("tooltipSequentialUpdate");
    renderSummary();
  }

  function renderRow(user) {
    const tr = document.createElement("tr");
    tr.appendChild(cell(renderCheckbox(user)));
    tr.appendChild(cell(renderUser(user)));
    tr.appendChild(cell(displayFollowing(user) || "-", "count-cell"));
    tr.appendChild(cell(displayFollowers(user) || "-", "count-cell"));
    tr.appendChild(cell(renderSources(user)));
    tr.appendChild(cell(renderPosts(user)));
    tr.appendChild(cell(formatDate(user.lastSeenAt), "date-cell"));
    return tr;
  }

  function selectMissingVisible() {
    visibleUsers.filter(user => !hasCompleteStats(user)).forEach(user => selected.add(user.username));
    render();
  }

  function invertVisibleSelection() {
    visibleUsers.forEach(user => {
      if (selected.has(user.username)) {
        selected.delete(user.username);
      } else {
        selected.add(user.username);
      }
    });
    render();
  }

  function hasCompleteStats(user) {
    return Boolean(displayFollowing(user) && displayFollowers(user));
  }

  function pruneSelection() {
    const existingUsernames = new Set(users.map(user => user.username));
    for (const username of Array.from(selected)) {
      if (!existingUsernames.has(username)) {
        selected.delete(username);
      }
    }
  }

  function displayFollowing(user) {
    return user.followingDisplay || core.formatCompactCount(user.followingCount);
  }

  function displayFollowers(user) {
    return user.followersDisplay || core.formatCompactCount(user.followersCount);
  }

  function renderCheckbox(user) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(user.username);
    input.ariaLabel = t("managerSelectUserAria", user.username);
    input.addEventListener("change", () => {
      if (input.checked) {
        selected.add(user.username);
      } else {
        selected.delete(user.username);
      }
      render();
    });
    return input;
  }

  function renderUser(user) {
    const wrapper = document.createElement("div");
    wrapper.className = "user-identity";
    const link = document.createElement("a");
    link.href = user.profileUrl || `https://x.com/${user.username}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = user.displayName || `@${user.username}`;
    const handle = document.createElement("span");
    handle.className = "handle";
    handle.textContent = `@${user.username}${user.userId ? ` · ${user.userId}` : ""}`;
    wrapper.appendChild(link);
    if (user.displayName || user.userId) {
      wrapper.appendChild(handle);
    }
    return wrapper;
  }

  function renderSources(user) {
    const sources = normalizeSources(user.sources);
    if (showCommentsToggle.checked && core.userHasCommentSource && core.userHasCommentSource(user)) {
      sources.push("comment");
    }
    dropImportSourceWhenFresh(sources);
    const wrapper = document.createElement("div");
    wrapper.className = "source-list";
    if (sources.length === 0) {
      wrapper.textContent = "-";
      return wrapper;
    }
    for (const source of sources) {
      const item = document.createElement("span");
      item.textContent = sourceLabel(source);
      wrapper.appendChild(item);
    }
    return wrapper;
  }

  function dropImportSourceWhenFresh(sources) {
    if (!Array.isArray(sources) || !sources.some(source => source !== "import")) {
      return;
    }
    const importIndex = sources.indexOf("import");
    if (importIndex !== -1) {
      sources.splice(importIndex, 1);
    }
  }

  function renderPosts(user) {
    const post = core.selectObservedPost
      ? core.selectObservedPost(user, {
          includeComments: true,
          preferComments: preferCommentsToggle.checked
        })
      : latestPostFallback(user);
    if (!post) {
      const span = document.createElement("span");
      span.className = "meta";
      const sources = normalizeSources(user.sources);
      span.textContent = sources.includes("import")
        ? t("managerNoPostImport")
        : sources.includes("userList")
        ? t("managerNoPostUserList")
        : t("managerNoPostGeneric");
      return span;
    }
    const wrapper = document.createElement("span");
    wrapper.className = "post-summary";
    const kindLabel = postBadgeLabel(post, user);
    if (kindLabel) {
      const badge = document.createElement("span");
      badge.className = "post-kind-badge";
      badge.textContent = kindLabel;
      wrapper.appendChild(badge);
    }
    const content = document.createElement("span");
    content.className = "post-summary-content";
    content.appendChild(document.createTextNode(truncate(post.text || post.url, 96)));
    if (post.url) {
      content.appendChild(document.createTextNode(" "));
      const link = document.createElement("a");
      link.href = post.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = t("managerOpenLink");
      content.appendChild(link);
    }
    wrapper.appendChild(content);
    return wrapper;
  }

  function cell(content, className) {
    const td = document.createElement("td");
    if (className) {
      td.className = className;
    }
    if (content instanceof Node) {
      td.appendChild(content);
    } else {
      td.textContent = String(content);
    }
    return td;
  }

  function matchesQuery(user, query, includeComments) {
    if (!query) {
      return true;
    }
    const postText = (user.observedPosts || [])
      .filter(post => includeComments || post.kind !== "comment")
      .map(post => post.text || "")
      .join(" ");
    const haystack = [
      user.displayName,
      user.username,
      user.userId,
      user.bio,
      user.website,
      postText
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  }

  function matchesSource(user, source) {
    return source === "all" || normalizeSources(user.sources).includes(source);
  }

  function matchesCommentVisibility(user) {
    return showCommentsToggle.checked || !core.userHasCommentSource || core.userHasNonCommentSource(user);
  }

  function exportSelected() {
    const selectedUsers = users.filter(user => selected.has(user.username));
    const isMarkdown = format.value === "markdown";
    const text = isMarkdown ? core.exportUsersToMarkdown(selectedUsers) : `\ufeff${core.exportUsersToCsv(selectedUsers)}`;
    const filename = `x-users-${new Date().toISOString().slice(0, 10)}.${isMarkdown ? "md" : "csv"}`;
    downloadText(filename, text, isMarkdown ? "text/markdown;charset=utf-8" : "text/csv;charset=utf-8");
  }

  function loadDisplaySettings() {
    chrome.storage.local.get(DISPLAY_SETTINGS_KEY, result => {
      applyDisplaySettings(result && result[DISPLAY_SETTINGS_KEY]);
    });
  }

  function applyDisplaySettings(settings) {
    const normalized = core.normalizeDisplaySettings(settings);
    lockListToggle.checked = normalized.updateOnlyExisting;
  }

  function updateLockListSetting() {
    chrome.storage.local.get(DISPLAY_SETTINGS_KEY, result => {
      const current = result && result[DISPLAY_SETTINGS_KEY] && typeof result[DISPLAY_SETTINGS_KEY] === "object"
        ? result[DISPLAY_SETTINGS_KEY]
        : {};
      const settings = core.normalizeDisplaySettings({
        ...current,
        updateOnlyExisting: lockListToggle.checked
      });
      chrome.storage.local.set({ [DISPLAY_SETTINGS_KEY]: settings });
    });
  }

  async function importUsersFromFile() {
    const file = importFileInput.files && importFileInput.files[0];
    importFileInput.value = "";
    if (!file) {
      return;
    }
    const text = await file.text();
    const importedUsers = core.parseImportedUsers ? core.parseImportedUsers(text, file.name) : [];
    if (importedUsers.length === 0) {
      setStatusMessage(t("managerNoImportUsers"));
      return;
    }
    chrome.storage.local.get(STORAGE_KEY, result => {
      const cache = result && result[STORAGE_KEY] && typeof result[STORAGE_KEY] === "object" ? { ...result[STORAGE_KEY] } : {};
      const now = new Date().toISOString();
      for (const importedUser of importedUsers) {
        const username = core.normalizeUsername(importedUser.username);
        if (!username) {
          continue;
        }
        const existing = cache[username] && typeof cache[username] === "object" ? cache[username] : null;
        const timestamp = importedUser.lastSeenAt || (existing && existing.lastSeenAt) || now;
        const merged = core.mergeObservedUser(existing, { ...importedUser, username }, timestamp);
        if (!merged) {
          continue;
        }
        merged.sources = normalizeSources([...(existing && existing.sources ? existing.sources : []), "import"]);
        if (importedUser.firstSeenAt) {
          merged.firstSeenAt = importedUser.firstSeenAt;
        } else if (!existing || !existing.firstSeenAt) {
          delete merged.firstSeenAt;
        }
        if (importedUser.lastSeenAt) {
          merged.lastSeenAt = importedUser.lastSeenAt;
        } else if (!existing || !existing.lastSeenAt) {
          delete merged.lastSeenAt;
        }
        cache[username] = merged;
      }
      chrome.storage.local.set({ [STORAGE_KEY]: cache }, loadUsers);
    });
  }

  function openSelectedProfiles() {
    const selectedUsers = users.filter(user => selected.has(user.username));
    for (const user of selectedUsers) {
      const profileUrl = user.profileUrl || `https://x.com/${user.username}`;
      if (!profileUrl) {
        continue;
      }
      chrome.tabs.create({ url: profileUrl, active: false });
    }
  }

  async function startSequentialUpdate() {
    if (sequentialUpdate.running) {
      sequentialUpdate.cancelRequested = true;
      setStatusMessage(t("managerSequentialStop"));
      return;
    }

    const targetUsers = users.filter(user => selected.has(user.username) && profileUrlForUser(user));
    if (targetUsers.length === 0) {
      setStatusMessage(t("managerSelectUsersFirst"));
      return;
    }

    sequentialUpdate.running = true;
    sequentialUpdate.cancelRequested = false;
    let previousDisplaySettings = null;
    render();

    try {
      previousDisplaySettings = await forceLockListDuringRun();
      for (let index = 0; index < targetUsers.length; index += 1) {
        if (sequentialUpdate.cancelRequested) {
          break;
        }
        const user = targetUsers[index];
        const profileUrl = profileUrlForUser(user);
        setStatusMessage(t("managerUpdatingSequential", index + 1, targetUsers.length, user.username));
        const tabReady = await openOrNavigateSequentialTab(profileUrl);
        if (!tabReady) {
          sequentialUpdate.cancelRequested = true;
          break;
        }
        const result = await requestProfileStatsUpdate(sequentialUpdate.tabId, user.username);
        if (result && result.manualStop) {
          sequentialUpdate.cancelRequested = true;
          break;
        }
        if (index < targetUsers.length - 1 && !sequentialUpdate.cancelRequested) {
          await delay(randomInt(SEQUENTIAL_STEP_PAUSE_MIN_MS, SEQUENTIAL_STEP_PAUSE_MAX_MS));
        }
      }
      clearStatusMessage();
    } catch (error) {
      setStatusMessage(t("managerSequentialInterrupted", error && error.message ? error.message : "unknown"));
    } finally {
      await restoreDisplaySettings(previousDisplaySettings);
      sequentialUpdate.running = false;
      sequentialUpdate.cancelRequested = false;
      sequentialUpdate.tabId = 0;
      loadUsers();
    }
  }

  function profileUrlForUser(user) {
    return user && (user.profileUrl || (user.username ? `https://x.com/${user.username}` : ""));
  }

  async function openOrNavigateSequentialTab(url) {
    if (!sequentialUpdate.tabId) {
      const tab = await tabsCreate({ url, active: true });
      sequentialUpdate.tabId = tab && tab.id ? tab.id : 0;
    } else {
      const updated = await tabsUpdateWithRetry(sequentialUpdate.tabId, { url });
      if (!updated) {
        return false;
      }
    }
    await delay(randomInt(500, 900));
    return true;
  }

  function requestProfileStatsUpdate(tabId, username) {
    const startedAt = Date.now();
    return new Promise(resolve => {
      const attempt = () => {
        if (!tabId || Date.now() - startedAt > SEQUENTIAL_STEP_TIMEOUT_MS) {
          resolve({ ok: false, hasStats: false, error: "timeout" });
          return;
        }
        chrome.tabs.sendMessage(tabId, { type: "xfs:updateProfileStats", username }, response => {
          const error = chrome.runtime.lastError;
          if (error) {
            if (isMissingTabError(error.message)) {
              resolve({ ok: false, hasStats: false, manualStop: true, error: error.message });
              return;
            }
            setTimeout(attempt, SEQUENTIAL_MESSAGE_RETRY_MS);
            return;
          }
          resolve(response || { ok: false, hasStats: false });
        });
      };
      attempt();
    });
  }

  async function forceLockListDuringRun() {
    const current = await storageGet(DISPLAY_SETTINGS_KEY);
    const previous = core.normalizeDisplaySettings(current);
    if (!previous.updateOnlyExisting) {
      const next = core.normalizeDisplaySettings({ ...current, updateOnlyExisting: true });
      await storageSet({ [DISPLAY_SETTINGS_KEY]: next });
    }
    return previous;
  }

  async function restoreDisplaySettings(previous) {
    if (!previous || previous.updateOnlyExisting) {
      return;
    }
    const current = await storageGet(DISPLAY_SETTINGS_KEY);
    await storageSet({
      [DISPLAY_SETTINGS_KEY]: core.normalizeDisplaySettings({
        ...current,
        updateOnlyExisting: false
      })
    });
  }

  function tabsCreate(options) {
    return new Promise((resolve, reject) => {
      chrome.tabs.create(options, tab => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tab);
      });
    });
  }

  function tabsUpdateWithRetry(tabId, options) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const attempt = () => {
        chrome.tabs.update(tabId, options, tab => {
          const error = chrome.runtime.lastError;
          if (!error) {
            resolve(tab);
            return;
          }
          if (isMissingTabError(error.message)) {
            resolve(null);
            return;
          }
          if (isTransientTabEditError(error.message) && Date.now() - startedAt < SEQUENTIAL_TAB_EDIT_TIMEOUT_MS) {
            setTimeout(attempt, SEQUENTIAL_TAB_EDIT_RETRY_MS);
            return;
          }
          reject(new Error(error.message));
        });
      };
      attempt();
    });
  }

  function isMissingTabError(message) {
    return /No tab with id|cannot find tab|tab .* not found/i.test(String(message || ""));
  }

  function isTransientTabEditError(message) {
    return /Tabs cannot be edited right now|user may be dragging a tab/i.test(String(message || ""));
  }

  function storageGet(key) {
    return new Promise(resolve => {
      chrome.storage.local.get(key, result => resolve(result && result[key]));
    });
  }

  function storageSet(values) {
    return new Promise(resolve => chrome.storage.local.set(values, resolve));
  }

  function loadLanguagePreference() {
    chrome.storage.local.get(LANGUAGE_KEY, result => {
      languagePreference = i18n && i18n.normalizeLanguage
        ? i18n.normalizeLanguage(result && result[LANGUAGE_KEY]) || null
        : null;
      applyStaticI18n();
      render();
    });
  }

  function setStatusMessage(message) {
    statusMessage = message;
    renderSummary();
  }

  function clearStatusMessage() {
    statusMessage = "";
    renderSummary();
  }

  function renderSummary() {
    const base = t("managerSummary", users.length, visibleUsers.length, selected.size);
    summary.textContent = statusMessage ? `${base} ${statusMessage}` : base;
  }

  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sourceLabel(source) {
    return {
      feed: t("sourceFeed"),
      userList: t("sourceUserList"),
      import: t("sourceImport"),
      comment: t("sourceComment")
    }[source] || source;
  }

  function normalizeStoredUser(user) {
    return {
      ...user,
      username: core.normalizeUsername(user.username),
      sources: core.userSurfaceSources ? core.userSurfaceSources(user) : normalizeSources(user.sources)
    };
  }

  function normalizeSources(sources) {
    const result = [];
    for (const source of sources || []) {
      const normalized = core.normalizeSource ? core.normalizeSource(source) : source;
      if ((normalized === "feed" || normalized === "userList" || normalized === "import") && !result.includes(normalized)) {
        result.push(normalized);
      }
    }
    return result;
  }

  function latestPostFallback(user) {
    return Array.isArray(user.observedPosts) && user.observedPosts.length > 0 ? user.observedPosts[0] : null;
  }

  function postBadgeLabel(post, user) {
    const source = core.normalizePostSource ? core.normalizePostSource(post && post.source) : post && post.source;
    const sources = normalizeSources(user && user.sources);
    if (source === "import" || (!source && sources.includes("import") && !sources.includes("feed"))) {
      return t("postKindImport");
    }
    return postKindLabel(post && post.kind);
  }

  function postKindLabel(kind) {
    const labels = {
      original: t("postKindOriginal"),
      retweet: t("postKindRetweet"),
      comment: t("postKindComment"),
      unknown: t("postKindOriginal")
    };
    const normalized = core.normalizePostKind ? core.normalizePostKind(kind) : kind;
    return Object.prototype.hasOwnProperty.call(labels, normalized) ? labels[normalized] : t("postKindOriginal");
  }

  function updateManagerSettings() {
    saveManagerSettings();
    render();
  }

  function readManagerSettings() {
    try {
      return JSON.parse(localStorage.getItem(MANAGER_SETTINGS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function applyManagerSettings(settings) {
    const source = settings && typeof settings === "object" ? settings : {};
    showCommentsToggle.checked = source.showComments !== false;
    preferCommentsToggle.checked = Boolean(source.preferComments);
  }

  function saveManagerSettings() {
    localStorage.setItem(
      MANAGER_SETTINGS_KEY,
      JSON.stringify({
        showComments: showCommentsToggle.checked,
        preferComments: preferCommentsToggle.checked
      })
    );
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "-";
    }
    const locale = i18n && i18n.localeTag ? i18n.localeTag(languagePreference) : "en";
    return date.toLocaleString(locale, { hour12: false });
  }

  function truncate(value, length) {
    const text = String(value || "");
    return text.length > length ? `${text.slice(0, length - 1)}...` : text;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function applyStaticI18n() {
    if (i18n && i18n.applyStatic) {
      i18n.applyStatic(document, languagePreference);
      return;
    }
    document.documentElement.lang = t("htmlLang");
    document.title = t("shortName");
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
