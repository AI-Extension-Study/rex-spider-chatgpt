import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptCounts, replyCounts } from '../../src/counts.mts';
import { MARK, T0, answer, attachment, group, imagePart, nodeId, prompt, recap, reference, searchCall, thinking, toolResult } from './fixtures.mts';

type Json = Record<string, unknown>;

// A copy of a message with its metadata changed.
const withMetadata = (message: Json, metadata: Json): Json => ({ ...message, metadata: { ...(message.metadata as Json), ...metadata } });
const withoutMetadataKey = (message: Json, key: string): Json => {
  const metadata = { ...(message.metadata as Json) };
  delete metadata[key];
  return { ...message, metadata };
};
// A reply of one visible message and nothing else on its path.
const alone = (message: Json) => replyCounts([message], [message]);

// 'MARKER one two' is 14 code points and 3 words; 'MARKER three four five' 22 and 4.
const ONE_TWO = `${MARK} one two`;
const THREE_FOUR_FIVE = `${MARK} three four five`;

test('a prompt counts the string parts of its text', () => {
  assert.deepEqual(promptCounts(prompt(nodeId(1), T0, ONE_TWO)), { text_chars: 14, text_words: 3, citation_count: 0, search_result_count: 0, attachments: 0 });
});

test('a multimodal prompt counts its string parts, not its image parts, and its attachments from metadata.attachments', () => {
  const multimodal = {
    ...prompt(nodeId(1), T0),
    content: { content_type: 'multimodal_text', parts: [imagePart(1), imagePart(2), `${MARK} look at these`] },
  };
  const counted = promptCounts(withMetadata(multimodal, { attachments: [attachment(1), attachment(2)] }));
  assert.deepEqual(counted, { text_chars: 20, text_words: 4, citation_count: 0, search_result_count: 0, attachments: 2 });
});

test('a voice message counts the transcript part and not the audio part', () => {
  const voice = {
    ...prompt(nodeId(1), T0),
    content: {
      content_type: 'multimodal_text',
      parts: [
        { content_type: 'audio_transcription', text: `${MARK} spoken words here`, direction: 'in', decoding_id: null },
        { content_type: 'audio_asset_pointer', asset_pointer: `sediment://${MARK}-audio`, size_bytes: 1000, format: 'wav', metadata: {} },
      ],
    },
  };
  assert.equal(promptCounts(voice).text_chars, 24);
  assert.equal(promptCounts(voice).text_words, 4);
  const spokenReply = { ...answer(nodeId(2), T0, ''), content: voice.content };
  assert.deepEqual([alone(spokenReply).text_chars, alone(spokenReply).text_words], [24, 4]);
});

test('a reply counts the text of every message it folds, and only those', () => {
  const first = answer(nodeId(4), T0 + 3, ONE_TWO);
  const last = answer(nodeId(7), T0 + 7, THREE_FOUR_FIVE);
  // The call and the tool result are on the path with text of their own.
  const path = [thinking(nodeId(2), T0 + 1), recap(nodeId(3), T0 + 2), first, searchCall(nodeId(5), T0 + 4), toolResult(nodeId(6), T0 + 5, []), last];
  const counted = replyCounts([first, last], path);
  assert.deepEqual([counted.text_chars, counted.text_words], [36, 7]);
});

test('a Deep Research report, drawn beside the chat from metadata.chatgpt_sdk.widget_state, is not counted', () => {
  const report = JSON.stringify({ report_message: { content: { parts: [`${MARK} a long report of many words`] } } });
  const envelope = answer(nodeId(4), T0, `{"path": "/${MARK} Deep Research App/start", "args": {}}`, { metadata: { chatgpt_sdk: { widget_state: report } } });
  const empty = answer(nodeId(5), T0, '', { metadata: { chatgpt_sdk: { widget_state: report } } });
  assert.deepEqual([alone(envelope).text_chars, alone(envelope).text_words], [0, 0]);
  assert.deepEqual([alone(empty).text_chars, alone(empty).text_words], [0, 0]);
  // With text beside it, the text is counted and the report is not.
  const withText = replyCounts([answer(nodeId(3), T0, ONE_TWO), envelope], [answer(nodeId(3), T0, ONE_TWO), envelope]);
  assert.deepEqual([withText.text_chars, withText.text_words], [14, 3]);
});

test('with widget_state a string, a part that is empty or the tool call that made the report counts none, and the other parts count', () => {
  const report = JSON.stringify({ report_message: { content: { parts: [`${MARK} a long report of many words`] } } });
  // 25 code points and 2 words when counted as text.
  const toolCall = `{"path": "/${MARK}/start"}`;
  const visible = `${MARK} visible words here`; // 25 code points, 4 words
  const withWidget = (parts: unknown[], widgetState: unknown) => answer(nodeId(4), T0, '', { parts, metadata: { chatgpt_sdk: { widget_state: widgetState } } });
  const count = (message: Json) => [alone(message).text_chars, alone(message).text_words];
  assert.deepEqual(count(withWidget([toolCall], report)), [0, 0]);
  assert.deepEqual(count(withWidget([''], report)), [0, 0]);
  assert.deepEqual(count(withWidget([visible, toolCall, ''], report)), [25, 4]);
  assert.deepEqual(count(withWidget([visible], '{}')), [25, 4]);
  // A widget_state that is null, false or absent changes nothing: every part counts.
  for (const state of [null, false, undefined]) {
    assert.deepEqual(count(withWidget([toolCall, visible], state)), [50, 6], String(state));
  }
});

test('code and execution output are not text, and add nothing', () => {
  const code = { ...answer(nodeId(4), T0, ''), content: { content_type: 'code', language: 'python', text: `print("${MARK}")` } };
  const output = { ...answer(nodeId(5), T0, ''), content: { content_type: 'execution_output', text: `${MARK} output` } };
  const text = answer(nodeId(6), T0, ONE_TWO);
  const counted = replyCounts([code, output, text], [code, output, text]);
  assert.deepEqual([counted.text_chars, counted.text_words], [14, 3]);
});

test('text counts are null when the content, its parts or a part has another form, or the content type is not one the reader sees as text', () => {
  const base = prompt(nodeId(1), T0, ONE_TWO);
  const cases: Array<[string, unknown]> = [
    ['no content', undefined],
    ['content null', null],
    ['content a string', 'text'],
    ['no parts', { content_type: 'text' }],
    ['parts an object', { content_type: 'text', parts: { 0: 'x' } }],
    ['a part that is a number', { content_type: 'text', parts: ['x', 5] }],
    ['a part that is null', { content_type: 'text', parts: [null] }],
    ['a transcript with no text', { content_type: 'multimodal_text', parts: [{ content_type: 'audio_transcription' }] }],
    ['an unknown content type', { content_type: 'rich_answer', parts: ['x'] }],
    ['no content type', { parts: ['x'] }],
  ];
  for (const [what, content] of cases) {
    const message: Json = { ...base };
    if (content === undefined) {
      delete message.content;
    } else {
      message.content = content;
    }
    assert.deepEqual([promptCounts(message).text_chars, promptCounts(message).text_words], [null, null], what);
    // One such message in a reply makes the reply's text unknown.
    const reply = { ...answer(nodeId(7), T0, ''), content: message.content };
    const counted = replyCounts([answer(nodeId(6), T0, ONE_TWO), reply], [answer(nodeId(6), T0, ONE_TWO), reply]);
    assert.deepEqual([counted.text_chars, counted.text_words], [null, null], what);
  }
});

test('a prompt has no citations and no search results, whatever its metadata holds', () => {
  const odd = withMetadata(prompt(nodeId(1), T0), { content_references: [reference()], search_result_groups: 'x' });
  const counted = promptCounts(odd);
  assert.equal(counted.citation_count, 0);
  assert.equal(counted.search_result_count, 0);
});

test('citations are the grouped_webpages entries of content_references, one per cited passage, summed over the folded messages', () => {
  const first = answer(nodeId(4), T0, ONE_TWO, { refs: [] });
  const last = answer(nodeId(7), T0, THREE_FOUR_FIVE, {
    refs: [reference(), reference('sources_footnote'), reference(), reference('product_entity'), reference('hidden'), reference()],
  });
  assert.equal(replyCounts([first, last], [first, last]).citation_count, 3);
  assert.equal(alone(first).citation_count, 0);
});

test('citations are counted from the folded messages that carry the key when another lacks it', () => {
  const lacking = withoutMetadataKey(answer(nodeId(4), T0, ONE_TWO), 'content_references');
  const carrying = answer(nodeId(7), T0, ONE_TWO, { refs: [reference()] });
  assert.equal(replyCounts([lacking, carrying], [lacking, carrying]).citation_count, 1);
});

test('citations are null when no folded message carries content_references, since every visible answer does', () => {
  const lacking = withoutMetadataKey(answer(nodeId(4), T0, ONE_TWO), 'content_references');
  assert.equal(alone(lacking).citation_count, null);
});

test('citations are null when content_references or one of its entries has another form', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['an object', { 0: reference() }],
    ['a string', 'grouped_webpages'],
    ['an entry that is a string', [reference(), 'grouped_webpages']],
    ['an entry with no type', [{ matched_text: `${MARK} x`, items: [] }]],
    ['an entry whose type is not a string', [{ type: 3 }]],
  ];
  for (const [what, refs] of cases) {
    const odd = withMetadata(answer(nodeId(7), T0, ONE_TWO), { content_references: refs });
    const fine = answer(nodeId(4), T0, ONE_TWO, { refs: [reference()] });
    assert.equal(replyCounts([fine, odd], [fine, odd]).citation_count, null, what);
  }
});

test('search results: the distinct results of the tool messages on the path, not the answer\'s own copies', () => {
  const first = answer(nodeId(4), T0 + 3, ONE_TWO);
  const call = searchCall(nodeId(5), T0 + 4);
  // The second tool message repeats one result of the first (same url and ref_id).
  const results = toolResult(nodeId(6), T0 + 5, [group('news', 0, 3), group('wiki', 3, 2)]);
  const call2 = searchCall(nodeId(7), T0 + 6);
  const results2 = toolResult(nodeId(8), T0 + 7, [group('news', 2, 1), group('blog', 0, 2)]);
  const last = answer(nodeId(9), T0 + 8, THREE_FOUR_FIVE, { groups: [group('rewritten', 50, 4)] });
  const path = [thinking(nodeId(2), T0 + 1), recap(nodeId(3), T0 + 2, { search_result_groups: [group('recap', 100, 3)] }), first, call, results, call2, results2, last];
  assert.equal(replyCounts([first, last], path).search_result_count, 7);
});

test('search results: a result is one url and ref_id, so one URL under two ref_ids is two, and a result listed twice is one', () => {
  const at = (refIndex: number) => ({ type: 'search_result', url: `https://${MARK}.example/same`, title: `${MARK} t`, snippet: `${MARK} s`, ref_id: { turn_index: 0, ref_type: 'search', ref_index: refIndex }, pub_date: null, attribution: `${MARK}.example` });
  const results = toolResult(nodeId(6), T0 + 1, [{ type: 'search_result_group', domain: `${MARK}.example`, entries: [at(0), at(1), at(0)] }]);
  const last = answer(nodeId(9), T0 + 2, ONE_TWO);
  assert.equal(replyCounts([last], [searchCall(nodeId(5), T0), results, last]).search_result_count, 2);
});

test('search results: an entry with neither url nor ref_id cannot be told from another, so the count is null', () => {
  const bare = { type: 'search_result', title: `${MARK} title`, snippet: `${MARK} snippet`, pub_date: null, attribution: `${MARK}.example` };
  const call = searchCall(nodeId(5), T0);
  const last = answer(nodeId(9), T0 + 2, ONE_TWO);
  const results = (entries: unknown[]) => toolResult(nodeId(6), T0 + 1, [{ type: 'search_result_group', domain: `${MARK}.example`, entries }]);
  assert.equal(replyCounts([last], [call, results([bare, bare, bare]), last]).search_result_count, null);
  assert.equal(replyCounts([last], [call, results([{ ...bare, url: null, ref_id: null }]), last]).search_result_count, null);
  const lastWithBare = answer(nodeId(9), T0 + 2, ONE_TWO, { groups: [{ type: 'search_result_group', entries: [bare] }] });
  assert.equal(replyCounts([lastWithBare], [call, lastWithBare]).search_result_count, null);
  // One of the two is enough to tell entries apart.
  assert.equal(replyCounts([last], [call, results([{ ...bare, url: `https://${MARK}.example/a` }, { ...bare, url: `https://${MARK}.example/b` }]), last]).search_result_count, 2);
  assert.equal(replyCounts([last], [call, results([{ ...bare, ref_id: { turn_index: 0, ref_type: 'search', ref_index: 1 } }]), last]).search_result_count, 1);
});

test('search results: with none on a tool message, the distinct results on the folded messages', () => {
  const call = searchCall(nodeId(5), T0, 'web');
  const last = answer(nodeId(9), T0 + 1, ONE_TWO, { groups: [group('news', 0, 3), group('news', 1, 3)] });
  assert.equal(replyCounts([last], [call, last]).search_result_count, 4);
});

test('search results: none anywhere and no search call is 0, an answer with the key absent included', () => {
  assert.equal(alone(answer(nodeId(9), T0, ONE_TWO)).search_result_count, 0);
  assert.equal(alone(withoutMetadataKey(answer(nodeId(9), T0, ONE_TWO), 'search_result_groups')).search_result_count, 0);
});

test('search results: a search call with no results stored anywhere is null, not 0', () => {
  for (const recipient of ['web', 'web.run', 'browser', 'web.search', 'browser.open']) {
    const call = searchCall(nodeId(5), T0, recipient);
    const last = answer(nodeId(9), T0 + 1, ONE_TWO);
    assert.equal(replyCounts([last], [call, last]).search_result_count, null, recipient);
    // A tool message with no results does not change that.
    const empty = toolResult(nodeId(6), T0, []);
    assert.equal(replyCounts([last], [call, empty, last]).search_result_count, null, recipient);
  }
});

test('search results: a call to a tool that is not a search does not make the count null', () => {
  for (const recipient of ['python', 'canmore.create_textdoc', 'bio', 'q7dr546', 'webhook', 'browserless']) {
    const call = searchCall(nodeId(5), T0, recipient);
    const last = answer(nodeId(9), T0 + 1, ONE_TWO);
    assert.equal(replyCounts([last], [call, last]).search_result_count, 0, recipient);
  }
});

test('search results: two calls written before their results are both counted', () => {
  const call1 = searchCall(nodeId(4), T0 + 1);
  const call2 = searchCall(nodeId(5), T0 + 2);
  const results1 = toolResult(nodeId(6), T0 + 3, [group('news', 0, 2)]);
  const results2 = toolResult(nodeId(7), T0 + 4, [group('wiki', 0, 3)]);
  const last = answer(nodeId(9), T0 + 5, ONE_TWO);
  assert.equal(replyCounts([last], [call1, call2, results1, results2, last]).search_result_count, 5);
});

test('search results: a search call with no tool message after it while another call has one is null', () => {
  const call1 = searchCall(nodeId(4), T0 + 1);
  const results1 = toolResult(nodeId(5), T0 + 2, [group('news', 0, 2)]);
  const call2 = searchCall(nodeId(6), T0 + 3);
  const last = answer(nodeId(9), T0 + 4, ONE_TWO, { groups: [group('news', 0, 2)] });
  assert.equal(replyCounts([last], [call1, results1, call2, last]).search_result_count, null);
});

test('search results: thinking, recaps and the inline copy are never read', () => {
  const recapped = recap(nodeId(3), T0, { search_result_groups: [group('recap', 0, 23)] });
  const last = answer(nodeId(9), T0 + 1, ONE_TWO, { metadata: { inline_cot_expandable_content: { search_result_groups: [group('inline', 0, 24)] } } });
  assert.equal(replyCounts([last], [thinking(nodeId(2), T0), recapped, last]).search_result_count, 0);
});

test('search results: null when search_result_groups, a group or an entry has another form on a message the count reads', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['an object', { 0: group('news', 0, 1) }],
    ['a group that is a string', ['news']],
    ['a group with no entries', [{ type: 'search_result_group', domain: `${MARK}.example` }]],
    ['entries that are an object', [{ type: 'search_result_group', entries: { 0: {} } }]],
    ['an entry that is a string', [{ type: 'search_result_group', entries: [`https://${MARK}.example/`] }]],
  ];
  for (const [what, groups] of cases) {
    const call = searchCall(nodeId(5), T0);
    const fine = toolResult(nodeId(6), T0 + 1, [group('news', 0, 2)]);
    const odd = toolResult(nodeId(7), T0 + 2, groups as unknown[]);
    const last = answer(nodeId(9), T0 + 3, ONE_TWO);
    assert.equal(replyCounts([last], [call, fine, odd, last]).search_result_count, null, `${what} on a tool message`);
    const oddAnswer = withMetadata(answer(nodeId(9), T0 + 3, ONE_TWO), { search_result_groups: groups });
    assert.equal(replyCounts([oddAnswer], [call, fine, oddAnswer]).search_result_count, null, `${what} on a folded message`);
  }
});

test('attachments: the entries of metadata.attachments, 0 when the key is absent, on a prompt and summed over a reply', () => {
  assert.equal(promptCounts(prompt(nodeId(1), T0)).attachments, 0);
  assert.equal(promptCounts(withMetadata(prompt(nodeId(1), T0), { attachments: [attachment(1)] })).attachments, 1);
  const first = withMetadata(answer(nodeId(4), T0, ONE_TWO), { attachments: [attachment(1), attachment(2)] });
  const last = answer(nodeId(7), T0, ONE_TWO);
  assert.equal(replyCounts([first, last], [first, last]).attachments, 2);
  assert.equal(alone(last).attachments, 0);
});

test('attachments: null when metadata.attachments has another form', () => {
  for (const value of [null, {}, 'file', 2]) {
    assert.equal(promptCounts(withMetadata(prompt(nodeId(1), T0), { attachments: value })).attachments, null, JSON.stringify(value));
    const odd = withMetadata(answer(nodeId(7), T0, ONE_TWO), { attachments: value });
    assert.equal(replyCounts([answer(nodeId(4), T0, ONE_TWO), odd], [answer(nodeId(4), T0, ONE_TWO), odd]).attachments, null, JSON.stringify(value));
  }
});

test('a message whose metadata has another form gives null for every count read from metadata', () => {
  for (const metadata of [null, 'x', [1]]) {
    const odd = { ...prompt(nodeId(1), T0, ONE_TWO), metadata };
    assert.deepEqual(promptCounts(odd), { text_chars: null, text_words: null, citation_count: 0, search_result_count: 0, attachments: null }, JSON.stringify(metadata));
    const oddReply = { ...answer(nodeId(7), T0, ONE_TWO), metadata };
    assert.deepEqual(alone(oddReply), { text_chars: null, text_words: null, citation_count: null, search_result_count: null, attachments: null }, JSON.stringify(metadata));
  }
});

test('the counts hold numbers only: no text from the messages', () => {
  const first = answer(nodeId(4), T0, ONE_TWO, { refs: [reference()] });
  const call = searchCall(nodeId(5), T0);
  const results = toolResult(nodeId(6), T0, [group('news', 0, 2)]);
  const last = answer(nodeId(7), T0, THREE_FOUR_FIVE);
  const serialized = JSON.stringify([replyCounts([first, last], [first, call, results, last]), promptCounts(prompt(nodeId(1), T0))]);
  assert.equal(serialized.includes(MARK), false);
});
