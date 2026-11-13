import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { DateString } from '@bric/rex-types/types';

import { type Answer } from '../../src/client.mts';
import { type ListItem, walkLists } from '../../src/list.mts';
import { type Hash, buildDetailRecord, buildSummaryRecord } from '../../src/record.mts';
import { redactChatGPT } from '../../src/redact.mts';
import { skeletonOf } from '../../src/skeleton.mts';
import {
  CHAT_ID, LIST_CREATED, LIST_UPDATED, MARK, PROJECT_ID, ROOT, T0, answer, attachment, detail, editedFirstPromptDetail, group, hiddenContext, imagePart, listItem,
  nodeId, nodeOf, oddTree, projectItem, prompt, reasoningDetail, reference, searchCall, systemMessage, toolResult, tree,
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

// The builders' record as the one id rule leaves it: a mapping entry whose
// key is outside the rule is gone and the turns read incomplete, and a
// turn's identifier or parent, or current_node, outside it reads null.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inIdForm = (id: unknown): boolean => id === ROOT || (typeof id === 'string' && UUID_SHAPE.test(id));
function underIdRule(record: Json): Json {
  const expected = plain(record);
  if (expected.is_summary !== false) return expected;
  const metadata = expected.metadata as Json;
  const mapping = metadata.mapping as Json;
  const kept = Object.fromEntries(Object.entries(mapping).filter(([key]) => inIdForm(key)));
  const orNull = (id: unknown) => (inIdForm(id) ? id : null);
  return {
    ...expected,
    turns: (expected.turns as Json[]).map((turn) => ({ ...turn, identifier: orNull(turn.identifier), parent: orNull(turn.parent) })),
    turns_complete: expected.turns_complete === true && Object.keys(kept).length === Object.keys(mapping).length,
    metadata: { ...metadata, current_node: inIdForm(metadata.current_node) && Object.hasOwn(kept, metadata.current_node as string) ? metadata.current_node : null, mapping: kept },
  };
}

const API = 'https://chatgpt.com/backend-api';
// The items the list walk reads when the lists hold these; the sidebar names
// the fixtures' one project.
type Lists = { main?: unknown[]; archived?: unknown[]; starred?: unknown[]; project?: unknown[] };
async function walk(lists: Lists): Promise<{ items: ListItem[]; outcome: string; reason: string }> {
  const pages: Record<string, unknown> = {
    [`${API}/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false`]: { items: lists.main ?? [] },
    [`${API}/conversations?offset=0&limit=28&order=updated&is_archived=true`]: { items: lists.archived ?? [] },
    [`${API}/conversations?offset=0&limit=28&order=updated&is_starred=true`]: { items: lists.starred ?? [] },
    [`${API}/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=28`]: { items: [{ gizmo: { gizmo: { id: PROJECT_ID } } }], cursor: null },
    [`${API}/gizmos/${PROJECT_ID}/conversations?cursor=0`]: { items: lists.project ?? [], cursor: null },
  };
  const client = { get: async (url: string): Promise<Answer> => ({ status: 200, headers: {}, text: JSON.stringify(pages[url] ?? { items: [] }) }) };
  return walkLists(client, { start: null, end: null }, { crawlDelay: () => 0, sleep: async () => {} }, { log: () => {} });
}
async function listed(lists: Lists): Promise<ListItem[]> {
  const result = await walk(lists);
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

const upper = (n: number) => nodeId(n).toUpperCase();
// Each kind of tree, as GET /backend-api/conversation/{id} sends it, with
// every node id in the id form.
const CHATS: ReadonlyArray<[string, () => Json]> = [
  ['the small chat', smallChat],
  ['an edited first prompt', editedFirstPromptDetail],
  ['a reasoning reply', reasoningDetail],
  ['a chat from the app, with no current node', () => detail(tree([nodeId(50), null, null], [nodeId(1), nodeId(50), prompt(nodeId(1), T0 + 1)], [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, MARK)]), undefined)],
  ['no create_time, so no started', () => ({ ...smallChat(), create_time: null })],
  ['a project chat, starred and pinned, with hidden context, an image and an attachment', () => detail(tree(
    [ROOT, null, null],
    [nodeId(11), ROOT, hiddenContext(nodeId(11))],
    [nodeId(1), nodeId(11), { ...prompt(nodeId(1), T0 + 1), content: { content_type: 'multimodal_text', parts: [imagePart(1), `${MARK} see`] }, metadata: { attachments: [attachment(1)] } }],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
  ), nodeId(2), { gizmo_id: `g-p-${MARK}gizmo`, conversation_template_id: `g-p-${MARK}template`, gizmo_type: 'snorlax', is_starred: true, pinned_time: T0 + 3 })],
  ['a child and a parent the tree does not hold', () => {
    const missing = detail(tree(
      [ROOT, null, null], [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)], [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, MARK)], [nodeId(5), nodeId(4), prompt(nodeId(5), T0 + 5)],
    ), nodeId(2));
    (nodeOf(missing.mapping as Json, nodeId(2)).children as string[]).push(nodeId(9));
    return missing;
  }],
  ['a message that cannot be read', () => detail(tree([ROOT, null, null], [nodeId(1), ROOT, { ...prompt(nodeId(1), T0 + 1), author: { role: 7 } }], [nodeId(2), nodeId(1), prompt(nodeId(2), T0 + 2)]), nodeId(2))],
  ['node ids in capitals', () => detail(tree([ROOT, null, null], [upper(1), ROOT, prompt(upper(1), T0 + 1)], [upper(2), upper(1), answer(upper(2), T0 + 2, MARK)]), upper(2))],
  // A null node, a node of no form, children null, an author that is null or
  // a string, metadata that is not an object: shapes the skeleton keeps.
  ['the odd nodes, under keys of the id form', () => detail(oddTree(nodeId), nodeId(1))],
];

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
  const details = await Promise.all(CHATS.map(async ([what, chat]): Promise<[string, Json]> => [`detail: ${what}`, await detailOf(chat())]));
  return [...summaries, ...details];
}
const RECORDS = await fixtureRecords();
const recordOf = (what: string): Json => (RECORDS.find(([name]) => name.includes(what)) ?? assert.fail(`no record ${what}`))[1];
const SUMMARY = recordOf(`main list, ${CHAT_ID}`);
const DETAIL = recordOf('the small chat');

// What the case makes of a raw tree put in a record's mapping, and the
// skeleton the builder writes for that tree, as the id rule leaves it: the
// two must agree, so the case's forms are the builder's. The case never
// reads a message's content, so content_type, which the builder takes from
// content, reads null on a raw tree.
const mappingOf = (tree: unknown): unknown => (redact({ ...DETAIL, metadata: { ...(DETAIL.metadata as Json), mapping: tree } }).metadata as Json).mapping;
const skeletonUnderIdRule = (tree: unknown): Json => Object.fromEntries(Object.entries(skeletonOf(tree)).filter(([key]) => inIdForm(key)).map(([key, node]) => {
  const message = (node as Json | null)?.message as Json | null | undefined;
  return [key, message ? { ...(node as Json), message: { ...message, content_type: null } } : node];
}));

test('every record the builders make on the fixtures comes back equal, as built and as the walker leaves its times', () => {
  assert.equal(RECORDS.length, 16, 'Test setup invalid: a fixture record is missing');
  const odd = Object.values(((recordOf('the odd nodes').metadata as Json).mapping) as Record<string, Json | null>);
  const messages = odd.map((node) => node?.message as Json | null | undefined).filter((message) => message);
  assert.ok(
    odd.includes(null) && odd.some((node) => node?.children === null) && messages.some((message) => isDeepStrictEqual(message?.author, { role: null, name: null }))
      && messages.some((message) => isDeepStrictEqual(message?.metadata, {})),
    'Test setup invalid: the odd tree\'s record lacks a null node, children null, an empty author or empty message metadata',
  );
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
      // As objects too, where a key whose value is undefined still shows.
      assert.deepEqual([Object.keys(out).sort(), out.turns, out.metadata], [Object.keys(record).sort(), record.turns, record.metadata], `${what}, ${form}: keys`);
      // Turn keys go in the standard's order, and metadata in the builders'.
      assert.equal(JSON.stringify([out.turns, out.metadata]), JSON.stringify([record.turns, record.metadata]), `${what}, ${form}: key order`);
      assert.ok(out.ended instanceof DateString && (record.started === undefined || out.started instanceof DateString), `${what}, ${form}: a time is not a DateString`);
    }
  }
});

test('a raw tree in the mapping comes back as the skeleton the builder writes for it, as the id rule leaves it', () => {
  const trees: Array<[string, unknown]> = [...CHATS.map(([what, chat]): [string, unknown] => [what, chat().mapping]), ['the odd nodes, under their own keys', oddTree()]];
  for (const [what, tree] of trees) {
    assert.deepEqual(mappingOf(tree), skeletonUnderIdRule(tree), what);
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
      ...metadata, conversation_id: 'chat one', create_time: T0 * 1000, update_time: 5, default_model_slug: 'GPT-5', is_starred: false, is_archived: 'no', memory_scope: 7,
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
    [kept.conversation_id, kept.create_time, kept.update_time, kept.default_model_slug, kept.is_starred, kept.is_archived, kept.memory_scope, kept.current_node, kept.gizmo_type, kept.title_hash],
    [null, null, null, 'unrecognised', null, null, null, null, 'unrecognised', null],
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

// Text glued to a value otherwise in form, before or after it, or after a
// space or a newline: each form is anchored at both ends, so none is kept.
const riders = (value: string): string[] => [`${MARK}${value}`, `${value}${MARK}`, `${value} ${MARK}`, `${value}\n${MARK}`];
// Temporal.Instant, as rex-types reads with it: it takes an annotation such
// as [x=MARKER] after the Z and ignores it, so only the shape stops one.
const temporalReads = (text: string): boolean => {
  try {
    ((new DateString(LIST_CREATED).value as object).constructor as unknown as { from(item: string): unknown }).from(text);
    return true;
  } catch {
    return false;
  }
};

test('text riding on a value otherwise in form is not kept: ids, keys and links null or dropped, digests and times null, a long type name unrecognised', () => {
  const [user, reply] = DETAIL.turns as Json[];
  const metadata = DETAIL.metadata as Json;
  const mapping = metadata.mapping as Record<string, Json>;
  const node = mapping[nodeId(4)];
  const message = node.message as Json;
  for (const odd of [...riders(nodeId(4)), ...riders(ROOT)]) {
    const out = redact({
      ...DETAIL,
      turns: [{ ...user, identifier: odd, parent: odd }, reply],
      metadata: {
        ...metadata, conversation_id: odd, current_node: odd,
        mapping: {
          ...mapping, [odd]: { ...node },
          [nodeId(4)]: { ...node, id: odd, parent: odd, children: [odd], message: { ...message, metadata: { ...(message.metadata as Json), request_id: odd, turn_exchange_id: odd, working_turn_id: odd } } },
        },
      },
    });
    const kept = out.metadata as Json;
    const nodes = kept.mapping as Record<string, Json>;
    const held = nodes[nodeId(4)];
    const ids = (held.message as Json).metadata as Json;
    assert.deepEqual(
      [(out.turns as Json[])[0].identifier, (out.turns as Json[])[0].parent, kept.conversation_id, kept.current_node, held.id, held.parent, held.children, ids.request_id, ids.turn_exchange_id, ids.working_turn_id, Object.hasOwn(nodes, odd)],
      [null, null, null, null, null, null, [null], null, null, null, false],
      JSON.stringify(odd),
    );
    assert.deepEqual(redact({ ...SUMMARY, identifier: odd }), { date: SUMMARY.date, name: 'rex-conversation', platform: 'chatgpt' }, JSON.stringify(odd));
  }
  const ended = SUMMARY.ended as DateString;
  const annotated = `${LIST_UPDATED}[x=${MARK}]`;
  assert.ok(temporalReads(annotated), 'Test setup invalid: Temporal no longer reads an annotated time, so this cannot see a shape check go');
  for (const time of [...riders(LIST_UPDATED), annotated]) {
    const out = redact({ ...SUMMARY, metadata: { ...(SUMMARY.metadata as Json), create_time: time, update_time: time, pinned_time: time } });
    const kept = out.metadata as Json;
    assert.deepEqual([kept.create_time, kept.update_time, kept.pinned_time], [null, null, null], JSON.stringify(time));
    assert.deepEqual(redact({ ...SUMMARY, ended: { value: ended.value, originalValue: `other:${time}` } }), { date: SUMMARY.date, name: 'rex-conversation', platform: 'chatgpt', identifier: CHAT_ID }, JSON.stringify(time));
  }
  for (const digest of riders('f'.repeat(64))) {
    for (const record of [SUMMARY, DETAIL]) {
      const kept = redact({ ...record, metadata: { ...(record.metadata as Json), title_hash: digest, gizmo_id_hash: digest, conversation_template_id_hash: digest } }).metadata as Json;
      assert.deepEqual([kept.title_hash, kept.gizmo_id_hash, kept.conversation_template_id_hash], [null, null, null], JSON.stringify(digest));
    }
  }
  // 64 characters is a type name; 65 is not.
  const [long, longest] = ['a'.repeat(64), 'a'.repeat(65)];
  const out = redact({
    ...DETAIL,
    turns: [user, { ...reply, model_slug: longest, content_type: long }],
    metadata: { ...metadata, memory_scope: longest, gizmo_type: long, mapping: { ...mapping, [nodeId(4)]: { ...node, message: { ...message, recipient: longest, channel: long } } } },
  });
  const kept = out.metadata as Json;
  const held = (kept.mapping as Record<string, Json>)[nodeId(4)].message as Json;
  assert.deepEqual(
    [(out.turns as Json[])[1].model_slug, (out.turns as Json[])[1].content_type, kept.memory_scope, kept.gizmo_type, held.recipient, held.channel],
    ['unrecognised', long, 'unrecognised', long, 'unrecognised', long],
  );
});

test('a key held only through the prototype reads as missing', () => {
  const kept = redact({ ...SUMMARY, metadata: Object.create(SUMMARY.metadata as object) }).metadata as Json;
  assert.deepEqual(kept, Object.fromEntries(Object.keys(SUMMARY.metadata as Json).map((key) => [key, null])));
  assert.equal(redact({ ...DETAIL, turns: [Object.create((DETAIL.turns as Json[])[0]), (DETAIL.turns as Json[])[1]] }).is_summary, undefined, 'a turn whose keys are all inherited was kept');
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
    const metadata = redact({ ...record, metadata: {} }).metadata as Json;
    // As objects, so a key whose value is undefined still shows.
    assert.deepEqual([Object.keys(metadata), metadata], [Object.keys(nulls), nulls], `is_summary ${String(record.is_summary)}`);
  }
});

test('a turn that is not an object is dropped, and the turns read incomplete', () => {
  const out = redact({ ...DETAIL, turns: [...(DETAIL.turns as Json[]), MARK, [MARK], null] });
  assert.deepEqual([plain(out.turns), out.turns_complete], [plain(DETAIL.turns), false]);
  assert.equal(wire(out).includes(MARK), false);
});

test('a mapping entry whose key is no node id is dropped, a link naming it reads null, and the turns read incomplete', () => {
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
  assert.deepEqual([(kept.mapping as Record<string, Json>)[nodeId(4)].children, kept.current_node, out.turns_complete], [[null], null, false]);
  assert.equal(wire(out).includes(MARK), false);
});

// A node id of another form, in the builders' record of a whole tree: the
// turn below it would read parent null, as a first turn does.
test('a turn under a node the id rule drops reads parent null, and the turns read incomplete', async () => {
  const chat = detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, MARK)],
    ['msg_0002', nodeId(2), prompt('msg_0002', T0 + 3)],
    [nodeId(4), 'msg_0002', answer(nodeId(4), T0 + 4, MARK)],
  ), nodeId(4));
  const record = await detailOf(chat);
  assert.equal(record.turns_complete, true, 'Test setup invalid: the builder already says the turns are incomplete');
  const out = redact(record);
  assert.deepEqual((out.turns as Json[]).map((turn) => [turn.identifier, turn.parent]), [[nodeId(1), null], [nodeId(2), nodeId(1)], [null, nodeId(2)], [nodeId(4), null]]);
  assert.equal(out.turns_complete, false);
});

// A copy with the marker in every leaf: after each string, in place of each
// null, and in each empty list and empty object. Numbers and flags stay.
function markLeaves(value: unknown): unknown {
  if (typeof value === 'string') return `${value}${MARK}`;
  if (value === null) return MARK;
  if (Array.isArray(value)) return value.length === 0 ? [MARK] : value.map(markLeaves);
  if (typeof value === 'object') return Object.keys(value).length === 0 ? { text: MARK } : Object.fromEntries(Object.entries(value).map(([key, held]) => [key, markLeaves(held)]));
  return value;
}

test('no text gets through: content*, metadata*, a raw tree marked in every leaf, a cleartext title, a project item\'s owner and snippet', () => {
  const raw = markLeaves(reasoningDetail()) as Json;
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

// Values JSON can carry, each in or out of a form some field is held to.
const RAW_VALUES: readonly unknown[] = [
  null, 0, -1, 1.5, 5, T0, T0 * 1000, true, false, '', 'x', MARK, `${MARK} text`, 'Text', 'text', 'gpt-5', 'user', 'assistant', 'tool', 'system',
  'all', 'web', 'finished_successfully', 'in_progress', 'finished_partial_completion', 'thoughts', 'multimodal_text', ROOT, nodeId(1), nodeId(4),
  nodeId(99), upper(5), 'msg_0002', `${nodeId(5)}${MARK}`, `${ROOT}${MARK}`, LIST_CREATED, '2026-13-08T13:48:43Z', '2026-09-08T13:48:43+05:30',
  `${LIST_CREATED}[x=${MARK}]`, 'f'.repeat(64), `${'f'.repeat(64)}${MARK}`, 'x'.repeat(65), [], [MARK], [nodeId(1)], {}, { text: MARK }, { role: 'user' },
  { content_type: 'text', parts: [MARK] },
];
const NEW_KEYS = [nodeId(98), upper(3), 'msg_0003', `${MARK} key`, ROOT];

// One or two departures from a raw chat or list item, as JSON can make
// them: a value set anywhere (the chat's own id left alone), a key deleted,
// or a mapping key renamed, its links as they were.
function departRaw(raw: Json, random: () => number): Json {
  const event = JSON.parse(JSON.stringify(raw)) as Json;
  for (let n = 1 + Math.floor(random() * 2); n > 0; n -= 1) {
    const places = placesOf(event).filter((path) => path.length > 1 || (path[0] !== 'id' && path[0] !== 'conversation_id'));
    const path = places[Math.floor(random() * places.length)];
    const target = path.slice(0, -1).reduce((at: Json, key) => at[key] as Json, event);
    const key = path[path.length - 1];
    const roll = random();
    if (roll < 0.15) {
      delete target[key];
    } else if (roll < 0.3 && path[path.length - 2] === 'mapping' && Object.hasOwn(target, key)) {
      const name = NEW_KEYS[Math.floor(random() * NEW_KEYS.length)];
      target[name] = target[key];
      if (name !== key) delete target[key];
    } else {
      target[key] = RAW_VALUES[Math.floor(random() * RAW_VALUES.length)];
    }
  }
  return JSON.parse(JSON.stringify(event)) as Json;
}

test('2,000 seeded departures of the raw chats and list items: every record the builders make comes back as the id rule leaves it', async (t) => {
  const random = seeded(20261113);
  const chats: ReadonlyArray<[string, () => Json]> = [...CHATS, ['the odd nodes, under their own keys', () => detail(oddTree(), nodeId(1))]];
  const lists: ReadonlyArray<[keyof Lists, () => Json]> = [
    ['main', () => listItem(CHAT_ID)], ['project', () => projectItem(CHAT_ID)], ['archived', () => listItem(CHAT_ID, { is_archived: true })],
    ['starred', () => listItem(CHAT_ID, { is_starred: true, pinned_time: LIST_CREATED })],
  ];
  const tally = { details: 0, summaries: 0, none: 0, changed: 0 };
  for (let n = 0; n < 2000; n += 1) {
    let record: Json | null;
    let what: string;
    if (random() < 0.75) {
      const [name, chat] = chats[Math.floor(random() * chats.length)];
      what = `departure ${n} of ${name}`;
      const raw = departRaw(chat(), random);
      assert.deepEqual(mappingOf(raw.mapping), skeletonUnderIdRule(raw.mapping), `${what}: its raw tree in the mapping`);
      record = await buildDetailRecord(raw, MAIN_ITEM, hash);
    } else {
      const [list, item] = lists[Math.floor(random() * lists.length)];
      what = `departure ${n} of a ${list} list item`;
      const [listedItem] = (await walk({ [list]: [departRaw(item(), random)] })).items;
      record = listedItem === undefined ? null : await buildSummaryRecord(listedItem, hash);
    }
    if (record === null) {
      tally.none += 1;
      continue;
    }
    tally[record.is_summary === true ? 'summaries' : 'details'] += 1;
    const expected = underIdRule(record);
    if (!isDeepStrictEqual(expected, plain(record))) tally.changed += 1;
    const out = redact(record);
    assert.deepEqual(plain(out), expected, what);
    assert.deepEqual([Object.keys(out).sort(), out.turns, out.metadata], [Object.keys(expected).sort(), expected.turns, expected.metadata], `${what}: keys`);
    assert.equal(JSON.stringify([out.turns, out.metadata]), JSON.stringify([expected.turns, expected.metadata]), `${what}: key order`);
    assert.equal(wire(out).includes(MARK), false, what);
  }
  t.diagnostic(`${tally.details} details and ${tally.summaries} summaries, ${tally.changed} of them changed by the id rule; ${tally.none} departures gave no record`);
  assert.ok(tally.details > 1000 && tally.summaries > 300 && tally.changed > 50, JSON.stringify(tally));
});

test('the redactor imports nothing but rex-types, so the extension can carry a copy of it', () => {
  const imports = (file: string) => {
    const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
    assert.equal(/\bimport\s*\(|\brequire\s*\(/.test(source), false, `${file} loads a module at run time`);
    return [...source.matchAll(/^import\b[^;]*?from\s+'([^']+)';/gm)].map((match) => match[1]);
  };
  assert.deepEqual(imports('keep.mts'), ['@bric/rex-types/types']);
  assert.deepEqual(imports('redact.mts'), ['@bric/rex-types/types', './keep.mts']);
});
