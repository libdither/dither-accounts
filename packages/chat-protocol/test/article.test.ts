import { describe, expect, test } from 'bun:test';
import { htmlPreview, htmlToMarkdown } from '../src/article.ts';

describe('htmlToMarkdown', () => {
  test('paragraphs, emphasis, links, headings, code, rules and line breaks', () => {
    const md = htmlToMarkdown('<p>Hi <b>there</b>, <em>you</em> <s>old</s> <code>a`b</code><br>next</p><h3>Part <i>two</i></h3><hr><pre><code class="language-ts">let x = "*";</code></pre>', { base: 'https://example.com/p/a' });
    expect(md).toBe('Hi **there**, *you* ~~old~~ ``a`b``  \nnext\n\n### Part *two*\n\n---\n\n```ts\nlet x = "*";\n```');
  });
  test('links and pictures: http(s) only, relative ones from the base, parentheses kept inside the address', () => {
    expect(htmlToMarkdown('<p><a href="/x(1)">one</a> <a href="javascript:alert(1)">two</a> <a href="mailto:a@example.com">three</a></p>', { base: 'https://example.com/p/a' })).toBe('[one](https://example.com/x%281%29) two three');
    expect(htmlToMarkdown('<img src="data:image/png;base64,AAAA" alt="x"><img srcset="https://example.com/s.png 1x, https://example.com/l.png 2x" alt="small [one]">')).toBe('![small \\[one\\]](https://example.com/s.png)');
  });
  test('quotes and nested lists keep their structure; words that look like markup are escaped', () => {
    expect(htmlToMarkdown('<blockquote><p>a</p><p>- b</p></blockquote><ol start="3"><li>c<ul><li>d</li></ul></li><li>e</li></ol><p># not a heading *really*</p>')).toBe(
      '> a\n>\n> \\- b\n\n3. c\n\n   - d\n4. e\n\n\\# not a heading \\*really\\*',
    );
  });
  test('tables as pipes, frames and videos as links, scripts and forms gone with what they hold, drop() for furniture', () => {
    const md = htmlToMarkdown(
      '<table><tr><th>a</th><th>b</th></tr><tr><td>1|2</td><td>3</td></tr></table><iframe src="https://video.example.com/embed/1"></iframe><script>alert("<p>x</p>")</script><form><p>Sign up</p></form><div class="ad"><p>Buy</p></div><p>end</p>',
      { drop: (el) => el.attrs.class === 'ad' },
    );
    expect(md).toBe('| a | b |\n| --- | --- |\n| 1\\|2 | 3 |\n\n[Embedded: video.example.com](https://video.example.com/embed/1)\n\nend');
  });
  test("math as its TeX: MathML's alttext, MathJax's aria-label, never its glyphs", () => {
    expect(htmlToMarkdown('<p>Let <math alttext="x^2"><mi>x</mi></math> and <span class="mjx-chtml"><span class="mjx-math" aria-label="y + 1"><span>y+1</span></span></span>.</p>')).toBe('Let $x^2$ and $y + 1$.');
  });
  test("display math (MathJax's MJXc-display, MathML's display=block) is a block between lines of $$; a plain $ is escaped", () => {
    const html =
      '<p>It costs $5 and $6 so <span class="mjpage mjpage__block"><span class="mjx-chtml MJXc-display"><span class="mjx-math" aria-label="\\log_2(n) = k"><span aria-hidden="true">log</span></span></span><style>.mjx-chtml{}</style></span> holds.</p><math display="block" alttext="a+b"><mi>a</mi></math>';
    expect(htmlToMarkdown(html)).toBe('It costs \\$5 and \\$6 so\n\n$$\n\\log_2(n) = k\n$$\n\nholds.\n\n$$\na+b\n$$');
    expect(htmlPreview('<p>It costs $5.</p>')).toBe('It costs $5.');
  });
  test('entities, implied end tags and stray closers are read as a browser would', () => {
    expect(htmlToMarkdown('<p>a &amp; b &lt;c&gt; &#x1F600;<p>next</div><li>loose')).toBe('a & b \\<c\\> 😀\n\nnext\n\nloose');
  });
  test('too long is cut at a paragraph, saying so', () => {
    const md = htmlToMarkdown(Array.from({ length: 50 }, (_, i) => `<p>paragraph ${i} ${'x'.repeat(80)}</p>`).join(''), { max: 1000 });
    expect(md.length).toBeLessThan(1100);
    expect(md).toEndWith('*(The rest is too long to show here: open it on the site.)*');
  });
});

describe('htmlPreview', () => {
  test('plain words of the first paragraphs, cut at a word', () => {
    expect(htmlPreview('<h2>Title</h2><p>Some <b>bold</b> and <a href="https://example.com">a link</a> here.</p><img src="https://example.com/a.png">', 40)).toBe('Title\n\nSome bold and a link here.');
    expect(htmlPreview('<p>one two three four five six</p>', 12)).toBe('one two…');
    // A footnote mark's link (escaped brackets in its words) and an escaped literal keep their words.
    expect(htmlPreview('<p>True.<sup><a href="https://example.com/p#fn1">[1]</a></sup> And 2 * 3 = 6.</p>')).toBe('True.[1] And 2 * 3 = 6.');
    // Math keeps its TeX: underscores and backslashes are not emphasis or escapes there.
    expect(htmlPreview('<p>Cost $3 for <span class="mjx-chtml"><span class="mjx-math" aria-label="x_1 * \\alpha"></span></span> each.</p>')).toBe('Cost $3 for $x_1 * \\alpha$ each.');
  });
});
