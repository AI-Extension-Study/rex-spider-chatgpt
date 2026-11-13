// The forms a record keeps a value in, shared by the detail parser, the counts
// and the record builders. A value of another form is read as null, and a
// string outside its form as 'unrecognised', which carries nothing of it.
// Pure.
import { DateString } from '@bric/rex-types/types';

export const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

// An own key of an object, or undefined for anything else: a key named like
// one of Object's own (constructor, toString) is never read through the
// prototype.
export const field = (value: unknown, key: string): unknown => (isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined);

// A type name: lowercase letters, digits, _, . and -, at most 64 characters.
// The capture did not print model slugs, memory scopes or gizmo types, so
// they are held to this form.
const TYPE_NAME = /^[a-z0-9_.-]{1,64}$/;
export const typeName = (value: unknown): string | null => (typeof value !== 'string' ? null : TYPE_NAME.test(value) ? value : 'unrecognised');

export const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

// A message's status, from the closed set the capture saw: in_progress only on
// thinking, finished_successfully on everything else.
const STATUSES: ReadonlySet<string> = new Set(['finished_successfully', 'in_progress']);
export const statusOf = (value: unknown): string | null => (typeof value !== 'string' ? null : STATUSES.has(value) ? value : 'unrecognised');

// Epoch seconds from 2001 to 2286, the form the detail writes times in. A
// time in milliseconds would otherwise read as a date some 50,000 years
// ahead.
export const isPlausibleSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1e9 && value < 1e10;
export const secondsOrNull = (value: unknown): number | null => (isPlausibleSeconds(value) ? value : null);

// An instant from epoch seconds as the detail writes them, a float with
// microseconds. The float is read to the microsecond, so its binary rounding
// does not reach the instant: new DateString(1794319231.871) is
// ...31.871000064Z, this ...31.871Z. Null for anything but plausible seconds.
export function instantOf(seconds: unknown): DateString | null {
  if (!isPlausibleSeconds(seconds)) {
    return null;
  }
  let whole = Math.floor(seconds);
  let micros = Math.round((seconds - whole) * 1e6);
  if (micros === 1e6) {
    whole += 1;
    micros = 0;
  }
  const date = new Date(whole * 1000).toISOString().slice(0, 19);
  return new DateString(`${date}.${String(micros).padStart(6, '0')}Z`);
}
