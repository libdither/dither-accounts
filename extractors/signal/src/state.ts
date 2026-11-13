/**
 * Adapter state that signal-cli does not keep for us, in <accountDir>/state.json:
 *
 *   dms       peers we have a 1:1 with (Signal has no conversation list)
 *   index     recent message ids -> conversation, text, quoted message, files:
 *             read syncs and receipts carry no conversation, quotes and edits
 *             want the original, deletions remove the downloaded files; your
 *             own edits' ids point at the message they edit (receipts name them)
 *   unread    incoming messages not yet acknowledged with a read receipt
 *   expiring  disappearing messages and when their timer started
 *   pins      pins that end by themselves, and when
 *   groups    last seen group details, to describe group updates and admin changes
 *   abouts    the About text and emoji last seen for each contact, to tell a change
 *   heard     1:1 peers who wrote to you, and when their first message came: a message request, unless the
 *             conversation is yours (`ours`) or signal-cli says it was accepted (add.ts isMessageRequest)
 *   ours      1:1 peers you wrote to (here or on another device) or whose request you accepted here
 *   invites   groups you are invited to: who invited you (when a group update said) and since when
 *   keys      each person's identity key as last seen (people.ts KnownKey), to tell when their safety number changes
 *   username  your username and its link as updateAccount last said them (signal-cli cannot read the link otherwise)
 *   seenAt    when the daemon was last up and read, to tell a long outage (a sync request follows one)
 *   syncedAt  when a sync request last went to your phone
 *   stories   the owner turned stories on (off unless they did; the daemon reads it when it starts)
 *   storyFiles  files signal-cli downloaded for stories, and when each story ends: deleted then
 *
 * Writes are debounced and atomic (tmp + rename).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { PinTimer, QuoteSource } from './mapping.ts';
import type { KnownKey } from './people.ts';
import type { SigGroup } from './types.ts';

export interface Expiring {
  id: string;
  conversation: string;
  ts: number;
  ttl: number; // seconds
  started?: number; // ms epoch; unset until read
  files?: string[];
}

interface StateFile {
  v: 1;
  dms: string[];
  index: [id: string, entry: IndexEntry][];
  unread: Record<string, [author: string, ts: number][]>;
  expiring: Expiring[];
  pins?: PinTimer[];
  groups: Record<string, SigGroup>;
  abouts?: Record<string, About>;
  heard?: Record<string, number>;
  ours?: string[];
  invites?: Record<string, Invite>;
  keys?: Record<string, KnownKey>;
  username?: { name: string; link?: string } | null;
  seenAt?: number;
  syncedAt?: number;
  stories?: boolean;
  storyFiles?: [path: string, until: number][];
}

/** An invitation to a group: who sent it, when a group update named them, and since when (ms epoch). */
export interface Invite {
  by?: string;
  ts: number;
}

/** Someone's About as last seen: text and emoji, each left out when not set. */
export interface About {
  t?: string;
  e?: string;
}

interface IndexEntry {
  c: string; // conversation
  t: string; // plain text (truncated)
  r?: string; // quoted message id
  f?: string[]; // downloaded attachment files
  o?: string; // the message this edit's id stands for
  q?: QuoteSource; // what a reply to it quotes
}

const INDEX_MAX = 5000;
const TEXT_MAX = 280;
const UNREAD_MAX = 500;

export class AdapterState {
  dms = new Set<string>();
  /** insertion-ordered; oldest first */
  private index = new Map<string, IndexEntry>();
  unread = new Map<string, [string, number][]>();
  expiring: Expiring[] = [];
  pins: PinTimer[] = [];
  groups = new Map<string, SigGroup>();
  abouts = new Map<string, About>();
  heard = new Map<string, number>();
  ours = new Set<string>();
  invites = new Map<string, Invite>();
  keys = new Map<string, KnownKey>();
  username: { name: string; link?: string } | null = null;
  seenAt = 0;
  syncedAt = 0;
  stories = false;
  storyFiles: [path: string, until: number][] = [];
  private timer?: Timer;

  constructor(private path: string) {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) return;
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StateFile>;
      for (const d of s.dms ?? []) this.dms.add(d);
      for (const [id, e] of s.index ?? []) if (e && typeof e === 'object') this.index.set(id, e);
      for (const [c, list] of Object.entries(s.unread ?? {})) this.unread.set(c, list);
      this.expiring = s.expiring ?? [];
      this.pins = s.pins ?? [];
      for (const [id, g] of Object.entries(s.groups ?? {})) this.groups.set(id, g);
      for (const [id, a] of Object.entries(s.abouts ?? {})) this.abouts.set(id, a);
      for (const [id, ts] of Object.entries(s.heard ?? {})) if (typeof ts === 'number') this.heard.set(id, ts);
      for (const id of s.ours ?? []) this.ours.add(id);
      for (const [id, inv] of Object.entries(s.invites ?? {})) if (inv && typeof inv.ts === 'number') this.invites.set(id, inv);
      for (const [id, k] of Object.entries(s.keys ?? {})) if (k && typeof k.f === 'string') this.keys.set(id, k);
      if (s.username?.name) this.username = s.username;
      this.seenAt = typeof s.seenAt === 'number' ? s.seenAt : 0;
      this.syncedAt = typeof s.syncedAt === 'number' ? s.syncedAt : 0;
      this.stories = s.stories === true;
      this.storyFiles = (s.storyFiles ?? []).filter((x) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number');
      // From before message requests were kept: who wrote in a 1:1 and is still unread, as when their first message came.
      if (s.heard === undefined) {
        for (const [c, list] of this.unread) {
          const m = /^dm:([^:]+):([^:]+)$/.exec(c);
          if (!m || m[1] === m[2]) continue;
          const ts = list.filter(([a]) => a === m[2]).map(([, t]) => t);
          if (ts.length) this.heard.set(m[2], Math.min(...ts));
        }
      }
    } catch (e) {
      console.error('[signal] state.json unreadable, starting fresh', e);
    }
  }

  clear() {
    this.dms.clear();
    this.index.clear();
    this.unread.clear();
    this.expiring = [];
    this.pins = [];
    this.groups.clear();
    this.abouts.clear();
    this.heard.clear();
    this.ours.clear();
    this.invites.clear();
    this.keys.clear();
    this.username = null;
    this.seenAt = 0;
    this.syncedAt = 0;
    this.save();
  }

  remember(id: string, conversation: string, text: string, replyTo?: string, files?: string[], quote?: QuoteSource) {
    const prev = this.index.get(id);
    this.index.delete(id);
    const r = replyTo ?? prev?.r;
    const f = files?.length ? files : prev?.f;
    // An edit keeps the files of the message it edits, and a quote of it shows them still.
    const q = quote ? { ...quote, ...(!quote.a && prev?.q?.a ? { a: prev.q.a } : {}) } : prev?.q;
    this.index.set(id, { c: conversation, t: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX - 1) + '…' : text, ...(r ? { r } : {}), ...(f ? { f } : {}), ...(q ? { q } : {}) });
    while (this.index.size > INDEX_MAX) this.index.delete(this.index.keys().next().value!);
    this.save();
  }

  /** Drop a deleted message; returns its downloaded files. */
  forget(id: string): string[] {
    const e = this.index.get(id);
    if (!e) return [];
    this.index.delete(id);
    this.save();
    return e.f ?? [];
  }

  conversationOf(id: string) {
    return this.index.get(id)?.c;
  }

  /** An edit you sent, by its own id: receipts for it count for the message it edits. */
  alias(editId: string, original: string, conversation: string) {
    if (editId === original) return;
    this.index.delete(editId);
    this.index.set(editId, { c: conversation, t: '', o: this.originalOf(original) ?? original });
    while (this.index.size > INDEX_MAX) this.index.delete(this.index.keys().next().value!);
    this.save();
  }

  originalOf(id: string) {
    return this.index.get(id)?.o;
  }

  textOf(id: string) {
    return this.index.get(id)?.t;
  }

  replyOf(id: string) {
    return this.index.get(id)?.r;
  }

  /** What a reply to this message quotes, when this device has seen it since quotes were kept. */
  quoteOf(id: string) {
    return this.index.get(id)?.q;
  }

  addUnread(conversation: string, author: string, ts: number) {
    const list = this.unread.get(conversation) ?? [];
    if (!list.some(([a, t]) => a === author && t === ts)) list.push([author, ts]);
    if (list.length > UNREAD_MAX) list.splice(0, list.length - UNREAD_MAX);
    this.unread.set(conversation, list);
    this.save();
  }

  /** Remove and return unread entries up to `upToTs`. */
  takeUnread(conversation: string, upToTs: number): [string, number][] {
    const list = this.unread.get(conversation) ?? [];
    const taken = list.filter(([, t]) => t <= upToTs);
    const left = list.filter(([, t]) => t > upToTs);
    if (left.length) this.unread.set(conversation, left);
    else this.unread.delete(conversation);
    if (taken.length) this.save();
    return taken;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const data: StateFile = {
      v: 1,
      dms: [...this.dms],
      index: [...this.index],
      unread: Object.fromEntries(this.unread),
      expiring: this.expiring,
      pins: this.pins,
      groups: Object.fromEntries(this.groups),
      abouts: Object.fromEntries(this.abouts),
      heard: Object.fromEntries(this.heard),
      ours: [...this.ours],
      invites: Object.fromEntries(this.invites),
      keys: Object.fromEntries(this.keys),
      username: this.username,
      seenAt: this.seenAt,
      syncedAt: this.syncedAt,
      stories: this.stories,
      storyFiles: this.storyFiles,
    };
    try {
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (e) {
      console.error('[signal] could not write state.json', e);
    }
  }
}
