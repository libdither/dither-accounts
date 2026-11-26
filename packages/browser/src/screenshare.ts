/**
 * A browser sandbox's own session, on every backend: a session bus of its own and an audio server of its own, in a
 * runtime directory of its own, so that nothing in the sandbox reaches the machine's desktop session. On the wayland
 * backend, with screen sharing, also PipeWire, WirePlumber, xdg-desktop-portal and xdg-desktop-portal-wlr, so that
 * getDisplayMedia (Chromium's and Electron's PipeWire capturer, through the portal's ScreenCast) captures the sandbox's
 * own sway output, with no chooser, and nothing else.
 *
 * Safety first: the machine's own session bus has the owner's portal on it (and its PipeWire the owner's screen), so a
 * getDisplayMedia that reached it could capture the owner's real screen; its notification server shows on the owner's
 * desktop; the machine's audio server has the owner's speakers and microphone. Everything here runs on a bus of its own
 * (a dbus-daemon listening only on <dir>/bus), with XDG_RUNTIME_DIR, the config, data and state directories all inside
 * <dir>. The client (Chromium) is given XDG_RUNTIME_DIR=<dir>, that bus, an address for the system bus with nothing
 * there, and the audio server here (clientEnv); none of the machine's. xdg-desktop-portal-wlr is
 * told the compositor's socket alone and picks its one output (chooser_type=none, output_name), so another sandbox's
 * output is not even a choice. WirePlumber runs with every device monitor off: no sound card, camera or Bluetooth of
 * the machine is opened or offered.
 *
 *   dbus-daemon            <dir>/bus, session policy, one service it may start: the portal's permission store
 *   pulseaudio             <dir>/pulse/native, a silent speaker and microphone (null sink and source) and nothing of
 *                          the machine's sound: so Chromium's audio (a page's sound, a call's Web Audio graph) runs on
 *                          a clock as on any desktop, and never falls back to ALSA, which would open the machine's
 *                          sound cards (/dev/snd is open to the user at the seat)
 *   (with screen sharing, on wayland only:)
 *   pipewire               <dir>/pipewire-0 (XDG_RUNTIME_DIR=<dir>)
 *   wireplumber            links the capture stream to its client; monitors off
 *   xdg-desktop-portal-wlr org.freedesktop.impl.portal.desktop.wlr: ScreenCast and Screenshot of the sway output
 *   xdg-desktop-portal     org.freedesktop.portal.Desktop, with wlr the only backend (XDG_DESKTOP_PORTAL_DIR)
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { type BinSpec, type Log, resolveBin } from './bins.ts';
import type { Screen, ScreenSpawn } from './screen.ts';

export const SHARE_BINS = {
  dbusDaemon: { name: 'dbus-daemon', env: 'DBUS_DAEMON_BIN', nix: 'dbus', candidates: ['/run/current-system/sw/bin/dbus-daemon'], pinned: true },
  pulseaudio: { name: 'pulseaudio', env: 'PULSEAUDIO_BIN', nix: 'pulseaudio', pinned: true },
  pipewire: { name: 'pipewire', env: 'PIPEWIRE_BIN', nix: 'pipewire', pinned: true },
  wireplumber: { name: 'wireplumber', env: 'WIREPLUMBER_BIN', nix: 'wireplumber', pinned: true },
  // Both live in libexec/, so neither is on PATH: found through their packages.
  portal: { name: 'xdg-desktop-portal', env: 'XDG_DESKTOP_PORTAL_BIN', nix: 'xdg-desktop-portal', path: false, sub: 'libexec', pinned: true },
  portalWlr: { name: 'xdg-desktop-portal-wlr', env: 'XDG_DESKTOP_PORTAL_WLR_BIN', nix: 'xdg-desktop-portal-wlr', path: false, sub: 'libexec', pinned: true },
} satisfies Record<string, BinSpec>;

/** The sway output every sandbox has (WLR_HEADLESS_OUTPUTS=1). */
export const SHARE_OUTPUT = 'HEADLESS-1';

/** The directory, under the compositor's (whose path is short enough for sway's IPC socket name, so for ours too). */
export const SHARE_DIR = 'share';

/** What only the session's bus and audio server need; the rest is for a capture. */
const SESSION_BINS = ['dbusDaemon', 'pulseaudio'] as const;

export interface ScreenShareOptions {
  /** The screen's runtime directory (Screen.runtimeDir); ours is <dir>/share. */
  dir: string;
  /** The compositor's Wayland socket (WaylandScreen.socket); null on X, where there is nothing to capture through it. */
  waylandSocket: string | null;
  spawn: ScreenSpawn;
  log: Log;
  /** Programs to run instead of the resolved ones (tests: one that fails). */
  bins?: Partial<Record<keyof typeof SHARE_BINS, string>>;
}

/** The portal configuration: wlr for ScreenCast and Screenshot, nothing for the rest. */
export function portalsConf(): string {
  return '[preferred]\ndefault=none\norg.freedesktop.impl.portal.ScreenCast=wlr\norg.freedesktop.impl.portal.Screenshot=wlr\n';
}

/** xdg-desktop-portal-wlr's: the one output, no chooser to show or wait on. */
export function wlrConfig(output = SHARE_OUTPUT, maxFps = 60): string {
  return `[screencast]\noutput_name=${output}\nchooser_type=none\nmax_fps=${maxFps}\n`;
}

/** WirePlumber with every device monitor off and nothing of the machine's session (logind, device reservation). */
export function wireplumberConf(): string {
  const off = ['monitor.alsa', 'monitor.alsa-midi', 'monitor.bluez', 'monitor.bluez.midi', 'monitor.bluez-midi', 'monitor.v4l2', 'monitor.libcamera', 'support.reserve-device', 'support.logind'];
  return `wireplumber.profiles = {\n  main = {\n${off.map((k) => `    ${k} = disabled`).join('\n')}\n  }\n}\n`;
}

/**
 * The audio server's script: its socket, a silent speaker and microphone as the defaults, and nothing else (no
 * default.pa: no sound card, Bluetooth or network sound of the machine's). Idle, the speaker sleeps.
 */
export function audioScript(socket: string): string {
  return `load-module module-native-protocol-unix socket=${socket} auth-anonymous=1
load-module module-null-sink sink_name=speakers rate=48000 sink_properties=device.description=Speakers
load-module module-null-source source_name=microphone rate=48000 description=Microphone
load-module module-suspend-on-idle
set-default-sink speakers
set-default-source microphone
`;
}

/** What a client of the audio server reads: no server of its own started for it, no shared memory. */
export const AUDIO_CLIENT_CONF = 'autospawn = no\nenable-shm = no\n';

/**
 * The environment that keeps a process off the machine's session: no session or system bus (an address in `dir` that
 * is never made: left unset, libdbus and GDBus would go to $XDG_RUNTIME_DIR/bus and the system bus's well-known path),
 * no audio server (PulseAudio's and PipeWire's addresses unset), and `dir` as its runtime directory, where they would
 * look next. What the session here gives a client (clientEnv) goes over it.
 */
export function noHostSession(dir: string): Record<string, string | undefined> {
  const none = `unix:path=${join(dir, 'no-bus')}`;
  return {
    XDG_RUNTIME_DIR: dir,
    DBUS_SESSION_BUS_ADDRESS: none,
    DBUS_SYSTEM_BUS_ADDRESS: none,
    PULSE_SERVER: undefined,
    PULSE_COOKIE: undefined,
    PULSE_CLIENTCONFIG: undefined,
    PIPEWIRE_REMOTE: undefined,
    PIPEWIRE_RUNTIME_DIR: undefined,
    // GTK's accessibility bridge looks for the accessibility bus on the session bus: there is none.
    NO_AT_BRIDGE: '1',
  };
}

/** The bus: session policy, listening only on <dir>/bus, starting only the services in <dir>/services. */
export function busConf(dir: string): string {
  return `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path=${join(dir, 'bus')}</listen><auth>EXTERNAL</auth>
<servicedir>${join(dir, 'services')}</servicedir>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
`;
}

export class ScreenShare {
  readonly dir: string;
  readonly procNames = ['xdg-desktop-portal', 'xdg-desktop-portal-wlr', 'wireplumber', 'pipewire', 'pulseaudio', 'dbus-daemon'] as const;
  /** What this share started, so a capture that failed halfway can end its own (startOrBusOnly). */
  private procs: Subprocess[] = [];
  /** The portal and PipeWire run (start with capture), not only the bus. */
  capturing = false;

  constructor(private o: ScreenShareOptions) {
    this.dir = join(o.dir, SHARE_DIR);
  }

  get busAddress() {
    return `unix:path=${join(this.dir, 'bus')}`;
  }

  /** The audio server's socket, where a client with this runtime directory looks by itself too. */
  get audioSocket() {
    return join(this.dir, 'pulse', 'native');
  }

  /**
   * What a client (Chromium, Electron) is given: this directory as its runtime directory, this bus, this audio server,
   * and no other way to the machine's (noHostSession).
   */
  clientEnv(): Record<string, string | undefined> {
    return {
      ...noHostSession(this.dir),
      DBUS_SESSION_BUS_ADDRESS: this.busAddress,
      DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(this.dir, 'no-system-bus')}`,
      PULSE_SERVER: `unix:${this.audioSocket}`,
      PULSE_CLIENTCONFIG: join(this.dir, 'pulse-client.conf'),
      PULSE_COOKIE: join(this.dir, 'pulse-cookie'),
    };
  }

  /** The environment of the processes here: everything they look up is under <dir>. */
  private env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    const d = this.dir;
    return {
      ...noHostSession(d),
      HOME: join(d, 'home'),
      XDG_RUNTIME_DIR: d,
      PIPEWIRE_RUNTIME_DIR: d,
      XDG_CONFIG_HOME: join(d, 'config'),
      XDG_DATA_HOME: join(d, 'data'),
      XDG_STATE_HOME: join(d, 'state'),
      XDG_CACHE_HOME: join(d, 'cache'),
      XDG_CONFIG_DIRS: undefined,
      DBUS_SESSION_BUS_ADDRESS: this.busAddress,
      // Not the machine's system bus either: an address with nothing there. (Left unset, libdbus would go to the
      // system bus's well-known path.)
      DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(d, 'no-system-bus')}`,
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
      WAYLAND_SOCKET: undefined,
      XDG_CURRENT_DESKTOP: 'sway',
      XDG_SESSION_TYPE: 'wayland',
      ...extra,
    };
  }

  private prepare(portalBin: string) {
    const d = this.dir;
    rmSync(d, { recursive: true, force: true });
    for (const sub of ['', 'home', 'pulse', 'config/xdg-desktop-portal', 'config/xdg-desktop-portal-wlr', 'config/wireplumber/wireplumber.conf.d', 'data', 'state', 'cache', 'services', 'portals'])
      mkdirSync(join(d, sub), { recursive: true, mode: 0o700 });
    const st = lstatSync(d);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & 0o077) throw new Error(`the screen share's directory ${d} is not this user's own`);
    writeFileSync(join(d, 'bus.conf'), busConf(d));
    writeFileSync(join(d, 'audio.pa'), audioScript(this.audioSocket));
    writeFileSync(join(d, 'pulse-client.conf'), AUDIO_CLIENT_CONF);
    writeFileSync(join(d, 'config/xdg-desktop-portal/sway-portals.conf'), portalsConf());
    writeFileSync(join(d, 'config/xdg-desktop-portal/portals.conf'), portalsConf());
    writeFileSync(join(d, 'config/xdg-desktop-portal-wlr/config'), wlrConfig());
    writeFileSync(join(d, 'config/wireplumber/wireplumber.conf.d/90-sandbox.conf'), wireplumberConf());
    // The portal's permission store, the one service the bus may start (the portal asks for it).
    const store = join(dirname(portalBin), 'xdg-permission-store');
    if (portalBin && existsSync(store)) writeFileSync(join(d, 'services/org.freedesktop.impl.portal.PermissionStore.service'), `[D-BUS Service]\nName=org.freedesktop.impl.portal.PermissionStore\nExec=${store}\n`);
  }

  /**
   * Up: the bus and the audio server, and with `capture` (on wayland) ready for a ScreenCast. With `capture: false` a
   * client that must not reach the machine's session but has nothing to share gets a bus with nothing on it.
   */
  async start(o: { capture?: boolean } = {}) {
    const capture = o.capture ?? true;
    const waylandSocket = this.o.waylandSocket;
    if (capture && !waylandSocket) throw new Error('screen sharing through the portal needs a Wayland compositor');
    const bins = Object.fromEntries(
      Object.entries(SHARE_BINS)
        .filter(([k]) => capture || (SESSION_BINS as readonly string[]).includes(k))
        .map(([k, spec]) => [k, this.o.bins?.[k as keyof typeof SHARE_BINS] ?? resolveBin(spec, this.o.log)]),
    ) as Record<keyof typeof SHARE_BINS, string>;
    this.prepare(bins.portal ?? '');
    const d = this.dir;
    const bus = this.spawn('dbus-daemon', [bins.dbusDaemon, `--config-file=${join(d, 'bus.conf')}`, '--nofork', '--nopidfile', '--nosyslog'], join(d, 'bus.conf'));
    await this.waitForFile(join(d, 'bus'), bus, 5000, 'dbus-daemon');
    const pa = this.spawn(
      'pulseaudio',
      [bins.pulseaudio, '-n', '--daemonize=no', '--system=no', '--use-pid-file=no', '--realtime=no', '--high-priority=no', '--exit-idle-time=-1', '--disallow-module-loading', '--disable-shm=yes', '--log-target=stderr', '--log-level=1', '-F', join(d, 'audio.pa')],
      join(d, 'audio.pa'),
    );
    await this.waitForFile(this.audioSocket, pa, 8000, 'pulseaudio');
    if (!capture || !waylandSocket) return;
    const wlrPortal = join(dirname(dirname(bins.portalWlr)), 'share/xdg-desktop-portal/portals/wlr.portal');
    if (!existsSync(wlrPortal)) throw new Error(`no wlr.portal beside ${bins.portalWlr}`);
    symlinkSync(wlrPortal, join(d, 'portals/wlr.portal'));

    const pw = this.spawn('pipewire', [bins.pipewire], d);
    await this.waitForFile(join(d, 'pipewire-0'), pw, 10_000, 'pipewire');
    this.spawn('wireplumber', [bins.wireplumber], d);
    const wlr = this.spawn('xdg-desktop-portal-wlr', [bins.portalWlr, '-r', ...(process.env.DITHER_SHARE_DEBUG === '1' ? ['-l', 'DEBUG'] : [])], d, { WAYLAND_DISPLAY: waylandSocket });
    await this.waitForName('org.freedesktop.impl.portal.desktop.wlr', wlr, bins.dbusDaemon, 10_000);
    const xdp = this.spawn('xdg-desktop-portal', [bins.portal, '-r'], d, { XDG_DESKTOP_PORTAL_DIR: join(d, 'portals'), WAYLAND_DISPLAY: waylandSocket });
    await this.waitForName('org.freedesktop.portal.Desktop', xdp, bins.dbusDaemon, 15_000);
    this.capturing = true;
    this.o.log('debug', `screen share up: portal and PipeWire on ${this.busAddress}`);
  }

  /**
   * With capture, and if any part of it fails (a program missing, one that misses its deadline): said in the log, what
   * it started ended, and the bus and audio server alone started instead. Screen sharing is something the sandbox can
   * do without; its own session it cannot.
   */
  async startOrBusOnly(capture: boolean) {
    if (!capture) return this.start({ capture: false });
    try {
      await this.start({ capture: true });
    } catch (e) {
      this.o.log('warn', `screen sharing is off for this run: ${(e as Error).message.slice(0, 300)}`);
      await this.endOwn();
      await this.start({ capture: false });
    }
  }

  /** End what this share started (its owner's list keeps them too, and stops what is left at the end). */
  private async endOwn() {
    const procs = this.procs.splice(0);
    for (const p of procs) {
      try {
        p.kill('SIGTERM');
      } catch {}
    }
    const killer = setTimeout(() => {
      for (const p of procs) {
        try {
          p.kill('SIGKILL');
        } catch {}
      }
    }, 3000);
    await Promise.all(procs.map((p) => p.exited.catch(() => {})));
    clearTimeout(killer);
  }

  private spawn(name: string, cmd: string[], match: string, extra?: Record<string, string | undefined>): Subprocess {
    const p = this.o.spawn(name, cmd, { match, env: this.env(extra) });
    this.procs.push(p);
    return p;
  }

  private async waitForFile(path: string, proc: Subprocess, ms: number, what: string) {
    const end = Date.now() + ms;
    while (!existsSync(path)) {
      if (proc.exitCode !== null || proc.signalCode) throw new Error(`${what} exited (${proc.signalCode ?? proc.exitCode}) before ${path} was there`);
      if (Date.now() > end) throw new Error(`${what} did not make ${path} within ${ms} ms`);
      await Bun.sleep(25);
    }
  }

  /** Until the name has an owner on our bus (asked with dbus-send, beside dbus-daemon). */
  private async waitForName(name: string, proc: Subprocess, dbusDaemon: string, ms: number) {
    const send = join(dirname(dbusDaemon), 'dbus-send');
    const end = Date.now() + ms;
    for (;;) {
      if (proc.exitCode !== null || proc.signalCode) throw new Error(`${name.split('.').pop()} exited (${proc.signalCode ?? proc.exitCode}) before it took ${name}`);
      const q = Bun.spawn([send, `--bus=${this.busAddress}`, '--print-reply=literal', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', `string:${name}`], { stdout: 'pipe', stderr: 'ignore' });
      const out = await new Response(q.stdout).text();
      if (/true/.test(out)) return;
      if (Date.now() > end) throw new Error(`nothing took ${name} on the screen share's bus within ${ms} ms`);
      await Bun.sleep(50);
    }
  }

  /** Its files gone; the processes are its owner's to stop (procNames), as the screen's are. */
  async stop() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * A browser sandbox's: on a screen that needs a session of its own (Screen.needsOwnBus: every backend) its bus and
 * audio server, with the screen share's portal and PipeWire when `capture` on Wayland and they start (and the flag
 * that has Chromium use them); on X Chromium captures its X server itself. Started; its clientEnv goes into Chromium's
 * environment and its procNames before the screen's when stopping.
 */
export async function browserShare(screen: Screen, o: { capture: boolean; spawn: ScreenSpawn; log: Log }): Promise<{ share: ScreenShare | null; flags: string[] }> {
  if (!screen.needsOwnBus || !screen.runtimeDir) return { share: null, flags: [] };
  const wayland = screen.protocol === 'wayland';
  const share = new ScreenShare({ dir: screen.runtimeDir, waylandSocket: wayland ? screen.socket : null, spawn: o.spawn, log: o.log });
  await share.startOrBusOnly(o.capture && wayland);
  return { share, flags: share.capturing ? ['--enable-features=WebRTCPipeWireCapturer'] : [] };
}
