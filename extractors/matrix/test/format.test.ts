import { describe, expect, test } from 'bun:test';
import { escapeMarkdown, htmlToMarkdown, markdownToMatrix, parseMatrixLink, snippet, stripReplyFallback } from '../src/format.ts';

const names = {
  user: (id: string) => ({ '@alice:dither.test': 'Alice Chen', '@quinn:dither.test': 'Quinn' })[id],
  room: (id: string) => ({ '!general:dither.test': 'general' })[id],
};

describe('htmlToMarkdown', () => {
  test('inline formatting', () => {
    expect(htmlToMarkdown('<strong>bold</strong> <em>it</em> <u>under</u> <del>gone</del> <code>x = 1</code>')).toBe(
      '**bold** *it* __under__ ~~gone~~ `x = 1`',
    );
  });
  test('spoilers, links and mention pills', () => {
    expect(htmlToMarkdown('<span data-mx-spoiler>secret</span>')).toBe('||secret||');
    expect(htmlToMarkdown('<a href="https://matrix.to/#/@quinn:dither.test">Quinn</a>: look')).toBe('<@@quinn:dither.test>: look');
    expect(htmlToMarkdown('<a href="https://matrix.to/#/%40quinn%3Adither.test">Quinn</a>')).toBe('<@@quinn:dither.test>');
    expect(htmlToMarkdown('see <a href="https://example.com/a_b">the docs</a>')).toBe('see [the docs](https://example.com/a_b)');
    expect(htmlToMarkdown('<a href="https://example.com">https://example.com</a>')).toBe('https://example.com');
    expect(htmlToMarkdown('<a href="https://matrix.to/#/!abc:dither.test?via=dither.test">room</a>')).toBe('<#!abc:dither.test>');
  });
  test('reply fallback is dropped', () => {
    const html =
      '<mx-reply><blockquote><a href="https://matrix.to/#/!r/$e">In reply to</a> <a href="https://matrix.to/#/@alice:dither.test">@alice:dither.test</a><br>Welcome!</blockquote></mx-reply>thanks!';
    expect(htmlToMarkdown(html)).toBe('thanks!');
  });
  test('blocks: paragraphs, quotes, code, lists', () => {
    expect(htmlToMarkdown('<p>one</p>\n<p>two</p>')).toBe('one\n\ntwo');
    expect(htmlToMarkdown('a<br />b')).toBe('a\nb');
    expect(htmlToMarkdown('<blockquote>quoted<br>more</blockquote>after')).toBe('> quoted\n> more\nafter');
    expect(htmlToMarkdown('<pre><code class="language-rust">fn main() {\n    *x = 1;\n}\n</code></pre>')).toBe('```rust\nfn main() {\n    *x = 1;\n}\n```');
    expect(htmlToMarkdown('<ul><li>a</li><li>b<ul><li>c</li><li>d</li></ul></li></ul>')).toBe('- a\n- b\n  - c\n  - d');
    expect(htmlToMarkdown('<ol start="3"><li>x</li><li>y</li></ol>')).toBe('3. x\n4. y');
  });
  test('literal markdown characters are escaped, URLs are not', () => {
    expect(htmlToMarkdown('2*3*4 and __init__ but snake_case')).toBe('2\\*3\\*4 and \\_\\_init\\_\\_ but snake_case');
    expect(htmlToMarkdown('go to https://example.com/a_b_c?x=*')).toBe('go to https://example.com/a_b_c?x=*');
    expect(htmlToMarkdown('&lt;@@fake:x&gt; &amp; ~~no~~')).toBe('\\<@@fake:x> & \\~\\~no\\~\\~');
  });
  test('emoticons and images', () => {
    expect(htmlToMarkdown('<img data-mx-emoticon src="mxc://x/y" alt=":blobcat:"> hi')).toBe(':blobcat: hi');
  });
});

describe('stripReplyFallback', () => {
  test('strips the quoted fallback', () => {
    expect(stripReplyFallback('> <@alice:dither.test> Welcome!\n> second line\n\nthanks!')).toBe('thanks!');
  });
  test('keeps a genuine quote without the blank line', () => {
    expect(stripReplyFallback('> quoted\nnot a fallback')).toBe('> quoted\nnot a fallback');
    expect(stripReplyFallback('plain')).toBe('plain');
  });
});

describe('markdownToMatrix', () => {
  test('plain text has no formatted body', () => {
    const r = markdownToMatrix('hello world', names);
    expect(r).toEqual({ body: 'hello world', mentions: [] });
  });
  test('formatting and mentions', () => {
    const r = markdownToMatrix('hey <@@alice:dither.test>, **look** at `x<y` and ||this||', names);
    expect(r.body).toBe('hey Alice Chen, **look** at `x<y` and ||this||');
    expect(r.formatted).toBe(
      'hey <a href="https://matrix.to/#/@alice:dither.test">Alice Chen</a>, <strong>look</strong> at <code>x&lt;y</code> and <span data-mx-spoiler>this</span>',
    );
    expect(r.mentions).toEqual(['@alice:dither.test']);
  });
  test('nested emphasis, underline, strike, links', () => {
    expect(markdownToMatrix('*a **b** c*', names).formatted).toBe('<em>a <strong>b</strong> c</em>');
    expect(markdownToMatrix('__u__ ~~s~~ [docs](https://e.com/x)', names).formatted).toBe('<u>u</u> <del>s</del> <a href="https://e.com/x">docs</a>');
    expect(markdownToMatrix('snake_case_name stays', names).formatted).toBeUndefined();
    expect(markdownToMatrix('\\*not italic\\*', names).formatted).toBeUndefined();
  });
  test('quotes, fenced code and line breaks', () => {
    const r = markdownToMatrix('> quoted\nreply\nsecond\n```ts\nlet a = 1;\n```\nafter', names);
    expect(r.formatted).toBe(
      '<blockquote>quoted</blockquote>reply<br />second<pre><code class="language-ts">let a = 1;\n</code></pre>after',
    );
  });
  test('round trip through htmlToMarkdown', () => {
    const md = '**bold** *it* __u__ ~~s~~ `c` ||sp|| <@@quinn:dither.test>';
    expect(htmlToMarkdown(markdownToMatrix(md, names).formatted!)).toBe(md);
  });
});

describe('helpers', () => {
  test('parseMatrixLink', () => {
    expect(parseMatrixLink('matrix:u/alice:dither.test')).toEqual({ kind: 'user', id: '@alice:dither.test' });
    expect(parseMatrixLink('https://matrix.to/#/!r:x/$ev?via=x')).toEqual({ kind: 'room', id: '!r:x', event: '$ev' });
    expect(parseMatrixLink('https://example.com')).toBeNull();
  });
  test('snippet', () => {
    expect(snippet('**CI is red** on `main`, <@@quinn:dither.test> please look at the flaky network test before lunch', 40, (u) => names.user(u) ?? u)).toBe(
      'CI is red on main, Quinn please look at…',
    );
  });
  test('escapeMarkdown leaves ordinary text alone', () => {
    expect(escapeMarkdown("it's 5 o'clock ~ish | a|b")).toBe("it's 5 o'clock ~ish | a|b");
  });
});
