/**
 * Moderating a group or server (docs/moderation.md): what an admin or moderator does to its members and to other
 * people's messages there. Removing (Discord: kicking), banning and unbanning, making admins (Signal), giving and
 * taking roles and timing out (Discord), ending a group (Signal), deleting someone else's message and clearing
 * reactions.
 *
 * Every one of them only where the network says this account may, from the owner's click on the hub's page, one at
 * a time, after a confirm in the app; nothing is batch. The adapter says what it may (About.moderation for members,
 * ReactionContext.moderation for messages) and refuses anything else itself too; the hub checks a fresh About first.
 *
 * Adapter side, capability 'moderate': the `moderate`, `bans` and `clearReactions` commands, and `redact` with
 * `moderator` for someone else's message. Join requests to a group you admin are requests (add.ts, kind 'join').
 */
import type { IdentityView } from './api.ts';
import type { Network } from './ontology.ts';

/** One power over members here: whether this account may use it, and why not in words. */
export interface ModPower {
  can: boolean;
  reason?: string;
}

/** What this account may do to the members of a group or server (About.moderation). Absent: nothing it may do. */
export interface AboutModeration {
  /** Take someone out (Signal: remove from the group; Discord: kick). They can come back with an invite. */
  remove?: ModPower;
  /** Ban them: out, and they cannot come back. `deleteHistory`: the choices of their recent messages to delete with the ban, seconds (Discord's dialog). */
  ban?: ModPower & { deleteHistory?: number[] };
  /** Make someone an admin or stop them being one (Signal). */
  admins?: ModPower;
  /** Give or take a role (Discord): the ones this account may hand out, below its own top role, by AboutRole id. */
  roles?: ModPower & { assignable: string[] };
  /** Time someone out (Discord): they cannot send, react, talk or join voice until it ends. The client's own choices, seconds. */
  timeout?: ModPower & { durations: number[] };
  /** End the group for everyone (Signal): nobody can send or change anything in it again. */
  end?: ModPower;
  /** Server mute or unmute someone in voice (Discord: Mute Members, in the voice channel). */
  voiceMute?: ModPower;
  /** Server deafen or undeafen someone in voice (Discord: Deafen Members). */
  voiceDeafen?: ModPower;
  /** Move someone in voice to another voice channel, or disconnect them (Discord: Move Members). */
  voiceMove?: ModPower;
  /** Who is banned, as native identity ids, when the network lists them without being asked (Signal). */
  banned?: string[];
  /** The banned list is read on a click, through the `bans` command (Discord). */
  bansOnRequest?: boolean;
  /** People asking to join, native identity ids; they are answered under Requests (kind 'join'). */
  requesting?: string[];
  /** What moderating here is left to the network's own app, in words ("Audit log, AutoMod, …: open Discord"). */
  elsewhere?: string;
}

/** How this account stands to one member, where it differs from the About's powers (AboutMember.mod). */
export interface MemberMod {
  /** This account cannot act on them: they outrank it, own the place, or are this account. */
  above?: boolean;
  reason?: string;
  /** Their roles by AboutRole id (Discord), to give or take one. */
  roles?: string[];
  /** ms epoch: timed out until then (Discord). */
  timedOutUntil?: number;
}

/** One moderating action. `who`: a native identity id (the hub's API takes hub identity ids instead). */
export type ModAction =
  | { op: 'remove'; who: string }
  | { op: 'ban'; who: string; /** Delete their messages from this many seconds back (Discord); 0 or absent: none. */ deleteSeconds?: number }
  | { op: 'unban'; who: string }
  | { op: 'admin'; who: string; remove?: true }
  | { op: 'role'; who: string; role: string; remove?: true }
  /** 0 ends a timeout. */
  | { op: 'timeout'; who: string; seconds: number }
  | { op: 'end' }
  /** Server mute (on) or unmute someone in voice. */
  | { op: 'voiceMute'; who: string; on: boolean }
  /** Server deafen (on) or undeafen someone in voice. */
  | { op: 'voiceDeafen'; who: string; on: boolean }
  /** Move someone in voice to another voice channel of the same server: `to` its native id (the hub's API takes a hub conversation id). */
  | { op: 'move'; who: string; to: string }
  /** Take someone out of voice. */
  | { op: 'disconnect'; who: string };

/** The actions on someone in voice: no rank above theirs is needed, only the permission (Discord's own member menu). */
export const VOICE_MOD_OPS: readonly ModOp[] = ['voiceMute', 'voiceDeafen', 'move', 'disconnect'];

export type ModOp = ModAction['op'];

/** What `bans` answers: the banned, newest first as the network lists them, with the reason given. */
export interface BansResult {
  banned: { id: string; reason?: string }[];
  /** The network has more than it gave. */
  more?: boolean;
}

/** What this account may do to others' messages here (ReactionContext.moderation). */
export interface MessageModeration {
  /** Delete someone else's message for everyone (Discord: Manage Messages; Signal: a group admin's delete). */
  delete: boolean;
  /** Remove others' reactions: all, one emoji's, one person's (Discord: Manage Messages). */
  reactions?: boolean;
}

/** Discord's timeout dialog: 60 seconds, 5 and 10 minutes, an hour, a day, a week (it allows up to 28 days). */
export const TIMEOUT_DURATIONS = [60, 300, 600, 3600, 86400, 7 * 86400];
export const TIMEOUT_MAX = 28 * 86400;
/** Discord's ban dialog: delete none of their messages, or the last hour, 6 or 12 hours, a day, 3 or 7 days. */
export const BAN_DELETE_CHOICES = [0, 3600, 6 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400];

const OPS: readonly ModOp[] = ['remove', 'ban', 'unban', 'admin', 'role', 'timeout', 'end', 'voiceMute', 'voiceDeafen', 'move', 'disconnect'];

/** The power an action needs, in About.moderation. */
export function modPowerOf(op: ModOp): keyof Pick<AboutModeration, 'remove' | 'ban' | 'admins' | 'roles' | 'timeout' | 'end' | 'voiceMute' | 'voiceDeafen' | 'voiceMove'> {
  if (op === 'move' || op === 'disconnect') return 'voiceMove';
  return op === 'unban' ? 'ban' : op === 'admin' ? 'admins' : op === 'role' ? 'roles' : op === 'end' ? 'end' : op;
}

/** Is this action well formed? The reason in words, or null. Who may do it is the About's to say. */
export function modActionProblem(a: unknown): string | null {
  if (!a || typeof a !== 'object') return 'what should happen?';
  const x = a as Record<string, unknown>;
  if (!OPS.includes(x.op as ModOp)) return 'unknown action';
  if (x.op === 'end') return null;
  if (typeof x.who !== 'string' || !x.who) return 'to whom?';
  if (x.op === 'ban' && x.deleteSeconds !== undefined && !BAN_DELETE_CHOICES.includes(x.deleteSeconds as number)) return 'not one of the choices for deleting their messages';
  if (x.op === 'role' && (typeof x.role !== 'string' || !x.role)) return 'which role?';
  if ((x.op === 'voiceMute' || x.op === 'voiceDeafen') && typeof x.on !== 'boolean') return 'on or off?';
  if (x.op === 'move' && (typeof x.to !== 'string' || !x.to)) return 'to which voice channel?';
  if (x.op === 'timeout') {
    const s = x.seconds;
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > TIMEOUT_MAX) return 'a timeout is a whole number of seconds, at most 28 days';
  }
  return null;
}

/**
 * Why this account may not take this action, by the About it just gave; null when it may. `member` is how it stands
 * to the person, from the same About.
 */
export function modRefusal(m: AboutModeration | undefined, a: ModAction, member?: MemberMod, isMember = true): string | null {
  const p = m?.[modPowerOf(a.op)] as ModPower | undefined;
  if (!p?.can) return p?.reason ?? 'You cannot do that here.';
  if (a.op === 'end') return null;
  if (a.op === 'unban') return null;
  // Someone in voice: whether they are in a voice channel now is the network's to say (the adapter checks it).
  if (VOICE_MOD_OPS.includes(a.op)) return null;
  if (!isMember && a.op !== 'ban') return 'They are not in it now.';
  if (member?.above) return member.reason ?? 'They outrank you here.';
  if (a.op === 'role') {
    if (!m?.roles?.assignable.includes(a.role)) return 'You cannot give or take that role: it is not below your own top role.';
    const has = member?.roles?.includes(a.role) ?? false;
    if (a.remove && !has) return 'They do not have that role.';
    if (!a.remove && has) return 'They have that role already.';
  }
  if (a.op === 'timeout' && a.seconds > 0 && m?.timeout?.durations && !m.timeout.durations.includes(a.seconds)) return 'not one of the timeout choices';
  return null;
}

/** What an action does, for a confirm and the hub's log: "Remove Ana from the group?" */
export function modVerb(network: Network, a: ModAction): string {
  switch (a.op) {
    case 'remove':
      return network === 'discord' ? 'Kick' : 'Remove';
    case 'ban':
      return 'Ban';
    case 'unban':
      return 'Unban';
    case 'admin':
      return a.remove ? 'Remove as admin' : 'Make admin';
    case 'role':
      return a.remove ? 'Take role' : 'Give role';
    case 'timeout':
      return a.seconds ? 'Time out' : 'End timeout';
    case 'end':
      return 'End the group';
    case 'voiceMute':
      return a.on ? 'Server mute' : 'Server unmute';
    case 'voiceDeafen':
      return a.on ? 'Server deafen' : 'Server undeafen';
    case 'move':
      return 'Move';
    case 'disconnect':
      return 'Disconnect';
  }
}

/** "an hour", "7 days", "60 seconds": for timeouts and how much history a ban deletes. */
export function spanLabel(seconds: number): string {
  if (!seconds) return 'none';
  if (seconds % 86400 === 0) return seconds === 86400 ? 'a day' : seconds === 7 * 86400 ? 'a week' : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? 'an hour' : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'a minute' : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

/** What `clearReactions` takes off a message: all reactions, one emoji's (`key`), or one person's (`key` and `who`). */
export interface ReactionClear {
  key?: string;
  /** Native identity id; needs `key`. */
  who?: string;
}

/** Is this clear well formed? */
export function reactionClearProblem(c: ReactionClear): string | null {
  if (c.who !== undefined && (typeof c.who !== 'string' || !c.who)) return 'whose reaction?';
  if (c.who !== undefined && !c.key) return 'which reaction of theirs?';
  if (c.key !== undefined && (typeof c.key !== 'string' || !c.key)) return 'which reaction?';
  return null;
}

/** The member label you show in a group (Signal), About.label: a few words and an emoji. */
export interface AboutLabel {
  value: string | null;
  emoji: string | null;
  canEdit: boolean;
  reason?: string;
  /** Characters. */
  max?: number;
}

/** A member label is a few words: the app keeps it to 24 characters (signal-cli does not say Signal's own limit; a longer one comes back as Signal's error). */
export const MEMBER_LABEL_MAX = 24;

/** What is wrong with a member label before anything is sent; null when it may go ('' clears it). */
export function memberLabelProblem(text: unknown, emoji: unknown, max = MEMBER_LABEL_MAX): string | null {
  if (typeof text !== 'string') return 'A label is text';
  if ([...text.trim()].length > max) return `A label is at most ${max} characters`;
  if (emoji !== undefined && emoji !== null && (typeof emoji !== 'string' || [...emoji].length > 8)) return 'One emoji';
  return null;
}

// ---------------------------------------------------------------- hub API

/** AboutView.moderation: About.moderation with hub identity ids. */
export interface AboutModerationView extends Omit<AboutModeration, 'banned' | 'requesting'> {
  banned?: string[];
  requesting?: string[];
}

/** POST /api/(conversations|spaces)/:id/moderate { action, accountId? }: `who` is a hub identity id. Answers the AboutView. */
export interface ModerateRequest {
  action: ModAction;
  accountId?: string;
}

/** GET /api/(conversations|spaces)/:id/bans: who is banned, as hub identity ids, with their identities. */
export interface BansView {
  accountId: string;
  banned: { identityId: string; reason?: string }[];
  more?: boolean;
  identities: IdentityView[];
}

/** POST /api/messages/:id/clear-reactions { key?, identityId? }: all, one emoji's, or one person's. */
export interface ClearReactionsRequest {
  key?: string;
  identityId?: string;
}

/** The pictures a group or server picture may be, as the app uploads them. */
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** At most this large: Discord takes a server icon up to 10 MB; Signal's own apps shrink a group picture first. */
export const PICTURE_MAX = 8 * 1024 * 1024;
