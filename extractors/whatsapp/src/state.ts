/**
 * What whatsmeow does not keep for us, in <accountDir>/state.db (bun:sqlite):
 *
 *   alias    every JID we have seen -> the native id it was first published under. WhatsApp
 *            addresses one person by phone number (…@s.whatsapp.net) or by LID (…@lid), and
 *            switches between them; pinning the first keeps one identity and one DM per person.
 *   chat     the conversation list (WhatsApp sends it once, in the history sync on link)
 *   msg      per message: the JIDs and id needed to reply, react, edit, delete, mark read,
 *            forward and download, and its content (protojson, thumbnails dropped)
 *   react    one reaction per person per message, so a removal knows what it removes
 *   person   names from the address book, push names and business names
 *   pin      pinned messages and when each pin lapses: WhatsApp sends nothing when it does
 *   kv       odds and ends (own JIDs, sync markers)
 */

import { Database } from 'bun:sqlite';
import type { WaMessage } from './types.ts';

export interface StoredMsg {
  /** Native message id: "<conversation native id>/<WhatsApp id>". */
  id: string;
  conversation: string;
  /** JID to address the chat with. */
  chat: string;
  wid: string;
  /** Sender JID as WhatsApp gave it (for message keys). */
  sender: string;
  /** Sender's native id. */
  author: string;
  fromMe: boolean;
  ts: number;
  content?: WaMessage | null;
  /** ms epoch the message disappears at. */
  expires?: number;
}

export interface ChatRow {
  id: string;
  jid: string;
  fact: Record<string, any>;
  lastTs: number;
}

export interface PersonRow {
  id: string;
  fullName?: string;
  firstName?: string;
  pushName?: string;
  businessName?: string;
  phone?: string;
  avatar?: string;
}

export class State {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS alias (jid TEXT PRIMARY KEY, id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS alias_id ON alias (id);
      CREATE TABLE IF NOT EXISTS chat (id TEXT PRIMARY KEY, jid TEXT NOT NULL, fact TEXT NOT NULL, last_ts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS msg (
        id TEXT PRIMARY KEY, conversation TEXT NOT NULL, chat TEXT NOT NULL, wid TEXT NOT NULL, sender TEXT NOT NULL,
        author TEXT NOT NULL, from_me INTEGER NOT NULL, ts INTEGER NOT NULL, content TEXT, expires INTEGER
      );
      CREATE INDEX IF NOT EXISTS msg_conv_ts ON msg (conversation, ts);
      CREATE INDEX IF NOT EXISTS msg_expires ON msg (expires) WHERE expires IS NOT NULL;
      CREATE TABLE IF NOT EXISTS react (msg TEXT NOT NULL, author TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (msg, author));
      CREATE TABLE IF NOT EXISTS person (id TEXT PRIMARY KEY, full_name TEXT, first_name TEXT, push_name TEXT, business_name TEXT, phone TEXT, avatar TEXT);
      CREATE TABLE IF NOT EXISTS pin (msg TEXT PRIMARY KEY, conversation TEXT NOT NULL, ts INTEGER NOT NULL, expires INTEGER);
      CREATE INDEX IF NOT EXISTS pin_expires ON pin (expires) WHERE expires IS NOT NULL;
    `);
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------ kv

  get(k: string): string | undefined {
    return (this.db.query('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | null)?.v;
  }
  set(k: string, v: string | null) {
    if (v === null) this.db.query('DELETE FROM kv WHERE k = ?').run(k);
    else this.db.query('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // ------------------------------------------------------------ aliases

  aliasOf(jid: string): string | undefined {
    return (this.db.query('SELECT id FROM alias WHERE jid = ?').get(jid) as { id: string } | null)?.id;
  }
  setAlias(jid: string, id: string) {
    this.db.query('INSERT INTO alias (jid, id) VALUES (?, ?) ON CONFLICT (jid) DO NOTHING').run(jid, id);
  }
  /** Every JID published under this id. */
  jidsOf(id: string): string[] {
    return (this.db.query('SELECT jid FROM alias WHERE id = ?').all(id) as { jid: string }[]).map((r) => r.jid);
  }

  // ------------------------------------------------------------ chats

  chat(id: string): ChatRow | undefined {
    const r = this.db.query('SELECT * FROM chat WHERE id = ?').get(id) as any;
    return r ? { id: r.id, jid: r.jid, fact: JSON.parse(r.fact), lastTs: r.last_ts } : undefined;
  }
  chats(): ChatRow[] {
    return (this.db.query('SELECT * FROM chat ORDER BY last_ts DESC').all() as any[]).map((r) => ({ id: r.id, jid: r.jid, fact: JSON.parse(r.fact), lastTs: r.last_ts }));
  }
  putChat(c: ChatRow) {
    this.db
      .query('INSERT INTO chat (id, jid, fact, last_ts) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET jid = excluded.jid, fact = excluded.fact, last_ts = max(chat.last_ts, excluded.last_ts)')
      .run(c.id, c.jid, JSON.stringify(c.fact), c.lastTs);
  }
  dropChat(id: string) {
    this.db.query('DELETE FROM chat WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ messages

  msg(id: string): StoredMsg | undefined {
    const r = this.db.query('SELECT * FROM msg WHERE id = ?').get(id) as any;
    return r ? rowToMsg(r) : undefined;
  }
  putMsg(m: StoredMsg) {
    this.db
      .query(
        `INSERT INTO msg (id, conversation, chat, wid, sender, author, from_me, ts, content, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET content = coalesce(excluded.content, msg.content), expires = coalesce(excluded.expires, msg.expires)`,
      )
      .run(m.id, m.conversation, m.chat, m.wid, m.sender, m.author, m.fromMe ? 1 : 0, m.ts, m.content ? JSON.stringify(m.content) : null, m.expires ?? null);
  }
  updateContent(id: string, content: WaMessage) {
    this.db.query('UPDATE msg SET content = ? WHERE id = ?').run(JSON.stringify(content), id);
  }
  dropMsg(id: string) {
    this.db.query('DELETE FROM msg WHERE id = ?').run(id);
    this.db.query('DELETE FROM react WHERE msg = ?').run(id);
    this.db.query('DELETE FROM pin WHERE msg = ?').run(id);
  }
  /** Oldest message we know in a conversation, at or before a time. */
  oldest(conversation: string, beforeTs?: number): StoredMsg | undefined {
    const r = this.db.query('SELECT * FROM msg WHERE conversation = ? AND ts < ? ORDER BY ts ASC LIMIT 1').get(conversation, beforeTs ?? Number.MAX_SAFE_INTEGER) as any;
    return r ? rowToMsg(r) : undefined;
  }
  /** Incoming messages in a conversation up to a time, newest first (for read receipts). */
  incomingUpTo(conversation: string, ts: number, since: number, limit = 200): StoredMsg[] {
    return (this.db.query('SELECT * FROM msg WHERE conversation = ? AND from_me = 0 AND ts <= ? AND ts > ? ORDER BY ts DESC LIMIT ?').all(conversation, ts, since, limit) as any[]).map(rowToMsg);
  }
  expired(now: number): StoredMsg[] {
    return (this.db.query('SELECT * FROM msg WHERE expires IS NOT NULL AND expires <= ? LIMIT 500').all(now) as any[]).map(rowToMsg);
  }
  countMsgs(conversation?: string): number {
    const r = conversation ? this.db.query('SELECT count(*) AS n FROM msg WHERE conversation = ?').get(conversation) : this.db.query('SELECT count(*) AS n FROM msg').get();
    return (r as { n: number }).n;
  }

  // ------------------------------------------------------------ reactions

  reaction(msg: string, author: string): string | undefined {
    return (this.db.query('SELECT key FROM react WHERE msg = ? AND author = ?').get(msg, author) as { key: string } | null)?.key;
  }
  setReaction(msg: string, author: string, key: string | null) {
    if (key === null) this.db.query('DELETE FROM react WHERE msg = ? AND author = ?').run(msg, author);
    else this.db.query('INSERT INTO react (msg, author, key) VALUES (?, ?, ?) ON CONFLICT (msg, author) DO UPDATE SET key = excluded.key').run(msg, author, key);
  }

  // ------------------------------------------------------------ pins

  /** A pin (expires: when it lapses) or an unpin (null), unless a later one is already known. */
  putPin(msg: string, conversation: string, ts: number, expires: number | null) {
    this.db
      .query('INSERT INTO pin (msg, conversation, ts, expires) VALUES (?, ?, ?, ?) ON CONFLICT (msg) DO UPDATE SET ts = excluded.ts, expires = excluded.expires WHERE excluded.ts >= pin.ts')
      .run(msg, conversation, ts, expires);
  }
  /** Pins whose time is up, now unpinned here. */
  lapsedPins(now: number): { msg: string; conversation: string; expires: number }[] {
    const rows = this.db.query('SELECT msg, conversation, expires FROM pin WHERE expires IS NOT NULL AND expires <= ? LIMIT 500').all(now) as { msg: string; conversation: string; expires: number }[];
    // The lapse is the latest news about the pin: the same pin sent again (a history resync) does not revive it.
    for (const r of rows) this.db.query('UPDATE pin SET ts = expires, expires = NULL WHERE msg = ?').run(r.msg);
    return rows;
  }

  // ------------------------------------------------------------ people

  person(id: string): PersonRow | undefined {
    const r = this.db.query('SELECT * FROM person WHERE id = ?').get(id) as any;
    return r ? rowToPerson(r) : undefined;
  }
  people(): PersonRow[] {
    return (this.db.query('SELECT * FROM person').all() as any[]).map(rowToPerson);
  }
  /** Merge in what is known; undefined fields keep their value. Returns whether anything changed. */
  putPerson(p: PersonRow): boolean {
    const cur = this.person(p.id);
    const next: PersonRow = { ...cur, id: p.id };
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') (next as any)[k] = v;
    if (cur && JSON.stringify(cur) === JSON.stringify(next)) return false;
    this.db
      .query(
        `INSERT INTO person (id, full_name, first_name, push_name, business_name, phone, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET full_name = excluded.full_name, first_name = excluded.first_name, push_name = excluded.push_name,
           business_name = excluded.business_name, phone = excluded.phone, avatar = excluded.avatar`,
      )
      .run(next.id, next.fullName ?? null, next.firstName ?? null, next.pushName ?? null, next.businessName ?? null, next.phone ?? null, next.avatar ?? null);
    return true;
  }
}

function rowToMsg(r: any): StoredMsg {
  return {
    id: r.id,
    conversation: r.conversation,
    chat: r.chat,
    wid: r.wid,
    sender: r.sender,
    author: r.author,
    fromMe: !!r.from_me,
    ts: r.ts,
    content: r.content ? JSON.parse(r.content) : null,
    expires: r.expires ?? undefined,
  };
}

function rowToPerson(r: any): PersonRow {
  const p: PersonRow = { id: r.id };
  if (r.full_name) p.fullName = r.full_name;
  if (r.first_name) p.firstName = r.first_name;
  if (r.push_name) p.pushName = r.push_name;
  if (r.business_name) p.businessName = r.business_name;
  if (r.phone) p.phone = r.phone;
  if (r.avatar) p.avatar = r.avatar;
  return p;
}
