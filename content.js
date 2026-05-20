(function installXFollowStatsContentScript() {
  "use strict";

  if (window.__xFollowStatsContentCleanup) {
    window.__xFollowStatsContentCleanup();
  }

  const core = globalThis.XFollowStatsCore;
  const i18n = globalThis.XFSI18n;
  const SOURCE = core.SOURCE;
  const STORAGE_KEY = "xfs:userStatsCacheV2";
  const SETTINGS_KEY = "xfs:displaySettingsV1";
  const LANGUAGE_KEY = i18n ? i18n.LANGUAGE_KEY : "xfs:languagePreferenceV1";
  const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const SCAN_DEBOUNCE_MS = 180;
  const HOVER_DELAY_MS = 850;
  const HOVER_TIMEOUT_MS = 3200;
  const AUTO_HOVER_RETRY_MS = 15 * 1000;
  const FALLBACK_MESSAGES = {
    followersLabel: "Followers",
    followingLabel: "Following",
    listSeparator: ", ",
    pillHoverInterruptedTitle: "Hover card reading was interrupted by the page. The extension will keep retrying.",
    pillHoverMissingTitle: "No hover card was read this time. The extension will keep retrying.",
    pillHoverReadingTitle: "Reading avatar hover card.",
    pillLoadingFullTitle: "Getting counts from X page data and avatar hover cards.",
    pillLoadingShortTitle: "Reading counts.",
    pillReading: "Reading",
    pillStatsText: "$1 Following · $2 Followers",
    pillWaitingData: "Waiting",
    sourceFeed: "Feed",
    sourcePrefix: "Source: ",
    sourceUserList: "User lists"
  };

  const state = {
    cache: new Map(),
    cleanupCallbacks: [],
    hoverAttempts: new Map(),
    hoverQueue: [],
    hoverRetryTimers: new Map(),
    hovering: false,
    intersectionObserver: null,
    languagePreference: null,
    mutationObserver: null,
    pendingSaveTimer: 0,
    scanTimer: 0,
    settings: core.normalizeDisplaySettings(),
    startedAt: Date.now(),
    statsFromApi: 0,
    statsFromHover: 0
  };

  addEventListener("message", onPageMessage);
  state.cleanupCallbacks.push(() => removeEventListener("message", onPageMessage));

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  state.cleanupCallbacks.push(() => chrome.runtime.onMessage.removeListener(onRuntimeMessage));

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
      scanStatsSurfaces({ forceHover: true });
      sendResponse({ ok: true, status: getStatus() });
      return false;
    }
    if (message.type === "xfs:status") {
      sendResponse({ ok: true, status: getStatus() });
      return false;
    }
    if (message.type === "xfs:updateProfileStats") {
      performProfileStatsUpdate(message.username)
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
      persistCacheNow();
      sendResponse({ ok: true, status: getStatus() });
      return false;
    }
    if (message.type === "xfs:updateSettings") {
      state.settings = core.normalizeDisplaySettings(message.settings);
      chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
      removeDisabledPills();
      scanStatsSurfaces({ forceHover: false });
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

  Promise.all([loadCache(), loadSettings(), loadLanguagePreference()]).then(() => {
    document.querySelectorAll(".xfs-stats-pill").forEach(pill => pill.remove());
    setupObservers();
    scheduleScan(0);
  });

  window.__xFollowStatsContentCleanup = cleanup;

  function cleanup() {
    clearTimeout(state.scanTimer);
    clearTimeout(state.pendingSaveTimer);
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
    }
    if (state.intersectionObserver) {
      state.intersectionObserver.disconnect();
    }
    for (const timer of state.hoverRetryTimers.values()) {
      clearTimeout(timer);
    }
    state.hoverRetryTimers.clear();
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
    if (event.data.type === "users") {
      if (!isPageAllowed()) {
        return;
      }
      storeUsers(event.data.users, "pageData");
    }
  }

  function setupObservers() {
    state.mutationObserver = new MutationObserver(() => scheduleScan(SCAN_DEBOUNCE_MS));
    observeDocument();

    const storageListener = changes => {
      if (changes[STORAGE_KEY]) {
        if (isEmptyCacheValue(changes[STORAGE_KEY].newValue)) {
          clearLocalCache();
        } else {
          syncLocalCache(changes[STORAGE_KEY].newValue);
        }
      }
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

    state.intersectionObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          const cell = entry.target;
          const surface = surfaceFromElement(cell);
          if (!isSurfaceEnabled(surface)) {
            continue;
          }
          const profile = readProfileFromCell(cell, surface);
          if (profile && shouldRecordUsername(profile.username) && !getFreshCachedStats(profile.username)) {
            queueHover(profile, cell, surface);
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
  }

  function observeDocument() {
    const root = document.body || document.documentElement;
    if (root && state.mutationObserver) {
      state.mutationObserver.observe(root, { childList: true, subtree: true });
      return;
    }
    setTimeout(observeDocument, 50);
  }

  function scheduleScan(delay) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => scanStatsSurfaces({ forceHover: false }), delay);
  }

  function clearLocalCache() {
    state.cache.clear();
    state.hoverAttempts.clear();
    state.hoverQueue.length = 0;
    for (const timer of state.hoverRetryTimers.values()) {
      clearTimeout(timer);
    }
    state.hoverRetryTimers.clear();
    removeAllPills();
  }

  function isEmptyCacheValue(value) {
    return !value || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
  }

  function scanStatsSurfaces(options) {
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
      queueHover(profile, cell, surface);
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

    storeObservedUser(profile, cell, surface);
    cell.dataset.xfsUsername = profile.username;
    cell.dataset.xfsSurface = surface;
    const cachedStats = getFreshCachedStats(profile.username);
    if (cachedStats) {
      renderStats(ensurePill(cell, profile, surface), cachedStats);
      return;
    }
    const pill = ensurePill(cell, profile, surface);
    pill.dataset.xfsState = "loading";
    pill.textContent = t("pillWaitingData");
    pill.title = t("pillLoadingFullTitle");

    if (state.intersectionObserver) {
      state.intersectionObserver.observe(cell);
    }
    queueHover(profile, cell, surface);
    if (options && options.forceHover) {
      queueHover(profile, cell, surface, { force: true });
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
      nameBlock.appendChild(pill);
    } else if (nameLink && nameLink.parentElement) {
      const anchor = ensureUserListPillAnchor(nameLink);
      anchor.appendChild(pill);
    } else if (nameBlock) {
      nameBlock.appendChild(pill);
    } else {
      cell.appendChild(pill);
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

  function renderStats(pill, stats) {
    const followingDisplay = stats.followingDisplay || core.formatCompactCount(stats.followingCount);
    const followersDisplay = stats.followersDisplay || core.formatCompactCount(stats.followersCount);
    if (!followingDisplay || !followersDisplay) {
      pill.remove();
      return;
    }
    pill.dataset.xfsState = "loaded";
    pill.textContent = t("pillStatsText", followingDisplay, followersDisplay);
    const locale = i18n && i18n.localeTag ? i18n.localeTag(state.languagePreference) : "en";
    const followingRaw = Number.isFinite(stats.followingCount) ? ` (${stats.followingCount.toLocaleString(locale)})` : "";
    const followersRaw = Number.isFinite(stats.followersCount) ? ` (${stats.followersCount.toLocaleString(locale)})` : "";
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
    mergeUserRecord(observedUser);
  }

  function getFreshCachedStats(username) {
    const stats = state.cache.get(username);
    if (!stats) {
      return null;
    }
    if (Date.now() - Number(stats.updatedAt || 0) > CACHE_TTL_MS) {
      state.cache.delete(username);
      return null;
    }
    if (!hasDisplayableStats(stats)) {
      return null;
    }
    return stats;
  }

  function hasDisplayableStats(stats) {
    if (!stats || typeof stats !== "object") {
      return false;
    }
    const followingDisplay = stats.followingDisplay || core.formatCompactCount(stats.followingCount);
    const followersDisplay = stats.followersDisplay || core.formatCompactCount(stats.followersCount);
    return Boolean(followingDisplay && followersDisplay);
  }

  function storeUsers(users, source) {
    if (!Array.isArray(users) || users.length === 0) {
      return;
    }
    let changed = false;
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
      mergeUserRecord({
        username,
        displayName: typeof user.displayName === "string" ? user.displayName : "",
        userId: typeof user.userId === "string" ? user.userId : "",
        profileUrl: `https://x.com/${username}`,
        avatarUrl: typeof user.avatarUrl === "string" ? user.avatarUrl : "",
        bio: typeof user.bio === "string" ? user.bio : "",
        website: typeof user.website === "string" ? user.website : "",
        verified: Boolean(user.verified),
        followingCount,
        followersCount,
        followingDisplay: followingDisplay || core.formatCompactCount(followingCount),
        followersDisplay: followersDisplay || core.formatCompactCount(followersCount),
        sources: [],
        updatedAt: Date.now()
      });
      changed = true;
      if (source === "pageData" || source === "api") {
        state.statsFromApi += 1;
      } else if (source === "hover") {
        state.statsFromHover += 1;
      }
      clearHoverRetry(username);
      persistCacheNow();
      updateVisibleCells(username);
    }

    if (changed) {
      schedulePersist();
    }
  }

  function mergeUserRecord(user) {
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
    schedulePersist();
    return merged;
  }

  function shouldRecordUsername(username) {
    const normalizedUsername = core.normalizeUsername(username);
    return Boolean(normalizedUsername && (!state.settings.updateOnlyExisting || state.cache.has(normalizedUsername)));
  }

  function updateVisibleCells(username) {
    const stats = getFreshCachedStats(username);
    if (!stats) {
      return;
    }
    document.querySelectorAll(`[data-xfs-username="${cssEscape(username)}"]`).forEach(element => {
      const cell = element.matches('[data-testid="UserCell"], [data-testid="cellInnerDiv"]')
        ? element
        : element.closest('article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="cellInnerDiv"]');
      if (!cell) {
        return;
      }
      const surface = element.dataset.xfsSurface || surfaceFromElement(cell);
      if (!isSurfaceEnabled(surface)) {
        element.remove();
        return;
      }
      const profile = readProfileFromCell(cell, surface);
      if (!profile) {
        return;
      }
      renderStats(ensurePill(cell, profile, surface), stats);
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
    if (!profile || !cell || document.hidden || !isSurfaceEnabled(surface)) {
      return;
    }
    if (!shouldQueueHover(profile.username, Boolean(options?.force))) {
      return;
    }
    state.hoverQueue.push({ profile, cell, surface });
    runHoverQueue();
  }

  function shouldQueueHover(username, force) {
    if (force) {
      return true;
    }
    const now = Date.now();
    pruneHoverAttempts(now);
    const lastAttemptAt = state.hoverAttempts.get(username);
    if (lastAttemptAt && now - lastAttemptAt < AUTO_HOVER_RETRY_MS) {
      return false;
    }
    state.hoverAttempts.set(username, now);
    return true;
  }

  function pruneHoverAttempts(now) {
    for (const [username, attemptedAt] of state.hoverAttempts.entries()) {
      if (now - attemptedAt >= AUTO_HOVER_RETRY_MS) {
        state.hoverAttempts.delete(username);
      }
    }
  }

  async function runHoverQueue() {
    if (state.hovering) {
      return;
    }
    state.hovering = true;
    try {
      while (state.hoverQueue.length > 0) {
        const item = state.hoverQueue.shift();
        if (
          !item ||
          !isSurfaceEnabled(item.surface) ||
          getFreshCachedStats(item.profile.username) ||
          !document.contains(item.cell)
        ) {
          continue;
        }
        await hydrateFromHover(item.profile, item.cell, item.surface);
      }
    } finally {
      state.hovering = false;
    }
  }

  async function hydrateFromHover(profile, cell, surface) {
    let target = null;
    const pill = findPill(cell, profile.username, surface) || ensurePill(cell, profile, surface);
    try {
      pill.dataset.xfsState = "loading";
      pill.textContent = t("pillReading");
      pill.title = t("pillHoverReadingTitle");
      target = profile.avatarOrNameLink || profile.nameLink;
      triggerHover(target);
      await delay(HOVER_DELAY_MS);
      const parsed = await waitForHoverStats(profile.username);

      if (!parsed) {
        pill.dataset.xfsState = "loading";
        pill.textContent = t("pillWaitingData");
        pill.title = t("pillHoverMissingTitle");
        scheduleHoverRetry(profile, cell, surface);
        return;
      }

      storeUsers(
        [
          {
            username: profile.username,
            followingDisplay: parsed.followingDisplay,
            followersDisplay: parsed.followersDisplay
          }
        ],
        "hover"
      );
    } catch {
      pill.dataset.xfsState = "loading";
      pill.textContent = t("pillWaitingData");
      pill.title = t("pillHoverInterruptedTitle");
      scheduleHoverRetry(profile, cell, surface);
    } finally {
      releaseHover(target);
    }
  }

  function scheduleHoverRetry(profile, cell, surface) {
    const key = `${profile.username}:${surface}`;
    if (state.hoverRetryTimers.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      state.hoverRetryTimers.delete(key);
      if (
        document.hidden ||
        !document.contains(cell) ||
        getFreshCachedStats(profile.username) ||
        !isSurfaceEnabled(surface)
      ) {
        return;
      }
      queueHover(profile, cell, surface);
    }, AUTO_HOVER_RETRY_MS);
    state.hoverRetryTimers.set(key, timer);
  }

  function clearHoverRetry(username) {
    for (const [key, timer] of state.hoverRetryTimers.entries()) {
      if (key.startsWith(`${username}:`)) {
        clearTimeout(timer);
        state.hoverRetryTimers.delete(key);
      }
    }
  }

  function triggerHover(target) {
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
    if (typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
  }

  function releaseHover(target) {
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
  }

  async function waitForHoverStats(username) {
    const deadline = Date.now() + HOVER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const parsed = readHoverCardStats(username);
      if (parsed) {
        return parsed;
      }
      await delay(120);
    }
    return null;
  }

  function readHoverCardStats(username) {
    const candidates = new Set([
      ...document.querySelectorAll('[data-testid*="Hover"], [role="dialog"], div[style*="position"]')
    ]);
    for (const element of candidates) {
      if (!isVisible(element)) {
        continue;
      }
      const text = core.normalizeText(element.innerText || element.textContent || "");
      if (!text || !text.toLowerCase().includes(username)) {
        continue;
      }
      const parsed = core.parseStatsText(text);
      if (parsed) {
        return parsed;
      }
    }
    return null;
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

  async function performProfileStatsUpdate(rawUsername) {
    const username = core.normalizeUsername(rawUsername);
    if (!username) {
      return { ok: false, hasStats: false, error: "invalid_username" };
    }
    await waitForProfilePage(username, 8000);
    const existingStats = getFreshCachedStats(username);
    if (existingStats) {
      return profileUpdateResult(username, "cached");
    }

    const deadline = Date.now() + 18000;
    let attempts = 0;
    while (Date.now() < deadline) {
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
          "pageData"
        );
        return profileUpdateResult(username, "profile_header");
      }

      scanStatsSurfaces({ forceHover: true });
      await gentleProfileScroll(attempts);
      const stats = await waitForCachedStats(username, 2600);
      if (stats) {
        return profileUpdateResult(username, "surface_or_hover");
      }
      attempts += 1;
    }

    const finalStats = getFreshCachedStats(username);
    return {
      ok: true,
      hasStats: Boolean(finalStats),
      source: finalStats ? "late_cache" : "not_found"
    };
  }

  function profileUpdateResult(username, source) {
    const stats = getFreshCachedStats(username);
    return {
      ok: true,
      hasStats: Boolean(stats),
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

  async function waitForCachedStats(username, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const stats = getFreshCachedStats(username);
      if (stats) {
        return stats;
      }
      await delay(160);
    }
    return null;
  }

  function readCurrentProfileStats(username) {
    if (core.usernameFromProfileHref(location.href, location.origin) !== username) {
      return null;
    }
    for (const element of collectProfileStatsCandidates(username)) {
      if (!element || !isVisible(element)) {
        continue;
      }
      const text = core.normalizeText(element.innerText || element.textContent || "");
      const parsed = core.parseStatsText(text);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  function collectProfileStatsCandidates(username) {
    const candidates = [];
    const seen = new Set();
    const main = document.querySelector("main") || document.body;

    function add(element) {
      if (!element || seen.has(element)) {
        return;
      }
      seen.add(element);
      candidates.push(element);
    }

    if (!main) {
      return candidates;
    }

    main.querySelectorAll("a[href]").forEach(anchor => {
      if (!isProfileStatsLink(anchor, username)) {
        return;
      }
      let current = anchor;
      for (let depth = 0; depth < 5 && current; depth += 1) {
        add(current);
        current = current.parentElement;
      }
    });
    add(main.querySelector('[data-testid="UserProfileHeader_Items"]'));
    add(main.querySelector('[data-testid="UserDescription"]')?.parentElement);
    add(main);
    return candidates;
  }

  function isProfileStatsLink(anchor, username) {
    try {
      const url = new URL(anchor.href || anchor.getAttribute("href"), location.origin);
      const normalizedPath = url.pathname.replace(/\/+$/, "");
      const escapedUsername = username.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      return new RegExp(`^/${escapedUsername}/(following|verified_followers|followers)$`, "i").test(normalizedPath);
    } catch {
      return false;
    }
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

  function loadCache() {
    return new Promise(resolve => {
      chrome.storage.local.get(STORAGE_KEY, result => {
        syncLocalCache(result && result[STORAGE_KEY]);
        resolve();
      });
    });
  }

  function syncLocalCache(rawCache) {
    if (!rawCache || typeof rawCache !== "object" || Array.isArray(rawCache)) {
      return;
    }
    state.cache.clear();
    for (const [username, stats] of Object.entries(rawCache)) {
      if (core.normalizeUsername(username) && stats && typeof stats === "object") {
        state.cache.set(username, stats);
      }
    }
  }

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(SETTINGS_KEY, result => {
        state.settings = core.normalizeDisplaySettings(result && result[SETTINGS_KEY]);
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
    const rawCache = {};
    for (const [username, stats] of state.cache.entries()) {
      rawCache[username] = stats;
    }
    chrome.storage.local.set({ [STORAGE_KEY]: rawCache });
  }

  function getStatus() {
    return {
      cachedUsers: state.cache.size,
      queued: state.hoverQueue.length,
      fromApi: state.statsFromApi,
      fromHover: state.statsFromHover,
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

  function removeDisabledPills() {
    if (!isPageAllowed()) {
      removeAllPills();
      return;
    }
    document.querySelectorAll(".xfs-stats-pill").forEach(pill => {
      if (!isSurfaceEnabled(pill.dataset.xfsSurface || "userList")) {
        pill.remove();
      }
    });
  }

  function removeAllPills() {
    document.querySelectorAll(".xfs-stats-pill").forEach(pill => pill.remove());
  }

  function removePill(cell, username, surface) {
    const pill = cell ? findPill(cell, username, surface) : null;
    if (pill) {
      pill.remove();
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
