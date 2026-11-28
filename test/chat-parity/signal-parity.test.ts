/**
 * Composition parity for Signal: the real extractor (extractors/signal, in process) driving the fake signal-cli
 * (extractors/signal/test/fake-signal-cli.ts), a separate process speaking signal-cli's JSON-RPC over its socket. The
 * fake keeps no messages, so the oracle is a model of Signal kept here, fed by Alice's actions (pushed to the
 * extractor as `receive` envelopes, shaped after test/fixtures) and by decoding each request the extractor made of
 * signal-cli, with the timestamp the fake answered (its fake-rpc.jsonl).
 *
 * The model speaks Signal's edit chains as Signal's apps do (docs/signal.md "Edits"): a message is sent at T0, each
 * edit is a message of its own at T1, T2..., and from then on the message is known on the network by its newest
 * version only. Alice's edits name the version before them, her reactions, replies, deletes and pins the newest. The
 * extractor's edit, sendReaction, remoteDelete, sendPinMessage, sendUnpinMessage and a reply's quoteTimestamp must
 * name the newest version too: one naming an older version (T0 of a message edited since) or none at all lands on
 * nothing here, as on Alice's phone, and the action fails saying which version it named.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { type AdapterHost, SignalAdapter } from '../../extractors/signal/src/adapter.ts';
import { dmId, msgId, parseMsgId } from '../../extractors/signal/src/mapping.ts';
import { type Actor, type Cap, EventFolder, type Handle, normalize, type ParityDriver, type RawMessage, runScenario, type SendOptions } from './harness.ts';
import { compositionScenarios, runCompositionSuite } from './scenarios.ts';

const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete', 'pin', 'media'];
const FAKE = join(import.meta.dir, '../../extractors/signal/test/fake-signal-cli.ts');
// The fake's own account and its contact Alice (fake-signal-cli.ts).
const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const SELF_NUMBER = '+15550100';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const ALICE_NUMBER = '+15550137';
const DM = dmId(SELF, ALICE);
const numberOf = (aci: string) => (aci === SELF ? SELF_NUMBER : ALICE_NUMBER);

/** One message as Signal holds it: by its author and every version's timestamp, the newest last. */
interface Held {
  author: string;
  chain: number[];
  text: string;
  /** The parent as the network resolved the quote when the message was sent: its handle, or null. */
  quote: Handle | null;
  /** The quote as it went out (author, timestamp, text), sent again with each edit as Signal's apps do. */
  quoted?: { author: string; ts: number; text: string };
  reactions: Map<string, string>;
  pinned: boolean;
  attachments: string[];
}

type SignalDriver = ParityDriver & { stop(): Promise<void>; adapter: SignalAdapter };

async function start(): Promise<SignalDriver> {
  const dir = mkdtempSync(join(tmpdir(), 'parity-sig-'));
  const signalDir = join(dir, 'signal-cli');
  // Already linked, as the fake's link leaves it: signal-cli's account list and this device's file.
  mkdirSync(join(signalDir, 'data'), { recursive: true });
  writeFileSync(join(signalDir, 'data', 'accounts.json'), JSON.stringify({ accounts: [{ path: '123456', environment: 'LIVE', number: SELF_NUMBER, uuid: SELF }], version: 2 }));
  writeFileSync(join(signalDir, 'data', '123456'), JSON.stringify({ version: 9, deviceId: 2 }));
  const spool = join(dir, 'spool');
  mkdirSync(spool);

  const folder = new EventFolder('signal');
  /** Lines the extractor shows that are no message on the network ("Alice pinned a message."). */
  const notices = new Set<string>();
  const ticks = new Set<() => void>();
  const tick = () => {
    for (const f of [...ticks]) f();
  };
  const changed = () => new Promise<void>((r) => ticks.add(function t() { ticks.delete(t); r(); }));
  let status: Extract<P.AdapterEvent, { t: 'status' }> | undefined;
  let secret: Record<string, unknown> = {};
  const host: AdapterHost = {
    emit: (e) => {
      if (e.t === 'status') status = e;
      if (e.t === 'message' && e.message.kind === 'system') notices.add(e.message.nativeId);
      folder.apply(e);
      tick();
    },
    log: () => {},
    accountDir: dir,
    config: {},
    secret: () => secret,
    saveSecret: (v) => {
      secret = v as Record<string, unknown>;
    },
  };
  const adapter = new SignalAdapter(host, {
    signalCli: async () => [process.execPath, FAKE],
    restartBackoffMs: [100, 200],
    resnapshotMs: [0],
    resnapshotEveryMs: 3_600_000,
    expirySweepMs: 3_600_000,
    daemonReadyTimeoutMs: 10_000,
    daemonHealthEveryMs: 3_600_000,
    devicesEveryMs: 3_600_000,
  });
  const until = async (f: () => unknown) => {
    while (!f()) await changed();
  };

  // ------------------------------------------------------------ the oracle: Signal as Alice's phone holds it
  const held = new Map<Handle, Held>();
  const deleted = new Set<Handle>();
  const violations: string[] = [];
  const handleOf = (m: Held) => msgId(m.author, m.chain[0]!);
  /**
   * The message `author` sent that Signal knows by `ts`: only its newest version's. An older one (a stale target
   * after an edit) or one nobody sent lands on nothing, and is noted.
   */
  const find = (what: string, author: string | undefined, ts: unknown): Held | undefined => {
    const a = String(author ?? '').toLowerCase();
    for (const m of held.values()) {
      if (m.author !== a || !m.chain.includes(Number(ts))) continue;
      if (m.chain.at(-1) === Number(ts)) return m;
      violations.push(`${what} named ${a}:${ts}, version ${m.chain.indexOf(Number(ts)) + 1} of ${m.chain.length} of ${handleOf(m)}; Signal knows it only by its newest, ${m.chain.at(-1)}`);
      return undefined;
    }
    violations.push(`${what} named ${a}:${ts}, which is no message Signal has${[...deleted].includes(msgId(a, Number(ts))) ? ' (it was deleted)' : ''}`);
    return undefined;
  };
  const kindOf = (mime: string) => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file');

  /** What the extractor asked of signal-cli, read from the fake's log: each request with the answer after it. */
  const log = join(signalDir, 'fake-rpc.jsonl');
  let read = 0;
  const fromWire = () => {
    if (!existsSync(log)) return;
    const text = readFileSync(log, 'utf8');
    const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
    for (; read < lines.length; read++) {
      const req = JSON.parse(lines[read]!);
      if (req.t !== 'rpc') continue;
      const next = lines[read + 1] ? JSON.parse(lines[read + 1]!) : null;
      // A request the fake failed has no answer: it reached nobody.
      if (next?.t !== 'result' || next.method !== req.method) continue;
      const p = req.params ?? {};
      const res = next.result ?? {};
      if (p.recipient && !(p.recipient as string[]).map((x) => x.toLowerCase()).includes(ALICE)) continue;
      switch (req.method) {
        case 'send': {
          if (p.editTimestamp !== undefined) {
            const m = find('edit (editTimestamp)', SELF, p.editTimestamp);
            if (p.quoteTimestamp !== undefined) find("an edited reply's quoteTimestamp", p.quoteAuthor, p.quoteTimestamp);
            if (m) {
              m.chain.push(res.timestamp);
              m.text = p.message ?? '';
            }
            break;
          }
          const parent = p.quoteTimestamp !== undefined ? find("a reply's quoteTimestamp", p.quoteAuthor, p.quoteTimestamp) : undefined;
          const attachments = ([] as string[]).concat(p.attachment ?? []).map((a) => kindOf(/^data:([^;,]+)/.exec(a)?.[1] ?? ''));
          held.set(msgId(SELF, res.timestamp), { author: SELF, chain: [res.timestamp], text: p.message ?? '', quote: parent ? handleOf(parent) : null, ...(parent ? { quoted: { author: parent.author, ts: Number(p.quoteTimestamp), text: parent.text } } : {}), reactions: new Map(), pinned: false, attachments });
          break;
        }
        case 'sendReaction': {
          const m = find('sendReaction', p.targetAuthor, p.targetTimestamp);
          if (!m) break;
          if (!p.remove) m.reactions.set(SELF, p.emoji);
          else if (m.reactions.get(SELF) === p.emoji) m.reactions.delete(SELF);
          break;
        }
        case 'remoteDelete': {
          const m = find('remoteDelete', SELF, p.targetTimestamp);
          if (m) {
            held.delete(handleOf(m));
            deleted.add(handleOf(m));
          }
          break;
        }
        case 'sendPinMessage':
        case 'sendUnpinMessage': {
          const m = find(req.method, p.targetAuthor, p.targetTimestamp);
          if (m) m.pinned = req.method === 'sendPinMessage';
          break;
        }
      }
    }
  };
  /** Each of the extractor's actions resolves after signal-cli answered: what it named is in the log by then. */
  const checked = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    const before = violations.length;
    const r = await f();
    fromWire();
    if (violations.length > before) throw new Error(`signal: the extractor's ${what} reached nothing on Signal:\n  ${violations.slice(before).join('\n  ')}`);
    return r;
  };

  // ------------------------------------------------------------ Alice's phone
  let clock = Date.now();
  const nextTs = () => (clock = Math.max(clock + 1, Date.now()));
  let pushes = 0;
  const pushDir = join(signalDir, 'fake-push');
  /** One envelope from Alice, delivered by the fake as a `receive` notification. */
  const fromAlice = (ts: number, content: Record<string, unknown>) => {
    mkdirSync(pushDir, { recursive: true });
    const tmp = join(dir, `push-${pushes}.json`);
    writeFileSync(tmp, JSON.stringify({ account: SELF_NUMBER, envelope: { source: ALICE_NUMBER, sourceNumber: ALICE_NUMBER, sourceUuid: ALICE, sourceName: 'Alice Chen', sourceDevice: 1, timestamp: ts, serverReceivedTimestamp: ts + 1, serverDeliveredTimestamp: ts + 2, ...content } }));
    renameSync(tmp, join(pushDir, `${String(pushes++).padStart(5, '0')}.json`));
  };
  const data = (ts: number, rest: Record<string, unknown>) => ({ timestamp: ts, message: null, expiresInSeconds: 0, isExpirationUpdate: false, viewOnce: false, isEndSession: false, isProfileKeyUpdate: false, hasProfileKey: true, ...rest });
  const quoteOf = (q: Held['quoted']) => (q ? { quote: { id: q.ts, author: numberOf(q.author), authorNumber: numberOf(q.author), authorUuid: q.author, text: q.text, attachments: [] } } : {});
  const target = (m: Held) => ({ targetAuthor: numberOf(m.author), targetAuthorNumber: numberOf(m.author), targetAuthorUuid: m.author, targetSentTimestamp: m.chain.at(-1)! });
  const heldOf = (h: Handle) => {
    const m = held.get(h);
    if (!m) throw new Error(`signal oracle: no message ${h} on the network`);
    return m;
  };

  await adapter.start();
  await until(() => status?.status === 'online');
  // A first message from Alice, so the 1:1 is known before anyone else writes.
  const hello = nextTs();
  fromAlice(hello, { dataMessage: data(hello, { message: 'hello' }) });
  held.set(msgId(ALICE, hello), { author: ALICE, chain: [hello], text: 'hello', quote: null, reactions: new Map(), pinned: false, attachments: [] });
  await folder.next((e) => e.t === 'message' && e.message.nativeId === msgId(ALICE, hello));

  const cmd = (c: Record<string, unknown>) => adapter.command({ id: 'x', ...c } as P.AdapterCommand);

  const send = async (actor: Actor, body: string, o: SendOptions = {}): Promise<Handle> => {
    if (actor === 'A') {
      const attachments = o.attachment
        ? [(() => {
            const path = join(spool, o.attachment.name);
            writeFileSync(path, o.attachment.bytes);
            return { path, name: o.attachment.name, mime: o.attachment.mime, size: o.attachment.bytes.length, kind: 'image' as const };
          })()]
        : undefined;
      return checked('send', async () => ((await cmd({ t: 'send', conversation: DM, body, ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(attachments ? { attachments } : {}) })) as { nativeId: string }).nativeId);
    }
    const ts = nextTs();
    const parent = o.replyTo ? heldOf(o.replyTo) : undefined;
    const quoted = parent ? { author: parent.author, ts: parent.chain.at(-1)!, text: parent.text } : undefined;
    let files: Record<string, unknown>[] = [];
    if (o.attachment) {
      // signal-cli has downloaded it by the time the envelope comes: in its attachments dir, by its id.
      const id = `parity${ts}.png`;
      mkdirSync(join(signalDir, 'attachments'), { recursive: true });
      writeFileSync(join(signalDir, 'attachments', id), o.attachment.bytes);
      files = [{ contentType: o.attachment.mime, filename: o.attachment.name, id, size: o.attachment.bytes.length, width: 1, height: 1, caption: null, uploadTimestamp: ts, isVoiceNote: false }];
    }
    fromAlice(ts, { dataMessage: data(ts, { message: body, ...quoteOf(quoted), ...(files.length ? { attachments: files } : {}) }) });
    held.set(msgId(ALICE, ts), { author: ALICE, chain: [ts], text: body, quote: parent ? handleOf(parent) : null, ...(quoted ? { quoted } : {}), reactions: new Map(), pinned: false, attachments: files.map(() => 'image') });
    tick();
    return msgId(ALICE, ts);
  };

  const d: SignalDriver = {
    name: 'signal (fake signal-cli)',
    network: 'signal',
    capabilities: CAPS,
    actorA: SELF,
    actorB: ALICE,
    adapter,
    send,
    reply: (actor, h, body) => send(actor, body, { replyTo: h }),
    async edit(actor, h, body) {
      if (actor === 'A') return void (await checked('edit', () => cmd({ t: 'edit', conversation: DM, message: h, body })));
      // Alice's edit names the version before it, and becomes the newest.
      const m = heldOf(h);
      const ts = nextTs();
      fromAlice(ts, { editMessage: { targetSentTimestamp: m.chain.at(-1)!, dataMessage: data(ts, { message: body, ...quoteOf(m.quoted) }) } });
      m.chain.push(ts);
      m.text = body;
      tick();
    },
    async react(actor, h, key, remove) {
      if (actor === 'A') return void (await checked('react', () => cmd({ t: 'react', conversation: DM, message: h, key, ...(remove ? { remove: true } : {}) })));
      const m = heldOf(h);
      const ts = nextTs();
      fromAlice(ts, { dataMessage: data(ts, { reaction: { emoji: key, ...target(m), isRemove: !!remove } }) });
      remove ? m.reactions.get(ALICE) === key && m.reactions.delete(ALICE) : m.reactions.set(ALICE, key);
      tick();
    },
    async delete(actor, h) {
      if (actor === 'A') return void (await checked('redact', () => cmd({ t: 'redact', conversation: DM, message: h })));
      const m = heldOf(h);
      const ts = nextTs();
      fromAlice(ts, { dataMessage: data(ts, { remoteDelete: { timestamp: m.chain.at(-1)! } }) });
      held.delete(h);
      deleted.add(h);
      tick();
    },
    async pin(actor, h, pinned) {
      if (actor === 'A') return void (await checked(pinned ? 'pin' : 'unpin', () => cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DM }, change: { key: 'pin', message: h, ...(pinned ? {} : { remove: true }) } })));
      const m = heldOf(h);
      const ts = nextTs();
      fromAlice(ts, { dataMessage: data(ts, pinned ? { pinMessage: { ...target(m), pinDurationSeconds: -1 } } : { unpinMessage: target(m) }) });
      m.pinned = pinned;
      tick();
    },
    extractorState() {
      const s = folder.state(d, DM);
      for (const id of notices) delete s.messages[id];
      return s;
    },
    async oracleState() {
      fromWire();
      const live: RawMessage[] = [...held.values()].map((m) => ({
        id: handleOf(m),
        author: m.author,
        body: m.text,
        edited: m.chain.length > 1,
        replyTo: m.quote,
        reactions: [...m.reactions].map(([author, key]) => ({ author, key })),
        pinned: m.pinned,
        attachments: m.attachments.map((kind) => ({ kind })),
      }));
      return normalize(d, live, deleted);
    },
    changed,
    mark: () => folder.events.length,
    dropped: (since) => folder.dropped.filter((x) => x.at >= since),
    async stop() {
      await adapter.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return d;
}

runCompositionSuite('signal', start, { capabilities: CAPS });

/**
 * The oracle itself: with the extractor naming an edited message by the timestamp it was first sent with (as before
 * edit chains were followed), the suite fails, on your own second edit, a reaction to Alice's edited message and taking a pin off it.
 */
describe('composition parity: signal, the oracle catches a stale timestamp', () => {
  test('an edit, a reaction and a pin naming T0 of an edited message reach nothing', async () => {
    const d = await start();
    try {
      const a = d.adapter as unknown as { signalTs(id: string, m?: { ts: number }): number };
      a.signalTs = (id, m) => (m ?? parseMsgId(id)!).ts;
      const scenario = (name: string) => compositionScenarios().find((s) => s.name === name)!;
      await expect(runScenario(d, scenario('self: send → edit → edit'), { convergeMs: 2000 })).rejects.toThrow(/edit \(editTimestamp\) named .*version 1 of 2.*newest/);
      await expect(runScenario(d, scenario('peer: send → edit → react (peer + self) → unreact'), { convergeMs: 2000 })).rejects.toThrow(/sendReaction named .*version 1 of 2.*newest/);
      await expect(runScenario(d, scenario('peer: send → pin → edit → unpin'), { convergeMs: 2000 })).rejects.toThrow(/sendUnpinMessage named .*version 1 of 2.*newest/);
    } finally {
      await d.stop();
    }
  }, 60_000);
});
