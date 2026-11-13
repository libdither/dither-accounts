import { expect, test } from 'bun:test';
import { fromTelegram, toTelegram } from '../src/entities.ts';

const e = (_: string, offset: number, length: number, extra: Record<string, unknown> = {}) => ({ _, offset, length, ...extra });

test('styles become canonical Markdown', () => {
  expect(fromTelegram('Yes, 10am at the park', [e('messageEntityBold', 5, 4)])).toBe('Yes, **10am** at the park');
  expect(fromTelegram('a b c d e', [e('messageEntityItalic', 0, 1), e('messageEntityUnderline', 2, 1), e('messageEntityStrike', 4, 1), e('messageEntitySpoiler', 6, 1)])).toBe('*a* __b__ ~~c~~ ||d|| e');
  expect(fromTelegram('run ls -la now', [e('messageEntityCode', 4, 6)])).toBe('run `ls -la` now');
  expect(fromTelegram('x\nfn main() {}\ny', [e('messageEntityPre', 2, 12, { language: 'rust' })])).toBe('x\n```rust\nfn main() {}\n```\ny');
});

test('links, mentions by name and quotes', () => {
  expect(fromTelegram('Release notes are up', [e('messageEntityTextUrl', 0, 13, { url: 'https://example.com/notes' })])).toBe('[Release notes](https://example.com/notes) are up');
  const seen: string[] = [];
  expect(fromTelegram('Test can you?', [e('messageEntityMentionName', 0, 4, { userId: 5000001 })], { onMention: (id) => seen.push(id) })).toBe('<@5000001> can you?');
  expect(seen).toEqual(['5000001']);
  expect(fromTelegram('said:\nfirst line\nsecond\nme', [e('messageEntityBlockquote', 6, 18)])).toBe('said:\n> first line\n> second\nme');
});

test('a plain @username of someone this account knows is their mention; anyone else stays text', () => {
  const known: Record<string, string> = { bob: '5000003' };
  const seen: string[] = [];
  const opts = { userByName: (n: string) => known[n.toLowerCase()] ?? null, onMention: (id: string) => seen.push(id) };
  expect(fromTelegram('ask @Bob or @nobody_here', [e('messageEntityMention', 4, 4), e('messageEntityMention', 12, 12)], opts)).toBe('ask <@5000003> or @nobody_here');
  expect(seen).toEqual(['5000003']);
  // Without a way to look names up, as before: text.
  expect(fromTelegram('ask @bob', [e('messageEntityMention', 4, 4)])).toBe('ask @bob');
  // Inside code it is code.
  expect(fromTelegram('@bob', [e('messageEntityCode', 0, 4), e('messageEntityMention', 0, 4)], opts)).toBe('`@bob`');
});

test('overlapping and messy entities still nest', () => {
  // bold over "hello wor", italic over "world": italic closes and reopens around bold's end
  expect(fromTelegram('hello world', [e('messageEntityBold', 0, 9), e('messageEntityItalic', 6, 5)])).toBe('**hello *wor****ld*');
  // edge whitespace trimmed, split at newlines
  expect(fromTelegram('a \nb', [e('messageEntityBold', 0, 4)])).toBe('**a** \n**b**');
  // a style inside code is dropped
  expect(fromTelegram('code here', [e('messageEntityCode', 0, 4), e('messageEntityBold', 1, 2)])).toBe('`code` here');
  // UTF-16 offsets: an emoji is two code units
  expect(fromTelegram('🎉 party', [e('messageEntityBold', 3, 5)])).toBe('🎉 **party**');
});

test('Markdown becomes text and entities', () => {
  const t = toTelegram('Yes, **10am** at the *park* and __here__ ~~not~~ ||secret|| `x` [docs](https://e.com)');
  expect(t.text).toBe('Yes, 10am at the park and here not secret x docs');
  expect(t.entities.map((x) => [x.type, t.text.slice(x.offset, x.offset + x.length)])).toEqual([
    ['bold', '10am'],
    ['italic', 'park'],
    ['underline', 'here'],
    ['strike', 'not'],
    ['spoiler', 'secret'],
    ['code', 'x'],
    ['textUrl', 'docs'],
  ]);
  expect(t.entities.find((x) => x.type === 'textUrl')?.url).toBe('https://e.com');
});

test('mentions, fenced code and quotes go out as Telegram does them', () => {
  const t = toTelegram('hey <@5000002>!\n```js\nlet a = 1\n```\n> quoted\n> twice\nafter', (id) => (id === '5000002' ? 'Alice' : undefined));
  expect(t.text).toBe('hey Alice!\nlet a = 1\nquoted\ntwice\nafter');
  const by = Object.fromEntries(t.entities.map((x) => [x.type, x]));
  expect(t.text.slice(by.mentionName.offset, by.mentionName.offset + by.mentionName.length)).toBe('Alice');
  expect(by.mentionName.userId).toBe('5000002');
  expect(by.pre.language).toBe('js');
  expect(t.text.slice(by.blockquote.offset, by.blockquote.offset + by.blockquote.length)).toBe('quoted\ntwice');
  // snake_case stays literal, unpaired markers too
  expect(toTelegram('a_b_c and 2*3').text).toBe('a_b_c and 2*3');
  expect(toTelegram('a_b_c and 2*3').entities).toEqual([]);
});

test('round trip', () => {
  for (const md of ['plain', '**bold** and *it*', '__u__ ~~s~~ ||sp||', 'x `code` y', '[t](https://a.b/c)', '<@42> hi', '> q\nno']) {
    const t = toTelegram(md, (id) => (id === '42' ? 'Someone' : undefined));
    const ents = t.entities.map((x) => ({
      _: { bold: 'messageEntityBold', italic: 'messageEntityItalic', underline: 'messageEntityUnderline', strike: 'messageEntityStrike', spoiler: 'messageEntitySpoiler', code: 'messageEntityCode', pre: 'messageEntityPre', textUrl: 'messageEntityTextUrl', mentionName: 'messageEntityMentionName', blockquote: 'messageEntityBlockquote' }[x.type],
      offset: x.offset,
      length: x.length,
      ...(x.url ? { url: x.url } : {}),
      ...(x.userId ? { userId: Number(x.userId) } : {}),
    }));
    expect(fromTelegram(t.text, ents)).toBe(md);
  }
});
