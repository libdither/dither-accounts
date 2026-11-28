/**
 * The Test DC parity runner's offline parts (telegram-testdc-oracle.ts; the live run is scripts/parity-telegram-testdc.ts),
 * and two Telegram edge cases against the fake Telegram: a delete Telegram names by an id too old to place, and a
 * basic group upgraded to a supergroup. Nothing here reaches the network.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { type Host, TelegramAdapter } from '../../extractors/telegram/src/adapter.ts';
import type { tl } from '../../extractors/telegram/src/backend.ts';
import { FAKE_IDS, FakeTelegram } from '../../extractors/telegram/src/fake.ts';
import { msgId, userId } from '../../extractors/telegram/src/ids.ts';
import { State } from '../../extractors/telegram/src/state.ts';
import { type Actor, type Cap, diffConversationStates, EventFolder, type Handle, type ParityDriver, type SendOptions } from './harness.ts';
import { runCompositionSuite } from './scenarios.ts';
import { normalizeTelegramHistory, parseTestDcPhone, readCreds, redactTestPhone, sentMessageId, testDcCode, testDcNumbers, testDcPhone } from './telegram-testdc-oracle.ts';

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- numbers and codes

describe('test DC numbers and codes', () => {
  test('a number is +99966, the DC, four digits; its code the DC five times', () => {
    expect(testDcPhone(2, 1234)).toBe('+9996621234');
    expect(testDcPhone(1, 7)).toBe('+9996610007');
    expect(parseTestDcPhone('+999 66 3 0042')).toEqual({ dc: 3, n: 42 });
    expect(parseTestDcPhone('+15550100123')).toBeNull();
    expect(parseTestDcPhone('+9996641234')).toBeNull();
    expect(testDcCode('+9996621234')).toBe('22222');
    expect(testDcCode(3)).toBe('33333');
    expect(testDcCode(1, 6)).toBe('111111');
    expect(() => testDcPhone(4, 1)).toThrow('there is no test DC 4');
    expect(() => testDcPhone(2, 10_000)).toThrow('0-9999');
    expect(() => testDcCode('+15550100123')).toThrow('not a test DC number');
  });

  test('the numbers to try are the same for a seed, all different, all on the DC', () => {
    const a = testDcNumbers('state-a', 2, 50);
    expect(testDcNumbers('state-a', 2, 50)).toEqual(a);
    expect(new Set(a).size).toBe(50);
    for (const p of a) expect(parseTestDcPhone(p)?.dc).toBe(2);
    expect(testDcNumbers('state-b', 2, 50)).not.toEqual(a);
    expect(testDcNumbers('x', 1, 3).every((p) => p.startsWith('+999661'))).toBe(true);
    // The whole range, once each.
    expect(new Set(testDcNumbers('all', 3, 10_000)).size).toBe(10_000);
  });

  test('logs show a number by its DC and last two digits', () => {
    expect(redactTestPhone('+9996621234')).toBe('+999662··34');
    expect(redactTestPhone('+15550100123')).toBe('a phone number');
  });

  test('credentials come from the environment or a file, and are checked', () => {
    const hash = '0123456789abcdef0123456789abcdef';
    expect(readCreds({ env: { TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: hash } })).toEqual({ apiId: 12345, apiHash: hash });
    const d = tmp('parity-tg-creds-');
    writeFileSync(join(d, 'creds.json'), JSON.stringify({ apiId: 54321, apiHash: hash }));
    expect(readCreds({ env: {}, file: join(d, 'creds.json') })).toEqual({ apiId: 54321, apiHash: hash });
    writeFileSync(join(d, 'creds.env'), `# test DC\nexport TELEGRAM_API_ID=777\nTELEGRAM_API_HASH="${hash}"\n`);
    expect(readCreds({ env: {}, file: join(d, 'creds.env') })).toEqual({ apiId: 777, apiHash: hash });
    expect(() => readCreds({ env: {} })).toThrow('TELEGRAM_API_ID is missing');
    expect(() => readCreds({ env: { TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'short' } })).toThrow('TELEGRAM_API_HASH is missing or not 32 hex digits');
  });

  test("a send's message id, from each shape of answer", () => {
    expect(sentMessageId({ _: 'updateShortSentMessage', id: 41 })).toBe(41);
    expect(sentMessageId({ _: 'updates', updates: [{ _: 'updateMessageID', id: 9 }, { _: 'updateNewChannelMessage', message: { id: 9 } }] })).toBe(9);
    expect(sentMessageId({ _: 'updates', updates: [{ _: 'updateMessageID', id: 12 }] })).toBe(12);
    expect(() => sentMessageId({ _: 'updates', updates: [] })).toThrow('no message id');
  });
});

// ---------------------------------------------------------------- the normalizer

const A = 5000001;
const B = 5000002;
const CH = 1700000042;
const CONV = `channel:${CH}`;
const peerCh = { _: 'peerChannel', channelId: CH } as const;
const user = (id: number) => ({ _: 'peerUser', userId: id }) as const;
const emoji = (e: string) => ({ _: 'reactionEmoji', emoticon: e }) as const;
const msg = (id: number, from: number, text: string, more: Record<string, unknown> = {}) => ({ _: 'message', id, peerId: peerCh, fromId: user(from), date: 1_700_000_000 + id, message: text, ...more }) as unknown as tl.TypeMessage;
const handle = (id: number) => `${CONV}#${id}`;
const base = { self: B, handle, actorA: String(A), actorB: String(B) };

describe('normalizeTelegramHistory', () => {
  test('edits, replies, pins, reactions, files and deletes, from MTProto messages', () => {
    const messages = [
      msg(1, A, ' first words, edited ', { editDate: 1_700_000_100 }),
      msg(2, B, 'an answer', { replyTo: { _: 'messageReplyHeader', replyToMsgId: 1 }, pinned: true }),
      msg(3, A, 'react to me', {
        reactions: {
          _: 'messageReactions',
          results: [{ _: 'reactionCount', reaction: emoji('👍'), count: 1 }, { _: 'reactionCount', reaction: emoji('🎉'), count: 1, chosenOrder: 0 }],
          recentReactions: [{ _: 'messagePeerReaction', peerId: user(A), date: 0, reaction: emoji('👍') }],
        },
      }),
      msg(4, B, 'a photo', { media: { _: 'messageMediaPhoto', photo: { _: 'photo' } } }),
      msg(5, A, 'a clip', { media: { _: 'messageMediaDocument', document: { _: 'document', attributes: [{ _: 'documentAttributeVideo' }, { _: 'documentAttributeFilename' }] } } }),
      msg(6, A, 'a voice note', { media: { _: 'messageMediaDocument', document: { _: 'document', attributes: [{ _: 'documentAttributeAudio' }] } } }),
      msg(7, A, 'a file', { media: { _: 'messageMediaDocument', document: { _: 'document', attributes: [{ _: 'documentAttributeFilename' }] } } }),
      msg(8, A, 'hidden edit', { editDate: 1_700_000_200, editHide: true }),
      { _: 'messageEmpty', id: 9 } as tl.TypeMessage,
      { _: 'messageService', id: 10, peerId: peerCh, fromId: user(B), date: 0, action: { _: 'messageActionPinMessage' } } as unknown as tl.TypeMessage,
      msg(11, A, 'pinned by the list'),
    ];
    const s = normalizeTelegramHistory({ ...base, messages, made: [1, 2, 3, 4, 5, 6, 7, 8, 9, 12], pinned: [11] });
    expect(s.messages[handle(1)]).toEqual({ id: handle(1), author: 'A', body: 'first words, edited', edited: true, replyTo: null, reactionsByAuthor: {}, pinned: false, attachments: [] });
    expect(s.messages[handle(2)]).toMatchObject({ author: 'B', replyTo: handle(1), pinned: true });
    // A's from recentReactions; B's own from chosenOrder, though recentReactions left it out.
    expect(s.messages[handle(3)]!.reactionsByAuthor).toEqual({ A: ['👍'], B: ['🎉'] });
    expect([4, 5, 6, 7].map((i) => s.messages[handle(i)]!.attachments)).toEqual([['image'], ['video'], ['audio'], ['file']]);
    expect(s.messages[handle(8)]!.edited).toBe(false);
    expect(s.messages[handle(11)]!.pinned).toBe(true);
    // Gone: an empty message, or one no longer there at all. A service message is not the scenario's.
    expect(s.deleted).toEqual([handle(12), handle(9)].sort());
    expect(s.messages[handle(10)]).toBeUndefined();
  });

  test('reactions listed by messages.getMessageReactionsList win over recentReactions', () => {
    const m = msg(1, A, 'x', { reactions: { _: 'messageReactions', results: [{ _: 'reactionCount', reaction: emoji('👍'), count: 2 }], recentReactions: [{ _: 'messagePeerReaction', peerId: user(A), date: 0, reaction: emoji('👍') }] } });
    const s = normalizeTelegramHistory({ ...base, messages: [m], reactionLists: new Map([[1, [{ userId: A, key: '👍' }, { userId: B, key: '👍' }]]]) });
    expect(s.messages[handle(1)]!.reactionsByAuthor).toEqual({ A: ['👍'], B: ['👍'] });
  });

  test("a private chat's messages without a sender are the other person's, or ours when outgoing", () => {
    const dm = (id: number, out: boolean) => ({ _: 'message', id, peerId: user(A), date: 0, message: `m${id}`, ...(out ? { out: true } : {}) }) as unknown as tl.TypeMessage;
    const s = normalizeTelegramHistory({ ...base, handle: (id) => `dm:${A}:${B}#${id}`, messages: [dm(1, false), dm(2, true)] });
    expect(Object.values(s.messages).map((m) => [m.body, m.author])).toEqual([['m1', 'A'], ['m2', 'B']]);
  });

  test('messages the handle leaves out are not compared; a reply to one points at its Telegram id', () => {
    const s = normalizeTelegramHistory({ ...base, handle: (id) => (id === 1 ? null : handle(id)), messages: [msg(1, A, 'before'), msg(2, B, 'after', { replyTo: { _: 'messageReplyHeader', replyToMsgId: 1 } })], made: [1] });
    expect(Object.keys(s.messages)).toEqual([handle(2)]);
    expect(s.messages[handle(2)]!.replyTo).toBe('tg:1');
    expect(s.deleted).toEqual([]);
  });

  test('a disagreement with the extractor is named', () => {
    const oracle = normalizeTelegramHistory({ ...base, messages: [msg(1, A, 'two', { editDate: 1 }), msg(2, B, 'reply', { replyTo: { _: 'messageReplyHeader', replyToMsgId: 1 } })], made: [1, 2, 3] });
    const extractor = structuredClone(oracle);
    extractor.messages[handle(1)]!.edited = false;
    extractor.messages[handle(2)]!.reactionsByAuthor = { A: ['👍'] };
    extractor.messages[handle(3)] = { id: handle(3), author: 'A', body: 'still here', edited: false, replyTo: null, reactionsByAuthor: {}, pinned: false, attachments: [] };
    extractor.deleted = [];
    expect(diffConversationStates(extractor, oracle).map((m) => `${m.kind} ${m.id}`).sort()).toEqual([`edited ${handle(1)}`, `extra reaction ${handle(2)}`, `missed delete ${handle(3)}`]);
    expect(diffConversationStates(oracle, oracle)).toEqual([]);
  });
});

// ---------------------------------------------------------------- the extractor against the fake Telegram

const FAST = { spacing: { join: 0, dialogs: 0, history: 0, send: 0, read: 0, media: 0, light: 0 }, perChatSendMs: 0 };
const S = FAKE_IDS.self;
const DM = `dm:${S}:${FAKE_IDS.alice}`;
const GROUP = `group:${S}:${FAKE_IDS.group}`;

/** The extractor signed in to a fresh fake Telegram, with every event and log line kept. */
async function signedIn(o: { msgConvMax?: number } = {}) {
  const dir = tmp('parity-tg-testdc-');
  writeSecretFile(join(dir, 'secret.json'), { apiHash: '0123456789abcdef0123456789abcdef' });
  const fake = new FakeTelegram({ dir, qrMs: 60_000 });
  const events: P.AdapterEvent[] = [];
  const logs: string[] = [];
  const ticks = new Set<() => void>();
  const tick = () => {
    for (const f of [...ticks]) f();
  };
  fake.onCall = tick;
  const host: Host = {
    emit: (e) => {
      events.push(e);
      tick();
    },
    log: (level, m) => {
      logs.push(`[${level}] ${m}`);
      tick();
    },
    accountDir: dir,
    config: { apiId: '12345' },
    secret: () => readSecretFile(join(dir, 'secret.json')),
    saveSecret: (v) => writeSecretFile(join(dir, 'secret.json'), v),
  };
  const adapter = new TelegramAdapter(host, { backend: () => fake, fake: true, pacer: FAST, ...(o.msgConvMax ? { msgConvMax: o.msgConvMax } : {}) });
  /** Resolves once `f` holds: looked at again at every event, log line and call reaching the fake. */
  const until = async <T>(f: () => T | undefined | null | false): Promise<T> => {
    for (;;) {
      const v = f();
      if (v) return v;
      await new Promise<void>((r) => ticks.add(function t() { ticks.delete(t); r(); }));
    }
  };
  const status = () => [...events].reverse().find((e): e is Extract<P.AdapterEvent, { t: 'status' }> => e.t === 'status');
  await adapter.start();
  await until(() => status()?.attention?.qr);
  await fake.control({ op: 'scan' });
  await until(() => status()?.status === 'online');
  // The first snapshot is read: its messages are placed before the test begins.
  await until(() => logs.some((l) => l.startsWith('[info] snapshot:')));
  const cmd = (c: Record<string, unknown>) => adapter.command({ id: 'x', ...c } as P.AdapterCommand);
  /** The next event, log line or call reaching the fake. */
  const next = () => new Promise<void>((r) => ticks.add(function t() { ticks.delete(t); r(); }));
  return { dir, fake, adapter, events, logs, until, next, cmd, stop: () => adapter.shutdown() };
}

describe('deletes Telegram names by id only (updateDeleteMessages)', () => {
  test('a message too old to place is not deleted anywhere, and is counted; the newer ones in the same update are placed', async () => {
    const h = await signedIn({ msgConvMax: 3 });
    try {
      const ids: number[] = [];
      for (const text of ['one', 'two', 'three', 'four']) {
        const { id } = (await h.fake.control({ op: 'incoming', peer: `user:${FAKE_IDS.alice}`, from: FAKE_IDS.alice, text })) as { id: number };
        ids.push(id);
        await h.until(() => h.events.some((e) => e.t === 'message' && e.message.nativeId === msgId(DM, id)));
      }
      // Only the last three are placed now; "one" was the least recently seen.
      const n = h.events.length;
      await h.fake.control({ op: 'delete', peer: `user:${FAKE_IDS.alice}`, ids: [ids[0], ids[3]] });
      await h.until(() => h.events.slice(n).some((e) => e.t === 'delete' && e.nativeId === msgId(DM, ids[3]!)));
      expect(h.events.slice(n).filter((e) => e.t === 'delete')).toEqual([{ t: 'delete', conversation: DM, nativeId: msgId(DM, ids[3]!) }]);
      expect(((await h.cmd({ t: 'action', action: 'status' })) as { deletesUnplaced: number }).deletesUnplaced).toBe(1);
    } finally {
      await h.stop();
    }
  });

  test('a message seen again (an edit) is placed as the newest, in a basic group too', async () => {
    const h = await signedIn({ msgConvMax: 3 });
    try {
      const say = async (peer: string, conv: string, text: string) => {
        const { id } = (await h.fake.control({ op: 'incoming', peer, from: FAKE_IDS.alice, text })) as { id: number };
        await h.until(() => h.events.some((e) => e.t === 'message' && e.message.nativeId === msgId(conv, id)));
        return id;
      };
      const first = await say(`chat:${FAKE_IDS.group}`, GROUP, 'in the group');
      const second = await say(`user:${FAKE_IDS.alice}`, DM, 'in private');
      const third = await say(`user:${FAKE_IDS.alice}`, DM, 'again');
      let n = h.events.length;
      await h.fake.control({ op: 'edit', peer: `chat:${FAKE_IDS.group}`, id: first, text: 'in the group, edited' });
      await h.until(() => h.events.slice(n).some((e) => e.t === 'message' && e.message.nativeId === msgId(GROUP, first) && e.message.editedTs));
      await say(`user:${FAKE_IDS.alice}`, DM, 'pushes one out');
      // "second" went, not the edited "first".
      n = h.events.length;
      await h.fake.control({ op: 'delete', peer: `chat:${FAKE_IDS.group}`, ids: [first, second, third] });
      await h.until(() => h.events.slice(n).filter((e) => e.t === 'delete').length === 2);
      expect(h.events.slice(n).filter((e) => e.t === 'delete')).toEqual([
        { t: 'delete', conversation: GROUP, nativeId: msgId(GROUP, first) },
        { t: 'delete', conversation: DM, nativeId: msgId(DM, third) },
      ]);
    } finally {
      await h.stop();
    }
  });

  test('the placed ids are kept across a restart, cut to the limit as they load', () => {
    const dir = tmp('parity-tg-state-');
    const s = new State(dir, 10);
    for (let i = 1; i <= 6; i++) s.rememberMessage(i, i % 2 ? DM : GROUP, false);
    s.rememberMessage(1, DM, false);
    s.flush();
    expect([...new State(dir, 10).msgConv]).toEqual([[2, GROUP], [3, DM], [4, GROUP], [5, DM], [6, GROUP], [1, DM]]);
    expect([...new State(dir, 3).msgConv.keys()]).toEqual([5, 6, 1]);
    // A channel's messages need no placing: its deletes name the channel.
    s.rememberMessage(7, `channel:${FAKE_IDS.devs}`, false);
    expect(s.msgConv.has(7)).toBe(false);
  });
});

describe('a basic group upgraded to a supergroup', () => {
  test('the group is left and stays left; the supergroup arrives with its first message, and can be written to', async () => {
    const h = await signedIn();
    try {
      expect(h.events.some((e) => e.t === 'conversation' && e.conversation.nativeId === GROUP)).toBe(true);
      const n = h.events.length;
      const { channel } = (await h.fake.control({ op: 'migrate', chat: FAKE_IDS.group, by: FAKE_IDS.alice })) as { channel: number };
      const SUPER = `channel:${channel}`;
      const at = await h.until(() => {
        const i = h.events.findIndex((e, j) => j >= n && e.t === 'message' && e.message.nativeId === msgId(SUPER, 1));
        return i >= 0 ? i + 1 : null;
      });
      const after = h.events.slice(n);
      expect(after.filter((e) => e.t === 'leave')).toEqual([{ t: 'leave', kind: 'conversation', nativeId: GROUP }]);
      expect(after.find((e) => e.t === 'conversation' && e.conversation.nativeId === SUPER)).toMatchObject({ conversation: { nativeId: SUPER, name: 'Weekend plans' } });
      expect(h.events[at - 1]).toMatchObject({ t: 'message', message: { conversation: SUPER, kind: 'system', body: 'this supergroup was upgraded from the group “Weekend plans”' } });
      // The snapshot the upgrade asks for: Telegram still lists the old group, which does not come back.
      const logs = h.logs.length;
      await h.until(() => h.logs.slice(logs).some((l) => l.startsWith('[info] snapshot:')));
      const since = h.events.slice(n);
      expect(since.some((e) => (e.t === 'conversation' && e.conversation.nativeId === GROUP) || (e.t === 'message' && e.message.conversation === GROUP))).toBe(false);
      expect(since.some((e) => e.t === 'conversation' && e.conversation.nativeId === SUPER)).toBe(true);
      const sent = (await h.cmd({ t: 'send', conversation: SUPER, body: 'hello, supergroup' })) as { nativeId: string };
      expect(sent.nativeId).toBe(msgId(SUPER, 2));
      expect(h.fake.world.msgs[SUPER]?.at(-1)).toMatchObject({ text: 'hello, supergroup', from: S });
    } finally {
      await h.stop();
    }
  });
});

// ---------------------------------------------------------------- the matrix, with this oracle on the fake

const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete', 'pin', 'media'];

/**
 * The composition matrix with normalizeTelegramHistory as the oracle, over the TL the fake Telegram itself sends
 * (fake.tlMessage), in a supergroup as the live run uses: so the normalizer agrees with the extractor wherever the
 * extractor is right, before it meets the test DC.
 */
async function fakeDriver(): Promise<ParityDriver & { stop(): Promise<void> }> {
  const h = await signedIn();
  const folder = new EventFolder('telegram');
  for (const e of h.events) folder.apply(e);
  const PEER = `channel:${FAKE_IDS.devs}`;
  const CONV_DEVS = `channel:${FAKE_IDS.devs}`;
  const seen = h.events.length;
  let folded = seen;
  const sync = () => {
    for (; folded < h.events.length; folded++) folder.apply(h.events[folded]!);
  };
  const made = new Set<number>();
  const spool = tmp('parity-tg-spool-');
  const num = (x: Handle) => Number(x.slice(x.lastIndexOf('#') + 1));
  const send = async (actor: Actor, body: string, o: SendOptions = {}): Promise<Handle> => {
    let id: number;
    if (actor === 'A') {
      const attachments = o.attachment
        ? [(() => {
            const path = join(spool, o.attachment.name);
            writeFileSync(path, o.attachment.bytes);
            return { path, name: o.attachment.name, mime: o.attachment.mime, size: o.attachment.bytes.length, kind: 'image' as const };
          })()]
        : undefined;
      id = num(((await h.cmd({ t: 'send', conversation: CONV_DEVS, body, ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(attachments ? { attachments } : {}) })) as { nativeId: string }).nativeId);
    } else id = ((await h.fake.control({ op: 'incoming', peer: PEER, from: FAKE_IDS.alice, text: body, ...(o.replyTo ? { replyTo: num(o.replyTo) } : {}) })) as { id: number }).id;
    made.add(id);
    return msgId(CONV_DEVS, id);
  };
  const d: ParityDriver & { stop(): Promise<void> } = {
    name: 'telegram (fake Telegram, MTProto oracle)',
    network: 'telegram',
    capabilities: CAPS,
    only: { B: CAPS.filter((c) => c !== 'media') },
    actorA: userId(S),
    actorB: userId(FAKE_IDS.alice),
    send,
    reply: (actor, x, body) => send(actor, body, { replyTo: x }),
    async edit(actor, x, body) {
      if (actor === 'A') await h.cmd({ t: 'edit', conversation: CONV_DEVS, message: x, body });
      else await h.fake.control({ op: 'edit', peer: PEER, id: num(x), text: body });
    },
    async react(actor, x, key, remove) {
      if (actor === 'A') await h.cmd({ t: 'react', conversation: CONV_DEVS, message: x, key, ...(remove ? { remove: true } : {}) });
      else await h.fake.control({ op: 'react', peer: PEER, id: num(x), from: FAKE_IDS.alice, key: remove ? null : key });
    },
    async delete(actor, x) {
      if (actor === 'A') await h.cmd({ t: 'redact', conversation: CONV_DEVS, message: x });
      else await h.fake.control({ op: 'delete', peer: PEER, ids: [num(x)] });
    },
    async pin(actor, x, pinned) {
      if (actor === 'A') await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: CONV_DEVS }, change: { key: 'pin', message: x, ...(pinned ? {} : { remove: true }) } });
      else await h.fake.control({ op: 'pin', peer: PEER, id: num(x), pinned });
    },
    extractorState: () => {
      sync();
      return folder.state(d, CONV_DEVS);
    },
    async oracleState() {
      // The fake's own TL for each message, as channels.getMessages answers it. The fake writes it as its account sees
      // it (out, chosenOrder), so that account is the reader here.
      const messages = (h.fake.world.msgs[PEER] ?? []).filter((m) => made.has(m.id)).map((m) => h.fake.tlMessage(PEER, m));
      return normalizeTelegramHistory({ messages, made, self: S, handle: (id) => msgId(CONV_DEVS, id), actorA: d.actorA, actorB: d.actorB });
    },
    changed: h.next,
    mark: () => {
      sync();
      return folder.events.length;
    },
    dropped: (since) => {
      sync();
      return folder.dropped.filter((x) => x.at >= since);
    },
    stop: h.stop,
  };
  return d;
}

runCompositionSuite('telegram (fake, MTProto oracle)', fakeDriver, { capabilities: CAPS, only: { B: CAPS.filter((c) => c !== 'media') } });
