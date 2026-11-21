/**
 * The page's port to the service worker is replaced every few minutes (packages/browser/src/page/isolated-world.js).
 * A command the worker hands to the old port just as it is replaced must still reach the hook, and only once: before
 * this, the old port was closed at once and such a command was lost (a Gmail page's sync, "did not answer in 25 s").
 *
 * In a real sandboxed Chromium (packages/browser's Sandbox: Xvfb, no automation), the shared test hook
 * (test/page-traces/ext) with its port replaced every 300 ms instead of every 250 s, under two workers: one that sends a
 * command to the page's newest port only (Proton's, as Google's, Meta's and Privacy's do) and one that sends it to
 * every port (Discord's). A stand-in for the extractor streams commands down and counts each one's replies.
 *
 * Skipped when Xvfb, chromium or x11vnc cannot be found.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { pickFreeDisplay, resolveBins, Sandbox } from '../packages/browser/src/index.ts';
import { expandIncludes } from '../packages/browser/src/markers.ts';

const ROOT = join(import.meta.dir, '..');
const EXT = join(import.meta.dir, 'page-traces/ext');
const KEY = 'port-rotation-test-marker-key-0123456789';
const TOKEN = 'port-rotation-test-token';
const WORKERS = { newest: 'extractors/proton/src/extension/sw.js', fanout: 'extractors/discord/src/extension/sw.js' } as const;
type Kind = keyof typeof WORKERS;
const COMMANDS = 600;

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`port-rotation: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let server: Server<{ kind: Kind }> | null = null;
let dir = '';
const sockets: Partial<Record<Kind, ServerWebSocket<{ kind: Kind }>>> = {};
const hooks: Record<Kind, number> = { newest: 0, fanout: 0 };
const replies: Record<Kind, Map<string, number>> = { newest: new Map(), fanout: new Map() };

async function until<T>(f: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** The test extension as its sandbox copies it, under this kind's worker, its port replaced every 300 ms. */
function prepare(kind: Kind, to: string, port: number) {
  copyFileSync(join(ROOT, WORKERS[kind]), join(to, 'sw.js'));
  writeFileSync(join(to, 'config.json'), JSON.stringify({ wsUrl: `ws://127.0.0.1:${port}/ws/${kind}`, token: TOKEN }));
  const content = expandIncludes(readFileSync(join(to, 'content.js'), 'utf8'));
  if (!/\b250000\b/.test(content)) throw new Error('content.js: no 250000 ms port rotation to shorten');
  writeFileSync(join(to, 'content.js'), content.replace(/\b250000\b/, '300'));
  const m = JSON.parse(readFileSync(join(to, 'manifest.json'), 'utf8'));
  for (const cs of m.content_scripts ?? []) cs.matches = [`http://127.0.0.1/${kind}/*`];
  m.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(join(to, 'manifest.json'), JSON.stringify(m, null, 2));
}

/** Commands streamed down while the port is replaced again and again; how many replies each one got. */
async function stream(kind: Kind) {
  const { display } = await pickFreeDisplay();
  const sb = new Sandbox({
    accountDir: join(dir, kind),
    display,
    width: 800,
    height: 600,
    extensionSrc: EXT,
    config: { wsUrl: `ws://127.0.0.1:${server!.port}/ws/${kind}`, token: TOKEN },
    prepareExtension: (d) => prepare(kind, d, server!.port!),
    markerKey: KEY,
    startUrl: `http://127.0.0.1:${server!.port}/${kind}/`,
    log: () => {},
  });
  await sb.start();
  try {
    await until(() => hooks[kind] > 0 && sockets[kind], 60_000, `${kind}'s hook`);
    const ids = Array.from({ length: COMMANDS }, (_, i) => `${kind}-${i}`);
    // Two at a time, a few milliseconds apart: about 10 port changes while they go down.
    for (let i = 0; i < ids.length; i += 2) {
      for (const id of ids.slice(i, i + 2)) sockets[kind]!.send(JSON.stringify({ t: 'cmd', id, cmd: { kind: 'probe' } }));
      await Bun.sleep(10);
    }
    // Each answered (the old port closes 10 s after it is replaced, so a lost one is lost by then), or the time is up.
    await until(() => ids.every((id) => replies[kind].has(id)), 15_000, `${kind}'s replies`).catch(() => {});
    // Time for a second reply to any of them.
    await Bun.sleep(500);
    return { missing: ids.filter((id) => !replies[kind].has(id)), twice: ids.filter((id) => (replies[kind].get(id) ?? 0) > 1) };
  } finally {
    await sb.stop();
  }
}

beforeAll(() => {
  if (!bins) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dacc-rotation-')));
  server = Bun.serve<{ kind: Kind }, never>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      const ws = u.pathname.match(/^\/ws\/(\w+)$/);
      if (ws && ws[1]! in WORKERS) {
        if (u.searchParams.get('token') !== TOKEN) return new Response('no', { status: 401 });
        return srv.upgrade(req, { data: { kind: ws[1] as Kind } }) ? undefined : new Response('no', { status: 400 });
      }
      if (u.pathname === '/ping') return new Response('pong');
      return new Response(`<!doctype html><title>page</title><body>page</body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
    websocket: {
      open(ws) {
        sockets[ws.data.kind] = ws;
      },
      message(ws, data) {
        let msg: any;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        const kind = ws.data.kind;
        if (msg.t === 'hook') hooks[kind]++;
        if (msg.t === 'reply' && typeof msg.id === 'string') replies[kind].set(msg.id, (replies[kind].get(msg.id) ?? 0) + 1);
      },
    },
  });
});

afterAll(() => {
  server?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('a worker that sends to the newest port: every command arrives across port changes, once', async () => {
  expect(await stream('newest')).toEqual({ missing: [], twice: [] });
}, 120_000);

it('a worker that sends to every port: every command arrives across port changes, once', async () => {
  expect(await stream('fanout')).toEqual({ missing: [], twice: [] });
}, 120_000);
