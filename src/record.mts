// The rex-conversation records the spider sends, in the shared conversation
// record layout (format 1): a summary record from a list item, and a detail
// record from a chat's detail and its list item. Nothing in them is text from
// a chat or its list: a detail record's turns hold counts, its metadata the
// conversation's content-free keys and the content-free skeleton of its
// tree, and the title and the project ids go out as SHA-256 hashes made with
// the hash handed in. The builders read no configuration and say nothing of
// the account as a whole: summary or detail is the caller's choice. Pure but
// for the hash.
import { type DateString } from '@bric/rex-types/types';

import { parseDetail } from './detail.mts';
import { field, flag, instantOf, isObject, isPlausibleSeconds, secondsOrNull, typeName } from './forms.mts';
import { type ListItem, uploadTime } from './list.mts';

export const FORMAT_VERSION = 1;

const NAME = 'rex-conversation';
const PLATFORM = 'chatgpt';

// A string's SHA-256 as lowercase hex: in the spider, rex-core's sha256, the
// hash the extension's content processor gave a title.
export type Hash = (text: string) => Promise<string>;

const SHA256_HEX = /^[0-9a-f]{64}$/;

// The hash of a non-empty string, or null: for anything else, and when the
// hash fails or answers with anything but a SHA-256 in lowercase hex, so a
// hash wired wrong can never send the value itself.
async function hashOf(value: unknown, hash: Hash): Promise<string | null> {
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  try {
    const digest = await hash(value);
    return typeof digest === 'string' && SHA256_HEX.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

// A summary record. Its ended, and date in epoch ms, are the time the upload
// key is built from on the item's list path (list.mts, uploadTime), so a chat
// only a project lists keeps that path's value, 1 ms early, as it always
// had; started is the list's create_time as each path has always read it.
// metadata is the list's allow-listed keys, each in its form (ListItem.meta),
// and the hashes of the title and the project's ids.
export async function buildSummaryRecord(item: ListItem, hash: Hash): Promise<Record<string, unknown>> {
  const ended = uploadTime(item);
  const [titleHash, gizmoIdHash, templateIdHash] = await Promise.all([hashOf(item.title, hash), hashOf(item.gizmoId, hash), hashOf(item.templateId, hash)]);
  const { create_time, update_time, is_archived, is_starred, pinned_time, is_temporary_chat, is_do_not_remember, memory_scope, async_status } = item.meta;
  return {
    name: NAME,
    platform: PLATFORM,
    identifier: item.id,
    format_version: FORMAT_VERSION,
    is_summary: true,
    date: ended.timestamp(),
    ...(item.started === null ? {} : { started: item.started }),
    ended,
    turns: [],
    metadata: {
      create_time, update_time, is_archived, is_starred, pinned_time, is_temporary_chat, is_do_not_remember, memory_scope, async_status,
      title_hash: titleHash, gizmo_id_hash: gizmoIdHash, conversation_template_id_hash: templateIdHash,
    },
  };
}

// The chat's last time as the spider has always taken it for a detail: its
// create_time, or the latest create_time of any message in the tree if
// later. Null when none reads as epoch seconds.
function latestSeconds(json: Readonly<Record<string, unknown>>, mapping: Readonly<Record<string, unknown>>): number | null {
  let latest = secondsOrNull(field(json, 'create_time'));
  for (const node of Object.values(mapping)) {
    const time = field(field(node, 'message'), 'create_time');
    if (isPlausibleSeconds(time) && (latest === null || time > latest)) {
      latest = time;
    }
  }
  return latest;
}

// Browser when a node with no parent is client-created-root, the root a
// browser makes, as the spider has always said.
const userAgentOf = (mapping: Readonly<Record<string, unknown>>): string => (Object.values(mapping).some((node) => field(node, 'parent') === null && field(node, 'id') === 'client-created-root') ? 'Browser' : 'App (Mobile or Desktop)');

// A detail record, or null when the detail cannot give one: it is not a
// conversation (no object, or no mapping object), it names another chat than
// the list item, or no time in it reads as epoch seconds. The caller then
// treats the read as failed. started is the chat's create_time, ended the
// latest message time as before, and date started's epoch ms, or ended's
// when there is no started. turns and turns_complete are the parse's.
// metadata holds the conversation's content-free keys, each in its form,
// the hashes, and the skeleton.
export async function buildDetailRecord(json: unknown, item: ListItem, hash: Hash): Promise<Record<string, unknown> | null> {
  const mapping = field(json, 'mapping');
  if (!isObject(json) || !isObject(mapping)) {
    return null;
  }
  const conversationId = field(json, 'conversation_id');
  if (conversationId !== undefined && conversationId !== item.id) {
    return null;
  }
  const latest = latestSeconds(json, mapping);
  if (latest === null) {
    return null;
  }
  const started = instantOf(field(json, 'create_time'));
  const ended = instantOf(latest) as DateString;
  const { turns, complete, skeleton } = parseDetail(json);
  const [titleHash, gizmoIdHash, templateIdHash] = await Promise.all([
    hashOf(field(json, 'title'), hash), hashOf(field(json, 'gizmo_id'), hash), hashOf(field(json, 'conversation_template_id'), hash),
  ]);
  // current_node is kept when it names a node of the tree, so it adds no
  // string the skeleton does not hold.
  const current = field(json, 'current_node');
  return {
    name: NAME,
    platform: PLATFORM,
    identifier: item.id,
    format_version: FORMAT_VERSION,
    is_summary: false,
    date: (started ?? ended).timestamp(),
    ...(started === null ? {} : { started }),
    ended,
    user_agent: userAgentOf(mapping),
    turns,
    turns_complete: complete,
    metadata: {
      conversation_id: typeof conversationId === 'string' ? conversationId : null,
      create_time: secondsOrNull(field(json, 'create_time')),
      update_time: secondsOrNull(field(json, 'update_time')),
      default_model_slug: typeName(field(json, 'default_model_slug')),
      is_archived: flag(field(json, 'is_archived')),
      // true or null, as on a list: an unstarred chat says null, never false.
      is_starred: field(json, 'is_starred') === true ? true : null,
      pinned_time: secondsOrNull(field(json, 'pinned_time')),
      is_temporary_chat: flag(field(json, 'is_temporary_chat')),
      is_do_not_remember: flag(field(json, 'is_do_not_remember')),
      memory_scope: typeName(field(json, 'memory_scope')),
      is_study_mode: flag(field(json, 'is_study_mode')),
      current_node: typeof current === 'string' && Object.hasOwn(mapping, current) ? current : null,
      gizmo_type: typeName(field(json, 'gizmo_type')),
      title_hash: titleHash,
      gizmo_id_hash: gizmoIdHash,
      conversation_template_id_hash: templateIdHash,
      mapping: skeleton,
    },
  };
}
