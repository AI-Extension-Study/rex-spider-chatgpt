// Re-sending after a change of mode. Each mode has its own upload key
// (keys.mts), so a chat sent in one mode is unsent in the other. Re-sending
// everything in the crawl window on every switch would be too much, and
// re-sending nothing would leave the new mode without the recent past, so a
// switch re-sends the chats last used in the RESEND_WINDOW_MS before it, once.
// "Before it" is the first pass in this browser that ran the new mode, kept
// in the store, so a browser that was offline when the config changed still
// gets the full window. A browser that has never stored a mode, such as one
// updated from a build that keyed both modes alike, counts as switching then.
import type { DateString } from '@bric/rex-types/types';

import { uploadKeyId } from './keys.mts';
import { type ChatGPTStore, type Mode } from './store.mts';

export const RESEND_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// A stored start further ahead of now than this was written under a clock
// that ran fast. Trusted, it would shrink the re-send, possibly to nothing, so
// it is replaced by now. A clock that ran slow cannot be told apart from a
// real early start and is trusted.
export const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

// When this browser started running the served mode, writing the record when
// the stored one is absent, malformed, of the other mode or from the future.
// Null when the record could not be read or a new one could not be written:
// this pass then sends nothing again (sentAlready), and the next pass tries
// again.
export async function resendSince(store: Pick<ChatGPTStore, 'mode'>, served: Mode, now: number): Promise<number | null> {
  const stored = await store.mode.get();
  if (stored.unanswered) {
    return null;
  }
  if (stored.value !== null && stored.value.mode === served && stored.value.since <= now + CLOCK_SKEW_MS) {
    return stored.value.since;
  }
  const written = await store.mode.set({ mode: served, since: now });
  return written.ok ? now : null;
}

// rex-spider's checkIfAlreadyTransmitted, or a test's stand-in.
export type Transmitted = (id: string, ended: DateString) => Promise<boolean>;

// Whether a chat in the crawl window needs nothing this pass: it was sent in
// the served mode at this time, or sent in the other mode at this time and
// last used more than RESEND_WINDOW_MS before the switch. The time is the one
// its upload key is built from (list.mts, uploadTime). With no start for this
// pass (since null), a chat sent in the other mode is held back rather than
// sent.
export async function sentAlready(transmitted: Transmitted, chatId: string, ended: DateString, served: Mode, since: number | null): Promise<boolean> {
  if (await transmitted(uploadKeyId(chatId, served === 'summary'), ended)) {
    return true;
  }
  if (!(await transmitted(uploadKeyId(chatId, served !== 'summary'), ended))) {
    return false;
  }
  return since === null || ended.timestamp() < since - RESEND_WINDOW_MS;
}
