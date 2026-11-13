/**
 * Moderating a server (dither-chat's docs/moderation.md): who this account may kick, ban, time out and give roles to,
 * by the client's own permission and hierarchy checks as the hook read them (hook.js "moderation"), and the commands
 * that do it. Pure mapping, tested in test/moderation.test.ts; ModOps runs the commands on the adapter's write pace.
 * Everything fails closed: a power is offered only where the client said yes.
 *
 * Not built here, by decision (open Discord): the audit log, AutoMod rules, pruning, emoji, sticker and soundboard
 * management, integrations, moderator reports and raid actions. Role member lists are never read (member scraping).
 */
import { BAN_DELETE_CHOICES, modRefusal, TIMEOUT_DURATIONS } from '@dither-chat/protocol';
import type * as P from '@dither-chat/protocol';
import type { RawAbout, RawCan, RawUser } from './discord-types.ts';
import { CHANNEL_TYPE, isoToMs } from './map.ts';

export const MOD_ELSEWHERE = 'The audit log, AutoMod, pruning, emoji, stickers and soundboard, integrations, reports and raid actions: open Discord.';
const NEED: Record<'kickMembers' | 'banMembers' | 'moderateMembers' | 'manageRoles' | 'muteMembers' | 'deafenMembers' | 'moveMembers', string> = {
  kickMembers: 'You need the Kick Members permission.',
  banMembers: 'You need the Ban Members permission.',
  moderateMembers: 'You need the Timeout Members permission.',
  manageRoles: 'You need the Manage Roles permission.',
  muteMembers: 'You need the Mute Members permission.',
  deafenMembers: 'You need the Deafen Members permission.',
  moveMembers: 'You need the Move Members permission.',
};

/** A voice or stage channel: where someone in voice is moderated, from the call's own page. */
function voicePlace(raw: RawAbout): boolean {
  return !!raw.channel && (raw.channel.type === CHANNEL_TYPE.VOICE || raw.channel.type === CHANNEL_TYPE.STAGE);
}
const OUTRANKED = 'They have a role as high as yours, or own the server.';

/** Is this a place in a server (not a DM or group DM), whose members a moderator acts on? */
export function inServer(raw: RawAbout): boolean {
  return !!raw.guild && (!raw.channel || (raw.channel.type !== CHANNEL_TYPE.DM && raw.channel.type !== CHANNEL_TYPE.GROUP_DM));
}

/** The About with what this account may do to the server's members, and how it stands to each loaded one. */
export function withModeration(raw: RawAbout, about: P.About): P.About {
  if (!inServer(raw)) return about;
  const g = raw.guild!;
  const can: RawCan = raw.channel ? (raw.guildCan ?? {}) : raw.can;
  const self = raw.selfId ?? '';
  const owner = !!g.owner_id && g.owner_id === self;
  const power = (k: keyof typeof NEED, from: RawCan = can): P.ModPower => (from[k] === true ? { can: true } : { can: false, reason: NEED[k] });
  // Someone in voice is moderated by the permissions in the voice channel itself (its overwrites count).
  const voice = voicePlace(raw) ? { voiceMute: power('muteMembers', raw.can), voiceDeafen: power('deafenMembers', raw.can), voiceMove: power('moveMembers', raw.can) } : {};
  const top = owner ? Infinity : (raw.top_position ?? -1);
  const assignable = (raw.roles ?? []).filter((r) => r.id !== g.id && !r.managed && r.position < top).map((r) => r.id);
  const byId = new Map((raw.members ?? []).map((m) => [m.user.id, m]));
  const now = Date.now();
  const members = about.members && {
    ...about.members,
    list: about.members.list.map((m): P.AboutMember => {
      const r = byId.get(m.id);
      if (!r) return m;
      const mod: P.MemberMod = { roles: r.roles.filter((id) => id !== g.id) };
      if (m.id === self) Object.assign(mod, { above: true, reason: 'That is you.' });
      else if (g.owner_id === m.id) Object.assign(mod, { above: true, reason: 'They own the server.' });
      else if ((['kickMembers', 'banMembers', 'moderateMembers', 'manageRoles'] as const).some((k) => can[k] === true && r.manage?.[k] === false)) Object.assign(mod, { above: true, reason: OUTRANKED });
      const until = r.timeout_until ? isoToMs(r.timeout_until) : 0;
      if (until > now) mod.timedOutUntil = until;
      return { ...m, mod };
    }),
  };
  return {
    ...about,
    ...(members ? { members } : {}),
    moderation: {
      remove: power('kickMembers'),
      ban: { ...power('banMembers'), deleteHistory: BAN_DELETE_CHOICES },
      roles: { ...power('manageRoles'), assignable: can.manageRoles === true ? assignable : [] },
      timeout: { ...power('moderateMembers'), durations: TIMEOUT_DURATIONS },
      ...voice,
      bansOnRequest: true,
      elsewhere: MOD_ELSEWHERE,
    },
  };
}

/** What `moderate` asks the hook for: one action on one member of one server. */
export interface ModPlan {
  kind: 'moderate';
  guildId: string;
  userId: string;
  op: 'kick' | 'ban' | 'unban' | 'timeout' | 'role' | 'voiceMute' | 'voiceDeafen' | 'move' | 'disconnect';
  deleteSeconds?: number;
  seconds?: number;
  roleId?: string;
  remove?: boolean;
  /** voiceMute, voiceDeafen: on or off. */
  on?: boolean;
  /** move: the voice channel. */
  channelId?: string;
}

/** The hook command for an action, or an Error in words, checked against the About made from the same read. */
export function moderatePlan(raw: RawAbout, about: P.About, a: P.ModAction): ModPlan {
  if (!inServer(raw)) throw new Error('Only a server has members to moderate on Discord.');
  if (a.op === 'admin' || a.op === 'end') throw new Error('Discord servers have roles, not admins: give a role instead.');
  const member = about.members?.list.find((m) => m.id === a.who);
  const refusal = modRefusal(about.moderation, a, member?.mod, !!member);
  if (refusal) throw new Error(refusal);
  const base = { kind: 'moderate' as const, guildId: raw.guild!.id, userId: a.who };
  switch (a.op) {
    case 'remove':
      return { ...base, op: 'kick' };
    case 'ban':
      return { ...base, op: 'ban', deleteSeconds: a.deleteSeconds ?? 0 };
    case 'unban':
      return { ...base, op: 'unban' };
    case 'timeout':
      return { ...base, op: 'timeout', seconds: a.seconds };
    case 'role':
      return { ...base, op: 'role', roleId: a.role, ...(a.remove ? { remove: true } : {}) };
    case 'voiceMute':
    case 'voiceDeafen':
      return { ...base, op: a.op, on: a.on };
    case 'move':
      return { ...base, op: 'move', channelId: a.to };
    case 'disconnect':
      return { ...base, op: 'disconnect' };
  }
}

/** The hook's Bans list: identity facts for the users, and the result. */
export function bansOutcome(r: { bans?: { user: RawUser | null; reason: string | null }[]; more?: boolean } | null | undefined): { users: RawUser[]; result: P.BansResult } {
  const list = (r?.bans ?? []).filter((b): b is { user: RawUser; reason: string | null } => !!b?.user?.id);
  return { users: list.map((b) => b.user), result: { banned: list.map((b) => ({ id: b.user.id, ...(b.reason ? { reason: b.reason } : {}) })), ...(r?.more ? { more: true } : {}) } };
}

/** The hook command for clearing reactions, by the key the hub knows them by ("name:id" for custom emoji). */
export function clearPlan(conversation: string, message: string, c: P.ReactionClear) {
  return { kind: 'clearReactions' as const, channelId: conversation, messageId: message, ...(c.key ? { emoji: c.key } : {}), ...(c.who ? { userId: c.who } : {}) };
}
