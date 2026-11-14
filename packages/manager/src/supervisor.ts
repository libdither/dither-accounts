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
import { fingerprintEntry } from './fingerprint.ts';
import { LOG } from './files.ts';
import type { Kind } from './kinds.ts';
import { procAlive, procCmdline, procEnv, procStartedAt, procStat } from './procs.ts';
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

/** `auto`: `scope` when the manager runs as a systemd service and `systemd-run --user --scope` works, else `child`. */
export function chooseLaunch(want: Launch | 'auto'): Launch {
  if (want !== 'auto') return want;
  if (!process.env.INVOCATION_ID) return 'child';
  try {
    const r = Bun.spawnSync(['systemd-run', '--user', '--scope', '--quiet', '--collect', 'true'], { stdout: 'ignore', stderr: 'ignore', timeout: 10_000 });
    return r.exitCode === 0 ? 'scope' : 'child';
  } catch {
    return 'child';
  }
}

interface Running {
  retry?: Timer;
  /** Its process, when this manager started it (its exit code comes from here). */
  proc?: Subprocess;
  /** The process that runs the account, started here or adopted, and when it started (procs.ts): a reused pid is not it. */
  pid?: number;
  pstart?: string;
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

type Pending = { resolve: (v: unknown) => void; reject: (e: ExtractorError) => void; timer: Timer };

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
/** Between two restarts for changed code, and before the first. */
const RESTART_PAUSE_MS = 20_000;
/** An extractor that outlives its manager ends itself after this long without one (its link, DITHER_MANAGER_GONE_EXIT_S). */
const MANAGER_GONE_EXIT_S = 1800;

/** An extractor's own process, not what it started (Chromium, signal-cli, the WhatsApp bridge inherit its environment). */
const isExtractorCmd = (pid: number) => procCmdline(pid).some((a) => a.endsWith('/src/main.ts'));

/**
 * Processes on this machine that run an account: any live process with DITHER_ACCOUNT_ID=<id> in its environment,
 * whoever started it (a hub that predates the lock, an orphan of a crashed supervisor). Not our own children.
 */
export function accountProcesses(accountId: string, except: number[] = []): number[] {
  const out: number[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  const needle = `DITHER_ACCOUNT_ID=${accountId}`;
  for (const d of pids) {
    const pid = Number(d);
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

/** Signal `pid` only while it is still the process that started at `start`. */
function signal(pid: number, start: string | undefined, sig: NodeJS.Signals): boolean {
  if (!procAlive(pid, start)) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM, then SIGKILL after `graceMs`; resolves once it is gone (or it would not go). */
async function terminate(pid: number, start: string | undefined, proc?: Subprocess, graceMs = 8000): Promise<void> {
  if (!signal(pid, start, 'SIGTERM')) return;
  const gone = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (proc ? proc.exitCode !== null || proc.signalCode !== null : !procAlive(pid, start)) return true;
      await (proc ? Promise.race([proc.exited, Bun.sleep(100)]) : Bun.sleep(100));
    }
    return false;
  };
  if (await gone(graceMs)) return;
  signal(pid, start, 'SIGKILL');
  await gone(3000);
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
  /** Adopted accounts whose code changed, restarted one at a time. */
  private outdated: string[] = [];
  private rolling = false;
  private scan?: { at: number; found: Found[] };
  private pause?: { timer: Timer; done: () => void };
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
      /** The fingerprint of a kind's code (default fingerprint.ts over repoRoot); tests give their own. */
      fingerprint?: (kind: Kind) => string;
      /** Between restarts for changed code (default 20 s). */
      restartPauseMs?: number;
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

  /** The fingerprint of the code a kind's extractor would run if started now. */
  fingerprintOf(kind: Kind): string {
    if (this.opts.fingerprint) return this.opts.fingerprint(kind);
    try {
      return fingerprintEntry(this.opts.repoRoot, join(kind.dir, kind.entry)).hash;
    } catch (e) {
      return `unknown: ${(e as Error).message}`.slice(0, 100);
    }
  }

  /**
   * Every enabled account's extractor: an earlier manager's still running is adopted, the rest start. Extractors an
   * earlier manager left running for accounts that are now disabled or gone are stopped.
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
    const found = this.lookInProc(mine);
    this.scan = { at: Date.now(), found };
    return found;
  }

  private lookInProc(mine: Set<number | undefined>): Found[] {
    const out: Found[] = [];
    let pids: number[] = [];
    try {
      pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
    } catch {
      return out;
    }
    for (const pid of pids) {
      if (pid === process.pid || mine.has(pid)) continue;
      const env = procEnv(pid);
      if (!env || env.DITHER_MANAGER_DATA !== this.dataDir || !env.DITHER_EXTRACTOR_LAUNCH || !env.DITHER_ACCOUNT_ID) continue;
      if (!isExtractorCmd(pid)) continue;
      const st = procStat(pid);
      if (!st || st.state === 'Z') continue;
      out.push({ pid, start: st.start, accountId: env.DITHER_ACCOUNT_ID, token: env.DITHER_ADAPTER_TOKEN ?? '', fingerprint: env.DITHER_EXTRACTOR_FINGERPRINT ?? '' });
    }
    return out;
  }

  /** Strays: an earlier manager's extractors whose account is disabled or gone (or whose token is not the account's). */
  private sweep() {
    for (const f of this.found()) {
      const acc = this.store.account(f.accountId);
      if (acc?.enabled && acc.token === f.token && !this.inProcess.has(acc.id)) continue;
      console.error(`[${f.accountId}] stopping pid ${f.pid}, left running by an earlier manager: its account is ${acc ? (acc.enabled ? 'started another way' : 'disabled') : 'gone'}`);
      if (acc) appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} dither-accounts stopping pid ${f.pid}, left running by an earlier manager (the account is ${acc.enabled ? 'not its' : 'disabled'})\n`);
      void terminate(f.pid, f.start);
    }
  }

  start(id: string) {
    if (this.inProcess.has(id) || this.closing) return;
    const acc = this.store.account(id);
    if (!acc || !acc.enabled) return;
    const cur = this.running.get(id);
    if (cur && !cur.stopping && cur.pid) return;
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
      for (const m of more) void terminate(m.pid, m.start);
      acquireLock(acc.dir, 'dither-accounts', acc.id, found.map((x) => x.pid));
      r.proc = undefined;
      r.pid = f!.pid;
      r.pstart = f!.start;
      r.adopted = true;
      r.survives = true;
      r.fingerprint = f!.fingerprint;
      r.lastStart = procStartedAt(f!.start) ?? Date.now();
      r.connectBy = r.ws ? undefined : Date.now() + ADOPT_CONNECT_MS;
      const now = this.fingerprintOf(kind);
      appendFileSync(log, `--- ${new Date().toISOString()} dither-accounts took over the running ${acc.kind} extractor (pid ${f!.pid})${f!.fingerprint === now ? '' : '; its code changed, so it restarts soon'}\n`);
      r.logFrom = fileSize(log);
      this.watch();
      if (f!.fingerprint !== now) this.queueRestart(id);
      this.opts.onChange(id);
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
    const argv = launch === 'scope' ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${scopeName(acc.id)}`, `--description=dither-accounts extractor (${acc.kind})`, 'bun', entry] : ['bun', entry];
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
          ...(launch === 'child' ? {} : { DITHER_MANAGER_GONE_EXIT_S: String(MANAGER_GONE_EXIT_S) }),
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
    r.adopted = false;
    r.survives = launch !== 'child';
    r.fingerprint = fingerprint;
    r.connectBy = undefined;
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
          this.ended(id, r, code, null);
        } else if (!r.ws && r.connectBy && Date.now() > r.connectBy) {
          r.connectBy = undefined;
          const acc = this.store.account(id);
          if (acc) appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} the extractor taken over (pid ${r.pid}) did not connect in ${ADOPT_CONNECT_MS / 1000} s: starting it afresh\n`);
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
    r.proc = undefined;
    r.pid = undefined;
    r.pstart = undefined;
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
    if ((code !== null && code !== 0) || sig != null) this.opts.onFailedExit?.(id, acc.kind, { code, signal: sig, stderr: lines });
    if (Date.now() - r.lastStart > 120_000) r.restarts = 0;
    const delay = BACKOFF[Math.min(r.restarts, BACKOFF.length - 1)];
    r.restarts++;
    // Kept in retry, so a stop (or the manager stopping) cancels it; set before onCrash, which must not keep it from it.
    r.retry = setTimeout(() => this.start(id), delay * 1000);
    this.opts.onCrash?.(id);
  }

  async stop(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.stopping = true;
    clearTimeout(r.retry);
    this.outdated = this.outdated.filter((x) => x !== id);
    if (r.ws) {
      try {
        r.ws.send(JSON.stringify({ t: 'shutdown' }));
      } catch {}
    }
    if (r.pid) await terminate(r.pid, r.pstart, r.proc);
    this.running.delete(id);
    this.history.set(id, { starts: r.starts, lastExit: r.lastExit });
    const acc = this.store.account(id);
    if (acc) releaseLock(acc.dir);
    this.opts.onExit?.(id);
    this.opts.onChange(id);
  }

  /**
   * The manager is going. Extractors that outlive it (launched as `scope` or `detached`, or adopted) are left running
   * for the next manager to adopt when `leave`; the rest stop, as every one does without it.
   */
  async stopAll(o: { leave?: boolean } = {}) {
    this.closing = true;
    clearInterval(this.watcher);
    this.watcher = undefined;
    this.outdated = [];
    if (this.pause) {
      clearTimeout(this.pause.timer);
      this.pause.done();
    }
    const ids = [...this.running.keys()];
    for (const id of ids) clearTimeout(this.running.get(id)!.retry);
    await Promise.all(ids.filter((id) => !(o.leave && this.running.get(id)?.survives)).map((id) => this.stop(id)));
  }

  async restart(id: string) {
    await this.stop(id);
    this.start(id);
  }

  // ---------------------------------------------------------- changed code

  private queueRestart(id: string) {
    if (!this.outdated.includes(id)) this.outdated.push(id);
    void this.roll();
  }

  private sleep(ms: number) {
    return new Promise<void>((done) => {
      this.pause = { timer: setTimeout(done, ms), done };
    });
  }

  /**
   * Adopted extractors whose code changed restart one at a time, a pause before each, each waited for until it is
   * online again (or a minute), so a deploy never restarts every account at once.
   */
  private async roll() {
    if (this.rolling) return;
    this.rolling = true;
    try {
      while (this.outdated.length && !this.closing) {
        await this.sleep(this.opts.restartPauseMs ?? RESTART_PAUSE_MS);
        const id = this.outdated.shift();
        if (!id || this.closing) break;
        const r = this.running.get(id);
        const acc = this.store.account(id);
        const kind = acc && this.kinds.get(acc.kind);
        if (!r?.adopted || !r.pid || r.stopping || !acc?.enabled || !kind) continue;
        const now = this.fingerprintOf(kind);
        if (r.fingerprint === now) continue;
        // Connected first, so it hears a shutdown and ends as it would at a stop (the watch restarts one that never does).
        const by = Date.now() + ADOPT_CONNECT_MS;
        while (!this.closing && !r.ws && r.pid && Date.now() < by) await Bun.sleep(250);
        if (this.closing || !r.pid || this.running.get(id) !== r) continue;
        appendFileSync(join(acc.dir, LOG), `--- ${new Date().toISOString()} its code changed since it started: restarting it\n`);
        await this.restart(id);
        const end = Date.now() + 60_000;
        while (!this.closing && Date.now() < end && !this.running.get(id)?.ws) await Bun.sleep(250);
      }
    } finally {
      this.rolling = false;
    }
  }

  // ---------------------------------------------------------- socket

  authorize(accountId: string | null, token: string | null): string | null {
    if (!accountId || !token || this.inProcess.has(accountId)) return null;
    const acc = this.store.account(accountId);
    return acc && acc.token === token ? acc.id : null;
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
      if (!r?.ws) return reject(new ExtractorError('the account is not connected', 'offline'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ExtractorError(`no answer to ${cmd.t} in ${Math.round(timeoutMs / 1000)} s`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
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
