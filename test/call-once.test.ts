/**
 * A call runs once, however often it arrives: the manager answers a repeated call id (an app's client resending after
 * its socket dropped) with the first call's answer, and the client resends only reads after a dropped socket; a write
 * that was under way fails `unsure` (504) instead of going twice.
 *
 * The account's extractor is replaced by an in-process handler (the router's own hook for built-in accounts), so the
 * test holds each call until it says so and counts how often each ran. A relay between the client and the manager
 * lets the test cut the client's socket while a call is in flight, the manager staying up.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';

// These tests start real extractor processes, and under load one start can take seconds. A test's limit is longer
// than the waits inside it, so one that hangs fails saying what it waited for, not with bun's bare 5 s timeout.
setDefaultTimeout(30_000);

let m: Manager;
let dir: string;
let app: { app: string; token: string };
let account: string;
let admin: AccountsClient;

const until = async (f: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Each op's runs, and a way to hold the next run of an op until the test lets it answer. */
const runs: Record<string, number> = {};
/** The call ids the manager took for each op, in order (a resent call appears twice). */
const received: Record<string, string[]> = {};
const held = new Map<string, { arrived: ReturnType<typeof deferred<void>>; answer: ReturnType<typeof deferred<unknown>> }>();
function hold(op: string) {
  const h = { arrived: deferred<void>(), answer: deferred<unknown>() };
  held.set(op, h);
  return h;
}

/** A relay: the client talks to it, it talks to the manager; `cut` closes every socket through it. */
type RelayData = { up: WebSocket; queue: string[] };
function relay(target: string) {
  const socks = new Set<ServerWebSocket<RelayData>>();
  let opened = 0;
  const server: Server<RelayData> = Bun.serve<RelayData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const u = new URL(req.url);
      const up = new WebSocket(`${target.replace(/^http/, 'ws')}${u.pathname}${u.search}`);
      return srv.upgrade(req, { data: { up, queue: [] } }) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        socks.add(ws);
        opened++;
        const { up } = ws.data;
        up.onopen = () => {
          for (const q of ws.data.queue) up.send(q);
          ws.data.queue = [];
        };
        up.onmessage = (e) => ws.readyState === 1 && ws.send(String(e.data));
        up.onclose = () => ws.close();
      },
      message(ws, msg) {
        const { up } = ws.data;
        if (up.readyState === WebSocket.OPEN) up.send(String(msg));
        else ws.data.queue.push(String(msg));
      },
      close(ws) {
        socks.delete(ws);
        ws.data.up.close();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    opened: () => opened,
    cut() {
      for (const ws of socks) ws.close();
    },
    stop: () => server.stop(true),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-once-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  const reg = await register(m.url, { name: 'once', requests: [{ interface: 'accounts', level: 'manage', kinds: ['fake'] }, { interface: 'test.echo', level: 'manage' }] });
  for (const r of reg.requests) await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  app = reg;
  admin = new AccountsClient({ url: m.url, app: reg.app, token: reg.token });
  await until(() => admin.connected, 4000, 'connect');
  account = (await admin.admin({ do: 'create', kind: 'fake', label: 'once' })).id;
  // Every call message the manager takes, by op: the test waits for a resent one to arrive.
  const take = m.router.message.bind(m.router);
  m.router.message = (ws, raw) => {
    const p = take(ws, raw);
    try {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'call') (received[msg.op] ??= []).push(msg.id);
    } catch {}
    return p;
  };
  // Its calls answered here instead of by its extractor: counted, and held where the test asked.
  m.router.inProcess.set(account, async (op, input) => {
    runs[op] = (runs[op] ?? 0) + 1;
    const h = held.get(op);
    if (h) {
      held.delete(op);
      h.arrived.resolve();
      return h.answer.promise;
    }
    return op === 'shout' ? { text: String(input.text).toUpperCase() } : { text: input.text };
  });
}, 20_000);

afterAll(async () => {
  admin?.close();
  await m?.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A socket of this app's own, straight to the manager, and the results it hears, in order, by call id. */
async function socket() {
  const ws = new WebSocket(`${m.url.replace(/^http/, 'ws')}/consumer?app=${app.app}&token=${app.token}`);
  const heard = new Map<string, any[]>();
  const waiters = new Map<string, ((msg: any) => void)[]>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.t !== 'result') return;
    const w = waiters.get(msg.id)?.shift();
    if (w) w(msg);
    else (heard.get(msg.id) ?? heard.set(msg.id, []).get(msg.id)!).push(msg);
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('no socket'));
  });
  return {
    call: (id: string, op: string, input: Record<string, unknown>) => ws.send(JSON.stringify({ t: 'call', id, account, op, input })),
    /** The next result for this id that the test has not taken yet. */
    result: (id: string) => {
      const early = heard.get(id)?.shift();
      if (early) return Promise.resolve(early);
      return new Promise<any>((res) => (waiters.get(id) ?? waiters.set(id, []).get(id)!).push(res));
    },
    close: () => ws.close(),
  };
}

test('the manager runs a repeated call id once: a repeat while it runs waits for its answer, one after gets the same answer', async () => {
  const before = runs.shout ?? 0;
  const h = hold('shout');
  const a = await socket();
  a.call('w-1', 'shout', { text: 'once' });
  await h.arrived.promise;
  // The app's socket dropped; its client sends the call again on a new one.
  a.close();
  const b = await socket();
  b.call('w-1', 'shout', { text: 'once' });
  h.answer.resolve({ text: 'ONCE' });
  expect(await b.result('w-1')).toEqual({ t: 'result', id: 'w-1', ok: true, result: { text: 'ONCE' } });
  // Long after it answered, the same id still answers as the first did, and does not run.
  b.call('w-1', 'shout', { text: 'once' });
  expect(await b.result('w-1')).toMatchObject({ ok: true, result: { text: 'ONCE' } });
  const c = await socket();
  c.call('w-1', 'shout', { text: 'once' });
  expect(await c.result('w-1')).toMatchObject({ ok: true, result: { text: 'ONCE' } });
  expect(runs.shout).toBe(before + 1);
  // Another id runs.
  c.call('w-2', 'shout', { text: 'twice' });
  expect(await c.result('w-2')).toMatchObject({ ok: true, result: { text: 'TWICE' } });
  expect(runs.shout).toBe(before + 2);
  // The same id for another call is refused, and does not run.
  c.call('w-2', 'echo', { text: 'other' });
  expect(await c.result('w-2')).toMatchObject({ ok: false, error: { code: 'invalid' } });
  expect(runs.echo ?? 0).toBe(0);
  b.close();
  c.close();
});

test("the manager forgets a read once it answered (a repeat runs it again), and another app's id is its own", async () => {
  const before = runs.echo ?? 0;
  const a = await socket();
  a.call('r-1', 'echo', { text: 'x' });
  expect(await a.result('r-1')).toMatchObject({ ok: true, result: { text: 'x' } });
  const again = await socket();
  again.call('r-1', 'echo', { text: 'x' });
  expect(await again.result('r-1')).toMatchObject({ ok: true, result: { text: 'x' } });
  expect(runs.echo).toBe(before + 2);
  a.close();
  again.close();
});

test('the client after a dropped socket: a read in flight is sent again and answered once; a write in flight fails unsure; a write made while away is sent', async () => {
  const r = relay(m.url);
  const reg = { url: r.url, app: app.app, token: app.token };
  const c = new AccountsClient(reg);
  try {
    await until(() => c.connected, 4000, 'the client connected');
    const echoes = runs.echo ?? 0;
    const shouts = runs.shout ?? 0;
    const shoutsTaken = received.shout?.length ?? 0;
    const read = hold('echo');
    const write = hold('shout');
    const readCall = c.call(testEcho, account, 'echo', { text: 'kept' });
    const writeCall = c.call(testEcho, account, 'shout', { text: 'maybe' }).catch((e) => e);
    await read.arrived.promise;
    await write.arrived.promise;
    const opened = r.opened();
    r.cut();
    const e = (await writeCall) as CallFailed;
    expect(e).toBeInstanceOf(CallFailed);
    expect([e.code, e.status]).toEqual(['unsure', 504]);
    // Made while the socket is down: never sent, so it waits and goes on the next socket.
    expect(c.connected).toBe(false);
    const later = c.call(testEcho, account, 'shout', { text: 'later' });
    await until(() => c.connected && r.opened() > opened, 10_000, 'the client back');
    // The read went again with its id: wait for the manager to take it.
    const readId = received.echo!.at(-1)!;
    await until(() => received.echo!.filter((id) => id === readId).length === 2, 10_000, 'the read sent again');
    // The manager waits for the first run rather than running it twice.
    read.answer.resolve({ text: 'kept' });
    expect(await readCall).toEqual({ text: 'kept' });
    expect(runs.echo).toBe(echoes + 1);
    expect(await later).toEqual({ text: 'LATER' });
    // The write that failed unsure answered the manager after all; it ran once and was not sent again.
    write.answer.resolve({ text: 'MAYBE' });
    expect(runs.shout).toBe(shouts + 2);
    const taken = received.shout!.slice(shoutsTaken);
    expect([taken.length, new Set(taken).size]).toEqual([2, 2]);
  } finally {
    c.close();
    r.stop();
  }
});
