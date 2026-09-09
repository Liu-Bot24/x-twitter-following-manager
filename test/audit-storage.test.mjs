import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
const coreSource = await readFile(new URL('../stats-core.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const managerSource = await readFile(new URL('../manager/manager.js', import.meta.url), 'utf8');
const CACHE = 'xfs:userStatsCacheV2', GEN = 'xfs:cacheGenerationV1', RUNS = 'xfs:activeRunsV1';
const extension = { url: 'chrome-extension://test/manager/manager.html' };
function event() { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(...args) { return listeners.map(fn => fn(...args)); } }; }
function service(initial = {}) {
  let data = structuredClone(initial), failWrites = false, afterWrite;
  const runtime = { onMessage: event(), onConnect: event(), getURL: path => `chrome-extension://test/${path}` };
  const local = {
    get(keys, cb) { const snapshot = Object.fromEntries(keys.map(key => [key, structuredClone(data[key])])); queueMicrotask(() => cb(snapshot)); },
    getBytesInUse(key, cb) { queueMicrotask(() => cb(new TextEncoder().encode(JSON.stringify(data)).length)); },
    set(value, cb) { queueMicrotask(() => {
      if (failWrites) runtime.lastError = { message: 'QUOTA_BYTES exceeded' };
      else { Object.assign(data, structuredClone(value)); afterWrite?.(value); }
      cb(); delete runtime.lastError;
    }); }
  };
  const context = vm.createContext({ Intl, URL, TextEncoder, chrome: { runtime, storage: { local } }, importScripts() {} });
  vm.runInContext(coreSource, context); vm.runInContext(backgroundSource, context);
  const request = (action, payload = {}, sender = extension) => new Promise(resolve => runtime.onMessage.emit({ type: 'xfs:storage', action, ...payload }, sender, resolve));
  return { request, runtime, core: context.XFollowStatsCore, data: () => data, fail() { failWrites = true; }, restore() { failWrites = false; }, afterWrite(handler) { afterWrite = handler; } };
}
const user = username => ({ username, followingCount: 12, followersCount: 34, statsUpdatedAt: 100, updatedAt: 100, sources: ['import'] });
test('concurrent imports and capture preserve all accounts with no content-script coordinator', async () => {
  const s = service();
  const results = await Promise.all([
    s.request('import', { generation: 0, users: [user('alice')] }),
    s.request('import', { generation: 0, users: [user('bob')] }),
    s.request('merge', { generation: 0, users: [user('carol')] })
  ]);
  assert.ok(results.every(r => r.ok));
  assert.deepEqual(Object.keys(s.data()[CACHE]).sort(), ['alice', 'bob', 'carol']);
});
test('clear rejects stale pending snapshots, including after a service restart', async () => {
  const s = service({ [CACHE]: { alice: user('alice') } });
  assert.equal((await s.request('clear')).ok, true);
  assert.equal((await s.request('merge', { generation: 0, users: [user('alice')] })).code, 'stale_generation');
  const restarted = service(s.data());
  assert.equal((await restarted.request('import', { generation: 0, users: [user('bob')] })).code, 'stale_generation');
  assert.deepEqual(Object.keys(restarted.data()[CACHE]), []);
  assert.equal((await restarted.request('import', { generation: 1, users: [user('bob')] })).ok, true);
});
test('write errors and capacity rejection preserve prior data and report failure', async () => {
  const s = service({ [CACHE]: { alice: user('alice') } });
  await s.request('read'); s.fail();
  assert.equal((await s.request('import', { generation: 0, users: [user('bob')] })).ok, false);
  assert.deepEqual(Object.keys(s.data()[CACHE]), ['alice']);
  s.restore();
  const huge = { ...user('bob'), bio: 'a'.repeat(10 * 1024 * 1024) };
  assert.equal((await s.request('import', { generation: 0, users: [huge] })).code, 'storage_capacity');
  assert.deepEqual(Object.keys(s.data()[CACHE]), ['alice']);
});
function connect(s, id) {
  const port = { name: 'xfs:sequential-run', sender: extension, onMessage: event(), onDisconnect: event(), postMessage(message) { if (port.closed) throw new Error('Port disconnected'); port.reply?.(message); } };
  s.runtime.onConnect.emit(port);
  const ready = new Promise(resolve => { port.reply = resolve; });
  port.onMessage.emit({ type: 'start', runId: id });
  return { ready, disconnect: () => { port.closed = true; port.onDisconnect.emit(); } };
}
test('temporary overlapping runs never alter manual preference and release on disconnect', async () => {
  const s = service({ [CACHE]: { alice: user('alice') }, 'xfs:displaySettingsV1': { updateOnlyExisting: false } });
  const a = connect(s, 'a'), b = connect(s, 'b');
  await Promise.all([a.ready, b.ready]); a.disconnect();
  await s.request('merge', { generation: 0, users: [user('bob')] });
  assert.deepEqual(Object.keys(s.data()[CACHE]), ['alice']);
  assert.deepEqual(Object.keys(s.data()[RUNS]), ['b']);
  assert.equal(s.data()['xfs:displaySettingsV1'].updateOnlyExisting, false);
  b.disconnect(); await s.request('merge', { generation: 0, users: [user('bob')] });
  assert.deepEqual(Object.keys(s.data()[CACHE]).sort(), ['alice', 'bob']);
});
test('content senders cannot import or clear', async () => {
  const s = service(); const sender = { url: 'https://x.com/home' };
  assert.equal((await s.request('clear', {}, sender)).ok, false);
  assert.equal((await s.request('import', { generation: 0, users: [user('alice')] }, sender)).ok, false);
});
test('disconnect during lock-start persistence removes the stored lock even if ready cannot be delivered', async () => {
  const s = service();
  const connection = connect(s, 'closing-run');
  s.afterWrite(value => { if (value[RUNS]?.['closing-run']) connection.disconnect(); });
  await new Promise(resolve => setImmediate(resolve));
  await s.request('read');
  assert.deepEqual(Object.keys(s.data()[RUNS]), []);
});
test('real worker merge/import paths preserve authoritative metadata against DOM-only and minimum CSV records', async () => {
  const s = service(), core = s.core;
  const dom = core.mergeObservedUser(null, { username: 'alice', displayName: 'Alice' }, '2026-09-01T00:00:00Z');
  const authority = core.mergeObservedUser(dom, { username: 'alice', bio: 'Keep', website: 'https://example.com', verified: true }, '2026-09-02T00:00:00Z');
  const laterDom = core.mergeObservedUser(dom, { username: 'alice', displayName: 'Alice renamed' }, '2026-09-03T00:00:00Z');
  for (const record of [dom, authority, laterDom]) assert.equal((await s.request('merge', { generation: 0, users: [record] })).ok, true);
  assert.equal((await s.request('import', { generation: 0, users: core.parseImportedUsers('profile_url\nhttps://x.com/alice\n', 'minimal.csv') })).ok, true);
  assert.equal(s.data()[CACHE].alice.bio, 'Keep'); assert.equal(s.data()[CACHE].alice.website, 'https://example.com'); assert.equal(s.data()[CACHE].alice.verified, true);
});
test('real worker import accepts older valid statistics for a newer empty profile', async () => {
  const s = service(), core = s.core;
  const empty = core.mergeObservedUser(null, { username: 'alice' }, '2026-09-09T00:00:00Z');
  await s.request('merge', { generation: 0, users: [empty] });
  const yesterday = Date.parse('2026-09-08T00:00:00Z');
  const rows = core.parseImportedUsers(`profile_url,following_count,followers_count,stats_updated_at\nhttps://x.com/alice,12,34,${yesterday}\n`, 'stats.csv');
  assert.equal((await s.request('import', { generation: 0, users: rows })).ok, true);
  assert.equal(s.data()[CACHE].alice.followingCount, 12); assert.equal(s.data()[CACHE].alice.statsUpdatedAt, yesterday);
});
