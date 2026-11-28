/**
 * Composition parity for Telegram: the real extractor (extractors/telegram, in process) signed in to the fake
 * Telegram (src/fake.ts), which keeps a whole world of chats. Alice acts through the fake's control ops, as her own
 * client would reach Telegram; the oracle is the fake's world itself, read directly, never through the extractor.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { type Host, TelegramAdapter } from '../../extractors/telegram/src/adapter.ts';
import { FAKE_IDS, FakeTelegram } from '../../extractors/telegram/src/fake.ts';
import { msgId, userId } from '../../extractors/telegram/src/ids.ts';
import { type Actor, type Cap, EventFolder, type Handle, normalize, type ParityDriver, type RawMessage, type SendOptions } from './harness.ts';
import { runCompositionSuite } from './scenarios.ts';

const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete', 'pin', 'media'];
const DM = `dm:${FAKE_IDS.self}:${FAKE_IDS.alice}`;
const PEER = `user:${FAKE_IDS.alice}`;
const FAST = { spacing: { join: 0, dialogs: 0, history: 0, send: 0, read: 0, media: 0, light: 0 }, perChatSendMs: 0 };

async function start(): Promise<ParityDriver & { stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'parity-tg-'));
  writeSecretFile(join(dir, 'secret.json'), { apiHash: '0123456789abcdef0123456789abcdef' });
  const fake = new FakeTelegram({ dir, qrMs: 60_000 });
  const folder = new EventFolder('telegram');
  // Changes on either side: an event from the extractor, or a call reaching the fake.
  const ticks = new Set<() => void>();
  const tick = () => {
    for (const f of [...ticks]) f();
  };
  fake.onCall = tick;
  let status: Extract<P.AdapterEvent, { t: 'status' }> | undefined;
  const host: Host = {
    emit: (e) => {
      if (e.t === 'status') status = e;
      folder.apply(e);
      tick();
    },
    log: () => {},
    accountDir: dir,
    config: { apiId: '12345' },
    secret: () => readSecretFile(join(dir, 'secret.json')),
    saveSecret: (v) => writeSecretFile(join(dir, 'secret.json'), v),
  };
  const adapter = new TelegramAdapter(host, { backend: () => fake, fake: true, pacer: FAST });
  const until = async (f: () => unknown) => {
    while (!f()) await new Promise<void>((r) => ticks.add(function t() { ticks.delete(t); r(); }));
  };
  await adapter.start();
  await until(() => status?.attention?.qr);
  await fake.control({ op: 'scan' });
  await until(() => status?.status === 'online');

  const cmd = (c: Record<string, unknown>) => adapter.command({ id: 'x', ...c } as P.AdapterCommand);
  const num = (h: Handle) => Number(h.slice(h.lastIndexOf('#') + 1));
  /** The messages this run made, so a deleted one is known as deleted on the network too. */
  const made = new Set<Handle>();
  const spool = mkdtempSync(join(tmpdir(), 'parity-tg-spool-'));

  const send = async (actor: Actor, body: string, o: SendOptions = {}): Promise<Handle> => {
    let h: Handle;
    if (actor === 'A') {
      const attachments = o.attachment ? [(() => {
        const path = join(spool, o.attachment.name);
        writeFileSync(path, o.attachment.bytes);
        return { path, name: o.attachment.name, mime: o.attachment.mime, size: o.attachment.bytes.length, kind: 'image' as const };
      })()] : undefined;
      h = ((await cmd({ t: 'send', conversation: DM, body, ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(attachments ? { attachments } : {}) })) as { nativeId: string }).nativeId;
    } else {
      if (o.attachment) throw new Error("the fake's peer sends no files");
      const { id } = (await fake.control({ op: 'incoming', peer: PEER, from: FAKE_IDS.alice, text: body, ...(o.replyTo ? { replyTo: num(o.replyTo) } : {}) })) as { id: number };
      h = msgId(DM, id);
    }
    made.add(h);
    return h;
  };

  const d: ParityDriver & { stop(): Promise<void> } = {
    name: 'telegram (fake Telegram)',
    network: 'telegram',
    capabilities: CAPS,
    // Alice's side is the fake's control ops, which send no files.
    only: { B: CAPS.filter((c) => c !== 'media') },
    actorA: userId(FAKE_IDS.self),
    actorB: userId(FAKE_IDS.alice),
    send,
    reply: (actor, h, body) => send(actor, body, { replyTo: h }),
    async edit(actor, h, body) {
      if (actor === 'A') await cmd({ t: 'edit', conversation: DM, message: h, body });
      else await fake.control({ op: 'edit', peer: PEER, id: num(h), text: body });
    },
    async react(actor, h, key, remove) {
      if (actor === 'A') await cmd({ t: 'react', conversation: DM, message: h, key, ...(remove ? { remove: true } : {}) });
      else await fake.control({ op: 'react', peer: PEER, id: num(h), from: FAKE_IDS.alice, key: remove ? null : key });
    },
    async delete(actor, h) {
      if (actor === 'A') await cmd({ t: 'redact', conversation: DM, message: h });
      else await fake.control({ op: 'delete', peer: PEER, ids: [num(h)] });
    },
    async pin(actor, h, pinned) {
      if (actor === 'A') await cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DM }, change: { key: 'pin', message: h, ...(pinned ? {} : { remove: true }) } });
      else await fake.control({ op: 'pin', peer: PEER, id: num(h), pinned });
    },
    extractorState: () => folder.state(d, DM),
    async oracleState() {
      const live: RawMessage[] = (fake.world.msgs[PEER] ?? [])
        .filter((m) => !m.service)
        .map((m) => ({
          id: msgId(DM, m.id),
          author: userId(m.from),
          body: m.text,
          edited: m.edit !== undefined,
          replyTo: m.replyTo ? msgId(DM, m.replyTo) : null,
          reactions: Object.entries(m.reactions ?? {}).flatMap(([key, who]) => who.map((u) => ({ author: userId(u), key }))),
          pinned: !!m.pinned,
          attachments: m.media ? [{ kind: m.media.kind === 'photo' ? 'image' : 'file' }] : [],
        }));
      const there = new Set(live.map((m) => m.id));
      return normalize(d, live, [...made].filter((h) => !there.has(h)));
    },
    changed: () => new Promise<void>((r) => ticks.add(function t() { ticks.delete(t); r(); })),
    mark: () => folder.events.length,
    dropped: (since) => folder.dropped.filter((x) => x.at >= since),
    async stop() {
      await adapter.shutdown();
      rmSync(dir, { recursive: true, force: true });
      rmSync(spool, { recursive: true, force: true });
    },
  };
  return d;
}

runCompositionSuite('telegram', start, { capabilities: CAPS, only: { B: CAPS.filter((c) => c !== 'media') } });
