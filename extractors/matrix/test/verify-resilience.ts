/**
 * Device verification when the connection misbehaves, against the local testbed only.
 *
 *   bun extractors/matrix/testbed/testbed.ts up
 *   bun extractors/matrix/test/verify-resilience.ts [scenario ...]
 *
 * Runs the real adapter (src/main.ts) as a fresh device of @quinn in a temporary dir, behind a
 * proxy that can drop or stall its homeserver connection (testbed/flaky.ts), with a fake hub.
 * "The other client" is a second quinn device (test/peer.ts) that can go to the background.
 * Each scenario runs one emoji verification between them and says how it ended.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { FlakyProxy } from '../testbed/flaky.ts';
import { M, Peer } from './peer.ts';

const REPO = resolve(import.meta.dir, '../../..');
const tb = JSON.parse(readFileSync(join(process.env.DITHER_TESTBED_DIR ?? join(REPO, '.data/matrix-testbed'), 'testbed.json'), 'utf8'));
const only = process.argv.slice(2);
const token = crypto.randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'dither-verify-resilience-'));
writeFileSync(join(dir, 'secret.json'), JSON.stringify({ userId: tb.users.quinn.userId, password: tb.users.quinn.password }), { mode: 0o600 });
const proxy = new FlakyProxy(tb.baseUrl).start();

// ------------------------------------------------------------------ fake hub

const events: P.AdapterEvent[] = [];
const waiters: { pred: (e: P.AdapterEvent) => boolean; resolve: (e: P.AdapterEvent) => void }[] = [];
type Data = Record<string, never>;
const conn: { ws: import('bun').ServerWebSocket<Data> | null } = { ws: null };
const logLines: string[] = [];
const server = Bun.serve<Data, never>({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/adapter' && u.searchParams.get('token') === token && srv.upgrade(req, { data: {} })) return undefined;
    return new Response('no', { status: 401 });
  },
  websocket: {
    open(ws) {
      conn.ws = ws;
    },
    message(_ws, raw) {
      const ev = JSON.parse(String(raw)) as P.AdapterEvent;
      events.push(ev);
      if (ev.t === 'log') {
        logLines.push(`[${ev.level}] ${ev.msg}`);
        if (process.env.VERBOSE && ev.level !== 'debug') console.log(`    adapter: [${ev.level}] ${ev.msg}`);
      }
      for (const w of [...waiters]) if (w.pred(ev)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(ev);
    },
    close() {
      conn.ws = null;
    },
  },
});

function waitFor<T extends P.AdapterEvent>(pred: (e: P.AdapterEvent) => boolean, ms = 15_000, includePast = true): Promise<T> {
  const past = includePast ? events.find(pred) : undefined;
  if (past) return Promise.resolve(past as T);
  return new Promise((res, rej) => {
    const w = { pred, resolve: (e: P.AdapterEvent) => (clearTimeout(t), res(e as T)) };
    const t = setTimeout(() => (waiters.splice(waiters.indexOf(w), 1), rej(new Error('timed out waiting for an event'))), ms);
    waiters.push(w);
  });
}

async function command(cmd: Record<string, unknown>, ms = 60_000): Promise<any> {
  const id = crypto.randomUUID();
  const reply = waitFor<Extract<P.AdapterEvent, { t: 'reply' }>>((e) => e.t === 'reply' && e.id === id, ms, false);
  conn.ws!.send(JSON.stringify({ ...cmd, id }));
  const r = await reply;
  if (!r.ok) throw new Error(`${cmd.t} failed: ${r.error}`);
  return r.result;
}
const action = (name: string, args?: unknown, ms?: number) => command({ t: 'action', action: name, ...(args ? { args } : {}) }, ms);
const step = (s: string) => action('verifyDevice', { step: s });

// ADAPTER_MAIN: another copy of the adapter, e.g. an older one, for a before/after comparison.
const adapter = Bun.spawn(['bun', process.env.ADAPTER_MAIN ?? join(REPO, 'extractors/matrix/src/main.ts')], {
  cwd: REPO,
  env: {
    ...process.env,
    DITHER_HUB_URL: `ws://127.0.0.1:${server.port}/adapter`,
    DITHER_ACCOUNT_ID: 'acc_resilience',
    DITHER_ADAPTER_TOKEN: token,
    DITHER_ACCOUNT_DIR: dir,
    DITHER_ACCOUNT_CONFIG: JSON.stringify({ homeserver: proxy.url }),
  },
  stdout: 'inherit',
  stderr: 'inherit',
});

// ------------------------------------------------------------------ helpers

const results: [boolean, string][] = [];
const check = (ok: boolean, what: string, detail?: unknown) => {
  results.push([ok, what]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

async function until<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`gave up after ${ms / 1000}s waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** The adapter's verification as its latest status event shows it. */
const shown = () => {
  const st = events.filter((e): e is Extract<P.AdapterEvent, { t: 'status' }> => e.t === 'status').at(-1);
  return (st?.attention?.detail as any)?.verification as { flowId: string; phase: string; reason?: string; expiresAt?: number; otherDevice?: string } | undefined;
};

let other!: Peer;
let user!: M.UserId;
let hubDevice = '';

const open = (r: M.VerificationRequest) => !r.isDone() && !r.isCancelled() && !r.timedOut();

/** The other device's half, after a request exists on both sides: SAS until both show emoji. */
async function toEmoji(req: M.VerificationRequest, opts: { otherStarts: boolean }): Promise<M.Sas> {
  let sas: M.Sas | undefined;
  if (opts.otherStarts) {
    // As Element does when it asked: start once the adapter says ready (unless the adapter already did).
    await until(() => req.phase() === M.VerificationRequestPhase.Ready || req.getVerification(), 30_000, 'the request to be ready on the other device');
    const started = req.getVerification() ? undefined : await req.startSas();
    if (started) await other.send1(started[1]);
    sas = started?.[0] ?? (req.getVerification() as M.Sas);
    if (!sas.weStarted() && !sas.hasBeenAccepted()) {
      const accepted = sas.accept();
      if (accepted) await other.send1(accepted);
    }
  } else {
    sas = await until(() => {
      const v = req.getVerification();
      return v instanceof M.Sas ? v : undefined;
    }, 45_000, 'the adapter to start SAS');
    const accepted = sas.accept();
    if (accepted) await other.send1(accepted);
  }
  await until(() => sas!.canBePresented(), 30_000, 'emoji on the other device');
  await until(() => shown()?.phase === 'compare', 30_000, 'emoji on the adapter');
  return sas;
}

async function confirmOther(sas: M.Sas) {
  for (const out of await sas.confirm()) if (out) await other.send1(out);
}

/** How it ended, as the other device saw it, within `ms`. */
async function outcome(req: M.VerificationRequest, ms: number): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (req.isDone()) return 'verified';
    if (req.isCancelled()) return `cancelled: ${req.cancelInfo?.reason() ?? '?'}${req.cancelInfo?.cancelledbyUs() ? ' (by the other device)' : ' (by the adapter)'}`;
    await Bun.sleep(200);
  }
  return 'still open';
}

/** The adapter asks; the other device answers. */
async function hubAsks(): Promise<M.VerificationRequest> {
  const before = new Set(other.machine.getVerificationRequests(user).map((r) => r.flowId));
  await step('start');
  const req = await until(() => other.machine.getVerificationRequests(user).find((r) => !before.has(r.flowId) && open(r) && r.otherDeviceId?.toString() === hubDevice), 20_000, 'the request on the other device');
  const ready = req.acceptWithMethods([M.VerificationMethod.SasV1]);
  if (ready) await other.send1(ready);
  return req;
}

/** The other device asks; the adapter's user taps Accept. */
async function otherAsks(): Promise<M.VerificationRequest> {
  const device = await other.machine.getDevice(user, new M.DeviceId(hubDevice));
  const [req, out] = await device!.requestVerification([M.VerificationMethod.SasV1]);
  await other.send1(out);
  return req;
}

async function settle() {
  // Whatever the last scenario left open ends here, on both sides.
  for (const r of other.machine.getVerificationRequests(user)) {
    if (!open(r)) continue;
    const out = r.cancel();
    if (out) await other.send1(out).catch(() => {});
  }
  proxy.rule = () => 'pass';
  other.paused = false;
  await until(async () => !(await action('encryptionStatus')).verification || shown()?.phase === 'ended', 30_000, 'the adapter to have no flow in progress').catch(() => {});
  if (shown()?.phase === 'ended') await step('dismiss').catch(() => {});
}

const toDevice = (method: string, path: string) => method === 'PUT' && path.includes('/sendToDevice/');
const isSync = (method: string, path: string) => method === 'GET' && path.endsWith('/sync');

// ------------------------------------------------------------------ scenarios

const scenarios: Record<string, () => Promise<void>> = {
  /** Sending fails for 8 s when the user taps "Verify with another device". */
  async 'lost-request'() {
    proxy.rule = (m, p) => (toDevice(m, p) ? 'reset' : 'pass');
    setTimeout(() => (proxy.rule = () => 'pass'), 8_000);
    const req = await hubAsks();
    const sas = await toEmoji(req, { otherStarts: false });
    await confirmOther(sas);
    await step('confirm');
    const end = await outcome(req, 30_000);
    check(end === 'verified', 'lost-request: the request, sent while sending fails, still arrives and the flow finishes', end);
  },

  /** Our m.key.verification.start fails to send for 12 s, right after the other device said ready. */
  async 'lost-start'() {
    proxy.rule = (m, p) => (toDevice(m, p) && p.includes('m.key.verification.start') ? 'reset' : 'pass');
    const req = await hubAsks();
    setTimeout(() => (proxy.rule = () => 'pass'), 12_000);
    const sas = await toEmoji(req, { otherStarts: false });
    await confirmOther(sas);
    await step('confirm');
    const end = await outcome(req, 30_000);
    check(end === 'verified', 'lost-start: the start message, sent while sending fails, still arrives and the flow finishes', end);
  },

  /** The user taps "They match" while sending fails for 10 s. */
  async 'lost-confirm'() {
    const req = await hubAsks();
    const sas = await toEmoji(req, { otherStarts: false });
    await confirmOther(sas);
    proxy.rule = (m, p) => (toDevice(m, p) ? 'reset' : 'pass');
    setTimeout(() => (proxy.rule = () => 'pass'), 10_000);
    const tap = await step('confirm').then(
      () => 'ok',
      (e) => String(e.message),
    );
    console.log(`      the tap answered: ${tap}`);
    const end = await outcome(req, 40_000);
    check(end === 'verified', 'lost-confirm: our MAC, sent while sending fails, still arrives and the flow finishes', end);
  },

  /** The connection dies silently (no reset) while the emoji are up; the other device confirms meanwhile. */
  async 'dead-sync'() {
    const req = await hubAsks();
    const sas = await toEmoji(req, { otherStarts: false });
    proxy.rule = (m, p) => (isSync(m, p) ? 'hang' : 'pass');
    await proxy.refuse(50); // cut the sync already in flight, so the next one is the one that hangs
    setTimeout(() => (proxy.rule = () => 'pass'), 20_000);
    await confirmOther(sas);
    await Bun.sleep(3000);
    await step('confirm').catch((e) => console.log(`      the tap answered: ${e.message}`));
    const end = await outcome(req, 70_000);
    check(end === 'verified', 'dead-sync: a 20 s dead connection while comparing emoji does not end the flow', end);
  },

  /** The whole homeserver connection is refused for 15 s right after the other device said ready. */
  async 'refused'() {
    const req = await hubAsks();
    void proxy.refuse(15_000);
    const sas = await toEmoji(req, { otherStarts: false });
    await confirmOther(sas);
    await step('confirm');
    const end = await outcome(req, 30_000);
    check(end === 'verified', 'refused: 15 s without the homeserver while starting does not end the flow', end);
  },

  /**
   * The other device asks twice: its app was killed in the background and, reopened, asks again. It forgot
   * the first request, so no cancel for it ever reaches the adapter.
   */
  async 'newer-request'() {
    const first = await otherAsks();
    await until(() => shown()?.flowId === first.flowId && shown()?.phase === 'requested', 20_000, 'the first request on the adapter');
    first.cancel(); // forgotten, not sent
    const second = await otherAsks();
    const showsSecond = await until(() => shown()?.flowId === second.flowId && shown()?.phase === 'requested', 15_000, 'the adapter to show the newer request').then(
      () => true,
      () => false,
    );
    check(showsSecond, 'newer-request: the adapter shows the newest request, still open', { shown: shown()?.flowId === first.flowId ? 'the first' : shown() });
    check(logLines.some((l) => l.includes('cancelling the older request')), 'newer-request: and cancelled the stale one itself');
    await step('accept');
    const sas = await toEmoji(second, { otherStarts: true });
    await confirmOther(sas);
    await step('confirm');
    const end = await outcome(second, 30_000);
    check(end === 'verified', 'newer-request: the newer one finishes', end);
  },

  /** The other app goes to the background right after the user accepts here, for 75 s (longer than one emoji step may idle). */
  async 'other-in-background'() {
    const req = await otherAsks();
    await until(() => shown()?.phase === 'requested', 20_000, 'the request on the adapter');
    other.paused = true;
    await step('accept');
    await Bun.sleep(75_000);
    other.paused = false;
    const sas = await toEmoji(req, { otherStarts: true });
    await confirmOther(sas);
    await step('confirm');
    const end = await outcome(req, 30_000);
    check(end === 'verified', 'other-in-background: 75 s away before the emoji step does not end the flow', end);
  },

  /** Nobody confirms: the flow times out, the UI says so, and one tap starts again. */
  async 'timeout-then-again'() {
    const req = await hubAsks();
    await toEmoji(req, { otherStarts: false });
    const v = shown();
    check(!!v?.expiresAt && v.expiresAt > Date.now() && v.expiresAt - Date.now() <= 61_000, 'timeout-then-again: the emoji step says how long is left', v?.expiresAt ? `${Math.round((v.expiresAt - Date.now()) / 1000)}s` : v);
    check(v?.otherDevice === other.deviceId, 'timeout-then-again: and which device it is with', v?.otherDevice);
    const ended = await until(() => (shown()?.phase === 'ended' ? shown() : undefined), 120_000, 'the adapter to say it ended').catch(() => undefined);
    check(!!ended && /timed out/i.test(ended.reason ?? ''), 'timeout-then-again: a timed-out flow stays on screen with the reason', ended?.reason ?? shown());
    const again = await hubAsks();
    check(!!again, 'timeout-then-again: "start again" sends a new request');
    await toEmoji(again, { otherStarts: false });
  },
};

// ------------------------------------------------------------------ run

let failed = false;
try {
  await waitFor((e) => e.t === 'status' && e.status === 'online', 60_000);
  const st = await action('setupEncryption', {});
  hubDevice = st.deviceId;
  other = await Peer.login(tb.baseUrl, 'quinn', tb.users.quinn.password);
  user = new M.UserId(other.userId);
  // A cross-signing identity of its own, as an account set up in Element has. Only on the testbed.
  await other.bootstrapCrossSigning(tb.users.quinn.password);
  // Both devices have to know each other's keys before either can ask.
  await until(async () => !!(await other.machine.getDevice(user, new M.DeviceId(hubDevice))), 30_000, 'the other device to see the adapter device');
  await Bun.sleep(1500);
  for (const [name, run] of Object.entries(scenarios)) {
    if (only.length && !only.includes(name)) continue;
    console.log(`\n--- ${name}`);
    const t0 = Date.now();
    try {
      await run();
    } catch (e) {
      check(false, `${name}: ${(e as Error).message}`, shown());
    }
    console.log(`      (${Math.round((Date.now() - t0) / 1000)}s)`);
    await settle();
  }
} catch (e) {
  failed = true;
  console.log(`FAIL  ${(e as Error).message}`);
} finally {
  conn.ws?.send(JSON.stringify({ t: 'shutdown' }));
  await Promise.race([adapter.exited, Bun.sleep(5000)]);
  adapter.kill();
  await other?.stop().catch(() => {});
  const s = JSON.parse(readFileSync(join(dir, 'secret.json'), 'utf8'));
  if (s.accessToken) await fetch(`${tb.baseUrl}/_matrix/client/v3/logout`, { method: 'POST', headers: { authorization: `Bearer ${s.accessToken}` } }).catch(() => {});
  proxy.stop();
  server.stop(true);
  if (process.env.KEEP) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
const bad = results.filter(([ok]) => !ok).length;
if (process.env.VERBOSE || bad) console.log(`\nadapter log (warnings):\n${logLines.filter((l) => !l.startsWith('[debug]')).slice(-40).join('\n')}`);
console.log(`\n${bad || failed ? `${bad} failed` : `all ${results.length} passed`}`);
process.exit(bad || failed ? 1 : 0);
