import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoStore, decodeValue, encodeValue } from '../src/cryptostore.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-cryptostore-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const req = <T = any>(r: any) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
const txDone = (tx: any) => new Promise<void>((res, rej) => ((tx.oncomplete = () => res()), (tx.onabort = () => rej(tx.error))));
const idb = () => (globalThis as any).indexedDB;

function openDb(version = 1) {
  const r = idb().open('test', version);
  r.onupgradeneeded = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    if (!db.objectStoreNames.contains('rows')) {
      const rows = db.createObjectStore('rows', { keyPath: 'id' });
      rows.createIndex('by_tag', 'tag', { unique: false });
    }
    if (!db.objectStoreNames.contains('auto')) db.createObjectStore('auto', { autoIncrement: true });
  };
  return req(r);
}

describe('value encoding', () => {
  test('round trips what structured clone can hold', () => {
    const v = { s: 'x', n: 1.5, z: -0, inf: Infinity, nan: NaN, u: undefined, b: true, nil: null, big: 12345678901234567890n, bytes: new Uint8Array([1, 2, 255]), date: new Date(5), map: new Map([['a', new Uint8Array([9])]]), set: new Set([1, 'two']), arr: [1, [2, { deep: new Uint8Array([3]) }]], $: 'looks like a tag' };
    const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(v))));
    expect(back).toEqual(v);
    expect(Object.is(back.z, -0)).toBe(true);
    expect(back.bytes).toBeInstanceOf(Uint8Array);
    expect('u' in back).toBe(true);
    const ab = decodeValue(JSON.parse(JSON.stringify(encodeValue(new Uint8Array([7, 8]).buffer))));
    expect(ab).toBeInstanceOf(ArrayBuffer);
  });
  test('refuses what it could not bring back', () => {
    class Odd {}
    expect(() => encodeValue(new Odd())).toThrow();
    expect(() => encodeValue(() => 1)).toThrow();
  });
});

describe('write-through IndexedDB', () => {
  const file = join(dir, 'crypto.sqlite');

  test('committed writes survive a restart; aborted ones do not', async () => {
    let store = await CryptoStore.open(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    let db = await openDb();
    let tx = db.transaction(['kv', 'rows', 'auto'], 'readwrite');
    tx.objectStore('kv').put(new Uint8Array([1, 2, 3]), 'bytes');
    tx.objectStore('kv').put({ nested: true }, ['array', 'key']);
    tx.objectStore('kv').put('gone', 'deleted-later');
    tx.objectStore('kv').put('ranged', 'r1');
    tx.objectStore('kv').put('ranged', 'r2');
    tx.objectStore('rows').add({ id: 'a', tag: 't', v: 1 });
    tx.objectStore('rows').add({ id: 'b', tag: 't', v: 2 });
    tx.objectStore('rows').add({ id: 'c', tag: 'u', v: 3 });
    tx.objectStore('auto').add({ first: true });
    await txDone(tx);

    tx = db.transaction(['kv'], 'readwrite');
    tx.objectStore('kv').delete('deleted-later');
    tx.objectStore('kv').delete((globalThis as any).IDBKeyRange.bound('r1', 'r2'));
    await txDone(tx);

    // A cursor update through an index, and a cursor delete.
    tx = db.transaction(['rows'], 'readwrite');
    const cursors = tx.objectStore('rows').index('by_tag').openCursor('t');
    cursors.onsuccess = () => {
      const c = cursors.result;
      if (!c) return;
      if (c.value.id === 'a') c.update({ ...c.value, v: 100 });
      else c.delete();
      c.continue();
    };
    await txDone(tx);

    tx = db.transaction(['kv'], 'readwrite');
    tx.objectStore('kv').put('must not persist', 'aborted');
    tx.abort();
    await txDone(tx).catch(() => {});
    db.close();
    store.close();

    store = await CryptoStore.open(file);
    db = await openDb();
    tx = db.transaction(['kv', 'rows', 'auto'], 'readwrite');
    const kv = tx.objectStore('kv');
    expect(await req(kv.get('bytes'))).toEqual(new Uint8Array([1, 2, 3]));
    expect(await req(kv.get(['array', 'key']))).toEqual({ nested: true });
    expect(await req(kv.get('deleted-later'))).toBeUndefined();
    expect(await req(kv.get('r1'))).toBeUndefined();
    expect(await req(kv.get('aborted'))).toBeUndefined();
    const rows = tx.objectStore('rows');
    expect(await req(rows.get('a'))).toEqual({ id: 'a', tag: 't', v: 100 });
    expect(await req(rows.get('b'))).toBeUndefined();
    expect((await req<any[]>(rows.index('by_tag').getAll('u'))).map((r) => r.id)).toEqual(['c']);
    // The key generator carries on after what was restored.
    const auto = tx.objectStore('auto');
    expect(await req(auto.get(1))).toEqual({ first: true });
    expect(await req(auto.add({ second: true }))).toBe(2);
    await txDone(tx);

    tx = db.transaction(['kv'], 'readwrite');
    tx.objectStore('kv').clear();
    await txDone(tx);
    db.close();
    store.close();

    store = await CryptoStore.open(file);
    db = await openDb();
    tx = db.transaction(['kv', 'auto']);
    expect(await req(tx.objectStore('kv').count())).toBe(0);
    expect(await req(tx.objectStore('auto').get(2))).toEqual({ second: true });
    db.close();
    store.close();
  });

  test('the real library keeps its identity and sessions across a restart', async () => {
    const M = await import('@matrix-org/matrix-sdk-crypto-wasm');
    await M.initAsync();
    const path = join(dir, 'machine.sqlite');
    const key = crypto.getRandomValues(new Uint8Array(32));
    const open = async () => M.OlmMachine.initFromStore(new M.UserId('@a:test'), new M.DeviceId('DEV'), await M.StoreHandle.openWithKey('dither', key));

    let store = await CryptoStore.open(path);
    let m = await open();
    const ed = m.identityKeys.ed25519.toBase64();
    const curve = m.identityKeys.curve25519.toBase64();
    const reqs = await m.outgoingRequests();
    expect(reqs.some((r) => r.type === M.RequestType.KeysUpload)).toBe(true);
    const up = reqs.find((r) => r.type === M.RequestType.KeysUpload)!;
    await m.markRequestAsSent(up.id!, up.type, JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }));
    const backup = M.BackupDecryptionKey.createRandomKey();
    await m.saveBackupDecryptionKey(backup, '7');
    m.close();
    store.close();

    store = await CryptoStore.open(path);
    m = await open();
    expect(m.identityKeys.ed25519.toBase64()).toBe(ed);
    expect(m.identityKeys.curve25519.toBase64()).toBe(curve);
    const saved = await m.getBackupKeys();
    expect(saved.backupVersion).toBe('7');
    expect(saved.decryptionKey?.toBase64()).toBe(backup.toBase64());
    // The upload was recorded as sent, so a restart does not publish the same keys again.
    expect((await m.outgoingRequests()).some((r) => r.type === M.RequestType.KeysUpload)).toBe(false);
    m.close();
    store.close();
  });
});
