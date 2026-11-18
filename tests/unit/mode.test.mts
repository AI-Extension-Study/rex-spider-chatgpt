import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { CLOCK_SKEW_MS, RESEND_WINDOW_MS, dueState, resendSince, sentAlready } from '../../src/mode.mts';
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
  assert.equal(await sentAlready(keys(['c_1-detail', ended]), 'c_1', at(ended), 'detail', SWITCH, 1), true);
});

test('a chat holding keys in both modes at this time, as every re-sent chat does, needs nothing', async () => {
  const ended = SWITCH - 3 * DAY;
  const both = keys(['c_1', ended], ['c_1-detail', ended]);
  for (const served of ['detail', 'summary'] as const) {
    assert.equal(await sentAlready(both, 'c_1', at(ended), served, SWITCH, 1), true, served);
  }
});

test('a chat never sent at this time is sent', async () => {
  const ended = SWITCH - 10 * DAY;
  assert.equal(await sentAlready(keys(['c_1', ended - 1000]), 'c_1', at(ended), 'detail', SWITCH, 1), false);
});

test('a chat with no key in either mode is sent, however long before the switch it was last used', async () => {
  const ended = SWITCH - 120 * DAY;
  for (const served of ['detail', 'summary'] as const) {
    assert.equal(await sentAlready(keys(), 'c_1', at(ended), served, SWITCH, 1), false, served);
  }
});

test('a chat sent in the other mode and last used within 90 days before the switch is sent again', async () => {
  for (const daysBefore of [0, 2, 81, 90]) {
    const ended = SWITCH - daysBefore * DAY;
    assert.equal(await sentAlready(keys(['c_1', ended]), 'c_1', at(ended), 'detail', SWITCH, 1), false, `${daysBefore} days before`);
  }
});

test('a chat sent in the other mode and last used more than 90 days before the switch keeps its record', async () => {
  const ended = SWITCH - 90 * DAY - 1000;
  assert.equal(await sentAlready(keys(['c_1', ended]), 'c_1', at(ended), 'detail', SWITCH, 1), true);
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
    assert.equal(await sentAlready(keys(['c_1', ms]), 'c_1', exactly(ms), 'detail', since, 1), kept, `${ms - boundary} ms from the boundary`);
  }
});

test('the rule runs both ways: back to summary, a detail-mode chat from the last 90 days is sent as a summary', async () => {
  const ended = SWITCH - 3 * DAY;
  assert.equal(await sentAlready(keys(['c_1-detail', ended]), 'c_1', at(ended), 'summary', SWITCH, 1), false);
  assert.equal(await sentAlready(keys(['c_1', ended]), 'c_1', at(ended), 'summary', SWITCH, 1), true);
});

test('back to summary, a chat whose detail record is from more than 90 days before the switch keeps it', async () => {
  const ended = SWITCH - 90 * DAY - 1000;
  assert.equal(await sentAlready(keys(['c_1-detail', ended]), 'c_1', at(ended), 'summary', SWITCH, 1), true);
});

test('with no start this pass, a chat sent in the other mode is held back, not sent', async () => {
  const ended = SWITCH - 3 * DAY;
  assert.equal(await sentAlready(keys(['c_1', ended]), 'c_1', at(ended), 'detail', null, 1), true);
  assert.equal(await sentAlready(keys(), 'c_1', at(ended), 'detail', null, 1), false);
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
  assert.equal(await sentAlready(held, 'c_1', at(ended), 'detail', since, 1), true);
  assert.equal(await sentAlready(held, 'c_2', at(ended), 'detail', since, 1), false);
});

test('the update itself: a browser with only summary keys, served detail, re-sends exactly the last 90 days', async () => {
  const fake = modeStore(read(null));
  const since = await resendSince(fake.store, 'detail', SWITCH);
  const chats: [string, number][] = [['c_nov18', SWITCH - 2 * DAY], ['c_sep1', SWITCH - 80 * DAY], ['c_jul1', SWITCH - 142 * DAY]];
  const held = keys(...chats);
  const resent = [];
  for (const [id, ended] of chats) {
    if (!(await sentAlready(held, id, at(ended), 'detail', since, 1))) resent.push(id);
  }
  assert.deepEqual(resent, ['c_nov18', 'c_sep1']);
});

test('what a chat needs this pass, three ways: sent, due, or held back for want of a start', async () => {
  const ended = SWITCH - 3 * DAY;
  const old = SWITCH - 100 * DAY;
  assert.equal(await dueState(keys(['c_1-detail', ended]), 'c_1', at(ended), 'detail', SWITCH, 1), 'sent');
  assert.equal(await dueState(keys(), 'c_1', at(ended), 'detail', SWITCH, 1), 'due');
  assert.equal(await dueState(keys(['c_1', ended]), 'c_1', at(ended), 'detail', SWITCH, 1), 'due');
  assert.equal(await dueState(keys(['c_1', old]), 'c_1', at(old), 'detail', SWITCH, 1), 'sent');
  assert.equal(await dueState(keys(['c_1', ended]), 'c_1', at(ended), 'detail', null, 1), 'held');
  assert.equal(await dueState(keys(['c_1', old]), 'c_1', at(old), 'detail', null, 1), 'held');
  assert.equal(await dueState(keys(), 'c_1', at(ended), 'detail', null, 1), 'due');
  assert.equal(await dueState(keys(['c_1-detail', ended]), 'c_1', at(ended), 'detail', null, 1), 'sent');
});

// Ended times across the crawl window: the last 90 days, the boundary, and
// well before it, where a switch of mode would not send again.
const WINDOW_DAYS = [0, 2, 81, 90, 91, 120, 400];

test('under format 2, a chat holding only format 1 keys in both modes is due, however long ago it was used and whatever the mode record says', async () => {
  // The browser served detail all along (a mode record from long ago), so
  // its served mode does not change at the update: only the format does.
  for (const since of [SWITCH, SWITCH - 300 * DAY, null]) {
    for (const days of WINDOW_DAYS) {
      const ended = SWITCH - days * DAY;
      const formatOne = keys(['c', ended], ['c-detail', ended]);
      for (const served of ['detail', 'summary'] as const) {
        assert.equal(await dueState(formatOne, 'c', at(ended), served, since, 2), 'due', `${served}, ${days} days, since ${since}`);
        assert.equal(await sentAlready(formatOne, 'c', at(ended), served, since, 2), false, `${served}, ${days} days, since ${since}`);
      }
    }
  }
});

test('under format 1 the same keys answer as before: sent', async () => {
  for (const since of [SWITCH, SWITCH - 300 * DAY, null]) {
    for (const days of WINDOW_DAYS) {
      const ended = SWITCH - days * DAY;
      const formatOne = keys(['c', ended], ['c-detail', ended]);
      for (const served of ['detail', 'summary'] as const) {
        assert.equal(await dueState(formatOne, 'c', at(ended), served, since, 1), 'sent', `${served}, ${days} days, since ${since}`);
      }
    }
  }
});

test('within format 2 the mode rule runs as within format 1, on the format 2 keys only', async () => {
  const ended = SWITCH - 3 * DAY;
  const old = SWITCH - 100 * DAY;
  assert.equal(await dueState(keys(['c-detail-f2', ended]), 'c', at(ended), 'detail', SWITCH, 2), 'sent');
  assert.equal(await dueState(keys(['c-f2', ended]), 'c', at(ended), 'detail', SWITCH, 2), 'due');
  assert.equal(await dueState(keys(['c-f2', old]), 'c', at(old), 'detail', SWITCH, 2), 'sent');
  assert.equal(await dueState(keys(['c-f2', ended]), 'c', at(ended), 'detail', null, 2), 'held');
  assert.equal(await dueState(keys(['c-detail-f2', ended]), 'c', at(ended), 'summary', SWITCH, 2), 'due');
  // A format 1 key next to them changes nothing.
  assert.equal(await dueState(keys(['c-f2', old], ['c-detail', old]), 'c', at(old), 'detail', SWITCH, 2), 'sent');
  assert.equal(await dueState(keys(['c-f2', ended], ['c-detail', ended]), 'c', at(ended), 'detail', null, 2), 'held');
});
