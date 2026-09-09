import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, after } from 'node:test';
import { chromium, browserOptions } from './browser.mjs';
const browser = await chromium.launch(browserOptions);
after(() => browser.close());
const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const storageSource = await readFile(new URL('../storage-client.js', import.meta.url), 'utf8');
const i18nSource = await readFile(new URL('../i18n.js', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('../stats-core.js', import.meta.url), 'utf8');
async function fixture(html) {
  const page = await browser.newPage();
  await page.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://x.com/alice');
  await page.evaluate(() => {
    const event = { addListener() {}, removeListener() {} };
    window.chrome = { runtime: { onMessage: event, sendMessage(message, callback) { callback({ ok: true, cache: {}, generation: 0, runs: {}, status: {} }); } }, storage: { onChanged: event, local: {
      get(key, callback) { callback({ 'xfs:languagePreferenceV1': 'en' }); }, set(data, callback) { callback?.(); }
    } } };
  });
  await page.addScriptTag({ content: coreSource });
  await page.addScriptTag({ content: storageSource });
  await page.addScriptTag({ content: i18nSource });
  await page.addScriptTag({ content: source.replace(/\}\)\(\);\s*$/, 'window.audit = { state, processCell, updateVisibleCells, readCurrentProfileStats, hoverCardMatchesUsername, setupObservers, scanStatsSurfaces, shouldQueueHover, applyHoverOutcome, getFreshCachedStats, hydrateFromHover, readProfileFromCell }; })();') });
  await page.waitForTimeout(50);
  return page;
}
const native = '<main><article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a><a href="/alice">@alice</a></div><div data-testid="tweetText">Hello</div></article></main>';

for (const stage of ['background', 'fallback']) test(`automatic ${stage} hover restarts when the removed account row reappears`, async () => {
  const page = await fixture(native);
  try {
    await page.evaluate(stage => {
      let attempts = 0;
      document.querySelector('article a').addEventListener('pointerover', () => {
        if (++attempts === (stage === 'background' ? 1 : 2)) document.querySelector('article').remove();
      });
    }, stage);
    await page.waitForFunction(() => audit.state.hoverJobSequence > 0 && !audit.state.hovering, null, { timeout: 6500 });
    assert.equal(await page.evaluate(() => audit.state.hoverAttempts.has('alice')), false);
    const previousJobs = await page.evaluate(() => audit.state.hoverJobSequence);
    await page.evaluate(html => { document.querySelector('main').outerHTML = html; }, native);
    await page.waitForFunction(previous => audit.state.hoverJobSequence > previous, previousJobs, { timeout: 2000 });
  } finally { await page.close(); }
});

for (const stage of ['background', 'fallback']) test(`a ${stage} hover whose cell is recycled releases its attempt without accepting the stale result`, async () => {
  const page = await fixture('<main></main>');
  try {
    const result = await page.evaluate(async ({ html, stage }) => {
      audit.state.mutationObserver.disconnect();
      audit.state.intersectionObserver.disconnect();
      document.querySelector('main').outerHTML = html;
      const cell = document.querySelector('article');
      audit.state.visibleCells.add(cell);
      const profile = audit.readProfileFromCell(cell, 'feed');
      let attempts = 0;
      profile.avatarOrNameLink.addEventListener('pointerover', () => {
        if (++attempts !== (stage === 'background' ? 1 : 2)) return;
        cell.querySelectorAll('a').forEach(anchor => { anchor.href = '/bob'; });
        document.body.insertAdjacentHTML('beforeend', '<div data-testid="HoverCard"><a href="/alice">Alice</a><div><a href="/alice/following">12 Following</a><a href="/alice/followers">34 Followers</a></div></div>');
      });
      audit.shouldQueueHover('alice', false);
      await audit.hydrateFromHover(profile, cell, 'feed');
      document.querySelector('[data-testid="HoverCard"]').remove();
      cell.querySelectorAll('a').forEach(anchor => { anchor.href = '/alice'; });
      return { saved: Boolean(audit.getFreshCachedStats('alice')), eligible: audit.shouldQueueHover('alice', false) };
    }, { html: native, stage });
    assert.equal(result.saved, false, 'A recycled cell must not accept the old hover result');
    assert.equal(result.eligible, true, 'The same account must remain eligible when it reappears');
  } finally { await page.close(); }
});
test('disabling display and then receiving stats preserves native tweet', async () => {
  const page = await fixture(native);
  const result = await page.evaluate(() => {
    const a = window.audit;
    a.state.cache.set('alice', { username: 'alice', followingCount: 12, followersCount: 34, statsUpdatedAt: Date.now() });
    a.processCell(document.querySelector('article'), {}, 'feed');
    a.state.settings.feed = false;
    a.updateVisibleCells('alice');
    return { native: document.querySelectorAll('article').length, pills: document.querySelectorAll('.xfs-stats-pill').length };
  });
  assert.equal(result.native, 1); assert.equal(result.pills, 0);
  await page.close();
});
test('stable cached page produces no continuing self mutations', async () => {
  const page = await fixture(native);
  await page.evaluate(() => {
    audit.state.cache.set('alice', { username: 'alice', followingCount: 12, followersCount: 34, statsUpdatedAt: Date.now() });
    audit.scanStatsSurfaces({});
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.mutations = 0; new MutationObserver(r => { window.mutations += r.length; }).observe(document.body, { childList: true, subtree: true }); });
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.mutations), 0);
  await page.close();
});
test('profile counts reject timeline and biography decoys but accept owner stats links', async () => {
  const page = await fixture('<main><div data-testid="UserDescription">12 Following 34 Followers <a href="/alice/following">12 Following</a></div><article>12 Following 34 Followers</article></main>');
  assert.equal(await page.evaluate(() => audit.readCurrentProfileStats('alice')), null);
  await page.evaluate(() => { document.querySelector('main').insertAdjacentHTML('afterbegin', '<div><a href="/alice/following">56 Following</a><a href="/alice/followers">78 Followers</a></div>'); });
  const stats = await page.evaluate(() => audit.readCurrentProfileStats('alice'));
  assert.equal(stats.followingDisplay, '56'); assert.equal(stats.followersDisplay, '78');
  await page.close();
});
test('offscreen cells do not enqueue hover work; visible cells do', async () => {
  const offscreen = await fixture(native.replace('<article ', '<article style="margin-top:5000px" '));
  await offscreen.waitForTimeout(500);
  assert.equal(await offscreen.evaluate(() => audit.state.hoverJobSequence), 0);
  await offscreen.close();
  const visible = await fixture(native);
  await visible.waitForFunction(() => audit.state.hoverJobSequence > 0);
  await visible.close();
});
test('user-list display toggle and disallowed SPA path preserve native nodes', async () => {
  const page = await fixture('<main><div data-testid="UserCell"><a href="/alice">Alice</a><span>@alice</span></div></main>');
  const result = await page.evaluate(() => {
    const cell = document.querySelector('[data-testid="UserCell"]');
    audit.state.cache.set('alice', { username: 'alice', followingCount: 12, followersCount: 34, statsUpdatedAt: Date.now() });
    audit.processCell(cell, {}, 'userList');
    audit.state.settings.userList = false;
    audit.updateVisibleCells('alice');
    history.pushState({}, '', '/notifications');
    audit.scanStatsSurfaces({});
    return { connected: cell.isConnected, pills: cell.querySelectorAll('.xfs-stats-pill').length };
  });
  assert.equal(result.connected, true); assert.equal(result.pills, 0);
  await page.close();
});
test('hover owner is not inferred from a mentioned profile in the biography', async () => {
  const page = await fixture('<main><div data-testid="HoverCard"><a href="/bob">Bob</a><div data-testid="UserDescription"><a href="/alice">Alice</a></div><div><a href="/bob/following">12 Following</a><a href="/bob/followers">34 Followers</a></div></div></main>');
  const result = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="HoverCard"]');
    return [audit.hoverCardMatchesUsername(card, 'alice'), audit.hoverCardMatchesUsername(card, 'bob')];
  });
  assert.deepEqual(result, [false, true]); await page.close();
});
test('owner statistics can have separate wrappers within the same compact statistics block', async () => {
  const page = await fixture('<main><div><div><a href="/alice/following">56 Following</a></div><div><a href="/alice/verified_followers">78 Followers</a></div></div></main>');
  const stats = await page.evaluate(() => audit.readCurrentProfileStats('alice'));
  assert.equal(stats?.followingDisplay, '56'); assert.equal(stats?.followersDisplay, '78');
  await page.close();
});
test('approximate statistics preserve their displayed precision and do not get exact-value tooltips', async () => {
  const page = await fixture(native);
  const result = await page.evaluate(() => {
    const core = XFollowStatsCore;
    const parsed = core.parseImportedUsers('profile_url,following_count,followers_count\nhttps://x.com/alice,1.2K,3.4K\n', 'users.csv')[0];
    audit.state.cache.set('alice', core.mergeObservedUser(null, parsed));
    audit.processCell(document.querySelector('article'), {}, 'feed');
    const pill = document.querySelector('.xfs-stats-pill');
    return { text: pill.textContent, title: pill.title };
  });
  assert.match(result.text, /1\.2K/); assert.match(result.text, /3\.4K/);
  assert.doesNotMatch(result.title, /\(1,200\)|\(3,400\)/);
  assert.match(result.title, /approximate/);
  await page.close();
});
test('successful hover permits automatic collection again after the three-day TTL expires', async () => {
  const page = await fixture(native);
  await page.evaluate(() => {
    audit.shouldQueueHover('alice', false);
    audit.applyHoverOutcome({ username: 'alice' }, { source: 'card', stats: { followingDisplay: '12', followersDisplay: '34' } }, 1, 'background');
    const future = audit.state.cache.get('alice').statsUpdatedAt + 3 * 24 * 60 * 60 * 1000 + 1;
    const originalNow = Date.now, offset = future - originalNow();
    Date.now = () => originalNow() + offset;
    audit.scanStatsSurfaces({});
  });
  assert.equal(await page.evaluate(() => audit.getFreshCachedStats('alice')), null);
  await page.waitForFunction(() => audit.state.hoverJobSequence > 0, null, { timeout: 2000 });
  await page.close();
});
