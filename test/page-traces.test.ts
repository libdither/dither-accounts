/**
 * What a page can see of our hooks (docs/page-traces.md), looked at from the page's side in a real Chromium. Every
 * hook family's real extension, copied and stamped as its sandbox copies it (and a test extension made only of what
 * every hook shares, packages/browser/src/page), is loaded into one sandboxed Chromium (packages/browser's Sandbox:
 * Xvfb, no automation), each on a probe page at its own path of a local server, with a stand-in for its extractor at
 * the other end of its service worker's WebSocket. The probe pages (test/page-traces/*.js) check what any site's own
 * script could: window messages, symbols on window, the patched natives' text, names, lengths and properties against
 * a pristine frame's, stacks and CallSites through our wrappers, the traps on the page's globals. The stand-in shows
 * each channel works end to end: every hook's first words arrive, the shared probe's command comes back, Privacy's
 * refusals reach the page, Discord joins and leaves a call.
 *
 * Skipped when Xvfb, chromium or x11vnc cannot be found.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { pickFreeDisplay, resolveBins, Sandbox, stampExtension } from '../packages/browser/src/index.ts';

const ROOT = join(import.meta.dir, '..');
const HERE = join(import.meta.dir, 'page-traces');
const KEY = 'page-traces-test-marker-key-0123456789';
const TOKEN = 'page-traces-test-token';
const KINDS = ['shared', 'google', 'privacy', 'proton', 'discord', 'meta', 'x'] as const;
type Kind = (typeof KINDS)[number];

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`page-traces: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

const results: Partial<Record<Kind, { fails: string[]; extra: any }>> = {};
const frames: Record<string, any[]> = {};
const sockets: Record<string, ServerWebSocket<{ kind: string; origin: string }>> = {};
const origins: Record<string, string> = {};
let sharedProbe: any = null;
let callJoined: any = null;
let server: Server<{ kind: string; origin: string }> | null = null;
let sb: Sandbox | null = null;
let dir = '';
const errors: string[] = [];

async function until<T>(f: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}
const send = (kind: string, msg: unknown) => sockets[kind]?.send(JSON.stringify(msg));
const reply = (kind: string, id: string) => frames[kind]?.find((f) => f.t === 'reply' && f.id === id);
/** A command down the extension to the hook, as the extractor sends it; its reply. */
async function command(kind: string, id: string, cmd: unknown) {
  send(kind, { t: 'cmd', id, cmd });
  return until(() => reply(kind, id), 15_000, `${kind}'s reply to ${id}`);
}

/** What the extractor's side does when a hook says something. */
function heard(kind: string, msg: any) {
  // Privacy: the extractor refuses a get as having no passkey for it, and a create as one it already has.
  if (kind === 'privacy' && msg.t === 'webauthn') {
    const get = msg.op === 'get';
    send(kind, { t: 'cmd', id: `a-${msg.sid}`, cmd: { kind: 'webauthn.answer', sid: msg.sid, ok: false, error: get ? 'no passkey here for this request' : 'this browser already holds a passkey for this account', code: get ? 'NotAllowedError' : 'InvalidStateError' } });
  }
  // Discord: once the hook has found the client's stores, join a voice channel in bridge mode.
  if (kind === 'discord' && msg.t === 'finders' && msg.results?.ChannelStore && !callJoined) {
    callJoined = 'asked';
    void command('discord', 'join', { kind: 'call', op: 'join', mode: 'bridge', channelId: '5', call: 'c1' }).then(
      (r) => (callJoined = r),
      (e) => (callJoined = { ok: false, error: String(e) }),
    );
  }
}

/** The next probe page; Discord's is told its extension's id (from its worker's WebSocket Origin). */
function nextAfter(kind: Kind): string | null {
  const next = KINDS[KINDS.indexOf(kind) + 1];
  if (!next) return null;
  return next === 'discord' ? `/discord/?ext=${(origins.discord ?? '').replace('chrome-extension://', '')}` : `/${next}/`;
}

/** An extension as its sandbox copies it, with its content scripts on this kind's probe path. */
function prepare(kind: Kind, to: string, port: number) {
  if (kind !== 'shared') cpSync(join(ROOT, 'extractors', kind, 'src/extension'), to, { recursive: true });
  // The test extension's worker is Discord's: it relays every frame both ways.
  else copyFileSync(join(ROOT, 'extractors/discord/src/extension/sw.js'), join(to, 'sw.js'));
  writeFileSync(join(to, 'config.json'), JSON.stringify({ wsUrl: `ws://127.0.0.1:${port}/ws/${kind}`, token: TOKEN }));
  const m = JSON.parse(readFileSync(join(to, 'manifest.json'), 'utf8'));
  for (const cs of m.content_scripts ?? []) cs.matches = [`http://127.0.0.1/${kind}/*`];
  m.host_permissions = [...(m.host_permissions ?? []), 'http://127.0.0.1/*'];
  writeFileSync(join(to, 'manifest.json'), JSON.stringify(m, null, 2));
}

beforeAll(async () => {
  if (!bins) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dacc-traces-')));
  server = Bun.serve<{ kind: string; origin: string }, never>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const u = new URL(req.url);
      const ws = u.pathname.match(/^\/ws\/(\w+)$/);
      if (ws) {
        if (u.searchParams.get('token') !== TOKEN) return new Response('no', { status: 401 });
        return srv.upgrade(req, { data: { kind: ws[1]!, origin: req.headers.get('origin') ?? '' } }) ? undefined : new Response('no', { status: 400 });
      }
      if (u.pathname === '/ping') return new Response('pong');
      if (u.pathname === '/start/') return new Response(`<!doctype html><title>start</title><script>setTimeout(() => location.assign('/shared/'), 1000)</script>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      const page = u.pathname.match(/^\/(\w+)\/$/);
      if (page && (KINDS as readonly string[]).includes(page[1]!))
        return new Response(`<!doctype html><html><head><title>${page[1]}</title><script src="/probe.js"></script><script src="/${page[1]}.js"></script></head><body></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      const js = u.pathname.match(/^\/(\w+)\.js$/);
      if (js && (js[1] === 'probe' || (KINDS as readonly string[]).includes(js[1]!))) return new Response(Bun.file(join(HERE, `${js[1]}.js`)), { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
      const done = u.pathname.match(/^\/result\/([\w-]+)$/);
      if (done && req.method === 'POST') {
        const body = await req.json();
        if (done[1] === 'discord-call') {
          // The page has looked at the call: leave it.
          await command('discord', 'leave', { kind: 'call', op: 'leave', call: 'c1' }).catch((e) => errors.push(String(e)));
          return Response.json({});
        }
        const kind = done[1] as Kind;
        // The channel both ways, while the page is still there: a command down, the hook's answer up.
        if (kind === 'shared') sharedProbe = await command('shared', 'probe', { kind: 'probe' }).catch((e) => ({ error: String(e) }));
        results[kind] = body;
        return Response.json({ next: nextAfter(kind) });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets[ws.data.kind] = ws;
        origins[ws.data.kind] = ws.data.origin;
      },
      message(ws, data) {
        let msg: any;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        (frames[ws.data.kind] ??= []).push(msg);
        heard(ws.data.kind, msg);
      },
    },
  });
  const port = server.port!;
  const dirs = KINDS.filter((k) => k !== 'shared').map((k) => {
    const to = join(dir, k);
    prepare(k, to, port);
    const left = stampExtension(to, KEY);
    if (left.length) throw new Error(`${k}: the copy still holds ${left.join(', ')}`);
    return to;
  });
  const accountDir = join(dir, 'shared');
  const { display } = await pickFreeDisplay();
  sb = new Sandbox({
    accountDir,
    display,
    width: 1280,
    height: 800,
    extensionSrc: join(HERE, 'ext'),
    config: { wsUrl: `ws://127.0.0.1:${port}/ws/shared`, token: TOKEN },
    prepareExtension: (d) => prepare('shared', d, port),
    markerKey: KEY,
    startUrl: `http://127.0.0.1:${port}/start/`,
    // Every extension at once: the last --load-extension is the one Chromium reads.
    flags: [`--load-extension=${[join(accountDir, 'extension'), ...dirs].join(',')}`],
    log: (level, msg) => {
      if (level === 'warn' || level === 'error') errors.push(`${level} ${msg}`);
    },
  });
  await sb.start();
  await until(() => results.x, 150_000, 'every probe page').catch((e) => errors.push(String(e)));
}, 200_000);

afterAll(async () => {
  await sb?.stop();
  server?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const online = (kind: string) => (frames[kind] ?? []).some((f) => f.t === 'hook' || (f.t === 'log' && /installed/.test(String(f.msg))));

it('every probe page ran', () => {
  expect({ ran: KINDS.filter((k) => !results[k]), errors: errors.filter((e) => !/exited/.test(e)) }).toEqual({ ran: [], errors: [] });
});

it('the shared mechanism: nothing a page can see, and the channel works both ways', () => {
  expect(results.shared?.fails).toEqual([]);
  expect(online('shared')).toBe(true);
  // The hook answered the command; page code it called meanwhile found no event of ours in window.event; the
  // install guard says yes once, then no.
  expect(sharedProbe).toMatchObject({ ok: true, result: { seen: 'undefined', once: [true, false] } });
});

for (const kind of KINDS.filter((k) => k !== 'shared'))
  it(`${kind}: nothing of the hook a page can see, and its channel is up`, () => {
    expect(results[kind]?.fails).toEqual([]);
    expect(online(kind)).toBe(true);
  });

it('privacy: the extractor heard each passkey request the page made', () => {
  expect((frames.privacy ?? []).filter((f) => f.t === 'webauthn').map((f) => f.op)).toEqual(['get', 'create']);
});

it('discord: a bridge call patched the media natives and put them back; the stand-in microphone passes', () => {
  expect(callJoined).toMatchObject({ ok: true });
  expect(reply('discord', 'leave')).toMatchObject({ ok: true });
  expect(results.discord?.extra?.patched).toBe(true);
  // A machine with a microphone of its own lists it, and the stand-in is not used: then there is nothing to look at.
  if (!results.discord?.extra?.mic) console.warn('page-traces: this machine lists a microphone of its own; the stand-in was not used');
  else expect(results.discord.extra.mic).toMatchObject({ capabilities: expect.arrayContaining(['deviceId', 'groupId']) });
});
