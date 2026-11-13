import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REASON_CODES, STOPS, formatReason } from '../../src/reasons.mts';

test('a reason is its code, then each field the catalogue lists for it, in the catalogue\'s order', () => {
  assert.equal(formatReason('ok', { ms: 1200, sent: 2, listed: 3 }), 'ok listed=3 sent=2 ms=1200');
  assert.equal(formatReason('partial', { listed: 3, sent: 0, failed: 1, held: 2, left: 1, stop: 'failed-reads', ms: 5 }), 'partial listed=3 sent=0 failed=1 held=2 left=1 stop=failed-reads ms=5');
  assert.equal(formatReason('not-signed-in', { stage: 'home', ms: 7 }), 'not-signed-in stage=home ms=7');
  assert.equal(formatReason('not-signed-in', { stage: 'list', status: 401, ms: 7 }), 'not-signed-in stage=list status=401 ms=7');
  assert.equal(formatReason('rate-limited', { stage: 'home', status: 429, 'retry-after': 120, ms: 3 }), 'rate-limited stage=home status=429 retry-after=120 ms=3');
  assert.equal(formatReason('list-failed', { ms: 0 }), 'list-failed ms=0');
});

test('an optional field is left out when it is not given, and a required one cannot be', () => {
  assert.equal(formatReason('ok', { listed: 0, sent: 0, ms: 0 }), 'ok listed=0 sent=0 ms=0');
  assert.throws(() => formatReason('ok', { listed: 0, ms: 0 } as never), /sent: required/);
  assert.throws(() => formatReason('http-error', { stage: 'home', ms: 0 } as never), /status: required/);
});

test('no field takes text: a string where a count goes, a value outside a fixed set, or a key the catalogue does not list is refused', () => {
  assert.throws(() => formatReason('ok', { listed: 'https://chatgpt.com/c/1' as never, sent: 0, ms: 0 }), /listed/);
  assert.throws(() => formatReason('ok', { listed: 1, sent: 0, stop: 'the server said: slow down' as never, ms: 0 }), /stop/);
  assert.throws(() => formatReason('not-signed-in', { stage: 'detail' as never, ms: 0 }), /stage/);
  assert.throws(() => formatReason('ok', { listed: 1, sent: 0, ms: 0, note: 'x' } as never), /unknown key/);
  assert.throws(() => formatReason('no-such-code' as never, { ms: 0 } as never), /not in the catalogue/);
});

test('a count is a whole number of at least 0', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => formatReason('ok', { listed: bad, sent: 0, ms: 0 }), /listed/, String(bad));
  }
});

test('the stops are the closed set the pass can end its sending with', () => {
  assert.deepEqual([...STOPS], ['budget', 'mode', 'disabled', 'rate-limited', 'challenge', 'not-signed-in', 'failed-reads', 'halt-on-error', 'store', 'internal']);
  for (const stop of STOPS) {
    assert.equal(formatReason('ok', { listed: 1, sent: 1, stop, ms: 1 }), `ok listed=1 sent=1 stop=${stop} ms=1`);
  }
});

test('every code can be written, and what comes out holds only lowercase names, digits and the separators', () => {
  const samples: Record<string, Record<string, unknown>> = {
    ok: { listed: 1, sent: 1, ms: 1 },
    partial: { listed: 1, sent: 1, ms: 1 },
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
  };
  assert.deepEqual([...REASON_CODES].sort(), Object.keys(samples).sort());
  for (const code of REASON_CODES) {
    const reason = formatReason(code, samples[code] as never);
    assert.match(reason, /^[a-z-]+( [a-z-]+=[a-z0-9-]+)+$/, reason);
  }
});
