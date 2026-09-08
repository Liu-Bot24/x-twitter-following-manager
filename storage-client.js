(function installStorageClient(global) {
  "use strict";
  const CACHE_KEY = "xfs:userStatsCacheV2";
  const GENERATION_KEY = "xfs:cacheGenerationV1";
  const RUNS_KEY = "xfs:activeRunsV1";
  const STATUS_KEY = "xfs:storageStatusV1";
  function request(action, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "xfs:storage", action, ...payload }, response => {
        const failure = chrome.runtime.lastError;
        if (failure || !response?.ok) {
          const error = new Error(failure?.message || response?.error || "Storage service unavailable");
          error.code = response?.code || "storage_error";
          reject(error);
        } else resolve(response);
      });
    });
  }
  global.XFSStorage = { CACHE_KEY, GENERATION_KEY, RUNS_KEY, STATUS_KEY, request };
})(globalThis);
