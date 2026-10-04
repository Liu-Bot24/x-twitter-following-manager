(function installXFollowStatsPageHook() {
  "use strict";

  const core = window.XFollowStatsPageCore;
  if (!core || window.__xFollowStatsPageHookLoaded) {
    return;
  }
  window.__xFollowStatsPageHookLoaded = true;

  const SOURCE = core.SOURCE;
  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const pendingUserBatches = [];
  let contentReady = false;
  let captureGeneration = 0;
  const MAX_RESPONSE_BYTES = 12_000_000;

  function postHookReady() {
    window.postMessage({ source: SOURCE, type: "hook-ready" }, window.location.origin);
  }

  function flushPendingUsers() {
    if (!contentReady) {
      return;
    }
    while (pendingUserBatches.length > 0) {
      const batch = pendingUserBatches.shift();
      postUsers(batch.users, batch.sourceUrl, batch.capture);
    }
  }

  window.addEventListener("message", event => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) {
      return;
    }
    if (event.data.type === 'invalidate-captures' && Number.isSafeInteger(event.data.captureGeneration)) {
      captureGeneration = event.data.captureGeneration;
      pendingUserBatches.length = 0;
    }
    if (event.data.type === "content-ready") {
      contentReady = true;
      flushPendingUsers();
    }
  });

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

  const documentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let requestSequence = 0;
  function startCapture() {
    return { generation: captureGeneration, startedAt: Date.now(), documentId, sequence: ++requestSequence };
  }

  function postUsers(users, sourceUrl, capture) {
    if (capture.generation !== captureGeneration || !users || users.length === 0) {
      return;
    }
    if (!contentReady) {
      pendingUserBatches.push({ users, sourceUrl, capture });
      if (pendingUserBatches.length > 100) {
        pendingUserBatches.shift();
      }
      return;
    }
    window.postMessage(
      {
        source: SOURCE,
        type: "users",
        captureGeneration: capture.generation,
        requestStartedAt: capture.startedAt,
        requestSequence: capture.sequence,
        documentId: capture.documentId,
        users,
        sourceUrl: String(sourceUrl || "")
      },
      window.location.origin
    );
  }

  function inspectPayload(payload, sourceUrl, capture) {
    if (capture.generation !== captureGeneration) return;
    try {
      postUsers(core.collectUserStats(payload), sourceUrl, capture);
    } catch {
      // The hook must never affect X's own runtime.
    }
  }

  function inspectJsonText(text, sourceUrl, capture) {
    if (!text || text.length > MAX_RESPONSE_BYTES) {
      return;
    }
    try {
      inspectPayload(JSON.parse(text), sourceUrl, capture);
    } catch {
      // Ignore non-JSON or truncated responses.
    }
  }

  async function inspectResponse(response, sourceUrl, capture) {
    if (capture.generation !== captureGeneration) return;
    const length = Number(response.headers?.get('content-length'));
    if (length > MAX_RESPONSE_BYTES) return;
    const copy = response.clone();
    const reader = copy.body?.getReader();
    if (!reader) return;
    const chunks = [];
    let size = 0, timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5000);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (timedOut) return;
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); return; }
        chunks.push(value);
      }
      const decoder = new TextDecoder();
      const text = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
      inspectJsonText(text, sourceUrl, capture);
    } finally { clearTimeout(timeout); reader.releaseLock(); }
  }

  window.fetch = function xFollowStatsFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
    const capture = startCapture();
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
        void inspectResponse(response, response.url || url, capture).catch(() => {});
      },
      () => {}
    );
    return responsePromise;
  };
  window.fetch.toString = () => originalFetch.toString();

  XMLHttpRequest.prototype.open = function xFollowStatsXhrOpen(method, url) {
    this.__xFollowStatsUrl = typeof url === "string" ? url : url instanceof URL ? url.href : "";
    return originalXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open.toString = () => originalXhrOpen.toString();

  XMLHttpRequest.prototype.send = function xFollowStatsXhrSend() {
    this.__xFollowStatsCapture = startCapture();
    if (!this.__xFollowStatsListening) {
      this.__xFollowStatsListening = true;
      this.addEventListener("load", () => {
        if (!shouldInspectUrl(this.__xFollowStatsUrl)) return;
        try {
          const contentType = this.getResponseHeader && this.getResponseHeader("content-type");
          if (contentType && !contentType.toLowerCase().includes("json")) {
            return;
          }
          if (this.responseType === 'json') {
            inspectPayload(this.response, this.responseURL || this.__xFollowStatsUrl, this.__xFollowStatsCapture);
          } else if ((!this.responseType || this.responseType === 'text') && typeof this.responseText === "string") {
            inspectJsonText(this.responseText, this.responseURL || this.__xFollowStatsUrl, this.__xFollowStatsCapture);
          }
        } catch {
          // Some responseType values make responseText inaccessible.
        }
      });
    }
    return originalXhrSend.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send.toString = () => originalXhrSend.toString();

  postHookReady();
})();
