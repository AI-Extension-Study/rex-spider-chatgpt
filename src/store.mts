// The one module that reads and writes rex-core's key-value store, through
// the fetchValue and storeValue messages rexCorePlugin.handleMessage takes.
// The function is handed in, so the unit tests use a double; rex-core itself
// does not load under Node, and only its type is imported here.
//
// Two behaviours of rex-core shape this. A missing key answers null. While
// its database is not open, a read is not handled at all (handleMessage
// returns false and no answer comes) and a write is taken (true) but never
// answered. So every call has a deadline: an unanswered read counts as absent
// and an unanswered write as failed, and both say so to the caller.
import type rexCorePlugin from '@bric/rex-core/service-worker';

import { MODE_KEY, keyKind, memoKey } from './keys.mts';

export type HandleMessage = typeof rexCorePlugin.handleMessage;

export const STORE_DEADLINE_MS = 1000;

export interface RawRead {
  readonly value: unknown;
  readonly unanswered: boolean;
}

export interface Read<T> {
  readonly value: T | null;
  readonly unanswered: boolean;
  // Something was stored under the key, but not a T: read as absent.
  readonly malformed: boolean;
}

export interface Write {
  readonly ok: boolean;
  readonly unanswered: boolean;
}

export type Mode = 'summary' | 'detail';

// The served mode, and the epoch ms of the first pass in this browser that
// ran it (mode.mts).
export interface ModeRecord {
  readonly mode: Mode;
  readonly since: number;
}

// A chat whose detail read failed: the last-message time it failed at (epoch
// ms), when, how long until it is read again, and how many reads in a row
// have failed.
export interface DetailMemo {
  readonly ended: number;
  readonly at: number;
  readonly retryMs: number;
  readonly failures: number;
}

export interface ChatGPTStore {
  get(key: string): Promise<RawRead>;
  set(key: string, value: unknown): Promise<Write>;
  readonly mode: {
    get(): Promise<Read<ModeRecord>>;
    set(record: ModeRecord): Promise<Write>;
  };
  readonly memo: {
    get(chatId: string): Promise<Read<DetailMemo>>;
    set(chatId: string, memo: DetailMemo): Promise<Write>;
    clear(chatId: string): Promise<Write>;
  };
}

export interface StoreOptions {
  readonly deadlineMs?: number;
  readonly log?: (line: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function isModeRecord(value: unknown): value is ModeRecord {
  return isRecord(value) && (value.mode === 'summary' || value.mode === 'detail') && isCount(value.since);
}

function isDetailMemo(value: unknown): value is DetailMemo {
  return isRecord(value) && isCount(value.ended) && isCount(value.at) && isCount(value.retryMs) && (value.retryMs as number) > 0 && isCount(value.failures) && (value.failures as number) > 0;
}

const defaultLog = (line: string) => console.log(`[rex-spider-chatgpt] ${line}`);

export function createStore(handleMessage: HandleMessage, { deadlineMs = STORE_DEADLINE_MS, log = defaultLog }: StoreOptions = {}): ChatGPTStore {
  // Sends one message and settles exactly once: with rex-core's answer, or
  // unanswered at the deadline, on a throw, or at once for a read rex-core
  // did not handle. Log lines carry the key's kind, never the key.
  function ask(message: { messageType: 'fetchValue' | 'storeValue'; key: string; value?: unknown }): Promise<{ answer: unknown; unanswered: boolean }> {
    const what = `${message.messageType} ${keyKind(message.key)}`;
    return new Promise((resolve) => {
      let settled = false;
      const unanswered = (why: string) => {
        settled = true;
        clearTimeout(timer);
        log(`store: ${what} ${why}`);
        resolve({ answer: undefined, unanswered: true });
      };
      const timer = setTimeout(() => unanswered(`unanswered after ${deadlineMs} ms`), deadlineMs);
      const sendResponse = (answer: unknown) => {
        if (settled) {
          log(`store: late answer to ${what}, ignored`);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ answer, unanswered: false });
      };
      let handled: boolean;
      try {
        handled = handleMessage(message, null, sendResponse);
      } catch (error) {
        if (!settled) {
          unanswered(`threw ${error instanceof Error ? error.name : typeof error}`);
        }
        return;
      }
      if (!handled && message.messageType === 'fetchValue' && !settled) {
        unanswered('not handled, so no answer will come');
      }
    });
  }

  async function get(key: string): Promise<RawRead> {
    const { answer, unanswered } = await ask({ messageType: 'fetchValue', key });
    return { value: unanswered || answer === undefined ? null : answer, unanswered };
  }

  async function set(key: string, value: unknown): Promise<Write> {
    const { answer, unanswered } = await ask({ messageType: 'storeValue', key, value });
    return { ok: answer === true, unanswered };
  }

  async function typed<T>(key: string, isT: (value: unknown) => value is T): Promise<Read<T>> {
    const raw = await get(key);
    if (raw.value === null) {
      return { value: null, unanswered: raw.unanswered, malformed: false };
    }
    if (!isT(raw.value)) {
      log(`store: ${keyKind(key)} holds a value of the wrong shape (${Array.isArray(raw.value) ? 'array' : typeof raw.value}), read as absent`);
      return { value: null, unanswered: false, malformed: true };
    }
    return { value: raw.value, unanswered: false, malformed: false };
  }

  return {
    get,
    set,
    mode: {
      get: () => typed(MODE_KEY, isModeRecord),
      set: (record) => set(MODE_KEY, record),
    },
    // async, so that a bad chat id rejects rather than throws.
    memo: {
      get: async (chatId) => typed(memoKey(chatId), isDetailMemo),
      set: async (chatId, memo) => set(memoKey(chatId), memo),
      // rex-core has no delete; null reads back as nothing.
      clear: async (chatId) => set(memoKey(chatId), null),
    },
  };
}
