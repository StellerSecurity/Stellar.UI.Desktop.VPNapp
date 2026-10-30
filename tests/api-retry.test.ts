import test from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, type RetryRuntime } from '../src/infrastructure/http/ApiRetry.ts';
function clock() {
  let now = 0;
  const delays: number[] = [];
  const runtime: RetryRuntime = { now: () => now, random: () => 0, sleep: async (ms, signal) => { assert.ok(!signal.aborted); delays.push(ms); now += ms; } };
  return { runtime, delays };
}
const response = (status = 200, headers = {}) => new Response('{}', { status, headers });
test('read API calls retry transient transport and HTTP failures with bounded backoff', async () => {
  const time = clock(); let calls = 0;
  const result = await apiRequest(async () => { calls++; if (calls === 1) throw new TypeError('offline'); return response(calls === 2 ? 503 : 200); }, 'https://example.test', {}, true, time.runtime);
  assert.equal(result.status, 200); await result.text(); assert.equal(calls, 3); assert.deepEqual(time.delays, [250, 500]);
});
test('three attempts is a hard limit even when the API stays unavailable', async () => {
  let calls = 0;
  const result = await apiRequest(async () => { calls++; return response(502); }, 'https://example.test', {}, true, clock().runtime);
  assert.equal(result.status, 502); await result.text(); assert.equal(calls, 3);
});
test('authentication, validation and conflict errors are never retried', async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    let calls = 0;
    const result = await apiRequest(async () => { calls++; return response(status); }, 'https://example.test', {}, true, clock().runtime);
    await result.text(); assert.equal(calls, 1);
  }
});
test('login/register/logout are not replayed after ambiguous failures', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let calls = 0;
    const result = await apiRequest(async () => { calls++; return response(status); }, 'https://example.test', { method: 'POST' }, false, clock().runtime);
    await result.text(); assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(apiRequest(async () => { calls++; throw new TypeError('offline'); }, 'https://example.test', {}, false, clock().runtime));
  assert.equal(calls, 1);
});
test('mutations can retry only an explicit pre-execution rejection from the origin', async () => {
  let calls = 0; const time = clock();
  const result = await apiRequest(async () => ++calls === 1 ? response(429, { 'X-Stellar-Retry-Safe': 'not-executed', 'Retry-After': '2' }) : response(), 'https://example.test', { method: 'POST' }, false, time.runtime);
  await result.text(); assert.equal(calls, 2); assert.deepEqual(time.delays, [2000]);
});
test('Retry-After is never shortened and cannot extend the 30 second operation budget', async () => {
  let calls = 0; const time = clock();
  const result = await apiRequest(async () => { calls++; return response(429, { 'Retry-After': '60' }); }, 'https://example.test', {}, true, time.runtime);
  await result.text(); assert.equal(calls, 1); assert.deepEqual(time.delays, []);
});
test('cancelling backoff prevents every later attempt', async () => {
  const controller = new AbortController(); let calls = 0;
  const time = clock(); time.runtime.sleep = async () => { controller.abort(); };
  await assert.rejects(apiRequest(async () => { calls++; return response(503); }, 'https://example.test', { signal: controller.signal }, true, time.runtime), /cancelled/);
  assert.equal(calls, 1);
});
test('a pre-cancelled request never starts the transport', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(apiRequest(async () => { calls++; return response(); }, 'https://example.test', { signal: controller.signal }, true, clock().runtime));
  assert.equal(calls, 0);
});
test('logout or a newer session cancels retries with the old bearer', async () => {
  let current = true, calls = 0;
  const time = clock(); time.runtime.sleep = async () => { current = false; };
  await assert.rejects(apiRequest(async () => { calls++; return response(503); }, 'https://example.test', {}, true, time.runtime, () => current));
  assert.equal(calls, 1);
});
