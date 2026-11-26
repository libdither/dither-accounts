/**
 * The `browser` interface (packages/interfaces/src/browser.ts, docs/browser.md) for a kind on BrowserHost: the
 * account's signed-in browser, driven like a person drives it, in tabs of its own.
 *
 * The extension (browser.js, appended to the driver) reads the page and says where an element is on the screen; the
 * input itself is real: xdotool moves the mouse, clicks and presses keys on the account's own display, which this
 * extractor owns. Nothing is synthesized in the page but a <select>'s choice (browser.select).
 *
 * Only tabs this interface opened are read or touched, only URLs inside the extension's host permissions are loaded,
 * buttons that buy, pay, send or delete are pressed only by browser.press (manage), and while the kind is busy (a
 * pull) a call that brings a tab forward answers 409. Typed text and page contents never reach the log.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveImport, resolveXdotool } from '@dither-accounts/browser';
import { type Command, StatusError } from '@dither-accounts/link';
import type { BrowserHost } from './tabs.ts';

/** Words on a button that commits money, a message or a deletion. Best effort; the grant is the real line. */
export const GUARD =
  "\\b(buy now|buy it now|place (your )?order|complete (your )?(order|purchase)|confirm (and pay|purchase|payment|order)|pay( now|\\b)|submit (order|payment)|checkout|check out|proceed to (checkout|payment)|send( money| payment|\\b)|transfer|withdraw|delete|remove account|close account|subscribe( now)?|start (my |your )?(free )?trial|purchase|donate)\\b";

const IDLE_MS = 15 * 60_000;
const SETTLE_MS = 1500;
const LOAD_MS = 30_000;
/**
 * How long a call waits for the browser to come up (it was asleep and this call woke it, or it just started) before
 * answering 503: within the 30 s an op without a time of its own has.
 */
const UP_WAIT_MS = 20_000;

export interface BrowserOpsOpts {
  host: BrowserHost;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** Why the kind can't lend its browser now (a pull is running), else null. */
  busy?: () => string | null;
}

type After = { tabId: number; url: string; title: string; challenge: string | null };
type Point = { x: number; y: number; guarded: boolean; name: string; tag: string; covered: string | null; error?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** chrome match pattern → RegExp over a whole URL: https://www.example.com/*, *://*.example.com/*. */
export function matchPattern(p: string): RegExp | null {
  const m = /^(\*|https?):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(p);
  if (!m) return null;
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const scheme = m[1] === '*' ? 'https?' : m[1];
  const host = m[2] === '*' ? '[^/]+' : m[2].startsWith('*.') ? `([^/]+\\.)?${esc(m[2].slice(2))}` : esc(m[2]);
  const path = esc(m[3]).replace(/\*/g, '.*');
  return new RegExp(`^${scheme}://${host}(:\\d+)?${path}$`);
}

export class BrowserOps {
  /** Tabs this interface opened → when last used. */
  private own = new Map<number, number>();
  private xdotool: string | null = null;
  private importBin: string | null = null;
  private timer: Timer;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private o: BrowserOpsOpts) {
    this.timer = setInterval(() => void this.reap(), 60_000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Tabs an app opened here and has not closed (closed after 15 idle minutes): a sleep would close them (link.sleep). */
  inUse(): string | null {
    return this.own.size ? `${this.own.size} browser tab(s) an app opened` : null;
  }

  /** The `browser` ops; undefined for anything else. One at a time: two callers' clicks never interleave. */
  handle(cmd: Command): Promise<unknown> | undefined {
    if (!cmd.t.startsWith('browser.')) return undefined;
    const run = this.chain.then(() => this.run(cmd));
    this.chain = run.catch(() => {});
    return run;
  }

  private async run(cmd: Command): Promise<unknown> {
    const i = cmd as Record<string, any>;
    const { host } = this.o;
    for (const end = Date.now() + UP_WAIT_MS; !host.attached && Date.now() < end; ) await sleep(250);
    if (!host.attached) throw new StatusError('the browser is not ready yet', 503, 'unavailable');
    switch (cmd.t) {
      case 'browser.tabs': {
        const tabs = [];
        for (const id of [...this.own.keys()].reverse()) {
          const t = await this.info(id).catch(() => null);
          if (t) tabs.push({ tabId: t.tabId, url: t.url, title: t.title, active: t.active });
        }
        return { tabs };
      }
      case 'browser.read': {
        const id = await this.tab(i.tabId);
        const maxText = clamp(i.maxText, 1000, 200_000, 20_000);
        const maxElements = clamp(i.maxElements, 10, 2000, 300);
        const page = await this.call<any>(id, 'read', [maxText, maxElements, GUARD]);
        const challenge = await this.call<string | null>(id, 'challenge');
        this.o.log('info', `browser.read: ${host_(page.url)}, ${page.elements.length} elements`);
        return { tabId: id, ...page, challenge };
      }
      case 'browser.shot': {
        const id = await this.tab(i.tabId);
        this.notBusy();
        await this.front(id);
        await sleep(300);
        return { tabId: id, mime: 'image/png', base64: (await this.screen()).toString('base64') };
      }
      case 'browser.open': {
        this.notBusy();
        const url = this.allowed(i.url);
        const t = await host.open(url, { active: true, timeout: LOAD_MS });
        this.own.set(t.tabId, Date.now());
        await this.front(t.tabId);
        this.o.log('info', `browser.open: ${host_(url)}`);
        return this.after(t.tabId);
      }
      case 'browser.go': {
        const id = await this.tab(i.tabId);
        this.notBusy();
        await host.go(id, this.allowed(i.url), LOAD_MS);
        return this.after(id);
      }
      case 'browser.click':
      case 'browser.press': {
        const id = await this.tab(i.tabId);
        this.notBusy();
        const p = await this.point(id, i.ref);
        if (p.guarded && cmd.t === 'browser.click')
          throw new StatusError(`"${p.name}" looks like it buys, pays, sends or deletes: only browser.press (manage) presses it`, 403, 'guarded');
        if (p.covered) this.o.log('debug', `browser: ${i.ref} is under a ${p.covered}; clicking where it shows`);
        await this.input(id, ['mousemove', '--sync', String(p.x), String(p.y), 'sleep', '0.15', 'click', '1']);
        this.o.log('info', `${cmd.t}: ${p.tag}`);
        return this.settle(id);
      }
      case 'browser.type': {
        const id = await this.tab(i.tabId);
        this.notBusy();
        if (typeof i.text !== 'string') throw new StatusError('text is required', 400);
        const p = await this.point(id, i.ref);
        await this.input(id, ['mousemove', '--sync', String(p.x), String(p.y), 'sleep', '0.15', 'click', '1', 'sleep', '0.2']);
        if (i.clear) await this.input(id, ['key', 'ctrl+a']);
        if (i.text) await this.input(id, ['type', '--delay', '35', '--', i.text]);
        if (i.enter) await this.keys(id, 'Return', 'browser.press');
        this.o.log('info', `browser.type: ${i.text.length} characters into a ${p.tag}${i.enter ? ', then Enter' : ''}`);
        return this.settle(id);
      }
      case 'browser.select': {
        const id = await this.tab(i.tabId);
        this.notBusy();
        const r = await this.call<{ chosen?: string; error?: string }>(id, 'select', [i.ref, String(i.option ?? '')]);
        if (r.error) throw new StatusError(r.error, 404);
        return this.settle(id);
      }
      case 'browser.key': {
        const id = await this.tab(i.tabId);
        this.notBusy();
        await this.keys(id, String(i.keys ?? ''), cmd.t);
        return this.settle(id);
      }
      case 'browser.scroll': {
        const id = await this.tab(i.tabId);
        this.notBusy();
        await this.front(id);
        const button = i.direction === 'up' ? '4' : '5';
        await this.input(id, ['mousemove', '--sync', '640', '450', 'click', '--repeat', '6', '--delay', '40', button]);
        await sleep(400);
        return this.after(id);
      }
      case 'browser.close': {
        const id = await this.tab(i.tabId);
        await host.close(id);
        this.own.delete(id);
        return { closed: true };
      }
    }
    throw new StatusError(`no browser operation "${cmd.t}"`, 400);
  }

  // ---------------------------------------------------------------- parts
  /** The tab a call means: the one named, which must be ours, or our newest still open. */
  private async tab(tabId: unknown): Promise<number> {
    if (tabId !== undefined && tabId !== null) {
      if (!Number.isInteger(tabId) || !this.own.has(tabId as number)) throw new StatusError(`tab ${tabId} is not one this interface opened`, 403, 'refused');
      const ok = await this.info(tabId as number).catch(() => null);
      if (!ok) {
        this.own.delete(tabId as number);
        throw new StatusError(`tab ${tabId} is closed`, 404);
      }
      this.own.set(tabId as number, Date.now());
      return tabId as number;
    }
    for (const id of [...this.own.keys()].reverse()) {
      if (await this.info(id).catch(() => null)) {
        this.own.set(id, Date.now());
        return id;
      }
      this.own.delete(id);
    }
    throw new StatusError('no tab of this interface is open: browser.open one', 404);
  }

  private info(tabId: number) {
    return this.o.host.bridge.request<{ tabId: number; url: string; title: string; active: boolean; status: string }>({ kind: 'tab.info', tabId }, 10_000);
  }
  private front(tabId: number) {
    return this.o.host.bridge.request({ kind: 'tab.front', tabId }, 10_000);
  }
  private call<T>(tabId: number, fn: string, args: unknown[] = []): Promise<T> {
    return this.o.host.bridge.request<T>({ kind: 'page.call', tabId, fn, args }, 30_000).catch((e) => {
      throw new StatusError(`the page can't be read (${String((e as Error).message ?? e).slice(0, 160)}): is it still on the account's site?`, 409);
    });
  }

  private notBusy() {
    const why = this.o.busy?.();
    if (why) throw new StatusError(`the account's browser is busy: ${why}; try again when it is done`, 409, 'busy');
  }

  private allowed(url: unknown): string {
    if (typeof url !== 'string' || !url) throw new StatusError('url is required', 400);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new StatusError(`not a URL: ${url.slice(0, 100)}`, 400);
    }
    const ext = this.o.host.sandbox?.extensionDir;
    const patterns: string[] = ext ? (JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')).host_permissions ?? []) : [];
    if (!patterns.map(matchPattern).some((r) => r?.test(u.href)))
      throw new StatusError(`${u.origin} is not this account's site (${patterns.join(', ') || 'none'})`, 403, 'refused');
    return u.href;
  }

  private async point(tabId: number, ref: unknown): Promise<Point> {
    if (typeof ref !== 'string' || !/^e\d+$/.test(ref)) throw new StatusError('ref is one browser.read gave (e1, e2…)', 400);
    await this.front(tabId);
    const p = await this.call<Point>(tabId, 'point', [ref, GUARD]);
    if (p.error) throw new StatusError(p.error, 404);
    await sleep(120);
    return p;
  }

  /** Keys, unless Enter or space would press a guarded button that has the focus (only browser.press may). */
  private async keys(tabId: number, keys: string, as: string) {
    const list = keys.split(/\s+/).filter(Boolean);
    if (!list.length) throw new StatusError('keys is required', 400);
    if (as !== 'browser.press' && list.some((k) => /^(Return|KP_Enter|space)$/i.test(k.split('+').pop()!))) {
      await this.front(tabId);
      const f = await this.call<{ guarded: boolean; name: string }>(tabId, 'focused', [GUARD]);
      if (f.guarded) throw new StatusError(`the focus is on "${f.name}", which looks like it buys, pays, sends or deletes: only browser.press presses it`, 403, 'guarded');
    }
    await this.input(tabId, ['key', '--delay', '60', '--', ...list]);
  }

  /** xdotool on the account's display, with the tab in front first. */
  private async input(tabId: number, args: string[]) {
    const { host } = this.o;
    if (host.display === null) throw new StatusError('no display', 503, 'unavailable');
    await this.front(tabId);
    this.xdotool ??= resolveXdotool(this.o.log);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(this.xdotool!, args, { env: { ...process.env, DISPLAY: `:${host.display}` }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new StatusError(`input failed: ${err.trim().slice(0, 200) || `xdotool exited ${code}`}`, 500))));
    });
  }

  /** A PNG of the whole display, as the live view shows it (Chromium won't capture a tab for a site-only extension). */
  private async screen(): Promise<Buffer> {
    const { host } = this.o;
    if (host.display === null) throw new StatusError('no display', 503, 'unavailable');
    this.importBin ??= resolveImport(this.o.log);
    return new Promise<Buffer>((resolve, reject) => {
      const p = spawn(this.importBin!, ['-window', 'root', 'png:-'], { env: { ...process.env, DISPLAY: `:${host.display}` }, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let err = '';
      p.stdout.on('data', (d: Buffer) => out.push(d));
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new StatusError(`screenshot failed: ${err.trim().slice(0, 200) || `import exited ${code}`}`, 500))));
    });
  }

  /** After input: wait for a load it started, then say where the tab is. */
  private async settle(tabId: number): Promise<After> {
    const end = Date.now() + LOAD_MS;
    await sleep(SETTLE_MS);
    for (;;) {
      const t = await this.info(tabId).catch(() => null);
      if (!t) throw new StatusError('the tab closed', 404);
      if (t.status !== 'loading' || Date.now() > end) break;
      await sleep(250);
    }
    await sleep(300);
    return this.after(tabId);
  }

  private async after(tabId: number): Promise<After> {
    const t = await this.info(tabId);
    const challenge = await this.call<string | null>(tabId, 'challenge').catch(() => null);
    if (challenge) this.o.log('warn', `browser: the page asks for ${challenge}; that is the owner's to clear in the live view`);
    return { tabId, url: t.url, title: t.title, challenge };
  }

  private async reap() {
    const now = Date.now();
    for (const [id, at] of [...this.own]) {
      if (now - at < IDLE_MS) continue;
      this.own.delete(id);
      await this.o.host.close(id).catch(() => {});
      this.o.log('info', 'browser: closed a tab left idle');
    }
  }
}

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  return Number.isInteger(v) ? Math.max(lo, Math.min(hi, v as number)) : dflt;
}
function host_(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}
