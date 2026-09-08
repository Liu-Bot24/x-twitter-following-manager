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
  let data = structuredClone(initial), failWrites = false;
  const runtime = { onMessage: event(), onConnect: event(), getURL: path => `chrome-extension://test/${path}` };
  const local = {
    get(keys, cb) { const snapshot = Object.fromEntries(keys.map(key => [key, structuredClone(data[key])])); queueMicrotask(() => cb(snapshot)); },
    getBytesInUse(key, cb) { queueMicrotask(() => cb(new TextEncoder().encode(JSON.stringify(data)).length)); },
    set(value, cb) { queueMicrotask(() => {
      if (failWrites) runtime.lastError = { message: 'QUOTA_BYTES exceeded' };
      else Object.assign(data, structuredClone(value));
      cb(); delete runtime.lastError;
    }); }
  };
  const context = vm.createContext({ Intl, URL, TextEncoder, chrome: { runtime, storage: { local } }, importScripts() {} });
  vm.runInContext(coreSource, context); vm.runInContext(backgroundSource, context);
  const request = (action, payload = {}, sender = extension) => new Promise(resolve => runtime.onMessage.emit({ type: 'xfs:storage', action, ...payload }, sender, resolve));
  return { request, runtime, data: () => data, fail() { failWrites = true; }, restore() { failWrites = false; } };
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
  const port = { name: 'xfs:sequential-run', sender: extension, onMessage: event(), onDisconnect: event(), postMessage(message) { port.reply?.(message); } };
  s.runtime.onConnect.emit(port);
  const ready = new Promise(resolve => { port.reply = resolve; });
  port.onMessage.emit({ type: 'start', runId: id });
  return { ready, disconnect: () => port.onDisconnect.emit() };
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
