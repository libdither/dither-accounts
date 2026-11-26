/**
 * A per-account browser sandbox (extractors/discord's, generalized): a private screen (screen.ts: an Xvfb display, or a
 * headless Wayland compositor of its own), a NON-headless Chromium with a persistent profile and an unpacked MV3
 * extension, and a VNC server on a Unix socket in the account's directory (and on no TCP port: vnc.ts) so the
 * manager's page can show a live view, where you sign in once.
 *
 * Deliberately NOT automation: no Playwright/Puppeteer, no --enable-automation, no --remote-debugging-port, no
 * --headless. It is an ordinary browser window that happens to run on a virtual display, so navigator.webdriver stays
 * false and the site behaves as it would on your desktop. The extension is the only instrument.
 *
 * Each account has its own display, profile and extension copy (re-copied every start, so template edits take effect;
 * the profile, which holds the sign-in, persists). The copy is where the names the extension leaves in the page are
 * made for this install and account (markers.ts).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { cleanEnv, DISPLAY_BINS, type Log, resolveBin } from './bins.ts';
import type { FreeDisplay } from './display.ts';
import { MEMORY_DISABLED_FEATURES, mergeFeatureFlags } from './flags.ts';
import { markerKey, stampExtension } from './markers.ts';
import { ChromiumNoise } from './noise.ts';
import { makeScreen, type Screen, type ScreenHealth } from './screen.ts';
import { browserShare, type ScreenShare } from './screenshare.ts';
import { renderNode } from './wayland.ts';
import { vncSocketPath } from './vnc.ts';
import { refreshWorker } from './worker.ts';

export type { Log };

export interface SandboxOptions {
  accountDir: string;
  /** The display pickFreeDisplay gave (x11 or wayland), or an X display number: 80 → :80. */
  display: number | FreeDisplay;
  /** Where the live view listens; default vnc.sock in accountDir (vncSocketPath). */
  vncSocket?: string;
  width: number;
  height: number;
  /** The unpacked extension to copy into the account directory. */
  extensionSrc: string;
  /** Written to the copy's config.json (0600): the bridge's wsUrl and token, and whatever else the extension reads. */
  config: Record<string, unknown>;
  /** Change the copy before Chromium loads it (e.g. rewrite manifest.json). Placeholders it adds are replaced too. */
  prepareExtension?: (dir: string) => void;
  /** What the copy's page-visible names are made from (markers.ts). Default: the one the manager gave this process. */
  markerKey?: string;
  startUrl: string;
  /** Extra Chromium flags. */
  flags?: string[];
  /** Set if the chromium suid sandbox is unavailable. */
  noSandbox?: boolean;
  /**
   * On a screen that needs a bus of its own (Wayland): the sandbox's own portal and PipeWire (screenshare.ts), so
   * getDisplayMedia can share this sandbox's screen and nothing else. Chromium's own picker still asks (its Entire
   * Screen tab, then Share) unless the flags say otherwise. Without it, or when those fail to start (said in the log,
   * and the sandbox starts without them), Chromium still gets a session bus of its own, an empty one: never the
   * machine's, where the owner's portal could share the owner's real screen. On x11 Chromium captures its Xvfb.
   */
  screenShare?: boolean;
  /** The screen's live view's server went down or came back (Screen.health). */
  onScreenHealth?: (h: ScreenHealth) => void;
  log: Log;
}

export interface Bins {
  xvfb: string;
  x11vnc: string;
  chromium: string;
}

const CHROMIUM = { name: 'chromium', env: 'CHROMIUM_BIN', nix: 'chromium', candidates: [`/etc/profiles/per-user/${process.env.USER}/bin/chromium`, '/run/current-system/sw/bin/chromium'] };

export function resolveChromium(log: Log): string {
  return resolveBin(CHROMIUM, log);
}

/** The x11 backend's programs and Chromium (what the tests that run a real browser on X look for). */
export function resolveBins(log: Log): Bins {
  return {
    xvfb: resolveBin(DISPLAY_BINS.xvfb, log),
    x11vnc: resolveBin(DISPLAY_BINS.x11vnc, log),
    chromium: resolveChromium(log),
  };
}

/**
 * Xvfb has no GL of its own, so left alone Chromium runs with WebGL off, which no ordinary desktop browser does.
 * Point it at the machine's GPU directly (a render node it can open), or at its software renderer if there is none.
 * The same on Wayland: sway renders with gles2 on that render node (wayland.ts), and Chromium's WebGL reports the same
 * Vulkan renderer as on X. What else depends on the screen is the screen's (Screen.chromiumFlags, adjustPrefs).
 */
export function gpuFlags(): string[] {
  if (renderNode()) return ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan'];
  return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
}

export class Sandbox {
  private procs: { name: string; proc: Subprocess }[] = [];
  private stopped = false;
  private noise = new ChromiumNoise();
  readonly profileDir: string;
  readonly extensionDir: string;
  /** The live view: the VNC server's Unix socket, for the status's liveView.vncSocket. */
  readonly vncSocket: string;
  private screen_: Screen | null = null;
  private share: ScreenShare | null = null;

  constructor(private opts: SandboxOptions) {
    this.profileDir = join(opts.accountDir, 'profile');
    this.extensionDir = join(opts.accountDir, 'extension');
    this.vncSocket = opts.vncSocket ?? vncSocketPath(opts.accountDir);
  }

  /** Copy the extension, stamp this account's config into it, and give it this account's names. */
  private prepareExtension() {
    mkdirSync(this.profileDir, { recursive: true });
    rmSync(this.extensionDir, { recursive: true, force: true });
    cpSync(this.opts.extensionSrc, this.extensionDir, { recursive: true });
    writeFileSync(join(this.extensionDir, 'config.json'), JSON.stringify(this.opts.config, null, 2), { mode: 0o600 });
    this.opts.prepareExtension?.(this.extensionDir);
    const left = stampExtension(this.extensionDir, this.opts.markerKey ?? markerKey());
    if (left.length) this.opts.log('warn', 'the extension copy still holds a name that is the same for every install', left);
  }

  /**
   * Chromium must not offer to keep a password typed into the live view: this profile runs on --password-store=basic.
   * And what the screen needs of the profile (Screen.adjustPrefs).
   */
  private writePrefs(screen: Screen) {
    const path = join(this.profileDir, 'Default', 'Preferences');
    let prefs: Record<string, any> = {};
    try {
      if (existsSync(path)) prefs = JSON.parse(readFileSync(path, 'utf8'));
    } catch {}
    prefs.credentials_enable_service = false;
    prefs.profile = { ...prefs.profile, password_manager_enabled: false };
    screen.adjustPrefs(prefs);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(prefs));
  }

  /** The screen it runs on (input, pictures); null before start. */
  get screen(): Screen | null {
    return this.screen_;
  }

  /** Whether its screen's live view's server runs (on Wayland all input goes through it): for its status. */
  get screenHealth(): ScreenHealth {
    return this.screen_?.health() ?? { ok: true };
  }

  /** Whether its screen share's portal and PipeWire run (they may have failed to start, and been left out). */
  get capturing(): boolean {
    return !!this.share?.capturing;
  }

  private spawn(name: string, cmd: string[], env?: Record<string, string | undefined>): Subprocess {
    // Nothing new once it is stopping (a live view's server started again, say): it would outlive the stop.
    if (this.stopped) throw new Error(`the sandbox is stopping: ${name} is not started`);
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
    // Drain output into the extractor's log at debug level; Chromium's own noise counted instead (noise.ts).
    const noise = name === 'chromium' ? this.noise : null;
    for (const stream of [proc.stdout, proc.stderr]) {
      (async () => {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = dec.decode(value, { stream: true }).trim();
          if (!text) continue;
          if (!noise) {
            this.opts.log('debug', `[${name}] ${text.slice(0, 400)}`);
            continue;
          }
          const kept = noise.keep(text);
          if (kept.length) this.opts.log('debug', `[${name}] ${kept.join('\n').slice(0, 400)}`);
          const said = noise.summary();
          if (said) this.opts.log('debug', `[${name}] ${said}`);
        }
      })().catch(() => {});
    }
    return proc;
  }

  async start(): Promise<{ chromium: string }> {
    const chromium = resolveChromium(this.opts.log);
    this.prepareExtension();
    // Chromium runs the worker it first registered in this profile, not the copy's: clear it when the copy's changed.
    const worker = refreshWorker(this.opts.accountDir, this.profileDir, this.extensionDir);
    if (worker === 'cleared') this.opts.log('info', "the extension's worker is new to this profile: cleared its service workers so Chromium runs it");
    else if (worker === 'busy') this.opts.log('warn', "a browser still holds the profile: its service workers were left as they are");
    const { width, height } = this.opts;

    // 1. The screen and its live view: on the account's own Unix socket and no TCP port, no password (the manager
    // carries it, behind its login), kept up for any number of viewers (screen.ts).
    const screen = makeScreen({
      display: this.opts.display,
      dir: this.opts.accountDir,
      vncSocket: this.vncSocket,
      width,
      height,
      spawn: (name, cmd, o) => this.spawn(name, cmd, o.env),
      log: this.opts.log,
      onHealth: this.opts.onScreenHealth,
    });
    this.screen_ = screen;
    this.writePrefs(screen);
    await screen.start();
    // Where the screen needs one (Wayland), a session bus of its own, with the screen share's portal on it when asked
    // for and it starts (screenshare.ts).
    const shared = await browserShare(screen, { capture: !!this.opts.screenShare, spawn: (name, cmd, o) => this.spawn(name, cmd, o.env), log: this.opts.log });
    this.share = shared.share;

    // 2. The browser: an ordinary window, persistent profile, our extension.
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
      ...gpuFlags(),
      ...screen.chromiumFlags(),
      ...shared.flags,
      ...(this.opts.flags ?? []),
    ];
    if (this.opts.noSandbox) flags.push('--no-sandbox');
    this.spawn('chromium', [chromium, ...mergeFeatureFlags(flags), this.opts.startUrl], { ...screen.clientEnv(), ...this.share?.clientEnv() });

    this.opts.log('info', `sandbox up: ${screen.describe()}, vnc on ${this.vncSocket}`);
    return { chromium };
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    // The screen first hears it is stopping, so it starts nothing again as its processes end (screen.ts KeptServer).
    await this.screen_?.stop();
    // Browser and vnc first, display last.
    for (const name of ['chromium', ...(this.share?.procNames ?? []), ...(this.screen_?.procNames ?? [])]) {
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
    const said = this.noise.summary(Date.now(), true);
    if (said) this.opts.log('debug', `[chromium] ${said}`);
    await this.share?.stop();
    rmSync(this.vncSocket, { force: true });
    this.opts.log('info', 'sandbox stopped');
  }

  /** True while the Chromium process is alive. */
  get browserAlive(): boolean {
    const c = this.procs.find((p) => p.name === 'chromium');
    return !!c && c.proc.exitCode === null;
  }
}
