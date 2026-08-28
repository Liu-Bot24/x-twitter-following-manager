import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const coreSource = await readFile(new URL("../stats-core.js", import.meta.url), "utf8");
const pageCoreSource = await readFile(new URL("../page-hook-core.js", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../page-hook.js", import.meta.url), "utf8");
const i18nSource = await readFile(new URL("../i18n.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../content.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

const hydrateStart = contentSource.indexOf("async function hydrateFromHover");
const hydrateEnd = contentSource.indexOf("async function runHoverAttempt", hydrateStart);
const hydrateSource = contentSource.slice(hydrateStart, hydrateEnd);
assert.ok(hydrateStart >= 0 && hydrateEnd > hydrateStart);
assert.ok(
  hydrateSource.indexOf('mode: "background"') < hydrateSource.indexOf('mode: "fallback"'),
  "Background reading must run before automatic compatibility fallback"
);
const attemptStart = contentSource.indexOf("async function runHoverAttempt");
const attemptEnd = contentSource.indexOf("function applyHoverOutcome", attemptStart);
const attemptSource = contentSource.slice(attemptStart, attemptEnd);
assert.ok(
  attemptSource.indexOf("createHoverOutcomeWatcher") < attemptSource.indexOf("triggerHover(target, hidden)"),
  "HoverCard/network observation must start before synthetic hover is dispatched"
);
assert.doesNotMatch(
  hydrateSource,
  /waitForCachedStats\(profile\.username,\s*2200/,
  "DOM observation must not start after a serial 2.2s cache wait"
);
assert.match(contentSource, /new MutationObserver\(check\)/);
assert.match(contentSource, /observer\.observe\(root,[\s\S]*?characterData:\s*true[\s\S]*?childList:\s*true/);
assert.match(contentSource, /scheduleDeferredHover\(item\.profile,\s*item\.cell,\s*item\.surface,\s*"not-idle"\)/);
assert.match(contentSource, /hoverDiagnostics:\s*state\.hoverDiagnostics\.slice\(-50\)/);

const messages = [];
let jsonCalls = 0;
const payload = {
  data: {
    user: {
      result: {
        legacy: {
          screen_name: "quiet_user",
          friends_count: 12,
          followers_count: 34
        }
      }
    }
  }
};

class FakeXhr {
  addEventListener() {}
  getResponseHeader() {
    return "application/json";
  }
}
FakeXhr.prototype.open = function open() {};
FakeXhr.prototype.send = function send() {};

const sandbox = {
  console,
  XMLHttpRequest: FakeXhr,
  location: { origin: "https://x.com" },
  fetch(input) {
    const url = typeof input === "string" ? input : input.url;
    return Promise.resolve({
      url,
      headers: { get: () => "application/json" },
      clone() {
        return this;
      },
      json: () => {
        jsonCalls += 1;
        return Promise.resolve(payload);
      }
    });
  },
  __messages: messages
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  `
    window.__listeners = {};
    window.addEventListener = (type, listener) => {
      (window.__listeners[type] ||= []).push(listener);
    };
    window.postMessage = data => {
      window.__messages.push(data);
      for (const listener of window.__listeners.message || []) {
        listener({ source: window, data });
      }
    };
  `,
  sandbox
);
vm.runInContext(coreSource, sandbox);
vm.runInContext(pageCoreSource, sandbox);
vm.runInContext(hookSource, sandbox);

assert.equal(sandbox.XFollowStatsCore.collectUserStats(payload).length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(sandbox.XFollowStatsPageCore.collectUserStats(payload))),
  JSON.parse(JSON.stringify(sandbox.XFollowStatsCore.collectUserStats(payload)))
);
assert.equal(sandbox.XFollowStatsPageCore.SOURCE, sandbox.XFollowStatsCore.SOURCE);
for (const variant of [
  { core: { user_results: { result: { rest_id: "9", legacy: { screen_name: "nested_user", friends_count: "0", normal_followers_count: "1,234" } } } } },
  { user_results: { result: { legacy: { screen_name: "display_user", following_count: 44, followers_count: 55 } } } },
  { legacy: { screen_name: "missing_counts" } }
]) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.XFollowStatsPageCore.collectUserStats(variant))),
    JSON.parse(JSON.stringify(sandbox.XFollowStatsCore.collectUserStats(variant)))
  );
}
assert.ok(messages.some(message => message.type === "hook-ready"));
await sandbox.fetch("https://x.com/i/api/graphql/UserByScreenName");
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));
assert.equal(jsonCalls, 1);
assert.equal(messages.some(message => message.type === "users"), false);

sandbox.postMessage({ source: sandbox.XFollowStatsCore.SOURCE, type: "content-ready" });
await new Promise(resolve => setTimeout(resolve, 10));
const usersMessage = messages.find(message => message.type === "users");
assert.ok(usersMessage, JSON.stringify(messages));
assert.equal(usersMessage.users.length, 1);
assert.equal(usersMessage.users[0].username, "quiet_user");
assert.equal(usersMessage.users[0].followingCount, 12);
assert.equal(usersMessage.users[0].followersCount, 34);

const usersMessageCount = messages.filter(message => message.type === "users").length;
await sandbox.fetch("https://x.com/not-an-api-response");
await new Promise(resolve => setImmediate(resolve));
assert.equal(messages.filter(message => message.type === "users").length, usersMessageCount);

const isolatedListeners = new Map();
const isolatedSandbox = {
  console,
  Date,
  Intl,
  Map,
  Promise,
  Set,
  URL,
  clearTimeout,
  setTimeout,
  location: {
    href: "https://x.com/home",
    origin: "https://x.com",
    pathname: "/home"
  },
  CSS: { escape: value => String(value) },
  MutationObserver: class MutationObserver {
    observe() {}
    disconnect() {}
  },
  IntersectionObserver: class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  document: {
    activeElement: null,
    body: {},
    documentElement: { dataset: {} },
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; }
  },
  chrome: {
    runtime: {
      onMessage: { addListener() {}, removeListener() {} }
    },
    storage: {
      local: {
        get(key, callback) { callback({}); },
        set() { return Promise.resolve(); }
      },
      onChanged: { addListener() {}, removeListener() {} }
    }
  },
  addEventListener(type, listener) {
    const listeners = isolatedListeners.get(type) || [];
    listeners.push(listener);
    isolatedListeners.set(type, listeners);
  },
  removeEventListener(type, listener) {
    const listeners = isolatedListeners.get(type) || [];
    isolatedListeners.set(type, listeners.filter(item => item !== listener));
  },
  postMessage() {}
};
isolatedSandbox.window = isolatedSandbox;
isolatedSandbox.globalThis = isolatedSandbox;
vm.createContext(isolatedSandbox);
const isolatedSources = {
  "stats-core.js": coreSource,
  "i18n.js": i18nSource,
  "content.js": contentSource
};
for (const filename of manifest.content_scripts[1].js) {
  vm.runInContext(isolatedSources[filename], isolatedSandbox, { filename });
}
await new Promise(resolve => setTimeout(resolve, 10));
assert.ok(isolatedSandbox.XFollowStatsCore);
assert.ok(isolatedSandbox.XFSI18n);
assert.equal(typeof isolatedSandbox.__xFollowStatsContentCleanup, "function");
isolatedSandbox.__xFollowStatsContentCleanup();
