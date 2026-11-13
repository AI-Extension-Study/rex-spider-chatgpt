import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sha256 } from '@bric/rex-core/common';
import { DateString } from '@bric/rex-types/types';

import { type Answer } from '../../src/client.mts';
import { type ListItem, walkLists } from '../../src/list.mts';
import { type Hash, buildDetailRecord, buildSummaryRecord } from '../../src/record.mts';
import {
  CHAT_ID, EXCHANGE, LIST_CREATED, LIST_UPDATED, MARK, PROJECT_ID, ROOT, T0, answer, attachment, detail, group, hiddenContext, imagePart, listItem,
  nodeId, nodeOf, projectItem, prompt, reasoningDetail, reference, searchCall, systemMessage, toolResult, tree,
} from './fixtures.mts';

type Json = Record<string, unknown>;

const PROJECT_CHAT = '6911f0a5-2222-8000-8000-000000000002';

// SHA-256 in hex of the fixtures' strings, from shasum -a 256.
const TITLE_HASH = 'e9132382394b9cf16c5a932edf7227fe44d1d42639d3a41a63f1c91d293040fe'; // 'MARKER title of the chat'
const LIST_TITLE_HASH = 'c5f710ba01815792a3a200c4118e0dd6e847d6bc214b237c93c3349ba8da81eb'; // 'MARKER list title'
const GIZMO_HASH = 'ee87c5854fc8cadf4970183b54969bdb35658b59e94056a8008a60ff7e3c61fd'; // 'g-p-MARKERgizmo'
const TEMPLATE_HASH = '4bd921ca6711f9df110fa8d2ac463f6b342903c7c703b25e3712e8dc83c3f66e'; // 'g-p-MARKERtemplate'

const SUMMARY_METADATA_KEYS = [
  'create_time', 'update_time', 'is_archived', 'is_starred', 'pinned_time', 'is_temporary_chat', 'is_do_not_remember', 'memory_scope',
  'async_status', 'title_hash', 'gizmo_id_hash', 'conversation_template_id_hash',
];
const DETAIL_METADATA_KEYS = [
  'conversation_id', 'create_time', 'update_time', 'default_model_slug', 'is_archived', 'is_starred', 'pinned_time', 'is_temporary_chat',
  'is_do_not_remember', 'memory_scope', 'is_study_mode', 'current_node', 'gizmo_type', 'title_hash', 'gizmo_id_hash',
  'conversation_template_id_hash', 'mapping',
];

// The builders, each record checked for text from the list or the chat,
// whatever the test.
async function summaryOf(item: ListItem, hash: Hash = sha256): Promise<Json> {
  const record = await buildSummaryRecord(item, hash);
  assert.equal(JSON.stringify(record).includes(MARK), false, 'text from the list is in the summary');
  return record;
}

async function detailOf(chat: unknown, item: ListItem, hash: Hash = sha256): Promise<Json | null> {
  const record = await buildDetailRecord(chat, item, hash);
  assert.equal(JSON.stringify(record).includes(MARK), false, 'text from the chat is in the record');
  return record;
}

// The record as it is uploaded: its JSON, each DateString as its instant.
const uploaded = (record: unknown): Json => JSON.parse(JSON.stringify(record)) as Json;

// The list items the walk reads from a main list and one project holding
// these items; every other list is empty.
async function listed(main: unknown[], project: unknown[] = []): Promise<Map<string, ListItem>> {
  const API = 'https://chatgpt.com/backend-api';
  const pages: Record<string, unknown> = {
    [`${API}/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false`]: { items: main, total: 29, limit: 28, offset: 0 },
    [`${API}/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=28`]: { items: [{ gizmo: { gizmo: { id: PROJECT_ID } } }], cursor: null },
    [`${API}/gizmos/${PROJECT_ID}/conversations?cursor=0`]: { items: project, cursor: null },
  };
  const client = { get: async (url: string): Promise<Answer> => ({ status: 200, headers: {}, text: JSON.stringify(pages[url] ?? { items: [] }) }) };
  const result = await walkLists(client, { start: null, end: null }, { crawlDelay: () => 0, sleep: async () => {} }, { log: () => {} });
  assert.equal(result.outcome, 'whole', result.reason);
  return new Map(result.items.map((item) => [item.id, item]));
}

async function one(main: unknown[], project: unknown[] = []): Promise<ListItem> {
  const items = [...(await listed(main, project)).values()];
  assert.equal(items.length, 1);
  return items[0];
}

test('the summary of a main-list chat: every key and value', async () => {
  const record = await summaryOf(await one([listItem(CHAT_ID)]), sha256);
  assert.deepEqual(uploaded(record), {
    name: 'rex-conversation',
    platform: 'chatgpt',
    identifier: CHAT_ID,
    format_version: 1,
    is_summary: true,
    date: 1788875383781,
    started: '2026-09-08T13:48:43.781123Z',
    ended: '2026-09-08T13:49:43.781456Z',
    turns: [],
    metadata: {
      create_time: LIST_CREATED, update_time: LIST_UPDATED, is_archived: false, is_starred: null, pinned_time: null, is_temporary_chat: false,
      is_do_not_remember: false, memory_scope: 'global_enabled', async_status: null, title_hash: LIST_TITLE_HASH, gizmo_id_hash: null,
      conversation_template_id_hash: null,
    },
  });
  assert.equal(typeof record.date, 'number');
  assert.ok(record.started instanceof DateString && record.ended instanceof DateString);
  assert.deepEqual(Object.keys(record), ['name', 'platform', 'identifier', 'format_version', 'is_summary', 'date', 'started', 'ended', 'turns', 'metadata']);
  assert.deepEqual(Object.keys(record.metadata as Json), SUMMARY_METADATA_KEYS);
});

test('the summary of a chat only a project lists keeps that path\'s times, 1 ms early as today, and hashes its project ids', async () => {
  const item = await one([], [projectItem(PROJECT_CHAT)]);
  const record = await summaryOf(item, sha256);
  // What today's spider sends on that path: new DateString(Date.parse(t) / 1000).
  assert.equal(JSON.stringify(record.ended), JSON.stringify(new DateString(Date.parse(LIST_UPDATED) / 1000)));
  assert.equal(JSON.stringify(record.started), JSON.stringify(new DateString(Date.parse(LIST_CREATED) / 1000)));
  assert.deepEqual(uploaded(record), {
    name: 'rex-conversation',
    platform: 'chatgpt',
    identifier: PROJECT_CHAT,
    format_version: 1,
    is_summary: true,
    date: 1788875383780,
    started: '2026-09-08T13:48:43.780999936Z',
    ended: '2026-09-08T13:49:43.780999936Z',
    turns: [],
    metadata: {
      create_time: LIST_CREATED, update_time: LIST_UPDATED, is_archived: false, is_starred: null, pinned_time: null, is_temporary_chat: null,
      is_do_not_remember: false, memory_scope: 'global_enabled', async_status: null, title_hash: LIST_TITLE_HASH, gizmo_id_hash: GIZMO_HASH,
      conversation_template_id_hash: TEMPLATE_HASH,
    },
  });
});

test('a summary keeps the list\'s starred, archived and pinned values in their forms', async () => {
  const item = await one([listItem(CHAT_ID, { is_starred: true, is_archived: true, pinned_time: LIST_CREATED, memory_scope: `${MARK} scope`, async_status: 'queued' })]);
  const { metadata } = await summaryOf(item, sha256);
  const kept = metadata as Json;
  assert.deepEqual([kept.is_starred, kept.is_archived, kept.pinned_time, kept.memory_scope, kept.async_status], [true, true, LIST_CREATED, 'unrecognised', 'queued']);
});

test('a summary of a chat with no readable create_time has no started', async () => {
  const record = await summaryOf(await one([listItem(CHAT_ID, { create_time: null })]), sha256);
  assert.equal(Object.hasOwn(record, 'started'), false);
  assert.equal(record.date, 1788875383781);
});

test('a summary holds no text from the list: no title, snippet, owner, URL, scope or summary', async () => {
  const items = await listed([listItem(CHAT_ID)], [projectItem(PROJECT_CHAT)]);
  for (const item of items.values()) {
    const record = await summaryOf(item, sha256);
    assert.equal(JSON.stringify(record).includes(MARK), false, item.source);
  }
});

// A chat of the shape in the record layout's example: the root, a system
// message, a prompt, a web search and its result, and the answer.
const smallDetail = () => detail(tree(
  [ROOT, null, null],
  [nodeId(10), ROOT, systemMessage(nodeId(10))],
  [nodeId(1), nodeId(10), prompt(nodeId(1), T0 + 0.25, `${MARK} one two three`)],
  [nodeId(2), nodeId(1), searchCall(nodeId(2), T0 + 1, 'web')],
  [nodeId(3), nodeId(2), toolResult(nodeId(3), T0 + 2, [group('news', 0, 3)])],
  [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 26.871, `${MARK} three four five`, { channel: null, refs: [reference(), reference('sources_footnote')] })],
), nodeId(4));

const message = (fields: Json): Json => ({
  author: { role: 'assistant', name: null }, create_time: null, update_time: null, status: 'finished_successfully', weight: 1, end_turn: null,
  recipient: 'all', channel: null, content_type: 'text', metadata: { turn_exchange_id: EXCHANGE }, ...fields,
});
const ANSWER_METADATA = { turn_exchange_id: EXCHANGE, model_slug: 'gpt-5', resolved_model_slug: 'gpt-5-2025', message_type: 'next', request_id: 'cccccccc-0000-4000-8000-000000000001', finished_duration_sec: 3 };

test('the detail record of a chat: every key and value', async () => {
  const record = await detailOf(smallDetail(), await one([listItem(CHAT_ID)]), sha256);
  assert.ok(record !== null);
  assert.deepEqual(uploaded(record), {
    name: 'rex-conversation',
    platform: 'chatgpt',
    identifier: CHAT_ID,
    format_version: 1,
    is_summary: false,
    date: 1794319205000,
    started: '2026-11-10T14:00:05Z',
    ended: '2026-11-10T14:00:31.871Z',
    user_agent: 'Browser',
    turns: [
      {
        identifier: nodeId(1), parent: null, speaker: 'user', when: '2026-11-10T14:00:05.25Z', on_current_branch: true,
        text_chars: 20, text_words: 4, citation_count: 0, search_result_count: 0, attachments: 0, content_type: 'text', status: 'finished_successfully',
      },
      {
        identifier: nodeId(4), parent: nodeId(1), speaker: 'assistant', when: '2026-11-10T14:00:31.871Z', on_current_branch: true,
        text_chars: 22, text_words: 4, citation_count: 1, search_result_count: 3, attachments: 0, content_type: 'text', status: 'finished_successfully',
        model_slug: 'gpt-5', nodes: 1,
      },
    ],
    turns_complete: true,
    metadata: {
      conversation_id: CHAT_ID, create_time: 1794319205, update_time: 1794319265.5, default_model_slug: 'gpt-5', is_archived: false, is_starred: null,
      pinned_time: null, is_temporary_chat: false, is_do_not_remember: false, memory_scope: 'global_enabled', is_study_mode: false,
      current_node: nodeId(4), gizmo_type: null, title_hash: TITLE_HASH, gizmo_id_hash: null, conversation_template_id_hash: null,
      mapping: {
        [ROOT]: { id: ROOT, parent: null, children: [nodeId(10)], message: null },
        [nodeId(10)]: { id: nodeId(10), parent: ROOT, children: [nodeId(1)], message: message({ author: { role: 'system', name: null } }) },
        [nodeId(1)]: { id: nodeId(1), parent: nodeId(10), children: [nodeId(2)], message: message({ author: { role: 'user', name: null }, create_time: 1794319205.25 }) },
        [nodeId(2)]: { id: nodeId(2), parent: nodeId(1), children: [nodeId(3)], message: message({ create_time: 1794319206, recipient: 'web', channel: 'commentary' }) },
        [nodeId(3)]: { id: nodeId(3), parent: nodeId(2), children: [nodeId(4)], message: message({ author: { role: 'tool', name: 'web.run' }, create_time: 1794319207 }) },
        [nodeId(4)]: { id: nodeId(4), parent: nodeId(3), children: [], message: message({ create_time: 1794319231.871, end_turn: true, metadata: ANSWER_METADATA }) },
      },
    },
  });
  assert.equal(typeof record.date, 'number');
  assert.ok(record.started instanceof DateString && record.ended instanceof DateString);
  assert.deepEqual(Object.keys(record), [
    'name', 'platform', 'identifier', 'format_version', 'is_summary', 'date', 'started', 'ended', 'user_agent', 'turns', 'turns_complete', 'metadata',
  ]);
  assert.deepEqual(Object.keys(record.metadata as Json), DETAIL_METADATA_KEYS);
});

test('the detail record of a project chat hashes its gizmo and template ids', async () => {
  const chat = { ...smallDetail(), gizmo_id: `g-p-${MARK}gizmo`, conversation_template_id: `g-p-${MARK}template`, gizmo_type: 'snorlax' };
  const record = await detailOf(chat, await one([listItem(CHAT_ID)]), sha256);
  const metadata = record?.metadata as Json;
  assert.deepEqual([metadata.gizmo_id_hash, metadata.conversation_template_id_hash, metadata.gizmo_type], [GIZMO_HASH, TEMPLATE_HASH, 'snorlax']);
});

test('ended is the latest message create_time, a tool or hidden message\'s included, not update_time; started the chat\'s create_time', async () => {
  const chat = detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
    [nodeId(3), nodeId(2), answer(nodeId(3), T0 + 45.5, `${MARK} hidden copy`, { metadata: { is_visually_hidden_from_conversation: true } })],
  ), nodeId(3), { create_time: T0 + 0.5, update_time: T0 + 99 });
  const record = uploaded(await detailOf(chat, await one([listItem(CHAT_ID)]), sha256));
  assert.deepEqual([record.started, record.ended, record.date], ['2026-11-10T14:00:05.5Z', '2026-11-10T14:00:50.5Z', 1794319205500]);
});

test('ended is the chat\'s create_time when no message is later, as the spider has always taken it', async () => {
  const chat = { ...smallDetail(), create_time: T0 + 40 };
  const record = uploaded(await detailOf(chat, await one([listItem(CHAT_ID)]), sha256));
  assert.deepEqual([record.started, record.ended, record.date], ['2026-11-10T14:00:45Z', '2026-11-10T14:00:45Z', 1794319245000]);
});

test('with no create_time that reads as epoch seconds there is no started, and date is ended\'s', async () => {
  for (const value of [null, undefined, (T0 + 1) * 1000, '2026-11-10T14:00:05Z']) {
    const chat = { ...smallDetail(), create_time: value };
    const record = await detailOf(chat, await one([listItem(CHAT_ID)]), sha256);
    assert.ok(record !== null);
    assert.equal(Object.hasOwn(record, 'started'), false, String(value));
    assert.equal(record.date, 1794319231871, String(value));
    assert.equal((record.metadata as Json).create_time, null, String(value));
  }
});

test('user_agent is Browser when the root is client-created-root, as the spider has always said, and App otherwise', async () => {
  const item = await one([listItem(CHAT_ID)]);
  const fromApp = detail(tree(
    [nodeId(50), null, null],
    [nodeId(1), nodeId(50), prompt(nodeId(1), T0 + 1)],
  ), nodeId(1));
  assert.equal((await detailOf(smallDetail(), item, sha256))?.user_agent, 'Browser');
  assert.equal((await detailOf(fromApp, item, sha256))?.user_agent, 'App (Mobile or Desktop)');
  // Only a node with no parent counts, as before.
  const notRoot = detail(tree([nodeId(50), null, null], [ROOT, nodeId(50), null], [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)]), nodeId(1));
  assert.equal((await detailOf(notRoot, item, sha256))?.user_agent, 'App (Mobile or Desktop)');
});

test('the detail metadata keeps each conversation key in its form, or null', async () => {
  const chat = {
    ...smallDetail(),
    default_model_slug: `GPT 5 ${MARK}`,
    memory_scope: `${MARK}`,
    gizmo_type: 'snorlax',
    is_starred: false,
    is_archived: 'yes',
    pinned_time: '2026-11-10T14:00:05Z',
    is_study_mode: null,
    update_time: (T0 + 1) * 1000,
    current_node: nodeId(99),
  };
  const metadata = (await detailOf(chat, await one([listItem(CHAT_ID)]), sha256))?.metadata as Json;
  assert.deepEqual(
    [metadata.default_model_slug, metadata.memory_scope, metadata.gizmo_type, metadata.is_starred, metadata.is_archived, metadata.pinned_time, metadata.is_study_mode, metadata.update_time, metadata.current_node],
    ['unrecognised', 'unrecognised', 'snorlax', null, null, null, null, null, null],
  );
  const pinned = (await detailOf({ ...smallDetail(), is_starred: true, pinned_time: T0 + 3 }, await one([listItem(CHAT_ID)]), sha256))?.metadata as Json;
  assert.deepEqual([pinned.is_starred, pinned.pinned_time], [true, T0 + 3]);
});

test('a detail record\'s turns are incomplete when the parse is', async () => {
  const chat = smallDetail();
  (nodeOf(chat.mapping as Json, nodeId(4)).children as string[]).push(nodeId(9));
  const record = await detailOf(chat, await one([listItem(CHAT_ID)]), sha256);
  assert.equal(record?.turns_complete, false);
});

test('a detail that holds no conversation, or another chat\'s, or no time at all, gives no record', async () => {
  const item = await one([listItem(CHAT_ID)]);
  const timeless = detail(tree([ROOT, null, null], [nodeId(1), ROOT, { ...prompt(nodeId(1), T0), create_time: null }]), nodeId(1), { create_time: null });
  const bodies: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'text'],
    ['an array', []],
    ['no mapping', { ...smallDetail(), mapping: undefined }],
    ['a mapping that is an array', { ...smallDetail(), mapping: [] }],
    ['another chat', { ...smallDetail(), conversation_id: PROJECT_CHAT }],
    ['a conversation_id that is null', { ...smallDetail(), conversation_id: null }],
    ['no time', timeless],
  ];
  for (const [what, body] of bodies) {
    assert.equal(await detailOf(body, item, sha256), null, what);
  }
  // A detail with no conversation_id is read as the chat the list named.
  const unnamed: Json = { ...smallDetail() };
  delete unnamed.conversation_id;
  const record = await detailOf(unnamed, item, sha256);
  assert.deepEqual([record?.identifier, (record?.metadata as Json).conversation_id], [CHAT_ID, null]);
});

test('no detail record holds text from the chat', async () => {
  const item = await one([listItem(CHAT_ID)]);
  const voice = { content_type: 'multimodal_text', parts: [{ content_type: 'audio_transcription', text: `${MARK} spoken`, direction: 'in' }, { content_type: 'audio_asset_pointer', asset_pointer: `sediment://${MARK}` }] };
  const report = JSON.stringify({ report_message: { content: { parts: [`${MARK} report`] } } });
  const chats = [
    reasoningDetail(),
    smallDetail(),
    { ...smallDetail(), gizmo_id: `g-p-${MARK}gizmo`, conversation_template_id: `g-p-${MARK}template` },
    detail(tree(
      [ROOT, null, null],
      [nodeId(11), ROOT, hiddenContext(nodeId(11))],
      [nodeId(1), nodeId(11), { ...prompt(nodeId(1), T0 + 1), content: { content_type: 'multimodal_text', parts: [imagePart(1), `${MARK} see`] }, metadata: { attachments: [attachment(1)] } }],
      [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`, { metadata: { chatgpt_sdk: { widget_state: report } } })],
      [nodeId(3), nodeId(2), { ...prompt(nodeId(3), T0 + 3), content: voice }],
    ), nodeId(3)),
  ];
  for (const chat of chats) {
    const record = await detailOf(chat, item, sha256);
    assert.ok(record !== null);
    assert.equal(JSON.stringify(record).includes(MARK), false);
  }
});

test('a hash that fails, or answers with anything but lowercase hex SHA-256, gives null: a title never goes out as itself', async () => {
  const item = await one([listItem(CHAT_ID)], []);
  const project = await one([], [projectItem(PROJECT_CHAT)]);
  const chat = { ...smallDetail(), gizmo_id: `g-p-${MARK}gizmo`, conversation_template_id: `g-p-${MARK}template` };
  const hashes: Array<[string, (text: string) => Promise<string>]> = [
    ['the text itself', async (text) => text],
    ['upper-case hex', async (text) => (await sha256(text)).toUpperCase()],
    ['a short hex', async () => 'abc123'],
    ['a rejection', async () => { throw new Error('no digest'); }],
  ];
  for (const [what, hash] of hashes) {
    const summary = await summaryOf(project, hash);
    const fromDetail = await detailOf(chat, item, hash);
    for (const record of [summary, fromDetail]) {
      const metadata = record?.metadata as Json;
      assert.deepEqual([metadata.title_hash, metadata.gizmo_id_hash, metadata.conversation_template_id_hash], [null, null, null], what);
      assert.equal(JSON.stringify(record).includes(MARK), false, what);
    }
  }
});

test('an empty title or an id that is not a string is not hashed', async () => {
  const asked: string[] = [];
  const hash = async (text: string) => {
    asked.push(text);
    return sha256(text);
  };
  const chat = { ...smallDetail(), title: '', gizmo_id: 7, conversation_template_id: '' };
  const metadata = (await detailOf(chat, await one([listItem(CHAT_ID)]), hash))?.metadata as Json;
  assert.deepEqual([metadata.title_hash, metadata.gizmo_id_hash, metadata.conversation_template_id_hash], [null, null, null]);
  assert.deepEqual(asked, []);
});
