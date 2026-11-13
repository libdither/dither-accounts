/**
 * Sending with more than words (dither-chat's docs/sending.md; its docs/research/discord-gaps.md rows "Silent send",
 * "Reply without ping", "Suppress embeds", "Saved messages / bookmarks", "Reminders" and "Scheduled messages"):
 *
 * - a send's `silent` and `mentionReplied` become the client's own send options (flags SUPPRESS_NOTIFICATIONS, and
 *   allowedMentions with replied_user false, exactly as its reply bar's @ toggle builds them);
 * - previews come off your own message through the client's MessageActions.suppressEmbeds;
 * - saved messages and reminders are what the client loads by itself on connecting (SAVED_MESSAGES_UPDATE) and hears
 *   from the gateway (SAVED_MESSAGE_CREATE/DELETE), its own timer's MESSAGE_REMINDER_DUE, and its Saved list's fetch
 *   when the owner opens the list (savedList); saving goes through its own save functions;
 * - Discord's own scheduled messages are read with the request its Scheduled list makes, only when its experiment
 *   gate says this account has them, and cancelled with its own cancel.
 *
 * Read from the client's source (build of 2026-11-12), never run. The hook's side is in hook.js, "sending extras".
 */
import type * as P from '@dither-chat/protocol';
import type { RawMessage } from './discord-types.ts';
import { type AdapterState, messageEvents } from './ingest.ts';
import { isoToMs } from './map.ts';

// ------------------------------------------------------------------ the hook's shapes

/** A saved message as the hook picks it from the client's store or an action (save_data, snake_case). */
export interface RawSaved {
  channel_id: string;
  message_id: string;
  guild_id?: string | null;
  saved_at: string | null;
  due_at?: string | null;
  notes?: string | null;
  author_summary?: string | null;
  channel_summary?: string | null;
  message_summary?: string | null;
  message?: RawMessage | null;
}

/** A Discord scheduled message as its list request answers (snake_case). */
export interface RawScheduled {
  id: string;
  channel_id: string;
  content?: string;
  scheduled_timestamp: string;
  flags?: number;
  message_reference?: { message_id?: string } | null;
}

export type SendingDispatch = 'SAVED_MESSAGES_UPDATE' | 'SAVED_MESSAGE_CREATE' | 'SAVED_MESSAGE_DELETE' | 'MESSAGE_REMINDER_DUE';
export const SENDING_DISPATCHES = new Set<string>(['SAVED_MESSAGES_UPDATE', 'SAVED_MESSAGE_CREATE', 'SAVED_MESSAGE_DELETE', 'MESSAGE_REMINDER_DUE']);

export type SendingHookCommand =
  /** reply {} once the client patched it. */
  | { kind: 'suppressEmbeds'; channelId: string; messageId: string }
  /** reply RawSaved (a save) or {} (a removal). */
  | { kind: 'save'; channelId: string; messageId: string; dueAt?: string; remove?: boolean }
  /** reply { saved: RawSaved[]; more: boolean }: the client's Saved list, loaded (more: its next page) and read from its store. */
  | { kind: 'savedList'; more?: boolean }
  /** reply { enabled: boolean; scheduled: RawScheduled[] } */
  | { kind: 'nativeScheduled' }
  /** reply {} */
  | { kind: 'cancelScheduled'; id: string };

/** Discord's message flag for @silent. */
export const SUPPRESS_NOTIFICATIONS = 1 << 12;
/** Everything a reply's mention may parse, as the client's reply bar sends with replied_user false. */
export const MENTION_PARSE = ['users', 'roles', 'everyone'] as const;

/** The client's own send options for a send's silent and no-ping, or nothing. */
export function sendOptions(cmd: { silent?: boolean; mentionReplied?: boolean; replyTo?: string }): { flags?: number; allowedMentions?: { parse: string[]; replied_user: false } } {
  return {
    ...(cmd.silent ? { flags: SUPPRESS_NOTIFICATIONS } : {}),
    ...(cmd.replyTo && cmd.mentionReplied === false ? { allowedMentions: { parse: [...MENTION_PARSE], replied_user: false as const } } : {}),
  };
}

// ------------------------------------------------------------------ capabilities

export function sendingCapabilities(found: Record<string, boolean>): P.Capability[] {
  const caps: P.Capability[] = [];
  // The client's own send takes both options; without it, the REST body the hook sends carries them the same way.
  if (found.MessageActions || found.Rest) caps.push('silentSend', 'replyMention');
  if (found.MessageActions || found.Rest) caps.push('suppressEmbeds');
  if (found.SavedMessagesStore && found.SavedMessageActions) caps.push('savedMessages');
  if (found.ScheduledMessageActions && found.ScheduledMessageGate && found.Rest) caps.push('nativeScheduled');
  return caps;
}

// ------------------------------------------------------------------ facts

/** A saved message in protocol terms, or null when the hook's shape is not one. */
export function savedFact(r: RawSaved | null | undefined): P.SavedFact | null {
  if (!r || typeof r.message_id !== 'string' || !r.message_id) return null;
  const savedAt = isoToMs(r.saved_at ?? null);
  const due = isoToMs(r.due_at ?? null) || undefined;
  const summary = { ...(r.author_summary ? { author: r.author_summary } : {}), ...(r.channel_summary ? { place: r.channel_summary } : {}), ...(r.message_summary ? { text: r.message_summary } : {}) };
  return {
    ...(r.channel_id ? { conversation: String(r.channel_id) } : {}),
    message: String(r.message_id),
    savedAt,
    ...(due !== undefined ? { dueAt: due } : {}),
    ...(r.notes ? { note: r.notes } : {}),
    ...(Object.keys(summary).length ? { summary } : {}),
  };
}

/** Message facts for those saved messages the client had loaded, then the saved facts. */
function savedEvents(list: RawSaved[], st: AdapterState): { events: P.AdapterEvent[]; facts: P.SavedFact[] } {
  const events: P.AdapterEvent[] = [];
  const facts: P.SavedFact[] = [];
  for (const r of list) {
    const f = savedFact(r);
    if (!f) continue;
    if (r.message && r.message.id) events.push(...messageEvents(r.message, st, false));
    facts.push(f);
  }
  return { events, facts };
}

/** The hook's forwarded saved-message actions as facts. */
export function sendingDispatch(event: string, data: any, st: AdapterState): P.AdapterEvent[] {
  switch (event) {
    // What the client loads on connecting: its reminders whole, and only the ids of the rest, so not `complete`.
    case 'SAVED_MESSAGES_UPDATE':
    case 'SAVED_MESSAGE_CREATE': {
      const list: RawSaved[] = Array.isArray(data?.saved) ? data.saved : [];
      const { events, facts } = savedEvents(list, st);
      return facts.length ? [...events, { t: 'saved', saved: facts }] : events;
    }
    case 'SAVED_MESSAGE_DELETE':
      return data?.message_id ? [{ t: 'unsaved', message: String(data.message_id), ...(data.channel_id ? { conversation: String(data.channel_id) } : {}) }] : [];
    case 'MESSAGE_REMINDER_DUE': {
      const { events, facts } = savedEvents(data?.saved ? [data.saved] : [], st);
      return facts.length ? [...events, { t: 'reminderDue', saved: facts[0] }] : [];
    }
    default:
      return [];
  }
}

// ------------------------------------------------------------------ commands

/** The hook command for a protocol command of this section. */
export function sendingHookCommand(cmd: P.SendCommand): SendingHookCommand {
  switch (cmd.t) {
    case 'suppressEmbeds':
      return { kind: 'suppressEmbeds', channelId: cmd.conversation, messageId: cmd.message };
    case 'save':
      return { kind: 'save', channelId: cmd.conversation, messageId: cmd.message, ...(cmd.remove ? { remove: true } : {}), ...(cmd.dueAt !== undefined ? { dueAt: new Date(cmd.dueAt).toISOString() } : {}) };
    case 'savedList':
      return { kind: 'savedList', ...(cmd.before !== undefined ? { more: true } : {}) };
    case 'nativeScheduled':
      return { kind: 'nativeScheduled' };
    case 'cancelScheduled':
      if (!/^\d+$/.test(cmd.nativeId)) throw new Error('which scheduled message?');
      return { kind: 'cancelScheduled', id: cmd.nativeId };
  }
}

/** A savedList's answer: facts for the messages first, then the reply. */
export function savedListOutcome(raw: { saved?: RawSaved[]; more?: boolean } | null | undefined, st: AdapterState): { events: P.AdapterEvent[]; result: P.SavedListResult } {
  const { events, facts } = savedEvents(Array.isArray(raw?.saved) ? raw!.saved! : [], st);
  facts.sort((a, b) => b.savedAt - a.savedAt);
  return { events, result: { saved: facts, more: !!raw?.more } };
}

/** Discord's scheduled messages in protocol terms. */
export function nativeScheduledOutcome(raw: { enabled?: boolean; scheduled?: RawScheduled[] } | null | undefined): P.NativeScheduledResult {
  if (!raw?.enabled) return { enabled: false, scheduled: [] };
  const out: P.NativeScheduledFact[] = [];
  for (const s of Array.isArray(raw.scheduled) ? raw.scheduled : []) {
    const due = isoToMs(s?.scheduled_timestamp ?? null);
    if (!s?.id || !s.channel_id || !due) continue;
    out.push({
      nativeId: String(s.id),
      conversation: String(s.channel_id),
      body: s.content ?? '',
      dueAt: due,
      ...((s.flags ?? 0) & SUPPRESS_NOTIFICATIONS ? { silent: true } : {}),
      ...(s.message_reference?.message_id ? { replyTo: String(s.message_reference.message_id) } : {}),
    });
  }
  return { enabled: true, scheduled: out.sort((a, b) => a.dueAt - b.dueAt) };
}
