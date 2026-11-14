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
 */
import type { ServerWebSocket, Subprocess } from 'bun';
import { createHmac } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecretFile } from '@dither-chat/protocol/secret-file';
import { isExtractorCode } from '@dither-accounts/spec';
import type { Row, Store } from './db.ts';
import { fingerprintEntry, sameCode } from './fingerprint.ts';
import { LOG } from './files.ts';
import type { Kind } from './kinds.ts';
import { allPids, cgroupMembers, cgroupOf, descendants, endAll, groupMembers, ownService, procAlive, procCmdline, procEnv, type ProcRef, procsWithEnv, procStartedAt, procStat, signalRef } from './procs.ts';
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
export function chooseLaunch(want: Launch | 'auto', o: { service?: () => string | null; probe?: () => boolean } = {}): { launch: Launch; unit: string | null } {
  const unit = (o.service ?? ownService)();
  if (want !== 'auto') return { launch: want, unit };
  if (!unit) return { launch: 'child', unit };
  const probe =
    o.probe ??
    (() => {
      try {
        return Bun.spawnSync(['systemd-run', '--user', '--scope', '--quiet', '--collect', 'true'], { stdout: 'ignore', stderr: 'ignore', timeout: 10_000 }).exitCode === 0;
      } catch {
        return false;
      }
    });
  return { launch: probe() ? 'scope' : 'child', unit };
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
}

/** How many of an extractor's last log lines are kept for a crash record. */
const CRASH_LINES = 60;

type Pending = { resolve: (v: unknown) => void; reject: (e: ExtractorError) => void; timer: Timer; ws: ServerWebSocket<ExtractorSocketData> };

export class ExtractorError extends Error {
  constructor(
    message: string,
    /** The manager's offline, timeout or failed; or the extractor's own word for a refusal (spec isExtractorCode). */
    readonly code: 'offline' | 'timeout' | 'failed' | (string & {}),
    readonly status?: number,
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
/** An extractor that outlives its manager ends itself after this long without one (its link, DITHER_MANAGER_GONE_EXIT_S). */
const MANAGER_GONE_EXIT_S = 1800;
/** How long a going manager waits for its extractors to say they hold their events. */
const GOING_MS = 5000;
/** A scope the supervisor made: only such a control group is ever emptied (never the manager's own). */
const OUR_SCOPE = /\/dither-accounts-x-[^/]+\.scope$/;

/** An extractor's own process, not what it started (Chromium, signal-cli, the WhatsApp bridge inherit its environment). */
const isExtractorCmd = (pid: number) => procCmdline(pid).some((a) => a.endsWith('/src/main.ts'));

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
  /** The manager is going: nothing starts again, and exits of processes it leaves running are not crashes. */
  private closing = false;

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
      /** Seconds an extractor that outlives the manager waits for one before it ends itself (default 1800). */
      managerGoneExitS?: number;
      /** Events (not replies or logs) from an account's extractor. */
      onEvent: (accountId: string, ev: ExtractorEvent) => void;
      /** Running or online changed. */
      onChange: (accountId: string) => void;
      /** An extractor process ended: what it last said of itself (its status) no longer holds. */
      onExit?: (accountId: string) => void;
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
  }

  state(id: string) {
    if (this.inProcess.has(id)) return { running: true, online: true, error: null };
    const r = this.running.get(id);
    return { running: !!r?.pid, online: !!r?.ws, error: r?.error ?? null };
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
   */
  startAll() {
    this.sweep();
    for (const a of this.store.accounts()) if (a.enabled) this.start(a.id);
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
      found.push({ pid, start: st.start, accountId: env.DITHER_ACCOUNT_ID, token: env.DITHER_ADAPTER_TOKEN ?? '', fingerprint: env.DITHER_EXTRACTOR_FINGERPRINT ?? '' });
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
    // A stop of it is under way: this start follows it.
    if (this.stops.has(id)) {
      this.startAfter.add(id);
      return;
    }
    const acc = this.store.account(id);
    if (!acc || !acc.enabled) return;
    const cur = this.running.get(id);
    if (cur && !cur.stopping && (cur.pid || cur.cleaning)) return;
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
      r.proc = undefined;
      r.pid = f!.pid;
      r.pstart = f!.start;
      r.cgroup = scopeOf(f!.pid);
      r.adopted = true;
      r.survives = true;
      r.fingerprint = f!.fingerprint;
      r.lastStart = procStartedAt(f!.start) ?? Date.now();
      r.connectBy = r.ws ? undefined : Date.now() + (this.opts.adoptConnectMs ?? ADOPT_CONNECT_MS);
      const changed = !sameCode(f!.fingerprint, this.fingerprintOf(kind));
      appendFileSync(log, `--- ${new Date().toISOString()} dither-accounts took over the running ${acc.kind} extractor (pid ${f!.pid})${changed ? '; its code changed, so it restarts soon' : ''}\n`);
      r.logFrom = fileSize(log);
      this.watch();
      if (changed) this.queueRestart(id);
      // Back already (it connected before startAll got to it): what it said on its return counts now.
      if (r.resumedHeld !== undefined) this.opts.onResumed?.(id, r.resumedHeld);
      this.opts.onChange(id);
      return;
    }

    // What an earlier process of this account left (a browser, signal-cli) goes first: never two sessions on one store.
    // (Not right after this manager ended what the last one left: that look at every process's environment is slow.)
    const left = Date.now() - (this.cleanedAt.get(id) ?? 0) < 2000 ? [] : this.leftovers(id);
    if (left.length) {
      r.cleaning = true;
      void this.endLeft(id, undefined, left).finally(() => {
        r.cleaning = false;
        if (this.running.get(id) === r && !r.stopping) this.start(id);
      });
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
    const launch = this.launch;
    appendFileSync(log, `\n--- ${new Date().toISOString()} dither-accounts starting ${acc.kind} extractor\n`);
    r.logFrom = fileSize(log);
    const argv = launch === 'scope' ? [this.opts.systemdRun ?? 'systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${scopeName(acc.id)}`, `--description=dither-accounts extractor (${acc.kind})`, 'bun', entry] : ['bun', entry];
    // Its output straight to its log: the manager going away cannot break a pipe under it.
    const fd = openSync(log, 'a', 0o600);
    let proc: Subprocess;
    try {
      proc = Bun.spawn(argv, {
        cwd: root,
        env: {
          ...process.env,
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
    r.proc = proc;
    r.pid = proc.pid;
    r.pstart = procStat(proc.pid)?.start;
    r.cgroup = undefined;
    r.adopted = false;
    r.survives = launch !== 'child';
    r.fingerprint = fingerprint;
    r.connectBy = undefined;
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

  private fail(id: string, r: Running, error: string) {
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
    }, WATCH_MS);
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
    r.lastExit = { code, signal: sig, at: Date.now() };
    if (log) appendFileSync(log, `--- exited code=${code} signal=${sig}\n`);
    this.opts.onExit?.(id);
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
    for (const q of this.outdated.values()) if (q.includes(id)) q.splice(q.indexOf(id), 1);
    if (r.ws) {
      try {
        r.ws.send(JSON.stringify({ t: 'shutdown' }));
      } catch {}
    }
    if (r.pid) await this.end(id, { pid: r.pid, start: r.pstart, proc: r.proc, cgroup: r.cgroup });
    else await this.endLeft(id, r.cgroup);
    if (this.running.get(id) === r) this.running.delete(id);
    this.history.set(id, { starts: r.starts, lastExit: r.lastExit });
    const acc = this.store.account(id);
    if (acc) releaseLock(acc.dir);
    this.opts.onExit?.(id);
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
    this.outdated.clear();
    for (const p of this.pauses) {
      clearTimeout(p.timer);
      p.done();
    }
    this.pauses.clear();
    const ids = [...this.running.keys()];
    for (const id of ids) clearTimeout(this.running.get(id)!.retry);
    const left = ids.filter((id) => o.leave && this.running.get(id)?.survives && this.running.get(id)?.pid);
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
    await this.stopProcess(id);
    // Apps hear it went before the next one's start takes the event loop.
    await Bun.sleep(1);
    if (this.halted.has(id)) return;
    this.start(id);
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
   * Adopted extractors whose code changed restart one at a time per kind (a pause before each, each waited for until it
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
        if (sameCode(r.fingerprint, this.fingerprintOf(k))) continue;
        this.rollingNow.add(id);
        try {
          // Connected first, so it hears a shutdown and ends as it would at a stop (the watch restarts one that never does).
          const by = Date.now() + (this.opts.adoptConnectMs ?? ADOPT_CONNECT_MS);
          while (!this.closing && !r.ws && r.pid && Date.now() < by) await Bun.sleep(250);
          if (this.closing || !r.pid || this.running.get(id) !== r || this.halted.has(id)) continue;
          appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} its code changed since it started: restarting it\n`);
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
    r.connectBy = undefined;
    this.running.set(ws.data.accountId, r);
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
    const r = this.running.get(ws.data.accountId);
    if (r?.ws === ws) r.ws = undefined;
    // What was asked of it on that socket gets no answer now: said at once, not after the call's timeout.
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new ExtractorError('the account went offline', 'offline'));
    }
    this.opts.onChange(ws.data.accountId);
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
      if (!p) return;
      this.pending.delete(rid);
      clearTimeout(p.timer);
      if (ev.ok) p.resolve(ev.result);
      // The extractor's own code passes only when it is not one of the manager's (it cannot say 'denied' for us).
      else p.reject(new ExtractorError(String(ev.error), isExtractorCode(ev.code) ? ev.code : 'failed', typeof ev.status === 'number' ? ev.status : undefined));
      return;
    }
    if (ev.t === 'ask') {
      void this.answer(ws, ev);
      return;
    }
    if (ev.t === 'log') {
      // A finished span from the extractor (trace.ts): into the trace with the manager's, not its log.
      if (ev.msg === 'trace') {
        const r = spanRecordOf(ev.data);
        if (r) writeSpan({ ...r, attrs: { ...r.attrs, account: id } });
        return;
      }
      const acc = this.store.account(id);
      const line = `[${ev.level}] ${ev.msg}${ev.data !== undefined ? ' ' + JSON.stringify(ev.data) : ''}\n`;
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

  command(accountId: string, cmd: Record<string, unknown> & { t: string }, timeoutMs = 30_000): Promise<unknown> {
    const r = this.running.get(accountId);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      // Not connected, or being stopped (it heard `shutdown`): it would never answer.
      if (!r?.ws || r.stopping) return reject(new ExtractorError('the account is not connected', 'offline'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ExtractorError(`no answer to ${cmd.t} in ${Math.round(timeoutMs / 1000)} s`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, ws: r.ws });
      // The call's own id travels as `rid`, so an op input named `id` (mail.get, cal.delete…) reaches the extractor
      // as it was sent. Inputs without one also get it as `id`, which chat adapters (dither-chat's protocol) answer by.
      r.ws.send(JSON.stringify({ ...cmd, ...(cmd.id === undefined ? { id } : {}), rid: id }));
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
