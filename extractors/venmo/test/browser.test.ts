/**
 * extractors/venmo end to end in a real Chromium (Xvfb, the extension, x11vnc) against the fake Venmo
 * (fake-venmo.ts), with a stand-in for the manager's /extractor socket: signed out it asks you to sign in in the live
 * view; you sign in (the fake's page does it) and the pull follows by itself, from the extractor's own /statement tab,
 * with the request Venmo's page makes; the seeded check fetches a closed range again and finds the same bytes; once
 * the session dies a pull skips quietly and the account stays online. Skipped without Xvfb, chromium or x11vnc.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket, Subprocess } from 'bun';
import { resolveBins } from '../../../packages/browser/src/index.ts';
import { sha256hex } from '../../statements-common/src/spool.ts';
import { activity, iso } from '../src/venmo.ts';
import { csvFor, type FakeVenmo, startFakeVenmo } from './fake-venmo.ts';

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`venmo browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakeVenmo;
let hub: Server<undefined>;
let sock: ServerWebSocket<undefined> | null = null;
let proc: Subprocess | null = null;
let dir: string;
const events: any[] = [];
const raw: string[] = [];
const replies = new Map<string, any>();

const lastStatus = () => events.filter((e) => e.t === 'status').at(-1);
const until = async (f: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await Bun.sleep(100);
  }
  const st = lastStatus();
  throw new Error(`timed out waiting for ${what}; last status ${JSON.stringify(st && { status: st.status, attention: st.attention, layers: st.layers, details: st.details })}; fake ${JSON.stringify(fake.log)}`);
};
async function call(t: string, input: Record<string, unknown> = {}) {
  const rid = `r${Math.random().toString(36).slice(2)}`;
  sock!.send(JSON.stringify({ t, rid, ...input }));
  await until(() => replies.has(rid), 10_000, `a reply to ${t}`);
  return replies.get(rid);
}
const pulls = () => events.filter((e) => e.t === 'statements.pulled');

// `bun test` runs this process in UTC, but the extractor it spawns keeps the machine's own time zone (as in
// production), so "today" is the local calendar day: in the evening Pacific time the UTC date is already tomorrow.
const [Y, M, D] = Bun.spawnSync(['date', '+%Y %m %d']).stdout.toString().trim().split(' ').map(Number);
const t = new Date(Y, M - 1, D);
const first = new Date(Y, M - 2, 1);
const recent = { start: iso(first), end: iso(t) };
const old2025 = csvFor('2025-01-01', '2025-12-31');

beforeAll(async () => {
  if (!bins) return;
  fake = startFakeVenmo();
  hub = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        sock = ws;
      },
      message(_ws, m) {
        const s = String(m);
        raw.push(s);
        const e = JSON.parse(s);
        if (e.t === 'reply') replies.set(e.id, e);
        else events.push(e);
      },
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'dacc-venmo-'));
  // Seeded as seed.ts would from a raw tree holding 2025: incremental, with 2025 to check again.
  const b = Buffer.from(old2025);
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      ranges: { '2025-01-01_2025-12-31': { sha256: sha256hex(b), file: 'venmo_2025-01-01_2025-12-31_20261102T224346Z.csv' } },
      backfilled: true,
      check: { range: '2025-01-01_2025-12-31', sha256: sha256hex(b), file: 'venmo_2025-01-01_2025-12-31_20261102T224346Z.csv', rows: activity(old2025), size: b.length },
    }),
  );
  proc = Bun.spawn(['bun', join(import.meta.dir, '../src/main.ts')], {
    env: {
      ...process.env,
      DITHER_HUB_URL: `ws://127.0.0.1:${hub.port}/extractor`,
      DITHER_ACCOUNT_ID: 'acc_venmotest',
      DITHER_ADAPTER_TOKEN: 'token',
      DITHER_ACCOUNT_DIR: dir,
      DITHER_ACCOUNT_CONFIG: JSON.stringify({ testOrigin: fake.origin, paceScale: 0.05, schedule: false }),
      DITHER_ACCOUNT_LABEL: 'Venmo test',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
}, 30_000);

afterAll(async () => {
  if (!bins) return;
  try {
    sock?.send(JSON.stringify({ t: 'shutdown' }));
  } catch {}
  const exited = proc ? await Promise.race([proc.exited, Bun.sleep(8000).then(() => null)]) : 0;
  if (exited === null) proc?.kill('SIGKILL');
  hub?.stop(true);
  fake?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

it(
  'asks for a sign-in, pulls right after it, checks the seeded range, then skips quietly when the session ends',
  async () => {
    await until(() => events.some((e) => e.t === 'hello'), 20_000, 'hello');
    expect(events.find((e) => e.t === 'hello')).toMatchObject({ interfaces: ['statements'], capabilities: ['liveView'] });

    // Signed out, never pulled: the sign-in attention, with the live view.
    await until(() => lastStatus()?.attention?.kind === 'login', 60_000, 'the sign-in attention');
    expect(lastStatus().attention.liveView).toBe(true);
    expect(lastStatus().liveView).toMatchObject({ width: 1280, height: 800 });
    expect(pulls()).toHaveLength(0);

    // You sign in; the pull follows by itself.
    fake.push('signin');
    await until(() => pulls().length === 1, 60_000, 'the pull after the sign-in');
    expect(pulls()[0]).toMatchObject({ ok: true, saved: 1 });
    // Last month to today, then the seeded 2025 again; every request signed in, with Venmo's query.
    expect(fake.requests.map((r) => [r.start, r.end, r.ok])).toEqual([
      [recent.start, recent.end, true],
      ['2025-01-01', '2025-12-31', true],
    ]);
    expect(fake.requests[0].query).toEqual(['startDate', 'endDate', 'csv', 'profileId', 'accountType']);
    const files = events.filter((e) => e.t === 'statements.file').map((e) => e.file);
    expect(files).toHaveLength(1);
    expect(files[0].dir).toBe('venmo');
    expect(files[0].name).toMatch(new RegExp(`^venmo_${recent.start}_${recent.end}_\\d{8}T\\d{6}Z\\.csv$`));
    const f = await call('statements.fetch', { id: files[0].id });
    expect(Buffer.from(f.result.base64, 'base64').toString('utf8')).toBe(csvFor(recent.start, recent.end));
    await until(() => lastStatus()?.status === 'online', 10_000, 'online');
    expect(lastStatus().details.seedCheck).toBe('2025-01-01_2025-12-31: same bytes (rows 24 → 24)');
    expect(lastStatus().layers.map((l: any) => `${l.name}:${l.state}`)).toEqual(['display:ok', 'browser:ok', 'extension:ok', 'signed in:ok', 'pull:ok']);

    // The session ends (30 idle minutes): a pull skips quietly, and the account stays online (it pulled today).
    fake.expire();
    fake.requests.splice(0);
    expect((await call('statements.refresh')).result).toEqual({ started: true });
    await until(() => pulls().length === 2, 30_000, 'the signed-out pull');
    expect(pulls()[1]).toMatchObject({ ok: true, saved: 0, skipped: 'signed-out' });
    expect(fake.requests).toHaveLength(0);
    await Bun.sleep(3000);
    expect(lastStatus().status).toBe('online');
    expect(lastStatus().attention).toBeNull();
    expect(pulls()).toHaveLength(2);
    // Venmo's profile id and the cookie never reach the manager.
    expect(raw.join('\n')).not.toContain('2468013579');
  },
  180_000,
);
