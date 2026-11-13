// One crawl pass: the access token from the home page, the list walk, and a
// record for each chat in the crawl window that is not sent yet in the served
// mode. Summary mode sends the list item; detail mode reads the chat first.
// The requests, rex-spider's side, rex-core's store, the dispatch, the waits
// and the clock are handed in, so the pass runs under the unit tests as it
// does in the worker. It never throws: every outcome is a reason
// (reasons.mts), and it never logs text, an id or the token.
import { type DateString } from '@bric/rex-types/types';

import { type Answer, type Classification, type Client, RequestError, classify, retryAfterMs } from './client.mts';
import { HOME_URL, accessToken } from './home.mts';
import { uploadKeyId } from './keys.mts';
import { type CrawlWindow, type ListItem, type WalkResult, crawlDelayMs, uploadTime, walkLists } from './list.mts';
import { type Transmitted, dueState, resendSince } from './mode.mts';
import { TIMED_OUT, touch, withDeadline } from './pacing.mts';
import { type ReasonCode, type ReasonFields, type Stop, formatReason } from './reasons.mts';
import { type Hash, buildDetailRecord, buildSummaryRecord } from './record.mts';
import { type ChatGPTStore, type Mode } from './store.mts';

// The rex-spider calls the pass makes on the spider. The flags are the
// served config as of the last refresh, read where they apply: isEnabled
// before every request, the served mode before each chat. The crawl window
// and the upload keys go to rex-core, which never answers while its database
// is not open, so each such call has a deadline.
export interface PassFramework {
  isEnabled(): boolean;
  justSummarize(): boolean;
  continueAfterError(): boolean;
  fetchCrawlDelay(): number;
  crawlWindowStart(): Promise<number | null>;
  crawlWindowEnd(): Promise<number | null>;
  checkIfAlreadyTransmitted(identifier: string, updated: DateString): Promise<boolean>;
  logTransmitted(identifier: string, updated: DateString): Promise<void>;
}

export interface PassLimits {
  // The wait after records are dispatched before their keys are stamped. It
  // stands in for a signal rex-core's dispatchEvent does not give: when a
  // point is stored. The extension stores points a little over a second after
  // the last one, so 3 s leaves room for a batch. A worker that dies before
  // the stamps sends those records again rather than losing them.
  readonly settleMs: number;
  // Summary records dispatched before each settle wait.
  readonly batch: number;
  // The longest wait for the crawl window, an upload-key lookup or a stamp:
  // long enough that only storage that is not answering trips it.
  readonly storeMs: number;
  // The longest wait for one hash. rex-core's sha256 never settles when the
  // digest fails, and a record must not wait on it for good.
  readonly hashMs: number;
  // The reading time after which a pass reads no more details: the requests,
  // parsing and store calls of its detail reads, and not its paced waits,
  // which at the 30 s pace would end a pass after a dozen reads. It starts at
  // the first detail read, since every pass walks the whole list first, and a
  // heavy account's walk could otherwise spend it before any detail is read.
  // A first sweep runs as one pass; the chats it does not reach keep no key
  // and are read in a later pass.
  readonly detailBudgetMs: number;
}

export const PASS_LIMITS: PassLimits = { settleMs: 3000, batch: 25, storeMs: 20_000, hashMs: 1000, detailBudgetMs: 360_000 };

export interface PassDeps {
  // A client for chatgpt.com: with no token for the home page, then with the
  // token read from it.
  readonly client: (token?: string) => Pick<Client, 'get'>;
  readonly framework: PassFramework;
  // rex-core's store, for the mode record (mode.mts).
  readonly store: Pick<ChatGPTStore, 'mode'>;
  readonly dispatch: (record: Record<string, unknown>) => void;
  // Every wait of the pass, in chunks of at most 20 s with a keep-alive call
  // before each (pacing.mts).
  readonly sleep: (ms: number) => Promise<void>;
  // Made before each store call, which does not reset the worker's idle timer.
  readonly keepAlive: () => unknown;
  readonly hash: Hash;
  // The record builders (record.mts): the real ones unless a test hands in
  // others.
  readonly records?: Records;
  readonly limits?: PassLimits;
  readonly log?: (line: string) => void;
}

export interface Records {
  readonly summary: typeof buildSummaryRecord;
  readonly detail: typeof buildDetailRecord;
}

const RECORDS: Records = { summary: buildSummaryRecord, detail: buildDetailRecord };

export interface PassOutcome {
  // Records sent when the pass read the whole list, or -1 when it has no
  // whole reading of it: it read none, or only part. Readers of the completion
  // event take 0 or more to mean ids is the account's chats in the window, so
  // a list read in part would read as chats deleted. The reason still says
  // how many records a partial pass sent.
  readonly count: number;
  // The chats listed in the crawl window, in the walk's order; [] with -1.
  readonly ids: string[];
  readonly reason: string;
}

const DETAIL_URL = 'https://chatgpt.com/backend-api/conversation/';
export const detailUrl = (chatId: string): string => `${DETAIL_URL}${encodeURIComponent(chatId)}`;

// The store did not answer, or failed.
class StoreSilent extends Error {}
// enabled false was served during the list walk.
class SwitchedOff extends Error {}

type Stage = 'start' | 'home' | 'list';

interface Pass {
  readonly deps: PassDeps;
  readonly limits: PassLimits;
  readonly now: () => number;
  readonly say: (line: string) => void;
  readonly hash: Hash;
  readonly records: Records;
  // When the pass started, for the ms its reason ends with.
  readonly started: number;
  // Time spent in the paced waits, which the detail budget leaves out.
  waited: number;
  // Where a throw is reported, until the list is read.
  stage: Stage;
}

const nameOf = (error: unknown) => (error instanceof Error ? error.name : typeof error);

// A paced wait, measured on the clock rather than taken as the wait asked
// for, so a timer that fires late, or a clock change during the wait, does
// not count as reading either.
async function pace(pass: Pass, ms: number): Promise<void> {
  const from = pass.now();
  await pass.deps.sleep(ms);
  pass.waited += Math.max(0, pass.now() - from);
}

// The reading time since a mark: the time since, less the paced waits since.
interface Mark {
  readonly at: number;
  readonly waited: number;
}

const markOf = (pass: Pass): Mark => ({ at: pass.now(), waited: pass.waited });
const spentSince = (pass: Pass, mark: Mark): number => pass.now() - mark.at - (pass.waited - mark.waited);

// The pass's wall-clock time, for its reason.
function elapsed(pass: Pass): number {
  const ms = Math.round(pass.now() - pass.started);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
}

// One hash to its deadline. A hash that does not answer in time, or fails,
// rejects, and the record builders read a rejection as no hash.
function boundedHash(hash: Hash, ms: number): Hash {
  return async (text) => {
    const digest = await withDeadline(Promise.resolve().then(() => hash(text)), ms);
    if (digest === TIMED_OUT) {
      throw new Error('the hash did not answer');
    }
    return digest;
  };
}

// One rex-core call through rex-spider to its deadline, after a keep-alive
// call. One that gets no answer, or fails, rejects.
async function stored<T>(pass: Pass, call: () => Promise<T>): Promise<T> {
  touch(pass.deps.keepAlive, pass.say);
  let answer: T | typeof TIMED_OUT;
  try {
    answer = await withDeadline(Promise.resolve().then(call), pass.limits.storeMs);
  } catch {
    throw new StoreSilent();
  }
  if (answer === TIMED_OUT) {
    throw new StoreSilent();
  }
  return answer;
}

// The upload-key lookup: true or false as rex-core answers. One that gets no
// answer rejects, never answers false: false reads as never sent, and the
// chat would go out again.
const lookup = (pass: Pass): Transmitted => async (id, at) => (await stored(pass, () => pass.deps.framework.checkIfAlreadyTransmitted(id, at))) === true;

// Stamps a sent record's key and reads it back, since rex-spider's
// logTransmitted resolves whatever the store answers, a failed write
// included. A stamp that is not kept or gets no answer stops the sending for
// the pass: a record sent without its key goes out again in a later pass,
// and a store that fails would leave every record of the pass so.
async function stamp(pass: Pass, id: string, at: DateString): Promise<boolean> {
  try {
    await stored(pass, () => pass.deps.framework.logTransmitted(id, at));
    if (await lookup(pass)(id, at)) {
      return true;
    }
    pass.say('an upload key was not kept; the sending stops for this pass');
  } catch {
    pass.say('an upload key got no answer; the sending stops for this pass');
  }
  return false;
}

function dispatched(pass: Pass, record: Record<string, unknown>): boolean {
  try {
    pass.deps.dispatch(record);
    return true;
  } catch (error) {
    pass.say(`a record could not be dispatched (${nameOf(error)}); the sending stops for this pass`);
    return false;
  }
}

// Why the sending stops before the next chat, if it does: the spider was
// switched off, or the served mode is no longer the pass's. A chat already
// sent keeps the key of the mode it went out in, and the next pass sends in
// the mode served then.
function halted(pass: Pass, mode: Mode): Stop | null {
  const { framework } = pass.deps;
  if (!framework.isEnabled()) {
    return 'disabled';
  }
  if ((framework.justSummarize() ? 'summary' : 'detail') !== mode) {
    pass.say('another mode was served during the pass; a later pass sends the chats not sent');
    return 'mode';
  }
  return null;
}

interface Sending {
  readonly sent: number;
  readonly failed: number;
  readonly held: number;
  readonly stop: Stop | null;
  // When it stopped, the due chats a later pass sends: those not reached, and
  // those sent without their key, which go out again. Absent when it stopped
  // before it knew which chats were due.
  readonly left?: number;
}

// Summary mode: the records in batches, each batch's keys stamped after the
// settle wait that follows it. The builders hash the title and project ids,
// so each record is awaited before it is dispatched.
async function sendSummaries(pass: Pass, due: readonly ListItem[]): Promise<Sending> {
  let sent = 0;
  let stamped = 0;
  let stop: Stop | null = null;
  try {
    for (let start = 0; start < due.length && stop === null; start += pass.limits.batch) {
      const out: ListItem[] = [];
      for (const item of due.slice(start, start + pass.limits.batch)) {
        stop = halted(pass, 'summary');
        if (stop !== null) {
          break;
        }
        // A hash that hangs holds a record for the hash deadline, and a batch
        // of them would outlast the worker's idle limit with no call between.
        touch(pass.deps.keepAlive, pass.say);
        if (!dispatched(pass, await pass.records.summary(item, pass.hash))) {
          stop = 'internal';
          break;
        }
        out.push(item);
        sent += 1;
      }
      if (out.length > 0) {
        await pace(pass, pass.limits.settleMs);
        for (const item of out) {
          if (!(await stamp(pass, uploadKeyId(item.id, true), uploadTime(item)))) {
            stop = 'store';
            break;
          }
          stamped += 1;
        }
      }
    }
  } catch (error) {
    pass.say(`the summary records ended on an internal error (${nameOf(error)})`);
    stop = 'internal';
  }
  return { sent, failed: 0, held: 0, stop, ...(stop === null ? {} : { left: due.length - stamped }) };
}

type DetailRead =
  | { readonly kind: 'record'; readonly record: Record<string, unknown> }
  | { readonly kind: 'failed'; readonly why: Exclude<Classification, 'ok'> | 'timeout' | 'network' | 'unreadable'; readonly retryAfterMs: number | null };

// One chat's detail, as a record, or why it gave none. The log names the
// kind of failure and the status, never the answer's text.
async function readDetail(pass: Pass, client: Pick<Client, 'get'>, item: ListItem): Promise<DetailRead> {
  let answer: Answer;
  try {
    answer = await client.get(detailUrl(item.id));
  } catch (error) {
    const why = error instanceof RequestError ? error.kind : 'network';
    pass.say(`a detail read failed (${why})`);
    return { kind: 'failed', why, retryAfterMs: null };
  }
  const verdict = classify(answer);
  if (verdict === 'ok') {
    // classify has parsed the body as JSON, so the parse cannot throw. A
    // builder that throws on this detail fails this chat's read alone: were it
    // to end the pass, the chat would come first on every pass and the chats
    // behind it would never be read.
    let record: Record<string, unknown> | null;
    try {
      record = await pass.records.detail(JSON.parse(answer.text), item, pass.hash);
    } catch (error) {
      pass.say(`the record builder failed on a detail (${nameOf(error)})`);
      record = null;
    }
    if (record !== null) {
      return { kind: 'record', record };
    }
    pass.say('a detail could not be read into a record');
    return { kind: 'failed', why: 'unreadable', retryAfterMs: null };
  }
  pass.say(`a detail read failed (${verdict}, status ${answer.status})`);
  return { kind: 'failed', why: verdict, retryAfterMs: verdict === 'rate-limited' || verdict === 'challenge' ? retryAfterMs(answer, pass.now()) : null };
}

// What ends the reads at a failed one.
const STOP_OF: Readonly<Partial<Record<string, Stop>>> = { 'rate-limited': 'rate-limited', challenge: 'challenge', 'signed-out': 'not-signed-in' };

// Detail mode: each chat read in turn, crawl_delay apart and never closer
// than the settle wait, until the reads have spent the detail budget. A
// record's key is stamped after the wait before the next read, or after a
// settle wait at the end, so the record is stored before its key. A read
// that fails ends the reads, and its chat is read again in a later pass.
async function sendDetails(pass: Pass, client: Pick<Client, 'get'>, due: readonly ListItem[]): Promise<Sending> {
  const { framework } = pass.deps;
  let sent = 0;
  let stamped = 0;
  let failed = 0;
  let index = 0;
  let stop: Stop | null = null;
  let pending: { readonly id: string; readonly at: DateString } | null = null;
  const start = markOf(pass);
  try {
    for (; index < due.length; index += 1) {
      const item = due[index];
      if (spentSince(pass, start) >= pass.limits.detailBudgetMs) {
        pass.say('the detail budget is spent; the chats not read are read in a later pass');
        stop = 'budget';
        break;
      }
      await pace(pass, Math.max(crawlDelayMs(framework.fetchCrawlDelay()), pass.limits.settleMs));
      if (pending !== null) {
        const key = pending;
        pending = null;
        if (!(await stamp(pass, key.id, key.at))) {
          stop = 'store';
          break;
        }
        stamped += 1;
      }
      stop = halted(pass, 'detail');
      if (stop !== null) {
        break;
      }
      const read = await readDetail(pass, client, item);
      if (read.kind === 'record') {
        if (!dispatched(pass, read.record)) {
          stop = 'internal';
          break;
        }
        sent += 1;
        // The key's time is the list's, as the key was checked, never the
        // record's ended (its latest message), which would make the key new
        // on every pass.
        pending = { id: uploadKeyId(item.id, false), at: uploadTime(item) };
        continue;
      }
      failed += 1;
      stop = STOP_OF[read.why] ?? 'failed-reads';
      break;
    }
  } catch (error) {
    pass.say(`the detail reads ended on an internal error (${nameOf(error)})`);
    stop = 'internal';
  }
  if (pending !== null) {
    try {
      await pace(pass, pass.limits.settleMs);
      if (await stamp(pass, pending.id, pending.at)) {
        stamped += 1;
      } else {
        stop ??= 'store';
      }
    } catch (error) {
      pass.say(`the last upload key was not written (${nameOf(error)})`);
      stop ??= 'internal';
    }
  }
  return { sent, failed, held: 0, stop, ...(stop === null ? {} : { left: due.length - stamped }) };
}

// The chats due this pass, checked against the upload keys, then sent in the
// served mode, newest first so a pass cut short has sent the most recent.
async function sendAll(pass: Pass, client: Pick<Client, 'get'>, walk: WalkResult, served: Mode, since: number | null): Promise<Sending> {
  let held = 0;
  const due: ListItem[] = [];
  try {
    const transmitted = lookup(pass);
    for (const item of walk.items) {
      // An archived or starred chat may sit in a project the walk did not
      // finish, and its key be that path's (list.mts, projectsWhole), so it
      // waits for a pass that reads the projects whole.
      if (!walk.projectsWhole && (item.source === 'archived' || item.source === 'starred')) {
        held += 1;
        continue;
      }
      // The time is the one the key is built from on the item's list path.
      const need = await dueState(transmitted, item.id, uploadTime(item), served, since);
      if (need === 'due') {
        due.push(item);
      } else if (need === 'held') {
        held += 1;
      }
    }
  } catch (error) {
    pass.say(error instanceof StoreSilent ? 'an upload key got no answer; the sending stops for this pass' : `the upload keys could not be read (${nameOf(error)})`);
    return { sent: 0, failed: 0, held, stop: error instanceof StoreSilent ? 'store' : 'internal' };
  }
  if (held > 0) {
    pass.say(`${held} chats are held back for a later pass: archived or starred while the project lists were not read whole, or sent only in the other mode while the mode record could not be read`);
  }
  due.sort((a, b) => uploadTime(b).timestamp() - uploadTime(a).timestamp());
  const sending = served === 'summary' ? await sendSummaries(pass, due) : await sendDetails(pass, client, due);
  return { ...sending, held: sending.held + held };
}

// The pass with no reading of the list.
function none<C extends Exclude<ReasonCode, 'ok' | 'partial'>>(pass: Pass, code: C, fields: Omit<ReasonFields<C>, 'ms'>): PassOutcome {
  return { count: -1, ids: [], reason: formatReason(code, { ...fields, ms: elapsed(pass) } as unknown as ReasonFields<C>) };
}

const seconds = (ms: number | null | undefined): number | undefined => (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.ceil(ms / 1000) : undefined);

// The home page's answer: the token, or how the pass ends there.
async function readHome(pass: Pass): Promise<{ readonly token: string } | PassOutcome> {
  let home: Answer;
  try {
    home = await pass.deps.client().get(HOME_URL);
  } catch (error) {
    return none(pass, error instanceof RequestError && error.kind === 'timeout' ? 'timeout' : 'network', { stage: 'home' });
  }
  const verdict = classify(home);
  switch (verdict) {
    case 'rate-limited':
      return none(pass, 'rate-limited', { stage: 'home', status: home.status, 'retry-after': seconds(retryAfterMs(home, pass.now())) });
    case 'challenge':
      return none(pass, 'challenge', { stage: 'home', status: home.status });
    case 'signed-out':
      return none(pass, 'not-signed-in', { stage: 'home', status: home.status });
    case 'refused':
    case 'server':
      return none(pass, 'http-error', { stage: 'home', status: home.status });
    default: {
      // A page, so not JSON: what matters is whether it holds the token.
      const token = accessToken(home.text);
      if (token === null) {
        pass.say('the home page holds no access token; the user is not signed in');
        return none(pass, 'not-signed-in', { stage: 'home' });
      }
      return { token };
    }
  }
}

// A walk stopped by an answer the next request would meet too.
function walkFailed(pass: Pass, walk: WalkResult): PassOutcome {
  switch (walk.reason) {
    case 'rate-limited':
      return none(pass, 'rate-limited', { stage: 'list', 'retry-after': seconds(walk.retryAfterMs) });
    case 'challenge':
      return none(pass, 'challenge', { stage: 'list' });
    case 'signed-out':
      return none(pass, 'not-signed-in', { stage: 'list', status: 401 });
    default:
      return none(pass, 'internal', { stage: 'list' });
  }
}

async function crawlWindow(pass: Pass): Promise<CrawlWindow | null> {
  const { framework } = pass.deps;
  try {
    const [start, end] = await stored(pass, () => Promise.all([framework.crawlWindowStart(), framework.crawlWindowEnd()]));
    return { start, end };
  } catch {
    pass.say('the crawl window got no answer');
    return null;
  }
}

async function run(pass: Pass): Promise<PassOutcome> {
  const { deps } = pass;
  const { framework } = deps;
  // rex-spider checks enabled when it queues the crawl; the config may have
  // switched the spider off since.
  if (!framework.isEnabled()) {
    return none(pass, 'disabled', { stage: 'start' });
  }
  const served: Mode = framework.justSummarize() ? 'summary' : 'detail';
  // When this browser started running the served mode, written now if it
  // had not run it before (mode.mts). Taken before any request, so a pass
  // that finds the user signed out still dates a switch.
  const since = await resendSince({
    mode: {
      get: () => {
        touch(deps.keepAlive, pass.say);
        return deps.store.mode.get();
      },
      set: (record) => {
        touch(deps.keepAlive, pass.say);
        return deps.store.mode.set(record);
      },
    },
  }, served, pass.now());
  if (since === null) {
    pass.say('the mode record was not read or not written; chats sent only in the other mode wait for a later pass');
  }
  const window = await crawlWindow(pass);
  if (window === null) {
    return none(pass, 'store', {});
  }
  // The mode record's read and write and the window's lookup can each take up
  // to a store deadline, and a refresh in that time may have switched the
  // spider off, so enabled is read again just before the first request.
  if (!framework.isEnabled()) {
    return none(pass, 'disabled', { stage: 'start' });
  }
  pass.stage = 'home';
  const home = await readHome(pass);
  if (!('token' in home)) {
    return home;
  }
  pass.stage = 'list';
  const client = deps.client(home.token);
  // crawl_delay between every two requests of the pass, the home page's too.
  await pace(pass, crawlDelayMs(framework.fetchCrawlDelay()));
  if (!framework.isEnabled()) {
    return none(pass, 'disabled', { stage: 'list' });
  }
  let walk: WalkResult;
  try {
    // enabled is read again after each of the walk's waits, so a spider
    // switched off during the walk sends no request after it.
    walk = await walkLists(client, window, {
      crawlDelay: () => framework.fetchCrawlDelay(),
      sleep: async (ms) => {
        await pace(pass, ms);
        if (!framework.isEnabled()) {
          throw new SwitchedOff();
        }
      },
    }, { log: pass.say });
  } catch (error) {
    if (error instanceof SwitchedOff) {
      return none(pass, 'disabled', { stage: 'list' });
    }
    throw error;
  }
  if (walk.outcome === 'failed') {
    return walkFailed(pass, walk);
  }
  // A walk read only in part may hold no chat because the lists failed, not
  // because the account has none.
  if (walk.outcome === 'partial' && walk.items.length === 0) {
    return none(pass, 'list-failed', {});
  }
  const sending = await sendAll(pass, client, walk, served, since);
  const ids = walk.items.map((item) => item.id);
  const whole = walk.outcome === 'whole';
  const positive = (count: number) => (count > 0 ? count : undefined);
  return {
    count: whole ? sending.sent : -1,
    ids: whole ? ids : [],
    reason: formatReason(whole ? 'ok' : 'partial', {
      seen: ids.length,
      dispatched: sending.sent,
      failed: positive(sending.failed),
      held: positive(sending.held),
      left: sending.left,
      stop: sending.stop ?? undefined,
      ms: elapsed(pass),
    }),
  };
}

export async function runPass(deps: PassDeps, now: () => number): Promise<PassOutcome> {
  const log = deps.log ?? ((line: string) => console.log(`[rex-spider-chatgpt] ${line}`));
  // A log that throws has nowhere left to report to.
  const say = (line: string) => {
    try {
      log(line);
    } catch {
      // ignored
    }
  };
  let pass: Pass | null = null;
  try {
    const limits = deps.limits ?? PASS_LIMITS;
    pass = { deps, limits, now, say, hash: boundedHash(deps.hash, limits.hashMs), records: deps.records ?? RECORDS, started: now(), waited: 0, stage: 'start' };
    return await run(pass);
  } catch (error) {
    say(`the pass ended on an internal error (${nameOf(error)})`);
    try {
      if (pass !== null) {
        return none(pass, 'internal', { stage: pass.stage });
      }
    } catch {
      // A clock that throws: the literal below.
    }
    return { count: -1, ids: [], reason: 'internal stage=start ms=0' };
  }
}
