/**
 * What the adapter keeps between runs, in <accountDir>/state.db (bun:sqlite). Never the session (that is
 * secret.json's) and only what replies, reactions, read marks, history and downloads need:
 *
 *   conv     each conversation: Google Messages' id, its fact as last published, SMS or RCS, the SIM participant it
 *            sends from, whether it is end-to-end encrypted, read or not
 *   msg      per message: Google Messages' id, its author, its media (ids and keys to download them), its reactions
 *            as last published, what it says (a hash, to tell a real change from a status update), how far it got
 *   person   names and numbers of the people in conversations (the phone's contacts, as it names them)
 *   pmap     a conversation's participant id -> the identity it was published as
 *   kv       odds and ends (self, settings, last seen)
 */

import { Database } from 'bun:sqlite';
import type { GmMedia } from './types.ts';

export interface ConvRow {
  /** Native id ("<ns>:c<gm id>"). */
  id: string;
  gmId: string;
  fact: Record<string, any>;
  type: 'sms' | 'rcs' | '';
  outgoing: string;
  e2ee: boolean;
  unread: boolean;
  lastTs: number;
  latestId: string;
  group: boolean;
}

export interface MsgRow {
  /** Native id ("<ns>:m<gm id>"). */
  id: string;
  gmId: string;
  conversation: string;
  author: string;
  fromMe: boolean;
  ts: number;
  kind: string;
  state: string;
  hash: string;
  media: GmMedia[];
  /** emoji -> identity ids, as last published. */
  reactions: Record<string, string[]>;
}

export interface PersonRow {
  id: string;
  number?: string;
  formatted?: string;
  name?: string;
  firstName?: string;
  contact?: boolean;
  /** A participant id to ask the phone for their picture by. */
  participant?: string;
}

export class State {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS conv (
        id TEXT PRIMARY KEY, gm_id TEXT NOT NULL, fact TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', outgoing TEXT NOT NULL DEFAULT '',
        e2ee INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, last_ts INTEGER NOT NULL DEFAULT 0, latest_id TEXT NOT NULL DEFAULT '',
        grp INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS msg (
        id TEXT PRIMARY KEY, gm_id TEXT NOT NULL, conversation TEXT NOT NULL, author TEXT NOT NULL, from_me INTEGER NOT NULL,
        ts INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL DEFAULT '',
        media TEXT NOT NULL DEFAULT '[]', reactions TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS msg_conv_ts ON msg (conversation, ts);
      CREATE TABLE IF NOT EXISTS person (id TEXT PRIMARY KEY, number TEXT, formatted TEXT, name TEXT, first_name TEXT, contact INTEGER, participant TEXT);
      CREATE TABLE IF NOT EXISTS pmap (conversation TEXT NOT NULL, participant TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY (conversation, participant));
    `);
  }

  close() {
    this.db.close();
  }

  get(k: string): string | undefined {
    return (this.db.query('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | null)?.v;
  }
  set(k: string, v: string | null) {
    if (v === null) this.db.query('DELETE FROM kv WHERE k = ?').run(k);
    else this.db.query('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // ------------------------------------------------------------ conversations

  private convRow(r: any): ConvRow {
    return { id: r.id, gmId: r.gm_id, fact: JSON.parse(r.fact), type: r.type, outgoing: r.outgoing, e2ee: !!r.e2ee, unread: !!r.unread, lastTs: r.last_ts, latestId: r.latest_id, group: !!r.grp };
  }
  conv(id: string): ConvRow | undefined {
    const r = this.db.query('SELECT * FROM conv WHERE id = ?').get(id);
    return r ? this.convRow(r) : undefined;
  }
  convs(): ConvRow[] {
    return (this.db.query('SELECT * FROM conv ORDER BY last_ts DESC').all() as any[]).map((r) => this.convRow(r));
  }
  putConv(c: ConvRow) {
    this.db
      .query(
        `INSERT INTO conv (id, gm_id, fact, type, outgoing, e2ee, unread, last_ts, latest_id, grp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET gm_id = excluded.gm_id, fact = excluded.fact, type = excluded.type, outgoing = excluded.outgoing,
           e2ee = excluded.e2ee, unread = excluded.unread, last_ts = max(conv.last_ts, excluded.last_ts), latest_id = excluded.latest_id, grp = excluded.grp`,
      )
      .run(c.id, c.gmId, JSON.stringify(c.fact), c.type, c.outgoing, c.e2ee ? 1 : 0, c.unread ? 1 : 0, c.lastTs, c.latestId, c.group ? 1 : 0);
  }
  setE2EE(id: string, on: boolean) {
    this.db.query('UPDATE conv SET e2ee = ? WHERE id = ?').run(on ? 1 : 0, id);
  }
  setUnread(id: string, unread: boolean) {
    this.db.query('UPDATE conv SET unread = ? WHERE id = ?').run(unread ? 1 : 0, id);
  }
  dropConv(id: string) {
    this.db.query('DELETE FROM conv WHERE id = ?').run(id);
    this.db.query('DELETE FROM msg WHERE conversation = ?').run(id);
    this.db.query('DELETE FROM pmap WHERE conversation = ?').run(id);
  }
  countConvs(): number {
    return (this.db.query('SELECT count(*) AS n FROM conv').get() as { n: number }).n;
  }

  // ------------------------------------------------------------ messages

  private msgRow(r: any): MsgRow {
    return { id: r.id, gmId: r.gm_id, conversation: r.conversation, author: r.author, fromMe: !!r.from_me, ts: r.ts, kind: r.kind, state: r.state, hash: r.hash, media: JSON.parse(r.media), reactions: JSON.parse(r.reactions) };
  }
  msg(id: string): MsgRow | undefined {
    const r = this.db.query('SELECT * FROM msg WHERE id = ?').get(id);
    return r ? this.msgRow(r) : undefined;
  }
  putMsg(m: MsgRow) {
    this.db
      .query(
        `INSERT INTO msg (id, gm_id, conversation, author, from_me, ts, kind, state, hash, media, reactions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET conversation = excluded.conversation, author = excluded.author, from_me = excluded.from_me, ts = excluded.ts,
           kind = excluded.kind, state = excluded.state, hash = excluded.hash, media = excluded.media, reactions = excluded.reactions`,
      )
      .run(m.id, m.gmId, m.conversation, m.author, m.fromMe ? 1 : 0, m.ts, m.kind, m.state, m.hash, JSON.stringify(m.media), JSON.stringify(m.reactions));
  }
  dropMsg(id: string) {
    this.db.query('DELETE FROM msg WHERE id = ?').run(id);
  }
  oldest(conversation: string): MsgRow | undefined {
    const r = this.db.query('SELECT * FROM msg WHERE conversation = ? ORDER BY ts ASC LIMIT 1').get(conversation);
    return r ? this.msgRow(r) : undefined;
  }
  latest(conversation: string, upToTs = Number.MAX_SAFE_INTEGER): MsgRow | undefined {
    const r = this.db.query('SELECT * FROM msg WHERE conversation = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').get(conversation, upToTs);
    return r ? this.msgRow(r) : undefined;
  }
  countMsgs(): number {
    return (this.db.query('SELECT count(*) AS n FROM msg').get() as { n: number }).n;
  }

  // ------------------------------------------------------------ people

  person(id: string): PersonRow | undefined {
    const r = this.db.query('SELECT * FROM person WHERE id = ?').get(id) as any;
    return r ? { id: r.id, number: r.number ?? undefined, formatted: r.formatted ?? undefined, name: r.name ?? undefined, firstName: r.first_name ?? undefined, contact: !!r.contact, participant: r.participant ?? undefined } : undefined;
  }
  /** Merge: what is given replaces, what is not stays. */
  putPerson(p: PersonRow) {
    const cur = this.person(p.id) ?? { id: p.id };
    const m = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== '')) } as PersonRow;
    this.db
      .query('INSERT INTO person (id, number, formatted, name, first_name, contact, participant) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET number = excluded.number, formatted = excluded.formatted, name = excluded.name, first_name = excluded.first_name, contact = excluded.contact, participant = excluded.participant')
      .run(m.id, m.number ?? null, m.formatted ?? null, m.name ?? null, m.firstName ?? null, m.contact ? 1 : 0, m.participant ?? null);
    return m;
  }

  identityOf(conversation: string, participant: string): string | undefined {
    return (this.db.query('SELECT identity FROM pmap WHERE conversation = ? AND participant = ?').get(conversation, participant) as { identity: string } | null)?.identity;
  }
  mapParticipant(conversation: string, participant: string, identity: string) {
    this.db.query('INSERT INTO pmap (conversation, participant, identity) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET identity = excluded.identity').run(conversation, participant, identity);
  }
}
