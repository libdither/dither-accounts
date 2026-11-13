/**
 * The monero extractor (docs/monero.md): a view-only Monero wallet as the `statements` interface, a port of
 * dither-finance's connectors/monero.py. A pull scans (monero-wallet-rpc against a remote node), imports key images
 * when a newer file came (monero-wallet-cli), reads height, balance and transfers, and saves
 * `monero-<UTC stamp>Z.json` written as Python's json.dumps(…, indent=1) did. `monero.view`'s one op stores key images.
 *
 * Its directory: secret.json {address, viewKey} (600), wallet/ (700: view, view.keys, password, rpc.log, cli.log,
 * ki-imported), key_images (600), spool/, pulls.json. It logs the node, block counts and transfer counts; never the
 * address, the view key, a balance or an amount.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { StatementAccount } from '@dither-accounts/interfaces';
import { linkManager, StatusError, type Command } from '@dither-accounts/link';
import { NeedsYou, py, StatementsRunner, writeWhole } from '@dither-accounts/statements-common';
import { binDir, DEFAULT_NODES, hasWallet, importKeyImages, nodeOk, transferRows, WalletProcess } from './wallet.ts';

interface Secret {
  address?: string;
  viewKey?: string;
}
const KEY_IMAGES_MAX = 16 * 1024 * 1024;

let runner: StatementsRunner;
let lastStatus = '';
let current: WalletProcess | null = null;
let phase: 'idle' | 'node' | 'scanning' | 'key images' | 'reading' = 'idle';
let phaseSince = 0;
let node: string | null = null;
let last: { height: number | null; transfers: number; scanned: number | null } | null = null;

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'monero', version: '1', interfaces: ['statements', 'monero.view'] });
    lastStatus = '';
    status();
  },
  onShutdown: async () => {
    runner?.stop();
    await current?.abort();
  },
  async onCommand(cmd: Command) {
    const r = runner.handle(cmd);
    if (r !== undefined) return r;
    if (cmd.t === 'monero.keyImages') return keyImages(String((cmd as any).base64 ?? ''));
    throw new StatusError(`monero has no operation "${cmd.t}"`, 400);
  },
});

const dir = link.accountDir;
const WALLET = join(dir, 'wallet');
const KEY_IMAGES = join(dir, 'key_images');
const MARKER = join(WALLET, 'ki-imported');
const cfg = link.config as { node?: string; restoreHeight?: string | number; binDir?: string };
const secret = () => link.secret<Secret>();
const configured = () => {
  const s = secret();
  return !!(s.address && s.viewKey);
};
const setPhase = (p: typeof phase) => {
  phase = p;
  phaseSince = Date.now();
  status();
};
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const keyImagesWaiting = () => existsSync(KEY_IMAGES) && (!existsSync(MARKER) || statSync(MARKER).mtimeMs < statSync(KEY_IMAGES).mtimeMs);

function keyImages(base64: string) {
  const b = Buffer.from(base64, 'base64');
  if (!b.length) throw new StatusError('no key images: base64 of the file the full wallet exported', 400);
  if (b.length > KEY_IMAGES_MAX) throw new StatusError(`at most ${KEY_IMAGES_MAX} bytes`, 413);
  // Monero's key image export starts with this magic (wallet2::export_key_images_to_file).
  if (!b.subarray(0, 23).toString('latin1').startsWith('Monero key image export')) throw new StatusError('not a Monero key image export file', 400);
  writeWhole(KEY_IMAGES, b);
  link.log('info', 'key images stored; the next pull imports them', { bytes: b.length });
  status();
  return { saved: true, size: b.length };
}

async function pull() {
  const s = secret();
  if (!s.address || !s.viewKey) throw new NeedsYou('secret.json needs both address and viewKey', 'config');
  const bin = await binDir(cfg.binDir);
  setPhase('node');
  const nodes = cfg.node ? [cfg.node] : DEFAULT_NODES;
  node = null;
  for (const n of nodes) if (await nodeOk(n)) {
    node = n;
    break;
  }
  if (!node) throw new Error(`no reachable node among ${nodes.length}`);
  link.log('info', 'node', { node });
  mkdirSync(WALLET, { recursive: true, mode: 0o700 });
  chmodSync(WALLET, 0o700);
  const pwf = join(WALLET, 'password');
  if (!existsSync(pwf)) writeFileSync(pwf, randomBytes(18).toString('base64url'), { mode: 0o600 });
  const wpw = readFileSync(pwf, 'utf8').trim();

  try {
    // Scan first: key images only mean something for outputs already found.
    setPhase('scanning');
    current = new WalletProcess(bin, WALLET, node);
    const scanned = await WalletProcess.use(current, async (rpc) => {
      if (hasWallet(WALLET)) await rpc.call('open_wallet', { filename: 'view', password: wpw });
      else {
        await rpc.call('generate_from_keys', { filename: 'view', address: s.address, viewkey: s.viewKey, restore_height: Number.parseInt(String(cfg.restoreHeight || 0), 10) || 0, password: wpw, autosave_current: true });
        link.log('info', 'created the view-only wallet');
      }
      const t0 = Date.now();
      const r = await rpc.call('refresh', {}, 12 * 3600_000);
      const n = Number(py.toJs(py.pyGet(r, 'blocks_fetched')) ?? 0);
      link.log('info', 'scanned', { blocks: n, seconds: Math.round((Date.now() - t0) / 1000) });
      return n;
    });
    if (keyImagesWaiting()) {
      setPhase('key images');
      const ok = await importKeyImages(bin, WALLET, node, wpw, KEY_IMAGES);
      link.log(ok ? 'info' : 'warn', ok ? 'key images imported' : 'key image import failed; see wallet/cli.log');
      if (ok) {
        if (!existsSync(MARKER)) writeFileSync(MARKER, '', { mode: 0o600 });
        const now = new Date();
        utimesSync(MARKER, now, now);
      }
    }
    setPhase('reading');
    current = new WalletProcess(bin, WALLET, node);
    const { height, bal, tr } = await WalletProcess.use(current, async (rpc) => {
      await rpc.call('open_wallet', { filename: 'view', password: wpw });
      const height = py.pyGet(await rpc.call('get_height'), 'height');
      const bal = await rpc.call('get_balance', { account_index: 0, all_accounts: true });
      const tr = await rpc.call('get_transfers', { in: true, out: true, pending: true, pool: true, failed: false, all_accounts: true });
      return { height, bal, tr };
    });
    const rows = transferRows(tr);
    const pulledAt = stamp(new Date());
    const doc = new py.PyObj([
      ['source', 'monero-wallet-rpc'],
      ['pulled_at', pulledAt],
      ['wallet', [...s.address].slice(0, 8).join('')],
      ['height', height ?? null],
      ['key_images', existsSync(MARKER)],
      ['balance', py.pyGet(bal, 'balance') ?? null],
      ['unlocked_balance', py.pyGet(bal, 'unlocked_balance') ?? null],
      ['transfers', rows],
    ]);
    runner.spool.add(`monero-${pulledAt.replace(/[:-]/g, '')}.json`, '', py.dumps(doc, 1));
    last = { height: height instanceof py.PyInt ? height.toNumber() : null, transfers: rows.length, scanned };
    writeWhole(join(dir, 'state.json'), JSON.stringify({ last }));
    link.log('info', 'saved', { transfers: rows.length });
    return { saved: 1 };
  } finally {
    current = null;
    setPhase('idle');
  }
}

function accounts(): StatementAccount[] {
  const a = secret().address;
  return a ? [{ id: [...a].slice(0, 8).join(''), name: link.label || 'Monero wallet', institution: 'Monero (view-only)', currency: 'XMR', kind: 'wallet' }] : [];
}

function status() {
  if (!runner) return;
  const ok = configured();
  const needs = runner.st.needs;
  const state = !ok || needs ? 'attention' : phase === 'scanning' ? 'syncing' : 'online';
  const since = phaseSince ? new Date(phaseSince).toLocaleTimeString() : '';
  const layers = [
    { name: 'keys', state: ok ? 'ok' : 'failed', note: ok ? 'address and view key' : 'secret.json needs address and viewKey' },
    { name: 'node', state: !ok ? 'off' : phase === 'node' ? 'waiting' : node ? 'ok' : runner.st.lastOk === false ? 'failed' : 'waiting', note: node ?? (cfg.node ? cfg.node : 'the default nodes') },
    { name: 'wallet', state: !ok ? 'off' : phase === 'scanning' ? 'waiting' : hasWallet(WALLET) ? 'ok' : 'waiting', note: phase === 'scanning' ? `scanning since ${since}` : hasWallet(WALLET) ? `${last?.height ? `height ${last.height}` : 'on disk'}` : 'made on the first pull (a scan from the restore height can take hours)' },
    { name: 'key images', state: existsSync(MARKER) ? 'ok' : existsSync(KEY_IMAGES) ? 'waiting' : 'off', note: keyImagesWaiting() ? 'imported on the next pull' : existsSync(MARKER) ? 'imported' : 'none (spent outputs are not seen)' },
    runner.pullLayer(),
  ];
  const ev = {
    t: 'status',
    status: state,
    attention: state === 'attention' ? { kind: needs?.kind ?? 'config', message: needs?.message ?? 'Add the address and private view key (secret.json).' } : null,
    self: { displayName: link.label || 'Monero (view-only)' },
    details: {
      node: node ?? cfg.node ?? null,
      phase: phase === 'idle' ? 'idle' : `${phase} since ${since}`,
      walletOnDisk: hasWallet(WALLET),
      walletHeight: last?.height ?? null,
      transfers: last?.transfers ?? null,
      lastScanBlocks: last?.scanned ?? null,
      keyImagesImported: existsSync(MARKER),
      keyImagesWaiting: keyImagesWaiting(),
      ...runner.details(),
    },
    layers,
  };
  const s = JSON.stringify(ev);
  if (s === lastStatus) return;
  lastStatus = s;
  link.emit(ev);
}

try {
  if (existsSync(join(dir, 'state.json'))) last = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).last ?? null;
} catch {}
runner = new StatementsRunner({
  link,
  pull: () => pull(),
  accounts,
  blocked: () => (configured() ? null : 'secret.json needs address and viewKey'),
  onChange: status,
});
runner.start();
status();
