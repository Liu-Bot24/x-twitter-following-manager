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
test('a partial imported observation retains the provided count without inventing its counterpart', () => {
  const parsed = core.parseImportedUsers('profile_url,following_count\nhttps://x.com/alice,12\n', 'partial.csv')[0];
  const merged = core.mergeObservedUser(null, parsed);
  assert.equal(merged.followingCount, 12);
  assert.equal(merged.followersCount, null);
  assert.equal(core.isCachedStatsFresh(merged), false);
  const newer = core.mergeObservedUser({ username: 'alice', followingCount: 10, followersCount: 20, statsUpdatedAt: 1 }, parsed);
  assert.equal(newer.followingCount, 12);
  assert.equal(newer.followersCount, null);
});
test('missing CSV metadata columns preserve existing fields; explicit empty columns clear them', () => {
  const existing = { username: 'alice', bio: 'Keep biography', website: 'https://example.com' };
  const absent = core.parseImportedUsers('profile_url\nhttps://x.com/alice\n', 'users.csv')[0];
  const present = core.parseImportedUsers('profile_url,bio,website\nhttps://x.com/alice,,\n', 'users.csv')[0];
  assert.equal(core.mergeObservedUser(existing, absent).bio, existing.bio);
  assert.equal(core.mergeObservedUser(existing, absent).website, existing.website);
  assert.equal(core.mergeObservedUser(existing, present).bio, '');
  assert.equal(core.mergeObservedUser(existing, present).website, '');
});
test('newer DOM snapshots cannot erase or restore stale authoritative metadata across tabs', () => {
  const t1 = '2026-09-01T00:00:00Z', t2 = '2026-09-02T00:00:00Z', t3 = '2026-09-03T00:00:00Z';
  const domOnly = core.mergeObservedUser(null, { username: 'alice', displayName: 'Alice' }, t1);
  const authority = core.mergeObservedUser(domOnly, { username: 'alice', bio: 'Known bio', website: 'https://example.com', verified: true }, t2);
  const laterDom = core.mergeObservedUser(domOnly, { username: 'alice', observedPost: { id: '1', text: 'New post' } }, t3);
  const merged = core.mergeCachedUserRecords(authority, laterDom);
  assert.equal(merged.bio, authority.bio); assert.equal(merged.website, authority.website); assert.equal(merged.verified, true);
  const oldAuthority = core.mergeObservedUser(null, { username: 'alice', bio: 'Old', website: 'https://old.example', verified: true }, t1);
  const cleared = core.mergeObservedUser(oldAuthority, { username: 'alice', bio: '', website: '', verified: false }, t2);
  const staleDom = core.mergeObservedUser(oldAuthority, { username: 'alice', displayName: 'Alice new name' }, t3);
  const combined = core.mergeCachedUserRecords(cleared, staleDom);
  assert.equal(combined.bio, ''); assert.equal(combined.website, ''); assert.equal(combined.verified, false);
  assert.equal(core.canonicalStringify(combined), core.canonicalStringify(core.mergeCachedUserRecords(staleDom, cleared)));
});
test('a recent profile without statistics cannot block the first valid older statistics snapshot', () => {
  const yesterday = Date.parse('2026-09-08T00:00:00Z');
  let empty = core.mergeObservedUser(null, { username: 'alice' }, '2026-09-09T00:00:00Z');
  empty = core.mergeObservedUser(empty, { username: 'alice', displayName: 'Alice' }, '2026-09-09T00:00:01Z');
  const incoming = { username: 'alice', followingCount: 12, followersCount: 34, statsUpdatedAt: yesterday };
  const observed = core.mergeObservedUser(empty, incoming, '2026-09-09T00:00:02Z');
  assert.equal(observed.followingCount, 12); assert.equal(observed.followersCount, 34);
  assert.equal(observed.statsUpdatedAt, yesterday);
  const cached = core.mergeCachedUserRecords(empty, { ...incoming, updatedAt: yesterday });
  assert.equal(cached.followingCount, 12); assert.equal(cached.statsUpdatedAt, yesterday);
  assert.equal(empty.statsUpdatedAt, 0);
});
