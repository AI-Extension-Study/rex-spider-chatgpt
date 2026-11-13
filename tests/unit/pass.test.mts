import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sha256 } from '@bric/rex-core/common';
import { DateString } from '@bric/rex-types/types';

import { type Answer, RequestError } from '../../src/client.mts';
import { PASS_LIMITS, type PassFramework, type PassLimits, type PassOutcome, runPass } from '../../src/pass.mts';
import { type Hash, buildDetailRecord, buildSummaryRecord } from '../../src/record.mts';
import { type ModeRecord, type Read, type Write } from '../../src/store.mts';
import { MARK, ROOT, T0, answer, detail, listItem, nodeId, projectItem, prompt, tree } from './fixtures.mts';

type Json = Record<string, unknown>;

const DAY = 24 * 60 * 60 * 1000;
// The pass's clock: 2026-11-20T12:00:00Z.
const NOW = Date.UTC(2026, 10, 20, 12);
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYXNzIn0.c2lnbmF0dXJl';
const HOME = 'https://chatgpt.com/';
const PROJECT = 'g-p-0000000000000000000000000000bbbb';
// SHA-256 in hex of 'MARKER list title', the fixtures' list title.
const LIST_TITLE_HASH = 'c5f710ba01815792a3a200c4118e0dd6e847d6bc214b237c93c3349ba8da81eb';

const chat = (n: number): string => `6911f0a5-2222-8000-8000-${String(n).padStart(12, '0')}`;
// update_time as the lists send it: an ISO instant with microseconds.
const listTime = (ms: number): string => new Date(ms).toISOString().replace('Z', '321Z');
// The ms of the upload key rex-spider builds for a chat listed at that time:
// on the main, archived and starred lists the list's instant; for a chat
// only a project lists, new DateString(Date.parse(t) / 1000), up to 1 ms
// early, as the spider has always built it.
const mainKeyMs = (iso: string): number => Math.round(new DateString(iso).timestamp());
const projectKeyMs = (iso: string): number => Math.round(new DateString(Date.parse(iso) / 1000).timestamp());
// A project chat's time that the project path reads 1 ms early, so a key
// built from the list's instant would differ from the one the spider wrote.
const PROJECT_TIME = listTime(NOW - 2 * DAY + 1);

test('the project chats of these tests are listed at a time the project path reads 1 ms early', () => {
  assert.equal(projectKeyMs(PROJECT_TIME), mainKeyMs(PROJECT_TIME) - 1);
});

// A main-list item last used `days` before the pass, and its key's time.
const listed = (n: number, days: number, fields: Json = {}): Json => listItem(chat(n), { update_time: listTime(NOW - days * DAY), create_time: listTime(NOW - days * DAY - 3_600_000), ...fields });
const keyOf = (n: number, days: number, mode: 'summary' | 'detail'): string => `${chat(n)}${mode === 'detail' ? '-detail' : ''} ${mainKeyMs(listTime(NOW - days * DAY))}`;

// A chat's detail: a prompt and an answer at T0, which is not its list time,
// so a record's ended (its latest message) differs from the key's time.
function chatDetail(id: string, seconds = T0): Json {
  return detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), seconds + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), seconds + 2, `${MARK} answer`)],
  ), nodeId(2), { conversation_id: id, create_time: seconds, update_time: seconds + 2 });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Answer => ({ status, headers, text: JSON.stringify(body) });
const homePage = (token = TOKEN): Answer => ({ status: 200, headers: { 'content-type': 'text/html' }, text: `<html>\n<script>window.__boot={"accessToken":"${token}"}</script>\n</html>` });

type ListName = 'main' | 'archived' | 'starred' | 'sidebar' | 'project';
type Reply = Answer | ((read: number) => Answer);

interface SiteOptions {
  readonly home?: Reply;
  readonly main?: readonly Json[];
  readonly archived?: readonly Json[];
  readonly starred?: readonly Json[];
  // Project id to its items.
  readonly projects?: Readonly<Record<string, readonly Json[]>>;
  // A list answered with this instead of its pages.
  readonly failing?: Partial<Record<ListName, Answer>>;
  // A chat's detail answer, or one per read of it (1 for the first).
  readonly details?: Readonly<Record<string, Reply>>;
  // One request's answer by its label ('main 28', 'sidebar'), before any other.
  readonly answers?: Readonly<Record<string, Answer>>;
}

// chatgpt.com as the pass reads it: the home page, the three conversation
// lists by offset, the sidebar and each project's list, one page each, and
// each chat's detail, its own unless a test gives another answer.
function site(options: SiteOptions = {}) {
  const requests: { readonly url: string; readonly token: string | undefined }[] = [];
  const reads: string[] = [];
  const homes = { count: 0 };
  const answerTo = (url: string): Answer => {
    const given = options.answers?.[label(url)];
    if (given !== undefined) return given;
    if (url === HOME) {
      homes.count += 1;
      const given = options.home ?? homePage();
      return typeof given === 'function' ? given(homes.count) : given;
    }
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === '/backend-api/conversations') {
      const list = parsed.searchParams.get('is_archived') === 'true' ? 'archived' : parsed.searchParams.get('is_starred') === 'true' ? 'starred' : 'main';
      const failing = options.failing?.[list];
      if (failing !== undefined) return failing;
      const offset = Number(parsed.searchParams.get('offset'));
      return json({ items: (options[list] ?? []).slice(offset, offset + 28), total: 29, limit: 28, offset });
    }
    if (path === '/backend-api/gizmos/snorlax/sidebar') {
      return options.failing?.sidebar ?? json({ items: Object.keys(options.projects ?? {}).map((id) => ({ gizmo: { gizmo: { id } } })), cursor: null });
    }
    const project = /^\/backend-api\/gizmos\/([^/]+)\/conversations$/.exec(path);
    if (project !== null) {
      return options.failing?.project ?? json({ items: options.projects?.[decodeURIComponent(project[1])] ?? [], cursor: null });
    }
    const read = /^\/backend-api\/conversation\/([^/]+)$/.exec(path);
    if (read !== null) {
      const id = decodeURIComponent(read[1]);
      reads.push(id);
      const given = options.details?.[id];
      if (given === undefined) return json(chatDetail(id));
      return typeof given === 'function' ? given(reads.filter((each) => each === id).length) : given;
    }
    throw new Error('the pass asked for a page the site does not have');
  };
  return { requests, reads, homes, answerTo };
}

// A short name for a request, for the order a test expects.
function label(url: string): string {
  if (url === HOME) return 'home';
  const parsed = new URL(url);
  if (parsed.pathname === '/backend-api/conversations') {
    const list = parsed.searchParams.get('is_archived') === 'true' ? 'archived' : parsed.searchParams.get('is_starred') === 'true' ? 'starred' : 'main';
    return `${list} ${parsed.searchParams.get('offset')}`;
  }
  if (parsed.pathname.endsWith('/sidebar')) return 'sidebar';
  if (parsed.pathname.startsWith('/backend-api/gizmos/')) return 'project';
  return `detail ${decodeURIComponent(parsed.pathname.split('/').pop() ?? '')}`;
}

const the = <T,>(given: T | (() => T) | undefined, fallback: T): T => (typeof given === 'function' ? (given as () => T)() : given ?? fallback);

interface SideOptions {
  // Upload keys the browser holds, as 'id ms', the id and time rex-spider
  // builds its key from.
  readonly keys?: readonly string[];
  readonly summarize?: boolean | (() => boolean);
  readonly halt?: boolean | (() => boolean);
  readonly enabled?: boolean | (() => boolean);
  readonly crawlDelay?: unknown;
  readonly windowStart?: number | null;
  // checkIfAlreadyTransmitted never answers, as while rex-core's database is
  // not open.
  readonly silentLookups?: boolean;
  // logTransmitted answers but keeps nothing, as rex-spider resolves after a
  // failed write.
  readonly unkeptStamps?: boolean;
  readonly silentWindow?: boolean;
  // Called when the crawl window is looked up.
  readonly onWindow?: () => void;
}

// rex-spider's side as the pass sees it: the served flags, the crawl window,
// crawl_delay, and the upload keys. A stamp adds its key, so a later pass on
// the same side sees it. Detail mode and halt_on_error unless a test says.
function rexSpider(options: SideOptions = {}) {
  const keys = new Set(options.keys ?? []);
  const stamps: string[] = [];
  const lookups: string[] = [];
  const keyOfCall = (id: string, at: DateString) => `${id} ${Math.round(at.timestamp())}`;
  const framework: PassFramework = {
    isEnabled: () => the(options.enabled, true),
    justSummarize: () => the(options.summarize, false),
    continueAfterError: () => !the(options.halt, true),
    fetchCrawlDelay: () => (options.crawlDelay === undefined ? 30_000 : options.crawlDelay) as number,
    crawlWindowStart: () => {
      options.onWindow?.();
      return options.silentWindow === true ? new Promise(() => {}) : Promise.resolve(options.windowStart ?? null);
    },
    crawlWindowEnd: async () => null,
    checkIfAlreadyTransmitted: (id, at) => {
      lookups.push(keyOfCall(id, at));
      return options.silentLookups === true ? new Promise(() => {}) : Promise.resolve(keys.has(keyOfCall(id, at)));
    },
    logTransmitted: (id, at) => {
      stamps.push(keyOfCall(id, at));
      if (options.unkeptStamps !== true) keys.add(keyOfCall(id, at));
      return Promise.resolve();
    },
  };
  return { framework, keys, stamps, lookups };
}

// rex-core's store as the pass sees it (store.mts): the mode record.
// unanswered: its reads get no answer; unkept: its writes fail.
function rexCore({ mode = null as ModeRecord | null, unanswered = false, unkept = false, onRead = () => {} } = {}) {
  const held = { mode };
  const writes: ModeRecord[] = [];
  return {
    held,
    writes,
    store: {
      mode: {
        get: async (): Promise<Read<ModeRecord>> => {
          onRead();
          return { value: unanswered ? null : held.mode, unanswered, malformed: false };
        },
        set: async (record: ModeRecord): Promise<Write> => {
          writes.push(record);
          if (unkept) return { ok: false, unanswered: false };
          held.mode = record;
          return { ok: true, unanswered: false };
        },
      },
    },
  };
}

interface RunOptions {
  readonly core?: ReturnType<typeof rexCore>;
  readonly now?: number;
  readonly limits?: Partial<PassLimits>;
  // How long one detail read takes on the clock, and one home or list request.
  readonly readMs?: number;
  readonly listMs?: number;
  // How long a stamp takes on the clock.
  readonly stampMs?: number;
  // How long a wait takes on the clock: what it asked for unless a test says.
  readonly slept?: (ms: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly hash?: Hash;
  readonly dispatchThrowsOn?: string;
  // A detail builder in place of the real one.
  readonly detailBuilder?: typeof buildDetailRecord;
}

// One pass with the fakes. The clock starts at now and moves only with the
// waits and the detail reads, so a test can spend the detail budget, which
// counts reading and not the waits. Every record dispatched is checked for
// text from the site, and every log line for text, the token and ids.
async function pass(web: ReturnType<typeof site>, side: ReturnType<typeof rexSpider>, options: RunOptions = {}) {
  let clock = options.now ?? NOW;
  const core = options.core ?? rexCore();
  const sent: Json[] = [];
  const raw: unknown[] = [];
  const events: string[] = [];
  // events, with every keep-alive call and every rex-core call in its place.
  const trace: string[] = [];
  const note = (event: string) => {
    events.push(event);
    trace.push(event);
  };
  const lines: string[] = [];
  const outcome: PassOutcome = await runPass({
    client: (token) => ({
      get: async (url: string) => {
        web.requests.push({ url, token });
        note(`GET ${label(url)}`);
        clock += url.includes('/backend-api/conversation/') ? options.readMs ?? 0 : options.listMs ?? 0;
        return web.answerTo(url);
      },
    }),
    framework: {
      ...side.framework,
      crawlWindowStart: () => {
        trace.push('window');
        return side.framework.crawlWindowStart();
      },
      checkIfAlreadyTransmitted: (id, at) => {
        trace.push(`lookup ${id}`);
        return side.framework.checkIfAlreadyTransmitted(id, at);
      },
      logTransmitted: (id, at) => {
        note(`stamp ${id}`);
        clock += options.stampMs ?? 0;
        return side.framework.logTransmitted(id, at);
      },
    },
    store: {
      ...core.store,
      mode: {
        get: () => {
          trace.push('mode get');
          return core.store.mode.get();
        },
        set: (record) => {
          trace.push('mode set');
          return core.store.mode.set(record);
        },
      },
    },
    dispatch: (record) => {
      if (record.identifier === options.dispatchThrowsOn) throw new Error('the queue is full');
      raw.push(record);
      const text = JSON.stringify(record);
      assert.equal(text.includes(MARK), false, 'text from the site reached an upload');
      sent.push(JSON.parse(text) as Json);
      note(`dispatch ${String(record.identifier)}`);
    },
    sleep: options.sleep ?? (async (ms) => {
      note(`wait ${ms}`);
      clock += (options.slept ?? ((asked) => asked))(ms);
    }),
    keepAlive: () => {
      trace.push('keep-alive');
    },
    hash: options.hash ?? sha256,
    ...(options.detailBuilder === undefined ? {} : { records: { summary: buildSummaryRecord, detail: options.detailBuilder } }),
    limits: { ...PASS_LIMITS, storeMs: 50, hashMs: 50, ...options.limits },
    log: (line) => lines.push(line),
  }, () => clock);
  for (const line of lines) {
    assert.equal(line.includes(MARK) || line.includes(TOKEN) || line.includes('g-p-') || /[0-9a-f]{8}-[0-9a-f]{4}-/.test(line), false, `a log line carries text, a token or an id: ${line}`);
  }
  return { outcome, sent, raw, events, trace, lines, clock: () => clock };
}

const withoutMs = (reason: string): string => reason.replace(/ ms=\d+$/, '');
const detailsOf = (events: readonly string[]): string[] => events.filter((event) => event.startsWith('GET detail')).map((event) => event.slice('GET detail '.length));
const LIST_WALK = ['GET main 0', 'wait 30000', 'GET main 28', 'wait 30000', 'GET archived 0', 'wait 30000', 'GET starred 0', 'wait 30000', 'GET sidebar'];

test('the summary pass sends one summary per listed chat, newest first, stamped with the keys the spider has always written on both list paths', async () => {
  const projectTime = PROJECT_TIME;
  const web = site({ main: [listed(1, 1), listed(2, 3)], projects: { [PROJECT]: [projectItem(chat(3), { update_time: projectTime })] } });
  const side = rexSpider({ summarize: true });
  const run = await pass(web, side);
  assert.deepEqual(run.events, [
    'GET home', 'wait 30000', ...LIST_WALK, 'wait 30000', 'GET project',
    `dispatch ${chat(1)}`, `dispatch ${chat(3)}`, `dispatch ${chat(2)}`, 'wait 3000', `stamp ${chat(1)}`, `stamp ${chat(3)}`, `stamp ${chat(2)}`,
  ]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'summary'), `${chat(3)} ${projectKeyMs(projectTime)}`, keyOf(2, 3, 'summary')]);
  for (const record of run.sent) {
    assert.deepEqual([record.name, record.platform, record.format_version, record.is_summary, record.turns], ['rex-conversation', 'chatgpt', 1, true, []]);
  }
  assert.deepEqual(run.outcome.ids, [chat(1), chat(2), chat(3)]);
  assert.equal(run.outcome.count, 3);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=3');
  const again = await pass(site({ main: [listed(1, 1), listed(2, 3)], projects: { [PROJECT]: [projectItem(chat(3), { update_time: projectTime })] } }), side);
  assert.deepEqual(again.sent, []);
  assert.equal(withoutMs(again.outcome.reason), 'ok seen=3 dispatched=0');
});

test('summary records are built in full, their hashes made, before they are dispatched', async () => {
  const run = await pass(site({ main: [listed(1, 1)] }), rexSpider({ summarize: true }));
  assert.equal(run.raw.length, 1);
  assert.equal(typeof (run.raw[0] as { then?: unknown }).then, 'undefined');
  assert.equal((run.sent[0].metadata as Json).title_hash, LIST_TITLE_HASH);
});

test('the detail pass reads each chat and sends format 1 records, stamped with -detail keys at the list\'s time and never at the record\'s ended', async () => {
  const projectTime = PROJECT_TIME;
  const lists = { main: [listed(1, 1), listed(2, 3)], projects: { [PROJECT]: [projectItem(chat(3), { update_time: projectTime })] } };
  const side = rexSpider();
  const core = rexCore();
  const run = await pass(site(lists), side, { core });
  assert.deepEqual(run.events, [
    'GET home', 'wait 30000', ...LIST_WALK, 'wait 30000', 'GET project',
    'wait 30000', `GET detail ${chat(1)}`, `dispatch ${chat(1)}`,
    'wait 30000', `stamp ${chat(1)}-detail`, `GET detail ${chat(3)}`, `dispatch ${chat(3)}`,
    'wait 30000', `stamp ${chat(3)}-detail`, `GET detail ${chat(2)}`, `dispatch ${chat(2)}`,
    'wait 3000', `stamp ${chat(2)}-detail`,
  ]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail'), `${chat(3)}-detail ${projectKeyMs(projectTime)}`, keyOf(2, 3, 'detail')]);
  for (const record of run.sent) {
    assert.deepEqual([record.format_version, record.is_summary, record.turns_complete, (record.turns as unknown[]).length], [1, false, true, 2]);
    // The record's ended is its latest message, not the list's time the key holds.
    assert.equal(record.ended, '2026-11-10T14:00:07Z');
  }
  assert.deepEqual(core.writes, [{ mode: 'detail', since: NOW }]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=3');
  const again = await pass(site(lists), side, { core });
  assert.deepEqual(detailsOf(again.events), []);
  assert.equal(withoutMs(again.outcome.reason), 'ok seen=3 dispatched=0');
});

// The calls that go to rex-core: the store adapter's and rex-spider's.
const REX_CORE_CALL = /^(window|lookup |stamp |mode (get|set))/;

test('every call to rex-core is made just after a keep-alive call, since store calls do not reset the worker\'s idle timer', async () => {
  const side = rexSpider({ keys: [keyOf(2, 2, 'detail')] });
  const run = await pass(site({ main: [listed(1, 1), listed(2, 2)] }), side, { core: rexCore({ mode: { mode: 'summary', since: NOW - DAY } }) });
  const calls = run.trace.flatMap((entry, at) => (REX_CORE_CALL.test(entry) ? [[entry, run.trace[at - 1]]] : []));
  assert.ok(calls.length >= 8, `only ${calls.length} rex-core calls were seen`);
  for (const [call, before] of calls) {
    assert.equal(before, 'keep-alive', `${call} came after ${before}`);
  }
});

test('a keep-alive call comes before each summary record is built, since a hash that hangs can hold a record for its deadline', async () => {
  const run = await pass(site({ main: [listed(1, 1), listed(2, 2), listed(3, 3)] }), rexSpider({ summarize: true }));
  const firstDispatch = run.trace.indexOf(`dispatch ${chat(1)}`);
  const lastLookup = run.trace.slice(0, firstDispatch).map((entry) => entry.startsWith('lookup ')).lastIndexOf(true);
  assert.deepEqual(run.trace.slice(lastLookup + 1, run.trace.indexOf('wait 3000')), [
    'keep-alive', `dispatch ${chat(1)}`, 'keep-alive', `dispatch ${chat(2)}`, 'keep-alive', `dispatch ${chat(3)}`,
  ]);
});

test('the home page is fetched with no token, every request after it with the token from it, and a chat\'s detail at its own URL', async () => {
  const web = site({ main: [listed(1, 1)] });
  await pass(web, rexSpider());
  assert.deepEqual(web.requests[0], { url: HOME, token: undefined });
  assert.ok(web.requests.slice(1).every((request) => request.token === TOKEN));
  assert.equal(web.requests.at(-1)?.url, `https://chatgpt.com/backend-api/conversation/${chat(1)}`);
});

test('a switch from summary to detail re-sends in detail only the chats last used in the 90 days before it', async () => {
  // chat 1 sent as a summary 10 days ago, chat 2 100 days ago, chat 3 never.
  const side = rexSpider({ keys: [keyOf(1, 10, 'summary'), keyOf(2, 100, 'summary')] });
  const core = rexCore({ mode: { mode: 'summary', since: NOW - 200 * DAY } });
  const run = await pass(site({ main: [listed(3, 5), listed(1, 10), listed(2, 100)] }), side, { core });
  assert.deepEqual(detailsOf(run.events), [chat(3), chat(1)]);
  assert.deepEqual(side.stamps, [keyOf(3, 5, 'detail'), keyOf(1, 10, 'detail')]);
  assert.deepEqual(core.writes, [{ mode: 'detail', since: NOW }]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=2');
});

test('a switch from detail to summary re-sends as summaries only the chats last used in the 90 days before it', async () => {
  const side = rexSpider({ summarize: true, keys: [keyOf(1, 10, 'detail'), keyOf(2, 100, 'detail')] });
  const core = rexCore({ mode: { mode: 'detail', since: NOW - 200 * DAY } });
  const run = await pass(site({ main: [listed(3, 5), listed(1, 10), listed(2, 100)] }), side, { core });
  assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary]), [[chat(3), true], [chat(1), true]]);
  assert.deepEqual(side.stamps, [keyOf(3, 5, 'summary'), keyOf(1, 10, 'summary')]);
  assert.deepEqual(core.writes, [{ mode: 'summary', since: NOW }]);
});

test('a store that does not answer the mode record holds back the chats sent only in the other mode, and sends the rest', async () => {
  const side = rexSpider({ keys: [keyOf(1, 10, 'summary')] });
  const core = rexCore({ mode: { mode: 'summary', since: NOW - 200 * DAY }, unanswered: true });
  const run = await pass(site({ main: [listed(3, 5), listed(1, 10)] }), side, { core });
  assert.deepEqual(detailsOf(run.events), [chat(3)]);
  assert.deepEqual(side.stamps, [keyOf(3, 5, 'detail')]);
  assert.deepEqual(core.writes, []);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 held=1');
});

test('a mode record that cannot be written holds them back too', async () => {
  const side = rexSpider({ keys: [keyOf(1, 10, 'summary')] });
  const core = rexCore({ mode: { mode: 'summary', since: NOW - 200 * DAY }, unkept: true });
  const run = await pass(site({ main: [listed(3, 5), listed(1, 10)] }), side, { core });
  assert.deepEqual(detailsOf(run.events), [chat(3)]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 held=1');
});

test('a key lookup that never answers stops the sending with nothing sent: its deadline rejects, and never reads as not sent', { timeout: 5000 }, async () => {
  const side = rexSpider({ silentLookups: true });
  const run = await pass(site({ main: [listed(1, 1), listed(2, 3)] }), side);
  assert.deepEqual(run.sent, []);
  assert.deepEqual(detailsOf(run.events), []);
  assert.equal(side.lookups.length, 1);
  assert.equal(run.outcome.count, 0);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=0 stop=store');
});

test('a summary stamp that is not kept stops the sending for the pass, and the records with no key count as left: they go out again', async () => {
  const side = rexSpider({ summarize: true, unkeptStamps: true });
  const run = await pass(site({ main: [listed(1, 1), listed(2, 3)] }), side);
  assert.equal(run.sent.length, 2);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'summary')]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=2 left=2 stop=store');
});

test('a detail stamp that is not kept stops the reads before the next one, and its chat counts as left with the one not read', async () => {
  const side = rexSpider({ unkeptStamps: true });
  const run = await pass(site({ main: [listed(1, 1), listed(2, 3)] }), side);
  assert.deepEqual(detailsOf(run.events), [chat(1)]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 left=2 stop=store');
});

test('the last detail record\'s key, written after the reads, counts it as left when it is not kept', async () => {
  const side = rexSpider({ unkeptStamps: true });
  const run = await pass(site({ main: [listed(1, 1)] }), side);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=1 dispatched=1 left=1 stop=store');
});

test('the detail budget is 360 s of reading', () => {
  assert.equal(PASS_LIMITS.detailBudgetMs, 360_000);
});

test('the detail budget counts the reading: at 100 s a read, the reads stop after four and the rest wait for a later pass', async () => {
  const main = [1, 2, 3, 4, 5, 6].map((n) => listed(n, n));
  const side = rexSpider();
  const run = await pass(site({ main }), side, { readMs: 100_000 });
  assert.deepEqual(detailsOf(run.events), [chat(1), chat(2), chat(3), chat(4)]);
  assert.deepEqual(side.stamps, [1, 2, 3, 4].map((n) => keyOf(n, n, 'detail')));
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=6 dispatched=4 left=2 stop=budget');
});

test('the budget starts at the first detail read: a list walk that takes longer than the budget does not starve the reads', async () => {
  const main = [1, 2, 3].map((n) => listed(n, n));
  // Six requests before the reads (the home page and five list pages) at 100 s each.
  const run = await pass(site({ main }), rexSpider(), { listMs: 100_000 });
  assert.deepEqual(detailsOf(run.events), [chat(1), chat(2), chat(3)]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=3');
});

test('store calls during the reads count against the budget: at 100 s a stamp, the reads stop after five', async () => {
  const main = [1, 2, 3, 4, 5, 6].map((n) => listed(n, n));
  const side = rexSpider();
  const run = await pass(site({ main }), side, { stampMs: 100_000 });
  assert.deepEqual(detailsOf(run.events), [1, 2, 3, 4, 5].map(chat));
  assert.deepEqual(side.stamps, [1, 2, 3, 4, 5].map((n) => keyOf(n, n, 'detail')));
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=6 dispatched=5 left=1 stop=budget');
});

test('the paced waits do not count against the budget: twenty reads 30 s apart all go out', async () => {
  const main = Array.from({ length: 20 }, (_, k) => listed(k + 1, k + 1));
  const run = await pass(site({ main }), rexSpider());
  assert.equal(detailsOf(run.events).length, 20);
  assert.ok(run.clock() - NOW > 600_000, 'the waits took less than the budget');
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=20 dispatched=20');
});

test('nor does a wait that runs longer than it asked: it is measured on the clock', async () => {
  const main = [1, 2, 3, 4, 5, 6].map((n) => listed(n, n));
  const run = await pass(site({ main }), rexSpider(), { readMs: 50_000, slept: (ms) => ms + 50_000 });
  assert.equal(detailsOf(run.events).length, 6);
});

test('a crawl_delay of 0 still keeps the settle wait between detail reads, and one that cannot be read is 30 s', async () => {
  const fast = await pass(site({ main: [listed(1, 1), listed(2, 2)] }), rexSpider({ crawlDelay: 0 }));
  assert.deepEqual(fast.events.filter((event) => event.startsWith('wait')), ['wait 0', 'wait 0', 'wait 0', 'wait 0', 'wait 0', 'wait 3000', 'wait 3000', 'wait 3000']);
  const broken = await pass(site({ main: [listed(1, 1)] }), rexSpider({ crawlDelay: 'soon' }));
  // After the home page, between the five list requests, and before the read.
  assert.deepEqual(broken.events.filter((event) => event.startsWith('wait')), [...Array(6).fill('wait 30000'), 'wait 3000']);
});

test('summarize served during the detail reads ends them; the chats sent keep their detail keys, and the next pass sends in summary', async () => {
  const main = [1, 2, 3, 4].map((n) => listed(n, n));
  const web = site({ main });
  let summarize = false;
  const side = rexSpider({ summarize: () => summarize || web.reads.length >= 2 });
  const core = rexCore();
  const run = await pass(web, side, { core });
  assert.deepEqual(detailsOf(run.events), [chat(1), chat(2)]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail'), keyOf(2, 2, 'detail')]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=4 dispatched=2 left=2 stop=mode');
  summarize = true;
  const next = await pass(site({ main }), side, { core });
  assert.deepEqual(detailsOf(next.events), []);
  // The switch re-sends the two read in detail once, in summary, as it would any chat used in the 90 days before it.
  assert.deepEqual(next.sent.map((record) => [record.identifier, record.is_summary]), [1, 2, 3, 4].map((n) => [chat(n), true]));
  assert.ok(side.keys.has(keyOf(1, 1, 'detail')) && side.keys.has(keyOf(2, 2, 'detail')));
});

test('detail served during a summary pass ends it too, and what went out is stamped', async () => {
  let asked = 0;
  // Read once when the pass starts and once before each chat.
  const side = rexSpider({ summarize: () => (asked += 1) <= 2 });
  const run = await pass(site({ main: [listed(1, 1), listed(2, 2), listed(3, 3)] }), side);
  assert.deepEqual(run.sent.map((record) => record.identifier), [chat(1)]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'summary')]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=1 left=2 stop=mode');
});

test('enabled false served during the detail reads stops them before the next request', async () => {
  const web = site({ main: [1, 2, 3, 4].map((n) => listed(n, n)) });
  const side = rexSpider({ enabled: () => web.reads.length < 2 });
  const run = await pass(web, side);
  assert.deepEqual(detailsOf(run.events), [chat(1), chat(2)]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail'), keyOf(2, 2, 'detail')]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=4 dispatched=2 left=2 stop=disabled');
});

test('a switch-off served while the mode record is read stops the pass before any request', async () => {
  let enabled = true;
  const web = site({ main: [listed(1, 1)] });
  const run = await pass(web, rexSpider({ enabled: () => enabled }), { core: rexCore({ onRead: () => { enabled = false; } }) });
  assert.deepEqual(web.requests, []);
  assert.deepEqual(run.outcome, { count: -1, ids: [], reason: run.outcome.reason });
  assert.equal(withoutMs(run.outcome.reason), 'disabled stage=start');
});

test('a switch-off served while the crawl window is looked up stops the pass before the home page', async () => {
  let enabled = true;
  const web = site({ main: [listed(1, 1)] });
  const run = await pass(web, rexSpider({ enabled: () => enabled, onWindow: () => { enabled = false; } }));
  assert.deepEqual(web.requests, []);
  assert.deepEqual([run.outcome.count, withoutMs(run.outcome.reason)], [-1, 'disabled stage=start']);
});

test('a switch-off served during the list walk stops it before its next request, with no reading of the list', async () => {
  const web = site({ main: [listed(1, 1)] });
  const run = await pass(web, rexSpider({ enabled: () => web.requests.length < 3 }));
  assert.deepEqual(run.events.filter((event) => event.startsWith('GET')), ['GET home', 'GET main 0', 'GET main 28']);
  assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], 'disabled stage=list']);
});

test('archived and starred chats are held back when the project lists were not read whole', async () => {
  const web = site({ main: [listed(1, 1)], archived: [listed(2, 2, { is_archived: true })], starred: [listed(3, 3, { is_starred: true })], failing: { sidebar: json({ detail: `${MARK} broke` }, 500) } });
  const side = rexSpider({ summarize: true });
  const run = await pass(web, side);
  assert.deepEqual(run.sent.map((record) => record.identifier), [chat(1)]);
  assert.deepEqual([run.outcome.count, run.outcome.ids], [-1, []]);
  assert.equal(withoutMs(run.outcome.reason), 'partial seen=3 dispatched=1 held=2');
});

test('a list read in part is no reading of the account: count -1 and no ids, so the chats it missed do not read as deleted, while the reason says what went out', async () => {
  const main = Array.from({ length: 30 }, (_, k) => listed(k + 1, k + 1));
  const web = site({ main, answers: { 'main 28': json({ detail: `${MARK} broke` }, 500) } });
  const run = await pass(web, rexSpider({ summarize: true }));
  assert.equal(run.sent.length, 28);
  assert.deepEqual([run.outcome.count, run.outcome.ids], [-1, []]);
  assert.equal(withoutMs(run.outcome.reason), 'partial seen=28 dispatched=28');
});

test('they are sent when the project lists were read whole', async () => {
  const web = site({ main: [listed(1, 1)], archived: [listed(2, 2, { is_archived: true })], starred: [listed(3, 3, { is_starred: true })] });
  const run = await pass(web, rexSpider({ summarize: true }));
  assert.deepEqual(run.sent.map((record) => record.identifier), [chat(1), chat(2), chat(3)]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=3');
});

test('a list read only in part that gives no chat is no reading of the account: count -1, never an empty list', async () => {
  const broken = json({ detail: `${MARK} broke` }, 500, { 'x-detail': MARK });
  const web = site({ failing: { main: broken, archived: broken, starred: broken, sidebar: broken } });
  const run = await pass(web, rexSpider({ summarize: true }));
  assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], 'list-failed']);
});

test('a list read whole with no chat in the window is an empty reading: count 0', async () => {
  const run = await pass(site(), rexSpider({ summarize: true }));
  assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [0, [], 'ok seen=0 dispatched=0']);
});

test('the list walk reads the crawl window rex-spider gives', async () => {
  const run = await pass(site({ main: [listed(1, 1), listed(2, 30)] }), rexSpider({ summarize: true, windowStart: NOW - 10 * DAY }));
  assert.deepEqual(run.outcome.ids, [chat(1)]);
});

test('a crawl window that does not come stops the pass before any request', { timeout: 5000 }, async () => {
  const web = site({ main: [listed(1, 1)] });
  const run = await pass(web, rexSpider({ silentWindow: true }));
  assert.deepEqual(web.requests, []);
  assert.deepEqual([run.outcome.count, withoutMs(run.outcome.reason)], [-1, 'store']);
});

test('a list that is rate-limited or challenged ends the pass with no reading, and no request after it', async () => {
  const limited = await pass(site({ main: [listed(1, 1)], failing: { main: json({}, 429, { 'retry-after': '120' }) } }), rexSpider());
  assert.deepEqual(limited.events.filter((event) => event.startsWith('GET')), ['GET home', 'GET main 0']);
  assert.deepEqual([limited.outcome.count, withoutMs(limited.outcome.reason)], [-1, 'rate-limited stage=list retry-after=120']);
  const challenged = await pass(site({ main: [listed(1, 1)], failing: { main: { status: 403, headers: { 'cf-mitigated': 'challenge' }, text: '<html>' } } }), rexSpider());
  assert.equal(withoutMs(challenged.outcome.reason), 'challenge stage=list');
  const signedOut = await pass(site({ main: [listed(1, 1)], failing: { main: json({}, 401) } }), rexSpider());
  assert.equal(withoutMs(signedOut.outcome.reason), 'not-signed-in stage=list status=401');
});

test('the home page decides whether the pass goes on: no token, a 401, another status, or no answer end it there', async () => {
  const cases: [Reply | 'network' | 'timeout', string][] = [
    [{ status: 200, headers: {}, text: `<html>${MARK} Log in</html>` }, 'not-signed-in stage=home'],
    [json({}, 401), 'not-signed-in stage=home status=401'],
    [json({}, 500), 'http-error stage=home status=500'],
    [json({}, 404), 'http-error stage=home status=404'],
    [json({}, 429, { 'retry-after': '90' }), 'rate-limited stage=home status=429 retry-after=90'],
    [json({}, 503), 'rate-limited stage=home status=503'],
    [{ status: 403, headers: { 'cf-mitigated': 'challenge' }, text: `<html>${MARK}</html>` }, 'challenge stage=home status=403'],
    ['network', 'network stage=home'],
    ['timeout', 'timeout stage=home'],
  ];
  for (const [home, reason] of cases) {
    const web = site({ main: [listed(1, 1)], home: typeof home === 'string' ? () => { throw new RequestError(home); } : home });
    const run = await pass(web, rexSpider());
    assert.equal(web.requests.length, 1, reason);
    assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], reason]);
  }
});

test('a hash that never answers gives null hashes, and the records still go out', { timeout: 5000 }, async () => {
  const stuck: Hash = () => new Promise(() => {});
  const summary = await pass(site({ main: [listed(1, 1)] }), rexSpider({ summarize: true }), { hash: stuck });
  assert.equal((summary.sent[0].metadata as Json).title_hash, null);
  const read = await pass(site({ main: [listed(1, 1)] }), rexSpider(), { hash: stuck });
  assert.equal((read.sent[0].metadata as Json).title_hash, null);
  assert.equal(read.sent[0].is_summary, false);
});

test('a detail that gives no record sends nothing for its chat and stamps no key', async () => {
  // A detail of another chat, which the record builder refuses.
  const web = site({ main: [listed(1, 1), listed(2, 2)], details: { [chat(1)]: json(chatDetail(chat(9))) } });
  const side = rexSpider();
  const run = await pass(web, side);
  assert.deepEqual(run.sent.map((record) => record.identifier).includes(chat(1)), false);
  assert.equal(side.stamps.some((key) => key.startsWith(chat(1))), false);
});

// A builder that throws on one chat's detail (no input is known to make the
// real one throw; this stands in for a fault in a later build).
const throwsOn = (id: string): typeof buildDetailRecord => async (json, item, hash) => {
  if (item.id === id) throw new TypeError('the builder broke');
  return buildDetailRecord(json, item, hash);
};

test('a record builder that throws on a chat\'s detail fails that read, and does not end the pass as an internal error', async () => {
  const run = await pass(site({ main: [listed(1, 1), listed(2, 2)] }), rexSpider(), { detailBuilder: throwsOn(chat(1)) });
  assert.deepEqual(detailsOf(run.events), [chat(1)]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=0 failed=1 left=2 stop=failed-reads');
});

test('a wait that rejects ends the pass with a reason, and runPass does not throw', async () => {
  let calls = 0;
  let throwAt = 0;
  const failing = async () => {
    calls += 1;
    if (calls === throwAt) throw new TypeError('timer broke');
  };
  // The third wait is the walk's second.
  throwAt = 3;
  const walk = await pass(site({ main: [listed(1, 1)] }), rexSpider(), { sleep: failing });
  assert.deepEqual([walk.outcome.count, withoutMs(walk.outcome.reason)], [-1, 'internal stage=list']);
  // The seventh is the one before the second read: the first record still gets its key.
  calls = 0;
  throwAt = 7;
  const side = rexSpider();
  const reads = await pass(site({ main: [listed(1, 1), listed(2, 2)] }), side, { sleep: failing });
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail')]);
  assert.equal(withoutMs(reads.outcome.reason), 'ok seen=2 dispatched=1 left=1 stop=internal');
});

test('a dispatch that throws stops the sending, and its chat gets no key', async () => {
  const side = rexSpider({ summarize: true });
  const run = await pass(site({ main: [listed(1, 1), listed(2, 2)] }), side, { dispatchThrowsOn: chat(2) });
  assert.deepEqual(run.sent.map((record) => record.identifier), [chat(1)]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'summary')]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 left=1 stop=internal');
});

test('a switch-off before the pass starts sends no request', async () => {
  const web = site({ main: [listed(1, 1)] });
  const run = await pass(web, rexSpider({ enabled: false }));
  assert.deepEqual(web.requests, []);
  assert.equal(withoutMs(run.outcome.reason), 'disabled stage=start');
});
