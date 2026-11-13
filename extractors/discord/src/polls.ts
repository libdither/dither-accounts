/**
 * Polls and pins on Discord (dither-chat's protocol poll.ts; docs/chat.md "Polls and pins").
 *
 * A poll comes on its message (the hook's pickPoll: question, answers, expiry, choice rule, and its counts with your
 * own vote, from the gateway's results or the client's vote reactions). A vote after that comes as a reaction of the
 * vote kind: the hook adds the poll as the client then counts it when it has the message loaded, and the adapter
 * says those counts; otherwise only that one answer moved, by one. Your own vote is said by the vote itself, so its
 * echo is not counted twice. Who voted is never asked for: Discord's client asks only when someone clicks a count.
 *
 * Voting and ending go through the client's own poll actions (its REST helper when that chunk is not loaded), making
 * one through its own sendPollMessage; pinning is the pin button's request, and a channel's pinned list is the pages
 * its pins popout loads, read when the About is opened and kept a minute.
 */
import type * as P from '@dither-chat/protocol';
import { PIN_DURATIONS, pollDraftProblem } from '@dither-chat/protocol';
import type { RawMessage, RawPoll } from './discord-types.ts';

/** Discord's reaction kind for a poll vote. */
export const VOTE_REACTION = 2;

/** An answer's emoji as body Markdown: a custom one as `<:name:id>`, else the character. */
function emojiText(e: { id?: string | null; name?: string | null; animated?: boolean } | null | undefined): string | undefined {
  if (!e) return undefined;
  if (e.id) return `<${e.animated ? 'a' : ''}:${e.name || 'emoji'}:${e.id}>`;
  return e.name || undefined;
}

/** The hook's poll as protocol poll.ts has it. An older hook sent the answers' words alone: Discord numbers them from 1. */
export function pollFact(p: RawPoll | undefined): P.PollFact | undefined {
  if (!p || typeof p.question !== 'string' || !Array.isArray(p.answers) || !p.answers.length) return undefined;
  const options: P.PollOptionFact[] = p.answers.map((a, i) => {
    if (typeof a === 'string') return { id: String(i + 1), text: a };
    const emoji = emojiText(a.emoji);
    return { id: String(a.id), text: a.text ?? '', ...(emoji ? { emoji } : {}) };
  });
  const expires = p.expiry ? Date.parse(p.expiry) : NaN;
  return {
    question: p.question,
    options,
    ...(p.allow_multiselect ? { multi: true } : {}),
    ...(Number.isFinite(expires) ? { expires } : {}),
    ...(p.finalized ? { ended: true } : {}),
    ...(p.counts ? { counts: p.counts, mine: p.mine ?? [] } : {}),
  };
}

/** A poll's result message (type 46) says its poll is over: the poll it points at. */
export function pollResultEvents(m: RawMessage): P.AdapterEvent[] {
  const ref = m.message_reference;
  if (m.type !== 46 || !ref?.message_id) return [];
  return [{ t: 'pollUpdate', conversation: ref.channel_id ?? m.channel_id, message: ref.message_id, ended: true }];
}

/** What the hook forwards for a vote: the reaction, and the poll as the client counts it now when it has the message. */
interface RawVote {
  channelId?: string;
  messageId?: string;
  userId?: string;
  emoji?: { id?: string | null } | null;
  poll?: RawPoll | null;
}

/** Counts said whole: the client's, after the change. */
function countsEvent(channelId: string, messageId: string, poll: RawPoll): P.AdapterEvent[] {
  if (!poll.counts) return [];
  return [{ t: 'pollUpdate', conversation: channelId, message: messageId, counts: poll.counts, mine: poll.mine ?? [], ...(poll.finalized ? { ended: true } : {}) }];
}

/** A vote added or taken back, heard as a reaction of the vote kind. */
export function voteEvents(a: RawVote, remove: boolean, selfId: string | null): P.AdapterEvent[] {
  if (!a?.channelId || !a.messageId) return [];
  if (a.poll) return countsEvent(a.channelId, a.messageId, a.poll);
  const answer = a.emoji?.id;
  // Your own vote was said when it was made; an echo of it without the client's counts would count it twice.
  if (answer == null || !a.userId || a.userId === selfId) return [];
  return [{ t: 'pollUpdate', conversation: a.channelId, message: a.messageId, add: { [String(answer)]: remove ? -1 : 1 } }];
}

/** Votes heard many at once (the batched form). */
export function manyVoteEvents(
  a: { channelId?: string; messageId?: string; reactions?: { emoji?: { id?: string | null } | null; reactionType?: number; users?: ({ id?: string } | string)[] }[]; poll?: RawPoll | null },
  selfId: string | null,
): P.AdapterEvent[] {
  if (!a?.channelId || !a.messageId) return [];
  const votes = (a.reactions ?? []).filter((r) => r?.reactionType === VOTE_REACTION);
  if (!votes.length) return [];
  if (a.poll) return countsEvent(a.channelId, a.messageId, a.poll);
  const add: Record<string, number> = {};
  for (const r of votes) {
    const id = r.emoji?.id;
    if (id == null) continue;
    const n = (r.users ?? []).filter((u) => (typeof u === 'string' ? u : u?.id) !== selfId).length;
    if (n) add[String(id)] = (add[String(id)] ?? 0) + n;
  }
  return Object.keys(add).length ? [{ t: 'pollUpdate', conversation: a.channelId, message: a.messageId, add }] : [];
}

/** The capabilities the modules found allow: the REST helper stands in for a poll or pin chunk not loaded yet. */
export function pollCapabilities(found: Record<string, boolean>): P.Capability[] {
  const caps: P.Capability[] = ['polls'];
  if (found.PollActions || found.Rest) caps.push('pollVote', 'pollEnd');
  if (found.MessageActions || found.Rest) caps.push('pollCreate');
  if (found.Rest) caps.push('pin');
  return caps;
}

// ---------------------------------------------------------------- the commands

interface Bridge {
  request<T>(cmd: { kind: string; [k: string]: unknown }, timeoutMs: number): Promise<T>;
}
interface Pace {
  run<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export interface PollOpsDeps {
  bridge: Bridge;
  /** Writes: as the adapter paces sends. */
  pace: Pace;
  /** Reads a click makes: the pinned list. */
  lookPace: Pace;
  emit: (ev: P.AdapterEvent) => void;
  /** Facts for messages a read brought (the pinned ones). */
  messages: (raw: RawMessage[]) => void;
  selfId: () => string | null;
  caps: () => P.Capability[];
  nonce: () => string;
}

function checked(r: { check?: string } | null | undefined, what: string) {
  if (r?.check) throw new Error(`Discord wants a ${r.check} check before it will ${what}: open the live view`);
}

/** A pinned list read this recently is not read again. */
const PINS_FRESH_MS = 60_000;

export class PollOps {
  private pins = new Map<string, { at: number; ids: string[]; complete: boolean }>();
  constructor(private d: PollOpsDeps) {}

  private need(cap: P.Capability, what: string) {
    if (!this.d.caps().includes(cap)) throw new Error(`${what} isn't available: the hook did not find Discord's own module for it (Discord changed?)`);
  }

  /** Your vote. The store's counts lag it until the gateway says it, so your vote alone goes on: the hub moves the counts. */
  async vote(cmd: Extract<P.AdapterCommand, { t: 'pollVote' }>): Promise<unknown> {
    this.need('pollVote', 'Voting');
    const r = await this.d.pace.run('pollVote', () => this.d.bridge.request<{ check?: string }>({ kind: 'pollVote', channelId: cmd.conversation, messageId: cmd.message, answerIds: cmd.options }, 45_000));
    checked(r, 'take your vote');
    this.d.emit({ t: 'pollUpdate', conversation: cmd.conversation, message: cmd.message, mine: cmd.options });
    return {};
  }

  async end(cmd: Extract<P.AdapterCommand, { t: 'pollEnd' }>): Promise<unknown> {
    this.need('pollEnd', 'Ending polls');
    const r = await this.d.pace.run('pollEnd', () => this.d.bridge.request<{ check?: string }>({ kind: 'pollEnd', channelId: cmd.conversation, messageId: cmd.message }, 45_000));
    checked(r, 'end the poll');
    this.d.emit({ t: 'pollUpdate', conversation: cmd.conversation, message: cmd.message, ended: true });
    return {};
  }

  async create(cmd: Extract<P.AdapterCommand, { t: 'pollCreate' }>): Promise<{ nativeId?: string }> {
    this.need('pollCreate', 'Making polls');
    const problem = pollDraftProblem('discord', cmd.poll);
    if (problem) throw new Error(problem);
    const hours = cmd.poll.hours ?? 24;
    const r = await this.d.pace.run('pollCreate', () =>
      this.d.bridge.request<{ check?: string; nativeId?: string | null }>(
        { kind: 'pollCreate', channelId: cmd.conversation, question: cmd.poll.question.trim(), answers: cmd.poll.options.map((o) => o.trim()), multi: cmd.poll.multi, hours, nonce: this.d.nonce() },
        60_000,
      ),
    );
    checked(r, 'send the poll');
    // The message itself comes back from the gateway, as a sent one does.
    return r?.nativeId ? { nativeId: r.nativeId } : {};
  }

  /** Pin or unpin (Discord's pins have no timer); the pin said here too, as the gateway's own news of it may not come. */
  async pin(target: P.AboutTarget, change: Extract<P.AboutChange, { key: 'pin' }>, pinned: P.AboutPinned | undefined): Promise<void> {
    this.need('pin', 'Pinning');
    if (target.kind !== 'conversation') throw new Error('Messages are pinned in a channel, not a server');
    if (typeof change.seconds === 'number' && !change.remove && !PIN_DURATIONS.discord?.includes(change.seconds)) throw new Error("Discord's pins have no timer");
    if (pinned && !pinned.canEdit) throw new Error(pinned.reason ?? 'You need the Pin Messages permission here');
    const r = await this.d.pace.run('pin', () => this.d.bridge.request<{ check?: string }>({ kind: 'pin', channelId: target.nativeId, messageId: change.message, remove: !!change.remove }, 30_000));
    checked(r, change.remove ? 'unpin it' : 'pin it');
    this.pins.delete(target.nativeId);
    const by = this.d.selfId();
    this.d.emit({ t: 'pin', conversation: target.nativeId, message: change.message, pinned: !change.remove, ...(by ? { by } : {}), ts: Date.now() });
  }

  /**
   * The channel's pinned messages as Discord has them, for its About: the pinned ones' facts first, and a pin for
   * each at its time. Null when pins cannot be read here.
   */
  async pinned(channelId: string, canEdit: boolean, reason?: string): Promise<P.AboutPinned | null> {
    if (!this.d.caps().includes('pin')) return null;
    let kept = this.pins.get(channelId);
    if (!kept || Date.now() - kept.at > PINS_FRESH_MS) {
      const r = await this.d.lookPace.run('pins', () => this.d.bridge.request<{ pins: { pinned_at: string | null; message: RawMessage }[]; more: boolean }>({ kind: 'pinnedList', channelId }, 60_000));
      const list = (r?.pins ?? []).filter((p) => p?.message?.id);
      this.d.messages(list.map((p) => p.message));
      for (const p of list) {
        const at = p.pinned_at ? Date.parse(p.pinned_at) : NaN;
        this.d.emit({ t: 'pin', conversation: channelId, message: p.message.id, pinned: true, ...(Number.isFinite(at) ? { ts: at } : {}) });
      }
      kept = { at: Date.now(), ids: list.map((p) => p.message.id), complete: !r?.more };
      this.pins.set(channelId, kept);
    }
    return { messages: kept.ids, canEdit, ...(reason && !canEdit ? { reason } : {}), ...(kept.complete ? { complete: true } : {}) };
  }
}
