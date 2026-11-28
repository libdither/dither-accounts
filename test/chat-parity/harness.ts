/**
 * Differential composition parity (docs/parity-testing.md): one conversation driven through sequences of operations
 * that interact (send, edit, edit again, react, take it back, reply, delete, pin), from both sides, and after every
 * step the conversation as the extractor told the hub about it is compared with the conversation as the network
 * itself holds it.
 *
 * - The extractor's side is its AdapterEvents folded the way dither-chat's hub folds them (EventFolder, after the
 *   hub's store.ts): a message fact replaces the message, an edit flag once set stays, a reaction or pin aimed at a
 *   message the hub never heard of is dropped, a delete of an unknown message too.
 * - The network's side (the oracle) is read independently: a real homeserver's API, or a fake network's own world.
 *
 * Both come out as a NormalizedConversationState, and diffConversationStates names every difference.
 */
import { canonicalReactionKey, REACTION_RULES, type Network } from '@dither-chat/protocol';
import type * as P from '@dither-chat/protocol';

// ---------------------------------------------------------------- the driver

/** What a driver may do. A step needing one the acting side lacks is skipped. */
export type Cap = 'send' | 'edit' | 'react' | 'reply' | 'delete' | 'pin' | 'media';
/** A: the extractor under test (the account's own actions go through its commands). B: the other person. */
export type Actor = 'A' | 'B';

/** A message, by the native id the extractor gives it (an oracle maps its own ids to these). */
export type Handle = string;

export interface SendOptions {
  replyTo?: Handle;
  /** A small file sent with it (capability 'media'). */
  attachment?: { name: string; mime: string; bytes: Uint8Array };
}

/**
 * One chat network wired up for the suite: the extractor on one side, an independent peer and oracle on the other.
 * Every action resolves once the network has taken it (the server answered, the fake's world changed); the harness
 * then waits for the extractor to catch up.
 */
export interface ParityDriver {
  readonly name: string;
  readonly network: Network;
  /** What both sides can do. `only` narrows one side: WhatsApp's extractor pins nothing, though a peer's pin arrives. */
  readonly capabilities: readonly Cap[];
  readonly only?: Partial<Record<Actor, readonly Cap[]>>;
  /** The two people, by the native identity id the extractor names them by. */
  readonly actorA: string;
  readonly actorB: string;

  /** A fresh conversation for a scenario, where the network makes that cheap (a new room, a new topic). */
  beginScenario?(name: string): Promise<void>;

  send(actor: Actor, body: string, opts?: SendOptions): Promise<Handle>;
  edit(actor: Actor, handle: Handle, body: string): Promise<void>;
  react(actor: Actor, handle: Handle, key: string, remove?: boolean): Promise<void>;
  reply(actor: Actor, handle: Handle, body: string): Promise<Handle>;
  delete(actor: Actor, handle: Handle): Promise<void>;
  pin(actor: Actor, handle: Handle, pinned: boolean): Promise<void>;

  /** The scenario's conversation as the extractor's events made it (usually `folder.state(conversation)`). */
  extractorState(): NormalizedConversationState;
  /** The same conversation read from the network, not from the extractor. */
  oracleState(): Promise<NormalizedConversationState>;
  /** Resolves at the next thing that may change either state: an event from the extractor, a change in a fake. */
  changed(): Promise<void>;
  /** What the extractor emitted that the hub would have dropped, since `since` (EventFolder.dropped). */
  dropped?(since: number): Dropped[];
  /** A mark for dropped(): the folder's event count now. */
  mark?(): number;
}

export function can(d: Pick<ParityDriver, 'capabilities' | 'only'>, actor: Actor, cap: Cap): boolean {
  return d.capabilities.includes(cap) && (d.only?.[actor]?.includes(cap) ?? true);
}

// ---------------------------------------------------------------- the normalized state

export interface NormalizedMessage {
  id: Handle;
  /** 'A' or 'B' for the two actors, else the native id. */
  author: string;
  body: string;
  edited: boolean;
  replyTo: Handle | null;
  /** Each person's reactions, canonical keys sorted; people with none left out. */
  reactionsByAuthor: Record<string, string[]>;
  pinned: boolean;
  /** Each file's kind (image, video, audio, file), in order: names are each network's own. */
  attachments: string[];
}

export interface NormalizedConversationState {
  /** The messages still there, by id. */
  messages: Record<Handle, NormalizedMessage>;
  /** Messages known to have been deleted. */
  deleted: Handle[];
}

export function emptyState(): NormalizedConversationState {
  return { messages: {}, deleted: [] };
}

/** One message as either side sees it, before normalizing. */
export interface RawMessage {
  id: Handle;
  author: string;
  body: string;
  edited: boolean;
  replyTo?: Handle | null;
  /** key → people, or person → keys: either way round, as `reactionsBy` says. */
  reactions?: { author: string; key: string }[];
  pinned?: boolean;
  attachments?: { kind: string; name?: string }[];
}

/** Builds a state from raw messages: authors as A/B, keys canonical, everything sorted. */
export function normalize(d: Pick<ParityDriver, 'actorA' | 'actorB'>, live: RawMessage[], deleted: Iterable<Handle> = []): NormalizedConversationState {
  const who = (id: string) => (id === d.actorA ? 'A' : id === d.actorB ? 'B' : id);
  const messages: Record<Handle, NormalizedMessage> = {};
  for (const m of live) {
    const by: Record<string, Set<string>> = {};
    for (const r of m.reactions ?? []) (by[who(r.author)] ??= new Set()).add(canonicalReactionKey(r.key));
    messages[m.id] = {
      id: m.id,
      author: who(m.author),
      body: m.body.trim(),
      edited: m.edited,
      replyTo: m.replyTo ?? null,
      reactionsByAuthor: Object.fromEntries(
        Object.entries(by)
          .filter(([, keys]) => keys.size)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([a, keys]) => [a, [...keys].sort()]),
      ),
      pinned: !!m.pinned,
      attachments: (m.attachments ?? []).map((a) => a.kind),
    };
  }
  return { messages, deleted: [...new Set(deleted)].filter((id) => !(id in messages)).sort() };
}

/** Only these messages (a scenario's), for networks whose conversation is shared between scenarios. */
export function scoped(s: NormalizedConversationState, keep: (id: Handle) => boolean): NormalizedConversationState {
  return {
    messages: Object.fromEntries(Object.entries(s.messages).filter(([id]) => keep(id))),
    deleted: s.deleted.filter(keep),
  };
}

// ---------------------------------------------------------------- the extractor's events, folded as the hub does

interface Folded {
  nativeId: string;
  conversation: string;
  author: string;
  ts: number;
  body: string;
  edited: boolean;
  replyTo: string | null;
  attachments: { kind: string; name?: string }[];
  /** author → keys */
  reactions: Map<string, Set<string>>;
  pinned: boolean;
  deleted: boolean;
}

/** An event the hub would have dropped: aimed at a message it never heard of. */
export interface Dropped {
  t: 'reaction' | 'pin' | 'delete' | 'reactionsCleared';
  nativeId: string;
  /** Its position among the folder's events, for scoping to a scenario. */
  at: number;
  event: P.AdapterEvent;
}

/**
 * AdapterEvents folded into conversations the way dither-chat's hub folds them (its packages/hub/src/store.ts, the
 * `message`, `delete`, `reaction`, `reactionsCleared` and `pin` cases):
 *
 * - `message` creates the message or replaces it whole: body, kind, attachments when given, a reaction snapshot when
 *   given. editedTs, replyTo and the conversation are kept when a later fact leaves them out (COALESCE). A deleted
 *   message stays deleted.
 * - `delete` marks a known message deleted and empties it; an unknown one is dropped.
 * - `reaction`, `reactionsCleared` and `pin` on a message the hub does not have are dropped: that is what makes a
 *   reaction sent to a stale id (target-id drift after an edit) visible here, as a reaction missing from the state
 *   and an entry in `dropped`. On a network whose reactions are exclusive (REACTION_RULES), a new one replaces the
 *   person's old one.
 */
export class EventFolder {
  readonly messages = new Map<string, Folded>();
  readonly dropped: Dropped[] = [];
  readonly events: P.AdapterEvent[] = [];
  private listeners = new Set<() => void>();

  constructor(readonly network: Network) {}

  /** Resolves at the next event folded. */
  changed(): Promise<void> {
    return new Promise((resolve) => {
      const f = () => {
        this.listeners.delete(f);
        resolve();
      };
      this.listeners.add(f);
    });
  }

  /** The first event (from `from` on) matching, now or when it comes. */
  async next<T extends P.AdapterEvent>(pred: (e: P.AdapterEvent) => boolean, from = 0): Promise<T> {
    for (let i = from; ; ) {
      for (; i < this.events.length; i++) if (pred(this.events[i]!)) return this.events[i] as T;
      await this.changed();
    }
  }

  apply(ev: P.AdapterEvent) {
    const at = this.events.push(ev) - 1;
    switch (ev.t) {
      case 'message': {
        const f = ev.message;
        const old = this.messages.get(f.nativeId);
        const m: Folded = old ?? { nativeId: f.nativeId, conversation: f.conversation, author: f.author, ts: f.ts, body: '', edited: false, replyTo: null, attachments: [], reactions: new Map(), pinned: false, deleted: false };
        if (f.moved || !old) m.conversation = f.conversation;
        m.author = f.author;
        m.ts = f.ts;
        // A kept deleted message the network sends again empty (a Matrix redaction) keeps what it was.
        if (!(m.deleted && f.body === '')) m.body = f.body;
        if (f.editedTs != null) m.edited = true;
        if (f.replyTo) m.replyTo = f.replyTo;
        if (f.attachments && !(m.deleted && !f.attachments.length)) m.attachments = f.attachments.map((a) => ({ kind: a.kind, name: a.name }));
        if (f.reactions) {
          // The hub's applySnapshot: a key the snapshot leaves out is gone; a key with the whole list (no `count`)
          // has exactly those people; a partial list (with `count`) keeps whoever was known too.
          const keys = new Set(f.reactions.map((r) => canonicalReactionKey(r.key)));
          for (const [, set] of m.reactions) for (const k of [...set]) if (!keys.has(k)) set.delete(k);
          for (const r of f.reactions) {
            const key = canonicalReactionKey(r.key);
            if (r.count === undefined) for (const [a, set] of m.reactions) if (!r.authors.includes(a)) set.delete(key);
            for (const a of r.authors) (m.reactions.get(a) ?? m.reactions.set(a, new Set()).get(a)!).add(key);
          }
        }
        this.messages.set(f.nativeId, m);
        break;
      }
      case 'delete': {
        const m = this.messages.get(ev.nativeId);
        if (!m) this.dropped.push({ t: 'delete', nativeId: ev.nativeId, at, event: ev });
        else if (!m.deleted) {
          m.deleted = true;
          m.body = '';
          m.attachments = [];
        }
        break;
      }
      case 'reaction': {
        const m = this.messages.get(ev.message);
        if (!m) {
          this.dropped.push({ t: 'reaction', nativeId: ev.message, at, event: ev });
          break;
        }
        const key = canonicalReactionKey(ev.key);
        const mine = m.reactions.get(ev.author) ?? m.reactions.set(ev.author, new Set()).get(ev.author)!;
        if (ev.remove) mine.delete(key);
        else {
          if (REACTION_RULES[this.network]?.exclusive) mine.clear();
          mine.add(key);
        }
        break;
      }
      case 'reactionsCleared': {
        const m = this.messages.get(ev.message);
        if (!m) {
          this.dropped.push({ t: 'reactionsCleared', nativeId: ev.message, at, event: ev });
          break;
        }
        for (const [, set] of m.reactions) ev.key === undefined ? set.clear() : set.delete(canonicalReactionKey(ev.key));
        break;
      }
      case 'pin': {
        const m = this.messages.get(ev.message);
        if (!m) this.dropped.push({ t: 'pin', nativeId: ev.message, at, event: ev });
        else m.pinned = ev.pinned;
        break;
      }
    }
    for (const f of [...this.listeners]) f();
  }

  /** One conversation (or any matching), normalized. */
  state(d: Pick<ParityDriver, 'actorA' | 'actorB'>, conversation: string | ((c: string) => boolean)): NormalizedConversationState {
    const inIt = typeof conversation === 'string' ? (c: string) => c === conversation : conversation;
    const live: RawMessage[] = [];
    const deleted: string[] = [];
    for (const m of this.messages.values()) {
      if (!inIt(m.conversation)) continue;
      if (m.deleted) deleted.push(m.nativeId);
      else
        live.push({
          id: m.nativeId,
          author: m.author,
          body: m.body,
          edited: m.edited,
          replyTo: m.replyTo,
          reactions: [...m.reactions].flatMap(([author, keys]) => [...keys].map((key) => ({ author, key }))),
          pinned: m.pinned,
          attachments: m.attachments,
        });
    }
    return normalize(d, live, deleted);
  }
}

// ---------------------------------------------------------------- the diff

export interface Mismatch {
  kind: 'missing message' | 'extra message' | 'body' | 'edited' | 'replyTo' | 'dangling replyTo' | 'missing reaction' | 'extra reaction' | 'pinned' | 'missed delete' | 'wrong delete' | 'attachments' | 'author' | 'dropped event';
  id: Handle;
  detail: string;
}

const q = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}...` : s);

/** Every way the extractor's conversation differs from the oracle's, named. Empty: they agree. */
export function diffConversationStates(extractor: NormalizedConversationState, oracle: NormalizedConversationState): Mismatch[] {
  const out: Mismatch[] = [];
  const exIds = new Set(Object.keys(extractor.messages));
  const orIds = new Set(Object.keys(oracle.messages));
  const exDeleted = new Set(extractor.deleted);
  const orDeleted = new Set(oracle.deleted);
  for (const id of orIds) {
    if (exIds.has(id)) continue;
    const m = oracle.messages[id]!;
    if (exDeleted.has(id)) out.push({ kind: 'wrong delete', id, detail: `the extractor deleted ${id}, but the network still has it (${m.author}: ${q(m.body)})` });
    else out.push({ kind: 'missing message', id, detail: `the network has ${id} (${m.author}: ${q(m.body)}); the extractor never sent it` });
  }
  for (const id of exIds) {
    if (orIds.has(id)) continue;
    const m = extractor.messages[id]!;
    const twin = Object.values(oracle.messages).find((o) => o.body === m.body);
    if (orDeleted.has(id)) out.push({ kind: 'missed delete', id, detail: `the network deleted ${id}, but the extractor still shows it (${q(m.body)})` });
    else out.push({ kind: 'extra message', id, detail: `the extractor has ${id} (${m.author}: ${q(m.body)}), which the network does not${twin ? `: a duplicate of ${twin.id}?` : ''}` });
  }
  // Deleted on the network and never mentioned by the extractor at all: nothing shows, which is what a delete wants.
  for (const id of orIds) {
    const o = oracle.messages[id]!;
    const e = extractor.messages[id];
    if (!e) continue;
    if (e.author !== o.author) out.push({ kind: 'author', id, detail: `${id} is by ${o.author} on the network, ${e.author} in the extractor` });
    if (e.body !== o.body) out.push({ kind: 'body', id, detail: `${id} reads ${q(o.body)} on the network, ${q(e.body)} in the extractor` });
    if (e.edited !== o.edited) out.push({ kind: 'edited', id, detail: `${id} is ${o.edited ? '' : 'not '}edited on the network, ${e.edited ? '' : 'not '}edited in the extractor` });
    if (e.replyTo !== o.replyTo) out.push({ kind: 'replyTo', id, detail: `${id} replies to ${o.replyTo ?? 'nothing'} on the network, ${e.replyTo ?? 'nothing'} in the extractor` });
    for (const who of new Set([...Object.keys(o.reactionsByAuthor), ...Object.keys(e.reactionsByAuthor)])) {
      const ok = new Set(o.reactionsByAuthor[who] ?? []);
      const ek = new Set(e.reactionsByAuthor[who] ?? []);
      for (const k of ok) if (!ek.has(k)) out.push({ kind: 'missing reaction', id, detail: `${who}'s ${k} on ${id} is on the network, not in the extractor` });
      for (const k of ek) if (!ok.has(k)) out.push({ kind: 'extra reaction', id, detail: `${who}'s ${k} on ${id} is in the extractor, not on the network` });
    }
    if (e.pinned !== o.pinned) out.push({ kind: 'pinned', id, detail: `${id} is ${o.pinned ? '' : 'not '}pinned on the network, ${e.pinned ? '' : 'not '}pinned in the extractor` });
    if (JSON.stringify(e.attachments) !== JSON.stringify(o.attachments)) out.push({ kind: 'attachments', id, detail: `${id} has ${JSON.stringify(o.attachments)} on the network, ${JSON.stringify(e.attachments)} in the extractor` });
  }
  // A reply whose parent the extractor never told the hub about (neither there nor deleted) points at nothing.
  for (const e of Object.values(extractor.messages)) {
    if (e.replyTo && !exIds.has(e.replyTo) && !exDeleted.has(e.replyTo) && (orIds.has(e.replyTo) || orDeleted.has(e.replyTo)))
      out.push({ kind: 'dangling replyTo', id: e.id, detail: `${e.id} replies to ${e.replyTo}, which the extractor never sent` });
  }
  return out;
}

export function formatMismatches(m: Mismatch[]): string {
  return m.map((x) => `  - ${x.kind}: ${x.detail}`).join('\n');
}

// ---------------------------------------------------------------- the scenario matrix

export type Step =
  | { do: 'send'; as: Actor; ref: string; body: string; attachment?: true }
  | { do: 'edit'; as: Actor; ref: string; body: string }
  | { do: 'react'; as: Actor; ref: string; key: string; remove?: true }
  | { do: 'reply'; as: Actor; ref: string; to: string; body: string }
  | { do: 'delete'; as: Actor; ref: string }
  | { do: 'pin'; as: Actor; ref: string; pinned: boolean };

export interface Scenario {
  name: string;
  /** What it is there to catch. */
  catches: string;
  steps: Step[];
}

const CAP_OF: Record<Step['do'], Cap> = { send: 'send', edit: 'edit', react: 'react', reply: 'reply', delete: 'delete', pin: 'pin' };
export const stepCap = (s: Step): Cap => (s.do === 'send' && s.attachment ? 'media' : CAP_OF[s.do]);

/** The steps of a scenario this driver can take; a step whose actor lacks its capability is left out. */
export function runnableSteps(d: Pick<ParityDriver, 'capabilities' | 'only'>, s: Scenario): Step[] {
  const kept: Step[] = [];
  const refs = new Set<string>();
  for (const step of s.steps) {
    if (!can(d, step.as, stepCap(step))) continue;
    // A step on a message that was never sent (its send was skipped) goes too.
    if (step.do !== 'send' && !refs.has(step.ref) && !(step.do === 'reply' && refs.has(step.to))) continue;
    if (step.do === 'send' || step.do === 'reply') refs.add(step.ref);
    kept.push(step);
  }
  return kept;
}

/** Whether the scenario still tests what it is for here: more than its sends. */
export function scenarioRuns(d: Pick<ParityDriver, 'capabilities' | 'only'>, s: Scenario): boolean {
  const all = new Set(s.steps.map(stepCap));
  const kept = runnableSteps(d, s);
  // Every capability it is about must be there for someone: a scenario about pins says nothing without pins.
  for (const c of all) if (c !== 'send' && !kept.some((st) => stepCap(st) === c)) return false;
  return kept.length > 1;
}

// ---------------------------------------------------------------- running it

export interface RunOptions {
  /** How long the extractor may take to agree with the network after a step before the step fails (default 20 s). */
  convergeMs?: number;
  /** A nonce in every body, so scenarios sharing a conversation never match each other's messages. */
  tag?: string;
  log?: (line: string) => void;
}

/**
 * Waits until the extractor's state equals the oracle's: looked at again at every change, so it returns the moment
 * they agree. Fails after `ms` with the differences named; that limit only ends a failure, a pass never waits for it.
 */
export async function converge(d: ParityDriver, keep: (id: Handle) => boolean, label: string, ms: number, mark?: number): Promise<void> {
  // Any event the hub would drop since the scenario began is a failure in itself: something aimed at a wrong id.
  const dropped = () => (mark !== undefined ? (d.dropped?.(mark) ?? []) : []);
  let oracle = scoped(await d.oracleState(), keep);
  let timer: Timer | undefined;
  const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ms)));
  try {
    for (;;) {
      const next = d.changed();
      const ex = scoped(d.extractorState(), keep);
      const diff = diffConversationStates(ex, oracle);
      if (!diff.length && !dropped().length) return;
      const r = await Promise.race([next, timeout]);
      // The network can move on after the action returned (a fake's update, an echo), so it is read again too.
      oracle = scoped(await d.oracleState(), keep);
      if (r === 'timeout') {
        const ex2 = scoped(d.extractorState(), keep);
        const diff2 = diffConversationStates(ex2, oracle);
        if (!diff2.length && !dropped().length) return;
        const lines = [...diff2.map((x) => `  - ${x.kind}: ${x.detail}`), ...dropped().map((x) => `  - dropped event: the extractor sent a ${x.t} for ${x.nativeId}, a message it never sent (the hub drops it)`)];
        throw new Error(`${d.name}, ${label}: the extractor does not agree with the network after ${ms} ms\n${lines.join('\n')}\n  extractor: ${JSON.stringify(ex2)}\n  network:   ${JSON.stringify(oracle)}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one scenario against a driver, checking the two states agree after every step and at a barrier after the last. */
export async function runScenario(d: ParityDriver, s: Scenario, o: RunOptions = {}): Promise<void> {
  const ms = o.convergeMs ?? 20_000;
  // PARITY_LOG=1: each step, and the state both sides agreed on at the end.
  const log = o.log ?? (process.env.PARITY_LOG ? (l: string) => console.log(`[parity] ${d.name}: ${l}`) : undefined);
  const tag = o.tag ?? Math.random().toString(36).slice(2, 8);
  await d.beginScenario?.(s.name);
  // Messages from before the scenario (a conversation shared with earlier ones) are left out of the comparison.
  const before = new Set([...Object.keys(d.extractorState().messages), ...d.extractorState().deleted, ...Object.keys((await d.oracleState()).messages), ...(await d.oracleState()).deleted]);
  const keep = (id: Handle) => !before.has(id);
  const mark = d.mark?.();
  const refs = new Map<string, Handle>();
  const ref = (r: string) => {
    const h = refs.get(r);
    if (!h) throw new Error(`${s.name}: no message "${r}" yet`);
    return h;
  };
  const steps = runnableSteps(d, s);
  for (const [i, step] of steps.entries()) {
    const label = `${s.name}, step ${i + 1} (${step.as} ${step.do}${'body' in step ? ` ${JSON.stringify(step.body)}` : ''}${step.do === 'react' ? ` ${step.key}${step.remove ? ' removed' : ''}` : ''}${step.do === 'pin' ? (step.pinned ? ' on' : ' off') : ''})`;
    log?.(label);
    const body = (b: string) => `${b} [${tag}]`;
    switch (step.do) {
      case 'send':
        refs.set(step.ref, await d.send(step.as, body(step.body), step.attachment ? { attachment: { name: `parity-${tag}.png`, mime: 'image/png', bytes: PNG } } : undefined));
        break;
      case 'edit':
        await d.edit(step.as, ref(step.ref), body(step.body));
        break;
      case 'react':
        await d.react(step.as, ref(step.ref), step.key, !!step.remove);
        break;
      case 'reply':
        refs.set(step.ref, await d.reply(step.as, ref(step.to), body(step.body)));
        break;
      case 'delete':
        await d.delete(step.as, ref(step.ref));
        break;
      case 'pin':
        await d.pin(step.as, ref(step.ref), step.pinned);
        break;
    }
    await converge(d, keep, label, ms, mark);
  }
  // A barrier: the other person writes once more. Whatever the extractor would still send about the steps (a late
  // duplicate, a reaction to a stale id) comes before it, so once it is folded the comparison is final.
  const barrierBy: Actor | null = can(d, 'B', 'send') ? 'B' : can(d, 'A', 'send') ? 'A' : null;
  if (barrierBy) {
    await d.send(barrierBy, `barrier [${tag}]`);
    await converge(d, keep, `${s.name}, the barrier`, ms, mark);
  }
  log?.(`${s.name}: agreed on ${JSON.stringify(scoped(d.extractorState(), keep))}`);
}

/** A 1×1 PNG, for the file scenario. */
export const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
