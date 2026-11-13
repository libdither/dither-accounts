/**
 * The browser half of the extension-only finance kinds (venmo, amazon, schwab): a sandbox (packages/browser: Xvfb, an
 * ordinary Chromium with the account's profile and this kind's extension, x11vnc for the live view; no CDP, no
 * Playwright) and a tab driver over the extension's bridge. The extension is statements-common/extension/driver.js
 * (copied in as sw.js) plus the kind's page.js; the extractor asks it to open a tab, load a page, run a page function
 * (read the page, or make the request the site's own page makes), bring a tab forward, close it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BridgeServer, pickFreeDisplay, Sandbox } from '@dither-accounts/browser';
import type { Link } from '@dither-accounts/link';

export const WIDTH = 1280;
export const HEIGHT = 800;
/** The extension should be talking to us this soon after the browser starts. */
const ATTACH_MS = 30_000;

export interface TabReport {
  id: number;
  /** Origin and path only. */
  url: string;
  active: boolean;
  loading?: boolean;
}
export interface TabInfo {
  tabId: number;
  /** The whole URL (the extractor's own tabs need the query, e.g. Venmo's profileId); never logged. */
  url: string;
  status?: string;
  active: boolean;
}

type Up = { t: 'ready' } | { t: 'tabs'; tabs: TabReport[] } | { t: string; [k: string]: unknown };
type Down = { kind: string; [k: string]: unknown };

export interface HostOpts {
  link: Link;
  /** The kind's extension dir: manifest.json and page.js (driver.js is added as sw.js). */
  extensionSrc: string;
  startUrl: string;
  /** Tests: the fake site's origin, added to the extension's host permissions (and its content scripts' matches). */
  testOrigin?: string | null;
  /** Tests: more of the fake site's origins (Schwab's sign-in frame), added the same way. */
  testOrigins?: string[];
  /** The kind's extension has a passkey (hook.js and content.js content scripts): passkeys.js goes in with the driver. */
  passkeys?: boolean;
  onTabs?: (tabs: TabReport[]) => void;
  onChange?: () => void;
  /** Anything else the extension says (the page hooks' `webauthn` and `hook`). */
  onMessage?: (m: { t: string; [k: string]: unknown }) => void;
}

/**
 * The driver as the extension's sw.js (with passkeys.js after it for a kind with a passkey), and in tests the fake
 * site's origins added to the host permissions and the content scripts' matches.
 */
export function prepareDriver(dir: string, opts: { passkeys?: boolean; testOrigins?: (string | null | undefined)[] } = {}) {
  const ext = join(import.meta.dir, '../extension');
  const worker = readFileSync(join(ext, 'driver.js'), 'utf8') + (opts.passkeys ? readFileSync(join(ext, 'passkeys.js'), 'utf8') : '');
  writeFileSync(join(dir, 'sw.js'), worker);
  const origins = (opts.testOrigins ?? []).filter((o): o is string => !!o);
  if (!origins.length) return;
  const path = join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.host_permissions = [...(m.host_permissions ?? []), ...origins.map((o) => `${o}/*`)];
  for (const cs of m.content_scripts ?? []) cs.matches = [...cs.matches, ...origins.map((o) => `${o}/*`)];
  writeFileSync(path, JSON.stringify(m, null, 2));
}

export type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

export class BrowserHost {
  readonly bridge: BridgeServer<Up, Down>;
  private token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
  sandbox: Sandbox | null = null;
  sandboxError: string | null = null;
  display: number | null = null;
  liveView: { vncSocket: string; width: number; height: number } | null = null;
  startedAt = 0;
  tabs: TabReport[] = [];
  private timers: Timer[] = [];
  private cleaning: Promise<void> | null = null;

  constructor(private o: HostOpts) {
    this.bridge = new BridgeServer<Up, Down>({
      token: this.token,
      onMessage: (m) => this.onBridge(m),
      onConnect: () => o.onChange?.(),
      onDisconnect: () => o.onChange?.(),
      log: (l, m, d) => o.link.log(l, m, d),
    });
  }

  get attached() {
    return this.bridge.connected;
  }
  get attachOverdue() {
    return !!this.liveView && !!this.startedAt && Date.now() - this.startedAt > ATTACH_MS;
  }
  get activeTab(): TabReport | null {
    return this.tabs.find((t) => t.active) ?? this.tabs[0] ?? null;
  }

  private onBridge(m: Up) {
    if (m.t === 'ready') this.o.link.log('info', 'extension service worker ready');
    else if (m.t === 'tabs') {
      this.tabs = Array.isArray((m as any).tabs) ? ((m as any).tabs as TabReport[]).map((t) => ({ ...t, url: String(t.url ?? '').slice(0, 300) })) : [];
      this.o.onTabs?.(this.tabs);
      this.o.onChange?.();
    } else this.o.onMessage?.(m as { t: string });
  }

  private prepare = (dir: string) => prepareDriver(dir, { passkeys: this.o.passkeys, testOrigins: [this.o.testOrigin, ...(this.o.testOrigins ?? [])] });

  async start(): Promise<boolean> {
    const { link } = this.o;
    this.bridge.start();
    this.o.onChange?.();
    const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dither-accounts', link.accountId, 'chromium');
    try {
      mkdirSync(cache, { recursive: true, mode: 0o700 });
    } catch {}
    const tried: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      let free: { display: number };
      try {
        free = await pickFreeDisplay(undefined, tried);
      } catch (e) {
        this.sandboxError = String((e as Error).message ?? e);
        break;
      }
      tried.push(free.display);
      this.display = free.display;
      const sb = new Sandbox({
        accountDir: link.accountDir,
        display: free.display,
        width: WIDTH,
        height: HEIGHT,
        extensionSrc: this.o.extensionSrc,
        config: { wsUrl: this.bridge.wsUrl, token: this.token },
        prepareExtension: this.prepare,
        startUrl: this.o.startUrl,
        // The HTTP cache is not the sign-in: keep it out of the account's directory.
        flags: [`--disk-cache-dir=${cache}`],
        noSandbox: !!link.config.noSandbox || process.env.DITHER_CHROMIUM_NO_SANDBOX === '1',
        log: (l, m, d) => link.log(l, m, d),
      });
      try {
        await sb.start();
        this.sandbox = sb;
        this.startedAt = Date.now();
        this.liveView = { vncSocket: sb.vncSocket, width: WIDTH, height: HEIGHT };
        this.sandboxError = null;
        break;
      } catch (e) {
        this.sandboxError = String((e as Error).message ?? e).slice(0, 300);
        link.log('warn', `sandbox on :${free.display} failed`, this.sandboxError);
        await sb.stop();
      }
    }
    this.o.onChange?.();
    if (!this.sandbox) return false;
    this.timers.push(setInterval(() => this.bridge.ping(), 20_000));
    this.timers.push(
      setInterval(() => {
        if (this.sandbox && !this.sandbox.browserAlive) {
          link.log('warn', 'chromium exited; exiting for a supervised restart');
          void this.stop().then(() => process.exit(1));
        }
      }, 5000),
    );
    return true;
  }

  stop(): Promise<void> {
    this.cleaning ??= (async () => {
      for (const t of this.timers) clearInterval(t);
      try {
        this.bridge.stop();
      } catch {}
      try {
        await this.sandbox?.stop();
      } catch {}
    })();
    return this.cleaning;
  }

  // ---------------------------------------------------------------- the tab driver
  private req<T>(cmd: Down, ms = 30_000): Promise<T> {
    return this.bridge.request<T>(cmd, ms);
  }
  /** A new tab (in the background unless `active`), loaded to the top frame's DOMContentLoaded. */
  open(url: string, opts: { active?: boolean; timeout?: number } = {}): Promise<TabInfo> {
    const timeout = opts.timeout ?? 60_000;
    return this.req({ kind: 'tab.open', url, active: !!opts.active, timeout }, timeout + 5000);
  }
  /** Load `url` in the tab, to DOMContentLoaded (Playwright's goto(…, wait_until="domcontentloaded")). */
  go(tabId: number, url: string, timeout = 60_000): Promise<TabInfo> {
    return this.req({ kind: 'tab.go', tabId, url, timeout }, timeout + 5000);
  }
  get(tabId: number): Promise<TabInfo> {
    return this.req({ kind: 'tab.get', tabId });
  }
  activate(tabId: number): Promise<TabInfo> {
    return this.req({ kind: 'tab.activate', tabId });
  }
  close(tabId: number): Promise<unknown> {
    return this.req({ kind: 'tab.close', tabId });
  }
  /** Run page.js's PAGE[fn](...args) in the tab's top frame; MAIN is the page's own world (its fetch, its cookies). */
  exec<T>(tabId: number, fn: string, args: unknown[] = [], world: 'ISOLATED' | 'MAIN' = 'ISOLATED', timeout = 60_000): Promise<T> {
    return this.req({ kind: 'tab.exec', tabId, fn, args, world }, timeout);
  }
  /** The same in one frame of the tab (a frameId execAll reported). */
  execIn<T>(tabId: number, frameId: number, fn: string, args: unknown[] = [], world: 'ISOLATED' | 'MAIN' = 'ISOLATED', timeout = 60_000): Promise<T> {
    return this.req({ kind: 'tab.exec', tabId, frameId, fn, args, world }, timeout);
  }
  /** The same in every frame the extension may reach (a sign-in in a frame from another host); frame 0 is the top. */
  execAll<T>(tabId: number, fn: string, args: unknown[] = [], world: 'ISOLATED' | 'MAIN' = 'ISOLATED', timeout = 60_000): Promise<{ frameId: number; result: T }[]> {
    return this.req({ kind: 'tab.exec', tabId, fn, args, world, allFrames: true }, timeout);
  }

  /** display → browser → extension, as every browser kind starts its layers. */
  layers(): Layer[] {
    const page = this.activeTab?.url ?? null;
    const host = (() => {
      try {
        return page ? new URL(page).hostname : null;
      } catch {
        return null;
      }
    })();
    const display: Layer = this.liveView
      ? { name: 'display', state: 'ok', note: `Xvfb :${this.display}, live view ready` }
      : this.sandboxError
        ? { name: 'display', state: 'failed', note: this.sandboxError }
        : { name: 'display', state: 'waiting', note: 'starting Xvfb' };
    const browser: Layer = !this.liveView
      ? { name: 'browser', state: this.sandboxError ? 'off' : 'waiting', note: 'not started yet' }
      : this.sandbox?.browserAlive
        ? { name: 'browser', state: 'ok', note: host ? `Chromium, on ${host}` : 'Chromium is running' }
        : { name: 'browser', state: 'failed', note: 'Chromium exited; the account restarts' };
    const extension: Layer = this.attached
      ? { name: 'extension', state: 'ok', note: 'attached' }
      : this.attachOverdue
        ? { name: 'extension', state: 'failed', note: 'did not attach' }
        : { name: 'extension', state: 'waiting', note: 'not attached yet' };
    return [display, browser, extension];
  }

  /** The status before the kind's own: an error, connecting, or null when the browser and extension are up. */
  baseState(): { status: string; attention: { kind: string; message: string; liveView: boolean } | null } | null {
    if (this.sandboxError && !this.liveView) return { status: 'error', attention: { kind: 'unknown', message: `The sandbox failed to start: ${this.sandboxError}`, liveView: false } };
    if (!this.liveView) return { status: 'connecting', attention: null };
    if (!this.attached) {
      if (this.attachOverdue) return { status: 'attention', attention: { kind: 'unknown', message: 'The sandbox extension did not attach; open the live view to see the browser', liveView: true } };
      return { status: 'connecting', attention: null };
    }
    return null;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** random.uniform(lo, hi) seconds, as the pullers paced themselves. */
export const pause = (lo: number, hi: number) => sleep(Math.round((lo + Math.random() * (hi - lo)) * 1000));
