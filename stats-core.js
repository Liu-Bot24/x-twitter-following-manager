(function installXFollowStatsCore(global) {
  "use strict";

  const SOURCE = "x-follow-stats-extension";
  const PROFILE_METADATA_FIELDS = ["bio", "website", "verified"];
  const MAX_GRAPH_DEPTH = 18;
  const MAX_GRAPH_NODES = 12000;
  const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
  const BLOCKED_STATS_PATH_PREFIXES = ["/notifications"];
  const PROFILE_PATH_RE = /^\/([A-Za-z0-9_]{1,15})(?:\/)?$/;
  const RESERVED_PATHS = new Set([
    "compose",
    "explore",
    "hashtag",
    "home",
    "i",
    "jobs",
    "messages",
    "notifications",
    "search",
    "settings"
  ]);
  const FOLLOWING_LABELS = [
    "正在关注",
    "关注中",
    "Following",
    "フォロー中",
    "팔로우 중",
    "Siguiendo",
    "Abonnements"
  ];
  const FOLLOWERS_LABELS = [
    "关注者",
    "粉丝",
    "Followers",
    "フォロワー",
    "팔로워",
    "Seguidores",
    "Abonnes",
    "Abonnés"
  ];
  const EXPORT_FIELDS = [
    "display_name",
    "username",
    "user_id",
    "profile_url",
    "following_count",
    "followers_count",
    "sources",
    "bio",
    "website",
    "first_seen_at",
    "last_seen_at",
    "latest_post_kind",
    "latest_post_text",
    "latest_post_url",
    "observed_posts_count",
    "following_display",
    "followers_display",
    "following_precision",
    "followers_precision",
    "stats_updated_at",
    "stats_source",
    "export_mode"
  ];

  function normalizeUsername(value) {
    if (typeof value !== "string") {
      return "";
    }
    const username = value.trim().replace(/^@/, "");
    return USERNAME_RE.test(username) ? username.toLowerCase() : "";
  }

  function normalizeDisplaySettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      feed: source.feed !== false,
      userList: source.userList !== false,
      updateOnlyExisting: source.updateOnlyExisting === true
    };
  }

  function shouldRunHoverFallback(context) {
    const state = context && typeof context === "object" ? context : {};
    if (state.documentHidden || state.inputFocused) {
      return false;
    }
    const idleForMs = Number(state.idleForMs || 0);
    const requiredIdleMs = Number(state.requiredIdleMs || 0);
    if (idleForMs < requiredIdleMs) {
      return false;
    }
    return Boolean(state.force || !state.alreadyAttempted);
  }

  function classifyStatsSurface(value) {
    if (value && value.isTweet) {
      return "feed";
    }
    return "userList";
  }

  function isStatsAllowedPath(pathname) {
    let path = typeof pathname === "string" ? pathname.trim() : "";
    if (!path) {
      return true;
    }
    try {
      if (/^https?:\/\//i.test(path)) {
        path = new URL(path).pathname;
      }
    } catch {
      return true;
    }
    path = path.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
    return !BLOCKED_STATS_PATH_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
  }

  function usernameFromProfileHref(href, baseUrl) {
    if (!href) {
      return "";
    }
    let url;
    try {
      url = new URL(href, baseUrl || "https://x.com/");
    } catch {
      return "";
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !/^(x\.com|twitter\.com)$/i.test(url.hostname)) {
      return "";
    }
    const match = url.pathname.match(PROFILE_PATH_RE);
    if (!match) {
      return "";
    }
    const username = normalizeUsername(match[1]);
    if (!username || RESERVED_PATHS.has(username)) {
      return "";
    }
    return username;
  }

  function findNameLinkInAnchors(anchors, username, baseUrl) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername || !anchors) {
      return null;
    }
    const handleText = `@${normalizedUsername}`;
    const matchingHandleLinks = [];
    for (const anchor of Array.from(anchors)) {
      const href = anchor && (anchor.href || (typeof anchor.getAttribute === "function" ? anchor.getAttribute("href") : ""));
      if (usernameFromProfileHref(href, baseUrl) !== normalizedUsername) {
        continue;
      }
      const text = normalizeText(anchor.textContent || "");
      if (text && !text.startsWith("@")) {
        return anchor;
      }
      if (text.toLowerCase() === handleText) {
        matchingHandleLinks.push(anchor);
      }
    }
    return matchingHandleLinks.length > 1 ? matchingHandleLinks[0] : null;
  }

  function toFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value.replace(/,/g, ""));
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function firstFiniteNumber() {
    for (const value of arguments) {
      const parsed = toFiniteNumber(value);
      if (parsed !== null) {
        return parsed;
      }
    }
    return null;
  }

  const countFormatters = new Map();
  function formatCompactCount(count, locale) {
    const numeric = toFiniteNumber(count);
    if (numeric === null) {
      return "";
    }
    try {
      const language = locale || "zh-CN";
      const digits = numeric >= 10000 ? 1 : 0;
      const key = language + ':' + digits;
      if (!countFormatters.has(key)) countFormatters.set(key, new Intl.NumberFormat(language, { maximumFractionDigits: digits, notation: 'compact' }));
      return countFormatters.get(key).format(numeric);
    } catch {
      return String(numeric);
    }
  }

  function formatStatsCount(user, field, locale) {
    const { count, display, precision } = normalizeStatsField(user, field);
    if (precision === 'approximate') return display || formatCompactCount(count, locale);
    return count !== null ? formatCompactCount(count, locale) : '';
  }

  function profileUrlForUsername(username) {
    const normalizedUsername = normalizeUsername(username);
    return normalizedUsername ? `https://x.com/${normalizedUsername}` : "";
  }

  function profileUrlForUser(user) {
    const username = normalizeUsername(user?.username);
    if (username && usernameFromProfileHref(user?.profileUrl) === username) {
      return new URL(user.profileUrl, 'https://x.com/').href;
    }
    return profileUrlForUsername(username);
  }

  function safePostUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !/^(x\.com|twitter\.com)$/i.test(url.hostname)
        || !/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/\d+\/?$/.test(url.pathname)) return '';
      return `https://x.com${url.pathname}`;
    } catch { return ''; }
  }

  function normalizeSource(value) {
    const source = typeof value === "string" ? value.trim() : "";
    if (source === "api") {
      return "pageData";
    }
    return source;
  }

  function normalizePostSource(value) {
    const source = normalizeSource(value);
    return source === "feed" || source === "import" ? source : "";
  }

  function compactUniqueList(values) {
    const result = [];
    for (const value of values || []) {
      const normalizedValue = normalizeSource(value);
      if (!normalizedValue || result.includes(normalizedValue)) {
        continue;
      }
      result.push(normalizedValue);
    }
    return result;
  }

  function userSurfaceSources(user) {
    const sources = compactUniqueList(user && user.sources);
    const posts = normalizedObservedPosts(user);
    const result = [];
    if (sources.includes("userList")) {
      result.push("userList");
    }
    if (sources.includes("feed") && (posts.length === 0 || posts.some(post => post.kind !== "comment"))) {
      result.push("feed");
    }
    if (sources.includes("import") && result.length === 0) {
      result.push("import");
    }
    return result;
  }

  function preferString(next, current) {
    return typeof next === "string" && next.trim() ? next.trim() : current || "";
  }

  function normalizeObservedPost(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const text = typeof value.text === "string" ? normalizeText(value.text) : "";
    const url = safePostUrl(value.url);
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const kind = normalizePostKind(value.kind || value.postKind || value.type);
    const source = normalizePostSource(value.source || value.origin || value.surface);
    if (!text && !url && !id) {
      return null;
    }
    return {
      id,
      url,
      text,
      kind,
      source,
      capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : ""
    };
  }

  function normalizePostKind(value) {
    const kind = typeof value === "string" ? value.trim() : "";
    if (kind === "comment" || kind === "retweet" || kind === "original" || kind === "unknown") {
      return kind;
    }
    return "original";
  }

  function mergeObservedPosts(currentPosts, incomingPosts) {
    const postsByKey = new Map();
    for (const post of [...(currentPosts || []), ...(incomingPosts || [])]) {
      const normalizedPost = normalizeObservedPost(post);
      if (!normalizedPost) {
        continue;
      }
      const key = normalizedPost.id || normalizedPost.url || normalizedPost.text;
      const existing = postsByKey.get(key);
      if (!existing) {
        postsByKey.set(key, normalizedPost);
        continue;
      }
      const existingTimestamp = Date.parse(existing.capturedAt || "") || 0;
      const nextTimestamp = Date.parse(normalizedPost.capturedAt || "") || 0;
      if (
        nextTimestamp > existingTimestamp
        || (nextTimestamp === existingTimestamp && canonicalStringify(normalizedPost) > canonicalStringify(existing))
      ) {
        postsByKey.set(key, normalizedPost);
      }
    }
    return Array.from(postsByKey.values())
      .sort((left, right) => {
        const timeDifference = (Date.parse(right.capturedAt || "") || 0) - (Date.parse(left.capturedAt || "") || 0);
        if (timeDifference) {
          return timeDifference;
        }
        const leftKey = left.id || left.url || left.text;
        const rightKey = right.id || right.url || right.text;
        return leftKey.localeCompare(rightKey);
      })
      .slice(0, 20);
  }

  function canonicalStringify(value) {
    const seen = new WeakSet();
    function normalize(item) {
      if (!item || typeof item !== "object") {
        return item;
      }
      if (seen.has(item)) {
        throw new TypeError("Cannot canonicalize circular data");
      }
      seen.add(item);
      if (Array.isArray(item)) {
        const result = item.map(normalize);
        seen.delete(item);
        return result;
      }
      const result = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        if (typeof item[key] !== "undefined") {
          result[key] = normalize(item[key]);
        }
      }
      seen.delete(item);
      return result;
    }
    return JSON.stringify(normalize(value));
  }

  function metadataTimestamp(record, field) {
    const valid = Object.hasOwn(record, field) && (field === "verified"
      ? typeof record[field] === "boolean" : typeof record[field] === "string");
    if (!valid) return 0;
    if (Object.hasOwn(record, "metadataUpdatedAt")) {
      const timestamp = Number(record.metadataUpdatedAt?.[field]);
      return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
    }
    // Legacy empty/false values may have been synthesized by a DOM-only record.
    // Retain meaningful legacy values; only new observations can assert a clear.
    return record[field] ? cacheRecordTimestamp(record) || 1 : 0;
  }

  function mergeProfileMetadata(existing, next, observedAt) {
    const result = { metadataUpdatedAt: {} };
    const isObservation = observedAt !== undefined && !Object.hasOwn(next, "metadataUpdatedAt");
    for (const field of PROFILE_METADATA_FIELDS) {
      const supplied = Object.hasOwn(next, field) && (field === "verified"
        ? typeof next[field] === "boolean" : typeof next[field] === "string");
      const previousTime = metadataTimestamp(existing, field);
      const nextTime = isObservation && supplied ? observedAt : metadataTimestamp(next, field);
      if (!previousTime && !nextTime) continue;
      const nextWins = nextTime > previousTime || (nextTime === previousTime
        && (isObservation || canonicalStringify(next[field]) > canonicalStringify(existing[field])));
      result[field] = nextWins ? next[field] : existing[field];
      result.metadataUpdatedAt[field] = Math.max(previousTime, nextTime);
    }
    return result;
  }

  function validTime(value) {
    const time = typeof value === 'number' || /^\d{10,16}$/.test(value || '') ? Number(value) : Date.parse(value || '');
    return Number.isFinite(time) && time > 0 && time <= 8640000000000000 ? time : 0;
  }

  function rangeDate(values, choose, fallback = '') {
    const times = values.map(validTime).filter(Boolean);
    return times.length ? new Date(choose(...times)).toISOString() : fallback;
  }

  function normalizeCapture(value) {
    if (!value || typeof value.documentId !== 'string' || !value.documentId
      || !Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !Number.isSafeInteger(value.generation) || !validTime(value.startedAt)) return null;
    return { documentId: value.documentId, sequence: value.sequence, generation: value.generation, startedAt: value.startedAt };
  }

  function compareCapture(left, right) {
    const a = normalizeCapture(left), b = normalizeCapture(right);
    return a && b && a.documentId === b.documentId && a.generation === b.generation
      ? Math.sign(a.sequence - b.sequence) : 0;
  }

  function compareStatsSnapshots(left, right) {
    const captured = compareCapture(left?.statsCapture, right?.statsCapture);
    if (captured) return captured;
    const time = statsRecordTimestamp(left) - statsRecordTimestamp(right);
    if (time) return Math.sign(time);
    const quality = user => ['following', 'followers'].reduce((sum, field) => sum + ({ missing: 0, approximate: 1, exact: 2 }[normalizeStatsField(user, field).precision]), hasCompleteStatsRecord(user) ? 4 : 0);
    const difference = quality(left) - quality(right);
    if (difference) return Math.sign(difference);
    // A deterministic tie-breaker only; count magnitude is never a freshness rule.
    const key = user => canonicalStringify({ ...normalizedStats(user), source: user?.statsSource || '', capture: normalizeCapture(user?.statsCapture) });
    return key(left).localeCompare(key(right));
  }

  function identityTimestamp(record) {
    return record?.userId ? validTime(record.identityUpdatedAt) || cacheRecordTimestamp(record) : 0;
  }

  function compareIdentity(left, right) {
    return compareCapture(left?.identityCapture, right?.identityCapture)
      || Math.sign(identityTimestamp(left) - identityTimestamp(right))
      || canonicalStringify([left?.userId, left?.username]).localeCompare(canonicalStringify([right?.userId, right?.username]));
  }

  function conflictingIdentity(left, right) {
    return Boolean(left?.userId && right?.userId && left.userId !== right.userId);
  }

  function identityHistory(records, activeId) {
    const byId = new Map();
    for (const record of records) {
      if (!record?.userId || record.userId === activeId) continue;
      const { identityHistory: nested, ...plain } = record;
      const previous = byId.get(plain.userId);
      byId.set(plain.userId, previous
        ? { ...previous, ...plain, ...mergeCachedUserRecords(previous, plain) } : plain);
    }
    return [...byId.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  }

  function attachIdentityHistory(result, records) {
    const history = identityHistory(records, result.userId);
    if (history.length) result.identityHistory = history;
    return result;
  }

  function mergeIdentityConflict(existing, next) {
    const winner = compareIdentity(next, existing) > 0 ? next : existing;
    const loser = winner === next ? existing : next;
    const history = [...(existing.identityHistory || []), ...(next.identityHistory || []), loser];
    let { identityHistory: ignored, ...result } = winner;
    // A previously archived stable identity can reclaim a handle. Restore only
    // its own history, never the intervening owner's data.
    for (const archived of history) {
      if (archived.userId !== winner.userId) continue;
      const { identityHistory: nested, ...plain } = archived;
      result = { ...plain, ...result, ...mergeCachedUserRecords(plain, result) };
    }
    return attachIdentityHistory(result, history);
  }

  function mergeObservedUser(current, incoming, now) {
    const normalizedUsername = normalizeUsername(incoming?.username || current?.username);
    if (!normalizedUsername) return current || null;
    const timestamp = new Date(validTime(now) || Date.now()).toISOString();
    const observedAt = Date.parse(timestamp);
    const existing = current && typeof current === 'object' ? current : {};
    const next = incoming && typeof incoming === 'object' ? incoming : {};
    if (conflictingIdentity(existing, next)) return mergeIdentityConflict(existing, mergeObservedUser(null, next, timestamp));
    const incomingHasStats = hasAnyStatsRecord(next);
    const statsUpdatedAt = incomingHasStats ? statsRecordTimestamp(next) || observedAt : 0;
    const incomingSnapshot = { ...next, statsUpdatedAt };
    const snapshot = incomingHasStats && (!hasAnyStatsRecord(existing) || compareStatsSnapshots(incomingSnapshot, existing) >= 0)
      ? incomingSnapshot : existing;
    const incomingPosts = [...(Array.isArray(next.observedPosts) ? next.observedPosts : []), next.observedPost]
      .filter(Boolean).map(post => post.capturedAt ? post : { ...post, capturedAt: timestamp });
    const nextIdentity = next.userId ? {
      ...next, identityUpdatedAt: validTime(next.identityUpdatedAt) || validTime(next.statsCapture?.startedAt) || observedAt,
      identityCapture: normalizeCapture(next.identityCapture || next.statsCapture)
    } : existing;
    const identity = !existing.userId || compareIdentity(nextIdentity, existing) >= 0 ? nextIdentity : existing;
    const result = {
      username: normalizedUsername,
      userId: preferString(next.userId, existing.userId),
      identityUpdatedAt: identityTimestamp(identity),
      identityCapture: normalizeCapture(identity.identityCapture),
      displayName: preferString(next.displayName, existing.displayName),
      profileUrl: profileUrlForUser({ username: normalizedUsername, profileUrl: next.profileUrl || existing.profileUrl }),
      avatarUrl: preferString(next.avatarUrl, existing.avatarUrl),
      ...mergeProfileMetadata(existing, next, validTime(next.statsCapture?.startedAt) || observedAt),
      ...normalizedStats(snapshot),
      sources: compactUniqueList([...(existing.sources || []), ...(next.sources || [])]),
      firstSeenAt: rangeDate([existing.firstSeenAt, next.firstSeenAt || timestamp], Math.min, timestamp),
      lastSeenAt: rangeDate([existing.lastSeenAt, next.lastSeenAt || timestamp], Math.max, timestamp),
      updatedAt: Math.max(validTime(existing.updatedAt), observedAt),
      statsUpdatedAt: statsRecordTimestamp(snapshot),
      statsSource: snapshot.statsSource || '',
      statsCapture: normalizeCapture(snapshot.statsCapture),
      statsReceivedAt: validTime(snapshot.statsReceivedAt) || statsRecordTimestamp(snapshot),
      observedPosts: mergeObservedPosts(existing.observedPosts, incomingPosts)
    };
    return attachIdentityHistory(result, [...(existing.identityHistory || []), ...(next.identityHistory || [])]);
  }

  function statsRecordTimestamp(user) {
    if (!hasAnyStatsRecord(user)) return 0;
    const explicitTimestamp = validTime(user?.statsUpdatedAt);
    if (explicitTimestamp) {
      return explicitTimestamp;
    }
    return hasCompleteStatsRecord(user) ? validTime(user?.updatedAt) : 0;
  }

  function hasAnyStatsRecord(user) {
    return ['following', 'followers'].some(field => normalizeStatsField(user, field).precision !== 'missing');
  }

  function cacheRecordTimestamp(user) {
    return Math.max(
      validTime(user?.updatedAt),
      statsRecordTimestamp(user),
      Date.parse(user && user.lastSeenAt ? user.lastSeenAt : "") || 0
    );
  }

  function hasCompleteStatsRecord(user) {
    return ['following', 'followers'].every(field => normalizeStatsField(user, field).precision !== 'missing');
  }

  function isCachedStatsFresh(stats, options) {
    if (!hasCompleteStatsRecord(stats)) {
      return false;
    }
    const settings = options && typeof options === "object" ? options : {};
    const now = Number.isFinite(settings.now) ? settings.now : Date.now();
    const ttlMs = Number.isFinite(settings.ttlMs) ? settings.ttlMs : Infinity;
    const minStatsUpdatedAt = Number(settings.minStatsUpdatedAt || 0);
    const statsUpdatedAt = statsRecordTimestamp(stats);
    return Boolean(
      statsUpdatedAt
      && now - statsUpdatedAt <= ttlMs
      && statsUpdatedAt >= minStatsUpdatedAt
    );
  }

  function mergeCachedUserRecords(current, incoming) {
    const existing = current && typeof current === 'object' ? current : null;
    const next = incoming && typeof incoming === 'object' ? incoming : null;
    if (!existing || !next) {
      const record = existing || next;
      return record ? mergeObservedUser(null, record, record.lastSeenAt || new Date(cacheRecordTimestamp(record) || 1).toISOString()) : null;
    }
    const existingUsername = normalizeUsername(existing.username), nextUsername = normalizeUsername(next.username);
    if (!existingUsername || !nextUsername || (existingUsername !== nextUsername && (!existing.userId || existing.userId !== next.userId))) return null;
    if (conflictingIdentity(existing, next)) return mergeIdentityConflict(existing, next);
    const existingTimestamp = cacheRecordTimestamp(existing), nextTimestamp = cacheRecordTimestamp(next);
    const newer = nextTimestamp > existingTimestamp || (nextTimestamp === existingTimestamp && canonicalStringify(next) > canonicalStringify(existing)) ? next : existing;
    const older = newer === next ? existing : next;
    const lastSeenAt = rangeDate([existing.lastSeenAt, next.lastSeenAt], Math.max);
    const merged = mergeObservedUser(older, newer, lastSeenAt || new Date(Math.max(existingTimestamp, nextTimestamp, 1)).toISOString());
    for (const field of PROFILE_METADATA_FIELDS) delete merged[field];
    Object.assign(merged, mergeProfileMetadata(existing, next));
    const statsWinner = hasAnyStatsRecord(next) && (!hasAnyStatsRecord(existing) || compareStatsSnapshots(next, existing) > 0) ? next : existing;
    Object.assign(merged, normalizedStats(statsWinner), {
      statsUpdatedAt: statsRecordTimestamp(statsWinner), statsSource: statsWinner.statsSource || '',
      statsCapture: normalizeCapture(statsWinner.statsCapture),
      statsReceivedAt: validTime(statsWinner.statsReceivedAt) || statsRecordTimestamp(statsWinner),
      updatedAt: Math.max(existingTimestamp, nextTimestamp),
      sources: compactUniqueList([...(existing.sources || []), ...(next.sources || [])]).sort(),
      firstSeenAt: rangeDate([existing.firstSeenAt, next.firstSeenAt], Math.min, merged.firstSeenAt)
    });
    if (lastSeenAt) merged.lastSeenAt = lastSeenAt;
    else delete merged.lastSeenAt;
    const identity = compareIdentity(next, existing) > 0 ? next : existing;
    if (identity.userId) {
      merged.username = identity.username;
      merged.profileUrl = profileUrlForUser(identity);
      merged.identityUpdatedAt = identityTimestamp(identity);
      merged.identityCapture = normalizeCapture(identity.identityCapture);
    }
    return merged;
  }

  function mergeImportedUser(current, record, now = new Date().toISOString()) {
    const observedAt = rangeDate([record.lastSeenAt, record.firstSeenAt], Math.max, now);
    const imported = mergeObservedUser(null, record, observedAt);
    imported.sources = compactUniqueList([...(imported.sources || []), 'import']);
    const merged = mergeCachedUserRecords(current, imported);
    merged.updatedAt = Math.max(cacheRecordTimestamp(merged), validTime(now));
    return merged;
  }

  function reconcileUserCaches(currentCache, incomingCache) {
    const current = currentCache && typeof currentCache === "object" && !Array.isArray(currentCache)
      ? currentCache
      : {};
    const incoming = incomingCache && typeof incomingCache === "object" && !Array.isArray(incomingCache)
      ? incomingCache
      : {};
    const normalizedIncoming = Object.create(null);
    const reconciled = Object.create(null);

    for (const [rawUsername, user] of Object.entries(incoming)) {
      const username = normalizeUsername(rawUsername);
      if (!username || !user || typeof user !== "object") {
        continue;
      }
      const normalizedRecord = { ...user, username };
      normalizedIncoming[username] = mergeCachedUserRecords(normalizedRecord, normalizedRecord);
      reconciled[username] = normalizedIncoming[username];
    }
    for (const [rawUsername, user] of Object.entries(current)) {
      const username = normalizeUsername(rawUsername);
      if (!username || !user || typeof user !== "object") {
        continue;
      }
      const normalizedCurrent = { ...user, username };
      reconciled[username] = reconciled[username]
        ? mergeCachedUserRecords(normalizedCurrent, reconciled[username])
        : mergeCachedUserRecords(normalizedCurrent, normalizedCurrent);
    }

    const handlesById = new Map();
    for (const [username, record] of Object.entries(reconciled)) {
      if (!record?.userId) continue;
      const previousHandle = handlesById.get(record.userId);
      if (previousHandle) {
        const merged = mergeCachedUserRecords(reconciled[previousHandle], record);
        delete reconciled[previousHandle];
        delete reconciled[username];
        reconciled[merged.username] = merged;
        handlesById.set(record.userId, merged.username);
      } else handlesById.set(record.userId, username);
    }
    return {
      cache: reconciled,
      needsPersist: canonicalStringify(reconciled) !== canonicalStringify(normalizedIncoming)
    };
  }

  function latestObservedPost(user) {
    return user && Array.isArray(user.observedPosts) && user.observedPosts.length > 0 ? user.observedPosts[0] : null;
  }

  function normalizedObservedPosts(user) {
    if (!user || !Array.isArray(user.observedPosts)) {
      return [];
    }
    return user.observedPosts.map(normalizeObservedPost).filter(Boolean);
  }

  function userHasCommentSource(user) {
    return normalizedObservedPosts(user).some(post => post.kind === "comment");
  }

  function userHasNonCommentSource(user) {
    const sources = userSurfaceSources(user);
    if (sources.includes("userList") || sources.includes("import")) {
      return true;
    }
    const posts = normalizedObservedPosts(user);
    if (posts.some(post => post.kind !== "comment")) {
      return true;
    }
    return sources.includes("feed") && posts.length === 0;
  }

  function selectObservedPost(user, options) {
    const settings = options && typeof options === "object" ? options : {};
    const includeComments = settings.includeComments !== false;
    const preferComments = Boolean(settings.preferComments && includeComments);
    const posts = normalizedObservedPosts(user);
    if (posts.length === 0) {
      return null;
    }
    if (preferComments) {
      return posts.find(post => post.kind === "comment") || posts.find(post => post.kind !== "comment") || null;
    }
    return posts.find(post => post.kind !== "comment") || (includeComments ? posts.find(post => post.kind === "comment") || null : null);
  }

  function csvEscape(value) {
    if (value === null || value === undefined) {
      return "";
    }
    const text = String(value);
    if (!/[",\n\r]/.test(text)) {
      return text;
    }
    return `"${text.replace(/"/g, '""')}"`;
  }

  function userExportRow(user) {
    user = { ...user, ...normalizedStats(user) };
    const latestPost = selectObservedPost(user);
    return {
      display_name: user.displayName || "",
      username: user.username || "",
      user_id: user.userId || "",
      profile_url: profileUrlForUser(user),
      following_count: user.followingCount ?? "",
      followers_count: user.followersCount ?? "",
      sources: userSurfaceSources(user).join("|"),
      bio: user.bio || "",
      website: user.website || "",
      first_seen_at: user.firstSeenAt || "",
      last_seen_at: user.lastSeenAt || "",
      latest_post_kind: latestPost ? exportPostKind(latestPost.kind) : "",
      latest_post_text: latestPost ? latestPost.text || "" : "",
      latest_post_url: latestPost ? latestPost.url || "" : "",
      observed_posts_count: Array.isArray(user.observedPosts) ? user.observedPosts.length : 0,
      following_display: user.followingDisplay || '',
      followers_display: user.followersDisplay || '',
      following_precision: user.followingPrecision || (Number.isFinite(user.followingCount) ? 'exact' : user.followingDisplay ? 'approximate' : 'missing'),
      followers_precision: user.followersPrecision || (Number.isFinite(user.followersCount) ? 'exact' : user.followersDisplay ? 'approximate' : 'missing'),
      stats_updated_at: user.statsUpdatedAt || '',
      stats_source: user.statsSource || ''
    };
  }

  function exportUsersToCsv(users, options = {}) {
    const rows = [EXPORT_FIELDS.join(",")];
    for (const user of users || []) {
      const row = userExportRow(user);
      row.export_mode = options.spreadsheetSafe === false ? 'raw' : 'spreadsheet-safe';
      rows.push(EXPORT_FIELDS.map(field => {
        let value = row[field];
        if (options.spreadsheetSafe !== false && typeof value === 'string' && /^[\s\uFEFF]*[=+@\-']|^[\t\r\n]/.test(value)) value = "'" + value;
        return csvEscape(value);
      }).join(','));
    }
    return `${rows.join("\n")}\n`;
  }

  function markdownEscape(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\\[\]()*_|])/g, "\\$1").replace(/\r?\n/g, "<br>").trim();
  }

  function exportUsersToMarkdown(users) {
    const lines = ["# X 用户导出", ""];
    for (const rawUser of users || []) {
      const user = { ...rawUser, ...normalizedStats(rawUser) };
      const title = markdownEscape(user.displayName || `@${user.username}`);
      const profileUrl = profileUrlForUser(user);
      const following = user.followingDisplay || formatCompactCount(user.followingCount) || "-";
      const followers = user.followersDisplay || formatCompactCount(user.followersCount) || "-";
      lines.push(`- [${title}](${profileUrl}) - @${user.username} - ${following} 正在关注 / ${followers} 关注者`);
      if (user.bio) {
        lines.push(`  - 简介：${markdownEscape(user.bio)}`);
      }
      const sources = userSurfaceSources(user);
      if (sources.length > 0) {
        lines.push(`  - 来源：${sources.join("、")}`);
      }
      const latestPost = selectObservedPost(user);
      if (latestPost) {
        const kindLabel = postKindLabel(latestPost.kind);
        lines.push(
          kindLabel
            ? `  - 最新捕获推文（${kindLabel}）：${markdownEscape(latestPost.text)}`
            : `  - 最新捕获推文：${markdownEscape(latestPost.text)}`
        );
        if (latestPost.url) {
          lines.push(`  - 推文链接：${latestPost.url}`);
        }
      } else {
        lines.push(`  - 最新捕获推文：${markdownNoPostText(user)}`);
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  function markdownNoPostText(user) {
    const sources = userSurfaceSources(user);
    if (sources.includes("import")) {
      return "来自用户导入，未浏览到推文";
    }
    if (sources.includes("userList")) {
      return "来自用户列表，未浏览到推文";
    }
    return "未浏览到推文";
  }

  function postKindLabel(kind) {
    const labels = {
      original: "原创",
      retweet: "转推",
      comment: "评论",
      unknown: ""
    };
    const normalized = normalizePostKind(kind);
    return Object.prototype.hasOwnProperty.call(labels, normalized) ? labels[normalized] : "原创";
  }

  function exportPostKind(kind) {
    const normalized = normalizePostKind(kind);
    return normalized === "unknown" ? "" : normalized;
  }

  function postKindFromLabel(label) {
    const text = String(label || "").trim();
    if (!text) {
      return "unknown";
    }
    const mapped = {
      原创: "original",
      转推: "retweet",
      转发: "retweet",
      评论: "comment",
      回复: "comment",
      original: "original",
      retweet: "retweet",
      repost: "retweet",
      comment: "comment",
      reply: "comment"
    }[text];
    return mapped || "unknown";
  }

  function parseImportedUsers(text, filename) {
    const body = String(text || "").replace(/^\ufeff/, "");
    if (!body.trim()) {
      return [];
    }
    const name = String(filename || "").toLowerCase();
    if (name.endsWith(".csv") || looksLikeCsv(body)) {
      return parseImportedCsv(body);
    }
    return parseImportedMarkdown(body);
  }

  function looksLikeCsv(text) {
    const firstLine = String(text || "").split(/\r?\n/, 1)[0].toLowerCase();
    return firstLine.includes(",") && (firstLine.includes("username") || firstLine.includes("profile_url"));
  }

  function parseImportedCsv(text) {
    const rows = parseCsvRows(text).filter(row => row.some(value => String(value || "").trim()));
    if (rows.length < 2) {
      return [];
    }
    const headers = rows[0].map(header => String(header || "").replace(/^\ufeff/, "").trim().toLowerCase());
    const result = [];
    const seen = new Set();
    for (const row of rows.slice(1)) {
      const values = {};
      headers.forEach((header, index) => {
        values[header] = row[index] || "";
      });
      const user = importedUserFromColumns(values);
      if (!user || seen.has(user.username)) {
        continue;
      }
      seen.add(user.username);
      result.push(user);
    }
    return result;
  }

  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inQuotes) {
        if (char === '"' && text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
        continue;
      }
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }
    if (field || row.length > 0) {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
    }
    return rows;
  }

  function importedUserFromColumns(values) {
    if (values.export_mode === 'spreadsheet-safe') {
      values = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value]));
    }
    const profileUrl = readImportColumn(values, "profile_url", "url", "主页链接", "账号链接", "链接");
    const username = usernameFromProfileHref(profileUrl, "https://x.com/");
    if (!username) {
      return null;
    }
    const following = readImportColumn(values, "following_count", "following", "正在关注");
    const followers = readImportColumn(values, "followers_count", "followers", "关注者", "粉丝");
    const latestPostText = readImportColumn(values, "latest_post_text", "latest_post", "最新捕获推文", "已浏览的最新推文");
    const latestPostUrl = readImportColumn(values, "latest_post_url", "post_url", "推文链接");
    const latestPostKind = readImportColumn(values, "latest_post_kind", "post_kind", "推文类型");
    const user = {
      username,
      userId: readImportColumn(values, "user_id", "rest_id", "用户 id", "用户ID"),
      displayName: readImportColumn(values, "display_name", "name", "昵称"),
      profileUrl: profileUrlForUser({ username, profileUrl }),
      ...(hasImportColumn(values, "bio", "简介") ? { bio: readImportColumn(values, "bio", "简介") } : {}),
      ...(hasImportColumn(values, "website", "网站") ? { website: readImportColumn(values, "website", "网站") } : {}),
      sources: ["import"]
    };
    assignImportedCount(user, "following", following);
    assignImportedCount(user, "followers", followers);
    for (const field of ['following', 'followers']) {
      const display = readImportColumn(values, field + '_display');
      if (display) {
        if (user[field + 'Count'] == null) assignImportedCount(user, field, display);
        const parsedDisplay = parseCountToken(display);
        if (parsedDisplay.precision !== 'missing') user[field + 'Display'] = parsedDisplay.display;
      }
      const precision = readImportColumn(values, field + '_precision');
      // An exported compact display may accompany an exact numeric count.
      // Only allow a precision hint to downgrade a valid value, never to turn
      // invalid/abbreviated count input into an exact result.
      if (precision === 'approximate' && user[field + 'Precision'] !== 'missing') user[field + 'Precision'] = 'approximate';
    }
    const statsTime = Number(readImportColumn(values, 'stats_updated_at'));
    if (Number.isFinite(statsTime) && statsTime > 0) user.statsUpdatedAt = statsTime;
    user.statsSource = readImportColumn(values, 'stats_source') || 'import';
    const firstSeenAt = readImportColumn(values, "first_seen_at", "首次看到");
    const lastSeenAt = readImportColumn(values, "last_seen_at", "最近看到");
    if (firstSeenAt) {
      user.firstSeenAt = firstSeenAt;
    }
    if (lastSeenAt) {
      user.lastSeenAt = lastSeenAt;
    }
    if (latestPostText || latestPostUrl) {
      user.observedPosts = [
        {
          id: "",
          text: latestPostText,
          url: safePostUrl(latestPostUrl),
          kind: postKindFromLabel(latestPostKind),
          source: "import",
          capturedAt: lastSeenAt || firstSeenAt || new Date().toISOString()
        }
      ];
    }
    return user;
  }

  function readImportColumn(values) {
    for (const name of Array.prototype.slice.call(arguments, 1)) {
      const key = String(name || "").trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        return String(values[key] || "").trim();
      }
    }
    return "";
  }

  function hasImportColumn(values, ...names) {
    return names.some(name => Object.hasOwn(values, name.trim().toLowerCase()));
  }

  // Counts are non-negative safe integers, or explicitly supported compact tokens.
  // Never infer availability/precision from arbitrary non-empty display text.
  function parseCountToken(value) {
    const text = normalizeText(value).replace(/，/g, ',');
    const missing = { count: null, display: '', precision: 'missing' };
    let numeric, precision = 'exact', display = text;
    const compact = text.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(万|萬|亿|億|千|百|[KkMmBb])$/);
    if (compact) {
      const multiplier = { 百: 100, 千: 1000, 万: 10000, 萬: 10000, 亿: 100000000, 億: 100000000, K: 1000, M: 1000000, B: 1000000000 }[compact[2].toUpperCase()];
      numeric = Math.round(Number(compact[1].replace(',', '.')) * multiplier);
      precision = 'approximate';
      display = compact[1].replace(',', '.') + compact[2].toUpperCase();
    } else if (/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,3}(?: [0-9]{3})+)$/.test(text)) {
      numeric = Number(text.replace(/[ ,]/g, ''));
      display = text.replace(/ /g, '');
    } else return missing;
    if (!Number.isSafeInteger(numeric) || numeric < 0) return missing;
    return { count: numeric, display, precision };
  }

  function normalizeStatsField(user, field) {
    const rawCount = user?.[field + 'Count'];
    const numeric = typeof rawCount === 'number'
      ? (Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : null)
      : parseCountToken(rawCount).precision === 'exact' ? parseCountToken(rawCount).count : null;
    const display = parseCountToken(user?.[field + 'Display']);
    if (numeric !== null) {
      const approximate = user?.[field + 'Precision'] === 'approximate';
      return { count: numeric, display: display.display || String(numeric), precision: approximate ? 'approximate' : 'exact' };
    }
    // DOM abbreviations are display-only; do not manufacture an exact count.
    return { ...display, count: display.precision === 'exact' ? display.count : null };
  }

  function normalizedStats(user) {
    const result = {};
    for (const field of ['following', 'followers']) {
      const value = normalizeStatsField(user, field);
      result[field + 'Count'] = value.count;
      result[field + 'Display'] = value.display;
      result[field + 'Precision'] = value.precision;
    }
    return result;
  }

  function assignImportedCount(user, field, value) {
    const parsed = parseCountToken(value);
    user[field + 'Count'] = parsed.count;
    user[field + 'Display'] = parsed.display;
    user[field + 'Precision'] = parsed.precision;
  }

  function parseImportedMarkdown(text) {
    const result = [];
    const seen = new Set();
    let current = null;
    function pushCurrent() {
      if (current && current.username && !seen.has(current.username)) {
        seen.add(current.username);
        result.push(current);
      }
      current = null;
    }
    function pushProfileLink(profileUrl, displayName) {
      const username = usernameFromProfileHref(profileUrl, "https://x.com/");
      if (!username || seen.has(username)) {
        return;
      }
      pushCurrent();
      seen.add(username);
      result.push({
        username,
        displayName: displayName || "",
        profileUrl: profileUrlForUser({ username, profileUrl }),
        sources: ["import"]
      });
    }
    const lines = String(text || "").split(/\r?\n/);
    for (const line of lines) {
      const itemMatch = line.match(/^- \[((?:\\.|[^\]\\])+)\]\(([^)]+)\) - @([A-Za-z0-9_]{1,15})(?: - (.*))?$/);
      if (itemMatch) {
        pushCurrent();
        const profileUsername = usernameFromProfileHref(itemMatch[2], "https://x.com/");
        if (!profileUsername) {
          continue;
        }
        current = {
          username: profileUsername,
          displayName: unescapeMarkdownText(itemMatch[1]),
          profileUrl: profileUrlForUser({ username: profileUsername, profileUrl: itemMatch[2] }),
          sources: ["import"]
        };
        const countMatch = String(itemMatch[4] || "").match(/(.+?)\s*正在关注\s*\/\s*(.+?)\s*关注者/);
        if (countMatch) {
          assignImportedCount(current, "following", countMatch[1]);
          assignImportedCount(current, "followers", countMatch[2]);
        }
        continue;
      }
      const linkOnlyMatch = line.match(/^(?:[-*]\s*)?\[((?:\\.|[^\]\\])*)\]\(([^)]+)\)\s*$/);
      if (linkOnlyMatch && usernameFromProfileHref(linkOnlyMatch[2], "https://x.com/")) {
        const title = unescapeMarkdownText(linkOnlyMatch[1]);
        const displayName = normalizeUsername(title) || title.startsWith("@") || /^https?:\/\//i.test(title) ? "" : title;
        pushProfileLink(linkOnlyMatch[2].trim(), displayName);
        continue;
      }
      const rawUrlMatch = line.match(/^(?:[-*]\s*)?(https?:\/\/(?:x|twitter)\.com\/[^\s)]+)\s*$/i);
      if (rawUrlMatch && usernameFromProfileHref(rawUrlMatch[1], "https://x.com/")) {
        pushProfileLink(rawUrlMatch[1].trim(), "");
        continue;
      }
      if (!current) {
        continue;
      }
      const bioMatch = line.match(/^\s+- 简介：(.*)$/);
      if (bioMatch) {
        current.bio = unescapeMarkdownText(bioMatch[1]);
        continue;
      }
      const postMatch = line.match(/^\s+- 最新捕获推文(?:（([^）]+)）)?：(.*)$/);
      if (postMatch) {
        const textValue = unescapeMarkdownText(postMatch[2]);
        if (textValue && !isMarkdownNoPostText(textValue)) {
          current.observedPosts = [
            {
              id: "",
              text: textValue,
              url: "",
              kind: postKindFromLabel(postMatch[1]),
              source: "import",
              capturedAt: new Date().toISOString()
            }
          ];
        }
        continue;
      }
      const postUrlMatch = line.match(/^\s+- 推文链接：(.*)$/);
      if (postUrlMatch) {
        const url = postUrlMatch[1].trim();
        if (current.observedPosts && current.observedPosts[0]) {
          current.observedPosts[0].url = url;
        } else if (url) {
          current.observedPosts = [{ id: "", text: "", url, kind: "unknown", source: "import", capturedAt: new Date().toISOString() }];
        }
      }
    }
    pushCurrent();
    return result.filter(user => user.username);
  }

  function isMarkdownNoPostText(value) {
    return [
      "未获取到推文",
      "未浏览到推文",
      "来自用户导入，未浏览到推文",
      "来自用户列表，未浏览到推文"
    ].includes(String(value || "").trim());
  }

  function unescapeMarkdownText(value) {
    return String(value || "").replace(/<br>/g, "\n").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\\([\\\[\]()*_|])/g, "$1").trim();
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function findCountBeforeLabel(text, labels) {
    const normalized = normalizeText(text);
    for (const label of labels) {
      const pattern = new RegExp(escapeRegExp(label) + '(?=$|[\\s:：·|,，。])', 'ig');
      for (const match of normalized.matchAll(pattern)) {
        // Read the entire adjacent numeric span before validating it. A broken
        // group must not restart at its last three digits and look exact.
        const before = normalized.slice(0, match.index).trimEnd();
        const token = before.match(/(?:^|[^0-9A-Za-z_.,，+\-])([+\-]?[0-9][0-9.,， ]*(?:[KkMmBb万萬亿億千百])?)$/);
        if (!token) continue;
        const parsed = parseCountToken(token[1]);
        if (parsed.precision !== 'missing') return parsed.display;
      }
    }
    return '';
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseStatsText(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return null;
    }

    const followingDisplay = findCountBeforeLabel(normalized, FOLLOWING_LABELS);
    const followersDisplay = findCountBeforeLabel(normalized, FOLLOWERS_LABELS);

    if (!followingDisplay || !followersDisplay) {
      return null;
    }

    return {
      followingDisplay,
      followersDisplay
    };
  }

  function collectUserStats(payload) {
    const users = [];
    const seenObjects = new WeakSet();
    const seenUsers = new Map();
    let nodeCount = 0;

    function addUser(candidate) {
      if (!candidate || typeof candidate !== "object") {
        return;
      }

      const legacy = candidate.legacy && typeof candidate.legacy === "object" ? candidate.legacy : candidate;
      const username = normalizeUsername(
        legacy.screen_name || legacy.username || candidate.screen_name || candidate.username
      );
      if (!username) {
        return;
      }

      const followingCount = firstFiniteNumber(
        legacy.friends_count,
        legacy.following_count,
        candidate.friends_count,
        candidate.following_count
      );
      const followersCount = firstFiniteNumber(
        legacy.followers_count,
        legacy.normal_followers_count,
        candidate.followers_count,
        candidate.normal_followers_count
      );

      if (followingCount === null || followersCount === null) {
        return;
      }

      const record = {
        username,
        userId: String(candidate.rest_id || candidate.id_str || legacy.id_str || candidate.id || ""),
        displayName: typeof legacy.name === "string" ? legacy.name : "",
        avatarUrl: typeof legacy.profile_image_url_https === "string" ? legacy.profile_image_url_https : "",
        bio: typeof legacy.description === "string" ? legacy.description : "",
        website: readExpandedWebsite(legacy),
        verified: Boolean(legacy.verified || candidate.is_blue_verified),
        followingCount,
        followersCount,
        followingDisplay: formatCompactCount(followingCount),
        followersDisplay: formatCompactCount(followersCount)
      };
      if (!Object.hasOwn(legacy, 'description')) delete record.bio;
      if (!Object.hasOwn(legacy, 'url') && !Object.hasOwn(legacy.entities || {}, 'url')) delete record.website;
      if (!Object.hasOwn(legacy, 'verified') && !Object.hasOwn(candidate, 'is_blue_verified')) delete record.verified;
      const previous = seenUsers.get(username);
      if (previous) {
        record.userId ||= previous.userId;
        if (previous.verified === true || !Object.hasOwn(record, "verified")) record.verified = previous.verified;
      }
      seenUsers.set(username, record);
      if (legacy !== candidate) seenObjects.add(legacy);
    }

    function visit(value, depth) {
      if (!value || depth > MAX_GRAPH_DEPTH || nodeCount > MAX_GRAPH_NODES) {
        return;
      }
      if (typeof value !== "object") {
        return;
      }
      if (seenObjects.has(value)) {
        return;
      }
      seenObjects.add(value);
      nodeCount += 1;

      addUser(value);
      if (value.result && typeof value.result === "object") {
        addUser(value.result);
      }
      if (value.user_results && value.user_results.result) {
        addUser(value.user_results.result);
      }
      if (value.core && value.core.user_results && value.core.user_results.result) {
        addUser(value.core.user_results.result);
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item, depth + 1);
        }
        return;
      }

      for (const item of Object.values(value)) {
        visit(item, depth + 1);
      }
    }

    visit(payload, 0);
    users.push(...seenUsers.values());
    return users;
  }

  function readExpandedWebsite(legacy) {
    const urls = legacy && legacy.entities && legacy.entities.url && legacy.entities.url.urls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return "";
    }
    const first = urls[0];
    return String(first.expanded_url || first.display_url || first.url || "");
  }

  global.XFollowStatsCore = {
    SOURCE,
    canonicalStringify,
    collectUserStats,
    classifyStatsSurface,
    exportUsersToCsv,
    exportUsersToMarkdown,
    findNameLinkInAnchors,
    formatCompactCount,
    formatStatsCount,
    isStatsAllowedPath,
    isCachedStatsFresh,
    hasCompleteStatsRecord,
    profileUrlForUsername,
    profileUrlForUser,
    safePostUrl,
    mergeCachedUserRecords,
    mergeImportedUser,
    compareStatsSnapshots,
    mergeObservedUser,
    normalizeDisplaySettings,
    normalizePostKind,
    normalizePostSource,
    normalizeSource,
    normalizeText,
    normalizeUsername,
    parseImportedUsers,
    parseStatsText,
    reconcileUserCaches,
    selectObservedPost,
    shouldRunHoverFallback,
    userHasCommentSource,
    userHasNonCommentSource,
    userSurfaceSources,
    usernameFromProfileHref
  };
})(globalThis);
