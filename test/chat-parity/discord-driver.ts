/**
 * The Discord ParityDriver (harness.ts), shared by the CI suite (discord-parity.test.ts, a fake Discord) and the live
 * script (scripts/parity-discord.ts, a throwaway account in a test channel):
 *
 * - **A** is the extractor's account. Its actions are the chat interface's commands (send, edit, react, redact,
 *   configure's pin), handed to `command`: in CI the extractor in process, live the manager's `chat` interface.
 * - **B** is a bot (DiscordBotOracle) acting with its own token, and the same bot reads the channel back for the
 *   oracle.
 * - The extractor's events go into `apply`, folded as the hub folds them. Discord's own notices ("pinned a message",
 *   type 6: a `system` message fact) are left out of both sides; the oracle keeps only types 0 and 19.
 *
 * One channel for every scenario (Discord makes a new one costly, live): `after` (a snowflake from before the run)
 * bounds what the oracle reads, and runScenario leaves out each scenario's earlier messages itself.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DiscordBotOracle } from './discord-bot-oracle.ts';
import { type Actor, type Cap, EventFolder, type Handle, type NormalizedConversationState, type ParityDriver, scoped, type SendOptions } from './harness.ts';

export interface DiscordDriverOptions {
  name: string;
  oracle: DiscordBotOracle;
  channelId: string;
  /** Discord user ids: A the extractor's account, B the bot. */
  actorA: string;
  actorB: string;
  capabilities: readonly Cap[];
  only?: Partial<Record<Actor, readonly Cap[]>>;
  /** A's commands: the chat interface's input with its `t` (no id). */
  command: (cmd: { t: string; [k: string]: unknown }) => Promise<unknown>;
  /** Messages after this snowflake only. */
  after: string;
  /** Where A's file is written before its send names it (the hub hands files by path). Needed for A's 'media'. */
  fileDir?: string;
  /**
   * Resolves at the next change on the network: a fake's world changing; live, a short wait (nothing tells a bot
   * that someone else's request landed). Also a change signal for converge beside the extractor's events.
   */
  networkChanged: () => Promise<void>;
  /** How long A's edit or delete may take to reach Discord before it fails (default 30 s). */
  settleMs?: number;
}

export type DiscordDriver = ParityDriver & {
  /** Feed every event the extractor emits here. */
  apply(ev: P.AdapterEvent): void;
  readonly folder: EventFolder;
  /** Every message the run made (for cleanup). */
  readonly made: Set<Handle>;
  /** Who made each (A or B), for cleanup. */
  readonly madeBy: Map<Handle, Actor>;
};

export function discordDriver(o: DiscordDriverOptions): DiscordDriver {
  const folder = new EventFolder('discord');
  const system = new Set<string>();
  const made = new Set<Handle>();
  const madeBy = new Map<Handle, Actor>();
  const chan = o.channelId;
  let files = 0;

  /**
   * Until the network holds what `check` looks for. The hook starts the client's own edit and delete and answers
   * before Discord has (as the client's editMessage does), while a driver's action resolves only once the network has
   * taken it: so A's edit and delete wait here, on Discord's side, never on the extractor's.
   */
  const settle = async (what: string, check: () => Promise<boolean>) => {
    const ms = o.settleMs ?? 30_000;
    let timer: Timer | undefined;
    // The limit only ends a failure: a pass returns at the change that made it true.
    const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ms)));
    try {
      for (;;) {
        const next = o.networkChanged();
        if (await check()) return;
        if ((await Promise.race([next, timeout])) === 'timeout' && !(await check())) throw new Error(`${what}: Discord did not have it after ${ms} ms`);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const send = async (actor: Actor, body: string, s: SendOptions = {}): Promise<Handle> => {
    let id: Handle;
    if (actor === 'B') {
      id = (await o.oracle.send(chan, body, { replyTo: s.replyTo, ...(s.attachment ? { file: s.attachment } : {}) })).id;
    } else {
      let attachments: P.OutgoingAttachment[] | undefined;
      if (s.attachment) {
        if (!o.fileDir) throw new Error('no fileDir for A to send a file from');
        const path = join(o.fileDir, `${files++}-${s.attachment.name}`);
        writeFileSync(path, s.attachment.bytes);
        attachments = [{ path, name: s.attachment.name, mime: s.attachment.mime, size: s.attachment.bytes.length, kind: 'image' }];
      }
      const r = (await o.command({ t: 'send', conversation: chan, body, ...(s.replyTo ? { replyTo: s.replyTo } : {}), ...(attachments ? { attachments } : {}) })) as { nativeId?: string | null };
      if (!r?.nativeId) throw new Error(`the extractor's send gave no message id: ${JSON.stringify(r)}`);
      id = r.nativeId;
    }
    made.add(id);
    madeBy.set(id, actor);
    return id;
  };

  const d: DiscordDriver = {
    name: o.name,
    network: 'discord',
    capabilities: o.capabilities,
    ...(o.only ? { only: o.only } : {}),
    actorA: o.actorA,
    actorB: o.actorB,
    folder,
    made,
    madeBy,
    apply(ev) {
      if (ev.t === 'message' && ev.message.kind === 'system') system.add(ev.message.nativeId);
      folder.apply(ev);
    },
    send,
    reply: (actor, h, body) => send(actor, body, { replyTo: h }),
    async edit(actor, h, body) {
      if (actor === 'B') await o.oracle.edit(chan, h, body);
      else {
        await o.command({ t: 'edit', conversation: chan, message: h, body });
        await settle(`A's edit of ${h}`, async () => (await o.oracle.message(chan, h))?.content === body);
      }
    },
    async react(actor, h, key, remove) {
      if (actor === 'B') await o.oracle.react(chan, h, key, !!remove);
      else await o.command({ t: 'react', conversation: chan, message: h, key, ...(remove ? { remove: true } : {}) });
    },
    async delete(actor, h) {
      if (actor === 'B') await o.oracle.delete(chan, h);
      else {
        await o.command({ t: 'redact', conversation: chan, message: h });
        await settle(`A's delete of ${h}`, async () => (await o.oracle.message(chan, h)) === null);
      }
    },
    async pin(actor, h, pinned) {
      if (actor === 'B') await o.oracle.pin(chan, h, pinned);
      else await o.command({ t: 'configure', target: { kind: 'conversation', nativeId: chan }, change: { key: 'pin', message: h, ...(pinned ? {} : { remove: true }) } });
    },
    extractorState: (): NormalizedConversationState => scoped(folder.state(d, chan), (id) => !system.has(id) && BigInt(id) > BigInt(o.after)),
    oracleState: () => o.oracle.oracleState(chan, { actorA: o.actorA, actorB: o.actorB, after: o.after, made }),
    changed: () => Promise.race([folder.changed(), o.networkChanged()]),
    mark: () => folder.events.length,
    // A pin or reaction aimed at a notice the folder dropped as unknown would be reported too; none are expected.
    dropped: (since) => folder.dropped.filter((x) => x.at >= since && !system.has(x.nativeId)),
  };
  return d;
}

/** A snowflake for "now": messages after it are the run's. */
export function snowflakeNow(now = Date.now()): string {
  return ((BigInt(now) - 1420070400000n) << 22n).toString();
}
