// The rex-account record (format 1): the account's plan and settings, read
// from four GETs, and the rules that say when to read them and when to send
// the record. Every key of the shared account layout is on every record; a
// key is null when its source did not answer 200 with an object, the site
// holds no such key, or the value has the wrong form. Nothing in the record
// is an id, a name or text the person wrote: each key is a boolean, a count,
// an instant, or a string held to a short enum form. metadata keeps only the
// keys listed here, and leaves a key out when its value has the wrong form.
// Pure but for the hash.
import { DateString } from '@bric/rex-types/types';

import { FORMAT_VERSION, type Hash, hashOf } from './record.mts';

const NAME = 'rex-account';
const PLATFORM = 'chatgpt';

// The four reads, in the order they are made. /backend-api/me is never read:
// it holds the email, the name and the phone number, and nothing on it is
// needed.
export const ACCOUNT_SOURCES = [
  ['user_system_messages', 'https://chatgpt.com/backend-api/user_system_messages'],
  ['accounts_check', 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'],
  ['settings_user', 'https://chatgpt.com/backend-api/settings/user'],
  ['memories', 'https://chatgpt.com/backend-api/memories'],
] as const;

export type AccountSource = (typeof ACCOUNT_SOURCES)[number][0];

// What a read gave: its HTTP status, -1 for none, and its parsed body.
export interface AccountAnswer {
  readonly status: number;
  readonly body: unknown;
}

export type Workspace = 'personal' | 'team' | 'enterprise' | 'edu';
export type AccountMetadataValue = boolean | number | string | null;

export interface AccountRecord {
  readonly name: typeof NAME;
  readonly platform: typeof PLATFORM;
  readonly format_version: number;
  // Epoch ms of the read.
  readonly date: number;
  readonly plan: string | null;
  readonly paid: boolean | null;
  readonly workspace: Workspace | null;
  readonly web_search_enabled: boolean | null;
  readonly training_allowed: boolean | null;
  // Not a setting on this site: always null.
  readonly history_saved: null;
  readonly memory_enabled: boolean | null;
  readonly custom_instructions_set: boolean | null;
  readonly account_created: string | null;
  readonly source_status: Readonly<Record<string, number>>;
  readonly metadata: Readonly<Record<string, AccountMetadataValue>>;
}

// --- When to read, and when to send ---

export interface AccountSettings {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
}

const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 24 * 60;
// A stored read or send time further ahead than this was written by a clock
// that has since gone back. Honoured, it would hold off every read, or the
// daily send, until the clock caught up.
const CLOCK_SLACK_MS = 5 * 60_000;
// A record goes out at least once a day, so a day with none means the read
// failed, not that nothing changed.
const RESEND_MS = 24 * 60 * 60_000;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

// An own key of an object, or undefined for anything else, so a key named
// like one of Object's own is never read through the prototype.
const field = (value: unknown, key: string): unknown => (isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined);
const fieldAt = (value: unknown, ...keys: readonly string[]): unknown => keys.reduce((inner, key) => field(inner, key), value);

const isInterval = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= MIN_INTERVAL_MINUTES && (value as number) <= MAX_INTERVAL_MINUTES;

// The served account block, as rex-spider merged it: on only for enabled:
// true. The interval is read whether or not the read is on.
export function accountSettings(block: unknown): AccountSettings {
  const interval = field(block, 'interval_minutes');
  return { enabled: field(block, 'enabled') === true, intervalMinutes: isInterval(interval) ? interval : DEFAULT_INTERVAL_MINUTES };
}

// What the store keeps between passes: the hash of the last record sent, when
// it was sent, and when the sources were last read (epoch ms).
export interface AccountState {
  readonly hash: string;
  readonly sentAt: number;
  readonly readAt: number;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// What the store trusts of what it reads back: rex-core returns whatever was
// written, by any build, so a value of another form counts as none. Any
// string is a hash, the empty one included, so a state stored before
// anything was sent still holds its read time.
export function isAccountState(value: unknown): value is AccountState {
  return typeof field(value, 'hash') === 'string' && isTime(field(value, 'sentAt')) && isTime(field(value, 'readAt'));
}

export function accountDue(state: AccountState | null, now: number, intervalMinutes: number): boolean {
  if (state === null) {
    return true;
  }
  const sinceMs = now - state.readAt;
  if (sinceMs < -CLOCK_SLACK_MS) {
    return true;
  }
  const interval = isInterval(intervalMinutes) ? intervalMinutes : DEFAULT_INTERVAL_MINUTES;
  return sinceMs >= interval * 60_000;
}

export function shouldSend(state: AccountState | null, hash: string, now: number): boolean {
  if (state === null || state.hash !== hash) {
    return true;
  }
  const sinceMs = now - state.sentAt;
  return sinceMs < -CLOCK_SLACK_MS || sinceMs >= RESEND_MS;
}

// --- The hash ---

// JSON with the keys of every object sorted, so the hash does not depend on
// the order the builder or the site wrote them in.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// Web Crypto's SHA-256 in lowercase hex: a global in the service worker and
// in Node.
const sha256: Hash = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

// The hash a record is compared by: SHA-256 of the record without date, so
// two reads with the same values have the same hash. It is only stored, never
// sent. Throws when the digest fails, which the caller's catch takes as a
// failed read.
export async function accountHash(record: AccountRecord): Promise<string> {
  const content: Record<string, unknown> = { ...record };
  delete content.date;
  const digest = await hashOf(canonical(content), sha256);
  if (digest === null) {
    throw new Error('the account hash failed');
  }
  return digest;
}

// --- The record ---

const NO_ANSWER = -1;

// A source's answer. Answers that are no map (null, a list) hold none.
const answerOf = (answers: Readonly<Record<string, AccountAnswer>>, source: string): AccountAnswer | undefined => (isObject(answers) && Object.hasOwn(answers, source) ? answers[source] : undefined);

// An HTTP status, or -1 for anything else (no answer, a timeout, a status a
// fetch never gives).
function statusOf(answer: AccountAnswer | undefined): number {
  const status = field(answer, 'status');
  return Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? (status as number) : NO_ANSWER;
}

// A source's body when it answered 200 with a JSON object, else undefined:
// a challenge page, an error body or a body of another form gives none.
function bodyOf(answers: Readonly<Record<string, AccountAnswer>>, source: AccountSource): Readonly<Record<string, unknown>> | undefined {
  const answer = answerOf(answers, source);
  const body = field(answer, 'body');
  return statusOf(answer) === 200 && isObject(body) ? body : undefined;
}

// Whether any source gave an answer to build from. With none, nothing is
// sent.
export function hasUsableAnswer(answers: Readonly<Record<string, AccountAnswer>>): boolean {
  return ACCOUNT_SOURCES.some(([source]) => bodyOf(answers, source) !== undefined);
}

// The site's plan value: lowercase letters, digits, _, ., - and space, at
// most 40 characters. A model slug, the same without _ or space, and never
// starting g-: the last model used can be a custom GPT, whose id (g- and 9
// characters) has too few hex digits in a row for the id check below.
// Neither may hold an id, which both forms would let through: a run like a
// UUID's first three groups, or 12 hex digits in a row.
const PLAN_FORM = /^[a-z0-9][a-z0-9_. -]{0,39}$/;
const MODEL_FORM = /^(?!g-)[a-z0-9][a-z0-9.-]{0,39}$/;
const ID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{12,}/i;
const WORKSPACE_PLANS: ReadonlySet<string> = new Set(['team', 'enterprise', 'edu']);
const MAX_COUNT = 1e6;

const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const formed = (value: unknown, form: RegExp): string | null => (typeof value === 'string' && form.test(value) && !ID_LIKE.test(value) ? value : null);

// An ISO 8601 instant: a date, a time, and Z or an offset. Checked by shape,
// then by Temporal, which refuses a shape that names no instant (30
// February, hour 24); DateString is not used to check, since it logs the
// value it cannot read.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)$/;
// The one form a time is sent in: UTC, Z, and a four-digit year.
const SENT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// Temporal.Instant, taken from a DateString's value so it is the copy
// rex-types reads with.
const INSTANT = (new DateString('1970-01-01T00:00:00Z').value as object).constructor as unknown as { from(item: string): { toString(): string } };

// The instant written in UTC with Z, as Temporal writes it, so every record
// writes a time the same way whatever offset the site used. Null for
// anything else, and for an offset that carries the year past 9999, which
// Temporal writes +010000-...
function utcInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) {
    return null;
  }
  try {
    const utc = INSTANT.from(value).toString();
    return SENT_INSTANT.test(utc) ? utc : null;
  } catch {
    return null;
  }
}

// The account the record describes: the first entry of accounts_check's
// accounts not under default (default repeats one of the others).
function accountEntry(body: unknown): unknown {
  const accounts = field(body, 'accounts');
  if (!isObject(accounts)) {
    return undefined;
  }
  const key = Object.keys(accounts).find((name) => name !== 'default');
  return key === undefined ? undefined : accounts[key];
}

// personal for a personal account; for a workspace, its plan when that is a
// workspace plan.
function workspaceOf(account: unknown): Workspace | null {
  const structure = field(account, 'structure');
  if (structure === 'personal') {
    return 'personal';
  }
  const plan = field(account, 'plan_type');
  return structure === 'workspace' && typeof plan === 'string' && WORKSPACE_PLANS.has(plan) ? (plan as Workspace) : null;
}

// name_user_message is a nickname and does not count.
const INSTRUCTION_KEYS = ['about_user_message', 'about_model_message', 'traits_model_message', 'other_user_message'] as const;

// false when custom instructions are switched off; else whether any of the
// four texts is written. Unknown when one is missing and none is written,
// since the missing one could be.
function instructionsSet(body: Readonly<Record<string, unknown>> | undefined): boolean | null {
  if (body === undefined) {
    return null;
  }
  if (field(body, 'enabled') === false) {
    return false;
  }
  const texts = INSTRUCTION_KEYS.map((key) => field(body, key));
  if (texts.some((text) => typeof text === 'string' && text !== '')) {
    return true;
  }
  return texts.every((text) => typeof text === 'string') ? false : null;
}

function webSearch(body: Readonly<Record<string, unknown>> | undefined): boolean | null {
  const tools = field(body, 'disabled_tools');
  return Array.isArray(tools) ? !tools.includes('browser') : null;
}

// metadata's forms. undefined leaves the key out. A time may be null: the
// site writes null for no date (renews_at on an account that does not renew).
const asFlag = (value: unknown): boolean | undefined => flag(value) ?? undefined;
const asModel = (value: unknown): string | undefined => formed(value, MODEL_FORM) ?? undefined;
const asCount = (value: unknown): number | undefined => (Array.isArray(value) && value.length <= MAX_COUNT ? value.length : undefined);
const asTime = (value: unknown): string | null | undefined => (value === null ? null : utcInstant(value) ?? undefined);

export function buildChatGPTAccount(answers: Readonly<Record<string, AccountAnswer>>, now: number): AccountRecord {
  const system = bodyOf(answers, 'user_system_messages');
  const entry = accountEntry(bodyOf(answers, 'accounts_check'));
  const account = field(entry, 'account');
  const entitlement = field(entry, 'entitlement');
  const settings = field(bodyOf(answers, 'settings_user'), 'settings');
  const memories = bodyOf(answers, 'memories');

  const sourceStatus: Record<string, number> = {};
  for (const [source] of ACCOUNT_SOURCES) {
    sourceStatus[source] = statusOf(answerOf(answers, source));
  }

  const metadata: Record<string, AccountMetadataValue> = {};
  const keep = (key: string, value: AccountMetadataValue | undefined): void => {
    if (value !== undefined) {
      metadata[key] = value;
    }
  };
  keep('hive_referenced_in_internal_knowledge', asFlag(field(settings, 'hive_referenced_in_internal_knowledge')));
  keep('connector_search_enabled', asFlag(field(settings, 'connector_search_enabled')));
  keep('free_ads_opt_out', asFlag(field(settings, 'free_ads_opt_out')));
  keep('last_used_model', asModel(fieldAt(settings, 'last_used_model_config', 'slugs', 'web')));
  keep('memories', asCount(field(memories, 'memories')));
  keep('is_trial', asFlag(field(account, 'is_trial')));
  keep('cancels_at', asTime(field(entitlement, 'cancels_at')));
  keep('renews_at', asTime(field(entitlement, 'renews_at')));
  keep('will_renew', asFlag(fieldAt(entry, 'last_active_subscription', 'will_renew')));

  return {
    name: NAME,
    platform: PLATFORM,
    format_version: FORMAT_VERSION,
    date: now,
    plan: formed(field(account, 'plan_type'), PLAN_FORM),
    paid: flag(field(entitlement, 'has_active_subscription')),
    workspace: workspaceOf(account),
    web_search_enabled: webSearch(system),
    training_allowed: flag(field(settings, 'training_allowed')),
    history_saved: null,
    memory_enabled: flag(field(settings, 'm3m')),
    custom_instructions_set: instructionsSet(system),
    account_created: utcInstant(field(account, 'created_time')),
    source_status: sourceStatus,
    metadata,
  };
}
