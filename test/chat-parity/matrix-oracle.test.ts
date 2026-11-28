/**
 * Composition parity for Matrix against a real homeserver: continuwuity, started for this file on a fresh directory
 * (extractors/matrix/testbed/homeserver.ts, the testbed's own config). The extractor (extractors/matrix, in process)
 * is quinn, signed in with a password as a fresh device. Alice is a plain Client-Server API client with nothing shared
 * with the extractor but the server, and she is the oracle too: the conversation is read back from the server, the
 * room's timeline from /messages, each message's edits and reactions from /relations, its pins from the room state,
 * never from the extractor. Each scenario gets a room of its own.
 *
 * Skips where continuwuity is not to be had (test/needs.ts: CONTINUWUITY_BIN, the prepared test programs, or PATH).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { MatrixAdapter } from '../../extractors/matrix/src/adapter.ts';
import { enc, type MatrixClient } from '../../extractors/matrix/src/http.ts';
import { type Homeserver, registerUser, SERVER_NAME, startHomeserver } from '../../extractors/matrix/testbed/homeserver.ts';
import { continuwuity, why } from '../needs.ts';
import { type Actor, type Cap, EventFolder, type Handle, normalize, type ParityDriver, type RawMessage, type SendOptions } from './harness.ts';
import { runCompositionSuite } from './scenarios.ts';

const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete', 'pin', 'media'];
const QUINN = `@quinn:${SERVER_NAME}`;
const ALICE = `@alice:${SERVER_NAME}`;

/** The reply fallback older clients put before a reply's words (spec: "Stripping the fallback"). */
const stripFallback = (body: string) => {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('> ')) i++;
  return i && lines[i] === '' ? lines.slice(i + 1).join('\n') : body;
};

async function start(): Promise<ParityDriver & { stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'parity-matrix-'));
  let hs: Homeserver | null = null;
  let adapter: MatrixAdapter | null = null;
  try {
    hs = await startHomeserver({ bin: continuwuity!, dir });
    const password = crypto.randomUUID();
    const alice = await registerUser(hs, 'alice', crypto.randomUUID());
    // quinn's own client only joins the scenarios' rooms; the extractor signs in as a device of its own.
    const quinn = await registerUser(hs, 'quinn', password);

    const accountDir = mkdtempSync(join(dir, 'account-'));
    const secretFile = join(accountDir, 'secret.json');
    writeFileSync(secretFile, JSON.stringify({ userId: QUINN, password }), { mode: 0o600 });
    const folder = new EventFolder('matrix');
    const hub = {
      accountId: 'acc_parity',
      accountDir,
      config: { homeserver: hs.baseUrl },
      label: 'parity',
      emit: (e: P.AdapterEvent) => folder.apply(e),
      log: () => {},
      secret: () => JSON.parse(readFileSync(secretFile, 'utf8')),
      saveSecret: (v: unknown) => writeFileSync(secretFile, JSON.stringify(v), { mode: 0o600 }),
      ask: async () => {
        throw new Error('no manager here');
      },
      connected: true,
      close: () => {},
    } as unknown as HubLink;
    const a = (adapter = new MatrixAdapter());
    a.start(hub);
    a.onConnect();
    await folder.next((e) => e.t === 'status' && e.status === 'online');

    let room = '';
    const made = new Set<Handle>();
    /** Alice's reactions, by message and key, so she can take one back (a redaction of her reaction event). */
    const hers = new Map<string, string>();
    const cmd = (c: Record<string, unknown>) => a.command({ id: 'x', ...c } as P.AdapterCommand);
    const put = async (c: MatrixClient, type: string, content: unknown) => (await c.request('PUT', `/_matrix/client/v3/rooms/${enc(room)}/send/${enc(type)}/${enc(c.txnId())}`, { body: content })).event_id as string;

    const send = async (actor: Actor, body: string, o: SendOptions = {}): Promise<Handle> => {
      let h: Handle;
      if (actor === 'A') {
        const attachments = o.attachment
          ? [(() => {
              const path = join(accountDir, o.attachment.name);
              writeFileSync(path, o.attachment.bytes);
              return { path, name: o.attachment.name, mime: o.attachment.mime, size: o.attachment.bytes.length, kind: 'image' as const };
            })()]
          : undefined;
        h = ((await cmd({ t: 'send', conversation: room, body, ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(attachments ? { attachments } : {}) })) as { nativeId: string }).nativeId;
      } else if (o.attachment) {
        // A picture with a caption (MSC2530: a filename and a body that differs from it).
        const up = await alice.request('POST', '/_matrix/media/v3/upload', { query: { filename: o.attachment.name }, body: o.attachment.bytes, contentType: o.attachment.mime });
        h = await put(alice, 'm.room.message', { msgtype: 'm.image', body, filename: o.attachment.name, url: up.content_uri, info: { mimetype: o.attachment.mime, size: o.attachment.bytes.length } });
      } else h = await put(alice, 'm.room.message', { msgtype: 'm.text', body, ...(o.replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: o.replyTo } } } : {}) });
      made.add(h);
      return h;
    };
    const pinned = async (): Promise<string[]> => {
      try {
        return ((await alice.request('GET', `/_matrix/client/v3/rooms/${enc(room)}/state/m.room.pinned_events`, { retries: 0 })) as { pinned?: string[] }).pinned ?? [];
      } catch {
        return [];
      }
    };

    const d: ParityDriver & { stop(): Promise<void> } = {
      name: 'matrix (continuwuity)',
      network: 'matrix',
      capabilities: CAPS,
      actorA: QUINN,
      actorB: ALICE,
      async beginScenario(name) {
        // Both may pin: a private chat gives power only to its creator.
        room = (
          await alice.request('POST', '/_matrix/client/v3/createRoom', {
            body: { preset: 'private_chat', name: name.slice(0, 60), invite: [QUINN], power_level_content_override: { users: { [ALICE]: 100, [QUINN]: 100 } } },
          })
        ).room_id;
        const from = folder.events.length;
        await quinn.request('POST', `/_matrix/client/v3/join/${enc(room)}`, { body: {} });
        await folder.next((e) => e.t === 'conversation' && e.conversation.nativeId === room, from);
      },
      send,
      reply: (actor, h, body) => send(actor, body, { replyTo: h }),
      async edit(actor, h, body) {
        if (actor === 'A') await cmd({ t: 'edit', conversation: room, message: h, body });
        else await put(alice, 'm.room.message', { msgtype: 'm.text', body: `* ${body}`, 'm.new_content': { msgtype: 'm.text', body }, 'm.relates_to': { rel_type: 'm.replace', event_id: h } });
      },
      async react(actor, h, key, remove) {
        if (actor === 'A') return void (await cmd({ t: 'react', conversation: room, message: h, key, ...(remove ? { remove: true } : {}) }));
        if (!remove) hers.set(`${h} ${key}`, await put(alice, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: h, key } }));
        else {
          const ev = hers.get(`${h} ${key}`)!;
          hers.delete(`${h} ${key}`);
          await alice.request('PUT', `/_matrix/client/v3/rooms/${enc(room)}/redact/${enc(ev)}/${enc(alice.txnId())}`, { body: {} });
        }
      },
      async delete(actor, h) {
        if (actor === 'A') await cmd({ t: 'redact', conversation: room, message: h });
        else await alice.request('PUT', `/_matrix/client/v3/rooms/${enc(room)}/redact/${enc(h)}/${enc(alice.txnId())}`, { body: {} });
      },
      async pin(actor, h, on) {
        if (actor === 'A') return void (await cmd({ t: 'configure', target: { kind: 'conversation', nativeId: room }, change: { key: 'pin', message: h, ...(on ? {} : { remove: true }) } }));
        const now = (await pinned()).filter((x) => x !== h);
        await alice.request('PUT', `/_matrix/client/v3/rooms/${enc(room)}/state/m.room.pinned_events/`, { body: { pinned: on ? [h, ...now] : now } });
      },
      extractorState: () => folder.state(d, room),
      async oracleState() {
        const events: any[] = [];
        for (let from: string | undefined; ; ) {
          const page = await alice.request('GET', `/_matrix/client/v3/rooms/${enc(room)}/messages`, { query: { dir: 'b', limit: 100, ...(from ? { from } : {}) } });
          events.push(...(page.chunk ?? []));
          if (!page.end || !page.chunk?.length) break;
          from = page.end;
        }
        const pins = new Set(await pinned());
        const live: RawMessage[] = [];
        const deleted: string[] = [];
        for (const ev of events) {
          if (ev.type !== 'm.room.message') continue;
          if (ev.unsigned?.redacted_because || !ev.content?.msgtype) {
            deleted.push(ev.event_id);
            continue;
          }
          if (ev.content['m.relates_to']?.rel_type === 'm.replace') continue;
          // Only what relates to this event itself: continuwuity (26.9) lists a reply's edits and reactions under its
          // parent too, as if a reply were a relation (extractors/matrix/test/relations.test.ts).
          const rel = (t: string) =>
            alice
              .request('GET', `/_matrix/client/v1/rooms/${enc(room)}/relations/${enc(ev.event_id)}/${t}`, { query: { limit: 100 } })
              .then((r: any) => ((r.chunk ?? []) as any[]).filter((x) => x.content?.['m.relates_to']?.rel_type === t && x.content['m.relates_to'].event_id === ev.event_id));
          const [edits, reactions] = await Promise.all([rel('m.replace'), rel('m.annotation')]);
          const latest = edits.filter((e) => e.sender === ev.sender && e.content?.['m.new_content']).sort((x, y) => x.origin_server_ts - y.origin_server_ts).at(-1);
          const content = latest ? latest.content['m.new_content'] : ev.content;
          const replyTo: string | undefined = ev.content['m.relates_to']?.['m.in_reply_to']?.event_id;
          const media = /^m\.(image|video|audio|file)$/.exec(content.msgtype ?? '');
          live.push({
            id: ev.event_id,
            author: ev.sender,
            body: replyTo && !latest ? stripFallback(String(content.body ?? '')) : String(content.body ?? ''),
            edited: !!latest,
            replyTo: replyTo ?? null,
            reactions: reactions.filter((r) => r.type === 'm.reaction' && r.content?.['m.relates_to']?.key).map((r) => ({ author: r.sender, key: r.content['m.relates_to'].key })),
            pinned: pins.has(ev.event_id),
            attachments: media ? [{ kind: media[1]! }] : [],
          });
        }
        return normalize(d, live, [...deleted, ...[...made].filter((h) => !live.some((m) => m.id === h))]);
      },
      changed: () => folder.changed(),
      mark: () => folder.events.length,
      dropped: (since) => folder.dropped.filter((x) => x.at >= since),
      async stop() {
        await a.shutdown();
        await hs!.stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
    return d;
  } catch (e) {
    await adapter?.shutdown();
    if (hs) console.error(hs.log.slice(-30).join('\n'));
    await hs?.stop();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

const have = why('continuwuity (the Matrix homeserver: CONTINUWUITY_BIN, or the prepared test programs)', !!continuwuity);
runCompositionSuite('matrix, against continuwuity', start, { capabilities: CAPS, skip: have ? null : 'no continuwuity here' });
