/* All account-cache mutations are serialized here, including import and clear. */
importScripts("stats-core.js");
(function installStorageService() {
  "use strict";
  const core = globalThis.XFollowStatsCore;
  const CACHE_KEY = "xfs:userStatsCacheV2";
  const GENERATION_KEY = "xfs:cacheGenerationV1";
  const CLEARED_AT_KEY = "xfs:cacheClearedAtV1";
  const RUNS_KEY = "xfs:activeRunsV1";
  const STATUS_KEY = "xfs:storageStatusV1";
  const SETTINGS_KEY = "xfs:displaySettingsV1";
  const BUDGET_BYTES = 9 * 1024 * 1024;
  const runs = new Map();
  const ports = new Set();
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  function storageCall(method, value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local[method](value, result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }
  // A worker restart disconnects the old owners. No permanent preference is changed.
  let queue = storageCall("set", { [RUNS_KEY]: {} });
  function enqueue(operation) {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  }
  function extensionPage(sender) {
    return Boolean(sender?.url?.startsWith(chrome.runtime.getURL("")));
  }
  function generationOf(data) {
    return Number.isSafeInteger(data[GENERATION_KEY]) ? data[GENERATION_KEY] : 0;
  }
  async function operate(message, sender) {
    const data = await storageCall("get", [CACHE_KEY, GENERATION_KEY, CLEARED_AT_KEY, SETTINGS_KEY, STATUS_KEY]);
    let cache = core.reconcileUserCaches({}, data[CACHE_KEY]).cache;
    const generation = generationOf(data);
    if (message.action === 'status') return { count: Object.keys(cache).length, status: data[STATUS_KEY] || {}, bytesUsed: await storageCall('getBytesInUse', null), budgetBytes: BUDGET_BYTES };
    if (message.action === "read") {
      return { cache, generation, clearedAt: data[CLEARED_AT_KEY] || 0, runs: Object.fromEntries(runs), status: data[STATUS_KEY] || {}, bytesUsed: await storageCall("getBytesInUse", null), budgetBytes: BUDGET_BYTES };
    }
    if (message.action === "clear") {
      if (!extensionPage(sender)) throw new Error("Only extension pages can clear the account cache");
      await storageCall("set", { [CACHE_KEY]: {}, [GENERATION_KEY]: generation + 1, [CLEARED_AT_KEY]: Date.now(), [STATUS_KEY]: { savedAt: Date.now(), error: "" } });
      return { generation: generation + 1 };
    }
    if (!["merge", "import"].includes(message.action)) throw new Error("Unknown storage operation");
    if (message.action === "import" && !extensionPage(sender)) throw new Error("Only extension pages can import accounts");
    if (message.generation !== generation) {
      const error = new Error("The cache was cleared. Reload data before saving again.");
      error.code = "stale_generation";
      throw error;
    }
    if (!Array.isArray(message.users)) throw new Error("Expected account records");
    const locked = core.normalizeDisplaySettings(data[SETTINGS_KEY]).updateOnlyExisting || runs.size > 0;
    const now = new Date().toISOString();
    const rejectedUsernames = [];
    for (const record of message.users) {
      const username = core.normalizeUsername(record?.username);
      if (!username) continue;
      if (message.action !== "import" && locked && !Object.hasOwn(cache, username)
        && !(record.userId && Object.values(cache).some(user => user.userId === record.userId))) { rejectedUsernames.push(username); continue; }
      const existing = cache[username];
      cache[username] = message.action === 'import'
        ? core.mergeImportedUser(existing, { ...record, username }, now)
        : core.mergeCachedUserRecords(existing, { ...record, username });
    }
    cache = core.reconcileUserCaches({}, cache).cache;
    const oldBytes = bytes(data[CACHE_KEY] || {});
    const cacheBytes = bytes(cache);
    const totalBytes = await storageCall("getBytesInUse", null);
    if (totalBytes - oldBytes + cacheBytes > BUDGET_BYTES && cacheBytes > oldBytes) {
      const error = new Error("Storage is nearly full. Export your accounts, then clear unneeded data before retrying.");
      error.code = "storage_capacity";
      throw error;
    }
    await storageCall("set", { [CACHE_KEY]: cache, [STATUS_KEY]: { savedAt: Date.now(), error: "", cacheBytes } });
    return { generation, saved: true, cacheBytes, rejectedUsernames };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "xfs:storage") return false;
    enqueue(async () => {
      try { respond({ ok: true, ...await operate(message, sender) }); }
      catch (error) {
        if (error.code !== "stale_generation") {
          try { await storageCall("set", { [STATUS_KEY]: { error: error.message, code: error.code || "storage_error", failedAt: Date.now() } }); }
          catch { /* The original failure is still returned even when status cannot be stored. */ }
        }
        respond({ ok: false, error: error.message, code: error.code || "storage_error" });
      }
    });
    return true;
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== "xfs:sequential-run" || !extensionPage(port.sender)) return;
    ports.add(port);
    let runId = "";
    port.onMessage.addListener(message => {
      if (message?.type === "heartbeat") return;
      if (message?.type !== "start" || runId || typeof message.runId !== "string") return;
      runId = message.runId;
      enqueue(async () => {
        if (!ports.has(port)) return;
        runs.set(runId, { startedAt: Date.now() });
        try {
          await storageCall("set", { [RUNS_KEY]: Object.fromEntries(runs) });
          port.postMessage({ ok: true, runId });
        } catch (error) {
          runs.delete(runId);
          await storageCall("set", { [RUNS_KEY]: Object.fromEntries(runs) });
          if (ports.has(port)) {
            try { port.postMessage({ ok: false, error: error.message }); }
            catch { /* The owner closed while the response was being delivered. */ }
          }
        }
      });
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      enqueue(async () => {
        runs.delete(runId);
        await storageCall("set", { [RUNS_KEY]: Object.fromEntries(runs) });
      }).catch(() => {});
    });
  });
})();
