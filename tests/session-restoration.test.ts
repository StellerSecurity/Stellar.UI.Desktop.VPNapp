import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRestoration } from '../src/infrastructure/auth/SessionRestoration.ts';

test('a locked vault rejects startup and can be restored after unlocking', async () => {
  const restoration = new SessionRestoration();
  let calls = 0;
  const restore = async () => { if (++calls === 1) throw new Error('vault unavailable'); };
  await assert.rejects(restoration.run(restore), /vault unavailable/);
  await restoration.run(restore);
  await restoration.run(restore);
  assert.equal(calls, 2);
});

test('concurrent startup callers share one vault operation', async () => {
  const restoration = new SessionRestoration();
  let calls = 0, finish!: () => void;
  const restore = async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); };
  const first = restoration.run(restore), second = restoration.run(restore);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(); await first;
});

test('a completed manual login is not reset by an older failed startup operation', async () => {
  const restoration = new SessionRestoration();
  let fail!: (error: Error) => void;
  const pending = restoration.run(() => new Promise<void>((_, reject) => { fail = reject; }));
  await Promise.resolve(); restoration.complete();
  fail(new Error('old startup failure')); await assert.rejects(pending);
  await restoration.run(async () => { assert.fail('manual login already completed restoration'); });
});

test('a late vault read cannot overwrite a newer manual login', async () => {
  const restoration = new SessionRestoration();
  let finish!: () => void;
  let appliedOldLogin = false;
  const pending = restoration.run(async isCurrent => {
    await new Promise<void>(resolve => { finish = resolve; });
    if (isCurrent()) appliedOldLogin = true;
  });
  await Promise.resolve();
  restoration.complete(); finish(); await pending;
  assert.equal(appliedOldLogin, false);
});
