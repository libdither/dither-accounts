/**
 * Composition parity for WhatsApp: the real extractor (extractors/whatsapp, in process) talking to the fake bridge
 * (extractors/whatsapp/test/fake-bridge.ts), a separate process speaking the bridge's JSON lines. The fake keeps no
 * chats of its own, so the oracle is a model of what WhatsApp would hold, kept here: Alice's actions go in as she
 * makes them (and reach the extractor as the bridge's message events, shaped after test/fixtures/events.jsonl), and
 * the account's own go in decoded from what the extractor actually put on the wire: each `send` the bridge was given,
 * with the id it answered. A reaction, edit or revoke that names the wrong message key lands on the wrong message in
 * the model too, and the comparison shows it.
 *
 * WhatsApp lets anyone in the chat pin, but this extractor offers no pinning (adapter.ts configure), so only Alice
 * pins. No files: the fake bridge uploads none.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { WhatsAppAdapter } from '../../extractors/whatsapp/src/adapter.ts';
import { msgId } from '../../extractors/whatsapp/src/mapping.ts';
import type { WaMessage } from '../../extractors/whatsapp/src/types.ts';
import { type Actor, type Cap, EventFolder, type Handle, normalize, type ParityDriver, type RawMessage, type SendOptions } from './harness.ts';
import { runCompositionSuite } from './scenarios.ts';

const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete', 'pin'];
const ONLY: Partial<Record<Actor, Cap[]>> = { A: ['send', 'edit', 'react', 'reply', 'delete'] };
const FAKE = join(import.meta.dir, '../../extractors/whatsapp/test/fake-bridge.ts');
const ME = '15550000001@s.whatsapp.net';
const ALICE = '15550000002@s.whatsapp.net';
const ALICE_LID = '200000000000002@lid';

/** One message as WhatsApp holds it, by its wire id. */
interface WaHeld {
  wid: string;
  fromMe: boolean;
  text: string;
  edited: boolean;
  quoted?: string;
  /** author ('me' | 'alice') → key */
  reactions: Map<'me' | 'alice', string>;
  pinned: boolean;
}

const textOf = (m: WaMessage | undefined): string | undefined => m?.conversation ?? m?.extendedTextMessage?.text;

async function start(): Promise<ParityDriver & { stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'parity-wa-'));
  const sock = join(dir, 'ctl.sock');
  const folder = new EventFolder('whatsapp');
  const held = new Map<string, WaHeld>();
  const deleted = new Set<string>();
  const pending = new Map<string, any>();
  const ticks = new Set<() => void>();
  const tick = () => {
    for (const f of [...ticks]) f();
  };
  const changed = () => new Promise<void>((r) => ticks.add(function t() { ticks.delete(t); r(); }));

  /** What the account's own `send`s did on WhatsApp: the oracle's half that comes from the wire. */
  const fromWire = (message: WaMessage, wid: string) => {
    const r = message.reactionMessage;
    const edit = (message.editedMessage as { message?: WaMessage } | undefined)?.message?.protocolMessage;
    const pm = message.protocolMessage;
    if (r) {
      const m = held.get(r.key?.ID ?? '');
      if (m) r.text ? m.reactions.set('me', r.text) : m.reactions.delete('me');
    } else if (edit?.type === 'MESSAGE_EDIT') {
      const m = held.get(edit.key?.ID ?? '');
      if (m) {
        m.text = textOf(edit.editedMessage) ?? m.text;
        m.edited = true;
      }
    } else if (pm?.type === 'REVOKE') {
      if (held.delete(pm.key?.ID ?? '')) deleted.add(pm.key!.ID!);
    } else {
      const text = textOf(message);
      if (text !== undefined) held.set(wid, { wid, fromMe: true, text, edited: false, quoted: message.extendedTextMessage?.contextInfo?.stanzaID, reactions: new Map(), pinned: false });
    }
  };

  let conn: { write(s: string): void } | null = null;
  const server = Bun.listen({
    unix: sock,
    socket: {
      open(s) {
        conn = s;
        (s as any).buf = '';
        tick();
      },
      data(s, d) {
        (s as any).buf += d.toString();
        let nl: number;
        while ((nl = (s as any).buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse((s as any).buf.slice(0, nl));
          (s as any).buf = (s as any).buf.slice(nl + 1);
          if (msg.cmd?.op === 'send') pending.set(msg.cmd.id, msg.cmd);
          if (msg.replied?.op === 'send' && msg.replied.ok) {
            const cmd = pending.get(msg.replied.id);
            pending.delete(msg.replied.id);
            if (cmd) fromWire(cmd.message, msg.replied.result.id);
          }
          tick();
        }
      },
      close() {
        conn = null;
      },
    },
  });

  let status: Extract<P.AdapterEvent, { t: 'status' }> | undefined;
  const adapter = new WhatsAppAdapter(
    {
      emit: (e) => {
        if (e.t === 'status') status = e;
        folder.apply(e);
        tick();
      },
      log: () => {},
      accountDir: dir,
      config: {},
    },
    {
      bridge: async () => ['env', `FAKE_WA_SOCK=${sock}`, 'FAKE_WA_LOGGED_IN=1', 'FAKE_WA_NOW=1', 'bun', FAKE],
      statePath: ':memory:',
      restartBackoffMs: [50, 100],
      historyTimeoutMs: 400,
      expirySweepMs: 60_000,
    },
  );
  const until = async (f: () => unknown) => {
    while (!f()) await changed();
  };
  await adapter.start();
  await until(() => status?.status === 'online' && folder.events.some((e) => e.t === 'requests') && conn);

  let n = 0;
  /** Alice's client: a bridge message event, as WhatsApp delivers hers. */
  const fromAlice = (message: WaMessage, extra: Record<string, unknown> = {}) => {
    const wid = `P${++n}`;
    conn!.write(JSON.stringify({ emit: { t: 'message', info: { id: wid, chat: ALICE, sender: ALICE, senderAlt: ALICE_LID, fromMe: false, isGroup: false, ts: Date.now(), pushName: 'Alice', ...extra }, message } }) + '\n');
    return wid;
  };
  // A first message from Alice, so the chat is known before anyone else writes.
  const hello = fromAlice({ conversation: 'hello' });
  const first = await folder.next<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.body === 'hello');
  const conv = first.message.conversation;
  const self = status!.self!.nativeId;
  held.set(hello, { wid: hello, fromMe: false, text: 'hello', edited: false, reactions: new Map(), pinned: false });

  const wid = (h: Handle) => h.slice(conv.length + 1);
  const keyOf = (h: Handle) => ({ remoteJID: ALICE, fromMe: !!held.get(wid(h))?.fromMe, ID: wid(h) });
  const cmd = (c: Record<string, unknown>) => adapter.command({ id: 'x', ...c } as P.AdapterCommand);

  const send = async (actor: Actor, body: string, o: SendOptions = {}): Promise<Handle> => {
    if (o.attachment) throw new Error('the fake bridge sends no files');
    if (actor === 'A') return ((await cmd({ t: 'send', conversation: conv, body, ...(o.replyTo ? { replyTo: o.replyTo } : {}) })) as { nativeId: string }).nativeId;
    const parent = o.replyTo ? held.get(wid(o.replyTo)) : undefined;
    const message: WaMessage = parent ? { extendedTextMessage: { text: body, contextInfo: { stanzaID: parent.wid, participant: parent.fromMe ? ME : ALICE, quotedMessage: { conversation: parent.text } } } } : { conversation: body };
    const w = fromAlice(message);
    held.set(w, { wid: w, fromMe: false, text: body, edited: false, quoted: parent?.wid, reactions: new Map(), pinned: false });
    tick();
    return msgId(conv, w);
  };

  const d: ParityDriver & { stop(): Promise<void> } = {
    name: 'whatsapp (fake bridge)',
    network: 'whatsapp',
    capabilities: CAPS,
    only: ONLY,
    actorA: self,
    actorB: conv,
    send,
    reply: (actor, h, body) => send(actor, body, { replyTo: h }),
    async edit(actor, h, body) {
      if (actor === 'A') return void (await cmd({ t: 'edit', conversation: conv, message: h, body }));
      fromAlice({ protocolMessage: { key: keyOf(h), type: 'MESSAGE_EDIT', editedMessage: { conversation: body }, timestampMS: String(Date.now()) } }, {});
      const m = held.get(wid(h))!;
      m.text = body;
      m.edited = true;
      tick();
    },
    async react(actor, h, key, remove) {
      if (actor === 'A') return void (await cmd({ t: 'react', conversation: conv, message: h, key, ...(remove ? { remove: true } : {}) }));
      fromAlice({ reactionMessage: { key: keyOf(h), text: remove ? '' : key, senderTimestampMS: String(Date.now()) } });
      const m = held.get(wid(h))!;
      remove ? m.reactions.delete('alice') : m.reactions.set('alice', key);
      tick();
    },
    async delete(actor, h) {
      if (actor === 'A') return void (await cmd({ t: 'redact', conversation: conv, message: h }));
      fromAlice({ protocolMessage: { key: keyOf(h), type: 'REVOKE' } });
      held.delete(wid(h));
      deleted.add(wid(h));
      tick();
    },
    async pin(actor, h, pinned) {
      if (actor === 'A') throw new Error('this extractor offers no pinning on WhatsApp');
      fromAlice({ ...(pinned ? { messageContextInfo: { messageAddOnDurationInSecs: 604800 } } : {}), pinInChatMessage: { key: keyOf(h), type: pinned ? 'PIN_FOR_ALL' : 'UNPIN_FOR_ALL', senderTimestampMS: String(Date.now()) } }, { edit: '2' });
      held.get(wid(h))!.pinned = pinned;
      tick();
    },
    extractorState: () => folder.state(d, conv),
    async oracleState() {
      const live: RawMessage[] = [...held.values()].map((m) => ({
        id: msgId(conv, m.wid),
        author: m.fromMe ? self : conv,
        body: m.text,
        edited: m.edited,
        replyTo: m.quoted ? msgId(conv, m.quoted) : null,
        reactions: [...m.reactions].map(([who, key]) => ({ author: who === 'me' ? self : conv, key })),
        pinned: m.pinned,
      }));
      return normalize(d, live, [...deleted].map((w) => msgId(conv, w)));
    },
    changed,
    mark: () => folder.events.length,
    dropped: (since) => folder.dropped.filter((x) => x.at >= since),
    async stop() {
      await adapter.shutdown();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return d;
}

runCompositionSuite('whatsapp', start, { capabilities: CAPS, only: ONLY });
