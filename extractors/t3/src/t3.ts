/**
 * How the t3 extractor reaches T3 Code on this machine (docs/t3.md):
 *
 * - **The command line** (`t3`): `t3 auth session issue` makes the two read-only sessions this extractor holds, and
 *   `t3 thread send` sends a turn (it signs in for that one call, at the owner's own access, and signs out).
 * - **The MCP endpoint** (`POST <origin>/mcp`, JSON-RPC, a session whose subject is `mcp-client`): the tools the CLI
 *   itself calls, `t3_project_list` and `t3_thread_read`, plus `t3_thread_list` when the stream below is not there.
 * - **The shell stream** (`<origin>/ws`, Effect RPC frames in JSON, a plain bearer session that mints a one-use
 *   ticket): `orchestration.subscribeShell`, the app's own sidebar feed: a snapshot of the active threads, then each
 *   thread's summary as it changes.
 *
 * The origin is in `<base dir>/userdata/server-runtime.json`, which the running server writes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------- where things are

/** The t3 command as argv: config `t3`, else $T3_BIN (may carry arguments), else `t3` on PATH, else the per-user Nix profile's. */
export function findBin(config: { t3?: unknown }, env: Record<string, string | undefined> = process.env): string[] | null {
  if (typeof config.t3 === 'string' && config.t3.trim()) return [config.t3.trim()];
  if (env.T3_BIN?.trim()) return env.T3_BIN.trim().split(/\s+/);
  const onPath = Bun.which('t3', env.PATH ? { PATH: env.PATH } : undefined);
  if (onPath) return [onPath];
  const user = env.USER;
  const profile = user ? `/etc/profiles/per-user/${user}/bin/t3` : null;
  return profile && existsSync(profile) ? [profile] : null;
}

/** T3 Code's data directory: config `baseDir`, else $T3CODE_HOME, else ~/.t3. */
export function baseDirOf(config: { baseDir?: unknown }, env: Record<string, string | undefined> = process.env): string {
  if (typeof config.baseDir === 'string' && config.baseDir.trim()) return config.baseDir.trim();
  return env.T3CODE_HOME?.trim() || join(homedir(), '.t3');
}

/** The running server's origin, from the file it keeps while it runs; null when there is none. */
export function readOrigin(baseDir: string): string | null {
  try {
    const s = JSON.parse(readFileSync(join(baseDir, 'userdata', 'server-runtime.json'), 'utf8')) as { origin?: unknown };
    return typeof s.origin === 'string' && /^https?:\/\//.test(s.origin) ? s.origin.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the command line

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class Cli {
  constructor(
    readonly bin: string[],
    readonly baseDir: string | null,
  ) {}

  /** argv after `t3 <group> <command>`: flags first, then `--base-dir` when set, then the arguments. */
  async run(path: string[], flags: string[], args: string[] = [], stdin?: string, timeoutMs = 60_000): Promise<CliResult> {
    const argv = [...this.bin, ...path, ...flags, ...(this.baseDir ? ['--base-dir', this.baseDir] : []), ...args];
    const p = Bun.spawn(argv, { stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The last line it printed on stderr, as its reason (the CLI prints expected failures as one line). */
  static reason(r: CliResult): string {
    const line = r.stderr.trim().split('\n').filter(Boolean).at(-1)?.trim();
    return line ? line.slice(0, 300) : `t3 exited with ${r.code}`;
  }
}

export interface Session {
  sessionId: string;
  token: string;
  /** ms epoch */
  expiresAt: number;
}

export type SessionUse = 'mcp' | 'rpc';

/**
 * A read-only session: `mcp` for the MCP endpoint (subject mcp-client), `rpc` for the shell stream (a plain bearer
 * session; the server takes an MCP client's only at /mcp). orchestration:read alone, so neither can change a thread.
 */
export async function issueSession(cli: Cli, use: SessionUse, label: string, ttl = '7d'): Promise<Session> {
  const flags = [...(use === 'mcp' ? ['--subject', 'mcp-client'] : []), '--scope', 'orchestration:read', '--ttl', ttl, '--label', `${label} (${use === 'mcp' ? 'reads' : 'live updates'})`, '--json'];
  const r = await cli.run(['auth', 'session', 'issue'], flags);
  if (r.code !== 0) throw new Error(`t3 auth session issue: ${Cli.reason(r)}`);
  const j = JSON.parse(r.stdout) as { sessionId?: string; token?: string; expiresAt?: string };
  if (!j.sessionId || !j.token || !j.expiresAt) throw new Error('t3 auth session issue printed no session');
  return { sessionId: j.sessionId, token: j.token, expiresAt: Date.parse(j.expiresAt) };
}

export async function revokeSession(cli: Cli, sessionId: string): Promise<void> {
  const r = await cli.run(['auth', 'session', 'revoke'], [], [sessionId]);
  if (r.code !== 0) throw new Error(`t3 auth session revoke: ${Cli.reason(r)}`);
}

/** What `t3 thread send --json` prints. */
export interface SendResult {
  threadId: string;
  messageId: string;
  runId: string;
  status: string;
  delivery: string;
}

/** A turn to a thread, queued behind a busy one as the CLI does (nothing is interrupted). */
export async function sendTurn(cli: Cli, threadId: string, body: string): Promise<SendResult> {
  const r = await cli.run(['thread', 'send'], ['--json'], [threadId, '-'], body, 120_000);
  if (r.code !== 0) throw new Error(Cli.reason(r));
  const j = JSON.parse(r.stdout) as SendResult;
  if (!j.messageId) throw new Error('t3 thread send printed no message id');
  return j;
}

// ---------------------------------------------------------------- the MCP endpoint

export class AuthError extends Error {}

const MCP_PROTOCOL = '2025-06-18';

/** A small client of T3's MCP endpoint: one MCP session, opened on first use and again when the server forgets it. */
export class Mcp {
  private sid: string | null = null;
  private pv: string | null = null;
  private n = 0;
  constructor(
    readonly origin: string,
    readonly token: string,
  ) {}

  private async post(msg: unknown): Promise<any> {
    const r = await fetch(`${this.origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${this.token}`,
        ...(this.sid ? { 'mcp-session-id': this.sid } : {}),
        ...(this.pv ? { 'mcp-protocol-version': this.pv } : {}),
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(60_000),
    });
    this.sid = r.headers.get('mcp-session-id') ?? this.sid;
    const text = await r.text();
    if (r.status === 401 || r.status === 403) throw new AuthError(`T3's MCP endpoint refused the session (HTTP ${r.status})`);
    if (r.status === 404 && this.sid) {
      this.sid = null;
      throw new SessionGone();
    }
    if (!r.ok) throw new Error(`T3's MCP endpoint answered HTTP ${r.status}`);
    if (!text.trim()) return null;
    const id = (msg as { id?: unknown }).id;
    if (r.headers.get('content-type')?.includes('text/event-stream')) {
      const all = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => JSON.parse(l.slice(5)));
      return all.find((m) => m?.id === id) ?? all.at(-1) ?? null;
    }
    return JSON.parse(text);
  }

  private async open() {
    const init = await this.post({ jsonrpc: '2.0', id: `t3x-${this.n++}`, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'dither-accounts-t3', version: '1' } } });
    if (!init?.result) throw new Error(`T3's MCP initialize failed${init?.error ? `: ${JSON.stringify(init.error).slice(0, 200)}` : ''}`);
    this.pv = init.result.protocolVersion ?? MCP_PROTOCOL;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** A tool's structured result; a tool error as an Error with T3's own message. */
  async call<T = any>(tool: string, args: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.sid) await this.open();
        const r = await this.post({ jsonrpc: '2.0', id: `t3x-${this.n++}`, method: 'tools/call', params: { name: tool, arguments: args } });
        if (r?.error) throw new Error(`${tool}: ${r.error.message ?? JSON.stringify(r.error).slice(0, 200)}`);
        const res = r?.result;
        if (res?.isError) {
          const text = res.content?.find((c: { text?: string }) => c.text)?.text ?? '';
          let msg = text;
          try {
            msg = JSON.parse(text).message ?? text;
          } catch {}
          throw new Error(`${tool}: ${String(msg || 'failed').slice(0, 300)}`);
        }
        return res?.structuredContent as T;
      } catch (e) {
        if (e instanceof SessionGone && attempt === 0) continue;
        throw e;
      }
    }
  }

  async close() {
    if (!this.sid) return;
    const sid = this.sid;
    this.sid = null;
    await fetch(`${this.origin}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${this.token}`, 'mcp-session-id': sid }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}
class SessionGone extends Error {}

// ---------------------------------------------------------------- the shell stream

/** The orchestration protocol this client speaks (T3's ORCHESTRATION_PROTOCOL_VERSION); the server refuses others with 426. */
export const ORCHESTRATION_PROTOCOL = 2;

export interface ShellHandlers {
  onItem(item: any): void;
  onOpen(): void;
  onClose(why: string, protocol: boolean): void;
}

/**
 * One subscription to `orchestration.subscribeShell`. It sends a Request frame, acknowledges each Chunk (the server
 * sends the next one only then), answers Pings, and pings itself; a socket silent for `staleMs` is closed. Closing for
 * any reason calls onClose once; the caller reconnects.
 */
export class ShellStream {
  private ws: WebSocket | null = null;
  private closed = false;
  private heard = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    readonly origin: string,
    readonly token: string,
    readonly h: ShellHandlers,
    readonly staleMs = 120_000,
  ) {}

  async start() {
    const r = await fetch(`${this.origin}/api/auth/websocket-ticket`, { method: 'POST', headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401 || r.status === 403) throw new AuthError(`T3 refused the live-updates session (HTTP ${r.status})`);
    if (!r.ok) throw new Error(`T3's websocket ticket: HTTP ${r.status}`);
    const { ticket } = (await r.json()) as { ticket: string };
    const u = new URL('/ws', this.origin);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('orchestrationProtocol', String(ORCHESTRATION_PROTOCOL));
    const plain = u.href.replace(/^ws/, 'http');
    u.searchParams.set('wsTicket', ticket);
    const ws = new WebSocket(u.href);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.heard = Date.now();
      ws.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'orchestration.subscribeShell', payload: { omitOlderSettled: true, omitIdleSubagents: true }, headers: [] }));
      this.h.onOpen();
      this.timer = setInterval(() => {
        if (Date.now() - this.heard > this.staleMs) return this.end('no frames from T3', false);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ _tag: 'Ping' }));
      }, Math.min(30_000, this.staleMs / 2));
    };
    ws.onmessage = (e) => {
      this.heard = Date.now();
      let m: any;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m._tag === 'Chunk') {
        for (const v of m.values ?? []) this.h.onItem(v);
        ws.send(JSON.stringify({ _tag: 'Ack', requestId: m.requestId }));
      } else if (m._tag === 'Ping') ws.send(JSON.stringify({ _tag: 'Pong' }));
      else if (m._tag === 'Exit' || m._tag === 'Defect' || m._tag === 'ClientProtocolError') this.end(`the stream ended (${m._tag})`, false);
    };
    // An upgrade refused before it opened: the server answers 426 to a client of another orchestration protocol, and
    // checks that before any credential, so a plain GET without the ticket tells the two apart.
    const failed = async (why: string) => {
      if (opened || this.closed) return this.end(why, false);
      const probe = await fetch(plain, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (probe?.status === 426) this.end(`T3 speaks another orchestration protocol than ${ORCHESTRATION_PROTOCOL}`, true);
      else this.end(`the upgrade was refused${probe ? ` (HTTP ${probe.status} without a ticket)` : ''}`, false);
    };
    ws.onclose = (e) => void failed(`closed (${e.code})`);
    ws.onerror = () => void failed('socket error');
  }

  private end(why: string, protocol: boolean) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    try {
      this.ws?.close();
    } catch {}
    this.h.onClose(why, protocol);
  }

  close() {
    this.end('closed here', false);
  }
}
