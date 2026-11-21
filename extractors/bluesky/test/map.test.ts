/** The bluesky kind's mapping (ids, facets, text) and its XRPC client's rate limits, without a manager. */
import { afterAll, expect, test } from 'bun:test';
import { feedEntryOf, findFacets, graphemes, homeItemOf, postIdOf, textOf, uriOfPost } from '../src/map.ts';
import { Xrpc } from '../src/xrpc.ts';

const DID = 'did:plc:aliceaaaaaaaaaaaaaaaaaaa';
const ctx = { self: 'did:plc:quinnaaaaaaaaaaaaaaaaaaa', web: 'https://bsky.app' };

test('post ids are <did>~<rkey> and back', () => {
  expect(postIdOf(`at://${DID}/app.bsky.feed.post/3kabcdefghij2`)).toBe(`${DID}~3kabcdefghij2`);
  expect(uriOfPost(`${DID}~3kabcdefghij2`)).toBe(`at://${DID}/app.bsky.feed.post/3kabcdefghij2`);
  expect(uriOfPost('did:web:alice.example~abc')).toBe('at://did:web:alice.example/app.bsky.feed.post/abc');
  expect(uriOfPost('12345')).toBeNull();
  expect(uriOfPost(`${DID}/abc`)).toBeNull();
});

test('link facets put the whole address back, counting UTF-8 bytes', () => {
  const shown = 'é 🌊 example.com/lo…';
  const start = new TextEncoder().encode('é 🌊 ').length;
  const end = new TextEncoder().encode(shown).length;
  const rec = { text: `${shown} after`, facets: [{ index: { byteStart: start, byteEnd: end }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/long/path' }] }] };
  expect(textOf(rec)).toBe('é 🌊 https://example.com/long/path after');
  // A facet out of range is left alone.
  expect(textOf({ text: 'short', facets: [{ index: { byteStart: 2, byteEnd: 99 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }] }] })).toBe('short');
});

test('facets found in words: links without trailing punctuation, handles, tags', () => {
  const text = '🌊 see (https://example.com/a?b=1). @ann.example #café!';
  const spans = findFacets(text);
  const bytes = new TextEncoder().encode(text);
  expect(spans.map((s) => [s.kind, s.value, new TextDecoder().decode(bytes.slice(s.start, s.end))])).toEqual([
    ['link', 'https://example.com/a?b=1', 'https://example.com/a?b=1'],
    ['mention', 'ann.example', '@ann.example'],
    ['tag', 'café', '#café'],
  ]);
  expect(findFacets('mail me at ann@example.com')).toEqual([]);
});

test('graphemes count as Bluesky counts them', () => {
  expect(graphemes('👨‍👩‍👧é')).toBe(2);
});

test('a repost in a timeline without its record uri gets an id of its own', () => {
  const people = new Map();
  const item = homeItemOf(
    { post: { uri: `at://${DID}/app.bsky.feed.post/p1`, cid: 'c', author: { did: DID, handle: 'alice.example' }, record: { text: 'hi', createdAt: '2026-01-01T00:00:00Z' } }, reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: { did: ctx.self, handle: 'quinn.example' }, indexedAt: '2026-01-02T00:00:00Z' } },
    ctx,
    people,
  );
  expect(item.post).toMatchObject({ id: `${ctx.self}~rp1`, author: ctx.self, text: '', repostOf: { id: `${DID}~p1` } });
  expect([...people.keys()].sort()).toEqual([DID, ctx.self].sort());
});

test('a like of a post the server no longer shows still names it', () => {
  const e = feedEntryOf({ uri: `at://${DID}/app.bsky.feed.like/l1`, author: { did: DID, handle: 'alice.example' }, reason: 'like', reasonSubject: `at://${ctx.self}/app.bsky.feed.post/gone`, indexedAt: '2026-01-01T00:00:00Z' }, new Map(), ctx)!;
  expect(e.message).toMatchObject({ nativeId: `like:${ctx.self}~gone:${DID}`, body: 'liked your post', extra: { feed: { type: 'like' } } });
});

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    const reset = String(Math.ceil(Date.now() / 1000) + 60);
    if (path.endsWith('.low')) return Response.json({ ok: true }, { headers: { 'ratelimit-remaining': '2', 'ratelimit-reset': reset } });
    if (path.endsWith('.limited')) return Response.json({ error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' }, { status: 429, headers: { 'retry-after': '30' } });
    if (path.endsWith('.expired')) return Response.json({ error: 'ExpiredToken', message: 'Token has expired' }, { status: 400 });
    return Response.json({ auth: req.headers.get('authorization') }, { headers: { 'ratelimit-remaining': '100', 'ratelimit-reset': reset } });
  },
});
afterAll(() => server.stop(true));

test('the client: the bearer only to its own host, an expired token is auth, rate limits held back', async () => {
  const x = new Xrpc(`http://127.0.0.1:${server.port}`, () => 'tok');
  expect(await x.query('a.b.ok')).toEqual({ auth: 'Bearer tok' });
  expect(await x.query('a.b.ok', {}, { anonymous: true })).toEqual({ auth: null });
  await expect(x.query('a.b.expired')).rejects.toMatchObject({ failure: 'auth', code: 'ExpiredToken', status: 400 });
  // Three or fewer left: nothing more is sent until the reset.
  await x.query('a.b.low');
  await expect(x.query('a.b.ok')).rejects.toMatchObject({ failure: 'rate', status: 429 });
  const y = new Xrpc(`http://127.0.0.1:${server.port}`, () => null);
  const before = Date.now();
  await expect(y.procedure('a.b.limited', {})).rejects.toMatchObject({ failure: 'rate', status: 429 });
  expect(y.limitedUntil).toBeGreaterThanOrEqual(before + 29_000);
});
