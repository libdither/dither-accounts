/**
 * The activity log (docs/activity.md): one row per stay on a screen or place, and what happened to each
 * notification. Labelled data for notification triage and the planned local decision model. Ids, times, counts
 * and where you came from: never what was said, and never what was typed into search.
 */

/** What was on screen. `conversation` is any open timeline: a DM, a group, a channel or a thread. */
export type VisitView =
  | 'inbox'
  | 'triage'
  | 'conversation'
  | 'space'
  | 'person'
  | 'people'
  | 'profile'
  | 'folder'
  | 'spaces'
  | 'search'
  | 'settings'
  | 'accounts'
  | 'directory'
  /** Mail (docs/mail.md): the list or a thread, with no ids yet. */
  | 'mail'
  /** Requests waiting on you (docs/add.md). */
  | 'requests'
  /** dither-calendar's pane (docs/calendar.md). */
  | 'calendar'
  /** Notices (docs/notices.md). */
  | 'notices';
export const VISIT_VIEWS: readonly VisitView[] = ['inbox', 'triage', 'conversation', 'space', 'person', 'people', 'profile', 'folder', 'spaces', 'search', 'settings', 'accounts', 'directory', 'mail', 'requests', 'calendar', 'notices'];

/**
 * How the user got there. `notification`: a tap on a push (sw.js, the Android app); `toast`: on the in-app
 * notification; `inbox`/`triage`: a row of the ranked inbox or the triage board; `rail`: the rail or the phone's
 * tab bar; `list`: another list (a space's channels, People); `search`: a search result; `link`: a link, mention,
 * reply or jump inside a timeline; `back`/`forward`: browser history; `start`: the app opened here; `resume`: back
 * after a long time away, still here.
 */
export type VisitSource = 'notification' | 'toast' | 'inbox' | 'triage' | 'rail' | 'list' | 'search' | 'link' | 'back' | 'forward' | 'start' | 'resume' | 'other';
export const VISIT_SOURCES: readonly VisitSource[] = ['notification', 'toast', 'inbox', 'triage', 'rail', 'list', 'search', 'link', 'back', 'forward', 'start', 'resume', 'other'];

/** One stay, as the device sends it. Sent again while it lasts, with the same id: the hub keeps the latest. */
export interface VisitRecord {
  /** Made by the device. */
  id: string;
  /** This install of the app (random, kept in localStorage), and what it is. */
  device: string;
  deviceLabel?: string | null;
  view: VisitView;
  conversationId?: string | null;
  spaceId?: string | null;
  personId?: string | null;
  /** When the stay began, and when it was last in use. */
  start: number;
  end: number;
  /** Seconds in use: visible, focused, input in the last 5 minutes (the same rules as usage, docs/organize.md). */
  active: number;
  source: VisitSource;
  /** The notification tapped (`notification`, `toast`). */
  pushId?: string | null;
  /** From an inbox row: its position (0 = top), its attention score, and whether it needed you. */
  rank?: number | null;
  score?: number | null;
  needs?: boolean | null;
  /** The deepest inbox row on screen during the stay (0 = top), when the inbox's list was on screen: how far you looked. */
  depth?: number | null;
  /** The latest message on screen when the conversation was marked read here. */
  readToId?: string | null;
  readToTs?: number | null;
  /** Messages sent, reactions added, older pages loaded, threads and attachments opened, during the stay. */
  sent: number;
  reactions: number;
  history: number;
  threads: number;
  attachments: number;
  /** Where the user went next; null while it lasts or when the app went away. */
  next?: VisitView | null;
  /** Over: no more updates will come. */
  closed: boolean;
  /** The newest message on screen in the conversation, read or not (its time): what the stay could have seen. */
  seenToTs?: number | null;
  /** When the reply you owe there began, as the stay began (attention's `owedSince`), and whether its row showed ↩. */
  owedSince?: number | null;
  owedShown?: boolean | null;
  /** Edits to the message box during the stay (a count, nothing of what was typed), and whether a draft was left in it. */
  typed?: number;
  draftLeft?: boolean | null;
  /** How the stay ended: another place in the app (`route`), the app hidden (`hidden`) or closed (`closed`). */
  exit?: VisitExit | null;
}

export type VisitExit = 'route' | 'hidden' | 'closed';
export const VISIT_EXITS: readonly VisitExit[] = ['route', 'hidden', 'closed'];

/**
 * Something done to an inbox row that says what you made of it (docs/activity.md): `read`, Mark As Read on a row that
 * showed a reply you owe. Kept in the activity log with the stays; ids and times only.
 */
export type InboxActionKind = 'read';
export interface InboxAction {
  /** Made by the device: the same action sent twice is kept once. */
  id: string;
  device: string;
  action: InboxActionKind;
  /** The row's conversation (each route of a chat of several), or mail thread. */
  targetKind: 'conversation' | 'mail';
  targetId: string;
  at: number;
  /** The row's owed turn, as it showed: when it began. */
  owedSince?: number | null;
}

/**
 * What a device says happened to a notification. `delivered`: it reached the device; `shown`: the device showed
 * it; `suppressed`: not shown, since the app was on screen; `blocked`: notifications are off on the device;
 * `inapp`: the open app showed it as a toast instead; `tapped`; `dismissed`: swiped away (where the platform
 * tells: the Android app does, browsers only sometimes); `replied`: answered from the notification itself.
 */
export type NotificationEventKind = 'delivered' | 'shown' | 'suppressed' | 'blocked' | 'inapp' | 'tapped' | 'dismissed' | 'replied';
export const NOTIFICATION_EVENTS: readonly NotificationEventKind[] = ['delivered', 'shown', 'suppressed', 'blocked', 'inapp', 'tapped', 'dismissed', 'replied'];

export interface NotificationEvent {
  id: string;
  event: NotificationEventKind;
  /** The push registration (sw.js, the Android app), or the page's device id. */
  device?: string;
  at?: number;
}

export interface ActivitySettings {
  enabled: boolean;
  /** Visits and notifications older than this are deleted. */
  retentionDays: number;
}
export const DEFAULT_ACTIVITY: ActivitySettings = { enabled: true, retentionDays: 365 };
export const RETENTION_CHOICES = [30, 90, 180, 365] as const;

export interface ActivityInfo {
  settings: ActivitySettings;
  visits: number;
  notifications: number;
  oldest: number | null;
  /** DITHER_ACTIVITY_FEATURES: triage adds the features below to its reasons and keeps them with each decision. */
  featuresInTriage: boolean;
}

/**
 * What the log says about one place (a conversation; for a DM, all DMs with that person), over the last
 * FEATURE_WINDOW. Rates are null with nothing to count. Counts are given so a consumer can weigh small numbers.
 */
export interface PlaceActivity {
  kind: 'conversation' | 'person';
  id: string;
  /** Pushes sent for messages here. */
  pushes: number;
  /** Tapped, and opened by any route within OPEN_WINDOW of the push. */
  tapped: number;
  opened: number;
  tapRate: number | null;
  openRate: number | null;
  /** Median ms from push to open, of those opened. */
  medianTimeToOpen: number | null;
  /** Median active seconds of the visit after an opened push. */
  medianDwell: number | null;
  /** Of opened pushes, how many had a message from you within REPLY_AFTER of opening. */
  repliedAfterOpen: number;
  replyAfterOpenRate: number | null;
  /** Bursts of messages that got no push, and of those how many you opened within OPEN_WINDOW anyway. */
  unpushedBursts: number;
  openedWithoutPush: number;
  openedWithoutPushRate: number | null;
  /** Visits and their active seconds, over the window. */
  visits: number;
  activeSeconds: number;
}
