// Every rex-core key this module writes. They sit under the namespace
// rex-spider gives the spider, next to the two keys rex-spider writes itself:
// rex-spider-chatgpt-last-crawl, and the upload key
// rex-spider-chatgpt-conversation-upload-<id>-<ms>, which rex-spider builds
// from the id below and the list's update_time as the list path reads it
// (list.mts, uploadTime).

export const KEY_PREFIX = 'rex-spider-chatgpt-';

function chatIdOrThrow(chatId: string): string {
  if (typeof chatId !== 'string' || chatId === '') {
    throw new TypeError('a chat id must be a non-empty string');
  }
  return chatId;
}

// The id an upload key is built from, one per mode, so a chat sent in one
// mode is unsent in the other. Summary mode keeps the bare chat id, the key
// earlier builds of this module wrote, so an update sends nothing again there.
export function uploadKeyId(chatId: string, summary: boolean): string {
  return summary ? chatIdOrThrow(chatId) : `${chatIdOrThrow(chatId)}-detail`;
}

// The served mode and when this browser first saw it (store.mts, ModeRecord).
export const MODE_KEY = `${KEY_PREFIX}mode`;

const MEMO_PREFIX = `${KEY_PREFIX}detail-memo-`;

// One chat's memo of a failed detail read (store.mts, DetailMemo).
export function memoKey(chatId: string): string {
  return `${MEMO_PREFIX}${chatIdOrThrow(chatId)}`;
}

// The part of a key that may be logged: its kind. A memo key carries a chat
// id, and a key this module does not own is not echoed at all.
export function keyKind(key: string): string {
  if (key === MODE_KEY) {
    return MODE_KEY;
  }
  if (key.startsWith(MEMO_PREFIX)) {
    return `${KEY_PREFIX}detail-memo`;
  }
  return 'other key';
}
