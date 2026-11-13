// Synthetic chatgpt.com details, built from the shapes the capture of
// 2026-11-12 recorded (key names, forms, roles, recipients, channels and
// content types, counted), never from a real chat. Every field that holds
// text a person wrote or read, a title, a URL, a search query or a file name
// carries MARK, so a test can serialize what the spider builds and look for
// it. Ids carry no MARK: the record keeps them.

export const MARK = 'MARKER';

type Json = Record<string, unknown>;

// Message ids are UUIDs; the root of a chat made in a browser is
// client-created-root (39 of 40 chats), a UUID otherwise.
export const ROOT = 'client-created-root';
export const nodeId = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const CHAT_ID = '6911f0a5-2222-8000-8000-000000000001';
const EXCHANGE = 'bbbbbbbb-0000-4000-8000-000000000001';

// 2026-11-10T14:00:05Z in epoch seconds, the form the detail writes times in.
export const T0 = 1794319205;

interface MessageOptions {
  readonly time: number | null;
  readonly recipient?: string;
  readonly channel?: string | null;
  readonly status?: string;
  readonly endTurn?: boolean | null;
  readonly authorName?: string | null;
  readonly metadata?: Json;
}

// A message with every key the capture saw on one (459 of 459 nodes carry
// id, message, parent and children; a message these).
function message(id: string, role: string, content: Json, options: MessageOptions): Json {
  return {
    id,
    author: { role, name: options.authorName ?? null, metadata: {} },
    create_time: options.time,
    update_time: null,
    content,
    status: options.status ?? 'finished_successfully',
    end_turn: options.endTurn ?? null,
    weight: 1,
    metadata: { turn_exchange_id: EXCHANGE, ...options.metadata },
    recipient: options.recipient ?? 'all',
    channel: options.channel ?? null,
  };
}

// A prompt: text parts and none of the list keys (ChatGPT omits them on a
// prompt), with dictation's original text, which is text outside the parts.
export function prompt(id: string, time: number, text = `${MARK} prompt`, metadata: Json = {}): Json {
  return message(id, 'user', { content_type: 'text', parts: [text] }, {
    time,
    metadata: { dictation: false, dictation_original_text: `${MARK} dictated`, serialization_metadata: { custom_symbol_offsets: [] }, ...metadata },
  });
}

interface AnswerOptions {
  readonly channel?: string | null;
  readonly refs?: unknown[];
  readonly groups?: unknown[];
  readonly model?: string;
  readonly status?: string;
  readonly metadata?: Json;
  readonly parts?: unknown[];
  readonly contentType?: string;
}

// A visible answer: text to all, with the list keys ChatGPT writes on one
// (citations [] and content_references on every visible answer, and
// search_result_groups [] unless results are given), and the text-bearing
// keys found outside the parts.
export function answer(id: string, time: number, text: string, options: AnswerOptions = {}): Json {
  return message(id, 'assistant', { content_type: options.contentType ?? 'text', parts: options.parts ?? [text] }, {
    time,
    channel: options.channel === undefined ? 'final' : options.channel,
    endTurn: true,
    status: options.status,
    metadata: {
      citations: [],
      content_references: options.refs ?? [],
      search_result_groups: options.groups ?? [],
      model_slug: options.model ?? 'gpt-5',
      default_model_slug: 'gpt-5',
      resolved_model_slug: 'gpt-5-2025',
      message_type: 'next',
      request_id: 'cccccccc-0000-4000-8000-000000000001',
      finished_duration_sec: 3,
      code_blocks: [{ language: 'text', code: `${MARK} code block` }],
      writing_blocks: [{ title: `${MARK} writing block` }],
      ...options.metadata,
    },
  });
}

// A reasoning model's thinking (in_progress on 6 of 17 in the capture), with
// the timing keys the skeleton keeps.
export function thinking(id: string, time: number): Json {
  return message(id, 'assistant', {
    content_type: 'thoughts',
    thoughts: [{ summary: `${MARK} thought summary`, content: `${MARK} thought content`, chunks: [], finished: true }],
    source_analysis_msg_id: 'dddddddd-0000-4000-8000-000000000001',
  }, {
    time,
    status: 'in_progress',
    metadata: {
      reasoning_title: `${MARK} reasoning title`,
      reasoning_status: 'is_reasoning',
      reasoning_start_time: time - 0.5,
      reasoning_end_time: time + 0.25,
      thinking_effort: 'high',
      working_turn_id: 'dddddddd-0000-4000-8000-000000000002',
    },
  });
}

// The recap before a reasoning model's final answer.
export function recap(id: string, time: number, metadata: Json = {}): Json {
  return message(id, 'assistant', { content_type: 'reasoning_recap', content: `${MARK} recap` }, { time, metadata });
}

// A web search call: a text message addressed to the search tool.
export function searchCall(id: string, time: number, recipient = 'web.run'): Json {
  return message(id, 'assistant', { content_type: 'text', parts: [`{"search_query": [{"q": "${MARK} query"}]}`] }, {
    time,
    recipient,
    channel: 'commentary',
    metadata: { search_queries: [{ type: 'search', q: `${MARK} query` }], content_references: [], citations: [] },
  });
}

// A tool's result: a tool message to all with string parts, its results in
// search_result_groups.
export function toolResult(id: string, time: number, groups: unknown[] | undefined, name = 'web.run'): Json {
  return message(id, 'tool', { content_type: 'text', parts: [`${MARK} tool output`] }, {
    time,
    authorName: name,
    metadata: { ...(groups === undefined ? {} : { search_result_groups: groups }), search_display_string: `${MARK} searched the web` },
  });
}

export function systemMessage(id: string, hidden = true): Json {
  return message(id, 'system', { content_type: 'text', parts: [''] }, { time: null, metadata: hidden ? { is_visually_hidden_from_conversation: true } : {} });
}

// The custom instructions, a hidden user message.
export function hiddenContext(id: string): Json {
  return message(id, 'user', { content_type: 'user_editable_context', user_profile: `${MARK} profile`, user_instructions: `${MARK} instructions` }, {
    time: null,
    metadata: { is_visually_hidden_from_conversation: true, user_context_message_data: { about_user_message: `${MARK} about` } },
  });
}

// n search results in one group, numbered from `from`: entries in the
// capture's form, {type, url, title, snippet, ref_id, pub_date, attribution}.
export function group(site: string, from: number, n: number): Json {
  return {
    type: 'search_result_group',
    domain: `${MARK}-${site}.example`,
    entries: Array.from({ length: n }, (_, k) => ({
      type: 'search_result',
      url: `https://${MARK}-${site}.example/page-${from + k}`,
      title: `${MARK} result title ${from + k}`,
      snippet: `${MARK} result snippet ${from + k}`,
      ref_id: { turn_index: 0, ref_type: 'search', ref_index: from + k },
      pub_date: null,
      attribution: `${MARK}-${site}.example`,
    })),
  };
}

// A content_references entry. grouped_webpages is one cited passage with its
// sources in items; the others carry their own keys.
export function reference(type = 'grouped_webpages'): Json {
  const common = { type, matched_text: `${MARK} cited passage`, start_idx: 10, end_idx: 30, alt: `${MARK} alt`, prompt_text: `${MARK} prompt text`, safe_urls: [`https://${MARK}.example/safe`], refs: [] };
  if (type === 'grouped_webpages') {
    return {
      ...common,
      items: [{ title: `${MARK} cited title`, url: `https://${MARK}.example/cited`, pub_date: null, snippet: `${MARK} cited snippet`, attribution: `${MARK}.example`, attributions: null, attribution_segments: null, supporting_websites: [], refs: [], hue: null }],
      fallback_items: [],
      status: 'done',
      style: null,
      error: null,
    };
  }
  if (type === 'sources_footnote') {
    return { ...common, sources: [{ title: `${MARK} source`, url: `https://${MARK}.example/source` }], has_images: false };
  }
  return common;
}

// An image part of a multimodal prompt.
export function imagePart(n: number): Json {
  return { content_type: 'image_asset_pointer', asset_pointer: `file-service://file-${MARK}${n}`, size_bytes: 1000, width: 10, height: 10, fovea: null, metadata: null };
}

// An attachment entry in its capture form.
export function attachment(n: number): Json {
  return { id: `file-${MARK}${n}`, name: `${MARK}-photo-${n}.png`, size: 1000, mime_type: 'image/png', width: 10, height: 10, source: 'local', library_file_id: null, is_big_paste: false };
}

export type Spec = readonly [id: string, parent: string | null, message: Json | null];

// A mapping from [id, parent, message] specs, in the order given, each
// node's children taken from the specs that name it as their parent.
export function tree(...specs: Spec[]): Json {
  const mapping: Json = {};
  for (const [id, parent, held] of specs) {
    mapping[id] = { id, message: held, parent, children: specs.filter((spec) => spec[1] === id).map((spec) => spec[0]) };
  }
  return mapping;
}

// A node of a mapping, to change it in a test.
export const nodeOf = (mapping: Json, id: string): Json => mapping[id] as Json;

// A detail as GET /backend-api/conversation/{id} sends it: the mapping, its
// current node, and the conversation's own keys, text-bearing ones included.
export function detail(mapping: Json, current: string | undefined, fields: Json = {}): Json {
  return {
    title: `${MARK} title of the chat`,
    create_time: T0,
    update_time: T0 + 60.5,
    mapping,
    moderation_results: [],
    ...(current === undefined ? {} : { current_node: current }),
    plugin_ids: null,
    conversation_id: CHAT_ID,
    conversation_template_id: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    is_starred: null,
    safe_urls: [`https://${MARK}.example/safe`],
    blocked_urls: [`https://${MARK}.example/blocked`],
    default_model_slug: 'gpt-5',
    conversation_origin: null,
    voice: null,
    async_status: null,
    disabled_tool_ids: [],
    is_do_not_remember: false,
    memory_scope: 'global_enabled',
    context_scopes: [{ type: 'project', title: `${MARK} scope` }],
    sugar_item_id: null,
    is_study_mode: false,
    pinned_time: null,
    is_temporary_chat: false,
    owner: { user_email: `${MARK}@example.com`, name: `${MARK} owner` },
    ...fields,
  };
}

// The capture's edited prompts: both were the first prompt, so the old and
// the new prompt hang from the root side by side, each with its reply.
export function editedFirstPromptDetail(): Json {
  return detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1, `${MARK} before the edit`)],
    [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} old answer`)],
    [nodeId(3), ROOT, prompt(nodeId(3), T0 + 3, `${MARK} after the edit`)],
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 4, `${MARK} new answer`)],
  ), nodeId(4));
}

// A prompt and a reasoning model's reply in the order the capture saw:
// thinking, a recap, visible text, a web.run call and its tool result with
// five results, then the final answer, which holds rewritten copies of two
// results and the inline copy of more. The recap also holds results.
export function reasoningDetail(): Json {
  return detail(tree(
    [ROOT, null, null],
    [nodeId(1), ROOT, prompt(nodeId(1), T0 + 0.25, `${MARK} one two three`)],
    [nodeId(2), nodeId(1), thinking(nodeId(2), T0 + 1)],
    [nodeId(3), nodeId(2), recap(nodeId(3), T0 + 2, { search_result_groups: [group('recap', 100, 3)] })],
    [nodeId(4), nodeId(3), answer(nodeId(4), T0 + 3.123456, `${MARK} one two`, { channel: 'commentary' })],
    [nodeId(5), nodeId(4), searchCall(nodeId(5), T0 + 4)],
    [nodeId(6), nodeId(5), toolResult(nodeId(6), T0 + 5, [group('news', 0, 3), group('wiki', 3, 2)])],
    [nodeId(7), nodeId(6), answer(nodeId(7), T0 + 26.871, `${MARK} three four five`, {
      model: 'gpt-5-thinking',
      refs: [reference(), reference('sources_footnote'), reference()],
      groups: [group('rewritten', 50, 2)],
      metadata: { inline_cot_expandable_content: { search_result_groups: [group('inline', 200, 4)], summary: `${MARK} inline` } },
    })],
  ), nodeId(7));
}
