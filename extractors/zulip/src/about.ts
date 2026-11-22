/**
 * A Zulip place's settings and members (`about`, `configure`), people's profiles (`profile`, `setProfile`), the @
 * picker (`mentionables`), and joining a channel by its link or name (`resolve`, `add`).
 *
 * Who may do what follows Zulip's roles (owner 100, administrator 200, moderator 300, member 400, guest 600) and each
 * channel's own permission groups where the server says them; the server has the last word on every change.
 */
import type * as P from '@dither-chat/protocol';
import { RefusalError } from '@dither-chat/protocol/client';
import type { ZulipAdapter } from './adapter.ts';
import { narrowLink, RESOLVED } from './ids.ts';
import { mediaUrl } from './markdown.ts';
import { codeToChar, customOf, reactionOf } from './emoji.ts';
import type { ZStream, ZSub, ZUser } from './state.ts';

export function roleName(role: number | undefined): string {
  switch (role) {
    case 100:
      return 'Owner';
    case 200:
      return 'Administrator';
    case 300:
      return 'Moderator';
    case 600:
      return 'Guest';
    default:
      return 'Member';
  }
}

function rank(role: number | undefined): number {
  return role === 100 ? 100 : role === 200 ? 90 : role === 300 ? 50 : role === 600 ? -10 : 0;
}

const isAdmin = (a: ZulipAdapter) => a.st.role <= 200;
const ADMIN_ONLY = 'Only organization administrators can change this';

/** The system group a channel's posting permission names, as Zulip's role groups are named. */
function groupName(a: ZulipAdapter, setting: unknown): string | null {
  if (typeof setting === 'number') return a.st.groups.get(setting)?.name ?? null;
  return null;
}

/**
 * Zulip's "a large number" of subscribers for @all (its WILDCARD_MENTION_THRESHOLD): above it only
 * `can_mention_many_users_group` may write one.
 */
const WILDCARD_THRESHOLD = 15;

/** Whether someone is in a group-setting value: a group (and the groups nested in it), or a list of members and groups. */
export function inGroupSetting(a: ZulipAdapter, setting: ZulipAdapter['st']['canMentionMany'], uid: number): boolean {
  if (setting === null || setting === undefined) return true;
  const seen = new Set<number>();
  const inGroup = (id: number): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const g = a.st.groups.get(id);
    return !!g && (g.members.includes(uid) || (g.direct_subgroup_ids ?? []).some(inGroup));
  };
  if (typeof setting === 'number') return inGroup(setting);
  return (setting.direct_members ?? []).includes(uid) || (setting.direct_subgroups ?? []).some(inGroup);
}

function systemGroup(a: ZulipAdapter, name: string): number | null {
  for (const g of a.st.groups.values()) if (g.is_system_group && g.name === name) return g.id;
  return null;
}

/** Only admins may post: Zulip's "Who can post to this channel" set to administrators (or owners). */
function announceOnly(a: ZulipAdapter, s: ZStream): boolean | null {
  const n = groupName(a, s.can_send_message_group);
  if (n) return n === 'role:administrators' || n === 'role:owners';
  if (s.stream_post_policy !== undefined) return s.stream_post_policy === 2;
  return null;
}

/** Each account's channels' subscribers, kept 5 minutes. */
const subscriberCache = new WeakMap<ZulipAdapter, Map<number, { at: number; ids: number[] }>>();
const cacheOf = (a: ZulipAdapter) => subscriberCache.get(a) ?? subscriberCache.set(a, new Map()).get(a)!;
/** A channel's subscribers changed (an event, or someone added from here): read them again next time. */
export function forgetSubscribers(a: ZulipAdapter, stream: number) {
  cacheOf(a).delete(stream);
}
async function subscribersOf(a: ZulipAdapter, stream: number): Promise<number[]> {
  const subscribers = cacheOf(a);
  const c = subscribers.get(stream);
  if (c && Date.now() - c.at < 300_000) return c.ids;
  const r = await a.api.get(`/streams/${stream}/members`);
  const ids: number[] = r.subscribers ?? [];
  subscribers.set(stream, { at: Date.now(), ids });
  return ids;
}

function member(a: ZulipAdapter, id: number): P.AboutMember {
  a.ensureIdentity(id);
  const u = a.st.users.get(id);
  return { id: a.ids.user(id), role: roleName(u?.role), rank: rank(u?.role) };
}

const ROLES: P.AboutRole[] = [
  { id: 'owner', name: 'Owner', rank: 100 },
  { id: 'admin', name: 'Administrator', rank: 90 },
  { id: 'moderator', name: 'Moderator', rank: 50 },
  { id: 'member', name: 'Member', rank: 0 },
  { id: 'guest', name: 'Guest', rank: -10 },
];

export async function about(a: ZulipAdapter, target: P.AboutTarget): Promise<P.About> {
  const st = a.st;
  if (target.kind === 'space') {
    if (target.nativeId !== a.ids.space) {
      const fid = a.ids.folderId(target.nativeId);
      const f = fid !== null ? st.folders.get(fid) : undefined;
      if (!f) throw new RefusalError('Not a place on this Zulip server', 404);
      return { noun: 'folder', fields: { name: { value: f.name, canEdit: false, reason: 'Folders are changed in Zulip' }, topic: { value: f.description ?? '', canEdit: false } } };
    }
    const active = [...st.users.values()].filter((u) => u.is_active !== false && !u.is_bot);
    const me = st.users.get(st.self);
    return {
      noun: 'organization',
      fields: {
        name: { value: st.realm.name, canEdit: isAdmin(a), ...(isAdmin(a) ? {} : { reason: ADMIN_ONLY }) },
        topic: { value: st.realm.description, canEdit: isAdmin(a), ...(isAdmin(a) ? {} : { reason: ADMIN_ONLY }) },
      },
      members: { list: active.slice(0, 200).map((u) => member(a, u.user_id)), total: active.length, complete: active.length <= 200 },
      roles: ROLES.map((r) => ({ ...r, count: active.filter((u) => roleName(u.role) === r.name).length })),
      you: { role: roleName(me?.role ?? st.role), rank: rank(st.role) },
      facts: [
        { label: 'Server', value: `Zulip ${st.version}` },
        { label: 'Channels you are in', value: String(st.subs.size) },
      ],
      invite: { link: a.base, canCreate: false, derived: true, reason: 'Invitations are sent from Zulip' },
    };
  }
  const p = a.place(target.nativeId);
  if (p.kind === 'dm') {
    const others = p.users.filter((u) => u !== st.self);
    return {
      noun: others.length > 1 ? 'group conversation' : 'conversation',
      fields: {},
      members: { list: p.users.map((u) => member(a, u)), total: p.users.length, complete: true },
      adding: { can: false, reason: 'A Zulip group conversation keeps the people it started with', who: 'known', mode: 'add' },
      leaving: { can: false, reason: 'Zulip has no leaving a direct conversation' },
    };
  }
  const s = (st.subs.get(p.stream) ?? st.streams.get(p.stream)) as ZSub;
  if (p.kind === 'topic') {
    const conv = a.ids.topic(p.stream, p.topic);
    const name = a.topicName(st.topics.get(conv), a.topicOf(p));
    const ut = st.userTopics.get(st.topicKey(p.stream, a.topicOf(p)));
    const policy = ut?.visibility_policy ?? 0;
    const guest = st.role >= 600;
    return {
      noun: 'topic',
      fields: { name: { value: name, canEdit: !guest, ...(guest ? { reason: 'Guests cannot rename topics' } : { reason: 'Renaming moves every message in the topic' }) } },
      thread: { archived: name.startsWith(RESOLVED), locked: false, canArchive: !guest, canLock: false, reason: 'Archiving a topic marks it resolved (✔); it stays open to write in', joined: policy === 3, ...(policy === 3 ? { notify: 'all' as const } : {}), muted: policy === 1 },
      facts: [{ label: 'Channel', value: `#${s?.name ?? p.stream}` }],
      invite: { link: narrowLink(a.base, { stream: p.stream, streamName: s?.name, topic: a.topicOf(p) }), canCreate: false, derived: true },
    };
  }
  const ids = await subscribersOf(a, p.stream).catch(() => [] as number[]);
  const admin = isAdmin(a);
  const ao = announceOnly(a, s);
  const why = admin ? {} : { reason: 'Only channel and organization administrators can change this' };
  const facts: { label: string; value: string }[] = [];
  if (s.date_created) facts.push({ label: 'Created', value: new Date(s.date_created * 1000).toISOString().slice(0, 10) });
  if (s.is_web_public) facts.push({ label: 'Visibility', value: 'Web-public: anyone on the internet can read it' });
  if (s.is_archived) facts.push({ label: 'Archived', value: 'Nobody can post here any more' });
  return {
    noun: 'channel',
    fields: {
      name: { value: s.name, canEdit: admin, ...why },
      topic: { value: s.description ?? '', canEdit: admin, ...why },
      ...(ao !== null ? { announceOnly: { value: ao, canEdit: admin, ...why } } : {}),
      joinRule: { value: s.invite_only ? 'invite' : 'open', canEdit: admin, ...why },
      history: { value: s.history_public_to_subscribers === false ? 'joined' : 'shared', canEdit: admin, ...why },
    },
    members: { list: ids.slice(0, 500).map((u) => member(a, u)), total: ids.length, complete: ids.length <= 500 },
    adding: { can: !s.is_archived && st.role < 600, ...(st.role >= 600 ? { reason: 'Guests cannot add people to channels' } : {}), who: 'known', mode: 'add' },
    leaving: { can: st.subs.has(p.stream), ...(s.invite_only ? { warning: 'It is private: you need someone in it to add you back' } : {}) },
    facts,
    invite: { link: narrowLink(a.base, { stream: p.stream, streamName: s.name }), canCreate: false, derived: true, reason: 'People in the organization can open this link and subscribe' },
  };
}

export async function configure(a: ZulipAdapter, target: P.AboutTarget, change: P.AboutChange): Promise<P.About> {
  if (change.key === 'pin' || change.key === 'invite') throw new RefusalError(`Zulip has no ${change.key === 'pin' ? 'pinned messages' : 'invite links for a channel'}`, 400);
  if (target.kind === 'space') {
    if (target.nativeId !== a.ids.space) throw new RefusalError('Folders are changed in Zulip', 400);
    if (change.key === 'name') await a.api.patch('/realm', { name: change.value });
    else if (change.key === 'topic') await a.api.patch('/realm', { description: change.value });
    else throw new RefusalError(`Zulip has no ${change.key} for an organization`, 400);
    if (change.key === 'name') a.st.realm.name = change.value as string;
    if (change.key === 'topic') a.st.realm.description = change.value as string;
    a.link.emit({ t: 'space', space: a.orgFact() });
    return about(a, target);
  }
  const p = a.place(target.nativeId);
  if (p.kind === 'dm') throw new RefusalError('A Zulip direct conversation has no settings', 400);
  if (p.kind === 'topic') {
    if (change.key !== 'name') throw new RefusalError('A Zulip topic has only its name', 400);
    const next = String(change.value).trim();
    if (!next) throw new RefusalError('A topic needs a name', 400);
    const conv = a.ids.topic(p.stream, p.topic);
    const t = a.st.topics.get(conv);
    const r = t?.maxId ? { messages: [{ id: t.maxId }] } : await a.api.get('/messages', { anchor: 'newest', num_before: 1, num_after: 0, narrow: a.narrowOf(p) });
    const mid = r.messages?.[0]?.id;
    if (!mid) throw new RefusalError('That topic has no messages', 404);
    await a.api.patch(`/messages/${mid}`, { topic: next, propagate_mode: 'change_all', send_notification_to_old_thread: false, send_notification_to_new_thread: false });
    return about(a, { kind: 'conversation', nativeId: a.ids.topic(p.stream, next) });
  }
  const path = `/streams/${p.stream}`;
  switch (change.key) {
    case 'name':
      await a.api.patch(path, { new_name: change.value });
      break;
    case 'topic':
      await a.api.patch(path, { description: change.value });
      break;
    case 'joinRule':
      if (change.value !== 'open' && change.value !== 'invite') throw new RefusalError('A Zulip channel is public or private', 400);
      await a.api.patch(path, { is_private: change.value === 'invite' });
      break;
    case 'history':
      if (change.value !== 'shared' && change.value !== 'joined') throw new RefusalError('A Zulip channel shows new members its whole history, or none of it', 400);
      await a.api.patch(path, { history_public_to_subscribers: change.value === 'shared' });
      break;
    case 'announceOnly': {
      const g = systemGroup(a, change.value ? 'role:administrators' : 'role:everyone');
      if (g === null) throw new RefusalError('This server does not say its role groups', 400);
      await a.api.patch(path, { can_send_message_group: { new: g } });
      break;
    }
    default:
      throw new RefusalError(`Zulip has no ${change.key} for a channel`, 400);
  }
  // The stream event brings the change; say it now too, so the reply and the facts agree.
  const s = await a.api.get(path).catch(() => null);
  if (s?.stream) {
    a.st.putStream(s.stream);
    const sub = a.st.subs.get(p.stream);
    if (sub) {
      Object.assign(sub, s.stream);
      a.emitConv(a.channelFact(sub));
    }
  }
  return about(a, target);
}

// ---------------------------------------------------------------- people

/** Zulip's custom profile field types. */
const FIELD = { SHORT: 1, LONG: 2, SELECT: 3, DATE: 4, URL: 5, USER: 6, EXTERNAL: 7, PRONOUNS: 8 };

export async function profile(a: ZulipAdapter, who: string): Promise<P.PersonAbout> {
  const uid = a.userOf(who);
  const r = await a.api.get(`/users/${uid}`, { include_custom_profile_fields: true });
  const u: ZUser = r.user;
  a.st.putUser(u);
  a.ensureIdentity(uid);
  const fields = await customFields(a);
  const handle = a.handleOf(u);
  const out: P.PersonAbout = { displayName: u.full_name, ...(handle ? { handle } : {}), ...(u.avatar_url ? { avatar: mediaUrl(u.avatar_url, a.base) } : {}) };
  const facts: { label: string; value: string; people?: string[] }[] = [{ label: 'Role', value: u.is_bot ? 'Bot' : roleName(u.role) }];
  const links: { label: string; value: string; url?: string }[] = [];
  /** People a field or the bot's owner names: by name, with their ids so the app links them (identity facts first). */
  const people = (ids: number[]) => {
    for (const id of ids) a.ensureIdentity(id);
    return { value: ids.map((id) => a.st.users.get(id)?.full_name ?? `User ${id}`).join(', '), people: ids.filter((id) => a.st.users.has(id)).map((id) => a.ids.user(id)) };
  };
  for (const f of fields) {
    const v = u.profile_data?.[String(f.id)]?.value;
    if (!v) continue;
    if (f.type === FIELD.LONG && out.bio === undefined) out.bio = v;
    else if (f.type === FIELD.PRONOUNS) out.pronouns = v;
    else if (f.type === FIELD.URL) links.push({ label: f.name, value: v, url: v });
    else if (f.type === FIELD.EXTERNAL) {
      const url = externalUrl(fieldData(f), v);
      links.push({ label: f.name, value: v, ...(url ? { url } : {}) });
    } else if (f.type === FIELD.SELECT) facts.push({ label: f.name, value: fieldData(f)[v]?.text ?? v });
    else if (f.type === FIELD.USER) {
      let ids: number[] = [];
      try {
        ids = (JSON.parse(v) as unknown[]).filter((x): x is number => typeof x === 'number');
      } catch {
        // Not a list: said as it is.
      }
      const named = ids.length ? people(ids) : { value: v, people: [] };
      facts.push({ label: f.name, value: named.value, ...(named.people.length ? { people: named.people } : {}) });
    } else if (f.type === FIELD.DATE) facts.push({ label: f.name, value: dateText(v) });
    else facts.push({ label: f.name, value: v });
  }
  if (u.timezone) facts.push({ label: 'Time zone', value: u.timezone });
  if (u.date_joined) out.createdAt = Date.parse(u.date_joined);
  if (u.is_bot && u.bot_owner_id) {
    const owner = people([u.bot_owner_id]);
    facts.push({ label: 'Owner', value: owner.value, ...(owner.people.length ? { people: owner.people } : {}) });
  }
  if (u.is_active === false) facts.push({ label: 'Account', value: 'Deactivated' });
  // The organization, with their role first and the user groups they are in, as Zulip's profile lists them.
  out.mutualSpaces = [{ id: a.ids.space, roles: [{ name: roleName(u.role) }, ...groupsOf(a, uid).map((name) => ({ name }))], ...(u.date_joined ? { joinedAt: Date.parse(u.date_joined) } : {}) }];
  const s = a.st.status.get(uid);
  if (s?.status_text || s?.emoji_name) {
    const unicode = s.reaction_type === 'unicode_emoji' && s.emoji_code;
    // A custom emoji (the organization's, or Zulip's own) by name, with its picture.
    const pic = !unicode && s.emoji_name && s.emoji_code && (s.reaction_type === 'realm_emoji' || s.reaction_type === 'zulip_extra_emoji') ? customOf({ emoji_name: s.emoji_name, emoji_code: s.emoji_code, reaction_type: s.reaction_type }, a.emoji, a.base)?.url : undefined;
    out.status = {
      ...(s.status_text ? { text: s.status_text } : {}),
      ...(s.emoji_name ? { emoji: unicode ? codeToChar(unicode) : `:${s.emoji_name}:` } : {}),
      ...(pic ? { emojiUrl: pic } : {}),
    };
  }
  out.facts = facts;
  if (links.length) out.links = links;
  if (uid === a.st.self) {
    const editable: P.ProfileField[] = ['name', 'avatar', 'emoji'];
    if (fields.some((f) => f.type === FIELD.LONG)) editable.push('bio');
    if (fields.some((f) => f.type === FIELD.PRONOUNS)) editable.push('pronouns');
    out.editable = editable;
  }
  return out;
}

interface CustomField {
  id: number;
  name: string;
  type: number;
  field_data?: string;
  order?: number;
}
/** Each account's organization's profile fields, kept until a `custom_profile_fields` event says they changed. */
const fieldsCache = new WeakMap<ZulipAdapter, CustomField[]>();
export function forgetFields(a: ZulipAdapter) {
  fieldsCache.delete(a);
}
async function customFields(a: ZulipAdapter): Promise<CustomField[]> {
  const kept = fieldsCache.get(a);
  if (kept) return kept;
  const r = await a.api.get('/realm/profile_fields');
  const list: CustomField[] = (r.custom_fields ?? []).sort((x: CustomField, y: CustomField) => (x.order ?? 0) - (y.order ?? 0));
  fieldsCache.set(a, list);
  return list;
}

/** A custom field's settings (its choices, an external account's kind and link pattern), or nothing. */
function fieldData(f: CustomField): Record<string, any> {
  try {
    return JSON.parse(f.field_data || '{}') ?? {};
  } catch {
    return {};
  }
}

/** Where an external account field leads: the organization's own pattern, else Zulip's built-in kinds. */
const EXTERNAL: Record<string, string> = { github: 'https://github.com/%(username)s', twitter: 'https://x.com/%(username)s' };
export function externalUrl(data: Record<string, any>, value: string): string | undefined {
  const pattern = typeof data.url_pattern === 'string' && data.url_pattern ? data.url_pattern : EXTERNAL[data.subtype];
  if (!pattern || !pattern.includes('%(username)s')) return undefined;
  const url = pattern.replaceAll('%(username)s', encodeURIComponent(value));
  return /^https?:\/\//.test(url) ? url : undefined;
}

/** A date field's `2024-03-05` as words ("March 5, 2024"); anything else as it is. */
export function dateText(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

/** The user groups someone is in directly, by name: not the system ones (role:…), which their role says. */
export function groupsOf(a: ZulipAdapter, uid: number): string[] {
  return [...a.st.groups.values()]
    .filter((g) => !g.is_system_group && !g.deactivated && !g.name.startsWith('role:') && g.members?.includes(uid))
    .map((g) => g.name)
    .sort((x, y) => x.localeCompare(y));
}

export async function setProfile(a: ZulipAdapter, change: P.ProfileChange): Promise<P.PersonAbout> {
  if (change.username !== undefined || change.banner !== undefined || change.accent !== undefined) throw new RefusalError('Zulip has no username, banner or profile colour', 400);
  if (change.name !== undefined) await a.api.patch('/settings', { full_name: change.name });
  if (change.avatar === null) await a.api.del('/users/me/avatar');
  else if (change.avatar) {
    const form = new FormData();
    form.append('file', Bun.file(change.avatar.path), change.avatar.name);
    await a.api.call('POST', '/users/me/avatar', undefined, { form });
  }
  if (change.emoji !== undefined) {
    const r = change.emoji ? reactionOf(change.emoji, a.emoji) : null;
    await a.api.post('/users/me/status', r ? r : { emoji_name: '' });
  }
  const fields = await customFields(a);
  const data: { id: number; value: string | null }[] = [];
  if (change.bio !== undefined) {
    const f = fields.find((x) => x.type === FIELD.LONG);
    if (!f) throw new RefusalError('This organization has no field for a bio', 400);
    data.push({ id: f.id, value: change.bio || null });
  }
  if (change.pronouns !== undefined) {
    const f = fields.find((x) => x.type === FIELD.PRONOUNS);
    if (!f) throw new RefusalError('This organization has no field for pronouns', 400);
    data.push({ id: f.id, value: change.pronouns || null });
  }
  const set = data.filter((d) => d.value !== null);
  const clear = data.filter((d) => d.value === null).map((d) => d.id);
  if (set.length) await a.api.patch('/users/me/profile_data', { data: set });
  if (clear.length) await a.api.del('/users/me/profile_data', { data: clear });
  // As it now stands: read back rather than waiting for the events that say so.
  const self = a.st.self;
  const me = await a.api.get(`/users/${self}`, { include_custom_profile_fields: true });
  if (me.user) a.st.putUser(me.user);
  if (change.emoji !== undefined) {
    const st = await a.api.get(`/users/${self}/status`).catch(() => null);
    if (st?.status) a.st.status.set(self, st.status);
  }
  return profile(a, a.ids.user(self));
}

// ---------------------------------------------------------------- @ picker

export async function mentionables(a: ZulipAdapter, conv: string, query: string, limit: number): Promise<P.Mentionables> {
  const p = a.place(conv);
  const q = query.trim().toLowerCase();
  const pool = p.kind === 'dm' ? p.users : await subscribersOf(a, p.stream).catch(() => [...a.st.users.keys()]);
  const match = (u: ZUser) => !q || u.full_name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || u.full_name.toLowerCase().startsWith(q) || !!a.handleOf(u)?.toLowerCase().startsWith(q);
  const people: P.MentionablePerson[] = [];
  for (const id of pool) {
    const u = a.st.users.get(id);
    if (!u || u.is_active === false || id === a.st.self || !match(u)) continue;
    a.ensureIdentity(id);
    const handle = a.handleOf(u);
    people.push({ nativeId: a.ids.user(id), name: u.full_name, ...(handle ? { handle } : {}), ...(u.avatar_url ? { avatar: mediaUrl(u.avatar_url, a.base) } : {}), ...(u.is_bot ? { isBot: true } : {}) });
    if (people.length >= limit) break;
  }
  const roles: P.MentionableRole[] = [...a.st.groups.values()]
    .filter((g) => !g.is_system_group && !g.deactivated && (!q || g.name.toLowerCase().startsWith(q)))
    .slice(0, 10)
    .map((g) => ({ id: `${a.ids.host}/g/${g.id}`, name: g.name, count: g.members.length }));
  // @all and @topic: in a channel, where it is small or you may use them in big ones (Zulip refuses them otherwise).
  const everyone = p.kind !== 'dm' && (pool.length <= WILDCARD_THRESHOLD || inGroupSetting(a, a.st.canMentionMany, a.st.self));
  return { people, roles, everyone };
}

// ---------------------------------------------------------------- joining

/** A channel from a narrow link (`…/#narrow/channel/12-design`), `#design`, or its name. */
function channelRef(a: ZulipAdapter, address: string): { id?: number; name?: string } {
  const s = address.trim();
  const m = s.match(/#narrow\/(?:channel|stream)\/(\d+)(?:-[^/]*)?/);
  if (m) {
    try {
      const u = new URL(s);
      if (u.host !== a.ids.host) throw new RefusalError(`That link is to ${u.host}, not this organization`, 400);
    } catch (e) {
      if (e instanceof RefusalError) throw e;
    }
    return { id: Number(m[1]) };
  }
  return { name: s.replace(/^#\*{0,2}/, '').replace(/\*{2}$/, '') };
}

async function streamOf(a: ZulipAdapter, ref: { id?: number; name?: string }): Promise<ZStream> {
  let id = ref.id ?? (ref.name ? a.st.streamByName(ref.name) : undefined);
  if (id === undefined && ref.name) id = (await a.api.get('/get_stream_id', { stream: ref.name }).catch(() => null))?.stream_id;
  if (id === undefined) throw new RefusalError('No channel by that name here, or it is private', 404);
  const r = await a.api.get(`/streams/${id}`).catch(() => null);
  if (!r?.stream) throw new RefusalError('No such channel, or it is private', 404);
  a.st.putStream(r.stream);
  return r.stream;
}

export async function resolve(a: ZulipAdapter, ref: P.AddRef): Promise<P.AddPreview> {
  if (ref.kind === 'person' || (ref.kind === 'name' && ref.name.includes('@'))) {
    const handle = ref.kind === 'person' ? ref.handle : ref.name;
    const uid = a.userOf(handle);
    const u = a.st.users.get(uid)!;
    a.ensureIdentity(uid);
    return { what: 'person', name: u.full_name, nativeId: a.ids.user(uid), ...(u.avatar_url ? { avatar: mediaUrl(u.avatar_url, a.base) } : {}), actions: ['message'], relationship: 'contact' };
  }
  if (ref.kind === 'invite') throw new RefusalError('A Zulip invitation makes a new account in an organization: open it in a browser', 400);
  const s = await streamOf(a, channelRef(a, ref.kind === 'place' ? ref.address : ref.name));
  const joined = a.st.subs.has(s.stream_id);
  const notes: string[] = [];
  if (s.invite_only && !joined) notes.push('It is private: someone in it has to add you');
  if (s.is_archived) notes.push('It is archived: nobody can post there');
  return {
    what: 'channel',
    name: s.name,
    nativeId: a.ids.channel(s.stream_id),
    ...(s.description ? { description: s.description } : {}),
    ...(s.subscriber_count !== undefined ? { members: s.subscriber_count } : {}),
    ...(joined ? { joined: { conversation: a.ids.channel(s.stream_id), space: a.ids.space } } : {}),
    actions: joined || s.invite_only || s.is_archived ? [] : ['join'],
    ...(notes.length ? { notes } : {}),
  };
}

export async function add(a: ZulipAdapter, ref: P.AddRef, action: string): Promise<P.AddResult> {
  if (action !== 'join') throw new RefusalError('On Zulip you can join channels; everyone in the organization can be written to already', 400);
  if (ref.kind === 'person' || ref.kind === 'invite') throw new RefusalError('Not a channel', 400);
  const s = await streamOf(a, channelRef(a, ref.kind === 'place' ? ref.address : ref.name));
  if (!a.st.subs.has(s.stream_id)) {
    await a.api.post('/users/me/subscriptions', { subscriptions: [{ name: s.name }] });
    const sub: ZSub = { ...s, is_muted: false };
    a.st.subs.set(s.stream_id, sub);
    a.emitConv(a.channelFact(sub));
    await a.topicsAtStart([s.stream_id]).catch(() => {});
  }
  return { space: a.ids.space, conversation: a.ids.channel(s.stream_id) };
}
