import { describe, expect, test } from 'bun:test';
import { canonicalReactionKey as c } from '../src/index.ts';

describe('canonicalReactionKey', () => {
  test('one form for the same emoji, however a client spelled it', () => {
    expect(c('❤')).toBe('❤️'); // a bare heart renders as text; fully qualified
    expect(c('❤️')).toBe('❤️');
    expect(c('👍️')).toBe('👍'); // Element's spelling: a variation selector it does not need
    expect(c('👍')).toBe('👍');
  });

  test('sequences keep their shape', () => {
    for (const e of ['❤️‍🔥', '🏳️‍🌈', '🏴‍☠️', '👁️‍🗨️', '👍🏽', '☝🏽', '⛹🏽‍♂️', '🤷‍♂️', '1️⃣', '#️⃣', '🇺🇸', '👨‍👩‍👧‍👦']) expect(c(e)).toBe(e);
    expect(c('🏳‍🌈')).toBe('🏳️‍🌈');
    expect(c('1⃣')).toBe('1️⃣');
  });

  test('leaves what is not an emoji alone', () => {
    for (const k of ['+1', 'lol 123', 'party:123456', 'mxc://server/abc', 'ok #1']) expect(c(k)).toBe(k);
  });
});
