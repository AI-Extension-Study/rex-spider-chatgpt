// The content-free copy of a chat's message tree that a detail record keeps
// in metadata.mapping, so analysis written for the tree keeps working. It
// keeps the keys the extension's content processor kept: per node its id,
// parent and children; per message the author's role and name, its times,
// status, weight, end_turn, recipient and channel, the kind of its content
// (never the content), and the ten metadata keys below, which hold ids, model
// names and timings. Each value is held to the form the capture of 2026-11-12
// saw for it, so a value in its form is copied unchanged and nothing else,
// text included, reaches the record: a type name of another form becomes
// 'unrecognised', and an id, a time or a flag of another form, or a value of
// another type, null. A node or a message that is not an object is null.
// The status is a type name here, so a server status the turn's closed set
// does not hold (finished_partial_completion, say) stays as it came. Pure.
import { field, flag, isObject, typeName } from './forms.mts';

// The capture saw a UUID in every message id, parent and child, and in every
// request_id, turn_exchange_id and working_turn_id; the root a browser makes
// is client-created-root.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value: unknown): string | null => (typeof value === 'string' && UUID.test(value) ? value : null);
const nodeIdOrNull = (value: unknown): string | null => (value === 'client-created-root' ? value : uuidOrNull(value));
const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// The message metadata kept, each key with its form.
const KEPT_METADATA: ReadonlyMap<string, (value: unknown) => unknown> = new Map<string, (value: unknown) => unknown>([
  ['model_slug', typeName],
  ['resolved_model_slug', typeName],
  ['message_type', typeName],
  ['thinking_effort', typeName],
  ['finished_duration_sec', finiteOrNull],
  ['reasoning_start_time', finiteOrNull],
  ['reasoning_end_time', finiteOrNull],
  ['request_id', uuidOrNull],
  ['working_turn_id', uuidOrNull],
  ['turn_exchange_id', uuidOrNull],
]);

function keepMessage(message: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const metadata = field(message, 'metadata');
  const kept: Record<string, unknown> = {};
  if (isObject(metadata)) {
    for (const [key, value] of Object.entries(metadata)) {
      const form = KEPT_METADATA.get(key);
      if (form !== undefined) {
        kept[key] = form(value);
      }
    }
  }
  const author = field(message, 'author');
  return {
    author: { role: typeName(field(author, 'role')), name: typeName(field(author, 'name')) },
    create_time: finiteOrNull(field(message, 'create_time')),
    update_time: finiteOrNull(field(message, 'update_time')),
    status: typeName(field(message, 'status')),
    weight: finiteOrNull(field(message, 'weight')),
    end_turn: flag(field(message, 'end_turn')),
    recipient: typeName(field(message, 'recipient')),
    channel: typeName(field(message, 'channel')),
    content_type: typeName(field(field(message, 'content'), 'content_type')),
    metadata: kept,
  };
}

function keepNode(node: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const children = field(node, 'children');
  const message = field(node, 'message');
  return {
    id: nodeIdOrNull(field(node, 'id')),
    parent: nodeIdOrNull(field(node, 'parent')),
    children: Array.isArray(children) ? children.map(nodeIdOrNull) : null,
    message: isObject(message) ? keepMessage(message) : null,
  };
}

export function skeletonOf(mapping: unknown): Record<string, unknown> {
  const skeleton: Record<string, unknown> = {};
  if (!isObject(mapping)) {
    return skeleton;
  }
  for (const [id, node] of Object.entries(mapping)) {
    skeleton[id] = isObject(node) ? keepNode(node) : null;
  }
  return skeleton;
}
