/** Mastodon's HTML as text, its length count, post ids, notifications as feed messages, and the HTTP client's rate limits. */
import { afterAll, expect, test } from 'bun:test';
import { Api, ApiError, baseOf, parseLink, queryParam } from '../src/http.ts';
import { chainsOf, type Ctx, feedEntryOf, htmlToText, localIdOf, postOf, statusLength } from '../src/map.ts';

const ctx: Ctx = { host: 'social.example', domain: 'example.social', self: 'quinn@example.social' };
const account = (id: string, acct: string, extra: Record<string, unknown> = {}) => ({ id, acct, username: acct.split('@')[0], display_name: acct, avatar: `https://files.example/${id}.png`, ...extra });

test('HTML as text: paragraphs, breaks, links expanded, mentions and hashtags as words, entities', () => {
  expect(
    htmlToText(
      '<p>Hi <span class="h-card"><a href="https://x.example/@ann" class="u-url mention">@<span>ann</span></a></span> &amp; all</p><p>see <a href="https://example.com/long/path?q=1&amp;r=2" rel="nofollow"><span class="invisible">https://</span><span class="ellipsis">example.com/long/pa</span><span class="invisible">th?q=1&amp;r=2</span></a><br>and <a href="https://x.example/tags/rust" class="mention hashtag">#<span>rust</span></a></p>',
    ),
  ).toBe('Hi @ann & all\n\nsee https://example.com/long/path?q=1&r=2\nand #rust');
  expect(htmlToText(null)).toBe('');
  expect(htmlToText('<p>a&#39;b &#x1F600;</p>')).toBe("a'b 😀");
});

test("a status's length as Mastodon counts it: links 23, a remote mention by its username", () => {
  expect(statusLength('héllo 👋🏽', 23)).toBe(7);
  expect(statusLength(`see https://example.com/${'a'.repeat(200)}`, 23)).toBe(27);
  expect(statusLength('@ann@far.example hi', 23)).toBe(7);
});

test('post ids carry the host that gave them; another server\'s are not ours', () => {
  expect(localIdOf('110@social.example', ctx)).toBe('110');
  expect(localIdOf('110@elsewhere.example', ctx)).toBeNull();
  expect(localIdOf('110', ctx)).toBe('110');
  expect(localIdOf('../etc@social.example', ctx)).toBeNull();
});

test('a boost, a reply, a quote (both shapes) and a poll as PostFacts', () => {
  const people = new Map();
  const orig = { id: '1', account: account('a', 'ann'), created_at: '2026-01-01T00:00:00Z', content: '<p>orig</p>', replies_count: 0, reblogs_count: 1, favourites_count: 2 };
  const boost = postOf({ id: '2', account: account('b', 'bob@far.example'), created_at: '2026-01-01T01:00:00Z', content: '', reblog: orig }, ctx, people);
  expect(boost).toMatchObject({ id: '2@social.example', author: 'bob@far.example', text: '', repostOf: { id: '1@social.example', author: 'ann@example.social', text: 'orig' } });
  expect([...people.keys()].sort()).toEqual(['ann@example.social', 'bob@far.example']);
  const reply = postOf({ id: '3', account: account('b', 'bob@far.example'), created_at: '2026-01-01T02:00:00Z', content: '<p>yes</p>', in_reply_to_id: '1', in_reply_to_account_id: 'a', mentions: [{ id: 'a', acct: 'ann' }] }, ctx, people);
  expect(reply.replyTo).toEqual({ id: '1@social.example', author: 'ann@example.social' });
  const wrapped = postOf({ id: '4', account: account('a', 'ann'), created_at: '2026-01-01T03:00:00Z', content: '<p>q</p>', quote: { state: 'accepted', quoted_status: orig } }, ctx, people);
  expect(wrapped.quoteOf?.id).toBe('1@social.example');
  const pending = postOf({ id: '5', account: account('a', 'ann'), created_at: '2026-01-01T03:00:00Z', content: '<p>q</p>', quote: { state: 'pending', quoted_status: null } }, ctx, people);
  expect(pending.quoteOf).toBeUndefined();
  const bare = postOf({ id: '6', account: account('a', 'ann'), created_at: '2026-01-01T03:00:00Z', content: '<p>q</p>', quote: orig }, ctx, people);
  expect(bare.quoteOf?.id).toBe('1@social.example');
  const poll = postOf({ id: '7', account: account('a', 'ann'), created_at: '2026-01-01T03:00:00Z', content: '<p>Tea?</p>', poll: { options: [{ title: 'Yes', votes_count: 3 }, { title: 'No', votes_count: null }] } }, ctx, people);
  expect(poll.text).toBe('Tea?\n\n◯ Yes (3)\n◯ No');
});

test('notifications: a mention that answers you is a reply; unknown kinds are other, in words', () => {
  const status = { id: '9', account: account('a', 'ann'), created_at: '2026-01-01T00:00:00Z', content: '<p>hi</p>', in_reply_to_id: '1', in_reply_to_account_id: 'q', mentions: [{ id: 'q', acct: 'quinn' }] };
  const r = feedEntryOf({ id: 'n1', type: 'mention', account: status.account, status, created_at: '2026-01-01T00:00:00Z' }, ctx)!;
  expect(r.message).toMatchObject({ nativeId: 'reply:9@social.example', conversation: 'feed:quinn@example.social', kind: 'text', mentionsSelf: true });
  const other = feedEntryOf({ id: 'n2', type: 'some_new_kind', account: status.account, created_at: '2026-01-01T00:00:00Z' }, ctx)!;
  expect(other.message).toMatchObject({ nativeId: 'other:n2:ann@example.social', body: 'notified you (some_new_kind)', kind: 'system' });
  const warn = feedEntryOf({ id: 'n3', type: 'moderation_warning', created_at: '2026-01-01T00:00:00Z' }, ctx)!;
  expect(warn.message.author).toBe('example.social');
  expect(feedEntryOf({ id: 'n4', type: 'favourite', account: status.account, created_at: '2026-01-01T00:00:00Z' }, ctx)).toBeNull();
});

test('descendants as chains: one per direct reply, its branch depth first', () => {
  const s = (id: string, to: string) => ({ id, in_reply_to_id: to });
  const chains = chainsOf('1', [s('2', '1'), s('3', '2'), s('4', '1'), s('5', '3'), s('6', '2')], (x) => ({ id: x.id }) as any);
  expect(chains.map((c) => c.map((p) => p.id))).toEqual([
    ['2', '3', '5', '6'],
    ['4'],
  ]);
});

test('addresses, Link headers', () => {
  expect(baseOf('mastodon.example')).toBe('https://mastodon.example');
  expect(baseOf('https://mastodon.example/')).toBe('https://mastodon.example');
  expect(baseOf('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  expect(baseOf('')).toBeNull();
  const l = parseLink('<https://m.example/api/v1/x?max_id=5>; rel="next", <https://m.example/api/v1/x?min_id=9>; rel="prev"');
  expect(queryParam(l.next, 'max_id')).toBe('5');
  expect(queryParam(l.prev, 'min_id')).toBe('9');
});

// A server that answers with rate-limit headers, and 429s on demand.
let remaining = 100;
let reset = new Date(Date.now() + 60_000).toISOString();
let tooMany = 0;
const seen: { auth: string | null; path: string }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req) => {
    seen.push({ auth: req.headers.get('authorization'), path: new URL(req.url).pathname });
    const headers = { 'content-type': 'application/json', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': reset };
    if (tooMany > 0) {
      tooMany--;
      return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { ...headers, 'retry-after': '30' } });
    }
    if (new URL(req.url).pathname === '/moved') return new Response('', { status: 302, headers: { location: 'https://elsewhere.example/' } });
    if (new URL(req.url).pathname === '/missing') return new Response(JSON.stringify({ error: 'Record not found' }), { status: 404, headers });
    return new Response('{"ok":true}', { headers });
  },
});
afterAll(() => server.stop(true));

test('rate limits: a 429 waits as Retry-After says, and nothing is sent meanwhile; almost none left waits for the reset', async () => {
  const api = new Api(`http://127.0.0.1:${server.port}`, () => 'tok');
  expect((await api.req('GET', '/a')).body).toEqual({ ok: true });
  expect(seen.at(-1)!.auth).toBe('Bearer tok');
  expect(api.remaining).toBe(100);
  tooMany = 1;
  const e = (await api.req('GET', '/b').catch((x) => x)) as ApiError;
  expect(e).toBeInstanceOf(ApiError);
  expect(e.status).toBe(429);
  expect(e.retryAt! - Date.now()).toBeGreaterThan(25_000);
  const sent = seen.length;
  await expect(api.req('GET', '/c')).rejects.toThrow('asks to wait');
  expect(seen.length).toBe(sent);

  const low = new Api(`http://127.0.0.1:${server.port}`, () => null);
  remaining = 2;
  reset = new Date(Date.now() + 60_000).toISOString();
  await low.req('GET', '/d');
  expect(seen.at(-1)!.auth).toBeNull();
  await expect(low.req('GET', '/e')).rejects.toThrow('rate limit');
  remaining = 100;
});

test('errors carry the status and the server\'s words; a redirect is not followed with the token', async () => {
  const api = new Api(`http://127.0.0.1:${server.port}`, () => 'tok');
  const e = (await api.req('GET', '/missing').catch((x) => x)) as ApiError;
  expect([e.status, e.failure, e.message, e.code]).toEqual([404, 'missing', 'Record not found', 'Record not found']);
  const r = (await api.req('GET', '/moved').catch((x) => x)) as ApiError;
  expect(r.status).toBe(502);
  expect(seen.some((s) => s.path === '/' && s.auth)).toBe(false);
});
