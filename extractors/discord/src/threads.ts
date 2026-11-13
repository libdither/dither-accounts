/**
 * Threads, forums and group DMs beyond messages (dither-chat's docs/threads.md): which threads this account follows
 * and how each notifies it, starting threads and forum posts, archiving and locking, a forum's tags, publishing in an
 * announcement channel, and running a group DM it owns (leaving it, taking someone out, handing it over, its picture).
 * The hook reads and acts through the client's own stores and actions (hook.js, "threads"); this maps what it hands
 * over to the protocol (pure functions, tested in test/threads.test.ts) and runs the commands on the adapter's paces.
 *
 * Discord notifies about a thread only while you are in it (a mention reaches you anyway): a thread's membership is
 * told to the hub as its native mute (threadMute), so triage weighs it as Discord's own apps do.
 */
import { POST_TAGS_MAX, postProblem, threadNameProblem } from '@dither-chat/protocol';
import type * as P from '@dither-chat/protocol';
import { readFileSync } from 'node:fs';
import type { RawAbout, RawChannel, RawUser } from './discord-types.ts';
import { CHANNEL_TYPE, isoToMs, isThread } from './map.ts';

// ---------------------------------------------------------------- what the hook hands over

/** This account's membership of a thread, as hook.js joinedOf reads it. */
export interface RawThreadMember {
  flags: number;
  muted: boolean;
  /** ISO time a mute runs out; null: until turned off. */
  mute_end: string | null;
}

/** A forum's tag, as hook.js picks it. */
export interface RawForumTag {
  id: string;
  name: string;
  emoji_name?: string | null;
  emoji_id?: string | null;
  moderated?: boolean;
}

/** What pickChannel adds to a thread or a forum (hook.js threadChannelFields). */
export interface RawThreadFields {
  /** null: not in it; absent: the hook could not say. */
  member?: RawThreadMember | null;
  applied_tags?: string[];
  available_tags?: RawForumTag[];
  /** 0 latest activity, 1 creation date. */
  default_sort_order?: number | null;
  /** 0 not set, 1 list, 2 gallery. */
  default_forum_layout?: number | null;
  /** A post's PINNED 2; a forum's REQUIRE_TAG 16. */
  flags?: number | null;
  message_count?: number | null;
  create_timestamp?: string | null;
  invitable?: boolean;
}

/** The hook's thread, forum, group and DM commands. */
export type ThreadHookCommand =
  | { kind: 'followThread'; channelId: string; follow: boolean }
  | { kind: 'threadNotify'; channelId: string; notify?: P.ThreadNotify; muted?: boolean; until?: number }
  | { kind: 'threadState'; channelId: string; archived?: boolean; locked?: boolean }
  | { kind: 'createThread'; channelId: string; name: string; messageId?: string; private?: boolean; content?: string; nonce: string; files?: HookFile[] }
  | { kind: 'createPost'; channelId: string; name: string; content: string; tags: string[]; files?: HookFile[] }
  | { kind: 'crosspost'; channelId: string; messageId: string }
  | { kind: 'leaveGroupDM'; channelId: string; silent?: boolean }
  | { kind: 'groupMember'; channelId: string; userId: string; op: 'remove' | 'owner' }
  | { kind: 'groupIcon'; channelId: string; dataUrl: string | null };

export type HookFile = { name: string; mime: string; size: number; base64: string };

/** The dispatches the threads section forwards. */
export const THREAD_DISPATCHES = new Set(['THREAD_MEMBER_UPDATE', 'THREAD_MEMBERS_UPDATE', 'LOAD_FORUM_POSTS', 'LOAD_ARCHIVED_THREADS_SUCCESS', 'LOAD_THREADS_SUCCESS']);
export type ThreadDispatch = 'THREAD_MEMBER_UPDATE' | 'THREAD_MEMBERS_UPDATE' | 'LOAD_FORUM_POSTS' | 'LOAD_ARCHIVED_THREADS_SUCCESS' | 'LOAD_THREADS_SUCCESS';

// ---------------------------------------------------------------- facts

/** Discord's numbers. */
const FLAG = { ALL_MESSAGES: 2, ONLY_MENTIONS: 4, NO_MESSAGES: 8 } as const;
const POST_PINNED = 2;
const REQUIRE_TAG = 16;
type Raw = RawChannel & RawThreadFields;

/** How this account stands in a thread, as a notify setting; undefined where the member flags set none. */
function notifyOf(flags: number): P.ThreadNotify | undefined {
  if (flags & FLAG.ALL_MESSAGES) return 'all';
  if (flags & FLAG.ONLY_MENTIONS) return 'mentions';
  if (flags & FLAG.NO_MESSAGES) return 'none';
  return undefined;
}

/** A thread's own facts; undefined when the hook said nothing beyond the channel. */
export function threadFact(c: Raw): P.ThreadFact | undefined {
  if (!isThread(c.type)) return undefined;
  const out: P.ThreadFact = {};
  if (c.member === null) out.joined = false;
  else if (c.member) {
    out.joined = true;
    const n = notifyOf(c.member.flags ?? 0);
    if (n) out.notify = n;
    if (c.member.muted) {
      out.muted = true;
      const until = isoToMs(c.member.mute_end ?? null);
      if (until) out.mutedUntil = until;
    }
  }
  if (c.thread_metadata?.locked) out.locked = true;
  if (Array.isArray(c.applied_tags)) out.tags = c.applied_tags.map(String);
  if (typeof c.flags === 'number' && c.flags & POST_PINNED) out.pinned = true;
  if (c.type === CHANNEL_TYPE.PRIVATE_THREAD) out.private = true;
  if (c.owner_id) out.owner = c.owner_id;
  const created = isoToMs(c.create_timestamp ?? null);
  if (created) out.createdAt = created;
  if (typeof c.message_count === 'number') out.messageCount = c.message_count;
  return Object.keys(out).length ? out : undefined;
}

/**
 * A thread's membership as its native mute: Discord tells you of a thread's messages only while you are in it (a
 * mention reaches you either way), and then as the thread's own setting says, else as its channel. undefined: the
 * hook could not say, and the hub keeps what it had.
 */
export function threadMute(c: Raw): P.NativeMute | undefined {
  if (c.member === undefined) return undefined;
  if (c.member === null) return { level: 'mentions' };
  const m = c.member;
  const out: P.NativeMute = {};
  const n = notifyOf(m.flags ?? 0);
  if (n) out.level = n;
  if (m.muted) {
    out.muted = true;
    const until = isoToMs(m.mute_end ?? null);
    if (until) out.until = until;
  }
  return out;
}

/** A forum's (or media channel's) tags and default order; undefined for any other channel. */
export function forumFact(c: Raw): P.ForumFact | undefined {
  if (c.type !== CHANNEL_TYPE.FORUM && c.type !== CHANNEL_TYPE.MEDIA) return undefined;
  const tags: P.ForumTag[] = (c.available_tags ?? [])
    .filter((t) => t?.id && t.name)
    .map((t) => ({ id: String(t.id), name: String(t.name), ...(t.emoji_name ? { emoji: t.emoji_name } : {}), ...(t.moderated ? { moderated: true } : {}) }));
  return {
    tags,
    sort: c.default_sort_order === 1 ? 'created' : 'activity',
    layout: c.default_forum_layout === 2 || (c.default_forum_layout !== 1 && c.type === CHANNEL_TYPE.MEDIA) ? 'gallery' : 'list',
    ...(typeof c.flags === 'number' && c.flags & REQUIRE_TAG ? { tagRequired: true } : {}),
  };
}

/** A conversation fact with what this adds: a thread's facts and its membership as a mute, a forum's tags. */
export function withThreadFacts(fact: P.ConversationFact, c: Raw): P.ConversationFact {
  const thread = threadFact(c);
  const forum = forumFact(c);
  const mute = thread ? threadMute(c) : undefined;
  // A mute the caller already worked out (a channel override) is more specific than the membership.
  return { ...fact, ...(thread ? { thread } : {}), ...(forum ? { forum } : {}), ...(mute && !fact.mute ? { mute } : {}) };
}

// ---------------------------------------------------------------- the About

const NEED_THREADS = 'You need the Manage Threads permission.';
const NEED_THREADS_OR_OWN = 'You need the Manage Threads permission, or to have started the thread.';
const LOCKED_ARCHIVE = 'It is locked: only someone with Manage Threads may open it again.';
const NOT_OWNER = 'Only the group owner may do this.';

/**
 * A thread's About with archiving, locking and following; a group DM's with its owner, removing and handing it over,
 * its picture where this account may change it, and leaving it; a DM's with closing it.
 */
export function withThreads(about: P.About, raw: RawAbout, caps: P.Capability[]): P.About {
  const c = raw.channel as (RawAbout['channel'] & RawThreadFields) | undefined;
  if (!c) return about;
  const self = raw.selfId ?? '';
  if (isThread(c.type)) {
    const archived = !!c.thread_metadata?.archived;
    const locked = !!c.thread_metadata?.locked;
    const manage = raw.can?.manageThreads === true;
    const own = !!c.owner_id && c.owner_id === self;
    const canArchive = manage || (own && !locked);
    const f = threadFact(c);
    const thread: P.AboutThread = {
      archived,
      locked,
      canArchive: caps.includes('threadState') && canArchive,
      canLock: caps.includes('threadState') && manage,
      ...(!canArchive ? { reason: locked ? LOCKED_ARCHIVE : NEED_THREADS_OR_OWN } : !manage ? { reason: `Locking: ${NEED_THREADS.toLowerCase()}` } : {}),
      joined: f?.joined === true,
      ...(f?.notify ? { notify: f.notify } : {}),
      ...(f?.muted ? { muted: true } : {}),
      ...(f?.mutedUntil ? { mutedUntil: f.mutedUntil } : {}),
    };
    return { ...about, thread };
  }
  if (c.type === CHANNEL_TYPE.GROUP_DM) {
    const owner = c.owner_id ?? undefined;
    const youOwn = !!owner && owner === self;
    const others = (c.recipients ?? []).filter((r) => r.id !== self).length;
    const ownership: P.AboutOwnership = {
      ...(owner ? { owner } : {}),
      youOwn,
      canRemove: caps.includes('removeMembers') && youOwn && others > 0,
      canTransfer: caps.includes('transferOwner') && youOwn && others > 0,
      ...(!youOwn ? { reason: NOT_OWNER } : {}),
    };
    const avatar = about.fields.avatar;
    return {
      ...about,
      ownership,
      // Anyone in a group DM may change its picture.
      ...(caps.includes('groupPicture') && avatar ? { fields: { ...about.fields, avatar: { value: avatar.value, canEdit: true } } } : {}),
      ...(caps.includes('leave') ? { leaving: { can: true, silent: true, ...(youOwn && others ? { warning: 'You own this group: Discord makes someone else in it its owner.' } : {}) } } : {}),
    };
  }
  if (c.type === CHANNEL_TYPE.DM && caps.includes('leave')) {
    return { ...about, leaving: { can: true, warning: 'Closing it only hides it in Discord: it comes back when either of you writes.' } };
  }
  return about;
}

// ---------------------------------------------------------------- capabilities

/** What the modules found allow. Everything here needs at least the REST client. */
export function threadCapabilities(found: Record<string, boolean>): P.Capability[] {
  if (!found.Rest) return [];
  const caps: P.Capability[] = ['createThreads', 'forumPosts', 'myThreads', 'crosspost', 'removeMembers', 'transferOwner', 'groupPicture', 'leave'];
  if (found.JoinedThreadsStore && found.ThreadActions) caps.push('followThreads');
  if (found.ThreadActions) caps.push('threadState');
  return caps;
}

// ---------------------------------------------------------------- the commands

interface Bridge {
  request<T>(cmd: { kind: string; [k: string]: unknown }, timeoutMs: number): Promise<T>;
}
interface Pace {
  run<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export interface ThreadOpsDeps {
  bridge: Bridge;
  /** Writes, as the adapter paces sends and settings. */
  pace: Pace;
  emit: (ev: P.AdapterEvent) => void;
  /** The facts for a channel the hook handed back (its conversation, with the threads part). */
  channel: (c: RawChannel) => P.AdapterEvent[];
  /** The facts for a message the hook handed back. */
  message: (m: unknown) => P.AdapterEvent[];
  users: (users: (RawUser | null | undefined)[]) => void;
  caps: () => P.Capability[];
  /** A fresh About, read from the client's stores. */
  about: (target: P.AboutTarget) => Promise<P.About>;
  /** The raw about behind it, for the checks. */
  rawAbout: (target: P.AboutTarget) => Promise<RawAbout>;
  nonce: () => string;
  log: (level: 'debug' | 'info' | 'warn', msg: string, data?: unknown) => void;
}

/** A check the client wanted (a captcha): the owner's, in the live view. */
function checked(r: { check?: string } | null | undefined, what: string) {
  if (r?.check) throw new Error(`Discord wants a ${r.check} check before it will ${what}: open the live view`);
}

/** The files of a command, read from the hub's spool, as the hook sends them. */
export function hookFiles(list: P.OutgoingAttachment[] | undefined): HookFile[] | undefined {
  return list?.length ? list.map((f) => ({ name: f.name, mime: f.mime, size: f.size, base64: readFileSync(f.path).toString('base64') })) : undefined;
}

export class ThreadOps {
  constructor(private d: ThreadOpsDeps) {}

  private need(cap: P.Capability, what: string) {
    if (!this.d.caps().includes(cap)) throw new Error(`${what} isn't available: the hook did not find Discord's own module for it (Discord changed?)`);
  }

  /** The channel the hook handed back, told; its thread facts as they now stand. */
  private told(r: { channel?: RawChannel | null } | null | undefined): P.ThreadFact {
    if (!r?.channel) return {};
    let thread: P.ThreadFact = {};
    for (const ev of this.d.channel(r.channel)) {
      this.d.emit(ev);
      if (ev.t === 'conversation' && ev.conversation.nativeId === r.channel.id) thread = ev.conversation.thread ?? {};
    }
    return thread;
  }

  async follow(cmd: Extract<P.AdapterCommand, { t: 'followThread' }>): Promise<P.ThreadFact> {
    this.need('followThreads', 'Following threads');
    const r = await this.d.pace.run('followThread', () => this.d.bridge.request<{ channel?: RawChannel | null; check?: string }>({ kind: 'followThread', channelId: cmd.conversation, follow: cmd.follow === true }, 45_000));
    checked(r, cmd.follow ? 'let you follow it' : 'let you leave it');
    return this.told(r);
  }

  async notify(cmd: Extract<P.AdapterCommand, { t: 'threadNotify' }>): Promise<P.ThreadFact> {
    this.need('followThreads', 'Thread notifications');
    if (cmd.notify !== undefined && cmd.notify !== 'all' && cmd.notify !== 'mentions' && cmd.notify !== 'none') throw new Error('All messages, only mentions, or nothing?');
    if (cmd.notify === undefined && typeof cmd.muted !== 'boolean') throw new Error('nothing to change');
    const hc: ThreadHookCommand = { kind: 'threadNotify', channelId: cmd.conversation, ...(cmd.notify ? { notify: cmd.notify } : {}), ...(typeof cmd.muted === 'boolean' ? { muted: cmd.muted } : {}), ...(cmd.muted && cmd.until ? { until: cmd.until } : {}) };
    const r = await this.d.pace.run('threadNotify', () => this.d.bridge.request<{ channel?: RawChannel | null; check?: string }>(hc, 45_000));
    checked(r, 'change it');
    return this.told(r);
  }

  /** Archive or lock, checked against a fresh About first; the About again after. */
  async state(cmd: Extract<P.AdapterCommand, { t: 'threadState' }>): Promise<P.About> {
    this.need('threadState', 'Archiving and locking threads');
    const target: P.AboutTarget = { kind: 'conversation', nativeId: cmd.conversation };
    const t = (await this.d.about(target)).thread;
    if (!t) throw new Error('That is not a thread');
    if (cmd.archived !== undefined && cmd.archived !== t.archived && !t.canArchive) throw new Error(t.reason ?? NEED_THREADS_OR_OWN);
    if (cmd.locked !== undefined && cmd.locked !== t.locked && !t.canLock) throw new Error(NEED_THREADS);
    const archived = cmd.archived !== undefined && cmd.archived !== t.archived ? cmd.archived : undefined;
    const locked = cmd.locked !== undefined && cmd.locked !== t.locked ? cmd.locked : undefined;
    if (archived === undefined && locked === undefined) return this.d.about(target);
    const r = await this.d.pace.run('threadState', () => this.d.bridge.request<{ channel?: RawChannel | null; check?: string }>({ kind: 'threadState', channelId: cmd.conversation, ...(archived !== undefined ? { archived } : {}), ...(locked !== undefined ? { locked } : {}) }, 60_000));
    checked(r, 'change it');
    this.told(r);
    return this.d.about(target);
  }

  async createThread(cmd: Extract<P.AdapterCommand, { t: 'createThread' }>): Promise<P.CreateThreadResult> {
    this.need('createThreads', 'Starting threads');
    const problem = threadNameProblem(cmd.name);
    if (problem) throw new Error(problem);
    const files = hookFiles(cmd.attachments);
    const hc: ThreadHookCommand = {
      kind: 'createThread',
      channelId: cmd.conversation,
      name: cmd.name.trim(),
      ...(cmd.message ? { messageId: cmd.message } : {}),
      ...(cmd.private ? { private: true } : {}),
      ...(cmd.body?.trim() ? { content: cmd.body } : {}),
      nonce: this.d.nonce(),
      ...(files ? { files } : {}),
    };
    const r = await this.d.pace.run('createThread', () => this.d.bridge.request<{ channel?: RawChannel | null; check?: string }>(hc, files ? 170_000 : 60_000));
    checked(r, 'start it');
    if (!r?.channel?.id) throw new Error('Discord did not say which thread it started');
    this.told(r);
    return { conversation: r.channel.id };
  }

  async createPost(cmd: Extract<P.AdapterCommand, { t: 'createPost' }>, forum?: P.ForumFact | null): Promise<P.CreateThreadResult> {
    this.need('forumPosts', 'Starting forum posts');
    const tags = [...new Set((cmd.tags ?? []).map(String))].slice(0, POST_TAGS_MAX + 1);
    const problem = postProblem({ name: cmd.name, body: cmd.body, tags, files: cmd.attachments?.length ?? 0 }, forum ?? null);
    if (problem) throw new Error(problem);
    const files = hookFiles(cmd.attachments);
    const hc: ThreadHookCommand = { kind: 'createPost', channelId: cmd.conversation, name: cmd.name.trim(), content: cmd.body ?? '', tags, ...(files ? { files } : {}) };
    const r = await this.d.pace.run('createPost', () => this.d.bridge.request<{ channel?: RawChannel | null; message?: unknown; check?: string }>(hc, files ? 170_000 : 60_000));
    checked(r, 'start it');
    if (!r?.channel?.id) throw new Error('Discord did not say which post it started');
    this.told(r);
    if (r.message) for (const ev of this.d.message(r.message)) this.d.emit(ev);
    return { conversation: r.channel.id };
  }

  async crosspost(cmd: Extract<P.AdapterCommand, { t: 'crosspost' }>): Promise<Record<string, never>> {
    this.need('crosspost', 'Publishing');
    const r = await this.d.pace.run('crosspost', () => this.d.bridge.request<{ message?: unknown; check?: string }>({ kind: 'crosspost', channelId: cmd.conversation, messageId: cmd.message }, 45_000));
    checked(r, 'publish it');
    if (r?.message) for (const ev of this.d.message(r.message)) this.d.emit(ev);
    return {};
  }

  /** Leave a group DM (silently where asked) or close a DM. The leave event first. */
  async leaveConversation(cmd: Extract<P.AdapterCommand, { t: 'leave' }>): Promise<P.LeaveResult> {
    this.need('leave', 'Leaving');
    const raw = await this.d.rawAbout(cmd.target);
    const c = raw.channel;
    if (!c || (c.type !== CHANNEL_TYPE.DM && c.type !== CHANNEL_TYPE.GROUP_DM)) throw new Error("Leaving a channel or thread isn't something Discord does: leave its server, or unfollow the thread");
    const r = await this.d.pace.run('leave', () => this.d.bridge.request<{ left?: boolean; check?: string }>({ kind: 'leaveGroupDM', channelId: c.id, ...(cmd.silent && c.type === CHANNEL_TYPE.GROUP_DM ? { silent: true } : {}) }, 45_000));
    checked(r, c.type === CHANNEL_TYPE.GROUP_DM ? 'let you leave' : 'close it');
    // A closed DM is only hidden in Discord, and its history stays; a group left is gone.
    if (c.type === CHANNEL_TYPE.GROUP_DM) this.d.emit({ t: 'leave', kind: 'conversation', nativeId: c.id });
    return { left: true };
  }

  /** Take someone out of a group DM, or hand it to them: checked against a fresh About first; the About again after. */
  async member(cmd: Extract<P.AdapterCommand, { t: 'removeMember' | 'setOwner' }>): Promise<P.About> {
    const remove = cmd.t === 'removeMember';
    this.need(remove ? 'removeMembers' : 'transferOwner', remove ? 'Removing people' : 'Handing a group over');
    if (cmd.target.kind !== 'conversation') throw new Error('Discord has owners only for group DMs here');
    const about = await this.d.about(cmd.target);
    const o = about.ownership;
    if (!o) throw new Error('Only a group DM has an owner');
    if (remove ? !o.canRemove : !o.canTransfer) throw new Error(o.reason ?? 'You may not do this here');
    if (!about.members?.list.some((m) => m.id === cmd.who) || cmd.who === o.owner) throw new Error(remove ? 'They are not in this group' : 'Give it to someone else in the group');
    const r = await this.d.pace.run(cmd.t, () => this.d.bridge.request<{ channel?: RawChannel | null; check?: string }>({ kind: 'groupMember', channelId: cmd.target.nativeId, userId: cmd.who, op: remove ? 'remove' : 'owner' }, 45_000));
    checked(r, remove ? 'remove them' : 'hand it over');
    this.told(r);
    return this.d.about(cmd.target);
  }

  /** A group DM's picture, or none. */
  async picture(cmd: Extract<P.AdapterCommand, { t: 'setPicture' }>): Promise<P.About> {
    this.need('groupPicture', 'Changing the picture');
    const about = await this.d.about(cmd.target);
    if (!about.ownership || !about.fields.avatar?.canEdit) throw new Error(about.fields.avatar?.reason ?? 'Only a group DM has a picture you may change here');
    let dataUrl: string | null = null;
    if (cmd.picture) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(cmd.picture.mime)) throw new Error('A picture is a PNG, JPEG, GIF or WebP');
      if (cmd.picture.size > 8 * 1024 * 1024) throw new Error('That picture is over 8 MB');
      dataUrl = `data:${cmd.picture.mime};base64,${readFileSync(cmd.picture.path).toString('base64')}`;
    }
    const r = await this.d.pace.run('setPicture', () => this.d.bridge.request<{ channel?: RawChannel | null; check?: string }>({ kind: 'groupIcon', channelId: cmd.target.nativeId, dataUrl }, 60_000));
    checked(r, 'change it');
    this.told(r);
    return this.d.about(cmd.target);
  }
}

// ---------------------------------------------------------------- dispatches

/** The threads section's dispatches to facts: channels (with this account's membership) and the messages loaded. */
export function threadDispatch(event: string, a: any, d: Pick<ThreadOpsDeps, 'channel' | 'message'>): P.AdapterEvent[] {
  if (!THREAD_DISPATCHES.has(event) || !a) return [];
  const out: P.AdapterEvent[] = [];
  for (const c of Array.isArray(a.channels) ? a.channels : []) if (c?.id) out.push(...d.channel(c));
  for (const m of Array.isArray(a.messages) ? a.messages : []) out.push(...d.message(m));
  return out;
}
