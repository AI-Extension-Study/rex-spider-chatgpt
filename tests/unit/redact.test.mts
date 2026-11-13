import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { DateString } from '@bric/rex-types/types';

import { type Answer } from '../../src/client.mts';
import { type ListItem, walkLists } from '../../src/list.mts';
import { type Hash, buildDetailRecord, buildSummaryRecord } from '../../src/record.mts';
import { redactChatGPT } from '../../src/redact.mts';
import {
  CHAT_ID, LIST_CREATED, MARK, PROJECT_ID, ROOT, T0, answer, attachment, detail, editedFirstPromptDetail, group, hiddenContext, imagePart, listItem,
  nodeId, nodeOf, projectItem, prompt, reasoningDetail, reference, searchCall, systemMessage, toolResult, tree,
} from './fixtures.mts';

type Json = Record<string, unknown>;

const hash: Hash = async (text) => createHash('sha256').update(text).digest('hex');
const chatId = (n: number) => `6911f0a5-2222-8000-8000-${String(n).padStart(12, '0')}`;
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const redact = (event: unknown): Json => redactChatGPT(event as Json);

// What the extension uploads: rex-content-processing walks the processor's
// output and copies each object's own keys into a plain one, so a DateString
// goes out as {value, originalValue}, originalValue included.
function walked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walked);
  if (Object.prototype.toString.call(value) !== '[object Object]') return value;
  return Object.fromEntries(Object.keys(value as object).map((key) => [key, walked((value as Json)[key])]));
}
const wire = (value: unknown): string => JSON.stringify(walked(value));

const API = 'https://chatgpt.com/backend-api';
// The items the list walk reads when the lists hold these; the sidebar names
// the fixtures' one project.
async function listed(lists: { main?: unknown[]; archived?: unknown[]; starred?: unknown[]; project?: unknown[] }): Promise<ListItem[]> {
  const pages: Record<string, unknown> = {
    [`${API}/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false`]: { items: lists.main ?? [] },
    [`${API}/conversations?offset=0&limit=28&order=updated&is_archived=true`]: { items: lists.archived ?? [] },
    [`${API}/conversations?offset=0&limit=28&order=updated&is_starred=true`]: { items: lists.starred ?? [] },
    [`${API}/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=28`]: { items: [{ gizmo: { gizmo: { id: PROJECT_ID } } }], cursor: null },
    [`${API}/gizmos/${PROJECT_ID}/conversations?cursor=0`]: { items: lists.project ?? [], cursor: null },
  };
  const client = { get: async (url: string): Promise<Answer> => ({ status: 200, headers: {}, text: JSON.stringify(pages[url] ?? { items: [] }) }) };
  const result = await walkLists(client, { start: null, end: null }, { crawlDelay: () => 0, sleep: async () => {} }, { log: () => {} });
  assert.equal(result.outcome, 'whole', `Test setup invalid: ${result.reason}`);
  return result.items;
}

// The root, a system message, a prompt, a web search and its result, and the answer.
const smallChat = () => detail(tree(
  [ROOT, null, null],
  [nodeId(10), ROOT, systemMessage(nodeId(10))],
  [nodeId(1), nodeId(10), prompt(nodeId(1), T0 + 0.25)],
  [nodeId(2), nodeId(1), searchCall(nodeId(2), T0 + 1, 'web')],
  [nodeId(3), nodeId(2), toolResult(nodeId(3), T0 + 2, [group('news', 0, 3)])],
  [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 26.871, `${MARK} three four five`, { channel: null, refs: [reference(), reference('sources_footnote')] })],
), nodeId(4));

const [MAIN_ITEM] = await listed({ main: [listItem(CHAT_ID)] });
async function detailOf(chat: unknown): Promise<Json> {
  const record = await buildDetailRecord(chat, MAIN_ITEM, hash);
  assert.ok(record !== null, 'Test setup invalid: the builder gave no record');
  return record;
}

// Every shape of record the builders make from the fixtures: summaries from
// each list path, and details of each kind of tree.
async function fixtureRecords(): Promise<Array<[string, Json]>> {
  const items = await listed({
    main: [listItem(CHAT_ID), listItem(chatId(3), { create_time: null }), listItem(chatId(4), {
      create_time: '2026-09-08T13:48:43.781123+00:00', update_time: '2026-09-08T15:49:43+02:00', memory_scope: `${MARK} scope`, async_status: 'queued',
    })],
    archived: [listItem(chatId(5), { is_archived: true })],
    starred: [listItem(chatId(6), { is_starred: true, pinned_time: LIST_CREATED })],
    project: [projectItem(chatId(2))],
  });
  const summaries = await Promise.all(items.map(async (item): Promise<[string, Json]> => [`summary from the ${item.source} list, ${item.id}`, await buildSummaryRecord(item, hash)]));
  const missing = detail(tree(
    [ROOT, null, null], [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)], [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, MARK)], [nodeId(5), nodeId(4), prompt(nodeId(5), T0 + 5)],
  ), nodeId(2));
  (nodeOf(missing.mapping as Json, nodeId(2)).children as string[]).push(nodeId(9));
  const upper = (n: number) => nodeId(n).toUpperCase();
  const chats: Array<[string, unknown]> = [
    ['the small chat', smallChat()],
    ['an edited first prompt', editedFirstPromptDetail()],
    ['a reasoning reply', reasoningDetail()],
    ['a chat from the app, with no current node', detail(tree([nodeId(50), null, null], [nodeId(1), nodeId(50), prompt(nodeId(1), T0 + 1)], [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, MARK)]), undefined)],
    ['no create_time, so no started', { ...smallChat(), create_time: null }],
    ['a project chat, starred and pinned, with hidden context, an image and an attachment', detail(tree(
      [ROOT, null, null],
      [nodeId(11), ROOT, hiddenContext(nodeId(11))],
      [nodeId(1), nodeId(11), { ...prompt(nodeId(1), T0 + 1), content: { content_type: 'multimodal_text', parts: [imagePart(1), `${MARK} see`] }, metadata: { attachments: [attachment(1)] } }],
      [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
    ), nodeId(2), { gizmo_id: `g-p-${MARK}gizmo`, conversation_template_id: `g-p-${MARK}template`, gizmo_type: 'snorlax', is_starred: true, pinned_time: T0 + 3 })],
    ['a child and a parent the tree does not hold', missing],
    ['a message that cannot be read', detail(tree([ROOT, null, null], [nodeId(1), ROOT, { ...prompt(nodeId(1), T0 + 1), author: { role: 7 } }], [nodeId(2), nodeId(1), prompt(nodeId(2), T0 + 2)]), nodeId(2))],
    ['node ids in capitals', detail(tree([ROOT, null, null], [upper(1), ROOT, prompt(upper(1), T0 + 1)], [upper(2), upper(1), answer(upper(2), T0 + 2, MARK)]), upper(2))],
  ];
  const details = await Promise.all(chats.map(async ([what, chat]): Promise<[string, Json]> => [`detail: ${what}`, await detailOf(chat)]));
  return [...summaries, ...details];
}
const RECORDS = await fixtureRecords();
const recordOf = (what: string): Json => (RECORDS.find(([name]) => name.includes(what)) ?? assert.fail(`no record ${what}`))[1];
const SUMMARY = recordOf(`main list, ${CHAT_ID}`);
const DETAIL = recordOf('the small chat');

test('every record the builders make on the fixtures comes back equal, as built and as the walker leaves its times', () => {
  assert.equal(RECORDS.length, 15, 'Test setup invalid: a fixture record is missing');
  for (const [what, record] of RECORDS) {
    const times = (key: string, form: (date: DateString) => unknown) => (record[key] === undefined ? {} : { [key]: form(record[key] as DateString) });
    const forms: Array<[string, Json]> = [
      ['as built', record],
      ['as the walker leaves it', { ...record, ...times('started', (date) => ({ ...date })), ...times('ended', (date) => ({ ...date })) }],
      ['with each instant as its string', { ...record, ...times('started', (date) => ({ value: date.toJSON(), originalValue: date.originalValue })), ...times('ended', (date) => ({ value: date.toJSON(), originalValue: date.originalValue })) }],
    ];
    for (const [form, event] of forms) {
      const out = redact(event);
      assert.deepEqual(plain(out), plain(record), `${what}, ${form}`);
      // Turn keys go in the standard's order, and metadata in the builders'.
      assert.equal(JSON.stringify([out.turns, out.metadata]), JSON.stringify([record.turns, record.metadata]), `${what}, ${form}: key order`);
      assert.ok(out.ended instanceof DateString && (record.started === undefined || out.started instanceof DateString), `${what}, ${form}: a time is not a DateString`);
    }
  }
});

test('a point that is not a format 1 record the builders make keeps only the scaffold', () => {
  const scaffold = { date: SUMMARY.date, name: 'rex-conversation', platform: 'chatgpt', identifier: CHAT_ID };
  const ended = SUMMARY.ended as DateString;
  const cases: Array<[string, Json, Json]> = [
    ['no format_version', { ...SUMMARY, format_version: undefined }, scaffold],
    ['format_version 2', { ...SUMMARY, format_version: 2 }, scaffold],
    ['format_version as text', { ...SUMMARY, format_version: '1' }, scaffold],
    ['another platform', { ...SUMMARY, platform: 'gemini' }, { ...scaffold, platform: 'gemini' }],
    ['another name', { ...SUMMARY, name: 'rex-other' }, { ...scaffold, name: 'rex-other' }],
    ['an identifier that is no chat id', { ...SUMMARY, identifier: `${MARK} chat` }, { date: SUMMARY.date, name: 'rex-conversation', platform: 'chatgpt' }],
    ['no is_summary', { ...SUMMARY, is_summary: undefined }, scaffold],
    ['turns that are not a list', { ...SUMMARY, turns: {} }, scaffold],
    ['a summary with a turn', { ...SUMMARY, turns: [(DETAIL.turns as Json[])[0]] }, scaffold],
    ['a summary with turns_complete', { ...SUMMARY, turns_complete: true }, scaffold],
    ['metadata that is not an object', { ...SUMMARY, metadata: [] }, scaffold],
    ['no ended', { ...SUMMARY, ended: undefined }, scaffold],
    ['ended as a string', { ...SUMMARY, ended: ended.toJSON() }, scaffold],
    ['ended of text', { ...SUMMARY, ended: { value: null, originalValue: `other:${MARK}` } }, scaffold],
    ['ended from epoch ms', { ...SUMMARY, ended: new DateString(T0 * 1000), date: T0 * 1000 * 1000 }, { ...scaffold, date: T0 * 1000 * 1000 }],
    ['ended from a Date', { ...SUMMARY, ended: new DateString(new Date(ended.timestamp())) }, scaffold],
    ['ended whose value is another instant', { ...SUMMARY, ended: { value: new DateString(T0).value, originalValue: ended.originalValue } }, scaffold],
    ['ended whose value only looks like an instant', { ...SUMMARY, ended: { value: { toString: () => ended.toJSON() }, originalValue: ended.originalValue } }, scaffold],
    ['ended with another own key', { ...SUMMARY, ended: { ...ended, note: 1 } }, scaffold],
    ['started of text', { ...SUMMARY, started: { value: null, originalValue: `other:${MARK}` } }, scaffold],
    ['a date that is not ended', { ...SUMMARY, date: (SUMMARY.date as number) + 1 }, { ...scaffold, date: (SUMMARY.date as number) + 1 }],
  ];
  const detailScaffold = { ...scaffold, date: DETAIL.date };
  const [user, reply] = DETAIL.turns as Json[];
  const endedMs = (DETAIL.ended as DateString).timestamp();
  cases.push(
    ['a detail with no is_summary', { ...DETAIL, is_summary: undefined }, detailScaffold],
    ['a detail whose is_summary is text', { ...DETAIL, is_summary: MARK }, detailScaffold],
    ['a detail with no turns_complete', { ...DETAIL, turns_complete: undefined }, detailScaffold],
    ['a detail whose turns_complete is text', { ...DETAIL, turns_complete: 'yes' }, detailScaffold],
    ['a detail with another user agent', { ...DETAIL, user_agent: MARK }, detailScaffold],
    ['a detail dated by its end though it has a start', { ...DETAIL, date: endedMs }, { ...scaffold, date: endedMs }],
    ['a turn of another speaker', { ...DETAIL, turns: [{ ...user, speaker: 'system' }, reply] }, detailScaffold],
    ['a turn with no speaker', { ...DETAIL, turns: [user, { ...reply, speaker: undefined }] }, detailScaffold],
    ['a reply that folds no message', { ...DETAIL, turns: [user, { ...reply, nodes: 0 }] }, detailScaffold],
    ['a reply whose nodes is text', { ...DETAIL, turns: [user, { ...reply, nodes: '1' }] }, detailScaffold],
  );
  // Every case runs before the test fails, so one break shows each case it lets through.
  const wrong = cases.filter(([, event, expected]) => !isDeepStrictEqual(redact(event), expected)).map(([what]) => what);
  assert.deepEqual(wrong, []);
});

test('the scaffold keeps each field only in its form, and the PDK envelope keys as they come', () => {
  const event = { name: 'Rex Conversation', platform: 'chatgpt', identifier: MARK, date: 'today', generatorId: 'rex-conversation', _pdk_trace_context: { bundle_id: 1 }, 'passive-data-metadata': { timestamp: 2 }, title: MARK };
  assert.deepEqual(redact(event), { platform: 'chatgpt', generatorId: 'rex-conversation', _pdk_trace_context: { bundle_id: 1 }, 'passive-data-metadata': { timestamp: 2 } });
  assert.deepEqual(redact({ name: 'rex-conversation', platform: MARK, generatorId: MARK, date: 1 }), { name: 'rex-conversation', date: 1 });
  const out = redact({ ...SUMMARY, generatorId: 'rex-conversation', _pdk_trace_context: { bundle_id: 1 } });
  assert.deepEqual([out.generatorId, out._pdk_trace_context, out.is_summary], ['rex-conversation', { bundle_id: 1 }, true]);
});

test('an unknown key at any level is dropped, and the record comes back as it was without it', () => {
  const metadata = DETAIL.metadata as Json;
  const mapping = metadata.mapping as Record<string, Json>;
  // Keys named like Object's own are read only as the value's own keys.
  const extra = { 'content*': MARK, title: MARK, constructor: MARK, toString: MARK };
  const planted = {
    ...DETAIL,
    ...extra,
    turns: (DETAIL.turns as Json[]).map((turn) => ({ ...turn, ...extra, 'metadata*': { text: MARK }, model_slug: turn.model_slug ?? 'gpt-5', nodes: turn.nodes ?? 1 })),
    metadata: {
      ...metadata, ...extra, owner: { user_email: MARK }, safe_urls: [MARK],
      mapping: Object.fromEntries(Object.entries(mapping).map(([id, node]) => [id, {
        ...node, ...extra, message: node.message === null ? null : {
          ...(node.message as Json), content: { parts: [MARK] }, author: { ...((node.message as Json).author as Json), metadata: { text: MARK } },
          metadata: { ...((node.message as Json).metadata as Json), ...extra, dictation_original_text: MARK, search_queries: [{ q: MARK }] },
        },
      }])),
    },
  };
  assert.deepEqual(plain(redact(planted)), plain(DETAIL));
  const summary = { ...SUMMARY, ...extra, user_agent: 'Browser', metadata: { ...(SUMMARY.metadata as Json), ...extra, snippet: MARK, id: CHAT_ID } };
  assert.deepEqual(plain(redact(summary)), plain(SUMMARY));
});

test('a value out of its form is null, and a string out of its type name or closed set reads unrecognised, at every level', () => {
  const [user, reply] = DETAIL.turns as Json[];
  const metadata = DETAIL.metadata as Json;
  const mapping = metadata.mapping as Record<string, Json>;
  const odd = redact({
    ...DETAIL,
    turns: [
      {
        ...user, identifier: 'node one', parent: MARK, when: '2026-11-10T14:00:05.250Z', on_current_branch: 'yes', text_chars: -1, text_words: 1.5,
        citation_count: '3', search_result_count: Number.NaN, attachments: Number.MAX_SAFE_INTEGER + 2, content_type: 'Text', status: 'finished_partial_completion',
      },
      { ...reply, parent: ROOT, when: '2026-13-10T14:00:31.871Z', model_slug: 'GPT 5', status: 7, content_type: null },
    ],
    metadata: {
      ...metadata, conversation_id: 'chat one', create_time: T0 * 1000, default_model_slug: 'GPT-5', is_starred: false, is_archived: 'no', memory_scope: 7,
      current_node: nodeId(99), gizmo_type: 'Snorlax', title_hash: 'F'.repeat(64),
      mapping: {
        ...mapping,
        [nodeId(10)]: { ...mapping[nodeId(10)], message: { ...(mapping[nodeId(10)].message as Json), status: 'Finished Successfully' } },
        [nodeId(4)]: {
          id: 'node four', parent: nodeId(3), children: ['x', nodeId(3)], message: {
            author: { role: 'Assistant', name: 7 }, create_time: '1', status: 'finished_partial_completion', weight: 'heavy', end_turn: 'yes', recipient: 'All',
            channel: 'final answer', content_type: 'TEXT', metadata: { request_id: 'request 1', model_slug: 'GPT', finished_duration_sec: Number.POSITIVE_INFINITY },
          },
        },
      },
    },
  });
  assert.deepEqual((odd.turns as Json[])[0], {
    ...user, identifier: null, parent: null, when: null, on_current_branch: null, text_chars: null, text_words: null, citation_count: null,
    search_result_count: null, attachments: null, content_type: 'unrecognised', status: 'unrecognised',
  });
  assert.deepEqual((odd.turns as Json[])[1], { ...reply, parent: ROOT, when: null, model_slug: 'unrecognised', status: null, content_type: null });
  const kept = odd.metadata as Json;
  assert.deepEqual(
    [kept.conversation_id, kept.create_time, kept.default_model_slug, kept.is_starred, kept.is_archived, kept.memory_scope, kept.current_node, kept.gizmo_type, kept.title_hash],
    [null, null, 'unrecognised', null, null, null, null, 'unrecognised', null],
  );
  const nodes = kept.mapping as Record<string, Json>;
  // The tree's status is a type name, so a lowercase server value stays; a turn's is the closed set.
  assert.equal((nodes[nodeId(10)].message as Json).status, 'unrecognised');
  assert.deepEqual(nodes[nodeId(4)], {
    id: null, parent: nodeId(3), children: [null, nodeId(3)], message: {
      author: { role: 'unrecognised', name: null }, create_time: null, update_time: null, status: 'finished_partial_completion', weight: null, end_turn: null,
      recipient: 'unrecognised', channel: 'unrecognised', content_type: 'unrecognised', metadata: { request_id: null, model_slug: 'unrecognised', finished_duration_sec: null },
    },
  });
});

test('summary metadata keeps its twelve keys, each only in its form', () => {
  const out = redact({
    ...SUMMARY,
    metadata: {
      ...(SUMMARY.metadata as Json), create_time: '2026-13-08T13:48:43Z', update_time: 1788875383.781, pinned_time: '2026-09-08T13:48:43+05:30', is_archived: 'false',
      is_starred: false, is_temporary_chat: 1, is_do_not_remember: null, memory_scope: 'Global', async_status: 'queued', title_hash: 'f'.repeat(63),
      gizmo_id_hash: 'f'.repeat(64), conversation_template_id_hash: 7,
    },
  });
  assert.deepEqual(out.metadata, {
    create_time: null, update_time: null, is_archived: null, is_starred: null, pinned_time: '2026-09-08T13:48:43+05:30', is_temporary_chat: null, is_do_not_remember: null,
    memory_scope: 'unrecognised', async_status: 'queued', title_hash: null, gizmo_id_hash: 'f'.repeat(64), conversation_template_id_hash: null,
  });
});

test('every metadata key is written, null where the record has none, in the builders\' order', () => {
  for (const record of [SUMMARY, DETAIL]) {
    const nulls = Object.fromEntries(Object.keys(record.metadata as Json).map((key) => [key, key === 'mapping' ? {} : null]));
    assert.equal(JSON.stringify(redact({ ...record, metadata: {} }).metadata), JSON.stringify(nulls), `is_summary ${String(record.is_summary)}`);
  }
});

test('a turn that is not an object is dropped, and the turns read incomplete', () => {
  const out = redact({ ...DETAIL, turns: [...(DETAIL.turns as Json[]), MARK, [MARK], null] });
  assert.deepEqual([plain(out.turns), out.turns_complete], [plain(DETAIL.turns), false]);
  assert.equal(wire(out).includes(MARK), false);
});

test('a mapping entry whose key is no node id is dropped, and a link naming it reads null', () => {
  const metadata = DETAIL.metadata as Json;
  const mapping = metadata.mapping as Record<string, Json>;
  const odd = `${MARK} node`;
  const out = redact({
    ...DETAIL,
    metadata: { ...metadata, current_node: odd, mapping: { ...mapping, [nodeId(4)]: { ...mapping[nodeId(4)], children: [odd] }, [odd]: { id: odd, parent: nodeId(4), children: [], message: null } } },
  });
  const kept = out.metadata as Json;
  assert.equal(out.is_summary, false, 'the record was cut to the scaffold');
  assert.deepEqual(Object.keys(kept.mapping as Json), Object.keys(mapping));
  assert.deepEqual([(kept.mapping as Record<string, Json>)[nodeId(4)].children, kept.current_node], [[null], null]);
  assert.equal(wire(out).includes(MARK), false);
});

test('no text gets through: content*, metadata*, a raw tree with message content, a cleartext title, a project item\'s owner and snippet', () => {
  const raw = reasoningDetail();
  const [project] = RECORDS.filter(([what]) => what.includes('project list')).map(([, record]) => record);
  const old = {
    name: 'rex-conversation', platform: 'chatgpt', identifier: CHAT_ID, date: new Date(T0 * 1000), started: new DateString(T0), ended: new DateString(T0),
    turns: Object.values(raw.mapping as Json).map((node) => ({ 'content*': MARK, 'metadata*': node, speaker: 'user' })), metadata: raw,
  };
  const points: Array<[string, Json]> = [
    ['the spider\'s old record', old],
    ['a record whose mapping is the raw tree', { ...DETAIL, metadata: { ...(DETAIL.metadata as Json), mapping: raw.mapping } }],
    ['a record whose metadata is the raw detail', { ...DETAIL, metadata: raw }],
    ['turns carrying content* and metadata*', { ...DETAIL, turns: (DETAIL.turns as Json[]).map((turn) => ({ ...turn, 'content*': MARK, 'metadata*': raw })) }],
    ['a cleartext title', { ...DETAIL, title: MARK, metadata: { ...(DETAIL.metadata as Json), title: MARK } }],
    ['a summary carrying its project item', { ...project, metadata: { ...(project.metadata as Json), ...projectItem(chatId(2)) } }],
  ];
  for (const [what, point] of points) {
    assert.ok(wire(point).includes(MARK), `Test setup invalid: ${what} carries no marker`);
    const out = redact(point);
    assert.equal(wire(out).includes(MARK), false, what);
    // Kept as a record, not cut, so the text was dropped from a record that went out.
    assert.equal(typeof out.is_summary, what === 'the spider\'s old record' ? 'undefined' : 'boolean', what);
  }
});

test('it never throws: a field that throws, a proxy, or no object at all gives the scaffold or nothing', () => {
  const throwing = { ...SUMMARY };
  Object.defineProperty(throwing, 'metadata', { enumerable: true, get: () => { throw new Error(MARK); } });
  const hostile = new Proxy({}, Object.fromEntries(['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map((trap) => [trap, () => { throw new Error(MARK); }])));
  assert.deepEqual(redact(throwing), { date: SUMMARY.date, name: 'rex-conversation', platform: 'chatgpt', identifier: CHAT_ID });
  for (const value of [hostile, null, undefined, 42, MARK, [SUMMARY], Object.create(SUMMARY)]) {
    assert.deepEqual(redact(value), {});
  }
});

// A seeded generator (mulberry32), so every run makes the same departures.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A copy to change: objects and lists copied, a DateString as one, its
// Temporal instant shared, since an instant never changes.
function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy);
  if (value instanceof DateString) return Object.assign(Object.create(DateString.prototype), { value: value.value, originalValue: value.originalValue });
  if (Object.prototype.toString.call(value) !== '[object Object]') return value;
  return Object.fromEntries(Object.entries(value as Json).map(([key, held]) => [key, copy(held)]));
}

// Each place one departure can go: every key of every object and list in a
// record, a DateString's two included, and one key more on each.
function placesOf(value: unknown, path: string[] = []): string[][] {
  if (!Array.isArray(value) && !(value instanceof DateString) && Object.prototype.toString.call(value) !== '[object Object]') return [];
  const keys = Object.keys(value as object);
  return [[...path, Array.isArray(value) ? String(value.length) : `${MARK}_key`], ...keys.flatMap((key) => [[...path, key], ...placesOf((value as Json)[key], [...path, key])])];
}

const PROBES: ReadonlyArray<[string, (() => unknown) | 'delete' | 'throws']> = [
  ['deleted', 'delete'], ['a getter that throws', 'throws'], ['undefined', () => undefined], ['null', () => null], ['an empty string', () => ''],
  ['text', () => `${MARK} text`], ['the marker', () => MARK], ['zero', () => 0], ['minus one', () => -1], ['a fraction', () => 1.5],
  ['not a number', () => Number.NaN], ['infinity', () => Number.POSITIVE_INFINITY], ['an unsafe integer', () => Number.MAX_SAFE_INTEGER + 2], ['true', () => true],
  ['false', () => false], ['an empty object', () => ({})], ['an object holding text', () => ({ text: MARK, 'content*': MARK })], ['an empty list', () => []],
  ['a list holding text', () => [MARK, { title: MARK }]], ['an impossible time', () => '2026-13-08T13:48:43Z'], ['another instant', () => '2026-01-01T00:00:00Z'],
  ['epoch seconds', () => T0], ['epoch ms', () => T0 * 1000], ['a node id', () => nodeId(99)], ['the browser root', () => ROOT], ['a chat id', () => CHAT_ID],
  ['a type name', () => 'unrecognised'], ['a digest', () => 'f'.repeat(64)], ['a digest in capitals', () => 'F'.repeat(64)], ['a long type name', () => 'x'.repeat(65)],
  ['a DateString of text', () => Object.assign(Object.create(DateString.prototype), { value: null, originalValue: `other:${MARK}` })],
  ['a DateString of another instant', () => new DateString(T0 + 1)], ['an instant look-alike', () => ({ toString: () => '2026-01-01T00:00:00Z', toJSON: () => MARK })],
];

function departed(record: Json, path: string[], probe: (() => unknown) | 'delete' | 'throws'): Json {
  const event = copy(record) as Json;
  const target = path.slice(0, -1).reduce((at: Json, key) => at[key] as Json, event);
  const key = path[path.length - 1];
  if (probe === 'delete') delete target[key];
  else if (probe === 'throws') Object.defineProperty(target, key, { enumerable: true, get: () => { throw new Error(MARK); } });
  else target[key] = probe();
  return event;
}

test('2,000 single-field departures from records the builders make: none throws, none lets a marker out, nothing is printed', (t) => {
  const printed: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => printed.push(args.map(String).join(' ')));
  const random = seeded(20261112);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const bases = [SUMMARY, recordOf('project list'), DETAIL, recordOf('a reasoning reply')].map((record): [Json, string[][]] => [record, placesOf(record)]);
  const outcomes = { kept: 0, cut: 0 };
  for (let n = 0; n < 2000; n += 1) {
    const [record, places] = pick(bases);
    const path = pick(places);
    const [probe, value] = pick(PROBES);
    const what = `${String(record.identifier)} ${String(record.is_summary)}: ${path.join('.')} ${probe}`;
    let out: Json = {};
    assert.doesNotThrow(() => { out = redact(departed(record, path, value)); }, what);
    assert.equal(wire(out).includes(MARK), false, what);
    outcomes[typeof out.is_summary === 'boolean' ? 'kept' : 'cut'] += 1;
  }
  assert.deepEqual(printed, []);
  // Both ways out were taken, so the departures reached the record checks and the field forms alike.
  assert.ok(outcomes.kept > 500 && outcomes.cut > 100, JSON.stringify(outcomes));
  t.diagnostic(`${outcomes.kept} kept as records, ${outcomes.cut} cut to the scaffold`);
});
