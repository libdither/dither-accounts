/**
 * The hook's raw about (read from the client's stores) -> a protocol About, and a setting change -> the one PATCH
 * that makes it. Pure functions, tested in test/about.test.ts. Wording follows the demo world's Discord answers
 * (hub/src/demo.ts) so the panel reads the same against either.
 *
 * Permissions fail closed: a setting is editable only when the client's own check said yes. When it could not
 * say (no PermissionStore, or the check threw), the setting is locked with UNSURE as the reason.
 */

import { ABOUT_LABEL, ADD_MEMBERS_MAX } from '@dither-chat/protocol';
import type * as P from '@dither-chat/protocol';
import type { RawAbout, RawAboutPatch, RawCan, RawRole, RawSeenMember, RawUser } from './discord-types.ts';
import { CHANNEL_TYPE, groupIconUrl, guildIconUrl, isThread, mapPrivateChannel, snowflakeToMs, userDisplayName } from './map.ts';

export const PICTURE = 'Changing the picture is not supported yet.';
export const UNSURE = 'Discord did not say whether you may.';
const NEED_CHANNELS = 'You need the Manage Channels permission.';
const NEED_GUILD = 'You need the Manage Server permission.';
const NEED_THREADS = 'You need the Manage Threads permission, or to have started the thread.';
const SEND_RULES = "Change who can send in the channel's permissions, in Discord.";

/** Discord holds at most this many people in a group DM, you included. */
export const GROUP_MAX = 10;
const ONLY_FRIENDS = `Only your friends, up to ${GROUP_MAX} people in all.`;
export const GROUP_FULL = `A Discord group holds at most ${GROUP_MAX} people.`;
export const NOT_GROUP = 'Discord adds people only to group DMs: a server has invites instead.';

const VERIFICATION = ['None', 'Low: a verified email', 'Medium: on Discord for 5 minutes', 'High: a member here for 10 minutes', 'Highest: a verified phone number'];

/** Whether the check said yes, and why not in words. */
function may(v: boolean | null | undefined, need: string): { ok: boolean; reason?: string } {
  if (v === true) return { ok: true };
  return { ok: false, reason: v === false ? need : UNSURE };
}

const day = (id: string) => {
  const ms = snowflakeToMs(id);
  return ms ? new Date(ms).toISOString().slice(0, 10) : null;
};

/** The users a raw about names, for identity facts ahead of the answer. */
export function aboutUsers(raw: RawAbout): RawUser[] {
  return [...(raw.members ?? []).map((m) => m.user), ...(raw.channel?.recipients ?? []), ...(raw.guild?.owner ? [raw.guild.owner] : [])];
}

/** The server's members the client had loaded, as seen members: role names, @everyone left out. */
export function aboutSeenMembers(raw: RawAbout): { guildId: string; members: RawSeenMember[]; total?: number } | null {
  const g = raw.guild;
  if (!g?.id) return null;
  const names = new Map((raw.roles ?? []).map((r) => [r.id, r.name]));
  const members = (raw.members ?? [])
    .filter((m) => m.user?.id)
    .map((m) => ({ user: m.user, ...(names.size ? { roles: m.roles.filter((id) => id !== g.id && names.has(id)).map((id) => names.get(id)!) } : {}) }));
  return { guildId: g.id, members, ...(typeof raw.memberCount === 'number' ? { total: raw.memberCount } : {}) };
}

/** A member's standing: their top hoisted role (as the member list groups them), else their top coloured one. */
function standing(roleIds: string[], byId: Map<string, RawRole>): RawRole | undefined {
  const mine = roleIds.map((id) => byId.get(id)).filter((r): r is RawRole => !!r).sort((a, b) => b.position - a.position);
  return mine.find((r) => r.hoist) ?? mine.find((r) => r.color);
}

export function mapAbout(raw: RawAbout): P.About {
  const fields: P.AboutFields = {};
  const set = <K extends P.AboutKey>(k: K, value: P.AboutValues[K] | null, check: { ok: boolean; reason?: string }) => {
    (fields as Record<string, P.AboutSetting>)[k] = { value: value as never, canEdit: check.ok, ...(check.reason && !check.ok ? { reason: check.reason } : {}) };
  };
  const no = (reason: string) => ({ ok: false, reason });
  const can: RawCan = raw.can ?? {};
  const guildCan: RawCan = raw.guildCan ?? (raw.channel ? {} : can);
  const self = raw.selfId ?? '';
  const c = raw.channel;
  const g = raw.guild;
  const facts: { label: string; value: string }[] = [];
  const rules: P.AboutRule[] = [];
  let noun = 'Server';
  let you: P.About['you'];
  let adding: P.AboutAdding | undefined;

  // Members and roles: the server's, as far as the client has loaded them.
  const roles = [...(raw.roles ?? [])].sort((a, b) => b.position - a.position);
  const byId = new Map(roles.map((r) => [r.id, r]));
  let members: P.About['members'];
  if (g) {
    const list: P.AboutMember[] = (raw.members ?? []).map((m) => {
      const r = standing(m.roles, byId);
      const color = m.color || r?.color || roles.find((x) => x.color && m.roles.includes(x.id))?.color;
      return { id: m.user.id, ...(r ? { role: r.name } : {}), rank: r?.position ?? 0, ...(color ? { color } : {}) };
    });
    list.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    const total = raw.memberCount ?? undefined;
    members = { list, ...(total !== undefined ? { total } : {}), complete: total !== undefined && list.length >= total };
    const mine = list.find((m) => m.id === self);
    const top = roles[0]?.position ?? 0;
    you = g.owner_id && g.owner_id === self ? { role: 'Owner', rank: top + 1 } : { role: mine?.role ?? 'Member', rank: mine?.rank ?? 0 };
  }

  if (!c && g) {
    // The server itself.
    set('name', g.name ?? '', may(guildCan.manageGuild, NEED_GUILD));
    set('topic', g.description ?? '', no(g.community ? 'Change the server description in Discord.' : 'Only Community servers have a description, set in Discord.'));
    set('avatar', guildIconUrl(g) ?? null, no(PICTURE));
    // 1 explicit, 3 age-restricted; Discord sets it.
    if (g.nsfw_level != null) set('nsfw', g.nsfw_level === 1 || g.nsfw_level === 3, no('Discord sets this for the server.'));
  } else if (c?.type === CHANNEL_TYPE.CATEGORY) {
    noun = 'Category';
    set('name', c.name ?? '', may(can.manageChannels, NEED_CHANNELS));
  } else if (c?.type === CHANNEL_TYPE.DM) {
    noun = 'Direct message';
  } else if (c?.type === CHANNEL_TYPE.GROUP_DM) {
    noun = 'Group';
    const owner = !!c.owner_id && c.owner_id === self;
    set('name', mapPrivateChannel(c, self).name ?? '', { ok: true });
    set('avatar', groupIconUrl(c) ?? null, no(PICTURE));
    rules.push({ what: 'Rename, change the icon, add people', who: 'Everyone in the group', you: true }, { what: 'Remove people', who: 'The group owner', you: owner });
    you = { role: owner ? 'Group owner' : 'Member', rank: owner ? 100 : 0 };
    // Anyone in the group adds their friends, while it has room.
    const n = 1 + (c.recipients ?? []).filter((r) => r.id !== self).length;
    adding = { can: n < GROUP_MAX, reason: n < GROUP_MAX ? ONLY_FRIENDS : GROUP_FULL, who: 'friends', mode: 'add', room: Math.max(0, GROUP_MAX - n) };
  } else if (c) {
    const thread = isThread(c.type);
    noun = thread ? 'Thread' : 'Channel';
    const edit = thread ? (c.owner_id && c.owner_id === self ? { ok: true } : may(can.manageThreads, NEED_THREADS)) : may(can.manageChannels, NEED_CHANNELS);
    set('name', c.name ?? '', edit);
    // Voice and stage channels have no topic of their own.
    if (!thread && c.type !== CHANNEL_TYPE.VOICE && c.type !== CHANNEL_TYPE.STAGE) set('topic', c.topic ?? '', edit);
    set('slowMode', c.rate_limit_per_user ?? 0, edit);
    if (!thread) set('nsfw', !!c.nsfw, edit);
    const manage = may(can.manageChannels, NEED_CHANNELS);
    set('announceOnly', !!c.everyone_denies_send, no(manage.ok ? SEND_RULES : manage.reason!));
  }

  if (c && g) {
    const thread = isThread(c.type);
    rules.push(
      thread
        ? { what: 'Rename the thread and set its slow mode', who: 'Manage Threads, or whoever started it', you: !!fields.name?.canEdit }
        : { what: 'Change the name, topic and slow mode', who: 'Manage Channels', you: can.manageChannels === true },
    );
  }
  if (g) {
    rules.push({ what: 'Change the server', who: 'Manage Server', you: guildCan.manageGuild === true });
    if (c && c.type !== CHANNEL_TYPE.CATEGORY) {
      rules.push(
        { what: 'Send messages', who: 'Send Messages', you: can.sendMessages === true },
        { what: 'Pin messages', who: 'Pin Messages', you: can.pinMessages === true || can.manageMessages === true },
      );
    }
    rules.push({ what: 'Manage roles', who: 'Manage Roles', you: can.manageRoles === true }, { what: 'Create invites', who: 'Create Instant Invite', you: can.createInvite === true });
  }

  // Details.
  if (!c && g) {
    const v = g.verification_level;
    if (v != null && VERIFICATION[v]) facts.push({ label: 'Verification level', value: VERIFICATION[v] });
    if (g.owner) facts.push({ label: 'Owner', value: userDisplayName(g.owner) });
  }
  if (c?.type === CHANNEL_TYPE.GROUP_DM && c.owner_id) {
    const o = c.owner_id === self ? null : c.recipients?.find((r) => r.id === c.owner_id);
    facts.push({ label: 'Owner', value: c.owner_id === self ? 'You' : o ? userDisplayName(o) : 'Someone who left' });
  }
  const created = day((c ?? g)?.id ?? '');
  if (created) facts.push({ label: 'Created', value: created });

  // DMs and groups: everyone in them, known in full.
  if (c && (c.type === CHANNEL_TYPE.DM || c.type === CHANNEL_TYPE.GROUP_DM)) {
    const ids = [self, ...(c.recipients ?? []).map((r) => r.id)].filter(Boolean);
    members = {
      list: ids.map((id) => (c.type === CHANNEL_TYPE.GROUP_DM && id === c.owner_id ? { id, role: 'Group owner', rank: 100 } : { id, rank: 0 })),
      complete: true,
    };
  }

  return {
    noun,
    fields,
    ...(members ? { members } : {}),
    ...(adding ? { adding } : {}),
    ...(g && roles.length ? { roles: roles.map((r) => ({ id: r.id, name: r.name, rank: r.position, ...(r.color ? { color: r.color } : {}) })) } : {}),
    ...(rules.length ? { rules } : {}),
    ...(you ? { you } : {}),
    ...(facts.length ? { facts } : {}),
  };
}

/** What `configure` asks the hook for: one PATCH of one channel or server. */
export interface ConfigurePlan {
  channelId?: string;
  guildId?: string;
  patch: RawAboutPatch;
}

/**
 * The PATCH for a change, or an Error in words. Checked against the About built from the same raw read, so a
 * setting this account may not change, or that the target does not have, is refused here too.
 */
export function configurePlan(raw: RawAbout, change: P.AboutChange): ConfigurePlan {
  switch (change.key) {
    case 'invite':
      throw new Error('Invite links are not supported on Discord yet.');
    case 'pin':
      throw new Error('Pinning is not supported on Discord yet.');
    case 'avatar':
      throw new Error(PICTURE);
    case 'announceOnly':
      throw new Error(SEND_RULES);
    case 'name':
    case 'topic':
    case 'slowMode':
    case 'nsfw':
      break;
    default:
      throw new Error(`${ABOUT_LABEL[change.key]} is not a Discord setting.`);
  }
  const field = mapAbout(raw).fields[change.key];
  if (!field) throw new Error(`This ${raw.channel ? 'conversation' : 'server'} has no such setting on Discord.`);
  if (!field.canEdit) throw new Error(field.reason ?? 'You may not change this.');
  const target = raw.channel ? { channelId: raw.channel.id } : { guildId: raw.guild!.id };
  switch (change.key) {
    case 'name': {
      const name = String(change.value ?? '').trim();
      if (!name) throw new Error('a name cannot be empty');
      return { ...target, patch: { name } };
    }
    case 'topic':
      return { ...target, patch: { topic: String(change.value ?? '') } };
    case 'slowMode': {
      const n = Number(change.value);
      if (!Number.isInteger(n) || n < 0 || n > 21600) throw new Error('not one of the slow mode choices');
      return { ...target, patch: { rate_limit_per_user: n } };
    }
    default:
      return { ...target, patch: { nsfw: change.value === true } };
  }
}

/** What `addMembers` asks the hook for: who, in which group. */
export interface AddPlan {
  channelId: string;
  userIds: string[];
}

/**
 * The people to add, or an Error in words. Checked against the About built from the same raw read: only a group DM,
 * only while it has room for all of them. Whether each one is a friend the hook checks, one by one.
 */
export function addPlan(raw: RawAbout, people: string[]): AddPlan {
  const c = raw.channel;
  if (!c || c.type !== CHANNEL_TYPE.GROUP_DM) throw new Error(NOT_GROUP);
  const adding = mapAbout(raw).adding!;
  if (!adding.can) throw new Error(adding.reason ?? GROUP_FULL);
  const userIds = [...new Set(people.map(String))];
  if (!userIds.length) throw new Error('Whom to add?');
  if (userIds.length > ADD_MEMBERS_MAX) throw new Error(`At most ${ADD_MEMBERS_MAX} people at a time.`);
  if (userIds.length > (adding.room ?? 0)) throw new Error(`Only ${adding.room} more fit in this group: Discord holds at most ${GROUP_MAX} people in one.`);
  return { channelId: c.id, userIds };
}

/** The raw about with these people in the group: the client's stores may not have caught up with the adding yet. */
export function withRecipients(raw: RawAbout, users: RawUser[]): RawAbout {
  const c = raw.channel;
  if (!c || c.type !== CHANNEL_TYPE.GROUP_DM) return raw;
  const have = new Set([raw.selfId, ...(c.recipients ?? []).map((r) => r.id)]);
  const more = users.filter((u) => u?.id && !have.has(u.id));
  return more.length ? { ...raw, channel: { ...c, recipients: [...(c.recipients ?? []), ...more] } } : raw;
}

/** The About after a change Discord accepted: the client's stores may not have caught up with the PATCH yet. */
export function withChange(about: P.About, change: P.AboutChange): P.About {
  if (change.key === 'invite' || change.key === 'pin') return about;
  const f = about.fields[change.key];
  if (!f) return about;
  const value = change.key === 'name' && typeof change.value === 'string' ? change.value.trim() : change.value;
  return { ...about, fields: { ...about.fields, [change.key]: { ...f, value } } };
}
