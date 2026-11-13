import { describe, expect, test } from 'bun:test';
import { fromSignal, MENTION_PLACEHOLDER as M, plainText, toSignal } from '../src/markdown.ts';
import type { SigTextStyle } from '../src/types.ts';

const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const SAM = '5a3e0000-3333-4eee-afff-000000000003';

const st = (text: string, sub: string, style: string, nth = 0): SigTextStyle => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(sub, i + 1);
  if (i < 0) throw new Error(`no ${sub}`);
  return { style, start: i, length: sub.length };
};

describe('fromSignal (body ranges -> Markdown)', () => {
  test('plain text passes through', () => {
    expect(fromSignal('hello there', null, null)).toBe('hello there');
    expect(fromSignal(null, null, null)).toBe('');
  });

  test('every style, plus mentions as <@aci>', () => {
    const text = `Hey ${M} and ${M}, the purple V4 is evil. It was easy. Spoiler: I flashed it. Beta: heel hook`;
    const seen: string[] = [];
    const md = fromSignal(
      text,
      [st(text, 'purple V4', 'BOLD'), st(text, 'evil', 'ITALIC'), st(text, 'easy', 'STRIKETHROUGH'), st(text, 'I flashed it', 'SPOILER'), st(text, 'heel hook', 'MONOSPACE')],
      [
        { uuid: SELF, number: '+15550100', start: 4, length: 1 },
        { uuid: SAM, number: '+15550161', start: 10, length: 1 },
      ],
      { onMention: (a) => seen.push(a) },
    );
    expect(md).toBe(`Hey <@${SELF}> and <@${SAM}>, the **purple V4** is *evil*. It was ~~easy~~. Spoiler: ||I flashed it||. Beta: \`heel hook\``);
    expect(seen).toEqual([SELF, SAM]);
  });

  test('ranges are UTF-16 code units (emoji before a style)', () => {
    const text = '🧗‍♀️ send it';
    expect(fromSignal(text, [st(text, 'send', 'BOLD')], null)).toBe('🧗‍♀️ **send** it');
  });

  test('nested styles: the longer one is outside', () => {
    const text = 'very important news';
    expect(fromSignal(text, [{ style: 'BOLD', start: 0, length: text.length }, st(text, 'important', 'ITALIC')], null)).toBe('**very *important* news**');
    // same range: bold outside italic
    expect(fromSignal('both', [{ style: 'ITALIC', start: 0, length: 4 }, { style: 'BOLD', start: 0, length: 4 }], null)).toBe('***both***');
  });

  test('same-style ranges merge', () => {
    expect(fromSignal('abcdef', [{ style: 'BOLD', start: 0, length: 3 }, { style: 'BOLD', start: 3, length: 3 }], null)).toBe('**abcdef**');
  });

  test('emphasis does not start or end on whitespace and does not cross lines', () => {
    expect(fromSignal('a bold b', [{ style: 'BOLD', start: 1, length: 6 }], null)).toBe('a **bold** b');
    expect(fromSignal('line one\nline two', [{ style: 'BOLD', start: 0, length: 17 }], null)).toBe('**line one**\n**line two**');
  });

  test('multi-line monospace becomes a fenced block; code nests inside bold', () => {
    const code = 'fn main() {\n  println!("hi");\n}';
    const text = `look:\n${code}`;
    expect(fromSignal(text, [st(text, code, 'MONOSPACE')], null)).toBe(`look:\n\`\`\`\n${code}\n\`\`\``);
    const t2 = 'run cargo build now';
    expect(fromSignal(t2, [{ style: 'BOLD', start: 0, length: t2.length }, st(t2, 'cargo build', 'MONOSPACE')], null)).toBe('**run `cargo build` now**');
  });

  test('styles that start or end inside code are clipped, inside code dropped', () => {
    const t = 'abc defg hij';
    // italic over "c def" partially overlaps code "defg": clipped to "c"
    expect(fromSignal(t, [st(t, 'defg', 'MONOSPACE'), { style: 'ITALIC', start: 2, length: 5 }], null)).toBe('ab*c* `defg` hij');
    // bold strictly inside code: dropped
    expect(fromSignal(t, [st(t, 'defg', 'MONOSPACE'), st(t, 'ef', 'BOLD')], null)).toBe('abc `defg` hij');
  });

  test('crossing ranges still produce balanced markers', () => {
    const md = fromSignal('abcdefghijklmnop', [{ style: 'BOLD', start: 0, length: 10 }, { style: 'ITALIC', start: 5, length: 10 }], null);
    expect(md.replace(/[*]/g, '')).toBe('abcdefghijklmnop');
    expect((md.match(/\*/g) ?? []).length % 2).toBe(0);
    expect(md.startsWith('**abcde*')).toBe(true);
  });

  test('bad ranges are clamped or ignored; unknown styles ignored', () => {
    expect(fromSignal('abc', [{ style: 'BOLD', start: -5, length: 7 }], null)).toBe('**ab**c');
    expect(fromSignal('abc', [{ style: 'BOLD', start: 2, length: 50 }, { style: 'UNDERLINE', start: 0, length: 1 }], null)).toBe('ab**c**');
    expect(fromSignal('abc', [{ style: 'BOLD', start: 5, length: 2 }], null)).toBe('abc');
  });

  test('mention without an ACI falls back to the number', () => {
    expect(fromSignal(`hi ${M}`, null, [{ number: '+15550161', start: 3, length: 1 }])).toBe('hi @+15550161');
  });

  test('plainText renders mentions with names', () => {
    expect(plainText(`hi ${M}!`, [{ uuid: SAM, start: 3, length: 1 }], (a) => (a === SAM ? 'Sam' : undefined))).toBe('hi @Sam!');
  });
});

describe('toSignal (Markdown -> body ranges)', () => {
  test('every style', () => {
    const r = toSignal('**bold** *it* _it2_ ~~gone~~ ||secret|| `code`');
    expect(r.text).toBe('bold it it2 gone secret code');
    expect(r.textStyles).toEqual(['0:4:BOLD', '5:2:ITALIC', '8:3:ITALIC', '12:4:STRIKETHROUGH', '17:6:SPOILER', '24:4:MONOSPACE']);
  });

  test('mentions become U+FFFC placeholders', () => {
    const r = toSignal(`<@${SAM}> are you coming? cc <@!${SELF}>`);
    expect(r.text).toBe(`${M} are you coming? cc ${M}`);
    expect(r.mentions).toEqual([`0:1:${SAM}`, `${r.text.length - 1}:1:${SELF}`]);
  });

  test('things that are not markup stay literal', () => {
    expect(toSignal('my_var_name and snake_case').text).toBe('my_var_name and snake_case');
    expect(toSignal('2 * 3 * 4').text).toBe('2 * 3 * 4');
    expect(toSignal('* bullet').text).toBe('* bullet');
    expect(toSignal('unclosed **bold').text).toBe('unclosed **bold');
    expect(toSignal('<@not-a-uuid>').text).toBe('<@not-a-uuid>');
    expect(toSignal('a ~ b | c').text).toBe('a ~ b | c');
  });

  test('nesting and bold+italic', () => {
    expect(toSignal('**bold *both* bold**').styles).toEqual([
      { style: 'BOLD', start: 0, length: 14 },
      { style: 'ITALIC', start: 5, length: 4 },
    ]);
    const r = toSignal('***both***');
    expect(r.text).toBe('both');
    expect(r.textStyles.sort()).toEqual(['0:4:BOLD', '0:4:ITALIC']);
  });

  test('fenced code, links, escapes, underline', () => {
    expect(toSignal('```ts\nconst x = 1;\n```')).toMatchObject({ text: 'const x = 1;', textStyles: ['0:12:MONOSPACE'] });
    expect(toSignal('see [the docs](https://example.org/x)').text).toBe('see the docs (https://example.org/x)');
    expect(toSignal('[https://a.b](https://a.b)').text).toBe('https://a.b');
    expect(toSignal('\\*not italic\\*').text).toBe('*not italic*');
    expect(toSignal('__underlined__')).toMatchObject({ text: 'underlined', textStyles: [] });
  });

  test('round trip: Markdown we produce parses back to the same ranges', () => {
    const cases: [string, SigTextStyle[]][] = [
      ['the purple V4 is evil', [{ style: 'BOLD', start: 4, length: 9 }, { style: 'ITALIC', start: 17, length: 4 }]],
      ['spoiler: I flashed it', [{ style: 'SPOILER', start: 9, length: 12 }]],
      ['very important news', [{ style: 'BOLD', start: 0, length: 19 }, { style: 'ITALIC', start: 5, length: 9 }]],
      ['run cargo build now', [{ style: 'STRIKETHROUGH', start: 0, length: 3 }, { style: 'MONOSPACE', start: 4, length: 11 }]],
      ['both', [{ style: 'BOLD', start: 0, length: 4 }, { style: 'ITALIC', start: 0, length: 4 }]],
    ];
    for (const [text, styles] of cases) {
      const back = toSignal(fromSignal(text, styles, null));
      expect(back.text).toBe(text);
      const key = (s: SigTextStyle) => `${s.start}:${s.length}:${s.style}`;
      expect(back.styles.map(key).sort()).toEqual(styles.map(key).sort());
    }
    const withMention = toSignal(fromSignal(`hey ${M}`, null, [{ uuid: SAM, start: 4, length: 1 }]));
    expect(withMention).toMatchObject({ text: `hey ${M}`, mentions: [`4:1:${SAM}`] });
  });
});
