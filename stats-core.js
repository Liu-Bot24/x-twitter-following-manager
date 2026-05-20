(function installXFollowStatsCore(global) {
  "use strict";

  const SOURCE = "x-follow-stats-extension";
  const MAX_GRAPH_DEPTH = 18;
  const MAX_GRAPH_NODES = 12000;
  const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
  const DEFAULT_DISPLAY_SETTINGS = Object.freeze({
    feed: true,
    userList: true,
    updateOnlyExisting: false
  });
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
    "observed_posts_count"
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

  function formatCompactCount(count, locale) {
    const numeric = toFiniteNumber(count);
    if (numeric === null) {
      return "";
    }
    try {
      return new Intl.NumberFormat(locale || "zh-CN", {
        maximumFractionDigits: numeric >= 10000 ? 1 : 0,
        notation: "compact"
      }).format(numeric);
    } catch {
      return String(numeric);
    }
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
      capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : new Date().toISOString()
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
    const result = [];
    const seen = new Set();
    for (const post of [...(incomingPosts || []), ...(currentPosts || [])]) {
      const normalizedPost = normalizeObservedPost(post);
      if (!normalizedPost) {
        continue;
      }
      const key = normalizedPost.id || normalizedPost.url || normalizedPost.text;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(normalizedPost);
    }
    return result.slice(0, 20);
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
    const followingCount = firstFiniteNumber(next.followingCount, existing.followingCount);
    const followersCount = firstFiniteNumber(next.followersCount, existing.followersCount);
    const incomingPosts = [];
    if (Array.isArray(next.observedPosts)) {
      incomingPosts.push(...next.observedPosts);
    }
    const singlePost = normalizeObservedPost(next.observedPost);
    if (singlePost) {
      incomingPosts.push(singlePost);
    }

    return {
      username: normalizedUsername,
      userId: preferString(next.userId, existing.userId),
      displayName: preferString(next.displayName, existing.displayName),
      profileUrl: preferString(next.profileUrl, existing.profileUrl) || profileUrlForUsername(normalizedUsername),
      avatarUrl: preferString(next.avatarUrl, existing.avatarUrl),
      bio: preferString(next.bio, existing.bio),
      website: preferString(next.website, existing.website),
      verified: Boolean(next.verified || existing.verified),
      followingCount,
      followersCount,
      followingDisplay: preferString(next.followingDisplay, existing.followingDisplay) || formatCompactCount(followingCount),
      followersDisplay: preferString(next.followersDisplay, existing.followersDisplay) || formatCompactCount(followersCount),
      sources: compactUniqueList([...(existing.sources || []), ...(next.sources || [])]),
      firstSeenAt: existing.firstSeenAt || timestamp,
      lastSeenAt: timestamp,
      updatedAt: Date.parse(timestamp) || Date.now(),
      observedPosts: mergeObservedPosts(existing.observedPosts, incomingPosts)
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
      observed_posts_count: Array.isArray(user.observedPosts) ? user.observedPosts.length : 0
    };
  }

  function exportUsersToCsv(users) {
    const rows = [EXPORT_FIELDS.join(",")];
    for (const user of users || []) {
      const row = userExportRow(user);
      rows.push(EXPORT_FIELDS.map(field => csvEscape(row[field])).join(","));
    }
    return `${rows.join("\n")}\n`;
  }

  function markdownEscape(value) {
    return String(value || "").replace(/\|/g, "\\|").trim();
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
      bio: readImportColumn(values, "bio", "简介"),
      website: readImportColumn(values, "website", "网站"),
      sources: ["import"]
    };
    assignImportedCount(user, "following", following);
    assignImportedCount(user, "followers", followers);
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

  function assignImportedCount(user, field, value) {
    const text = String(value || "").trim();
    if (!text || text === "-") {
      return;
    }
    const numeric = parseHumanCount(text);
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
      const itemMatch = line.match(/^- \[([^\]]+)\]\(([^)]+)\) - @([A-Za-z0-9_]{1,15})(?: - (.*))?$/);
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
      const linkOnlyMatch = line.match(/^\s*(?:[-*]\s*)?\[([^\]]*)\]\(([^)]+)\)\s*$/);
      if (linkOnlyMatch && usernameFromProfileHref(linkOnlyMatch[2], "https://x.com/")) {
        const title = unescapeMarkdownText(linkOnlyMatch[1]);
        const displayName = normalizeUsername(title) || title.startsWith("@") || /^https?:\/\//i.test(title) ? "" : title;
        pushProfileLink(linkOnlyMatch[2].trim(), displayName);
        continue;
      }
      const rawUrlMatch = line.match(/https?:\/\/(?:x|twitter)\.com\/[^\s)]+/i);
      if (rawUrlMatch && usernameFromProfileHref(rawUrlMatch[0], "https://x.com/")) {
        pushProfileLink(rawUrlMatch[0].trim(), "");
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
    return String(value || "").replace(/\\\|/g, "|").trim();
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
      seenUsers.set(username, record);
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
    collectUserStats,
    classifyStatsSurface,
    exportUsersToCsv,
    exportUsersToMarkdown,
    findNameLinkInAnchors,
    formatCompactCount,
    isStatsAllowedPath,
    mergeObservedUser,
    normalizeDisplaySettings,
    normalizePostKind,
    normalizePostSource,
    normalizeSource,
    normalizeText,
    normalizeUsername,
    parseImportedUsers,
    parseStatsText,
    selectObservedPost,
    userHasCommentSource,
    userHasNonCommentSource,
    userSurfaceSources,
    usernameFromProfileHref
  };
})(globalThis);
