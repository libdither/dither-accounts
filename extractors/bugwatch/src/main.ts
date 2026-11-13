/**
 * The bugwatch extractor: your own services' error files and logs on this machine as `notifications`
 * (docs/bugwatch.md). Every scan (30 s) reads what is new in each source, and each new bug (a fingerprint not seen
 * for 14 days, a spike, or an `always` match) becomes a notice and, within the caps, a T3 thread.
 *
 * Its config is a JSON file outside the repository, named by the account's `config` field, read again when it
 * changes. Where it is in each file and what it saw are in state.json, so a restart goes on where it was. An owner
 * clears a fingerprint (so it may get a thread again) by adding its id to clear.txt in the account directory
 * (`bun extractors/bugwatch/src/cli.ts --account-dir <dir> --clear <id>`). It logs ids, counts and paths, never what
 * a record says.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { ConfigFile } from './config.ts';
import { run } from './run.ts';
import { loadState, saveState } from './state.ts';
import { Watch } from './watch.ts';

const SCAN_MS = Number(process.env.DITHER_BUGWATCH_SCAN_MS) > 0 ? Number(process.env.DITHER_BUGWATCH_SCAN_MS) : 30_000;
const TEMPLATE = readFileSync(join(import.meta.dir, '../brief.md'), 'utf8');

type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', network: 'bugwatch', version: '1', capabilities: [] });
    status(true);
  },
  onCommand: (cmd) => op(cmd),
  onShutdown: () => save(),
});

const configPath = typeof link.config.config === 'string' ? link.config.config.trim() : '';
const file = configPath ? new ConfigFile(configPath) : null;
const statePath = join(link.accountDir, 'state.json');
const clearPath = join(link.accountDir, 'clear.txt');
const st = loadState(statePath, (m) => link.log('warn', m));
let watch: Watch | null = null;
let problem: string | null = configPath ? null : 'No config file: add the account again with the path of its JSON config (docs/bugwatch.md).';
let scanning = false;
const firstScan = Promise.withResolvers<void>();
let lastScan: { at: number; records: number; raised: number; catchUp: boolean } | null = null;

function save() {
  try {
    saveState(statePath, st);
  } catch (e) {
    link.log('error', `could not write state.json: ${(e as Error).message}`);
  }
}

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    if (!file) return;
    let cfg;
    try {
      cfg = file.get();
      problem = file.error ? `The config does not read now (the last good one is in use): ${file.error}` : null;
    } catch (e) {
      problem = `The config does not read: ${(e as Error).message}`;
      return;
    }
    if (!watch) watch = new Watch(cfg, st, { now: Date.now, run, log: (l, m) => link.log(l, m), emit: (ev) => link.emit(ev), briefTemplate: TEMPLATE });
    watch.cfg = cfg;
    applyClears(watch);
    const r = await watch.scan();
    lastScan = { at: Date.now(), records: r.records, raised: r.raised.length, catchUp: r.catchUp };
    if (r.records || r.raised.length) link.log('info', `scan: ${r.records} records, ${r.raised.length} bugs raised${r.catchUp ? ' (the first look: the last 24 h, listed without notifications)' : ''}`);
    save();
  } catch (e) {
    link.log('error', `scan failed: ${(e as Error).message}`);
  } finally {
    scanning = false;
    firstScan.resolve();
    status();
  }
}

/** Fingerprints the owner cleared (clear.txt, one id a line): they may get a thread again. */
function applyClears(w: Watch) {
  if (!existsSync(clearPath)) return;
  try {
    const ids = readFileSync(clearPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    rmSync(clearPath, { force: true });
    for (const id of ids) link.log('info', w.clear(id) ? `cleared bug ${id}` : `clear.txt names no bug ${id}`);
  } catch (e) {
    link.log('warn', `clear.txt: ${(e as Error).message}`);
  }
}

async function ready(): Promise<Watch> {
  await Promise.race([firstScan.promise, Bun.sleep(30_000)]);
  if (!watch) throw new StatusError(problem ?? 'bugwatch has not read its config yet', 503);
  return watch;
}

async function op(cmd: Command): Promise<unknown> {
  switch (cmd.t) {
    case 'notify.list': {
      const w = await ready();
      return w.list({
        unreadOnly: cmd.unreadOnly === true,
        since: typeof cmd.since === 'number' && Number.isFinite(cmd.since) ? cmd.since : undefined,
        limit: typeof cmd.limit === 'number' ? cmd.limit : undefined,
        pageToken: typeof cmd.pageToken === 'string' ? cmd.pageToken : undefined,
      });
    }
    case 'notify.markRead': {
      const w = await ready();
      w.markRead((Array.isArray(cmd.ids) ? cmd.ids : []).map(String));
      save();
      return {};
    }
    case 'notify.markAllRead': {
      const w = await ready();
      w.markAllRead(typeof cmd.before === 'number' && Number.isFinite(cmd.before) ? cmd.before : undefined);
      save();
      return {};
    }
    case 'notify.mute': {
      const w = await ready();
      const id = String(cmd.id ?? '');
      if (!w.mute(id)) throw new StatusError(`no bug "${id}"`, 404);
      link.log('info', `muted bug ${id}`);
      save();
      return {};
    }
    default:
      throw new StatusError(`bugwatch has no operation "${cmd.t}"`, 400);
  }
}

// ------------------------------------------------------------------ status

function layers(): Layer[] {
  const out: Layer[] = [file ? (problem && !watch ? { name: 'config', state: 'failed', note: problem } : problem ? { name: 'config', state: 'waiting', note: problem } : { name: 'config', state: 'ok', note: configPath }) : { name: 'config', state: 'failed', note: 'no config file' }];
  for (const s of watch?.cfg.sources ?? []) {
    const h = watch!.health.get(s.name);
    out.push(!h ? { name: s.name, state: 'waiting', note: 'not read yet' } : h.error ? { name: s.name, state: 'failed', note: h.error } : h.files ? { name: s.name, state: 'ok', note: `${h.files} file${h.files === 1 ? '' : 's'}, ${h.records} new records` } : { name: s.name, state: 'waiting', note: 'no file there yet' });
  }
  const t = watch?.cfg.threads;
  out.push(!watch ? { name: 'threads', state: 'waiting' } : !t ? { name: 'threads', state: 'off', note: 'not set up' } : { name: 'threads', state: 'ok', note: `${st.threadStarts.length} in the last 24 h of ${t.dayMax}, ${watch.queue().length} waiting` });
  return out;
}

let lastKey = '';
let lastSentAt = 0;
function status(force = false) {
  const unread = watch ? watch.notices().filter((b) => b.notice!.unread).length : 0;
  const ev = {
    t: 'status',
    status: problem && !watch ? 'attention' : 'online',
    attention: problem && !watch ? { kind: 'config', message: problem } : null,
    details: {
      config: configPath || null,
      sources: watch?.cfg.sources.length ?? 0,
      fingerprints: Object.keys(st.bugs).length,
      unread,
      threadsToday: st.threadStarts.length,
      queued: watch?.queue().length ?? 0,
      lastScanAt: lastScan ? new Date(lastScan.at).toISOString() : null,
      lastScanRecords: lastScan?.records ?? null,
    },
    layers: layers(),
  };
  const key = JSON.stringify({ ...ev, details: { ...ev.details, lastScanAt: null, lastScanRecords: null }, layers: ev.layers.map((l) => ({ ...l, note: l.name === 'config' || l.name === 'threads' ? l.note : l.state })) });
  if (!force && key === lastKey && Date.now() - lastSentAt < 600_000) return;
  lastKey = key;
  lastSentAt = Date.now();
  link.emit(ev);
}

// ------------------------------------------------------------------ start

void scan();
setInterval(() => void scan(), SCAN_MS);
