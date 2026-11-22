/**
 * One Zulip account: its organization through the REST API and the real-time event queue (docs/zulip.md).
 *
 *   sign in: an API key (secret.json `apiKey`), or a password swapped once for one (POST /fetch_api_key) and dropped
 *   → GET /server_settings, the emoji table → POST /register (everything, Markdown source, client capabilities)
 *   → the organization, folders, channels, topics and direct conversations as facts → the newest messages and every
 *   unread one → GET /events, long-polled, for as long as the account runs. A queue the server forgot
 *   (BAD_EVENT_QUEUE_ID, after a long sleep or a server restart) is registered again and what was missed is read.
 *
 * Model: the organization is a community; a channel folder a section in it; a channel a forum (variant 'forum') and
 * each of its topics a thread in it; direct messages are direct, group or self conversations. Ids: ids.ts.
 *
 * It logs ids, counts and statuses, never the key, a password or what a message says.
 */
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { canonicalReactionKey } from '@dither-chat/protocol';
import { RefusalError, type HubLink } from '@dither-chat/protocol/client';
import { type Credentials, Zulip, ZulipError, baseOf } from './http.ts';
import { Ids, msOf, narrowLink, RESOLVED, type Place } from './ids.ts';
import { Emoji, customOf, keyOf, reactionOf, type EmojiTable } from './emoji.ts';
import { editedContent, fromZulip, mediaUrl, plainText, replyQuote, toZulip, type MdCtx } from './markdown.ts';
import { State, type TopicInfo, type ZMessage, type ZStream, type ZSub, type ZUser } from './state.ts';
import { apply, fold, pollCommand, pollFact, todoBody, voteChanges, type Submessage } from './widgets.ts';
import * as about from './about.ts';
import { Receipts, START_WINDOW_MS } from './receipts.ts';

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
/** How many of the newest messages are read at start, across every conversation. */
const START_MESSAGES = num('DITHER_ZULIP_START_MESSAGES', 300);
/** At most this many unread messages are read at start (Zulip keeps up to 50,000). */
const START_UNREAD = num('DITHER_ZULIP_START_UNREAD', 2000);
/** Topics of each channel said at start, newest first; the rest come with `threads`. */
const START_TOPICS = num('DITHER_ZULIP_START_TOPICS', 30);
/** Waits after failures: this, doubling, up to five minutes. */
const BACKOFF_MS = num('DITHER_ZULIP_BACKOFF_MS', 2_000);
/** A message heard less than this old counts as live (it may alert). */
const LIVE_MS = 15 * 60_000;
const TYPING_TTL = 15_000;
/** How often others' presence is looked at again, to say who went idle or offline. */
const PRESENCE_SWEEP_MS = num('DITHER_ZULIP_PRESENCE_SWEEP_MS', 15_000);
/** Room for one second's messages after a moment, when history is asked for from a time. */
const SAME_SECOND = 50;

/** A presence as Zulip gives it (slim, or the older per-client form), as times in ms. */
function presenceTimes(p: any): { active: number; idle: number } {
  let active: number;
  let idle: number;
  if (p?.active_timestamp !== undefined || p?.idle_timestamp !== undefined) {
    active = Number(p.active_timestamp ?? 0) * 1000;
    idle = Number(p.idle_timestamp ?? 0) * 1000;
  } else {
    const t = Number(p?.aggregated?.timestamp ?? 0) * 1000;
    active = p?.aggregated?.status === 'active' ? t : 0;
    idle = t;
  }
  return { active, idle: Math.max(idle, active) };
}

export const CAPABILITIES: P.Capability[] = [
  'send', 'history', 'react', 'edit', 'redact', 'markRead', 'typing', 'threads', 'media', 'sendMedia', 'openDirect',
  'about', 'configure', 'profile', 'members', 'resolve', 'join', 'addMembers', 'createGroup', 'search', 'walkMembers',
  'mentionables', 'listThreads', 'leave', 'mute', 'markUnread', 'markReadMany', 'followThreads', 'forumPosts',
  'threadState', 'polls', 'pollVote', 'pollCreate', 'savedMessages', 'nativeScheduled', 'setPresence', 'ignore',
  'editProfile',
];

interface Config {
  server?: string;
  email?: string;
}
interface Secret {
  apiKey?: string;
  password?: string;
  email?: string;
}

type Phase = 'starting' | 'signin' | 'unreachable' | 'online';

export class ZulipAdapter {
  link!: HubLink;
  api!: Zulip;
  ids!: Ids;
  st = new State();
  emoji!: Emoji;
  base = '';
  private creds: Credentials | null = null;
  private phase: Phase = 'starting';
  private problem: string | null = null;
  private queue: { id: string; last: number } | null = null;
  private stopped = false;
  private failures = 0;
  private emitted = new Set<string>();
  private convSigs = new Map<string, string>();
  private registeredAt = 0;
  /** Read receipts for your newest message in each DM (receipts.ts). */
  receipts = new Receipts({
    enabled: () => this.st.readReceipts && this.st.featureLevel >= 137,
    ask: async (id) => ((await this.api.get(`/messages/${id}/read_receipts`)) as { user_ids?: number[] }).user_ids ?? [],
    read: (conv, id, who, ts) => {
      this.ensureIdentity(who);
      this.link.emit({ t: 'receipt', conversation: conv, messages: [this.ids.message(id)], who: this.ids.user(who), state: 'read', ts });
    },
    log: (msg) => this.link.log('warn', msg),
  });
  /** Each person's presence as last said to the hub, so a timer can say when they go idle or offline. */
  private presenceShown = new Map<number, 'online' | 'idle' | 'offline'>();
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private presencePolledAt = 0;
  private presencePolling = false;
  private eventsHeard = 0;
  private searches = new Map<string, number[]>();

  constructor(private fetchImpl: typeof fetch = fetch) {}

  // ---------------------------------------------------------------- start

  start(link: HubLink) {
    this.link = link;
    const cfg = link.config as Config;
    const base = baseOf(cfg.server);
    this.base = base ?? '';
    this.ids = new Ids(base ? new URL(base).host : 'invalid');
    this.emoji = new Emoji(join(link.accountDir, 'emoji.json'));
    this.api = new Zulip(base ?? 'https://invalid', () => this.creds, this.fetchImpl);
    if (!base) {
      this.setPhase('signin', 'No server address: set the organization URL (like https://chat.example.org) on the account.');
      return;
    }
    void this.run();
  }

  onConnect() {
    this.link.emit({ t: 'hello', network: 'zulip', version: '1', capabilities: CAPABILITIES });
    this.status();
    if (this.phase === 'online') {
      this.emitted.clear();
      this.convSigs.clear();
      this.emitStructure();
      this.emitReads();
      this.link.emit({ t: 'saved', saved: this.savedFacts(), complete: true });
      this.link.emit({ t: 'ignored', identities: [...this.st.mutedUsers].map((u) => this.ids.user(u)) });
      this.emitSelfState();
    }
  }

  async shutdown() {
    this.stopped = true;
    this.receipts.stop();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    if (this.queue) await this.api.del('/events', { queue_id: this.queue.id }).catch(() => {});
  }

  private status() {
    const host = this.ids.host;
    const layers: P.StatusLayer[] = [
      { name: host, state: this.phase === 'unreachable' ? 'failed' : this.st.version ? 'ok' : 'waiting', ...(this.st.version ? { note: `Zulip ${this.st.version} (feature level ${this.st.featureLevel})` } : this.phase === 'unreachable' && this.problem ? { note: this.problem } : {}) },
      { name: 'signed in', state: this.creds && this.st.self ? 'ok' : this.phase === 'signin' ? 'failed' : 'waiting', ...(this.phase === 'signin' && this.problem ? { note: this.problem } : this.creds ? { note: this.creds.email } : {}) },
      { name: 'event queue', state: this.phase !== 'online' ? 'waiting' : this.queue ? 'ok' : 'failed', ...(this.registeredAt ? { note: `${this.eventsHeard} events since ${new Date(this.registeredAt).toISOString()}` } : {}) },
    ];
    const self = this.st.users.get(this.st.self);
    this.link.emit({
      t: 'status',
      status: this.phase === 'online' ? 'online' : this.phase === 'signin' ? 'attention' : this.phase === 'unreachable' ? 'error' : 'connecting',
      attention: this.phase === 'signin' ? { kind: 'login', message: this.problem ?? 'Sign in again: set a new API key or password on the account.' } : null,
      ...(self ? { self: this.identity(self) } : {}),
      details: { server: host, version: this.st.version || null, featureLevel: this.st.featureLevel || null, requests: this.api.requests, ...(this.api.remaining !== null ? { rateRemaining: this.api.remaining } : {}) },
      layers,
    });
  }

  private setPhase(p: Phase, why: string | null = null) {
    this.phase = p;
    this.problem = why;
    this.status();
  }

  private backoff() {
    return Math.min(300_000, BACKOFF_MS * 2 ** Math.max(0, this.failures - 1));
  }

  private running = false;

  /** The one loop: sign in, register, poll; again after a failure. A second call while it runs does nothing. */
  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.loop();
    } finally {
      this.running = false;
    }
  }

  private async loop() {
    while (!this.stopped) {
      try {
        if (!this.creds) await this.signIn();
        if (!this.creds) return;
        await this.register();
        this.failures = 0;
        this.setPhase('online');
        if (this.laterTopics.length) void this.topicsAtStart(this.laterTopics.splice(0));
        await this.poll();
      } catch (e) {
        if (this.stopped) return;
        const err = e as ZulipError;
        if (err instanceof ZulipError && err.failure === 'auth') {
          this.creds = null;
          this.setPhase('signin', `${this.ids.host} refused the API key: ${err.message}. Set a new API key (Personal settings → Account & privacy → API key) or your password on the account.`);
          return;
        }
        this.failures++;
        this.queue = null;
        this.link.log('warn', `zulip: ${err?.failure ?? 'error'} ${err?.status ?? ''} ${err?.code ?? ''}: ${err?.message ?? e}; again in ${this.backoff()} ms`);
        if (err instanceof ZulipError && err.failure === 'network') this.setPhase('unreachable', err.message);
        await Bun.sleep(this.backoff());
      }
    }
  }

  private async signIn() {
    const cfg = this.link.config as Config;
    const secret = this.link.secret<Secret>();
    const email = (secret.email ?? cfg.email ?? '').trim();
    if (!email) {
      this.setPhase('signin', 'No email address: set the one you sign in to Zulip with on the account.');
      return;
    }
    // A password given (at first, or to sign in again) is swapped for the key at once, whatever key was there.
    if (secret.password) {
      try {
        const r = await this.api.post<{ api_key: string; email: string; user_id: number }>('/fetch_api_key', { username: email, password: secret.password }, { anonymous: true });
        this.keep({ apiKey: r.api_key, email: r.email ?? email });
        this.creds = { email: r.email ?? email, apiKey: r.api_key };
        this.link.log('info', 'zulip: swapped the password for an API key');
        return;
      } catch (e) {
        const err = e as ZulipError;
        if (!(err instanceof ZulipError && (err.failure === 'auth' || err.status === 403 || err.status === 400))) throw e;
        // Refused: it is dropped either way. A key beside it (one typed into the same field) gets its turn.
        this.keep({ ...(secret.apiKey ? { apiKey: secret.apiKey } : {}), email });
        if (!secret.apiKey) {
          this.setPhase('signin', `${this.ids.host} did not take the password: ${err.message}. An organization that signs in with SSO wants an API key instead.`);
          return;
        }
      }
    }
    if (secret.apiKey) {
      this.creds = { email, apiKey: secret.apiKey };
      return;
    }
    this.setPhase('signin', 'Set an API key (Zulip: Personal settings → Account & privacy → API key) or your password on the account.');
  }

  /**
   * Writes the secret without a password. Written twice: the file keeps the one before as secret.json.bak, and the
   * password must not stay there either.
   */
  private keep(secret: Secret) {
    this.link.saveSecret(secret);
    this.link.saveSecret(secret);
  }

  // ---------------------------------------------------------------- register

  private async register() {
    const ss = await this.api.get('/server_settings', undefined, { anonymous: true });
    this.st.version = String(ss.zulip_version ?? '');
    this.st.featureLevel = Number(ss.zulip_feature_level ?? 0);
    if (!this.emoji.loaded) {
      try {
        const res = await this.api.fetchFile('/static/generated/emoji/emoji_codes.json');
        this.emoji.set((await res.json()) as EmojiTable);
      } catch (e) {
        this.link.log('warn', `zulip: no emoji table: ${(e as Error).message}`);
      }
    }
    const r = await this.api.post('/register', {
      apply_markdown: false,
      client_gravatar: false,
      include_subscribers: false,
      slim_presence: true,
      client_capabilities: {
        notification_settings_null: true,
        bulk_message_deletion: true,
        user_avatar_url_field_optional: false,
        stream_typing_notifications: true,
        user_settings_object: true,
        linkifier_url_template: true,
        user_list_incomplete: true,
        include_deactivated_groups: true,
        archived_channels: true,
        empty_topic_name: true,
        simplified_presence_events: true,
      },
    });
    this.queue = { id: r.queue_id, last: r.last_event_id };
    this.registeredAt = Date.now();
    this.load(r);
    this.emitStructure();
    await this.catchUp();
    // Channels with something in what was just read get their topics now; the rest once online, so a big
    // organization's hundreds of channels do not hold the account back for minutes of the request budget.
    const active = new Set([...this.st.topics.values()].filter((t) => t.maxId > 0).map((t) => t.stream));
    await this.topicsAtStart([...active]);
    this.laterTopics = [...this.st.subs.keys()].filter((id) => !active.has(id));
    await this.learnReminderTargets();
    this.link.emit({ t: 'saved', saved: this.savedFacts(), complete: true });
    this.link.emit({ t: 'ignored', identities: [...this.st.mutedUsers].map((u) => this.ids.user(u)) });
    this.emitSelfState();
    this.presenceSweep(true);
    this.watchOwnAtStart();
  }

  private load(r: any) {
    const st = this.st;
    st.self = r.user_id;
    st.realm = { name: r.realm_name ?? this.ids.host, description: r.realm_description ?? '', icon: r.realm_icon_url ?? null, id: r.realm_id ?? 0 };
    for (const u of r.realm_users ?? []) st.putUser(u);
    for (const u of r.realm_non_active_users ?? []) st.putUser({ ...u, is_active: false });
    for (const b of r.cross_realm_bots ?? []) st.putUser({ ...b, is_bot: true });
    // Its own picture: /register says it apart, where the people list may leave it out.
    const me = st.users.get(r.user_id);
    if (me && !me.avatar_url && r.avatar_url) me.avatar_url = r.avatar_url;
    // /register gives the account's role as flags; its own entry among the people has the number.
    st.role = st.users.get(r.user_id)?.role ?? (r.is_owner ? 100 : r.is_admin ? 200 : r.is_moderator ? 300 : r.is_guest ? 600 : 400);
    st.subs.clear();
    for (const s of r.subscriptions ?? []) {
      st.subs.set(s.stream_id, s);
      st.putStream(s);
    }
    for (const s of r.unsubscribed ?? []) st.putStream(s);
    for (const s of r.never_subscribed ?? []) st.putStream(s);
    for (const s of r.streams ?? []) st.putStream(s);
    st.folders.clear();
    for (const f of r.channel_folders ?? []) st.folders.set(f.id, f);
    st.groups.clear();
    for (const g of r.realm_user_groups ?? []) st.groups.set(g.id, g);
    this.emoji.realm.clear();
    for (const [id, e] of Object.entries<any>(r.realm_emoji ?? {})) this.emoji.realm.set(id, { ...e, id });
    st.userTopics.clear();
    for (const t of r.user_topics ?? []) st.userTopics.set(st.topicKey(t.stream_id, t.topic_name), t);
    st.recentDms.clear();
    for (const c of r.recent_private_conversations ?? []) st.recentDms.set([...c.user_ids].sort((a: number, b: number) => a - b).join(','), c.max_message_id);
    st.presenceEnabled = r.user_settings?.presence_enabled ?? r.presence_enabled ?? true;
    st.offlineMs = Number(r.server_presence_offline_threshold_seconds ?? 140) * 1000;
    st.pingMs = Number(r.server_presence_ping_interval_seconds ?? 60) * 1000;
    this.presencePolledAt = Date.now();
    st.readReceipts = !!r.realm_enable_read_receipts;
    st.canMentionMany = r.realm_can_mention_many_users_group ?? null;
    st.presence.clear();
    for (const [id, p] of Object.entries<any>(r.presences ?? {})) st.presence.set(Number(id), presenceTimes(p));
    this.presenceShown.clear();
    st.mutedUsers = new Set((r.muted_users ?? []).map((m: any) => m.id));
    st.starred = new Set(r.starred_messages ?? []);
    st.scheduled.clear();
    for (const s of r.scheduled_messages ?? []) st.scheduled.set(s.scheduled_message_id, s);
    st.reminders.clear();
    for (const s of r.reminders ?? []) st.reminders.set(s.reminder_id, s);
    st.status.clear();
    for (const [id, s] of Object.entries<any>(r.user_status ?? {})) st.status.set(Number(id), s);
    // Unread: every unread message's conversation; their times come with the messages read next.
    st.unread.clear();
    st.unreadMentions = new Set(r.unread_msgs?.mentions ?? []);
    const u = r.unread_msgs ?? {};
    for (const s of u.streams ?? []) for (const id of s.unread_message_ids ?? []) st.unread.set(id, this.ids.topic(s.stream_id, s.topic));
    for (const p of u.pms ?? []) for (const id of p.unread_message_ids ?? []) st.unread.set(id, this.ids.dm([st.self, p.other_user_id ?? p.sender_id]));
    for (const h of u.huddles ?? []) for (const id of h.unread_message_ids ?? []) st.unread.set(id, this.ids.dm(String(h.user_ids_string).split(',').map(Number)));
    for (const s of u.streams ?? []) this.noteTopic(s.stream_id, s.topic, 0, 0);
  }

  /** Reads the newest messages and every unread one (up to START_UNREAD), as facts. After a gap, what came since. */
  private async catchUp() {
    const newest = await this.api.get('/messages', { anchor: 'newest', num_before: START_MESSAGES, num_after: 0, narrow: [], apply_markdown: false, allow_empty_topic_name: true });
    const unread = this.st.unread.size
      ? await this.api.get('/messages', { anchor: 'first_unread', num_before: 0, num_after: START_UNREAD, narrow: [{ operator: 'is', operand: 'unread' }], apply_markdown: false, allow_empty_topic_name: true })
      : { messages: [] };
    const all = new Map<number, ZMessage>();
    for (const m of [...newest.messages, ...unread.messages]) all.set(m.id, m);
    // After a gap (a queue the server forgot): what the cache holds from the range just read but the server no longer
    // returns was deleted meanwhile, and what it holds elsewhere was moved.
    const oldest = newest.messages?.[0]?.id;
    const moved = new Set<number>();
    if (oldest !== undefined)
      for (const m of [...this.st.cachedMessages()]) {
        const now = all.get(m.id);
        // Only where the range read covers: DMs and channels this account is in (not one browsed without joining).
        if (!now && m.id >= oldest && (m.type === 'private' || this.st.subs.has(m.stream_id ?? -1))) {
          this.st.unread.delete(m.id);
          this.st.forget(m.id);
          this.link.emit({ t: 'delete', conversation: this.convOf(m), nativeId: this.ids.message(m.id) });
        } else if (now && this.convOf(now) !== this.convOf(m)) moved.add(m.id);
      }
    const now = Date.now();
    for (const m of [...all.values()].sort((a, b) => a.id - b.id)) this.emitMessage(m, { live: false, late: now - m.timestamp * 1000 < LIVE_MS && !(m.flags ?? []).includes('read'), ...(moved.has(m.id) ? { moved: true } : {}) });
    this.emitReads();
  }

  // ---------------------------------------------------------------- events

  private async poll() {
    while (!this.stopped && this.queue) {
      let r: any;
      try {
        r = await this.api.get('/events', { queue_id: this.queue.id, last_event_id: this.queue.last }, { timeoutMs: 120_000 });
      } catch (e) {
        const err = e as ZulipError;
        if (err instanceof ZulipError && err.failure === 'queue') {
          this.link.log('info', 'zulip: the event queue is gone; registering again');
          this.queue = null;
          return;
        }
        throw e;
      }
      for (const ev of r.events ?? []) {
        this.queue.last = Math.max(this.queue.last, ev.id);
        if (ev.type === 'heartbeat') continue;
        this.eventsHeard++;
        try {
          await this.event(ev);
        } catch (e) {
          this.link.log('warn', `zulip: event ${ev.type}/${ev.op ?? ''} failed: ${(e as Error).message}`);
        }
      }
    }
  }

  private async event(ev: any) {
    const st = this.st;
    switch (ev.type) {
      case 'message': {
        const m: ZMessage = { ...ev.message, flags: ev.flags ?? [] };
        this.emitMessage(m, { live: true });
        this.watchReceipts(m);
        if (!(m.flags ?? []).includes('read')) {
          st.unread.set(m.id, this.convOf(m));
          if ((m.flags ?? []).some((f) => f === 'mentioned' || f.endsWith('wildcard_mentioned'))) st.unreadMentions.add(m.id);
        }
        this.emitRead(this.convOf(m));
        return;
      }
      case 'update_message':
        return this.onUpdate(ev);
      case 'delete_message': {
        const ids: number[] = ev.message_ids ?? (ev.message_id ? [ev.message_id] : []);
        const touched = new Set<string>();
        for (const id of ids) {
          const m = st.message(id);
          const conv = m ? this.convOf(m) : ev.message_type === 'stream' ? this.ids.topic(ev.stream_id, ev.topic ?? '') : null;
          if (!conv) continue;
          this.link.emit({ t: 'delete', conversation: conv, nativeId: this.ids.message(id) });
          this.receipts.forget(conv, id);
          st.forget(id);
          st.unread.delete(id);
          st.unreadMentions.delete(id);
          touched.add(conv);
        }
        for (const c of touched) this.emitRead(c);
        return;
      }
      case 'reaction': {
        const m = st.message(ev.message_id);
        const conv = m ? this.convOf(m) : await this.convOfId(ev.message_id);
        if (!conv) return;
        this.ensureIdentity(ev.user_id);
        if (m) {
          m.reactions = (m.reactions ?? []).filter((x) => !(x.user_id === ev.user_id && x.emoji_code === ev.emoji_code && x.reaction_type === ev.reaction_type));
          if (ev.op === 'add') m.reactions.push({ emoji_name: ev.emoji_name, emoji_code: ev.emoji_code, reaction_type: ev.reaction_type, user_id: ev.user_id });
        }
        const emoji = customOf(ev, this.emoji, this.base);
        this.link.emit({ t: 'reaction', conversation: conv, message: this.ids.message(ev.message_id), author: this.ids.user(ev.user_id), key: keyOf(ev), ...(ev.op === 'remove' ? { remove: true } : {}), ...(emoji ? { emoji } : {}) });
        return;
      }
      case 'update_message_flags': {
        const ids: number[] = ev.messages ?? [];
        if (ev.flag === 'read') {
          const touched = new Set<string>();
          if (ev.op === 'add') {
            const list = ev.all ? [...st.unread.keys()] : ids;
            for (const id of list) {
              const c = st.unread.get(id);
              if (c) touched.add(c);
              st.unread.delete(id);
              st.unreadMentions.delete(id);
            }
          } else {
            for (const id of ids) {
              const d = ev.message_details?.[id];
              const m = st.message(id);
              const conv = m ? this.convOf(m) : d ? (d.type === 'stream' ? this.ids.topic(d.stream_id, d.topic ?? '') : this.ids.dm([st.self, ...(d.user_ids ?? [])])) : null;
              if (!conv) continue;
              st.unread.set(id, conv);
              if (d?.mentioned) st.unreadMentions.add(id);
              touched.add(conv);
            }
            await this.learnTimes(ids.filter((id) => !st.ts.has(id)));
          }
          for (const c of touched) this.emitRead(c, ev.op === 'remove');
        } else if (ev.flag === 'starred') {
          for (const id of ids) {
            if (ev.op === 'add') {
              st.starred.add(id);
              const m = st.message(id);
              this.link.emit({ t: 'saved', saved: [{ message: this.ids.message(id), savedAt: Date.now(), ...(m ? { conversation: this.convOf(m) } : {}) }] });
            } else {
              st.starred.delete(id);
              const m = st.message(id);
              this.link.emit({ t: 'unsaved', message: this.ids.message(id), ...(m ? { conversation: this.convOf(m) } : {}) });
            }
          }
        }
        return;
      }
      case 'typing': {
        if (ev.sender?.user_id === st.self || ev.sender_id === st.self) return;
        const who = ev.sender?.user_id ?? ev.sender_id;
        const conv = ev.message_type === 'stream' ? this.ids.topic(ev.stream_id, ev.topic ?? '') : this.ids.dm((ev.recipients ?? []).map((r: any) => r.user_id));
        this.ensureIdentity(who);
        this.link.emit({ t: 'typing', conversation: conv, author: this.ids.user(who), ...(ev.op === 'stop' ? { stop: true } : { ttl: TYPING_TTL }) });
        if (ev.op !== 'stop' && ev.message_type !== 'stream') this.receipts.nudge(conv, who);
        return;
      }
      case 'subscription':
        return this.onSubscription(ev);
      case 'stream':
        return this.onStream(ev);
      case 'channel_folder': {
        if (ev.op === 'add' && ev.channel_folder) st.folders.set(ev.channel_folder.id, ev.channel_folder);
        else if (ev.op === 'update' && st.folders.has(ev.channel_folder_id)) {
          const f = st.folders.get(ev.channel_folder_id)!;
          Object.assign(f, ev.data ?? {});
          // An archived folder is gone from Zulip's sidebar; its channels go back to the organization.
          if (f.is_archived) this.link.emit({ t: 'leave', kind: 'space', nativeId: this.ids.folder(f.id) });
        }
        else if (ev.op === 'reorder' && Array.isArray(ev.order)) ev.order.forEach((id: number, i: number) => st.folders.has(id) && (st.folders.get(id)!.order = i));
        this.emitStructure();
        return;
      }
      case 'realm_user': {
        if (ev.op === 'add' || ev.op === 'update') {
          const id = ev.person.user_id;
          const old = st.users.get(id);
          const p = { ...ev.person };
          if (p.custom_profile_field && old) {
            const pd = { ...(old.profile_data ?? {}) };
            pd[String(p.custom_profile_field.id)] = { value: p.custom_profile_field.value, rendered_value: p.custom_profile_field.rendered_value };
            p.profile_data = pd;
            delete p.custom_profile_field;
          }
          st.putUser({ ...(old ?? { user_id: id, email: '', full_name: '' }), ...p });
          if (id === st.self && typeof p.role === 'number') st.role = p.role;
          // A new role in the organization (member → administrator): the hub logs it as one role lost, one given.
          if (ev.op === 'update' && typeof p.role === 'number' && old && old.role !== p.role) {
            this.ensureIdentity(id);
            const target = { kind: 'space' as const, nativeId: this.ids.space };
            this.link.emit({ t: 'role', target, member: this.ids.user(id), role: about.roleName(old.role), given: false, ts: Date.now() });
            this.link.emit({ t: 'role', target, member: this.ids.user(id), role: about.roleName(p.role), given: true, ts: Date.now() });
          }
          if (this.emitted.has(this.ids.user(id)) || ev.op === 'update') {
            this.emitted.delete(this.ids.user(id));
            this.ensureIdentity(id);
          }
        } else if (ev.op === 'remove') {
          const u = st.users.get(ev.person.user_id);
          if (u) u.is_active = false;
        }
        return;
      }
      case 'realm_bot':
        return;
      case 'realm':
        if (ev.op === 'update' && ev.property === 'name') st.realm.name = ev.value;
        if (ev.op === 'update' && ev.property === 'description') st.realm.description = ev.value;
        if (ev.op === 'update' && ev.property === 'enable_read_receipts') st.readReceipts = !!ev.value;
        if (ev.op === 'update_dict' && ev.data?.enable_read_receipts !== undefined) st.readReceipts = !!ev.data.enable_read_receipts;
        if (ev.op === 'update_dict' && ev.data?.can_mention_many_users_group !== undefined) st.canMentionMany = ev.data.can_mention_many_users_group;
        if (ev.op === 'update_dict' && ev.data?.server_presence_offline_threshold_seconds) st.offlineMs = ev.data.server_presence_offline_threshold_seconds * 1000;
        if (ev.op === 'update' && /^(enable_read_receipts|can_mention_many_users_group)$/.test(ev.property)) return;
        if (ev.op === 'update_dict') {
          // Zulip 13 says name and description changes this way too ("default" property).
          if (typeof ev.data?.name === 'string') st.realm.name = ev.data.name;
          if (typeof ev.data?.description === 'string') st.realm.description = ev.data.description;
          if (ev.data?.icon_url) st.realm.icon = ev.data.icon_url;
        }
        this.link.emit({ t: 'space', space: this.orgFact() });
        return;
      case 'realm_emoji':
        this.emoji.realm.clear();
        for (const [id, e] of Object.entries<any>(ev.realm_emoji ?? {})) this.emoji.realm.set(id, { ...e, id });
        return;
      case 'user_group':
        if (ev.op === 'add' && ev.group) st.groups.set(ev.group.id, ev.group);
        else if (ev.op === 'remove') st.groups.delete(ev.group_id);
        else if (ev.op === 'update' && st.groups.has(ev.group_id)) Object.assign(st.groups.get(ev.group_id)!, ev.data ?? {});
        else if (ev.op === 'add_members' && st.groups.has(ev.group_id)) {
          const g = st.groups.get(ev.group_id)!;
          const added = (ev.user_ids ?? []).filter((u: number) => !g.members.includes(u));
          g.members.push(...added);
          this.groupChanged(g, added, true);
        } else if (ev.op === 'remove_members' && st.groups.has(ev.group_id)) {
          const g = st.groups.get(ev.group_id)!;
          const gone = (ev.user_ids ?? []).filter((u: number) => g.members.includes(u));
          g.members = g.members.filter((u) => !gone.includes(u));
          this.groupChanged(g, gone, false);
        } else if (ev.op === 'add_subgroups' && st.groups.has(ev.group_id)) {
          const g = st.groups.get(ev.group_id)!;
          g.direct_subgroup_ids = [...new Set([...(g.direct_subgroup_ids ?? []), ...(ev.direct_subgroup_ids ?? [])])];
        } else if (ev.op === 'remove_subgroups' && st.groups.has(ev.group_id)) {
          const g = st.groups.get(ev.group_id)!;
          g.direct_subgroup_ids = (g.direct_subgroup_ids ?? []).filter((x) => !(ev.direct_subgroup_ids ?? []).includes(x));
        }
        return;
      case 'user_topic': {
        const t = { stream_id: ev.stream_id, topic_name: ev.topic_name, visibility_policy: ev.visibility_policy, last_updated: ev.last_updated };
        st.userTopics.set(st.topicKey(ev.stream_id, ev.topic_name), t);
        this.noteTopic(ev.stream_id, ev.topic_name, 0, 0);
        this.emitTopic(ev.stream_id, ev.topic_name);
        return;
      }
      case 'muted_user':
      case 'muted_users':
        st.mutedUsers = new Set((ev.muted_users ?? []).map((m: any) => m.id));
        this.link.emit({ t: 'ignored', identities: [...st.mutedUsers].map((u) => this.ids.user(u)) });
        return;
      case 'presence': {
        for (const [id, p] of Object.entries<any>(ev.presences ?? (ev.user_id ? { [ev.user_id]: ev.presence } : {}))) {
          const uid = Number(id);
          const cur = st.presence.get(uid);
          const next = presenceTimes(p);
          // A legacy event says only the client that changed: keep the later of each time.
          st.presence.set(uid, { active: Math.max(next.active, cur?.active ?? 0), idle: Math.max(next.idle, cur?.idle ?? 0) });
          this.presenceOf(uid);
        }
        return;
      }
      case 'user_status': {
        const cur = st.status.get(ev.user_id) ?? {};
        const next = { ...cur, ...(ev.status_text !== undefined ? { status_text: ev.status_text } : {}), ...(ev.emoji_name !== undefined ? { emoji_name: ev.emoji_name, emoji_code: ev.emoji_code, reaction_type: ev.reaction_type } : {}), ...(ev.away !== undefined ? { away: ev.away } : {}) };
        st.status.set(ev.user_id, next);
        const emoji = next.emoji_name ? (next.reaction_type === 'unicode_emoji' && next.emoji_code ? keyOf({ emoji_code: next.emoji_code, reaction_type: 'unicode_emoji' }) : `:${next.emoji_name}:`) : undefined;
        this.ensureIdentity(ev.user_id);
        this.link.emit({ t: 'customStatus', who: this.ids.user(ev.user_id), ...(next.status_text ? { text: next.status_text } : {}), ...(emoji ? { emoji } : {}), ts: Date.now() });
        if (ev.user_id === st.self) this.emitSelfState();
        return;
      }
      case 'submessage': {
        const m = st.message(ev.message_id);
        const sub: Submessage = { id: ev.submessage_id, message_id: ev.message_id, sender_id: ev.sender_id, msg_type: ev.msg_type, content: ev.content };
        if (m) m.submessages = [...(m.submessages ?? []), sub];
        let w = st.widgets.get(ev.message_id);
        if (!w && m) {
          w = fold(m.submessages ?? []) ?? undefined;
          if (w) st.widgets.set(m.id, w);
          if (w && m) this.emitMessage(m, { live: false });
          return;
        }
        if (!w || !apply(w, sub)) return;
        if (!m) return;
        if (w.kind === 'poll') {
          const f = pollFact(w, st.self);
          this.link.emit({ t: 'pollUpdate', conversation: this.convOf(m), message: this.ids.message(m.id), counts: f.counts, voters: f.voters, mine: f.mine, ts: Date.now() } as P.AdapterEvent);
          this.emitMessage(m, { live: false });
        } else this.emitMessage(m, { live: false });
        return;
      }
      case 'scheduled_messages': {
        if (ev.op === 'add') for (const s of ev.scheduled_messages ?? []) st.scheduled.set(s.scheduled_message_id, s);
        else if (ev.op === 'update' && ev.scheduled_message) st.scheduled.set(ev.scheduled_message.scheduled_message_id, ev.scheduled_message);
        else if (ev.op === 'remove') st.scheduled.delete(ev.scheduled_message_id);
        return;
      }
      case 'reminders': {
        if (ev.op === 'add') for (const s of ev.reminders ?? []) st.reminders.set(s.reminder_id, s);
        else if (ev.op === 'remove') st.reminders.delete(ev.reminder_id);
        await this.learnReminderTargets();
        this.link.emit({ t: 'saved', saved: this.savedFacts(), complete: true });
        return;
      }
      case 'custom_profile_fields':
        about.forgetFields(this);
        return;
      case 'user_settings':
        if (ev.property === 'presence_enabled') {
          st.presenceEnabled = !!ev.value;
          this.emitSelfState();
        }
        return;
      case 'restart':
        return;
      default:
        return;
    }
  }

  private async onUpdate(ev: any) {
    const st = this.st;
    const ids: number[] = ev.message_ids ?? (ev.message_id ? [ev.message_id] : []);
    const moved = ev.orig_subject !== undefined || (ev.new_stream_id !== undefined && ev.new_stream_id !== ev.stream_id);
    // A content edit: the one message, its words now.
    if (ev.content !== undefined && ev.message_id) {
      const m = st.message(ev.message_id) ?? (await this.fetchMessages([ev.message_id]))[0];
      if (m) {
        m.content = ev.content;
        // Zulip works the mentions out again for the new words.
        if (Array.isArray(ev.flags)) m.flags = ev.flags;
        m.last_edit_timestamp = ev.edit_timestamp ?? Math.floor(Date.now() / 1000);
        st.remember(m);
        // A widget message keeps its state; a poll's text does not change by editing.
        this.emitMessage(m, { live: false });
        // A mention added or taken out by the edit changes an unread message's count.
        if (Array.isArray(ev.flags) && st.unread.has(m.id)) {
          const mentions = ev.flags.some((f: string) => f === 'mentioned' || f.endsWith('wildcard_mentioned'));
          if (mentions !== st.unreadMentions.has(m.id)) {
            if (mentions) st.unreadMentions.add(m.id);
            else st.unreadMentions.delete(m.id);
            this.emitRead(this.convOf(m));
          }
        }
      }
    }
    if (!moved) return;
    const toStream: number = ev.new_stream_id ?? ev.stream_id;
    const toTopic: string = ev.subject ?? ev.orig_subject;
    const fromConv = this.ids.topic(ev.stream_id, ev.orig_subject ?? ev.subject ?? '');
    const toConv = this.ids.topic(toStream, toTopic);
    this.noteTopic(toStream, toTopic, 0, 0);
    // A rename is the topic's new spelling, a change of case too (its id stays the same).
    const info = st.topics.get(toConv);
    if (info) info.name = toTopic;
    // Resolving or unresolving a topic renames it by its ✔ only: Zulip does not count that as moving its messages.
    const bare = (t: string | undefined) => (t?.startsWith(RESOLVED) ? t.slice(RESOLVED.length) : t);
    const resolving = toStream === ev.stream_id && ev.orig_subject !== undefined && bare(ev.orig_subject) === bare(toTopic) && ev.orig_subject !== toTopic;
    const known = ids.map((id) => st.message(id)).filter((m): m is ZMessage => !!m);
    const missing = ids.filter((id) => !st.message(id));
    const fetched = missing.length ? await this.fetchMessages(missing) : [];
    for (const m of [...known, ...fetched].sort((a, b) => a.id - b.id)) {
      m.stream_id = toStream;
      m.subject = toTopic;
      if (!resolving) m.last_moved_timestamp = ev.edit_timestamp;
      if (ev.new_stream_id !== undefined) m.display_recipient = st.streams.get(toStream)?.name ?? m.display_recipient;
      st.remember(m);
      if (st.unread.has(m.id)) st.unread.set(m.id, this.convOf(m));
      this.emitMessage(m, { live: false, moved: true });
    }
    this.emitTopic(toStream, toTopic);
    this.emitRead(fromConv);
    this.emitRead(this.ids.topic(toStream, toTopic));
    // Every message of the topic moved: it is gone from Zulip, and from here.
    if (ev.propagate_mode === 'change_all' && fromConv !== toConv) {
      st.topics.delete(fromConv);
      this.link.emit({ t: 'leave', kind: 'conversation', nativeId: fromConv });
    }
  }

  private onSubscription(ev: any) {
    const st = this.st;
    if (ev.op === 'peer_add' || ev.op === 'peer_remove') {
      for (const id of ev.stream_ids ?? []) about.forgetSubscribers(this, id);
      return;
    }
    if (ev.op === 'add') {
      for (const s of ev.subscriptions ?? []) {
        st.subs.set(s.stream_id, s);
        st.putStream(s);
        this.emitConv(this.channelFact(s));
      }
    } else if (ev.op === 'remove') {
      for (const s of ev.subscriptions ?? []) {
        st.subs.delete(s.stream_id);
        this.link.emit({ t: 'leave', kind: 'conversation', nativeId: this.ids.channel(s.stream_id) });
        for (const [cid, t] of st.topics) if (t.stream === s.stream_id) this.link.emit({ t: 'leave', kind: 'conversation', nativeId: cid });
      }
    } else if (ev.op === 'update') {
      const s = st.subs.get(ev.stream_id);
      if (!s) return;
      (s as any)[ev.property] = ev.value;
      if (ev.property === 'in_home_view') s.is_muted = !ev.value;
      this.emitConv(this.channelFact(s));
      // A channel's mute is its topics' too, unless a topic says otherwise.
      if (ev.property === 'is_muted' || ev.property === 'in_home_view') for (const t of st.topics.values()) if (t.stream === s.stream_id) this.emitTopic(t.stream, t.name);
    }
  }

  private onStream(ev: any) {
    const st = this.st;
    if (ev.op === 'create') for (const s of ev.streams ?? []) st.putStream(s);
    else if (ev.op === 'delete') {
      for (const s of ev.streams ?? []) {
        const id = s.stream_id ?? s;
        const cur = st.streams.get(id);
        if (cur) cur.is_archived = true;
        if (st.subs.has(id)) {
          const sub = st.subs.get(id)!;
          sub.is_archived = true;
          this.emitConv(this.channelFact(sub));
        }
      }
    } else if (ev.op === 'update') {
      const s = st.streams.get(ev.stream_id);
      if (s) {
        const patch: any = { [ev.property]: ev.value };
        if (ev.property === 'invite_only' && ev.history_public_to_subscribers !== undefined) patch.history_public_to_subscribers = ev.history_public_to_subscribers;
        st.putStream({ ...s, ...patch });
        const sub = st.subs.get(ev.stream_id);
        if (sub) {
          Object.assign(sub, patch);
          this.emitConv(this.channelFact(sub));
          if (ev.property === 'name') for (const t of st.topics.values()) if (t.stream === sub.stream_id) this.emitTopic(t.stream, t.name);
        }
      }
    }
  }

  // ---------------------------------------------------------------- facts

  mdCtx(): MdCtx {
    const st = this.st;
    return {
      ids: this.ids,
      base: this.base,
      user: (id) => st.users.get(id),
      userByName: (n) => st.userByName(n),
      streamName: (id) => st.streams.get(id)?.name,
      streamByName: (n) => st.streamByName(n),
      emoji: (n) => this.emoji.char(n),
      emojiName: (c) => this.emoji.name(c),
      groupByName: (n) => {
        for (const g of st.groups.values()) if (!g.deactivated && g.name.toLowerCase() === n.toLowerCase()) return `${this.ids.host}/g/${g.id}`;
        return undefined;
      },
      group: (id) => {
        const m = id.match(/\/g\/(\d+)$/);
        return m ? st.groups.get(Number(m[1]))?.name : undefined;
      },
    };
  }

  /**
   * The address someone signs in with, where this account may see it. The API's `email` is often a stand-in
   * (`user9@chat.example.org`, when the organization keeps addresses from members): no handle at all then.
   */
  handleOf(u: ZUser): string | undefined {
    if (u.delivery_email) return u.delivery_email;
    return /^user\d+@/.test(u.email) && u.email.startsWith(`user${u.user_id}@`) ? undefined : u.email || undefined;
  }

  identity(u: ZUser): P.IdentityFact {
    const handle = this.handleOf(u);
    return {
      nativeId: this.ids.user(u.user_id),
      ...(handle ? { handle } : {}),
      displayName: u.full_name,
      ...(u.avatar_url ? { avatarUrl: mediaUrl(u.avatar_url, this.base) } : {}),
      ...(u.is_bot ? { isBot: true } : {}),
      ...(u.user_id === this.st.self ? { isSelf: true } : {}),
      // Everyone in the organization is someone you can write to: Zulip's people are all "contacts".
      contact: true,
    };
  }

  // ---------------------------------------------------------------- presence, receipts, groups

  /**
   * Others' presence. Zulip says when someone becomes active, never when they go idle or offline: its clients work
   * that out from the times, after `offlineMs`. So a timer looks every PRESENCE_SWEEP_MS and says each change.
   * At start (`all`), everyone Zulip has a presence for and the hub knows is said once, offline too, so nobody stays
   * online in the hub from before.
   */
  private presenceSweep(all = false) {
    if (!all && !this.presencePolling && Date.now() - this.presencePolledAt >= this.st.pingMs) void this.refreshPresence();
    for (const uid of this.st.presence.keys()) this.presenceOf(uid, all);
    if (!this.presenceTimer && !this.stopped) {
      this.presenceTimer = setInterval(() => this.presenceSweep(), PRESENCE_SWEEP_MS);
      (this.presenceTimer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Everyone's presence times as the server has them now (`GET /realm/presence`), as Zulip's own apps read them once
   * a ping interval: its event says only who came online, so without this someone active for a while would age to
   * idle here. Reading them does not change your own presence. One request a ping interval (60 s).
   */
  async refreshPresence() {
    this.presencePolling = true;
    this.presencePolledAt = Date.now();
    try {
      const r = await this.api.get('/realm/presence');
      const byEmail = new Map<string, number>();
      for (const u of this.st.users.values()) if (u.email) byEmail.set(u.email.toLowerCase(), u.user_id);
      for (const [key, p] of Object.entries<any>(r.presences ?? {})) {
        const uid = /^\d+$/.test(key) ? Number(key) : byEmail.get(key.toLowerCase());
        if (uid === undefined) continue;
        const cur = this.st.presence.get(uid);
        const next = presenceTimes(p);
        this.st.presence.set(uid, { active: Math.max(next.active, cur?.active ?? 0), idle: Math.max(next.idle, cur?.idle ?? 0) });
        this.presenceOf(uid);
      }
    } catch (e) {
      this.link.log('warn', `zulip: presence: ${(e as Error).message}`);
    } finally {
      this.presencePolling = false;
    }
  }

  private presenceOf(uid: number, force = false) {
    if (uid === this.st.self || !this.emitted.has(this.ids.user(uid))) return;
    const p = this.st.presence.get(uid);
    if (!p) return;
    const now = Date.now();
    const state = now - p.active < this.st.offlineMs ? 'online' : now - p.idle < this.st.offlineMs ? 'idle' : 'offline';
    if (!force && this.presenceShown.get(uid) === state) return;
    this.presenceShown.set(uid, state);
    this.link.emit({ t: 'presence', who: this.ids.user(uid), state, ts: now });
  }

  /** A message in a DM: yours is watched for who reads it, and someone else's there asks about yours soon. */
  private watchReceipts(m: ZMessage) {
    if (m.type === 'stream' || !Array.isArray(m.display_recipient)) return;
    const conv = this.convOf(m);
    if (m.sender_id === this.st.self) {
      const others = m.display_recipient.map((r) => r.id).filter((u) => u !== this.st.self);
      this.receipts.sent(conv, m.id, others, msOf(m));
    } else this.receipts.nudge(conv, m.sender_id);
  }

  /** At start: your newest message in each DM, if it is the newest there and recent, is asked about once now. */
  private watchOwnAtStart() {
    const now = Date.now();
    for (const [conv, n] of this.st.newest) {
      const m = this.st.message(n.id);
      if (!m || m.type === 'stream' || m.sender_id !== this.st.self || !Array.isArray(m.display_recipient)) continue;
      if (now - msOf(m) > START_WINDOW_MS) continue;
      this.receipts.sent(conv, m.id, m.display_recipient.map((r) => r.id).filter((u) => u !== this.st.self), msOf(m), true);
    }
  }

  /** People added to or taken out of a user group: the hub logs it as a role given or lost (Discord's roles). */
  private groupChanged(g: { id: number; name: string; is_system_group?: boolean; deactivated?: boolean }, users: number[], given: boolean) {
    // A system group (role:administrators...) changes with a role, which realm_user says.
    if (g.is_system_group || g.deactivated) return;
    for (const u of users) {
      this.ensureIdentity(u);
      this.link.emit({ t: 'role', target: { kind: 'space', nativeId: this.ids.space }, member: this.ids.user(u), role: g.name, given, ts: Date.now() });
    }
  }

  ensureIdentity(id: number | undefined, fallback?: { full_name?: string; email?: string }) {
    if (id === undefined || id === null) return;
    const nid = this.ids.user(id);
    if (this.emitted.has(nid)) return;
    const u = this.st.users.get(id) ?? (fallback ? { user_id: id, email: fallback.email ?? '', full_name: fallback.full_name ?? `User ${id}` } : undefined);
    if (!u) return;
    this.emitted.add(nid);
    this.link.emit({ t: 'identity', identity: this.identity(u) });
  }

  orgFact(): P.SpaceFact {
    const r = this.st.realm;
    return { nativeId: this.ids.space, kind: 'community', name: r.name || this.ids.host, topic: r.description, ...(r.icon ? { iconUrl: mediaUrl(r.icon, this.base) } : {}) };
  }

  private folderFact(f: { id: number; name: string; description?: string; order?: number }): P.SpaceFact {
    return { nativeId: this.ids.folder(f.id), kind: 'section', name: f.name, ...(f.description ? { topic: f.description } : {}), parents: [{ nativeId: this.ids.space, position: String(f.order ?? f.id).padStart(6, '0') }] };
  }

  private spacesOf(s: ZStream): P.SpaceRef[] {
    const f = s.folder_id ? this.st.folders.get(s.folder_id) : undefined;
    return f && !f.is_archived ? [{ nativeId: this.ids.folder(f.id) }] : [{ nativeId: this.ids.space }];
  }

  channelFact(s: ZSub): P.ConversationFact {
    const newest = this.st.newest.get(this.ids.channel(s.stream_id));
    return {
      nativeId: this.ids.channel(s.stream_id),
      shape: 'channel',
      variant: 'forum',
      name: s.name,
      // Its description as words: Zulip writes it in Markdown, and a topic line shows text.
      ...(s.description ? { topic: plainText(s.description) } : {}),
      spaces: this.spacesOf(s),
      archived: !!s.is_archived,
      mute: s.is_muted || s.in_home_view === false ? { muted: true } : {},
      forum: { tags: [], sort: 'activity', layout: 'list' },
      ...(newest ? { lastMessageAt: newest.ts } : {}),
    };
  }

  topicName(t: TopicInfo | undefined, raw?: string) {
    const n = t?.name ?? raw ?? '';
    return n === '' ? 'general chat' : n;
  }

  topicFact(stream: number, topic: string): P.ConversationFact | null {
    const s = this.st.streams.get(stream);
    if (!s) return null;
    const id = this.ids.topic(stream, topic);
    const t = this.st.topics.get(id);
    const ut = this.st.userTopics.get(this.st.topicKey(stream, topic));
    const sub = this.st.subs.get(stream);
    const policy = ut?.visibility_policy ?? 0;
    const channelMuted = !!(sub?.is_muted || sub?.in_home_view === false);
    const muted = policy === 1 || (channelMuted && policy === 0);
    const name = this.topicName(t, topic);
    return {
      nativeId: id,
      shape: 'thread',
      variant: 'text',
      name,
      // A thread is placed by its parent, not in a space of its own (else every topic is a channel of the organization).
      parentConversation: this.ids.channel(stream),
      // A resolved topic (Zulip's ✔) reads as archived: done, kept, still open to write in.
      archived: name.startsWith(RESOLVED),
      mute: muted ? { muted: true } : policy === 3 || policy === 2 ? { level: 'all' } : {},
      thread: { joined: policy === 3, ...(policy === 3 ? { notify: 'all' as const } : policy === 1 ? { muted: true } : {}) },
      ...(t?.lastTs ? { lastMessageAt: t.lastTs } : {}),
    };
  }

  dmFact(users: number[]): P.ConversationFact {
    const self = this.st.self;
    const all = [...new Set([...users, self])].sort((a, b) => a - b);
    const others = all.filter((u) => u !== self);
    for (const u of all) this.ensureIdentity(u);
    const id = this.ids.dm(all);
    const newest = this.st.newest.get(id);
    return {
      nativeId: id,
      shape: others.length === 0 ? 'self' : others.length === 1 ? 'direct' : 'group',
      participants: all.map((u) => this.ids.user(u)),
      ...(newest ? { lastMessageAt: newest.ts } : {}),
    };
  }

  noteTopic(stream: number, topic: string, id: number, ts: number) {
    const cid = this.ids.topic(stream, topic);
    const cur = this.st.topics.get(cid);
    // In ms as the message's own (msOf), so the topic's last message time is its newest message's.
    const ms = ts ? msOf({ id, timestamp: ts }) : 0;
    if (!cur) this.st.topics.set(cid, { stream, name: topic, maxId: id, lastTs: ms });
    else if (id >= cur.maxId) {
      cur.maxId = id;
      cur.name = id ? topic : cur.name;
      if (ts) cur.lastTs = ms;
    }
  }

  emitTopic(stream: number, topic: string) {
    const f = this.topicFact(stream, topic);
    if (!f) return;
    // A channel this account is not in (one it left, read through its old messages or a search) is said too, so the
    // topic has its parent; the hub then offers to join it.
    const s = this.st.streams.get(stream);
    if (s && !this.st.subs.has(stream)) this.emitConv(this.channelFact(s));
    this.emitConv(f);
  }

  /** A conversation fact, unless the hub has just been told exactly this one. */
  emitConv(f: P.ConversationFact) {
    const sig = JSON.stringify(f);
    if (this.convSigs.get(f.nativeId) === sig) return;
    this.convSigs.set(f.nativeId, sig);
    this.link.emit({ t: 'conversation', conversation: f });
  }

  /** The organization, folders, channels, topics known and recent direct conversations. */
  emitStructure() {
    const st = this.st;
    this.link.emit({ t: 'space', space: this.orgFact() });
    for (const f of st.folders.values()) if (!f.is_archived) this.link.emit({ t: 'space', space: this.folderFact(f) });
    const self = st.users.get(st.self);
    if (self) this.ensureIdentity(self.user_id);
    for (const s of st.subs.values()) this.emitConv(this.channelFact(s));
    for (const t of st.topics.values()) if (st.subs.has(t.stream)) this.emitTopic(t.stream, t.name);
    for (const key of st.recentDms.keys()) this.emitConv(this.dmFact(key ? key.split(',').map(Number) : []));
  }

  convOf(m: ZMessage): string {
    if (m.type === 'stream') return this.ids.topic(m.stream_id!, m.subject ?? '');
    const users = Array.isArray(m.display_recipient) ? m.display_recipient.map((r) => r.id) : [];
    return this.ids.dm([...users, this.st.self]);
  }

  private async convOfId(id: number): Promise<string | null> {
    const [m] = await this.fetchMessages([id]);
    return m ? this.convOf(m) : null;
  }

  async fetchMessages(ids: number[]): Promise<ZMessage[]> {
    if (!ids.length) return [];
    const out: ZMessage[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const r = await this.api.get('/messages', { message_ids: ids.slice(i, i + 100), apply_markdown: false, allow_empty_topic_name: true });
      out.push(...(r.messages ?? []));
    }
    for (const m of out) this.st.remember(m);
    return out;
  }

  private async learnTimes(ids: number[]) {
    for (const m of await this.fetchMessages(ids)) this.st.ts.set(m.id, msOf(m));
  }

  /** A message as facts: its conversation (and topic, channel, people) first, then the message. */
  emitMessage(m: ZMessage, o: { live: boolean; late?: boolean; moved?: boolean }) {
    const st = this.st;
    st.remember(m);
    const conv = this.convOf(m);
    const ts = msOf(m);
    st.ts.set(m.id, ts);
    const prev = st.newest.get(conv);
    if (!prev || m.id >= prev.id) st.newest.set(conv, { id: m.id, ts });
    if (m.type === 'stream') {
      const ch = this.ids.channel(m.stream_id!);
      const pc = st.newest.get(ch);
      if (!pc || m.id >= pc.id) st.newest.set(ch, { id: m.id, ts });
      this.noteTopic(m.stream_id!, m.subject ?? '', m.id, m.timestamp);
      if (!st.streams.has(m.stream_id!) && typeof m.display_recipient === 'string') st.putStream({ stream_id: m.stream_id!, name: m.display_recipient, description: '', invite_only: false });
      this.emitTopic(m.stream_id!, m.subject ?? '');
    } else {
      const users = Array.isArray(m.display_recipient) ? m.display_recipient : [];
      for (const r of users) this.ensureIdentity(r.id, r);
      const key = users.map((r) => r.id).filter((u) => u !== st.self).sort((a, b) => a - b).join(',');
      const cur = st.recentDms.get(key);
      if (cur === undefined || m.id > cur) st.recentDms.set(key, m.id);
      if (!this.emitted.has(conv) || cur === undefined || m.id > cur) {
        this.emitted.add(conv);
        this.emitConv(this.dmFact(users.map((r) => r.id)));
      }
    }
    this.ensureIdentity(m.sender_id, { full_name: m.sender_full_name, email: m.sender_email });
    const fact = this.messageFact(m);
    if (o.moved) fact.moved = true;
    this.link.emit({ t: 'message', message: fact, live: o.live, ...(o.late ? { late: true } : {}) });
  }

  messageFact(m: ZMessage): P.MessageFact {
    const st = this.st;
    const flags = m.flags ?? [];
    const parsed = fromZulip(m.content, this.mdCtx());
    for (const id of parsed.mentioned) {
      const uid = this.ids.userId(id);
      if (uid !== null) this.ensureIdentity(uid);
    }
    let body = parsed.body;
    let kind: P.MessageKind = parsed.attachments.length && !body ? 'media' : 'text';
    const extra: Record<string, unknown> = {};
    // The user groups it names, so the app can say their names (rich.roles, as Discord's roles).
    const roles = [...new Set([...body.matchAll(/<@&([^>\s]+)>/g)].map((x) => x[1]!))].flatMap((id) => {
      const g = st.groups.get(Number(id.split('/g/')[1]));
      return g ? [{ id, name: g.name }] : [];
    });
    if (roles.length) extra.roles = roles;
    let w = st.widgets.get(m.id);
    if (!w && m.submessages?.length) {
      w = fold(m.submessages) ?? undefined;
      if (w) st.widgets.set(m.id, w);
    }
    if (w?.kind === 'poll') {
      extra.poll = pollFact(w, st.self);
      body = w.question;
    } else if (w?.kind === 'todo') body = todoBody(w);
    if (m.is_me_message) body = `*${m.sender_full_name ?? st.users.get(m.sender_id)?.full_name ?? ''}* ${body.replace(/^\/me\s*/, '')}`;
    if (m.client === 'Internal' || (st.users.get(m.sender_id)?.is_bot && st.users.get(m.sender_id)?.bot_type === null && m.sender_email?.startsWith('notification-bot'))) kind = 'system';
    // When it was last moved to another topic or channel (Zulip 10+): the app marks it "moved" (protocol extra.ts movedAt).
    if (m.last_moved_timestamp) extra.movedAt = m.last_moved_timestamp * 1000;
    const reactions = new Map<string, P.ReactionFact>();
    for (const r of m.reactions ?? []) {
      const key = keyOf(r);
      this.ensureIdentity(r.user_id);
      const f = reactions.get(key) ?? { key, authors: [], ...(customOf(r, this.emoji, this.base) ? { emoji: customOf(r, this.emoji, this.base) } : {}) };
      f.authors.push(this.ids.user(r.user_id));
      reactions.set(key, f);
    }
    const mentionsSelf = flags.some((f) => f === 'mentioned' || f.endsWith('wildcard_mentioned') || f === 'has_alert_word');
    const mentionsAll = mentionsSelf && !flags.includes('mentioned') && flags.some((f) => f.endsWith('wildcard_mentioned'));
    return {
      nativeId: this.ids.message(m.id),
      conversation: this.convOf(m),
      author: this.ids.user(m.sender_id),
      ts: msOf(m),
      ...(m.last_edit_timestamp ? { editedTs: m.last_edit_timestamp * 1000 } : {}),
      kind,
      body,
      ...(parsed.replyTo ? { replyTo: parsed.replyTo } : {}),
      ...(mentionsSelf ? { mentionsSelf: true } : {}),
      ...(mentionsAll ? { mentionsAll: true } : {}),
      ...(parsed.attachments.length ? { attachments: parsed.attachments } : {}),
      reactions: [...reactions.values()],
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  }

  // ---------------------------------------------------------------- reading state

  /** A conversation's read point: just before its oldest unread message, or its newest message when none is unread. */
  emitRead(conv: string, manual = false) {
    const st = this.st;
    let oldest = Infinity;
    let unread = 0;
    let mentions = 0;
    for (const [id, c] of st.unread) {
      if (c !== conv) continue;
      unread++;
      if (st.unreadMentions.has(id)) mentions++;
      const t = st.ts.get(id);
      if (t !== undefined && t < oldest) oldest = t;
    }
    const newest = st.newest.get(conv);
    const upToTs = unread ? (Number.isFinite(oldest) ? oldest - 1 : 0) : (newest?.ts ?? 0);
    if (!upToTs && !unread) return;
    this.link.emit({ t: 'read', conversation: conv, upToTs, unread, mentions, ...(manual ? { manual: true } : {}) });
  }

  emitReads() {
    const convs = new Set<string>([...this.st.newest.keys()].filter((c) => !/\/s\/\d+$/.test(c)));
    for (const c of this.st.unread.values()) convs.add(c);
    for (const c of convs) this.emitRead(c);
  }

  savedFacts(): P.SavedFact[] {
    const st = this.st;
    const out: P.SavedFact[] = [];
    for (const id of st.starred) {
      const m = st.message(id);
      out.push({ message: this.ids.message(id), savedAt: 0, ...(m ? { conversation: this.convOf(m) } : {}) });
    }
    for (const r of st.reminders.values()) {
      const target = Number(r.reminder_target_message_id);
      if (!target) continue;
      const m = st.message(target);
      out.push({ message: this.ids.message(target), savedAt: 0, dueAt: Number(r.scheduled_delivery_timestamp) * 1000, ...(r.content ? { note: String(r.content).slice(0, 200) } : {}), ...(m ? { conversation: this.convOf(m) } : {}) });
    }
    return out;
  }

  private emitSelfState() {
    this.link.emit({ t: 'selfState', state: { presence: this.ownPresence() } });
  }

  // ---------------------------------------------------------------- places

  /**
   * The messages reminders are on, where they are older than what was read: a reminder always names its conversation
   * (SavedFact), and only the message says which that is.
   */
  private async learnReminderTargets() {
    const st = this.st;
    const missing = [...new Set([...st.reminders.values()].map((r) => Number(r.reminder_target_message_id)).filter((id) => id && !st.message(id)))].slice(0, 100);
    if (!missing.length) return;
    try {
      const r = await this.api.get('/messages', { message_ids: missing, apply_markdown: false, allow_empty_topic_name: true });
      for (const m of (r.messages ?? []) as ZMessage[]) st.remember(m);
    } catch (e) {
      this.link.log('warn', `zulip: the messages of ${missing.length} reminders: ${(e as Error).message}`);
    }
  }

  /** The place a conversation id names, checked: a channel this account is in, a topic of one, or a DM. */
  place(conv: string): Place {
    const p = this.ids.place(conv);
    if (!p) throw new RefusalError('Not a conversation on this Zulip server', 404);
    if (p.kind !== 'dm' && !this.st.streams.has(p.stream)) throw new RefusalError('That channel is not known here', 404);
    return p;
  }

  /**
   * A topic not seen since start: its name as Zulip spells it, from its newest message (a topic narrow matches any
   * case), so what is sent there does not rename it to the lower case of its id.
   */
  private async knowTopic(conv: string) {
    const p = this.ids.place(conv);
    if (!p || p.kind !== 'topic' || this.st.topics.has(conv) || !this.st.streams.has(p.stream)) return;
    try {
      // The id leaves out a resolved topic's ✔: try the name as it is, then resolved.
      let m: ZMessage | undefined;
      for (const name of [p.topic, RESOLVED + p.topic]) {
        const r = await this.api.get('/messages', { anchor: 'newest', num_before: 1, num_after: 0, narrow: [{ operator: 'channel', operand: p.stream }, { operator: 'topic', operand: name }], apply_markdown: false, allow_empty_topic_name: true });
        m = r.messages?.[0];
        if (m) break;
      }
      if (m?.subject !== undefined) this.noteTopic(p.stream, m.subject, m.id, m.timestamp);
    } catch (e) {
      this.link.log('warn', `zulip: the name of a topic: ${(e as Error).message}`);
    }
  }

  topicOf(p: Place & { kind: 'topic' }): string {
    const t = this.st.topics.get(this.ids.topic(p.stream, p.topic));
    return t?.name ?? p.topic;
  }

  narrowOf(p: Place): object[] {
    if (p.kind === 'channel') return [{ operator: 'channel', operand: p.stream }];
    if (p.kind === 'topic') return [{ operator: 'channel', operand: p.stream }, { operator: 'topic', operand: this.topicOf(p) }];
    const others = p.users.filter((u) => u !== this.st.self);
    return [{ operator: 'dm', operand: others.length ? others : [this.st.self] }];
  }

  /** Where a message goes: Zulip's `type` and `to` (and topic). */
  private target(p: Place): Record<string, unknown> {
    if (p.kind === 'channel') throw new RefusalError('A Zulip channel takes messages in its topics: open a topic, or start one', 400);
    if (p.kind === 'topic') return { type: 'stream', to: p.stream, topic: this.topicOf(p) };
    const others = p.users.filter((u) => u !== this.st.self);
    return { type: 'direct', to: others.length ? others : [this.st.self] };
  }

  private async content(body: string, attachments: P.OutgoingAttachment[] | undefined, replyTo?: string): Promise<string> {
    let text = toZulip(body, this.mdCtx());
    const links: string[] = [];
    for (const a of attachments ?? []) {
      const up = await this.api.upload(a.name, Bun.file(a.path));
      links.push(`[${a.name.replace(/[[\]]/g, '')}](${up.url})`);
    }
    if (links.length) text = [text, ...links].filter(Boolean).join('\n');
    if (replyTo) {
      const id = this.ids.messageId(replyTo);
      const m = id !== null ? (this.st.message(id) ?? (await this.fetchMessages([id]))[0]) : undefined;
      if (m) {
        const where = m.type === 'stream' ? { stream: m.stream_id, streamName: this.st.streams.get(m.stream_id!)?.name, topic: m.subject ?? '' } : { dm: (Array.isArray(m.display_recipient) ? m.display_recipient.map((r) => r.id) : []).sort((a, b) => a - b) };
        text = replyQuote(this.st.users.get(m.sender_id), narrowLink(this.base, where, m.id), m.content) + text;
      }
    }
    return text;
  }

  // ---------------------------------------------------------------- commands

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    if (cmd.t === 'shutdown') return undefined;
    // Signing in again is what an account out of reach or refused needs: an action gets through.
    if (this.phase !== 'online' && cmd.t !== 'fetchMedia' && cmd.t !== 'action') throw new RefusalError(this.problem ?? 'The Zulip account is not connected yet', 503);
    const st = this.st;
    const conv = (cmd as { conversation?: unknown }).conversation;
    if (typeof conv === 'string') await this.knowTopic(conv);
    switch (cmd.t) {
      case 'send': {
        const p = this.place(cmd.conversation);
        const content = await this.content(cmd.body, cmd.attachments, cmd.replyTo);
        if (!content.trim()) throw new RefusalError('Nothing to send', 400);
        const r = await this.api.post('/messages', { ...this.target(p), content, read_by_sender: true });
        return { nativeId: this.ids.message(r.id) };
      }
      case 'edit': {
        const id = this.mid(cmd.message);
        const old = st.message(id) ?? (await this.fetchMessages([id]))[0];
        const next = toZulip(cmd.body, this.mdCtx());
        await this.api.patch(`/messages/${id}`, { content: old ? editedContent(old.content, next) : next });
        return {};
      }
      case 'redact': {
        await this.api.del(`/messages/${this.mid(cmd.message)}`);
        return {};
      }
      case 'react': {
        const r = reactionOf(cmd.key, this.emoji, cmd.emoji);
        if (!r) throw new RefusalError('Zulip has no such emoji', 400);
        const path = `/messages/${this.mid(cmd.message)}/reactions`;
        if (cmd.remove) await this.api.del(path, r);
        else await this.api.post(path, r);
        return {};
      }
      case 'reactionContext': {
        const custom = [...this.emoji.realm.values()]
          .filter((e) => !e.deactivated)
          .map((e) => ({ key: `realm:${e.id}`, name: e.name, url: mediaUrl(e.source_url, this.base) ?? e.source_url, ...(e.still_url ? { animated: true } : {}) }));
        custom.push({ key: 'zulip:zulip', name: 'zulip', url: 'zulip:/static/generated/emoji/images/emoji/unicode/zulip.png' });
        return { canReact: true, custom: [{ id: this.ids.space, name: st.realm.name || this.ids.host, emoji: custom }] } satisfies P.ReactionContext;
      }
      case 'reactors': {
        const id = this.mid(cmd.message);
        const m = st.message(id) ?? (await this.fetchMessages([id]))[0];
        const want = canonicalReactionKey(cmd.key);
        const authors = (m?.reactions ?? []).filter((r) => canonicalReactionKey(keyOf(r)) === want).map((r) => {
          this.ensureIdentity(r.user_id);
          return this.ids.user(r.user_id);
        });
        return { authors };
      }
      case 'markRead':
        await this.markRead(cmd.conversation, cmd.upTo);
        return {};
      case 'markReadMany':
        for (const i of cmd.items) await this.markRead(i.conversation, i.upTo);
        return { marked: cmd.items.length };
      case 'markUnread': {
        const p = this.place(cmd.conversation);
        const from = this.mid(cmd.from);
        await this.api.post('/messages/flags/narrow', { anchor: from, include_anchor: true, num_before: 0, num_after: 5000, narrow: this.narrowOf(p), op: 'remove', flag: 'read' });
        return {};
      }
      case 'typing': {
        const p = this.place(cmd.conversation);
        const op = cmd.stop ? 'stop' : 'start';
        if (p.kind === 'topic') await this.api.post('/typing', { op, type: 'stream', stream_id: p.stream, topic: this.topicOf(p) });
        else if (p.kind === 'dm') {
          const others = p.users.filter((u) => u !== st.self);
          if (others.length) await this.api.post('/typing', { op, type: 'direct', to: others });
        }
        return {};
      }
      case 'history':
        return this.history(cmd);
      case 'search':
        return this.search(cmd);
      case 'fetchMedia': {
        const path = cmd.url.replace(/^zulip:/, '');
        const res = await this.api.fetchFile(path);
        const buf = Buffer.from(await res.arrayBuffer());
        return { mime: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream', base64: buf.toString('base64') };
      }
      case 'openDirect': {
        const uid = this.userOf(cmd.peer);
        const f = this.dmFact([uid]);
        const key = uid === st.self ? '' : String(uid);
        const existed = st.recentDms.has(key);
        this.link.emit({ t: 'conversation', conversation: f });
        return { conversation: f.nativeId, existed, ...(existed ? {} : { startsAtFirstSend: true }) } satisfies P.OpenDirectResult;
      }
      case 'createGroup': {
        const ids = cmd.people.map((p) => this.userOf(p));
        const f = this.dmFact(ids);
        this.link.emit({ t: 'conversation', conversation: f });
        const r: P.CreateGroupResult = { conversation: f.nativeId, added: ids.map((u) => this.ids.user(u)), notes: ['Zulip makes a group conversation with its first message; it has no name of its own.'] };
        return r;
      }
      case 'threads':
        return this.threads(cmd);
      case 'createPost': {
        const p = this.place(cmd.conversation);
        if (p.kind !== 'channel') throw new RefusalError('A new topic starts in a channel', 400);
        const name = cmd.name.trim();
        if (!name) throw new RefusalError('A topic needs a name', 400);
        const content = await this.content(cmd.body, cmd.attachments);
        const sent = await this.api.post('/messages', { type: 'stream', to: p.stream, topic: name, content, read_by_sender: true });
        // The topic as Zulip took it (it cuts a long name), and its first message, before the answer.
        const [first] = await this.fetchMessages([sent.id]);
        const topic = first?.subject ?? name;
        this.noteTopic(p.stream, topic, sent.id, first?.timestamp ?? Math.floor(Date.now() / 1000));
        this.emitTopic(p.stream, topic);
        if (first) this.emitMessage(first, { live: false });
        return { conversation: this.ids.topic(p.stream, topic) };
      }
      case 'followThread': {
        const p = this.topicPlace(cmd.conversation);
        return (await this.setTopicPolicy(p, cmd.follow ? 3 : 0)).thread ?? {};
      }
      case 'threadNotify': {
        // Only what is given changes: unmuting a followed topic keeps it followed.
        const p = this.topicPlace(cmd.conversation);
        const cur = st.userTopics.get(st.topicKey(p.stream, this.topicOf(p)))?.visibility_policy ?? 0;
        const sub = st.subs.get(p.stream);
        const channelMuted = !!(sub?.is_muted || sub?.in_home_view === false);
        let policy = cur;
        if (cmd.notify !== undefined) policy = cmd.notify === 'all' ? 3 : cmd.notify === 'none' ? 1 : cur === 3 || cur === 1 ? 0 : cur;
        if (cmd.muted === true) policy = 1;
        else if (cmd.muted === false && policy === 1) policy = channelMuted ? 2 : 0;
        return (await this.setTopicPolicy(p, policy)).thread ?? {};
      }
      case 'threadState': {
        const p = this.topicPlace(cmd.conversation);
        if (cmd.locked !== undefined) throw new RefusalError('Zulip topics cannot be locked', 400);
        if (cmd.archived !== undefined) {
          const to = await this.resolveTopic(p, cmd.archived);
          if (to) return about.about(this, { kind: 'conversation', nativeId: to });
        }
        return about.about(this, { kind: 'conversation', nativeId: cmd.conversation });
      }
      case 'mute':
        return this.mute(cmd);
      case 'pollVote': {
        const id = this.mid(cmd.message);
        const m = st.message(id) ?? (await this.fetchMessages([id]))[0];
        const w = m ? (st.widgets.get(id) ?? fold(m.submessages ?? [])) : null;
        if (!w || w.kind !== 'poll') throw new RefusalError('That message is not a poll', 400);
        for (const ch of voteChanges(w, st.self, cmd.options)) await this.api.post('/submessage', { message_id: id, msg_type: 'widget', content: JSON.stringify({ type: 'vote', key: ch.key, vote: ch.vote }) });
        return {};
      }
      case 'pollCreate': {
        const p = this.place(cmd.conversation);
        if (!cmd.poll.multi) throw new RefusalError('Zulip polls always take several choices', 400);
        const r = await this.api.post('/messages', { ...this.target(p), content: pollCommand(cmd.poll), read_by_sender: true });
        return { nativeId: this.ids.message(r.id) };
      }
      case 'save': {
        const id = this.mid(cmd.message);
        if (cmd.remove) {
          await this.api.post('/messages/flags', { messages: [id], op: 'remove', flag: 'starred' });
          for (const [rid, r] of st.reminders) if (Number(r.reminder_target_message_id) === id) await this.api.del(`/reminders/${rid}`);
          return {};
        }
        if (cmd.dueAt) await this.api.post('/reminders', { message_id: id, scheduled_delivery_timestamp: Math.floor(cmd.dueAt / 1000) });
        else await this.api.post('/messages/flags', { messages: [id], op: 'add', flag: 'starred' });
        return { message: cmd.message, conversation: cmd.conversation, savedAt: Date.now(), ...(cmd.dueAt ? { dueAt: cmd.dueAt } : {}) } satisfies P.SavedFact;
      }
      case 'savedList': {
        const r = await this.api.get('/messages', { anchor: 'newest', num_before: 100, num_after: 0, narrow: [{ operator: 'is', operand: 'starred' }], apply_markdown: false, allow_empty_topic_name: true });
        for (const m of r.messages ?? []) this.emitMessage(m, { live: false });
        st.starred = new Set([...st.starred, ...(r.messages ?? []).map((m: ZMessage) => m.id)]);
        const saved = this.savedFacts();
        this.link.emit({ t: 'saved', saved, complete: true });
        // One page of the newest starred: Zulip has no time a message was starred to page by.
        return { saved, more: !r.found_oldest } satisfies P.SavedListResult;
      }
      case 'nativeScheduled': {
        const r = await this.api.get('/scheduled_messages');
        st.scheduled.clear();
        for (const s of r.scheduled_messages ?? []) st.scheduled.set(s.scheduled_message_id, s);
        const scheduled: P.NativeScheduledFact[] = [...st.scheduled.values()].map((s) => ({
          nativeId: String(s.scheduled_message_id),
          conversation: s.type === 'stream' ? this.ids.topic(s.to, s.topic ?? '') : this.ids.dm([...(s.to ?? []), st.self]),
          body: fromZulip(s.content ?? '', this.mdCtx()).body,
          dueAt: Number(s.scheduled_delivery_timestamp) * 1000,
        }));
        return { enabled: true, scheduled } satisfies P.NativeScheduledResult;
      }
      case 'cancelScheduled':
        await this.api.del(`/scheduled_messages/${Number(cmd.nativeId)}`);
        return {};
      case 'setPresence': {
        const c = cmd.change;
        if (c.state) {
          if (c.state === 'dnd' || c.state === 'idle') throw new RefusalError('Zulip has no Away or Do not disturb any more: it has Invisible, and a status', 400);
          await this.api.patch('/settings', { presence_enabled: c.state !== 'invisible' });
          st.presenceEnabled = c.state !== 'invisible';
        }
        if (c.status !== undefined) {
          const emoji = c.status?.emoji;
          const r = emoji ? (emoji.startsWith(':') ? { emoji_name: emoji.slice(1, -1), reaction_type: 'realm_emoji' } : reactionOf(emoji, this.emoji)) : null;
          await this.api.post('/users/me/status', { status_text: c.status?.text ?? '', ...(r ? r : { emoji_name: '' }) });
          st.status.set(st.self, { ...st.status.get(st.self), status_text: c.status?.text ?? '', ...(r ? r : { emoji_name: '', emoji_code: '', reaction_type: '' }) });
        }
        this.emitSelfState();
        return this.ownPresence();
      }
      case 'ignore': {
        const uid = this.userOf(cmd.identity);
        if (cmd.ignored) await this.api.post(`/users/me/muted_users/${uid}`);
        else await this.api.del(`/users/me/muted_users/${uid}`);
        return { ignored: cmd.ignored };
      }
      case 'walkMembers': {
        const q = cmd.query.toLowerCase();
        const users = [...st.users.values()].filter((u) => u.is_active !== false && (!q || u.full_name.toLowerCase().startsWith(q) || !!this.handleOf(u)?.toLowerCase().startsWith(q))).slice(0, cmd.limit);
        for (const u of users) this.ensureIdentity(u.user_id);
        this.link.emit({ t: 'members', space: this.ids.space, members: users.map((u) => ({ who: this.ids.user(u.user_id), ...(u.date_joined ? { joinedAt: Date.parse(u.date_joined) } : {}), roles: [about.roleName(u.role)] })), source: 'walk', total: [...st.users.values()].filter((u) => u.is_active !== false).length });
        return { count: users.length, total: [...st.users.values()].filter((u) => u.is_active !== false).length } satisfies P.WalkResult;
      }
      case 'mentionables':
        return about.mentionables(this, cmd.conversation, cmd.query, cmd.limit);
      case 'about':
        return about.about(this, cmd.target);
      case 'configure':
        return about.configure(this, cmd.target, cmd.change);
      case 'profile':
        return about.profile(this, cmd.who);
      case 'setProfile':
        return about.setProfile(this, cmd.change);
      case 'leave': {
        const target = (cmd as any).target as P.AboutTarget | undefined;
        const nid = target?.nativeId ?? (cmd as any).conversation;
        const p = this.place(nid);
        if (p.kind === 'dm') throw new RefusalError('Zulip has no leaving a direct conversation', 400);
        const name = st.streams.get(p.stream)!.name;
        await this.api.del('/users/me/subscriptions', { subscriptions: [name] });
        // The leave first (the subscription event says it again later).
        st.subs.delete(p.stream);
        this.link.emit({ t: 'leave', kind: 'conversation', nativeId: this.ids.channel(p.stream) });
        for (const [cid, t] of st.topics) if (t.stream === p.stream) this.link.emit({ t: 'leave', kind: 'conversation', nativeId: cid });
        return { left: true } satisfies P.LeaveResult;
      }
      case 'addMembers': {
        const p = this.place(cmd.target.nativeId);
        if (p.kind === 'dm') throw new RefusalError('Zulip group conversations keep the people they started with: write a new one with everyone', 400);
        const name = st.streams.get(p.stream)!.name;
        const r = await this.api.post('/users/me/subscriptions', { subscriptions: [{ name }], principals: cmd.people.map((x) => this.userOf(x)) });
        about.forgetSubscribers(this, p.stream);
        // Keyed by user id (by email before feature level 214).
        const who = (k: string) => this.ids.user(/^\d+$/.test(k) ? Number(k) : this.userOf(k));
        const added = Object.keys(r.subscribed ?? {}).map(who);
        // Those already in (r.already_subscribed) were in before: not added now.
        return { added, about: await about.about(this, cmd.target) } satisfies P.AddMembersResult;
      }
      case 'resolve':
        return about.resolve(this, cmd.ref);
      case 'add':
        return about.add(this, cmd.ref, cmd.action);
      case 'action':
        return this.action(cmd.action, cmd.args);
      default:
        throw new RefusalError(`Zulip does not do ${cmd.t}`, 400);
    }
  }

  private async action(action: string, args: unknown) {
    if (action === 'resync' || action === 'relogin') {
      if (action === 'relogin') {
        // Signing in again with what the owner typed: a password, or an API key (32 letters and digits). One field
        // takes either: what looks like a key is tried as a key once the password swap refuses it.
        const a = (args ?? {}) as { password?: string; apiKey?: string };
        const secret = this.link.secret<Secret>();
        const typed = a.password?.trim();
        if (a.apiKey?.trim()) this.keep({ email: secret.email, apiKey: a.apiKey.trim() });
        else if (typed) this.link.saveSecret({ email: secret.email, password: a.password, ...(/^[A-Za-z0-9]{32}$/.test(typed) ? { apiKey: typed } : {}) });
        this.creds = null;
      }
      if (this.queue) await this.api.del('/events', { queue_id: this.queue.id }).catch(() => {});
      this.queue = null;
      if (action === 'relogin') void this.run();
      return {};
    }
    throw new RefusalError(`No action ${action}`, 400);
  }

  mid(nativeId: string): number {
    const id = this.ids.messageId(nativeId);
    if (id === null) throw new RefusalError('Not a message on this Zulip server', 404);
    return id;
  }

  userOf(nativeOrEmail: string): number {
    const id = this.ids.userId(nativeOrEmail);
    if (id !== null) return id;
    const s = nativeOrEmail.trim().toLowerCase();
    if (/^\d+$/.test(s) && this.st.users.has(Number(s))) return Number(s);
    for (const u of this.st.users.values()) if (u.email.toLowerCase() === s || u.delivery_email?.toLowerCase() === s) return u.user_id;
    throw new RefusalError('No one with that address in this organization', 404);
  }

  topicPlace(conv: string): Place & { kind: 'topic' } {
    const p = this.place(conv);
    if (p.kind !== 'topic') throw new RefusalError('Not a Zulip topic', 400);
    return p;
  }

  /** Marks everything in a conversation up to a message read, Zulip's way: by narrow, from that message back. */
  private async markRead(conv: string, upTo: string) {
    const p = this.place(conv);
    const id = this.mid(upTo);
    let anchor: number | 'newest' = id;
    for (let i = 0; i < 20; i++) {
      const r: any = await this.api.post('/messages/flags/narrow', { anchor, include_anchor: true, num_before: 1000, num_after: 0, narrow: [...this.narrowOf(p), { operator: 'is', operand: 'unread' }], op: 'add', flag: 'read' });
      if (r.found_oldest || !r.processed_count || !r.first_processed_id) break;
      anchor = r.first_processed_id - 1;
    }
  }

  /** Resolves (✔) or unresolves a topic by renaming it: the renamed topic's id, or null when it already was. */
  private async resolveTopic(p: Place & { kind: 'topic' }, resolved: boolean): Promise<string | null> {
    const name = this.topicOf(p);
    const isResolved = name.startsWith(RESOLVED);
    if (isResolved === resolved) return null;
    const t = this.st.topics.get(this.ids.topic(p.stream, p.topic));
    const r = t?.maxId ? { messages: [{ id: t.maxId }] } : await this.api.get('/messages', { anchor: 'newest', num_before: 1, num_after: 0, narrow: this.narrowOf(p) });
    const mid = r.messages?.[0]?.id;
    if (!mid) throw new RefusalError('That topic has no messages', 404);
    const next = resolved ? `${RESOLVED}${name}` : name.slice(RESOLVED.length);
    await this.api.patch(`/messages/${mid}`, { topic: next, propagate_mode: 'change_all', send_notification_to_old_thread: false, send_notification_to_new_thread: true });
    // The same conversation (its id leaves the ✔ out), now archived: said before the answer, the event says it again.
    const info = this.st.topics.get(this.ids.topic(p.stream, next));
    if (info) info.name = next;
    this.emitTopic(p.stream, next);
    return this.ids.topic(p.stream, next);
  }

  /** Sets a topic's visibility policy (0 inherit, 1 muted, 2 unmuted, 3 followed): its fact first, then what it is. */
  private async setTopicPolicy(p: Place & { kind: 'topic' }, policy: number): Promise<P.ConversationFact> {
    const topic = this.topicOf(p);
    await this.api.post('/user_topics', { stream_id: p.stream, topic, visibility_policy: policy });
    this.st.userTopics.set(this.st.topicKey(p.stream, topic), { stream_id: p.stream, topic_name: topic, visibility_policy: policy, last_updated: Math.floor(Date.now() / 1000) });
    this.emitTopic(p.stream, topic);
    return this.topicFact(p.stream, topic)!;
  }

  ownPresence(): P.OwnPresence {
    const s = this.st.status.get(this.st.self);
    const emoji = s?.emoji_name ? (s.reaction_type === 'unicode_emoji' && s.emoji_code ? keyOf({ emoji_code: s.emoji_code, reaction_type: 'unicode_emoji' }) : `:${s.emoji_name}:`) : undefined;
    return { state: this.st.presenceEnabled ? 'online' : 'invisible', ...(s?.status_text || emoji ? { status: { ...(s?.status_text ? { text: s.status_text } : {}), ...(emoji ? { emoji } : {}) } } : {}) };
  }

  private async mute(cmd: Extract<P.AdapterCommand, { t: 'mute' }>) {
    if (cmd.target.kind === 'space') throw new RefusalError('Zulip mutes channels and topics, not the whole organization', 400);
    const p = this.place(cmd.target.nativeId);
    if (p.kind === 'dm') {
      // Zulip has no muting a conversation; muting the person is the nearest, and too much: refuse.
      throw new RefusalError('Zulip cannot mute a direct conversation, only the person (Ignore)', 400);
    }
    let mute: P.NativeMute | undefined;
    if (p.kind === 'channel') {
      await this.api.post('/users/me/subscriptions/properties', { subscription_data: [{ stream_id: p.stream, property: 'is_muted', value: cmd.muted }] });
      const sub = this.st.subs.get(p.stream);
      if (sub) {
        sub.is_muted = cmd.muted;
        sub.in_home_view = !cmd.muted;
        const f = this.channelFact(sub);
        this.emitConv(f);
        mute = f.mute;
        for (const t of this.st.topics.values()) if (t.stream === p.stream) this.emitTopic(t.stream, t.name);
      }
    } else {
      const sub = this.st.subs.get(p.stream);
      const channelMuted = !!(sub?.is_muted || sub?.in_home_view === false);
      // In a muted channel, "unmute" is Zulip's Unmuted policy; elsewhere, back to inherit.
      mute = (await this.setTopicPolicy(p, cmd.muted ? 1 : channelMuted ? 2 : 0)).mute;
    }
    // Zulip mutes until you unmute: it has no timer.
    return mute ?? {};
  }

  private async history(cmd: Extract<P.AdapterCommand, { t: 'history' }>): Promise<P.HistoryResult> {
    const p = this.place(cmd.conversation);
    const limit = Math.max(1, Math.min(cmd.limit, 1000));
    const q: Record<string, unknown> = { num_before: limit, num_after: 0, narrow: this.narrowOf(p), apply_markdown: false, allow_empty_topic_name: true };
    const cursor = cmd.cursor && /^\d+$/.test(cmd.cursor) ? Number(cmd.cursor) : null;
    if (cursor !== null) Object.assign(q, { anchor: cursor, include_anchor: false });
    else if (cmd.beforeTs && this.st.featureLevel >= 445) {
      // Zulip's times are whole seconds and a message's here has its id's last digits as ms (msOf): ask up to the next
      // whole second, with room for that second's messages, and keep those before the moment.
      const next = Math.ceil(cmd.beforeTs / 1000) * 1000;
      Object.assign(q, { anchor: 'date', anchor_date: new Date(next).toISOString(), include_anchor: false, num_before: limit + SAME_SECOND });
    } else Object.assign(q, { anchor: 'newest' });
    const r = await this.api.get('/messages', q);
    let msgs: ZMessage[] = r.messages ?? [];
    if (cursor === null && cmd.beforeTs) msgs = msgs.filter((m) => msOf(m) < cmd.beforeTs!);
    const cut = msgs.length > limit;
    if (cut) msgs = msgs.slice(-limit);
    for (const m of msgs) this.emitMessage(m, { live: false });
    const oldest = msgs[0];
    return { count: msgs.length, done: !!r.found_oldest && !cut, ...(oldest ? { oldest: msOf(oldest), next: String(oldest.id) } : {}) };
  }

  private async search(cmd: Extract<P.AdapterCommand, { t: 'search' }>): Promise<P.NetworkSearchResult> {
    const q = cmd.query;
    const narrow: object[] = [];
    if (cmd.scope.kind === 'conversation') narrow.push(...this.narrowOf(this.place(cmd.scope.id)));
    if (q.text.trim()) narrow.push({ operator: 'search', operand: q.text.trim() });
    for (const a of q.authors ?? []) narrow.push({ operator: 'sender', operand: this.userOf(a) });
    // Zulip's narrow terms all have to hold, so only one place can narrow it; with several, the hub filters.
    const inPlace = q.in?.length === 1 && cmd.scope.kind !== 'conversation' ? this.ids.place(q.in[0]!) : null;
    if (inPlace) narrow.push(...this.narrowOf(inPlace));
    for (const h of q.has ?? []) {
      const operand = h === 'link' ? 'link' : h === 'image' || h === 'video' ? 'image' : h === 'file' ? 'attachment' : h === 'reaction' ? 'reaction' : null;
      if (operand) narrow.push({ operator: 'has', operand });
    }
    if (q.mentions?.some((m) => this.ids.userId(m) === this.st.self)) narrow.push({ operator: 'is', operand: 'mentioned' });
    const limit = Math.max(1, Math.min(cmd.limit ?? 25, 100));
    const offset = cmd.offset ?? 0;
    const key = JSON.stringify([cmd.scope, q]);
    const anchors = this.searches.get(key) ?? [];
    const oldestFirst = q.sort === 'oldest';
    const anchor = offset === 0 ? (oldestFirst ? 'oldest' : 'newest') : anchors[offset];
    if (offset && anchor === undefined) throw new RefusalError('Search again from the start', 400);
    const r = await this.api.get('/messages', { anchor, include_anchor: offset === 0, num_before: oldestFirst ? 0 : limit, num_after: oldestFirst ? limit : 0, narrow, apply_markdown: false, allow_empty_topic_name: true });
    let msgs: ZMessage[] = r.messages ?? [];
    if (q.after) msgs = msgs.filter((m) => m.timestamp * 1000 >= q.after!);
    if (q.before) msgs = msgs.filter((m) => m.timestamp * 1000 < q.before!);
    // Zulip's narrow can say only "mentions me": anyone else's mentions are read from the words.
    const others = (q.mentions ?? []).filter((m) => this.ids.userId(m) !== this.st.self);
    if (others.length) {
      const ctx = this.mdCtx();
      msgs = msgs.filter((m) => {
        const named = fromZulip(m.content, ctx).mentioned;
        return others.every((o) => named.includes(o));
      });
    }
    for (const m of msgs) this.emitMessage(m, { live: false });
    const ordered = oldestFirst ? msgs : [...msgs].reverse();
    const done = oldestFirst ? r.found_newest : r.found_oldest;
    // A page the dates or mentions filtered empty is not the end: the server's page says that.
    const next = done || !r.messages?.length ? null : offset + r.messages.length;
    if (next !== null) {
      anchors[next] = oldestFirst ? r.messages[r.messages.length - 1].id : r.messages[0].id;
      this.searches.set(key, anchors);
    }
    return { hits: ordered.map((m) => this.ids.message(m.id)), total: null, next };
  }

  private async threads(cmd: Extract<P.AdapterCommand, { t: 'threads' }>): Promise<P.ThreadsResult> {
    const p = this.place(cmd.conversation);
    if (p.kind !== 'channel') throw new RefusalError('Topics are listed for a channel', 400);
    const r = await this.api.get(`/users/me/${p.stream}/topics`, { allow_empty_topic_name: true });
    // Resolved topics (Zulip's ✔) are the archived ones.
    const topics: { name: string; max_id: number }[] = (r.topics ?? []).filter((t: { name: string }) => t.name.startsWith(RESOLVED) === !!cmd.archived);
    const page = topics.slice(cmd.offset, cmd.offset + 50);
    // Their times are their newest messages'.
    const missing = page.filter((t) => !this.st.ts.has(t.max_id)).map((t) => t.max_id);
    const fetched = await this.fetchMessages(missing);
    for (const m of fetched) this.st.ts.set(m.id, msOf(m));
    const out: string[] = [];
    for (const t of page) {
      this.noteTopic(p.stream, t.name, t.max_id, Math.floor((this.st.ts.get(t.max_id) ?? 0) / 1000));
      this.emitTopic(p.stream, t.name);
      out.push(this.ids.topic(p.stream, t.name));
    }
    return { count: page.length, more: cmd.offset + page.length < topics.length, ids: out };
  }

  private laterTopics: number[] = [];

  /** Topics of each channel this account is in (or of the ones given), newest first, as facts: Zulip's sidebar. */
  async topicsAtStart(only?: number[]) {
    for (const s of this.st.subs.values()) {
      if (only && !only.includes(s.stream_id)) continue;
      if (this.stopped) return;
      try {
        const r = await this.api.get(`/users/me/${s.stream_id}/topics`, { allow_empty_topic_name: true });
        const topics: { name: string; max_id: number }[] = (r.topics ?? []).slice(0, START_TOPICS);
        // Each topic's time is its newest message's: those not read yet, in one request.
        const missing = topics.filter((t) => !this.st.ts.has(t.max_id)).map((t) => t.max_id);
        for (const m of missing.length ? await this.fetchMessages(missing) : []) this.st.ts.set(m.id, msOf(m));
        for (const t of topics) {
          this.noteTopic(s.stream_id, t.name, t.max_id, Math.floor((this.st.ts.get(t.max_id) ?? 0) / 1000));
          this.emitTopic(s.stream_id, t.name);
        }
      } catch (e) {
        this.link.log('warn', `zulip: topics of channel ${s.stream_id}: ${(e as Error).message}`);
      }
    }
  }
}

export type { ZSub, ZStream };
