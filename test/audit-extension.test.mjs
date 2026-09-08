import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, after } from 'node:test';
import { chromium, browserOptions } from './browser.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'test-results'), { recursive: true });
const profile = await mkdtemp(path.join(root, 'test-results', 'profile-'));
const context = await chromium.launchPersistentContext(profile, { ...browserOptions, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
after(() => context.close());
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).hostname;
const pageErrors = [];
context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
const CACHE = 'xfs:userStatsCacheV2', RUNS = 'xfs:activeRunsV1';
const read = key => worker.evaluate(async key => (await chrome.storage.local.get(key))[key], key);
async function manager() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/manager/manager.html`);
  await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('users total'));
  return page;
}
const request = (page, action, payload = {}) => page.evaluate(({action, payload}) => XFSStorage.request(action, payload), { action, payload });
test('real MV3 extension: capture, native DOM, manager paging/import, locks, clear', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ 'xfs:languagePreferenceV1': 'en' }));
  await context.route('https://x.com/**', route => {
    if (route.request().url().includes('/i/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rest_id: '1234567890123456789', is_blue_verified: true, legacy: { screen_name: 'alice', name: 'Alice', description: 'bio', friends_count: 12, followers_count: 34 } }) });
    return route.fulfill({ contentType: 'text/html', body: '<main><article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a><a href="/alice">@alice</a></div><div data-testid="tweetText">Hello</div></article></main><script>setTimeout(() => fetch("/i/api/graphql/UserByScreenName"), 100)</script>' });
  });
  const x = await context.newPage(); await x.goto('https://x.com/home');
  await x.waitForFunction(() => document.querySelector('.xfs-stats-pill')?.textContent.includes('12 Following'));
  const a = await manager(), b = await manager();
  await a.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
  assert.equal((await read(CACHE)).alice.userId, '1234567890123456789');
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await popup.locator('label').filter({ has: popup.locator('#feed-toggle') }).click();
  await x.waitForFunction(() => !document.querySelector('.xfs-stats-pill'));
  await x.evaluate(() => fetch('/i/api/graphql/UserByScreenName'));
  assert.equal(await x.locator('article').count(), 1);
  await x.close();
  const accounts = Array.from({ length: 230 }, (_, i) => ({ username: `user${i}`, displayName: `Person ${i}`, profileUrl: `https://x.com/user${i}`, sources: ['import'] }));
  await request(a, 'import', { generation: 0, users: accounts });
  await a.waitForFunction(() => document.querySelectorAll('#rows tr').length === 100);
  await a.evaluate(() => { window.firstRow = document.querySelector('#rows tr'); });
  await a.locator('#rows input[type=checkbox]').first().check();
  assert.equal(await a.evaluate(() => window.firstRow === document.querySelector('#rows tr')), true);
  await a.locator('#next-page').click();
  assert.equal(await a.locator('#page-status').textContent(), 'Page 2 of 3');
  await a.locator('#search').fill('Person 229');
  await a.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
  assert.equal(await a.locator('#page-status').textContent(), 'Page 1 of 1');
  await Promise.all([
    a.locator('#import-file').setInputFiles({ name: 'one.csv', mimeType: 'text/csv', buffer: Buffer.from('profile_url\nhttps://x.com/import_a\n') }),
    b.locator('#import-file').setInputFiles({ name: 'two.csv', mimeType: 'text/csv', buffer: Buffer.from('profile_url\nhttps://x.com/import_b\n') })
  ]);
  await b.waitForFunction(() => document.querySelector('#summary').textContent.includes('233 users total'));
  const records = await read(CACHE); assert.ok(records.import_a && records.import_b);
  await a.locator('#import-file').setInputFiles({ name: 'too-large.csv', mimeType: 'text/csv', buffer: Buffer.from('profile_url,bio\nhttps://x.com/no_save,' + 'x'.repeat(10 * 1024 * 1024) + '\n') });
  await a.waitForFunction(() => document.querySelector('#summary').textContent.includes('Not saved:'));
  assert.equal((await read(CACHE)).no_save, undefined);
  await popup.reload();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('Not saved:'));
  for (const [page, runId] of [[a, 'run-a'], [b, 'run-b']]) {
    await page.evaluate(runId => new Promise(resolve => {
      window.runPort = chrome.runtime.connect({ name: 'xfs:sequential-run' });
      window.runPort.onMessage.addListener(resolve);
      window.runPort.postMessage({ type: 'start', runId });
    }), runId);
  }
  await a.close();
  await b.waitForFunction(async () => Object.keys((await chrome.storage.local.get('xfs:activeRunsV1'))['xfs:activeRunsV1']).length === 1);
  assert.deepEqual(Object.keys(await read(RUNS)), ['run-b']);
  await b.locator('label').filter({ has: b.locator('#lock-list-toggle') }).click();
  await b.evaluate(() => window.runPort.disconnect());
  await b.waitForFunction(async () => Object.keys((await chrome.storage.local.get('xfs:activeRunsV1'))['xfs:activeRunsV1']).length === 0);
  assert.equal((await read('xfs:displaySettingsV1')).updateOnlyExisting, true);
  await popup.locator('#clear').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent === 'Cache cleared.');
  assert.deepEqual(Object.keys(await read(CACHE)), []);
  const stale = await b.evaluate(() => XFSStorage.request('merge', { generation: 0, users: [{ username: 'alice' }] }).then(() => '', error => error.code));
  assert.equal(stale, 'stale_generation');
  assert.deepEqual(pageErrors, []);
  await b.close(); await popup.close();
});
