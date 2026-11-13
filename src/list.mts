// The list walk: every chat the spider can see, from the main list, the
// archived and starred lists, and each project, one item per chat id. It makes
// the requests, waits crawl_delay between them, and says how far it got. It
// reads nothing from a chat but what a ListItem holds, and never logs a title,
// a project item's snippet or owner, an id, or the text of a failure.
import { DateString } from '@bric/rex-types/types';

import { type Answer, type Client, RequestError, classify, retryAfterMs } from './client.mts';

export const PAGE_SIZE = 28;

// A list still handing out pages after this many is cut, so a server that
// never stops paging cannot hold a crawl. 1,000 pages of 28 is far past any
// account seen.
export const MAX_PAGES = 1000;

// Cuts the whole walk, whatever lists the requests go to. A bound on the
// bounds: each list is already cut at MAX_PAGES, but a long sidebar of
// projects would multiply that.
export const MAX_REQUESTS = 5000;

// A list of chats (main, archived, starred or a project) whose pages bring no
// chat it had not given, this many in a row, is cut: its paging is not moving
// on. One such page can be ordinary (chats that move up between two calls
// shift a page), so it takes three.
export const STALE_PAGES = 3;

// The spider's own default, used when the served crawl_delay is unreadable:
// a broken value must not become no pacing.
export const DEFAULT_CRAWL_DELAY_MS = 30_000;

export type Source = 'main' | 'archived' | 'starred' | 'project';

// A chat that several lists name is taken from the list ranked first here,
// whatever order they are walked in, so it gets the upload key the spider
// could already have stored for it. The spider has always read the main list
// and the projects. Its main query leaves out archived and starred chats, so
// for one of those inside a project only the project path's key can exist.
const RANK: Readonly<Record<Source, number>> = { main: 0, project: 1, archived: 2, starred: 3 };

// The list keys a summary record's metadata is built from, and the only ones
// kept from a list item (the design's allow-list). Each is in its form or
// null: the times as ISO instants as the list sent them, is_starred true or
// null (a list sends null, never false, for a chat that is not starred), the
// flags as booleans, and memory_scope and async_status as type names, or
// 'unrecognised' for a string of another form.
export interface ListMeta {
  readonly create_time: string | null;
  // Always set on a listed chat, which needs a readable update_time.
  readonly update_time: string | null;
  readonly is_archived: boolean | null;
  readonly is_starred: true | null;
  readonly pinned_time: string | null;
  readonly is_temporary_chat: boolean | null;
  readonly is_do_not_remember: boolean | null;
  readonly memory_scope: string | null;
  readonly async_status: string | null;
}

export interface ListItem {
  readonly id: string;
  // The list's title as sent. Hashed before anything leaves the spider.
  readonly title: string | null;
  // The list's create_time as the spider has always read it on each path: a
  // main, archived or starred chat's is new DateString(create_time), from the
  // ISO string with its microseconds; a project chat's is
  // new DateString(Date.parse(create_time) / 1000), which has milliseconds
  // only and rounding noise below them. Null when create_time is absent or
  // unreadable; the chat is still listed.
  readonly started: DateString | null;
  // The list's update_time, read from its ISO string with its microseconds on
  // every source. uploadTime is what the upload key uses.
  readonly updated: DateString;
  // The list the item was read from: of the lists that name the chat, the
  // first in RANK (main, project, archived, starred).
  readonly source: Source;
  readonly meta: ListMeta;
  // gizmo_id and conversation_template_id, a non-empty string or null, for
  // the hashes the summary carries. Never sent as they are.
  readonly gizmoId: string | null;
  readonly templateId: string | null;
}

// Epoch milliseconds, as rex-spider's crawlWindowContains reads them; null is
// no bound on that side.
export interface CrawlWindow {
  readonly start: number | null;
  readonly end: number | null;
}

export interface Pace {
  readonly crawlDelay: () => number;
  // The wait between two requests. Handed in so the pass can keep the worker
  // awake through it, and a test can run on a fake clock.
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface WalkOptions {
  readonly log?: (line: string) => void;
  readonly maxPages?: number;
  readonly maxRequests?: number;
}

export type WalkOutcome = 'whole' | 'partial' | 'failed';

export interface WalkResult {
  // Each chat in the crawl window once, in the order first seen (main, then
  // archived, then starred, then the projects, each list newest first). A
  // chat seen again on a list of higher RANK takes that list's item in place.
  readonly items: ListItem[];
  // whole: every list was read to its end and every chat was readable.
  // failed: an answer that was rate-limited, challenged or signed-out stopped
  // the walk, since the next request would meet the same answer. items holds
  // what was read before it, and is not to be acted on. partial: anything else
  // went wrong and the walk went on; items may be empty, which is then not an
  // empty account.
  readonly outcome: WalkOutcome;
  // 'ok' for a whole walk. For failed, the bare classification of the answer
  // that stopped it: rate-limited, challenge or signed-out. For partial, what
  // went wrong, each thing once, joined by '; ': a list that ended on a
  // failure or was cut ('archived: server', 'main: page-limit', 'project:
  // refused', 'sidebar: not-moving'; the failure is one of refused, server,
  // not-json, timeout, network, bad-page) or 'request-limit' if the walk hit
  // its limit, in the order they happened, then the chats that could not be
  // read, counted ('2 items with no id', '3 items with an unreadable
  // update_time'). The lists are named, but no project, chat or title is.
  readonly reason: string;
  // Whether the walk saw every project chat in the window: the sidebar and
  // each project it named were read to their end (an empty page, a cursor
  // that is null, missing or '', or a page with nothing in the window), with
  // no stop, failure, bad page or cut on any of them. When false, a starred or
  // archived chat in a project the walk did not finish was taken from the
  // starred or archived list, so its upload time may not be the one the
  // spider stored for it, and the pass holds such chats back. Chats a project
  // lists that could not be read leave it true; the reason counts them.
  readonly projectsWhole: boolean;
  // The wait a rate-limited or challenged answer asked for, when it named one.
  readonly retryAfterMs?: number;
}

const API = 'https://chatgpt.com/backend-api';
const CONVERSATIONS = `${API}/conversations`;
const SIDEBAR = `${API}/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=${PAGE_SIZE}`;

// The main query is byte for byte the spider's own. The other two are the
// same list with the filter that reaches the chats it leaves out.
const FILTERS = {
  main: 'is_archived=false&is_starred=false',
  archived: 'is_archived=true',
  starred: 'is_starred=true',
} as const;

const conversationsUrl = (source: keyof typeof FILTERS, offset: number) => `${CONVERSATIONS}?offset=${offset}&limit=${PAGE_SIZE}&order=updated&${FILTERS[source]}`;

function cursorUrl(base: string, cursor: string): string {
  const url = new URL(base);
  url.searchParams.set('cursor', cursor);
  return url.href;
}

const sidebarUrl = (cursor: string | null) => (cursor === null ? SIDEBAR : cursorUrl(SIDEBAR, cursor));
const projectUrl = (projectId: string, cursor: string) => cursorUrl(`${API}/gizmos/${encodeURIComponent(projectId)}/conversations`, cursor);

// An ISO 8601 instant: a date, a time, and Z or an offset. The capture's are
// like "2026-09-08T13:48:43.781123Z". It is checked by shape, then by
// Temporal, before DateString reads it, because DateString logs the value it
// cannot read and these fields are not ours to log. Date.parse is no check:
// it reads almost any string with a number in it ("TITLE-2" is February
// 2001).
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)$/;

// Temporal.Instant, taken from a DateString's value so it is the copy
// DateString reads with. Its from() throws on a string of the right shape
// that names no instant (a 13th month, 30 February, hour 24, offset +25:00),
// where DateString would print the string.
const INSTANT = (new DateString('1970-01-01T00:00:00Z').value as object).constructor as unknown as { from(item: string): unknown };

function namesInstant(value: string): boolean {
  try {
    INSTANT.from(value);
    return true;
  } catch {
    return false;
  }
}

// A string read as an instant, or null.
function instant(value: unknown): DateString | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value) || !namesInstant(value)) {
    return null;
  }
  // DateString reads it with the same Temporal, so its value is never null.
  return new DateString(value);
}

// The forms of ListMeta. A time is kept as the list sent it when the walk can
// read it as an instant, by the reader updated and started use (the shape
// alone lets a 13th month through, and Date.parse takes 30 February). A type
// name is lowercase letters, digits, _, . and -, at most 64 characters; any
// other string reads 'unrecognised', which carries nothing of it.
const TYPE_NAME = /^[a-z0-9_.-]{1,64}$/;
const isoTime = (value: unknown): string | null => (typeof value === 'string' && instant(value) !== null ? value : null);
const typeName = (value: unknown): string | null => (typeof value !== 'string' ? null : TYPE_NAME.test(value) ? value : 'unrecognised');
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const idText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

// Only the allow-list, key by key. Nothing is copied from the list item as a
// whole: a project item also carries a text snippet and its owner's address
// and name.
function readMeta(fields: Record<string, unknown>): ListMeta {
  return {
    create_time: isoTime(fields.create_time),
    update_time: isoTime(fields.update_time),
    is_archived: flag(fields.is_archived),
    is_starred: fields.is_starred === true ? true : null,
    pinned_time: isoTime(fields.pinned_time),
    is_temporary_chat: flag(fields.is_temporary_chat),
    is_do_not_remember: flag(fields.is_do_not_remember),
    memory_scope: typeName(fields.memory_scope),
    async_status: typeName(fields.async_status),
  };
}

// A chat is read only with an id and an update_time; one without is skipped
// and counted (the answer says which), so the walk says it was partial and the
// chat is not guessed at. A create_time that cannot be read only gives a null
// started.
function readItem(raw: unknown, source: Source): ListItem | 'no-id' | 'no-update-time' {
  if (typeof raw !== 'object' || raw === null) {
    return 'no-id';
  }
  const fields = raw as Record<string, unknown>;
  const { id, title, create_time: createdAt, update_time: updatedAt } = fields;
  if (typeof id !== 'string' || id === '') {
    return 'no-id';
  }
  const updated = instant(updatedAt);
  if (updated === null) {
    return 'no-update-time';
  }
  let started: DateString | null;
  if (source === 'project') {
    const createdMs = typeof createdAt === 'string' && ISO_INSTANT.test(createdAt) ? Date.parse(createdAt) : Number.NaN;
    started = Number.isNaN(createdMs) ? null : new DateString(createdMs / 1000);
  } else {
    started = instant(createdAt);
  }
  return {
    id,
    title: typeof title === 'string' ? title : null,
    started,
    updated,
    source,
    meta: readMeta(fields),
    gizmoId: idText(fields.gizmo_id),
    templateId: idText(fields.conversation_template_id),
  };
}

// The time the upload key is built from, as the spider has always built it on
// each path. A main, archived or starred chat uses the list's instant. A
// project chat uses new DateString(Date.parse(update_time) / 1000), which
// comes out up to 1 ms early (the division and the nanosecond rounding in
// DateString lose it), and is kept because changing it would send every such
// chat again. updated.timestamp() is Date.parse(update_time) for an ISO
// string, both cutting the microseconds.
export function uploadTime(item: ListItem): DateString {
  return item.source === 'project' ? new DateString(item.updated.timestamp() / 1000) : item.updated;
}

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined);

const inWindow = (window: CrawlWindow, ms: number) => (window.start === null || ms >= window.start) && (window.end === null || ms <= window.end);

const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultLog = (line: string) => console.log(`[rex-spider-chatgpt] ${line}`);

// crawl_delay comes from the served config as it was written. A number or a
// numeric string is read as it is (0 too); anything else is the default. The
// pass reads it the same way between its own requests.
export function crawlDelayMs(given: unknown): number {
  const ms = typeof given === 'number' ? given : typeof given === 'string' && given.trim() !== '' ? Number(given) : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_CRAWL_DELAY_MS;
}

const delayOf = (pace: Pace): number => crawlDelayMs(pace.crawlDelay());

interface Failure {
  readonly reason: string;
  readonly retryAfterMs: number | null;
}

type Read = { readonly body: Record<string, unknown> } | { readonly failure: Failure };

const failure = (reason: string, retryAfter: number | null = null): { failure: Failure } => ({ failure: { reason, retryAfterMs: retryAfter } });

// These stop the whole walk: the next request would meet the same answer, and
// the pass has to back off or sign in. Any other failure ends only its list.
const STOPS: ReadonlySet<string> = new Set(['rate-limited', 'challenge', 'signed-out']);

export async function walkLists(client: Pick<Client, 'get'>, window: CrawlWindow, pace: Pace, { log = defaultLog, maxPages = MAX_PAGES, maxRequests = MAX_REQUESTS }: WalkOptions = {}): Promise<WalkResult> {
  const sleep = pace.sleep ?? timer;
  // A log that throws has nowhere left to report to.
  const say = (line: string) => {
    try {
      log(line);
    } catch {
      // ignored
    }
  };
  const items = new Map<string, ListItem>();
  let requests = 0;
  // What went wrong on a walk that went on, each once, in the order it
  // happened, and the chats that could not be read.
  const problems: string[] = [];
  const problem = (text: string) => {
    if (!problems.includes(text)) {
      problems.push(text);
    }
  };
  let noId = 0;
  let noUpdateTime = 0;
  // The lists that ended short of their end (failed, cut, or a bad page), and
  // whether the walk got past the last project. Together they give
  // projectsWhole.
  const short = new Set<string>();
  let projectsDone = false;

  // A list read only in part: cut at the page limit, or paging that does not
  // move on.
  const cut = (reason: string, what: string) => {
    short.add(what);
    problem(`${what}: ${reason}`);
    say(`the ${what} list was read only in part (${reason})`);
  };

  // Reads a page's chats into the items, counting what it cannot read. Returns
  // how many were new to the list (`seen` holds the ids it gave before) and
  // how many were in the window.
  const take = (list: unknown[], source: Source, seen: Set<string>) => {
    let fresh = 0;
    let inside = 0;
    let unreadable = 0;
    for (const raw of list) {
      const item = readItem(raw, source);
      if (typeof item === 'string') {
        unreadable += 1;
        if (item === 'no-id') {
          noId += 1;
        } else {
          noUpdateTime += 1;
        }
        continue;
      }
      if (!seen.has(item.id)) {
        seen.add(item.id);
        fresh += 1;
      }
      if (inWindow(window, item.updated.timestamp())) {
        inside += 1;
        const held = items.get(item.id);
        if (held === undefined || RANK[item.source] < RANK[held.source]) {
          items.set(item.id, item);
        }
      }
    }
    if (unreadable > 0) {
      say(`skipped ${unreadable} entries of the ${source} list with no usable id or update_time`);
    }
    return { fresh, inside };
  };

  // One paced request, answered as a JSON object or as why it was not.
  async function read(url: string): Promise<Read> {
    if (requests >= maxRequests) {
      return failure('request-limit');
    }
    if (requests > 0) {
      await sleep(delayOf(pace));
    }
    requests += 1;
    let answer: Answer;
    try {
      answer = await client.get(url);
    } catch (error) {
      return failure(error instanceof RequestError ? error.kind : 'network');
    }
    const verdict = classify(answer);
    if (verdict !== 'ok') {
      return failure(verdict, verdict === 'rate-limited' || verdict === 'challenge' ? retryAfterMs(answer) : null);
    }
    let body: unknown;
    try {
      body = JSON.parse(answer.text);
    } catch {
      return failure('not-json');
    }
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? { body: body as Record<string, unknown> } : failure('bad-page');
  }

  // A list that could not be read to its end. A failure that stops the walk is
  // handed back to stop it; any other is named and ends that list only.
  const ended = (what: string, page: number, why: Failure): Failure | null => {
    short.add(what);
    say(`the ${what} list ended at page ${page} (${why.reason})`);
    if (STOPS.has(why.reason)) {
      return why;
    }
    // The limit is the walk's, not a list's: every list after this one meets it.
    problem(why.reason === 'request-limit' ? 'request-limit' : `${what}: ${why.reason}`);
    return null;
  };
  const badPage: Failure = { reason: 'bad-page', retryAfterMs: null };

  // The main, archived and starred lists, by offset. Each stops as the
  // spider's main walk always has: on an empty page, or a page with nothing in
  // the window. Never by `total`, which is not a count.
  async function walkConversations(source: keyof typeof FILTERS): Promise<Failure | null> {
    const seen = new Set<string>();
    let stale = 0;
    for (let pages = 0; ; pages += 1) {
      if (pages >= maxPages) {
        cut('page-limit', source);
        return null;
      }
      const got = await read(conversationsUrl(source, pages * PAGE_SIZE));
      if ('failure' in got) {
        return ended(source, pages + 1, got.failure);
      }
      const list = got.body.items;
      if (!Array.isArray(list)) {
        return ended(source, pages + 1, badPage);
      }
      if (list.length === 0) {
        return null;
      }
      const { fresh, inside } = take(list, source, seen);
      if (inside === 0) {
        return null;
      }
      stale = fresh === 0 ? stale + 1 : 0;
      if (stale >= STALE_PAGES) {
        cut('not-moving', source);
        return null;
      }
    }
  }

  // A cursor is a string or a number; null, undefined and '' end the list.
  // Undefined is returned for any other value.
  const nextCursor = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    if (typeof value === 'string') {
      return value;
    }
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
  };

  // The sidebar's pages, giving the ids of the projects, g-p- gizmos. Other
  // gizmos are the account's own GPTs and are no project. A page that fails
  // ends the sidebar, and the projects of the pages before it are still read.
  async function walkSidebar(): Promise<{ projects: string[]; stop: Failure | null }> {
    const projects: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pages = 0; ; pages += 1) {
      if (pages >= maxPages) {
        cut('page-limit', 'sidebar');
        return { projects, stop: null };
      }
      const got = await read(sidebarUrl(cursor));
      if ('failure' in got) {
        return { projects, stop: ended('sidebar', pages + 1, got.failure) };
      }
      const list = got.body.items;
      if (!Array.isArray(list)) {
        return { projects, stop: ended('sidebar', pages + 1, badPage) };
      }
      for (const entry of list) {
        const id = field(field(field(entry, 'gizmo'), 'gizmo'), 'id');
        if (typeof id === 'string' && id.startsWith('g-p-') && !projects.includes(id)) {
          projects.push(id);
        }
      }
      const next = nextCursor(got.body.cursor);
      if (next === undefined) {
        return { projects, stop: ended('sidebar', pages + 1, badPage) };
      }
      if (next === null) {
        return { projects, stop: null };
      }
      if (cursors.has(next)) {
        cut('not-moving', 'sidebar');
        return { projects, stop: null };
      }
      cursors.add(next);
      cursor = next;
    }
  }

  // A project's chats, by cursor from 0. It stops as the conversation lists
  // do, on an empty page, a page with nothing in the window, or pages that
  // bring nothing new, and also on a cursor that is null, missing or '' or
  // comes back. It is a safety net: the capture found every project chat on
  // the main list too.
  async function walkProject(projectId: string): Promise<Failure | null> {
    const cursors = new Set<string>();
    const seen = new Set<string>();
    let stale = 0;
    let cursor = '0';
    for (let pages = 0; ; pages += 1) {
      if (pages >= maxPages) {
        cut('page-limit', 'project');
        return null;
      }
      cursors.add(cursor);
      const got = await read(projectUrl(projectId, cursor));
      if ('failure' in got) {
        return ended('project', pages + 1, got.failure);
      }
      const list = got.body.items;
      if (!Array.isArray(list)) {
        return ended('project', pages + 1, badPage);
      }
      if (list.length === 0) {
        return null;
      }
      const { fresh, inside } = take(list, 'project', seen);
      if (inside === 0) {
        return null;
      }
      stale = fresh === 0 ? stale + 1 : 0;
      if (stale >= STALE_PAGES) {
        cut('not-moving', 'project');
        return null;
      }
      const next = nextCursor(got.body.cursor);
      if (next === undefined) {
        return ended('project', pages + 1, badPage);
      }
      if (next === null) {
        return null;
      }
      if (cursors.has(next)) {
        cut('not-moving', 'project');
        return null;
      }
      cursor = next;
    }
  }

  async function walk(): Promise<Failure | null> {
    for (const source of ['main', 'archived', 'starred'] as const) {
      const stopped = await walkConversations(source);
      if (stopped !== null) {
        return stopped;
      }
    }
    const sidebar = await walkSidebar();
    if (sidebar.stop !== null) {
      return sidebar.stop;
    }
    for (const projectId of sidebar.projects) {
      const stopped = await walkProject(projectId);
      if (stopped !== null) {
        return stopped;
      }
    }
    projectsDone = true;
    return null;
  }

  const stopped = await walk();
  const found = [...items.values()];
  const projectsWhole = projectsDone && !short.has('sidebar') && !short.has('project');
  if (stopped !== null) {
    return { items: found, outcome: 'failed', reason: stopped.reason, projectsWhole, ...(stopped.retryAfterMs === null ? {} : { retryAfterMs: stopped.retryAfterMs }) };
  }
  const plural = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`;
  const reasons = [...problems];
  if (noId > 0) {
    reasons.push(`${plural(noId)} with no id`);
  }
  if (noUpdateTime > 0) {
    reasons.push(`${plural(noUpdateTime)} with an unreadable update_time`);
  }
  if (reasons.length === 0) {
    return { items: found, outcome: 'whole', reason: 'ok', projectsWhole };
  }
  return { items: found, outcome: 'partial', reason: reasons.join('; '), projectsWhole };
}
