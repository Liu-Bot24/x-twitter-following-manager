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
