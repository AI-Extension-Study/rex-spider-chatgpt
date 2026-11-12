import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoKey } from '../../src/keys.mts';
import { resendSince } from '../../src/mode.mts';
import { type HandleMessage, STORE_DEADLINE_MS, createStore } from '../../src/store.mts';

type Message = { messageType: string; key: string; value?: unknown };

const CHAT = '00000000-0000-4000-8000-000000000001';
const OTHER_CHAT = '00000000-0000-4000-8000-000000000002';

// A double of rex-core's store with its two behaviours that matter here: a
// missing key answers null, and while its database is not open a read is not
// handled at all (false, no answer) and a write is taken (true) but never
// answered.
function rexCore({ open = true }: { open?: boolean } = {}) {
  const values = new Map<string, unknown>();
  const handleMessage = ((message: Message, _sender: unknown, sendResponse: (response: unknown) => void): boolean => {
    if (message.messageType === 'fetchValue') {
      if (!open) return false;
      queueMicrotask(() => sendResponse(values.has(message.key) ? values.get(message.key) : null));
      return true;
    }
    if (message.messageType === 'storeValue') {
      if (open) {
        values.set(message.key, message.value);
        queueMicrotask(() => sendResponse(true));
      }
      return true;
    }
    return false;
  }) as unknown as HandleMessage;
  return { values, handleMessage };
}

const quiet = () => {};

test('a read answers what was stored, and null for a key never stored', async () => {
  const core = rexCore();
  const store = createStore(core.handleMessage, { log: quiet });
  assert.deepEqual(await store.set('k', { a: 1 }), { ok: true, unanswered: false });
  assert.deepEqual(await store.get('k'), { value: { a: 1 }, unanswered: false });
  assert.deepEqual(await store.get('never'), { value: null, unanswered: false });
});

test('while rex-core\'s database is not open a read is unanswered at once and a write after the deadline', { timeout: 2000 }, async () => {
  const store = createStore(rexCore({ open: false }).handleMessage, { deadlineMs: 50, log: quiet });
  const started = performance.now();
  assert.deepEqual(await store.get('k'), { value: null, unanswered: true });
  assert.ok(performance.now() - started < 40, 'the read waited for a deadline no answer could beat');
  assert.deepEqual(await store.set('k', 1), { ok: false, unanswered: true });
});

test('by default a read and a write wait 1 s for an answer, then count as unanswered', async (t) => {
  assert.equal(STORE_DEADLINE_MS, 1000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const silent = (() => true) as unknown as HandleMessage;
  const store = createStore(silent, { log: quiet });
  const settled: string[] = [];
  const read = store.get('k').then((answer) => {
    settled.push('read');
    return answer;
  });
  const write = store.set('k', 1).then((answer) => {
    settled.push('write');
    return answer;
  });
  t.mock.timers.tick(999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settled, [], 'a call gave up before 1 s');
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settled, ['read', 'write'], 'a call was still waiting at 1 s');
  assert.deepEqual(await read, { value: null, unanswered: true });
  assert.deepEqual(await write, { ok: false, unanswered: true });
});

test('a read that gets no answer within the deadline counts as absent and is flagged', { timeout: 2000 }, async () => {
  const silent = (() => true) as unknown as HandleMessage;
  const store = createStore(silent, { deadlineMs: 20, log: quiet });
  assert.deepEqual(await store.get('k'), { value: null, unanswered: true });
});

test('a read that never gets an answer stays flagged through the mode and memo reads, and resendSince writes nothing after it', { timeout: 2000 }, async () => {
  // Taken (true) or not handled (false), the message is never answered.
  for (const handled of [true, false]) {
    const asked: string[] = [];
    const silent = ((message: Message) => {
      asked.push(`${message.messageType} ${message.key}`);
      return handled;
    }) as unknown as HandleMessage;
    const store = createStore(silent, { deadlineMs: 20, log: quiet });
    assert.deepEqual(await store.mode.get(), { value: null, unanswered: true, malformed: false }, `handled: ${handled}`);
    assert.deepEqual(await store.memo.get(CHAT), { value: null, unanswered: true, malformed: false }, `handled: ${handled}`);
    asked.length = 0;
    assert.equal(await resendSince(store, 'detail', 1700000000000), null, `handled: ${handled}`);
    assert.deepEqual(asked, ['fetchValue rex-spider-chatgpt-mode'], `handled: ${handled}`);
  }
});

test('an answer that comes after the deadline is ignored', { timeout: 2000 }, async () => {
  let late: ((response: unknown) => void) | null = null;
  const slow = ((_message: Message, _sender: unknown, sendResponse: (response: unknown) => void) => {
    late = sendResponse;
    return true;
  }) as unknown as HandleMessage;
  const lines: string[] = [];
  const store = createStore(slow, { deadlineMs: 20, log: (line) => lines.push(line) });
  assert.deepEqual(await store.get('k'), { value: null, unanswered: true });
  (late as unknown as (response: unknown) => void)('too late');
  assert.ok(lines.some((line) => line.includes('late answer')), 'the late answer was not logged');
});

test('a handleMessage that throws leaves the read and the write unanswered', async () => {
  const broken = (() => {
    throw new Error('boom');
  }) as unknown as HandleMessage;
  const store = createStore(broken, { log: quiet });
  assert.deepEqual(await store.get('k'), { value: null, unanswered: true });
  assert.deepEqual(await store.set('k', 1), { ok: false, unanswered: true });
});

test('the mode record reads back as written, and anything else stored there reads as absent and malformed', async () => {
  const core = rexCore();
  const store = createStore(core.handleMessage, { log: quiet });
  assert.deepEqual(await store.mode.get(), { value: null, unanswered: false, malformed: false });
  await store.mode.set({ mode: 'detail', since: 1700000000000 });
  assert.deepEqual(core.values.get('rex-spider-chatgpt-mode'), { mode: 'detail', since: 1700000000000 });
  assert.deepEqual(await store.mode.get(), { value: { mode: 'detail', since: 1700000000000 }, unanswered: false, malformed: false });
  for (const bad of [{ mode: 'other', since: 1 }, { mode: 'summary', since: -1 }, { mode: 'summary', since: 1.5 }, { mode: 'summary' }, 'detail', [1]]) {
    core.values.set('rex-spider-chatgpt-mode', bad);
    assert.deepEqual(await store.mode.get(), { value: null, unanswered: false, malformed: true }, JSON.stringify(bad));
  }
});

test('a detail memo reads back as written, and clearing it writes null', async () => {
  const core = rexCore();
  const store = createStore(core.handleMessage, { log: quiet });
  const memo = { ended: 1700000000000, at: 1700000100000, retryMs: 86_400_000, failures: 1 };
  await store.memo.set(CHAT, memo);
  assert.deepEqual(await store.memo.get(CHAT), { value: memo, unanswered: false, malformed: false });
  await store.memo.clear(CHAT);
  assert.equal(core.values.get(memoKey(CHAT)), null);
  assert.deepEqual(await store.memo.get(CHAT), { value: null, unanswered: false, malformed: false });
  core.values.set(memoKey(OTHER_CHAT), { ended: 1, at: 1, retryMs: 0, failures: 1 });
  assert.deepEqual(await store.memo.get(OTHER_CHAT), { value: null, unanswered: false, malformed: true });
});

test('log lines name a key\'s kind, never the chat id in it', { timeout: 2000 }, async () => {
  const lines: string[] = [];
  const store = createStore(rexCore({ open: false }).handleMessage, { deadlineMs: 20, log: (line) => lines.push(line) });
  await store.memo.get(CHAT);
  await store.memo.set(CHAT, { ended: 1, at: 1, retryMs: 1, failures: 1 });
  assert.ok(lines.length >= 2, 'Test setup invalid: nothing was logged, so the absence below would mean nothing');
  assert.ok(lines.every((line) => !line.includes(CHAT)), lines.join('\n'));
  assert.ok(lines.every((line) => line.includes('rex-spider-chatgpt-detail-memo')), lines.join('\n'));
});

test('a stored 0, false or empty string reads back as itself, not as absent', async () => {
  const store = createStore(rexCore().handleMessage, { log: quiet });
  for (const value of [0, false, '']) {
    await store.set('k', value);
    assert.deepEqual(await store.get('k'), { value, unanswered: false }, JSON.stringify(value));
  }
});

test('a call answered in time logs nothing when its deadline passes later', { timeout: 2000 }, async () => {
  const lines: string[] = [];
  const store = createStore(rexCore().handleMessage, { deadlineMs: 20, log: (line) => lines.push(line) });
  await store.get('k');
  await store.set('k', 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(lines, []);
});

test('an answer given before handleMessage throws still counts', async () => {
  const answersThenThrows = ((_message: Message, _sender: unknown, sendResponse: (response: unknown) => void) => {
    sendResponse('stored');
    throw new Error('after the answer');
  }) as unknown as HandleMessage;
  const lines: string[] = [];
  const store = createStore(answersThenThrows, { log: (line) => lines.push(line) });
  assert.deepEqual(await store.get('k'), { value: 'stored', unanswered: false });
  assert.deepEqual(lines, [], 'an answered call was logged as unanswered');
});

test('a write rex-core refuses answers not ok, and answered', async () => {
  const refuses = ((message: Message, _sender: unknown, sendResponse: (response: unknown) => void) => {
    queueMicrotask(() => sendResponse(message.messageType === 'storeValue' ? false : null));
    return true;
  }) as unknown as HandleMessage;
  const store = createStore(refuses, { log: quiet });
  assert.deepEqual(await store.set('k', 1), { ok: false, unanswered: false });
});

test('a write that handleMessage reports as unhandled still waits for its answer', { timeout: 2000 }, async () => {
  const answersLater = ((_message: Message, _sender: unknown, sendResponse: (response: unknown) => void) => {
    setTimeout(() => sendResponse(true), 5);
    return false;
  }) as unknown as HandleMessage;
  const store = createStore(answersLater, { deadlineMs: 200, log: quiet });
  assert.deepEqual(await store.set('k', 1), { ok: true, unanswered: false });
});

test('memo fields of the wrong form, and arrays dressed as records, read as malformed', async () => {
  const core = rexCore();
  const store = createStore(core.handleMessage, { log: quiet });
  const good = { ended: 1700000000000, at: 1700000100000, retryMs: 86_400_000, failures: 1 };
  for (const bad of [{ ...good, failures: 0 }, { ...good, ended: -1 }, { ...good, at: 1.5 }, Object.assign([], good)]) {
    core.values.set(memoKey(CHAT), bad);
    assert.deepEqual(await store.memo.get(CHAT), { value: null, unanswered: false, malformed: true }, JSON.stringify(bad));
  }
  core.values.set('rex-spider-chatgpt-mode', Object.assign([], { mode: 'summary', since: 1 }));
  assert.deepEqual(await store.mode.get(), { value: null, unanswered: false, malformed: true });
});
