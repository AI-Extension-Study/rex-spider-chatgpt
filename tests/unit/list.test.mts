import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { type Answer, RequestError } from '../../src/client.mts';
import { type CrawlWindow, type ListItem, MAX_PAGES, walkLists, uploadTime } from '../../src/list.mts';

// The URLs are written out here and not built from the source's constants, so
// a change to one of them fails a test. The first four are the ones the
// capture of 2026-11-12 requested and got 200 for.
const API = 'https://chatgpt.com/backend-api';
const MAIN = (offset: number) => `${API}/conversations?offset=${offset}&limit=28&order=updated&is_archived=false&is_starred=false`;
const ARCHIVED = (offset: number) => `${API}/conversations?offset=${offset}&limit=28&order=updated&is_archived=true`;
const STARRED = (offset: number) => `${API}/conversations?offset=${offset}&limit=28&order=updated&is_starred=true`;
const SIDEBAR = `${API}/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=28`;
const SIDEBAR_AT = (cursor: string) => `${SIDEBAR}&cursor=${cursor}`;
const PROJECT = (id: string, cursor: string) => `${API}/gizmos/${id}/conversations?cursor=${cursor}`;

const P1 = 'g-p-0000000000000000000000000000aaaa';
const P2 = 'g-p-0000000000000000000000000000bbbb';

// The example of the map of 2026-11-12: on the project path, 1788875383781 ms
// comes out of new DateString(Date.parse(t) / 1000) as 1788875383780.
const T0 = 1788875383781;
const iso = (ms: number, micros = '000') => new Date(ms).toISOString().replace('Z', `${micros}Z`);
const chatId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const IN_WINDOW: CrawlWindow = { start: T0 - 1_000_000, end: null };
const BEFORE_WINDOW = T0 - 5_000_000;

// A main-list item: the fields of the capture's list items, with a marker in
// each field the walk must never log.
const entry = (n: number, ms = T0 - n * 1000) => ({
  id: chatId(n),
  title: `SECRET-TITLE-${n}`,
  create_time: iso(ms - 60_000, '123'),
  update_time: iso(ms, '456'),
  is_archived: false,
  is_starred: null,
});
// A project item also carries a text snippet and an owner.
const projectEntry = (n: number, ms = T0 - n * 1000) => ({
  ...entry(n, ms),
  gizmo_id: P1,
  snippet: `SECRET-SNIPPET-${n}`,
  owner: { user_email: `SECRET-EMAIL-${n}@example.com`, name: `SECRET-NAME-${n}` },
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Answer => ({ status, headers, text: JSON.stringify(body) });
const page = (items: unknown[], extra: Record<string, unknown> = {}) => json({ items, total: 99, limit: 28, offset: 0, ...extra });
const empty = () => page([]);
const projectPage = (items: unknown[], cursor: string | null | undefined) => json(cursor === undefined ? { items } : { items, cursor });
const sidebarOf = (...ids: unknown[]) => ({ items: ids.map((id) => ({ gizmo: { gizmo: { id }, flair: null }, files: [] })) });

type Reply = Answer | Error;

// A fake server: answers by URL (the nth request for the same URL takes the
// nth reply, the last one repeating) and records every request and wait, in
// order, so a test sees what the walk did between two requests.
function run(
  table: Record<string, Reply | Reply[]>,
  options: { window?: CrawlWindow; delay?: number; maxPages?: number; maxRequests?: number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const events: string[] = [];
  const urls: string[] = [];
  const logs: string[] = [];
  const seen = new Map<string, number>();
  const client = {
    get: async (url: string): Promise<Answer> => {
      events.push(`get ${url}`);
      urls.push(url);
      const replies = table[url];
      if (replies === undefined) {
        throw new Error(`nothing scripted for ${url}`);
      }
      const list = Array.isArray(replies) ? replies : [replies];
      const n = seen.get(url) ?? 0;
      seen.set(url, n + 1);
      const reply = list[Math.min(n, list.length - 1)];
      if (reply instanceof Error) {
        throw reply;
      }
      return reply;
    },
  };
  const pace = {
    crawlDelay: () => options.delay ?? 30_000,
    sleep:
      options.sleep ??
      (async (ms: number) => {
        events.push(`wait ${ms}`);
      }),
  };
  const result = walkLists(client, options.window ?? IN_WINDOW, pace, { log: (line) => logs.push(line), maxPages: options.maxPages, maxRequests: options.maxRequests });
  return { result, events, urls, logs };
}

// A walk that finds nothing on any list: main, archived, starred and the
// sidebar, each answered once with an empty page.
const NOTHING: Record<string, Reply> = { [MAIN(0)]: empty(), [ARCHIVED(0)]: empty(), [STARRED(0)]: empty(), [SIDEBAR]: json({ items: [] }) };
const ids = (items: ListItem[]) => items.map((item) => item.id);

test('walks main, archived, starred, the sidebar and each project at exactly the URLs the capture requested, crawl_delay apart', async () => {
  const fake = run({
    [MAIN(0)]: page([entry(1), entry(2)]),
    [MAIN(28)]: page([entry(3)]),
    [MAIN(56)]: empty(),
    [ARCHIVED(0)]: page([entry(4)]),
    [ARCHIVED(28)]: empty(),
    [STARRED(0)]: page([entry(5)]),
    [STARRED(28)]: empty(),
    [SIDEBAR]: json(sidebarOf(P1, 'g-notaproject')),
    [PROJECT(P1, '0')]: projectPage([projectEntry(6)], 'next-1'),
    [PROJECT(P1, 'next-1')]: projectPage([projectEntry(7)], null),
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls, [
    MAIN(0), MAIN(28), MAIN(56),
    ARCHIVED(0), ARCHIVED(28),
    STARRED(0), STARRED(28),
    SIDEBAR,
    PROJECT(P1, '0'), PROJECT(P1, 'next-1'),
  ]);
  // A wait before every request but the first, and none after the last.
  assert.deepEqual(
    fake.events,
    fake.urls.flatMap((url, i) => (i === 0 ? [`get ${url}`] : ['wait 30000', `get ${url}`])),
  );
  assert.equal(fake.events.filter((event) => event.startsWith('wait')).length, fake.urls.length - 1);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'whole', reason: 'ok' });
  assert.deepEqual(ids(result.items), [1, 2, 3, 4, 5, 6, 7].map(chatId));
  assert.deepEqual(result.items.map((item) => item.source), ['main', 'main', 'main', 'archived', 'starred', 'project', 'project']);
});

test('the main list is requested byte for byte as before', async () => {
  const fake = run(NOTHING);
  await fake.result;
  assert.equal(fake.urls[0], 'https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false');
});

test('a later page of the sidebar sets cursor on the same URL, and a project walk starts at cursor=0', async () => {
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json({ ...sidebarOf(P1), cursor: 'S 2/+=' }),
    [SIDEBAR_AT('S+2%2F%2B%3D')]: json(sidebarOf(P2)),
    [PROJECT(P1, '0')]: projectPage([], undefined),
    [PROJECT(P2, '0')]: projectPage([], null),
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls.slice(3), [SIDEBAR, SIDEBAR_AT('S+2%2F%2B%3D'), PROJECT(P1, '0'), PROJECT(P2, '0')]);
  assert.equal(result.outcome, 'whole');
});

test('a project walk follows body.cursor until it is null, undefined or empty, or a page has no items', async () => {
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json(sidebarOf(P1, P2)),
    // P1: the cursor goes missing on the second page (undefined ends it, it must not restart at 0).
    [PROJECT(P1, '0')]: projectPage([projectEntry(1)], 'a'),
    [PROJECT(P1, 'a')]: projectPage([projectEntry(2)], undefined),
    // P2: a page with no items ends it even though it names a cursor.
    [PROJECT(P2, '0')]: projectPage([projectEntry(3)], 'b'),
    [PROJECT(P2, 'b')]: projectPage([], 'c'),
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls.slice(4), [PROJECT(P1, '0'), PROJECT(P1, 'a'), PROJECT(P2, '0'), PROJECT(P2, 'b')]);
  assert.deepEqual(ids(result.items), [1, 2, 3].map(chatId));
  assert.equal(result.outcome, 'whole');
});

test('a project listed twice on the sidebar is walked once', async () => {
  const fake = run({ ...NOTHING, [SIDEBAR]: json(sidebarOf(P1, P1)), [PROJECT(P1, '0')]: projectPage([], null) });
  await fake.result;
  assert.equal(fake.urls.filter((url) => url === PROJECT(P1, '0')).length, 1);
});

test('only g-p- gizmos are projects; other sidebar entries are skipped without making the walk partial', async () => {
  const fake = run({ ...NOTHING, [SIDEBAR]: json({ items: [{ gizmo: { gizmo: { id: 'g-abcdef' } } }, { gizmo: null }, {}, { gizmo: { gizmo: { id: 7 } } }] }) });
  const result = await fake.result;
  assert.deepEqual(fake.urls, [MAIN(0), ARCHIVED(0), STARRED(0), SIDEBAR]);
  assert.equal(result.outcome, 'whole');
});

test('a list stops on an empty page', async () => {
  const fake = run({ ...NOTHING, [MAIN(0)]: page([entry(1)]), [MAIN(28)]: empty() });
  const result = await fake.result;
  assert.deepEqual(fake.urls.filter((url) => url.includes('is_archived=false')), [MAIN(0), MAIN(28)]);
  assert.deepEqual(ids(result.items), [chatId(1)]);
});

test('a list stops on a page with nothing in the window, and what is out of the window is not returned', async () => {
  const old = (n: number) => entry(n, BEFORE_WINDOW - n * 1000);
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page([entry(1), entry(2)]),
    [MAIN(28)]: page([old(3), old(4)]),
    // Never requested: the page before it had nothing in the window.
    [MAIN(56)]: page([entry(9)]),
  });
  const result = await fake.result;
  assert.ok(!fake.urls.includes(MAIN(56)), 'asked for a page past one with nothing in the window');
  assert.deepEqual(ids(result.items), [chatId(1), chatId(2)]);
  assert.equal(result.outcome, 'whole');
});

test('a page with one item in the window goes on to the next page', async () => {
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page([entry(1), entry(2, BEFORE_WINDOW)]),
    [MAIN(28)]: empty(),
  });
  const result = await fake.result;
  assert.ok(fake.urls.includes(MAIN(28)));
  assert.deepEqual(ids(result.items), [chatId(1)]);
});

test('the window has an end too: an item after it is out of the window', async () => {
  const fake = run({ ...NOTHING, [MAIN(0)]: page([entry(1, T0), entry(2, T0 - 10_000)]), [MAIN(28)]: empty() }, { window: { start: null, end: T0 - 5000 } });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [chatId(2)]);
});

test('with no window every item counts, until an empty page', async () => {
  const fake = run({ ...NOTHING, [MAIN(0)]: page([entry(1, 1000)]), [MAIN(28)]: empty() }, { window: { start: null, end: null } });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [chatId(1)]);
});

test('a list never pages by total, which is not a count', async () => {
  // total says 1, and a page with chats in the window still brings the next page.
  const fake = run({ ...NOTHING, [MAIN(0)]: page([entry(1)], { total: 1 }), [MAIN(28)]: page([entry(2)], { total: 1 }), [MAIN(56)]: empty() });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [chatId(1), chatId(2)]);
  // and a total that says 500 does not hold the walk on an empty page.
  const other = run({ ...NOTHING, [MAIN(0)]: page([], { total: 500 }) });
  assert.deepEqual(ids((await other.result).items), []);
  assert.deepEqual(other.urls.slice(0, 2), [MAIN(0), ARCHIVED(0)]);
});

test('each chat is returned once, with the first source it was seen on: main, then archived, then starred, then project', async () => {
  const fake = run({
    [MAIN(0)]: page([entry(1), entry(2), entry(3), entry(4)]),
    [MAIN(28)]: empty(),
    [ARCHIVED(0)]: page([entry(2), entry(5), entry(6)]),
    [ARCHIVED(28)]: empty(),
    [STARRED(0)]: page([entry(3), entry(6), entry(7)]),
    [STARRED(28)]: empty(),
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([projectEntry(4), projectEntry(7), projectEntry(8)], null),
  });
  const result = await fake.result;
  assert.deepEqual(
    result.items.map((item) => [item.id, item.source]),
    [
      [chatId(1), 'main'], [chatId(2), 'main'], [chatId(3), 'main'], [chatId(4), 'main'],
      [chatId(5), 'archived'], [chatId(6), 'archived'],
      [chatId(7), 'starred'],
      [chatId(8), 'project'],
    ],
  );
});

test('a chat repeated on a later page of the same list is returned once, as first seen', async () => {
  const fake = run({ ...NOTHING, [MAIN(0)]: page([entry(1), entry(2)]), [MAIN(28)]: page([entry(2), entry(3)]), [MAIN(56)]: empty() });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [1, 2, 3].map(chatId));
});

test('a list item holds the id, the title, the creation and update times, and the source, and nothing else', async () => {
  const fake = run({ ...NOTHING, [MAIN(0)]: page([entry(1, T0), { ...entry(2, T0 - 1000), title: null }, { ...entry(3, T0 - 2000), title: 42, create_time: null }]), [MAIN(28)]: empty() });
  const result = await fake.result;
  const [one, two, three] = result.items;
  assert.deepEqual(Object.keys(one).sort(), ['id', 'source', 'started', 'title', 'updated']);
  assert.equal(one.id, chatId(1));
  assert.equal(one.title, 'SECRET-TITLE-1');
  assert.equal(one.started?.timestamp(), T0 - 60_000);
  assert.equal(one.updated.timestamp(), T0);
  assert.equal(one.source, 'main');
  assert.equal(two.title, null);
  assert.equal(three.title, null);
  assert.equal(three.started, null);
});

test('started of a main, archived or starred chat is new DateString(create_time), with the microseconds of its ISO string', async () => {
  const fake = run({
    [MAIN(0)]: page([entry(1, T0)]),
    [MAIN(28)]: empty(),
    [ARCHIVED(0)]: page([entry(2, T0)]),
    [ARCHIVED(28)]: empty(),
    [STARRED(0)]: page([entry(3, T0)]),
    [STARRED(28)]: empty(),
    [SIDEBAR]: json({ items: [] }),
  });
  const result = await fake.result;
  assert.deepEqual(result.items.map((item) => item.source), ['main', 'archived', 'starred']);
  const created = iso(T0 - 60_000, '123');
  assert.equal(created, '2026-09-08T13:48:43.781123Z');
  for (const item of result.items) {
    assert.equal(JSON.stringify(item.started), JSON.stringify(new DateString(created)));
    assert.equal(JSON.stringify(item.started), '"2026-09-08T13:48:43.781123Z"');
  }
});

test('started of a chat only a project lists is the project path value: new DateString(Date.parse(create_time) / 1000)', async () => {
  // 40 different milliseconds, with microseconds on the ISO strings as the capture saw them.
  const times = Array.from({ length: 40 }, (_, k) => T0 + k * 7);
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage(times.map((ms, k) => ({ ...projectEntry(k + 1, ms), create_time: iso(ms - 60_000, '987') })), null),
  });
  const result = await fake.result;
  assert.equal(result.items.length, 40);
  let differs = 0;
  for (const [k, item] of result.items.entries()) {
    const created = iso(times[k] - 60_000, '987');
    const old = new DateString(Date.parse(created) / 1000);
    assert.equal(item.source, 'project');
    assert.equal(item.started?.timestamp(), old.timestamp());
    assert.equal(JSON.stringify(item.started), JSON.stringify(old));
    if (JSON.stringify(old) !== JSON.stringify(new DateString(created))) differs += 1;
  }
  assert.ok(differs > 0, 'no value differed from the main path, so this proved nothing about the project path');
});

test('a chat whose create_time cannot be read is still listed, with started null, is not counted as unreadable, and its create_time is not logged', async (t) => {
  const printed: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  // Date.parse reads 'SECRET-TITLE-2' as a date in February 2001, so it is no test of an ISO string.
  const bad = [undefined, null, '', 'SECRET-TITLE not a date', 'SECRET-TITLE-2', 1788875383.781, '2026-09-08'];
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page(bad.map((create_time, k) => ({ ...entry(k + 1, T0 - k * 1000), create_time }))),
    [MAIN(28)]: empty(),
  });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), bad.map((_, k) => chatId(k + 1)));
  assert.deepEqual(result.items.map((item) => item.started), bad.map(() => null));
  assert.deepEqual(result.items.map((item) => item.updated.timestamp()), bad.map((_, k) => T0 - k * 1000));
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'whole', reason: 'ok' });
  // The project path reads create_time with Date.parse, and must not take 'SECRET-TITLE-2' for a date either.
  const other = run({
    ...NOTHING,
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([{ ...projectEntry(1), create_time: 'not a date' }, { ...projectEntry(2), create_time: 'SECRET-TITLE-2' }, { ...projectEntry(3), create_time: undefined }], null),
  });
  const projectResult = await other.result;
  assert.deepEqual(projectResult.items.map((item) => item.started), [null, null, null]);
  assert.equal(projectResult.outcome, 'whole');
  for (const line of [...printed, ...fake.logs, ...other.logs]) {
    assert.ok(!line.includes('SECRET'), `"${line}" shows a create_time`);
  }
});

test('uploadTime of a main, archived or starred chat is new DateString(update_time), from the ISO string', async () => {
  const fake = run({
    [MAIN(0)]: page([entry(1, T0)]),
    [MAIN(28)]: empty(),
    [ARCHIVED(0)]: page([entry(2, T0)]),
    [ARCHIVED(28)]: empty(),
    [STARRED(0)]: page([entry(3, T0)]),
    [STARRED(28)]: empty(),
    [SIDEBAR]: json({ items: [] }),
  });
  const result = await fake.result;
  assert.deepEqual(result.items.map((item) => item.source), ['main', 'archived', 'starred']);
  for (const item of result.items) {
    assert.equal(uploadTime(item).timestamp(), T0);
    // The ISO string with its microseconds, as new DateString(update_time) keeps it.
    assert.equal(JSON.stringify(uploadTime(item)), JSON.stringify(iso(T0, '456')));
  }
});

test('uploadTime of a chat listed on main and in a project is the main list value', async () => {
  const fake = run({
    [MAIN(0)]: page([entry(1, T0)]),
    [MAIN(28)]: empty(),
    [ARCHIVED(0)]: empty(),
    [STARRED(0)]: empty(),
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([projectEntry(1, T0)], null),
  });
  const result = await fake.result;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source, 'main');
  assert.equal(uploadTime(result.items[0]).timestamp(), 1788875383781);
});

test('uploadTime of a chat only a project lists is the project path value, which drops 1 ms', async () => {
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([projectEntry(1, 1788875383781)], null),
  });
  const result = await fake.result;
  assert.equal(result.items[0].source, 'project');
  assert.equal(result.items[0].updated.timestamp(), 1788875383781);
  assert.equal(uploadTime(result.items[0]).timestamp(), 1788875383780);
});

test('the project path value is what the old code computed: new DateString(Date.parse(update_time) / 1000)', async () => {
  const { DateString } = await import('@bric/rex-types/types');
  // Microseconds on the ISO string, as the capture saw them, and 40 different milliseconds.
  const times = Array.from({ length: 40 }, (_, k) => T0 + k * 7);
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage(times.map((ms, k) => ({ ...projectEntry(k + 1, ms), update_time: iso(ms, '987') })), null),
  });
  const result = await fake.result;
  assert.equal(result.items.length, 40);
  let dropped = 0;
  for (const [k, item] of result.items.entries()) {
    const old = new DateString(Date.parse(iso(times[k], '987')) / 1000);
    assert.equal(uploadTime(item).timestamp(), old.timestamp());
    assert.equal(JSON.stringify(uploadTime(item)), JSON.stringify(old));
    if (old.timestamp() !== times[k]) dropped += 1;
  }
  assert.ok(dropped > 0, 'no value hit the 1 ms drop, so this proved nothing about it');
});

// A rate limit, a challenge and a signed-out answer stop the whole walk: the
// next request would meet the same answer, and the pass has to back off.
test('a rate-limited, challenged or signed-out answer stops the whole walk as failed, whichever list it comes on', async () => {
  const stops: [string, Reply, string][] = [
    ['a 401', json({}, 401), 'signed-out'],
    ['a 429', json({}, 429), 'rate-limited'],
    ['a 503', json({}, 503), 'rate-limited'],
    ['a Retry-After on a 500', json({}, 500, { 'retry-after': '5' }), 'rate-limited'],
    ['a challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' }, text: '<html>' }, 'challenge'],
  ];
  const lists: [string, string, string[]][] = [
    ['main', MAIN(0), [MAIN(0)]],
    ['archived', ARCHIVED(0), [MAIN(0), ARCHIVED(0)]],
    ['starred', STARRED(0), [MAIN(0), ARCHIVED(0), STARRED(0)]],
    ['the sidebar', SIDEBAR, [MAIN(0), ARCHIVED(0), STARRED(0), SIDEBAR]],
  ];
  for (const [what, reply, reason] of stops) {
    for (const [list, url, expected] of lists) {
      const fake = run({ ...NOTHING, [url]: reply });
      const result = await fake.result;
      assert.deepEqual({ what, list, outcome: result.outcome, reason: result.reason, urls: fake.urls }, { what, list, outcome: 'failed', reason, urls: expected });
    }
    // and on a project's page
    const fake = run({ ...NOTHING, [SIDEBAR]: json(sidebarOf(P1, P2)), [PROJECT(P1, '0')]: reply });
    const result = await fake.result;
    assert.deepEqual({ what, outcome: result.outcome, reason: result.reason, last: fake.urls.at(-1) }, { what, outcome: 'failed', reason, last: PROJECT(P1, '0') });
  }
});

// Any other failure ends only the list it came on, and the walk is partial.
test('a refused, server, not-json, timeout, network or bad-page failure ends only that list, and names it', async () => {
  const lists: [string, string, string[]][] = [
    ['main', MAIN(0), [MAIN(0), ARCHIVED(0), STARRED(0), SIDEBAR]],
    ['archived', ARCHIVED(0), [MAIN(0), ARCHIVED(0), STARRED(0), SIDEBAR]],
    ['starred', STARRED(0), [MAIN(0), ARCHIVED(0), STARRED(0), SIDEBAR]],
    ['sidebar', SIDEBAR, [MAIN(0), ARCHIVED(0), STARRED(0), SIDEBAR]],
  ];
  const failures: [string, Reply, string][] = [
    ['a 403', json({}, 403), 'refused'],
    ['a 404', json({}, 404), 'refused'],
    ['a 500', json({}, 500), 'server'],
    ['a 502', json({}, 502), 'server'],
    ['an HTML page', { status: 200, headers: {}, text: '<html>' }, 'not-json'],
    ['a timeout', new RequestError('timeout'), 'timeout'],
    ['a network error', new RequestError('network'), 'network'],
    ['a fetch that threw something else', new TypeError('Failed to fetch'), 'network'],
    ['a body that is not an object', json(null), 'bad-page'],
    ['a body with no items', json({ total: 3 }), 'bad-page'],
    ['a body whose items is not a list', json({ items: 'x' }), 'bad-page'],
  ];
  for (const [what, reply, kind] of failures) {
    for (const [list, url, expected] of lists) {
      const fake = run({ ...NOTHING, [url]: reply });
      const result = await fake.result;
      assert.deepEqual({ what, list, outcome: result.outcome, reason: result.reason, urls: fake.urls }, { what, list, outcome: 'partial', reason: `${list}: ${kind}`, urls: expected });
      assert.ok(!('retryAfterMs' in result));
    }
  }
});

test('a 503 on the archived list stops the walk before starred, and carries the wait', async () => {
  const fake = run({
    [MAIN(0)]: page([entry(1)]),
    [MAIN(28)]: empty(),
    [ARCHIVED(0)]: json({}, 503, { 'retry-after': '45' }),
    [STARRED(0)]: page([entry(2)]),
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([projectEntry(3)], null),
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls, [MAIN(0), MAIN(28), ARCHIVED(0)]);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason, retryAfterMs: result.retryAfterMs }, { outcome: 'failed', reason: 'rate-limited', retryAfterMs: 45_000 });
  // What was read before the stop is still in the result; a failed walk is not to be acted on.
  assert.deepEqual(ids(result.items), [chatId(1)]);
});

test('a 500 on the archived list still reads starred and the projects, and the walk is partial', async () => {
  const fake = run({
    [MAIN(0)]: page([entry(1)]),
    [MAIN(28)]: empty(),
    [ARCHIVED(0)]: json({}, 500),
    [STARRED(0)]: page([entry(2)]),
    [STARRED(28)]: empty(),
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([projectEntry(3)], null),
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls, [MAIN(0), MAIN(28), ARCHIVED(0), STARRED(0), STARRED(28), SIDEBAR, PROJECT(P1, '0')]);
  assert.deepEqual(ids(result.items), [1, 2, 3].map(chatId));
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'archived: server' });
});

test('a failure on a later page ends that list and keeps the chats of its earlier pages', async () => {
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page([entry(1), entry(2)]),
    [MAIN(28)]: json({}, 500),
    [ARCHIVED(0)]: page([entry(3)]),
    [ARCHIVED(28)]: empty(),
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls, [MAIN(0), MAIN(28), ARCHIVED(0), ARCHIVED(28), STARRED(0), SIDEBAR]);
  assert.deepEqual(ids(result.items), [1, 2, 3].map(chatId));
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'main: server' });
});

test('a 403 on one project\'s page still reads the next project', async () => {
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json(sidebarOf(P1, P2)),
    [PROJECT(P1, '0')]: json({}, 403),
    [PROJECT(P2, '0')]: projectPage([projectEntry(2)], null),
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls.slice(4), [PROJECT(P1, '0'), PROJECT(P2, '0')]);
  assert.deepEqual(ids(result.items), [chatId(2)]);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'project: refused' });
});

test('a 403 on a later page of a project keeps its earlier pages and reads the next project', async () => {
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json(sidebarOf(P1, P2)),
    [PROJECT(P1, '0')]: projectPage([projectEntry(1)], 'a'),
    [PROJECT(P1, 'a')]: json({}, 403),
    [PROJECT(P2, '0')]: projectPage([projectEntry(2)], null),
  });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [1, 2].map(chatId));
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'project: refused' });
});

test('two projects that fail the same way are named once, and the reason holds no project id', async () => {
  const fake = run({ ...NOTHING, [SIDEBAR]: json(sidebarOf(P1, P2)), [PROJECT(P1, '0')]: json({}, 403), [PROJECT(P2, '0')]: json({}, 403) });
  const result = await fake.result;
  assert.equal(result.reason, 'project: refused');
  assert.ok(!result.reason.includes('g-p-'));
});

test('a sidebar page that fails after the first still has its projects read', async () => {
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json({ ...sidebarOf(P1), cursor: 'S2' }),
    [SIDEBAR_AT('S2')]: json({}, 500),
    [PROJECT(P1, '0')]: projectPage([projectEntry(1)], null),
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls.slice(3), [SIDEBAR, SIDEBAR_AT('S2'), PROJECT(P1, '0')]);
  assert.deepEqual(ids(result.items), [chatId(1)]);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'sidebar: server' });
});

test('a walk in which every list fails is partial with no chats, and names each list', async () => {
  const fake = run({ [MAIN(0)]: json({}, 500), [ARCHIVED(0)]: json({}, 500), [STARRED(0)]: json({}, 500), [SIDEBAR]: json({}, 500) });
  const result = await fake.result;
  assert.deepEqual({ items: result.items, outcome: result.outcome, reason: result.reason }, { items: [], outcome: 'partial', reason: 'main: server; archived: server; starred: server; sidebar: server' });
});

test('a failure that stops the walk beats the lists that failed before it', async () => {
  const fake = run({ ...NOTHING, [MAIN(0)]: json({}, 500), [ARCHIVED(0)]: json({}, 429) });
  const result = await fake.result;
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'failed', reason: 'rate-limited' });
});

test('a stop after some chats were read is a failed walk that still holds them, and makes no further request', async () => {
  const fake = run({
    [MAIN(0)]: page([entry(1), entry(2)]),
    [MAIN(28)]: { status: 429, headers: { 'retry-after': '90' }, text: '{}' },
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls, [MAIN(0), MAIN(28)]);
  assert.deepEqual(ids(result.items), [chatId(1), chatId(2)]);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason, retryAfterMs: result.retryAfterMs }, { outcome: 'failed', reason: 'rate-limited', retryAfterMs: 90_000 });
});

test('a rate limit on a project list stops the walk there, keeps what the earlier lists gave and carries the wait', async () => {
  const fake = run({
    [MAIN(0)]: page([entry(1)]),
    [MAIN(28)]: empty(),
    [ARCHIVED(0)]: empty(),
    [STARRED(0)]: empty(),
    [SIDEBAR]: json(sidebarOf(P1, P2)),
    [PROJECT(P1, '0')]: { status: 429, headers: { 'Retry-After': '30' }, text: '' },
  });
  const result = await fake.result;
  assert.ok(!fake.urls.includes(PROJECT(P2, '0')));
  assert.deepEqual({ ids: ids(result.items), outcome: result.outcome, reason: result.reason, retryAfterMs: result.retryAfterMs }, { ids: [chatId(1)], outcome: 'failed', reason: 'rate-limited', retryAfterMs: 30_000 });
});

test('a failure with nothing returned is failed, and a retry wait is left out when the answer named none', async () => {
  const fake = run({ [MAIN(0)]: json({}, 429) });
  const result = await fake.result;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.retryAfterMs, undefined);
  assert.ok(!('retryAfterMs' in result));
});

test('a chat whose update_time cannot be read is skipped and counted, and the reason carries the count', async (t) => {
  // rex-types logs a date it cannot parse; keep that out of the test output.
  t.mock.method(console, 'log', () => {});
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page([
      entry(1),
      { ...entry(2), update_time: undefined },
      { ...entry(3), update_time: 'SECRET-TITLE not a date' },
      { ...entry(4), update_time: 1788875383.781 },
      { ...entry(5), update_time: '2026-09-08' },
    ]),
    [MAIN(28)]: empty(),
  });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [chatId(1)]);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: '4 items with an unreadable update_time' });
});

test('one unreadable update_time is counted as one item, and the count adds up over lists and pages', async () => {
  const one = run({ ...NOTHING, [MAIN(0)]: page([entry(1), { ...entry(2), update_time: 'x' }]), [MAIN(28)]: empty() });
  assert.equal((await one.result).reason, '1 item with an unreadable update_time');
  const many = run({
    ...NOTHING,
    [MAIN(0)]: page([entry(1), { ...entry(2), update_time: 'x' }]),
    [MAIN(28)]: page([entry(3), { ...entry(4), update_time: 'x' }]),
    [MAIN(56)]: empty(),
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([{ ...projectEntry(5), update_time: 'x' }], null),
  });
  const result = await many.result;
  assert.deepEqual(ids(result.items), [chatId(1), chatId(3)]);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: '3 items with an unreadable update_time' });
});

test('a chat with no id is counted too, and the count comes with the lists that failed', async () => {
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page([entry(1), { ...entry(2), id: undefined }, { ...entry(3), id: '' }, { ...entry(4), id: 7 }, null, 'SECRET-TITLE', { ...entry(5), update_time: 'x' }]),
    [MAIN(28)]: empty(),
    [ARCHIVED(0)]: json({}, 500),
  });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [chatId(1)]);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'archived: server; 5 items with no id; 1 item with an unreadable update_time' });
});

test('the reason of a walk with unreadable chats holds no title, and neither does what it logs', async (t) => {
  const printed: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page([entry(1), { ...entry(2), update_time: 'SECRET-TITLE-2' }, { ...entry(3), update_time: null }]),
    [MAIN(28)]: empty(),
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([{ ...projectEntry(4), update_time: 'SECRET-SNIPPET-4' }], null),
  });
  const result = await fake.result;
  assert.equal(result.reason, '3 items with an unreadable update_time');
  assert.ok(fake.logs.length > 0, 'nothing was logged, so this proved nothing');
  for (const line of [result.reason, ...fake.logs, ...printed]) {
    for (const secret of ['SECRET-TITLE', 'SECRET-SNIPPET', 'SECRET-EMAIL', 'SECRET-NAME']) {
      assert.ok(!line.includes(secret), `"${line}" shows ${secret}`);
    }
  }
});

test('a walk whose every chat is unreadable is partial with no chats, which the reason says', async () => {
  const fake = run({ ...NOTHING, [MAIN(0)]: page([{ ...entry(1), update_time: undefined }]), [MAIN(28)]: empty() });
  const result = await fake.result;
  assert.deepEqual({ items: result.items, outcome: result.outcome, reason: result.reason }, { items: [], outcome: 'partial', reason: '1 item with an unreadable update_time' });
});

test('an unreadable chat on the first page does not end the list, and a bad project entry is skipped too', async () => {
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page([{ ...entry(1), update_time: 'x' }, entry(2)]),
    [MAIN(28)]: empty(),
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([{ ...projectEntry(3), update_time: 'x' }, projectEntry(4)], null),
  });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [chatId(2), chatId(4)]);
  assert.equal(result.outcome, 'partial');
});

test('a list that keeps giving full pages is cut at the page limit, and the walk goes on to the next list', async () => {
  const fresh = (offset: number) => page([entry(offset + 1, T0 - offset), entry(offset + 2, T0 - offset)]);
  const fake = run({ ...NOTHING, [MAIN(0)]: fresh(0), [MAIN(28)]: fresh(28), [MAIN(56)]: fresh(56), [MAIN(84)]: fresh(84) }, { maxPages: 3 });
  const result = await fake.result;
  assert.deepEqual(fake.urls, [MAIN(0), MAIN(28), MAIN(56), ARCHIVED(0), STARRED(0), SIDEBAR]);
  assert.equal(result.items.length, 6);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'main: page-limit' });
});

test('the default page limit is 1000', () => {
  assert.equal(MAX_PAGES, 1000);
});

test('a list whose pages bring nothing new three times in a row is cut: its paging is not moving on', async () => {
  const same = page([entry(1), entry(2)]);
  const fake = run({ ...NOTHING, [MAIN(0)]: same, [MAIN(28)]: same, [MAIN(56)]: same, [MAIN(84)]: same, [MAIN(112)]: same });
  const result = await fake.result;
  assert.deepEqual(fake.urls.slice(0, 5), [MAIN(0), MAIN(28), MAIN(56), MAIN(84), ARCHIVED(0)]);
  assert.deepEqual({ ids: ids(result.items), outcome: result.outcome, reason: result.reason }, { ids: [chatId(1), chatId(2)], outcome: 'partial', reason: 'main: not-moving' });
});

test('one page that repeats chats is ordinary: chats move up between two calls', async () => {
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page([entry(1), entry(2)]),
    [MAIN(28)]: page([entry(2)]),
    [MAIN(56)]: page([entry(3)]),
    [MAIN(84)]: empty(),
  });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [1, 2, 3].map(chatId));
  assert.equal(result.outcome, 'whole');
});

test('a project cursor that comes back again cuts that project, and the next project is still read', async () => {
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json(sidebarOf(P1, P2)),
    [PROJECT(P1, '0')]: projectPage([projectEntry(1)], 'a'),
    [PROJECT(P1, 'a')]: projectPage([projectEntry(2)], 'a'),
    [PROJECT(P2, '0')]: projectPage([projectEntry(3)], null),
  });
  const result = await fake.result;
  assert.deepEqual(fake.urls.slice(4), [PROJECT(P1, '0'), PROJECT(P1, 'a'), PROJECT(P2, '0')]);
  assert.deepEqual(ids(result.items), [1, 2, 3].map(chatId));
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'project: not-moving' });
});

test('a sidebar cursor that comes back again ends the sidebar', async () => {
  const fake = run({ ...NOTHING, [SIDEBAR]: json({ ...sidebarOf(), cursor: 'S' }), [SIDEBAR_AT('S')]: json({ ...sidebarOf(), cursor: 'S' }) });
  const result = await fake.result;
  assert.deepEqual(fake.urls.slice(3), [SIDEBAR, SIDEBAR_AT('S')]);
  assert.deepEqual({ items: result.items, outcome: result.outcome, reason: result.reason }, { items: [], outcome: 'partial', reason: 'sidebar: not-moving' });
});

test('the whole walk is bounded by a request limit, whichever lists the requests go to', async () => {
  const fake = run({
    ...NOTHING,
    [SIDEBAR]: json(sidebarOf(P1)),
    [PROJECT(P1, '0')]: projectPage([projectEntry(1)], 'a'),
    [PROJECT(P1, 'a')]: projectPage([projectEntry(2)], 'b'),
    [PROJECT(P1, 'b')]: projectPage([projectEntry(3)], 'c'),
  }, { maxRequests: 6 });
  const result = await fake.result;
  assert.equal(fake.urls.length, 6);
  assert.deepEqual(ids(result.items), [1, 2].map(chatId));
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'request-limit' });
});

test('an account with nothing on any list is a whole walk of four requests', async () => {
  const fake = run(NOTHING);
  const result = await fake.result;
  assert.deepEqual(fake.urls, [MAIN(0), ARCHIVED(0), STARRED(0), SIDEBAR]);
  assert.deepEqual(result, { items: [], outcome: 'whole', reason: 'ok' });
});

test('the wait is crawl_delay as it reads when the wait starts', async () => {
  let delay = 5000;
  const waits: number[] = [];
  const client = { get: async () => empty() };
  const pace = { crawlDelay: () => delay, sleep: async (ms: number) => { waits.push(ms); delay = 7000; } };
  await walkLists(client, IN_WINDOW, pace, { log: () => {} });
  assert.deepEqual(waits, [5000, 7000, 7000]);
});

test('a crawl_delay that is not a number is read as 30 s, not as no wait', async () => {
  for (const bad of [Number.NaN, undefined, null, '', 'soon', -1, Infinity, {}]) {
    const waits: number[] = [];
    const client = { get: async () => empty() };
    const pace = { crawlDelay: () => bad as unknown as number, sleep: async (ms: number) => { waits.push(ms); } };
    await walkLists(client, IN_WINDOW, pace, { log: () => {} });
    assert.deepEqual(waits, [30_000, 30_000, 30_000], `crawl_delay ${String(bad)}`);
  }
});

test('a numeric string and 0 are read as they are', async () => {
  for (const [given, expected] of [['2500', 2500], [0, 0]] as const) {
    const waits: number[] = [];
    const client = { get: async () => empty() };
    const pace = { crawlDelay: () => given as unknown as number, sleep: async (ms: number) => { waits.push(ms); } };
    await walkLists(client, IN_WINDOW, pace, { log: () => {} });
    assert.deepEqual(waits, [expected, expected, expected]);
  }
});

test('without a sleep given, the walk waits crawl_delay on the timer, and sends the next request only after it', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: string[] = [];
  const client = {
    get: async (url: string) => {
      sent.push(url);
      return empty();
    },
  };
  const walking = walkLists(client, IN_WINDOW, { crawlDelay: () => 30_000 }, { log: () => {} });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.deepEqual(sent, [MAIN(0)]);
  t.mock.timers.tick(29_999);
  await settle();
  assert.deepEqual(sent, [MAIN(0)], 'the second request went out before crawl_delay');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(sent, [MAIN(0), ARCHIVED(0)]);
  t.mock.timers.tick(30_000);
  await settle();
  t.mock.timers.tick(30_000);
  await settle();
  assert.deepEqual((await walking).outcome, 'whole');
  assert.deepEqual(sent, [MAIN(0), ARCHIVED(0), STARRED(0), SIDEBAR]);
});

test('no title, snippet, owner, address, name or token reaches a log, an error or the reason of a walk that fails every way', async (t) => {
  const printed: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  const secrets = ['SECRET-TITLE', 'SECRET-SNIPPET', 'SECRET-EMAIL', 'SECRET-NAME', 'example.com', P1];
  const shaky: Record<string, Reply>[] = [
    // chats that cannot be read, with the markers in the fields
    { ...NOTHING, [MAIN(0)]: page([{ ...entry(1), update_time: 'SECRET-TITLE' }, { ...entry(2), create_time: 'SECRET-TITLE', id: undefined }, entry(3)]), [MAIN(28)]: empty() },
    // a project walk with the markers on its items, cut by a repeated cursor
    { ...NOTHING, [SIDEBAR]: json(sidebarOf(P1)), [PROJECT(P1, '0')]: projectPage([projectEntry(1), { ...projectEntry(2), update_time: 'SECRET-SNIPPET' }], 'a'), [PROJECT(P1, 'a')]: projectPage([projectEntry(3)], 'a') },
    // bad bodies whose text holds the markers
    { [MAIN(0)]: { status: 200, headers: {}, text: '{"items": "SECRET-TITLE SECRET-SNIPPET SECRET-EMAIL@example.com"' } },
    { [MAIN(0)]: json({ items: 'SECRET-TITLE', owner: { user_email: 'SECRET-EMAIL@example.com' } }) },
    { [MAIN(0)]: { status: 500, headers: {}, text: 'SECRET-TITLE SECRET-NAME' } },
    // a project failure, by status and by an error that names the project
    { ...NOTHING, [SIDEBAR]: json(sidebarOf(P1)), [PROJECT(P1, '0')]: { status: 429, headers: {}, text: 'SECRET-SNIPPET' } },
    { ...NOTHING, [SIDEBAR]: json(sidebarOf(P1)), [PROJECT(P1, '0')]: new TypeError(`Failed to fetch SECRET-TITLE ${P1}`) },
  ];
  const logged: string[] = [];
  const reasons: string[] = [];
  for (const table of shaky) {
    const client = {
      get: async (url: string) => {
        const reply = table[url];
        if (reply === undefined) throw new Error(`nothing scripted for ${url}`);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
    const result = await walkLists(client, IN_WINDOW, { crawlDelay: () => 0, sleep: async () => {} }, { log: (line) => logged.push(line) });
    reasons.push(result.reason);
  }
  assert.ok(logged.length >= 3, 'the walk logged almost nothing, so this proved little');
  for (const line of [...logged, ...reasons, ...printed]) {
    for (const secret of secrets) {
      assert.ok(!line.includes(secret), `"${line}" shows ${secret}`);
    }
  }
});

test('the default log writes to the console, with the module prefix and the same care', async (t) => {
  const printed: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  const client = { get: async () => page([{ ...entry(1), update_time: undefined, title: 'SECRET-TITLE' }]) };
  await walkLists(client, IN_WINDOW, { crawlDelay: () => 0, sleep: async () => {} });
  assert.ok(printed.length > 0);
  for (const line of printed) {
    assert.ok(line.startsWith('[rex-spider-chatgpt]'), line);
    assert.ok(!line.includes('SECRET-TITLE'), line);
  }
});

test('two lists that are cut are both named, in the order they were cut', async () => {
  const fresh = (offset: number) => page([entry(offset + 1, T0 - offset)]);
  const same = page([entry(900)]);
  const fake = run({
    ...NOTHING,
    // main: four fresh pages, cut at the page limit of 4
    [MAIN(0)]: fresh(0), [MAIN(28)]: fresh(28), [MAIN(56)]: fresh(56), [MAIN(84)]: fresh(84),
    // archived: one chat, then three pages that repeat it, cut as not moving
    [ARCHIVED(0)]: same, [ARCHIVED(28)]: same, [ARCHIVED(56)]: same, [ARCHIVED(84)]: same,
  }, { maxPages: 4 });
  const result = await fake.result;
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: 'main: page-limit; archived: not-moving' });
});

test('a stop after an unreadable chat names the stop, not the chat', async () => {
  const fake = run({
    ...NOTHING,
    [MAIN(0)]: page([entry(1), { ...entry(2), update_time: undefined }]),
    [MAIN(28)]: json({}, 429, { 'retry-after': '10' }),
  });
  const result = await fake.result;
  assert.deepEqual({ ids: ids(result.items), outcome: result.outcome, reason: result.reason, retryAfterMs: result.retryAfterMs }, { ids: [chatId(1)], outcome: 'failed', reason: 'rate-limited', retryAfterMs: 10_000 });
});

test('a date with no time of day is unreadable: Date.parse reads it, an ISO instant is not one', async (t) => {
  // rex-types logs the value it cannot read; keep that out of the test output.
  t.mock.method(console, 'log', () => {});
  const fake = run({ ...NOTHING, [MAIN(0)]: page([{ ...entry(1), update_time: '2026-09-08' }, entry(2)]), [MAIN(28)]: empty() });
  const result = await fake.result;
  assert.deepEqual(ids(result.items), [chatId(2)]);
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: '1 item with an unreadable update_time' });
});

test('a walk with a log that throws still ends in a result', async () => {
  const fake = walkLists({ get: async () => page([{ ...entry(1), id: undefined }]) }, IN_WINDOW, { crawlDelay: () => 0, sleep: async () => {} }, {
    log: () => {
      throw new Error('log sink is gone');
    },
  });
  const result = await fake;
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'partial', reason: '3 items with no id' });
});
