import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDetail } from '../../src/detail.mts';
import { skeletonOf } from '../../src/skeleton.mts';
import {
  MARK, ROOT, type Spec, T0, answer, attachment, detail, editedFirstPromptDetail, group, hiddenContext, imagePart, nodeId, nodeOf, oddTree, prompt,
  reasoningDetail, recap, searchCall, systemMessage, thinking, toolResult, tree,
} from './fixtures.mts';

type Json = Record<string, unknown>;
type Turn = Record<string, unknown>;

// An ISO instant for whole epoch seconds, made with Date, not with the code
// under test.
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
// The parse, each turn a plain record for the assertions. No text from the
// chat may be in it, whatever the test.
function parse(json: unknown) {
  const parsed = parseDetail(json);
  assert.equal(JSON.stringify(parsed).includes(MARK), false, 'text from the chat is in the parse');
  return { ...parsed, turns: parsed.turns.map((turn): Turn => ({ ...turn })) };
}
const ids = (turns: readonly Turn[]) => turns.map((turn) => turn.identifier);
const shape = (turns: readonly Turn[]) => turns.map((turn) => [turn.identifier, turn.parent, turn.on_current_branch]);

const USER_KEYS = [
  'identifier', 'parent', 'speaker', 'when', 'on_current_branch', 'text_chars', 'text_words', 'citation_count', 'search_result_count',
  'attachments', 'content_type', 'status',
];
const ASSISTANT_KEYS = [...USER_KEYS, 'model_slug', 'nodes'];

// A chat of two prompts and two answers in a line: 1, 2, 3, 4.
const fourInALine = (current = nodeId(4)) => detail(tree(
  [ROOT, null, null],
  [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
  [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer one`)],
  [nodeId(3), nodeId(2), prompt(nodeId(3), T0 + 3)],
  [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} answer two`)],
), current);

test('a prompt and a reasoning reply: one user turn, and one assistant turn that folds the two visible texts', () => {
  const parsed = parse(reasoningDetail());
  assert.deepEqual(parsed.turns, [
    {
      identifier: nodeId(1), parent: null, speaker: 'user', when: '2026-11-10T14:00:05.25Z', on_current_branch: true,
      text_chars: 20, text_words: 4, citation_count: 0, search_result_count: 0, attachments: 0,
      content_type: 'text', status: 'finished_successfully',
    },
    {
      // The last text is the identifier; when is the first text's time; the
      // text of both is counted; the results are the tool message's five,
      // not the answer's rewritten copies, the recap's or the inline copy.
      identifier: nodeId(7), parent: nodeId(1), speaker: 'assistant', when: '2026-11-10T14:00:08.123456Z', on_current_branch: true,
      text_chars: 36, text_words: 7, citation_count: 2, search_result_count: 5, attachments: 0,
      content_type: 'text', status: 'finished_successfully', model_slug: 'gpt-5-thinking', nodes: 2,
    },
  ]);
  assert.equal(parsed.complete, true);
});

test('a turn holds the standard keys in the standard order, then the extras', () => {
  const { turns } = parse(reasoningDetail());
  assert.deepEqual(Object.keys(turns[0]), USER_KEYS);
  assert.deepEqual(Object.keys(turns[1]), ASSISTANT_KEYS);
});

test('a retry: two assistant turns with the same parent, the one off the current branch false', () => {
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} first try`)],
    [nodeId(3), nodeId(1), answer(nodeId(3), T0 + 3, `${MARK} second try`)],
  ), nodeId(3)));
  assert.deepEqual(shape(parsed.turns), [
    [nodeId(1), null, true],
    [nodeId(2), nodeId(1), false],
    [nodeId(3), nodeId(1), true],
  ]);
  assert.equal(parsed.complete, true);
});

test('an edited prompt: two user turns with the same parent, the old one and its reply false', () => {
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
    [nodeId(3), nodeId(2), prompt(nodeId(3), T0 + 3, `${MARK} before the edit`)],
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} old answer`)],
    [nodeId(5), nodeId(2), prompt(nodeId(5), T0 + 5, `${MARK} after the edit`)],
    [nodeId(6), nodeId(5), answer(nodeId(6), T0 + 6, `${MARK} new answer`)],
  ), nodeId(6)));
  assert.deepEqual(shape(parsed.turns), [
    [nodeId(1), null, true],
    [nodeId(2), nodeId(1), true],
    [nodeId(3), nodeId(2), false],
    [nodeId(4), nodeId(3), false],
    [nodeId(5), nodeId(2), true],
    [nodeId(6), nodeId(5), true],
  ]);
});

test('system and hidden messages are not turns, and the next turn\'s parent passes over them', () => {
  const hiddenCopy = answer(nodeId(12), T0 + 2.5, `${MARK} hidden copy`, { metadata: { is_visually_hidden_from_conversation: true } });
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(10), ROOT, systemMessage(nodeId(10))],
    [nodeId(11), nodeId(10), hiddenContext(nodeId(11))],
    [nodeId(1), nodeId(11), prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
    [nodeId(12), nodeId(2), hiddenCopy],
    [nodeId(3), nodeId(12), prompt(nodeId(3), T0 + 3)],
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} answer`)],
  ), nodeId(4)));
  assert.deepEqual(shape(parsed.turns), [
    [nodeId(1), null, true],
    [nodeId(2), nodeId(1), true],
    [nodeId(3), nodeId(2), true],
    [nodeId(4), nodeId(3), true],
  ]);
  assert.deepEqual(parsed.turns.map((turn) => turn.nodes ?? null), [null, 1, null, 1]);
  assert.equal(parsed.complete, true);
});

test('on_current_branch is null on every turn when current_node is absent or not in the mapping', () => {
  const absent = fourInALine();
  delete absent.current_node;
  for (const [what, chat] of [['absent', absent], ['not in the mapping', fourInALine(nodeId(99))]] as const) {
    const parsed = parse(chat);
    assert.deepEqual(parsed.turns.map((turn) => turn.on_current_branch), [null, null, null, null], what);
    assert.equal(parsed.complete, true, 'a current node is not part of the tree being whole');
  }
  const notAString = parse({ ...fourInALine(), current_node: 4 });
  assert.deepEqual(notAString.turns.map((turn) => turn.on_current_branch), [null, null, null, null]);
});

test('on_current_branch is null on every turn when the parent links from current_node loop', () => {
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
    [nodeId(20), nodeId(21), prompt(nodeId(20), T0 + 3)],
    [nodeId(21), nodeId(20), answer(nodeId(21), T0 + 4, `${MARK} answer in a loop`)],
  ), nodeId(21)));
  assert.deepEqual(shape(parsed.turns), [[nodeId(1), null, null], [nodeId(2), nodeId(1), null]]);
  // The messages in the loop hang from no root, so they could not be read.
  assert.equal(parsed.complete, false);
});

test('on_current_branch is null on every turn when the path from current_node reaches a node that could not be read', () => {
  const mapping = tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
    [nodeId(30), nodeId(2), prompt(nodeId(30), T0 + 2.5)],
    [nodeId(3), nodeId(30), prompt(nodeId(3), T0 + 3)],
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} answer`)],
  );
  delete nodeOf(mapping, nodeId(30)).children;
  const parsed = parse(detail(mapping, nodeId(4)));
  // A turn below the unread node names it as its parent: it may have been a turn.
  assert.deepEqual(shape(parsed.turns), [[nodeId(1), null, null], [nodeId(2), nodeId(1), null], [nodeId(3), nodeId(30), null], [nodeId(4), nodeId(3), null]]);
  assert.equal(parsed.complete, false);
});

test('a child the tree names but does not hold: the rest is read, and the turns are not complete', () => {
  const chat = fourInALine();
  (nodeOf(chat.mapping as Json, nodeId(4)).children as string[]).push(nodeId(9));
  const parsed = parse(chat);
  assert.deepEqual(shape(parsed.turns), [[nodeId(1), null, true], [nodeId(2), nodeId(1), true], [nodeId(3), nodeId(2), true], [nodeId(4), nodeId(3), true]]);
  assert.equal(parsed.complete, false);
});

test('a parent the tree does not hold: the turns below it are read and name it, and the turns are not complete', () => {
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
    [nodeId(3), nodeId(8), prompt(nodeId(3), T0 + 3)],
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} answer`)],
  ), nodeId(2)));
  assert.deepEqual(shape(parsed.turns), [[nodeId(1), null, true], [nodeId(2), nodeId(1), true], [nodeId(3), nodeId(8), false], [nodeId(4), nodeId(3), false]]);
  assert.equal(parsed.complete, false);
});

test('a mapping with no root, empty or not, is not complete', () => {
  assert.equal(parse(detail({}, undefined)).complete, false);
  const rootless = tree([nodeId(1), nodeId(8), prompt(nodeId(1), T0 + 1)], [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)]);
  assert.equal(parse(detail(rootless, nodeId(2))).complete, false);
});

test('a user or assistant message that cannot be read is no turn, and the turns are not complete', () => {
  const breaks: Array<[string, (mapping: Json) => void]> = [
    ['an answer with no recipient', (mapping) => delete (nodeOf(mapping, nodeId(2)).message as Json).recipient],
    ['an answer to all with no content', (mapping) => delete (nodeOf(mapping, nodeId(2)).message as Json).content],
    ['an answer to all with no content type', (mapping) => ((nodeOf(mapping, nodeId(2)).message as Json).content = { parts: [`${MARK} x`] })],
    ['a message with no author', (mapping) => delete (nodeOf(mapping, nodeId(2)).message as Json).author],
    ['a message whose metadata is a string', (mapping) => ((nodeOf(mapping, nodeId(2)).message as Json).metadata = `${MARK} x`)],
    ['a node whose id is not its key', (mapping) => (nodeOf(mapping, nodeId(2)).id = nodeId(77))],
    ['a node with no message key', (mapping) => delete nodeOf(mapping, nodeId(2)).message],
    ['a node whose message is a string', (mapping) => (nodeOf(mapping, nodeId(2)).message = `${MARK} x`)],
    ['a node whose parent is a number', (mapping) => (nodeOf(mapping, nodeId(2)).parent = 1)],
    ['a node whose children hold a number', (mapping) => (nodeOf(mapping, nodeId(2)).children = [3])],
    ['a node that is null', (mapping) => (mapping[nodeId(2)] = null)],
  ];
  for (const [what, breakIt] of breaks) {
    const chat = fourInALine();
    breakIt(chat.mapping as Json);
    const parsed = parse(chat);
    assert.deepEqual(ids(parsed.turns), [nodeId(1), nodeId(3), nodeId(4)], what);
    assert.equal(parsed.complete, false, what);
  }
});

test('a prompt with no content is still a turn, with its text counts null', () => {
  const chat = fourInALine();
  delete (nodeOf(chat.mapping as Json, nodeId(3)).message as Json).content;
  const parsed = parse(chat);
  assert.deepEqual(ids(parsed.turns), [nodeId(1), nodeId(2), nodeId(3), nodeId(4)]);
  assert.deepEqual([parsed.turns[2].text_chars, parsed.turns[2].text_words, parsed.turns[2].content_type], [null, null, null]);
  assert.equal(parsed.complete, true);
});

test('order: oldest first by time, and a message before its child on a tie, whatever the mapping\'s order', () => {
  const parsed = parse(detail(tree(
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 30, `${MARK} answer`)],
    [nodeId(3), nodeId(2), prompt(nodeId(3), T0 + 20)],
    [nodeId(5), nodeId(1), answer(nodeId(5), T0 + 15, `${MARK} retry`)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 10, `${MARK} same second as its prompt`)],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 10)],
    [ROOT, null, null],
  ), nodeId(4)));
  assert.deepEqual(ids(parsed.turns), [nodeId(1), nodeId(2), nodeId(5), nodeId(3), nodeId(4)]);
});

test('a turn with no time goes after those with one', () => {
  const chat = fourInALine();
  (nodeOf(chat.mapping as Json, nodeId(1)).message as Json).create_time = null;
  assert.deepEqual(ids(parse(chat).turns), [nodeId(2), nodeId(3), nodeId(4), nodeId(1)]);
});

test('when is the message\'s create_time to the microsecond, without the float\'s rounding, and null when it is not epoch seconds', () => {
  const at = (time: unknown) => {
    const chat = fourInALine();
    (nodeOf(chat.mapping as Json, nodeId(1)).message as Json).create_time = time;
    return parse(chat).turns.find((turn) => turn.identifier === nodeId(1))?.when;
  };
  // new DateString(1794319231.871) gives ...31.871000064Z.
  assert.equal(at(T0 + 26.871), '2026-11-10T14:00:31.871Z');
  assert.equal(at(T0 + 0.000001), '2026-11-10T14:00:05.000001Z');
  // 0.99999976 s rounds up to the next whole second.
  assert.equal(at(T0 + 0.99999975), '2026-11-10T14:00:06Z');
  assert.equal(at(T0), '2026-11-10T14:00:05Z');
  for (const time of [null, undefined, '2026-11-10T14:00:05Z', (T0 + 1) * 1000, 12, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(at(time), null, String(time));
  }
});

test('status is the closed set or unrecognised, model_slug a type name or unrecognised, both from the reply\'s last folded message', () => {
  const first = answer(nodeId(2), T0 + 2, `${MARK} first`, { status: 'in_progress', model: 'first-model' });
  const last = answer(nodeId(3), T0 + 3, `${MARK} last`, { status: 'in_progress', model: 'gpt-4o-mini' });
  const reply = (lastMessage: Json) => parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), first],
    [nodeId(3), nodeId(2), lastMessage],
  ), nodeId(3))).turns[1];
  assert.deepEqual([reply(last).status, reply(last).model_slug, reply(last).identifier], ['in_progress', 'gpt-4o-mini', nodeId(3)]);
  assert.equal(reply({ ...last, status: 'cancelled_by_user' }).status, 'unrecognised');
  assert.equal(reply({ ...last, status: 5 }).status, null);
  const noStatus = { ...last };
  delete noStatus.status;
  assert.equal(reply(noStatus).status, null);
  const withModel = (model: unknown) => ({ ...last, metadata: { ...(last.metadata as Json), model_slug: model } });
  assert.equal(reply(withModel('GPT 5 Turbo')).model_slug, 'unrecognised');
  assert.equal(reply(withModel('x'.repeat(65))).model_slug, 'unrecognised');
  assert.equal(reply(withModel(undefined)).model_slug, null);
  assert.equal(reply(withModel(4)).model_slug, null);
});

test('content_type is the message\'s, or the reply\'s last folded message\'s, as a type name', () => {
  const multimodal = { ...prompt(nodeId(1), T0 + 1), content: { content_type: 'multimodal_text', parts: [imagePart(1), `${MARK} see`] } };
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, { ...multimodal, metadata: { attachments: [attachment(1)] } }],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, '', { contentType: 'multimodal_text', parts: [imagePart(2)] })],
  ), nodeId(2)));
  assert.deepEqual(parsed.turns.map((turn) => [turn.content_type, turn.text_chars, turn.attachments]), [['multimodal_text', 10, 1], ['multimodal_text', 0, 0]]);
});

test('a reply that branches after a visible message ends there: each branch is a turn of its own, and no message is in two turns', () => {
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} one two`, { channel: null })],
    [nodeId(3), nodeId(2), searchCall(nodeId(3), T0 + 3)],
    [nodeId(4), nodeId(3), toolResult(nodeId(4), T0 + 4, [group('news', 0, 2)])],
    [nodeId(5), nodeId(4), answer(nodeId(5), T0 + 5, `${MARK} three four five`)],
    [nodeId(6), nodeId(2), searchCall(nodeId(6), T0 + 6)],
    [nodeId(7), nodeId(6), toolResult(nodeId(7), T0 + 7, [group('wiki', 0, 3)])],
    [nodeId(8), nodeId(7), answer(nodeId(8), T0 + 8, `${MARK} three four five`)],
  ), nodeId(8)));
  assert.deepEqual(shape(parsed.turns), [
    [nodeId(1), null, true],
    [nodeId(2), nodeId(1), true],
    [nodeId(5), nodeId(2), false],
    [nodeId(8), nodeId(2), true],
  ]);
  // Each branch counts its own path's results and its own text.
  assert.deepEqual(parsed.turns.map((turn) => [turn.nodes ?? null, turn.text_chars, turn.search_result_count]), [[null, 13, 0], [1, 14, 0], [1, 22, 2], [1, 22, 3]]);
});

test('a retry after a search: both replies hang from the prompt and count the search above the branch', () => {
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), searchCall(nodeId(2), T0 + 2)],
    [nodeId(3), nodeId(2), toolResult(nodeId(3), T0 + 3, [group('news', 0, 2)])],
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} first try`)],
    [nodeId(5), nodeId(3), answer(nodeId(5), T0 + 5, `${MARK} second try`)],
  ), nodeId(5)));
  assert.deepEqual(parsed.turns.map((turn) => [turn.identifier, turn.parent, turn.search_result_count]), [
    [nodeId(1), null, 0],
    [nodeId(4), nodeId(1), 2],
    [nodeId(5), nodeId(1), 2],
  ]);
});

test('a reply counts the searches on its own path only, not an earlier reply\'s', () => {
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), searchCall(nodeId(2), T0 + 2)],
    [nodeId(3), nodeId(2), toolResult(nodeId(3), T0 + 3, [group('news', 0, 2)])],
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} searched`)],
    [nodeId(5), nodeId(4), prompt(nodeId(5), T0 + 5)],
    [nodeId(6), nodeId(5), answer(nodeId(6), T0 + 6, `${MARK} did not search`)],
  ), nodeId(6)));
  assert.deepEqual(parsed.turns.map((turn) => turn.search_result_count), [0, 2, 0, 0]);
});

test('a reply that branches at a search call: the call is on each branch\'s path, so with no results stored each reads null', () => {
  const below = (...specs: Spec[]) => parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} before the search`, { channel: null })],
    [nodeId(3), nodeId(2), searchCall(nodeId(3), T0 + 3, 'web')],
    ...specs,
  ), nodeId(5))).turns.map((turn) => [turn.identifier, turn.parent, turn.search_result_count]);
  // The call itself branches, and no tool message holds its results.
  assert.deepEqual(below(
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} first branch`)],
    [nodeId(5), nodeId(3), answer(nodeId(5), T0 + 5, `${MARK} second branch`)],
  ), [[nodeId(1), null, 0], [nodeId(2), nodeId(1), 0], [nodeId(4), nodeId(2), null], [nodeId(5), nodeId(2), null]]);
  // The branch is below its tool message: both branches count its results.
  assert.deepEqual(below(
    [nodeId(6), nodeId(3), toolResult(nodeId(6), T0 + 3.5, [group('news', 0, 2)])],
    [nodeId(4), nodeId(6), answer(nodeId(4), T0 + 4, `${MARK} first branch`)],
    [nodeId(5), nodeId(6), answer(nodeId(5), T0 + 5, `${MARK} second branch`)],
  ), [[nodeId(1), null, 0], [nodeId(2), nodeId(1), 0], [nodeId(4), nodeId(2), 2], [nodeId(5), nodeId(2), 2]]);
  // A search before the reply's last message is the reply's, not its branches'.
  const branchedAtTheAnswer = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), searchCall(nodeId(2), T0 + 2)],
    [nodeId(3), nodeId(2), toolResult(nodeId(3), T0 + 3, [group('news', 0, 2)])],
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} answer`)],
    [nodeId(5), nodeId(4), answer(nodeId(5), T0 + 5, `${MARK} first branch`)],
    [nodeId(6), nodeId(4), answer(nodeId(6), T0 + 6, `${MARK} second branch`)],
  ), nodeId(6))).turns.map((turn) => [turn.identifier, turn.parent, turn.search_result_count]);
  assert.deepEqual(branchedAtTheAnswer, [[nodeId(1), null, 0], [nodeId(4), nodeId(1), 2], [nodeId(5), nodeId(4), 0], [nodeId(6), nodeId(4), 0]]);
});

test('a system message shown to all is still no turn', () => {
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(10), ROOT, systemMessage(nodeId(10), false)],
    [nodeId(1), nodeId(10), prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
    [nodeId(11), nodeId(2), systemMessage(nodeId(11), false)],
    [nodeId(3), nodeId(11), prompt(nodeId(3), T0 + 3)],
  ), nodeId(3)));
  assert.deepEqual(shape(parsed.turns), [[nodeId(1), null, true], [nodeId(2), nodeId(1), true], [nodeId(3), nodeId(2), true]]);
});

test('the capture\'s edited prompt: two prompts side by side under the root, both with no parent, the old one and its reply false', () => {
  assert.deepEqual(shape(parse(editedFirstPromptDetail()).turns), [
    [nodeId(1), null, false],
    [nodeId(2), nodeId(1), false],
    [nodeId(3), null, true],
    [nodeId(4), nodeId(3), true],
  ]);
});

test('a turn\'s content_type and a prompt\'s status are held to their forms: unrecognised for another string, null for no string', () => {
  const turnsWith = (promptFields: Json, replyType: string) => parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, { ...prompt(nodeId(1), T0 + 1), ...promptFields }],
    [nodeId(2), nodeId(1), { ...answer(nodeId(2), T0 + 2, `${MARK} answer`), content: { content_type: replyType, parts: [`${MARK} answer`] } }],
  ), nodeId(2))).turns;
  const [oddPrompt, oddReply] = turnsWith({ content: { content_type: `Rich ${MARK}`, parts: [`${MARK} x`] }, status: `Cancelled ${MARK}` }, `Rich ${MARK}`);
  assert.deepEqual([oddPrompt.content_type, oddPrompt.status, oddPrompt.text_chars], ['unrecognised', 'unrecognised', null]);
  assert.deepEqual([oddReply.content_type, oddReply.text_chars], ['unrecognised', null]);
  const [notStrings] = turnsWith({ content: { content_type: 7, parts: [`${MARK} x`] }, status: 7 }, 'text');
  assert.deepEqual([notStrings.content_type, notStrings.status, notStrings.text_chars], [null, null, null]);
  // A status that is undefined is one JSON leaves out.
  assert.equal(turnsWith({ status: undefined }, 'text')[0].status, null);
});

test('a reply before any prompt has no parent', () => {
  const parsed = parse(detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, answer(nodeId(1), T0 + 1, `${MARK} greeting`)],
    [nodeId(2), nodeId(1), prompt(nodeId(2), T0 + 2)],
  ), nodeId(2)));
  assert.deepEqual(shape(parsed.turns), [[nodeId(1), null, true], [nodeId(2), nodeId(1), true]]);
});

// A line of `count` messages under the root, prompts and answers taking turns,
// one second apart from T0 + 1, the last the current node.
function line(count: number, idOf: (n: number) => string = nodeId, message = (id: string, k: number) => (k % 2 === 1 ? prompt(id, T0 + k) : answer(id, T0 + k, `${MARK} answer`))) {
  const specs: Spec[] = [[ROOT, null, null]];
  for (let k = 1; k <= count; k += 1) {
    specs.push([idOf(k), k === 1 ? ROOT : idOf(k - 1), message(idOf(k), k)]);
  }
  return { chat: detail(tree(...specs), idOf(count)), ids: specs.slice(1).map((spec) => spec[0]) };
}

test('1,000 messages are all kept, and the turns are complete', () => {
  const { chat, ids: all } = line(1000);
  const parsed = parse(chat);
  assert.deepEqual(ids(parsed.turns), all);
  assert.equal(parsed.complete, true);
});

test('1,001 messages: the newest 1,000 are kept, the turns are not complete, and the skeleton is whole', () => {
  const { chat, ids: all } = line(1001);
  const parsed = parse(chat);
  assert.deepEqual(ids(parsed.turns), all.slice(1));
  // The first kept turn still names the cut one.
  assert.equal(parsed.turns[0].parent, all[0]);
  assert.equal(parsed.complete, false);
  assert.equal(Object.keys(parsed.skeleton).length, 1002);
  assert.deepEqual(Object.keys(parsed.skeleton), Object.keys(chat.mapping as Json));
});

test('turns whose JSON passes 512 KB: the newest that fit are kept, the turns are not complete, and the skeleton is whole', () => {
  // Every turn the same size: prompts only, ids of one length, whole seconds.
  const idOf = (n: number) => `${'a'.repeat(1500)}-${String(n).padStart(6, '0')}`;
  const { chat, ids: all } = line(260, idOf, (id, k) => prompt(id, T0 + k, `${MARK} one two`));
  const parsed = parse(chat);
  const expected = (k: number): Turn => ({
    identifier: idOf(k), parent: idOf(k - 1), speaker: 'user', when: iso(T0 + k), on_current_branch: true,
    text_chars: 14, text_words: 3, citation_count: 0, search_result_count: 0, attachments: 0, content_type: 'text', status: 'finished_successfully',
  });
  const size = JSON.stringify(expected(100)).length;
  // [t,t,...,t] of n turns is n * size + (n - 1) commas + 2 brackets.
  const fits = Math.floor((512 * 1024 - 1) / (size + 1));
  assert.ok(fits < 260, 'Test setup invalid: every turn fits, so nothing is cut');
  assert.deepEqual(parsed.turns, all.slice(260 - fits).map((_, k) => expected(260 - fits + k + 1)));
  assert.ok(JSON.stringify(parsed.turns).length <= 512 * 1024);
  assert.equal(parsed.complete, false);
  assert.equal(Object.keys(parsed.skeleton).length, 261);
});

test('the bound is exact: turns of 512 KB of JSON are all kept, and one character more cuts the oldest', () => {
  const count = 190;
  const base = (n: number) => `${'b'.repeat(1200)}-${String(n).padStart(6, '0')}`;
  const turnOf = (idOf: (n: number) => string, k: number): Turn => ({
    identifier: idOf(k), parent: k === 1 ? null : idOf(k - 1), speaker: 'user', when: iso(T0 + k), on_current_branch: true,
    text_chars: 14, text_words: 3, citation_count: 0, search_result_count: 0, attachments: 0, content_type: 'text', status: 'finished_successfully',
  });
  const expected = (idOf: (n: number) => string) => Array.from({ length: count }, (_, k) => turnOf(idOf, k + 1));
  // The newest message's id is lengthened until the turns' JSON is exactly 512 KB.
  const pad = 512 * 1024 - JSON.stringify(expected(base)).length;
  const exact = (n: number) => (n === count ? `${base(n)}${'c'.repeat(pad)}` : base(n));
  const over = (n: number) => (n === count ? `${base(n)}${'c'.repeat(pad + 1)}` : base(n));
  assert.equal(JSON.stringify(expected(exact)).length, 512 * 1024, 'Test setup invalid: the turns are not exactly at the bound');
  const onePrompt = (id: string, k: number) => prompt(id, T0 + k, `${MARK} one two`);
  const atBound = parse(line(count, exact, onePrompt).chat);
  assert.deepEqual(atBound.turns, expected(exact));
  assert.equal(atBound.complete, true);
  const past = parse(line(count, over, onePrompt).chat);
  assert.deepEqual(past.turns, expected(over).slice(1));
  assert.equal(past.complete, false);
});

test('a body that holds no conversation gives no turns, incomplete, and an empty skeleton', () => {
  for (const body of [null, 'text', 5, [], {}, { mapping: null }, { mapping: 'x' }, { mapping: [] }]) {
    assert.deepEqual(parse(body), { turns: [], complete: false, skeleton: {} }, JSON.stringify(body));
  }
});

// The content processor's code that built the skeleton before this module,
// verbatim but for the function around it: the module keeps the same keys and,
// for a value in its form, the same value. It is compared on fixtures whose
// values are all in their forms: on a value out of its form the module writes
// null or 'unrecognised', where this code copied the value as it came.
/* eslint-disable @typescript-eslint/no-explicit-any */
const CHATGPT_MSG_META_KEEP = new Set([
  'model_slug', 'resolved_model_slug', 'message_type', 'finished_duration_sec',
  'reasoning_start_time', 'reasoning_end_time', 'thinking_effort',
  'request_id', 'working_turn_id', 'turn_exchange_id',
]);
function previousSkeleton(md: any): any {
  const mapping = md.mapping || {};
  const skeleton: any = {};
  for (const id of Object.keys(mapping)) {
    const node = mapping[id];
    if (!node) { skeleton[id] = node; continue; }

    const sn: any = { id: node.id, parent: node.parent, children: node.children };
    const m = node.message;

    if (m) {
      const meta = m.metadata || {};
      const keptMeta: any = {};
      for (const k of Object.keys(meta)) {
        if (CHATGPT_MSG_META_KEEP.has(k)) keptMeta[k] = meta[k];
      }
      sn.message = {
        author: { role: m.author?.role ?? null, name: m.author?.name ?? null },
        create_time: m.create_time ?? null,
        update_time: m.update_time ?? null,
        status: m.status ?? null,
        weight: m.weight ?? null,
        end_turn: m.end_turn ?? null,
        recipient: m.recipient ?? null,
        channel: m.channel ?? null,
        content_type: m.content?.content_type ?? null, // the KIND only, never the payload
        metadata: keptMeta,
      };
    } else {
      sn.message = null;
    }

    skeleton[id] = sn;
  }
  return skeleton;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

test('the skeleton keeps what the content processor kept, on every fixture', () => {
  const chats = [reasoningDetail(), fourInALine(), line(30).chat, editedFirstPromptDetail()];
  for (const chat of chats) {
    assert.deepEqual(parse(chat).skeleton, previousSkeleton(chat));
  }
});

test('values in their forms reach the skeleton unchanged', () => {
  const { skeleton } = parse(reasoningDetail());
  const at = (n: number) => skeleton[nodeId(n)] as Json;
  assert.deepEqual(at(2), {
    id: nodeId(2),
    parent: nodeId(1),
    children: [nodeId(3)],
    message: {
      author: { role: 'assistant', name: null }, create_time: T0 + 1, update_time: null, status: 'in_progress', weight: 1, end_turn: null,
      recipient: 'all', channel: null, content_type: 'thoughts',
      metadata: {
        turn_exchange_id: 'bbbbbbbb-0000-4000-8000-000000000001', reasoning_start_time: T0 + 0.5, reasoning_end_time: T0 + 1.25,
        thinking_effort: 'high', working_turn_id: 'dddddddd-0000-4000-8000-000000000002',
      },
    },
  });
  const message = (n: number) => at(n).message as Json;
  assert.deepEqual([message(5).recipient, message(5).channel, message(5).content_type], ['web.run', 'commentary', 'text']);
  assert.deepEqual(message(6).author, { role: 'tool', name: 'web.run' });
  assert.deepEqual(message(7).metadata, {
    turn_exchange_id: 'bbbbbbbb-0000-4000-8000-000000000001', model_slug: 'gpt-5-thinking', resolved_model_slug: 'gpt-5-2025', message_type: 'next',
    request_id: 'cccccccc-0000-4000-8000-000000000001', finished_duration_sec: 3,
  });
  // The root, client-created-root, and the first prompt's parent.
  assert.deepEqual([(skeleton[ROOT] as Json).id, (skeleton[ROOT] as Json).parent, at(1).parent], [ROOT, null, ROOT]);
});

test('a status out of the closed set stays in the skeleton as the server wrote it, and reads unrecognised on the turn', () => {
  const statuses = (status: string) => {
    const parsed = parse(detail(tree(
      [ROOT, null, null],
      [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
      [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} cut off`, { status })],
    ), nodeId(2)));
    return [((parsed.skeleton[nodeId(2)] as Json).message as Json).status, parsed.turns[1].status];
  };
  // A server status the turn's closed set does not hold, such as a reply cut off.
  assert.deepEqual(statuses('finished_partial_completion'), ['finished_partial_completion', 'unrecognised']);
  assert.deepEqual(statuses('in_progress'), ['in_progress', 'in_progress']);
  // Spaces or capitals are no server status: stopped in both.
  assert.deepEqual(statuses(`${MARK} cut off here`), ['unrecognised', 'unrecognised']);
  assert.deepEqual(statuses('Finished'), ['unrecognised', 'unrecognised']);
});

test('every value of a message the skeleton copies is held to its form: text planted in any of them never reaches the parse', () => {
  const base = () => detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
    [nodeId(2), nodeId(1), thinking(nodeId(2), T0 + 2)],
    [nodeId(3), nodeId(2), searchCall(nodeId(3), T0 + 3)],
    [nodeId(4), nodeId(3), toolResult(nodeId(4), T0 + 4, [group('news', 0, 1)])],
    [nodeId(5), nodeId(4), answer(nodeId(5), T0 + 5, `${MARK} answer`)],
  ), nodeId(5));
  const text = `${MARK} planted text`;
  const at = (mapping: Json, n: number) => nodeOf(mapping, nodeId(n)).message as Json;
  const KEPT = ['model_slug', 'resolved_model_slug', 'message_type', 'thinking_effort', 'finished_duration_sec', 'reasoning_start_time', 'reasoning_end_time', 'request_id', 'turn_exchange_id', 'working_turn_id'];
  const plants: Array<[string, (mapping: Json) => void]> = [
    ['author.role', (mapping) => ((at(mapping, 4).author as Json).role = text)],
    ['author.name', (mapping) => ((at(mapping, 4).author as Json).name = text)],
    ['recipient', (mapping) => (at(mapping, 3).recipient = text)],
    ['channel', (mapping) => (at(mapping, 5).channel = text)],
    ['status', (mapping) => (at(mapping, 5).status = text)],
    ['content_type', (mapping) => ((at(mapping, 4).content as Json).content_type = text)],
    ['create_time', (mapping) => (at(mapping, 4).create_time = text)],
    ['update_time', (mapping) => (at(mapping, 4).update_time = text)],
    ['weight', (mapping) => (at(mapping, 4).weight = text)],
    ['end_turn', (mapping) => (at(mapping, 5).end_turn = text)],
    ['a time that is an object', (mapping) => (at(mapping, 4).create_time = { text })],
    ...KEPT.map((key): [string, (mapping: Json) => void] => [`metadata.${key}`, (mapping) => ((at(mapping, 5).metadata as Json)[key] = text)]),
    // A bare word passes a looser id form; the capture saw only UUIDs here.
    ...['request_id', 'turn_exchange_id', 'working_turn_id'].map((key): [string, (mapping: Json) => void] => [`metadata.${key} a bare word`, (mapping) => ((at(mapping, 5).metadata as Json)[key] = MARK)]),
  ];
  for (const [what, plant] of plants) {
    const chat = base();
    plant(chat.mapping as Json);
    assert.equal(JSON.stringify(parse(chat).skeleton).includes(MARK), false, what);
  }
});

test('a node\'s id, parent and children reach the skeleton only as node ids: a UUID, or client-created-root', () => {
  const skeleton = skeletonOf({
    [ROOT]: { id: ROOT, parent: null, children: [nodeId(1), nodeId(2).toUpperCase(), `${MARK} child`, 5], message: null },
    [nodeId(1)]: { id: `${MARK} id`, parent: `${MARK} parent`, children: `${MARK} children`, message: null },
    [nodeId(2)]: { id: MARK, parent: { text: MARK }, children: [], message: null },
  });
  assert.deepEqual(skeleton, {
    [ROOT]: { id: ROOT, parent: null, children: [nodeId(1), nodeId(2).toUpperCase(), null, null], message: null },
    [nodeId(1)]: { id: null, parent: null, children: null, message: null },
    [nodeId(2)]: { id: null, parent: null, children: [], message: null },
  });
});

test('the skeleton writes a value out of its form as null, or a type name out of its form as unrecognised', () => {
  const odd = oddTree();
  const none = { create_time: null, update_time: null, status: null, weight: null, end_turn: null, recipient: null, channel: null, content_type: null, metadata: {} };
  assert.deepEqual(parse({ mapping: odd }).skeleton, {
    [ROOT]: { id: ROOT, parent: null, children: [nodeId(1), nodeId(7)], message: null },
    [nodeId(1)]: { id: nodeId(1), parent: ROOT, children: [], message: { ...none, author: { role: null, name: null }, create_time: 0, status: 'unrecognised' } },
    n2: null,
    n3: null,
    n4: null,
    n5: { id: null, parent: null, children: null, message: null },
    [nodeId(7)]: {
      id: nodeId(7), parent: ROOT, children: [],
      message: { ...none, author: { role: 'tool', name: 'web.run' }, weight: 0, end_turn: false, recipient: 'unrecognised', channel: 'unrecognised' },
    },
    [nodeId(8)]: { id: nodeId(8), parent: null, children: null, message: { ...none, author: { role: null, name: null } } },
    [nodeId(9)]: { id: nodeId(9), parent: nodeId(8), children: [], message: null },
  });
});

test('nothing parsed holds text from the chat', () => {
  const chats = [
    reasoningDetail(),
    fourInALine(),
    detail(tree(
      [ROOT, null, null],
      [nodeId(10), ROOT, systemMessage(nodeId(10))],
      [nodeId(11), nodeId(10), hiddenContext(nodeId(11))],
      [nodeId(1), nodeId(11), { ...prompt(nodeId(1), T0 + 1), content: { content_type: 'multimodal_text', parts: [imagePart(1), `${MARK} see`] } }],
      [nodeId(2), nodeId(1), thinking(nodeId(2), T0 + 2)],
      [nodeId(3), nodeId(2), recap(nodeId(3), T0 + 3)],
      [nodeId(4), nodeId(3), searchCall(nodeId(4), T0 + 4, 'web')],
      [nodeId(5), nodeId(4), answer(nodeId(5), T0 + 5, `${MARK} answer`)],
    ), nodeId(5)),
  ];
  for (const chat of chats) {
    assert.equal(JSON.stringify(parse(chat)).includes(MARK), false);
  }
});
