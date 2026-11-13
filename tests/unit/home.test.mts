import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOME_URL, accessToken } from '../../src/home.mts';

// A JWT-shaped stand-in: three base64url parts.
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

test('the home page is the one the spider has always read the token from', () => {
  assert.equal(HOME_URL, 'https://chatgpt.com/');
});

test('the token is read from the line that holds "accessToken":"...", as the spider has always split it', () => {
  const html = ['<!DOCTYPE html>', '<html><head>', `<script>window.__boot={"user":{"id":"u"},"accessToken":"${TOKEN}","expires":"2026-12-01"}</script>`, '</head></html>'].join('\n');
  assert.equal(accessToken(html), TOKEN);
});

test('lines split on \\r\\n as well as \\n', () => {
  assert.equal(accessToken(`<html>\r\n{"accessToken":"${TOKEN}"}\r\n</html>`), TOKEN);
});

test('of two lines that hold one, the last is read, as the spider always kept the last', () => {
  assert.equal(accessToken(`{"accessToken":"first.a.b"}\n{"accessToken":"${TOKEN}"}`), TOKEN);
});

test('a page with no token, as a signed-out session gets, reads null', () => {
  assert.equal(accessToken('<html><body>Log in</body></html>'), null);
  assert.equal(accessToken(''), null);
  // The name alone, with no value after it.
  assert.equal(accessToken('{"accessToken": null}'), null);
  assert.equal(accessToken('"accessToken"'), null);
});

test('an empty token, or one that could not go in a header, reads null rather than a token that cannot work', () => {
  assert.equal(accessToken('{"accessToken":""}'), null);
  assert.equal(accessToken('{"accessToken":"has space"}'), null);
  assert.equal(accessToken('{"accessToken":"tab\there"}'), null);
  assert.equal(accessToken('{"accessToken":"café"}'), null);
});
