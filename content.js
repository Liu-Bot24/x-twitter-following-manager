(function installXFollowStatsContentScript() {
  "use strict";

  if (window.__xFollowStatsContentCleanup) {
    window.__xFollowStatsContentCleanup();
  }

  const core = globalThis.XFollowStatsCore;
  const i18n = globalThis.XFSI18n;
  const storage = globalThis.XFSStorage;
  const SOURCE = core.SOURCE;
  const STORAGE_KEY = "xfs:userStatsCacheV2";
  const SETTINGS_KEY = "xfs:displaySettingsV1";
  const LANGUAGE_KEY = i18n ? i18n.LANGUAGE_KEY : "xfs:languagePreferenceV1";
  const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  const SCAN_DEBOUNCE_MS = 180;
  const API_GRACE_MS = 300;
  const SILENT_HOVER_TIMEOUT_MS = 1000;
  const HOVER_TIMEOUT_MS = 3200;
  const HOVER_RETRY_MS = 15000;
  const USER_IDLE_BEFORE_HOVER_MS = 650;
  const HOVER_DIAGNOSTICS_ENABLED = false;
  const HOVER_DIAGNOSTICS_LIMIT = 200;
  const LAST_SEEN_PERSIST_INTERVAL_MS = 5 * 60 * 1000;
  const FALLBACK_MESSAGES = {
    followersLabel: "Followers",
    followingLabel: "Following",
    listSeparator: ", ",
    pillHoverInterruptedTitle: "Reading paused while you use the page. It will retry when the page is idle.",
    pillHoverMissingTitle: "Counts were not available yet. The extension will retry.",
    pillHoverReadingTitle: "Reading following counts.",
    pillLoadingFullTitle: "Waiting for counts from X page data.",
    pillLoadingShortTitle: "Reading counts.",
    pillReading: "Reading",
    pillStatsText: "$1 Following · $2 Followers",
    pillWaitingData: "Waiting",
    sourceFeed: "Feed",
    sourcePrefix: "Source: ",
    sourceUserList: "User lists"
  };

  const state = {
    activeHoverTarget: null,
    activeHoverSilentMode: true,
    activeHoverUsername: "",
    activeHoverWatcher: null,
    activeSilentCards: new Set(),
    cache: new Map(),
    dirtyUsers: new Map(),
    cacheGeneration: null,
    captureGeneration: 0,
    clearedAt: 0,
    activeRuns: {},
    storageCapacityReached: false,
    storageRevision: 0,
    cleanupCallbacks: [],
    earlyUsers: [],
    hoverAttempts: new Set(),
    hoverDeferTimers: new Map(),
    hoverDiagnostics: [],
    hoverJobSequence: 0,
    hoverQueue: [],
    hoverRetryTimers: new Map(),
    hovering: false,
    initialized: false,
    intersectionObserver: null,
    visibleCells: new WeakSet(),
    observedCells: new Set(),
    lastUserActivityAt: 0,
    languagePreference: null,
    mutationObserver: null,
    pendingLookups: new Set(),
    pendingSaveTimer: 0,
    persistInFlight: null,
    persistRequested: false,
    persistError: "",
    idleScanTimer: 0,
    scanTimer: 0,
    settings: core.normalizeDisplaySettings(),
    startedAt: Date.now(),
    statsFromApi: 0,
    statsFromHover: 0,
    userActivityVersion: 0
  };

  addEventListener("message", onPageMessage);
  state.cleanupCallbacks.push(() => removeEventListener("message", onPageMessage));
  notifyContentReady();

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  state.cleanupCallbacks.push(() => chrome.runtime.onMessage.removeListener(onRuntimeMessage));
  const flushOnPageHide = () => {
    // Dispatch immediately even if an earlier write is awaiting its callback.
    // The background queue merges duplicate records and preserves clear ordering.
    if (state.initialized && state.dirtyUsers.size) {
      void persistCacheSnapshot().catch(recordPersistError);
    }
  };
  addEventListener("pagehide", flushOnPageHide);
  state.cleanupCallbacks.push(() => removeEventListener("pagehide", flushOnPageHide));

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || typeof message !== "object") {
      return false;
    }
    if (message.type === "xfs:rescan") {
      if (!isPageAllowed()) {
        removeAllPills();
        sendResponse({ ok: true, status: getStatus() });
        return false;
      }
      scanStatsSurfaces({ forceFallback: true });
      sendResponse({ ok: true, status: getStatus() });
      return false;
    }
    if (message.type === "xfs:status") {
      sendResponse({ ok: true, status: getStatus() });
      return false;
    }
    if (message.type === "xfs:updateProfileStats") {
      performProfileStatsUpdate(message.username, Boolean(message.force), message.refreshRequestedAt)
        .then(result => sendResponse(result))
        .catch(error => {
          sendResponse({
            ok: false,
            hasStats: false,
            error: error && error.message ? error.message : "unknown"
          });
        });
      return true;
    }
    if (message.type === "xfs:clearCache") {
      clearLocalCache();
      sendResponse({ ok: true, status: getStatus() });
      return false;
    }
    if (message.type === "xfs:updateSettings") {
      state.settings = core.normalizeDisplaySettings(message.settings);
      chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
      removeDisabledPills();
      scanStatsSurfaces({ forceFallback: false });
      sendResponse({ ok: true, status: getStatus() });
      return false;
    }
    if (message.type === "xfs:updateLanguage") {
      state.languagePreference = i18n && i18n.normalizeLanguage
        ? i18n.normalizeLanguage(message.languagePreference) || null
        : null;
      refreshPillLanguage();
      sendResponse({ ok: true, status: getStatus() });
      return false;
    }
    return false;
  }

  setupStorageListener();
  Promise.all([loadCache(), loadSettings(), loadLanguagePreference()]).then(() => {
    state.initialized = true;
    if (state.earlyUsers.length > 0) {
      const earlyBatches = state.earlyUsers.splice(0);
      for (const batch of earlyBatches) if (isCurrentCapture(batch)) storeUsers(batch.users, "pageData");
    }
    document.querySelectorAll(".xfs-stats-pill").forEach(pill => pill.remove());
    setupObservers();
    scheduleScan(0);
  }).catch(recordPersistError);

  window.__xFollowStatsContentCleanup = cleanup;

  function cleanup() {
    cancelHiddenHover();
    clearTimeout(state.scanTimer);
    clearTimeout(state.idleScanTimer);
    clearTimeout(state.pendingSaveTimer);
    state.hoverRetryTimers.forEach(timer => clearTimeout(timer));
    state.hoverRetryTimers.clear();
    state.hoverDeferTimers.forEach(timer => clearTimeout(timer));
    state.hoverDeferTimers.clear();
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
    }
    if (state.intersectionObserver) {
      state.intersectionObserver.disconnect();
    }
    state.cleanupCallbacks.forEach(callback => callback());
    state.cleanupCallbacks.length = 0;
    if (window.__xFollowStatsContentCleanup === cleanup) {
      delete window.__xFollowStatsContentCleanup;
    }
  }

  function onPageMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) {
      return;
    }
    if (event.data.type === "hook-ready") {
      notifyContentReady();
      return;
    }
    if (event.data.type === "users") {
      if (!isPageAllowed() || !isCurrentCapture(event.data)) {
        return;
      }
      if (!state.initialized) {
        state.earlyUsers.push(event.data);
        return;
      }
      storeUsers(event.data.users, "pageData");
    }
  }

  function isCurrentCapture(batch) {
    return batch.captureGeneration === state.captureGeneration
      && (!state.clearedAt || Number(batch.requestStartedAt) > state.clearedAt);
  }

  function notifyContentReady() {
    window.postMessage({ source: SOURCE, type: "content-ready" }, window.location.origin);
  }

  function setupStorageListener() {
    const storageListener = (changes, area) => {
      if (area && area !== "local") return;
      state.storageRevision++;
      if (changes[storage.STATUS_KEY]) {
        const status = changes[storage.STATUS_KEY].newValue || {};
        if (status.error) state.persistError ||= status.error;
        else if (!state.dirtyUsers.size) state.persistError = '';
        if (status.code === 'storage_capacity') state.storageCapacityReached = true;
        else if (!state.dirtyUsers.size) state.storageCapacityReached = false;
      }
      if (changes[storage.CLEARED_AT_KEY]) state.clearedAt = changes[storage.CLEARED_AT_KEY].newValue || 0;
      if (changes[storage.GENERATION_KEY]) {
        state.cacheGeneration = changes[storage.GENERATION_KEY].newValue || 0;
        clearLocalCache();
      }
      if (changes[storage.RUNS_KEY]) state.activeRuns = changes[storage.RUNS_KEY].newValue || {};
      if (changes[STORAGE_KEY]) mergeExternalCache(changes[STORAGE_KEY].newValue || {});
      if (changes[SETTINGS_KEY]) {
        state.settings = core.normalizeDisplaySettings(changes[SETTINGS_KEY].newValue);
        removeDisabledPills();
        scheduleScan(0);
      }
      if (changes[LANGUAGE_KEY]) {
        state.languagePreference = i18n && i18n.normalizeLanguage
          ? i18n.normalizeLanguage(changes[LANGUAGE_KEY].newValue) || null
          : null;
        refreshPillLanguage();
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
    state.cleanupCallbacks.push(() => chrome.storage.onChanged.removeListener(storageListener));

  }

  function setupObservers() {
    state.mutationObserver = new MutationObserver(records => {
      pruneSilentCards();
      for (const cell of state.observedCells) if (!document.contains(cell)) unregisterCell(cell);
      const owned = node => node.nodeType === 1 && node.matches('.xfs-stats-pill, .xfs-userlist-anchor');
      if (records.some(record => !record.target.parentElement?.closest('.xfs-stats-pill, .xfs-userlist-anchor')
        && !owned(record.target)
        && (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !owned(node))))) {
        scheduleScan(SCAN_DEBOUNCE_MS);
      }
    });
    observeDocument();

    state.intersectionObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            state.visibleCells.delete(entry.target);
            continue;
          }
          state.visibleCells.add(entry.target);
          const cell = entry.target;
          const surface = surfaceFromElement(cell);
          if (!isSurfaceEnabled(surface)) {
            continue;
          }
          const profile = readProfileFromCell(cell, surface);
          if (profile && shouldRecordUsername(profile.username) && !getFreshCachedStats(profile.username)) {
            schedulePassiveLookup(profile, cell, surface);
          } else if (profile && getFreshCachedStats(profile.username)) {
            state.intersectionObserver.unobserve(cell);
        state.visibleCells.delete(cell);
        state.observedCells.delete(cell);
          }
        }
      },
      { root: null, rootMargin: "400px 0px", threshold: 0.01 }
    );

    const visibilityListener = () => {
      if (!document.hidden) {
        scheduleScan(0);
      }
    };
    document.addEventListener("visibilitychange", visibilityListener);
    state.cleanupCallbacks.push(() => document.removeEventListener("visibilitychange", visibilityListener));

    const userActivityEvents = ["pointermove", "pointerdown", "wheel", "keydown", "scroll"];
    const markUserActivity = () => {
      state.lastUserActivityAt = Date.now();
      cancelHiddenHover();
      scheduleIdleScan();
    };
    userActivityEvents.forEach(type => document.addEventListener(type, markUserActivity, { capture: true, passive: true }));
    state.cleanupCallbacks.push(() => {
      userActivityEvents.forEach(type => document.removeEventListener(type, markUserActivity, true));
    });
  }

  function observeDocument() {
    const root = document.body || document.documentElement;
    if (root && state.mutationObserver) {
      state.mutationObserver.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] });
      return;
    }
    setTimeout(observeDocument, 50);
  }

  function scheduleScan(delay) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => scanStatsSurfaces({ forceFallback: false }), delay);
  }

  function clearLocalCache() {
    state.captureGeneration++;
    state.earlyUsers.length = 0;
    window.postMessage({ source: SOURCE, type: 'invalidate-captures', captureGeneration: state.captureGeneration }, location.origin);
    cancelHiddenHover();
    state.dirtyUsers.clear();
    state.persistError = "";
    state.storageCapacityReached = false;
    clearTimeout(state.pendingSaveTimer);
    state.hoverRetryTimers.forEach(timer => clearTimeout(timer));
    state.hoverRetryTimers.clear();
    state.cache.clear();
    state.hoverAttempts.clear();
    state.hoverDeferTimers.forEach(timer => clearTimeout(timer));
    state.hoverDeferTimers.clear();
    state.hoverQueue.length = 0;
    state.pendingLookups.clear();
    removeAllPills();
  }

  function scanStatsSurfaces(options) {
    if (!state.initialized) return;
    if (!isPageAllowed()) {
      removeAllPills();
      return;
    }
    removeDisabledPills();
    const entries = findStatsSurfaces();
    for (const entry of entries) {
      processCell(entry.element, options, entry.surface);
    }
    retryLoadingPills();
  }

  function retryLoadingPills() {
    if (document.hidden || !isPageAllowed()) {
      return;
    }
    document.querySelectorAll('.xfs-stats-pill[data-xfs-state="loading"]').forEach(pill => {
      const username = core.normalizeUsername(pill.dataset.xfsUsername);
      const surface = pill.dataset.xfsSurface || "userList";
      if (!username || !isSurfaceEnabled(surface) || !shouldRecordUsername(username) || getFreshCachedStats(username)) {
        return;
      }
      const cell = pill.closest('article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="cellInnerDiv"]');
      if (!cell || !document.contains(cell)) {
        return;
      }
      const profile = readProfileFromCell(cell, surface);
      if (!profile || profile.username !== username) {
        return;
      }
      schedulePassiveLookup(profile, cell, surface);
    });
  }

  function findStatsSurfaces() {
    if (!isPageAllowed()) {
      return [];
    }
    const entries = [];
    const seen = new Set();

    function add(element, surface) {
      if (!element || !isSurfaceEnabled(surface) || seen.has(element)) {
        return;
      }
      seen.add(element);
      entries.push({ element, surface });
    }

    if (state.settings.userList) {
      document.querySelectorAll('[data-testid="UserCell"]').forEach(element => add(element, "userList"));
      document.querySelectorAll('[data-testid="cellInnerDiv"]').forEach(element => {
        if (element.querySelector('article[data-testid="tweet"], [data-testid="UserCell"]')) {
          return;
        }
        if (readProfileFromCell(element, "userList")) {
          add(element, "userList");
        }
      });
    }

    if (state.settings.feed) {
      document.querySelectorAll('article[data-testid="tweet"]').forEach(element => add(element, "feed"));
    }

    return entries;
  }

  function processCell(cell, options, surface) {
    if (!isPageAllowed() || !isSurfaceEnabled(surface)) {
      return;
    }
    const profile = readProfileFromCell(cell, surface);
    if (!profile) {
      return;
    }
    if (!shouldRecordUsername(profile.username)) {
      removePill(cell, profile.username, surface);
      return;
    }

    removeMismatchedPills(cell, profile.username, surface);

    storeObservedUser(profile, cell, surface);
    cell.dataset.xfsUsername = profile.username;
    cell.dataset.xfsSurface = surface;
    const cachedStats = getFreshCachedStats(profile.username);
    if (cachedStats) {
      renderStats(ensurePill(cell, profile, surface), cachedStats);
      if (state.intersectionObserver) {
        state.intersectionObserver.unobserve(cell);
        state.visibleCells.delete(cell);
      }
      return;
    }
    const pill = ensurePill(cell, profile, surface);
    pill.dataset.xfsState = "loading";
    setPillText(pill, t("pillWaitingData"));
    pill.title = t("pillLoadingFullTitle");

    if (state.intersectionObserver) {
      state.intersectionObserver.observe(cell);
      state.observedCells.add(cell);
    }
    if (!state.intersectionObserver || (options?.forceFallback && state.visibleCells.has(cell))) {
      schedulePassiveLookup(profile, cell, surface, { forceFallback: Boolean(options?.forceFallback) });
    }
  }

  function isLookupTargetValid(profile, cell, surface) {
    if (!profile || !cell || document.hidden || !isSurfaceEnabled(surface) || !document.contains(cell)) return false;
    if (state.intersectionObserver && !state.visibleCells.has(cell)) return false;
    const rect = cell.getBoundingClientRect();
    return rect.bottom >= -400 && rect.top <= window.innerHeight + 400
      && readProfileFromCell(cell, surface)?.username === profile.username;
  }

  async function schedulePassiveLookup(profile, cell, surface, options) {
    if (!isLookupTargetValid(profile, cell, surface)) {
      return;
    }
    const generation = state.cacheGeneration;
    const key = `${profile.username}:${surface}`;
    if (state.pendingLookups.has(key)) {
      return;
    }
    state.pendingLookups.add(key);
    try {
      const stats = await waitForCachedStats(profile.username, API_GRACE_MS);
      if (generation !== state.cacheGeneration || !isLookupTargetValid(profile, cell, surface)) return;
      if (stats) {
        updateVisibleCells(profile.username);
        if (state.intersectionObserver) {
          state.intersectionObserver.unobserve(cell);
        state.visibleCells.delete(cell);
        }
        return;
      }
      queueHover(profile, cell, surface, { force: Boolean(options && options.forceFallback) });
    } finally {
      state.pendingLookups.delete(key);
    }
  }

  function readProfileFromCell(cell, surface) {
    const searchRoot = surface === "feed" ? cell.querySelector('[data-testid="User-Name"]') || cell : cell;
    const anchors = Array.from(searchRoot.querySelectorAll('a[href^="/"], a[href^="https://x.com/"], a[href^="https://twitter.com/"]'));
    for (const anchor of anchors) {
      const username = usernameFromHref(anchor.href || anchor.getAttribute("href"));
      if (!username) {
        continue;
      }
      const text = core.normalizeText(anchor.textContent || "");
      const isNameLink = text && !text.startsWith("@");
      return {
        username,
        displayName: text || "",
        avatarOrNameLink: anchor,
        nameLink: isNameLink ? anchor : findNameLink(searchRoot, username) || anchor
      };
    }
    return null;
  }

  function findNameLink(cell, username) {
    const links = Array.from(cell.querySelectorAll('a[href^="/"], a[href^="https://x.com/"], a[href^="https://twitter.com/"]'));
    return core.findNameLinkInAnchors(links, username, location.origin);
  }

  function usernameFromHref(href) {
    return core.usernameFromProfileHref(href, location.origin);
  }

  function ensurePill(cell, profile, surface) {
    let pill = findPill(cell, profile.username, surface);
    if (pill) {
      placePill(cell, profile, pill, surface);
      return pill;
    }

    pill = document.createElement("span");
    pill.className = "xfs-stats-pill";
    pill.dataset.xfsUsername = profile.username;
    pill.dataset.xfsSurface = surface;
    pill.dataset.xfsState = "loading";
    pill.textContent = t("pillWaitingData");
    pill.title = t("pillLoadingShortTitle");

    placePill(cell, profile, pill, surface);
    return pill;
  }

  function findPill(cell, username, surface) {
    return cell.querySelector(
      `.xfs-stats-pill[data-xfs-username="${cssEscape(username)}"][data-xfs-surface="${surface}"]`
    );
  }

  function placePill(cell, profile, pill, surface) {
    const nameBlock = cell.querySelector('[data-testid="User-Name"]');
    const nameLink = profile.nameLink || findNameLink(cell, profile.username);
    if (surface === "feed" && nameBlock) {
      if (pill.parentElement !== nameBlock) nameBlock.appendChild(pill);
    } else if (nameLink && nameLink.parentElement) {
      const anchor = ensureUserListPillAnchor(nameLink);
      if (pill.parentElement !== anchor) anchor.appendChild(pill);
    } else if (nameBlock) {
      if (pill.parentElement !== nameBlock) nameBlock.appendChild(pill);
    } else {
      if (pill.parentElement !== cell) cell.appendChild(pill);
    }
  }

  function ensureUserListPillAnchor(nameLink) {
    const parent = nameLink.parentElement;
    let anchor = parent.querySelector(":scope > .xfs-userlist-anchor");
    if (anchor) {
      return anchor;
    }
    anchor = document.createElement("span");
    anchor.className = "xfs-userlist-anchor";
    const handleRow = findHandleRowAfterNameLink(nameLink);
    if (handleRow && handleRow.parentElement === parent) {
      parent.insertBefore(anchor, handleRow);
    } else {
      nameLink.insertAdjacentElement("afterend", anchor);
    }
    return anchor;
  }

  function findHandleRowAfterNameLink(nameLink) {
    const parent = nameLink.parentElement;
    if (!parent) {
      return null;
    }
    let current = nameLink.nextElementSibling;
    while (current) {
      const text = core.normalizeText(current.innerText || current.textContent || "");
      if (text.startsWith("@")) {
        return current;
      }
      current = current.nextElementSibling;
    }
    return null;
  }

  function setPillText(pill, text) {
    if (pill.textContent !== text) pill.textContent = text;
  }

  function renderStats(pill, stats) {
    const locale = i18n && i18n.localeTag ? i18n.localeTag(state.languagePreference) : "en";
    const followingDisplay = core.formatStatsCount(stats, 'following', locale);
    const followersDisplay = core.formatStatsCount(stats, 'followers', locale);
    if (!followingDisplay || !followersDisplay) {
      pill.remove();
      return;
    }
    pill.dataset.xfsState = "loaded";
    setPillText(pill, t("pillStatsText", followingDisplay, followersDisplay));
    const followingRaw = stats.followingPrecision === "approximate" ? ` (${t("approximateLabel")})` : Number.isFinite(stats.followingCount) ? ` (${stats.followingCount.toLocaleString(locale)})` : "";
    const followersRaw = stats.followersPrecision === "approximate" ? ` (${t("approximateLabel")})` : Number.isFinite(stats.followersCount) ? ` (${stats.followersCount.toLocaleString(locale)})` : "";
    const surfaces = core.userSurfaceSources ? core.userSurfaceSources(stats).map(sourceLabel) : [];
    const sourceText = surfaces.length > 0 ? `\n${t("sourcePrefix")}${surfaces.join(t("listSeparator"))}` : "";
    pill.title = `${t("followingLabel")}: ${followingDisplay}${followingRaw}\n${t("followersLabel")}: ${followersDisplay}${followersRaw}${sourceText}`;
  }

  function sourceLabel(source) {
    return {
      feed: t("sourceFeed"),
      userList: t("sourceUserList")
    }[core.normalizeSource ? core.normalizeSource(source) : source] || source;
  }

  function storeObservedUser(profile, cell, surface) {
    const observedPost = surface === "feed" ? readTweetPost(cell, profile.username) : null;
    const existing = state.cache.get(profile.username);
    const observedUser = {
      username: profile.username,
      displayName: profile.displayName,
      profileUrl: `https://x.com/${profile.username}`,
      avatarUrl: readAvatarUrl(cell),
      sources: surface === "feed" && observedPost && observedPost.kind === "comment" ? [] : [surface]
    };
    if (observedPost) {
      observedUser.observedPost = observedPost;
    }
    const lastSeenAt = Date.parse(existing && existing.lastSeenAt ? existing.lastSeenAt : "") || 0;
    const existingPosts = existing && Array.isArray(existing.observedPosts) ? existing.observedPosts : [];
    const hasNewPost = Boolean(observedPost && !existingPosts.some(post => (
      (observedPost.id && post.id === observedPost.id)
      || (observedPost.url && post.url === observedPost.url)
      || (!observedPost.id && !observedPost.url && post.text === observedPost.text)
    )));
    const profileChanged = !existing
      || observedUser.displayName !== (existing.displayName || "")
      || (observedUser.avatarUrl && observedUser.avatarUrl !== (existing.avatarUrl || ""));
    const sourceChanged = observedUser.sources.some(source => !(existing?.sources || []).includes(source));
    const shouldPersist = profileChanged || hasNewPost || sourceChanged || Date.now() - lastSeenAt >= LAST_SEEN_PERSIST_INTERVAL_MS;
    if (shouldPersist) mergeUserRecord(observedUser);
  }

  function getFreshCachedStats(username, minStatsUpdatedAt) {
    const stats = state.cache.get(username);
    if (!core.isCachedStatsFresh(stats, {
      now: Date.now(),
      ttlMs: CACHE_TTL_MS,
      minStatsUpdatedAt
    })) {
      return null;
    }
    return stats;
  }

  function storeUsers(users, source) {
    if (!Array.isArray(users) || users.length === 0) {
      return;
    }
    let changed = false;
    const changedUsernames = [];
    for (const user of users) {
      const username = core.normalizeUsername(user && user.username);
      if (!username) {
        continue;
      }
      if (!shouldRecordUsername(username)) {
        continue;
      }
      const followingCount = toFiniteNumber(user.followingCount);
      const followersCount = toFiniteNumber(user.followersCount);
      const followingDisplay = typeof user.followingDisplay === "string" ? user.followingDisplay : "";
      const followersDisplay = typeof user.followersDisplay === "string" ? user.followersDisplay : "";
      if ((followingCount === null || followersCount === null) && (!followingDisplay || !followersDisplay)) {
        continue;
      }
      const statsUpdatedAt = Date.now();
      const merged = mergeUserRecord({
        username,
        displayName: typeof user.displayName === "string" ? user.displayName : "",
        userId: typeof user.userId === "string" ? user.userId : "",
        profileUrl: `https://x.com/${username}`,
        avatarUrl: typeof user.avatarUrl === "string" ? user.avatarUrl : "",
        ...(typeof user.bio === "string" ? { bio: user.bio } : {}),
        ...(typeof user.website === "string" ? { website: user.website } : {}),
        ...(typeof user.verified === "boolean" ? { verified: user.verified } : {}),
        followingCount,
        followersCount,
        followingDisplay: followingDisplay || core.formatCompactCount(followingCount),
        followersDisplay: followersDisplay || core.formatCompactCount(followersCount),
        sources: [],
        statsUpdatedAt,
        statsSource: source === "pageData" ? "network" : source,
        updatedAt: statsUpdatedAt
      }, { scheduleSave: false });
      if (!merged) {
        continue;
      }
      changed = true;
      changedUsernames.push(username);
      if (source === "pageData" || source === "api") {
        state.statsFromApi += 1;
      } else if (source === "hover") {
        state.statsFromHover += 1;
      }
    }

    if (changed) {
      schedulePersist();
      changedUsernames.forEach(username => {
        state.hoverAttempts.delete(username);
        clearDeferredHover(username);
        clearHoverRetry(username);
        updateVisibleCells(username);
      });
    }
  }

  function mergeUserRecord(user, options) {
    const username = core.normalizeUsername(user && user.username);
    if (!username) {
      return null;
    }
    if (!shouldRecordUsername(username)) {
      return null;
    }
    const merged = core.mergeObservedUser(state.cache.get(username), user);
    if (!merged) {
      return null;
    }
    state.cache.set(username, merged);
    state.dirtyUsers.set(username, merged);
    if (options?.scheduleSave !== false) {
      schedulePersist();
    }
    return merged;
  }

  function shouldRecordUsername(username) {
    const normalizedUsername = core.normalizeUsername(username);
    return Boolean(normalizedUsername && ((!state.storageCapacityReached && !state.settings.updateOnlyExisting && Object.keys(state.activeRuns).length === 0) || state.cache.has(normalizedUsername)));
  }

  function updateVisibleCells(username) {
    const stats = getFreshCachedStats(username);
    if (!stats) {
      return;
    }
    document.querySelectorAll(`.xfs-stats-pill[data-xfs-username="${cssEscape(username)}"]`).forEach(element => {
      const cell = element.matches('[data-testid="UserCell"], [data-testid="cellInnerDiv"]')
        ? element
        : element.closest('article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="cellInnerDiv"]');
      if (!cell) {
        return;
      }
      const surface = element.dataset.xfsSurface || surfaceFromElement(cell);
      if (!isSurfaceEnabled(surface)) {
        removePillElement(element);
        return;
      }
      const profile = readProfileFromCell(cell, surface);
      if (!profile || profile.username !== username) {
        if (element.classList && element.classList.contains("xfs-stats-pill")) {
          removePillElement(element);
        }
        return;
      }
      renderStats(ensurePill(cell, profile, surface), stats);
      if (state.intersectionObserver) {
        state.intersectionObserver.unobserve(cell);
        state.visibleCells.delete(cell);
      }
    });
  }

  function refreshPillLanguage() {
    const usernames = new Set();
    document.querySelectorAll(".xfs-stats-pill").forEach(pill => {
      const username = core.normalizeUsername(pill.dataset.xfsUsername);
      if (username) {
        usernames.add(username);
      }
      if (pill.dataset.xfsState === "loading") {
        pill.textContent = t("pillWaitingData");
        pill.title = t("pillLoadingShortTitle");
      }
    });
    usernames.forEach(username => updateVisibleCells(username));
  }

  function queueHover(profile, cell, surface, options) {
    if (!isLookupTargetValid(profile, cell, surface)) {
      return;
    }
    if (hasVisibleHoverCard()) {
      scheduleDeferredHover(profile, cell, surface, "visible-card");
      return;
    }
    if (!shouldQueueHover(profile.username, Boolean(options?.force))) {
      if (isUserInputFocused() || Date.now() - state.lastUserActivityAt < USER_IDLE_BEFORE_HOVER_MS) {
        scheduleDeferredHover(profile, cell, surface, "not-idle");
      }
      return;
    }
    clearDeferredHover(profile.username);
    state.hoverQueue.push({ profile, cell, surface });
    traceHover(profile.username, "queued", { surface });
    runHoverQueue();
  }

  function shouldQueueHover(username, force) {
    const shouldQueue = core.shouldRunHoverFallback({
      alreadyAttempted: state.hoverAttempts.has(username),
      documentHidden: document.hidden,
      force,
      idleForMs: Date.now() - state.lastUserActivityAt,
      inputFocused: isUserInputFocused(),
      requiredIdleMs: USER_IDLE_BEFORE_HOVER_MS
    });
    if (!shouldQueue) {
      return false;
    }
    state.hoverAttempts.add(username);
    return true;
  }

  function cancelHiddenHover() {
    state.userActivityVersion += 1;
    const queuedItems = state.hoverQueue.splice(0);
    queuedItems.forEach(item => {
      if (item && item.profile) {
        state.hoverAttempts.delete(item.profile.username);
        scheduleDeferredHover(item.profile, item.cell, item.surface, "user-activity");
      }
    });
    if (state.activeHoverUsername) {
      state.hoverAttempts.delete(state.activeHoverUsername);
    }
    if (state.activeHoverWatcher) {
      state.activeHoverWatcher.cancel("user-activity");
      state.activeHoverWatcher = null;
    }
    if (state.activeHoverTarget) {
      releaseHover(state.activeHoverTarget, state.activeHoverSilentMode);
      state.activeHoverTarget = null;
    }
    state.activeHoverSilentMode = true;
    state.activeHoverUsername = "";
    clearSilentCardMarkers();
    if (document.documentElement) {
      delete document.documentElement.dataset.xfsSilentHover;
    }
  }

  function scheduleIdleScan() {
    clearTimeout(state.idleScanTimer);
    state.idleScanTimer = setTimeout(() => {
      state.idleScanTimer = 0;
      scheduleScan(0);
    }, USER_IDLE_BEFORE_HOVER_MS + 50);
  }

  function scheduleDeferredHover(profile, cell, surface, reason) {
    if (!profile || state.hoverDeferTimers.has(profile.username)) {
      return;
    }
    const idleRemaining = Math.max(
      100,
      USER_IDLE_BEFORE_HOVER_MS - (Date.now() - state.lastUserActivityAt) + 50
    );
    const delayMs = isUserInputFocused() || reason === "visible-card"
      ? Math.max(idleRemaining, 500)
      : idleRemaining;
    traceHover(profile.username, "deferred", { reason, delayMs, surface });
    const timer = setTimeout(() => {
      state.hoverDeferTimers.delete(profile.username);
      state.hoverAttempts.delete(profile.username);
      if (
        state.initialized
        && document.contains(cell)
        && !getFreshCachedStats(profile.username)
        && isSurfaceEnabled(surface)
      ) {
        queueHover(profile, cell, surface, { force: false });
      }
    }, delayMs);
    state.hoverDeferTimers.set(profile.username, timer);
  }

  function clearDeferredHover(username) {
    const timer = state.hoverDeferTimers.get(username);
    if (timer) {
      clearTimeout(timer);
      state.hoverDeferTimers.delete(username);
    }
  }

  function pruneSilentCards() {
    state.activeSilentCards.forEach(card => {
      if (!card.isConnected) {
        card.removeAttribute("aria-hidden");
        delete card.dataset.xfsSilentCard;
        state.activeSilentCards.delete(card);
      }
    });
  }

  function clearSilentCardMarkers() {
    state.activeSilentCards.forEach(card => {
      card.removeAttribute("aria-hidden");
      delete card.dataset.xfsSilentCard;
    });
    state.activeSilentCards.clear();
  }

  function isUserInputFocused() {
    const active = document.activeElement;
    return Boolean(active && (
      active.matches?.("input, textarea, select")
      || active.isContentEditable
      || active.closest?.('[contenteditable="true"]')
    ));
  }

  async function runHoverQueue() {
    if (state.hovering) {
      return;
    }
    state.hovering = true;
    try {
      while (state.hoverQueue.length > 0) {
        const item = state.hoverQueue.shift();
        if (item && hasVisibleHoverCard()) {
          state.hoverAttempts.delete(item.profile.username);
          scheduleDeferredHover(item.profile, item.cell, item.surface, "visible-card");
          continue;
        }
        if (!item) {
          continue;
        }
        if (!isLookupTargetValid(item.profile, item.cell, item.surface) || getFreshCachedStats(item.profile.username)) {
          state.hoverAttempts.delete(item.profile.username);
          continue;
        }
        if (isUserInputFocused() || Date.now() - state.lastUserActivityAt < USER_IDLE_BEFORE_HOVER_MS) {
          state.hoverAttempts.delete(item.profile.username);
          scheduleDeferredHover(item.profile, item.cell, item.surface, "not-idle");
          continue;
        }
        await hydrateFromHover(item.profile, item.cell, item.surface);
      }
    } finally {
      state.hovering = false;
    }
  }

  async function hydrateFromHover(profile, cell, surface) {
    if (!isLookupTargetValid(profile, cell, surface) || hasVisibleHoverCard()) {
      state.hoverAttempts.delete(profile.username);
      return;
    }
    const target = profile.avatarOrNameLink || profile.nameLink;
    const activityVersion = state.userActivityVersion;
    const jobId = ++state.hoverJobSequence;
    const pill = findPill(cell, profile.username, surface) || ensurePill(cell, profile, surface);
    try {
      pill.dataset.xfsState = "loading";
      pill.textContent = t("pillReading");
      pill.title = t("pillHoverReadingTitle");

      const silentOutcome = await runHoverAttempt(profile.username, target, activityVersion, {
        hidden: true,
        jobId,
        mode: "background",
        timeoutMs: SILENT_HOVER_TIMEOUT_MS
      });
      if (state.userActivityVersion !== activityVersion) return;
      if (!isLookupTargetValid(profile, cell, surface)) {
        state.hoverAttempts.delete(profile.username);
        return;
      }
      if (applyHoverOutcome(profile, silentOutcome, jobId, "background")) {
        return;
      }
      if (silentOutcome.cancelled || state.userActivityVersion !== activityVersion) {
        deferInterruptedHover(profile, cell, surface, pill, jobId, silentOutcome.reason);
        return;
      }

      if (hasVisibleHoverCard() || isUserInputFocused()) {
        state.hoverAttempts.delete(profile.username);
        scheduleDeferredHover(profile, cell, surface, "visible-card");
        return;
      }

      traceHover(profile.username, "automatic-fallback", {
        jobId,
        silentElapsedMs: silentOutcome.elapsedMs
      });
      const fallbackOutcome = await runHoverAttempt(profile.username, target, activityVersion, {
        hidden: false,
        jobId,
        mode: "fallback",
        timeoutMs: HOVER_TIMEOUT_MS
      });
      if (state.userActivityVersion !== activityVersion) return;
      if (!isLookupTargetValid(profile, cell, surface)) {
        state.hoverAttempts.delete(profile.username);
        return;
      }
      if (applyHoverOutcome(profile, fallbackOutcome, jobId, "fallback")) {
        return;
      }
      if (fallbackOutcome.cancelled || state.userActivityVersion !== activityVersion) {
        deferInterruptedHover(profile, cell, surface, pill, jobId, fallbackOutcome.reason);
        return;
      }

      traceHover(profile.username, "timeout", { jobId, elapsedMs: fallbackOutcome.elapsedMs });
      pill.dataset.xfsState = "loading";
      pill.textContent = t("pillWaitingData");
      pill.title = t("pillHoverMissingTitle");
      scheduleHoverRetry(profile, cell, surface);
    } catch {
      pill.dataset.xfsState = "loading";
      pill.textContent = t("pillWaitingData");
      pill.title = t("pillHoverInterruptedTitle");
      scheduleHoverRetry(profile, cell, surface);
    }
  }

  async function runHoverAttempt(username, target, activityVersion, options) {
    const hidden = Boolean(options.hidden);
    const root = document.documentElement;
    let watcher = null;
    try {
      if (hidden) {
        root.dataset.xfsSilentHover = "1";
      }
      state.activeHoverTarget = target;
      state.activeHoverSilentMode = hidden;
      state.activeHoverUsername = username;
      watcher = createHoverOutcomeWatcher(username, activityVersion, options);
      state.activeHoverWatcher = watcher;
      traceHover(username, "triggering", {
        jobId: options.jobId,
        mode: options.mode,
        activeElement: activeElementFingerprint(),
        targetHref: target && (target.href || target.getAttribute?.("href") || "")
      });
      triggerHover(target, hidden);
      return await watcher.promise;
    } finally {
      if (watcher) {
        watcher.stop();
      }
      if (state.activeHoverWatcher === watcher) {
        state.activeHoverWatcher = null;
      }
      if (state.activeHoverTarget === target) {
        releaseHover(target, hidden);
        state.activeHoverTarget = null;
        state.activeHoverSilentMode = true;
      }
      if (state.activeHoverUsername === username) {
        state.activeHoverUsername = "";
      }
      if (hidden) {
        delete root.dataset.xfsSilentHover;
      }
    }
  }

  function applyHoverOutcome(profile, outcome, jobId, mode) {
    if (outcome.source === "cache" && outcome.stats) {
      state.hoverAttempts.delete(profile.username);
      traceHover(profile.username, "resolved-cache", { jobId, mode, elapsedMs: outcome.elapsedMs });
      updateVisibleCells(profile.username);
      return true;
    }
    if (outcome.source !== "card" || !outcome.stats) {
      return false;
    }
    traceHover(profile.username, "resolved-card", { jobId, mode, elapsedMs: outcome.elapsedMs });
    storeUsers(
      [
        {
          username: profile.username,
          followingDisplay: outcome.stats.followingDisplay,
          followersDisplay: outcome.stats.followersDisplay
        }
      ],
      "hover"
    );
    return true;
  }

  function deferInterruptedHover(profile, cell, surface, pill, jobId, reason) {
    traceHover(profile.username, "cancelled", { jobId, reason: reason || "activity" });
    pill.dataset.xfsState = "loading";
    pill.textContent = t("pillWaitingData");
    pill.title = t("pillHoverInterruptedTitle");
    scheduleDeferredHover(profile, cell, surface, "interrupted");
  }

  function scheduleHoverRetry(profile, cell, surface) {
    if (state.hoverRetryTimers.has(profile.username)) {
      return;
    }
    const timer = setTimeout(() => {
      state.hoverRetryTimers.delete(profile.username);
      if (state.activeHoverUsername === profile.username) {
        scheduleHoverRetry(profile, cell, surface);
        return;
      }
      state.hoverAttempts.delete(profile.username);
      if (state.initialized && document.contains(cell) && !getFreshCachedStats(profile.username)) {
        queueHover(profile, cell, surface, { force: false });
      }
    }, HOVER_RETRY_MS);
    state.hoverRetryTimers.set(profile.username, timer);
  }

  function clearHoverRetry(username) {
    const timer = state.hoverRetryTimers.get(username);
    if (timer) {
      clearTimeout(timer);
      state.hoverRetryTimers.delete(username);
    }
  }

  function triggerHover(target, hidden) {
    if (!target) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      view: window
    };
    target.dispatchEvent(new PointerEvent("pointerover", eventInit));
    target.dispatchEvent(new PointerEvent("pointerenter", { ...eventInit, bubbles: false }));
    target.dispatchEvent(new MouseEvent("mouseover", eventInit));
    target.dispatchEvent(new MouseEvent("mouseenter", { ...eventInit, bubbles: false }));
    if (hidden) {
      target.dispatchEvent(new FocusEvent("focusin", { bubbles: true, cancelable: false, view: window }));
      target.dispatchEvent(new FocusEvent("focus", { bubbles: false, cancelable: false, view: window }));
    } else if (typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
  }

  function releaseHover(target, hidden) {
    if (!target) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: rect.right + 20,
      clientY: rect.bottom + 20,
      view: window
    };
    target.dispatchEvent(new PointerEvent("pointerout", eventInit));
    target.dispatchEvent(new PointerEvent("pointerleave", { ...eventInit, bubbles: false }));
    target.dispatchEvent(new MouseEvent("mouseout", eventInit));
    target.dispatchEvent(new MouseEvent("mouseleave", { ...eventInit, bubbles: false }));
    if (hidden) {
      target.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: false, view: window }));
      target.dispatchEvent(new FocusEvent("blur", { bubbles: false, cancelable: false, view: window }));
    } else if (document.activeElement === target && typeof target.blur === "function") {
      target.blur();
    }
  }

  function createHoverOutcomeWatcher(username, activityVersion, options) {
    const startedAt = performance.now();
    let settled = false;
    let resolvePromise = null;
    let observer = null;
    let pollTimer = 0;
    let timeoutTimer = 0;

    const promise = new Promise(resolve => {
      resolvePromise = resolve;
    });

    function finish(outcome) {
      if (settled) {
        return;
      }
      settled = true;
      if (observer) {
        observer.disconnect();
      }
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      resolvePromise({
        ...outcome,
        elapsedMs: Math.round(performance.now() - startedAt)
      });
    }

    function check() {
      if (settled) {
        return;
      }
      if (state.userActivityVersion !== activityVersion) {
        finish({ cancelled: true, reason: "user-activity" });
        return;
      }
      const cached = getFreshCachedStats(username);
      if (cached) {
        finish({ source: "cache", stats: cached });
        return;
      }
      const parsed = readHoverCardStats(username, options);
      if (parsed) {
        finish({ source: "card", stats: parsed });
      }
    }

    const root = document.body || document.documentElement;
    if (root) {
      observer = new MutationObserver(check);
      observer.observe(root, {
        attributes: true,
        attributeFilter: ["aria-hidden", "data-testid", "style"],
        characterData: true,
        childList: true,
        subtree: true
      });
    }
    pollTimer = setInterval(check, 80);
    timeoutTimer = setTimeout(() => finish({ source: "timeout" }), options.timeoutMs);
    traceHover(username, "watcher-armed", {
      jobId: options.jobId,
      mode: options.mode,
      timeoutMs: options.timeoutMs,
      activeElement: activeElementFingerprint()
    });
    check();

    return {
      promise,
      cancel(reason) {
        finish({ cancelled: true, reason: reason || "cancelled" });
      },
      stop() {
        if (!settled) {
          finish({ cancelled: true, reason: "stopped" });
        }
      }
    };
  }

  function readHoverCardStats(username, diagnosticContext) {
    const candidates = document.querySelectorAll('[data-testid="HoverCard"]');
    if (candidates.length > 0) {
      traceHover(username, "card-seen", {
        jobId: diagnosticContext?.jobId || 0,
        candidates: candidates.length
      });
    }
    for (const element of candidates) {
      if (!isVisible(element)) {
        traceHover(username, "card-rejected", { reason: "no-size" });
        continue;
      }
      if (!hoverCardMatchesUsername(element, username)) {
        traceHover(username, "card-rejected", {
          reason: "username-mismatch",
          hrefs: Array.from(element.querySelectorAll("a[href]"))
            .slice(0, 8)
            .map(anchor => anchor.getAttribute("href") || "")
        });
        continue;
      }
      if (diagnosticContext?.hidden) {
        if (element.dataset.xfsSilentCard !== "1") {
          element.setAttribute("aria-hidden", "true");
          element.dataset.xfsSilentCard = "1";
        }
        state.activeSilentCards.add(element);
      } else if (element.dataset.xfsSilentCard === "1") {
        element.removeAttribute("aria-hidden");
        delete element.dataset.xfsSilentCard;
        state.activeSilentCards.delete(element);
      }
      const text = core.normalizeText(element.innerText || element.textContent || "");
      const parsed = readOwnedStatsLinks(element, username);
      if (parsed) {
        traceHover(username, "card-parsed", {
          jobId: diagnosticContext?.jobId || 0,
          followingDisplay: parsed.followingDisplay,
          followersDisplay: parsed.followersDisplay
        });
        return parsed;
      }
      traceHover(username, "card-rejected", {
        reason: "stats-unparsable",
        text: text.slice(0, 500)
      });
    }
    return null;
  }

  function traceHover(username, event, details) {
    if (!HOVER_DIAGNOSTICS_ENABLED) {
      return;
    }
    const record = {
      at: Math.round(performance.now()),
      event,
      username,
      ...(details && typeof details === "object" ? details : {})
    };
    state.hoverDiagnostics.push(record);
    if (state.hoverDiagnostics.length > HOVER_DIAGNOSTICS_LIMIT) {
      state.hoverDiagnostics.splice(0, state.hoverDiagnostics.length - HOVER_DIAGNOSTICS_LIMIT);
    }
    console.info("[XFS_DIAG]", JSON.stringify(record));
  }

  function activeElementFingerprint() {
    const element = document.activeElement;
    if (!element) {
      return "none";
    }
    const tag = String(element.tagName || "unknown").toLowerCase();
    const testId = element.getAttribute?.("data-testid") || "";
    const role = element.getAttribute?.("role") || "";
    return [tag, testId, role].filter(Boolean).join(":");
  }

  function hoverCardMatchesUsername(element, username) {
    return Boolean(readOwnedStatsLinks(element, username));
  }

  function hasVisibleHoverCard() {
    return Array.from(document.querySelectorAll('[data-testid="HoverCard"]')).some(element => (
      element.dataset.xfsSilentCard !== "1" && isVisible(element)
    ));
  }

  function readAvatarUrl(cell) {
    const image = cell.querySelector('img[src*="profile_images"], img[src^="https://pbs.twimg.com/profile_images"]');
    return image && typeof image.src === "string" ? image.src : "";
  }

  function readTweetPost(cell, username) {
    if (!cell || !cell.matches('article[data-testid="tweet"]')) {
      return null;
    }
    const textElement = cell.querySelector('[data-testid="tweetText"]');
    const text = core.normalizeText(textElement ? textElement.innerText || textElement.textContent || "" : "");
    const statusLinks = Array.from(cell.querySelectorAll('a[href*="/status/"]'));
    const statusLink = statusLinks.find(anchor => anchor.querySelector("time") && isStatusLinkForUser(anchor, username))
      || statusLinks.find(anchor => isStatusLinkForUser(anchor, username));
    const url = statusLink ? new URL(statusLink.href || statusLink.getAttribute("href"), location.origin).href : "";
    const idMatch = url.match(/\/status\/(\d+)/);
    if (!text && !url) {
      return null;
    }
    return {
      id: idMatch ? idMatch[1] : "",
      url,
      text,
      kind: determinePostKind(cell, idMatch ? idMatch[1] : ""),
      source: "feed",
      capturedAt: new Date().toISOString()
    };
  }

  async function performProfileStatsUpdate(rawUsername, force, rawRefreshRequestedAt) {
    const generation = state.cacheGeneration;
    const username = core.normalizeUsername(rawUsername);
    if (!username) {
      return { ok: false, hasStats: false, error: "invalid_username" };
    }
    const requestedAt = Number(rawRefreshRequestedAt);
    const refreshStartedAt = force
      ? requestedAt > 0
        ? Math.min(requestedAt, Date.now())
        : Date.now()
      : 0;
    await waitForProfilePage(username, 8000);
    if (generation !== state.cacheGeneration) return { ok: false, hasStats: false, error: "cache_cleared" };
    const existingStats = getFreshCachedStats(username);
    if (existingStats && !force) {
      return profileUpdateResult(username, "cached");
    }

    const deadline = Date.now() + 18000;
    let attempts = 0;
    while (Date.now() < deadline) {
      if (generation !== state.cacheGeneration) return { ok: false, hasStats: false, error: "cache_cleared" };
      const parsed = readCurrentProfileStats(username);
      if (parsed) {
        storeUsers(
          [
            {
              username,
              followingDisplay: parsed.followingDisplay,
              followersDisplay: parsed.followersDisplay
            }
          ],
          "profile"
        );
        return profileUpdateResult(username, "profile_header", force ? refreshStartedAt : 0);
      }

      scanStatsSurfaces({ forceFallback: true });
      await gentleProfileScroll(attempts);
      const stats = await waitForCachedStats(username, 2600, {
        minStatsUpdatedAt: force ? refreshStartedAt : 0
      });
      if (stats) {
        return profileUpdateResult(username, "surface_or_fallback", force ? refreshStartedAt : 0);
      }
      attempts += 1;
    }

    const finalStats = getFreshCachedStats(username, force ? refreshStartedAt : 0);
    if (finalStats) return profileUpdateResult(username, "late_cache", force ? refreshStartedAt : 0);
    return {
      ok: true,
      hasStats: Boolean(finalStats),
      source: finalStats ? "late_cache" : "not_found"
    };
  }

  async function profileUpdateResult(username, source, minStatsUpdatedAt) {
    await persistCacheNow();
    const stats = getFreshCachedStats(username, minStatsUpdatedAt);
    return {
      ok: !state.persistError,
      error: state.persistError,
      hasStats: Boolean(stats) && !state.persistError,
      source,
      followingDisplay: stats && (stats.followingDisplay || core.formatCompactCount(stats.followingCount)),
      followersDisplay: stats && (stats.followersDisplay || core.formatCompactCount(stats.followersCount))
    };
  }

  async function waitForProfilePage(username, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (core.usernameFromProfileHref(location.href, location.origin) === username) {
        return true;
      }
      await delay(120);
    }
    return false;
  }

  async function waitForCachedStats(username, timeoutMs, options) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (options?.cancel && options.cancel()) {
        return null;
      }
      const stats = getFreshCachedStats(username, options?.minStatsUpdatedAt);
      if (stats) {
        return stats;
      }
      await delay(160);
    }
    return null;
  }

  function readCurrentProfileStats(username) {
    if (core.usernameFromProfileHref(location.href, location.origin) !== username) return null;
    return readOwnedStatsLinks(document.querySelector('main'), username);
  }

  function collectProfileStatsCandidates(username, root = document.querySelector('main')) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('a[href]')).filter(anchor =>
      !anchor.closest('article, [data-testid="UserDescription"], [data-testid="UserCell"], [data-testid="tweetText"]')
      && isProfileStatsLink(anchor, username) && isVisible(anchor));
  }

  function isProfileStatsLink(anchor, username) {
    try {
      const url = new URL(anchor.href || anchor.getAttribute('href'), location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      return ['x.com', 'twitter.com'].includes(url.hostname) && parts.length === 2
        && core.normalizeUsername(parts[0]) === username
        && ['following', 'followers', 'verified_followers'].includes(parts[1]);
    } catch { return false; }
  }

  function readOwnedStatsLinks(root, username) {
    const links = collectProfileStatsCandidates(username, root);
    const followingLinks = links.filter(a => new URL(a.href).pathname.replace(/\/$/, '').endsWith('/following'));
    const followersLinks = links.filter(a => !new URL(a.href).pathname.replace(/\/$/, '').endsWith('/following'));
    for (const following of followingLinks) {
      for (const followers of followersLinks) {
        let parent = following.parentElement;
        for (let depth = 0; depth < 3 && parent; depth++, parent = parent.parentElement) {
          // A compact owner-statistics block may wrap each link separately.
          // Never combine links merely because both appear somewhere in main.
          if (parent === root && !root.matches('[data-testid="HoverCard"]')) break;
          if (parent.contains(followers)) {
            const parsed = core.parseStatsText(following.textContent + ' ' + followers.textContent);
            if (parsed) return parsed;
          }
          if (parent === root) break;
        }
      }
    }
    return null;
  }

  async function gentleProfileScroll(attempt) {
    const down = randomInt(180, 420);
    window.scrollBy({ top: down, left: 0, behavior: "smooth" });
    await delay(randomInt(420, 720));
    if (attempt % 2 === 1) {
      window.scrollBy({ top: -randomInt(70, 160), left: 0, behavior: "smooth" });
      await delay(randomInt(220, 420));
    }
  }

  function isStatusLinkForUser(anchor, username) {
    try {
      const url = new URL(anchor.href || anchor.getAttribute("href"), location.origin);
      return core.usernameFromProfileHref(`/${url.pathname.split("/")[1]}`, location.origin) === username;
    } catch {
      return false;
    }
  }

  function determinePostKind(cell, statusId) {
    const detailStatusId = currentDetailStatusId();
    if (detailStatusId && statusId && statusId !== detailStatusId) {
      return "comment";
    }
    if (isRetweetArticle(cell)) {
      return "retweet";
    }
    return "original";
  }

  function currentDetailStatusId() {
    const match = location.pathname.match(/\/status\/(\d+)/);
    return match ? match[1] : "";
  }

  function isRetweetArticle(cell) {
    const socialContext = cell.querySelector('[data-testid="socialContext"]');
    const text = core.normalizeText(socialContext ? socialContext.innerText || socialContext.textContent || "" : "");
    return /Reposted|Retweeted|转推|转发|转帖/i.test(text);
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function loadCache() {
    const requestedGeneration = state.cacheGeneration;
    const requestedRevision = state.storageRevision;
    let result;
    try { result = await storage.request('read'); }
    catch (error) { error.cacheGeneration = requestedGeneration; throw error; }
    if (state.cacheGeneration === null) {
      // First read adopts the persisted generation. Requests made by this new
      // document still belong to its initial capture generation and cutoff.
      state.cacheGeneration = result.generation;
    } else if (result.generation < state.cacheGeneration) return;
    else if (result.generation > state.cacheGeneration) {
      state.cacheGeneration = result.generation;
      clearLocalCache();
    }
    state.clearedAt = Math.max(state.clearedAt, result.clearedAt || 0);
    if (requestedRevision === state.storageRevision) {
      state.activeRuns = result.runs;
      state.persistError = result.status.error || '';
      state.storageCapacityReached = result.status.code === 'storage_capacity';
    }
    // A read may have started before a new observation or another storage event.
    // Clears advance the generation; within one generation records only merge.
    const reconciled = core.reconcileUserCaches(Object.fromEntries(state.cache), result.cache);
    mergeExternalCache(reconciled.cache);
  }

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(SETTINGS_KEY, result => {
        const stored = result && result[SETTINGS_KEY];
        state.settings = core.normalizeDisplaySettings(stored);
        if (stored && typeof stored === "object" && Object.prototype.hasOwnProperty.call(stored, "silentMode")) {
          chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
        }
        resolve();
      });
    });
  }

  function loadLanguagePreference() {
    return new Promise(resolve => {
      chrome.storage.local.get(LANGUAGE_KEY, result => {
        state.languagePreference = i18n && i18n.normalizeLanguage
          ? i18n.normalizeLanguage(result && result[LANGUAGE_KEY]) || null
          : null;
        resolve();
      });
    });
  }

  function schedulePersist() {
    clearTimeout(state.pendingSaveTimer);
    state.pendingSaveTimer = setTimeout(persistCacheNow, 600);
  }

  function persistCacheNow() {
    clearTimeout(state.pendingSaveTimer);
    state.pendingSaveTimer = 0;
    state.persistRequested = true;
    if (state.persistInFlight) {
      return state.persistInFlight;
    }
    state.persistInFlight = (async () => {
      while (state.persistRequested) {
        state.persistRequested = false;
        await persistCacheSnapshot();
      }
    })()
      .catch(recordPersistError)
      .finally(() => {
        state.persistInFlight = null;
        if (state.persistRequested) {
          persistCacheNow();
        }
      });
    return state.persistInFlight;
  }

  function recordPersistError(error) {
    if (error.cacheGeneration !== undefined && error.cacheGeneration !== state.cacheGeneration) return;
    state.persistError = error && error.message ? error.message : 'storage_write_failed';
  }

  async function persistCacheSnapshot() {
    const pending = new Map(state.dirtyUsers);
    if (!pending.size) return;
    const generation = state.cacheGeneration;
    try {
      const result = await storage.request('merge', { generation, users: [...pending.values()] });
      if (generation !== state.cacheGeneration) return;
      state.persistError = "";
      for (const [username, record] of pending) {
        if (state.dirtyUsers.get(username) === record) {
          state.dirtyUsers.delete(username);
          if (result.rejectedUsernames?.includes(username)) {
            state.cache.delete(username);
            document.querySelectorAll('.xfs-stats-pill').forEach(pill => { if (pill.dataset.xfsUsername === username) removePillElement(pill); });
          }
        }
      }
    } catch (error) {
      if (generation !== state.cacheGeneration) return;
      if (error.code === 'storage_capacity' || /QUOTA_BYTES/i.test(error.message)) state.storageCapacityReached = true;
      if (error.code === 'stale_generation') await loadCache();
      error.cacheGeneration = generation;
      throw error;
    }
  }

  function getStatus() {
    return {
      cachedUsers: state.cache.size,
      queued: state.hoverQueue.length,
      fromApi: state.statsFromApi,
      fromHover: state.statsFromHover,
      hoverDiagnostics: state.hoverDiagnostics.slice(-50),
      persistError: state.persistError,
      runningSeconds: Math.round((Date.now() - state.startedAt) / 1000),
      settings: state.settings,
      visibleCells: isPageAllowed() ? findStatsSurfaces().length : 0
    };
  }

  function surfaceFromElement(element) {
    return core.classifyStatsSurface({
      isTweet: Boolean(element && element.matches && element.matches('article[data-testid="tweet"]')),
      isUserCell: Boolean(element && element.matches && element.matches('[data-testid="UserCell"]'))
    });
  }

  function isSurfaceEnabled(surface) {
    if (!isPageAllowed()) {
      return false;
    }
    if (surface === "feed") {
      return state.settings.feed;
    }
    return state.settings.userList;
  }

  function unregisterCell(cell) {
    state.intersectionObserver?.unobserve(cell);
    state.visibleCells.delete(cell);
    state.observedCells.delete(cell);
    delete cell.dataset.xfsUsername;
    delete cell.dataset.xfsSurface;
  }

  function removeDisabledPills() {
    if (!isPageAllowed()) {
      removeAllPills();
      return;
    }
    for (const cell of state.observedCells) if (!isSurfaceEnabled(surfaceFromElement(cell))) unregisterCell(cell);
    document.querySelectorAll(".xfs-stats-pill").forEach(pill => {
      if (!isSurfaceEnabled(pill.dataset.xfsSurface || "userList")) {
        removePillElement(pill);
      }
    });
  }

  function removeAllPills() {
    for (const cell of state.observedCells) unregisterCell(cell);
    document.querySelectorAll(".xfs-stats-pill").forEach(removePillElement);
  }

  function removePill(cell, username, surface) {
    const pill = cell ? findPill(cell, username, surface) : null;
    if (pill) {
      removePillElement(pill);
    }
  }

  function mergeExternalCache(rawCache) {
    if (!rawCache || typeof rawCache !== 'object' || Array.isArray(rawCache)) return;
    const previous = state.cache;
    state.cache = new Map(Object.entries(rawCache));
    for (const [username, record] of state.dirtyUsers) {
      state.cache.set(username, core.mergeCachedUserRecords(state.cache.get(username), record));
    }
    for (const [username, user] of state.cache) {
      if (core.canonicalStringify(previous.get(username)) !== core.canonicalStringify(user)) updateVisibleCells(username);
    }
  }

  function removeMismatchedPills(cell, username, surface) {
    if (!cell) {
      return;
    }
    cell.querySelectorAll(`.xfs-stats-pill[data-xfs-surface="${surface}"]`).forEach(pill => {
      if (core.normalizeUsername(pill.dataset.xfsUsername) !== username) {
        removePillElement(pill);
      }
    });
  }

  function removePillElement(pill) {
    if (!pill?.classList.contains("xfs-stats-pill")) {
      return;
    }
    const anchor = pill.closest && pill.closest(".xfs-userlist-anchor");
    pill.remove();
    if (anchor && !anchor.querySelector(".xfs-stats-pill")) {
      anchor.remove();
    }
  }

  function isPageAllowed() {
    return core.isStatsAllowedPath(location.pathname);
  }

  function toFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replace(/,/g, ""));
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function t(key, ...substitutions) {
    if (i18n && i18n.getMessage) {
      return i18n.getMessage(key, substitutions.map(value => String(value)), state.languagePreference);
    }
    const message = chrome.i18n && chrome.i18n.getMessage
      ? chrome.i18n.getMessage(key, substitutions.map(value => String(value)))
      : "";
    return message || FALLBACK_MESSAGES[key] || key;
  }
})();
