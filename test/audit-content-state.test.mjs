import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
const coreSource = await readFile(new URL('../stats-core.js', import.meta.url), 'utf8');
// Optional source override supports checking the same regression against a historical file.
const contentSource = await readFile(process.env.XFS_CONTENT_UNDER_TEST || new URL('../content.js', import.meta.url), 'utf8');
const CACHE = 'xfs:userStatsCacheV2', GEN = 'xfs:cacheGenerationV1', CLEARED = 'xfs:cacheClearedAtV1';
async function fixture(options = {}) {
  let storageListener, rejectMerge, resolveRead, reads = 0, allowWrites = false;
  const savedUsers = [];
  let snapshot = { cache: {}, generation: 0, clearedAt: 0, runs: {}, status: {} };
  const event = { addListener() {}, removeListener() {} };
  const context = vm.createContext({
    Intl, URL, console, setTimeout, clearTimeout,
    location: { href: 'https://x.com/home', origin: 'https://x.com', pathname: '/home' },
    document: { body: {}, documentElement: { dataset: {} }, activeElement: null, hidden: false, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    chrome: { runtime: { onMessage: event }, storage: { onChanged: { addListener(listener) { storageListener = listener; }, removeListener() {} }, local: { get(key, cb) { cb({}); }, set() {} } } },
    XFSStorage: { GENERATION_KEY: GEN, CLEARED_AT_KEY: CLEARED, RUNS_KEY: 'runs', STATUS_KEY: 'status', request(action, payload) {
      if (action === 'read') {
        if (++reads > 1 && options.deferRecoveryRead) return new Promise(resolve => { resolveRead = resolve; });
        return Promise.resolve(snapshot);
      }
      if (allowWrites) { savedUsers.push(...payload.users); return Promise.resolve({ ok: true }); }
      return new Promise((resolve, reject) => { rejectMerge = reject; });
    } }
  });
  vm.runInContext('window = globalThis', context);
  vm.runInContext(coreSource, context);
  vm.runInContext(contentSource.replace(/\}\)\(\);\s*$/, 'window.audit = { state, mergeUserRecord, persistCacheNow }; })();'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, savedUsers, emitStorage: changes => storageListener(changes), allowWrites() { allowWrites = true; }, clear(generation = 1) {
    snapshot = { ...snapshot, generation, clearedAt: Date.now() };
    storageListener({ [GEN]: { newValue: generation }, [CLEARED]: { newValue: snapshot.clearedAt }, [CACHE]: { newValue: {} } });
  }, resolveRead(generation = 1) { resolveRead({ ...snapshot, generation }); }, rejectOldWrite() { const error = new Error('stale generation'); error.code = 'stale_generation'; rejectMerge(error); } };
}
test('a stale write failure cannot erase fresh dirty records captured after clear', async () => {
  const f = await fixture(); const api = f.context.audit;
  api.mergeUserRecord({ username: 'alice', sources: ['feed'] }, { scheduleSave: false });
  const pending = api.persistCacheNow();
  f.clear();
  api.mergeUserRecord({ username: 'bob', bio: 'new data', sources: ['feed'] }, { scheduleSave: false });
  f.rejectOldWrite(); await pending;
  assert.equal(api.state.cache.get('bob')?.bio, 'new data');
  assert.equal(api.state.dirtyUsers.has('bob'), true);
  assert.equal(api.state.cache.has('alice'), false);
  assert.equal(api.state.persistError, '', 'An obsolete failure must not change the current generation error status');
  f.allowWrites(); await api.persistCacheNow();
  assert.equal(f.savedUsers.find(user => user.username === 'bob')?.bio, 'new data');
  f.context.__xFollowStatsContentCleanup();
});
test('a delayed recovery read merges current dirty data and cannot roll back a second clear', async () => {
  for (const secondClear of [false, true]) {
    const f = await fixture({ deferRecoveryRead: true }); const api = f.context.audit;
    api.mergeUserRecord({ username: 'alice', sources: ['feed'] }, { scheduleSave: false });
    const pending = api.persistCacheNow(); f.rejectOldWrite();
    await new Promise(resolve => setImmediate(resolve));
    f.clear(1);
    if (secondClear) f.clear(2);
    api.mergeUserRecord({ username: 'bob', bio: 'new data', sources: ['feed'] }, { scheduleSave: false });
    f.resolveRead(1); await pending;
    assert.equal(api.state.cacheGeneration, secondClear ? 2 : 1);
    assert.equal(api.state.cache.get('bob')?.bio, 'new data');
    f.allowWrites(); await api.persistCacheNow();
    assert.equal(f.savedUsers.find(user => user.username === 'bob')?.bio, 'new data');
    f.context.__xFollowStatsContentCleanup();
  }
});
test('another writer success does not hide a local unsaved-data error', async () => {
  const f = await fixture(); const api = f.context.audit;
  api.mergeUserRecord({ username: 'alice', sources: ['feed'] }, { scheduleSave: false });
  api.state.persistError = 'Local data was not saved';
  f.emitStorage({ status: { newValue: { error: '', savedAt: Date.now() } } });
  assert.equal(api.state.persistError, 'Local data was not saved');
  f.allowWrites(); await api.persistCacheNow();
  assert.equal(api.state.persistError, '');
  f.context.__xFollowStatsContentCleanup();
});
