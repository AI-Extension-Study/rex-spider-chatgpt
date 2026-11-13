// The five counts of a turn, made in the browser from the messages it folds
// and the path above it, so a record says how much was written, cited, found
// and attached, never what. A count is null when what it is made from is
// missing or has another form, so a changed layout shows as null, not 0. The
// sources are the ones the capture of 2026-11-12 settled. Pure: only numbers
// leave this module.
import { field, isObject } from './forms.mts';
import { countText } from './text.mts';

export interface Counts {
  readonly text_chars: number | null;
  readonly text_words: number | null;
  readonly citation_count: number | null;
  readonly search_result_count: number | null;
  readonly attachments: number | null;
}

interface Text {
  readonly chars: number;
  readonly words: number;
}

const NO_TEXT: Text = { chars: 0, words: 0 };

// The content types whose string parts are what a person reads.
const TEXT_TYPES: ReadonlySet<string> = new Set(['text', 'multimodal_text']);
// Content types that hold code or its output, which are not text a person
// reads in the chat.
const NOT_TEXT_TYPES: ReadonlySet<string> = new Set(['code', 'execution_output']);

// A message's metadata: {} when it has none, null when it has one of another
// form.
function metadataOf(message: unknown): Readonly<Record<string, unknown>> | null {
  const metadata = field(message, 'metadata');
  if (metadata === undefined) {
    return {};
  }
  return isObject(metadata) ? metadata : null;
}

// The text of one message: its string parts, and a voice part's transcript.
// Images, files and audio are not text. A Deep Research report is a document
// drawn beside the chat from metadata.chatgpt_sdk.widget_state, which is
// never read. When widget_state is a string, a part that is empty or is the
// tool call that made the report (it starts {"path") is no text a person
// reads, and counts none; the message's other parts count as usual.
function textOf(message: unknown): Text | null {
  const metadata = metadataOf(message);
  if (metadata === null) {
    return null;
  }
  const report = typeof field(field(metadata, 'chatgpt_sdk'), 'widget_state') === 'string';
  const content = field(message, 'content');
  const type = field(content, 'content_type');
  if (typeof type !== 'string') {
    return null;
  }
  if (NOT_TEXT_TYPES.has(type)) {
    return NO_TEXT;
  }
  const parts = field(content, 'parts');
  if (!TEXT_TYPES.has(type) || !Array.isArray(parts)) {
    return null;
  }
  let chars = 0;
  let words = 0;
  for (const part of parts) {
    if (report && typeof part === 'string' && (part === '' || part.startsWith('{"path"'))) {
      continue;
    }
    let text: unknown = part;
    if (isObject(part)) {
      if (field(part, 'content_type') !== 'audio_transcription') {
        continue;
      }
      text = field(part, 'text');
    }
    if (typeof text !== 'string') {
      return null;
    }
    const counted = countText(text);
    chars += counted.chars;
    words += counted.words;
  }
  return { chars, words };
}

function sumText(messages: readonly unknown[]): Text | null {
  let chars = 0;
  let words = 0;
  for (const message of messages) {
    const text = textOf(message);
    if (text === null) {
      return null;
    }
    chars += text.chars;
    words += text.words;
  }
  return { chars, words };
}

// The entries of content_references whose type is grouped_webpages: one per
// cited passage, its sources in items. sources_footnote and the other types
// are not citations, and citations, never seen non-empty, is not read. Every
// visible answer carries content_references, so a reply none of whose
// messages does is null.
function citationCount(folded: readonly unknown[]): number | null {
  let carried = false;
  let count = 0;
  for (const message of folded) {
    const metadata = metadataOf(message);
    if (metadata === null) {
      return null;
    }
    const references = field(metadata, 'content_references');
    if (references === undefined) {
      continue;
    }
    if (!Array.isArray(references)) {
      return null;
    }
    carried = true;
    for (const reference of references) {
      const type = field(reference, 'type');
      if (typeof type !== 'string') {
        return null;
      }
      if (type === 'grouped_webpages') {
        count += 1;
      }
    }
  }
  return carried ? count : null;
}

// The recipients that make a message a web search call. Only web and web.run
// were seen; browser and the dotted names are a precaution. Other tools
// (Python, canvas, image generation, memory) are not searches.
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['web', 'web.run', 'browser']);
const isSearchCall = (recipient: unknown): boolean => typeof recipient === 'string' && (SEARCH_TOOLS.has(recipient) || recipient.startsWith('web.') || recipient.startsWith('browser.'));

// Adds a message's search results to `into`, each once by url and ref_id;
// false when its search_result_groups, a group or an entry has another form,
// or an entry has neither url nor ref_id, which leaves it nothing to be told
// apart from another by. The inline copy under inline_cot_expandable_content
// is never read.
function addResults(message: unknown, into: Set<string>): boolean {
  const metadata = metadataOf(message);
  if (metadata === null) {
    return false;
  }
  const groups = field(metadata, 'search_result_groups');
  if (groups === undefined) {
    return true;
  }
  if (!Array.isArray(groups)) {
    return false;
  }
  for (const group of groups) {
    const entries = field(group, 'entries');
    if (!Array.isArray(entries)) {
      return false;
    }
    for (const entry of entries) {
      const url = field(entry, 'url') ?? null;
      const refId = field(entry, 'ref_id') ?? null;
      if (!isObject(entry) || (url === null && refId === null)) {
        return false;
      }
      into.add(JSON.stringify([url, refId]));
    }
  }
  return true;
}

// What the searches on the reply's path returned, tool first so nothing is
// counted twice: the distinct results of the tool messages on the path when
// any holds some, else those of the folded messages, else 0 when no search
// was called. The answer's own copies are not added to the tool messages':
// in the capture none matched a tool message's result, even by URL. Null
// when a search was called and no results are stored anywhere, or when,
// counting the tool messages, a search call has no tool message after it,
// so its results were not stored. Thinking and recaps are never read.
function searchResultCount(folded: readonly unknown[], path: readonly unknown[]): number | null {
  const fromTools = new Set<string>();
  let lastTool = -1;
  let lastCall = -1;
  path.forEach((message, at) => {
    if (isSearchCall(field(message, 'recipient'))) {
      lastCall = at;
    }
  });
  for (let at = 0; at < path.length; at += 1) {
    if (field(field(path[at], 'author'), 'role') !== 'tool') {
      continue;
    }
    lastTool = at;
    if (!addResults(path[at], fromTools)) {
      return null;
    }
  }
  const fromReply = new Set<string>();
  for (const message of folded) {
    if (!addResults(message, fromReply)) {
      return null;
    }
  }
  if (fromTools.size > 0) {
    return lastCall > lastTool ? null : fromTools.size;
  }
  if (fromReply.size > 0) {
    return fromReply.size;
  }
  return lastCall === -1 ? 0 : null;
}

// The entries of metadata.attachments. ChatGPT leaves the key out of a
// message with none (150 of 151 prompts, never []), so absent is 0.
function attachmentCount(messages: readonly unknown[]): number | null {
  let count = 0;
  for (const message of messages) {
    const metadata = metadataOf(message);
    if (metadata === null) {
      return null;
    }
    const attached = field(metadata, 'attachments');
    if (attached === undefined) {
      continue;
    }
    if (!Array.isArray(attached)) {
      return null;
    }
    count += attached.length;
  }
  return count;
}

// A prompt's counts. A prompt cites nothing and is returned no search results.
export function promptCounts(message: unknown): Counts {
  const text = textOf(message);
  return {
    text_chars: text?.chars ?? null,
    text_words: text?.words ?? null,
    citation_count: 0,
    search_result_count: 0,
    attachments: attachmentCount([message]),
  };
}

// A reply's counts. `folded` holds the visible messages it folds, oldest
// first; `path` every message from the one after its parent turn to its last
// folded message, in order, the folded ones among them.
export function replyCounts(folded: readonly unknown[], path: readonly unknown[]): Counts {
  const text = sumText(folded);
  return {
    text_chars: text?.chars ?? null,
    text_words: text?.words ?? null,
    citation_count: citationCount(folded),
    search_result_count: searchResultCount(folded, path),
    attachments: attachmentCount(folded),
  };
}
