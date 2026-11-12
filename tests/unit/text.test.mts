import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countText } from '../../src/text.mts';

test('countText counts code points and words as the shared record defines them', () => {
  assert.deepEqual(countText(''), { chars: 0, words: 0 });
  assert.deepEqual(countText('Hello, world!'), { chars: 13, words: 2 });
  assert.deepEqual(countText('** - 1.'), { chars: 7, words: 1 }); // marks alone are not words
  assert.deepEqual(countText('a\u00a0b\u3000c'), { chars: 5, words: 3 }); // no-break and ideographic spaces split
  assert.deepEqual(countText('👍🏽 ok'), { chars: 5, words: 1 }); // code points, a lone emoji is no word
});

test('countText splits words on tabs and newlines', () => {
  assert.deepEqual(countText('a\tb\nc'), { chars: 5, words: 3 });
});

test('countText keeps punctuation inside a word', () => {
  assert.deepEqual(countText("don't a-b"), { chars: 9, words: 2 });
});

test('countText counts letters outside ASCII as word characters', () => {
  assert.deepEqual(countText('\u00e9 \u65e5\u672c'), { chars: 4, words: 2 }); // e with acute, then two CJK ideographs
});
