// The content-free copy of a chat's message tree that a detail record keeps
// in metadata.mapping, so analysis written for the tree keeps working. It is
// what the extension's content processor built from the raw mapping before
// the spider built records, key for key, value for value: per node its id,
// parent and children; per message the author's role and name, its times,
// status, weight, end_turn, recipient and channel, the kind of its content
// (never the content), and the ten metadata keys below, which hold ids, model
// names and timings. Nothing else of a message is read. Values are copied as
// they come, falsy ones included, so it reads the tree with JavaScript's own
// property access, as the code it replaces did. Pure.

const KEPT_METADATA: ReadonlySet<string> = new Set([
  'model_slug', 'resolved_model_slug', 'message_type', 'finished_duration_sec',
  'reasoning_start_time', 'reasoning_end_time', 'thinking_effort',
  'request_id', 'working_turn_id', 'turn_exchange_id',
]);

// value?.[key], for a value of any type.
const get = (value: unknown, key: string): unknown => (value === null || value === undefined ? undefined : (value as Record<string, unknown>)[key]);

function keepMessage(message: unknown): Record<string, unknown> {
  const metadata = get(message, 'metadata') || {};
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(metadata as object)) {
    if (KEPT_METADATA.has(key)) {
      kept[key] = (metadata as Record<string, unknown>)[key];
    }
  }
  const author = get(message, 'author');
  return {
    author: { role: get(author, 'role') ?? null, name: get(author, 'name') ?? null },
    create_time: get(message, 'create_time') ?? null,
    update_time: get(message, 'update_time') ?? null,
    status: get(message, 'status') ?? null,
    weight: get(message, 'weight') ?? null,
    end_turn: get(message, 'end_turn') ?? null,
    recipient: get(message, 'recipient') ?? null,
    channel: get(message, 'channel') ?? null,
    content_type: get(get(message, 'content'), 'content_type') ?? null,
    metadata: kept,
  };
}

export function skeletonOf(mapping: unknown): Record<string, unknown> {
  const nodes = (mapping || {}) as Record<string, unknown>;
  const skeleton: Record<string, unknown> = {};
  for (const id of Object.keys(nodes)) {
    const node = nodes[id];
    if (!node) {
      skeleton[id] = node;
      continue;
    }
    const message = get(node, 'message');
    skeleton[id] = { id: get(node, 'id'), parent: get(node, 'parent'), children: get(node, 'children'), message: message ? keepMessage(message) : null };
  }
  return skeleton;
}
