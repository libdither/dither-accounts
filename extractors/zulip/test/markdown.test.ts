import { expect, test } from 'bun:test';
import { Ids, linkedMessage, narrowLink } from '../src/ids.ts';
import { editedContent, fromZulip, plainText, replyQuote, toZulip, type MdCtx } from '../src/markdown.ts';

const ids = new Ids('chat.example.org');
const base = 'https://chat.example.org';
const users = [
  { user_id: 8, full_name: 'Quinn Park' },
  { user_id: 9, full_name: 'Ann Lee' },
  { user_id: 10, full_name: 'Bob Kim' },
];
const streams = [
  { id: 3, name: 'general' },
  { id: 4, name: 'design' },
];
const emoji: Record<string, string> = { smile: '😄', thumbs_up: '👍' };
const ctx: MdCtx = {
  ids,
  base,
  user: (id) => users.find((u) => u.user_id === id),
  userByName: (n) => users.find((u) => u.full_name.toLowerCase() === n.toLowerCase()),
  streamName: (id) => streams.find((s) => s.id === id)?.name,
  streamByName: (n) => streams.find((s) => s.name === n.toLowerCase())?.id,
  emoji: (n) => emoji[n],
  emojiName: (c) => Object.entries(emoji).find(([, v]) => v === c)?.[0],
  group: (id) => (id === 'chat.example.org/g/5' ? 'designers' : undefined),
  groupByName: (n) => (n === 'designers' ? 'chat.example.org/g/5' : undefined),
};

test('ids name every place on one server, and read back', () => {
  expect(ids.user(9)).toBe('chat.example.org/u/9');
  expect(ids.topic(4, 'Colors & Type')).toBe('chat.example.org/s/4/t/colors%20%26%20type');
  expect(ids.dm([9, 8, 9])).toBe('chat.example.org/dm/8,9');
  expect(ids.place('chat.example.org/s/4/t/colors%20%26%20type')).toEqual({ kind: 'topic', stream: 4, topic: 'colors & type' });
  expect(ids.place('chat.example.org/s/4/t/')).toEqual({ kind: 'topic', stream: 4, topic: '' });
  expect(ids.place('chat.example.org/dm/8')).toEqual({ kind: 'dm', users: [8] });
  expect(ids.place('other.example.org/s/4')).toBeNull();
  expect(ids.messageId('chat.example.org/m/345')).toBe(345);
  expect(ids.userId('chat.example.org/m/345')).toBeNull();
});

test('narrow links are written as the web client writes them, and their message read back', () => {
  const l = narrowLink(base, { stream: 4, streamName: 'design', topic: 'colors.v2' }, 345);
  expect(l).toBe('https://chat.example.org/#narrow/channel/4-design/topic/colors.2Ev2/near/345');
  // What Markdown or a URL would take as its own is escaped as the web client does.
  expect(narrowLink(base, { stream: 4, streamName: 'design', topic: "reply (v1.2) it's *it*!" }, 7)).toBe('https://chat.example.org/#narrow/channel/4-design/topic/reply.20.28v1.2E2.29.20it.27s.20.2Ait.2A.21/near/7');
  expect(linkedMessage(l)).toBe(345);
  expect(narrowLink(base, { dm: [8, 9] }, 7)).toBe('https://chat.example.org/#narrow/dm/8,9-dm/near/7');
});

test("Zulip's mentions, links, times and emoji become the hub's", () => {
  const p = fromZulip('hi @**Ann Lee|9** and @_**Bob Kim|10**, @**Quinn Park** see #**design>colors** and #**general** at <time:2026-12-01T15:00:00Z> :smile: :partyparrot:', ctx);
  expect(p.body).toBe('hi <@chat.example.org/u/9> and <@chat.example.org/u/10>, <@chat.example.org/u/8> see <#chat.example.org/s/4/t/colors> and <#chat.example.org/s/3> at <t:1796137200:F> 😄 :partyparrot:');
  expect(p.mentioned).toEqual(['chat.example.org/u/9', 'chat.example.org/u/10', 'chat.example.org/u/8']);
  expect(fromZulip('@**all** @**topic** @*designers* @_*designers* @*nobody*', ctx).body).toBe('@everyone @here <@&chat.example.org/g/5> <@&chat.example.org/g/5> @nobody');
});

test('code is left as written', () => {
  const src = 'look `@**Ann Lee|9**` here\n```py\nx = "@**Ann Lee|9**" :smile:\n```';
  expect(fromZulip(src, ctx).body).toBe(src);
});

test('quotes and spoilers', () => {
  expect(fromZulip('```quote\nfirst\n\nsecond\n```\nafter', ctx).body).toBe('> first\n>\n> second\nafter');
  expect(fromZulip('```spoiler The end\nthey win\n```', ctx).body).toBe('**The end** ||they win||');
});

test("a quote-reply the web client wrote is a reply to that message, without its quote", () => {
  const src = '@_**Ann Lee|9** [said](https://chat.example.org/#narrow/channel/3-general/topic/plans/near/35):\n```quote\nlunch?\n```\nyes please';
  const p = fromZulip(src, ctx);
  expect(p.replyTo).toBe('chat.example.org/m/35');
  expect(p.body).toBe('yes please');
  // A link to another server is only a link.
  expect(fromZulip(src.replace('chat.example.org/#', 'elsewhere.example.org/#'), ctx).replyTo).toBeUndefined();
  // And the quote this extractor writes reads back the same way.
  const q = replyQuote(users[1], narrowLink(base, { stream: 3, streamName: 'general', topic: 'plans' }, 35), 'lunch?\n```\ncode\n```');
  expect(q).toContain('````quote');
  expect(fromZulip(q + 'yes', ctx)).toMatchObject({ replyTo: 'chat.example.org/m/35', body: 'yes' });
});

test('uploads become attachments, and a line holding only one goes', () => {
  const p = fromZulip('the plan:\n[plan.pdf](/user_uploads/2/ab/xyz/plan.pdf)\nand [a pic](https://chat.example.org/user_uploads/2/cd/q/pic.png) inline [ext](https://example.com/x.png)', ctx);
  expect(p.attachments).toEqual([
    { nativeId: '/user_uploads/2/ab/xyz/plan.pdf', kind: 'file', mime: 'application/pdf', name: 'plan.pdf', url: 'zulip:/user_uploads/2/ab/xyz/plan.pdf' },
    { nativeId: '/user_uploads/2/cd/q/pic.png', kind: 'image', mime: 'image/png', name: 'a pic', url: 'zulip:/user_uploads/2/cd/q/pic.png' },
  ]);
  expect(p.body).toBe('the plan:\nand a pic inline [ext](https://example.com/x.png)');
  // Zulip's web client writes a picture as an image link.
  expect(fromZulip('![pic.png](/user_uploads/2/cd/q/pic.png)', ctx)).toMatchObject({ body: '', attachments: [{ kind: 'image', name: 'pic.png' }] });
});

test("the hub's body is written as Zulip Markdown", () => {
  expect(toZulip('hi <@chat.example.org/u/9>, see <#chat.example.org/s/4/t/colors> and <#chat.example.org/s/3>', ctx)).toBe('hi @**Ann Lee|9**, see #**design>colors** and #**general**');
  expect(toZulip('@everyone and @here, <@&chat.example.org/g/5>', ctx)).toBe('@**all** and @**topic**, @*designers*');
  expect(toZulip('at <t:1796137200:F>', ctx)).toBe('at <time:2026-12-01T15:00:00Z>');
  expect(toZulip('so ||secret|| ok', ctx)).toBe('so \n```spoiler\nsecret\n```\n ok');
  expect(toZulip('an __underlined__ word', ctx)).toBe('an *underlined* word');
  expect(toZulip('a _slanted_ word, a snake_case_name', ctx)).toBe('a *slanted* word, a snake_case_name');
  expect(toZulip('`<@chat.example.org/u/9>` stays', ctx)).toBe('`<@chat.example.org/u/9>` stays');
  expect(toZulip('```\n<@chat.example.org/u/9>\n```', ctx)).toBe('```\n<@chat.example.org/u/9>\n```');
  // An id the server does not know is left alone.
  expect(toZulip('<@chat.example.org/u/99>', ctx)).toBe('<@chat.example.org/u/99>');
});

test('quotes from another topic or a direct message are replies too', () => {
  const other = '@_**Ann Lee|9** [said](https://chat.example.org/#narrow/channel/3-general/topic/plans/near/35) in #**general>plans@35**:\n```quote\nlunch?\n```\nyes';
  expect(fromZulip(other, ctx)).toMatchObject({ replyTo: 'chat.example.org/m/35', body: 'yes' });
  const dm = '@_**Ann Lee|9** [said](https://chat.example.org/#narrow/dm/8,9-dm/near/36) to @_**Quinn Park|8**:\n```quote\nhi\n```\nhello';
  expect(fromZulip(dm, ctx)).toMatchObject({ replyTo: 'chat.example.org/m/36', body: 'hello' });
});

test('an edit keeps the reply quote, the uploads and silent mentions it had', () => {
  const quote = '@_**Ann Lee|9** [said](https://chat.example.org/#narrow/channel/3-general/topic/plans/near/35):\n```quote\nlunch?\n```\n';
  const old = `${quote}thanks @_**Bob Kim|10** and @**Ann Lee|9** @*designers*\n![pic.png](/user_uploads/2/cd/q/pic.png)`;
  const next = toZulip('thanks <@chat.example.org/u/10> and <@chat.example.org/u/9> <@&chat.example.org/g/5>, edited', ctx);
  expect(editedContent(old, next)).toBe(`${quote}thanks @_**Bob Kim|10** and @**Ann Lee|9** @*designers*, edited\n![pic.png](/user_uploads/2/cd/q/pic.png)`);
  // Nothing to keep: the new words as they are.
  expect(editedContent('plain', 'new')).toBe('new');
});

test("a channel's description reads as words", () => {
  expect(plainText('The **new site**, see [the plan](https://example.com/p) and `code`; ask @**Ann Lee|9** in #**general**')).toBe('The new site, see the plan (https://example.com/p) and code; ask @Ann Lee in #general');
});
