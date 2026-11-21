/**
 * What the extractor knows of the organization, from `POST /register` and kept up to date by the event queue:
 * people, channels and this account's subscriptions, channel folders, user groups, custom emoji, topics seen, and
 * this account's unread messages. Messages are kept only in a small cache (for quoting, widgets and moves).
 */
import type { Submessage, WidgetState } from './widgets.ts';

export interface ZUser {
  user_id: number;
  email: string;
  /** The address they sign in with, where this account may see it (the API's `email` may be a stand-in). */
  delivery_email?: string | null;
  full_name: string;
  avatar_url?: string | null;
  is_bot?: boolean;
  is_active?: boolean;
  role?: number;
  timezone?: string;
  date_joined?: string;
  bot_type?: number | null;
  bot_owner_id?: number | null;
  profile_data?: Record<string, { value: string; rendered_value?: string }>;
  is_imported_stub?: boolean;
  deleted?: boolean;
}

export interface ZStream {
  stream_id: number;
  name: string;
  description: string;
  invite_only: boolean;
  is_web_public?: boolean;
  history_public_to_subscribers?: boolean;
  is_archived?: boolean;
  folder_id?: number | null;
  date_created?: number;
  /** A group id or a {direct_members, direct_subgroups} setting: who may post. */
  can_send_message_group?: unknown;
  stream_post_policy?: number;
  subscriber_count?: number;
  topics_policy?: string;
}

export interface ZSub extends ZStream {
  is_muted?: boolean;
  in_home_view?: boolean;
  pin_to_top?: boolean;
  color?: string;
  desktop_notifications?: boolean | null;
  push_notifications?: boolean | null;
}

export interface ZMessage {
  id: number;
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  content: string;
  timestamp: number;
  type: 'stream' | 'private';
  stream_id?: number;
  subject?: string;
  display_recipient: string | { id: number; email: string; full_name: string }[];
  reactions?: { emoji_name: string; emoji_code: string; reaction_type: 'unicode_emoji' | 'realm_emoji' | 'zulip_extra_emoji'; user_id: number }[];
  submessages?: Submessage[];
  flags?: string[];
  last_edit_timestamp?: number;
  last_moved_timestamp?: number;
  is_me_message?: boolean;
  avatar_url?: string | null;
  client?: string;
}

export interface ZGroup {
  id: number;
  name: string;
  description?: string;
  members: number[];
  /** Groups whose members are members of this one too (Zulip 6.0+; system groups nest this way). */
  direct_subgroup_ids?: number[];
  is_system_group?: boolean;
  deactivated?: boolean;
}

export interface ZFolder {
  id: number;
  name: string;
  description?: string;
  order?: number;
  is_archived?: boolean;
}

export interface TopicInfo {
  stream: number;
  /** As last written. */
  name: string;
  maxId: number;
  lastTs: number;
}

/** visibility_policy: 0 inherit, 1 muted, 2 unmuted, 3 followed. */
export interface UserTopic {
  stream_id: number;
  topic_name: string;
  visibility_policy: number;
  last_updated?: number;
}

const CACHE = 5000;

export class State {
  realm = { name: '', description: '', icon: '' as string | null, id: 0 };
  self = 0;
  role = 400;
  featureLevel = 0;
  version = '';
  users = new Map<number, ZUser>();
  streams = new Map<number, ZStream>();
  subs = new Map<number, ZSub>();
  folders = new Map<number, ZFolder>();
  groups = new Map<number, ZGroup>();
  topics = new Map<string, TopicInfo>();
  userTopics = new Map<string, UserTopic>();
  /** Recent direct conversations: user ids (others) → newest message id. */
  recentDms = new Map<string, number>();
  mutedUsers = new Set<number>();
  /** Unread message id → its conversation's native id. */
  unread = new Map<number, string>();
  /** Unread messages that mention this account. */
  unreadMentions = new Set<number>();
  /** Message id → ts, for unread ones and the newest of each conversation (to say read points). */
  ts = new Map<number, number>();
  /** Conversation → its newest message seen. */
  newest = new Map<string, { id: number; ts: number }>();
  starred = new Set<number>();
  scheduled = new Map<number, any>();
  reminders = new Map<number, any>();
  widgets = new Map<number, WidgetState>();
  /** Whether others see this account online (Zulip's "invisible mode" is presence_enabled false). */
  presenceEnabled = true;
  /** Others' presence as Zulip last said it: the times, in ms, they were last active and last there at all. */
  presence = new Map<number, { active: number; idle: number }>();
  /** How long after those times someone is shown idle, then offline (`server_presence_offline_threshold_seconds`). */
  offlineMs = 140_000;
  /** How often Zulip's apps read everyone's presence again (`server_presence_ping_interval_seconds`). */
  pingMs = 60_000;
  /** Whether the organization has read receipts on (`realm_enable_read_receipts`). */
  readReceipts = false;
  /** Who may use @all and @topic in a big channel (`realm_can_mention_many_users_group`, a group-setting value). */
  canMentionMany: number | { direct_members?: number[]; direct_subgroups?: number[] } | null = null;
  status = new Map<number, { status_text?: string; emoji_name?: string; emoji_code?: string; reaction_type?: string; away?: boolean }>();
  private messages = new Map<number, ZMessage>();
  /** People by full name, for mentions written without an id. */
  private byName = new Map<string, number>();
  private streamsByName = new Map<string, number>();

  /** user_topics' key: the topic as Zulip names it (a resolved one with its ✔: Zulip keeps its own setting for it). */
  topicKey(stream: number, topic: string) {
    return `${stream}\u0000${topic.toLowerCase()}`;
  }

  putUser(u: ZUser) {
    const old = this.users.get(u.user_id);
    if (old && old.full_name !== u.full_name) this.byName.delete(old.full_name.toLowerCase());
    this.users.set(u.user_id, { ...old, ...u });
    this.byName.set(u.full_name.toLowerCase(), u.user_id);
  }
  userByName(name: string) {
    const id = this.byName.get(name.toLowerCase());
    return id === undefined ? undefined : this.users.get(id);
  }

  putStream(s: ZStream) {
    const old = this.streams.get(s.stream_id);
    if (old && old.name !== s.name) this.streamsByName.delete(old.name.toLowerCase());
    this.streams.set(s.stream_id, { ...old, ...s });
    this.streamsByName.set(s.name.toLowerCase(), s.stream_id);
  }
  streamByName(name: string) {
    return this.streamsByName.get(name.toLowerCase());
  }

  remember(m: ZMessage) {
    this.messages.delete(m.id);
    this.messages.set(m.id, m);
    if (this.messages.size > CACHE) {
      const first = this.messages.keys().next().value;
      if (first !== undefined) {
        this.messages.delete(first);
        this.widgets.delete(first);
      }
    }
  }
  message(id: number) {
    return this.messages.get(id);
  }
  forget(id: number) {
    this.messages.delete(id);
    this.widgets.delete(id);
  }
  cachedMessages() {
    return this.messages.values();
  }
}
