import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHUNK_MS, TIMED_OUT, sleep, withDeadline } from '../../src/pacing.mts';

function recorder() {
  const events: string[] = [];
  return {
    events,
    keepAlive: () => {
      events.push('keep-alive');
    },
    // Throws once a sleep has gone on far longer than any test asks for, so a
    // sleep that never ends fails the test instead of holding the runner: its
    // waits resolve at once, and the loop would starve the runner's timers.
    wait: async (ms: number) => {
      events.push(`wait ${ms}`);
      if (events.length > 100) throw new Error('sleep did not stop');
    },
  };
}

test('a 45 s sleep is three waits of at most 20 s, each right after a keep-alive call', async () => {
  const record = recorder();
  await sleep(45_000, { keepAlive: record.keepAlive, wait: record.wait });
  assert.equal(CHUNK_MS, 20_000);
  assert.deepEqual(record.events, ['keep-alive', 'wait 20000', 'keep-alive', 'wait 20000', 'keep-alive', 'wait 5000']);
});

test('the default 30 s crawl delay has no stretch longer than 20 s without a keep-alive call', async () => {
  const record = recorder();
  await sleep(30_000, { keepAlive: record.keepAlive, wait: record.wait });
  assert.deepEqual(record.events, ['keep-alive', 'wait 20000', 'keep-alive', 'wait 10000']);
});

test('a keep-alive that throws or rejects is logged by error name and the sleep goes on', async () => {
  const lines: string[] = [];
  const waits: number[] = [];
  let calls = 0;
  const keepAlive = () => {
    calls += 1;
    if (calls === 1) throw new TypeError('no storage');
    return Promise.reject(new RangeError('quota'));
  };
  await sleep(25_000, { keepAlive, wait: async (ms) => { waits.push(ms); }, log: (line) => lines.push(line) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(waits, [20_000, 5_000]);
  assert.deepEqual(lines.sort(), ['keep-alive failed (RangeError)', 'keep-alive failed (TypeError)']);
});

test('a log that throws while reporting a failed keep-alive does not break the sleep', async () => {
  const waits: number[] = [];
  let calls = 0;
  const keepAlive = () => {
    calls += 1;
    if (calls === 1) throw new TypeError('no storage');
    return Promise.reject(new RangeError('quota'));
  };
  const log = () => {
    throw new Error('log broke');
  };
  await sleep(25_000, { keepAlive, wait: async (ms) => { waits.push(ms); }, log });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(waits, [20_000, 5_000]);
});

test('a keep-alive that never answers does not hold the sleep', { timeout: 2000 }, async () => {
  const record = recorder();
  await sleep(10_000, { keepAlive: () => new Promise(() => {}), wait: record.wait });
  assert.deepEqual(record.events, ['wait 10000']);
});

test('a sleep of zero, a negative, a non-number or Infinity makes no call', async () => {
  for (const ms of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const record = recorder();
    await sleep(ms, { keepAlive: record.keepAlive, wait: record.wait });
    assert.deepEqual(record.events, [], String(ms));
  }
});

test('a crawl delay served as a numeric string is waited like its number', async () => {
  const record = recorder();
  await sleep('30000' as unknown as number, { keepAlive: record.keepAlive, wait: record.wait });
  assert.deepEqual(record.events, ['keep-alive', 'wait 20000', 'keep-alive', 'wait 10000']);
});

test('without an injected wait, sleep waits on a real timer', async () => {
  const started = performance.now();
  await sleep(30, { keepAlive: () => undefined });
  assert.ok(performance.now() - started >= 25, 'returned before the timer');
});

test('withDeadline answers the promise\'s value when it comes first, and TIMED_OUT when the deadline does', { timeout: 2000 }, async () => {
  assert.equal(await withDeadline(Promise.resolve('value'), 1000), 'value');
  assert.equal(await withDeadline(new Promise(() => {}), 20), TIMED_OUT);
});

test('withDeadline passes a rejection through, and a rejection after the deadline goes nowhere', { timeout: 2000 }, async () => {
  await assert.rejects(withDeadline(Promise.reject(new TypeError('broken')), 1000), TypeError);
  let reject: (error: Error) => void = () => {};
  const late = new Promise((_resolve, rejectLater) => { reject = rejectLater; });
  assert.equal(await withDeadline(late, 10), TIMED_OUT);
  reject(new Error('after the deadline'));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('withDeadline leaves no timer behind once the promise has answered', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const before = timers();
  await withDeadline(Promise.resolve('value'), 60_000);
  assert.equal(timers(), before, 'a deadline timer is still running after the race');
});
