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
    const convertTzOffset = toValidTzOffset(source.convertTzOffset, -7);
    const targetDiffTzOffset = toValidTzOffset(source.targetDiffTzOffset, 12);
    const targetDiffTime = normalizeDateTimeString(
      source.targetDiffTime,
      defaultDateTimeInOffset(targetDiffTzOffset)
    );
    return {
      feed: source.feed !== false,
      userList: source.userList !== false,
      updateOnlyExisting: source.updateOnlyExisting === true,
      convertTzEnabled: source.convertTzEnabled === true,
      convertTzOffset,
      targetDiffEnabled: source.targetDiffEnabled === true,
      targetDiffTzOffset,
      targetDiffTime
    };
  }

  function defaultDateTimeInOffset(offsetHours) {
    const wall = toOffsetWallDate(Date.now(), offsetHours);
    if (!wall) {
      return "2026-10-25T14:00";
    }
    const y = wall.getUTCFullYear();
    const m = String(wall.getUTCMonth() + 1).padStart(2, "0");
    const d = String(wall.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}T14:00`;
  }

  function toValidTzOffset(value, fallback) {
    const parsed = toFiniteNumber(value);
    if (parsed === null) {
      return fallback;
    }
    const rounded = Math.round(parsed);
    if (rounded < -12 || rounded > 14) {
      return fallback;
    }
    return rounded;
  }

  function normalizeDateTimeString(value, fallback) {
    if (typeof value !== "string") {
      return fallback;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      return "";
    }
    const fullMatch = trimmed.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T\s]([01]?\d|2[0-3]):([0-5]\d)$/);
    if (fullMatch) {
      return `${fullMatch[1]}-${fullMatch[2]}-${fullMatch[3]}T${String(Number(fullMatch[4])).padStart(2, "0")}:${fullMatch[5]}`;
    }
    const timeOnlyMatch = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (timeOnlyMatch) {
      const datePrefix = String(fallback || "2026-10-25T14:00").split("T")[0];
      return `${datePrefix}T${String(Number(timeOnlyMatch[1])).padStart(2, "0")}:${timeOnlyMatch[2]}`;
    }
    return fallback;
  }

  function normalizeTimeString(value, fallback) {
    return normalizeDateTimeString(value, fallback);
  }

  function formatUtcOffsetLabel(offsetHours) {
    const offset = toValidTzOffset(offsetHours, 0);
    if (offset === 0) {
      return "UTC+0";
    }
    return offset > 0 ? `UTC+${offset}` : `UTC${offset}`;
  }

  const TIMEZONE_CITIES = {
    zh: {
      "-12": "贝克岛",
      "-11": "帕果帕果 / 美属萨摩亚",
      "-10": "檀香山 / 夏威夷",
      "-9": "安克雷奇(标准时)",
      "-8": "洛杉矶 / 温哥华(标准时)",
      "-7": "旧金山(夏令时) / 丹佛(标准时)",
      "-6": "芝加哥(标准时) / 墨西哥城",
      "-5": "纽约 / 多伦多(标准时)",
      "-4": "纽约(夏令时) / 圣地亚哥(标准时)",
      "-3": "圣保罗 / 布宜诺斯艾利斯",
      "-2": "费尔南多-迪诺罗尼亚",
      "-1": "亚速尔群岛(标准时)",
      "0": "伦敦(标准时) / UTC",
      "1": "柏林 / 巴黎(标准时) / 伦敦(夏令时)",
      "2": "开罗 / 雅典(标准时) / 柏林(夏令时)",
      "3": "莫斯科 / 利雅得",
      "4": "迪拜 / 巴库",
      "5": "卡拉奇 / 塔什干 / 阿拉木图",
      "6": "达卡",
      "7": "曼谷 / 雅加达",
      "8": "北京 / 新加坡 / 台北",
      "9": "东京 / 首尔",
      "10": "悉尼 / 墨尔本(标准时)",
      "11": "所罗门群岛 / 悉尼(夏令时)",
      "12": "奥克兰(标准时) / 斐济",
      "13": "奥克兰(夏令时) / 努库阿洛法 / 萨摩亚",
      "14": "圣诞岛 (基里巴斯)"
    },
    en: {
      "-12": "Baker Island",
      "-11": "Pago Pago / American Samoa",
      "-10": "Honolulu / Hawaii",
      "-9": "Anchorage (standard)",
      "-8": "Los Angeles / Vancouver (standard)",
      "-7": "San Francisco (PDT) / Denver (standard)",
      "-6": "Chicago (standard) / Mexico City",
      "-5": "New York / Toronto (standard)",
      "-4": "New York (EDT) / Santiago (standard)",
      "-3": "São Paulo / Buenos Aires",
      "-2": "Fernando de Noronha",
      "-1": "Azores (standard)",
      "0": "London (standard) / UTC",
      "1": "Berlin / Paris (standard) / London (BST)",
      "2": "Cairo / Athens (standard) / Berlin (CEST)",
      "3": "Moscow / Riyadh",
      "4": "Dubai / Baku",
      "5": "Karachi / Tashkent / Almaty",
      "6": "Dhaka",
      "7": "Bangkok / Jakarta",
      "8": "Beijing / Singapore / Taipei",
      "9": "Tokyo / Seoul",
      "10": "Sydney / Melbourne (standard)",
      "11": "Solomon Is. / Sydney (AEDT)",
      "12": "Auckland (standard) / Fiji",
      "13": "Auckland (NZDT) / Tonga / Samoa",
      "14": "Kiritimati"
    }
  };

  function formatUtcOffsetOptionLabel(offsetHours, locale) {
    const offset = toValidTzOffset(offsetHours, 0);
    const utcLabel = formatUtcOffsetLabel(offset);
    const isZh = String(locale || "").toLowerCase().startsWith("zh");
    const table = isZh ? TIMEZONE_CITIES.zh : TIMEZONE_CITIES.en;
    const city = table[String(offset)];
    return city ? `${utcLabel} (${city})` : utcLabel;
  }

  function toOffsetWallDate(timestampMs, offsetHours) {
    const ms = toFiniteNumber(timestampMs);
    if (ms === null) {
      return null;
    }
    const offset = toValidTzOffset(offsetHours, 0);
    return new Date(ms + offset * 3600 * 1000);
  }

  function formatTimestampInOffset(timestampMs, offsetHours, locale) {
    const wall = toOffsetWallDate(timestampMs, offsetHours);
    if (!wall) {
      return "";
    }
    const isZh = String(locale || "").toLowerCase().startsWith("zh");
    const year = wall.getUTCFullYear();
    const month = wall.getUTCMonth() + 1;
    const day = wall.getUTCDate();
    const hours24 = wall.getUTCHours();
    const minutes = String(wall.getUTCMinutes()).padStart(2, "0");
    const isPM = hours24 >= 12;
    const hours12 = hours24 % 12 || 12;
    if (isZh) {
      const ampm = isPM ? "下午" : "上午";
      return `${ampm}${hours12}:${minutes} · ${year}年${month}月${day}日`;
    }
    const ampm = isPM ? "PM" : "AM";
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${hours12}:${minutes} ${ampm} · ${monthNames[month - 1]} ${day}, ${year}`;
  }

  function formatShortClockInOffset(timestampMs, offsetHours, locale) {
    const wall = toOffsetWallDate(timestampMs, offsetHours);
    if (!wall) {
      return { clock: "--:--", date: "" };
    }
    const isZh = String(locale || "").toLowerCase().startsWith("zh");
    const month = wall.getUTCMonth() + 1;
    const day = wall.getUTCDate();
    const hours24 = wall.getUTCHours();
    const minutes = String(wall.getUTCMinutes()).padStart(2, "0");
    const isPM = hours24 >= 12;
    const hours12 = hours24 % 12 || 12;
    if (isZh) {
      return {
        clock: `${isPM ? "下午" : "上午"}${hours12}:${minutes}`,
        date: `${month}月${day}日`
      };
    }
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return {
      clock: `${hours12}:${minutes} ${isPM ? "PM" : "AM"}`,
      date: `${monthNames[month - 1]} ${day}`
    };
  }

  function computeTargetMomentDiff(timestampMs, targetTzOffset, targetDateTimeStr, locale) {
    const ms = toFiniteNumber(timestampMs);
    const offset = toValidTzOffset(targetTzOffset, 0);
    const normalizedDateTime = normalizeDateTimeString(targetDateTimeStr, "");
    if (ms === null || !normalizedDateTime) {
      return null;
    }
    const [datePart, timePart] = normalizedDateTime.split("T");
    const [targetYear, targetMonth, targetDay] = datePart.split("-").map(Number);
    const [targetHour, targetMinute] = timePart.split(":").map(Number);
    const targetUtcMs = Date.UTC(
      targetYear,
      targetMonth - 1,
      targetDay,
      targetHour,
      targetMinute,
      0
    ) - offset * 3600 * 1000;

    const diffMinutes = Math.round((targetUtcMs - ms) / 60000);
    const sign = diffMinutes > 0 ? "+" : diffMinutes < 0 ? "-" : "";
    const absMinutes = Math.abs(diffMinutes);
    const days = Math.floor(absMinutes / 1440);
    const hours = Math.floor((absMinutes % 1440) / 60);
    const totalHours = Math.floor(absMinutes / 60);
    const minutes = absMinutes % 60;
    const isZh = String(locale || "").toLowerCase().startsWith("zh");
    let text;
    if (isZh) {
      if (absMinutes === 0) {
        text = "0小时";
      } else if (days >= 2) {
        text = hours === 0
          ? `${sign}${days}天`
          : `${sign}${days}天${hours}小时`;
      } else if (minutes === 0) {
        text = `${sign}${totalHours}小时`;
      } else if (totalHours === 0) {
        text = `${sign}${minutes}分钟`;
      } else {
        text = `${sign}${totalHours}小时${minutes}分`;
      }
    } else {
      if (absMinutes === 0) {
        text = "0h";
      } else if (days >= 2) {
        text = hours === 0
          ? `${sign}${days}d`
          : `${sign}${days}d ${hours}h`;
      } else if (minutes === 0) {
        text = `${sign}${totalHours}h`;
      } else if (totalHours === 0) {
        text = `${sign}${minutes}m`;
      } else {
        text = `${sign}${totalHours}h ${minutes}m`;
      }
    }
    return {
      diffMinutes,
      sign,
      text
    };
  }

  function buildTimestampHoverParts(timestampMs, settings, locale) {
    const normalized = normalizeDisplaySettings(settings);
    const ms = toFiniteNumber(timestampMs);
    if (ms === null) {
      return { convertedText: "", diffText: "", diffMinutes: 0 };
    }
    let convertedText = "";
    if (normalized.convertTzEnabled) {
      const tzLabel = formatUtcOffsetLabel(normalized.convertTzOffset);
      const formatted = formatTimestampInOffset(ms, normalized.convertTzOffset, locale);
      if (formatted) {
        convertedText = `${tzLabel} ${formatted}`;
      }
    }
    let diffText = "";
    let diffMinutes = 0;
    if (normalized.targetDiffEnabled && normalized.targetDiffTime) {
      const diff = computeTargetMomentDiff(
        ms,
        normalized.targetDiffTzOffset,
        normalized.targetDiffTime,
        locale
      );
      if (diff) {
        diffText = diff.text;
        diffMinutes = diff.diffMinutes;
      }
    }
    return {
      convertedText,
      diffText,
      diffMinutes
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
    if (!/^(x\.com|twitter\.com)$/i.test(url.hostname)) {
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
    const display = preferString(user && user[field + 'Display'], '');
    const count = firstFiniteNumber(user && user[field + 'Count']);
    if (user && user[field + 'Precision'] === 'approximate') return display || formatCompactCount(count, locale);
    return count !== null ? formatCompactCount(count, locale) : display;
  }

  function profileUrlForUsername(username) {
    const normalizedUsername = normalizeUsername(username);
    return normalizedUsername ? `https://x.com/${normalizedUsername}` : "";
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
    const url = typeof value.url === "string" ? value.url.trim() : "";
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

  function mergeObservedUser(current, incoming, now) {
    const normalizedUsername = normalizeUsername(
      incoming && incoming.username ? incoming.username : current && current.username
    );
    if (!normalizedUsername) {
      return current || null;
    }
    const timestamp = now || new Date().toISOString();
    const existing = current && typeof current === "object" ? current : {};
    const next = incoming && typeof incoming === "object" ? incoming : {};
    const incomingHasStats = (
      Number.isFinite(next.followingCount) || Number.isFinite(next.followersCount)
      || Boolean(preferString(next.followingDisplay, "")) || Boolean(preferString(next.followersDisplay, ""))
    );
    const existingStatsUpdatedAt = statsRecordTimestamp(existing);
    const incomingStatsUpdatedAt = statsRecordTimestamp(next);
    const statsUpdatedAt = incomingHasStats
      ? incomingStatsUpdatedAt || Date.parse(timestamp) || Date.now()
      : existingStatsUpdatedAt;
    const snapshot = incomingHasStats && statsUpdatedAt >= existingStatsUpdatedAt ? next : existing;
    const exactDisplayCount = value => /^[\d,，\s]+$/.test(String(value || ""))
      ? toFiniteNumber(String(value).replace(/[，\s]/g, match => match === "，" ? "," : "")) : null;
    const followingCount = firstFiniteNumber(snapshot.followingCount, exactDisplayCount(snapshot.followingDisplay));
    const followersCount = firstFiniteNumber(snapshot.followersCount, exactDisplayCount(snapshot.followersDisplay));
    const incomingPosts = [];
    if (Array.isArray(next.observedPosts)) {
      incomingPosts.push(...next.observedPosts.map(post => (
        post && typeof post === "object" && !post.capturedAt
          ? { ...post, capturedAt: timestamp }
          : post
      )));
    }
    const singlePost = normalizeObservedPost(
      next.observedPost && typeof next.observedPost === "object" && !next.observedPost.capturedAt
        ? { ...next.observedPost, capturedAt: timestamp }
        : next.observedPost
    );
    if (singlePost) {
      incomingPosts.push(singlePost);
    }

    return {
      username: normalizedUsername,
      userId: preferString(next.userId, existing.userId),
      displayName: preferString(next.displayName, existing.displayName),
      profileUrl: preferString(next.profileUrl, existing.profileUrl) || profileUrlForUsername(normalizedUsername),
      avatarUrl: preferString(next.avatarUrl, existing.avatarUrl),
      ...mergeProfileMetadata(existing, next, Date.parse(timestamp) || Date.now()),
      followingCount,
      followersCount,
      followingPrecision: snapshot.followingPrecision || (followingCount !== null ? 'exact' : snapshot.followingDisplay ? 'approximate' : 'missing'),
      followersPrecision: snapshot.followersPrecision || (followersCount !== null ? 'exact' : snapshot.followersDisplay ? 'approximate' : 'missing'),
      followingDisplay: preferString(snapshot.followingDisplay, "") || formatCompactCount(followingCount),
      followersDisplay: preferString(snapshot.followersDisplay, "") || formatCompactCount(followersCount),
      sources: compactUniqueList([...(existing.sources || []), ...(next.sources || [])]),
      firstSeenAt: existing.firstSeenAt || timestamp,
      lastSeenAt: timestamp,
      updatedAt: Date.parse(timestamp) || Date.now(),
      statsUpdatedAt: snapshot === next ? statsUpdatedAt : existingStatsUpdatedAt,
      statsSource: snapshot.statsSource || "",
      observedPosts: mergeObservedPosts(existing.observedPosts, incomingPosts)
    };
  }

  function statsRecordTimestamp(user) {
    if (!hasAnyStatsRecord(user)) return 0;
    const explicitTimestamp = Number(user && user.statsUpdatedAt || 0);
    if (explicitTimestamp) {
      return explicitTimestamp;
    }
    return hasCompleteStatsRecord(user) ? Number(user && user.updatedAt || 0) : 0;
  }

  function hasAnyStatsRecord(user) {
    return Boolean(user && (firstFiniteNumber(user.followingCount) !== null
      || firstFiniteNumber(user.followersCount) !== null
      || preferString(user.followingDisplay, "") || preferString(user.followersDisplay, "")));
  }

  function cacheRecordTimestamp(user) {
    return Math.max(
      Number(user && user.updatedAt || 0),
      statsRecordTimestamp(user),
      Date.parse(user && user.lastSeenAt ? user.lastSeenAt : "") || 0
    );
  }

  function hasCompleteStatsRecord(user) {
    if (!user || typeof user !== "object") {
      return false;
    }
    const hasNumericCounts = firstFiniteNumber(user.followingCount) !== null
      && firstFiniteNumber(user.followersCount) !== null;
    const hasDisplayCounts = Boolean(preferString(user.followingDisplay, ""))
      && Boolean(preferString(user.followersDisplay, ""));
    return hasNumericCounts || hasDisplayCounts;
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
    const existing = current && typeof current === "object" ? current : null;
    const next = incoming && typeof incoming === "object" ? incoming : null;
    if (!existing) {
      return next;
    }
    if (!next) {
      return existing;
    }
    const existingUsername = normalizeUsername(existing.username);
    const nextUsername = normalizeUsername(next.username);
    if (!existingUsername || !nextUsername || existingUsername !== nextUsername) {
      return null;
    }

    const existingTimestamp = cacheRecordTimestamp(existing);
    const nextTimestamp = cacheRecordTimestamp(next);
    const nextWinsRecord = nextTimestamp > existingTimestamp
      || (nextTimestamp === existingTimestamp && canonicalStringify(next) > canonicalStringify(existing));
    const newer = nextWinsRecord ? next : existing;
    const older = newer === next ? existing : next;
    const existingLastSeenAt = Date.parse(existing.lastSeenAt || "") || 0;
    const nextLastSeenAt = Date.parse(next.lastSeenAt || "") || 0;
    const nextWinsLastSeen = nextLastSeenAt > existingLastSeenAt
      || (
        nextLastSeenAt === existingLastSeenAt
        && String(next.lastSeenAt || "") > String(existing.lastSeenAt || "")
      );
    const lastSeenAt = nextWinsLastSeen
      ? next.lastSeenAt || existing.lastSeenAt || ""
      : existing.lastSeenAt || next.lastSeenAt || "";
    const mergeTimestamp = lastSeenAt || new Date(Math.max(existingTimestamp, nextTimestamp, 1)).toISOString();
    const merged = mergeObservedUser(older, newer, mergeTimestamp);
    if (!merged) {
      return null;
    }
    for (const field of PROFILE_METADATA_FIELDS) delete merged[field];
    Object.assign(merged, mergeProfileMetadata(existing, next));

    const existingStatsTimestamp = statsRecordTimestamp(existing);
    const nextStatsTimestamp = statsRecordTimestamp(next);
    const nextWinsStats = hasAnyStatsRecord(next) && (!hasAnyStatsRecord(existing)
      || nextStatsTimestamp > existingStatsTimestamp
      || (nextStatsTimestamp === existingStatsTimestamp && canonicalStringify(next) > canonicalStringify(existing)));
    const statsWinner = nextWinsStats ? next : existing;
    const followingCount = firstFiniteNumber(statsWinner.followingCount);
    const followersCount = firstFiniteNumber(statsWinner.followersCount);
    merged.followingCount = followingCount;
    merged.followersCount = followersCount;
    merged.followingDisplay = preferString(statsWinner.followingDisplay, "") || formatCompactCount(followingCount);
    merged.followersDisplay = preferString(statsWinner.followersDisplay, "") || formatCompactCount(followersCount);
    merged.followingPrecision = statsWinner.followingPrecision || (followingCount !== null ? 'exact' : statsWinner.followingDisplay ? 'approximate' : 'missing');
    merged.followersPrecision = statsWinner.followersPrecision || (followersCount !== null ? 'exact' : statsWinner.followersDisplay ? 'approximate' : 'missing');
    merged.statsUpdatedAt = Math.max(existingStatsTimestamp, nextStatsTimestamp);
    merged.statsSource = statsWinner.statsSource || "";
    merged.updatedAt = Math.max(existingTimestamp, nextTimestamp);
    merged.sources = compactUniqueList([...(existing.sources || []), ...(next.sources || [])]).sort();
    const existingFirstSeenAt = Date.parse(existing.firstSeenAt || "") || 0;
    const nextFirstSeenAt = Date.parse(next.firstSeenAt || "") || 0;
    merged.firstSeenAt = existingFirstSeenAt && nextFirstSeenAt
      ? existingFirstSeenAt <= nextFirstSeenAt ? existing.firstSeenAt : next.firstSeenAt
      : existing.firstSeenAt || next.firstSeenAt || merged.firstSeenAt;
    if (lastSeenAt) {
      merged.lastSeenAt = lastSeenAt;
    } else {
      delete merged.lastSeenAt;
    }
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
    const latestPost = selectObservedPost(user);
    return {
      display_name: user.displayName || "",
      username: user.username || "",
      user_id: user.userId || "",
      profile_url: user.profileUrl || profileUrlForUsername(user.username),
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
    for (const user of users || []) {
      const title = markdownEscape(user.displayName || `@${user.username}`);
      const profileUrl = user.profileUrl || profileUrlForUsername(user.username);
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
      profileUrl: profileUrl || profileUrlForUsername(username),
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
        user[field + 'Display'] = display;
      }
      const precision = readImportColumn(values, field + '_precision');
      if (['exact', 'approximate', 'missing'].includes(precision)) user[field + 'Precision'] = precision;
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
          url: latestPostUrl,
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

  function assignImportedCount(user, field, value) {
    const text = String(value || "").trim();
    if (!text || text === "-") {
      return;
    }
    const numeric = parseHumanCount(text);
    user[field + 'Precision'] = /[万萬亿億千百kmb]/i.test(text) ? 'approximate' : numeric !== null ? 'exact' : 'missing';
    if (field === "following") {
      if (numeric !== null) {
        user.followingCount = numeric;
      }
      user.followingDisplay = text;
    } else {
      if (numeric !== null) {
        user.followersCount = numeric;
      }
      user.followersDisplay = text;
    }
  }

  function parseHumanCount(value) {
    const text = String(value || "").replace(/,/g, "").replace(/，/g, "").trim();
    if (!text || text === "-") {
      return null;
    }
    const match = text.match(/^([0-9]+(?:\.[0-9]+)?)(万|萬|亿|億|千|百|[KkMmBb])?$/);
    if (!match) {
      return toFiniteNumber(text);
    }
    const base = Number(match[1]);
    if (!Number.isFinite(base)) {
      return null;
    }
    const multiplier = {
      百: 100,
      千: 1000,
      万: 10000,
      萬: 10000,
      亿: 100000000,
      億: 100000000,
      K: 1000,
      k: 1000,
      M: 1000000,
      m: 1000000,
      B: 1000000000,
      b: 1000000000
    }[match[2]] || 1;
    return Math.round(base * multiplier);
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
        profileUrl,
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
          profileUrl: itemMatch[2].trim(),
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

  function cleanDisplayCount(value) {
    if (typeof value !== "string") {
      return "";
    }
    return value
      .replace(/\s+/g, "")
      .replace(/，/g, ",")
      .replace(/([kmb])$/i, match => match.toUpperCase())
      .trim();
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function findCountBeforeLabel(text, labels) {
    const normalized = normalizeText(text);
    const countTokenPattern = "([0-9]+(?:[,，.][0-9]+)*(?:\\s*(?:[KkMmBb万萬亿億千百]+))?)";
    for (const label of labels) {
      const escapedLabel = escapeRegExp(label);
      const pattern = new RegExp(
        "(^|[^0-9A-Za-z_])" +
          countTokenPattern +
          "\\s*" +
          escapedLabel +
          "(?=$|[\\s:：·|,，。])",
        "i"
      );
      const match = normalized.match(pattern);
      if (match) {
        return cleanDisplayCount(match[2]);
      }
    }
    return "";
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
    buildTimestampHoverParts,
    canonicalStringify,
    collectUserStats,
    classifyStatsSurface,
    computeTargetMomentDiff,
    exportUsersToCsv,
    exportUsersToMarkdown,
    findNameLinkInAnchors,
    formatCompactCount,
    formatShortClockInOffset,
    formatStatsCount,
    formatTimestampInOffset,
    formatUtcOffsetLabel,
    formatUtcOffsetOptionLabel,
    isStatsAllowedPath,
    isCachedStatsFresh,
    mergeCachedUserRecords,
    mergeObservedUser,
    normalizeDisplaySettings,
    normalizePostKind,
    normalizePostSource,
    normalizeSource,
    normalizeText,
    normalizeTimeString,
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
