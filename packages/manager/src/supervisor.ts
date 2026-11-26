/**
 * Runs one extractor process per enabled account (dither-chat's adapter supervisor, moved here) and talks to it over
 * the /extractor socket: commands out with an id, replies and events back. An extractor may also ask the manager itself
 * (`ask`, answered by `onAsk` for that socket's account only: the approver's requests, docs/approver.md).
 *
 * One process per account, ever: a lock file in the account's directory names the process that runs its session.
 * dither-chat's hub takes the same lock for the accounts it still runs itself, so an account moved here cannot also
 * be started there (two Signal or WhatsApp sessions on one store corrupt it).
 *
 * Extractors outlive the manager (docs/supervisor.md): launched in a systemd scope of their own, writing straight to
 * their log, they keep their sessions while the manager restarts (a deploy), reconnect to the next one, and that one
 * adopts them (found in /proc by the data directory and token in their environment) instead of starting new ones. An
 * adopted extractor whose code changed (fingerprint.ts) restarts, one at a time; the others keep running.
 *
 * Accounts of a kind that may sleep (Manifest.sleep) are stopped when idle and started again by the next call, their
 * extractor's own next run, or a keep-alive (docs/supervisor.md "Sleeping"); the registry remembers which sleep.
 */
import type { ServerWebSocket, Subprocess } from 'bun';
import { createHmac } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecretFile } from '@dither-chat/protocol/secret-file';
import { type FailureKind, isExtractorCode, isFailureKind, retryAfterOf } from '@dither-accounts/spec';
import { Handover, HandoverError } from '@dither-accounts/spec/handover';
import { DEFAULT_DISPLAY_BACKEND, DISPLAY_BACKEND_ENV, type DisplayBackend, parseBackend } from '@dither-accounts/spec/display';

/** The page's choice of the default display backend, in the store's settings (Supervisor.defaultBackend). */
export const DISPLAY_BACKEND_SETTING = 'display_backend';
import type { SleepInfoView } from './api-types.ts';
import type { Row, Store } from './db.ts';
import { fingerprintEntry, sameCode } from './fingerprint.ts';
import { LOG } from './files.ts';
import type { Kind } from './kinds.ts';
import { allPids, cgroupMembers, cgroupOf, descendants, endAll, groupMembers, serviceOf, procAlive, procCmdline, procEnv, type ProcRef, procsWithEnv, procStartedAt, procStat, signalRef } from './procs.ts';
import { spanRecordOf, writeSpan } from './trace.ts';

export interface ExtractorSocketData {
  kind: 'extractor';
  accountId: string;
}

export type ExtractorEvent = { t: string; [k: string]: unknown };

/**
 * How an extractor's process is started (docs/supervisor.md):
 * - `scope`: in a systemd user scope of its own (`systemd-run --user --scope`), in a session of its own. Stopping or
 *   restarting the manager's unit leaves it running: it is in its own control group, not the unit's.
 * - `detached`: in a session of its own, nothing more. It outlives the manager's process, but not a systemd unit's
 *   stop (the unit's control group is killed): for a manager run without systemd, and for tests.
 * - `child`: as a plain child, stopped with the manager (main.ts's choice outside systemd).
 * In each its output goes straight to the account's adapter.log, never through the manager.
 */
export type Launch = 'scope' | 'detached' | 'child';

/**
 * `auto`: `scope` when this process is the main process of a systemd user service (procs.ts ownService: a shell or a
 * script that only inherited a service's INVOCATION_ID is not) and `systemd-run --user --scope` works; else `child`.
 * With the service's name, which main.ts asks on SIGTERM whether it is being restarted or stopped.
 */
export function chooseLaunch(
  want: Launch | 'auto',
  o: { service?: () => string | null; probe?: () => true | string } = {},
): { launch: Launch; unit: string | null; why: string } {
  // Only auto and scope need the service (scope: main.ts asks systemd on SIGTERM whether it restarts or stops).
  if (want === 'child' || want === 'detached') return { launch: want, unit: null, why: `set to ${want}` };
  const svc = o.service ? { unit: o.service(), why: 'given' } : serviceOf();
  const unit = svc.unit;
  if (want !== 'auto') return { launch: want, unit, why: `set to ${want}` };
  if (!unit) return { launch: 'child', unit, why: svc.why };
  const probe =
    o.probe ??
    ((): true | string => {
      try {
        const r = Bun.spawnSync(['systemd-run', '--user', '--scope', '--quiet', '--collect', 'true'], { stdout: 'ignore', stderr: 'pipe', timeout: 10_000 });
        return r.exitCode === 0 ? true : `systemd-run --user --scope failed (${r.exitCode ?? 'timed out'}): ${r.stderr.toString().trim().slice(0, 200)}`;
      } catch (e) {
        return `systemd-run --user --scope did not run: ${(e as Error).message}`;
      }
    });
  const ok = probe();
  return ok === true ? { launch: 'scope', unit, why: `the main process of ${unit}, and systemd-run --user --scope works` } : { launch: 'child', unit, why: ok };
}

interface Running {
  retry?: Timer;
  /** Its process, when this manager started it (its exit code comes from here). */
  proc?: Subprocess;
  /** The process that runs the account, started here or adopted, and when it started (procs.ts): a reused pid is not it. */
  pid?: number;
  pstart?: string;
  /** Its control group, when it is a scope of its own (`dither-accounts-x-….scope`): everything it started is in it. */
  cgroup?: string;
  /** Started by an earlier manager and taken over by this one: watched in /proc, not as a child. */
  adopted?: boolean;
  /** It outlives this manager (launched as `scope` or `detached`, or adopted): a manager that goes leaves it running. */
  survives?: boolean;
  /** The fingerprint of the code it runs (fingerprint.ts), as it was when it started. */
  fingerprint?: string;
  /** The display backend it was started with (DITHER_DISPLAY_BACKEND); null for a kind with no screen. */
  backend?: DisplayBackend | null;
  /** Waiting for the sandboxes' programs to be prepared (prepare.ts) before it starts. */
  waitingBins?: boolean;
  /** An adopted process that has not connected by then is started afresh. */
  connectBy?: number;
  /** adapter.log's size when it started: a failed exit's last lines are read from there. */
  logFrom?: number;
  /** What an earlier process left behind is being ended before this one starts. */
  cleaning?: boolean;
  /** Its link's `resumed` (back after its manager went): whether it held every event since. */
  resumedHeld?: boolean;
  ws?: ServerWebSocket<ExtractorSocketData>;
  restarts: number;
  stopping: boolean;
  lastStart: number;
  error?: string;
  /** When its socket last connected. */
  onlineSince?: number;
  /** Starts since the manager started (restarts after a crash included). */
  starts?: number;
  lastExit?: { code: number | null; signal: string | null; at: number };
  /**
   * What its extractor said about sleeping (link.sleep): what it is doing that a stop would cut, and when it next needs
   * to run by itself. Until it says, it does not sleep.
   */
  sleepSaid?: { busy: string | null; wakeAt: number | null };
  /** Its last status, in short: one that is not `online`, or that needs you, keeps it awake. */
  said?: { status: string; attention: boolean };
  /** When it last did something (connected, a call, busy, held awake): it sleeps its kind's idle time after that. */
  activeAt?: number;
}

/** An account asleep (docs/supervisor.md "Sleeping"): since when, and when and why it wakes by itself (null: a call). */
interface Asleep {
  since: number;
  wakeAt: number | null;
  wakeFor: string | null;
}

/** Sleeping, as the manager runs it (ManagerOpts.sleep, main.ts's `sleep` keys). Kinds say whether theirs may. */
export interface SleepOpts {
  /** False: no account sleeps (`sleep = 0`). Default true. */
  enabled?: boolean;
  /** Every kind's idle time, instead of its own (`sleep_idle_minutes`; tests). */
  idleMs?: number;
  /** The keep-alive of every kind that has one, instead of its own (`sleep_keep_alive_hours`); 0: none. */
  keepAliveMs?: number;
  /** How long before the time its extractor gave (a daily pull) it is started, so its browser is up by then (2 min). */
  leadMs?: number;
  /** It is not put to sleep for less than this: a stop and a start cost more than they save (10 min). */
  minMs?: number;
  /** How often idle accounts and due wakes are looked at (30 s). */
  checkMs?: number;
}

/** How many of an extractor's last log lines are kept for a crash record. */
const CRASH_LINES = 60;

type Pending = { resolve: (v: unknown) => void; reject: (e: ExtractorError) => void; timer: Timer; accountId: string };
type Socket = ServerWebSocket<ExtractorSocketData>;

export class ExtractorError extends Error {
  constructor(
    message: string,
    /** The manager's offline, timeout or failed; or the extractor's own word for a refusal (spec isExtractorCode). */
    readonly code: 'offline' | 'timeout' | 'failed' | (string & {}),
    readonly status?: number,
    /** The extractor's own kind for it (spec FailureKind) and how long it said to wait, when it said them. */
    readonly kind?: FailureKind,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const BACKOFF = [1, 2, 5, 10, 30, 60];
/** How often an account another process runs is looked at again. */
const LOCK_RETRY_MS = 15_000;
export const LOCK = 'extractor.lock';
/** What an extractor writes as it exits ({pid, code}): an adopted one is no child, so its code is read from here. */
export const EXIT_FILE = 'extractor.exit';
/** How often adopted processes are looked at in /proc. */
const WATCH_MS = 1000;
/** How long an adopted process has to connect before it is taken for stuck and started afresh. */
const ADOPT_CONNECT_MS = 60_000;
/** How long a restarted extractor has to come online before its kind's restarts stop. */
const RESTART_ONLINE_MS = 60_000;
/** Between two restarts for changed code, and before the first. */
const RESTART_PAUSE_MS = 20_000;
/**
 * How long a restart for changed code waits for the calls the old extractor already has (calls that come meanwhile wait
 * for the new one, so an app that polls without pause cannot keep it waiting): an app's poll is answered within a
 * second or two. Past it, the extractor is stopped anyway, and the calls it still has fail 'offline'.
 */
const RESTART_DRAIN_MS = 30_000;
/**
 * How long a call waits for an extractor that is starting (a start, the page's Restart, a restart for changed code)
 * before it is refused 'retry' (503: never sent). The new process's link connects a second or two after it starts,
 * before any browser is up; a stop before it takes at most its 8 s grace and 2 s to kill. Past this, the start is going
 * wrong (RESTART_ONLINE_MS stops a kind's restarts at 60 s), and the caller still has time to try again or to show the
 * account as restarting. Calls after that fail at once 'offline', until it connects.
 */
const START_OPEN_MS = 20_000;
/**
 * How long calls wait for an extractor whose socket dropped while its process runs: its link tries again after 250 ms
 * and never waits more than 5 s between tries (outlive.ts reconnectDelay), and sends the answers it made meanwhile.
 * Past this, waiting calls are refused 'retry', and the calls it had fail 'offline' (it may have run them): their
 * answers could only come on a socket it does not seem to open.
 */
const RECONNECT_OPEN_MS = 10_000;
/**
 * How long a call waits for an account it woke: what is left of its sleep's stop (up to its 8 s grace and 2 s to kill),
 * then the start (its link connects a second or two after it starts). Past this, waiting calls are refused 'retry'.
 */
const WAKE_OPEN_MS = 30_000;
const SLEEP_LEAD_MS = 2 * 60_000;
const SLEEP_MIN_MS = 10 * 60_000;
const SLEEP_CHECK_MS = 30_000;
/** An extractor that outlives its manager ends itself after this long without one (its link, DITHER_MANAGER_GONE_EXIT_S). */
const MANAGER_GONE_EXIT_S = 1800;
/** How long a going manager waits for its extractors to say they hold their events. */
const GOING_MS = 5000;
/** A scope the supervisor made: only such a control group is ever emptied (never the manager's own). */
const OUR_SCOPE = /\/dither-accounts-x-[^/]+\.scope$/;

/** An extractor's own process, not what it started (Chromium, signal-cli, the WhatsApp bridge inherit its environment). */
// Bun running an extractor's entry: not systemd-run on its way to it (for a moment, in the manager's control group,
// with the extractor's environment and its entry among its own arguments, until its scope exists).
const isExtractorCmd = (pid: number) => {
  const c = procCmdline(pid);
  return /(^|\/)bun[^/]*$/.test(c[0] ?? '') && c.slice(1).some((a) => a.endsWith('/src/main.ts'));
};

/**
 * Processes on this machine that run an account: any live process with DITHER_ACCOUNT_ID=<id> in its environment,
 * whoever started it (a hub that predates the lock, an orphan of a crashed supervisor). Not our own children.
 */
export function accountProcesses(accountId: string, except: number[] = []): number[] {
  const out: number[] = [];
  const needle = `DITHER_ACCOUNT_ID=${accountId}`;
  for (const pid of allPids()) {
    if (pid === process.pid || except.includes(pid)) continue;
    try {
      // The adapter itself (bun …/src/main.ts), not what it started (Chromium, signal-cli, the WhatsApp bridge
      // inherit its environment, and may outlive it for a moment).
      if (!readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(needle)) continue;
      if (isExtractorCmd(pid)) out.push(pid);
    } catch {}
  }
  return out;
}

/**
 * Take an account directory's lock, or say who holds it. A lock whose process is gone is stale and taken over. With
 * `accountId`, a live process already running that account (lock or not) also holds it, but for those in `except`
 * (an extractor being adopted).
 */
export function acquireLock(dir: string, owner: string, accountId?: string, except: number[] = []): string | null {
  if (accountId) {
    const running = accountProcesses(accountId, except);
    if (running.length) return `pid ${running.join(', ')} already runs this account`;
  }
  const p = join(dir, LOCK);
  if (existsSync(p)) {
    try {
      const l = JSON.parse(readFileSync(p, 'utf8')) as { pid: number; owner: string };
      if (l.pid !== process.pid && alive(l.pid)) return `${l.owner} (pid ${l.pid}) runs this account`;
    } catch {}
  }
  writeFileSync(p, JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() }), { mode: 0o600 });
  return null;
}
export function releaseLock(dir: string) {
  const p = join(dir, LOCK);
  try {
    if (JSON.parse(readFileSync(p, 'utf8')).pid === process.pid) unlinkSync(p);
  } catch {}
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** The manager's own lock on its data directory: one manager per data directory, so none adopts another's extractors. */
export const MANAGER_LOCK = 'manager.lock';
/** Data directories a manager in this process holds (tests run several managers in one process). */
const heldHere = new Set<string>();
export function acquireManagerLock(dataDir: string): string | null {
  const p = join(dataDir, MANAGER_LOCK);
  const key = realpathSync(dataDir);
  if (heldHere.has(key)) return `another manager in this process runs on ${dataDir}`;
  try {
    const l = JSON.parse(readFileSync(p, 'utf8')) as { pid?: number; start?: string };
    if (typeof l.pid === 'number' && l.pid !== process.pid && procAlive(l.pid, l.start)) return `another manager (pid ${l.pid}) runs on ${dataDir}`;
  } catch {}
  writeFileSync(p, JSON.stringify({ pid: process.pid, start: procStat(process.pid)?.start, at: new Date().toISOString() }), { mode: 0o600 });
  heldHere.add(key);
  return null;
}
export function releaseManagerLock(dataDir: string) {
  const p = join(dataDir, MANAGER_LOCK);
  try {
    heldHere.delete(realpathSync(dataDir));
  } catch {}
  try {
    if (JSON.parse(readFileSync(p, 'utf8')).pid === process.pid) unlinkSync(p);
  } catch {}
}

/** The code an extractor that is no child wrote as it exited (EXIT_FILE), if that file is about this pid. */
function exitCodeOf(dir: string, pid: number): number | null {
  try {
    const e = JSON.parse(readFileSync(join(dir, EXIT_FILE), 'utf8')) as { pid?: unknown; code?: unknown };
    return e.pid === pid && typeof e.code === 'number' ? e.code : null;
  } catch {
    return null;
  }
}

/** The last lines of a file from `from` on (at most the last 256 KB). */
function linesSince(path: string, from: number, n: number): string[] {
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(from, size - 256 * 1024, 0);
      if (start >= size) return [];
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines.slice(-n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

const fileSize = (p: string) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};

/** A systemd unit name for an extractor's scope: its account and a stamp (an old scope can linger while it empties). */
const scopeName = (accountId: string) => `dither-accounts-x-${accountId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${Date.now().toString(36)}.scope`;

/** A process's control group when it is a scope the supervisor made, else undefined. */
const scopeOf = (pid: number) => {
  const cg = cgroupOf(pid);
  return cg && OUR_SCOPE.test(cg) ? cg : undefined;
};

/**
 * The key an account's extractor makes the names its browser extension leaves in pages from (DITHER_MARKER_KEY,
 * packages/browser/src/markers.ts): HMAC of this install's own random secret (kv `page-markers`, made once) and the
 * account's id. So no two installs, and no two accounts of one install, show a site the same names, and an account's
 * names stay the same from one start to the next. The secret itself never leaves the manager.
 */
export function pageMarkerKey(store: Store, accountId: string): string {
  return createHmac('sha256', store.installValue('page-markers')).update(accountId).digest('base64url');
}

/** An extractor process an earlier manager of this data directory started, as /proc shows it. */
interface Found {
  pid: number;
  start: string;
  accountId: string;
  token: string;
  fingerprint: string;
  /** The display backend it was started with (DITHER_DISPLAY_BACKEND), null when it was given none. */
  backend: DisplayBackend | null;
}

/** Restarts for changed code since this manager started, for /api/health (only counts) and the deployer. */
export interface CodeRestarts {
  /** Waiting for their turn. */
  queued: number;
  /** Being restarted now (at most one per kind). */
  active: number;
  /** Restarted so far. */
  restarted: number;
  /** Of those, online now. */
  online: number;
  /** Of those, ended on their own since (a crash loop on the new code). */
  crashed: number;
}

export class Supervisor {
  private running = new Map<string, Running>();
  /** What a stop forgets but the account pane still shows: how often it started, how it last ended. */
  private history = new Map<string, Pick<Running, 'starts' | 'lastExit'>>();
  private pending = new Map<string, Pending>();
  /**
   * Each account's connection to its extractor, through restarts and reconnects (packages/spec handover.ts): calls wait
   * while one starts or reconnects, the old one answers what it has, and a call that could not be sent says so.
   */
  private lines = new Map<string, Handover<Socket>>();
  /** Fires when the manager closes: a restart's drain stops waiting. */
  private closingCtrl = new AbortController();
  /** Accounts the manager answers itself (the built-in `notices`): never started, always online. */
  readonly inProcess = new Set<string>();
  readonly launch: Launch;
  private dataDir: string;
  private watcher?: Timer;
  /** Adopted accounts whose code changed, by kind: one restart at a time per kind, different kinds side by side. */
  private outdated = new Map<string, string[]>();
  /** Accounts being restarted for changed code now (at most one per kind). */
  private rollingNow = new Set<string>();
  private pauses = new Set<{ timer: Timer; done: () => void }>();
  private rollingKinds = new Set<string>();
  /** Accounts restarted for changed code, and how often each ended on its own since (a crash on the new code). */
  private rolled = new Set<string>();
  private rolledCrashes = new Map<string, number>();
  /** An account's stop under way: a start waits for it (`startAfter`), so a stop never ends the start that followed it. */
  private stops = new Map<string, Promise<void>>();
  private startAfter = new Set<string>();
  /** Accounts whose next start must not trust what it kept from before (an app heard of a gap: DITHER_RESYNC). */
  private resync = new Set<string>();
  /** Accounts stopped on purpose (a stop from the page, an app, a disable): a staggered restart leaves them stopped. */
  private halted = new Set<string>();
  private scan?: { at: number; found: Found[] };
  /** When an account was last made sure to have nothing left running. */
  private cleanedAt = new Map<string, number>();
  /** Extractors that said they hold their events (a going manager's `manager-going`). */
  private holding = new Map<string, () => void>();
  /** The sandboxes' programs are prepared (or failed to be): a kind with a screen starts without waiting. */
  private binsSettled = false;
  /** The manager is going: nothing starts again, and exits of processes it leaves running are not crashes. */
  private closing = false;
  /** Accounts asleep, as the registry keeps them (table `asleep`). */
  private asleep = new Map<string, Asleep>();
  /** What holds an account awake besides its own work (its live view open, a provider's job), by holder. */
  private holds = new Map<string, Map<object, string>>();
  /** Accounts woken from sleep, and why, until their extractor starts: it gets DITHER_WOKE. */
  private woke = new Map<string, string>();
  private sleepTimer?: Timer;

  constructor(
    private store: Store,
    private kinds: Map<string, Kind>,
    private opts: {
      /** ws://127.0.0.1:<port>/extractor, once the server listens. */
      extractorUrl: () => string;
      repoRoot: string;
      /** The manager's data directory: its extractors carry it, so a manager adopts only its own (never a test's). */
      dataDir: string;
      /** How extractors are started (default `child`). */
      launch?: Launch;
      /** The display backend of accounts whose config names none (default x11). */
      displayBackend?: DisplayBackend;
      /**
       * The sandboxes' programs, prepared at the manager's start (prepare.ts): an extractor of a kind with a screen
       * starts once this settles, and is given the directory (DITHER_BINS) when there is one.
       */
      bins?: { ready: Promise<unknown>; dir: () => string | null };
      /** The command a `scope` launch goes through (default systemd-run; tests give a stand-in). */
      systemdRun?: string;
      /** The fingerprint of a kind's code (default fingerprint.ts over repoRoot); tests give their own. */
      fingerprint?: (kind: Kind) => string;
      /** Between restarts for changed code (default 20 s). */
      restartPauseMs?: number;
      /** How long an extractor restarted for changed code has to come online before its kind's restarts stop (60 s). */
      restartOnlineMs?: number;
      /** How long an adopted extractor has to connect (default 60 s). */
      adoptConnectMs?: number;
      /** How often adopted extractors are looked at in /proc (default 1 s). */
      watchMs?: number;
      /** Seconds an extractor that outlives the manager waits for one before it ends itself (default 1800). */
      managerGoneExitS?: number;
      /** Sleeping idle accounts of kinds that may (docs/supervisor.md "Sleeping"); on by default. */
      sleep?: SleepOpts;
      /** Events (not replies or logs) from an account's extractor. */
      onEvent: (accountId: string, ev: ExtractorEvent) => void;
      /** Running or online changed. */
      onChange: (accountId: string) => void;
      /**
       * An extractor process ended: what it last said of itself (its status) no longer holds. `asleep`: it was stopped
       * to sleep, so its last status still says how it was (all but its live view, which went with it).
       */
      onExit?: (accountId: string, asleep: boolean) => void;
      /** An extractor's process ended on its own and is being started again. */
      onCrash?: (accountId: string) => void;
      /**
       * An extractor's process ended on its own with a failure (a code other than 0, or a signal), with the last lines
       * it wrote to its log: the manager's error file (errors.ts) records its last error.
       */
      onFailedExit?: (accountId: string, kind: string, exit: { code: number | null; signal: string | null; stderr: string[] }) => void;
      /** An adopted extractor's link is back: `held`, it kept every event since its manager went (none was lost). */
      onResumed?: (accountId: string, held: boolean) => void;
      /** A question from an account's extractor to the manager (`what`, its input); throw to refuse. */
      onAsk?: (accountId: string, what: string, input: Record<string, unknown>) => Promise<unknown>;
    },
  ) {
    this.launch = opts.launch ?? 'child';
    try {
      this.dataDir = realpathSync(opts.dataDir);
    } catch {
      this.dataDir = opts.dataDir;
    }
    for (const a of store.all<{ account: string; since: number; wake_at: number | null; wake_for: string | null }>('SELECT * FROM asleep')) this.asleep.set(a.account, { since: a.since, wakeAt: a.wake_at, wakeFor: a.wake_for });
  }

  /** `asleep` once its extractor has stopped: while it falls asleep (its stop takes a few seconds) it still runs. */
  state(id: string) {
    if (this.inProcess.has(id)) return { running: true, online: true, error: null, asleep: false };
    const r = this.running.get(id);
    return { running: !!r?.pid, online: !!r?.ws, error: r?.error ?? null, asleep: this.asleep.has(id) && !r?.pid };
  }

  /** The process side of an account, for the account pane. */
  details(id: string) {
    const r = this.running.get(id);
    return {
      pid: r?.pid ?? null,
      tree: r?.pid ? processTree(r.pid) : [],
      startedAt: r?.pid ? r.lastStart : null,
      onlineSince: r?.ws ? (r.onlineSince ?? null) : null,
      starts: r?.starts ?? 0,
      lastExit: r?.lastExit ?? null,
      adopted: !!r?.adopted,
      displayBackend: r?.pid ? (r.backend ?? null) : null,
    };
  }

  /** Accounts whose extractor this manager adopted (still running as adopted). */
  adopted(): string[] {
    return [...this.running].filter(([, r]) => r.adopted && r.pid).map(([id]) => id);
  }

  /** Restarts for changed code: what waits, what is under way, and how the restarted ones are doing. */
  codeRestarts(): CodeRestarts {
    let online = 0;
    let crashed = 0;
    let restarted = 0;
    for (const id of this.rolled) {
      const r = this.running.get(id);
      if (!r || this.halted.has(id)) continue; // stopped on purpose since
      // Still under way: counted in `active`, once.
      if (this.rollingNow.has(id)) {
        if (this.rolledCrashes.get(id)) crashed++;
        continue;
      }
      restarted++;
      if (r.ws) online++;
      // Only exits nobody asked for: a restart from the page, an app or a gap is no crash.
      if (this.rolledCrashes.get(id)) crashed++;
    }
    let queued = 0;
    for (const q of this.outdated.values()) queued += q.length;
    return { queued, active: this.rollingNow.size, restarted, online, crashed };
  }

  /**
   * The display backend an account's sandboxes use: its config's displayBackend, else the manager's default
   * (defaultBackend). Null for a kind with no screen (its manifest does not say `screen`): mail, calendars, signal-cli
   * have none to move.
   */
  backendOf(acc: Row): DisplayBackend | null {
    const kind = this.kinds.get(acc.kind);
    if (!kind || !kind.screen) return null;
    return this.ownBackend(acc) ?? this.defaultBackend();
  }

  /** The backend an account's config names (its displayBackend), or null when it follows the manager's default. */
  ownBackend(acc: Row): DisplayBackend | null {
    try {
      return parseBackend((JSON.parse(acc.config || '{}') as { displayBackend?: unknown }).displayBackend);
    } catch {
      return null;
    }
  }

  /**
   * The manager's default display backend (docs/browser.md "Display backends"): the one chosen on the page, else
   * config.toml's display_backend (or its flag), else x11. The page's choice wins because it is the later one, made
   * where the default is shown; Use config.toml's on the page forgets it.
   */
  defaultBackend(): DisplayBackend {
    return parseBackend(this.store.setting(DISPLAY_BACKEND_SETTING)) ?? this.configBackend();
  }

  /** config.toml's display_backend (or --display-backend), else x11. */
  configBackend(): DisplayBackend {
    return this.opts.displayBackend ?? DEFAULT_DISPLAY_BACKEND;
  }

  /** The fingerprint of the code a kind's extractor would run if started now. */
  fingerprintOf(kind: Kind): string {
    if (this.opts.fingerprint) return this.opts.fingerprint(kind);
    try {
      return fingerprintEntry(this.opts.repoRoot, join(kind.dir, kind.entry), { ...process.env, ...(kind.env ?? {}) }).hash;
    } catch (e) {
      return `unknown: ${(e as Error).message}`.slice(0, 100);
    }
  }

  /**
   * Every enabled account's extractor: an earlier manager's still running is adopted, the rest start. Extractors an
   * earlier manager left running for accounts that are now disabled, gone or of a kind that no longer loads are stopped.
   * An account asleep stays so (it wakes when it would have), unless its kind no longer sleeps or an extractor of it
   * still runs (an earlier manager went while it fell asleep): then it starts, or is adopted, as any other.
   */
  startAll() {
    this.sweep();
    for (const a of this.store.accounts()) {
      if (!a.enabled) {
        this.forgetSleep(a.id);
        continue;
      }
      if (this.asleep.has(a.id) && this.sleepOf(a) && !this.found().some((f) => f.accountId === a.id && f.token === a.token)) continue;
      this.start(a.id);
    }
    for (const id of this.asleep.keys()) if (!this.store.account(id)) this.forgetSleep(id);
    this.sleepTimer ??= setInterval(() => this.sleepSweep(), this.opts.sleep?.checkMs ?? SLEEP_CHECK_MS);
  }

  /**
   * Extractor processes an earlier manager of this data directory started (their environment says so) that are not
   * this one's. Only their own processes (bun …/src/main.ts), not what they started.
   */
  private found(): Found[] {
    // One look at /proc serves every account startAll starts; each use checks again that the process still runs.
    const mine = new Set([...this.running.values()].map((r) => r.pid));
    if (this.scan && Date.now() - this.scan.at < 1000) return this.scan.found.filter((f) => !mine.has(f.pid) && procAlive(f.pid, f.start));
    const found: Found[] = [];
    for (const pid of allPids()) {
      if (pid === process.pid || mine.has(pid)) continue;
      const env = procEnv(pid);
      if (!env || env.DITHER_MANAGER_DATA !== this.dataDir || !env.DITHER_EXTRACTOR_LAUNCH || !env.DITHER_ACCOUNT_ID) continue;
      if (!isExtractorCmd(pid)) continue;
      const st = procStat(pid);
      if (!st || st.state === 'Z') continue;
      found.push({ pid, start: st.start, accountId: env.DITHER_ACCOUNT_ID, token: env.DITHER_ADAPTER_TOKEN ?? '', fingerprint: env.DITHER_EXTRACTOR_FINGERPRINT ?? '', backend: parseBackend(env[DISPLAY_BACKEND_ENV]) });
    }
    this.scan = { at: Date.now(), found };
    return found;
  }

  /** Every process this data directory's extractors of an account started and left (it inherits their environment). */
  private leftovers(accountId: string): ProcRef[] {
    return [...procsWithEnv((env) => env.DITHER_ACCOUNT_ID === accountId && env.DITHER_MANAGER_DATA === this.dataDir), ...this.sandboxProcs(accountId)];
  }

  /**
   * What a native-app sandbox of the account (packages/sandbox) says it runs, in its sandbox.json: bubblewrap clears
   * the environment, so Xvfb, x11vnc, dbus-daemon, pasta and the app itself carry no account id. In the account's
   * directory or a directory below it.
   */
  private sandboxProcs(accountId: string): ProcRef[] {
    const acc = this.store.account(accountId);
    if (!acc) return [];
    const files: string[] = [];
    const look = (d: string, depth: number) => {
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(d, n);
        if (n === 'sandbox.json') files.push(p);
        else if (depth > 0 && !n.startsWith('.') && n !== 'node_modules') {
          try {
            if (statSync(p).isDirectory()) look(p, depth - 1);
          } catch {}
        }
      }
    };
    look(acc.dir, 2);
    const out: ProcRef[] = [];
    for (const f of files) {
      try {
        const { procs } = JSON.parse(readFileSync(f, 'utf8')) as { procs?: { pid?: unknown; start?: unknown; match?: unknown }[] };
        for (const p of procs ?? []) {
          if (typeof p.pid !== 'number') continue;
          const st = procStat(p.pid);
          if (!st || st.state === 'Z') continue;
          // By its start time when the record has one, else by its command line (as the sandbox's own cleanup does).
          if (typeof p.start === 'string' ? st.start !== p.start : !(typeof p.match === 'string' && p.match && procCmdline(p.pid).join(' ').includes(p.match))) continue;
          out.push({ pid: p.pid, start: st.start });
        }
      } catch {}
    }
    return out;
  }

  /**
   * One stop of an account at a time, and a start asked for meanwhile waits for it (start() queues it): a stop that
   * finished later would end the new extractor, or forget it while it runs.
   */
  private serially(id: string, f: () => Promise<void>): Promise<void> {
    const p = (this.stops.get(id) ?? Promise.resolve()).then(f, f);
    this.stops.set(id, p);
    return p.finally(() => {
      if (this.stops.get(id) !== p) return;
      this.stops.delete(id);
      if (this.startAfter.delete(id) && !this.halted.has(id)) this.start(id);
    });
  }

  /** An app heard of a gap for this account: its next start must not trust what it kept (DITHER_RESYNC). */
  markResync(id: string) {
    this.resync.add(id);
  }

  /**
   * Ends an extractor and everything it started: SIGTERM (after a `shutdown` on its socket, sent by the caller), SIGKILL
   * after `graceMs`, then whatever is left of it: its scope's control group, its process group, its descendants as
   * they were, and anything carrying its account in this data directory's environment (Chromium's zygotes, Xvfb,
   * signal-cli, the WhatsApp bridge). A process left behind would be a second session on one account.
   */
  private async end(accountId: string, p: { pid: number; start?: string; proc?: Subprocess; cgroup?: string }, graceMs = 8000, spare?: number) {
    // Everything that is its, taken before it is signalled: looked for afterwards, a new extractor of the account
    // (started meanwhile) would be taken for one of its leftovers. `spare`: an extractor of the account that stays, and
    // what it started.
    const spared = new Set(spare ? [spare, ...descendants(spare).map((r) => r.pid)] : []);
    const snapshot = [...descendants(p.pid), ...groupMembers(p.pid), ...this.leftovers(accountId)].filter((r) => r.pid !== p.pid && !spared.has(r.pid));
    const cgroup = p.cgroup ?? scopeOf(p.pid);
    signalRef({ pid: p.pid, start: p.start ?? '' }, 'SIGTERM');
    const gone = () => (p.proc ? p.proc.exitCode !== null || p.proc.signalCode !== null : !procAlive(p.pid, p.start));
    const until = async (ms: number) => {
      const end = Date.now() + ms;
      while (!gone() && Date.now() < end) await (p.proc ? Promise.race([p.proc.exited, Bun.sleep(100)]) : Bun.sleep(100));
    };
    if (p.start === undefined) {
      // No start time to check by: signal it only as our own child.
      if (p.proc && !gone()) p.proc.kill('SIGTERM');
    }
    await until(graceMs);
    if (!gone()) {
      if (p.start !== undefined) signalRef({ pid: p.pid, start: p.start }, 'SIGKILL');
      else p.proc?.kill('SIGKILL');
      await until(2000);
    }
    // Its old scope and process group hold nothing new; its environment is not looked at again.
    await this.endLeft(accountId, cgroup, [...snapshot, ...groupMembers(p.pid)].filter((r) => !spared.has(r.pid)), false);
  }

  /** What is left of an account's extractor: ended (SIGTERM, then SIGKILL). */
  private async endLeft(accountId: string, cgroup: string | undefined, known: ProcRef[] = [], lookAgain = true) {
    const seen = new Map<string, ProcRef>();
    const add = (rs: ProcRef[]) => {
      for (const r of rs) if (r.pid !== process.pid) seen.set(`${r.pid}:${r.start}`, r);
    };
    add(known);
    if (cgroup && OUR_SCOPE.test(cgroup)) add(cgroupMembers(cgroup));
    if (lookAgain) add(this.leftovers(accountId));
    const left = [...seen.values()].filter((r) => procAlive(r.pid, r.start));
    this.cleanedAt.set(accountId, Date.now());
    if (!left.length) return;
    const acc = this.store.account(accountId);
    if (acc) appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} ending ${left.length} process(es) its extractor left: ${left.map((r) => r.pid).join(', ')}\n`);
    await endAll(left, 2000);
    this.cleanedAt.set(accountId, Date.now());
  }

  /** Strays: an earlier manager's extractors whose account is disabled or gone, of no kind, or not the account's token. */
  private sweep() {
    for (const f of this.found()) {
      const acc = this.store.account(f.accountId);
      const why = !acc ? 'gone' : !acc.enabled ? 'disabled' : !this.kinds.has(acc.kind) ? `of kind "${acc.kind}", which does not load` : acc.token !== f.token || this.inProcess.has(acc.id) ? 'run another way' : null;
      if (!why) continue;
      console.error(`[${f.accountId}] stopping pid ${f.pid}, left running by an earlier manager: its account is ${why}`);
      if (acc) appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} dither-accounts stopping pid ${f.pid}, left running by an earlier manager (the account is ${why})\n`);
      // In the account's line, so a start of it (an enabled account whose token changed) waits for this.
      void this.serially(f.accountId, () => this.end(f.accountId, { pid: f.pid, start: f.start }));
    }
  }

  start(id: string) {
    this.halted.delete(id);
    if (this.inProcess.has(id) || this.closing) return;
    // Started (a wake, the page, an app): it is not asleep any more.
    this.forgetSleep(id);
    // A stop of it is under way: this start follows it.
    if (this.stops.has(id)) {
      this.startAfter.add(id);
      return;
    }
    const acc = this.store.account(id);
    if (!acc || !acc.enabled) return void this.line(id).down(acc ? 'the account is disabled' : 'the account is gone');
    const cur = this.running.get(id);
    if (cur && !cur.stopping && (cur.pid || cur.cleaning || cur.waitingBins)) return;
    const r: Running = cur ?? { restarts: 0, stopping: false, lastStart: 0, ...this.history.get(id) };
    clearTimeout(r.retry);
    r.stopping = false;
    r.error = undefined;
    this.running.set(id, r);
    const kind = this.kinds.get(acc.kind);
    if (!kind) return this.fail(id, r, `no extractor for kind "${acc.kind}"`);
    if (!existsSync(acc.dir)) mkdirSync(acc.dir, { recursive: true, mode: 0o700 });
    const log = join(acc.dir, LOG);

    // An extractor an earlier manager started that still runs: this manager takes it over rather than start another.
    const found = this.found().filter((f) => f.accountId === id && f.token === acc.token);
    if (found.length) {
      const [f, ...more] = found;
      // A second one of the same account (it should never be): ended in the account's line, sparing the adopted one.
      for (const m of more) void this.serially(id, () => this.end(id, { pid: m.pid, start: m.start }, 8000, f!.pid));
      acquireLock(acc.dir, 'dither-accounts', acc.id, found.map((x) => x.pid));
      this.woke.delete(id);
      r.proc = undefined;
      r.pid = f!.pid;
      r.pstart = f!.start;
      r.cgroup = scopeOf(f!.pid);
      r.adopted = true;
      r.survives = true;
      r.fingerprint = f!.fingerprint;
      // One started before kinds said whether they have a screen had x11 written in: a kind without one has no backend.
      r.backend = this.backendOf(acc) === null ? null : (f!.backend ?? DEFAULT_DISPLAY_BACKEND);
      r.lastStart = procStartedAt(f!.start) ?? Date.now();
      r.connectBy = r.ws ? undefined : Date.now() + (this.opts.adoptConnectMs ?? ADOPT_CONNECT_MS);
      const changed = !sameCode(f!.fingerprint, this.fingerprintOf(kind));
      // A display backend changed (the account's or the manager's default) restarts it the same way as changed code.
      // Only a kind with a screen has one to change (backendOf is null for the rest).
      const moved = r.backend !== this.backendOf(acc);
      appendFileSync(log, `--- ${new Date().toISOString()} dither-accounts took over the running ${acc.kind} extractor (pid ${f!.pid})${changed ? '; its code changed, so it restarts soon' : moved ? `; its display backend is now ${this.backendOf(acc)}, so it restarts soon` : ''}\n`);
      r.logFrom = fileSize(log);
      if (!r.ws) this.starting(id);
      this.watch();
      if (changed || moved) this.queueRestart(id);
      // Back already (it connected before startAll got to it): what it said on its return counts now.
      if (r.resumedHeld !== undefined) this.opts.onResumed?.(id, r.resumedHeld);
      this.opts.onChange(id);
      return;
    }

    // What an earlier process of this account left (a browser, signal-cli) goes first: never two sessions on one store.
    // (Not right after this manager ended what the last one left: that look at every process's environment is slow.)
    const left = Date.now() - (this.cleanedAt.get(id) ?? 0) < 2000 ? [] : this.leftovers(id);
    if (left.length) {
      this.starting(id);
      r.cleaning = true;
      void this.endLeft(id, undefined, left).finally(() => {
        r.cleaning = false;
        if (this.running.get(id) === r && !r.stopping) this.start(id);
      });
      return;
    }

    // A kind with a screen runs the programs the manager prepares at its start (prepare.ts): it waits for them.
    const prep = this.opts.bins;
    if (prep && kind.screen && !this.binsSettled) {
      if (!r.waitingBins) {
        r.waitingBins = true;
        this.starting(id);
        void prep.ready.finally(() => {
          this.binsSettled = true;
          r.waitingBins = false;
          if (this.running.get(id) === r && !r.stopping) this.start(id);
        });
      }
      return;
    }

    const held = acquireLock(acc.dir, 'dither-accounts', acc.id);
    if (held) {
      // Another process runs it (dither-chat's hub, before it lets go): look again, and take over once it is gone.
      r.retry = setTimeout(() => this.start(id), LOCK_RETRY_MS);
      return this.fail(id, r, held);
    }

    r.lastStart = Date.now();
    r.starts = (r.starts ?? 0) + 1;
    let root = this.opts.repoRoot;
    let entry = join(kind.dir, kind.entry);
    // The real paths: a release is reached through a link (`current`) that a deploy moves, and an extractor that lives
    // on must keep loading its own release's files.
    try {
      root = realpathSync(root);
      entry = realpathSync(entry);
    } catch {}
    const fingerprint = this.fingerprintOf(kind);
    const backend = this.backendOf(acc);
    const bins = this.opts.bins;
    const launch = this.launch;
    appendFileSync(log, `\n--- ${new Date().toISOString()} dither-accounts starting ${acc.kind} extractor\n`);
    r.logFrom = fileSize(log);
    const argv = launch === 'scope' ? [this.opts.systemdRun ?? 'systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${scopeName(acc.id)}`, `--description=dither-accounts extractor (${acc.kind})`, 'bun', entry] : ['bun', entry];
    // Its output straight to its log: the manager going away cannot break a pipe under it.
    const fd = openSync(log, 'a', 0o600);
    // The screen its sandboxes draw on (docs/browser.md "Display backends"): the account's, else the manager's; and the
    // programs they run, from the manager's pinned nixpkgs (prepare.ts). A kind with no screen is given neither, nor
    // what the manager's own environment might hand down.
    const { [DISPLAY_BACKEND_ENV]: _b, DITHER_BINS: _d, ...inherited } = process.env;
    const binsDir = backend ? (bins?.dir() ?? process.env.DITHER_BINS) : undefined;
    const screenEnv: Record<string, string> = backend ? { [DISPLAY_BACKEND_ENV]: backend, ...(binsDir ? { DITHER_BINS: binsDir } : {}) } : {};
    let proc: Subprocess;
    try {
      proc = Bun.spawn(argv, {
        cwd: root,
        env: {
          ...inherited,
          ...screenEnv,
          ...(kind.env ?? {}),
          DITHER_HUB_URL: this.opts.extractorUrl(),
          DITHER_ACCOUNTS_URL: this.opts.extractorUrl(),
          DITHER_ACCOUNT_ID: acc.id,
          DITHER_ADAPTER_TOKEN: acc.token,
          DITHER_ACCOUNT_DIR: acc.dir,
          DITHER_ACCOUNT_CONFIG: acc.config,
          DITHER_ACCOUNT_LABEL: acc.label,
          DITHER_MARKER_KEY: pageMarkerKey(this.store, acc.id),
          // What a later manager reads in /proc to know it as one of its own, and whether its code is still current.
          DITHER_MANAGER_DATA: this.dataDir,
          DITHER_EXTRACTOR_LAUNCH: launch,
          DITHER_EXTRACTOR_FINGERPRINT: fingerprint,
          ...(launch === 'child' ? {} : { DITHER_MANAGER_GONE_EXIT_S: String(this.opts.managerGoneExitS ?? MANAGER_GONE_EXIT_S) }),
          // Started after an app heard of a gap: what it kept from before (Discord's backfill memory) is not trusted.
          ...(this.resync.delete(id) ? { DITHER_RESYNC: '1' } : {}),
          // A wake from sleep, and why: its next run or a call comes, so it need not do what a start does (a sign-in).
          ...(this.woke.has(id) ? { DITHER_WOKE: this.woke.get(id)! } : {}),
        },
        stdin: 'ignore',
        stdout: fd,
        stderr: fd,
        detached: launch !== 'child',
        onExit: (p, code, sig) => this.exited(id, p, code, sig),
      });
    } catch (e) {
      return this.fail(id, r, `could not start: ${(e as Error).message}`);
    } finally {
      closeSync(fd);
    }
    this.woke.delete(id);
    r.proc = proc;
    r.pid = proc.pid;
    r.pstart = procStat(proc.pid)?.start;
    r.cgroup = undefined;
    r.adopted = false;
    r.survives = launch !== 'child';
    r.fingerprint = fingerprint;
    r.backend = backend;
    r.connectBy = undefined;
    // A new process: what the last one said of itself does not hold for it.
    r.sleepSaid = undefined;
    r.said = undefined;
    r.activeAt = Date.now();
    this.starting(id);
    // Its scope exists once systemd-run has made it, just before it runs the extractor.
    if (launch === 'scope') {
      const cg = () => {
        if (r.proc === proc && !r.cgroup) r.cgroup = scopeOf(proc.pid);
      };
      setTimeout(cg, 200);
      setTimeout(cg, 2000);
    }
    this.opts.onChange(id);
  }

  /** The account's connection to its extractor, made on first use (down until a start). */
  private line(id: string): Handover<Socket> {
    let h = this.lines.get(id);
    if (!h) this.lines.set(id, (h = new Handover<Socket>({ name: "the account's extractor" })));
    return h;
  }

  /** A process of the account is on its way: calls wait for it to connect (START_OPEN_MS), unless a restart already said so. */
  private starting(id: string) {
    const h = this.line(id);
    if (h.state !== 'opening') h.opening('its extractor is starting', { ms: START_OPEN_MS });
  }

  /** The calls the account's extractor had are lost with it: each fails at once ('offline'), not after its timeout. */
  private lost(id: string, why: string) {
    this.lines.get(id)?.cut(why, Infinity);
  }

  private fail(id: string, r: Running, error: string) {
    this.line(id).down(error);
    r.error = error;
    console.error(`[${id}] ${error}`);
    this.opts.onChange(id);
  }

  /** A child of this manager ended. */
  private exited(id: string, proc: Subprocess, code: number | null, sig: unknown) {
    if (this.closing) return;
    const r = this.running.get(id);
    // A stale process can exit after a restart already started its replacement: ignore it.
    if (!r || r.proc !== proc) return;
    this.ended(id, r, code, sig == null ? null : String(sig));
  }

  /** Looks at adopted processes in /proc: gone ones end as a child's would; ones that never connected start afresh. */
  private watch() {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      for (const [id, r] of this.running) {
        if (!r.adopted || !r.pid || r.stopping) continue;
        if (!procAlive(r.pid, r.pstart)) {
          const acc = this.store.account(id);
          const code = acc ? exitCodeOf(acc.dir, r.pid) : null;
          // No exit record: it never got to write one (SIGKILL, the OOM killer).
          this.ended(id, r, code, code === null ? 'killed' : null);
        } else if (!r.ws && r.connectBy && Date.now() > r.connectBy) {
          r.connectBy = undefined;
          const acc = this.store.account(id);
          if (acc) appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} the extractor taken over (pid ${r.pid}) did not connect in ${Math.round((this.opts.adoptConnectMs ?? ADOPT_CONNECT_MS) / 1000)} s: starting it afresh\n`);
          void this.restart(id);
        }
      }
    }, this.opts.watchMs ?? WATCH_MS);
  }

  private ended(id: string, r: Running, code: number | null, sig: string | null) {
    const acc = this.store.account(id);
    const log = acc ? join(acc.dir, LOG) : null;
    // Its last lines, before the manager adds its own.
    const lines = log ? linesSince(log, r.logFrom ?? 0, CRASH_LINES) : [];
    const cgroup = r.cgroup;
    r.proc = undefined;
    r.pid = undefined;
    r.pstart = undefined;
    r.cgroup = undefined;
    r.adopted = false;
    r.connectBy = undefined;
    r.sleepSaid = undefined;
    r.said = undefined;
    r.lastExit = { code, signal: sig, at: Date.now() };
    this.lost(id, `its extractor exited (code ${code}, signal ${sig})`);
    // A stop under way (a restart) decides what comes next; otherwise nothing is coming until a start.
    if (!r.stopping) this.line(id).down('its extractor exited');
    if (log) appendFileSync(log, `--- exited code=${code} signal=${sig}\n`);
    this.opts.onExit?.(id, this.asleep.has(id));
    this.opts.onChange(id);
    if (r.stopping || !acc?.enabled || this.closing) {
      if (acc) releaseLock(acc.dir);
      return;
    }
    if ((code !== null && code !== 0) || sig != null) {
      this.opts.onFailedExit?.(id, acc.kind, { code, signal: sig, stderr: lines });
      if (this.rolled.has(id)) this.rolledCrashes.set(id, (this.rolledCrashes.get(id) ?? 0) + 1);
    }
    if (Date.now() - r.lastStart > 120_000) r.restarts = 0;
    const delay = BACKOFF[Math.min(r.restarts, BACKOFF.length - 1)]!;
    r.restarts++;
    // What it started goes before the next one starts; the retry is kept in `retry`, so a stop (or the manager
    // stopping) cancels it. Set before onCrash, which must not keep it from it.
    r.cleaning = true;
    const t0 = Date.now();
    void this.endLeft(id, cgroup).finally(() => {
      r.cleaning = false;
      if (r.stopping || this.closing || this.running.get(id) !== r) return;
      r.retry = setTimeout(() => this.start(id), Math.max(0, delay * 1000 - (Date.now() - t0)));
    });
    this.opts.onCrash?.(id);
  }

  /** Stops an account's extractor on purpose (a stop, a disable, a removal): a staggered restart leaves it stopped. */
  async stop(id: string) {
    this.halted.add(id);
    this.startAfter.delete(id);
    this.woke.delete(id);
    // Stopped, not asleep: nothing wakes it but a start.
    if (this.forgetSleep(id)) this.opts.onChange(id);
    this.line(id).down('it was stopped');
    await this.stopProcess(id);
  }

  private stopProcess(id: string): Promise<void> {
    return this.serially(id, () => this.stopNow(id));
  }

  private async stopNow(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.stopping = true;
    clearTimeout(r.retry);
    // A plain stop (the manager closing): nothing is coming. A restart said `opening` before, and keeps it.
    const h = this.line(id);
    if (h.state === 'up') h.down('it is being stopped');
    for (const q of this.outdated.values()) if (q.includes(id)) q.splice(q.indexOf(id), 1);
    if (r.ws) {
      try {
        r.ws.send(JSON.stringify({ t: 'shutdown' }));
      } catch {}
    }
    if (r.pid) await this.end(id, { pid: r.pid, start: r.pstart, proc: r.proc, cgroup: r.cgroup });
    else await this.endLeft(id, r.cgroup);
    this.lost(id, 'it was stopped');
    if (this.running.get(id) === r) this.running.delete(id);
    this.history.set(id, { starts: r.starts, lastExit: r.lastExit });
    const acc = this.store.account(id);
    if (acc) releaseLock(acc.dir);
    this.opts.onExit?.(id, this.asleep.has(id));
    this.opts.onChange(id);
  }

  /**
   * The manager is going. With `leave` (a restart), extractors that outlive it (launched as `scope` or `detached`, or
   * adopted) are told so (`manager-going`: from then on they hold their events for the next manager) and left running;
   * the rest stop, as every one does without it. Says which extractors acknowledged holding their events.
   */
  async stopAll(o: { leave?: boolean } = {}): Promise<{ holding: string[] }> {
    this.closing = true;
    clearInterval(this.watcher);
    this.watcher = undefined;
    // Accounts asleep stay so in the registry: the next manager wakes them when this one would have.
    clearInterval(this.sleepTimer);
    this.sleepTimer = undefined;
    this.outdated.clear();
    for (const p of this.pauses) {
      clearTimeout(p.timer);
      p.done();
    }
    this.pauses.clear();
    this.closingCtrl.abort();
    const ids = [...this.running.keys()];
    for (const id of ids) clearTimeout(this.running.get(id)!.retry);
    // One being stopped (falling asleep, a Restart's stop) is not left: its stop is waited for below.
    const left = ids.filter((id) => o.leave && this.running.get(id)?.survives && this.running.get(id)?.pid && !this.running.get(id)?.stopping);
    const holding: string[] = [];
    if (left.length) {
      // Every frame an extractor sent before its answer has arrived by then (one socket, in order).
      await Promise.all(
        left.map((id) => {
          const ws = this.running.get(id)?.ws;
          if (!ws) return;
          return new Promise<void>((done) => {
            const timer = setTimeout(done, GOING_MS);
            this.holding.set(id, () => {
              clearTimeout(timer);
              holding.push(id);
              done();
            });
            try {
              ws.send(JSON.stringify({ t: 'manager-going' }));
            } catch {
              done();
            }
          });
        }),
      );
    }
    await Promise.all(ids.filter((id) => !left.includes(id)).map((id) => this.stopProcess(id)));
    return { holding };
  }

  /**
   * Stop and start again (the page's Restart, an extractor that never reconnected). A Stop asked for while it waits for
   * its stop wins: the account stays stopped.
   */
  async restart(id: string) {
    this.halted.delete(id);
    // Calls from now on wait for the new process; the old one's are cut when it stops (a read runs again on the new one).
    this.line(id).opening('it is restarting', { ms: START_OPEN_MS });
    await this.stopProcess(id);
    // Apps hear it went before the next one's start takes the event loop.
    await Bun.sleep(1);
    if (this.halted.has(id)) return;
    this.start(id);
  }

  /**
   * Running accounts the page's new default backend moved to another screen: restarted one at a time per kind, each
   * waited for until it is online again (or a minute), with a pause between them, kinds side by side, as a deploy's
   * are (roll). The first of each kind goes at once: someone just asked for it. One whose screen no longer differs
   * by its turn (the default moved back, or its own was set), or that was stopped meanwhile, is left as it is.
   */
  async restartMoved(ids: string[]) {
    const byKind = new Map<string, string[]>();
    for (const id of ids) {
      const kind = this.store.account(id)?.kind;
      if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
    }
    await Promise.all(
      [...byKind.values()].map(async (list) => {
        for (const [i, id] of list.entries()) {
          if (i) await this.sleep(this.opts.restartPauseMs ?? RESTART_PAUSE_MS);
          const acc = this.store.account(id);
          const r = this.running.get(id);
          if (this.closing || !acc?.enabled || !r?.pid || r.stopping || this.halted.has(id) || r.backend === this.backendOf(acc)) continue;
          appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} the manager's default display backend is now ${this.backendOf(acc)}: restarting it\n`);
          await this.restart(id);
          const end = Date.now() + (this.opts.restartOnlineMs ?? RESTART_ONLINE_MS);
          while (!this.closing && Date.now() < end && !this.running.get(id)?.ws) await Bun.sleep(250);
        }
      }),
    );
  }

  // ---------------------------------------------------------- changed code

  private queueRestart(id: string) {
    const kind = this.store.account(id)?.kind ?? '?';
    const q = this.outdated.get(kind) ?? this.outdated.set(kind, []).get(kind)!;
    if (!q.includes(id)) q.push(id);
    void this.roll(kind);
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const p = { timer: setTimeout(() => (this.pauses.delete(p), resolve()), ms), done: resolve };
      this.pauses.add(p);
    });
  }

  /**
   * Adopted extractors whose code (or display backend) changed restart one at a time per kind (a pause before each, each waited for until it
   * is online again, or a minute); different kinds go side by side. Never every account at once, and never two of one
   * network together, which is what looks like a bot to it.
   */
  private async roll(kind: string) {
    if (this.rollingKinds.has(kind)) return;
    this.rollingKinds.add(kind);
    try {
      for (;;) {
        const q = this.outdated.get(kind);
        if (!q?.length || this.closing) break;
        await this.sleep(this.opts.restartPauseMs ?? RESTART_PAUSE_MS);
        const id = q.shift();
        if (!id || this.closing) break;
        const r = this.running.get(id);
        const acc = this.store.account(id);
        const k = acc && this.kinds.get(acc.kind);
        if (!r?.adopted || !r.pid || r.stopping || !acc?.enabled || !k || this.halted.has(id)) continue;
        const sameScreen = r.backend === this.backendOf(acc);
        if (sameCode(r.fingerprint, this.fingerprintOf(k)) && sameScreen) continue;
        this.rollingNow.add(id);
        try {
          // Connected first, so it hears a shutdown and ends as it would at a stop (the watch restarts one that never does).
          const by = Date.now() + (this.opts.adoptConnectMs ?? ADOPT_CONNECT_MS);
          while (!this.closing && !r.ws && r.pid && Date.now() < by) await Bun.sleep(250);
          if (this.closing || !r.pid || this.running.get(id) !== r || this.halted.has(id)) continue;
          // Calls from now on wait for the new process, and the ones the old one has get their answers first: a
          // deploy should not fail an app's call.
          const h = this.line(id);
          h.opening(`its ${sameScreen ? 'code' : 'display backend'} changed since it started: restarting it`, { ms: START_OPEN_MS });
          await h.drain(RESTART_DRAIN_MS, this.closingCtrl.signal);
          if (this.closing || !r.pid || this.running.get(id) !== r || this.halted.has(id)) {
            // Not restarted after all: what waited goes to the process that is still there.
            if (r.ws && h.state === 'opening' && this.running.get(id) === r) h.open(r.ws);
            continue;
          }
          appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} its ${sameScreen ? 'code' : 'display backend'} changed since it started: restarting it\n`);
          await this.stopProcess(id);
          // Stopped on purpose meanwhile (the page, an app): it stays stopped.
          if (this.halted.has(id) || this.closing) continue;
          this.start(id);
          this.rolled.add(id);
          this.rolledCrashes.delete(id);
          const end = Date.now() + (this.opts.restartOnlineMs ?? RESTART_ONLINE_MS);
          while (!this.closing && Date.now() < end && !this.running.get(id)?.ws) await Bun.sleep(250);
          // Not back on the new code: the rest of its kind keep their old code (running) rather than get this too.
          if (!this.closing && !this.running.get(id)?.ws && !this.halted.has(id)) {
            const left = this.outdated.get(kind) ?? [];
            appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} not online on its new code in ${Math.round((this.opts.restartOnlineMs ?? RESTART_ONLINE_MS) / 1000)} s: the ${left.length} other ${kind} account(s) waiting keep running their old code\n`);
            this.outdated.delete(kind);
            break;
          }
        } finally {
          this.rollingNow.delete(id);
        }
      }
    } finally {
      this.rollingKinds.delete(kind);
    }
  }

  /** A call answered, failed, timed out or cut: forget it. */
  private settle(rid: string, p: Pending) {
    this.pending.delete(rid);
    clearTimeout(p.timer);
  }

  // ---------------------------------------------------------- socket

  authorize(accountId: string | null, token: string | null): string | null {
    if (!accountId || !token || this.inProcess.has(accountId)) return null;
    const acc = this.store.account(accountId);
    // A disabled account's extractor (a stray being stopped) is not let in.
    return acc && acc.enabled && acc.token === token ? acc.id : null;
  }

  attach(ws: ServerWebSocket<ExtractorSocketData>) {
    const r = this.running.get(ws.data.accountId) ?? { restarts: 0, stopping: false, lastStart: Date.now() };
    if (r.ws && r.ws !== ws) {
      try {
        r.ws.close(4000, 'replaced');
      } catch {}
    }
    r.ws = ws;
    r.onlineSince = Date.now();
    r.activeAt = Date.now();
    r.connectBy = undefined;
    this.running.set(ws.data.accountId, r);
    // The new socket is the account's connection now: what waited for it goes. Calls still out on an older socket of
    // the same process stay out: its link sends their answers on this one.
    this.line(ws.data.accountId).open(ws);
    this.sendConfig(ws.data.accountId);
    this.opts.onChange(ws.data.accountId);
  }

  /**
   * The account's config as it is now, to its extractor (the link keeps its `config` current): on connect and on change.
   * Only kinds that hold passkeys (Keep new passkeys on, docs/approver.md): chat adapters' own client would take it for
   * a command.
   */
  sendConfig(id: string) {
    const ws = this.running.get(id)?.ws;
    const acc = this.store.account(id);
    if (!ws || !acc || !this.kinds.get(acc.kind)?.passkeys) return;
    let config: unknown = {};
    try {
      config = JSON.parse(acc.config || '{}');
    } catch {}
    try {
      ws.send(JSON.stringify({ t: 'config', config }));
    } catch {}
  }

  detach(ws: ServerWebSocket<ExtractorSocketData>) {
    const id = ws.data.accountId;
    const r = this.running.get(id);
    // An older socket, replaced by a newer one of the same process: the calls it had are answered on the new one.
    if (r?.ws && r.ws !== ws) return void this.opts.onChange(id);
    if (r) r.ws = undefined;
    const h = this.line(id);
    if (r?.pid && !r.stopping && !this.closing && h.state === 'up') {
      // Its process runs: its link connects again within seconds and sends what it answered meanwhile. Calls wait.
      const why = 'its connection to the manager dropped';
      h.opening(why, {
        ms: RECONNECT_OPEN_MS,
        late: () => {
          const gone = `${why} and was not back within ${RECONNECT_OPEN_MS / 1000} s`;
          this.lost(id, gone);
          h.down(gone);
        },
      });
    } else {
      // Stopping, ended, or the manager closing: what was asked of it gets no answer now, said at once, not after the
      // call's timeout.
      this.lost(id, 'the account went offline');
    }
    this.opts.onChange(id);
  }

  receive(ws: ServerWebSocket<ExtractorSocketData>, raw: string | Buffer) {
    let ev: ExtractorEvent;
    try {
      ev = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }
    const id = ws.data.accountId;
    if (ev.t === 'holding') {
      this.holding.get(id)?.();
      this.holding.delete(id);
      return;
    }
    if (ev.t === 'resumed') {
      // A link back after its manager went: whether it held everything since (it had heard manager-going) or events
      // may have been lost on the old socket.
      const r = this.running.get(id);
      if (r) r.resumedHeld = ev.held === true;
      if (r?.adopted) this.opts.onResumed?.(id, ev.held === true);
      return;
    }
    if (ev.t === 'reply') {
      const rid = (ev.rid ?? ev.id) as string;
      const p = this.pending.get(rid);
      if (!p || p.accountId !== id) return;
      this.settle(rid, p);
      if (ev.ok) p.resolve(ev.result);
      // The extractor's own code passes only when it is not one of the manager's (it cannot say 'denied' for us). Its
      // kind and retryAfterMs pass as it said them, when they are one (spec FailureKind) and a number of ms.
      else p.reject(new ExtractorError(String(ev.error), isExtractorCode(ev.code) ? ev.code : 'failed', typeof ev.status === 'number' ? ev.status : undefined, isFailureKind(ev.kind) ? ev.kind : undefined, retryAfterOf(ev.retryAfterMs)));
      return;
    }
    if (ev.t === 'ask') {
      void this.answer(ws, ev);
      return;
    }
    if (ev.t === 'sleep') {
      // Its word on sleeping (link.sleep), for the manager only: what a stop would cut, and when it next runs by itself.
      const r = this.running.get(id);
      if (r) {
        r.sleepSaid = { busy: typeof ev.busy === 'string' && ev.busy ? ev.busy.slice(0, 200) : null, wakeAt: typeof ev.wakeAt === 'number' && Number.isFinite(ev.wakeAt) ? ev.wakeAt : null };
        r.activeAt = Date.now();
      }
      return;
    }
    if (ev.t === 'status') {
      const r = this.running.get(id);
      if (r) r.said = { status: String(ev.status ?? ''), attention: !!ev.attention };
    }
    if (ev.t === 'log') {
      // A finished span from the extractor (trace.ts): into the trace with the manager's, not its log.
      if (ev.msg === 'trace') {
        const r = spanRecordOf(ev.data);
        if (r) writeSpan({ ...r, attrs: { ...r.attrs, account: id } });
        return;
      }
      const acc = this.store.account(id);
      // Each line with its time, so a line can be put next to a trace's spans or another account's log.
      const line = `${new Date().toISOString()} [${ev.level}] ${ev.msg}${ev.data !== undefined ? ' ' + JSON.stringify(ev.data) : ''}\n`;
      if (acc) appendFileSync(join(acc.dir, 'adapter.log'), line);
      return;
    }
    this.opts.onEvent(id, ev);
  }

  /** An extractor's `ask`: for the account its socket belongs to, whatever the question says. */
  private async answer(ws: ServerWebSocket<ExtractorSocketData>, ev: ExtractorEvent) {
    if (typeof ev.aid !== 'string' || ev.aid.length > 100) return;
    const input = ev.input && typeof ev.input === 'object' && !Array.isArray(ev.input) ? (ev.input as Record<string, unknown>) : {};
    let out: Record<string, unknown>;
    try {
      if (!this.opts.onAsk || typeof ev.what !== 'string') throw new Error('the manager answers no such question');
      out = { ok: true, result: (await this.opts.onAsk(ws.data.accountId, ev.what, input)) ?? null };
    } catch (e) {
      out = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
    try {
      ws.send(JSON.stringify({ t: 'answer', aid: ev.aid, ...out }));
    } catch {}
  }

  /**
   * A call to the account's extractor, answered within `timeoutMs` in all (a wait for it to start counts). While it
   * starts, restarts or reconnects, the call waits for it (START_OPEN_MS, RECONNECT_OPEN_MS); one that could not be
   * sent fails 'retry' (503), and is safe to send again. One its extractor had when it ended fails 'offline' (it may
   * have run), unless it is `repeatable` (a read) and a new process is on its way: then it runs again there, once.
   * With no extractor running, or one stopped on purpose, a call fails at once 'offline'. One to an account asleep wakes
   * it and waits for it as for a start (WAKE_OPEN_MS).
   */
  command(accountId: string, cmd: Record<string, unknown> & { t: string }, timeoutMs = 30_000, o: { repeatable?: boolean } = {}): Promise<unknown> {
    this.wake(accountId, `a call (${String(cmd.t).slice(0, 60)})`);
    const h = this.line(accountId);
    if (!this.running.get(accountId) || h.state === 'down') return Promise.reject(new ExtractorError('the account is not connected', 'offline', undefined, 'expected'));
    const deadline = Date.now() + timeoutMs;
    return h
      .run((ws, a) => this.send(accountId, ws, cmd, deadline, timeoutMs, a.signal), { deadline, repeatable: o.repeatable })
      .catch((e) => {
        if (!(e instanceof HandoverError)) throw e;
        // 'unsure' keeps the manager's 'offline', which apps already read as "it may have run".
        throw e.code === 'retry' ? new ExtractorError(e.message, 'retry', 503, 'transient') : new ExtractorError(e.message, 'offline', undefined, 'expected');
      })
      .finally(() => {
        // Its idle time counts from its last call's answer.
        const r = this.running.get(accountId);
        if (r) r.activeAt = Date.now();
      });
  }

  // ---------------------------------------------------------- sleeping

  /**
   * How an account sleeps, or null when it does not: its kind may not (Manifest.sleep), sleeping is off, or the
   * account is to stay awake (its `stayAwake` setting).
   */
  private sleepOf(acc: Row): { idleMs: number; keepAliveMs: number | null } | null {
    const o = this.opts.sleep ?? {};
    const k = this.kinds.get(acc.kind)?.sleep;
    if (o.enabled === false || !k || this.inProcess.has(acc.id)) return null;
    try {
      if (JSON.parse(acc.config || '{}')?.stayAwake === true) return null;
    } catch {}
    const keep = k.keepAliveHours ? (o.keepAliveMs ?? k.keepAliveHours * 3_600_000) : 0;
    return { idleMs: o.idleMs ?? k.idleMinutes * 60_000, keepAliveMs: keep > 0 ? keep : null };
  }

  /**
   * Why an account that runs is not idle now (null: it is): something keeps it awake, or it cannot be told. An
   * account sleeps only once this has been null for its kind's idle time.
   */
  awakeBecause(id: string): string | null {
    const r = this.running.get(id);
    if (!r?.pid) return 'it is not running';
    if (r.stopping || r.cleaning) return 'it is being stopped';
    if (!r.ws) return 'it is starting';
    if (this.rollingNow.has(id)) return 'it is restarting for changed code';
    const h = this.lines.get(id);
    if (h && h.inFlight + h.queued > 0) return 'a call is under way';
    const held = this.holds.get(id);
    if (held?.size) return [...held.values()][0]!;
    if (!r.said) return 'it has not said how it is yet';
    if (r.said.attention) return 'it needs you';
    if (r.said.status !== 'online') return `it says it is ${r.said.status || 'not online'}`;
    if (!r.sleepSaid) return 'its extractor has not said that it may sleep';
    if (r.sleepSaid.busy) return r.sleepSaid.busy;
    const wake = r.sleepSaid.wakeAt;
    if (wake !== null && wake - (this.opts.sleep?.leadMs ?? SLEEP_LEAD_MS) - Date.now() < (this.opts.sleep?.minMs ?? SLEEP_MIN_MS)) return 'its next run is due soon';
    return null;
  }

  /**
   * For the account pane: null for an account that does not sleep; else whether it is asleep, since when and until
   * when, or while awake what keeps it so (`awake`; null: nothing, and it has been idle since `idleSince`).
   */
  sleepInfo(id: string): SleepInfoView | null {
    const acc = this.store.account(id);
    const s = acc?.enabled ? this.sleepOf(acc) : null;
    if (!s) return null;
    const idleMinutes = s.idleMs / 60_000;
    const a = this.asleep.get(id);
    if (a && !this.running.get(id)?.pid) return { asleep: true, since: a.since, wakeAt: a.wakeAt, wakeFor: a.wakeFor, idleMinutes, awake: null, idleSince: null };
    if (a) return { asleep: false, since: null, wakeAt: null, wakeFor: null, idleMinutes, awake: 'it is falling asleep', idleSince: null };
    const why = this.awakeBecause(id);
    return { asleep: false, since: null, wakeAt: null, wakeFor: null, idleMinutes, awake: why, idleSince: why === null ? (this.running.get(id)?.activeAt ?? null) : null };
  }

  /**
   * Keeps an account awake while held (its live view is open, a provider's job runs on it), waking it if it sleeps.
   * Call what it returns to let go; its idle time counts from then.
   */
  hold(id: string, why: string): () => void {
    const key = {};
    const m = this.holds.get(id) ?? this.holds.set(id, new Map()).get(id)!;
    m.set(key, why);
    this.wake(id, why);
    return () => {
      if (!m.delete(key)) return;
      if (!m.size && this.holds.get(id) === m) this.holds.delete(id);
      const r = this.running.get(id);
      if (r) r.activeAt = Date.now();
    };
  }

  /** Starts an account asleep: calls from now on wait for it (WAKE_OPEN_MS). False if it was not asleep. */
  wake(id: string, why: string): boolean {
    if (!this.asleep.has(id) || this.closing) return false;
    const acc = this.store.account(id);
    if (acc) appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} waking: ${why}\n`);
    this.woke.set(id, why.slice(0, 200));
    this.line(id).opening(`it is waking (${why})`, { ms: WAKE_OPEN_MS });
    this.start(id);
    this.opts.onChange(id);
    return true;
  }

  /**
   * Idle accounts fall asleep, and asleep ones whose time came wake. An account is idle while nothing keeps it awake
   * (awakeBecause), counted from the last time something did.
   */
  private sleepSweep() {
    if (this.closing) return;
    const now = Date.now();
    for (const [id, a] of [...this.asleep]) if (a.wakeAt !== null && now >= a.wakeAt) this.wake(id, a.wakeFor ?? 'its time came');
    for (const [id, r] of [...this.running]) {
      const acc = this.store.account(id);
      const s = acc?.enabled ? this.sleepOf(acc) : null;
      if (this.asleep.has(id)) continue;
      // One that may not sleep now (Stay awake) is not idle: once it may, its idle time counts from then.
      if (!s || this.awakeBecause(id) !== null || r.activeAt === undefined) {
        r.activeAt = now;
        continue;
      }
      if (now - r.activeAt >= s.idleMs) void this.fallAsleep(id, s).catch((e) => console.error(`[${id}] falling asleep failed: ${(e as Error).message}`));
    }
  }

  /**
   * Stops an idle account's extractor (the usual stop: shutdown, then everything it started ends), remembering it as
   * asleep until its extractor's next run less the lead, or the keep-alive, whichever comes first. A call meanwhile
   * wakes it (after the stop, if one is under way).
   */
  private async fallAsleep(id: string, s: { idleMs: number; keepAliveMs: number | null }) {
    const r = this.running.get(id);
    const acc = this.store.account(id);
    if (!r || !acc || this.asleep.has(id)) return;
    const now = Date.now();
    const own = r.sleepSaid?.wakeAt != null ? r.sleepSaid.wakeAt - (this.opts.sleep?.leadMs ?? SLEEP_LEAD_MS) : null;
    const keep = s.keepAliveMs !== null ? now + s.keepAliveMs : null;
    const wakeAt = own !== null && (keep === null || own <= keep) ? own : keep;
    const a: Asleep = { since: now, wakeAt, wakeFor: wakeAt === null ? null : wakeAt === own ? 'its next scheduled run' : 'a keep-alive' };
    this.asleep.set(id, a);
    this.store.run('INSERT INTO asleep (account, since, wake_at, wake_for) VALUES (?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET since = excluded.since, wake_at = excluded.wake_at, wake_for = excluded.wake_for', id, a.since, a.wakeAt, a.wakeFor);
    appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} idle for ${Math.round((now - (r.activeAt ?? now)) / 60_000)} min: asleep until ${wakeAt === null ? 'the next call' : `${new Date(wakeAt).toISOString()} (${a.wakeFor}) or the next call`}\n`);
    this.line(id).down('it is falling asleep');
    this.opts.onChange(id);
    await this.stopProcess(id);
  }

  /** It is not asleep (any more): forgotten here and in the registry. True if it was. */
  private forgetSleep(id: string): boolean {
    if (!this.asleep.delete(id)) return false;
    this.store.run('DELETE FROM asleep WHERE account = ?', id);
    return true;
  }

  private send(accountId: string, ws: Socket, cmd: Record<string, unknown> & { t: string }, deadline: number, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) this.settle(id, p);
        reject(new ExtractorError(`no answer to ${cmd.t} in ${Math.round(timeoutMs / 1000)} s`, 'timeout', undefined, 'transient'));
      }, Math.max(1, deadline - Date.now()));
      this.pending.set(id, { resolve, reject, timer, accountId });
      // Cut (its process ended, its socket did not come back): the handover has refused it already.
      signal.addEventListener(
        'abort',
        () => {
          const p = this.pending.get(id);
          if (p) this.settle(id, p);
        },
        { once: true },
      );
      // The call's own id travels as `rid`, so an op input named `id` (mail.get, cal.delete…) reaches the extractor
      // as it was sent. Inputs without one also get it as `id`, which chat adapters (dither-chat's protocol) answer by.
      // 0: dropped, the socket is closing (its close is on its way): never sent.
      if (ws.send(JSON.stringify({ ...cmd, ...(cmd.id === undefined ? { id } : {}), rid: id })) === 0) {
        this.settle(id, this.pending.get(id)!);
        reject(new HandoverError("the account's extractor's socket was closing, so this was not sent", 'retry', 0));
      }
    });
  }
}

/**
 * A process and everything it started (Chromium and its helpers, Xvfb, signal-cli, the WhatsApp bridge), grouped by
 * name with their memory, from /proc. Only names, counts and sizes.
 */
export function processTree(root: number): { name: string; pids: number[]; rssBytes: number }[] {
  const children = new Map<number, number[]>();
  const info = new Map<number, { name: string; rss: number }>();
  let pids: number[] = [];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
  } catch {
    return [];
  }
  const page = 4096;
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // pid (comm) state ppid …, and comm may hold spaces and parentheses.
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const rest = stat.slice(close + 2).split(' ');
      const ppid = Number(rest[1]);
      const rss = Number(rest[21]) * page;
      info.set(pid, { name, rss });
      (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(pid);
    } catch {}
  }
  const groups = new Map<string, { name: string; pids: number[]; rssBytes: number }>();
  const visit = (pid: number, depth: number) => {
    const i = info.get(pid);
    if (!i || depth > 12) return;
    const g = groups.get(i.name) ?? groups.set(i.name, { name: i.name, pids: [], rssBytes: 0 }).get(i.name)!;
    g.pids.push(pid);
    g.rssBytes += i.rss;
    for (const c of children.get(pid) ?? []) visit(c, depth + 1);
  };
  visit(root, 0);
  return [...groups.values()];
}

/** A new account's directory under the manager's data dir. */
export function accountDir(dataDir: string, id: string): string {
  const d = join(dataDir, 'accounts', id);
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function writeSecret(acc: Row, secret: unknown) {
  if (!existsSync(acc.dir)) mkdirSync(acc.dir, { recursive: true, mode: 0o700 });
  // Whole or not at all, with the last good copy kept (chat-protocol secret-file.ts).
  writeSecretFile(join(acc.dir, 'secret.json'), secret ?? {});
}
