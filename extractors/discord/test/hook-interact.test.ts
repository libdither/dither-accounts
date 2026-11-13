/**
 * hook.js's bots-and-apps section (buttons, selects, slash commands, suggestions, forms) against a small replica of the
 * client: one rspack runtime with the modules and stores it looks for, under mangled export names, their functions
 * carrying the words the hook recognises them by. The harness is hook-attention.test.ts's, with its timers kept.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';
import { interactCapabilities } from '../src/interact.ts';

const KEY = 'discord-hook-interact-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const GUILD = '200000000000000001';
const CHAN = '300000000000000200';
const MSG = '500000000000000001';
const OTHER = '500000000000000002';
const APP = '700000000000000001';
const BOT = '800000000000000001';

/** The client as far as these tests go: what each module and store holds, and what was asked of them. */
function client(opts: { queues?: boolean } = {}) {
  const handlers = new Map<string, ((a: any) => void)[]>();
  const calls: any[] = [];
  const emit = (ev: string, a: any) => (handlers.get(ev) ?? []).forEach((fn) => fn(a));
  const channels: Record<string, any> = { [CHAN]: { id: CHAN, type: 0, guild_id: GUILD, name: 'general' } };
  // As the client keeps a message: components transformed, each with its path as `id`.
  const records: Record<string, any> = {
    [MSG]: {
      id: MSG,
      flags: 64,
      applicationId: APP,
      components: [
        { type: 1, id: '0', components: [{ type: 2, id: '0,0', customId: 'roll', style: 1, label: 'Roll' }, { type: 2, id: '0,1', style: 5, url: 'https://example.com', label: 'Docs' }] },
        { type: 1, id: '1', components: [{ type: 3, id: '1,0', customId: 'roles', options: [{ label: 'A', value: 'a' }] }] },
        { type: 1, id: '2', components: [{ type: 5, id: '2,0', customId: 'thank' }] },
      ],
    },
  };
  const dispatcher = {
    dispatch: (a: any) => (calls.push(['dispatch', a]), emit(a.type, a)),
    subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    unsubscribe() {},
    isDispatching: () => false,
    _subscriptions: {},
  };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, ...extra });
  const rest: Record<string, any> = {};
  const restAnswers: Record<string, any> = {};
  for (const k of ['get', 'post', 'put', 'patch', 'del'])
    rest[k] = async (o: any) => {
      calls.push([k, o.url, o.body ?? o.query]);
      const a = restAnswers[k];
      if (a instanceof Error || (a && a.status)) throw a;
      return { body: a ?? (k === 'get' ? [] : {}) };
    };
  let seq = 0;
  // The client's executeMessageComponentInteraction: it queues the interaction (unless one already waits), then posts.
  async function executeComponent(o: any) {
    const words = ['MESSAGE_COMPONENT', 'message_flags', 'canQueueInteraction'];
    calls.push(['component', o, words.length]);
    if (opts.queues === false) return;
    const nonce = `N${++seq}`;
    dispatcher.dispatch({ type: 'INTERACTION_QUEUE', nonce, messageId: o.messageId, data: { interactionType: 3, applicationId: o.applicationId, customId: o.customId, componentId: o.componentId } });
  }
  // The client's executeCommand: in autocomplete mode it asks for suggestions, else it queues the command.
  async function executeCommand(o: any) {
    const words = ['APPLICATION_COMMAND_USED', 'optionValues', 'subCommandPath'];
    calls.push(['command', o, words.length]);
    if (o.context.autocomplete) dispatcher.dispatch({ type: 'APPLICATION_COMMAND_AUTOCOMPLETE_REQUEST', nonce: 'A1', channelId: o.context.channel.id, name: o.context.autocomplete.name, query: o.context.autocomplete.query });
    else dispatcher.dispatch({ type: 'INTERACTION_QUEUE', nonce: `C${++seq}`, data: { interactionType: 2, applicationId: o.command.applicationId, channelId: o.context.channel.id } });
  }
  function queueInteraction(nonce: string, o: any) {
    const words = ['INTERACTION_QUEUE', 'preflight'];
    calls.push(['queue', nonce, o, words.length]);
  }
  function interactionFailed(nonce: string) {
    const words = ['INTERACTION_FAILURE', 'errorMessage'];
    calls.push(['failed', nonce, words.length]);
  }
  const commands = [
    { id: 'c1', untranslatedName: 'roll', displayName: 'roll', displayDescription: 'Roll a die', applicationId: APP, type: 1, inputType: 3, options: [{ type: 4, name: 'sides', displayDescription: 'Sides', minValue: 2, maxValue: 100 }] },
    { id: 'c2\0me', untranslatedName: 'remind me', displayName: 'remind me', applicationId: APP, type: 1, inputType: 3, options: [{ type: 3, name: 'when', required: true, autocomplete: true }, { type: 6, name: 'who' }] },
    // The client's own built-in: never listed.
    { id: '-1', untranslatedName: 'shrug', displayName: 'shrug', applicationId: '-1', type: 1, inputType: 0, execute() {}, options: [] },
  ];
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => ({ id: '100000000000000001', username: 'me' }), getUser: (id: string) => ({ id, username: `u${id}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => channels[id] ?? null });
    e.D = store('GuildStore', { getGuilds: () => ({ [GUILD]: { id: GUILD, name: 'Rust' } }), getGuild: (id: string) => (id === GUILD ? { id: GUILD, name: 'Rust' } : null) });
    e.E = store('MessageStore', { getMessage: (_c: string, id: string) => records[id] ?? null });
    e.F = store('AuthenticationStore', { getSessionId: () => 'session-1' });
    e.G = rest;
    e.H = { Gv: executeComponent, wy() {}, sW() {} };
    e.I = { A: executeCommand, x() {} };
    e.J = store('ApplicationCommandIndexStore', {
      query: (ctx: any, a: any, b: any) => {
        calls.push(['query', ctx.channel.id, a, b]);
        const kind = a.commandTypes[0];
        return { commands: commands.filter((c) => c.type === kind), descriptors: [{ id: APP, name: 'Helper', icon: 'abc123', botId: BOT, application: { bot: { id: BOT, username: 'helper', bot: true } } }], loading: false };
      },
    });
    e.K = store('ApplicationCommandAutocompleteStore', { getAutocompleteChoices: () => null });
    e.L = { tU: queueInteraction, C1: interactionFailed, Sw() {} };
    e.M = { default: { fromTimestamp: () => 'S1', extractTimestamp: () => 0 } }.default;
  };
  return { handlers, calls, channels, records, restAnswers, modules, emit };
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
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', 'clearTimeout', HOOK)(win, doc, loc, { webdriver: false }, session, (fn: () => void) => timers.push(fn), () => {}, () => {});
  const cache: Record<string, { exports: any }> = {};
  const T: any = (id: string) => cache[id]!.exports;
  T.c = cache;
  const self = win;
  (self.webpackChunkdiscord_app = self.webpackChunkdiscord_app || []).push = function (this: any, chunkData: any) {
    const [, mods, run] = chunkData;
    for (const id in mods) {
      const m = (cache[id] = { exports: {} });
      mods[id](m, m.exports, T);
    }
    if (run) run(T);
  };
  self.webpackChunkdiscord_app.push([['700'], { client: c.modules }]);
  timers.splice(0).forEach((fn) => fn());
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Bun.sleep(0);
  };
  const send = (id: string, command: unknown) => win.down({ t: 'cmd', id, cmd: command });
  const reply = (id: string) => posted.find((m) => m.t === 'reply' && m.id === id);
  const cmd = async (id: string, command: unknown) => {
    send(id, command);
    await settle();
    return reply(id);
  };
  const outcomes = () => posted.filter((m) => m.t === 'dispatch' && m.event === 'INTERACTION_OUTCOME').map((m) => m.data);
  return { posted, timers, cmd, send, reply, settle, outcomes };
}

describe("hook.js's bots-and-apps section", () => {
  test('finds the client’s executors, stores and queue, and the adapter offers what they allow', () => {
    const c = client();
    const p = page(c);
    const report = p.posted.filter((m) => m.t === 'finders').pop();
    expect(report?.results).toMatchObject({ ComponentInteract: true, CommandExecute: true, CommandIndexStore: true, AutocompleteStore: true, InteractionQueue: true, Snowflakes: true });
    expect(interactCapabilities(report.results)).toEqual(['interactComponents', 'interactCommands', 'interactContext', 'interactModals']);
    expect(interactCapabilities({ CommandExecute: true })).toEqual([]);
  });

  test("a press goes through the client's executor with the message's own flags, application and component id", async () => {
    const c = client();
    const p = page(c);
    const r = await p.cmd('1', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'roll' });
    expect(r).toMatchObject({ ok: true, result: { nonce: 'N1' } });
    const call = c.calls.find((x) => x[0] === 'component')[1];
    expect(call).toEqual({ componentType: 2, messageId: MSG, messageFlags: 64, customId: 'roll', componentId: '0,0', applicationId: APP, channelId: CHAN, guildId: GUILD, localState: null });
    expect(c.calls.filter((x) => ['get', 'post'].includes(x[0]))).toEqual([]);
    expect(p.outcomes()).toEqual([{ nonce: 'N1', channelId: CHAN, messageId: MSG, state: 'sending' }]);
    // Someone else's interaction (a click in the live view) is not ours to tell.
    c.emit('INTERACTION_SUCCESS', { nonce: 'X9' });
    c.emit('INTERACTION_SUCCESS', { nonce: 'N1' });
    expect(p.outcomes().map((o) => o.state)).toEqual(['sending', 'answered']);
  });

  test('a choice: a string select hands over its values, a user select the people picked', async () => {
    const c = client();
    const p = page(c);
    await p.cmd('1', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'roles', values: ['a'] });
    await p.cmd('2', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'thank', values: [BOT] });
    const [a, b] = c.calls.filter((x) => x[0] === 'component').map((x) => x[1]);
    expect(a).toMatchObject({ componentType: 3, componentId: '1,0', localState: { type: 3, values: ['a'] } });
    expect(b).toMatchObject({ componentType: 5, componentId: '2,0', localState: { type: 5, selectedOptions: [{ value: BOT }] } });
  });

  test('refused before the client is asked: a link button, a select with nothing chosen, a control it lacks', async () => {
    const c = client();
    const p = page(c);
    c.records[MSG].components[0].components[1].customId = 'docs';
    expect((await p.cmd('1', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'docs' })).error).toBe('This button is not pressed from here');
    expect((await p.cmd('2', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'roles' })).error).toBe('Choose something first');
    expect((await p.cmd('3', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'nope' })).error).toBe('This message no longer has that control');
    expect(c.calls.filter((x) => x[0] === 'component')).toEqual([]);
  });

  test('a message the client no longer holds is read once around it, and its component found by path', async () => {
    const c = client();
    const p = page(c);
    c.restAnswers.get = [{ id: OTHER, channel_id: CHAN, author: { id: BOT, username: 'helper' }, content: '', timestamp: '2026-11-12T10:00:00.000Z', flags: 0, application_id: APP, components: [{ type: 1, components: [{ type: 2, custom_id: 'x' }] }, { type: 1, components: [{ type: 2, custom_id: 'y', style: 2 }] }] }];
    expect(await p.cmd('1', { kind: 'ixComponent', channelId: CHAN, messageId: OTHER, customId: 'y' })).toMatchObject({ ok: true });
    expect(c.calls.filter((x) => x[0] === 'get')).toEqual([['get', `/channels/${CHAN}/messages`, { around: OTHER, limit: 1 }]]);
    expect(c.calls.find((x) => x[0] === 'component')[1]).toMatchObject({ componentId: '1,0', messageFlags: 0, applicationId: APP });
  });

  test('when the client queues nothing (one press still waits), it says so and sends nothing', async () => {
    const c = client({ queues: false });
    const p = page(c);
    expect((await p.cmd('1', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'roll' })).error).toBe('Discord did not send it: the last press on this message is still waiting for the bot');
  });

  test('outcomes: a failure in words, a reply carrying the nonce, a form; nothing back at all is a timeout', async () => {
    const c = client();
    const p = page(c);
    await p.cmd('1', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'roll' });
    c.emit('INTERACTION_FAILURE', { nonce: 'N1', errorMessage: 'Unknown interaction' });
    await p.cmd('2', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'roll' });
    // The client's own placeholder for an answer does not count; the bot's message does.
    c.emit('MESSAGE_CREATE', { optimistic: true, message: { id: 'N2', nonce: 'N2' } });
    c.emit('MESSAGE_CREATE', { message: { id: '900000000000000001', nonce: 'N2', channel_id: CHAN, author: { id: BOT, username: 'helper' } } });
    await p.cmd('3', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'roll' });
    p.timers.splice(0).forEach((fn) => fn());
    expect(p.outcomes().filter((o) => o.state !== 'sending')).toEqual([
      { nonce: 'N1', channelId: CHAN, messageId: MSG, state: 'failed', error: 'Unknown interaction' },
      { nonce: 'N2', channelId: CHAN, messageId: MSG, state: 'answered' },
      { nonce: 'N3', channelId: CHAN, messageId: MSG, state: 'timedOut' },
    ]);
  });

  test("the place's bot commands from the client's index, loaded as typing a slash loads it", async () => {
    const c = client();
    const p = page(c);
    const r = await p.cmd('1', { kind: 'ixCommands', channelId: CHAN, commandKind: 'chat' });
    expect(r.result.commands.map((x: any) => x.name)).toEqual(['roll', 'remind me']);
    expect(r.result.commands[0]).toEqual({ id: 'c1', name: 'roll', description: 'Roll a die', app: APP, type: 1, options: [{ type: 'integer', name: 'sides', description: 'Sides', min: 2, max: 100 }] });
    expect(r.result.apps).toEqual([{ id: APP, name: 'Helper', icon: `https://cdn.discordapp.com/app-icons/${APP}/abc123.png?size=64`, bot: expect.objectContaining({ id: BOT, username: 'helper' }) }]);
    expect(c.calls.find((x) => x[0] === 'query')).toEqual(['query', CHAN, { commandTypes: [1], builtIns: 'deny' }, expect.objectContaining({ allowFetch: true, scoreMethod: 'command_only' })]);
    expect((await p.cmd('2', { kind: 'ixCommands', channelId: CHAN, commandKind: 'message' })).result.commands).toEqual([]);
  });

  test("a command runs through the client's executor with the values as its composer hands them over", async () => {
    const c = client();
    const p = page(c);
    expect(await p.cmd('1', { kind: 'ixRun', channelId: CHAN, commandKind: 'chat', commandId: 'c2\0me', app: APP, options: [{ name: 'when', value: 'soon' }, { name: 'who', value: BOT, ref: 'user' }] })).toMatchObject({ ok: true, result: { nonce: 'C1' } });
    const call = c.calls.find((x) => x[0] === 'command')[1];
    expect(call.command.id).toBe('c2\0me');
    expect(call.optionValues).toEqual({ when: [{ type: 'text', text: 'soon' }], who: [{ type: 'userMention', userId: BOT }] });
    expect(call.context).toEqual({ channel: c.channels[CHAN], guild: { id: GUILD, name: 'Rust' } });
    expect((await p.cmd('2', { kind: 'ixRun', channelId: CHAN, commandKind: 'chat', commandId: 'c1', app: APP, options: [{ name: 'colour', value: 'x' }] })).error).toBe('/roll has no option colour');
    expect((await p.cmd('3', { kind: 'ixRun', channelId: CHAN, commandKind: 'chat', commandId: '-1', app: '-1', options: [] })).error).toBe('This command is not offered here any more');
  });

  test("suggestions through the executor's autocomplete mode, answered by the gateway's response to its nonce", async () => {
    const c = client();
    const p = page(c);
    p.send('1', { kind: 'ixSuggest', channelId: CHAN, commandId: 'c2\0me', app: APP, options: [], focused: 'when', query: 'to' });
    await p.settle();
    expect(c.calls.find((x) => x[0] === 'command')[1].context.autocomplete).toEqual({ name: 'when', query: 'to' });
    c.emit('APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE', { nonce: 'A1', choices: [{ name: 'tonight', name_localized: 'tonight!', value: 't' }] });
    await p.settle();
    expect(p.reply('1')).toMatchObject({ ok: true, result: { choices: [{ name: 'tonight!', value: 't' }] } });
  });

  test("a form a bot opened for one of ours goes up flat; its answers go once, in the body the client's dialog builds", async () => {
    const c = client();
    const p = page(c);
    const form = {
      id: 'M1',
      nonce: 'N1',
      channelId: CHAN,
      customId: 'ticket',
      title: 'Ticket',
      application: { id: APP, name: 'Helper' },
      components: [
        { type: 18, id: '0', label: 'Subject', component: { type: 4, id: '0,0', customId: 'subject', style: 1, required: true, maxLength: 80 } },
        { type: 1, id: '1', components: [{ type: 3, id: '1,0', customId: 'area', options: [{ label: 'A', value: 'a' }], minValues: 1, maxValues: 1 }] },
        { type: 10, id: '2', content: 'Be brief.' },
      ],
    };
    c.emit('INTERACTION_MODAL_CREATE', form);
    expect(p.posted.some((m) => m.event === 'INTERACTION_FORM')).toBe(false);
    await p.cmd('1', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'roll' });
    c.emit('INTERACTION_MODAL_CREATE', form);
    const up = p.posted.find((m) => m.event === 'INTERACTION_FORM').data;
    expect(up).toEqual({
      id: 'M1',
      nonce: 'N1',
      channelId: CHAN,
      title: 'Ticket',
      application: { id: APP, name: 'Helper' },
      fields: [
        { kind: 'text', id: 'subject', label: 'Subject', style: 'short', required: true, maxLength: 80 },
        { kind: 'select', id: 'area', select: 'string', options: [{ label: 'A', value: 'a' }], min: 1, max: 1 },
        { kind: 'display', text: 'Be brief.' },
      ],
    });
    expect(p.outcomes().at(-1)).toMatchObject({ nonce: 'N1', state: 'modal' });
    expect(await p.cmd('2', { kind: 'ixSubmit', formId: 'M1', values: [{ field: 'subject', value: 'Hi' }, { field: 'area', values: ['a'] }] })).toMatchObject({ ok: true, result: { nonce: 'S1' } });
    expect(c.calls.find((x) => x[0] === 'queue').slice(1, 3)).toEqual(['S1', { data: { interactionType: 5, applicationId: APP } }]);
    expect(c.calls.filter((x) => x[0] === 'post')).toEqual([
      [
        'post',
        '/interactions',
        {
          type: 5,
          application_id: APP,
          channel_id: CHAN,
          guild_id: GUILD,
          data: { id: 'M1', custom_id: 'ticket', components: [{ type: 18, component: { type: 4, custom_id: 'subject', value: 'Hi' } }, { type: 1, components: [{ type: 3, custom_id: 'area', values: ['a'] }] }, { type: 10 }] },
          session_id: 'session-1',
          nonce: 'S1',
        },
      ],
    ]);
    expect((await p.cmd('3', { kind: 'ixSubmit', formId: 'M1', values: [] })).error).toBe('This form has closed: do what opened it again');
  });

  test('a form refused by Discord is told to the client as its dialog tells it, and never sent again', async () => {
    const c = client();
    const p = page(c);
    await p.cmd('1', { kind: 'ixComponent', channelId: CHAN, messageId: MSG, customId: 'roll' });
    c.emit('INTERACTION_MODAL_CREATE', { id: 'M2', nonce: 'N1', channelId: CHAN, customId: 'f', title: 'F', application: { id: APP, name: 'Helper' }, components: [{ type: 1, components: [{ type: 4, customId: 'a', style: 2 }] }] });
    c.restAnswers.post = { status: 400, body: { message: 'Invalid Form Body' } };
    const r = await p.cmd('2', { kind: 'ixSubmit', formId: 'M2', values: [{ field: 'a', value: 'x' }] });
    expect(r).toMatchObject({ ok: false, error: 'Invalid Form Body (400)' });
    expect(c.calls.filter((x) => x[0] === 'failed').map((x) => x[1])).toEqual(['S1']);
    expect(p.outcomes().at(-1)).toMatchObject({ nonce: 'S1', state: 'failed', error: 'Invalid Form Body (400)' });
    expect(c.calls.filter((x) => x[0] === 'post')).toHaveLength(1);
  });
});
