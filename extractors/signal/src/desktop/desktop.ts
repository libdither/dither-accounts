/**
 * Signal Desktop as a Signal account's calls body (docs/signal.md "Calls through Signal Desktop"): the official app,
 * linked as one more device of the account, in the account's own sandbox (packages/sandbox) with audio devices of its
 * own, and our hook (hook/preload.cjs) inside its window. signal-cli keeps doing everything else; Desktop only calls.
 *
 * This file runs it and speaks to the hook: one Unix socket in the sandbox's runtime directory, bound into the sandbox,
 * one JSON object per line (requests {id, op} and their answers; news {ev}). Logs carry ops and states, never a link
 * code, a name or a number.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppSandbox, type AudioDevices, displayName, type Network, pickFreeDisplay, resolveBin, runtimeDir } from '@dither-accounts/sandbox';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

/** What Signal Desktop says of itself (hook appState). */
export interface DesktopApp {
  ready: boolean;
  /** Its install screen's step while not linked ("QrCodeNotScanned", "LinkInProgress"…). */
  step?: string | null;
  /** The link code it shows (sgnl://linkdevice…), while it shows one. */
  linkUrl?: string | null;
  aci?: string | null;
  signedIn?: boolean;
}

/** News from the hook, for the adapter. */
export type HookEvent =
  | { ev: 'call'; call: string; signal?: unknown; state?: HookCallState; ended?: string }
  | { ev: 'ring'; state: 'ringing' | 'ended'; ring: string; target: HookTarget; caller: string | null; video: boolean; joined?: boolean; at: number };

/** A conversation as the hook names it: a person by ACI, or a group by its id. */
export type HookTarget = { peer: string } | { group: string };

export interface HookCallState {
  target: HookTarget;
  participants: { id: string; muted: boolean; deafened: boolean; speaking: boolean; video?: boolean; streaming?: boolean }[];
  video: { slot: string; who: string; source: 'camera' | 'stream' }[];
  self: { connected: boolean; muted: boolean; deafened: boolean; camera?: boolean; streaming?: boolean };
}

/** What the adapter needs of Desktop (SignalDesktop; a stub in tests). */
export interface CallsHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Linked, signed in and its hook connected: calls can be made. */
  readonly ready: boolean;
  readonly app: DesktopApp | null;
  request<T = unknown>(op: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  liveView(): { vncSocket: string; width: number; height: number } | null;
  layer(): Layer;
  details(): Record<string, string | number | boolean | null>;
}

export interface DesktopOptions {
  accountDir: string;
  log: Log;
  onEvent: (ev: HookEvent) => void;
  /** Linked, signed in, the hook came or went: capabilities and status may have changed. */
  onChange: () => void;
  width?: number;
  height?: number;
  network?: Network;
}

/** The sandbox's audio: Signal plays the call into `call_out` and records `device_mic` (the device's microphone). */
export const AUDIO: AudioDevices = {
  sinks: [
    { name: 'call_out', description: 'Call' },
    { name: 'mic_in', description: 'DeviceMic' },
  ],
  sources: [
    { name: 'device_mic', from: 'mic_in', description: 'Microphone' },
    { name: 'call_mix', from: 'call_out', description: 'CallMix' },
  ],
  defaultSink: 'call_out',
  defaultSource: 'device_mic',
};

const HOOK_DIR = resolve(import.meta.dir, 'hook');
const HOOK_IN = '/run/dither/hook';
const RESTART_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** How long Desktop may be without its hook (a window reloading after a crash) before it is started again. */
const WATCHDOG_MS = 45_000;

/** Signal Desktop's Electron and app.asar, from its launcher ($SIGNAL_DESKTOP_BIN, PATH, or nix build nixpkgs#signal-desktop). */
export function resolveSignalDesktop(log: Log): { electron: string; asar: string } {
  const launcher = resolveBin({ name: 'signal-desktop', env: 'SIGNAL_DESKTOP_BIN', nix: 'signal-desktop' }, log);
  const text = readFileSync(launcher, 'utf8');
  // nixpkgs' launcher: exec "<electron>" <app.asar> "$@"
  const m = text.match(/exec\s+"?(\/nix\/store\/[^"\s]+\/bin\/electron)"?\s+"?(\/nix\/store\/[^"\s]+\/app\.asar)"?/);
  if (!m) throw new Error(`${launcher} does not say which Electron and app.asar it runs`);
  return { electron: m[1], asar: m[2] };
}

export class SignalDesktop implements CallsHost {
  private sandbox: AppSandbox | null = null;
  private dir: string;
  private hookDir: string;
  private socket: ReturnType<typeof Bun.listen> | null = null;
  private conn: { write(s: string): number; end(): void } | null = null;
  private buf = '';
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer }>();
  private stopped = false;
  private restarts = 0;
  private restartTimer: Timer | null = null;
  private watchdog: Timer | null = null;
  private error: string | null = null;
  app: DesktopApp | null = null;

  constructor(private o: DesktopOptions) {
    this.dir = join(o.accountDir, 'desktop');
    this.hookDir = join(runtimeDir(this.dir), 'hook');
  }

  get ready() {
    return !!(this.conn && this.app?.signedIn);
  }

  async start() {
    this.stopped = false;
    try {
      const { electron, asar } = resolveSignalDesktop(this.o.log);
      mkdirSync(this.hookDir, { recursive: true, mode: 0o700 });
      const path = join(this.hookDir, 'hook.sock');
      rmSync(path, { force: true });
      this.socket = Bun.listen({
        unix: path,
        socket: {
          open: (s) => {
            // One window, one hook: a reloaded window's hook replaces the last.
            this.conn?.end();
            this.conn = s;
            this.buf = '';
            this.o.log('info', 'the calls hook is in Signal Desktop');
            this.o.onChange();
          },
          data: (_s, d) => this.onData(d.toString()),
          close: (s) => {
            if (this.conn !== s) return;
            this.conn = null;
            for (const [, p] of this.pending) {
              clearTimeout(p.timer);
              p.reject(new Error('Signal Desktop went away'));
            }
            this.pending.clear();
            this.hookGone();
            this.o.onChange();
          },
        },
      });
      const free = await pickFreeDisplay();
      this.sandbox = new AppSandbox({
        dir: this.dir,
        display: free,
        width: this.o.width ?? 1280,
        height: this.o.height ?? 800,
        // --password-store=basic: no keyring in the sandbox (Signal would wait for one), so its database key is kept as
        // the account's other keys are, in the 0700 account directory.
        command: [electron, '-r', join(HOOK_DIR, 'main.cjs'), asar, '--password-store=basic'],
        roBinds: [HOOK_DIR],
        binds: [{ src: this.hookDir, dest: HOOK_IN }],
        audio: AUDIO,
        env: { DITHER_SIGNAL_ASAR: asar, ELECTRON_FORCE_IS_PACKAGED: '1', DITHER_HOOK_SOCKET: `${HOOK_IN}/hook.sock` },
        network: this.o.network,
        fitWindow: 'Signal',
        log: this.o.log,
        onEvent: (ev) => {
          if (ev.t !== 'app') return;
          if (ev.state === 'running') this.restarts = 0;
          if (ev.state === 'exited' && !this.stopped) this.scheduleRestart();
          this.o.onChange();
        },
      });
      await this.sandbox.start();
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
      this.o.log('error', `Signal Desktop did not start: ${this.error}`);
      this.o.onChange();
    }
  }

  /** Its hook went away (the window reloaded, the renderer crashed or hung): say where it hung, and start Desktop again if
   * the hook is not back soon (main.cjs reloads a crashed window itself). */
  private hookGone() {
    const hang = join(this.dir, 'home', 'dither-hang.json');
    if (existsSync(hang)) {
      try {
        const h = JSON.parse(readFileSync(hang, 'utf8')) as { reason?: string; error?: string; frames?: { fn: string; file: string; line: number; col: number }[] };
        this.o.log('warn', 'Signal Desktop hung', { reason: h.reason ?? h.error, at: (h.frames ?? []).slice(0, 12).map((f) => `${f.fn} ${f.file}:${f.line}:${f.col}`) });
      } catch {}
      rmSync(hang, { force: true });
    }
    if (this.watchdog || this.stopped) return;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.conn || this.stopped || !this.sandbox?.appAlive) return;
      this.o.log('warn', 'Signal Desktop has not come back since its window went away; starting it again');
      void this.sandbox.restartApp();
    }, WATCHDOG_MS);
  }

  private scheduleRestart() {
    if (this.restartTimer || this.stopped) return;
    const ms = RESTART_MS[Math.min(this.restarts++, RESTART_MS.length - 1)];
    this.o.log('warn', `Signal Desktop exited; starting it again in ${ms / 1000}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.sandbox?.startApp();
    }, ms);
  }

  async stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.conn?.end();
    this.conn = null;
    this.socket?.stop(true);
    this.socket = null;
    await this.sandbox?.stop();
    this.sandbox = null;
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof m.id === 'number' && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(String(m.error)));
        else p.resolve(m.result);
        continue;
      }
      this.onHook(m);
    }
  }

  private onHook(m: any) {
    switch (m.ev) {
      case 'hello':
        return;
      case 'log':
        // The hook's own words and numbers (states, levels, counts: never a name or what anyone says).
        this.o.log(m.level === 'warn' || m.level === 'error' ? m.level : m.level === 'info' ? 'info' : 'debug', `[desktop] ${String(m.msg).slice(0, 300)}`, m.data);
        return;
      case 'app': {
        const was = this.app;
        this.app = m.app as DesktopApp;
        if (!!was?.signedIn !== !!this.app.signedIn || !!was?.linkUrl !== !!this.app.linkUrl || was?.linkUrl !== this.app.linkUrl) this.o.onChange();
        return;
      }
      case 'call':
      case 'ring':
        this.o.onEvent(m as HookEvent);
        return;
    }
  }

  request<T = unknown>(op: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const conn = this.conn;
    if (!conn) return Promise.reject(new Error('Signal Desktop is not running'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Signal Desktop did not answer ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      conn.write(`${JSON.stringify({ ...body, id, op })}\n`);
    });
  }

  liveView() {
    return this.sandbox ? { vncSocket: this.sandbox.vncSocket, width: this.o.width ?? 1280, height: this.o.height ?? 800 } : null;
  }

  layer(): Layer {
    if (this.error) return { name: 'calls', state: 'failed', note: this.error };
    if (!this.sandbox) return { name: 'calls', state: 'waiting', note: 'starting Signal Desktop' };
    if (!this.sandbox.appAlive) return { name: 'calls', state: 'waiting', note: this.restarts ? `Signal Desktop exited; starting it again (${this.restarts} so far)` : 'starting Signal Desktop' };
    if (!this.conn || !this.app?.ready) return { name: 'calls', state: 'waiting', note: 'Signal Desktop is loading' };
    if (!this.app.signedIn) return { name: 'calls', state: 'waiting', note: this.app.linkUrl ? 'link Signal Desktop: scan the code in the live view with Signal on your phone (Settings → Linked devices)' : 'Signal Desktop is linking' };
    return { name: 'calls', state: 'ok', note: 'through Signal Desktop' };
  }

  details(): Record<string, string | number | boolean | null> {
    return {
      'calls body': this.ready ? 'Signal Desktop, linked' : this.app?.signedIn ? 'Signal Desktop, hook away' : 'Signal Desktop, not linked',
      ...(this.sandbox ? { 'calls display': displayName(this.sandbox.screen?.free) ?? 'starting' } : {}),
    };
  }
}
