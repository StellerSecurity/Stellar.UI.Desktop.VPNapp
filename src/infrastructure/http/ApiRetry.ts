// Transport policy only: no credential logging/storage and no new dependencies.
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
export type RetryRuntime = { now: () => number; random: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> };
const aborted = () => new DOMException('Request cancelled', 'AbortError');
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(aborted()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
const runtime: RetryRuntime = { now: () => performance.now(), random: Math.random, sleep };
function untilConsumed(response: Response, done: () => void): Response {
  if (!response.body) { done(); return response; }
  const reader = response.body.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const part = await reader.read();
        if (part.done) { done(); reader.releaseLock(); stream.close(); }
        else stream.enqueue(part.value);
      } catch (error) { done(); reader.releaseLock(); stream.error(error); }
    },
    async cancel() { try { await reader.cancel(); } finally { done(); reader.releaseLock(); } },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
function retryAfter(response: Response): number {
  const value = response.headers.get('Retry-After');
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : Infinity;
}
async function attempt(request: typeof fetch, input: RequestInfo | URL, init: RequestInit, parent: AbortSignal, milliseconds: number): Promise<Response> {
  if (parent.aborted) throw aborted();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parent.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, milliseconds);
  let delivered = false;
  let rejectAbort: () => void = () => {};
  const cancellation = new Promise<never>((_, reject) => { rejectAbort = () => reject(aborted()); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
  const cleanup = () => { clearTimeout(timer); parent.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', rejectAbort); };
  try {
    const pending = request(input, { ...init, signal: controller.signal });
    // Even a transport that ignores abort cannot deliver a late result to a caller.
    void pending.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await Promise.race([pending, cancellation]);
    delivered = true;
    return untilConsumed(response, cleanup);
  } finally {
    if (!delivered) cleanup();
  }
}

/** Three attempts maximum, sharing the caller's overall timeout/cancellation.
 * Mutations are never replayed after an ambiguous transport/5xx failure.
 * Only the origin's explicit pre-execution rejection permits their retry.
 */
export async function apiRequest(request: typeof fetch, input: RequestInfo | URL, init: RequestInit, readOnly: boolean, clock: RetryRuntime = runtime, isCurrent: () => boolean = () => true): Promise<Response> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  init.signal?.addEventListener('abort', cancel, { once: true });
  if (init.signal?.aborted) cancel();
  const timer = setTimeout(cancel, 30_000);
  const deadline = clock.now() + 30_000;
  let delivered = false;
  const cleanup = () => { clearTimeout(timer); init.signal?.removeEventListener('abort', cancel); };
  const finish = (response: Response) => { delivered = true; return untilConsumed(response, cleanup); };
  try {
    for (let index = 0; index < 3; index++) {
      if (controller.signal.aborted || clock.now() >= deadline || !isCurrent()) throw aborted();
      let response: Response | undefined;
      try {
        response = await attempt(request, input, init, controller.signal, Math.min(readOnly ? 8_000 : 30_000, deadline - clock.now()));
      } catch (error) {
        if (!readOnly || index === 2 || controller.signal.aborted) throw error;
      }
      if (response && (!TRANSIENT.has(response.status) || (!readOnly && response.headers.get('X-Stellar-Retry-Safe') !== 'not-executed'))) return finish(response);
      if (index === 2) return finish(response!);
      const delay = Math.max(250 * 2 ** index + Math.floor(clock.random() * 150), response ? retryAfter(response) : 0);
      // Never shorten Retry-After or extend the total operation deadline.
      if (delay >= deadline - clock.now()) { if (response) return finish(response); throw aborted(); }
      await response?.body?.cancel();
      await clock.sleep(delay, controller.signal);
    }
    throw aborted();
  } finally {
    if (!delivered) cleanup();
  }
}
