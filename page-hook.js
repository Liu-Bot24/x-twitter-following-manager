(function installXFollowStatsPageHook() {
  "use strict";

  const core = window.XFollowStatsCore;
  if (!core || window.__xFollowStatsPageHookLoaded) {
    return;
  }
  window.__xFollowStatsPageHookLoaded = true;

  const SOURCE = core.SOURCE;
  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  function shouldInspectUrl(url) {
    if (!url || typeof url !== "string") {
      return false;
    }
    const normalized = url.toLowerCase();
    if (!normalized.includes("/i/api/")) {
      return false;
    }
    if (normalized.includes("/graphql/")) {
      return true;
    }
    return normalized.includes("user") || normalized.includes("follow");
  }

  function postUsers(users, sourceUrl) {
    if (!users || users.length === 0) {
      return;
    }
    window.postMessage(
      {
        source: SOURCE,
        type: "users",
        users,
        sourceUrl: String(sourceUrl || "")
      },
      window.location.origin
    );
  }

  function inspectPayload(payload, sourceUrl) {
    try {
      postUsers(core.collectUserStats(payload), sourceUrl);
    } catch {
      // The hook must never affect X's own runtime.
    }
  }

  function inspectJsonText(text, sourceUrl) {
    if (!text || text.length > 12_000_000) {
      return;
    }
    try {
      inspectPayload(JSON.parse(text), sourceUrl);
    } catch {
      // Ignore non-JSON or truncated responses.
    }
  }

  window.fetch = function xFollowStatsFetch(input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const responsePromise = originalFetch.apply(this, arguments);
    if (!shouldInspectUrl(url)) {
      return responsePromise;
    }

    responsePromise.then(
      response => {
        const contentType = response.headers && response.headers.get("content-type");
        if (contentType && !contentType.toLowerCase().includes("json")) {
          return;
        }
        response
          .clone()
          .json()
          .then(payload => inspectPayload(payload, response.url || url))
          .catch(() => {});
      },
      () => {}
    );
    return responsePromise;
  };
  window.fetch.toString = () => originalFetch.toString();

  XMLHttpRequest.prototype.open = function xFollowStatsXhrOpen(method, url) {
    this.__xFollowStatsUrl = typeof url === "string" ? url : "";
    return originalXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open.toString = () => originalXhrOpen.toString();

  XMLHttpRequest.prototype.send = function xFollowStatsXhrSend() {
    if (shouldInspectUrl(this.__xFollowStatsUrl)) {
      this.addEventListener("load", () => {
        try {
          const contentType = this.getResponseHeader && this.getResponseHeader("content-type");
          if (contentType && !contentType.toLowerCase().includes("json")) {
            return;
          }
          if (typeof this.responseText === "string") {
            inspectJsonText(this.responseText, this.responseURL || this.__xFollowStatsUrl);
          }
        } catch {
          // Some responseType values make responseText inaccessible.
        }
      });
    }
    return originalXhrSend.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send.toString = () => originalXhrSend.toString();
})();
