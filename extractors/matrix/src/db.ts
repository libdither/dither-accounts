/**
 * The adapter's own state, in $DITHER_ACCOUNT_DIR/matrix.sqlite:
 * the sync token, joined-room state, per-room back-pagination tokens, and the
 * indexes needed to turn relations into facts (edits, reactions, threads).
 */

import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { Room, type MxEvent } from './rooms.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS room (
  id             TEXT PRIMARY KEY,
  membership     TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '{}',
  back_token     TEXT,
  latest_event   TEXT,
  members_loaded INTEGER NOT NULL DEFAULT 0,
  last_mute      TEXT
);

CREATE TABLE IF NOT EXISTS state (
  room  TEXT NOT NULL,
  type  TEXT NOT NULL,
  key   TEXT NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (room, type, key)
);

-- Every timeline event seen (for receipt timestamps and gap detection);
-- message-like events keep their original JSON (edits are rebuilt from it).
CREATE TABLE IF NOT EXISTS event (
  id       TEXT PRIMARY KEY,
  room     TEXT NOT NULL,
  conv     TEXT NOT NULL,
  type     TEXT NOT NULL,
  sender   TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  json     TEXT,
  redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS event_ts ON event(ts);

-- Latest valid replacement per edited event.
CREATE TABLE IF NOT EXISTS edit (
  target  TEXT PRIMARY KEY,
  id      TEXT NOT NULL,
  sender  TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edit_id ON edit(id);

-- Reaction event id -> what it annotates, so a redacted reaction can be removed.
CREATE TABLE IF NOT EXISTS reaction (
  id     TEXT PRIMARY KEY,
  room   TEXT NOT NULL,
  target TEXT NOT NULL,
  key    TEXT NOT NULL,
  sender TEXT NOT NULL,
  ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reaction_target ON reaction(target);

-- Thread conversations "<roomId>|<rootEventId>".
CREATE TABLE IF NOT EXISTS thread (
  id         TEXT PRIMARY KEY,
  room       TEXT NOT NULL,
  root       TEXT NOT NULL,
  name       TEXT,
  latest     TEXT,
  latest_ts  INTEGER NOT NULL DEFAULT 0,
  back_token TEXT,
  done       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS thread_room ON thread(room);

-- Encrypted events waiting for a key, by the Megolm session that would open them.
CREATE TABLE IF NOT EXISTS utd (
  id      TEXT PRIMARY KEY,
  room    TEXT NOT NULL,
  session TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS utd_session ON utd(session);
`;

export interface EventRow {
  id: string;
  room: string;
  conv: string;
  type: string;
  sender: string;
  ts: number;
  json: string | null;
  redacted: number;
}

export interface ReactionRow {
  id: string;
  room: string;
  target: string;
  key: string;
  sender: string;
  ts: number;
}

export interface EditRow {
  target: string;
  id: string;
  sender: string;
  ts: number;
  content: string;
}

export interface ThreadRow {
  id: string;
  room: string;
  root: string;
  name: string | null;
  latest: string | null;
  latest_ts: number;
  back_token: string | null;
  done: number;
}

export interface UtdRow {
  id: string;
  room: string;
  session: string;
}

export class AdapterDb {
  readonly db: Database;

  constructor(path: string) {
    // Message content lives here, decrypted content too: owner-only (SQLite gives the -wal/-shm files the same mode).
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- kv

  get(k: string): string | null {
    return (this.db.query('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | null)?.v ?? null;
  }
  set(k: string, v: string | null) {
    if (v === null) this.db.query('DELETE FROM kv WHERE k = ?').run(k);
    else this.db.query('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v);
  }

  // ---------------------------------------------------------------- rooms

  loadRooms(): Room[] {
    const rooms = new Map<string, Room>();
    for (const r of this.db.query('SELECT * FROM room').all() as any[]) {
      const room = new Room(r.id);
      room.membership = r.membership;
      room.summary = JSON.parse(r.summary || '{}');
      room.backToken = r.back_token;
      room.latestEvent = r.latest_event;
      room.membersLoaded = !!r.members_loaded;
      room.lastMute = r.last_mute;
      rooms.set(r.id, room);
    }
    for (const s of this.db.query('SELECT room, event FROM state').all() as { room: string; event: string }[]) {
      rooms.get(s.room)?.setState(JSON.parse(s.event));
    }
    return [...rooms.values()];
  }

  saveRoom(room: Room) {
    this.db
      .query(
        `INSERT INTO room (id, membership, summary, back_token, latest_event, members_loaded, last_mute) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET membership = excluded.membership, summary = excluded.summary, back_token = excluded.back_token,
           latest_event = excluded.latest_event, members_loaded = excluded.members_loaded, last_mute = excluded.last_mute`,
      )
      .run(room.id, room.membership, JSON.stringify(room.summary), room.backToken, room.latestEvent, room.membersLoaded ? 1 : 0, room.lastMute);
  }

  saveState(roomId: string, ev: MxEvent) {
    const slim = { type: ev.type, state_key: ev.state_key, event_id: ev.event_id, sender: ev.sender, origin_server_ts: ev.origin_server_ts, content: ev.content };
    this.db.query('INSERT OR REPLACE INTO state (room, type, key, event) VALUES (?, ?, ?, ?)').run(roomId, ev.type, ev.state_key ?? '', JSON.stringify(slim));
  }

  deleteRoom(roomId: string) {
    this.db.query('DELETE FROM room WHERE id = ?').run(roomId);
    this.db.query('DELETE FROM state WHERE room = ?').run(roomId);
    this.db.query('DELETE FROM thread WHERE room = ?').run(roomId);
  }

  // ---------------------------------------------------------------- events

  putEvent(ev: MxEvent, room: string, conv: string, keepJson: boolean) {
    const json = keepJson ? JSON.stringify({ type: ev.type, event_id: ev.event_id, sender: ev.sender, origin_server_ts: ev.origin_server_ts, content: ev.content, e2ee: ev.e2ee }) : null;
    this.db
      .query(
        `INSERT INTO event (id, room, conv, type, sender, ts, json) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET conv = excluded.conv, type = excluded.type, json = COALESCE(excluded.json, json)`,
      )
      .run(ev.event_id, room, conv, ev.type, ev.sender, ev.origin_server_ts, json);
  }

  event(id: string): EventRow | null {
    return (this.db.query('SELECT * FROM event WHERE id = ?').get(id) as EventRow | null) ?? null;
  }

  eventJson(id: string): MxEvent | null {
    const r = this.event(id);
    return r?.json ? (JSON.parse(r.json) as MxEvent) : null;
  }

  markRedacted(id: string) {
    this.db.query('UPDATE event SET redacted = 1 WHERE id = ?').run(id);
  }

  /** Keep the newest `keep` events; relation indexes for pruned targets go too. */
  prune(keep: number) {
    const n = (this.db.query('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n;
    if (n <= keep) return 0;
    const cutoff = (this.db.query('SELECT ts FROM event ORDER BY ts DESC LIMIT 1 OFFSET ?').get(keep) as { ts: number } | null)?.ts;
    if (cutoff === undefined) return 0;
    this.tx(() => {
      this.db.query('DELETE FROM reaction WHERE target IN (SELECT id FROM event WHERE ts < ?)').run(cutoff);
      this.db.query('DELETE FROM edit WHERE target IN (SELECT id FROM event WHERE ts < ?)').run(cutoff);
      this.db.query('DELETE FROM event WHERE ts < ?').run(cutoff);
      this.db.query('DELETE FROM utd WHERE id NOT IN (SELECT id FROM event)').run();
    });
    return n - keep;
  }

  // ---------------------------------------------------------------- events without a key

  putUtd(u: UtdRow) {
    this.db.query('INSERT OR REPLACE INTO utd (id, room, session) VALUES (?, ?, ?)').run(u.id, u.room, u.session);
  }
  dropUtd(id: string) {
    this.db.query('DELETE FROM utd WHERE id = ?').run(id);
  }
  utdOfSession(session: string): UtdRow[] {
    return this.db.query('SELECT * FROM utd WHERE session = ?').all(session) as UtdRow[];
  }
  utdAll(): UtdRow[] {
    return this.db.query('SELECT * FROM utd').all() as UtdRow[];
  }
  utdCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM utd').get() as { n: number }).n;
  }
  /** Encrypted events stored while encryption was off. */
  utdFromEvents() {
    const rows = this.db.query(`SELECT id, room, json FROM event WHERE type = 'm.room.encrypted' AND json IS NOT NULL AND redacted = 0 AND id NOT IN (SELECT id FROM utd)`).all() as { id: string; room: string; json: string }[];
    this.tx(() => {
      for (const r of rows) {
        const session = JSON.parse(r.json).content?.session_id;
        if (typeof session === 'string') this.putUtd({ id: r.id, room: r.room, session });
      }
    });
  }
  encryptedWithoutJson(): string[] {
    return (this.db.query(`SELECT id FROM event WHERE type = 'm.room.encrypted' AND json IS NULL AND redacted = 0`).all() as { id: string }[]).map((r) => r.id);
  }

  // ---------------------------------------------------------------- edits

  /** Store if newer than what we have (by ts, then event id). */
  putEdit(e: EditRow): boolean {
    const cur = this.edit(e.target);
    if (cur && (cur.ts > e.ts || (cur.ts === e.ts && cur.id >= e.id))) return false;
    this.db.query('INSERT OR REPLACE INTO edit (target, id, sender, ts, content) VALUES (?, ?, ?, ?, ?)').run(e.target, e.id, e.sender, e.ts, e.content);
    return true;
  }
  edit(target: string): EditRow | null {
    return (this.db.query('SELECT * FROM edit WHERE target = ?').get(target) as EditRow | null) ?? null;
  }
  /** Drop an edit by its own event id (it was redacted). Returns the edited event id. */
  dropEdit(id: string): string | null {
    const r = this.db.query('DELETE FROM edit WHERE id = ? RETURNING target').get(id) as { target: string } | null;
    return r?.target ?? null;
  }

  // ---------------------------------------------------------------- reactions

  putReaction(r: ReactionRow) {
    this.db.query('INSERT OR REPLACE INTO reaction (id, room, target, key, sender, ts) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.room, r.target, r.key, r.sender, r.ts);
  }
  reaction(id: string): ReactionRow | null {
    return (this.db.query('SELECT * FROM reaction WHERE id = ?').get(id) as ReactionRow | null) ?? null;
  }
  deleteReaction(id: string) {
    this.db.query('DELETE FROM reaction WHERE id = ?').run(id);
  }
  reactionsFor(target: string): ReactionRow[] {
    return this.db.query('SELECT * FROM reaction WHERE target = ? ORDER BY ts').all(target) as ReactionRow[];
  }
  reactionsBy(target: string, sender: string, key: string): ReactionRow[] {
    return this.db.query('SELECT * FROM reaction WHERE target = ? AND sender = ? AND key = ?').all(target, sender, key) as ReactionRow[];
  }

  // ---------------------------------------------------------------- threads

  thread(id: string): ThreadRow | null {
    return (this.db.query('SELECT * FROM thread WHERE id = ?').get(id) as ThreadRow | null) ?? null;
  }
  putThread(t: ThreadRow) {
    this.db
      .query('INSERT OR REPLACE INTO thread (id, room, root, name, latest, latest_ts, back_token, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.room, t.root, t.name, t.latest, t.latest_ts, t.back_token, t.done);
  }
  threadsOf(room: string): ThreadRow[] {
    return this.db.query('SELECT * FROM thread WHERE room = ?').all(room) as ThreadRow[];
  }
  threads(): ThreadRow[] {
    return this.db.query('SELECT * FROM thread').all() as ThreadRow[];
  }
}
