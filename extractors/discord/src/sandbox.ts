/**
 * Per-account sandbox: a private screen (packages/browser/src/screen.ts: an Xvfb
 * display, or a headless Wayland compositor of its own), a NON-headless Chromium
 * running the real Discord web client with a persistent profile and our unpacked
 * extension, and a VNC server on a Unix socket in the account's directory (no TCP
 * port: packages/browser/src/vnc.ts) so the manager can carry a live view.
 *
 * Deliberately NOT automation: no Playwright/Puppeteer, no --enable-automation, no
 * --remote-debugging-port, no --headless. It is an ordinary browser window that
 * happens to run on a virtual display, so navigator.webdriver stays false and the
 * client behaves exactly as it would on the user's desktop.
 *
 * Isolation today is per-process: each account gets its own display, profile and
 * extension copy. Wrapping each sandbox in a podman container (one more boundary,
 * shared nothing) is the obvious follow-up but not needed to run.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markerKey, stampExtension } from '@dither-accounts/browser/markers';
import type { Subprocess } from 'bun';
import {
  browserShare,
  claimDisplay,
  cleanEnv,
  type DisplayBackend,
  displayBackend,
  displayTaken,
  type FreeDisplay,
  isWaylandBackend,
  gpuFlags,
  makeScreen,
  WAYLAND_NOTE,
  MEMORY_DISABLED_FEATURES,
  mergeFeatureFlags,
  portInUse,
  refreshWorker,
  resolveChromium,
  type Screen,
  type ScreenShare,
  screenFlags,
  screenPrefs,
  vncSocketPath,
} from '@dither-accounts/browser';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_SRC = join(HERE, 'extension');
const LAB_SRC = join(HERE, 'lab');

export interface SandboxOptions {
  accountDir: string;
  display: number | FreeDisplay; // pickDisplay's, or an X display number, e.g. 91 -> :91
  width: number;
  height: number;
  wsUrl: string; //      ws://127.0.0.1:<adapterPort>/
  token: string; //      per-account WebSocket token
  startUrl: string; //   e.g. https://discord.com/app
  noSandbox?: boolean; // set if the chromium suid sandbox is unavailable
  lab?: boolean; //       call lab only: the lab probe and commands go into the hook (scripts/call-lab.ts)
  markerKey?: string; //  what the copy's page-visible names are made from (packages/browser markers.ts); default: the manager's
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

export class Sandbox {
  private procs: { name: string; proc: Subprocess }[] = [];
  private stopped = false;
  readonly profileDir: string;
  readonly extensionDir: string;
  /** The live view: the VNC server's Unix socket (vnc.sock in the account directory). */
  readonly vncSocket: string;
  private screen_: Screen | null = null;
  private share: ScreenShare | null = null;

  constructor(private opts: SandboxOptions) {
    this.profileDir = join(opts.accountDir, 'profile');
    this.extensionDir = join(opts.accountDir, 'extension');
    this.vncSocket = vncSocketPath(opts.accountDir);
  }

  /** Copy the extension template, stamp this account's config into it, and give it this account's names. */
  private prepareExtension() {
    mkdirSync(this.profileDir, { recursive: true });
    // Fresh copy each start so template edits take effect; profile (the login) persists.
    rmSync(this.extensionDir, { recursive: true, force: true });
    cpSync(EXTENSION_SRC, this.extensionDir, { recursive: true });
    writeFileSync(
      join(this.extensionDir, 'config.json'),
      JSON.stringify({ wsUrl: this.opts.wsUrl, token: this.opts.token }, null, 2),
      { mode: 0o600 },
    );
    // Call lab sandboxes only (scripts/call-lab.ts): the probe and the lab commands go inside the hook.
    if (this.opts.lab) {
      const hook = join(this.extensionDir, 'hook.js');
      const lab = ['probe.js', 'lab.js'].map((f) => readFileSync(join(LAB_SRC, f), 'utf8')).join('\n');
      writeFileSync(hook, readFileSync(hook, 'utf8').replace('/*@lab@*/', () => lab));
    }
    // The names the extension leaves in the page (the channel's event types…): this install's and account's, never ours.
    const left = stampExtension(this.extensionDir, this.opts.markerKey ?? markerKey());
    if (left.length) this.opts.log('warn', 'the extension copy still holds a name that is the same for every install', left);
  }

  /** Chromium must not offer to keep a password typed into the live view: this profile runs on --password-store=basic. */
  private disablePasswordManager() {
    const path = join(this.profileDir, 'Default', 'Preferences');
    const prefs = readConfigFile<Record<string, any>>(path, {});
    prefs.credentials_enable_service = false;
    prefs.profile = { ...prefs.profile, password_manager_enabled: false };
    screenPrefs(prefs, this.opts.display);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(prefs));
  }

  /** The screen it runs on; null before start. */
  get screen(): Screen | null {
    return this.screen_;
  }

  private spawn(name: string, cmd: string[], env?: Record<string, string | undefined>): Subprocess {
    this.opts.log('debug', `spawn ${name}`, cmd.join(' '));
    const proc = Bun.spawn(cmd, {
      env: cleanEnv({ ...process.env, ...env }),
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_p, code, signal) => {
        if (!this.stopped) this.opts.log('warn', `${name} exited`, { code, signal });
      },
    });
    this.procs.push({ name, proc });
    // Drain output into the adapter log at debug level.
    for (const stream of [proc.stdout, proc.stderr]) {
      (async () => {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = dec.decode(value).trim();
          if (text) this.opts.log('debug', `[${name}] ${text.slice(0, 400)}`);
        }
      })().catch(() => {});
    }
    return proc;
  }

  async start(): Promise<{ chromium: string }> {
    const chromium = resolveChromium(this.opts.log);
    this.prepareExtension();
    this.disablePasswordManager();
    // Chromium runs the worker it first registered in this profile, not the copy's: clear it when the copy's changed.
    const worker = refreshWorker(this.opts.accountDir, this.profileDir, this.extensionDir);
    if (worker === 'cleared') this.opts.log('info', "the extension's worker is new to this profile: cleared its service workers so Chromium runs it");
    else if (worker === 'busy') this.opts.log('warn', "a browser still holds the profile: its service workers were left as they are");
    const { width, height } = this.opts;

    // 1. The screen and its live view: VNC on the account's own Unix socket and no TCP port,
    // no password (the manager carries it, behind its login), for any number of viewers.
    const screen = makeScreen({
      display: this.opts.display,
      dir: this.opts.accountDir,
      vncSocket: this.vncSocket,
      width,
      height,
      spawn: (name, cmd, o) => this.spawn(name, cmd, o.env),
      log: this.opts.log,
    });
    this.screen_ = screen;
    await screen.start();
    // On wayland a session bus of its own (never the machine's: its portal could share the owner's real screen), with
    // a portal and PipeWire that share this sandbox's screen alone, for a Go Live that is not the device's
    // (packages/browser/src/screenshare.ts). Chromium's picker asks which, in the live view.
    const shared = await browserShare(screen, { capture: true, spawn: (name, cmd, o) => this.spawn(name, cmd, o.env), log: this.opts.log });
    this.share = shared.share;

    // 2. The browser (ordinary window, persistent profile, our extension).
    const flags = [
      `--user-data-dir=${this.profileDir}`,
      `--load-extension=${this.extensionDir}`,
      // newer Chromium gates --load-extension behind this feature switch
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      // processes every browser would start and no account uses (flags.ts)
      `--disable-features=${MEMORY_DISABLED_FEATURES.join(',')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-crash-reporter',
      '--noerrdialogs',
      '--disable-infobars',
      `--window-size=${width},${height}`,
      '--window-position=0,0',
      // Calls: the client's audio feeds the bridge without anyone clicking first.
      '--autoplay-policy=no-user-gesture-required',
    ];
    flags.push(...gpuFlags(), ...screenFlags(screen), ...shared.flags);
    if (this.opts.noSandbox) flags.push('--no-sandbox');
    this.spawn('chromium', [chromium, ...mergeFeatureFlags(flags), this.opts.startUrl], { ...screen.clientEnv(), ...this.share?.clientEnv() });

    this.opts.log('info', `sandbox up: ${isWaylandBackend(screen.backend) ? WAYLAND_NOTE[screen.backend] : `display :${screen.display}`}, vnc on ${this.vncSocket}`, { chromium });
    return { chromium };
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    // Kill in reverse-ish order: browser and vnc first, display last.
    const order = ['chromium', ...(this.share?.procNames ?? []), ...(this.screen_?.procNames ?? [])];
    for (const name of order) {
      for (const p of this.procs.filter((x) => x.name === name)) {
        try {
          p.proc.kill('SIGTERM');
        } catch {}
      }
    }
    // Give them a moment, then hard-kill anything still alive.
    const killer = setTimeout(() => {
      for (const p of this.procs) {
        try {
          p.proc.kill('SIGKILL');
        } catch {}
      }
    }, 4000);
    await Promise.all(this.procs.map((p) => p.proc.exited.catch(() => {})));
    clearTimeout(killer);
    this.procs = [];
    await this.share?.stop();
    await this.screen_?.stop();
    rmSync(this.vncSocket, { force: true });
    this.opts.log('info', 'sandbox stopped');
  }

  /** True while the Chromium process is alive. */
  get browserAlive(): boolean {
    const c = this.procs.find((p) => p.name === 'chromium');
    return !!c && c.proc.exitCode === null;
  }
}

/** Discord's own displays; the other sandboxes pick theirs elsewhere (packages/browser/src/display.ts). */
export const DISCORD_DISPLAYS = { from: 91, to: 99 } as const;

/** The account's preferred slot in :91–:99, the same on every start. */
export function hashedDisplay(accountId: string): number {
  let hc = 0;
  for (const ch of accountId) hc = (hc * 31 + ch.charCodeAt(0)) >>> 0;
  return DISCORD_DISPLAYS.from + (hc % (DISCORD_DISPLAYS.to - DISCORD_DISPLAYS.from + 1));
}

/** A slot nobody holds: no X server on it, no live claim from a sandbox starting, and its extension port free. */
export async function slotFree(n: number, port: number | null): Promise<boolean> {
  if (displayTaken(n)) return false;
  if (port !== null && (await portInUse(port, '127.0.0.1'))) return false;
  return claimDisplay(n);
}

/**
 * On a Wayland backend (wayland, wayland-tigervnc), a compositor of its own (no number, nothing to pick). On an X backend (x11, tigervnc, kasmvnc,
 * turbovnc), the display from config/env
 * when set; else the account's hashed slot in :91–:99 when it is free, or the next free one after it. Two accounts can
 * hash to the same slot, and the second then failed to start ("Is port 8796 in use?", the extension port being 8700 +
 * display), so a slot is taken only when slotFree says so. Its live view is a socket, not a port.
 */
export async function pickDisplay(
  accountId: string,
  config: Record<string, any>,
  opts: { portFixed?: boolean; free?: (n: number, port: number | null) => Promise<boolean>; backend?: DisplayBackend } = {},
): Promise<FreeDisplay> {
  const backend = opts.backend ?? displayBackend();
  if (isWaylandBackend(backend)) return { backend, display: null };
  const envD = process.env.DITHER_DISPLAY ? Number(process.env.DITHER_DISPLAY) : undefined;
  if (config.display || envD) return { backend, display: Number(config.display ?? envD) };
  const free = opts.free ?? slotFree;
  const { from, to } = DISCORD_DISPLAYS;
  const span = to - from + 1;
  const start = hashedDisplay(accountId) - from;
  for (let i = 0; i < span; i++) {
    const n = from + ((start + i) % span);
    if (await free(n, opts.portFixed ? null : 8700 + n)) return { backend, display: n };
  }
  throw new Error(`no free Discord display in :${from}–:${to}; set this account's config.display to one outside it`);
}

export function readConfigFile<T = any>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}
