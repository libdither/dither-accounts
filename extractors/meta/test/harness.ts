/**
 * hook.js and the fake app page (test/fake-messenger-page.js) in a plain object standing in for `window`, with the fake
 * server called directly: the hook's logic without a browser. test/messenger-browser.test.ts and
 * test/instagram-browser.test.ts run the same two scripts in a real Chromium.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';
import { FakeMetaServer, type FakeMetaOpts, SELF } from '../../../test/fake-messenger.ts';

/** The hook as the sandbox copies it: what every hook shares put in, its placeholders made into names under a key. */
const KEY = 'meta-hook-test-marker-key';
const HOOK = stampMarkers(readFileSync(join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);
const PAGE = readFileSync(join(import.meta.dir, '../../../test/fake-messenger-page.js'), 'utf8');
/** The channel's event types (packages/browser/src/page): the hook says `up`, content.js says `down`. */
export const UP = markerName(KEY, 'up');
export const DOWN = markerName(KEY, 'down');

export function harness(opts: FakeMetaOpts & { host?: string; path?: string }) {
  const server = new FakeMetaServer(opts);
  const posted: any[] = [];
  // The page's window, as far as the hook's channel goes; content.js's end answers its hello and keeps what it says.
  const events = new EventTarget();
  events.addEventListener(UP, (e: any) => {
    if (e.detail === null || e.detail === undefined) events.dispatchEvent(new CustomEvent(DOWN, { detail: null }));
    else posted.push(e.detail);
  });
  const host = opts.host ?? (opts.site === 'messenger' ? 'www.messenger.com' : 'www.instagram.com');
  const pathname = opts.path ?? (opts.site === 'messenger' ? '/' : '/direct/inbox/');
  const loc = { origin: `https://${host}`, hostname: host, pathname, href: `https://${host}${pathname}` };
  const win: any = {
    location: loc,
    addEventListener: (type: string, fn: (e: any) => void) => events.addEventListener(type, fn),
    dispatchEvent: (e: Event) => events.dispatchEvent(e),
  };
  const timers: Timer[] = [];
  const st = (fn: () => void, ms?: number) => {
    const t = setTimeout(fn, ms);
    timers.push(t);
    return t;
  };
  const si = (fn: () => void, ms?: number) => {
    const t = setInterval(fn, ms);
    timers.push(t);
    return t;
  };
  new Function('window', 'location', 'document', 'setTimeout', 'setInterval', 'clearTimeout', HOOK)(win, loc, undefined, st, si, clearTimeout);
  // The page: Meta's inline stub, a module defined before the runtime, then the runtime and the app.
  win.__d_stub = [];
  win.__d = function (...a: unknown[]) {
    win.__d_stub.push(a);
  };
  win.__d('FakeEarlyModule', [], (_g: any, _r: any, _d: any, _n: any, _l: any, _m: any, e: any) => {
    e.early = true;
  }, 98);
  const holder: any = {};
  new Function('window', PAGE)(holder);
  const app = holder.installFakeMeta(win, {
    ...opts,
    signedIn: opts.signedIn !== false,
    self: SELF,
    ui: false,
    transport: { post: (p: string, b: unknown) => server.handle(p, b), poll: (s: number) => server.poll(s) },
  });

  let seq = 0;
  /** A command to the hook, as the extension delivers it; resolves with its reply. */
  function cmd<T = any>(c: Record<string, unknown>, ms = 15_000): Promise<T> {
    const id = `t${++seq}`;
    events.dispatchEvent(new CustomEvent(DOWN, { detail: { t: 'cmd', id, cmd: c } }));
    return until(() => posted.find((p) => p.t === 'reply' && p.id === id), ms, `reply to ${c.kind}`).then((r: any) => {
      if (!r.ok) throw new Error(r.error);
      return r.result as T;
    });
  }
  const last = (t: string) => posted.filter((p) => p.t === t).at(-1);
  const all = (t: string) => posted.filter((p) => p.t === t);
  function stop() {
    app?.stop?.();
    for (const t of timers) clearTimeout(t);
  }
  return { server, win, posted, cmd, last, all, stop, app };
}

export async function until<T>(f: () => T | undefined | null | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}
