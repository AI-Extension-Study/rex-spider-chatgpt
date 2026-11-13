// The ChatGPT case of the extension's content processor, which calls it for
// platform 'chatgpt' on every rex-conversation point before it is queued for
// upload. A record buildSummaryRecord or buildDetailRecord made, in the
// standard record layout (format 1), comes back equal, each value written
// from its checked form (keep.mts) and every other key dropped, at every
// level. Any other point keeps only the scaffold: the fields the processor
// keeps for a point of no known platform, each in its form. The case never
// throws, because rex-content-processing uploads a failed processor's input
// unredacted. The extension carries a copy of this file and keep.mts, so the
// two import nothing but rex-types. Pure.
import { DateString } from '@bric/rex-types/types';

import { DETAIL_METADATA, INSTANT_TO_STRING, REPLY, SUMMARY_METADATA, TURN, asListTime, asSeconds, asUuid, isObject, keepAll } from './keep.mts';

const NAME = 'rex-conversation';
const PLATFORM = 'chatgpt';
const FORMAT_VERSION = 1;
const USER_AGENTS: ReadonlySet<string> = new Set(['Browser', 'App (Mobile or Desktop)']);

// The form the scaffold keeps a name, a platform or a generator id in: PDK's
// generator ids and the platform strings are lowercase words joined by
// hyphens, none over 64 characters.
const ID_FORM = /^[a-z][a-z0-9-]{0,63}$/;
const inIdForm = (value: unknown): boolean => typeof value === 'string' && ID_FORM.test(value);

// The fields the content processor keeps for a point of no known platform,
// each with the form the scaffold keeps it in; a field outside its form, or
// undefined, is left out. A chat id is a UUID. _pdk_trace_context and
// passive-data-metadata are PDK's own and go as they come, as in the
// processor's other cases.
const SCAFFOLD: Readonly<Record<string, (value: unknown) => boolean>> = {
  date: (value) => typeof value === 'number' && Number.isFinite(value),
  name: inIdForm,
  platform: inIdForm,
  identifier: (value) => asUuid(value) !== null,
  generatorId: inIdForm,
  _pdk_trace_context: (value) => value !== undefined,
  'passive-data-metadata': (value) => value !== undefined,
};
const FIELDS = [...Object.keys(SCAFFOLD), 'format_version', 'is_summary', 'started', 'ended', 'user_agent', 'turns', 'turns_complete', 'metadata'];

// A field of the event: an own property, read once, or undefined if reading
// it throws, as a getter or a proxy can.
function readOwn(event: unknown, key: string): unknown {
  try {
    return Object.hasOwn(event as object, key) ? (event as Readonly<Record<string, unknown>>)[key] : undefined;
  } catch {
    return undefined;
  }
}

const NUMBER_FORM = /^number:(\d+(?:\.\d+)?)$/;

// What a started or ended was built from, when it is a DateString the
// builders make: the ISO string of a list or of detail.mts (originalValue
// 'other:' and that string), or epoch seconds (originalValue 'number:' and
// the seconds, a project list's path); with value the same instant, as
// rex-types' Temporal.Instant or as its string, and no other own key. Else
// null, or a throw the caller catches. The case writes a new DateString from
// it, so nothing else of the object goes out: the extension uploads
// originalValue too.
function sourceOf(date: unknown): string | number | null {
  if (!isObject(date) || Object.keys(date).length !== 2 || !Object.hasOwn(date, 'value') || !Object.hasOwn(date, 'originalValue')) {
    return null;
  }
  const { value, originalValue } = date;
  const number = typeof originalValue === 'string' ? NUMBER_FORM.exec(originalValue) : null;
  const other = typeof originalValue === 'string' && originalValue.startsWith('other:') ? asListTime(originalValue.slice(6)) : null;
  const source = number === null ? other : asSeconds(Number(number[1]));
  if (source === null) {
    return null;
  }
  const iso = new DateString(source).toJSON();
  const same = typeof value === 'string' ? asListTime(value) !== null && new DateString(value).toJSON() === iso : Reflect.apply(INSTANT_TO_STRING, value, []) === iso;
  return same ? source : null;
}

// A turn in its form, or null for one the builders do not make: a speaker
// out of the two, or a reply that folds no message. Only a reply keeps the
// reply's extras.
function keepTurn(turn: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  const kept = keepAll(TURN, turn);
  if (kept.speaker === 'assistant') {
    Object.assign(kept, keepAll(REPLY, turn));
  }
  return kept.speaker === null || kept.nodes === null ? null : kept;
}

/** The record for a record the builders made, else the scaffold; never throws. */
export function redactChatGPT(event: Record<string, unknown>): Record<string, unknown> {
  const fields = Object.fromEntries(FIELDS.map((key) => [key, readOwn(event, key)]));
  const scaffold = Object.fromEntries(Object.entries(SCAFFOLD).filter(([key, holds]) => holds(fields[key])).map(([key]) => [key, fields[key]]));
  try {
    const { name, platform, identifier, format_version: version, is_summary: isSummary, date, user_agent: agent, turns, turns_complete: complete, metadata } = fields;
    // A summary has no turns and does not say whether they are complete; a
    // detail says so, and names one of the two user agents.
    const shaped = isSummary === true
      ? Array.isArray(turns) && turns.length === 0 && complete === undefined
      : isSummary === false && Array.isArray(turns) && typeof complete === 'boolean' && typeof agent === 'string' && USER_AGENTS.has(agent);
    if (name !== NAME || platform !== PLATFORM || asUuid(identifier) === null || version !== FORMAT_VERSION || !shaped || !isObject(metadata)) {
      return scaffold;
    }
    const ended = sourceOf(fields.ended);
    const started = fields.started === undefined ? undefined : sourceOf(fields.started);
    // date is a summary's end, or a detail's start when it has one, in ms.
    if (ended === null || started === null || date !== new DateString(isSummary ? ended : (started ?? ended)).timestamp()) {
      return scaffold;
    }
    const head = {
      ...scaffold, format_version: FORMAT_VERSION, is_summary: isSummary, ...(started === undefined ? {} : { started: new DateString(started) }), ended: new DateString(ended),
    };
    if (isSummary) {
      return { ...head, turns: [], metadata: keepAll(SUMMARY_METADATA, metadata) };
    }
    const objects = (turns as unknown[]).filter((turn) => isObject(turn));
    const kept = objects.map((turn) => keepTurn(turn));
    if (kept.includes(null)) {
      return scaffold;
    }
    const detail = keepAll(DETAIL_METADATA, metadata);
    if (detail.current_node !== null && !Object.hasOwn(detail.mapping as object, detail.current_node as string)) {
      detail.current_node = null;
    }
    // A turn dropped here, as not an object, leaves the turns incomplete.
    const whole = complete === true && objects.length === (turns as unknown[]).length;
    return { ...head, user_agent: agent, turns: kept, turns_complete: whole, metadata: detail };
  } catch {
    return scaffold;
  }
}
