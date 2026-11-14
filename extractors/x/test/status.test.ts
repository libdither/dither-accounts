import { expect, test } from 'bun:test';
import type { Facts } from '../src/status.ts';
import { capabilitiesOf, compute, HOOK_GRACE_MS } from '../src/status.ts';
import { selfTest } from './fixtures.ts';

const NOW = 1_800_000_000_000;
function facts(over: Partial<Facts> = {}): Facts {
  return {
    now: NOW,
    sandbox: { started: true, error: null, browserAlive: true, display: 81, liveView: true, startedAt: NOW - 200_000 },
    extensionAttached: true,
    hookTabs: 1,
    tab: 'https://x.com/i/chat',
    page: { state: 'chat', path: '/i/chat', pinMode: null, since: NOW - 200_000 },
    selfTest: selfTest(),
    self: { id: '1001', handle: 'pat_x', via: 'graph' },
    inbox: { conversations: 3, legacy: 1, xchat: 2, groups: 1, loading: false, failed: false, keysChecked: true },
    open: 0,
    dropped: null,
    droppedTotal: 0,
    lastCommand: null,
    diagnosticsAt: null,
    ...over,
  };
}

test('everything found and the chats loaded: online, every layer ok, every capability', () => {
  const c = compute(facts());
  expect(c.status).toBe('online');
  expect(c.attention).toBeNull();
  expect(c.layers.map((l) => [l.name, l.state])).toEqual([
    ['display', 'ok'],
    ['browser', 'ok'],
    ['extension', 'ok'],
    ['signed in', 'ok'],
    ['hooks', 'ok'],
    ['XChat keys', 'ok'],
    ['inbox', 'ok'],
    ['sending', 'ok'],
  ]);
  expect(c.layers.find((l) => l.name === 'signed in')!.note).toBe('as @pat_x');
  expect(c.capabilities).toEqual(['liveView', 'media', 'history', 'markRead', 'send', 'sendMedia', 'edit', 'redact', 'react', 'typing', 'forward', 'openDirect', 'requests', 'about', 'configure', 'addMembers', 'createGroup']);
  expect(c.details['hook.graph']).toBe('found (name)');
});

test("X's sign-in, a check, or the XChat PIN: attention with the live view, and the layer that waits says so", () => {
  const login = compute(facts({ page: { state: 'login', path: '/i/flow/login', pinMode: null, since: NOW }, self: null }));
  expect(login).toMatchObject({ status: 'attention', attention: { kind: 'login', liveView: true } });
  expect(login.layers.find((l) => l.name === 'signed in')).toEqual({ name: 'signed in', state: 'waiting', note: 'sign in to X in the live view' });
  expect(compute(facts({ page: { state: 'verify', path: '/account/access', pinMode: null, since: NOW } })).attention).toMatchObject({ kind: 'verify', liveView: true });
  const pin = compute(facts({ page: { state: 'pin', path: '/i/chat/pin/verify', pinMode: 'verify', since: NOW }, inbox: null, selfTest: selfTest(['inbox']) }));
  expect(pin.attention).toEqual({ kind: 'verify', message: 'Enter your XChat PIN in the live view, so this browser can open your encrypted chats', liveView: true });
  expect(pin.layers.find((l) => l.name === 'XChat keys')).toEqual({ name: 'XChat keys', state: 'waiting', note: 'enter your XChat PIN in the live view (verify)' });
});

test('a core hook missing: waiting during the grace period, then "X changed", with the layer that failed', () => {
  const early = compute(facts({ selfTest: selfTest(['graph', 'inbox']), inbox: null, page: { state: 'chat', path: '/i/chat', pinMode: null, since: NOW - 1000 } }));
  expect(early.status).toBe('connecting');
  expect(early.layers.find((l) => l.name === 'hooks')).toMatchObject({ state: 'waiting' });
  const late = compute(facts({ selfTest: selfTest(['graph', 'inbox']), inbox: null, page: { state: 'chat', path: '/i/chat', pinMode: null, since: NOW - HOOK_GRACE_MS - 1 } }));
  expect(late).toMatchObject({ status: 'attention', attention: { kind: 'selector_broken', message: 'X changed: graph, inbox no longer found, so DMs cannot be read', liveView: true } });
  expect(late.layers.find((l) => l.name === 'hooks')).toEqual({ name: 'hooks', state: 'failed', note: '21 of 23 found; not graph, inbox' });
});

test('sending not found: read-only, said plainly, and the hub is told it cannot send', () => {
  const c = compute(facts({ selfTest: selfTest(['send', 'edit', 'typing']) }));
  expect(c).toMatchObject({ status: 'attention', attention: { kind: 'selector_broken', message: 'X changed: sending was not found, so this account only reads (see its hooks)', liveView: false } });
  expect(c.layers.at(-1)).toEqual({ name: 'sending', state: 'failed', note: 'read-only: the composer events were not found' });
  expect(c.capabilities).toEqual(['liveView', 'media', 'history', 'markRead', 'redact', 'react', 'forward', 'openDirect', 'requests', 'about', 'configure', 'addMembers', 'createGroup']);
  // Only one feature missing: it says which, and the rest goes on.
  const noEdit = compute(facts({ selfTest: selfTest(['edit']) }));
  expect(noEdit.status).toBe('online');
  expect(noEdit.layers.at(-1)).toEqual({ name: 'sending', state: 'ok', note: 'can send; not edit' });
  expect(capabilitiesOf(null)).toEqual(['liveView', 'media']);
});

test('the sandbox: an error, an extension that never attached', () => {
  expect(compute(facts({ sandbox: { started: false, error: 'no free X display in :80–:89', browserAlive: false, display: null, liveView: false, startedAt: 0 } }))).toMatchObject({ status: 'error', attention: { kind: 'unknown', liveView: false } });
  const late = compute(facts({ extensionAttached: false, page: null, selfTest: null, inbox: null }));
  expect(late.attention).toMatchObject({ kind: 'unknown', message: 'The sandbox extension did not attach; open the live view to see the browser' });
  expect(late.layers.find((l) => l.name === 'extension')!.state).toBe('failed');
});

test('details: names and counts, a found/missing line per hook', () => {
  const d = compute(facts({ selfTest: selfTest(['attach'], { react: 'devtools' }), dropped: 'message.no-time 2', droppedTotal: 2 })).details;
  expect(d).toMatchObject({ hooks: '22 of 23', 'hook.react': 'found (devtools)', 'hook.attach': 'missing', dropped: 'message.no-time 2', conversations: 3, self: '1001 (graph)' });
  expect(compute(facts({ droppedTotal: 2 })).layers.find((l) => l.name === 'inbox')!.note).toBe('3 conversations: 2 XChat, 1 legacy DM; 1 groups; 2 objects dropped');
});

test('hooks checked only with a conversation open are pending until then: neither found nor missing', () => {
  const t = selfTest();
  t.hooks.attach = { ok: false, via: 'pending' };
  t.hooks.quietReads = { ok: false, via: 'pending' };
  const c = compute(facts({ selfTest: t }));
  expect(c.status).toBe('online');
  expect(c.missing).toEqual([]);
  expect(c.layers.find((l) => l.name === 'hooks')).toEqual({ name: 'hooks', state: 'ok', note: '21 of 23 found; quietReads, attach checked once a conversation is open' });
  expect(c.details).toMatchObject({ 'hook.attach': 'pending', 'hook.quietReads': 'pending', hooks: '21 of 23' });
});

test('past the conversation: each capability only where its hook was found', () => {
  const caps = (missing: string[]) => capabilitiesOf(selfTest(missing));
  expect(caps(['requests'])).not.toContain('requests');
  // Requests need answering too: a list with no way to answer it is not offered.
  expect(caps(['answer'])).not.toContain('requests');
  expect(caps(['openDirect'])).not.toContain('openDirect');
  expect(caps(['createGroup'])).not.toContain('createGroup');
  expect(caps(['addMembers'])).not.toContain('addMembers');
  expect(caps(['groupInfo'])).not.toContain('configure');
  expect(caps(['groupInfo'])).toContain('about');
  expect(caps(['inbox'])).not.toContain('about');
  expect(caps(['typing'])).not.toContain('typing');
  expect(caps(['forward'])).not.toContain('forward');
  // Each takes only its own feature away.
  expect(caps(['forward']).length).toBe(caps([]).length - 1);
});

test('the feed: its own layer and details, never the account status; profile only with its hooks', () => {
  const feedHooks = (missing: string[] = [], pending: string[] = []) => {
    const t = selfTest();
    t.feed = { webpack: { ok: true, via: 'chunk' }, store: { ok: true, via: 'provider' }, endpoints: { ok: true, via: 'thunk.api' }, notifications: { ok: true, via: 'loader' }, profiles: { ok: true, via: 'module' }, posts: { ok: true, via: 'module' }, actions: { ok: true, via: 'module' }, reactors: { ok: false, via: 'pending' } };
    for (const n of missing) t.feed![n as 'store'] = { ok: false, via: null };
    for (const n of pending) t.feed![n as 'store'] = { ok: false, via: 'pending' };
    return t;
  };
  const fd = { items: 0, people: 0, lastFetch: null, lastError: null, nextAt: NOW + 40_000, dropped: null };
  const waiting = compute(facts({ selfTest: feedHooks([], ['notifications']), feed: fd }));
  expect(waiting.status).toBe('online');
  expect(waiting.layers.at(-1)).toEqual({ name: 'feed', state: 'waiting', note: `first read at ${new Date(NOW + 40_000).toISOString().slice(11, 19)}` });
  expect(waiting.details).toMatchObject({ 'hook.webpack': 'found (chunk)', 'hook.store': 'found (provider)', 'hook.endpoints': 'found (thunk.api)', 'hook.notifications': 'pending', 'hook.profiles': 'found (module)', 'feed.items': 0 });
  expect(waiting.capabilities).toContain('profile');
  expect(waiting.capabilities).toContain('posts');
  const read = compute(facts({ selfTest: feedHooks(), feed: { ...fd, items: 9, people: 4, lastFetch: NOW - 1000, dropped: 'post.TweetTombstone 1' } }));
  expect(read.layers.at(-1)).toEqual({ name: 'feed', state: 'ok', note: `9 items, 4 profiles; read ${new Date(NOW - 1000).toISOString().slice(11, 19)}; dropped post.TweetTombstone 1` });
  expect(read.details).toMatchObject({ 'feed.items': 9, 'feed.people': 4, 'feed.lastFetch': new Date(NOW - 1000).toISOString(), 'feed.dropped': 'post.TweetTombstone 1' });
  const broken = compute(facts({ selfTest: feedHooks(['store', 'endpoints', 'profiles'], ['notifications']), feed: fd }));
  expect(broken.status).toBe('online');
  expect(broken.layers.at(-1)).toEqual({ name: 'feed', state: 'failed', note: 'X changed: store, endpoints, profiles not found, so notifications cannot be read' });
  expect(broken.capabilities).not.toContain('profile');
  expect(broken.capabilities).not.toContain('posts');
  // Each of profile and posts follows its own hook.
  expect(compute(facts({ selfTest: feedHooks(['profiles']), feed: fd })).capabilities).toContain('posts');
  expect(compute(facts({ selfTest: feedHooks(['posts']), feed: fd })).capabilities).toEqual([...waiting.capabilities.filter((c) => c !== 'posts')]);
  // Answering on X: like/repost and posting with the actions factory; who liked while its lazy chunk is pending or found.
  expect(waiting.capabilities).toEqual(expect.arrayContaining(['postActions', 'publish', 'translate', 'postReactors']));
  expect(waiting.details).toMatchObject({ 'hook.actions': 'found (module)', 'hook.reactors': 'pending' });
  const noActions = compute(facts({ selfTest: feedHooks(['actions']), feed: fd })).capabilities;
  expect(noActions).not.toContain('postActions');
  expect(noActions).not.toContain('publish');
  expect(noActions).toContain('postReactors');
  expect(compute(facts({ selfTest: feedHooks(['reactors']), feed: fd })).capabilities).not.toContain('postReactors');
  const loaded = feedHooks();
  loaded.feed!.reactors = { ok: true, via: 'loader' };
  expect(compute(facts({ selfTest: loaded, feed: fd })).capabilities).toContain('postReactors');
  const failed = compute(facts({ selfTest: feedHooks(), feed: { ...fd, lastFetch: NOW - 60_000, lastError: 'timed out' } }));
  expect(failed.layers.at(-1)).toEqual({ name: 'feed', state: 'failed', note: 'last read failed: timed out' });
});
