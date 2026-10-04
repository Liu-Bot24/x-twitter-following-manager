import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, after } from 'node:test';
import { chromium, browserOptions } from './browser.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'test-results'), { recursive: true });
const profile = await mkdtemp(path.join(root, 'test-results', 'integrity-'));
const context = await chromium.launchPersistentContext(profile, { ...browserOptions, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
after(() => context.close());
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).hostname;
console.info('Audit Chromium version:', context.browser().version());
const CACHE = 'xfs:userStatsCacheV2';
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const read = () => worker.evaluate(async key => (await chrome.storage.local.get(key))[key], CACHE);
const request = (page, action, payload = {}) => page.evaluate(({ action, payload }) => XFSStorage.request(action, payload), { action, payload });
async function manager() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/manager/manager.html`);
  await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('users total'));
  return page;
}
async function upload(page, text) {
  await page.locator('#import-file').setInputFiles({ name: 'audit.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
}
async function download(page, locator) {
  const waiting = page.waitForEvent('download');
  await locator.click();
  return readFile(await (await waiting).path(), 'utf8');
}

// Chromium 151 + Playwright 1.62.1 can leave an extension-created tab's
// first intercepted navigation pending before context.route receives it.
// Adapt only tab creation to Playwright's supported creation path. The manager,
// content scripts, service worker, storage, downloads and DOM remain real.
// Native chrome.tabs.create navigation is explicitly not certified by this test.
const adaptedPages = new WeakSet();
async function adaptTabCreation(page) {
  if (!adaptedPages.has(page)) {
    await page.exposeFunction('openFixtureTab', async options => {
      assert.equal(new URL(options.url).hostname, 'x.com');
      const opened = await context.newPage();
      await opened.goto(options.url);
      return worker.evaluate(async url => (await chrome.tabs.query({ url })).at(-1), options.url);
    });
    adaptedPages.add(page);
  }
  await page.evaluate(() => {
    window.tabCreateCalls = [];
    chrome.tabs.create = (options, callback) => {
      tabCreateCalls.push(options);
      const result = openFixtureTab(options);
      if (callback) void result.then(callback);
      return result;
    };
  });
}

test('R1/R2/R3/R5/C1: real manager import, missing selection, DOM update, exports and identity history', { timeout: 45000 }, async () => {
  await worker.evaluate(() => chrome.storage.local.set({ 'xfs:languagePreferenceV1': 'en' }));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.hostname !== 'x.com') return route.abort();
    const username = url.pathname.slice(1);
    return route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8"><main><div data-testid="UserName">${username}</div><div><a href="/${username}/following">1\u202f234 Abonnements</a> <a href="/${username}/followers">5\u00a0678 Abonnés</a></div></main>` });
  });
  const page = await manager();
  const header = 'profile_url,user_id,display_name,following_count,followers_count,first_seen_at,last_seen_at,latest_post_text,latest_post_url\n';
  await upload(page, header + 'https://x.com/alice,111,Old owner,unknown,n/a,2026-09-01T00:00:00Z,2026-10-01T00:00:00Z,Old owner post,https://x.com/alice/status/777\nhttps://x.com/bob,,Bob,,,,,,\nhttps://x.com/zero,,Zero,0,0,,,,\njavascript://x.com/unsafe#%0Aalert(1),,Unsafe,1,1,,,,\n');
  await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 3);
  assert.equal((await read()).unsafe, undefined);
  await page.locator('#select-missing').click();
  assert.equal(await page.locator('#rows input:checked').count(), 2);
  assert.equal(await page.locator('tr[data-username="zero"] input').isChecked(), false);
  await page.locator('#clear-selection').click();
  await page.locator('tr[data-username="bob"] input').check();
  await adaptTabCreation(page);
  await page.locator('#sequential-update').click();
  await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('Updated and saved 1 of 1'));
  const bob = (await read()).bob;
  assert.equal(bob.followingCount, 1234); assert.equal(bob.followersCount, 5678);
  assert.equal(bob.followingPrecision, 'exact');
  const csv = await download(page, page.locator('#export'));
  const exported = await page.evaluate(text => XFollowStatsCore.parseImportedUsers(text, 'export.csv'), csv);
  assert.equal(exported[0].followersCount, 5678); assert.equal(exported[0].followersPrecision, 'exact');

  await upload(page, header + 'https://x.com/alice,222,New owner,10,50,2026-10-02T00:00:00Z,2026-10-02T00:00:00Z,New owner post,https://x.com/alice/status/888\n');
  await page.waitForFunction(() => document.querySelector('tr[data-username="alice"] summary')?.textContent === 'Previous identities (1)');
  let alice = (await read()).alice;
  assert.equal(alice.userId, '222'); assert.equal(alice.observedPosts.length, 1);
  assert.equal(alice.observedPosts[0].text, 'New owner post');
  assert.equal(alice.identityHistory[0].userId, '111');
  await page.locator('tr[data-username="alice"] summary').click();
  const archive = JSON.parse(await download(page, page.getByRole('button', { name: 'Export identity history (JSON)' })));
  assert.equal(archive[0].observedPosts[0].text, 'Old owner post');
  assert.equal(archive[0].firstSeenAt, '2026-09-01T00:00:00.000Z');
  await upload(page, header + 'https://x.com/alice,222,New owner,10,50,2026-09-15T00:00:00Z,2026-09-20T00:00:00Z,,\n');
  await page.waitForFunction(async () => (await XFSStorage.request('read')).cache.alice.firstSeenAt.startsWith('2026-09-15'));
  alice = (await read()).alice;
  assert.equal(alice.lastSeenAt, '2026-10-02T00:00:00.000Z');
  await page.locator('#clear-selection').click();
  await page.locator('tr[data-username="alice"] input').check();
  const currentCsv = await download(page, page.locator('#export'));
  assert.ok(currentCsv.includes('New owner post')); assert.ok(!currentCsv.includes('Old owner post'));

  // Old stored links are also validated at every navigation/render boundary.
  await worker.evaluate(async key => {
    const data = (await chrome.storage.local.get(key))[key];
    data.bob.profileUrl = 'javascript://x.com/bob#%0Aalert(1)';
    data.bob.observedPosts = [{ id: '1', text: 'Unsafe link', url: 'javascript://x.com/bob/status/1' }];
    await chrome.storage.local.set({ [key]: data });
  }, CACHE);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('tr[data-username="bob"] .user-identity a')?.href === 'https://x.com/bob');
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  await page.locator('#clear-selection').click();
  await page.locator('tr[data-username="bob"] input').check();
  await adaptTabCreation(page);
  const opening = context.waitForEvent('page');
  await page.locator('#open-selected-profiles').click();
  const opened = await opening; await opened.waitForURL('https://x.com/bob');
  assert.equal(await page.evaluate(() => tabCreateCalls.at(-1).url), 'https://x.com/bob');
  await opened.close();
  await page.locator('tr[data-username="alice"] summary').click();
  await mkdir(path.join(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'output/playwright/audit-integrity-manager.png'), fullPage: true });
  assert.deepEqual(errors, []);
  for (const tab of context.pages()) await tab.close();
});

test('R4: real hook and service worker retain a newer decreasing snapshot after an older response arrives', { timeout: 20000 }, async () => {
  let oldRoute, oldArrived;
  const waiting = new Promise(resolve => { oldArrived = resolve; });
  const payload = count => ({ rest_id: '111', legacy: { screen_name: 'alice', friends_count: 12, followers_count: count } });
  await context.unrouteAll({ behavior: 'wait' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.hostname !== 'x.com') return route.abort();
    if (url.pathname.endsWith('/Older')) { oldRoute = route; oldArrived(); return; }
    if (url.pathname.endsWith('/Newer')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload(50)) });
    return route.fulfill({ contentType: 'text/html', body: '<main></main>' });
  });
  const page = await manager();
  await request(page, 'clear');
  const x = await context.newPage(); await x.goto('https://x.com/home');
  await x.evaluate(() => { window.captures = []; addEventListener('message', event => { if (event.data?.type === 'users') captures.push(event.data); }); });
  const old = x.evaluate(() => fetch('/i/api/graphql/Older').then(response => response.json()));
  await waiting;
  await x.evaluate(() => fetch('/i/api/graphql/Newer').then(response => response.json()));
  await x.waitForFunction(() => captures.length === 1);
  await oldRoute.fulfill({ contentType: 'application/json', body: JSON.stringify(payload(100)) });
  await old;
  await x.waitForFunction(() => captures.length === 2);
  await page.waitForFunction(async () => (await XFSStorage.request('read')).cache.alice?.followersCount === 50);
  await x.close();
  await page.reload();
  await page.waitForFunction(() => Boolean(window.XFSStorage));
  const alice = (await read()).alice;
  assert.equal(alice.followersCount, 50); assert.equal(alice.statsCapture.sequence, 2);
  assert.equal(alice.statsUpdatedAt, alice.statsCapture.startedAt);
  assert.ok(alice.statsReceivedAt >= alice.statsUpdatedAt);
  assert.deepEqual(errors, []);
  await page.close();
});
