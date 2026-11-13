/**
 * The dither-chat ontology: one vocabulary for Discord, Signal, Matrix and WhatsApp.
 *
 * Three independent axes describe every conversation:
 *   - where it sits socially    -> Shape   (direct, group, channel, thread, self)
 *   - how the network presents it -> Variant (text, announcement, forum, voice, ...)
 *   - who can see it            -> Vantage (which of your accounts observe it)
 *
 * Containment is a graph, not a tree: a Matrix room can belong to several
 * spaces, so space membership is an edge list (SpaceEdge) rather than a
 * parent pointer. Discord guilds and categories simply produce one edge each.
 *
 * Network objects (identities, spaces, conversations, messages) are keyed by
 * (network, nativeId) and deduplicated across accounts. Hub-only objects
 * (persons, folders, notification rules, triage) are never written back.
 */

export type Network = 'discord' | 'signal' | 'matrix' | 'whatsapp' | 'telegram' | 'gmessages' | 'messenger' | 'instagram' | 'x' | 'email' | 'calendar';
/**
 * The chat networks this hub offers. telegram, gmessages (Google Messages: SMS and RCS), messenger, instagram and x
 * (X's direct messages) run only in dither-accounts. `email` is a Network for people's addresses (identities) and the
 * tables below, but not a chat account kind: mail comes through dither-accounts' mail interface (docs/mail.md).
 * `calendar` is a calendar service beside the hub (dither-calendar, docs/calendar.md): its account brings the calendar's
 * own chats, and while one is on, the calendar's pane, plans and reminders are too.
 */
export const NETWORKS: readonly Network[] = ['discord', 'signal', 'matrix', 'whatsapp', 'telegram', 'gmessages', 'messenger', 'instagram', 'x', 'calendar'];

/** Where a conversation sits in the social structure, independent of network. */
export type Shape =
  | 'direct' //  you and one other person: Discord DM, Signal 1:1, Matrix DM room
  | 'group' //   small, invite-defined, no parent community: Discord group DM, Signal group, Matrix room outside any space
  | 'channel' // lives inside a community: Discord guild channel, Matrix room in a space
  | 'thread' //  hangs off a parent conversation: Discord thread / forum post, Matrix m.thread
  | 'self'; //   notes to self: Signal Note to Self, Matrix room with only you

/**
 * Network-flavoured presentation of a conversation. Purely cosmetic for routing, except `feed`: a network's
 * notifications about you (X's likes, reposts, replies, mentions, quotes and follows; feed.ts), read-only, shape
 * 'channel' with no space. Nothing is sent there: no message, read mark or typing.
 */
export type Variant = 'text' | 'announcement' | 'forum' | 'voice' | 'stage' | 'media' | 'rules' | 'feed';

/**
 * community: something you join and that has its own membership and moderation
 *            (Discord guild, Matrix space, including nested subspaces).
 * section:   a purely visual grouping inside a community (Discord category).
 */
export type SpaceKind = 'community' | 'section';

export type AccountStatus = 'connecting' | 'online' | 'attention' | 'offline' | 'error' | 'disabled';

/** Why an account needs a human. Drives the "Needs you" cards. */
export type AttentionKind =
  | 'login' //           not logged in; open the live view and log in
  | 'captcha' //         a captcha is on screen in the sandbox, or (detail.captcha: CaptchaCheck) one to solve in a browser
  | 'verify' //          email / phone / "suspicious activity" challenge
  | 'link_device' //     Signal, WhatsApp: scan the QR code with your phone
  | 'selector_broken' // the client changed and a hook no longer resolves
  | 'rate_limited'
  | 'unknown';

/**
 * A captcha the owner solves in their own browser (Signal's rate-limit challenge), in Attention.detail.captcha: open
 * `url`, solve it, copy the link "Open Signal" points at, and paste it; it goes to the adapter as the account action
 * `action` with { captcha }. Nothing solves it for them.
 */
export interface CaptchaCheck {
  url: string;
  action: string;
}

export interface Attention {
  kind: AttentionKind;
  message: string;
  since: number;
  /** A live view of the sandboxed client is available (VNC through the hub). */
  liveView?: boolean;
  /** A URI to render as a QR code (Signal device linking). */
  qr?: string;
  /** When the adapter replaces `qr` with a fresh code (ms since epoch). */
  qrRefreshAt?: number;
  detail?: unknown;
}

/**
 * A notification rule you set on a place or a person (docs/notifications.md). No rule is Automatic: the tiers decide.
 * `all` always alerts, `digest` keeps a place to the list (never a conversation row or an alert), `none` mutes it.
 * `mentions` is only what a network's own setting can say of a place ("it notifies mentions here"); `smart` and a
 * rule of `mentions` are from before the tiers, and the hub neither stores nor reads them.
 */
export type NotifyLevel =
  | 'all' //      Always alert
  | 'mentions' // not a rule: a network's own setting, "notifies only mentions here"
  | 'smart' //    gone: read as no rule
  | 'digest' //   List only
  | 'none'; //    Mute: no notification, no list, unread badge only

/** The levels a rule can be set to, and what the app calls them. */
export const RULE_LEVELS = ['all', 'digest', 'none'] as const;
export type RuleLevel = (typeof RULE_LEVELS)[number];
export const RULE_LABEL: Record<RuleLevel, string> = { all: 'Always alert', digest: 'List only', none: 'Mute' };

export type NotifyScope = 'global' | 'network' | 'account' | 'space' | 'conversation' | 'person' | 'keyword';

/**
 * The tier a message lands in (docs/notifications.md). The stored codes are those of the four levels the tiers
 * replaced, so old rows and an app that was not updated read on:
 *  - 'push'   Alert: the phone sounds, the desktop shows a notification. Urgent only.
 *  - 'quiet'  Conversation: people talking with you. A silent row of its own on the phone, nothing on the desktop.
 *  - 'digest' List: important enough for the phone's ranked list (importance at or above your level), silent.
 *  - 'drop'   below the list: unread in its chat, nowhere else.
 *  - 'silent' muted places, held requests: nowhere but the unread badge, and never marked.
 */
export type TriageDecision = 'push' | 'quiet' | 'digest' | 'drop' | 'silent';

/** The four tiers a decided message can be in. */
export type NotifyTier = 'push' | 'quiet' | 'digest' | 'drop';
export const TIER_LABEL: Record<NotifyTier, string> = { push: 'Alert', quiet: 'Conversation', digest: 'List', drop: 'Below the list' };

export type MessageKind = 'text' | 'media' | 'system' | 'sticker' | 'call' | 'encrypted';

/**
 * Reactions, one vocabulary for all networks (docs/reactions.md).
 *
 * A reaction is a key and a style. The key is a Unicode emoji in canonical form, free text where a
 * network allows it, or an opaque native id for a custom emoji (Discord "name:id", Matrix mxc://),
 * which is described by a catalog entry. The style is 'super' for Discord's burst reactions and
 * 'normal' for everything else; a person can do both on one key, so they count separately.
 */
export type ReactionStyle = 'normal' | 'super';

/** What a network allows anywhere. What is available in one place comes from ReactionContext. */
export interface ReactionRules {
  /** One reaction per person per message: a new one replaces the old. */
  exclusive: boolean;
  /** Any text works as a reaction, not just emoji. */
  freeText: boolean;
  /** Most distinct reactions a message can hold. */
  maxDistinct?: number;
}

export const REACTION_RULES: Record<Network, ReactionRules> = {
  discord: { exclusive: false, freeText: false, maxDistinct: 20 },
  signal: { exclusive: true, freeText: false },
  matrix: { exclusive: false, freeText: true },
  whatsapp: { exclusive: true, freeText: false },
  // One reaction each without Premium.
  telegram: { exclusive: true, freeText: false },
  // RCS reactions; SMS has none.
  gmessages: { exclusive: true, freeText: false },
  // One reaction each, any emoji.
  messenger: { exclusive: true, freeText: false },
  instagram: { exclusive: true, freeText: false },
  // XChat keeps a set per person (its reaction table's key includes the emoji); any emoji.
  x: { exclusive: false, freeText: false },
  // Mail has no reactions.
  email: { exclusive: true, freeText: false, maxDistinct: 0 },
  // The calendar's chats have none either.
  calendar: { exclusive: true, freeText: false, maxDistinct: 0 },
};

export function discordEmojiUrl(id: string, animated?: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.webp?size=64${animated ? '&animated=true' : ''}`;
}

/**
 * The same emoji reaches us with and without variation selectors (Element adds U+FE0F to everything,
 * others send a bare heart that renders as text). Fully qualified form, so they count as one reaction.
 */
export function canonicalReactionKey(key: string): string {
  if (/^[\x00-\x7F]*$/.test(key)) return key; // "+1", "name:id", "mxc://..."
  const chars = [...key.replace(/\uFE0F/g, '')];
  return chars
    .map((c, i) => {
      const next = chars[i + 1] ?? '';
      const textByDefault = /^\p{Emoji}$/u.test(c) && !/^\p{Emoji_Presentation}$/u.test(c);
      if (!textByDefault || /^\p{Emoji_Modifier}$/u.test(next)) return c;
      return /^[0-9#*]$/.test(c) && next !== '\u20E3' ? c : c + '\uFE0F';
    })
    .join('');
}
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

export function attachmentKind(mime: string): AttachmentKind {
  const top = mime.split('/')[0];
  return top === 'image' || top === 'video' || top === 'audio' ? top : 'file';
}

/**
 * Whether the hub lets a browser show this type from its own origin: images other than SVG, video, audio, PDF and
 * plain text. Anything else (HTML, SVG, XML, scripts, a type it doesn't know) could run as a page there, so the hub
 * serves it as a download.
 */
export function showsInline(mime: string | null | undefined): boolean {
  const t = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (/xml|svg|html/.test(t)) return false;
  return /^(image|video|audio)\/[\w.+-]+$/.test(t) || t === 'application/pdf' || t === 'text/plain';
}

/**
 * The most the hub takes in one file, in bytes. Uploads go to disk, but adapters still read a file whole to send it
 * (Discord's as base64), so this stays where every network's limit below is.
 */
export const MAX_UPLOAD = 25 * 1024 * 1024;
/** The largest piece of an upload in one request: small enough that a dropped connection on a phone loses little. */
export const UPLOAD_CHUNK = 2 * 1024 * 1024;
/** What each network takes, as far as we can tell without asking. Discord's is the limit without Nitro. */
export const ATTACHMENT_LIMITS: Record<Network, { bytes: number; files: number }> = {
  discord: { bytes: 10 * 1024 * 1024, files: 10 },
  signal: { bytes: MAX_UPLOAD, files: 10 },
  matrix: { bytes: MAX_UPLOAD - 1024 * 1024, files: 10 },
  whatsapp: { bytes: MAX_UPLOAD, files: 10 },
  telegram: { bytes: MAX_UPLOAD, files: 10 },
  // RCS takes large files; a carrier's MMS fallback may not.
  gmessages: { bytes: MAX_UPLOAD, files: 10 },
  messenger: { bytes: MAX_UPLOAD, files: 10 },
  instagram: { bytes: MAX_UPLOAD, files: 10 },
  // A direct message carries one photo, GIF or video.
  x: { bytes: MAX_UPLOAD, files: 1 },
  // dither-accounts' mail.attachment and OutgoingFile: 25 MB a file.
  email: { bytes: MAX_UPLOAD, files: 20 },
  // Words only.
  calendar: { bytes: 0, files: 0 },
};

/** Brand colours used to annotate the source of every object in the UI. */
export const NETWORK_META: Record<Network, { name: string; color: string; spaceNoun: string; sectionNoun: string }> = {
  discord: { name: 'Discord', color: '#5865F2', spaceNoun: 'server', sectionNoun: 'category' },
  signal: { name: 'Signal', color: '#3A91F5', spaceNoun: 'group', sectionNoun: 'section' },
  matrix: { name: 'Matrix', color: '#0DBD8B', spaceNoun: 'space', sectionNoun: 'subspace' },
  whatsapp: { name: 'WhatsApp', color: '#1DAA61', spaceNoun: 'community', sectionNoun: 'section' },
  telegram: { name: 'Telegram', color: '#2AABEE', spaceNoun: 'group', sectionNoun: 'folder' },
  gmessages: { name: 'Google Messages', color: '#1A73E8', spaceNoun: 'group', sectionNoun: 'section' },
  messenger: { name: 'Messenger', color: '#0866FF', spaceNoun: 'group', sectionNoun: 'section' },
  instagram: { name: 'Instagram', color: '#FF0069', spaceNoun: 'group', sectionNoun: 'section' },
  x: { name: 'X', color: '#000000', spaceNoun: 'group', sectionNoun: 'section' },
  email: { name: 'Email', color: '#5B7083', spaceNoun: 'mailbox', sectionNoun: 'folder' },
  calendar: { name: 'Calendar', color: '#7E57C2', spaceNoun: 'calendar', sectionNoun: 'section' },
};
