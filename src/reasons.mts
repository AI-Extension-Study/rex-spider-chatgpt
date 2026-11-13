// The closed set of completion reasons, and the only way to build one. A
// reason is '<code> key=value ...': the code and the keys come from the
// catalogue, and every value is a count or a member of a fixed set. No field
// takes a free string, so a URL, an id, a token or a body from the site
// cannot reach the completion event.
//
// ok and partial are the passes that read the list: the whole of it, or only
// part (a list that failed or was cut). Their count is the records sent and
// their ids the chats listed in the crawl window. stop says why the sending
// ended before every chat due was handled, and is absent when it did not;
// left is how many due chats it did not reach, which a later pass sends.
// Every other code is a pass with no reading of the list, count -1.

// Why the sending of a pass that read the list ended early. budget: the
// detail reads spent the pass's reading time; mode: summarize was served
// differently from the pass's start; disabled: the spider was switched off;
// rate-limited and challenge: the site asked for a wait (a back-off is set);
// not-signed-in: a 401; failed-reads: three detail reads in a row failed;
// halt-on-error: one did, with halt_on_error; store: the extension's storage
// did not answer or did not keep a write; internal: a throw nothing expected.
export const STOPS = ['budget', 'mode', 'disabled', 'rate-limited', 'challenge', 'not-signed-in', 'failed-reads', 'halt-on-error', 'store', 'internal'] as const;

type FieldSpec =
  | { readonly kind: 'count'; readonly optional?: true }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly optional?: true };

const count = { kind: 'count' } as const;
const optionalCount = { kind: 'count', optional: true } as const;
// Where a pass with no reading of the list stopped: at the home page, which
// the token comes from, or at a list.
const place = { kind: 'enum', values: ['home', 'list'] } as const;
const home = { kind: 'enum', values: ['home'] } as const;

// What the pass had read and sent when it ended. ms, the pass's wall-clock
// time, ends every reason.
const sending = {
  listed: count, sent: count, failed: optionalCount, held: optionalCount, left: optionalCount, stop: { kind: 'enum', values: STOPS, optional: true }, ms: count,
} as const;

export const CATALOGUE = {
  // failed: detail reads that failed; held: chats held back for a later
  // pass (an archived or starred chat while the projects were not read
  // whole, or one whose memo of a failed read holds it or got no answer).
  ok: sending,
  partial: sending,
  // The list was read only in part and gave no chat in the crawl window: an
  // empty reading would look like an emptied account.
  'list-failed': { ms: count },
  // No token on the home page (no status), or a 401 (status=401).
  'not-signed-in': { stage: place, status: optionalCount, ms: count },
  // A 429, a 503 or a Retry-After, which is given in seconds when it could
  // be read.
  'rate-limited': { stage: place, status: optionalCount, 'retry-after': optionalCount, ms: count },
  // A Cloudflare challenge (cf-mitigated).
  challenge: { stage: place, status: optionalCount, ms: count },
  // The home page answered another status.
  'http-error': { stage: home, status: count, ms: count },
  // The home page gave no answer, or none in time.
  network: { stage: home, ms: count },
  timeout: { stage: home, ms: count },
  // Switched off before any request (start), or after the home page and
  // before the list was read (list).
  disabled: { stage: { kind: 'enum', values: ['start', 'list'] }, ms: count },
  // The extension's storage did not answer the crawl window's lookup.
  store: { ms: count },
  // A throw nothing expected, before the list was read.
  internal: { stage: { kind: 'enum', values: ['start', 'home', 'list'] }, ms: count },
} as const satisfies Record<string, Record<string, FieldSpec>>;

type Catalogue = typeof CATALOGUE;
export type ReasonCode = keyof Catalogue;
export const REASON_CODES = Object.keys(CATALOGUE) as readonly ReasonCode[];
export type Stop = (typeof STOPS)[number];

type ValueOf<S> = S extends { kind: 'count' } ? number : S extends { kind: 'enum'; values: readonly (infer V)[] } ? V : never;
type OptionalKey<F> = { [K in keyof F]: F[K] extends { optional: true } ? K : never }[keyof F];
export type ReasonFields<C extends ReasonCode> =
  { [K in Exclude<keyof Catalogue[C], OptionalKey<Catalogue[C]>>]: ValueOf<Catalogue[C][K]> } &
  { [K in OptionalKey<Catalogue[C]>]?: ValueOf<Catalogue[C][K]> };

// The key named is always one of the catalogue's, never the caller's.
function fail(code: string, key: string, what: string): never {
  throw new Error(`reason ${code} ${key}: ${what}`);
}

function render(code: string, key: string, spec: FieldSpec, value: unknown): string {
  if (spec.kind === 'count') {
    if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code, key, 'expected a whole number of at least 0');
    return String(value);
  }
  if (typeof value !== 'string' || !spec.values.includes(value)) fail(code, key, `expected one of ${spec.values.join(', ')}`);
  return value;
}

export function formatReason<C extends ReasonCode>(code: C, fields: ReasonFields<C>): string {
  if (!Object.hasOwn(CATALOGUE, code)) throw new Error('reason code not in the catalogue');
  const specs: Record<string, FieldSpec> = CATALOGUE[code];
  const given = fields as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(specs, key)) fail(code, '*', 'unknown key');
  }
  const parts: string[] = [code];
  for (const [key, spec] of Object.entries(specs)) {
    const value = given[key];
    if (value === undefined) {
      if (spec.optional === true) continue;
      fail(code, key, 'required');
    }
    parts.push(`${key}=${render(code, key, spec, value)}`);
  }
  return parts.join(' ');
}
