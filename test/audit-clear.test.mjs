import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, after } from 'node:test';
import { chromium, browserOptions } from './browser.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'test-results'), { recursive: true });
const profile = await mkdtemp(path.join(root, 'test-results', 'clear-'));
const context = await chromium.launchPersistentContext(profile, { ...browserOptions, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
after(() => context.close());
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).hostname;
for (const responseTiming of ['before read', 'after read']) test(`a new page preserves post-clear requests with response ${responseTiming}`, { timeout: 15000 }, async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'xfs:userStatsCacheV2': {}, 'xfs:cacheGenerationV1': 7, 'xfs:cacheClearedAtV1': Date.now() - 60000 });
    const original = chrome.storage.local.getBytesInUse.bind(chrome.storage.local);
    chrome.storage.local.getBytesInUse = (keys, callback) => original(keys, result => {
      chrome.storage.local.getBytesInUse = original;
      globalThis.releaseInitialRead = () => { globalThis.releaseInitialRead = null; callback(result); };
    });
  });
  let respond, requestArrived;
  const arrived = new Promise(resolve => { requestArrived = resolve; });
  await context.route('https://x.com/**', route => {
    const fulfill = () => route.fulfill({
    contentType: route.request().url().includes('/i/api/') ? 'application/json' : 'text/html',
    body: route.request().url().includes('/i/api/') ? JSON.stringify({ legacy: { screen_name: 'startup', friends_count: 12, followers_count: 34 } }) : '<main></main>'
    });
    if (responseTiming === 'after read' && route.request().url().includes('/i/api/')) { respond = fulfill; requestArrived(); return; }
    return fulfill();
  });
  const x = await context.newPage();
  try {
    await x.goto('https://x.com/startup');
    const request = x.evaluate(() => fetch('/i/api/graphql/Startup').then(response => response.json()));
    if (responseTiming === 'before read') await request;
    else await arrived;
    await x.waitForTimeout(100);
    await worker.evaluate(() => globalThis.releaseInitialRead());
    if (responseTiming === 'after read') {
      await x.waitForTimeout(100);
      await respond();
      await request;
    }
    await x.waitForTimeout(900);
    const cache = await worker.evaluate(async () => (await chrome.storage.local.get('xfs:userStatsCacheV2'))['xfs:userStatsCacheV2']);
    assert.equal(cache.startup?.followingCount, 12, 'The first request from a new page is newer than the previous clear');
  } finally {
    await worker.evaluate(() => globalThis.releaseInitialRead?.());
    await x.close();
  }
});
test('a network response started before clear cannot repopulate the cleared cache', async () => {
  let delayedRoute, releaseRequest;
  const requested = new Promise(resolve => { releaseRequest = resolve; });
  await context.route('https://x.com/**', route => {
    if (route.request().url().includes('/i/api/')) { delayedRoute = route; releaseRequest(); return; }
    return route.fulfill({ contentType: 'text/html', body: '<main></main>' });
  });
  const x = await context.newPage(); await x.goto('https://x.com/home');
  const manager = await context.newPage(); await manager.goto(`chrome-extension://${id}/manager/manager.html`);
  await manager.waitForFunction(() => Boolean(window.XFSStorage));
  const resultPromise = x.evaluate(() => fetch('/i/api/graphql/Delayed').then(response => response.json()));
  await requested;
  await manager.evaluate(() => XFSStorage.request('clear'));
  await manager.waitForFunction(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://x.com/home' });
    return (await chrome.tabs.sendMessage(tab.id, { type: 'xfs:status' })).status.cachedUsers === 0;
  });
  const payload = { legacy: { screen_name: 'alice', friends_count: 12, followers_count: 34 } };
  await delayedRoute.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  assert.deepEqual(await resultPromise, payload, 'The native Fetch response must remain intact');
  await x.waitForTimeout(1000);
  const cache = await worker.evaluate(async () => (await chrome.storage.local.get('xfs:userStatsCacheV2'))['xfs:userStatsCacheV2']);
  assert.deepEqual(Object.keys(cache), [], 'Pre-clear capture must not acquire the new storage generation');
  // A request actually started after clear remains eligible.
  const nextRequested = new Promise(resolve => { releaseRequest = resolve; });
  const nextPromise = x.evaluate(() => fetch('/i/api/graphql/Next').then(response => response.json()));
  await nextRequested;
  await delayedRoute.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  await nextPromise;
  await manager.waitForFunction(async () => Boolean((await chrome.storage.local.get('xfs:userStatsCacheV2'))['xfs:userStatsCacheV2'].alice));
});
test('closing a page after capture preserves counts pending the persistence debounce', async () => {
  const manager = await context.newPage(); await manager.goto(`chrome-extension://${id}/manager/manager.html`);
  await manager.waitForFunction(() => Boolean(window.XFSStorage));
  await manager.evaluate(() => XFSStorage.request('clear'));
  await context.route('https://x.com/**', route => route.fulfill({ contentType: route.request().url().includes('/i/api/') ? 'application/json' : 'text/html', body: route.request().url().includes('/i/api/') ? JSON.stringify({ legacy: { screen_name: 'bob', friends_count: 12, followers_count: 34 } }) : '<main></main>' }));
  const x = await context.newPage(); await x.goto('https://x.com/lifecycle');
  await x.evaluate(() => fetch('/i/api/graphql/Lifecycle').then(response => response.json()));
  await manager.waitForFunction(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://x.com/lifecycle' });
    return (await chrome.tabs.sendMessage(tab.id, { type: 'xfs:status' })).status.cachedUsers === 1;
  });
  await x.close();
  await manager.waitForTimeout(800);
  const cache = await worker.evaluate(async () => (await chrome.storage.local.get('xfs:userStatsCacheV2'))['xfs:userStatsCacheV2']);
  assert.ok(cache.bob, 'Captured counts should survive closing the page');
});
test('page-close flush includes a new observation while the previous write callback is pending', async () => {
  const manager = await context.newPage(); await manager.goto(`chrome-extension://${id}/manager/manager.html`);
  await manager.waitForFunction(() => Boolean(window.XFSStorage));
  await manager.evaluate(() => XFSStorage.request('clear'));
  await worker.evaluate(() => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    let first = true, notify;
    globalThis.firstWriteStarted = new Promise(resolve => { notify = resolve; });
    chrome.storage.local.set = (values, callback) => originalSet(values, () => {
      if (first && values['xfs:userStatsCacheV2']?.bob?.followingCount === 12) {
        first = false;
        globalThis.releaseWrite = () => { chrome.storage.local.set = originalSet; callback(); };
        notify();
      } else callback();
    });
  });
  let count = 12;
  await context.route('https://x.com/**', route => route.fulfill({ contentType: route.request().url().includes('/i/api/') ? 'application/json' : 'text/html', body: route.request().url().includes('/i/api/') ? JSON.stringify({ legacy: { screen_name: 'bob', friends_count: count, followers_count: 34 } }) : '<main></main>' }));
  const x = await context.newPage(); await x.goto('https://x.com/closing');
  await x.evaluate(() => fetch('/i/api/graphql/Lifecycle').then(response => response.json()));
  await worker.evaluate(() => globalThis.firstWriteStarted);
  count = 25;
  await x.evaluate(() => fetch('/i/api/graphql/Lifecycle').then(response => response.json()));
  await manager.waitForFunction(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://x.com/closing' });
    return (await chrome.tabs.sendMessage(tab.id, { type: 'xfs:status' })).status.fromApi === 2;
  });
  await x.close();
  await worker.evaluate(() => globalThis.releaseWrite());
  await manager.waitForTimeout(800);
  const cache = await worker.evaluate(async () => (await chrome.storage.local.get('xfs:userStatsCacheV2'))['xfs:userStatsCacheV2']);
  assert.equal(cache.bob.followingCount, 25);
});
