// The allow-list of the ChatGPT case (redact.mts): every key a format 1
// record may carry at each level, with the form its value is kept in. A form
// returns the value when it is in form, else null, or 'unrecognised' for a
// string outside a type name or a closed set, which carries nothing of the
// string. They are the forms the builders apply (record.mts, detail.mts,
// skeleton.mts, list.mts), applied again because the extension runs the case
// on whatever point names the platform. The extension carries a copy of this
// file and redact.mts, so it imports nothing but rex-types. Pure.
import { DateString } from '@bric/rex-types/types';

const UNRECOGNISED = 'unrecognised';

export const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

// An own key's value, or undefined: a key named like one of Object's own
// (constructor, toString) is never read through the prototype.
const ownField = (value: unknown, key: string): unknown => (isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined);

// Model slugs, roles, recipients, channels, content types, memory scopes and
// gizmo types: lowercase letters, digits, _, . and -, at most 64 characters.
const TYPE_NAME = /^[a-z0-9_.-]{1,64}$/;
const asTypeName = (value: unknown): string | null => (typeof value !== 'string' ? null : TYPE_NAME.test(value) ? value : UNRECOGNISED);
// A turn's status: the two values the capture saw.
const STATUSES: ReadonlySet<string> = new Set(['finished_successfully', 'in_progress']);
const asTurnStatus = (value: unknown): string | null => (typeof value !== 'string' ? null : STATUSES.has(value) ? value : UNRECOGNISED);

const asFlag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
// ChatGPT says null, never false, for a chat that is not starred.
const asStarred = (value: unknown): true | null => (value === true ? true : null);
const asCount = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const asFinite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// Epoch seconds from 2001 to 2286, the form a detail writes times in, so a
// time in milliseconds is not taken for one some 50,000 years ahead.
export const asSeconds = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 1e9 && value < 1e10 ? value : null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const asUuid = (value: unknown): string | null => (typeof value === 'string' && UUID.test(value) ? value : null);
// The one id rule of the tree, for mapping keys, the links between nodes,
// current_node and a turn's identifier and parent: a UUID, as every message
// id the capture saw, or client-created-root, the root a browser makes. Only
// the case applies it to keys and turns; the parser keeps ids as sent, so
// its 512 KB bound on the turns still counts a long one.
const asNodeId = (value: unknown): string | null => (value === 'client-created-root' ? value : asUuid(value));

const SHA256_HEX = /^[0-9a-f]{64}$/;
const asHash = (value: unknown): string | null => (typeof value === 'string' && SHA256_HEX.test(value) ? value : null);

// Temporal.Instant, taken from a DateString's value so it is the copy
// DateString reads with. Its from() throws on a string that names no instant
// (a 13th month, hour 24), which DateString would print.
const INSTANT = (new DateString('1970-01-01T00:00:00Z').value as object).constructor as unknown as { from(item: string): object };
export const INSTANT_TO_STRING = (INSTANT as unknown as { prototype: { toString(): string } }).prototype.toString;

// The instant a string names, as Temporal writes it, or null.
function instantText(value: string): string | null {
  try {
    return Reflect.apply(INSTANT_TO_STRING, INSTANT.from(value), []);
  } catch {
    return null;
  }
}

// A time as a list sends it: an ISO 8601 instant with Z or an offset, kept as
// it came.
const LIST_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)$/;
export const asListTime = (value: unknown): string | null => (typeof value === 'string' && LIST_TIME.test(value) && instantText(value) !== null ? value : null);
// A turn's when, as DateString writes an instant: UTC, Z, no trailing zero.
const asUtcTime = (value: unknown): string | null => (typeof value === 'string' && instantText(value) === value ? value : null);

// Every key of the table, in its order, each from the value's own key of
// that name in its form; null where the value has none.
export function keepAll(table: Readonly<Record<string, (value: unknown) => unknown>>, value: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(table).map(([key, form]) => [key, form(ownField(value, key))]));
}

// Only the table's keys the value has, in the value's order.
function keepPresent(table: Readonly<Record<string, (value: unknown) => unknown>>, value: unknown): Record<string, unknown> {
  return isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(table, key)).map(([key, held]) => [key, table[key](held)])) : {};
}

// A message's metadata as the skeleton keeps it: these keys only where the
// message had them, which hold ids, model names and timings.
const MESSAGE_METADATA = {
  model_slug: asTypeName, resolved_model_slug: asTypeName, message_type: asTypeName, thinking_effort: asTypeName, finished_duration_sec: asFinite,
  reasoning_start_time: asFinite, reasoning_end_time: asFinite, request_id: asUuid, working_turn_id: asUuid, turn_exchange_id: asUuid,
};
const AUTHOR = { role: asTypeName, name: asTypeName };
// The skeleton's status is a type name, so a lowercase server value the
// turn's closed set does not hold stays as the server wrote it.
const MESSAGE = {
  author: (value: unknown) => keepAll(AUTHOR, value), create_time: asFinite, update_time: asFinite, status: asTypeName, weight: asFinite, end_turn: asFlag,
  recipient: asTypeName, channel: asTypeName, content_type: asTypeName, metadata: (value: unknown) => keepPresent(MESSAGE_METADATA, value),
};
const NODE = {
  id: asNodeId,
  parent: asNodeId,
  children: (value: unknown) => (Array.isArray(value) ? Array.from(value, asNodeId) : null),
  message: (value: unknown) => (isObject(value) ? keepAll(MESSAGE, value) : null),
};

// The skeleton: each node under its key. A key that is no node id is dropped
// with its node, since a key cannot be null and could hold any text; a link
// naming it fails the same rule and reads null.
const keepMapping = (value: unknown): Record<string, unknown> => (isObject(value)
  ? Object.fromEntries(Object.entries(value).filter(([key]) => asNodeId(key) !== null).map(([key, node]) => [key, isObject(node) ? keepAll(NODE, node) : null]))
  : {});

export const SUMMARY_METADATA = {
  create_time: asListTime, update_time: asListTime, is_archived: asFlag, is_starred: asStarred, pinned_time: asListTime, is_temporary_chat: asFlag,
  is_do_not_remember: asFlag, memory_scope: asTypeName, async_status: asTypeName, title_hash: asHash, gizmo_id_hash: asHash, conversation_template_id_hash: asHash,
};
// redact.mts keeps current_node only when it names a node of the kept mapping.
export const DETAIL_METADATA = {
  conversation_id: asUuid, create_time: asSeconds, update_time: asSeconds, default_model_slug: asTypeName, is_archived: asFlag, is_starred: asStarred,
  pinned_time: asSeconds, is_temporary_chat: asFlag, is_do_not_remember: asFlag, memory_scope: asTypeName, is_study_mode: asFlag, current_node: asNodeId,
  gizmo_type: asTypeName, title_hash: asHash, gizmo_id_hash: asHash, conversation_template_id_hash: asHash, mapping: keepMapping,
};

// A turn's keys in the standard's order, then ChatGPT's extras. A speaker
// out of the two, or a reply that folds no message, reads null here, and
// redact.mts takes the record for one the builders did not make.
export const TURN = {
  identifier: asNodeId, parent: asNodeId, speaker: (value: unknown) => (value === 'user' || value === 'assistant' ? value : null), when: asUtcTime,
  on_current_branch: asFlag, text_chars: asCount, text_words: asCount, citation_count: asCount, search_result_count: asCount, attachments: asCount,
  content_type: asTypeName, status: asTurnStatus,
};
export const REPLY = { model_slug: asTypeName, nodes: (value: unknown) => (asCount(value) === null || value === 0 ? null : value) };
