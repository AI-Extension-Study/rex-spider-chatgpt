// The chatgpt.com home page, which carries the access token every API call
// of a pass sends. A signed-in page holds it on one line as
// "accessToken":"<token>"; a signed-out one does not hold it.
export const HOME_URL = 'https://chatgpt.com/';

const NAME = '"accessToken"';
const START = '"accessToken":"';

// A token is sent as a header value, so one with a space, a control
// character or a character outside ASCII cannot work. It reads as no token.
const HEADER_SAFE = /^[\x21-\x7e]+$/;

// The token as the spider has always read it: from each line holding the
// name, the text from "accessToken":" on, split at the quotes, its fourth
// piece; the last such line wins. Null when no line holds one that could be
// sent.
export function accessToken(html: string): string | null {
  let token: string | null = null;
  for (const line of html.match(/[^\r\n]+/g) ?? []) {
    if (!line.includes(NAME)) {
      continue;
    }
    const at = line.indexOf(START);
    if (at === -1) {
      continue;
    }
    const pieces = line.substring(at).split('"');
    if (pieces.length > 3) {
      token = pieces[3];
    }
  }
  return token !== null && HEADER_SAFE.test(token) ? token : null;
}
