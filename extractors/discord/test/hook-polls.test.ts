/**
 * hook.js's polls and pins section against a small replica of the client (hook-attention.test.ts's harness): a poll
 * read from the gateway's object and from the client's record, votes forwarded with the poll as the store counts it,
 * voting and ending through the client's own poll actions (its REST helper without them), making one through its
 * sendPollMessage, and pins as the pin button and pins popout ask for them.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';

const KEY = 'discord-hook-polls-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const GUILD = '200000000000000001';
const CHAN = '300000000000000200';
const ME = '100000000000000001';
const ALICE = '400000000000000001';
const POLL_MSG = '500000000000000009';

const Routes = {
  POLL_ANSWERS: (c: string, m: string) => `/channels/${c}/polls/${m}/answers/@me`,
  POLL_EXPIRE: (c: string, m: string) => `/channels/${c}/polls/${m}/expire`,
};

/** A poll as the client's record keeps it: its votes as reactions of their own kind. */
const record = () => ({
  id: POLL_MSG,
  channel_id: CHAN,
  author: { id: ALICE, username: 'alice' },
  content: '',
  timestamp: '2026-11-12T10:00:00.000Z',
  type: 0,
  poll: {
    question: { text: 'Lunch?' },
    answers: [{ answer_id: 1, poll_media: { text: 'Pizza' } }, { answer_id: 2, poll_media: { text: 'Tacos', emoji: { id: null, name: '🌮' } } }],
    expiry: new Date('2026-11-13T10:00:00.000Z'),
    allow_multiselect: false,
    layout_type: 1,
  },
  reactions: [
    { emoji: { id: '1', name: '' }, count: 0, count_details: { vote: 3 }, me_vote: false },
    { emoji: { id: '2', name: '' }, count: 0, count_details: { vote: 1 }, me_vote: true },
  ],
});

function client(opts: { pollActions?: boolean } = {}) {
  const handlers = new Map<string, ((a: any) => void)[]>();
  const calls: any[] = [];
  const messages: Record<string, any> = { [POLL_MSG]: record() };
  const dispatcher = {
    dispatch: (a: any) => void calls.push(['dispatch', a]),
    subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    unsubscribe() {},
    isDispatching: () => false,
    _subscriptions: {},
  };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, ...extra });
  const rest: Record<string, any> = {};
  for (const k of ['get', 'post', 'put', 'patch', 'del'])
    rest[k] = async (o: any) => {
      calls.push([k, o.url, o.body ?? o.query]);
      if (k === 'get' && /\/messages\/pins$/.test(o.url))
        return { body: { items: o.query?.before ? [] : [{ pinned_at: '2026-11-11T09:00:00.000Z', message: { id: '7', channel_id: CHAN, author: { id: ALICE, username: 'alice' }, content: 'read this', timestamp: '2026-11-10T09:00:00.000Z', type: 0 } }], has_more: false } };
      if (k === 'post' && /\/messages$/.test(o.url)) return { body: { id: '800' } };
      return { body: {} };
    };
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => ({ id: ME, username: 'me' }), getUser: (id: string) => ({ id, username: `u${id}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => (id === CHAN ? { id: CHAN, type: 0, guild_id: GUILD, name: 'food' } : null), getMutablePrivateChannels: () => ({}) });
    e.D = store('GuildStore', { getGuilds: () => ({ [GUILD]: { id: GUILD, name: 'Lunch club' } }), getGuild: () => ({ id: GUILD, name: 'Lunch club' }) });
    e.E = store('MessageStore', { getMessage: (c: string, m: string) => (c === CHAN ? (messages[m] ?? null) : null) });
    e.H = rest;
    e.M = {
      sendMessage: async () => ({ body: { id: '1' } }),
      editMessage() {},
      sendPollMessage: async (c: string, poll: any, o: any) => (calls.push(['sendPollMessage', c, poll, o]), { body: { id: '801' } }),
    };
  };
  // The client's poll actions, under mangled names: a PUT of your answers and a POST that ends the poll.
  const pollModule = (_m: any, e: any) => {
    e.Q = async function (o: any) {
      calls.push(['vote', Routes.POLL_ANSWERS(o.channelId, o.messageId), { answer_ids: o.answerIds }]);
    };
    e.w = async function (o: any) {
      calls.push(['expire', Routes.POLL_EXPIRE(o.channelId, o.messageId)]);
    };
  };
  const mods: Record<string, any> = { client: modules };
  if (opts.pollActions !== false) mods.polls = pollModule;
  return { handlers, calls, messages, mods, emit: (ev: string, a: any) => (handlers.get(ev) ?? []).forEach((fn) => fn(a)) };
}

function page(c: ReturnType<typeof client>) {
  const posted: any[] = [];
  const timers: (() => void)[] = [];
  const events = new EventTarget();
  events.addEventListener(UP, (e: any) => {
    if (e.detail === null || e.detail === undefined) events.dispatchEvent(new CustomEvent(DOWN, { detail: null }));
    else posted.push(e.detail);
  });
  const win: any = {
    addEventListener: (type: string, fn: (e: any) => void) => events.addEventListener(type, fn),
    dispatchEvent: (e: Event) => events.dispatchEvent(e),
    down: (payload: any) => events.dispatchEvent(new CustomEvent(DOWN, { detail: payload })),
  };
  const doc: any = { readyState: 'complete', addEventListener() {}, querySelector: () => null, body: { innerText: '' } };
  const loc = { origin: 'https://discord.com', href: 'https://discord.com/app', pathname: '/app', reload() {} };
  const session = { getItem: () => null, setItem() {} };
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', HOOK)(win, doc, loc, { webdriver: false }, session, (fn: () => void) => timers.push(fn), () => {});
  const cache: Record<string, { exports: any }> = {};
  const T: any = (id: string) => cache[id]!.exports;
  T.c = cache;
  (win.webpackChunkdiscord_app = win.webpackChunkdiscord_app || []).push = function (chunkData: any) {
    const [, mods, run] = chunkData;
    for (const id in mods) {
      const m = (cache[id] = { exports: {} });
      mods[id](m, m.exports, T);
    }
    if (run) run(T);
  };
  win.webpackChunkdiscord_app.push([['700'], c.mods]);
  timers.splice(0).forEach((fn) => fn());
  const cmd = async (id: string, command: unknown) => {
    win.down({ t: 'cmd', id, cmd: command });
    for (let i = 0; i < 8; i++) await Bun.sleep(0);
    return posted.find((m) => m.t === 'reply' && m.id === id);
  };
  return { posted, cmd };
}

describe("hook.js's polls and pins", () => {
  test('finds the poll actions by what they ask for', () => {
    const c = client();
    const report = page(c).posted.filter((m) => m.t === 'finders').pop();
    expect(report?.results).toMatchObject({ PollActions: true });
  });

  test("a vote is forwarded with the poll as the client now counts it, your own answers marked; nobody's name", () => {
    const c = client();
    const p = page(c);
    c.emit('MESSAGE_REACTION_ADD', { channelId: CHAN, messageId: POLL_MSG, userId: ALICE, emoji: { id: '1', name: '' }, reactionType: 2 });
    const d = p.posted.find((m) => m.t === 'dispatch' && m.event === 'MESSAGE_REACTION_ADD');
    expect(d.data.poll).toEqual({
      question: 'Lunch?',
      answers: [{ id: '1', text: 'Pizza' }, { id: '2', text: 'Tacos', emoji: { id: null, name: '🌮', animated: false } }],
      expiry: '2026-11-13T10:00:00.000Z',
      allow_multiselect: false,
      finalized: false,
      counts: { '1': 3, '2': 1 },
      mine: ['2'],
    });
    // An ordinary reaction carries no poll.
    c.emit('MESSAGE_REACTION_REMOVE', { channelId: CHAN, messageId: POLL_MSG, userId: ALICE, emoji: { id: null, name: '👍' }, reactionType: 0 });
    expect(p.posted.find((m) => m.t === 'dispatch' && m.event === 'MESSAGE_REACTION_REMOVE').data.poll).toBeUndefined();
  });

  test("a message from the gateway carries its poll's results", () => {
    const c = client();
    const p = page(c);
    c.emit('MESSAGE_CREATE', {
      channelId: CHAN,
      message: { id: '9', channel_id: CHAN, author: { id: ALICE, username: 'alice' }, content: '', timestamp: '2026-11-12T10:00:00.000Z', type: 0, poll: { question: { text: 'Q' }, answers: [{ answer_id: 1, poll_media: { text: 'a' } }], expiry: '2026-11-13T10:00:00.000Z', allow_multiselect: true, results: { is_finalized: true, answer_counts: [{ id: 1, count: 2, me_voted: true }] } } },
    });
    const d = p.posted.find((m) => m.t === 'dispatch' && m.event === 'MESSAGE_CREATE');
    expect(d.data.message.poll).toMatchObject({ question: 'Q', allow_multiselect: true, finalized: true, counts: { '1': 2 }, mine: ['1'] });
  });

  test("voting and ending go through the client's own poll actions", async () => {
    const c = client();
    const p = page(c);
    expect(await p.cmd('v', { kind: 'pollVote', channelId: CHAN, messageId: POLL_MSG, answerIds: ['1'] })).toMatchObject({ ok: true });
    expect(await p.cmd('e', { kind: 'pollEnd', channelId: CHAN, messageId: POLL_MSG })).toMatchObject({ ok: true });
    expect(c.calls.filter((x) => x[0] === 'vote' || x[0] === 'expire')).toEqual([
      ['vote', `/channels/${CHAN}/polls/${POLL_MSG}/answers/@me`, { answer_ids: ['1'] }],
      ['expire', `/channels/${CHAN}/polls/${POLL_MSG}/expire`],
    ]);
    expect(c.calls.filter((x) => x[0] === 'put' || x[0] === 'post')).toEqual([]);
  });

  test('without those actions loaded, the same requests through its REST helper', async () => {
    const c = client({ pollActions: false });
    const p = page(c);
    await p.cmd('v', { kind: 'pollVote', channelId: CHAN, messageId: POLL_MSG, answerIds: [] });
    await p.cmd('e', { kind: 'pollEnd', channelId: CHAN, messageId: POLL_MSG });
    expect(c.calls.filter((x) => x[0] === 'put' || x[0] === 'post')).toEqual([
      ['put', `/channels/${CHAN}/polls/${POLL_MSG}/answers/@me`, { answer_ids: [] }],
      ['post', `/channels/${CHAN}/polls/${POLL_MSG}/expire`, undefined],
    ]);
  });

  test('a poll is made with its own sendPollMessage', async () => {
    const c = client();
    const p = page(c);
    expect(await p.cmd('c', { kind: 'pollCreate', channelId: CHAN, question: 'Lunch?', answers: ['Pizza', 'Tacos'], multi: true, hours: 8, nonce: '123' })).toMatchObject({ ok: true, result: { nativeId: '801' } });
    expect(c.calls.find((x) => x[0] === 'sendPollMessage')).toEqual([
      'sendPollMessage',
      CHAN,
      { question: { text: 'Lunch?' }, answers: [{ poll_media: { text: 'Pizza' } }, { poll_media: { text: 'Tacos' } }], allow_multiselect: true, duration: 8, layout_type: 1 },
      { nonce: '123' },
    ]);
  });

  test("pins: the pin button's request, and the pinned list the popout loads, then seen", async () => {
    const c = client();
    const p = page(c);
    await p.cmd('p', { kind: 'pin', channelId: CHAN, messageId: '7' });
    await p.cmd('u', { kind: 'pin', channelId: CHAN, messageId: '7', remove: true });
    expect(c.calls.filter((x) => x[0] === 'put' || x[0] === 'del')).toEqual([
      ['put', `/channels/${CHAN}/messages/pins/7`, undefined],
      ['del', `/channels/${CHAN}/messages/pins/7`, undefined],
    ]);
    const r = await p.cmd('l', { kind: 'pinnedList', channelId: CHAN });
    expect(r.result.more).toBe(false);
    expect(r.result.pins).toEqual([{ pinned_at: '2026-11-11T09:00:00.000Z', message: expect.objectContaining({ id: '7', content: 'read this' }) }]);
    expect(c.calls.filter((x) => x[0] === 'get')).toEqual([['get', `/channels/${CHAN}/messages/pins`, { limit: 25 }]]);
    expect(c.calls.find((x) => x[0] === 'dispatch' && x[1].type === 'CHANNEL_PINS_ACK')?.[1]).toEqual({ type: 'CHANNEL_PINS_ACK', channelId: CHAN });
  });
});
