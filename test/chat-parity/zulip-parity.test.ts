/**
 * Composition parity for Zulip: the real extractor (extractors/zulip, in process) against the fake Zulip server in
 * its live mode (extractors/zulip/test/fake-zulip.ts `live`), which stores what is written and sends every change
 * down the event queue, the writer's own queue too, as Zulip does. Ann acts on the server as her web client's requests
 * would; the oracle is the server's message list, read directly. Each scenario gets a topic of its own.
 *
 * Against a real Zulip: extractors/zulip/testbed (sandbox.ts brings one up in podman, drive.ts runs the extractor
 * against it); docs/parity-testing.md says how this driver's oracle would read it instead.
 */
import type * as P from '@dither-chat/protocol';
import { ZulipAdapter } from '../../extractors/zulip/src/adapter.ts';
import { Ids } from '../../extractors/zulip/src/ids.ts';
import { fakeZulip } from '../../extractors/zulip/test/fake-zulip.ts';
import { testLink } from '../../extractors/zulip/test/link.ts';
import { type Actor, type Cap, EventFolder, type Handle, normalize, type ParityDriver, type RawMessage, type SendOptions } from './harness.ts';
import { runCompositionSuite } from './scenarios.ts';

const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete'];
const STREAM = 3;
const ME = 8;
const ANN = 9;
const NAMES: Record<string, string> = { '👍': 'thumbs_up', '🎉': 'tada', '😄': 'smile' };

/** The web client's quote-and-reply (its compose_reply.ts): who said it, a link to it, the quote, then the words. */
const REPLY = /^@_?\*\*[^*\n]+?\*\* \[said\]\(([^)\s]+)\):\n(`{3,})quote\n[\s\S]*?\n\2[ \t]*(?:\n|$)/;

async function start(): Promise<ParityDriver & { stop(): Promise<void> }> {
  const z = fakeZulip({ live: true });
  const link = testLink({ server: z.url, email: 'quinn@example.com' }, { apiKey: z.key });
  const ids = new Ids(new URL(z.url).host);
  const folder = new EventFolder('zulip');
  const emit = link.emit.bind(link);
  link.emit = (e: P.AdapterEvent) => {
    emit(e);
    folder.apply(e);
  };
  const a = new ZulipAdapter();
  a.start(link);
  a.onConnect();
  await folder.next((e) => e.t === 'status' && e.status === 'online');

  let topic = 'parity';
  const conv = () => ids.topic(STREAM, topic);
  const num = (h: Handle) => ids.messageId(h)!;
  const made = new Set<Handle>();
  const cmd = (c: Record<string, unknown>) => a.command({ id: 'x', ...c } as P.AdapterCommand);
  const link_ = (id: number) => `${z.url}/#narrow/channel/${STREAM}-general/topic/${encodeURIComponent(topic)}/near/${id}`;

  const send = async (actor: Actor, body: string, o: SendOptions = {}): Promise<Handle> => {
    if (o.attachment) throw new Error('no files in this driver');
    let h: Handle;
    if (actor === 'A') h = ((await cmd({ t: 'send', conversation: conv(), body, ...(o.replyTo ? { replyTo: o.replyTo } : {}) })) as { nativeId: string }).nativeId;
    else {
      let content = body;
      if (o.replyTo) {
        const parent = z.messages.find((m) => m.id === num(o.replyTo!))!;
        const who = parent.sender_id === ME ? 'Quinn Park' : 'Ann Lee';
        content = `@_**${who}|${parent.sender_id}** [said](${link_(parent.id)}):\n\`\`\`quote\n${parent.content}\n\`\`\`\n${body}`;
      }
      h = ids.message(z.act.send(ANN, { stream: STREAM, topic }, content));
    }
    made.add(h);
    return h;
  };

  const d: ParityDriver & { stop(): Promise<void> } = {
    name: 'zulip (fake Zulip, live)',
    network: 'zulip',
    capabilities: CAPS,
    actorA: ids.user(ME),
    actorB: ids.user(ANN),
    async beginScenario() {
      topic = `parity-${made.size}`;
    },
    send,
    reply: (actor, h, body) => send(actor, body, { replyTo: h }),
    async edit(actor, h, body) {
      if (actor === 'A') await cmd({ t: 'edit', conversation: conv(), message: h, body });
      else {
        // Ann's client keeps the quote of a reply as it was, and changes the words after it.
        const m = z.messages.find((x) => x.id === num(h))!;
        const quote = String(m.content).match(REPLY)?.[0] ?? '';
        z.act.edit(num(h), `${quote}${body}`, ANN);
      }
    },
    async react(actor, h, key, remove) {
      if (actor === 'A') await cmd({ t: 'react', conversation: conv(), message: h, key, ...(remove ? { remove: true } : {}) });
      else z.act.react(num(h), ANN, NAMES[key]!, remove ? 'remove' : 'add');
    },
    async delete(actor, h) {
      if (actor === 'A') await cmd({ t: 'redact', conversation: conv(), message: h });
      else z.act.delete(num(h));
    },
    async pin() {
      throw new Error('Zulip has no pins');
    },
    extractorState: () => folder.state(d, conv()),
    async oracleState() {
      const live: RawMessage[] = z.messages
        .filter((m) => m.type === 'stream' && m.stream_id === STREAM && String(m.subject).toLowerCase() === topic)
        .map((m) => {
          const content = String(m.content);
          const r = content.match(REPLY);
          const near = r?.[1]?.match(/\/near\/(\d+)$/);
          return {
            id: ids.message(m.id),
            author: ids.user(m.sender_id),
            body: r ? content.slice(r[0].length) : content,
            edited: !!m.last_edit_timestamp,
            replyTo: near ? ids.message(Number(near[1])) : null,
            reactions: (m.reactions ?? []).map((x: any) => ({ author: ids.user(x.user_id), key: String.fromCodePoint(parseInt(x.emoji_code, 16)) })),
          };
        });
      const there = new Set(live.map((m) => m.id));
      return normalize(d, live, [...made].filter((h) => !there.has(h)));
    },
    changed: () => folder.changed(),
    mark: () => folder.events.length,
    dropped: (since) => folder.dropped.filter((x) => x.at >= since),
    async stop() {
      await a.shutdown();
      z.stop();
    },
  };
  return d;
}

runCompositionSuite('zulip', start, { capabilities: CAPS });
