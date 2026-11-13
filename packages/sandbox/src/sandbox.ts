/**
 * A native app in a sandbox the extractor owns (docs/native-sandbox.md). Per account:
 *
 *   display    a private Xvfb (path socket only, no abstract one), and x11vnc as the live view: on <dir>/vnc.sock
 *              (0600, in the 0700 directory) and no TCP port, outside everything the app is shown
 *   bus        a private dbus-daemon whose desktop services are ours (services.ts): notifications, portals, xdg-open
 *   files      HOME is <dir>/home; /nix/store and a handful of /etc files read-only; nothing else of the host
 *   PATH       our shims first (xdg-open and its aliases report to us over the bus), then coreutils
 *   network    its own namespace through pasta (user-mode, no host loopback, no abstract sockets of the host),
 *              or the host's when pasta is missing (said in info().network), or none
 *   downloads  <dir>/home/Downloads, watched: a file that has stopped changing is announced
 *
 * The app runs under bubblewrap with every namespace unshared but the network one pasta made. It never sees the
 * user's home, X server or session bus. What it hands to the desktop arrives as SandboxEvents.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Subprocess } from 'bun';
import { prepareVncSocket, vncSocketPath, waitForVncSocket, x11vncArgs } from '@dither-accounts/browser';
import { type Log, type SandboxBins, sandboxBins } from './bins.ts';
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
  /** The sandbox's directory (in the account directory): home/, bin/, etc/, sandbox.json, vnc.sock (the live view). */
  dir: string;
  display: number;
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
  /** A window name (xdotool regex) to keep fitted to the display: there is no window manager to maximize it. */
  fitWindow?: string;
  /** A download is announced once it has not changed for this long. */
  settleMs?: number;
  log: Log;
  onEvent: (ev: SandboxEvent) => void;
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

export class AppSandbox {
  readonly home: string;
  readonly downloads: string;
  readonly outbox: string;
  readonly run: string;
  /** The live view: x11vnc's Unix socket. Not under home/ or bin/, so the app never sees it. */
  readonly vncSocket: string;
  network: Network;
  private bins!: SandboxBins;
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
    this.bins = sandboxBins(this.o.log, { pasta: this.network === 'pasta', xdotool: !!this.o.fitWindow });
    if (this.network === 'pasta' && !this.bins.pasta) {
      this.network = 'host';
      this.o.log('warn', 'pasta is not available: the app shares the host network (and its abstract sockets)');
    }
    this.prepareFiles();
    const d = `:${this.o.display}`;

    // The display: only its path socket, which is the one bound into the sandbox.
    const xvfb = this.spawn('Xvfb', [this.bins.xvfb, d, '-screen', '0', `${this.o.width}x${this.o.height}x24`, '-nolisten', 'tcp', '-nolisten', 'local', '-nocursor', '-dpi', '96'], d);
    await this.waitFor(`/tmp/.X11-unix/X${this.o.display}`, xvfb, 8000, `Xvfb on ${d}`);
    prepareVncSocket(this.vncSocket);
    const vnc = this.spawn('x11vnc', x11vncArgs(this.bins.x11vnc, d, this.vncSocket), `-unixsock ${this.vncSocket}`);
    await waitForVncSocket(this.vncSocket, vnc, 10_000);

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

    this.scanDownloads(true);
    this.timers.push(setInterval(() => this.scanDownloads(false), 1000));
    if (this.o.fitWindow && this.bins.xdotool) this.timers.push(setInterval(() => void this.fit(), 3000));
    this.o.log('info', `sandbox up: display ${d}, vnc on ${this.vncSocket}, network ${this.network}`);
    this.startApp();
  }

  /** Start (or start again) the app; its exits arrive as `app` events and it is not restarted here. */
  startApp() {
    if (this.stopped || (this.app && this.app.proc.exitCode === null)) return;
    const cmd = [...this.wrap(), ...this.bwrapArgs(), '--', ...this.o.command];
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
    this.bus?.close();
    for (const name of ['app', 'x11vnc', 'dbus-daemon', 'Xvfb']) {
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
    rmSync(join(this.o.dir, 'sandbox.json'), { force: true });
    rmSync(this.vncSocket, { force: true });
    rmSync(this.run, { recursive: true, force: true });
    this.o.log('info', 'sandbox stopped');
  }

  get appAlive() {
    return !!this.app && this.app.proc.exitCode === null;
  }

  info() {
    return {
      display: this.o.display,
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
    const d = this.o.display;
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
    a.push('--dir', '/tmp/.X11-unix', '--bind', `/tmp/.X11-unix/X${d}`, `/tmp/.X11-unix/X${d}`);
    a.push('--dir', run, '--chmod', '0700', run, '--bind', join(this.run, 'bus'), `${run}/bus`);
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
      DISPLAY: `:${d}`,
      XDG_RUNTIME_DIR: run,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${run}/bus`,
      XDG_CONFIG_HOME: `${HOME}/.config`,
      XDG_DATA_HOME: `${HOME}/.local/share`,
      XDG_CACHE_HOME: `${HOME}/.cache`,
      XDG_STATE_HOME: `${HOME}/.local/state`,
      LANG: 'en_US.UTF-8',
      BROWSER: `${BIN}/xdg-open`,
      // Qt's file dialogs through the FileChooser portal (ours); GLib's link opening through OpenURI (ours).
      QT_QPA_PLATFORM: 'xcb',
      QT_QPA_PLATFORMTHEME: 'xdgdesktopportal',
      GTK_USE_PORTAL: '1',
      GIO_USE_PORTALS: '1',
      // No accessibility bus here (an AT-SPI tap would be ours to add: docs/native-sandbox.md).
      NO_AT_BRIDGE: '1',
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

  /** No window manager maximizes anything here: keep the app's main window the size of the display. */
  private async fit() {
    if (!this.bins.xdotool || !this.appAlive) return;
    const run = async (args: string[]) => {
      const p = Bun.spawn([this.bins.xdotool!, ...args], { env: { DISPLAY: `:${this.o.display}` }, stdout: 'pipe', stderr: 'ignore' });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return out;
    };
    try {
      const ids = (await run(['search', '--onlyvisible', '--name', this.o.fitWindow!])).split('\n').filter(Boolean);
      let best: { id: string; x: number; y: number; w: number; h: number } | null = null;
      for (const id of ids) {
        const g = Object.fromEntries((await run(['getwindowgeometry', '--shell', id])).split('\n').filter(Boolean).map((l) => l.split('=')));
        const w = Number(g.WIDTH);
        const h = Number(g.HEIGHT);
        if (w < 200 || h < 200) continue;
        if (!best || w * h > best.w * best.h) best = { id, x: Number(g.X), y: Number(g.Y), w, h };
      }
      if (!best || (best.x === 0 && best.y === 0 && best.w === this.o.width && best.h === this.o.height)) return;
      await run(['windowmove', best.id, '0', '0', 'windowsize', best.id, String(this.o.width), String(this.o.height)]);
    } catch (e) {
      this.o.log('debug', `fitting the window: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- processes

  private spawn(name: string, cmd: string[], match: string, onExit?: (code: number | null, signal: string | null) => void): Subprocess {
    this.o.log('debug', `spawn ${name}`, cmd.slice(0, 3).join(' '));
    // A small environment: the extractor's own (its manager token among it) stays out of every child, so not even
    // bubblewrap's init inside the sandbox carries it.
    const keep = ['PATH', 'HOME', 'LANG', 'TZ', 'XDG_RUNTIME_DIR', 'LOCALE_ARCHIVE'];
    const env: Record<string, string> = { DISPLAY: `:${this.o.display}` };
    for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
    const proc = Bun.spawn(cmd, {
      env,
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

  /** What runs, so a later start can end what an extractor killed outright left behind. */
  private savePids() {
    writeFileSync(join(this.o.dir, 'sandbox.json'), JSON.stringify({ procs: this.procs.map((p) => ({ name: p.name, pid: p.proc.pid, match: p.match })) }), { mode: 0o600 });
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
      if (proc.exitCode !== null) throw new Error(`${what} exited (${proc.exitCode})${what.startsWith('Xvfb') ? '; is the display taken?' : ''}`);
      if (existsSync(path)) return;
      await Bun.sleep(50);
    }
    throw new Error(`${what} did not come up within ${ms} ms`);
  }
}

// ---------------------------------------------------------------- helpers

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
