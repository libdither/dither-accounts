/**
 * The registry: accounts, apps, their grants and requests, and daily call counts. Secrets are not here: each account's
 * live in its directory (secret.json, 0600) where its extractor reads them, and provider clients in providers/. The one
 * random value kept here (kv) is not a credential: what this install's page-visible names are made from (supervisor.ts).
 * Nothing an account says passes through this file: the manager routes, it does not keep.
 */
import { Database } from 'bun:sqlite';
import type { Level } from '@dither-accounts/spec';

export type Row = Record<string, any>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS account (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  -- The extractor's own token for the /extractor socket.
  token      TEXT NOT NULL,
  -- Where its session lives. Imported accounts keep the directory they had (dither-chat's .data/accounts/<id>).
  dir        TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Who it was last signed in as (its status's self: names, handle, email, avatar), so the page can name it while it
  -- is stopped. Only that: nothing else an account says is kept.
  seen_as    TEXT
);

CREATE TABLE IF NOT EXISTS app (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  describe   TEXT,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);

-- What an app may do. interface 'accounts' with level 'manage' lets it create and run accounts of \`kinds\`.
CREATE TABLE IF NOT EXISTS grant_ (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  interface  TEXT NOT NULL,
  -- JSON: "*" or a list of account ids.
  accounts   TEXT NOT NULL DEFAULT '"*"',
  -- JSON: null (any kind) or a list of kinds.
  kinds      TEXT,
  level      TEXT NOT NULL CHECK (level IN ('read', 'write', 'manage')),
  -- Writes are answered without reaching the account.
  dry_run    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS grant_app ON grant_(app_id);

CREATE TABLE IF NOT EXISTS request (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  interface  TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('read', 'write', 'manage')),
  accounts   TEXT NOT NULL DEFAULT '"*"',
  kinds      TEXT,
  reason     TEXT,
  state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

-- Calls per day, app, account, operation and outcome: counts only, never what was asked or answered.
CREATE TABLE IF NOT EXISTS audit (
  day      TEXT NOT NULL,
  app_id   TEXT NOT NULL,
  account  TEXT NOT NULL,
  op       TEXT NOT NULL,
  outcome  TEXT NOT NULL,
  n        INTEGER NOT NULL,
  last_at  INTEGER NOT NULL,
  PRIMARY KEY (day, app_id, account, op, outcome)
);

-- Each approver request (docs/approver.md) and how it ended: who asked, for which site, on which device, and when.
-- Never the client data, a challenge or a key. outcome: waiting, ok, or the refusal (denied, refused, expired,
-- unknown-credential, error, no-device).
CREATE TABLE IF NOT EXISTS approval (
  id          TEXT PRIMARY KEY,
  account     TEXT NOT NULL,
  rp_id       TEXT NOT NULL,
  op          TEXT NOT NULL,
  device      TEXT NOT NULL,
  reason      TEXT,
  outcome     TEXT NOT NULL,
  message     TEXT,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  decided_at  INTEGER
);
CREATE INDEX IF NOT EXISTS approval_at ON approval(created_at);
`;

export function newId(prefix: string): string {
  return `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')}`;
}
export function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}
export function hashToken(t: string): string {
  return new Bun.CryptoHasher('sha256').update(t).digest('hex');
}

export interface GrantRow {
  id: string;
  app_id: string;
  interface: string;
  accounts: '*' | string[];
  kinds: string[] | null;
  level: Level;
  dry_run: boolean;
  created_at: number;
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec(SCHEMA);
    // Columns added after a registry was made.
    const cols = new Set(this.all<{ name: string }>('PRAGMA table_info(account)').map((c) => c.name));
    if (!cols.has('seen_as')) this.db.exec('ALTER TABLE account ADD COLUMN seen_as TEXT');
  }
  one<T = Row>(sql: string, ...p: any[]): T | null {
    return (this.db.query(sql).get(...p) as T) ?? null;
  }
  all<T = Row>(sql: string, ...p: any[]): T[] {
    return this.db.query(sql).all(...p) as T[];
  }
  run(sql: string, ...p: any[]) {
    return this.db.query(sql).run(...p);
  }

  /** A random value made the first time it is asked for, then kept: the same for this install from then on. */
  installValue(key: string): string {
    const had = this.one<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
    if (had) return had.value;
    this.run('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)', key, newToken());
    return this.one<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)!.value;
  }

  account(id: string): Row | null {
    return this.one('SELECT * FROM account WHERE id = ?', id);
  }
  accounts(): Row[] {
    return this.all('SELECT * FROM account ORDER BY kind, label');
  }
  app(id: string): Row | null {
    return this.one('SELECT * FROM app WHERE id = ?', id);
  }
  appByToken(token: string): Row | null {
    return this.one('SELECT * FROM app WHERE token_hash = ?', hashToken(token));
  }
  grants(appId?: string): GrantRow[] {
    const rows = appId ? this.all('SELECT * FROM grant_ WHERE app_id = ? ORDER BY created_at', appId) : this.all('SELECT * FROM grant_ ORDER BY created_at');
    return rows.map((r) => ({ ...r, accounts: JSON.parse(r.accounts), kinds: r.kinds ? JSON.parse(r.kinds) : null, dry_run: !!r.dry_run }) as GrantRow);
  }
  addGrant(g: { app_id: string; interface: string; accounts?: '*' | string[]; kinds?: string[] | null; level: Level; dry_run?: boolean }): string {
    const id = newId('grt');
    this.run(
      'INSERT INTO grant_ (id, app_id, interface, accounts, kinds, level, dry_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      g.app_id,
      g.interface,
      JSON.stringify(g.accounts ?? '*'),
      g.kinds ? JSON.stringify(g.kinds) : null,
      g.level,
      g.dry_run ? 1 : 0,
      Date.now(),
    );
    return id;
  }
}
