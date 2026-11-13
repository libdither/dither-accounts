/**
 * Attention: what Discord itself knows about what needs you, beyond messages as they come (dither-chat's
 * docs/research/discord-gaps.md, "Mentions, inbox, notifications"; protocol attention.ts). Pure functions over what
 * the hook forwards (its "attention" section), and the little state they keep; main.ts runs them.
 *
 * - **Mentions found late.** Discord's recent mentions (its Inbox's Mentions tab, /users/@me/mentions) name mentions
 *   in channels the client never loaded. Asked at a person's pace: after a snapshot (start, reconnect) and when the
 *   notification center says something new came, never more often than MENTIONS_GAP_MS. Each hit is a message fact
 *   with `late`, flagged as mentioning you: the hub triages it as live only while it is young by its own time.
 * - **Notification center.** A mention item carries its message (a late mention as above); a reaction to your message
 *   is a reaction fact on it. The rest (friend accepted, events starting) the hub learns elsewhere or not at all.
 * - **Message requests and spam.** A DM Discord holds as a message request, or filed as spam, is a RequestFact of
 *   kind 'message' about its conversation (spam ones `spam`), so the hub keeps it silent under Requests; Accept,
 *   Decline and Block are the client's request buttons.
 * - **Notification settings live.** Mutes and levels changed in Discord (any app), a mute running out, and the ones
 *   dither sets: the server's, category's, channel's or DM's fact again, with `{}` where a mute was cleared.
 * - **Unread by hand, many read at once.** The client's Mark Unread (a manual ack) and its bulk ack.
 */
import type * as P from '@dither-chat/protocol';
import type { RawChannel, RawGuild, RawGuildSettings, RawMessage, RawSnapshot, RawUser } from './discord-types.ts';
import { type AdapterState, messageEvents, routeChannel, userFacts } from './ingest.ts';
import { CHANNEL_TYPE, channelMute, customEmoji, isoToMs, mapCategory, mapChannel, mapGuild, mapMute, reactionKey, snowflakeToMs } from './map.ts';

// ------------------------------------------------------------------ the hook's shapes

/** The actions the hook's attention section forwards. */
export type AttentionDispatch =
  | 'LOAD_RECENT_MENTIONS_SUCCESS'
  | 'NOTIFICATION_CENTER_ITEM_CREATE'
  | 'REACTION_NOTIFICATION_SENT'
  | 'USER_GUILD_SETTINGS_FULL_UPDATE'
  | 'USER_GUILD_SETTINGS_GUILD_UPDATE'
  | 'USER_GUILD_SETTINGS_CHANNEL_UPDATE'
  | 'USER_GUILD_SETTINGS_CHANNEL_UPDATE_BULK'
  | 'USER_GUILD_SETTINGS_GUILD_AND_CHANNELS_UPDATE'
  | 'CHANNEL_MUTE_EXPIRED'
  | 'GUILD_MUTE_EXPIRED'
  | 'MESSAGE_REQUEST_ACCEPT_OPTIMISTIC';

const SETTINGS_EVENTS = new Set<string>([
  'USER_GUILD_SETTINGS_FULL_UPDATE',
  'USER_GUILD_SETTINGS_GUILD_UPDATE',
  'USER_GUILD_SETTINGS_CHANNEL_UPDATE',
  'USER_GUILD_SETTINGS_CHANNEL_UPDATE_BULK',
  'USER_GUILD_SETTINGS_GUILD_AND_CHANNELS_UPDATE',
  'CHANNEL_MUTE_EXPIRED',
  'GUILD_MUTE_EXPIRED',
]);

export type AttentionHookCommand =
  /** reply { via: 'actions' } (the answer comes as LOAD_RECENT_MENTIONS_SUCCESS) or { via: 'rest', messages, channels }. */
  | { kind: 'recentMentions'; limit?: number }
  /** reply RawMuted */
  | { kind: 'mute'; target: 'space' | 'conversation'; id: string; muted: boolean; until?: number }
  | { kind: 'markUnread'; channelId: string; messageId: string }
  /** reply { marked } */
  | { kind: 'markReadMany'; items: { channelId: string; messageId: string }[] }
  | { kind: 'messageRequestAnswer'; channelId: string; answer: P.RequestAnswer };

/** A DM as the hook picks it, with Discord's request and spam flags (absent: an older hook, which says nothing). */
export interface RawDM extends RawChannel {
  is_message_request?: boolean;
  is_message_request_timestamp?: string | null;
  is_spam?: boolean;
}

/** A server's settings, with what it suppresses. */
export interface RawAttentionSettings extends RawGuildSettings {
  suppress_everyone?: boolean;
  suppress_roles?: boolean;
}

/** One server's settings (or the DMs', guildId null) as the store had them after a change, and the channels they may name. */
export interface RawSettingsChange {
  guildId: string | null;
  settings: RawAttentionSettings;
  channels: RawChannel[];
  guild: RawGuild | null;
}

/** The hook's answer to `mute`. */
export interface RawMuted {
  guildId: string | null;
  settings: RawAttentionSettings;
  channel: RawChannel | null;
  guild: RawGuild | null;
}

export interface RawNotice {
  id: string;
  type: string;
  other_user?: RawUser | null;
  message?: RawMessage | null;
  channels?: RawChannel[];
}

// ------------------------------------------------------------------ state

export interface AttentionState {
  /** Message requests and spam DMs waiting, by channel id. */
  requests: Map<string, P.RequestFact>;
  /** Server, category, channel or DM id -> the mute last told (JSON, '' for none). */
  mutes: Map<string, string>;
  /** Messages told as late mentions, so a list fetched again tells each once. */
  told: Set<string>;
}

export function newAttention(): AttentionState {
  return { requests: new Map(), mutes: new Map(), told: new Set() };
}

/** What this account can do, by the modules the hook found. A request goes through the client's REST helper. */
export function attentionCapabilities(found: Record<string, boolean>): P.Capability[] {
  const caps: P.Capability[] = [];
  if (found.RecentMentionsActions || found.Rest) caps.push('mentions');
  // Only through the client's own menus' action: a mute is a setting the client keeps in its store.
  if (found.NotificationSettingsActions) caps.push('mute');
  if (found.Rest) caps.push('markUnread');
  if (found.Dispatcher && found.ReadStateStore) caps.push('markReadMany');
  return caps;
}

// ------------------------------------------------------------------ mentions

/** Recent mentions are asked for at most this often, and this long after what asked, so a burst asks once. */
export const MENTIONS_GAP_MS = 5 * 60_000;
export const MENTIONS_SETTLE_MS = 45_000;
const TOLD_MEMORY = 5_000;

/**
 * When the next recent-mentions request may go: never sooner than `settleMs` from now, nor `gapMs` after the last.
 * One request answers every reason that came meanwhile.
 */
export class MentionsPacer {
  private last = -Infinity;
  private timer: unknown = null;
  readonly reasons = new Set<string>();

  constructor(
    private run: (reasons: string[]) => Promise<void>,
    private o: { gapMs?: number; settleMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown } = {},
  ) {}

  /** Something says there may be mentions to learn of: a start, a reconnect, the notification center. */
  want(reason: string) {
    this.reasons.add(reason);
    if (this.timer) return;
    const now = (this.o.now ?? Date.now)();
    const at = Math.max(now + (this.o.settleMs ?? MENTIONS_SETTLE_MS), this.last + (this.o.gapMs ?? MENTIONS_GAP_MS));
    this.timer = (this.o.setTimer ?? setTimeout)(() => void this.fire(), at - now);
  }

  get scheduled(): boolean {
    return this.timer !== null;
  }

  private async fire() {
    this.timer = null;
    this.last = (this.o.now ?? Date.now)();
    const reasons = [...this.reasons];
    this.reasons.clear();
    try {
      await this.run(reasons);
    } catch {
      /* the run logs its own failure; the next reason asks again */
    }
  }
}

/**
 * Mentions found late -> the channels they are in that were not known (a thread nobody opened), the people they
 * name, and each message with `late`, flagged as mentioning you. @everyone, @here or a role (it is in the list, and
 * not you by name) is `mentionsAll`, which the hub never takes as being about you. Each message once.
 */
export function mentionEvents(messages: RawMessage[], channels: RawChannel[], st: AdapterState, att: AttentionState): P.AdapterEvent[] {
  const events: P.AdapterEvent[] = [];
  const fresh = (messages ?? []).filter((m) => m?.id && m.channel_id && m.author?.id && !att.told.has(m.id));
  if (!fresh.length) return events;
  const want = new Set(fresh.map((m) => m.channel_id));
  for (const c of channels ?? []) if (c?.id && want.has(c.id) && !st.known.has(c.id)) events.push(...routeChannel(c, st));
  for (const m of [...fresh].sort((a, b) => snowflakeToMs(a.id) - snowflakeToMs(b.id))) {
    if (att.told.size >= TOLD_MEMORY) att.told.clear();
    att.told.add(m.id);
    for (const ev of messageEvents(m, st, false)) {
      if (ev.t !== 'message') {
        events.push(ev);
        continue;
      }
      const byName = ev.message.mentionsSelf === true && ev.message.mentionsAll !== true;
      const { mentionsAll: _all, ...message } = ev.message;
      events.push({ ...ev, late: true, message: { ...message, mentionsSelf: true, ...(byName ? {} : { mentionsAll: true }) } });
    }
  }
  return events;
}

// ------------------------------------------------------------------ notification center

const MENTION_ITEMS = new Set(['recent_mention', 'reply_mention']);

/**
 * A notification center item -> facts, and whether recent mentions are worth asking for: a mention item with its
 * message is a late mention at once; one without asks the list.
 */
export function noticeEvents(item: RawNotice, st: AdapterState, att: AttentionState): { events: P.AdapterEvent[]; wantMentions: boolean } {
  if (!item || !MENTION_ITEMS.has(item.type)) return { events: [], wantMentions: false };
  if (!item.message?.id) return { events: [], wantMentions: true };
  return { events: mentionEvents([item.message], item.channels ?? [], st, att), wantMentions: false };
}

/** Someone reacted to your message (Discord's reaction notification): who, then the reaction on it. */
export function reactionNoticeEvents(
  a: { channelId?: string; messageId?: string; userId?: string; user?: RawUser | null; emoji?: { id?: string | null; name: string | null; animated?: boolean } | null },
  st: AdapterState,
): P.AdapterEvent[] {
  if (!a?.channelId || !a.messageId || !a.userId || !a.emoji || a.userId === st.selfId) return [];
  const emoji = customEmoji(a.emoji);
  return [...userFacts([a.user], st), { t: 'reaction', conversation: a.channelId, message: a.messageId, author: a.userId, key: reactionKey(a.emoji), ...(emoji ? { emoji } : {}) }];
}

// ------------------------------------------------------------------ message requests

export const SPAM_DM_WARNING = 'Discord filed this message as spam';
const MESSAGE_ANSWERS: P.RequestAnswer[] = ['accept', 'decline', 'block'];

export const messageRequestId = (channelId: string) => `message:${channelId}`;
/** The channel a message request is about, or null when it is not one (a friend request is `friend:<user>`). */
export function messageRequestChannel(nativeId: string): string | null {
  const m = /^message:(\d{15,22})$/.exec(String(nativeId));
  return m ? m[1]! : null;
}

/** A DM held as a message request or filed as spam -> its RequestFact; null when it is neither, or the hook did not say. */
export function messageRequest(c: RawDM, selfId: string): P.RequestFact | null {
  if (!c?.id || (c.type !== CHANNEL_TYPE.DM && c.type !== CHANNEL_TYPE.GROUP_DM)) return null;
  if (c.is_message_request !== true && c.is_spam !== true) return null;
  const from = (c.recipients ?? []).find((r) => r?.id && r.id !== selfId)?.id;
  const ts = isoToMs(c.is_message_request_timestamp) || (c.last_message_id ? snowflakeToMs(c.last_message_id) : 0) || snowflakeToMs(c.id);
  return {
    nativeId: messageRequestId(c.id),
    kind: 'message',
    ...(from ? { from } : {}),
    target: { kind: 'conversation', nativeId: c.id },
    ts,
    answers: [...MESSAGE_ANSWERS],
    ...(c.is_spam === true ? { spam: true, warning: SPAM_DM_WARNING } : {}),
  };
}

/** Whether the hook said anything of this DM's flags (an older hook says nothing, and nothing changes then). */
const saysFlags = (c: RawDM) => typeof c.is_message_request === 'boolean' || typeof c.is_spam === 'boolean';

/**
 * DMs as they now are -> a request for each new or changed one (who sent it first), a requestGone for each that is
 * no longer one. `whole`: these are all the DMs there are (a snapshot), so a request not among them is gone too.
 */
export function requestChanges(channels: RawDM[], st: AdapterState, att: AttentionState, whole = false): P.AdapterEvent[] {
  const events: P.AdapterEvent[] = [];
  const seen = new Set<string>();
  for (const c of channels ?? []) {
    if (!c?.id || (c.type !== CHANNEL_TYPE.DM && c.type !== CHANNEL_TYPE.GROUP_DM) || !saysFlags(c)) continue;
    seen.add(c.id);
    const fact = messageRequest(c, st.selfId);
    const had = att.requests.get(c.id);
    if (fact) {
      if (had && JSON.stringify(had) === JSON.stringify(fact)) continue;
      att.requests.set(c.id, fact);
      events.push(...userFacts((c.recipients ?? []).filter((r) => r.id === fact.from), st), { t: 'request', request: fact });
    } else if (had) {
      att.requests.delete(c.id);
      events.push({ t: 'requestGone', nativeId: had.nativeId });
    }
  }
  if (whole)
    for (const [id, had] of [...att.requests]) {
      if (seen.has(id)) continue;
      att.requests.delete(id);
      events.push({ t: 'requestGone', nativeId: had.nativeId });
    }
  return events;
}

/** A request answered or gone here or in another app (accepted, the DM closed): requestGone, once. */
export function requestGone(channelId: string, att: AttentionState): P.AdapterEvent[] {
  const had = att.requests.get(channelId);
  if (!had) return [];
  att.requests.delete(channelId);
  return [{ t: 'requestGone', nativeId: had.nativeId }];
}

/** The account's whole requests list with its message requests in it: the friend requests' list is add.ts's. */
export function withMessageRequests(ev: P.AdapterEvent, att: AttentionState): P.AdapterEvent {
  if (ev.t !== 'requests' || !att.requests.size) return ev;
  const have = new Set(ev.requests.map((r) => r.nativeId));
  return { t: 'requests', requests: [...ev.requests, ...[...att.requests.values()].filter((r) => !have.has(r.nativeId))] };
}

/** What answering a message request did: it is gone, and an accepted one leads to its conversation. */
export function messageAnswerOutcome(channelId: string, answer: P.RequestAnswer, att: AttentionState): { events: P.AdapterEvent[]; result: P.AddResult } {
  return { events: requestGone(channelId, att), result: answer === 'accept' ? { conversation: channelId } : answer === 'block' ? { relationship: 'blocked' } : {} };
}

// ------------------------------------------------------------------ notification settings

/** A server's own mute, with what it suppresses: what its space fact says. */
export function spaceMute(gs: RawAttentionSettings | undefined): P.NativeMute | undefined {
  if (!gs) return undefined;
  const m = mapMute(gs);
  const out: P.NativeMute = { ...m, ...(gs.suppress_everyone === true ? { suppressEveryone: true } : {}), ...(gs.suppress_roles === true ? { suppressRoles: true } : {}) };
  return Object.keys(out).length ? out : undefined;
}

const sig = (m: P.NativeMute | undefined) => (m && Object.keys(m).length ? JSON.stringify(m) : '');
const keyOf = (id: string | null | undefined) => (id == null || id === '@me' ? null : String(id));

/**
 * The mutes a snapshot told, as where changes start from. Its servers' facts did not say what they suppress, so a
 * server that suppresses anything is told again with it.
 */
export function snapshotMutes(data: Pick<RawSnapshot, 'guilds' | 'channels' | 'privateChannels' | 'guildSettings'>, st: AdapterState, att: AttentionState): P.AdapterEvent[] {
  const events: P.AdapterEvent[] = [];
  const settings = new Map<string | null, RawAttentionSettings>();
  for (const gs of (data.guildSettings ?? []) as RawAttentionSettings[]) settings.set(keyOf(gs.guild_id), gs);
  for (const g of data.guilds ?? []) {
    const gs = settings.get(g.id);
    const m = spaceMute(gs);
    att.mutes.set(g.id, sig(m));
    if (m && sig(m) !== sig(gs ? mapMute(gs) : undefined)) events.push({ t: 'space', space: mapGuild(st.guilds.get(g.id) ?? g, m) });
  }
  for (const c of data.channels ?? []) att.mutes.set(c.id, sig(channelMute(settings.get(keyOf(c.guild_id)), c.id)));
  for (const c of data.privateChannels ?? []) att.mutes.set(c.id, sig(channelMute(settings.get(null), c.id)));
  return events;
}

/**
 * Settings as they now are, after a change made anywhere -> the fact of each server, category, channel and DM whose
 * mute changed, with `{}` where a mute was cleared. The adapter's settings are updated, so later facts keep them.
 */
export function settingsEvents(changes: RawSettingsChange[], st: AdapterState, att: AttentionState): P.AdapterEvent[] {
  const events: P.AdapterEvent[] = [];
  for (const ch of changes ?? []) {
    if (!ch?.settings) continue;
    const gid = keyOf(ch.guildId ?? ch.settings.guild_id);
    const gs: RawAttentionSettings = { ...ch.settings, guild_id: gid };
    st.guildSettings.set(gid, gs);
    if (gid !== null) {
      const known = st.guilds.get(gid);
      const g = ch.guild ? { ...known, ...ch.guild } : known;
      const m = spaceMute(gs);
      if (g && att.mutes.get(gid) !== sig(m) && (att.mutes.has(gid) || m)) {
        att.mutes.set(gid, sig(m));
        st.guilds.set(gid, g);
        events.push({ t: 'space', space: mapGuild(g, m ?? {}) });
      }
    }
    const guild = gid ? st.guilds.get(gid) : undefined;
    for (const c of ch.channels ?? []) {
      if (!c?.id) continue;
      const m = channelMute(gs, c.id);
      const was = att.mutes.get(c.id);
      if (was === sig(m) || (was === undefined && !m)) continue;
      att.mutes.set(c.id, sig(m));
      if (c.type === CHANNEL_TYPE.CATEGORY) events.push({ t: 'space', space: mapCategory(c, m ?? {}) });
      else {
        const fact = mapChannel(c, { selfId: st.selfId, guild, mute: m ?? {} });
        if (!fact) continue;
        st.known.add(c.id);
        events.push({ t: 'conversation', conversation: fact });
      }
    }
  }
  return events;
}

/** The hook command for the hub's `mute`. */
export function muteHookCommand(cmd: { target: P.AboutTarget; muted: boolean; until?: number }): AttentionHookCommand {
  if (!/^\d{15,22}$/.test(String(cmd.target?.nativeId))) throw new Error('That is not a Discord id');
  if (typeof cmd.muted !== 'boolean') throw new Error('Mute or unmute?');
  return { kind: 'mute', target: cmd.target.kind, id: cmd.target.nativeId, muted: cmd.muted, ...(cmd.muted && typeof cmd.until === 'number' ? { until: cmd.until } : {}) };
}

/** What the hook answered to `mute`: the facts that changed, and the target's mute as it now stands (`{}`: none). */
export function muteOutcome(raw: RawMuted, target: P.AboutTarget, st: AdapterState, att: AttentionState): { events: P.AdapterEvent[]; mute: P.NativeMute } {
  const events = settingsEvents([{ guildId: raw.guildId, settings: raw.settings, channels: raw.channel ? [raw.channel] : [], guild: raw.guild }], st, att);
  const gs = st.guildSettings.get(keyOf(raw.guildId)) as RawAttentionSettings | undefined;
  const mute = target.kind === 'space' && raw.guild ? spaceMute(gs) : channelMute(gs, target.nativeId);
  return { events, mute: mute ?? {} };
}

// ------------------------------------------------------------------ read states

/** The hook command for the hub's `markUnread`: a manual ack of the message just before `from`. */
export function markUnreadHookCommand(conversation: string, from: string): AttentionHookCommand {
  if (!/^\d{15,22}$/.test(String(conversation)) || !/^\d{15,22}$/.test(String(from))) throw new Error('That is not a Discord id');
  return { kind: 'markUnread', channelId: conversation, messageId: (BigInt(from) - 1n).toString() };
}

/** The hook command for the hub's `markReadMany`: the ones with Discord ids, at most `max`. */
export function markReadManyHookCommand(items: { conversation: string; upTo: string }[], max = 50): AttentionHookCommand {
  const ok = (Array.isArray(items) ? items : []).filter((x) => /^\d{15,22}$/.test(String(x?.conversation)) && /^\d{15,22}$/.test(String(x?.upTo)));
  if (ok.length > max) throw new Error(`At most ${max} at a time`);
  return { kind: 'markReadMany', items: ok.map((x) => ({ channelId: x.conversation, messageId: x.upTo })) };
}

// ------------------------------------------------------------------ dispatch

/**
 * One forwarded action -> facts, for the actions above and for the channel actions a request may ride on (a DM
 * created as a request, one updated when it is accepted or filed as spam, one closed). `wantMentions` is called when
 * recent mentions are worth asking for.
 */
export function attentionDispatch(event: string, a: any, st: AdapterState, att: AttentionState, wantMentions: (reason: string) => void): P.AdapterEvent[] {
  if (SETTINGS_EVENTS.has(event)) return settingsEvents(a?.changes ?? [], st, att);
  switch (event) {
    case 'LOAD_RECENT_MENTIONS_SUCCESS':
      return mentionEvents(a?.messages ?? [], a?.channels ?? [], st, att);
    case 'NOTIFICATION_CENTER_ITEM_CREATE': {
      const { events, wantMentions: want } = noticeEvents(a as RawNotice, st, att);
      if (want) wantMentions('notification center');
      return events;
    }
    case 'REACTION_NOTIFICATION_SENT':
      return reactionNoticeEvents(a, st);
    case 'MESSAGE_REQUEST_ACCEPT_OPTIMISTIC':
      return a?.channelId ? requestGone(String(a.channelId), att) : [];
    case 'CHANNEL_CREATE':
      return a?.channel ? requestChanges([a.channel], st, att) : [];
    case 'CHANNEL_UPDATES':
      return requestChanges(a?.channels ?? [], st, att);
    case 'CHANNEL_DELETE':
      return a?.channel?.id ? requestGone(String(a.channel.id), att) : [];
    default:
      return [];
  }
}

/** What a snapshot adds: its message requests (all of them, so one not there is gone) and where mutes start from. */
export function attentionSnapshot(data: RawSnapshot, st: AdapterState, att: AttentionState): P.AdapterEvent[] {
  const dms = (data.privateChannels ?? []) as RawDM[];
  return [...snapshotMutes(data, st, att), ...requestChanges(dms, st, att, dms.some(saysFlags))];
}
