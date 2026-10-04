import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
const context = vm.createContext({ Intl, URL });
vm.runInContext(await readFile(new URL('../stats-core.js', import.meta.url), 'utf8'), context);
const core = context.XFollowStatsCore;
const t1 = '2026-09-01T00:00:00Z', t2 = '2026-10-01T00:00:00Z';

test('R1: grouped whitespace survives DOM parsing, cache and CSV as an exact whole count', () => {
  for (const number of ['1234', '1,234', '1 234', '1\u00a0234', '1\u202f234']) {
    const parsed = core.parseStatsText(`${number} Abonnements ${number} Abonnés`);
    const cached = core.mergeObservedUser(null, { username: 'alice', ...parsed }, t1);
    const row = core.parseImportedUsers(core.exportUsersToCsv([cached]), 'counts.csv')[0];
    assert.equal(cached.followingCount, 1234, number);
    assert.equal(cached.followingPrecision, 'exact');
    assert.equal(row.followersCount, 1234);
  }
});
test('R2: invalid placeholders never make statistics fresh', () => {
  for (const value of ['unknown', 'n/a', 'N/A', '-', 'words', '-1', 'NaN', 'Infinity', '1.5']) {
    const [user] = core.parseImportedUsers(`profile_url,following_count,followers_count\nhttps://x.com/alice,${value},${value}\n`, 'counts.csv');
    const cached = core.mergeObservedUser(null, user, t1);
    assert.equal(core.isCachedStatsFresh(cached, { now: Date.parse(t1) + 1 }), false, value);
    assert.equal(cached.followingPrecision, 'missing', value);
  }
});
test('R3: a reused handle cannot inherit the prior stable identity history', () => {
  const old = core.mergeObservedUser(null, { username: 'alice', userId: '111', displayName: 'Old owner', bio: 'Private notes', sources: ['feed'], observedPost: { id: '777', text: 'Old post' } }, t1);
  const next = core.mergeObservedUser(old, { username: 'alice', userId: '222', displayName: 'New owner' }, t2);
  assert.equal(next.userId, '222');
  assert.equal(next.observedPosts.length, 0);
  assert.equal(next.bio, undefined);
  assert.equal(next.sources.length, 0);
  assert.ok(!core.exportUsersToCsv([next]).includes('Old post'));
});
test('C1: profile inputs reject unsupported protocols, credentials and ports', () => {
  for (const url of ['javascript://x.com/alice#%0Aalert(1)', 'data://x.com/alice', 'file://x.com/alice', 'custom://x.com/alice', 'https://user:pass@x.com/alice', 'https://x.com:444/alice']) {
    assert.equal(core.usernameFromProfileHref(url), '', url);
    assert.equal(core.parseImportedUsers(`profile_url\n${url}\n`, 'users.csv').length, 0, url);
  }
});

test('R1/R2: compact decimals, malformed groups, precision hints and zero use one count model', () => {
  for (const token of ['1,2 K', '1.2K']) {
    const parsed = core.parseStatsText(`${token} Following ${token} Followers`);
    const record = core.mergeObservedUser(null, { username: 'alice', ...parsed }, t1);
    assert.equal(record.followingDisplay, '1.2K');
    assert.equal(record.followingCount, null);
    assert.equal(record.followingPrecision, 'approximate');
    assert.equal(core.isCachedStatsFresh(record), true);
  }
  for (const token of ['1 23', '12 34 567', '1,23', '1,234.5', '1 234,567', '1 234 56', '-12', '1.5', '1029381748 743']) {
    assert.equal(core.parseStatsText(`${token} Following 0 Followers`), null, token);
  }
  const zero = core.mergeObservedUser(null, { username: 'alice', followingCount: 0, followersDisplay: '0' }, t1);
  assert.equal(core.hasCompleteStatsRecord(zero), true);
  for (const count of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const record = core.mergeObservedUser(null, { username: 'alice', followingCount: count, followersCount: 0 }, t1);
    assert.equal(core.hasCompleteStatsRecord(record), false);
  }
  const [spoofed] = core.parseImportedUsers('profile_url,following_count,followers_count,following_precision,followers_precision\nhttps://x.com/alice,1.2K,unknown,exact,exact\n', 'precision.csv');
  assert.equal(spoofed.followingPrecision, 'approximate');
  assert.equal(spoofed.followersPrecision, 'missing');
  const legacy = { username: 'alice', followingDisplay: 'unknown', followersDisplay: 'n/a', followingPrecision: 'approximate', statsUpdatedAt: Date.now() };
  assert.equal(core.hasCompleteStatsRecord(legacy), false);
  assert.equal(core.formatStatsCount(legacy, 'following'), '');
  assert.equal(core.isCachedStatsFresh(legacy), false);
});

test('R3: conflicts archive original data; stale tabs and ID-less DOM do not reset identity', () => {
  const old = core.mergeObservedUser(null, { username: 'alice', userId: '111', displayName: 'Old owner', bio: 'Old biography', sources: ['feed'], observedPost: { id: '777', text: 'Old post' } }, t1);
  old.privateNote = 'retain original unknown fields';
  const current = core.mergeObservedUser(old, { username: 'alice', userId: '222', displayName: 'New owner', sources: ['userList'] }, t2);
  assert.equal(current.identityHistory.length, 1);
  assert.equal(current.identityHistory[0].privateNote, old.privateNote);
  assert.equal(current.identityHistory[0].observedPosts[0].text, 'Old post');
  const late = core.mergeObservedUser(old, { username: 'alice', displayName: 'Old tab DOM' }, '2026-10-02T00:00:00Z');
  for (const [a, b] of [[current, late], [late, current]]) {
    const merged = core.mergeCachedUserRecords(a, b);
    assert.equal(merged.userId, '222');
    assert.equal(merged.displayName, 'New owner');
    assert.equal(merged.observedPosts.length, 0);
    assert.equal(merged.identityHistory.length, 1);
    assert.equal(merged.identityHistory[0].observedPosts[0].id, '777');
    const dom = core.mergeObservedUser(merged, { username: 'alice', displayName: 'Current DOM' }, '2026-10-03T00:00:00Z');
    assert.equal(dom.userId, '222');
    assert.equal(dom.identityUpdatedAt, merged.identityUpdatedAt);
  }
});

test('R3: one stable ID changing handle remains one subject in either cache merge order', () => {
  const old = core.mergeObservedUser(null, { username: 'alice', userId: '111', sources: ['feed'], observedPost: { id: '777', text: 'Same person' } }, t1);
  const renamed = core.mergeObservedUser(null, { username: 'new_alice', userId: '111', displayName: 'New handle', sources: ['userList'] }, t2);
  for (const [a, b] of [[{ alice: old }, { new_alice: renamed }], [{ new_alice: renamed }, { alice: old }]]) {
    const cache = core.reconcileUserCaches(a, b).cache;
    assert.deepEqual(Object.keys(cache), ['new_alice']);
    assert.equal(cache.new_alice.observedPosts[0].text, 'Same person');
    assert.equal(cache.new_alice.identityHistory, undefined);
    assert.equal(core.reconcileUserCaches(cache, a).cache.new_alice.userId, '111');
  }
});

test('C1: ordinary X/Twitter links remain importable; profile navigation is validated and post links are validated', () => {
  for (const url of ['https://x.com/Alice?lang=en#bio', 'http://twitter.com/Alice', '/Alice', 'https://twitter.com:443/alice/']) {
    assert.equal(core.usernameFromProfileHref(url), 'alice', url);
    const [record] = core.parseImportedUsers(`profile_url\n${url}\n`, 'links.csv');
    assert.equal(record.profileUrl, new URL(url, 'https://x.com/').href);
  }
  for (const url of ['javascript://x.com/alice/status/1', 'https://other.example/alice/status/1', 'https://user@x.com/alice/status/1', 'https://x.com/alice']) {
    assert.equal(core.safePostUrl(url), '', url);
  }
  assert.equal(core.safePostUrl('https://twitter.com/alice/status/123?s=20'), 'https://x.com/alice/status/123');
});

test('R3: an archived identity reclaiming a handle restores only its own history', () => {
  const first = core.mergeObservedUser(null, { username: 'alice', userId: '111', sources: ['feed'], observedPost: { id: '1', text: 'First owner' } }, t1);
  const second = core.mergeObservedUser(first, { username: 'alice', userId: '222', sources: ['feed'], observedPost: { id: '2', text: 'Second owner' } }, t2);
  const returned = core.mergeObservedUser(second, { username: 'alice', userId: '111', displayName: 'Returned owner' }, '2026-10-03T00:00:00Z');
  assert.equal(returned.userId, '111');
  assert.deepEqual(Array.from(returned.observedPosts, post => post.text), ['First owner']);
  assert.equal(returned.identityHistory.length, 1);
  assert.equal(returned.identityHistory[0].observedPosts[0].text, 'Second owner');
});
