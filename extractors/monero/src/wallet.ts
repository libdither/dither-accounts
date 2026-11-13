/**
 * The view-only wallet, as connectors/monero.py runs it: monero-wallet-rpc (nixpkgs#monero-cli) on a random localhost
 * port with a random digest login, for one step of a pull, against a remote node; key images imported with
 * monero-wallet-cli. The two never open the wallet file at once: a pull runs its steps one after another, and one
 * pull at a time.
 */
import { existsSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { py } from '@dither-accounts/statements-common';
import { Rpc } from './rpc.ts';

export const DEFAULT_NODES = ['xmr-node.cakewallet.com:18081', 'node.sethforprivacy.com:18089', 'nodes.hashvault.pro:18081'];

let built: string | null = null;
/** The directory with monero-wallet-rpc and monero-wallet-cli: `binDir` from the config, else nixpkgs#monero-cli. */
export async function binDir(configured?: string): Promise<string> {
  if (configured) return configured;
  if (built) return built;
  const p = Bun.spawn(['nix', 'build', '--no-link', '--print-out-paths', 'nixpkgs#monero-cli'], { stdout: 'pipe', stderr: 'ignore' });
  const out = (await new Response(p.stdout).text()).trim().split(/\s+/).pop();
  if ((await p.exited) !== 0 || !out) throw new Error('nix build nixpkgs#monero-cli failed');
  built = `${out}/bin`;
  return built;
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

/** monero.py _node_ok: the node answers get_info, is synchronized and not offline. */
export async function nodeOk(node: string): Promise<boolean> {
  try {
    const r = await fetch(`http://${node}/json_rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const info = (await r.json()) as { result?: { synchronized?: boolean; offline?: boolean } };
    if (!info.result) return false;
    return (info.result.synchronized ?? true) && !info.result.offline;
  } catch {
    return false;
  }
}

/** Processes that have this file open (from /proc): a wallet file is never opened by two programs at once. */
export function openBy(path: string): number[] {
  const out: number[] = [];
  for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          if (readlinkSync(`/proc/${pid}/fd/${fd}`) === path) {
            out.push(Number(pid));
            break;
          }
        } catch {}
      }
    } catch {}
  }
  return out;
}

const setpriv = Bun.which('setpriv');

/** monero-wallet-rpc for one step; `use` gets its Rpc. Stored and stopped after, whatever happens. */
export class WalletProcess {
  proc: ReturnType<typeof Bun.spawn> | null = null;
  rpc: Rpc | null = null;
  constructor(
    private bin: string,
    private walletDir: string,
    private node: string,
  ) {}

  async start(): Promise<Rpc> {
    const port = await freePort();
    const user = 'da';
    const pw = randomBytes(18).toString('base64url');
    // The login goes in a 0600 config file, not argv, where any user on the machine could read it in /proc; the file
    // is gone once the wallet answers (it reads it at start).
    const conf = join(this.walletDir, `.rpc-${randomBytes(6).toString('hex')}.conf`);
    writeFileSync(conf, `rpc-login=${user}:${pw}\n`, { mode: 0o600 });
    const args = [join(this.bin, 'monero-wallet-rpc'), '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(port), '--config-file', conf, '--wallet-dir', this.walletDir, '--daemon-address', this.node, '--non-interactive', '--log-file', join(this.walletDir, 'rpc.log'), '--log-level', '0'];
    // The wallet gets SIGTERM if this extractor dies (monero.py's PR_SET_PDEATHSIG), so nothing is left scanning.
    this.proc = Bun.spawn(setpriv ? [setpriv, '--pdeathsig', 'TERM', ...args] : args, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    this.rpc = new Rpc(port, user, pw);
    try {
      for (let i = 0; i < 90; i++) {
        try {
          await this.rpc.call('get_version', {}, 5_000);
          return this.rpc;
        } catch {
          if (this.proc.exitCode !== null) throw new Error('monero-wallet-rpc exited; see wallet/rpc.log');
          await Bun.sleep(1000);
        }
      }
      throw new Error('monero-wallet-rpc did not start');
    } finally {
      rmSync(conf, { force: true });
    }
  }

  async stop() {
    if (!this.proc) return;
    try {
      await this.rpc!.call('store', {}, 60_000);
      await this.rpc!.call('stop_wallet', {}, 30_000);
    } catch {}
    const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(60_000).then(() => false)]);
    if (!exited) this.proc.kill('SIGKILL');
    this.proc = null;
  }

  /** On shutdown: a short chance to store, then SIGTERM (the manager kills us 8 s after its own SIGTERM). */
  async abort() {
    if (!this.proc) return;
    try {
      await this.rpc!.call('stop_wallet', {}, 4_000);
    } catch {}
    this.proc?.kill('SIGTERM');
  }

  static async use<T>(w: WalletProcess, f: (rpc: Rpc) => Promise<T>): Promise<T> {
    const rpc = await w.start();
    try {
      return await f(rpc);
    } finally {
      await w.stop();
    }
  }
}

/** monero.py _import_key_images: only the wallet CLI reads the binary key image file the wallets export. */
export async function importKeyImages(bin: string, walletDir: string, node: string, password: string, keyImages: string): Promise<boolean> {
  // The password through a 0600 file, never argv (readable by any user in /proc).
  const pwFile = join(walletDir, `.pw-${randomBytes(6).toString('hex')}`);
  writeFileSync(pwFile, password, { mode: 0o600 });
  try {
    const p = Bun.spawn(
      [join(bin, 'monero-wallet-cli'), '--wallet-file', join(walletDir, 'view'), '--password-file', pwFile, '--daemon-address', node, '--log-file', join(walletDir, 'cli.log'), 'import_key_images', keyImages],
      { stdin: new Blob(['']), stdout: 'pipe', stderr: 'pipe' },
    );
    const t = setTimeout(() => p.kill('SIGKILL'), 600_000);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(t);
    return code === 0 && !out.toLowerCase().includes('error');
  } finally {
    rmSync(pwFile, { force: true });
  }
}

export const hasWallet = (walletDir: string) => existsSync(join(walletDir, 'view'));

/** get_transfers' rows as monero.py keeps them: these keys in this order, then "type". */
export const TRANSFER_KEYS = ['txid', 'amount', 'fee', 'height', 'timestamp', 'confirmations', 'subaddr_index', 'unlock_time', 'double_spend_seen'];
export function transferRows(tr: py.PyValue): py.PyObj[] {
  const rows: py.PyObj[] = [];
  if (!(tr instanceof py.PyObj)) return rows;
  for (const [kind, xs] of tr.entries()) {
    for (const x of Array.isArray(xs) ? xs : []) {
      const row = new py.PyObj();
      for (const k of TRANSFER_KEYS) row.set(k, py.pyGet(x, k) ?? null);
      const t = x instanceof py.PyObj && x.has('type') ? x.get('type')! : kind;
      row.set('type', t);
      rows.push(row);
    }
  }
  return rows;
}
