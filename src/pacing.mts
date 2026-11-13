// Every wait of a pass goes through sleep. A wait is cut into chunks of at
// most CHUNK_MS with a keep-alive call before each, so the service worker is
// never idle long enough for Chrome to stop it in the middle of a pass.
// Measured in Chrome: an MV3 worker died during a bare 60 s timer, and a bare
// 30 s one sat at the edge; crawl_delay is 30 s unless the config sets another.
export const CHUNK_MS = 20_000;

export interface SleepOptions {
  // A cheap extension API call. Making it resets the worker's idle timer.
  readonly keepAlive: () => unknown;
  readonly wait?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nameOf = (error: unknown) => (error instanceof Error ? error.name : typeof error);
const defaultLog = (line: string) => console.log(`[rex-spider-chatgpt] ${line}`);

// Makes the keep-alive call without waiting on it: the call resets the idle
// timer when it is made, and one that never answers must hold nothing up. A
// call that throws or rejects is logged by its error's name and ignored.
export function touch(keepAlive: () => unknown, log: (line: string) => void = defaultLog): void {
  const failed = (error: unknown) => {
    try {
      log(`keep-alive failed (${nameOf(error)})`);
    } catch {
      // A log that throws has nowhere left to report to.
    }
  };
  try {
    Promise.resolve(keepAlive()).catch(failed);
  } catch (error) {
    failed(error);
  }
}

export async function sleep(ms: number, { keepAlive, wait = timer, log = defaultLog }: SleepOptions): Promise<void> {
  // A wait is read as setTimeout would read it: a numeric string is its
  // number, and anything that is not a finite number is no wait, so a broken
  // value cannot hold a pass for good.
  const total = Number(ms);
  if (!Number.isFinite(total)) {
    return;
  }
  for (let left = total; left > 0; left -= CHUNK_MS) {
    touch(keepAlive, log);
    await wait(Math.min(left, CHUNK_MS));
  }
}

// What withDeadline answers when the deadline comes first.
export const TIMED_OUT = Symbol('timed out');

// A race for a promise that is not a request (the client aborts its own): it
// ends the wait and cancels nothing, so whatever the promise goes on to do is
// ignored, and a rejection that comes after the deadline goes nowhere.
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
