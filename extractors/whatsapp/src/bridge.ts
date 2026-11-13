/**
 * The bridge process (bridge/main.go): finding it, running it, and talking JSON lines to it.
 *
 * Binary: $WHATSAPP_BRIDGE_BIN (a path, or "bun test/fake-bridge.ts" style for tests), else
 * `dither-wa-bridge` on PATH, else a nix build of bridge/package.nix, cached by a hash of the
 * bridge sources so an updated bridge is rebuilt and an unchanged one is not re-evaluated.
 */

import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeEvent, BridgeReply } from './types.ts';

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bridge');
const SOURCES = ['go.mod', 'go.sum', 'main.go', 'fixtures.go', 'package.nix'];

function isExecutable(p: string) {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function sourceHash(): string {
  const h = new Bun.CryptoHasher('sha256');
  for (const f of SOURCES) {
    const p = join(BRIDGE_DIR, f);
    if (existsSync(p)) h.update(f).update(readFileSync(p));
  }
  return h.digest('hex').slice(0, 16);
}

/** argv prefix for the bridge. May take a minute the first time (nix build). */
export async function resolveBridge(cacheDir: string, log: Logger): Promise<string[]> {
  const env = process.env.WHATSAPP_BRIDGE_BIN?.trim();
  if (env) {
    const parts = env.split(/\s+/);
    if (parts.length > 1 || isExecutable(parts[0])) return parts;
    throw new Error(`WHATSAPP_BRIDGE_BIN=${env} is not executable`);
  }
  const onPath = Bun.which('dither-wa-bridge');
  if (onPath) return [onPath];

  const hash = sourceHash();
  const cache = join(cacheDir, `wa-bridge.${hash}.path`);
  if (existsSync(cache)) {
    const bin = readFileSync(cache, 'utf8').trim();
    if (isExecutable(bin)) return [bin];
  }
  log('info', 'building the WhatsApp bridge with nix (first start only, about a minute)');
  const nix = Bun.which('nix') ?? '/run/current-system/sw/bin/nix';
  const expr = `(builtins.getFlake "nixpkgs").legacyPackages.\${builtins.currentSystem}.callPackage ${join(BRIDGE_DIR, 'package.nix')} {}`;
  const proc = Bun.spawn([nix, 'build', '--impure', '--no-link', '--print-out-paths', '--expr', expr], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const store = out.trim().split('\n').filter(Boolean).pop();
  const bin = store ? join(store, 'bin', 'dither-wa-bridge') : '';
  if (code !== 0 || !isExecutable(bin)) {
    throw new Error(`could not build the WhatsApp bridge (set WHATSAPP_BRIDGE_BIN or put dither-wa-bridge on PATH): nix build exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`);
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cache, bin + '\n');
  return [bin];
}

export interface BridgeOptions {
  argv: string[];
  env?: Record<string, string | undefined>;
  log: Logger;
  onEvent: (ev: BridgeEvent) => void;
  onExit: (code: number | null) => void;
}

/** One running bridge. Commands get replies by id; everything else is an event. */
export class Bridge {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer }>();
  private exited = false;
  readonly done: Promise<number | null>;

  constructor(private opts: BridgeOptions) {
    this.proc = Bun.spawn(opts.argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: opts.env as any });
    this.done = this.proc.exited.then((code) => {
      this.exited = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('the WhatsApp bridge stopped'));
      }
      this.pending.clear();
      opts.onExit(code);
      return code;
    });
    this.readLines(this.proc.stdout, (line) => this.onLine(line));
    this.readLines(this.proc.stderr, (line) => {
      const level = / (ERROR|WARN)\] /.exec(line)?.[1];
      opts.log(level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'debug', `bridge: ${line}`);
    });
  }

  get pid() {
    return this.proc.pid;
  }

  get alive() {
    return !this.exited;
  }

  private async readLines(stream: ReadableStream<Uint8Array>, each: (line: string) => void) {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of stream) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) each(line);
        }
      }
    } catch {}
  }

  private onLine(line: string) {
    let msg: BridgeEvent | BridgeReply;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.log('warn', `bridge printed something that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.t === 'reply') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
      return;
    }
    try {
      this.opts.onEvent(msg);
    } catch (e: any) {
      this.opts.log('error', `handling bridge event ${msg.t}: ${e?.stack ?? e}`);
    }
  }

  /** args must not have an `id`: that is the command's own (and the bridge matches names without case). */
  call<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if ('id' in args || 'op' in args) return Promise.reject(new Error(`bridge call ${op}: "id" and "op" are reserved`));
    if (this.exited) return Promise.reject(new Error('the WhatsApp bridge is not running'));
    const id = String(++this.seq);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WhatsApp did not answer (${op})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ ...args, id, op }) + '\n');
      this.proc.stdin.flush();
    });
  }

  async stop(graceMs = 5000) {
    if (this.exited) return;
    try {
      this.proc.stdin.end();
    } catch {}
    this.proc.kill('SIGTERM');
    const t = setTimeout(() => this.proc.kill('SIGKILL'), graceMs);
    await this.done.catch(() => {});
    clearTimeout(t);
  }
}
