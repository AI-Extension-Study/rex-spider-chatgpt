import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dataFormatOf } from '../../src/format.mts';

test('no data_format served is format 1, the format of every build before the key existed', () => {
  assert.equal(dataFormatOf(undefined), 1);
});

test('an integer from 1 to 999 is that format', () => {
  for (const format of [1, 2, 3, 999]) {
    assert.equal(dataFormatOf(format), format);
  }
});

test('anything else served is format 1: zero, a negative, a fraction, text, null, 1000 or more, NaN', () => {
  for (const value of [0, -1, 1.5, '2', null, 1000, NaN, Infinity, true, [2], { format: 2 }]) {
    assert.equal(dataFormatOf(value), 1, String(value));
  }
});
