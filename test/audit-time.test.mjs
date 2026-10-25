import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, after } from 'node:test';
import { chromium, browserOptions } from './browser.mjs';

const browser = await chromium.launch(browserOptions);
after(() => browser.close());
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const [core, storage, i18n, content, css, popup, popupScript] = await Promise.all(
  ['stats-core.js', 'storage-client.js', 'i18n.js', 'content.js', 'content.css', 'popup/popup.html', 'popup/popup.js'].map(read)
);
const settings = { feed: false, userList: true, updateOnlyExisting: true, convertTzEnabled: true, convertTzOffset: 8, targetDiffEnabled: true, targetDiffTzOffset: 12, targetDiffTime: '2026-10-25T14:00' };

async function contentFixture() {
  const page = await browser.newPage();
  await page.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<style>[role=tooltip]{max-width:180px;white-space:normal}</style><main><a href="/alice/status/1"><time datetime="2026-10-24T19:21:00Z">Oct 24</time></a><div role="tooltip" id="time-tip">7:21 PM · Oct 24, 2026</div><div role="tooltip" id="other-tip">Copy link</div></main>' }));
  await page.goto('https://x.com/home');
  await page.evaluate(() => {
    const event = { addListener() {}, removeListener() {} };
    window.chrome = { runtime: { onMessage: event, sendMessage(message, callback) { callback({ ok: true, cache: {}, generation: 0, runs: {}, status: {} }); } }, storage: { onChanged: event, local: {
      get(key, callback) { callback({ 'xfs:languagePreferenceV1': 'en' }); }, set(data, callback) { callback?.(); }
    } } };
  });
  for (const script of [core, storage, i18n]) await page.addScriptTag({ content: script });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: content.replace(/\}\)\(\);\s*$/, 'window.audit = { state, refreshTimestampTooltips, cleanup }; })();') });
  await page.waitForFunction(() => audit.state.initialized && audit.state.mutationObserver);
  await page.evaluate(settings => { audit.state.settings = settings; }, settings);
  await page.locator('time').hover();
  await page.waitForFunction(() => document.querySelector('.xfs-time-tooltip-extra'));
  return page;
}

const tooltipState = page => page.locator('#time-tip').evaluate(el => ({ text: el.textContent, marker: el.hasAttribute('data-xfs-time-tooltip'), whiteSpace: getComputedStyle(el).whiteSpace, maxWidth: getComputedStyle(el).maxWidth, extras: el.querySelectorAll('.xfs-time-tooltip-extra').length }));

test('timestamp options render independently and disabling both restores the native tooltip', async () => {
  const page = await contentFixture();
  try {
    assert.match((await tooltipState(page)).text, /UTC\+8 3:21 AM.*\+6h 39m/);
    assert.equal(await page.locator('#other-tip').getAttribute('data-xfs-time-tooltip'), null);
    await page.evaluate(() => { audit.state.settings.targetDiffEnabled = false; audit.refreshTimestampTooltips(); });
    assert.match((await tooltipState(page)).text, /UTC\+8/);
    assert.doesNotMatch((await tooltipState(page)).text, /\+6h/);
    await page.evaluate(() => { audit.state.settings.convertTzEnabled = false; audit.refreshTimestampTooltips(); });
    assert.deepEqual(await tooltipState(page), { text: '7:21 PM · Oct 24, 2026', marker: false, whiteSpace: 'normal', maxWidth: '180px', extras: 0 });
    assert.equal(await page.locator('time').getAttribute('datetime'), '2026-10-24T19:21:00Z');
  } finally { await page.close(); }
});

test('an empty target and content cleanup both remove timestamp styling without changing native text', async () => {
  const page = await contentFixture();
  try {
    await page.evaluate(() => { audit.state.settings.convertTzEnabled = false; audit.state.settings.targetDiffTime = ''; audit.refreshTimestampTooltips(); });
    assert.equal((await tooltipState(page)).marker, false);
    await page.evaluate(settings => { audit.state.settings = settings; audit.refreshTimestampTooltips(); }, settings);
    assert.equal((await tooltipState(page)).extras, 1);
    await page.evaluate(() => audit.cleanup());
    assert.deepEqual(await tooltipState(page), { text: '7:21 PM · Oct 24, 2026', marker: false, whiteSpace: 'normal', maxWidth: '180px', extras: 0 });
  } finally { await page.close(); }
});

async function popupFixture() {
  const page = await browser.newPage();
  await page.setContent(popup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
  await page.addScriptTag({ content: core });
  await page.addScriptTag({ content: i18n });
  await page.evaluate(settings => {
    window.saved = { 'xfs:displaySettingsV1': settings, 'xfs:languagePreferenceV1': 'en' };
    window.pending = [];
    window.writes = [];
    window.chrome = { storage: { local: {
      get(key, callback) { const result = { [key]: structuredClone(saved[key]) }; if (callback) callback(result); else return Promise.resolve(result); },
      async set(value) {
        if (window.holdFirstWrite) { window.holdFirstWrite = false; await new Promise(resolve => { window.releaseWrite = resolve; }); }
        if (window.failNextWrite) { window.failNextWrite = false; throw new Error('disk unavailable'); }
        Object.assign(saved, structuredClone(value)); writes.push(structuredClone(value));
      }
    } }, tabs: {
      async query() { return [{ id: 1, url: 'https://x.com/home' }]; },
      async sendMessage(id, message) {
        const response = { ok: true, status: { cachedUsers: 0, settings: structuredClone(message.settings || saved['xfs:displaySettingsV1']) } };
        if (window.holdResponses) return new Promise(resolve => pending.push({ response, resolve }));
        return response;
      }
    } };
    window.XFSStorage = { async request() { return { bytesUsed: 0, budgetBytes: 9437184, status: {} }; } };
  }, settings);
  await page.addScriptTag({ content: popupScript });
  await page.waitForFunction(() => document.querySelector('#target-diff-time-input').value === '2026-10-25T14:00' && !document.querySelector('#feed-toggle').disabled);
  return page;
}

test('delayed earlier page status cannot overwrite the latest edited date or other saved settings', async () => {
  const page = await popupFixture();
  try {
    await page.evaluate(() => { window.holdResponses = true; });
    const input = page.locator('#target-diff-time-input');
    await input.fill('2026-10-25T15:00');
    await page.waitForFunction(() => pending.length === 1);
    await input.fill('2026-10-25T16:00');
    await page.waitForFunction(() => pending.length === 2);
    await page.evaluate(() => pending[1].resolve(pending[1].response));
    await page.waitForFunction(() => !document.querySelector('#feed-toggle').disabled);
    await page.evaluate(async () => { pending[0].resolve(pending[0].response); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await input.inputValue(), '2026-10-25T16:00');
    assert.deepEqual(await page.evaluate(() => saved['xfs:displaySettingsV1']), { ...settings, targetDiffTime: '2026-10-25T16:00' });
  } finally { await page.close(); }
});

test('a delayed first storage write cannot roll back a later date edit', async () => {
  const page = await popupFixture();
  try {
    await page.evaluate(() => { window.holdFirstWrite = true; });
    await page.locator('#target-diff-time-input').fill('2026-10-25T15:00');
    await page.waitForFunction(() => typeof releaseWrite === 'function');
    await page.locator('#target-diff-time-input').fill('2026-10-25T16:00');
    await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 0)); releaseWrite(); });
    await page.waitForFunction(() => writes.length === 2);
    assert.equal(await page.evaluate(() => saved['xfs:displaySettingsV1'].targetDiffTime), '2026-10-25T16:00');
    assert.equal(await page.locator('#target-diff-time-input').inputValue(), '2026-10-25T16:00');
  } finally { await page.close(); }
});

test('a failed settings write is reported and does not prevent the next edit from saving', async () => {
  const page = await popupFixture();
  try {
    await page.evaluate(() => { window.failNextWrite = true; });
    await page.locator('#target-diff-time-input').fill('2026-10-25T15:00');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('disk unavailable'), null, { timeout: 2000 });
    assert.equal(await page.evaluate(() => saved['xfs:displaySettingsV1'].targetDiffTime), settings.targetDiffTime);
    await page.locator('#target-diff-time-input').fill('2026-10-25T16:00');
    await page.waitForFunction(() => saved['xfs:displaySettingsV1'].targetDiffTime === '2026-10-25T16:00');
  } finally { await page.close(); }
});
