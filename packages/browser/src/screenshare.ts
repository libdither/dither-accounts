/**
 * Screen sharing on the wayland backend: a sandbox's own session bus, PipeWire, WirePlumber, xdg-desktop-portal and
 * xdg-desktop-portal-wlr, so that getDisplayMedia (Chromium's and Electron's PipeWire capturer, through the portal's
 * ScreenCast) captures the sandbox's own sway output, with no chooser, and nothing else.
 *
 * Safety first: the machine's own session bus has the owner's portal on it (and its PipeWire the owner's screen), so a
 * getDisplayMedia that reached it could capture the owner's real screen. Everything here runs on a bus of its own (a
 * dbus-daemon listening only on <dir>/bus), with XDG_RUNTIME_DIR, the config, data and state directories all inside
 * <dir>; the client (Chromium) is given only DBUS_SESSION_BUS_ADDRESS=unix:path=<dir>/bus. xdg-desktop-portal-wlr is
 * told the compositor's socket alone and picks its one output (chooser_type=none, output_name), so another sandbox's
 * output is not even a choice. WirePlumber runs with every device monitor off: no sound card, camera or Bluetooth of
 * the machine is opened or offered.
 *
 *   dbus-daemon            <dir>/bus, session policy, one service it may start: the portal's permission store
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
import { WaylandScreen } from './wayland.ts';

export const SHARE_BINS = {
  dbusDaemon: { name: 'dbus-daemon', env: 'DBUS_DAEMON_BIN', nix: 'dbus', candidates: ['/run/current-system/sw/bin/dbus-daemon'] },
  pipewire: { name: 'pipewire', env: 'PIPEWIRE_BIN', nix: 'pipewire' },
  wireplumber: { name: 'wireplumber', env: 'WIREPLUMBER_BIN', nix: 'wireplumber' },
  // Both live in libexec/, so neither is on PATH: found through their packages.
  portal: { name: 'xdg-desktop-portal', env: 'XDG_DESKTOP_PORTAL_BIN', nix: 'xdg-desktop-portal', path: false, sub: 'libexec' },
  portalWlr: { name: 'xdg-desktop-portal-wlr', env: 'XDG_DESKTOP_PORTAL_WLR_BIN', nix: 'xdg-desktop-portal-wlr', path: false, sub: 'libexec' },
} satisfies Record<string, BinSpec>;

/** The sway output every sandbox has (WLR_HEADLESS_OUTPUTS=1). */
export const SHARE_OUTPUT = 'HEADLESS-1';

/** The directory, under the compositor's (whose path is short enough for sway's IPC socket name, so for ours too). */
export const SHARE_DIR = 'share';

export interface ScreenShareOptions {
  /** The compositor's directory (WaylandScreen.dir); ours is <dir>/share. */
  dir: string;
  /** The compositor's Wayland socket (WaylandScreen.socket). */
  waylandSocket: string;
  spawn: ScreenSpawn;
  log: Log;
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
  readonly procNames = ['xdg-desktop-portal', 'xdg-desktop-portal-wlr', 'wireplumber', 'pipewire', 'dbus-daemon'] as const;
  private procs: Subprocess[] = [];

  constructor(private o: ScreenShareOptions) {
    this.dir = join(o.dir, SHARE_DIR);
  }

  get busAddress() {
    return `unix:path=${join(this.dir, 'bus')}`;
  }

  /** What a client (Chromium, Electron) is given: this bus, and no other way to the machine's. */
  clientEnv(): Record<string, string> {
    return { DBUS_SESSION_BUS_ADDRESS: this.busAddress };
  }

  /** The environment of the processes here: everything they look up is under <dir>. */
  private env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    const d = this.dir;
    return {
      HOME: join(d, 'home'),
      XDG_RUNTIME_DIR: d,
      PIPEWIRE_RUNTIME_DIR: d,
      XDG_CONFIG_HOME: join(d, 'config'),
      XDG_DATA_HOME: join(d, 'data'),
      XDG_STATE_HOME: join(d, 'state'),
      XDG_CACHE_HOME: join(d, 'cache'),
      XDG_CONFIG_DIRS: undefined,
      DBUS_SESSION_BUS_ADDRESS: this.busAddress,
      DBUS_SYSTEM_BUS_ADDRESS: undefined,
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
      WAYLAND_SOCKET: undefined,
      PULSE_SERVER: undefined,
      PIPEWIRE_REMOTE: undefined,
      XDG_CURRENT_DESKTOP: 'sway',
      XDG_SESSION_TYPE: 'wayland',
      ...extra,
    };
  }

  private prepare(portalBin: string) {
    const d = this.dir;
    rmSync(d, { recursive: true, force: true });
    for (const sub of ['', 'home', 'config/xdg-desktop-portal', 'config/xdg-desktop-portal-wlr', 'config/wireplumber/wireplumber.conf.d', 'data', 'state', 'cache', 'services', 'portals'])
      mkdirSync(join(d, sub), { recursive: true, mode: 0o700 });
    const st = lstatSync(d);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & 0o077) throw new Error(`the screen share's directory ${d} is not this user's own`);
    writeFileSync(join(d, 'bus.conf'), busConf(d));
    writeFileSync(join(d, 'config/xdg-desktop-portal/sway-portals.conf'), portalsConf());
    writeFileSync(join(d, 'config/xdg-desktop-portal/portals.conf'), portalsConf());
    writeFileSync(join(d, 'config/xdg-desktop-portal-wlr/config'), wlrConfig());
    writeFileSync(join(d, 'config/wireplumber/wireplumber.conf.d/90-sandbox.conf'), wireplumberConf());
    // The portal's permission store, the one service the bus may start (the portal asks for it).
    const store = join(dirname(portalBin), 'xdg-permission-store');
    if (portalBin && existsSync(store)) writeFileSync(join(d, 'services/org.freedesktop.impl.portal.PermissionStore.service'), `[D-BUS Service]\nName=org.freedesktop.impl.portal.PermissionStore\nExec=${store}\n`);
  }

  /**
   * Up, and ready for a ScreenCast. With `capture: false` only the bus: a client that must not reach the machine's
   * session bus but has nothing to share gets one with nothing on it.
   */
  async start(o: { capture?: boolean } = {}) {
    const capture = o.capture ?? true;
    const bins = Object.fromEntries(
      Object.entries(SHARE_BINS)
        .filter(([k]) => capture || k === 'dbusDaemon')
        .map(([k, spec]) => [k, resolveBin(spec, this.o.log)]),
    ) as Record<keyof typeof SHARE_BINS, string>;
    this.prepare(bins.portal ?? '');
    const d = this.dir;
    if (!capture) {
      const bus = this.spawn('dbus-daemon', [bins.dbusDaemon, `--config-file=${join(d, 'bus.conf')}`, '--nofork', '--nopidfile', '--nosyslog'], join(d, 'bus.conf'));
      await this.waitForFile(join(d, 'bus'), bus, 5000, 'dbus-daemon');
      return;
    }
    const wlrPortal = join(dirname(dirname(bins.portalWlr)), 'share/xdg-desktop-portal/portals/wlr.portal');
    if (!existsSync(wlrPortal)) throw new Error(`no wlr.portal beside ${bins.portalWlr}`);
    symlinkSync(wlrPortal, join(d, 'portals/wlr.portal'));

    const bus = this.spawn('dbus-daemon', [bins.dbusDaemon, `--config-file=${join(d, 'bus.conf')}`, '--nofork', '--nopidfile', '--nosyslog'], join(d, 'bus.conf'));
    await this.waitForFile(join(d, 'bus'), bus, 5000, 'dbus-daemon');
    const pw = this.spawn('pipewire', [bins.pipewire], d);
    await this.waitForFile(join(d, 'pipewire-0'), pw, 10_000, 'pipewire');
    this.spawn('wireplumber', [bins.wireplumber], d);
    const wlr = this.spawn('xdg-desktop-portal-wlr', [bins.portalWlr, '-r', ...(process.env.DITHER_SHARE_DEBUG === '1' ? ['-l', 'DEBUG'] : [])], d, { WAYLAND_DISPLAY: this.o.waylandSocket });
    await this.waitForName('org.freedesktop.impl.portal.desktop.wlr', wlr, bins.dbusDaemon, 10_000);
    const xdp = this.spawn('xdg-desktop-portal', [bins.portal, '-r'], d, { XDG_DESKTOP_PORTAL_DIR: join(d, 'portals'), WAYLAND_DISPLAY: this.o.waylandSocket });
    await this.waitForName('org.freedesktop.portal.Desktop', xdp, bins.dbusDaemon, 15_000);
    this.o.log('debug', `screen share up: portal and PipeWire on ${this.busAddress}`);
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
 * A browser sandbox's: on wayland its own session bus, with the screen share's portal and PipeWire when `capture`
 * (and the flag that has Chromium use them); on x11 nothing (Chromium captures its Xvfb itself). Started; its
 * clientEnv goes into Chromium's environment and its procNames before the screen's when stopping.
 */
export async function browserShare(screen: Screen, o: { capture: boolean; spawn: ScreenSpawn; log: Log }): Promise<{ share: ScreenShare | null; flags: string[] }> {
  if (!(screen instanceof WaylandScreen)) return { share: null, flags: [] };
  const share = new ScreenShare({ dir: screen.dir, waylandSocket: screen.socket, spawn: o.spawn, log: o.log });
  await share.start({ capture: o.capture });
  return { share, flags: o.capture ? ['--enable-features=WebRTCPipeWireCapturer'] : [] };
}
