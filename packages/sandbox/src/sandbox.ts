/**
 * A native app in a sandbox the extractor owns (docs/native-sandbox.md). Per account:
 *
 *   display    a private screen (packages/browser screen.ts): Xvfb (path socket only, no abstract one) with x11vnc, or
 *              a headless sway of its own with wayvnc, whose Wayland socket alone is shown to the app. The live view
 *              is on <dir>/vnc.sock (0600, in the 0700 directory) and no TCP port, outside everything the app is shown
 *   bus        a private dbus-daemon whose desktop services are ours (services.ts): notifications, portals, xdg-open
 *   files      HOME is <dir>/home; /nix/store and a handful of /etc files read-only; nothing else of the host
 *   PATH       our shims first (xdg-open and its aliases report to us over the bus), then coreutils
 *   network    its own namespace through pasta (user-mode, no host loopback, no abstract sockets of the host),
 *              or the host's when pasta is missing (said in info().network), or none
 *   downloads  <dir>/home/Downloads, watched: a file that has stopped changing is announced
 *
 * The app runs under bubblewrap with every namespace unshared but the network one pasta made. It never sees the
 * user's home, X server, compositor or session bus. What it hands to the desktop arrives as SandboxEvents.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Subprocess } from 'bun';
import { cleanEnv, type FreeDisplay, isWaylandBackend, makeScreen, noHostSession, pickFreeXDisplay, type Screen, vncSocketPath } from '@dither-accounts/browser';
import { BINS, type Log, resolveBin, type SandboxBins, sandboxBins, tryBin } from './bins.ts';
import { DBusConnection } from './dbus.ts';
import { DesktopServices, type FileRequest, fileUri, type Notification } from './services.ts';

export type Network = 'pasta' | 'host' | 'none';

export type SandboxEvent =
  | { t: 'link'; id: string; url: string; via: 'xdg-open' | 'portal'; at: number }
  | { t: 'notification'; notification: Notification; at: number }
  | { t: 'notificationClosed'; id: number; by: 'app' | 'us'; at: number }
  | { t: 'download'; download: Download; at: number }
  | { t: 'fileRequest'; request: FileRequestRecord; at: number }
  | { t: 'app'; state: 'running' | 'exited'; code?: number | null; signal?: string | null; at: number };

export interface Download {
  id: string;
  /** Relative to the downloads folder ("Telegram Desktop/photo.jpg"). */
  path: string;
  name: string;
  size: number;
  mime: string;
  at: number;
}

export interface FileRequestRecord {
  id: string;
  kind: FileRequest['kind'];
  title: string;
  /** outbox: answered with files waiting in the outbox; downloads: a save into the downloads folder; cancelled. */
  answer: 'outbox' | 'downloads' | 'cancelled';
  /** File names given to the app. */
  files: string[];
}

export interface AppSandboxOptions {
  /** The sandbox's directory (in the account directory): home/, bin/, etc/, sandbox.json, vnc.sock (the live view), wl/. */
  dir: string;
  /** The display pickFreeDisplay gave (x11 or wayland), or an X display number. */
  display: number | FreeDisplay;
  width: number;
  height: number;
  /** The app and its arguments; the program must be under /nix/store or in roBinds. */
  command: string[];
  env?: Record<string, string>;
  /** Host paths shown read-only at the same path inside (an app or script that lives outside /nix/store). */
  roBinds?: string[];
  /**
   * Host directories the app may write, shown at `dest` inside (relative to its home, or absolute): data that must
   * outlive the account directory, like a wallet (the haveno kind). Each must exist.
   */
  binds?: { src: string; dest: string }[];
  /** Default pasta (falling back to the host's network when it cannot be had). */
  network?: Network;
  /**
   * The app draws only through X (Haveno's JavaFX). On the x11 backend nothing changes. On the wayland backend it gets
   * an Xwayland of its own, inside its sandbox: xwayland-satellite as `:0`, its socket in the sandbox's private /tmp
   * and its abstract socket in the sandbox's network namespace, each X window a window of the sandbox's sway. Without
   * a network namespace of its own (network `host`, pasta missing) that abstract socket would be the machine's, so
   * the sandbox takes an X display (Xvfb) instead, as it does when xwayland-satellite cannot be had.
   */
  x11App?: boolean;
  /**
   * On the wayland backend, a compositor that renders on the GPU (gles2). Default false: the app has no render node
   * inside its sandbox (`--dev /dev` holds none), so it draws in software, and so does its compositor (pixman), which
   * spares the GPU driver's memory and start-up (docs/native-sandbox.md, "Its compositor draws in software").
   */
  gpu?: boolean;
  /** A window name (a regex) to keep fitted to the display: on X there is no window manager to maximize it. */
  fitWindow?: string;
  /** A download is announced once it has not changed for this long. */
  settleMs?: number;
  /**
   * Audio devices of the sandbox's own: a private PulseAudio server (outside the sandbox, like Xvfb) with only these
   * null sinks and the sources made from their monitors, its socket shown to the app as its session's PulseAudio.
   * Nothing reaches the machine's own sound. Without it the app has no audio server at all.
   */
  audio?: AudioDevices;
  log: Log;
  onEvent: (ev: SandboxEvent) => void;
  /** The screen's live view's server went down or came back (Screen.health; it is started again). */
  onScreenHealth?: () => void;
}

/** A null sink (what an app plays into it goes nowhere but its monitor) and sources made from sinks' monitors. */
export interface AudioDevices {
  sinks: { name: string; description: string }[];
  /** Each a remap of `from`'s monitor, so apps see an ordinary microphone rather than a monitor. */
  sources: { name: string; from: string; description: string }[];
  defaultSink?: string;
  defaultSource?: string;
}

/** The PulseAudio script for a sandbox's audio devices (no default.pa: nothing of the machine's own sound). */
export function pulseScript(a: AudioDevices, socket: string): string {
  const q = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
  const lines = [`load-module module-native-protocol-unix socket=${socket} auth-anonymous=1`];
  for (const k of a.sinks) lines.push(`load-module module-null-sink sink_name=${q(k.name)} rate=48000 sink_properties=device.description=${q(k.description)}`);
  for (const s of a.sources) lines.push(`load-module module-remap-source source_name=${q(s.name)} master=${q(s.from)}.monitor source_properties=device.description=${q(s.description)}`);
  if (a.defaultSink) lines.push(`set-default-sink ${q(a.defaultSink)}`);
  if (a.defaultSource) lines.push(`set-default-source ${q(a.defaultSource)}`);
  return `${lines.join('\n')}\n`;
}

const HOME = '/home/user';
const BIN = '/run/dither/bin';
const SHIMS = ['xdg-open', 'x-www-browser', 'www-browser', 'sensible-browser', 'gnome-open', 'kde-open', 'kde-open5'];
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', json: 'application/json',
  html: 'text/html', tgs: 'application/x-tgsticker', webm_: 'video/webm',
};
export const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
const shortId = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Where the bus socket lives: short enough for a unix socket path, private to this user. */
export function runtimeDir(dir: string): string {
  const base = process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : tmpdir();
  return join(base, 'dither-sandbox', shortId(resolve(dir)).slice(0, 12));
}

interface Proc {
  name: string;
  proc: Subprocess;
  match: string;
}

/** What xwayland-satellite logs once it is its Xwayland's window manager (appCommand). */
export const SATELLITE_READY = 'Connected to Xwayland on';

export class AppSandbox {
  readonly home: string;
  readonly downloads: string;
  readonly outbox: string;
  readonly run: string;
  /** The live view: the VNC server's Unix socket. Not under home/ or bin/, so the app never sees it. */
  readonly vncSocket: string;
  network: Network;
  private bins!: SandboxBins;
  private screen_: Screen | null = null;
  /** xwayland-satellite, for an X app on the wayland backend (x11App). */
  private satellite: string | null = null;
  private procs: Proc[] = [];
  private app: Proc | null = null;
  private bus: DBusConnection | null = null;
  services: DesktopServices | null = null;
  private stopped = false;
  private timers: Timer[] = [];
  private files = new Map<string, { size: number; mtime: number; since: number; announced: boolean }>();
  private appState: 'starting' | 'running' | 'exited' = 'starting';
  private appExits = 0;
  private appStartedAt = 0;
  private lastExit: { code: number | null; signal: string | null } | null = null;
  private linkSeq = 0;
  private reqSeq = 0;

  constructor(private o: AppSandboxOptions) {
    this.home = join(o.dir, 'home');
    this.downloads = join(this.home, 'Downloads');
    this.outbox = join(this.home, 'Outbox');
    this.run = runtimeDir(o.dir);
    this.vncSocket = vncSocketPath(o.dir);
    this.network = o.network ?? 'pasta';
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    this.killStale();
    this.bins = sandboxBins(this.o.log, { pasta: this.network === 'pasta', pulseaudio: !!this.o.audio });
    if (this.network === 'pasta' && !this.bins.pasta) {
      this.network = 'host';
      this.o.log('warn', 'pasta is not available: the app shares the host network (and its abstract sockets)');
    }
    let display = this.o.display;
    if (this.o.x11App && typeof display !== 'number' && isWaylandBackend(display.backend)) {
      // Xwayland's abstract socket would be in the machine's network namespace without one of the sandbox's own.
      let why = this.network === 'host' ? 'no network namespace of its own' : '';
      if (!why)
        try {
          this.satellite = resolveBin(BINS.satellite, this.o.log);
        } catch (e) {
          why = (e as Error).message;
        }
      if (why) {
        display = await pickFreeXDisplay();
        this.o.log('warn', `an X app on the wayland backend, but ${why}: on X display :${display.display} instead`);
      }
    }
    this.prepareFiles();

    // The display: only its path socket (X) or its Wayland socket, which is the one bound into the sandbox.
    const screen = makeScreen({
      display,
      dir: this.o.dir,
      vncSocket: this.vncSocket,
      width: this.o.width,
      height: this.o.height,
      pathSocketOnly: true,
      gpu: this.o.gpu ?? false,
      spawn: (name, cmd, o) => this.spawn(name, cmd, o.match, undefined, o.env),
      log: this.o.log,
      onHealth: () => this.o.onScreenHealth?.(),
    });
    this.screen_ = screen;
    await screen.start();

    // The bus, and our services on it before the app looks for them.
    const conf = join(this.run, 'bus.conf');
    writeFileSync(
      conf,
      `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path=${join(this.run, 'bus')}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
`,
    );
    const daemon = this.spawn('dbus-daemon', [this.bins.dbusDaemon, `--config-file=${conf}`, '--nofork', '--nopidfile', '--nosyslog'], conf);
    await this.waitFor(join(this.run, 'bus'), daemon, 5000, 'dbus-daemon');
    this.bus = await DBusConnection.connect({ address: join(this.run, 'bus'), log: this.o.log });
    this.services = new DesktopServices(this.bus, {
      link: (url, via) => this.emit({ t: 'link', id: `l${Date.now().toString(36)}${(++this.linkSeq).toString(36)}`, url, via, at: Date.now() }),
      notify: (n) => this.emit({ t: 'notification', notification: n, at: Date.now() }),
      notificationClosed: (id, by) => this.emit({ t: 'notificationClosed', id, by, at: Date.now() }),
      chooseFiles: (req) => this.chooseFiles(req),
      online: this.network !== 'none',
      log: (l, m) => this.o.log(l, m),
    });
    await this.services.register();
    void this.bus.done.then(() => {
      if (!this.stopped) this.o.log('warn', 'the sandbox bus closed');
    });

    if (this.o.audio) await this.startAudio(this.o.audio);

    this.scanDownloads(true);
    this.timers.push(setInterval(() => this.scanDownloads(false), 1000));
    // No window manager on X: keep the app's main window the size of the display. On Wayland sway tiles it; the same
    // call makes sure the window that matches is the one tiled.
    if (this.o.fitWindow && (screen.protocol === 'wayland' || tryBin(BINS.xdotool, this.o.log))) this.timers.push(setInterval(() => void this.fit(), 3000));
    this.o.log('info', `sandbox up: ${screen.describe()}, vnc on ${this.vncSocket}, network ${this.network}`);
    this.startApp();
  }

  /** The audio server's socket, outside the sandbox (shown inside as the session's PulseAudio). */
  get pulseSocket() {
    return join(this.run, 'pulse.sock');
  }

  private async startAudio(a: AudioDevices) {
    const dir = join(this.run, 'pulse');
    mkdirSync(join(dir, 'home'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'rt'), { recursive: true, mode: 0o700 });
    const script = join(dir, 'devices.pa');
    writeFileSync(script, pulseScript(a, this.pulseSocket));
    rmSync(this.pulseSocket, { force: true });
    const pa = this.spawn(
      'pulseaudio',
      [this.bins.pulseaudio!, '-n', '--daemonize=no', '--system=no', '--use-pid-file=no', '--exit-idle-time=-1', '--disallow-module-loading', '--log-target=stderr', '--log-level=1', '-F', script],
      script,
      undefined,
      // Its own home and runtime dir: no cookie, config or socket of the machine's own sound server.
      { HOME: join(dir, 'home'), XDG_RUNTIME_DIR: join(dir, 'rt'), XDG_CONFIG_HOME: join(dir, 'home') },
    );
    await this.waitFor(this.pulseSocket, pa, 8000, 'pulseaudio');
  }

  /** Start (or start again) the app; its exits arrive as `app` events and it is not restarted here. */
  startApp() {
    if (this.stopped || (this.app && this.app.proc.exitCode === null)) return;
    const cmd = [...this.wrap(), ...this.bwrapArgs(), '--', ...this.appCommand()];
    this.appState = 'starting';
    this.appStartedAt = Date.now();
    const proc = this.spawn('app', cmd, join(this.o.dir, 'home'), (code, signal) => {
      this.appState = 'exited';
      this.appExits++;
      this.lastExit = { code, signal };
      this.emit({ t: 'app', state: 'exited', code, signal, at: Date.now() });
    });
    this.app = this.procs.find((p) => p.proc === proc) ?? null;
    // Running once it has lasted a moment (a broken sandbox exits at once).
    setTimeout(() => {
      if (this.app?.proc === proc && proc.exitCode === null) {
        this.appState = 'running';
        this.emit({ t: 'app', state: 'running', at: Date.now() });
      }
    }, 1500);
  }

  /**
   * The app's command inside: as given, or for an X app on Wayland behind its own Xwayland (xwayland-satellite :0,
   * which Xwayland admits only the sandbox's user into, by its name in /etc/passwd). The app is started once satellite
   * is Xwayland's window manager, and without WAYLAND_DISPLAY: it sees X alone.
   *
   * Not as soon as the X socket is there: satellite makes the socket before its Xwayland is up and before it connects
   * to it, and an app whose window is made in between is never given a Wayland window ("Tried to set serial for
   * unknown window"; one start in eight or so under load). So the wait is for satellite's own word that it is connected
   * (its log, as the pinned 0.8.3 writes it), its log still going to the app's output as before.
   */
  private appCommand(): string[] {
    if (!this.satellite) return this.o.command;
    const script = `log=/tmp/.xwayland-satellite.log
: > "$log"
${this.satellite} :0 2>>"$log" &
sat=$!
tail -n +1 -f --pid=$sat "$log" >&2 &
i=0
until case "$(cat "$log")" in *"${SATELLITE_READY}"*) true ;; *) false ;; esac; do
  kill -0 $sat 2>/dev/null || { echo "xwayland-satellite exited" >&2; exit 1; }
  i=$((i + 1)); [ $i -lt 800 ] || { echo "xwayland-satellite did not connect to its Xwayland" >&2; exit 1; }
  sleep 0.025
done
unset WAYLAND_DISPLAY
exec "$@"
`;
    return [this.bins.sh, '-c', script, 'x11-app', ...this.o.command];
  }

  async stopApp() {
    const a = this.app;
    if (!a || a.proc.exitCode !== null) return;
    a.proc.kill('SIGTERM');
    const t = setTimeout(() => a.proc.kill('SIGKILL'), 5000);
    await a.proc.exited.catch(() => {});
    clearTimeout(t);
  }

  async restartApp() {
    await this.stopApp();
    this.startApp();
  }

  private stopping: Promise<void> | null = null;
  /** Everything down, the run directory gone. A second call (a shutdown message and SIGTERM together) waits for the first. */
  stop(): Promise<void> {
    this.stopping ??= this.stopNow();
    return this.stopping;
  }

  private async stopNow() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    try {
      this.bus?.close();
    } catch {}
    // The screen first hears it is stopping, so it starts nothing again as its processes end (KeptServer). Whatever
    // goes wrong there, the processes below are still ended.
    await this.screen_?.stop().catch((e) => this.o.log('warn', `stopping the screen: ${(e as Error).message}`));
    for (const name of ['app', 'dbus-daemon', 'pulseaudio', ...(this.screen_?.procNames ?? [])]) {
      for (const p of this.procs.filter((x) => x.name === name)) {
        try {
          p.proc.kill('SIGTERM');
        } catch {}
      }
    }
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
    // Its files once nothing writes there any more.
    for (const [what, f] of [
      ["the screen's files", () => this.screen_?.removeFiles()],
      ['sandbox.json', () => rmSync(join(this.o.dir, 'sandbox.json'), { force: true })],
      ["the live view's socket", () => rmSync(this.vncSocket, { force: true })],
      ['the run directory', () => rmSync(this.run, { recursive: true, force: true })],
    ] as const) {
      try {
        await f();
      } catch (e) {
        this.o.log('warn', `removing ${what}: ${(e as Error).message}`);
      }
    }
    this.o.log('info', 'sandbox stopped');
  }

  get appAlive() {
    return !!this.app && this.app.proc.exitCode === null;
  }

  /** The app's process on this side (pasta or bubblewrap, the app below it), while it runs. */
  get appPid(): number | null {
    return this.app && this.app.proc.exitCode === null ? this.app.proc.pid : null;
  }

  /** The screen it runs on (input, pictures, windows); null before start. */
  get screen(): Screen | null {
    return this.screen_;
  }

  info() {
    const free = this.screen_?.free ?? (typeof this.o.display === 'number' ? { backend: 'x11' as const, display: this.o.display } : this.o.display);
    return {
      /** The X display number; null on Wayland. */
      display: free.display,
      backend: free.backend,
      vncSocket: this.vncSocket,
      width: this.o.width,
      height: this.o.height,
      network: this.network,
      app: this.appState,
      appExits: this.appExits,
      lastExit: this.lastExit,
      upFor: this.appState === 'running' ? Date.now() - this.appStartedAt : 0,
      /** The bus methods the app called, e.g. "org.freedesktop.Notifications.GetCapabilities": 1. */
      busCalls: Object.fromEntries(this.bus?.served ?? []),
    };
  }

  // ---------------------------------------------------------------- the sandbox's files

  private prepareFiles() {
    for (const d of [this.o.dir, this.home, this.downloads, this.outbox, join(this.o.dir, 'bin'), join(this.o.dir, 'etc'), join(this.home, '.config'), join(this.home, '.local/share/applications'), this.run]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
    }
    chmodSync(this.o.dir, 0o700);
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 100;
    const etc = join(this.o.dir, 'etc');
    writeFileSync(join(etc, 'passwd'), `user:x:${uid}:${gid}:user:${HOME}:/bin/sh\n`);
    writeFileSync(join(etc, 'group'), `user:x:${gid}:\n`);
    const mid = join(etc, 'machine-id');
    if (!existsSync(mid)) writeFileSync(mid, `${randomBytes(16).toString('hex')}\n`);

    // The shims: every way an app hands a link to "the browser" reaches us, over the bus.
    const shim = `#!${this.bins.sh}
# The sandbox's ${'$'}{0##*/}: the link goes to the account's extractor over the sandbox's session bus (docs/native-sandbox.md).
[ $# -ge 1 ] || { echo "usage: \${0##*/} <url>" >&2; exit 1; }
exec ${this.bins.dbusSend} --session --print-reply=literal --reply-timeout=10000 --dest=net.dither.Sandbox /net/dither/Sandbox net.dither.Sandbox.Open "string:$1" >/dev/null
`;
    for (const name of SHIMS) {
      const p = join(this.o.dir, 'bin', name);
      writeFileSync(p, shim, { mode: 0o755 });
    }
    // GLib apps without portals open links by their default handler: make that the shim too.
    writeFileSync(
      join(this.home, '.local/share/applications/dither-open.desktop'),
      `[Desktop Entry]\nType=Application\nName=Open outside the sandbox\nExec=${BIN}/xdg-open %u\nNoDisplay=true\nMimeType=x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/mailto;text/html;\n`,
    );
    mergeMimeapps(join(this.home, '.config/mimeapps.list'), ['x-scheme-handler/http', 'x-scheme-handler/https', 'x-scheme-handler/mailto', 'text/html'], 'dither-open.desktop');
    writeFileSync(
      join(this.home, '.config/user-dirs.dirs'),
      'XDG_DOWNLOAD_DIR="$HOME/Downloads"\nXDG_DOCUMENTS_DIR="$HOME/Downloads"\nXDG_PICTURES_DIR="$HOME/Downloads"\nXDG_VIDEOS_DIR="$HOME/Downloads"\nXDG_MUSIC_DIR="$HOME/Downloads"\nXDG_DESKTOP_DIR="$HOME"\n',
    );
  }

  private wrap(): string[] {
    if (this.network !== 'pasta' || !this.bins.pasta) return [];
    // A network namespace of its own: user-mode networking out, nothing in, the host's loopback not mapped.
    return [this.bins.pasta, '--config-net', '--quiet', '-t', 'none', '-u', 'none', '-T', 'none', '-U', 'none', '--no-map-gw', '--'];
  }

  private bwrapArgs(): string[] {
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 100;
    const run = `/run/user/${uid}`;
    const screen = this.screen_!;
    const a = [this.bins.bwrap, '--unshare-all', ...(this.network === 'none' ? [] : ['--share-net']), '--uid', String(uid), '--gid', String(gid), '--hostname', 'sandbox'];
    a.push('--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
    a.push('--ro-bind', '/nix/store', '/nix/store');
    if (existsSync('/run/opengl-driver')) a.push('--ro-bind', '/run/opengl-driver', '/run/opengl-driver');
    // /etc: what name lookups, TLS, fonts and the clock need, each resolved out of NixOS's symlinks.
    for (const p of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime', '/etc/fonts', '/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/certs/ca-bundle.crt', '/etc/pki/tls/certs/ca-bundle.crt']) {
      const r = realOrNull(p);
      if (r) a.push('--ro-bind', r, p);
    }
    const etc = join(this.o.dir, 'etc');
    a.push('--ro-bind', join(etc, 'passwd'), '/etc/passwd', '--ro-bind', join(etc, 'group'), '/etc/group', '--ro-bind', join(etc, 'machine-id'), '/etc/machine-id');
    // The display's one socket: X's path socket, or the compositor's Wayland socket at a path of the app's own.
    if (screen.protocol === 'x11') a.push('--dir', '/tmp/.X11-unix', '--bind', screen.socket, screen.socket);
    a.push('--dir', run, '--chmod', '0700', run, '--bind', join(this.run, 'bus'), `${run}/bus`);
    if (screen.protocol === 'wayland') a.push('--bind', screen.socket, `${run}/wayland-0`);
    if (this.o.audio) a.push('--dir', `${run}/pulse`, '--bind', this.pulseSocket, `${run}/pulse/native`);
    a.push('--bind', this.home, HOME, '--ro-bind', join(this.o.dir, 'bin'), BIN);
    a.push('--symlink', this.bins.sh, '/bin/sh', '--symlink', join(this.bins.coreutils, 'env'), '/usr/bin/env');
    for (const p of this.o.roBinds ?? []) a.push('--ro-bind', p, p);
    for (const b of this.o.binds ?? []) a.push('--bind', b.src, b.dest.startsWith('/') ? b.dest : join(HOME, b.dest));
    a.push('--chdir', HOME, '--clearenv');
    const env: Record<string, string> = {
      HOME,
      USER: 'user',
      LOGNAME: 'user',
      SHELL: '/bin/sh',
      PATH: `${BIN}:${this.bins.coreutils}`,
      ...displayEnv(screen, run),
      ...(this.satellite ? { DISPLAY: ':0', QT_QPA_PLATFORM: 'xcb', GDK_BACKEND: 'x11', SDL_VIDEODRIVER: 'x11', XDG_SESSION_TYPE: 'x11' } : {}),
      XDG_RUNTIME_DIR: run,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${run}/bus`,
      // No system bus: an address with nothing there (none is shown inside either).
      DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${run}/no-system-bus`,
      XDG_CONFIG_HOME: `${HOME}/.config`,
      XDG_DATA_HOME: `${HOME}/.local/share`,
      XDG_CACHE_HOME: `${HOME}/.cache`,
      XDG_STATE_HOME: `${HOME}/.local/state`,
      LANG: 'en_US.UTF-8',
      BROWSER: `${BIN}/xdg-open`,
      // Qt's file dialogs through the FileChooser portal (ours); GLib's link opening through OpenURI (ours).
      QT_QPA_PLATFORMTHEME: 'xdgdesktopportal',
      GTK_USE_PORTAL: '1',
      GIO_USE_PORTALS: '1',
      // No accessibility bus here (an AT-SPI tap would be ours to add: docs/native-sandbox.md).
      NO_AT_BRIDGE: '1',
      ...(this.o.audio ? { PULSE_SERVER: `unix:${run}/pulse/native` } : {}),
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
      ...(process.env.LOCALE_ARCHIVE?.startsWith('/nix/store/') ? { LOCALE_ARCHIVE: process.env.LOCALE_ARCHIVE } : {}),
      ...this.o.env,
    };
    for (const [k, v] of Object.entries(env)) a.push('--setenv', k, v);
    return a;
  }

  // ---------------------------------------------------------------- what the app hands out

  private emit(ev: SandboxEvent) {
    try {
      this.o.onEvent(ev);
    } catch (e) {
      this.o.log('warn', `sandbox event ${ev.t}: ${(e as Error).message}`);
    }
  }

  /**
   * The file dialogs' policy: a save goes into the downloads folder under the name the app suggests (made unique);
   * an open is answered with the files waiting in the outbox, or cancelled when there are none.
   */
  private async chooseFiles(req: FileRequest): Promise<string[] | null> {
    const id = `f${Date.now().toString(36)}${(++this.reqSeq).toString(36)}`;
    const record = (answer: FileRequestRecord['answer'], files: string[]) => {
      this.emit({ t: 'fileRequest', request: { id, kind: req.kind, title: req.title, answer, files }, at: Date.now() });
      return answer === 'cancelled' ? null : files;
    };
    if (req.kind === 'open') {
      if (req.directory) return record('cancelled', []);
      const files = listFiles(this.outbox, 1)
        .map((rel) => ({ rel, m: statSync(join(this.outbox, rel)).mtimeMs }))
        .sort((x, y) => y.m - x.m)
        .map((x) => x.rel);
      if (!files.length) return record('cancelled', []);
      const chosen = req.multiple ? files : files.slice(0, 1);
      return record('outbox', chosen)?.map((f) => fileUri(`${HOME}/Outbox/${f}`)) ?? null;
    }
    const names = (req.names.length ? req.names : ['file']).map((n) => safeName(n || 'file'));
    const unique = names.map((n) => uniqueName(this.downloads, n));
    return record('downloads', unique)?.map((f) => fileUri(`${HOME}/Downloads/${f}`)) ?? null;
  }

  /** New files in the downloads folder, announced once they stop changing; files already there at start are not. */
  private scanDownloads(initial: boolean) {
    const now = Date.now();
    const seen = new Set<string>();
    for (const rel of listFiles(this.downloads, 4)) {
      let st;
      try {
        st = statSync(join(this.downloads, rel));
      } catch {
        continue;
      }
      seen.add(rel);
      const prev = this.files.get(rel);
      if (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs) {
        this.files.set(rel, { size: st.size, mtime: st.mtimeMs, since: now, announced: initial });
        continue;
      }
      if (!prev.announced && now - prev.since >= (this.o.settleMs ?? 2000)) {
        prev.announced = true;
        this.emit({ t: 'download', download: this.download(rel, st.size, st.mtimeMs), at: now });
      }
    }
    for (const k of [...this.files.keys()]) if (!seen.has(k)) this.files.delete(k);
  }

  private download(rel: string, size: number, mtime: number): Download {
    return { id: shortId(`${rel}\0${size}\0${mtime}`), path: rel, name: rel.split('/').pop() ?? rel, size, mime: mimeOf(rel), at: Math.round(mtime) };
  }

  /** Every finished file in the downloads folder, newest first. */
  listDownloads(): Download[] {
    const out: Download[] = [];
    for (const rel of listFiles(this.downloads, 4)) {
      const f = this.files.get(rel);
      if (f && !f.announced) continue;
      try {
        const st = statSync(join(this.downloads, rel));
        out.push(this.download(rel, st.size, st.mtimeMs));
      } catch {}
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** A download's path on the host, by id; null when it is gone or changed since. */
  downloadPath(id: string): string | null {
    const d = this.listDownloads().find((x) => x.id === id);
    if (!d) return null;
    const p = resolve(this.downloads, d.path);
    return p.startsWith(this.downloads + sep) ? p : null;
  }

  /** Put a file in the outbox, for the next time the app asks for one. */
  offer(name: string, bytes: Uint8Array): string {
    const n = uniqueName(this.outbox, safeName(name));
    writeFileSync(join(this.outbox, n), bytes, { mode: 0o600 });
    return n;
  }

  // ---------------------------------------------------------------- the window

  /** Keep the app's main window (fitWindow) the size of the display (screen.ts: X has no window manager to). */
  private async fit() {
    if (!this.screen_ || !this.appAlive) return;
    try {
      await this.screen_.fit(this.o.fitWindow!);
    } catch (e) {
      this.o.log('debug', `fitting the window: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- processes

  private spawn(name: string, cmd: string[], match: string, onExit?: (code: number | null, signal: string | null) => void, extraEnv?: Record<string, string | undefined>): Subprocess {
    // Nothing new once it is stopping (a live view's server started again, say): it would outlive the stop.
    if (this.stopped) throw new Error(`the sandbox is stopping: ${name} is not started`);
    this.o.log('debug', `spawn ${name}`, cmd.slice(0, 3).join(' '));
    // A small environment: the extractor's own (its manager token among it) stays out of every child, so not even
    // bubblewrap's init inside the sandbox carries it. And none of the machine's session: the sandbox's run directory
    // as the runtime directory, no session or system bus, no audio server (noHostSession), so that not one of the
    // processes started out here (the screen's servers, the bus, the audio server, pasta and bubblewrap) could find the
    // owner's bus or sound by looking in the owner's runtime directory. What a process is given goes over that.
    const keep = ['PATH', 'HOME', 'LANG', 'TZ', 'LOCALE_ARCHIVE'];
    const env: Record<string, string | undefined> = noHostSession(this.run);
    for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
    Object.assign(env, extraEnv);
    const proc = Bun.spawn(cmd, {
      env: cleanEnv(env),
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_p, code, signal) => {
        if (!this.stopped) this.o.log(name === 'app' ? 'info' : 'warn', `${name} exited`, { code, signal });
        if (!this.stopped) onExit?.(code, signal == null ? null : String(signal));
      },
    });
    this.procs.push({ name, proc, match });
    this.savePids();
    for (const stream of [proc.stdout, proc.stderr]) {
      (async () => {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // The app's own output can carry what it shows; keep it out of the log unless asked.
          if (name === 'app' && process.env.DITHER_SANDBOX_APP_LOG !== '1') continue;
          const text = dec.decode(value).trim();
          if (text) this.o.log('debug', `[${name}] ${text.slice(0, 400)}`);
        }
      })().catch(() => {});
    }
    return proc;
  }

  /**
   * What runs, so a later start can end what an extractor killed outright left behind, and so can the manager (its
   * supervisor reads this file: bubblewrap clears the environment, so these processes carry no account id). Each with
   * its start time (/proc/<pid>/stat field 22), so a pid handed on is never taken for it.
   */
  private savePids() {
    const startOf = (pid: number) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
      } catch {
        return null;
      }
    };
    writeFileSync(join(this.o.dir, 'sandbox.json'), JSON.stringify({ procs: this.procs.map((p) => ({ name: p.name, pid: p.proc.pid, start: startOf(p.proc.pid), match: p.match })) }), { mode: 0o600 });
  }

  private killStale() {
    const file = join(this.o.dir, 'sandbox.json');
    if (!existsSync(file)) return;
    try {
      const { procs } = JSON.parse(readFileSync(file, 'utf8')) as { procs: { name: string; pid: number; match: string }[] };
      for (const p of procs) {
        let cmdline = '';
        try {
          cmdline = readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
        } catch {
          continue;
        }
        if (!p.match || !cmdline.includes(p.match)) continue;
        this.o.log('warn', `ending a ${p.name} (pid ${p.pid}) left from an earlier run`);
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch {}
      }
    } catch {}
    rmSync(file, { force: true });
  }

  private async waitFor(path: string, proc: Subprocess, ms: number, what: string) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`${what} exited (${proc.exitCode})`);
      if (existsSync(path)) return;
      await Bun.sleep(50);
    }
    throw new Error(`${what} did not come up within ${ms} ms`);
  }
}

// ---------------------------------------------------------------- helpers

/**
 * How the app finds its display inside: X's DISPLAY, or the compositor's socket at `<run>/wayland-0` and every toolkit
 * told to use it (Qt, GTK, SDL; Electron and Chromium by the session type and their own hint). Qt on X stays on xcb.
 */
export function displayEnv(screen: Pick<Screen, 'protocol' | 'display'>, run: string): Record<string, string> {
  if (screen.protocol === 'x11') return { DISPLAY: `:${screen.display}`, QT_QPA_PLATFORM: 'xcb' };
  return {
    WAYLAND_DISPLAY: `${run}/wayland-0`,
    XDG_SESSION_TYPE: 'wayland',
    QT_QPA_PLATFORM: 'wayland',
    GDK_BACKEND: 'wayland',
    SDL_VIDEODRIVER: 'wayland',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    NIXOS_OZONE_WL: '1',
  };
}

function realOrNull(p: string): string | null {
  try {
    return existsSync(p) ? realpathSync(p) : null;
  } catch {
    return null;
  }
}

/** Files under dir (relative paths), to a depth, skipping hidden ones and ones still being written by name. */
export function listFiles(dir: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || /\.(part|tmp|crdownload|download)$/i.test(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory() && left > 1) walk(p, left - 1);
      else if (e.isFile()) out.push(relative(dir, p));
    }
  };
  walk(dir, depth);
  return out;
}

export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop()!.replace(/[\0-\x1f]/g, '').trim();
  return !base || base === '.' || base === '..' ? 'file' : base.slice(0, 200);
}

function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
}

/** Set these types' default handler in a mimeapps.list, keeping what the app wrote there itself. */
export function mergeMimeapps(path: string, types: string[], desktop: string) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const out: string[] = [];
  let section = '';
  let placed = false;
  const ours = types.map((t) => `${t}=${desktop}`);
  for (const line of lines) {
    const m = line.match(/^\[(.+)\]\s*$/);
    if (m) {
      if (section === 'Default Applications' && !placed) {
        out.push(...ours);
        placed = true;
      }
      section = m[1];
      out.push(line);
      continue;
    }
    if (section === 'Default Applications' && types.some((t) => line.startsWith(`${t}=`))) continue;
    out.push(line);
  }
  if (section === 'Default Applications' && !placed) {
    while (out.length && out[out.length - 1] === '') out.pop();
    out.push(...ours);
    placed = true;
  }
  if (!placed) out.push(...(out.length && out[out.length - 1] !== '' ? [''] : []), '[Default Applications]', ...ours);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${out.join('\n').replace(/\n+$/, '')}\n`);
}
