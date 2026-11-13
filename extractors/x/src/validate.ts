/**
 * Every object the hook forwards is checked here against the fields the mapping needs, whatever the hook already
 * did: a new client build that hands over something else is dropped and counted (by kind and reason), never mapped
 * half-right. The counts show in the account's details (`dropped`), names only.
 */
import type { RawAbout, RawAttachment, RawConversation, RawInbox, RawMessage, RawMessages, RawReaction, RawRequests, RawUser, SelfTest } from './raw.ts';
import { FEED_HOOK_NAMES, HOOK_NAMES } from './raw.ts';

export class Drops {
  readonly counts = new Map<string, number>();
  add(kind: string, reason: string) {
    const k = `${kind}.${reason}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
  get total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }
  /** "message.no-time 3, user.bad-id 1": names and counts only. */
  summary(max = 6): string | null {
    if (!this.counts.size) return null;
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const optStr = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const optBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const optNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Ids: X's are digits, digits joined by '-', or letters, digits, ':', '-' and '_'. Nothing with spaces or markup. */
const ID = /^[\w:.\-=+/]{1,128}$/;
const id = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null);
const SEQ = /^-?\d{1,24}$/;
const seq = (v: unknown): string | null => (typeof v === 'string' && SEQ.test(v) ? v : null);
/** A picture or file we may show or fetch through the page: https on X's hosts, or the page's own blob and data URLs. */
export function mediaUrl(v: unknown, testOrigin?: string | null): string | null {
  if (typeof v !== 'string' || v.length > 4096) return null;
  if (/^(blob:|data:)/.test(v)) return v;
  try {
    const u = new URL(v);
    if (testOrigin && v.startsWith(testOrigin)) return v;
    if (u.protocol === 'https:' && /(^|\.)(twimg\.com|x\.com|twitter\.com)$/.test(u.hostname)) return v;
  } catch {}
  return null;
}
/** Times between 2006 (Twitter) and a day from now, in ms. */
const ts = (v: unknown): number | null => (typeof v === 'number' && v > 1_136_073_600_000 && v < Date.now() + 86_400_000 ? Math.round(v) : null);

export function user(v: unknown, drops: Drops, testOrigin?: string | null): RawUser | null {
  if (!isObj(v)) return drops.add('user', 'not-object'), null;
  const uid = id(v.id);
  if (!uid) return drops.add('user', 'bad-id'), null;
  const screenName = v.screenName == null ? null : str(v.screenName, 50);
  if (v.screenName != null && (!screenName || !/^\w{1,50}$/.test(screenName))) return drops.add('user', 'bad-screen-name'), null;
  return { id: uid, screenName, displayName: optStr(v.displayName, 200), avatarUrl: mediaUrl(v.avatarUrl, testOrigin) };
}

export function conversation(v: unknown, drops: Drops, testOrigin?: string | null): RawConversation | null {
  if (!isObj(v)) return drops.add('conversation', 'not-object'), null;
  const cid = id(v.id);
  if (!cid) return drops.add('conversation', 'bad-id'), null;
  const users: RawUser[] = [];
  for (const u of Array.isArray(v.users) ? v.users.slice(0, 50) : []) {
    const ok = user(u, drops, testOrigin);
    if (ok) users.push(ok);
  }
  const unread = optNum(v.unread);
  return {
    id: cid,
    kind: optStr(v.kind, 80),
    legacy: optBool(v.legacy),
    group: optBool(v.group),
    title: optStr(v.title, 200),
    avatarUrl: mediaUrl(v.avatarUrl, testOrigin),
    archived: optBool(v.archived),
    description: optStr(v.description, 2000),
    muted: optBool(v.muted),
    unread: unread !== null && unread >= 0 ? Math.floor(unread) : null,
    unreadByMe: optBool(v.unreadByMe),
    lastTs: ts(v.lastTs),
    lastReadSeq: seq(v.lastReadSeq),
    lastSeq: seq(v.lastSeq),
    users,
  };
}

function reaction(v: unknown, drops: Drops): RawReaction | null {
  if (!isObj(v)) return drops.add('reaction', 'not-object'), null;
  const emoji = str(v.emoji, 64);
  if (!emoji || !emoji.trim()) return drops.add('reaction', 'no-emoji'), null;
  const users = (Array.isArray(v.users) ? v.users : []).map(id).filter((x): x is string => !!x).slice(0, 200);
  return { emoji, users, mine: v.mine === true, attachmentId: id(v.attachmentId) };
}

function attachment(v: unknown, drops: Drops, testOrigin?: string | null): RawAttachment | null {
  if (!isObj(v)) return drops.add('attachment', 'not-object'), null;
  const index = optNum(v.index);
  if (index === null || index < 0 || index > 50) return drops.add('attachment', 'bad-index'), null;
  const size = optNum(v.size);
  return {
    index: Math.floor(index),
    id: optStr(v.id, 200),
    kind: optStr(v.kind, 80),
    type: optStr(v.type, 40),
    mime: typeof v.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(v.mime) ? v.mime : null,
    name: optStr(v.name, 255),
    size: size !== null && size >= 0 ? Math.floor(size) : null,
    width: optNum(v.width),
    height: optNum(v.height),
    url: mediaUrl(v.url, testOrigin),
  };
}

export function message(v: unknown, conv: string, drops: Drops, testOrigin?: string | null): RawMessage | null {
  if (!isObj(v)) return drops.add('message', 'not-object'), null;
  const mid = id(v.id);
  if (!mid) return drops.add('message', 'bad-id'), null;
  if (v.conv !== conv) return drops.add('message', 'other-conversation'), null;
  const time = ts(v.ts);
  if (time === null) return drops.add('message', 'no-time'), null;
  const sender = id(v.sender);
  if (!sender && v.mine !== true) return drops.add('message', 'no-sender'), null;
  if (v.text != null && typeof v.text !== 'string') return drops.add('message', 'bad-text'), null;
  const reactions: RawReaction[] = [];
  for (const r of Array.isArray(v.reactions) ? v.reactions.slice(0, 60) : []) {
    const ok = reaction(r, drops);
    if (ok) reactions.push(ok);
  }
  const attachments: RawAttachment[] = [];
  for (const a of Array.isArray(v.attachments) ? v.attachments.slice(0, 20) : []) {
    const ok = attachment(a, drops, testOrigin);
    if (ok) attachments.push(ok);
  }
  const reply = isObj(v.replyTo) ? { seq: seq(v.replyTo.seq), id: id(v.replyTo.id) } : null;
  return {
    id: mid,
    conv,
    kind: optStr(v.kind, 80),
    seq: seq(v.seq),
    readSeq: seq(v.readSeq),
    ts: time,
    sender,
    senderUser: v.senderUser == null ? null : user(v.senderUser, drops, testOrigin),
    mine: optBool(v.mine),
    text: typeof v.text === 'string' ? v.text.slice(0, 40_000) : null,
    encrypted: optBool(v.encrypted),
    undecryptable: optBool(v.undecryptable),
    edited: optBool(v.edited),
    hidden: optStr(v.hidden, 60),
    forwarded: optBool(v.forwarded),
    replyTo: reply && (reply.seq || reply.id) ? reply : null,
    reactions,
    attachments,
  };
}

export function inbox(v: unknown, drops: Drops, testOrigin?: string | null): RawInbox | null {
  if (!isObj(v) || !Array.isArray(v.conversations)) return drops.add('inbox', 'no-list'), null;
  const conversations: RawConversation[] = [];
  const seen = new Set<string>();
  for (const c of v.conversations.slice(0, 1000)) {
    const ok = conversation(c, drops, testOrigin);
    if (!ok) continue;
    if (seen.has(ok.id)) {
      drops.add('conversation', 'duplicate');
      continue;
    }
    seen.add(ok.id);
    conversations.push(ok);
  }
  const typing: RawInbox['typing'] = [];
  for (const t of Array.isArray(v.typing) ? v.typing.slice(0, 100) : []) {
    if (!isObj(t) || !id(t.conv)) continue;
    typing.push({ conv: t.conv as string, users: (Array.isArray(t.users) ? t.users : []).map(id).filter((x): x is string => !!x) });
  }
  return { conversations, typing, loading: v.loading === true, loadedFromDb: optBool(v.loadedFromDb), keysChecked: optBool(v.keysChecked), more: v.more === true, failed: v.failed === true };
}

export function messages(v: unknown, drops: Drops, testOrigin?: string | null): RawMessages | null {
  if (!isObj(v)) return drops.add('messages', 'not-object'), null;
  const conv = id(v.conv);
  if (!conv) return drops.add('messages', 'bad-conversation'), null;
  const out: RawMessage[] = [];
  for (const m of Array.isArray(v.messages) ? v.messages.slice(0, 1000) : []) {
    const ok = message(m, conv, drops, testOrigin);
    if (ok) out.push(ok);
  }
  const other: Record<string, number> = {};
  if (isObj(v.other)) for (const [k, n] of Object.entries(v.other)) if (typeof n === 'number' && k.length <= 80) other[k] = n;
  return {
    conv,
    legacy: optBool(v.legacy),
    participants: (Array.isArray(v.participants) ? v.participants : []).map(id).filter((x): x is string => !!x).slice(0, 500),
    readOnly: v.readOnly === true,
    older: v.older === true,
    quiet: v.quiet === true,
    messages: out,
    other,
  };
}

/** The self-test as the hook reports it: unknown hook names are ignored, missing ones count as missing. */
export function selfTest(v: unknown): SelfTest | null {
  if (!isObj(v) || !isObj(v.hooks)) return null;
  const hooks = {} as SelfTest['hooks'];
  for (const n of HOOK_NAMES) {
    const h = (v.hooks as Record<string, unknown>)[n];
    hooks[n] = isObj(h) ? { ok: h.ok === true, via: typeof h.via === 'string' ? h.via.slice(0, 40) : null } : { ok: false, via: null };
  }
  const c = isObj(v.counts) ? v.counts : {};
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const dropped: Record<string, number> = {};
  if (isObj(c.dropped)) for (const [k, x] of Object.entries(c.dropped)) if (typeof x === 'number' && k.length <= 60) dropped[k] = x;
  const feed = {} as NonNullable<SelfTest['feed']>;
  for (const k of FEED_HOOK_NAMES) {
    const h = (v.hooks as Record<string, unknown>)[k];
    feed[k] = isObj(h) ? { ok: h.ok === true, via: typeof h.via === 'string' ? h.via.slice(0, 40) : null } : { ok: false, via: null };
  }
  return {
    version: n(v.version),
    hooks,
    feed,
    counts: { renderers: n(c.renderers), roots: n(c.roots), modules: n(c.modules), modulesScanned: n(c.modulesScanned), conversationsOpen: n(c.conversationsOpen), readsHeld: n(c.readsHeld), dropped },
  };
}

/** The Requests page's list, as the inbox's rows are checked. */
export function requests(v: unknown, drops: Drops, testOrigin?: string | null): RawRequests | null {
  if (!isObj(v) || !Array.isArray(v.requests)) return drops.add('requests', 'no-list'), null;
  const out: RawConversation[] = [];
  const seen = new Set<string>();
  for (const c of v.requests.slice(0, 200)) {
    const ok = conversation(c, drops, testOrigin);
    if (!ok || seen.has(ok.id)) continue;
    seen.add(ok.id);
    out.push(ok);
  }
  return { requests: out, loading: v.loading === true, more: v.more === true, failed: v.failed === true };
}

/** A conversation's settings and members as its inbox row has them (the `about` command's reply). */
export function about(v: unknown, drops: Drops, testOrigin?: string | null): RawAbout | null {
  if (!isObj(v)) return drops.add('about', 'not-object'), null;
  const conv = id(v.conv);
  if (!conv) return drops.add('about', 'bad-conversation'), null;
  const participants: RawAbout['participants'] = [];
  for (const p of Array.isArray(v.participants) ? v.participants.slice(0, 500) : []) {
    if (!isObj(p) || !id(p.id)) continue;
    participants.push({ id: p.id as string, admin: p.admin === true, current: p.current !== false });
  }
  const users: RawUser[] = [];
  for (const u of Array.isArray(v.users) ? v.users.slice(0, 50) : []) {
    const ok = user(u, drops, testOrigin);
    if (ok) users.push(ok);
  }
  return {
    conv,
    group: optBool(v.group),
    legacy: optBool(v.legacy),
    request: v.request === true,
    title: optStr(v.title, 200),
    description: optStr(v.description, 2000),
    avatarUrl: mediaUrl(v.avatarUrl, testOrigin),
    muted: optBool(v.muted),
    adminOnlyEditGroupInfo: optBool(v.adminOnlyEditGroupInfo),
    adminOnlyAddMembers: optBool(v.adminOnlyAddMembers),
    adminOnlySendMessages: optBool(v.adminOnlySendMessages),
    participants,
    member: optBool(v.member),
    selfAdmin: v.selfAdmin === true,
    users,
  };
}
