/**
 * Hub <-> client (PWA) API: view models served by /api/* and pushed over /api/live.
 * Every id here is a hub id; native ids are included for display and deep links only.
 */

import type { About, AboutFields, AddWho, GroupRule, PersonAbout, PersonRelationship } from './about.ts';
import type { AddAction, AddCheck, AddPreview, AddRef, LinkRelationship, RequestAnswer, RequestFact } from './add.ts';
import type { Capability, NativeMute, ReceiptState } from './adapter.ts';
import type {
  AccountStatus,
  AttachmentKind,
  Attention,
  MessageKind,
  Network,
  NotifyLevel,
  NotifyTier,
  NotifyScope,
  ReactionStyle,
  Shape,
  SpaceKind,
  TriageDecision,
  Variant,
} from './ontology.ts';
import type { ArrangeSettings, UsageKind, UsageView } from './usage.ts';
import type { FileInfo } from './files.ts';
import type { AboutModerationView, MemberMod, MessageModeration } from './moderation.ts';
import type { RichView, VoiceFact } from './rich.ts';
import type { PollView } from './poll.ts';
import type { MailAccess, MailAccountView, MailboxView, MailBootstrap, MailOutboxView, MailThreadView } from './mail.ts';
import type { CalendarLinkView, CalendarNotifyRef, CalendarPlanView } from './calendar.ts';
import type { AccountSelfView } from './self.ts';
import type { ContactCardView, MissingAttachmentFact, QuoteView, SendFailureView, StoryReplyView } from './extra.ts';
import type { ForumView, ThreadView } from './threads.ts';
import type { FeedItem, PostFact } from './feed.ts';
import type { NoticesBoot } from './notices.ts';

export interface AccountView {
  id: string;
  network: Network;
  label: string;
  color: string;
  status: AccountStatus;
  attention: Attention | null;
  selfIdentityId: string | null;
  capabilities: Capability[];
  liveView: boolean;
  demo: boolean;
  createdAt: number;
  /** Set when dither-accounts runs it rather than this hub (docs/accounts.md). Absent from older hubs. */
  managedBy?: AccountManaged;
  /** What its network says of the account itself: notices, presence, folders (self.ts). Absent until it says any. */
  self?: AccountSelfView;
  /** A calendar account's service address (docs/calendar.md); null when its config has none that works. */
  url?: string | null;
}

/** How an account that dither-accounts runs came to be there, and where its page is. */
export interface AccountManaged {
  /** The account on the manager's page, when the hub knows the page's address (DITHER_ACCOUNTS_PUBLIC_URL). */
  url: string | null;
  /**
   * Who made it: this hub, another app, the manager's page, or an import of a session this hub kept (`import`: its
   * session is in the hub's data, so deleting it there would not delete it). Null until the manager has said.
   */
  origin: 'self' | 'app' | 'page' | 'import' | null;
}

export interface IdentityView {
  id: string;
  network: Network;
  nativeId: string;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  isBot: boolean;
  personId: string | null;
  /**
   * Your own name for this account (docs/chats.md, Names): only you see it, it stands for the account's name wherever
   * that shows, and a network never sets it. Absent when you gave none.
   */
  nickname?: string;
  /** Their custom status or About as last heard (docs/history.md). */
  status?: { text?: string; emoji?: string; at: number };
}

export interface PersonView {
  id: string;
  name: string;
  avatar: string | null;
  starred: boolean;
  isSelf: boolean;
  identityIds: string[];
  /** Where `name` came from (NameSource). */
  nameSource: NameSource;
}

/**
 * Where a person's name came from, always from their accounts' names as you see them (a nickname you gave an account
 * counts): `network`, their one account's; `merge`, one account's of several. A person has no nickname of their own
 * since 2026-11-11 (docs/chats.md, Names).
 */
export type NameSource = 'network' | 'merge';

/**
 * One way to reach a chat (docs/chats.md): a conversation and one of your accounts in it. A person reached from two of
 * your accounts in one conversation has two routes there.
 */
export interface ChatRoute {
  conversationId: string;
  accountId: string;
  network: Network;
  /** Their identity in the conversation (a direct one), null in a group. */
  theirIdentityId: string | null;
  /** Your identity on that account. */
  myIdentityId: string | null;
  lastTs: number | null;
  unread: number;
  mentions: number;
}

/**
 * A chat as one thing (docs/chats.md): `person:<id>`, every direct conversation with someone, or a conversation id on
 * its own. `route` is where a message goes when the sender does not say: the route you last chose, while it still
 * exists and no message has come on another route since (`at`, when it was chosen), else the one of the latest message.
 */
export interface ChatView {
  id: string;
  kind: 'person' | 'conversation';
  personId: string | null;
  conversationId: string | null;
  name: string;
  nameSource: NameSource | null;
  routes: ChatRoute[];
  route: { conversationId: string; accountId: string; why: 'chosen' | 'latest'; at?: number } | null;
}

/** One of your accounts observing a space or conversation, with its read state. */
export interface VantageView {
  accountId: string;
  unread: number;
  mentions: number;
  lastReadTs: number | null;
}

export interface SpaceView {
  id: string;
  network: Network;
  nativeId: string;
  kind: SpaceKind;
  name: string;
  topic: string | null;
  icon: string | null;
  accountIds: string[];
  nativeMute: NativeMute | null;
}

export interface SpaceEdgeView {
  parentId: string;
  childKind: 'space' | 'conversation';
  childId: string;
  position: string | null;
}

export interface MessagePreview {
  id: string;
  authorId: string | null;
  ts: number;
  kind: MessageKind;
  text: string;
}

export interface ConversationView {
  id: string;
  network: Network;
  nativeId: string;
  shape: Shape;
  variant: Variant;
  name: string | null;
  topic: string | null;
  avatar: string | null;
  encrypted: boolean;
  archived: boolean;
  parentId: string | null;
  /** Spaces that directly contain this conversation (usually one; Matrix can give several). */
  spaceIds: string[];
  participantIds: string[];
  /** direct: the person on the other end. */
  peerPersonId: string | null;
  vantages: VantageView[];
  lastMessage: MessagePreview | null;
  lastMessageAt: number | null;
  nativeMute: NativeMute | null;
  /** direct: a friend request between one of your accounts here and the other person, waiting on one side (docs/add.md). */
  pending?: PendingLinkView;
  /** A thread's following, tags and first message (threads.ts). */
  thread?: ThreadView;
  /** A forum or media channel's tags and default order (threads.ts). */
  forum?: ForumView;
}

/**
 * A friend or follow request between an account and someone, not yet answered. incoming: they asked; the request
 * to answer is `requestId`. Outgoing: the account asked (its list says 'requested'); Cancel removes it.
 */
export interface PendingLinkView {
  accountId: string;
  identityId: string;
  incoming: boolean;
  requestId: string | null;
}

/** One entry of an account's list (capability 'relationships', the hub's person_link). */
export interface PersonLinkView {
  accountId: string;
  identityId: string;
  personId: string | null;
  relationship: LinkRelationship;
  /** ms epoch, when the network said. */
  since: number | null;
}

/** GET /api/people?relationship=friend&account=acc_…: who is on your accounts' lists, newest first. */
export interface PeopleLinksView {
  links: PersonLinkView[];
  identities: IdentityView[];
}

export interface AttachmentView {
  id: string;
  kind: AttachmentKind;
  mime: string | null;
  name: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  url: string;
  /** What the file is by its bytes, once the hub has kept and looked at them (files.ts, docs/files.md). */
  info?: FileInfo;
  /** As AttachmentFact has them (docs/rich-messages.md): alt text, spoiler, explicit, voice message. */
  alt?: string;
  spoiler?: true;
  explicit?: true;
  voice?: VoiceFact;
  /** Recorded as a voice note (extra.ts AttachmentNote). */
  voiceNote?: true;
  /** Its own caption, where the network has one per file. */
  caption?: string;
}

/** A file uploaded to the hub and waiting to be sent. */
export interface UploadView {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * An upload made a piece at a time (docs/uploads.md): `POST /api/uploads/start` with { name, mime, size }, then
 * `PUT /api/uploads/:id?offset=<received>` with up to UPLOAD_CHUNK bytes each. It can be sent once `received` is
 * `size`. A piece at the wrong offset is refused with 409 and { received }, where to carry on from.
 */
export interface UploadState extends UploadView {
  received: number;
}

/**
 * The answer to `POST /api/conversations/:id/send`. `messageId` is the hub's id for the sent message when the network
 * said which it is: the app replaces its pending copy with that message (packages/web/src/outbox.ts).
 */
export interface SendResult {
  ok: true;
  accountId: string;
  result?: unknown;
  messageId?: string;
}

export interface TriageView {
  decision: TriageDecision;
  /** Its importance, 0 to 1 (the model's `important` chance): the phone's list and the inbox sort by it. */
  score: number | null;
  reasons: string[];
  /** 'learned': what your marks taught moved it from where it started (docs/notifications.md). */
  decidedBy: 'rules' | 'model' | 'learned';
  /** Your marks on it, if any. */
  marks?: TriageMarks | null;
  /** A vote from before the tiers (the level you voted it to), kept as an example of importance. */
  feedback: NotifyTier | null;
  /** The model's two chances. */
  probs?: TriageProbs | null;
  /** The local model's answer to "does this need the reader within an hour or two?", 0 to 1, when it was asked. */
  judge?: number | null;
  /** The bar that answer was held to: lower in DMs and messages about you (learn.ts `ALERT_BAR`). With `judge`. */
  bar?: number;
}

/**
 * What you said of a decision (POST /api/messages/:id/feedback). `alert` true: it should have alerted; false: the
 * alert was wrong. `less`: less like this (it was not important). Absent or null: no mark.
 */
export interface TriageMarks {
  alert?: boolean | null;
  less?: boolean | null;
}

/** What the decision model predicts for a message (docs/notifications.md): worth an alert, and its importance. */
export interface TriageProbs {
  alert: number;
  important: number;
}
export type TriageHead = keyof TriageProbs;

/** Something the model learned from your marks: a feature, in words, and how far it moves one of the chances. */
export interface LearnedFactorView {
  /** The feature, stable: for forgetting it. */
  key: string;
  text: string;
  head: TriageHead;
  /** In log-odds: +1 roughly doubles the odds again over. */
  weight: number;
  /** Marks it was part of. */
  votes: number;
}

/** What triage has learned from your marks, and how well it fits them. */
export interface TriagePolicyView {
  factors: LearnedFactorView[];
  /** Features you told it to forget: never learned again. */
  rejected: { key: string; text: string }[];
  /** Marks (and votes from before the tiers) it learns from. */
  votes: number;
  /** Marks the model gets wrong, and that its starting chances alone would. */
  errors: number;
  baseline: number;
  /** A message alerts at `alert` or more, and reaches the list at `important` or more (your level, PUT /api/triage/level). */
  thresholds: TriageProbs;
  /** The local model's answer at which a message alerts before any mark: in DMs and messages about you, and elsewhere. */
  bars: { direct: number; other: number };
  /** Chats a day the list would have held over the last week, at each level you could set. */
  preview: { level: number; perDay: number }[];
  learnedAt: number | null;
  /** Why it last learned. */
  lastReason: string | null;
}

/**
 * What the candidate model, run in shadow next to the live one, would have done over the last `days`
 * (GET /api/triage/shadow, docs/notifications.md). Counts of decisions, never which.
 */
export interface TriageShadowView {
  days: number;
  /** The oldest decision with a shadow, or null with none yet. */
  since: number | null;
  /** Decisions with a shadow, outside the Conversation tier. */
  decided: number;
  /** Of those, at the list or above: as decided, as the shadow's importance would have, and by both. */
  live: number;
  shadow: number;
  both: number;
}

/** A link preview or bot card attached to a message. */
export interface EmbedView {
  title?: string;
  description?: string;
  url?: string;
  provider?: string;
  author?: string;
  image?: string;
  fields?: { name: string; value: string }[];
  /** The colour bar down its side, CSS hex. */
  color?: string;
  footer?: string;
  footerIcon?: string;
  /** The time it shows in its footer, ms. */
  timestamp?: number;
  authorIcon?: string;
  authorUrl?: string;
  /**
   * A video: `url` is a player page (YouTube, Twitch, Vimeo) loaded only once clicked (`player`), or a file the
   * <video> plays (`gifv` loops it silently, as a GIF).
   */
  video?: { url: string; width?: number; height?: number; player?: true; gifv?: true };
}

export interface CustomEmojiView {
  key: string;
  name: string;
  url: string;
  animated: boolean;
}

export interface ReactionView {
  key: string;
  style: ReactionStyle;
  /** The total. Can exceed identityIds: Discord reports totals without naming everyone. */
  count: number;
  identityIds: string[];
  emoji?: CustomEmojiView;
  colors?: string[];
}

/**
 * A conversation's or space's About as the web app gets it (about.ts, docs/group-settings.md): the adapter's answer
 * in hub ids, from the account that asked. When no account could ask, the last answer the hub kept, with `stale`.
 */
export interface AboutView extends Omit<About, 'members' | 'pinned' | 'fields' | 'moderation'> {
  target: { kind: 'conversation' | 'space'; id: string };
  network: Network;
  /** The account whose view this is. null: none could ask, and nothing was kept. */
  accountId: string | null;
  fetchedAt: number;
  /** Why this is not fresh: the account is offline, or its adapter cannot read settings. */
  stale?: string;
  /** Some settings can be changed through this account. */
  canConfigure: boolean;
  fields: AboutFields;
  members?: {
    list: { identityId: string; role?: string; rank?: number; color?: string; label?: { text?: string; emoji?: string }; mod?: MemberMod }[];
    total?: number;
    complete: boolean;
  };
  /** About.moderation with hub identity ids for the banned and those asking to join. */
  moderation?: AboutModerationView;
  /** The members' identities, since strangers in a big place are not in the bootstrap. */
  identities: IdentityView[];
  /** A space's members your accounts have seen, with the adversarial `members` setting on. */
  coverage?: MemberCoverageView;
  pinned?: {
    /** Pinned messages the hub has, newest pin first. */
    messages: MessageView[];
    /** Pinned messages the hub has not stored. */
    missing: number;
    canEdit: boolean;
    reason?: string;
  };
}

/** GET /api/conversations/:id/members/candidates: whom this account could add here, people it talked with first. */
export interface MemberCandidatesView {
  accountId: string;
  /** Whom the network lets it add, from its last About. */
  who: AddWho;
  mode: 'add' | 'invite';
  room?: number;
  candidates: {
    identityId: string;
    /** On this account's list: friend, contact. */
    relationship?: PersonRelationship;
    /** When this account last had a message with them in a direct conversation. */
    lastTalked?: number;
  }[];
  identities: IdentityView[];
}

/** POST /api/conversations/:id/members { identities, accountId? }: who is in now, who was invited, who was refused and why. */
export interface AddMembersView {
  accountId: string;
  added: string[];
  invited: string[];
  failed: { identityId: string; reason: string }[];
  /** The About as it now stands, when the network said. */
  about: AboutView | null;
}

/** GET /api/groups/candidates (`?account=` for one): each connected account that can make a group, and whom it could put in one. */
export interface GroupCandidatesView {
  accounts: {
    accountId: string;
    network: Network;
    rule: GroupRule;
    /** People it talked with lately first, as for adding people. */
    candidates: { identityId: string; relationship?: PersonRelationship; lastTalked?: number }[];
  }[];
  /** Your other connected chat accounts, and why each cannot (WhatsApp's line, not built yet). Offline accounts are left out. */
  unable: { accountId: string; network: Network; reason: string }[];
  identities: IdentityView[];
}

/** POST /api/groups { accountId, name?, identities }: the group as made, who is in, who was invited, who was refused and why. */
export interface CreateGroupView {
  accountId: string;
  conversation: ConversationView;
  added: string[];
  invited: string[];
  failed: { identityId: string; reason: string }[];
  notes: string[];
}

/**
 * How much of a space's member list the hub has seen (passively: only what your accounts' clients loaded anyway).
 * Never everyone: Discord lists a big server's online members at most, and the client loads only what is in view.
 */
export interface MemberCoverageView {
  /** Members seen, ever, by any of your accounts. */
  seen: number;
  /** The network's member count and online count, as last reported. */
  total?: number;
  online?: number;
  /** seen / total, at most 1, when total is known. */
  fraction?: number;
  /** ms epoch: when someone here was last seen, and when the network last gave its counts. */
  lastSeenAt?: number;
  reportedAt?: number;
}

/**
 * People and the places they share (GET /api/graph, docs/people-graph.md): who is in which server or group, as far as
 * the hub knows. Server members come only with the adversarial `members` setting; a profile's mutual servers and a
 * group's participants always. Never message text.
 */
export interface PeopleGraph {
  /** Whether server members are recorded. Without it, a server has only who a profile or a channel's members named. */
  members: boolean;
  /** Your account ids; the `accounts` below are indexes into this. */
  accounts: string[];
  people: GraphPerson[];
  places: GraphPlace[];
  /** Person–place links as flat triples: person index, place index, GRAPH_SOURCE bits. Each pair once. */
  links: number[];
}
export interface GraphPerson {
  /** A person's id, or an identity's when no person holds it (`identity`). */
  id: string;
  identity?: true;
  name: string;
  networks: Network[];
  /** Accounts that have a direct chat with them. */
  dm: number[];
  bot?: true;
}
export interface GraphPlace {
  /** A community space (`space`) or a group conversation (`group`). */
  id: string;
  kind: 'space' | 'group';
  name: string | null;
  network: Network;
  /** Accounts that see it. */
  accounts: number[];
  /** The network's member count, when it gave one (members setting on). */
  total?: number;
}
/** Where a link came from: members seen (adversarial), a profile's mutual servers, a conversation's participants. */
export const GRAPH_SOURCE = { members: 1, profile: 2, participant: 4 } as const;

/** What one of your accounts can react with in a conversation. */
export interface ReactionContextView {
  accountId: string | null;
  canReact: boolean;
  reason?: string;
  existingOnly?: boolean;
  custom: { id: string; name: string; icon: string | null; emoji: CustomEmojiView[] }[];
  super?: { available: boolean; reason?: string };
  /** What this account may do to others' messages here (moderation.ts). */
  moderation?: MessageModeration;
}

/** How often you have reacted with something: the quick row and "frequently used". */
export interface ReactionUsage {
  key: string;
  network: Network;
  count: number;
  emoji?: CustomEmojiView;
}

export interface MessageView {
  id: string;
  conversationId: string;
  network: Network;
  nativeId: string;
  authorId: string | null;
  ts: number;
  editedTs: number | null;
  kind: MessageKind;
  body: string;
  replyToId: string | null;
  threadId: string | null;
  mentionsSelf: boolean;
  /**
   * Gone on the network. When the hub kept it (docs/history.md) `body` and the attachments are still here, and
   * `gone` says how: deleted, or its disappearing timer ran out; else the body is empty.
   */
  deleted: boolean;
  gone?: { how: 'deleted' | 'disappeared'; at: number; kept: boolean };
  /** Earlier versions the hub kept: GET /api/messages/:id/history. */
  edits?: number;
  /** Other things that happened to it the hub kept: reactions taken back, pins (docs/history.md). */
  events?: number;
  /** Pinned, as the last pin or unpin the hub saw says. */
  pinned?: boolean;
  /** Your own messages: how many people it reached, read and played, and the latest of those. */
  receipts?: { delivered: number; read: number; played: number; latest: { identityId: string; state: ReceiptState; at: number } };
  /** Something is wrong with this message's encryption, e.g. it came in the clear in an encrypted room. */
  encryptionWarning?: string;
  attachments: AttachmentView[];
  embeds: EmbedView[];
  reactions: ReactionView[];
  seenVia: string[];
  triage: TriageView | null;
  /** Your mark on whether it needs a reply, when there is one. */
  replyMark?: ReplyMark;
  /** This message forwards another: body and attachments are what was forwarded. */
  forward?: ForwardView;
  /** Controls, marks and the rest of rich.ts, when it has any (docs/rich-messages.md). */
  rich?: RichView;
  /** What the message quotes, as the message itself carries it (extra.ts QuoteFact). Shown when replyToId is not stored. */
  quote?: QuoteView;
  /** Contact cards shared in it. */
  contacts?: ContactCardView[];
  /** A reply (or reaction) to a story. */
  storyReply?: StoryReplyView;
  /** Your message did not reach these people (it reached the others). */
  failed?: SendFailureView[];
  /** Files it had that the account could not download. */
  missingAttachments?: MissingAttachmentFact[];
  /** A poll, with its votes as the hub has them (poll.ts). */
  poll?: PollView;
  /**
   * A feed conversation's message (variant 'feed', docs/feed.md): what they did, as the adapter's `extra.feed` said,
   * with each post's `author` a hub identity id and its pictures the hub's signed media paths.
   */
  feed?: FeedItem;
}

/** A forward, shown as a card with where it came from. */
export interface ForwardView {
  /** The original, when this hub has it. */
  messageId: string | null;
  conversationId: string | null;
  authorId: string | null;
  /** Who wrote the original, in words, when no identity is known. */
  authorName: string | null;
  network: Network | null;
  /** Where the original was: "#general · Some server". */
  source: string | null;
  ts: number | null;
  /** The forwarded text, when the message's own body also carries a note and a line saying where it came from. */
  text?: string;
  /** What was written with it, when the network carried both as one message (a forward this hub sent across networks). */
  note?: string;
  /** How it went out, for forwards this hub sent: the network's own forward, the content again, or into another network. */
  sentAs?: ForwardMode;
}

export type ForwardMode = 'native' | 'resend' | 'cross';

/** POST /api/messages/:id/forward */
export interface ForwardRequest {
  targets: { conversationId: string; accountId?: string }[];
  note?: string;
}

export interface ForwardResult {
  conversationId: string;
  ok: boolean;
  mode?: ForwardMode;
  accountId?: string;
  error?: string;
  /** Attachments that could not go along (too large for the destination, or gone). */
  skipped?: string[];
}

export interface FolderView {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  items: { kind: 'space' | 'conversation' | 'person'; id: string }[];
}

/** Where a place sits in your sidebar. Hub-only: networks never see it. */
export type PlaceKind = 'folder' | 'space' | 'conversation';
export interface PlacePrefView {
  kind: PlaceKind;
  id: string;
  /** Manual order; null follows activity. */
  position: number | null;
  pinned: boolean;
  /** Out of the sidebar and lists. Notifications are a separate setting and do not change. */
  hidden: boolean;
  /** Folders: shown expanded in the sidebar. */
  open: boolean;
  /** Conversations: has its own sidebar entry, as communities do by default. */
  railed: boolean;
}
export type PlacePrefPatch = { kind: PlaceKind; id: string } & Partial<Omit<PlacePrefView, 'kind' | 'id'>>;

/** A category is a yes/no question asked of each place (hub categorize.ts). */
export interface CategoryView {
  id: string;
  name: string;
  question: string;
  /** Used when no model is running. Empty means words from the name and question. */
  keywords: string[];
  color: string | null;
  /** A place belongs when P(yes) is at least this; null is the provider's default (categoryThreshold). */
  threshold?: number | null;
}

/**
 * Where a category starts matching when you have not moved its slider. Keyword scores are coarse (0.8 for a name hit);
 * the reranker's P(yes) is uncalibrated and low (a Rust server scores about 0.5 for "programming"), so it starts lower.
 */
export const categoryThreshold = (c: Pick<CategoryView, 'threshold'> | undefined, provider: string | null | undefined): number =>
  c?.threshold ?? (provider?.startsWith('jev') ? 0.12 : 0.5);

/** Every place's P(yes) for a question asked once (POST /api/categories/probe), not saved. */
export interface CategoryProbe {
  provider: string;
  question: string;
  scores: { kind: 'space' | 'conversation'; id: string; p: number }[];
}

export interface PlaceCategoryView {
  categoryId: string;
  kind: 'space' | 'conversation';
  id: string;
  /** P(yes) from the provider; null if you decided before any score existed. */
  p: number | null;
  provider: string | null;
  /** Your decision, which always beats the score. */
  override: boolean | null;
}

export interface PlaceStats {
  /** Conversation id -> messages stored in the last 7 days. */
  week: Record<string, number>;
  /** Conversation id -> when you last posted. */
  mine: Record<string, number>;
}

/** Everything the hub has stored about someone. It only knows what crossed your accounts. */
/** What one network says about one of a person's identities (docs/profile.md): PersonAbout in hub ids. */
export interface PersonAboutView extends Omit<PersonAbout, 'avatar' | 'banner' | 'mutualSpaces' | 'mutualFriends' | 'friends' | 'posts'> {
  identityId: string;
  network: Network;
  /** The account that asked. */
  accountId: string | null;
  fetchedAt: number;
  /** Why this is not fresh: no account could ask, it is offline, or the network refused. */
  stale?: string;
  avatar?: string | null;
  banner?: string | null;
  /** Spaces you share; `spaceId` null for one the hub does not have. */
  mutualSpaces?: { spaceId: string | null; nativeId: string; nick?: string; roles?: { name: string; color?: string }[]; joinedAt?: number }[];
  mutualFriends?: string[];
  friends?: string[];
  /** Their recent posts (X), as PersonAbout's, with each `author` a hub identity id and pictures signed media paths. */
  posts?: PostFact[];
  /**
   * Kept from what the network showed unasked (a `personAbout` event: X's notifications), not from asking it: no
   * posts of their own, and the profile asks the network for them.
   */
  unasked?: true;
  /** Everyone those name, for rendering. */
  identities: IdentityView[];
}

export interface ProfileView {
  personId: string | null;
  note: string | null;
  identityIds: string[];
  identities: IdentityView[];
  /** Places they have posted in or are listed as a member of, most recent first. */
  conversations: { id: string; messages: number; lastTs: number | null }[];
  recent: MessageView[];
  /** Everyone else named in those messages. */
  mentioned: IdentityView[];
  totalMessages: number;
  firstSeenTs: number | null;
  /** What each network said last, kept by the hub; ask `GET /api/identities/:id/about` for a fresh one. */
  abouts: PersonAboutView[];
  /** How each of your accounts stands with them, from the accounts' own lists (capability 'relationships'). */
  links?: PersonLinkView[];
  /** Your accounts that ignore them on their network (capability 'ignore', self.ts): their messages never alert. */
  ignored?: { accountId: string; identityId: string }[];
  /**
   * Spaces your accounts' clients have seen them as a member of, last seen first. Only with the adversarial `members`
   * setting on; not every space they are in.
   */
  memberOf?: { spaceId: string; nick?: string; roles?: string[]; joinedAt?: number; lastSeenAt: number }[];
  /**
   * Mail with them (hub mail/people.ts, docs/mail.md): their newest threads across your mail accounts, and how many
   * there are. Only when they have an email identity; `withList` opens all of it.
   */
  mail?: { threads: MailThreadView[]; total: number };
}

/**
 * How many messages someone has posted in a server, from the messages the hub holds and nothing else (hub
 * msgcount.ts, docs/profile.md). `observed` is exact and a lower bound; a total is given only where the data supports it.
 */
export interface MessageCountEstimate {
  /** The server (its top-level community). */
  spaceId: string;
  /** Their messages the hub holds there: they posted at least this many. */
  observed: number;
  /** Messages by anyone the hub holds there. */
  captured: number;
  /** Their share of those, a 95% Wilson interval. */
  shareLow: number;
  shareHigh: number;
  /** Their estimated count with its range, only when a total could be estimated. */
  estimate?: number;
  low?: number;
  high?: number;
  /**
   * Their messages in channels with no estimate (gaps in what is held, or too little of it), counted as seen only:
   * `high` is then not a ceiling, and the count may be more. At most a tenth of `observed`, or there is no estimate.
   */
  unestimated?: number;
  /** The server's own estimated total, when channels with no estimate hold at most a tenth of what is held. */
  total?: { estimate: number; low: number; high: number };
  /**
   * 'share': observed and share only, the total unknown. 'complete': the hub holds the channels back to their start.
   * 'snowflake-lifetime': the unseen time before the oldest message held, from each channel's id, at its own rate.
   */
  method: 'share' | 'complete' | 'snowflake-lifetime';
  /** Why, in a sentence: what the total rests on, or why there is none. */
  reason?: string;
  /** ms epoch: the newest message held there, which the estimate is as of. null when none. */
  asOf: number | null;
  networks: Network[];
}

/** GET /api/persons/:id/activity, /api/identities/:id/activity[?space=]: servers they posted in, most messages first. */
export interface ActivityView {
  spaces: MessageCountEstimate[];
}

/** Where a message was: a DM with you, a group, or a server's channel or thread. */
export type ActivityWhere = 'dm' | 'group' | 'server';
export type PresenceState = PresenceView['state'];

/** Messages per local hour from one kind of place on one network: `hours[i]` is hour i of the range. */
export interface ActivitySeries {
  where: ActivityWhere;
  network: Network;
  count: number;
  hours: number[];
}

/**
 * GET /api/people/:id/activity?days=30&tz=Europe/Berlin (or &offset=<minutes east of UTC>), :id a person or an
 * identity (hub activitychart.ts, docs/profile.md "Activity"): when someone is around, from what the hub holds. The
 * range is whole local days ending today; hour i is local hour i % 24 of day floor(i / 24), so a day is always 24
 * hours (the hour a clock skips is empty, the hour it repeats holds both).
 */
export interface ActivityChartView {
  /** The zone the hours are in: an IANA name, or "UTC+05:30" for an offset. */
  zone: string;
  /** The first day, local, YYYY-MM-DD; `days` days from it, today last. */
  firstDay: string;
  days: number;
  /** The first day's weekday, 0 Monday to 6 Sunday. */
  firstWeekday: number;
  /** The hour holding now; the hours after it are still to come. */
  nowHour: number;
  /** ms epoch: the first day's local midnight, and now. */
  from: number;
  to: number;
  /** Their messages (not system lines), by where and network. Only series with any. */
  sent: ActivitySeries[];
  /** Your messages in DMs and groups they are in, by where and network. Absent on your own page. */
  mine?: ActivitySeries[];
  /** Reactions they gave, at the hour of the message they reacted to (the hub does not keep when a reaction came). */
  reactions: { count: number; hours: number[] };
  /**
   * Weekday by hour, 7 × 24, Monday first (index weekday * 24 + hour): their messages, yours, and with presence the
   * seconds they were online or do not disturb (`online`) out of the seconds their presence was known (`known`).
   */
  week: { sent: number[]; mine?: number[]; online?: number[]; known?: number[] };
  /**
   * Their presence, only while presence is logged (an adversarial feature): merged across their identities (online,
   * then do not disturb, then idle, then offline wins). Stretches in hours from the range's start, fractional; per
   * hour, seconds in each state, only hours where it was known.
   */
  presence?: {
    stretches: [from: number, to: number, state: PresenceState][];
    hours: [hour: number, online: number, idle: number, dnd: number, offline: number][];
  };
  /** Their status changes in the range, only while statuses are logged (an adversarial feature). null text and emoji: cleared. */
  statuses?: { at: number; hour: number; text: string | null; emoji: string | null; network: Network }[];
}

/** POST /api/directs: a direct conversation, opened or found. */
export interface OpenedDirect {
  conversation: ConversationView | null;
  existed: boolean;
  /** Nothing exists on the network until the first message (Signal). */
  startsAtFirstSend: boolean;
}

/** POST /api/add/resolve: what a reading is, as one account sees it (add.ts, docs/add.md). Ids are hub ids. */
export interface AddPreviewView {
  accountId: string;
  ref: AddRef;
  what: AddPreview['what'];
  name: string;
  /** The network will not say more without acting: a missing count or id is not "not found". */
  partial?: true;
  nativeId: string | null;
  /** A person: their identity's id. */
  identityId: string | null;
  /** The hub's media URL, as other views carry one. */
  avatar: string | null;
  description: string | null;
  members: number | null;
  online: number | null;
  /** Already in it: hub space and conversation ids. */
  joined: { space?: string; conversation?: string } | null;
  relationship: PersonRelationship | null;
  /** What this account can do now, best first: the network's list, less what this account cannot do yet. */
  actions: AddAction[];
  expires: number | null;
  /** Who made the invite: an identity id (its view is in `identities`). */
  inviter: string | null;
  notes: string[];
  identities: IdentityView[];
}

/** POST /api/add and POST /api/requests/:id: what was done. Ids are hub ids. */
export interface AddResultView {
  accountId: string;
  /** The conversation to open, when the network made or found one. */
  conversation: ConversationView | null;
  spaceId: string | null;
  identityId: string | null;
  relationship: PersonRelationship | null;
  /** Asked; waiting on the other side. */
  pending: boolean;
  /** The network wants a check first, in the account's live view. Nothing was done. */
  check: AddCheck | null;
  /** The network wants you to confirm first: its words. Nothing was done; send it again with confirm: true. */
  confirm: string | null;
  notes: string[];
  /** Where that check is done: this hub carries the account's live view, and/or its page on dither-accounts. */
  liveView: boolean;
  managerUrl: string | null;
}

/** A request waiting on you (GET /api/requests, the bootstrap's `requests`, the `requests` event). */
export interface RequestView {
  /** `req_`, per account. */
  id: string;
  accountId: string;
  network: Network;
  nativeId: string;
  kind: RequestFact['kind'];
  /** Who asked: an identity id. */
  from: string | null;
  /** id: the hub's space or conversation, when it holds it. */
  target: { kind: 'space' | 'conversation'; id: string | null; name: string | null; members: number | null } | null;
  ts: number;
  answers: RequestAnswer[];
  /** The network flagged it, in its words: possible spam, or someone you share nothing with. */
  warning: string | null;
  /** The network filed it as spam: it never notifies, and sits last. */
  spam?: boolean;
}

export interface SearchHit {
  message: MessageView;
  /** The matching text, with matches between \u0001 and \u0002. Plain text otherwise, not HTML. */
  snippet: string;
  /** With &context=n: the messages just before and after it in its conversation, oldest first. */
  before?: MessageView[];
  after?: MessageView[];
}

export interface SearchPage {
  hits: SearchHit[];
  /** Identities for rendering, including people matched by name. */
  identities: IdentityView[];
  /** Identity ids whose name matches, for people the client may not hold. */
  people: string[];
  /** Pass as &cursor= for the next page; null at the end. */
  next: string | null;
  mode: 'fulltext' | 'substring' | 'filters';
  /** Nothing matched as typed, so these hits are for this query instead, a misspelt word corrected. Page with it. */
  corrected?: string;
}

/** A message with what surrounds it, for jumping to it. */
export interface MessageContext extends MessagePage {
  hasNewer: boolean;
}

/** One device that opted in to Web Push. The endpoint stays on the hub apart from this fingerprint. */
export interface PushDeviceView {
  id: string;
  label: string;
  /** Which relay carries it: Google, Apple, Mozilla, Microsoft, or a UnifiedPush server's host name. */
  relay: string;
  /** The UnifiedPush server's origin (ntfy), or null for a browser vendor's relay. */
  server: string | null;
  createdAt: number;
  /** The push server last took a push for it. */
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastTestAt: number | null;
  /** The device itself said a test push arrived (its service worker, or the Android app). */
  lastArrivedAt: number | null;
}

/** A UnifiedPush server the hub may send to, besides the browser vendors' relays (which are always allowed). */
export interface PushServerView {
  origin: string;
  /** default: allowed until turned off (ntfy.sh); environment: DITHER_PUSH_RELAYS; approved: allowed from the app. */
  source: 'default' | 'environment' | 'approved';
  /** Allowed although it is on a private address, such as a tailnet ntfy. */
  private: boolean;
  addedAt: number | null;
  /** A default the owner turned off. */
  off: boolean;
  devices: number;
}

/** Devices that tried to register through a server the hub does not send to yet, waiting for the owner to allow it. */
export interface PushPendingView {
  origin: string;
  labels: string[];
  at: number;
  /** Plain http: only allowed by typing it out. */
  http: boolean;
}

/** The older plain-text ntfy topic, DITHER_NTFY_URL. */
export interface PushTopicView {
  server: string;
  lastOkAt: number | null;
  lastError: string | null;
}

/** GET /api/push */
export interface PushInfo {
  publicKey: string;
  devices: PushDeviceView[];
  servers: PushServerView[];
  pending: PushPendingView[];
  topic: PushTopicView | null;
}

/** A daily window with no pushes. Times are in `timezone`, the zone of the device that set them. */
export interface QuietHours {
  enabled: boolean;
  start: string; // "22:00"
  end: string; //   "07:00"; earlier than start means it ends the next morning
  timezone: string;
  /** Weekdays the window starts on, 0 = Sunday. Empty or missing: every day. */
  days?: number[];
  /** Starred people, and people set to always notify, still get through. */
  allowStarred: boolean;
}

export interface RuleView {
  id: string;
  scope: NotifyScope;
  target: string | null;
  level: NotifyLevel;
  createdAt: number;
}

/**
 * Where a device wants notifications, on top of the rules every device shares (docs/devices.md). Only lowers:
 * `hub` follows the shared rules, `mentions` keeps only mentions and replies to you, `none` shows nothing here.
 */
export type DeviceLevel = 'hub' | 'mentions' | 'none';
export type DeviceScope = 'network' | 'account' | 'space' | 'conversation';

export interface DeviceRuleView {
  scope: DeviceScope;
  target: string;
  level: DeviceLevel;
}

/** A device that has said hello, or a push registration no open page has claimed yet. */
export interface DeviceView {
  id: string;
  label: string;
  lastSeenAt: number | null;
  /** Its push registrations (PushDeviceView ids). */
  pushIds: string[];
  rules: DeviceRuleView[];
}

export interface Bootstrap {
  selfPersonId: string | null;
  accounts: AccountView[];
  persons: PersonView[];
  identities: IdentityView[];
  spaces: SpaceView[];
  edges: SpaceEdgeView[];
  conversations: ConversationView[];
  folders: FolderView[];
  placePrefs: PlacePrefView[];
  categories: CategoryView[];
  placeCategories: PlaceCategoryView[];
  categoryProvider: string;
  /** Set when this hub's chat accounts run in dither-accounts. Absent from older hubs and hubs that run their own. */
  accountsManager?: { url: string | null };
  rules: RuleView[];
  /** Absent from hubs that predate per-device rules. */
  devices?: DeviceView[];
  reactionUsage: ReactionUsage[];
  /** The inbox's ranking (docs/inbox.md). Absent from hubs that predate it. */
  attention?: AttentionView[];
  now: number;
  /** Where in the hub's change journal this bootstrap stands, so the next reconnect asks only for what changed since (docs/sync.md). */
  sync?: SyncPosition;
  /** Mail (docs/mail.md). Absent from hubs that predate it. */
  mail?: MailBootstrap;
  /** Requests waiting on you (docs/add.md). Absent from hubs that predate them. */
  requests?: RequestView[];
  /** dither-calendar beside the hub (docs/calendar.md). Absent when the hub has none. */
  calendar?: CalendarLinkView;
  /** Notices (docs/notices.md). Absent when the hub has none. */
  notices?: NoticesBoot;
}

/**
 * How much a conversation needs you, from its metadata only (docs/inbox.md). The hub sends one for every
 * conversation the inbox lists: direct, group, notes to self, rooms outside a space, and anything else while it
 * has an unread mention or pinged you.
 */
/** The reason a row the learned order's exploring lifted gives (docs/inbox.md, "Exploring"). */
export const EXPLORE_REASON = 'Shown higher to learn: not much history with this one yet';

export interface AttentionView {
  /** A conversation's id, or a mail thread's (`mth_`) when `kind` is 'mail'. */
  id: string;
  /** A mail thread in the one-list inbox (docs/mail.md); a conversation without it. */
  kind?: 'mail';
  /** The inbox's order: higher first. Roughly 0..100; muted places sit below 0. */
  score: number;
  /** It needs you: something to answer or read, or a conversation going on. Not where you were. */
  needs: boolean;
  /** Why, most important first, as sentences. */
  reasons: string[];
  /** The first message addressed to you that you have not answered, if any. */
  owedSince: number | null;
  /** You marked what you owe here "Reply needed": it is held up until you answer (docs/inbox.md, "Marks"). */
  replyMark?: 'needs';
  /** When the hub computed it. */
  at: number;
}

/**
 * Your mark on whether a message needs a reply (docs/inbox.md, "Marks"): `none`, no reply needed (it settles what was
 * owed up to it, as a reaction would); `needs`, reply needed (held up until you answer; it never notifies).
 */
export type ReplyMark = 'none' | 'needs';

export interface MessagePage {
  messages: MessageView[];
  identities: IdentityView[];
  hasMore: boolean;
}

export interface InboxItem {
  message: MessageView;
  conversationId: string;
}

export interface InboxPage {
  items: InboxItem[];
  identities: IdentityView[];
}

export type ClientEvent =
  | { t: 'account'; account: AccountView }
  | { t: 'account.removed'; id: string }
  | { t: 'identity'; identity: IdentityView }
  | { t: 'person'; person: PersonView }
  | { t: 'person.removed'; id: string }
  | { t: 'space'; space: SpaceView; edges: SpaceEdgeView[] }
  | { t: 'space.removed'; id: string }
  | { t: 'conversation'; conversation: ConversationView }
  | { t: 'conversation.removed'; id: string }
  | { t: 'message'; message: MessageView; identities: IdentityView[]; live: boolean }
  | { t: 'message.deleted'; id: string; conversationId: string }
  /** No conversation: it is about a request, or about what quiet hours held. */
  | { t: 'notify'; messageId?: string; conversationId?: string; title: string; body: string; reasons: string[]; /** Its tier; absent is an alert. */ level?: 'push' | 'quiet' | 'digest'; /** The notification's id in the activity log (docs/activity.md). */ nid?: string; /** Devices whose own rules keep this quiet (docs/devices.md). */ quiet?: string[]; /** The sender's (or the place's) picture, a hub media path. */ icon?: string; network?: Network; /** About a mail thread (slice 9): `conversationId` is the thread too. */ mailThreadId?: string; /** About a request waiting on you (docs/add.md): it opens under Requests. */ requestId?: string; /** About an event in the calendar (docs/calendar.md): it opens the calendar there. */ calendar?: CalendarNotifyRef; /** A notice (docs/notices.md): `conversationId` is its group, and it opens under Notices. */ noticeId?: string }
  /**
   * Someone started typing (it lasts `ttl` ms unless another start comes) or `stop`ped. Of the moment: not journaled,
   * and a client that reconnects simply does not see it. `name` only when the hub knows no name for the identity.
   */
  | { t: 'typing'; conversationId: string; identityId: string; ttl?: number; stop?: true; name?: string }
  /**
   * A send went out, and the network named the message it became: the page that sent it (`clientId`) can match its
   * pending copy by id before the answer to its POST arrives. Of the moment, like `typing`: not journaled.
   */
  | { t: 'sent'; conversationId: string; clientId: string; messageId: string }
  /** Calls that changed: ringing you, going on, or just over (call.ts CallView, docs/calls.md "Ringing"). Of the moment. */
  | { t: 'calls'; calls: import('./call.ts').CallView[] }
  /** Voice channels whose people or status line changed (call.ts VoiceChannelView). Of the moment. */
  | { t: 'voice'; channels: import('./call.ts').VoiceChannelView[] }
  /**
   * Plans the calendar found in chats changed (docs/calendar.md): these, or all of them with `replace`. Of the moment,
   * like `typing`: not journaled. A page asks GET /api/plans again whenever its live socket (re)opens and on `resync`.
   */
  | { t: 'plans'; plans: CalendarPlanView[]; replace?: true }
  /**
   * Whether the hub reaches the calendar, and how many plans wait for you there. Of the moment too. `off`: the calendar
   * account was removed or turned off, so the calendar's pane, tab and plans go until one is on again (the next
   * `calendar` event without it).
   */
  | { t: 'calendar'; reachable: boolean; waiting: number; off?: true }
  | { t: 'folders'; folders: FolderView[] }
  | { t: 'placePrefs'; prefs: PlacePrefView[] }
  | { t: 'categories'; categories: CategoryView[]; placeCategories: PlaceCategoryView[] }
  | { t: 'rules'; rules: RuleView[] }
  | { t: 'devices'; devices: DeviceView[] }
  /** What the hub keeps of deleted, disappeared and edited messages changed (docs/history.md). */
  | { t: 'retention'; retention: RetentionSettings }
  /** New or changed inbox scores, and conversations the inbox no longer lists. `replace`: these are all of them. */
  | { t: 'attention'; items: AttentionView[]; removed: string[]; replace?: true }
  /** Mark-all-read still telling the networks: how many reads are left, how many were given up on. */
  | { t: 'readProgress'; pending: number; failed: number }
  /** Time spent in places changed (usage.ts, docs/organize.md). `replace`: these are all of them. */
  | { t: 'usage'; places: UsageView[]; removed: { kind: UsageKind; id: string }[]; replace?: true }
  | { t: 'arrange'; arrange: ArrangeSettings }
  /** Requests waiting on you changed (docs/add.md): the whole list. */
  | { t: 'requests'; requests: RequestView[] }
  /** Mail (docs/mail.md, docs/mail-design.md §5). Whether the hub may read it, its accounts, their mailboxes. */
  | { t: 'mail.access'; access: MailAccess }
  | { t: 'mail.account'; account: MailAccountView }
  | { t: 'mail.account.removed'; id: string }
  | { t: 'mail.mailboxes'; accountId: string; mailboxes: MailboxView[] }
  /** Threads new or changed, and threads gone (emptied, or merged into another). */
  | { t: 'mail.threads'; threads: MailThreadView[]; removed: string[] }
  /** Lists the page holds that the hub changed without sending each thread: fetch them again when shown (slice 2). `w:*` names every list of mail with someone. */
  | { t: 'mail.lists'; stale: string[] }
  /** An account's sync, as it goes. Of the moment: not journaled (slice 2). */
  | { t: 'mail.progress'; accountId: string; sync: MailAccountView['sync'] }
  /** Every item the outbox still shows (held, queued, sending, failed, or sent a little while ago): the whole list. */
  | { t: 'mail.outbox'; items: MailOutboxView[] }
  /** Messages to send later changed (sending.ts, docs/sending.md): the whole list the hub sends. Of the moment, not journaled. */
  | { t: 'scheduled'; items: import('./sending.ts').ScheduledSendView[] }
  /** Ends a frame whose changes went into the journal: a client holding everything up to here can resume from `seq`. */
  | { t: 'sync'; seq: number }
  /** How an interaction with a bot went (apps.ts, docs/apps.md). Of the moment: not journaled. */
  | { t: 'interaction'; interaction: import('./apps.ts').InteractionView }
  /** A bot opened a form in answer to one of yours (apps.ts). Of the moment. */
  | { t: 'appModal'; modal: import('./apps.ts').AppModalView }
  | { t: 'resync' };

// ------------------------------------------------------------------ delta sync (docs/sync.md)

/** Bumped when a journal from an older hub cannot be read the same way: a client from another version starts over. */
export const SYNC_VERSION = 1;

/** A place in the hub's change journal. `epoch` changes when the journal starts over, which makes every older position void. */
export interface SyncPosition {
  v: number;
  epoch: string;
  seq: number;
}

export interface SyncTimelineRequest {
  /** `c:<conversation>` or `p:<person>`, as the client keys its timelines. */
  key: string;
  /** The journal position this copy of the timeline is current to. */
  seq: number;
  /** The newest and oldest message held. */
  newest: number;
  oldest: number;
  /** False for a window around an old message: only changes inside it, nothing newer. */
  newer?: boolean;
  /** A person timeline: the conversations it merged. Another set now (people merged or split) means a fresh page. */
  conversationIds?: string[];
}

export interface SyncRequest {
  v: number;
  epoch: string;
  /** Everything but messages, changed after this. Absent: only the timelines. */
  since?: number;
  timelines?: SyncTimelineRequest[];
}

export interface SyncTimeline {
  key: string;
  /** New messages after `newest`, and changed ones (edited, deleted, reacted to) inside the held range. */
  messages: MessageView[];
  /** The held copy is past saving (too many new messages, or older than the journal): `messages` is the newest page instead. */
  replace: boolean;
  /** With `replace`: whether there are older messages than the page. */
  hasMore?: boolean;
  conversationIds?: string[];
}

export type SyncResponse =
  | { full: true; reason: string }
  | {
      full?: false;
      sync: SyncPosition;
      /** Changes since the hub process started; a new one may have brought a new web build. */
      boot: string;
      /** The same events the live socket sends, current as of `sync.seq`. Empty when only timelines were asked for. */
      events: ClientEvent[];
      selfPersonId?: string | null;
      categoryProvider?: string;
      /** As in the bootstrap; null: this hub runs its own accounts. */
      accountsManager?: { url: string | null } | null;
      reactionUsage?: ReactionUsage[];
      /** Messages the inbox lists that arrived or changed since. */
      inbox?: MessageView[];
      timelines: SyncTimeline[];
      /** Authors, reactors and mentions in the messages above. */
      identities: IdentityView[];
      /** Messages replies above quote, when not among them. */
      quoted: MessageView[];
    };

// ------------------------------------------------------------------ history (docs/history.md)

/** What the hub keeps of what the networks take back, per source: deleted, disappeared, and edited messages. */
export interface KeepSettings {
  deleted: boolean;
  disappearing: boolean;
  edits: boolean;
  /** Reactions taken back: who took back what. */
  reactions: boolean;
  /** Who got, read and played your messages, and when. */
  receipts: boolean;
}

export interface RetentionSettings extends KeepSettings {
  /** Names, descriptions, pictures, settings, members, roles, pins, and people's profiles, as they change. */
  changes: boolean;
  /** People's statuses over time (an adversarial feature). */
  statuses: boolean;
  /** People's presence (online, idle, do not disturb, offline) over time, as it changes. Adversarial. */
  presence: boolean;
  /** Who is in which server, from what the network's client loads anyway (passive). Adversarial. */
  members: boolean;
  /**
   * Who is in which voice channel when you are not, from what the network's client is sent anyway (passive), and when
   * each of them joined and left. Adversarial. Absent (a hub from before it): off.
   */
  voice?: boolean;
  /**
   * Adversarial features shown, after the warning (docs/history.md): their switches, and what they kept, in sight.
   * Statuses, presence and members are logged only while shown. Deleted and disappearing messages are kept as their
   * switches say whether shown or not: hiding never loses a message, it only keeps what was kept out of sight.
   */
  adversarial: boolean;
  /** Kept deleted and disappeared messages in chats: shown in full, marked, or not shown at all. */
  show: 'shown' | 'hidden';
  /** The same for one chat (conversation id), over `show`. */
  showIn: Record<string, 'shown' | 'hidden'>;
  /** Overrides by network ("signal") or account id, the account's first. */
  sources: Record<string, Partial<KeepSettings>>;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  deleted: false,
  disappearing: false,
  edits: true,
  reactions: true,
  receipts: true,
  changes: true,
  statuses: false,
  presence: false,
  members: false,
  voice: false,
  adversarial: false,
  show: 'shown',
  showIn: {},
  sources: {},
};

/** One change to the retention settings: each field's [before, after], and the device that made it. */
export interface RetentionChange {
  at: number;
  by: string | null;
  changed: Record<string, [unknown, unknown]>;
}

/** Switches whose turning off is confirmed (PUT /api/retention takes `confirm: true` for it). */
export const RETENTION_GUARDED = ['deleted', 'disappearing', 'statuses', 'presence', 'members', 'voice', 'adversarial'] as const satisfies readonly (keyof RetentionSettings)[];

/** Whether kept deleted and disappeared messages show in this chat. */
export const showsGone = (r: RetentionSettings, conversationId: string | null | undefined): boolean =>
  r.adversarial && ((conversationId ? r.showIn?.[conversationId] : undefined) ?? r.show) !== 'hidden';

/** Someone's presence, as a presence change's `old` and `new` (ChangeView, field "presence"). */
export interface PresenceView {
  state: 'online' | 'idle' | 'dnd' | 'offline';
  /** Where they are on, when the network says. */
  devices?: ('desktop' | 'mobile' | 'web')[];
}

/** The kinds that are adversarial: their switches show only with adversarial features shown. */
export const ADVERSARIAL_KEEPS = ['deleted', 'disappearing'] as const satisfies readonly (keyof KeepSettings)[];

/** What Forget erases, one kind at a time (POST /api/retention/erase); GET /api/retention/kept says which have anything kept. */
export const KEPT_KINDS = ['deleted', 'disappeared', 'edits', 'reactions', 'receipts', 'changes', 'statuses', 'presence', 'members', 'voice'] as const;
export type KeptKind = (typeof KEPT_KINDS)[number];

/**
 * One thing that changed about a place or a person. `old` and `new` are the values themselves: text for names and
 * descriptions, a media path for pictures, a setting's own type (seconds, true or false, "admins"), `{ text, emoji }`
 * for a status, `{ state, devices }` for presence, an identity id for a member, `{ identityId, role, color }` for a role. null: nothing.
 */
export interface ChangeView {
  id: number;
  target: { kind: 'conversation' | 'space' | 'identity'; id: string };
  /** name, topic, avatar, displayName, handle, bio, status, presence, pronouns, banner, a setting key, member, role. */
  field: string;
  old: unknown;
  new: unknown;
  at: number;
  /** Who made the change, where the network says. */
  actorId?: string;
  /** For member and role changes: whose. */
  identityId?: string;
}

/** Something that happened to one message, besides its text changing. */
export interface MessageEventView {
  kind: 'edit' | 'unreact' | 'pin' | 'unpin';
  /** edit: the text it had before; unreact: { key, style }. */
  data: unknown;
  actorId?: string;
  at: number;
}

/** GET /api/messages/:id/history */
export interface MessageHistoryView {
  /** Every version, oldest first, the last as it reads now. */
  versions: { body: string; at: number | null }[];
  events: MessageEventView[];
  /** Your message: who got it, read it, played it, and when. */
  receipts: { identityId: string; state: ReceiptState; at: number }[];
  identities: IdentityView[];
}
