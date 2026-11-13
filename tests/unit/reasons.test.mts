import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REASON_CODES, STOPS, formatReason } from '../../src/reasons.mts';

test('a reason is its code, then each field the catalogue lists for it, in the catalogue\'s order', () => {
  assert.equal(formatReason('ok', { ms: 1200, dispatched: 2, seen: 3 }), 'ok seen=3 dispatched=2 ms=1200');
  assert.equal(formatReason('partial', { seen: 3, dispatched: 0, failed: 1, held: 2, left: 1, stop: 'failed-reads', ms: 5 }), 'partial seen=3 dispatched=0 failed=1 held=2 left=1 stop=failed-reads ms=5');
  assert.equal(formatReason('not-signed-in', { stage: 'home', ms: 7 }), 'not-signed-in stage=home ms=7');
  assert.equal(formatReason('not-signed-in', { stage: 'list', status: 401, ms: 7 }), 'not-signed-in stage=list status=401 ms=7');
  assert.equal(formatReason('rate-limited', { stage: 'home', status: 429, 'retry-after': 120, ms: 3 }), 'rate-limited stage=home status=429 retry-after=120 ms=3');
  assert.equal(formatReason('list-failed', { ms: 0 }), 'list-failed ms=0');
});

test('an optional field is left out when it is not given, and a required one cannot be', () => {
  assert.equal(formatReason('ok', { seen: 0, dispatched: 0, ms: 0 }), 'ok seen=0 dispatched=0 ms=0');
  assert.throws(() => formatReason('ok', { seen: 0, ms: 0 } as never), /dispatched: required/);
  assert.throws(() => formatReason('http-error', { stage: 'home', ms: 0 } as never), /status: required/);
});

test('no field takes text: a string where a count goes, a value outside a fixed set, or a key the catalogue does not list is refused', () => {
  assert.throws(() => formatReason('ok', { seen: 'https://chatgpt.com/c/1' as never, dispatched: 0, ms: 0 }), /seen/);
  assert.throws(() => formatReason('ok', { seen: 1, dispatched: 0, stop: 'the server said: slow down' as never, ms: 0 }), /stop/);
  assert.throws(() => formatReason('not-signed-in', { stage: 'detail' as never, ms: 0 }), /stage/);
  assert.throws(() => formatReason('ok', { seen: 1, dispatched: 0, ms: 0, note: 'x' } as never), /unknown key/);
  assert.throws(() => formatReason('no-such-code' as never, { ms: 0 } as never), /not in the catalogue/);
});

test('a count is a whole number of at least 0', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => formatReason('ok', { seen: bad, dispatched: 0, ms: 0 }), /seen/, String(bad));
  }
});

test('the stops are the closed set the pass can end its sending with', () => {
  assert.deepEqual([...STOPS], ['budget', 'mode', 'disabled', 'rate-limited', 'challenge', 'not-signed-in', 'failed-reads', 'halt-on-error', 'store', 'internal']);
  for (const stop of STOPS) {
    assert.equal(formatReason('ok', { seen: 1, dispatched: 1, stop, ms: 1 }), `ok seen=1 dispatched=1 stop=${stop} ms=1`);
  }
});

test('every code can be written, and what comes out holds only lowercase names, digits, ISO times and the separators', () => {
  const samples: Record<string, Record<string, unknown>> = {
    ok: { seen: 1, dispatched: 1, ms: 1 },
    partial: { seen: 1, dispatched: 1, ms: 1 },
    'list-failed': { ms: 1 },
    'not-signed-in': { stage: 'home', ms: 1 },
    'rate-limited': { stage: 'list', ms: 1 },
    challenge: { stage: 'home', status: 403, ms: 1 },
    'http-error': { stage: 'home', status: 500, ms: 1 },
    network: { stage: 'home', ms: 1 },
    timeout: { stage: 'home', ms: 1 },
    disabled: { stage: 'start', ms: 1 },
    store: { ms: 1 },
    internal: { stage: 'list', ms: 1 },
    backoff: { until: Date.UTC(2026, 10, 20), code: 'challenge' },
  };
  assert.deepEqual([...REASON_CODES].sort(), Object.keys(samples).sort());
  for (const code of REASON_CODES) {
    const reason = formatReason(code, samples[code] as never);
    // An ISO time is the one value with capitals, colons and a point.
    assert.match(reason, /^[a-z-]+( [a-z-]+=([a-z0-9-]+|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z))+$/, reason);
  }
});

test('a skipped pass names when its back-off runs out, as an ISO time, and what asked for it', () => {
  assert.equal(formatReason('backoff', { until: Date.UTC(2026, 10, 20, 12, 5), code: 'rate-limited' }), 'backoff until=2026-11-20T12:05:00.000Z code=rate-limited');
  assert.equal(formatReason('backoff', { until: new Date(Date.UTC(2026, 10, 20, 12, 5)), code: 'challenge' }), 'backoff until=2026-11-20T12:05:00.000Z code=challenge');
  assert.throws(() => formatReason('backoff', { until: Number.NaN, code: 'rate-limited' }), /until/);
  assert.throws(() => formatReason('backoff', { until: 'tomorrow' as never, code: 'rate-limited' }), /until/);
  assert.throws(() => formatReason('backoff', { until: 1, code: 'provider-refused' as never }), /code/);
});
