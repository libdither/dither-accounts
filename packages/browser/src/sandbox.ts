/**
 * A per-account browser sandbox (extractors/discord's, generalized): a private Xvfb display, a NON-headless Chromium
 * with a persistent profile and an unpacked MV3 extension, and an x11vnc server on a Unix socket in the account's
 * directory (and on no TCP port: vnc.ts) so the manager's page can show a live view, where you sign in once.
 *
 * Deliberately NOT automation: no Playwright/Puppeteer, no --enable-automation, no --remote-debugging-port, no
 * --headless. It is an ordinary browser window that happens to run on a virtual display, so navigator.webdriver stays
 * false and the site behaves as it would on your desktop. The extension is the only instrument.
 *
 * Each account has its own display, profile and extension copy (re-copied every start, so template edits take effect;
 * the profile, which holds the sign-in, persists). The copy is where the names the extension leaves in the page are
 * made for this install and account (markers.ts).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { markerKey, stampExtension } from './markers.ts';
import { prepareVncSocket, vncSocketPath, waitForVncSocket, x11vncArgs } from './vnc.ts';
import { refreshWorker } from './worker.ts';

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface SandboxOptions {
  accountDir: string;
  /** X display number: 80 → :80. */
  display: number;
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
  log: Log;
}

export interface Bins {
  xvfb: string;
  x11vnc: string;
  chromium: string;
}

const CHROMIUM_CANDIDATES = [`/etc/profiles/per-user/${process.env.USER}/bin/chromium`, '/run/current-system/sw/bin/chromium'];

/** Resolve a binary: env override -> PATH -> known candidates -> nix build. */
function resolveBin(name: 'Xvfb' | 'x11vnc' | 'chromium', envVar: string, nixAttr: string, candidates: string[], log: Log): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  for (const c of candidates) if (existsSync(c)) return c;
  log('info', `resolving ${name} via nix build nixpkgs#${nixAttr}`);
  const out = spawnSync('nix', ['build', `nixpkgs#${nixAttr}`, '--no-link', '--print-out-paths'], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`cannot find ${name}: set ${envVar}, put it on PATH, or make nix available (${out.stderr?.slice(0, 200) ?? out.error?.message})`);
  const store = out.stdout.trim().split('\n').pop()!.trim();
  const bin = join(store, 'bin', name);
  if (!existsSync(bin)) throw new Error(`nix built ${nixAttr} but ${bin} is missing`);
  return bin;
}

export function resolveBins(log: Log): Bins {
  return {
    xvfb: resolveBin('Xvfb', 'XVFB_BIN', 'xvfb', [], log),
    x11vnc: resolveBin('x11vnc', 'X11VNC_BIN', 'x11vnc', [], log),
    chromium: resolveBin('chromium', 'CHROMIUM_BIN', 'chromium', CHROMIUM_CANDIDATES, log),
  };
}

/**
 * Xvfb has no GL of its own, so left alone Chromium runs with WebGL off, which no ordinary desktop browser does.
 * Point it at the machine's GPU directly, or at its software renderer if there is none.
 */
function gpuFlags(): string[] {
  let render = false;
  try {
    render = readdirSync('/dev/dri').some((n) => n.startsWith('renderD'));
  } catch {
    /* no /dev/dri at all */
  }
  if (render) return ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan'];
  return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
}

/** The pid an X server wrote into its lock file, or null if it cannot be read. */
function lockOwner(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || null;
  } catch {
    return null;
  }
}

export class Sandbox {
  private procs: { name: string; proc: Subprocess }[] = [];
  private stopped = false;
  readonly profileDir: string;
  readonly extensionDir: string;
  /** The live view: x11vnc's Unix socket, for the status's liveView.vncSocket. */
  readonly vncSocket: string;

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

  /** Chromium must not offer to keep a password typed into the live view: this profile runs on --password-store=basic. */
  private disablePasswordManager() {
    const path = join(this.profileDir, 'Default', 'Preferences');
    let prefs: Record<string, any> = {};
    try {
      if (existsSync(path)) prefs = JSON.parse(readFileSync(path, 'utf8'));
    } catch {}
    prefs.credentials_enable_service = false;
    prefs.profile = { ...prefs.profile, password_manager_enabled: false };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(prefs));
  }

  private spawn(name: string, cmd: string[], env?: Record<string, string>): Subprocess {
    this.opts.log('debug', `spawn ${name}`, cmd.join(' '));
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_p, code, signal) => {
        if (!this.stopped) this.opts.log('warn', `${name} exited`, { code, signal });
      },
    });
    this.procs.push({ name, proc });
    // Drain output into the extractor's log at debug level.
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

  async start(): Promise<Bins> {
    const bins = resolveBins(this.opts.log);
    this.prepareExtension();
    this.disablePasswordManager();
    // Chromium runs the worker it first registered in this profile, not the copy's: clear it when the copy's changed.
    const worker = refreshWorker(this.opts.accountDir, this.profileDir, this.extensionDir);
    if (worker === 'cleared') this.opts.log('info', "the extension's worker is new to this profile: cleared its service workers so Chromium runs it");
    else if (worker === 'busy') this.opts.log('warn', "a browser still holds the profile: its service workers were left as they are");
    const d = `:${this.opts.display}`;
    const { width, height } = this.opts;

    // 1. Virtual display. -dpi 96: Xvfb defaults to 100, and Chromium scales itself to match, which makes its window
    // wider and taller than the display and the page cut off at the edges.
    const xvfb = this.spawn('Xvfb', [bins.xvfb, d, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-nocursor', '-dpi', '96']);
    await this.waitForDisplay(d, xvfb, 8000);

    // 2. The browser: an ordinary window, persistent profile, our extension.
    const flags = [
      `--user-data-dir=${this.profileDir}`,
      `--load-extension=${this.extensionDir}`,
      // newer Chromium gates --load-extension behind this feature switch
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
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
      ...(this.opts.flags ?? []),
    ];
    if (this.opts.noSandbox) flags.push('--no-sandbox');
    this.spawn('chromium', [bins.chromium, ...flags, this.opts.startUrl], { DISPLAY: d });

    // 3. Live view: VNC on the account's own Unix socket and no TCP port, no password (the manager carries it, behind
    // its login). -forever so it survives viewers leaving; -shared for several viewers.
    prepareVncSocket(this.vncSocket);
    const vnc = this.spawn('x11vnc', x11vncArgs(bins.x11vnc, d, this.vncSocket));
    await waitForVncSocket(this.vncSocket, vnc, 10_000);

    this.opts.log('info', `sandbox up: display ${d}, vnc on ${this.vncSocket}`);
    return bins;
  }

  /**
   * Wait for the X socket so Chromium and x11vnc never race the display; fail at once if our Xvfb gave up. Two
   * sandboxes starting together can pick the same free display: the socket is then the other one's, and ours is about
   * to exit with "already active". So the display is ours only once its lock file names our Xvfb (or a process it
   * started); a lock that cannot be read is taken as ours, as before.
   */
  private async waitForDisplay(display: string, xvfb: Subprocess, timeoutMs: number) {
    const sock = `/tmp/.X11-unix/X${display.slice(1)}`;
    const lock = `/tmp/.X${display.slice(1)}-lock`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (xvfb.exitCode !== null) throw new Error(`Xvfb on ${display} exited (${xvfb.exitCode}); is the display taken?`);
      if (existsSync(sock)) {
        const owner = lockOwner(lock);
        if (owner === null || owner === xvfb.pid || parentOf(owner) === xvfb.pid) return;
      }
      await Bun.sleep(100);
    }
    throw new Error(`Xvfb display ${display} did not come up within ${timeoutMs}ms`);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    // Browser and vnc first, display last.
    for (const name of ['chromium', 'x11vnc', 'Xvfb']) {
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
    rmSync(this.vncSocket, { force: true });
    this.opts.log('info', 'sandbox stopped');
  }

  /** True while the Chromium process is alive. */
  get browserAlive(): boolean {
    const c = this.procs.find((p) => p.name === 'chromium');
    return !!c && c.proc.exitCode === null;
  }
}
