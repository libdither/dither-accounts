/**
 * One run of `signal-cli -a <aci> daemon --socket <path> --receive-mode on-connection`.
 *
 * Why a UNIX socket rather than --http: the socket lives in the 0700 account
 * dir, so no other local user can drive the account (signal-cli's HTTP
 * endpoint has no authentication), and there is no port to allocate.
 *
 * Why on-connection: signal-cli then only pulls messages from the server
 * while our connection is subscribed, so nothing is received (and
 * acknowledged) into the void while we are not listening.
 *
 * The socket only appears after signal-cli has loaded and checked the
 * account, so a successful connect means the account is usable. An exit with
 * "User … is not registered." means the phone removed this linked device.
 */

import type { Subprocess } from 'bun';
import { existsSync, unlinkSync } from 'node:fs';
import { type ChildRegistry, type Logger, readLines, stopProcess } from './cli.ts';
import { RpcClient, RpcError } from './rpc.ts';

export interface DaemonExit {
  code: number | null;
  signal: string | null;
  /** Last error-ish stderr line. */
  lastErr: string;
  /** The account is no longer registered (device unlinked). */
  notRegistered: boolean;
  /** Connected at some point. */
  wasReady: boolean;
  uptimeMs: number;
}

export interface DaemonOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  socketPath: string;
  children: ChildRegistry;
  log: Logger;
  onNotification: (method: string, params: any) => void;
  onReady: (rpc: RpcClient) => void;
  onExit: (info: DaemonExit) => void;
  /** Give up on a daemon that has not opened its socket after this long. */
  readyTimeoutMs?: number;
  /** Probe a ready daemon with `version` this often; two failures in a row restart it. 0 disables. */
  healthEveryMs?: number;
}

export class Daemon {
  private proc: Subprocess | null = null;
  rpc: RpcClient | null = null;
  private startedAt = 0;
  private ready = false;
  private exitedFlag = false;
  private stopping = false;
  private lastErr = '';
  private notRegistered = false;
  private health?: Timer;
  private healthFailures = 0;

  constructor(private o: DaemonOptions) {}

  start() {
    try {
      if (existsSync(this.o.socketPath)) unlinkSync(this.o.socketPath); // stale socket from a crash
    } catch {}
    this.startedAt = Date.now();
    this.o.log('info', 'starting signal-cli daemon');
    const proc = Bun.spawn(this.o.argv, { env: this.o.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    this.proc = proc;
    this.o.children.add(proc);
    const out = readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => line.trim() && this.o.log('debug', `[signal-cli] ${line}`));
    const err = readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => this.stderr(line));
    void this.connectLoop();
    Promise.all([proc.exited, out, err]).then(() => this.exited());
  }

  private stderr(line: string) {
    const t = line.trim();
    if (!t) return;
    // App.loadManager: "User <account> is not registered." (exit 1): the phone unlinked us.
    if (!this.ready && /^User \S+ is not registered\.?$/.test(t)) this.notRegistered = true;
    if (!/^\s+at |^\s*\.\.\.|^Caused by/.test(line) && /ERROR|WARN|Exception|Error|Failed|failed|not registered|in use/.test(t)) this.lastErr = t;
    if (/Config file is in use by another instance/i.test(t)) this.o.log('warn', '[signal-cli] account is locked by another signal-cli process; waiting for it');
    const level = /\bERROR\b|Exception/.test(t) ? 'warn' : /\bWARN\b/.test(t) ? 'info' : 'debug';
    this.o.log(level, `[signal-cli] ${t}`);
  }

  private async connectLoop() {
    const deadline = Date.now() + (this.o.readyTimeoutMs ?? 180_000);
    while (!this.exitedFlag && !this.stopping) {
      if (existsSync(this.o.socketPath)) {
        try {
          const rpc = await RpcClient.connect(this.o.socketPath, {
            onNotification: this.o.onNotification,
            onClose: () => {
              if (this.rpc === rpc) this.rpc = null;
              // A daemon whose socket went away is of no use to us: restart it.
              if (!this.exitedFlag && !this.stopping) {
                this.o.log('warn', 'signal-cli closed the JSON-RPC connection; restarting it');
                if (this.proc) void stopProcess(this.proc, 5000);
              }
            },
            defaultTimeoutMs: 60_000,
          });
          if (this.exitedFlag || this.stopping) {
            rpc.close();
            return;
          }
          this.rpc = rpc;
          this.ready = true;
          this.o.log('info', `signal-cli daemon ready after ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`);
          this.startHealth(rpc);
          this.o.onReady(rpc);
          return;
        } catch {
          // not accepting yet
        }
      }
      if (Date.now() > deadline) {
        this.lastErr ||= 'signal-cli did not open its socket in time';
        this.o.log('warn', `signal-cli daemon not ready after ${Math.round((this.o.readyTimeoutMs ?? 180_000) / 1000)}s; killing it`);
        if (this.proc) void stopProcess(this.proc, 3000);
        return;
      }
      await Bun.sleep(250);
    }
  }

  /** A hung daemon (socket open, nothing answering) is killed so the owner restarts it. */
  private startHealth(rpc: RpcClient) {
    const every = this.o.healthEveryMs ?? 120_000;
    if (!every) return;
    this.health = setInterval(async () => {
      try {
        await rpc.call('version', undefined, Math.min(30_000, every));
        this.healthFailures = 0;
      } catch (e: any) {
        if (e instanceof RpcError) {
          this.healthFailures = 0; // it answered, even if with an error
          return;
        }
        if (!rpc.open || this.exitedFlag || this.stopping) return;
        if (++this.healthFailures >= 2) {
          this.lastErr = `signal-cli stopped answering (${e?.message ?? e})`;
          this.o.log('warn', this.lastErr + '; restarting it');
          clearInterval(this.health);
          if (this.proc) void stopProcess(this.proc, 5000);
        }
      }
    }, every);
  }

  private exited() {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    clearInterval(this.health);
    const p = this.proc!;
    this.rpc?.close();
    this.rpc = null;
    try {
      if (existsSync(this.o.socketPath)) unlinkSync(this.o.socketPath);
    } catch {}
    const info: DaemonExit = {
      code: p.exitCode,
      signal: p.signalCode != null ? String(p.signalCode) : null,
      lastErr: this.lastErr,
      notRegistered: this.notRegistered,
      wasReady: this.ready,
      uptimeMs: Date.now() - this.startedAt,
    };
    if (!this.stopping) this.o.onExit(info);
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.health);
    this.rpc?.close();
    if (this.proc) await stopProcess(this.proc, 8000);
  }
}
