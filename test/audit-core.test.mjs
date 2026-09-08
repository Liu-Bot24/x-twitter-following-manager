import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
const context = vm.createContext({ Intl, URL });
for (const file of ['stats-core.js', 'page-hook-core.js']) {
  vm.runInContext(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), context);
}
const core = context.XFollowStatsCore;
test('display-only refresh replaces previous numeric snapshot', () => {
  const old = { username: 'alice', followingCount: 100, followersCount: 200, statsUpdatedAt: 1 };
  const next = core.mergeObservedUser(old, { username: 'alice', followingDisplay: '101', followersDisplay: '2.6万' }, '2026-09-09T00:00:00Z');
  assert.equal(next.followingCount, 101);
  assert.equal(next.followersCount, null);
  assert.equal(next.followersDisplay, '2.6万');
  const row = core.parseImportedUsers(core.exportUsersToCsv([next]), 'users.csv')[0];
  assert.equal(row.followingCount, 101);
  assert.notEqual(row.followersCount, 200);
  const seen = core.mergeObservedUser(next, { username: 'alice', displayName: 'Alice' });
  assert.equal(seen.statsUpdatedAt, next.statsUpdatedAt);
});
test('authoritative empty metadata is distinct from absent metadata', () => {
  const old = { username: 'alice', bio: 'old', website: 'https://example.com', verified: true };
  const next = core.mergeObservedUser(old, { username: 'alice', bio: '', website: '', verified: false });
  assert.equal(next.bio, ''); assert.equal(next.website, ''); assert.equal(next.verified, false);
  assert.equal(core.mergeObservedUser(old, { username: 'alice' }).bio, 'old');
});
test('both API collectors preserve complete outer user metadata', () => {
  const payload = { rest_id: '1234567890123456789', is_blue_verified: true, legacy: { screen_name: 'alice', friends_count: 12, followers_count: 34 } };
  for (const collector of [core, context.XFollowStatsPageCore]) {
    const [user] = collector.collectUserStats(payload);
    assert.equal(user.userId, payload.rest_id); assert.equal(user.verified, true);
    assert.equal(collector.collectUserStats({ legacy: { screen_name: 'alice' } }).length, 0);
  }
});
test('Markdown special characters and embedded profile links round trip', () => {
  const user = { username: 'alice', displayName: 'Alice] [Test] \\ demo', bio: 'See https://x.com/bob', followingCount: 12, followersCount: 34, observedPosts: [{ text: 'Hi https://x.com/carol', url: 'https://x.com/alice/status/1', kind: 'post' }] };
  const users = core.parseImportedUsers(core.exportUsersToMarkdown([user]), 'users.md');
  assert.equal(users.length, 1); assert.equal(users[0].displayName, user.displayName);
  assert.equal(users[0].bio, user.bio); assert.equal(users[0].observedPosts[0].text, user.observedPosts[0].text);
  assert.equal(core.parseImportedUsers('https://x.com/bob', 'users.md')[0].username, 'bob');
});
test('special username keys survive reconciliation and canonical serialization', () => {
  const data = JSON.parse('{"__proto__":{"username":"__proto__","bio":"kept"}}');
  const result = core.reconcileUserCaches({}, data).cache;
  assert.equal(Object.keys(result)[0], '__proto__');
  assert.equal(JSON.parse(core.canonicalStringify(result)).__proto__.bio, 'kept');
  assert.equal({}.bio, undefined);
});
test('spreadsheet CSV escapes formula prefixes while raw CSV preserves source text', () => {
  for (const displayName of ['=1+1', '+2', '-3', '@SUM(1)', '\t=1', '  =1', "'=1", 'Alice']) {
    const user = { username: 'alice', displayName };
    const safe = core.exportUsersToCsv([user]);
    const raw = core.exportUsersToCsv([user], { spreadsheetSafe: false });
    if (displayName !== 'Alice') assert.ok(safe.split('\n')[1].startsWith("'"));
    assert.ok(raw.split('\n')[1].startsWith(displayName));
    assert.equal(core.parseImportedUsers(safe, 'users.csv')[0].displayName, displayName.trim());
  }
});
test('abbreviations are explicitly approximate through import, merge, cache and CSV', () => {
  const imported = core.parseImportedUsers('profile_url,following_count,followers_count\nhttps://x.com/alice,2.6万,3K\n', 'users.csv')[0];
  assert.equal(imported.followingPrecision, 'approximate');
  const merged = core.mergeObservedUser(null, imported);
  const cached = core.mergeCachedUserRecords(merged, merged);
  const roundtrip = core.parseImportedUsers(core.exportUsersToCsv([cached]), 'users.csv')[0];
  assert.equal(roundtrip.followingPrecision, 'approximate');
  assert.equal(roundtrip.followingDisplay, '2.6万');
  const exact = core.mergeObservedUser(cached, { username: 'alice', followingCount: 26015, followersCount: 3010 });
  assert.equal(exact.followingPrecision, 'exact');
});
