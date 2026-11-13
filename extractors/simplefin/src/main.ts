/**
 * The simplefin extractor (docs/simplefin.md): SimpleFIN Bridge through one access URL, as the `statements`
 * interface. A pull is sfin.py's `pull --days 30`: the bridge's responses, re-serialized as Python's
 * json.dumps(…, indent=2) did, saved as `simplefin-<local stamp>-w<i>.json`. Its own state: the spool (the cursor)
 * and pulls.json (how the last pull went); state.json keeps the accounts' names for statements.accounts.
 *
 * It logs counts, error codes and the bridge's host; never the access URL, an amount, a balance or a description.
 */
import { join } from 'node:path';
import type { StatementAccount } from '@dither-accounts/interfaces';
import { linkManager, StatusError, type Command } from '@dither-accounts/link';
import { NeedsYou, py, StatementsRunner, writeWhole } from '@dither-accounts/statements-common';
import { existsSync, readFileSync } from 'node:fs';
import { accessParts, claim, getAccounts, stamp, windows } from './bridge.ts';

interface Secret {
  accessUrl?: string;
  setupToken?: string;
}

let runner: StatementsRunner;
let claiming: Promise<void> | null = null;
let claimError: { kind: string; message: string } | null = null;
let lastStatus = '';

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'simplefin', version: '1', interfaces: ['statements'] });
    lastStatus = '';
    status();
  },
  onShutdown: () => runner?.stop(),
  async onCommand(cmd: Command) {
    const r = runner.handle(cmd);
    if (r !== undefined) return r;
    throw new StatusError(`simplefin has no operation "${cmd.t}"`, 400);
  },
});

const stateFile = join(link.accountDir, 'state.json');
function loadAccounts(): StatementAccount[] {
  try {
    return existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')).accounts ?? []) : [];
  } catch {
    return [];
  }
}
let accounts = loadAccounts();

const accessUrl = () => link.secret<Secret>().accessUrl?.trim() || null;
const host = () => {
  try {
    const a = accessUrl();
    return a ? accessParts(a).host : null;
  } catch {
    return null;
  }
};
const days = () => Math.max(1, Math.min(3650, Number(link.config.days) || 30));

/** The names of the accounts in one response (no balances), for statements.accounts. */
function namesOf(data: py.PyValue): StatementAccount[] {
  const conns = new Map<string, string | null>();
  const cs = py.pyGet(data, 'connections');
  for (const c of Array.isArray(cs) ? cs : []) {
    const id = py.pyGet(c, 'conn_id');
    const name = py.pyGet(c, 'name') || py.pyGet(c, 'org_name');
    if (typeof id === 'string') conns.set(id, typeof name === 'string' ? name : null);
  }
  const as = py.pyGet(data, 'accounts');
  return (Array.isArray(as) ? as : []).map((a) => {
    const s = (k: string) => {
      const v = py.pyGet(a, k);
      return typeof v === 'string' ? v : null;
    };
    const org = py.pyGet(a, 'org');
    return {
      id: s('id') ?? '',
      name: s('name') ?? '',
      institution: conns.get(s('conn_id') ?? '') ?? (typeof py.pyGet(org, 'name') === 'string' ? (py.pyGet(org, 'name') as string) : null),
      currency: s('currency'),
      kind: 'unknown' as const,
    };
  });
}

async function pull(opts: { days?: number; full?: boolean }) {
  const access = accessUrl();
  if (!access) throw new NeedsYou(claimError?.message ?? 'no access URL yet', claimError?.kind ?? 'login');
  const d = opts.full ? 365 : Math.max(1, Math.min(3650, opts.days ?? days()));
  const now = Math.floor(Date.now() / 1000);
  const ws = windows(now, d);
  const st = stamp(new Date());
  let saved = 0;
  const seen = new Map<string, StatementAccount>();
  for (let i = 0; i < ws.length; i++) {
    const [s, e] = ws[i];
    const text = await getAccounts(access, [
      ['start-date', s],
      ['end-date', e],
      ['pending', 1],
    ]);
    const data = py.parse(text);
    runner.spool.add(`simplefin-${st}-w${i}.json`, '', py.dumps(data, 2), { coverage: { from: s * 1000, to: e * 1000 } });
    saved++;
    const errs = py.pyGet(data, 'errlist');
    const warns = py.pyGet(data, 'errors');
    const codes = (Array.isArray(errs) ? errs : []).map((x) => String(py.toJs(py.pyGet(x, 'code')) ?? '?'));
    const as = py.pyGet(data, 'accounts');
    link.log('info', `window ${i} saved`, { accounts: Array.isArray(as) ? as.length : null, errlist: codes, warnings: Array.isArray(warns) ? warns.length : 0 });
    for (const a of namesOf(data)) if (a.id && !seen.has(a.id)) seen.set(a.id, a);
    // sfin.py reads data["accounts"] after saving: a response without it fails the pull there too.
    if (!Array.isArray(as)) throw new Error('the bridge answered without "accounts"');
    if (!as.some((a) => py.truthy(py.pyGet(a, 'transactions')))) break; // history limit reached
  }
  if (seen.size) {
    accounts = [...seen.values()];
    writeWhole(stateFile, JSON.stringify({ accounts }));
  }
  return { saved };
}

function status() {
  const a = accessUrl();
  const needs = runner.st.needs ?? claimError;
  const state = claiming ? 'connecting' : !a || needs ? 'attention' : 'online';
  const layers = [
    { name: 'access URL', state: a ? 'ok' : claiming ? 'waiting' : 'failed', note: a ? (host() ?? '') : claiming ? 'claiming the setup token' : (claimError?.message ?? 'no access URL or setup token in secret.json') },
    { name: 'bridge', state: !a ? 'off' : needs ? 'failed' : runner.st.lastOk === null ? 'waiting' : runner.st.lastOk ? 'ok' : 'failed', note: needs?.message ?? (runner.st.lastOk === false ? (runner.st.lastError ?? '') : '') },
    runner.pullLayer(),
  ];
  const ev = {
    t: 'status',
    status: state,
    attention: state === 'attention' ? { kind: needs?.kind ?? 'login', message: needs?.message ?? 'Add a SimpleFIN setup token (bridge.simplefin.org → Apps → New connection).' } : null,
    self: { displayName: 'SimpleFIN Bridge', ...(host() ? { handle: host() } : {}) },
    details: { host: host(), accounts: accounts.length, institutions: new Set(accounts.map((x) => x.institution)).size, days: days(), ...runner.details() },
    layers,
  };
  const s = JSON.stringify(ev);
  if (s === lastStatus) return;
  lastStatus = s;
  link.emit(ev);
}

runner = new StatementsRunner({
  link,
  pull: (o) => pull(o),
  accounts: () => accounts,
  blocked: () => (claiming ? 'claiming the setup token' : accessUrl() ? null : (claimError?.message ?? 'no access URL yet')),
  onChange: status,
});

async function boot() {
  const sec = link.secret<Secret>();
  if (!sec.accessUrl && sec.setupToken) {
    claiming = (async () => {
      try {
        const access = await claim(sec.setupToken!);
        // The token works once: keep only what it gave.
        link.saveSecret({ accessUrl: access });
        link.log('info', 'setup token claimed', { host: accessParts(access).host });
      } catch (e) {
        claimError = { kind: e instanceof NeedsYou ? e.kind : 'login', message: (e as Error).message };
        link.log('warn', 'claim failed', { error: (e as Error).message });
      }
    })().finally(() => {
      claiming = null;
      status();
    });
    status();
    await claiming;
  }
  runner.start();
  status();
}
void boot();
