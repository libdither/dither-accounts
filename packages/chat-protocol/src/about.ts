/**
 * About and settings, one shape for every network (docs/group-settings.md).
 *
 * A conversation or space has an About: its settings, each with whether *this account* may change it and why not,
 * who is in it and with what role, who may do what there, its invite link and its pinned messages. The adapter
 * answers `about` with an About in native ids; the hub turns it into an AboutView. `configure` changes one setting
 * and answers with the About as it now stands.
 *
 * What a network has at all, and the choices its own client offers, is in ABOUT_RULES, the way REACTION_RULES says
 * how reactions work there. What is allowed in one place comes from the adapter, as ReactionContext does.
 */
import type { MediaUrl } from './adapter.ts';
import type { PostFact } from './feed.ts';
import { NETWORK_META, type Network } from './ontology.ts';
import type { AboutLeaving, InviteLinkFact, InviteOptions } from './servers.ts';
import { PIN_DURATIONS } from './poll.ts';
import type { AboutOwnership, AboutThread } from './threads.ts';
import type { AboutLabel, AboutModeration, MemberMod } from './moderation.ts';

/** Who may do something, as far as the networks agree. */
export type Who = 'everyone' | 'admins';

/**
 * How people get in. open: anyone who finds it or has the link. invite: only those invited. ask: they ask, a member
 * lets them in (Matrix knock). space: members of a containing space (Matrix restricted).
 */
export type JoinRule = 'open' | 'invite' | 'ask' | 'space';

/** Matrix: who can read the history. */
export type HistoryVisibility = 'world_readable' | 'shared' | 'invited' | 'joined';

/** Every setting, with the type of its value. A network has the ones its ABOUT_RULES lists. */
export interface AboutValues {
  name: string;
  /** Topic or description. */
  topic: string;
  avatar: MediaUrl;
  /** Messages disappear this many seconds after they are sent (Signal: after they are read). 0: off. */
  disappearing: number;
  /** Seconds a member waits between messages (Discord). 0: off. */
  slowMode: number;
  /** Age-restricted (Discord NSFW). */
  nsfw: boolean;
  /** Only admins can send. */
  announceOnly: boolean;
  /** Who can change the name, topic and picture. */
  editInfo: Who;
  /** Who can add people. */
  addMembers: Who;
  /** Someone with the invite link still needs an admin to let them in. */
  joinApproval: boolean;
  joinRule: JoinRule;
  history: HistoryVisibility;
  /** End-to-end encrypted. On Matrix it can be turned on, never off. */
  encrypted: boolean;
  /** Minutes of no activity before a new thread hides itself (Discord's default auto-archive): 60, 1440, 4320, 10080. */
  autoArchive: number;
  /** How many may be in a voice channel at once (Discord). 0: no limit. */
  userLimit: number;
  /** A voice channel's audio quality, bits a second (Discord). */
  bitrate: number;
}

export type AboutKey = keyof AboutValues;

export const ABOUT_KEYS: readonly AboutKey[] = ['name', 'topic', 'avatar', 'disappearing', 'slowMode', 'nsfw', 'announceOnly', 'editInfo', 'addMembers', 'joinApproval', 'joinRule', 'history', 'encrypted', 'autoArchive', 'userLimit', 'bitrate'];

/** One setting: its value, and whether this account may change it. */
export interface AboutSetting<K extends AboutKey = AboutKey> {
  /** null: the network has it but did not say. */
  value: AboutValues[K] | null;
  canEdit: boolean;
  /** Why not, in words (shown on hover and under the setting). Also a limit worth knowing when canEdit is true. */
  reason?: string;
  /** The values this account may pick here, where they depend on the place (Discord's bitrate by the server's boosts). */
  options?: number[];
  /**
   * Only the change can be sent, not the value read back (Signal's join approval: signal-cli does not say whether it
   * is on). The panel offers it as a choice, with the reason saying why the current value is unknown.
   */
  writeOnly?: boolean;
}

export type AboutFields = { [K in AboutKey]?: AboutSetting<K> };

export interface AboutMember {
  /** Native identity id. The adapter emits identity facts for members first. */
  id: string;
  /** What the network calls their standing: "Admin", "Owner", "Moderator", the top Discord role. */
  role?: string;
  /** Power, to sort by: 100 for admins and owners, 50 for moderators, 0 for members. Matrix: the power level. */
  rank?: number;
  /** CSS colour of their role (Discord). */
  color?: string;
  /** Their member label in a group (Signal), a few words and an emoji. */
  label?: { text?: string; emoji?: string };
  /** How this account stands to them, for moderating (capability 'moderate', moderation.ts). */
  mod?: MemberMod;
}

export interface AboutRole {
  id: string;
  name: string;
  color?: string;
  rank: number;
  /** Members with it, when known. */
  count?: number;
}

/** "Who can do what", in words: one row per thing the network gates. */
export interface AboutRule {
  what: string;
  who: string;
  /** This account may. */
  you: boolean;
}

export interface AboutInvite {
  /** The link, when there is one and this account may see it. */
  link: string | null;
  /** Make one, or a new one in place of the old (which stops working). */
  canCreate: boolean;
  /** Turn the link off. */
  canRevoke?: boolean;
  reason?: string;
  /** A Matrix address (alias) or room id, which works as a link without anyone making one. */
  derived?: boolean;
  /** Every link the account may see, newest first (capability 'inviteLinks'); `link` is then the newest of them. */
  links?: InviteLinkFact[];
  /** The space's own short address, which never runs out (Discord's vanity URL). */
  vanity?: string;
  /** The expiry and use limits a new link may have, and the defaults (capability 'inviteLinks'). */
  options?: InviteOptions;
}

export interface AboutPinned {
  /** Native message ids, newest pin first. */
  messages: string[];
  canEdit: boolean;
  reason?: string;
  /**
   * The network's whole list, just read (Discord's pinned list). Absent: the network keeps none this account can read
   * (Signal), so the hub adds the pins it saw itself.
   */
  complete?: boolean;
}

/**
 * Whom the network lets this account add to a group. friends: only its friends (Discord group DMs). contacts: people
 * it has as contacts or a chat with. known: anyone the account knows (Signal, Matrix, Telegram); the network may still
 * refuse someone, as their privacy settings say.
 */
export type AddWho = 'friends' | 'contacts' | 'known';

/**
 * Adding people to a group (capability 'addMembers', the `addMembers` command): whether this account may here, and
 * how. What its own client offers as "Add members", "Add people" or "Invite".
 */
export interface AboutAdding {
  /** This account may add people here now. */
  can: boolean;
  /** Why not, in words. When it may, a limit worth knowing ("Only your friends", "Up to 10 people in all"). */
  reason?: string;
  who: AddWho;
  /** add: they are in at once. invite: they get an invite and are in once they accept (Matrix). */
  mode: 'add' | 'invite';
  /** How many more fit, when the network caps the group (Discord: 10 people in all). */
  room?: number;
}

/** What `addMembers` answers, in native ids. */
export interface AddMembersResult {
  /** In it now. */
  added: string[];
  /** Invited: in once they accept (Matrix; Signal when it does not have their profile yet). */
  invited?: string[];
  /** Refused by the network, each with its sentence ("Their privacy settings don't let you add them"). */
  failed?: { id: string; reason: string }[];
  /** The About as it now stands. */
  about?: About;
}

/** At most this many people in one `addMembers`: a few at a time, as a person would pick them. */
export const ADD_MEMBERS_MAX = 10;

/** What a network that has groups but no `addMembers` for this account says instead. */
export function addMembersNotBuilt(network: Network): string {
  if (network === 'whatsapp') return 'Adding people from here is left out on WhatsApp, which watches for it: share the invite link, or add them on your phone.';
  return `Adding people on ${NETWORK_META[network].name} isn't built for this account yet.`;
}

/** What making a group takes on one network (the `createGroup` command). */
export interface GroupRule {
  /** What the network calls it, lower case, for sentences: "group DM", "group", "room". */
  noun: string;
  /** Whom the account may put in it, as for adding people (AddWho). */
  who: AddWho;
  /** add: they are in at once. invite: they get an invite and are in once they accept (Matrix). */
  mode: 'add' | 'invite';
  name: 'required' | 'optional';
  nameMax: number;
  /** The fewest and the most other people at the start. */
  min: number;
  max: number;
}

/** The networks where a group can be made from here. WhatsApp is left out on purpose (createGroupNotBuilt). */
export const GROUP_RULES: Partial<Record<Network, GroupRule>> = {
  discord: { noun: 'group DM', who: 'friends', mode: 'add', name: 'optional', nameMax: 100, min: 2, max: 9 },
  signal: { noun: 'group', who: 'known', mode: 'add', name: 'required', nameMax: 32, min: 1, max: 10 },
  matrix: { noun: 'room', who: 'known', mode: 'invite', name: 'required', nameMax: 255, min: 1, max: 10 },
  telegram: { noun: 'group', who: 'known', mode: 'add', name: 'required', nameMax: 128, min: 1, max: 10 },
  // XChat (X's web client): New message → Create a group, people its search offers as addable, a name of up to 32.
  x: { noun: 'group', who: 'known', mode: 'add', name: 'optional', nameMax: 32, min: 1, max: 10 },
};

/** What `createGroup` answers, in native ids. */
export interface CreateGroupResult {
  /** The new conversation. */
  conversation: string;
  /** In it now. */
  added: string[];
  /** Invited: in once they accept (Matrix; Signal when it does not have their profile yet). */
  invited?: string[];
  /** Refused by the network, each with its sentence. */
  failed?: { id: string; reason: string }[];
  /** Anything the owner should know ("Telegram made it a basic group"). */
  notes?: string[];
}

/**
 * What is wrong with a new group before anything is asked of the network, in words; null when it may go. The name is
 * trimmed first, an empty optional name is no name, and its length is counted in characters (code points).
 */
export function createGroupProblem(network: Network, name: string | undefined, people: number): string | null {
  const r = GROUP_RULES[network];
  if (!r) return createGroupNotBuilt(network);
  const net = NETWORK_META[network].name;
  const what = `${/^[AEIOX]/.test(net) ? 'An' : 'A'} ${net} ${r.noun}`;
  const them = (n: number) => (r.who === 'friends' ? (n === 1 ? 'friend' : 'friends') : n === 1 ? 'person' : 'people');
  if (people < r.min) return `${what} starts with at least ${r.min} ${them(r.min)}`;
  if (people > r.max) return `${what} starts with at most ${r.max} ${them(r.max)}`;
  const n = (name ?? '').trim();
  if (!n) return r.name === 'required' ? `Give the ${r.noun} a name` : null;
  if ([...n].length > r.nameMax) return `${what}'s name is at most ${r.nameMax} characters`;
  return null;
}

/** What a network or account that cannot make a group says instead. */
export function createGroupNotBuilt(network: Network): string {
  if (network === 'whatsapp') return 'Making groups from here is left out on WhatsApp, which watches for it: make it on your phone and it shows up here.';
  return `Making groups on ${NETWORK_META[network].name} isn't built for this account yet.`;
}

/** What `about` answers, in native ids. */
export interface About {
  /** The network's word for it: "Group", "Server", "Room", "Channel", "Community". */
  noun?: string;
  fields: AboutFields;
  members?: {
    list: AboutMember[];
    /** How many there are; list may hold fewer (Discord servers load members lazily). */
    total?: number;
    complete: boolean;
  };
  /** Adding people here, for an adapter with 'addMembers'. Left out where nobody adds people (DMs, servers, channels). */
  adding?: AboutAdding;
  roles?: AboutRole[];
  rules?: AboutRule[];
  /** This account's own standing here. */
  you?: { role?: string; rank?: number };
  invite?: AboutInvite;
  pinned?: AboutPinned;
  /** Read-only details only some networks have: "Room version", "Verification level", "Created". */
  facts?: { label: string; value: string }[];
  /** Leaving it (capability 'leave', servers.ts). */
  leaving?: AboutLeaving;
  /** Your own nickname here (capability 'nick', the `setNick` command): value null for none. */
  nick?: { value: string | null; canEdit: boolean; reason?: string; max?: number };
  /** You blocked this group: nothing from it reaches you (capability 'block'; the `block` command changes it). */
  blocked?: boolean;
  /** A thread's archiving, locking and following (threads.ts). */
  thread?: AboutThread;
  /** A group with an owner: who, and whether this account may remove people or hand it over (threads.ts). */
  ownership?: AboutOwnership;
  /** What this account may do to its members (capability 'moderate', moderation.ts). */
  moderation?: AboutModeration;
  /** Your own member label here (Signal); `configure` with key 'label' changes it. */
  label?: AboutLabel;
}

export interface AboutTarget {
  kind: 'conversation' | 'space';
  nativeId: string;
}

/** One change. `invite` makes, replaces or turns off the invite link; `pin` pins or unpins a message. */
export type AboutChange =
  | { [K in AboutKey]: { key: K; value: AboutValues[K] } }[AboutKey]
  | { key: 'invite'; op: 'create' | 'revoke'; /** create: seconds, 0 never. */ maxAge?: number; /** create: 0 no limit. */ maxUses?: number; temporary?: boolean; /** revoke: which link, else the newest. */ code?: string }
  | { key: 'pin'; message: string; remove?: boolean; /** How long it stays pinned, one of poll.ts PIN_DURATIONS for the network (null: until unpinned); absent: its default. */ seconds?: number | null };

// ---------------------------------------------------------------- per network

export interface AboutRules {
  /** Settings this network has for conversations, in the order its own client shows them. */
  conversation: AboutKey[];
  /** And for spaces. */
  space: AboutKey[];
  /** The timers its own client offers, in seconds (0: off). */
  disappearing?: number[];
  /** Any timer works, not just the ones offered (Signal sets any number of seconds). */
  disappearingFree?: boolean;
  slowMode?: number[];
  /** Discord: thread auto-archive minutes, voice user limits and bitrates its own settings offer. */
  autoArchive?: number[];
  userLimit?: number[];
  bitrate?: number[];
  nameMax?: number;
  topicMax?: number;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

export const ABOUT_RULES: Record<Network, AboutRules> = {
  discord: {
    conversation: ['name', 'topic', 'avatar', 'slowMode', 'nsfw', 'announceOnly', 'autoArchive', 'userLimit', 'bitrate'],
    space: ['name', 'topic', 'avatar', 'nsfw'],
    slowMode: [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, HOUR, 2 * HOUR, 6 * HOUR],
    autoArchive: [60, 1440, 4320, 10080],
    userLimit: [0, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 50, 75, 99],
    bitrate: [8000, 16000, 24000, 32000, 48000, 64000, 80000, 96000, 128000, 256000, 384000],
    nameMax: 100,
    topicMax: 1024,
  },
  signal: {
    conversation: ['name', 'topic', 'avatar', 'disappearing', 'announceOnly', 'editInfo', 'addMembers', 'joinApproval', 'encrypted'],
    space: [],
    disappearing: [0, 30, 5 * 60, HOUR, 8 * HOUR, DAY, 7 * DAY, 28 * DAY],
    disappearingFree: true,
    nameMax: 32,
    topicMax: 480,
  },
  matrix: {
    conversation: ['name', 'topic', 'avatar', 'announceOnly', 'joinRule', 'history', 'encrypted'],
    space: ['name', 'topic', 'avatar', 'joinRule'],
    nameMax: 255,
  },
  whatsapp: {
    conversation: ['name', 'topic', 'avatar', 'disappearing', 'announceOnly', 'editInfo', 'addMembers', 'joinApproval', 'encrypted'],
    space: ['name', 'topic', 'avatar', 'addMembers', 'joinApproval'],
    disappearing: [0, DAY, 7 * DAY, 90 * DAY],
    nameMax: 100,
    topicMax: 2048,
  },
  telegram: {
    conversation: ['name', 'topic', 'avatar', 'slowMode', 'joinApproval'],
    space: ['name', 'topic', 'avatar'],
    slowMode: [0, 10, 30, 60, 5 * 60, 15 * 60, HOUR],
    nameMax: 128,
    topicMax: 255,
  },
  gmessages: {
    conversation: ['name'],
    space: [],
    nameMax: 100,
  },
  messenger: {
    conversation: ['name', 'avatar'],
    space: [],
  },
  instagram: {
    conversation: ['name', 'avatar'],
    space: [],
  },
  // XChat groups: a name of up to 32 characters, a picture and a description of up to 500 (X's web client).
  x: {
    conversation: ['name', 'avatar', 'topic'],
    space: [],
    nameMax: 32,
    topicMax: 500,
  },
  // Mail has no conversations or spaces to set anything on.
  email: {
    conversation: [],
    space: [],
  },
  // Nor have the calendar's chats.
  calendar: {
    conversation: [],
    space: [],
  },
  t3: {
    conversation: [],
    space: [],
  },
};

export const ABOUT_LABEL: Record<AboutKey, string> = {
  name: 'Name',
  topic: 'Description',
  avatar: 'Picture',
  disappearing: 'Disappearing messages',
  slowMode: 'Slow mode',
  nsfw: 'Age-restricted',
  announceOnly: 'Only admins can send',
  editInfo: 'Who can edit info',
  addMembers: 'Who can add members',
  joinApproval: 'Approve new members',
  joinRule: 'Who can join',
  history: 'Who can read history',
  encrypted: 'End-to-end encryption',
  autoArchive: 'Hide threads after inactivity',
  userLimit: 'User limit',
  bitrate: 'Bitrate',
};

/** "5 minutes", "1 day", "Off". */
export function durationLabel(seconds: number | null | undefined): string {
  if (!seconds) return 'Off';
  const units: [number, string][] = [
    [7 * DAY, 'week'],
    [DAY, 'day'],
    [HOUR, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [n, name] of units) {
    if (seconds % n === 0) {
      const k = seconds / n;
      return `${k} ${name}${k === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}

export const WHO_LABEL: Record<Who, string> = { everyone: 'All members', admins: 'Only admins' };
export const JOIN_RULE_LABEL: Record<JoinRule, string> = { open: 'Anyone', invite: 'Only invited people', ask: 'Anyone can ask to join', space: 'Members of its space' };
export const HISTORY_LABEL: Record<HistoryVisibility, string> = {
  world_readable: 'Anyone, without joining',
  shared: 'Members, all of it',
  invited: 'Members, since they were invited',
  joined: 'Members, since they joined',
};

/**
 * Is this change well formed for this network? The hub refuses anything else before asking the adapter, and checks
 * canEdit against a fresh About. Returns the reason, or null.
 */
export function aboutChangeProblem(network: Network, kind: AboutTarget['kind'], change: AboutChange): string | null {
  const rules = ABOUT_RULES[network];
  if (change.key === 'invite') return inviteChangeProblem(change);
  if (change.key === 'pin') {
    if (typeof change.message !== 'string' || !change.message) return 'which message?';
    if (change.seconds === undefined || change.remove) return null;
    return PIN_DURATIONS[network]?.includes(change.seconds) ? null : 'Not one of the pin durations this network offers';
  }
  if (!ABOUT_KEYS.includes(change.key)) return `unknown setting ${String(change.key)}`;
  if (!rules[kind].includes(change.key)) return `${ABOUT_LABEL[change.key]} is not a setting here`;
  const v = change.value as unknown;
  switch (change.key) {
    case 'name': {
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s) return 'a name cannot be empty';
      if (rules.nameMax && s.length > rules.nameMax) return `a name is at most ${rules.nameMax} characters here`;
      return null;
    }
    case 'topic':
      if (typeof v !== 'string') return 'a description is text';
      if (rules.topicMax && v.length > rules.topicMax) return `a description is at most ${rules.topicMax} characters here`;
      return null;
    case 'avatar':
      // A new picture: the hub hands the adapter the uploaded file as a file:// URL in its spool (moderation.ts PICTURE_TYPES).
      return typeof v === 'string' && v.startsWith('file://') ? null : 'which picture?';
    case 'disappearing':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return 'a timer is a whole number of seconds';
      if (!rules.disappearingFree && !rules.disappearing?.includes(v)) return `${durationLabel(v)} is not one of the timers offered here`;
      return null;
    case 'slowMode':
      return typeof v === 'number' && rules.slowMode?.includes(v) ? null : 'not one of the slow mode choices';
    case 'autoArchive':
      return typeof v === 'number' && rules.autoArchive?.includes(v) ? null : 'not one of the choices for hiding threads';
    case 'userLimit':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 99 ? null : 'a user limit is 0 (none) to 99';
    case 'bitrate':
      return typeof v === 'number' && rules.bitrate?.includes(v) ? null : 'not one of the bitrate choices';
    case 'editInfo':
    case 'addMembers':
      return v === 'everyone' || v === 'admins' ? null : 'everyone or admins';
    case 'joinRule':
      return v === 'open' || v === 'invite' || v === 'ask' || v === 'space' ? null : 'unknown join rule';
    case 'history':
      return v === 'world_readable' || v === 'shared' || v === 'invited' || v === 'joined' ? null : 'unknown history setting';
    case 'encrypted':
      return v === true ? null : 'encryption cannot be turned off';
    default:
      return typeof v === 'boolean' ? null : 'on or off';
  }
}

/** An invite change's shape: create with whole, non-negative limits, revoke with a code if any. */
function inviteChangeProblem(c: Extract<AboutChange, { key: 'invite' }>): string | null {
  if (c.op !== 'create' && c.op !== 'revoke') return 'unknown invite operation';
  const whole = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 0);
  if (!whole(c.maxAge) || !whole(c.maxUses)) return 'an expiry and a use limit are whole numbers';
  if (c.code !== undefined && (typeof c.code !== 'string' || !/^[\w-]{1,64}$/.test(c.code))) return 'which link?';
  return null;
}

// ---------------------------------------------------------------- people

/**
 * What a network says about one person (the `profile` command, docs/profile.md), in native ids. Only what the
 * network's own client shows when you open someone's profile, asked only when you open theirs.
 */
export interface PersonAbout {
  /** As the network has them now. The adapter also emits an identity fact with these. */
  displayName?: string;
  handle?: string;
  avatar?: MediaUrl;
  /** A banner picture (Discord). */
  banner?: MediaUrl;
  /** A CSS colour for the banner when there is no picture (Discord's accent colour). */
  accent?: string;
  /** Bio or About text, as the network has it (Discord markdown, WhatsApp About, Signal About). */
  bio?: string;
  /** A short status line with an emoji (Discord custom status, Signal's About emoji). */
  status?: { text?: string; emoji?: string };
  pronouns?: string;
  /** ms epoch: when their account was made (Discord, from the id). */
  createdAt?: number;
  /** Your standing with them on this network. */
  relationship?: PersonRelationship;
  /** Spaces you share, native ids, with their name and roles there. All of them, not only where they posted. */
  mutualSpaces?: { id: string; nick?: string; roles?: { name: string; color?: string }[]; joinedAt?: number }[];
  /** Friends you share: native identity ids (identity facts for them are emitted first). */
  mutualFriends?: string[];
  /** When the person is you: your friends or contacts on this network, native identity ids. */
  friends?: string[];
  /** Connected accounts, websites, a phone number. */
  links?: { label: string; value: string; url?: string; verified?: boolean }[];
  /** Anything else worth a line: "Business account", "Local time". */
  facts?: { label: string; value: string }[];
  /** Badges the network shows on their profile, by name, with the network's picture. */
  badges?: { name: string; icon?: MediaUrl }[];
  /** A frame drawn around their picture (Discord's avatar decoration). */
  decoration?: MediaUrl;
  /** Their profile's own colours, as CSS hex, top first (Discord's theme colours). */
  themeColors?: string[];
  /** Your safety number with them (capability 'safetyNumbers'). */
  safety?: SafetyNumber;
  /** When the person is you: what the `setProfile` command can change on this account. Absent: only the bio. */
  editable?: ProfileField[];
  /** When the person is you: your username and its link, where the network has them and one is set. */
  username?: { name: string; link?: string };
  /**
   * Their recent posts, newest first (X: up to 20 from their profile's Posts tab, reposts included, a pinned one
   * first with `pinned`). Only in an answer to `profile`, never in a `personAbout` event.
   */
  posts?: PostFact[];
  /** Follower and following counts and their posts in all, where the network shows them. */
  counts?: { followers?: number; following?: number; posts?: number };
  /** They follow you (X). */
  followsYou?: boolean;
}

/** What `setProfile` may change: the bio, the profile name, the emoji by the bio, the picture, the username, pronouns, the banner and its colour. */
export type ProfileField = 'bio' | 'name' | 'emoji' | 'avatar' | 'username' | 'pronouns' | 'banner' | 'accent';

/**
 * A safety number (Signal): the digits two people compare to know nobody sits between them, and what their phones
 * scan instead. `trust`: verified (you compared it and said so), unverified (trusted as first seen, Signal's default),
 * untrusted (it changed and is not accepted yet).
 */
export interface SafetyNumber {
  /** The digits, without spaces (Signal shows 60 in 12 groups of 5). */
  digits: string;
  /** What Signal's QR code holds, base64: shown as a QR code of those bytes, for their phone to scan. */
  scannable?: string;
  trust: 'verified' | 'unverified' | 'untrusted';
  /** ms epoch: when their key last changed, if it changed since this device first saw it. */
  changedAt?: number;
}

/**
 * How long your own bio may be on each network that lets you change it (capability 'editProfile'), in characters
 * as bioLength counts them. Matrix has no bio.
 */
export const BIO_LIMIT: Partial<Record<Network, number>> = { discord: 190, signal: 140, whatsapp: 139 };

/** A bio's length the way the limits count it: one per character, so an emoji is one. */
export const bioLength = (s: string) => [...s].length;

/** friend: accepted; requested: you asked them; requesting: they asked you; contact: in your address book. */
/** following: you follow them (X, Instagram). */
export type PersonRelationship = 'friend' | 'requested' | 'requesting' | 'blocked' | 'contact' | 'following' | 'stranger';

export const RELATIONSHIP_LABEL: Record<PersonRelationship, string> = {
  friend: 'Friend',
  requested: 'Friend request sent',
  requesting: 'Wants to be friends',
  blocked: 'Blocked',
  contact: 'In your contacts',
  following: 'You follow them',
  stranger: 'Not a contact',
};
