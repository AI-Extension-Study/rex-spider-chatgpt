import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Answer, REQUEST_TIMEOUT_MS, RequestError, classify, createClient, retryAfterMs } from '../../src/client.mts';

const answer = (status: number, text = '{"items":[]}', headers: Record<string, string> = {}): Answer => ({ status, headers, text });

// One case per row of the failure policy's table.
const TABLE: [string, Answer, string][] = [
  ['200 with a JSON body', answer(200), 'ok'],
  ['200 with a JSON array', answer(200, '[]'), 'ok'],
  ['200 with an HTML body', answer(200, '<html>Just a moment...</html>'), 'not-json'],
  ['200 with an empty body', answer(200, ''), 'not-json'],
  ['401', answer(401, '{"detail":"x"}'), 'signed-out'],
  ['403', answer(403, '{"detail":"x"}'), 'refused'],
  ['404 (any other 4xx is a refusal too)', answer(404), 'refused'],
  ['429', answer(429), 'rate-limited'],
  ['503', answer(503), 'rate-limited'],
  ['Retry-After on a 500', answer(500, '', { 'retry-after': '5' }), 'rate-limited'],
  ['Retry-After on a 403 (a wait beats a refusal)', answer(403, '', { 'retry-after': '5' }), 'rate-limited'],
  ['Retry-After on a 200', answer(200, '{}', { 'retry-after': '5' }), 'rate-limited'],
  ['Retry-After spelled with capitals', answer(200, '{}', { 'Retry-After': '5' }), 'rate-limited'],
  ['cf-mitigated on a 403', answer(403, '<html>', { 'cf-mitigated': 'challenge' }), 'challenge'],
  ['cf-mitigated on a 200', answer(200, '<html>', { 'cf-mitigated': 'challenge' }), 'challenge'],
  ['cf-mitigated on a 503 (a challenge beats a wait)', answer(503, '<html>', { 'cf-mitigated': 'challenge' }), 'challenge'],
  ['cf-mitigated spelled with capitals', answer(403, '<html>', { 'CF-Mitigated': 'challenge' }), 'challenge'],
  ['500', answer(500), 'server'],
  ['502', answer(502), 'server'],
  ['504', answer(504), 'server'],
  ['a redirect that was not followed', answer(302, ''), 'server'],
];

for (const [name, given, expected] of TABLE) {
  test(`classify: ${name} is ${expected}`, () => {
    assert.equal(classify(given), expected);
  });
}

const NOW = Date.parse('2026-11-12T10:00:00Z');

test('retryAfterMs reads a number of seconds into milliseconds', () => {
  assert.equal(retryAfterMs(answer(429, '', { 'retry-after': '120' }), NOW), 120_000);
  assert.equal(retryAfterMs(answer(429, '', { 'retry-after': '0' }), NOW), 0);
  assert.equal(retryAfterMs(answer(429, '', { 'Retry-After': ' 7 ' }), NOW), 7000);
});

test('retryAfterMs reads an HTTP date as the wait from now', () => {
  const header = { 'retry-after': 'Thu, 12 Nov 2026 10:02:00 GMT' };
  assert.equal(retryAfterMs(answer(503, '', header), NOW), 120_000);
});

test('retryAfterMs is 0 for an HTTP date that has passed', () => {
  assert.equal(retryAfterMs(answer(503, '', { 'retry-after': 'Thu, 12 Nov 2026 09:00:00 GMT' }), NOW), 0);
});

test('retryAfterMs is null when there is no usable header', () => {
  assert.equal(retryAfterMs(answer(429), NOW), null);
  assert.equal(retryAfterMs(answer(429, '', { 'retry-after': '' }), NOW), null);
  assert.equal(retryAfterMs(answer(429, '', { 'retry-after': 'soon' }), NOW), null);
  assert.equal(retryAfterMs(answer(429, '', { 'retry-after': '-5' }), NOW), null);
  // Date.parse reads both of these as a year or a month, so they are checked by shape first.
  assert.equal(retryAfterMs(answer(429, '', { 'retry-after': '1.5' }), NOW), null);
  assert.equal(retryAfterMs(answer(429, '', { 'retry-after': '99999999999999999999' }), NOW), null);
});

test('retryAfterMs reads the clock when none is given', () => {
  const ms = retryAfterMs(answer(429, '', { 'retry-after': new Date(Date.now() + 60_000).toUTCString() }));
  assert.ok(ms !== null && ms > 50_000 && ms <= 60_000, `got ${ms}`);
});

interface Call {
  url: string;
  init: RequestInit;
}

const respond = (build: () => Response, calls: Call[] = []) => async (url: string, init: RequestInit) => {
  calls.push({ url, init });
  return build();
};

test('get sends the token as a bearer header, and nothing else in the headers', async () => {
  const calls: Call[] = [];
  const client = createClient({ token: 'TOKEN-VALUE', fetch: respond(() => new Response('{}'), calls) });
  await client.get('https://chatgpt.com/backend-api/conversations?offset=0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/conversations?offset=0');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer TOKEN-VALUE' });
});

test('get answers any status with its headers (lower-cased) and its body, and does not throw on 429', async () => {
  const client = createClient({
    token: 'T',
    fetch: respond(() => new Response('{"detail":"slow down"}', { status: 429, headers: { 'Retry-After': '30', 'Content-Type': 'application/json' } })),
  });
  const got = await client.get('https://chatgpt.com/x');
  assert.equal(got.status, 429);
  assert.equal(got.text, '{"detail":"slow down"}');
  assert.equal(got.headers['retry-after'], '30');
  assert.equal(got.headers['content-type'], 'application/json');
  assert.equal(classify(got), 'rate-limited');
});

test('requests time out after 30 s unless told otherwise', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 30_000);
});

test('a request with no answer within the timeout is aborted and throws a timeout', { timeout: 2000 }, async () => {
  let signal: AbortSignal | null = null;
  const client = createClient({
    token: 'T',
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal ?? null;
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  });
  await assert.rejects(client.get('https://chatgpt.com/x'), (error: unknown) => error instanceof RequestError && error.kind === 'timeout');
  assert.equal((signal as AbortSignal | null)?.aborted, true);
});

test('a fetch that ignores the abort still ends at the timeout', { timeout: 2000 }, async () => {
  const client = createClient({ token: 'T', timeoutMs: 20, fetch: () => new Promise(() => {}) });
  await assert.rejects(client.get('https://chatgpt.com/x'), (error: unknown) => error instanceof RequestError && error.kind === 'timeout');
});

test('a body that never finishes is cut at the same timeout', { timeout: 2000 }, async () => {
  const client = createClient({ token: 'T', timeoutMs: 20, fetch: respond(() => new Response(new ReadableStream({ start() {} }))) });
  await assert.rejects(client.get('https://chatgpt.com/x'), (error: unknown) => error instanceof RequestError && error.kind === 'timeout');
});

test('a client made without a timeout aborts at 30 s, not before', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = createClient({ token: 'T', fetch: () => new Promise(() => {}) });
  let settled = false;
  const outcome = client.get('https://chatgpt.com/x').then(
    () => {
      settled = true;
      return 'answered';
    },
    (error: unknown) => {
      settled = true;
      return error instanceof RequestError ? error.kind : 'other';
    },
  );
  t.mock.timers.tick(29_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'ended before 30 s');
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, 'still waiting at 30 s');
  assert.equal(await outcome, 'timeout');
});

test('a request that answered leaves no timer behind to abort its signal later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null = null;
  const client = createClient({
    token: 'T',
    fetch: async (_url, init) => {
      signal = init.signal ?? null;
      return new Response('{}');
    },
  });
  await client.get('https://chatgpt.com/x');
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  assert.equal((signal as AbortSignal | null)?.aborted, false, 'a timer aborted a request that had already answered');
});

test('a fetch that rejects throws a network error that carries nothing from the failure', async () => {
  const client = createClient({
    token: 'TOKEN-VALUE',
    fetch: async (url) => {
      throw new TypeError(`Failed to fetch ${url} with Bearer TOKEN-VALUE SECRET-TITLE`);
    },
  });
  await assert.rejects(client.get('https://chatgpt.com/backend-api/gizmos/g-p-abc/conversations'), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.kind, 'network');
    const shown = `${error.name} ${error.message} ${String(error.stack).split('\n')[0]} ${JSON.stringify(error)} ${String(error.cause)}`;
    for (const secret of ['TOKEN-VALUE', 'SECRET-TITLE', 'g-p-abc', 'chatgpt.com']) {
      assert.ok(!shown.includes(secret), `the error shows ${secret}`);
    }
    return true;
  });
});

test('a timeout error carries no URL or token either', { timeout: 2000 }, async () => {
  const client = createClient({ token: 'TOKEN-VALUE', timeoutMs: 10, fetch: () => new Promise(() => {}) });
  await assert.rejects(client.get('https://chatgpt.com/backend-api/gizmos/g-p-abc/conversations'), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    const shown = `${error.name} ${error.message} ${JSON.stringify(error)}`;
    for (const secret of ['TOKEN-VALUE', 'g-p-abc', 'chatgpt.com']) {
      assert.ok(!shown.includes(secret), `the error shows ${secret}`);
    }
    return true;
  });
});
