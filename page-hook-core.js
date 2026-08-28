(function installXFollowStatsPageCore(global) {
  "use strict";

  const SOURCE = "x-follow-stats-extension";
  const MAX_GRAPH_DEPTH = 18;
  const MAX_GRAPH_NODES = 12000;
  const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

  function normalizeUsername(value) {
    if (typeof value !== "string") {
      return "";
    }
    const username = value.trim().replace(/^@/, "");
    return USERNAME_RE.test(username) ? username.toLowerCase() : "";
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

  function formatCompactCount(count) {
    const numeric = toFiniteNumber(count);
    if (numeric === null) {
      return "";
    }
    try {
      return new Intl.NumberFormat("zh-CN", {
        maximumFractionDigits: numeric >= 10000 ? 1 : 0,
        notation: "compact"
      }).format(numeric);
    } catch {
      return String(numeric);
    }
  }

  function readExpandedWebsite(legacy) {
    const urls = legacy && legacy.entities && legacy.entities.url && legacy.entities.url.urls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return "";
    }
    const first = urls[0];
    return String(first.expanded_url || first.display_url || first.url || "");
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
      seenUsers.set(username, {
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
      });
    }

    function visit(value, depth) {
      if (!value || depth > MAX_GRAPH_DEPTH || nodeCount > MAX_GRAPH_NODES || typeof value !== "object") {
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
      const children = Array.isArray(value) ? value : Object.values(value);
      for (const item of children) {
        visit(item, depth + 1);
      }
    }

    visit(payload, 0);
    users.push(...seenUsers.values());
    return users;
  }

  global.XFollowStatsPageCore = { SOURCE, collectUserStats };
})(globalThis);
