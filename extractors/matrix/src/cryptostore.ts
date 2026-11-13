/**
 * The crypto library persists through IndexedDB, which Bun does not have.
 * fake-indexeddb implements IndexedDB in memory; this makes it durable by writing every
 * committed transaction through to $DITHER_ACCOUNT_DIR/crypto.sqlite (0600) and replaying
 * that file into memory at startup.
 *
 * The write happens inside the transaction's `complete` event, synchronously, before the
 * library's continuation runs. So by the time it acts on a commit (say, a ratchet advance
 * that is about to leave as a to-device message), that commit is on disk. Olm sessions must
 * never go backwards, which is also why this file syncs harder than matrix.sqlite does.
 *
 * Only the public IndexedDB surface is wrapped (put, add, delete, clear, cursor update and
 * delete), and fake-indexeddb is pinned to an exact version. The values are already encrypted
 * by the library with the store key from secret.json. Nothing here logs keys or values.
 */

import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import 'fake-indexeddb/auto';
import { IDBCursor, IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS idb_database (name TEXT PRIMARY KEY, version INTEGER NOT NULL, schema TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idb_row (db TEXT NOT NULL, store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (db, store, key)) WITHOUT ROWID;
`;

// ---------------------------------------------------------------- values

/**
 * Structured-clone values as JSON, with a format of our own: this file has to stay readable
 * across Bun upgrades, or the account loses its device. An unknown type throws, so nothing
 * gets stored that would not come back the same.
 */
export function encodeValue(v: unknown): unknown {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) && !Object.is(v, -0) ? v : { $: 'n', v: String(Object.is(v, -0) ? '-0' : v) };
    case 'undefined':
      return { $: 'u' };
    case 'bigint':
      return { $: 'i', v: v.toString() };
    case 'object':
      break;
    default:
      throw new TypeError(`crypto store: cannot persist a ${typeof v}`);
  }
  if (v === null) return null;
  if (Array.isArray(v)) return Array.from(v, encodeValue);
  if (v instanceof Uint8Array) return { $: 'b', v: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  if (v instanceof ArrayBuffer) return { $: 'a', v: Buffer.from(v).toString('base64') };
  if (v instanceof Date) return { $: 'd', v: v.getTime() };
  if (v instanceof Map) return { $: 'm', v: [...v].map(([k, x]) => [encodeValue(k), encodeValue(x)]) };
  if (v instanceof Set) return { $: 's', v: [...v].map(encodeValue) };
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`crypto store: cannot persist a ${proto?.constructor?.name ?? 'object'}`);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as object)) out[k] = encodeValue(x);
  return '$' in out ? { $: 'o', v: out } : out;
}

export function decodeValue(v: any): any {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  const decodeFields = (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = decodeValue(x);
    return out;
  };
  switch (v.$) {
    case undefined:
      return decodeFields(v);
    case 'n':
      return v.v === '-0' ? -0 : Number(v.v);
    case 'u':
      return undefined;
    case 'i':
      return BigInt(v.v);
    case 'b':
      return new Uint8Array(Buffer.from(v.v, 'base64'));
    case 'a':
      return new Uint8Array(Buffer.from(v.v, 'base64')).buffer;
    case 'd':
      return new Date(v.v);
    case 'm':
      return new Map(v.v.map(([k, x]: [unknown, unknown]) => [decodeValue(k), decodeValue(x)]));
    case 's':
      return new Set(v.v.map(decodeValue));
    case 'o':
      return decodeFields(v.v);
    default:
      throw new TypeError(`crypto store: unknown tag ${v.$}`);
  }
}

const encodeJson = (v: unknown) => JSON.stringify(encodeValue(v));

// ---------------------------------------------------------------- write-through

type Op = { op: 'put'; store: string; key?: string; value: string } | { op: 'del'; store: string; key: string } | { op: 'delKeys'; store: string; keys: string[] } | { op: 'clear'; store: string };

interface StoreSchema {
  name: string;
  keyPath: unknown;
  autoIncrement: boolean;
  indexes: { name: string; keyPath: unknown; unique: boolean; multiEntry: boolean }[];
}

/** The open store. One per adapter process, like the OlmMachine that uses it. */
let active: CryptoStore | null = null;
const pending = new WeakMap<object, Op[]>();

function opsOf(tx: any): Op[] {
  let ops = pending.get(tx);
  if (!ops) {
    ops = [];
    pending.set(tx, ops);
    const list = ops;
    const db = tx.db.name as string;
    // An aborted transaction never fires this, so its ops are simply dropped.
    tx.addEventListener('complete', () => active?.commit(db, list));
  }
  return ops;
}

const cursorStore = (cursor: any) => cursor.source.objectStore ?? cursor.source;

let patched = false;
function patchOnce() {
  if (patched) return;
  patched = true;
  const S: any = IDBObjectStore.prototype;
  const C: any = IDBCursor.prototype;
  const F: any = IDBFactory.prototype;
  const { put, add, delete: del, clear, getAllKeys } = S;
  const { update, delete: cursorDelete } = C;
  const { open, deleteDatabase } = F;

  const writer = (orig: (...a: any[]) => any) =>
    function (this: any, value: unknown, key?: unknown) {
      const req = key === undefined ? orig.call(this, value) : orig.call(this, value, key);
      if (!active) return req;
      const op: Op = { op: 'put', store: this.name, value: encodeJson(value) };
      opsOf(this.transaction).push(op);
      req.addEventListener('success', () => (op.key = encodeJson(req.result)));
      return req;
    };
  S.put = writer(put);
  S.add = writer(add);
  S.delete = function (this: any, query: unknown) {
    if (active) {
      const ops = opsOf(this.transaction);
      if (query instanceof IDBKeyRange) {
        const op: Op = { op: 'delKeys', store: this.name, keys: [] };
        ops.push(op);
        const keys = getAllKeys.call(this, query);
        keys.addEventListener('success', () => (op.keys = keys.result.map(encodeJson)));
      } else ops.push({ op: 'del', store: this.name, key: encodeJson(query) });
    }
    return del.call(this, query);
  };
  S.clear = function (this: any) {
    if (active) opsOf(this.transaction).push({ op: 'clear', store: this.name });
    return clear.call(this);
  };
  C.update = function (this: any, value: unknown) {
    const req = update.call(this, value);
    if (active) {
      const store = cursorStore(this);
      opsOf(store.transaction).push({ op: 'put', store: store.name, key: encodeJson(this.primaryKey), value: encodeJson(value) });
    }
    return req;
  };
  C.delete = function (this: any) {
    const req = cursorDelete.call(this);
    if (active) {
      const store = cursorStore(this);
      opsOf(store.transaction).push({ op: 'del', store: store.name, key: encodeJson(this.primaryKey) });
    }
    return req;
  };
  F.open = function (this: any, name: string, version?: number) {
    const req = version === undefined ? open.call(this, name) : open.call(this, name, version);
    if (!active) return req;
    let upgraded = false;
    req.addEventListener('upgradeneeded', () => (upgraded = true));
    req.addEventListener('success', () => {
      if (upgraded) active?.saveSchema(req.result);
    });
    return req;
  };
  F.deleteDatabase = function (this: any, name: string) {
    const req = deleteDatabase.call(this, name);
    if (active) req.addEventListener('success', () => active?.dropDatabase(name));
    return req;
  };
}

const done = (target: any, ok: string) =>
  new Promise<void>((resolve, reject) => {
    target.addEventListener(ok, () => resolve());
    target.addEventListener('error', () => reject(target.error));
    target.addEventListener('abort', () => reject(target.error));
  });

export class CryptoStore {
  private constructor(private readonly db: Database) {}

  /** Open the file, install a fresh in-memory IndexedDB as the global one, and replay the file into it. */
  static async open(path: string): Promise<CryptoStore> {
    if (active) throw new Error('a crypto store is already open in this process');
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
    const db = new Database(path, { create: true, strict: true });
    db.exec(SCHEMA);
    const store = new CryptoStore(db);
    const factory = new IDBFactory();
    (globalThis as any).indexedDB = factory;
    patchOnce();
    await store.replay(factory);
    active = store;
    return store;
  }

  close() {
    if (active === this) active = null;
    this.db.close();
  }

  private async replay(factory: any) {
    for (const row of this.db.query('SELECT name, version, schema FROM idb_database').all() as { name: string; version: number; schema: string }[]) {
      const schema = JSON.parse(row.schema) as StoreSchema[];
      const open = factory.open(row.name, row.version);
      open.addEventListener('upgradeneeded', () => {
        const idb = open.result;
        for (const s of schema) {
          const store = idb.createObjectStore(s.name, { keyPath: s.keyPath as any, autoIncrement: s.autoIncrement });
          for (const i of s.indexes) store.createIndex(i.name, i.keyPath as any, { unique: i.unique, multiEntry: i.multiEntry });
        }
      });
      await done(open, 'success');
      const idb = open.result;
      for (const s of schema) {
        const rows = this.db.query('SELECT key, value FROM idb_row WHERE db = ? AND store = ?').all(row.name, s.name) as { key: string; value: string }[];
        if (!rows.length) continue;
        const tx = idb.transaction([s.name], 'readwrite');
        const objectStore = tx.objectStore(s.name);
        for (const r of rows) {
          const key = decodeValue(JSON.parse(r.key));
          const value = decodeValue(JSON.parse(r.value));
          if (s.keyPath === null) objectStore.put(value, key);
          else {
            // A generated key is not in the value as it was written.
            if (s.autoIncrement && typeof s.keyPath === 'string') value[s.keyPath] = key;
            objectStore.put(value);
          }
        }
        await done(tx, 'complete');
      }
      idb.close();
    }
  }

  /** Called from inside the complete event. A failure here means memory and disk disagree, which the ratchets cannot survive. */
  commit(db: string, ops: Op[]) {
    if (!ops.length) return;
    const put = this.db.query('INSERT OR REPLACE INTO idb_row (db, store, key, value) VALUES (?, ?, ?, ?)');
    const del = this.db.query('DELETE FROM idb_row WHERE db = ? AND store = ? AND key = ?');
    const clear = this.db.query('DELETE FROM idb_row WHERE db = ? AND store = ?');
    try {
      this.db.transaction(() => {
        for (const op of ops) {
          if (op.op === 'put') {
            if (op.key !== undefined) put.run(db, op.store, op.key, op.value); // no key: the request failed and the transaction went on
          } else if (op.op === 'del') del.run(db, op.store, op.key);
          else if (op.op === 'delKeys') for (const k of op.keys) del.run(db, op.store, k);
          else clear.run(db, op.store);
        }
      })();
    } catch (e) {
      console.log(`[error] crypto store write failed, exiting so the adapter restarts from disk: ${(e as Error).message}`);
      process.exit(70);
    }
  }

  saveSchema(idb: any) {
    const names: string[] = [...idb.objectStoreNames];
    const schema: StoreSchema[] = [];
    if (names.length) {
      const tx = idb.transaction(names);
      for (const name of names) {
        const s = tx.objectStore(name);
        schema.push({
          name,
          keyPath: s.keyPath,
          autoIncrement: s.autoIncrement,
          indexes: [...s.indexNames].map((i: string) => {
            const x = s.index(i);
            return { name: i, keyPath: x.keyPath, unique: x.unique, multiEntry: x.multiEntry };
          }),
        });
      }
    }
    this.db.transaction(() => {
      this.db.query('INSERT OR REPLACE INTO idb_database (name, version, schema) VALUES (?, ?, ?)').run(idb.name, idb.version, JSON.stringify(schema));
      // A store the upgrade removed takes its rows with it.
      for (const r of this.db.query('SELECT DISTINCT store FROM idb_row WHERE db = ?').all(idb.name) as { store: string }[]) {
        if (!names.includes(r.store)) this.db.query('DELETE FROM idb_row WHERE db = ? AND store = ?').run(idb.name, r.store);
      }
    })();
  }

  dropDatabase(name: string) {
    this.db.transaction(() => {
      this.db.query('DELETE FROM idb_database WHERE name = ?').run(name);
      this.db.query('DELETE FROM idb_row WHERE db = ?').run(name);
    })();
  }
}
