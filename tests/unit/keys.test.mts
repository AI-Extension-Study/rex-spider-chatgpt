import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { type Answer } from '../../src/client.mts';
import { ACCOUNT_KEY, BACKOFF_KEY, MODE_KEY, keyKind, memoKey, uploadKeyId } from '../../src/keys.mts';
import { type ListItem, uploadTime, walkLists } from '../../src/list.mts';

const CHAT = '00000000-0000-4000-8000-000000000001';

// rex-spider's fetchUploadKey: the key it stores and looks up for the id and
// time a spider hands to checkIfAlreadyTransmitted and logTransmitted
// (rex-spider src/service-worker.mts:332-336, at 774e813, the commit the lock
// pins). It is private, and its module loads rex-core, which does not load
// under Node, so the test applies the same formula.
const rexSpiderKey = (id: string, updated: DateString) => `rex-spider-chatgpt-conversation-upload-${id}-${Math.round(updated.timestamp())}`;

test('summary mode keeps the bare chat id, the key earlier builds wrote; detail mode adds -detail', () => {
  assert.equal(uploadKeyId('c1', true, 1), 'c1');
  assert.equal(uploadKeyId('c1', false, 1), 'c1-detail');
  assert.equal(uploadKeyId(CHAT, true, 1), CHAT);
  assert.equal(uploadKeyId(CHAT, false, 1), `${CHAT}-detail`);
});

test('the upload key rex-spider builds from it differs between the modes for one chat at one time', () => {
  const key = (summary: boolean) => rexSpiderKey(uploadKeyId(CHAT, summary, 1), new DateString('2026-09-08T13:49:43.781123Z'));
  assert.equal(key(true), `rex-spider-chatgpt-conversation-upload-${CHAT}-1788875383781`);
  assert.equal(key(false), `rex-spider-chatgpt-conversation-upload-${CHAT}-detail-1788875383781`);
});

test('format 1 keeps today\'s ids; a later format adds -f and its number, so every chat is unsent under it', () => {
  assert.equal(uploadKeyId('c', true, 1), 'c');
  assert.equal(uploadKeyId('c', false, 1), 'c-detail');
  assert.equal(uploadKeyId('c', true, 2), 'c-f2');
  assert.equal(uploadKeyId('c', false, 2), 'c-detail-f2');
  assert.equal(uploadKeyId('c', false, 999), 'c-detail-f999');
  const key = (summary: boolean, format: number) => rexSpiderKey(uploadKeyId(CHAT, summary, format), new DateString('2026-09-08T13:49:43.781123Z'));
  assert.equal(key(true, 2), `rex-spider-chatgpt-conversation-upload-${CHAT}-f2-1788875383781`);
  assert.equal(key(false, 2), `rex-spider-chatgpt-conversation-upload-${CHAT}-detail-f2-1788875383781`);
  // The four ids of one chat are four keys.
  assert.equal(new Set([key(true, 1), key(false, 1), key(true, 2), key(false, 2)]).size, 4);
});

test('a format that is not an integer from 1 to 999 is refused, so no key is built from it', () => {
  for (const format of [0, -1, 1.5, 1000, NaN, '2' as unknown as number, null as unknown as number, undefined as unknown as number]) {
    assert.throws(() => uploadKeyId(CHAT, true, format), TypeError, String(format));
    assert.throws(() => uploadKeyId(CHAT, false, format), TypeError, String(format));
  }
});

// Summary keys must not change, or every browser sends its chats again on
// update. Each case below takes list JSON as the capture of 2026-11-12 saw it,
// reads it through the walk the pass uses, and builds the key from
// uploadKeyId and uploadTime. Today's key is built from the same JSON the way
// the spider before this rewrite built it (2af116b, src/service-worker.mts):
// a main-list chat's time is new DateString(update_time) (:290, :301), and a
// project chat's is new DateString(Date.parse(update_time) / 1000) (:406,
// :417, :420), which comes out 1 ms early for this time.
const API = 'https://chatgpt.com/backend-api';
const PROJECT = 'g-p-00000000000000000000000000000001';
// An ISO 8601 string with microseconds and Z, 27 characters, as on every list item the capture read.
const UPDATED = '2026-09-08T13:49:43.781123Z';
const MAIN_CHAT = '00000000-0000-4000-8000-000000000011';
const PROJECT_CHAT = '00000000-0000-4000-8000-000000000012';
const BOTH_CHAT = '00000000-0000-4000-8000-000000000013';

const mainEntry = (id: string) => ({
  id,
  title: 'A TITLE',
  create_time: '2026-09-08T13:40:00.000001Z',
  update_time: UPDATED,
  is_archived: false,
  is_starred: null,
  pinned_time: null,
  gizmo_id: null,
  conversation_template_id: null,
});
// A project item names its project and carries a snippet and an owner.
const projectEntry = (id: string) => ({
  ...mainEntry(id),
  gizmo_id: PROJECT,
  conversation_template_id: PROJECT,
  is_temporary_chat: null,
  snippet: 'A SNIPPET',
  owner: { user_email: 'owner@example.com', name: 'AN OWNER' },
});

// The walk over a main list and one project holding these entries. Every
// other page it asks for (the main list's second page, the archived and
// starred lists) is empty.
async function walk(main: unknown[], project: unknown[]): Promise<Map<string, ListItem>> {
  const pages: Record<string, unknown> = {
    [`${API}/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false`]: { items: main, total: 29, limit: 28, offset: 0 },
    [`${API}/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=28`]: { items: [{ gizmo: { gizmo: { id: PROJECT } } }], cursor: null },
    [`${API}/gizmos/${PROJECT}/conversations?cursor=0`]: { items: project, cursor: null },
  };
  const client = { get: async (url: string): Promise<Answer> => ({ status: 200, headers: {}, text: JSON.stringify(pages[url] ?? { items: [] }), redirected: false }) };
  const result = await walkLists(client, { start: null, end: null }, { crawlDelay: () => 0, sleep: async () => {} }, { log: () => {} });
  assert.equal(result.outcome, 'whole', result.reason);
  return new Map(result.items.map((item) => [item.id, item]));
}

const summaryKey = (item: ListItem | undefined) => {
  assert.ok(item !== undefined, 'the walk did not list the chat');
  return rexSpiderKey(uploadKeyId(item.id, true, 1), uploadTime(item));
};

test('a main-list chat keeps the summary key the spider stores today, to the millisecond', async () => {
  const entry = mainEntry(MAIN_CHAT);
  const item = (await walk([entry], [])).get(MAIN_CHAT);
  assert.equal(item?.source, 'main');
  const today = rexSpiderKey(entry.id, new DateString(entry.update_time));
  assert.equal(today, `rex-spider-chatgpt-conversation-upload-${MAIN_CHAT}-1788875383781`);
  assert.equal(summaryKey(item), today);
});

test('a chat only a project lists keeps the summary key the spider stores today, 1 ms early as on that path', async () => {
  const entry = projectEntry(PROJECT_CHAT);
  const item = (await walk([], [entry])).get(PROJECT_CHAT);
  assert.equal(item?.source, 'project');
  const today = rexSpiderKey(entry.id, new DateString(Date.parse(entry.update_time) / 1000));
  assert.equal(today, `rex-spider-chatgpt-conversation-upload-${PROJECT_CHAT}-1788875383780`);
  assert.notEqual(today, rexSpiderKey(entry.id, new DateString(entry.update_time)), 'Test setup invalid: this time is not 1 ms early on the project path, so the test cannot tell the two paths apart');
  assert.equal(summaryKey(item), today);
});

test('a chat both the main list and a project hold keeps the main path key, one of the two today\'s spider stored', async () => {
  const item = (await walk([mainEntry(BOTH_CHAT)], [projectEntry(BOTH_CHAT)])).get(BOTH_CHAT);
  assert.equal(item?.source, 'main');
  assert.equal(summaryKey(item), rexSpiderKey(BOTH_CHAT, new DateString(UPDATED)));
  assert.equal(summaryKey(item), `rex-spider-chatgpt-conversation-upload-${BOTH_CHAT}-1788875383781`);
});

test('the mode record, the back-off, the account state and the memos sit under the spider\'s namespace', () => {
  assert.equal(MODE_KEY, 'rex-spider-chatgpt-mode');
  assert.equal(BACKOFF_KEY, 'rex-spider-chatgpt-backoff');
  assert.equal(ACCOUNT_KEY, 'rex-spider-chatgpt-account');
  assert.equal(memoKey(CHAT), `rex-spider-chatgpt-detail-memo-${CHAT}`);
});

test('a memo key needs a chat id', () => {
  assert.throws(() => memoKey(''), TypeError);
  assert.throws(() => uploadKeyId('', true, 1), TypeError);
});

test('what may be logged of a key is its kind, never a chat id', () => {
  assert.equal(keyKind(MODE_KEY), 'rex-spider-chatgpt-mode');
  assert.equal(keyKind(BACKOFF_KEY), 'rex-spider-chatgpt-backoff');
  assert.equal(keyKind(ACCOUNT_KEY), 'rex-spider-chatgpt-account');
  assert.equal(keyKind(memoKey(CHAT)), 'rex-spider-chatgpt-detail-memo');
  assert.equal(keyKind(`rex-spider-chatgpt-conversation-upload-${CHAT}-1788875383781`), 'other key');
});

test('a chat id that is not a string is refused at run time too', () => {
  assert.throws(() => memoKey(123 as unknown as string), TypeError);
  assert.throws(() => uploadKeyId(null as unknown as string, false, 1), TypeError);
});
