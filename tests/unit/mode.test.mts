import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { CLOCK_SKEW_MS, RESEND_WINDOW_MS, resendSince, sentAlready } from '../../src/mode.mts';
import { type HandleMessage, type ModeRecord, type Read, type Write, createStore } from '../../src/store.mts';

const DAY = 24 * 60 * 60 * 1000;
const SWITCH = Date.UTC(2026, 10, 20);

function modeStore(stored: Read<ModeRecord>, write: Write = { ok: true, unanswered: false }) {
  const writes: ModeRecord[] = [];
  return {
    writes,
    store: {
      mode: {
        get: async () => stored,
        set: async (record: ModeRecord) => {
          writes.push(record);
          return write;
        },
      },
    },
  };
}

const read = (value: ModeRecord | null, flags: Partial<Read<ModeRecord>> = {}): Read<ModeRecord> => ({ value, unanswered: false, malformed: false, ...flags });

test('the re-send window is 90 days', () => {
  assert.equal(RESEND_WINDOW_MS, 7_776_000_000);
});

test('with no record, as on the first pass after an update, the served mode starts now', async () => {
  const fake = modeStore(read(null));
  assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH);
  assert.deepEqual(fake.writes, [{ mode: 'detail', since: SWITCH }]);
});

test('a record of the served mode keeps its start and is not written again', async () => {
  const fake = modeStore(read({ mode: 'detail', since: SWITCH - 5 * DAY }));
  assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH - 5 * DAY);
  assert.deepEqual(fake.writes, []);
});

test('a record of the other mode, or a malformed one, is replaced by the served mode from now', async () => {
  for (const stored of [read({ mode: 'summary', since: SWITCH - 50 * DAY }), read(null, { malformed: true })]) {
    const fake = modeStore(stored);
    assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH);
    assert.deepEqual(fake.writes, [{ mode: 'detail', since: SWITCH }]);
  }
});

test('a start more than a day ahead of now, written under a clock that ran fast, is replaced by now', async () => {
  assert.equal(CLOCK_SKEW_MS, 86_400_000);
  const fake = modeStore(read({ mode: 'detail', since: SWITCH + 365 * DAY }));
  assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH);
  assert.deepEqual(fake.writes, [{ mode: 'detail', since: SWITCH }]);
  const close = modeStore(read({ mode: 'detail', since: SWITCH + DAY }));
  assert.equal(await resendSince(close.store, 'detail', SWITCH), SWITCH + DAY);
  assert.deepEqual(close.writes, []);
  const past = modeStore(read({ mode: 'detail', since: SWITCH + DAY + 1 }));
  assert.equal(await resendSince(past.store, 'detail', SWITCH), SWITCH);
  assert.deepEqual(past.writes, [{ mode: 'detail', since: SWITCH }]);
});

test('a record that could not be read, or a new one that could not be written, gives no start this pass', async () => {
  const unread = modeStore(read(null, { unanswered: true }));
  assert.equal(await resendSince(unread.store, 'detail', SWITCH), null);
  assert.deepEqual(unread.writes, []);
  for (const failed of [{ ok: false, unanswered: true }, { ok: false, unanswered: false }]) {
    const fake = modeStore(read({ mode: 'summary', since: 1 }), failed);
    assert.equal(await resendSince(fake.store, 'detail', SWITCH), null, JSON.stringify(failed));
  }
});

// The upload keys a browser holds, as rex-spider's checkIfAlreadyTransmitted sees them.
function keys(...held: [string, number][]) {
  const set = new Set(held.map(([id, ms]) => `${id} ${ms}`));
  return async (id: string, ended: DateString) => set.has(`${id} ${Math.round(ended.timestamp())}`);
}

const at = (ms: number) => new DateString(ms / 1000);

test('a chat sent in the served mode at this time needs nothing', async () => {
  const ended = SWITCH - 10 * DAY;
  assert.equal(await sentAlready(keys(['c_1-detail', ended]), 'c_1', at(ended), 'detail', SWITCH), true);
});

test('a chat holding keys in both modes at this time, as every re-sent chat does, needs nothing', async () => {
  const ended = SWITCH - 3 * DAY;
  const both = keys(['c_1', ended], ['c_1-detail', ended]);
  for (const served of ['detail', 'summary'] as const) {
    assert.equal(await sentAlready(both, 'c_1', at(ended), served, SWITCH), true, served);
  }
});

test('a chat never sent at this time is sent', async () => {
  const ended = SWITCH - 10 * DAY;
  assert.equal(await sentAlready(keys(['c_1', ended - 1000]), 'c_1', at(ended), 'detail', SWITCH), false);
});

test('a chat with no key in either mode is sent, however long before the switch it was last used', async () => {
  const ended = SWITCH - 120 * DAY;
  for (const served of ['detail', 'summary'] as const) {
    assert.equal(await sentAlready(keys(), 'c_1', at(ended), served, SWITCH), false, served);
  }
});

test('a chat sent in the other mode and last used within 90 days before the switch is sent again', async () => {
  for (const daysBefore of [0, 2, 81, 90]) {
    const ended = SWITCH - daysBefore * DAY;
    assert.equal(await sentAlready(keys(['c_1', ended]), 'c_1', at(ended), 'detail', SWITCH), false, `${daysBefore} days before`);
  }
});

test('a chat sent in the other mode and last used more than 90 days before the switch keeps its record', async () => {
  const ended = SWITCH - 90 * DAY - 1000;
  assert.equal(await sentAlready(keys(['c_1', ended]), 'c_1', at(ended), 'detail', SWITCH), true);
});

// An instant read from its ISO string, exact to the millisecond, where
// new DateString(ms / 1000) can land 1 ms early.
const exactly = (ms: number) => new DateString(new Date(ms).toISOString());

test('the 90 days end at the millisecond: last used at the boundary or 1 ms inside it, sent again; 1 ms before it, kept', async () => {
  // A start with a millisecond part, as Date.now() gives, so a rule that cut
  // times to whole seconds would show here too.
  const since = SWITCH + 456;
  const boundary = since - 90 * DAY;
  const cases: [number, boolean][] = [[boundary + 1, false], [boundary, false], [boundary - 1, true]];
  for (const [ms, kept] of cases) {
    assert.equal(exactly(ms).timestamp(), ms, 'Test setup invalid: the instant is not exact to the millisecond');
    assert.equal(await sentAlready(keys(['c_1', ms]), 'c_1', exactly(ms), 'detail', since), kept, `${ms - boundary} ms from the boundary`);
  }
});

test('the rule runs both ways: back to summary, a detail-mode chat from the last 90 days is sent as a summary', async () => {
  const ended = SWITCH - 3 * DAY;
  assert.equal(await sentAlready(keys(['c_1-detail', ended]), 'c_1', at(ended), 'summary', SWITCH), false);
  assert.equal(await sentAlready(keys(['c_1', ended]), 'c_1', at(ended), 'summary', SWITCH), true);
});

test('back to summary, a chat whose detail record is from more than 90 days before the switch keeps it', async () => {
  const ended = SWITCH - 90 * DAY - 1000;
  assert.equal(await sentAlready(keys(['c_1-detail', ended]), 'c_1', at(ended), 'summary', SWITCH), true);
});

test('with no start this pass, a chat sent in the other mode is held back, not sent', async () => {
  const ended = SWITCH - 3 * DAY;
  assert.equal(await sentAlready(keys(['c_1', ended]), 'c_1', at(ended), 'detail', null), true);
  assert.equal(await sentAlready(keys(), 'c_1', at(ended), 'detail', null), false);
});

test('a mode record rex-core does not answer for holds the other mode\'s chats back this pass, and new chats still go', async () => {
  // Only the mode record's read goes unanswered here: rex-core does not
  // handle it, as while its database is not open. The upload-key lookups are
  // a stand-in that answers, so the test can show what a null start does to a
  // chat sent in the other mode and to a new one.
  const asked: string[] = [];
  const handleMessage = ((message: { messageType: string; key: string }) => {
    asked.push(`${message.messageType} ${message.key}`);
    return false;
  }) as unknown as HandleMessage;
  const store = createStore(handleMessage, { deadlineMs: 20, log: () => {} });
  const since = await resendSince(store, 'detail', SWITCH);
  assert.equal(since, null);
  // The null comes from the read itself: no write was tried.
  assert.deepEqual(asked, ['fetchValue rex-spider-chatgpt-mode']);
  const ended = SWITCH - 3 * DAY;
  const held = keys(['c_1', ended]);
  assert.equal(await sentAlready(held, 'c_1', at(ended), 'detail', since), true);
  assert.equal(await sentAlready(held, 'c_2', at(ended), 'detail', since), false);
});

test('the update itself: a browser with only summary keys, served detail, re-sends exactly the last 90 days', async () => {
  const fake = modeStore(read(null));
  const since = await resendSince(fake.store, 'detail', SWITCH);
  const chats: [string, number][] = [['c_nov18', SWITCH - 2 * DAY], ['c_sep1', SWITCH - 80 * DAY], ['c_jul1', SWITCH - 142 * DAY]];
  const held = keys(...chats);
  const resent = [];
  for (const [id, ended] of chats) {
    if (!(await sentAlready(held, id, at(ended), 'detail', since))) resent.push(id);
  }
  assert.deepEqual(resent, ['c_nov18', 'c_sep1']);
});
