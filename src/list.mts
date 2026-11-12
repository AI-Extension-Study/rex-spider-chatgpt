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

// A conversation list whose pages bring no chat it had not given, this many
// in a row, is cut: its paging is not moving on. One such page can be
// ordinary (chats that move up between two calls shift a page), so it takes
// three.
export const STALE_PAGES = 3;

// The spider's own default, used when the served crawl_delay is unreadable:
// a broken value must not become no pacing.
export const DEFAULT_CRAWL_DELAY_MS = 30_000;

export type Source = 'main' | 'archived' | 'starred' | 'project';

export interface ListItem {
  readonly id: string;
  // The list's title as sent. Hashed before anything leaves the spider.
  readonly title: string | null;
  // The list's create_time, in epoch seconds with millisecond precision
  // (Date.parse(create_time) / 1000), null when absent or unreadable.
  readonly createSec: number | null;
  // The list's update_time, read from its ISO string with its microseconds.
  // uploadTime is what the upload key uses.
  readonly updated: DateString;
  // The first list the chat was seen on: main, archived, starred, project.
  readonly source: Source;
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
  // Each chat in the crawl window once, main list first, then archived, then
  // starred, then the projects, each list newest first.
  readonly items: ListItem[];
  // whole: every list was read to its end. partial: something went wrong, and
  // there are chats. failed: something went wrong and there are none, which is
  // not an empty account.
  readonly outcome: WalkOutcome;
  // 'ok' for a whole walk. Otherwise the first thing that went wrong, and a
  // failure that stopped the walk beats a list that was only cut: the
  // classification of the answer that stopped it (signed-out, refused,
  // rate-limited, challenge, server, not-json), timeout, network, bad-page,
  // request-limit; or, for a walk that went on, unreadable-item, page-limit,
  // not-moving.
  readonly reason: string;
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

// A chat is read only with an id and an update_time Date.parse and the
// instant parser both read; anything else is skipped and counted, so the walk
// says it was partial, and not guessed at. The date is checked before
// DateString sees it because DateString logs what it cannot read.
function readItem(raw: unknown, source: Source): ListItem | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const { id, title, create_time: created, update_time: updatedAt } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
    return null;
  }
  const updated = new DateString(updatedAt);
  if (updated.value === null) {
    return null;
  }
  const createdMs = typeof created === 'string' ? Date.parse(created) : Number.NaN;
  return { id, title: typeof title === 'string' ? title : null, createSec: Number.isNaN(createdMs) ? null : createdMs / 1000, updated, source };
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
// numeric string is read as it is (0 too); anything else is the default.
function delayOf(pace: Pace): number {
  const given: unknown = pace.crawlDelay();
  const ms = typeof given === 'number' ? given : typeof given === 'string' && given.trim() !== '' ? Number(given) : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_CRAWL_DELAY_MS;
}

interface Failure {
  readonly reason: string;
  readonly retryAfterMs: number | null;
}

type Read = { readonly body: Record<string, unknown> } | { readonly failure: Failure };

const failure = (reason: string, retryAfter: number | null = null): { failure: Failure } => ({ failure: { reason, retryAfterMs: retryAfter } });

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
  // The first reason a list was read only in part, when the walk went on.
  let cutReason: string | null = null;
  const cut = (reason: string, what: string) => {
    cutReason ??= reason;
    say(`the ${what} list was read only in part (${reason})`);
  };
  const skipped = (count: number, what: string) => {
    if (count > 0) {
      cutReason ??= 'unreadable-item';
      say(`skipped ${count} entries of the ${what} list with no usable id or update_time`);
    }
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

  // Keeps a chat that is in the window, the first time it is seen, and says
  // whether it was in the window.
  const keep = (item: ListItem): boolean => {
    if (!inWindow(window, item.updated.timestamp())) {
      return false;
    }
    if (!items.has(item.id)) {
      items.set(item.id, item);
    }
    return true;
  };

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
        say(`the ${source} list stopped at page ${pages + 1} (${got.failure.reason})`);
        return got.failure;
      }
      const list = got.body.items;
      if (!Array.isArray(list)) {
        say(`the ${source} list answered a page with no list of chats`);
        return { reason: 'bad-page', retryAfterMs: null };
      }
      if (list.length === 0) {
        return null;
      }
      let inside = 0;
      let fresh = 0;
      let unreadable = 0;
      for (const raw of list) {
        const item = readItem(raw, source);
        if (item === null) {
          unreadable += 1;
          continue;
        }
        if (!seen.has(item.id)) {
          seen.add(item.id);
          fresh += 1;
        }
        if (keep(item)) {
          inside += 1;
        }
      }
      skipped(unreadable, source);
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
  // gizmos are the account's own GPTs and are no project.
  async function walkSidebar(): Promise<Failure | string[]> {
    const projects: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pages = 0; ; pages += 1) {
      if (pages >= maxPages) {
        cut('page-limit', 'sidebar');
        return projects;
      }
      const got = await read(sidebarUrl(cursor));
      if ('failure' in got) {
        say(`the sidebar stopped at page ${pages + 1} (${got.failure.reason})`);
        return got.failure;
      }
      const list = got.body.items;
      if (!Array.isArray(list)) {
        say('the sidebar answered a page with no list of gizmos');
        return { reason: 'bad-page', retryAfterMs: null };
      }
      for (const entry of list) {
        const id = field(field(field(entry, 'gizmo'), 'gizmo'), 'id');
        if (typeof id === 'string' && id.startsWith('g-p-') && !projects.includes(id)) {
          projects.push(id);
        }
      }
      const next = nextCursor(got.body.cursor);
      if (next === undefined) {
        return { reason: 'bad-page', retryAfterMs: null };
      }
      if (next === null) {
        return projects;
      }
      if (cursors.has(next)) {
        cut('not-moving', 'sidebar');
        return projects;
      }
      cursors.add(next);
      cursor = next;
    }
  }

  // A project's chats, by cursor from 0, until the cursor is null or missing or
  // a page has no items. The window does not stop it, as before. It is a
  // safety net: the capture found every project chat on the main list too.
  async function walkProject(projectId: string): Promise<Failure | null> {
    const cursors = new Set<string>();
    let cursor = '0';
    for (let pages = 0; ; pages += 1) {
      if (pages >= maxPages) {
        cut('page-limit', 'project');
        return null;
      }
      cursors.add(cursor);
      const got = await read(projectUrl(projectId, cursor));
      if ('failure' in got) {
        say(`a project list stopped at page ${pages + 1} (${got.failure.reason})`);
        return got.failure;
      }
      const list = got.body.items;
      if (!Array.isArray(list)) {
        say('a project list answered a page with no list of chats');
        return { reason: 'bad-page', retryAfterMs: null };
      }
      if (list.length === 0) {
        return null;
      }
      let unreadable = 0;
      for (const raw of list) {
        const item = readItem(raw, 'project');
        if (item === null) {
          unreadable += 1;
        } else {
          keep(item);
        }
      }
      skipped(unreadable, 'project');
      const next = nextCursor(got.body.cursor);
      if (next === undefined) {
        return { reason: 'bad-page', retryAfterMs: null };
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
    const projects = await walkSidebar();
    if (!Array.isArray(projects)) {
      return projects;
    }
    for (const projectId of projects) {
      const stopped = await walkProject(projectId);
      if (stopped !== null) {
        return stopped;
      }
    }
    return null;
  }

  const stopped = await walk();
  const found = [...items.values()];
  const reason = stopped?.reason ?? cutReason;
  if (reason === null) {
    return { items: found, outcome: 'whole', reason: 'ok' };
  }
  const wait = stopped?.retryAfterMs ?? null;
  return { items: found, outcome: found.length > 0 ? 'partial' : 'failed', reason, ...(wait === null ? {} : { retryAfterMs: wait }) };
}
