import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
const sources = await Promise.all(['page-hook-core.js', 'page-hook.js'].map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
const payload = { legacy: { screen_name: 'alice', friends_count: 1, followers_count: 2 } };
function hook(response) {
  const messages = [], listeners = new Map(); let originalPromise;
  class Xhr {
    constructor() { this.listeners = []; }
    addEventListener(type, callback) { this.listeners.push(callback); }
    open() {}
    send() { if (!this.defer) this.listeners.forEach(callback => callback()); }
    getResponseHeader() { return 'application/json'; }
  }
  const context = vm.createContext({
    Intl, URL, TextDecoder, setTimeout, clearTimeout, XMLHttpRequest: Xhr,
    location: { origin: 'https://x.com' },
    fetch() { return originalPromise = Promise.resolve(response); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(message) { messages.push(message); }
  });
  vm.runInContext('window = globalThis', context);
  sources.forEach(source => vm.runInContext(source, context));
  vm.runInContext('globalThis.readyEvent = { source: window, data: { source: "x-follow-stats-extension", type: "content-ready" } }', context);
  listeners.get('message')(context.readyEvent);
  return { context, messages, original: () => originalPromise, invalidate() {
    vm.runInContext('globalThis.invalidateEvent = { source: window, data: { source: "x-follow-stats-extension", type: "invalidate-captures", captureGeneration: 1 } }', context);
    listeners.get('message')(context.invalidateEvent);
  } };
}
const wait = () => new Promise(resolve => setTimeout(resolve, 25));
test('Fetch string, Request and URL retain native response identity and collect counts', async () => {
  const url = 'https://x.com/i/api/graphql/UserByScreenName';
  for (const input of [url, new URL(url), new Request(url)]) {
    const response = new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    const h = hook(response); const result = h.context.fetch(input);
    assert.equal(result, h.original()); assert.equal(await result, response);
    await wait();
    assert.equal(h.messages.filter(m => m.type === 'users').length, 1);
    assert.deepEqual(await response.json(), payload);
  }
});
test('oversized Fetch clone is cancelled without consuming original response', async () => {
  const text = JSON.stringify({ ...payload, padding: 'x'.repeat(12_000_001) });
  const response = new Response(text, { headers: { 'content-type': 'application/json', 'content-length': '1' } });
  const h = hook(response);
  await h.context.fetch('https://x.com/i/api/graphql/UserByScreenName'); await wait();
  assert.equal(h.messages.filter(m => m.type === 'users').length, 0);
  assert.equal((await response.text()).length, text.length);
});
test('JSON XHR avoids responseText getter and reused XHR has one listener', () => {
  const h = hook(null); const xhr = new h.context.XMLHttpRequest();
  xhr.responseType = 'json'; xhr.response = payload;
  Object.defineProperty(xhr, 'responseText', { get() { throw new Error('InvalidStateError'); } });
  xhr.open('GET', new URL('https://x.com/i/api/graphql/UserByScreenName')); xhr.send();
  xhr.open('GET', 'https://x.com/i/api/graphql/UserByScreenName'); xhr.send();
  assert.equal(h.messages.filter(m => m.type === 'users').length, 2);
  assert.equal(xhr.listeners.length, 1);
  xhr.open('GET', 'https://x.com/not-api'); xhr.send();
  assert.equal(h.messages.filter(m => m.type === 'users').length, 2);
});
test('clear invalidates XHR and a Fetch body already being read, while native data remains readable', async () => {
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const response = new Response(stream, { headers: { 'content-type': 'application/json' } });
  const h = hook(response);
  const xhr = new h.context.XMLHttpRequest();
  xhr.defer = true; xhr.responseType = 'json'; xhr.response = payload;
  xhr.open('GET', 'https://x.com/i/api/graphql/Old'); xhr.send();
  await h.context.fetch('https://x.com/i/api/graphql/Old');
  h.invalidate();
  xhr.listeners.forEach(callback => callback());
  controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close();
  await wait();
  assert.equal(h.messages.filter(m => m.type === 'users').length, 0);
  assert.deepEqual(await response.json(), payload);
  xhr.defer = false; xhr.send();
  assert.equal(h.messages.filter(m => m.type === 'users').length, 1);
});

test('R4: delayed Fetch clone parsing retains its original sequence and document identity', async () => {
  let release;
  const body = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); }; } });
  const first = new Response(body, { headers: { 'content-type': 'application/json' } });
  const second = new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  let clone = 0;
  const h = hook({ headers: new Headers({ 'content-type': 'application/json' }), clone() { return clone++ === 0 ? first : second; } });
  vm.runInContext('Date.now = () => 123456789', h.context);
  await h.context.fetch('https://x.com/i/api/graphql/First');
  await h.context.fetch('https://x.com/i/api/graphql/Second');
  await wait(); release(); await wait();
  const messages = h.messages.filter(message => message.type === 'users');
  assert.deepEqual(messages.map(message => message.requestSequence), [2, 1]);
  assert.equal(messages[0].requestStartedAt, messages[1].requestStartedAt);
  assert.equal(messages[0].documentId, messages[1].documentId);
  assert.ok(messages[0].documentId);
});
