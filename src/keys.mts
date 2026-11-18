// Every rex-core key this module writes. They sit under the namespace
// rex-spider gives the spider, next to the two keys rex-spider writes itself:
// rex-spider-chatgpt-last-crawl, and the upload key
// rex-spider-chatgpt-conversation-upload-<id>-<ms>, which rex-spider builds
// from the id below and the list's update_time as the list path reads it
// (list.mts, uploadTime).
import { DEFAULT_DATA_FORMAT, isDataFormat } from './format.mts';

export const KEY_PREFIX = 'rex-spider-chatgpt-';

function chatIdOrThrow(chatId: string): string {
  if (typeof chatId !== 'string' || chatId === '') {
    throw new TypeError('a chat id must be a non-empty string');
  }
  return chatId;
}

// An id under a data format: as it is under format 1, with -f and the format
// after. A format that is not one is refused, so no key is built from it.
function withFormat(id: string, format: number): string {
  if (!isDataFormat(format)) {
    throw new TypeError('a data format must be an integer from 1 to 999');
  }
  return format === DEFAULT_DATA_FORMAT ? id : `${id}-f${format}`;
}

// The id an upload key is built from, one per mode and data format
// (format.mts), so a chat sent in one mode, or under one format, is unsent in
// another. Format 1 keeps the ids earlier builds of this module wrote: the
// bare chat id in summary mode, so an update sends nothing again there, and
// -detail in detail mode. A later format adds -f and its number to both.
export function uploadKeyId(chatId: string, summary: boolean, format: number): string {
  return withFormat(summary ? chatIdOrThrow(chatId) : `${chatIdOrThrow(chatId)}-detail`, format);
}

// The served mode and when this browser first saw it (store.mts, ModeRecord).
export const MODE_KEY = `${KEY_PREFIX}mode`;

// The wait a refusal asked for, which skips passes until it runs out
// (backoff.mts, BackoffState).
export const BACKOFF_KEY = `${KEY_PREFIX}backoff`;

// The account read's state: the last read, and the hash and time of the
// last record sent (account.mts, AccountState).
export const ACCOUNT_KEY = `${KEY_PREFIX}account`;

const MEMO_PREFIX = `${KEY_PREFIX}detail-memo-`;

// One chat's memo of a failed detail read (store.mts, DetailMemo), one per
// data format as the upload keys are, so a memo written under one format
// holds nothing back under another. Format 1 keeps the key earlier builds
// wrote.
export function memoKey(chatId: string, format: number): string {
  return withFormat(`${MEMO_PREFIX}${chatIdOrThrow(chatId)}`, format);
}

// The part of a key that may be logged: its kind. A memo key carries a chat
// id, and a key this module does not own is not echoed at all.
export function keyKind(key: string): string {
  if (key === MODE_KEY || key === BACKOFF_KEY || key === ACCOUNT_KEY) {
    return key;
  }
  if (key.startsWith(MEMO_PREFIX)) {
    return `${KEY_PREFIX}detail-memo`;
  }
  return 'other key';
}
