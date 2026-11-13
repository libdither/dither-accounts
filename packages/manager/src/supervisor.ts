/**
 * Runs one extractor process per enabled account (dither-chat's adapter supervisor, moved here) and talks to it over
 * the /extractor socket: commands out with an id, replies and events back. An extractor may also ask the manager itself
 * (`ask`, answered by `onAsk` for that socket's account only: the approver's requests, docs/approver.md).
 *
 * One process per account, ever: a lock file in the account's directory names the process that runs its session.
 * dither-chat's hub takes the same lock for the accounts it still runs itself, so an account moved here cannot also
 * be started there (two Signal or WhatsApp sessions on one store corrupt it).
 */
import type { ServerWebSocket, Subprocess } from 'bun';
import { createHmac } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecretFile } from '@dither-chat/protocol/secret-file';
import { isExtractorCode } from '@dither-accounts/spec';
import type { Row, Store } from './db.ts';
import type { Kind } from './kinds.ts';
import { spanRecordOf, writeSpan } from './trace.ts';

export interface ExtractorSocketData {
  kind: 'extractor';
  accountId: string;
}

export type ExtractorEvent = { t: string; [k: string]: unknown };

interface Running {
  retry?: Timer;
  proc?: Subprocess;
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
  /** The last lines its process wrote to stderr (STDERR_LINES), for the error file when it crashes. */
  stderr?: string[];
  /** Its stderr read to the end. */
  stderrDone?: Promise<void>;
}

/** How many of an extractor's last stderr lines are kept for a crash record. */
const STDERR_LINES = 60;

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
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some((a) => a.endsWith('/src/main.ts'))) out.push(pid);
    } catch {}
  }
  return out;
}

/**
 * Take an account directory's lock, or say who holds it. A lock whose process is gone is stale and taken over. With
 * `accountId`, a live process already running that account (lock or not) also holds it.
 */
export function acquireLock(dir: string, owner: string, accountId?: string): string | null {
  if (accountId) {
    const running = accountProcesses(accountId);
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

/**
 * The key an account's extractor makes the names its browser extension leaves in pages from (DITHER_MARKER_KEY,
 * packages/browser/src/markers.ts): HMAC of this install's own random secret (kv `page-markers`, made once) and the
 * account's id. So no two installs, and no two accounts of one install, show a site the same names, and an account's
 * names stay the same from one start to the next. The secret itself never leaves the manager.
 */
export function pageMarkerKey(store: Store, accountId: string): string {
  return createHmac('sha256', store.installValue('page-markers')).update(accountId).digest('base64url');
}

export class Supervisor {
  private running = new Map<string, Running>();
  /** What a stop forgets but the account pane still shows: how often it started, how it last ended. */
  private history = new Map<string, Pick<Running, 'starts' | 'lastExit'>>();
  private pending = new Map<string, Pending>();
  /** Accounts the manager answers itself (the built-in `notices`): never started, always online. */
  readonly inProcess = new Set<string>();

  constructor(
    private store: Store,
    private kinds: Map<string, Kind>,
    private opts: {
      /** ws://127.0.0.1:<port>/extractor, once the server listens. */
      extractorUrl: () => string;
      repoRoot: string;
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
       * it wrote to stderr: the manager's error file (errors.ts) records its last error.
       */
      onFailedExit?: (accountId: string, kind: string, exit: { code: number | null; signal: string | null; stderr: string[] }) => void;
      /** A question from an account's extractor to the manager (`what`, its input); throw to refuse. */
      onAsk?: (accountId: string, what: string, input: Record<string, unknown>) => Promise<unknown>;
    },
  ) {}

  state(id: string) {
    if (this.inProcess.has(id)) return { running: true, online: true, error: null };
    const r = this.running.get(id);
    return { running: !!r?.proc, online: !!r?.ws, error: r?.error ?? null };
  }

  /** The process side of an account, for the account pane. */
  details(id: string) {
    const r = this.running.get(id);
    return {
      pid: r?.proc?.pid ?? null,
      tree: r?.proc?.pid ? processTree(r.proc.pid) : [],
      startedAt: r?.proc ? r.lastStart : null,
      onlineSince: r?.ws ? (r.onlineSince ?? null) : null,
      starts: r?.starts ?? 0,
      lastExit: r?.lastExit ?? null,
    };
  }

  startAll() {
    for (const a of this.store.accounts()) if (a.enabled) this.start(a.id);
  }

  start(id: string) {
    if (this.inProcess.has(id)) return;
    const acc = this.store.account(id);
    if (!acc || !acc.enabled) return;
    const cur = this.running.get(id);
    if (cur && !cur.stopping && cur.proc) return;
    const r: Running = cur ?? { restarts: 0, stopping: false, lastStart: 0, ...this.history.get(id) };
    clearTimeout(r.retry);
    r.stopping = false;
    r.lastStart = Date.now();
    r.error = undefined;
    r.starts = (r.starts ?? 0) + 1;
    this.running.set(id, r);
    const kind = this.kinds.get(acc.kind);
    if (!kind) return this.fail(id, r, `no extractor for kind "${acc.kind}"`);
    if (!existsSync(acc.dir)) mkdirSync(acc.dir, { recursive: true, mode: 0o700 });
    const held = acquireLock(acc.dir, 'dither-accounts', acc.id);
    if (held) {
      // Another process runs it (dither-chat's hub, before it lets go): look again, and take over once it is gone.
      r.retry = setTimeout(() => this.start(id), LOCK_RETRY_MS);
      return this.fail(id, r, held);
    }

    const log = join(acc.dir, 'adapter.log');
    appendFileSync(log, `\n--- ${new Date().toISOString()} dither-accounts starting ${acc.kind} extractor\n`);
    const proc = Bun.spawn(['bun', join(kind.dir, kind.entry)], {
      cwd: this.opts.repoRoot,
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
      },
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (p, code, signal) => this.exited(id, p, code, signal),
    });
    r.proc = proc;
    const tail: string[] = (r.stderr = []);
    for (const stream of [proc.stdout, proc.stderr]) {
      const isErr = stream === proc.stderr;
      const decoder = new TextDecoder();
      let partial = '';
      const done = (async () => {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          appendFileSync(log, value);
          if (isErr) {
            const lines = (partial + decoder.decode(value, { stream: true })).split('\n');
            partial = lines.pop() ?? '';
            tail.push(...lines);
            if (tail.length > STDERR_LINES) tail.splice(0, tail.length - STDERR_LINES);
          }
        }
        if (isErr && partial) tail.push(partial);
      })().catch(() => {});
      if (isErr) r.stderrDone = done;
    }
    this.opts.onChange(id);
  }

  private fail(id: string, r: Running, error: string) {
    r.error = error;
    console.error(`[${id}] ${error}`);
    this.opts.onChange(id);
  }

  private exited(id: string, proc: Subprocess, code: number | null, signal: unknown) {
    const r = this.running.get(id);
    // A stale process can exit after a restart already started its replacement: ignore it.
    if (!r || (r.proc && r.proc !== proc)) return;
    r.proc = undefined;
    r.lastExit = { code, signal: signal == null ? null : String(signal), at: Date.now() };
    const acc = this.store.account(id);
    if (acc) appendFileSync(join(acc.dir, 'adapter.log'), `--- exited code=${code} signal=${signal}\n`);
    this.opts.onExit?.(id);
    this.opts.onChange(id);
    if (r.stopping || !acc?.enabled) {
      if (acc) releaseLock(acc.dir);
      return;
    }
    if ((code !== null && code !== 0) || signal != null) {
      const stderr = r.stderr ?? [];
      const kind = acc.kind;
      const exit = { code, signal: signal == null ? null : String(signal) };
      // Its stderr can still be draining when the exit is reported.
      void Promise.race([r.stderrDone ?? Promise.resolve(), Bun.sleep(1000)]).then(() => this.opts.onFailedExit?.(id, kind, { ...exit, stderr: [...stderr] }));
    }
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
    if (r.ws) {
      try {
        r.ws.send(JSON.stringify({ t: 'shutdown' }));
      } catch {}
    }
    if (r.proc) {
      const p = r.proc;
      const killer = setTimeout(() => p.kill('SIGKILL'), 8000);
      p.kill('SIGTERM');
      await p.exited.catch(() => {});
      clearTimeout(killer);
    }
    this.running.delete(id);
    this.history.set(id, { starts: r.starts, lastExit: r.lastExit });
    const acc = this.store.account(id);
    if (acc) releaseLock(acc.dir);
    this.opts.onExit?.(id);
    this.opts.onChange(id);
  }

  async stopAll() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  async restart(id: string) {
    await this.stop(id);
    this.start(id);
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
