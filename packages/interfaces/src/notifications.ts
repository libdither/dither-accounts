/**
 * `notifications`: what a service tells you about, as a list you can read and clear: GitHub's notifications, Telegram
 * Desktop's, and the manager's own about its accounts (the built-in `notices` account, docs/notifications.md). Ids are
 * the source's own and stable; `at` is milliseconds since the epoch.
 *
 * `urgency` was added to version 1 as an optional field: a consumer that does not know it reads every notification as
 * `normal`, which is what its absence means.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface NotificationActor {
  name: string;
  url: string | null;
  avatar: string | null;
}

/**
 * How soon the source thinks you should look, a hint and never a decision (an app ranks it its own way):
 * - `high`: act soon (a security alert, an account that stopped and needs you, an approval nobody can answer);
 * - `normal`: addressed to you (a mention, a review request, an assignment);
 * - `low`: ambient (activity on something you only watch, CI, state changes).
 */
export type Urgency = 'high' | 'normal' | 'low';

export interface Notification {
  id: string;
  /** What raised it: 'github', 'Telegram Desktop', 'dither-accounts' (the manager's own), or a phone app's name. */
  source: string;
  title: string;
  body: string | null;
  /** Where it leads, on the web. */
  url: string | null;
  /** Why you got it, in the service's words: mention, review_requested, assign, comment… */
  reason: string | null;
  /** Where it belongs: a repository, an app, a conversation. */
  context: string | null;
  /** The thing it is about, when there is one: an issue, a pull request, a release. */
  subject: { kind: string; title: string; url: string | null; state: string | null } | null;
  actors: NotificationActor[];
  at: number;
  unread: boolean;
  /** The source's hint (Urgency); absent means `normal`. */
  urgency?: Urgency;
}

export const notifications = iface({
  name: 'notifications',
  version: 1,
  describe: 'What a service tells you about, to read and clear.',
  levels: {
    read: 'See your notifications',
    write: 'Mark your notifications read, and mute what they are about',
  },
  ops: {
    'notify.list': op(
      'read',
      'Your notifications, newest first, a page at a time',
      s.object({ unreadOnly: s.optional(s.boolean), since: s.optional(s.number), limit: s.optional(s.integer), pageToken: s.optional(s.string) }),
      s.typed<{ notifications: Notification[]; next: string | null }>(),
      60_000,
    ),
    'notify.markRead': op('write', 'Mark notifications read', s.object({ ids: s.array(s.string, 1000) }), s.object({})),
    'notify.markAllRead': op('write', 'Mark everything up to a time read (now, without one)', s.object({ before: s.optional(s.number) }), s.object({})),
    'notify.mute': op('write', 'No more notifications about what this one is about (a thread, a conversation)', s.object({ id: s.string }), s.object({})),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
    'notify.new': ev('A new notification, or one that came back unread', s.typed<{ notification: Notification }>()),
    'notify.read': ev('Notifications read elsewhere', s.typed<{ ids: string[] }>()),
  },
});
