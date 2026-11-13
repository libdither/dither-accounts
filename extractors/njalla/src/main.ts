/**
 * The njalla extractor (docs/njalla.md): Njalla's DNS records as the `dns` interface, with the API token in
 * secret.json (read on every call, so a new one is picked up without a restart).
 *
 * It checks the token by listing the domains when it starts, every DITHER_NJALLA_RECHECK_MS (15 minutes), and again
 * when a call is refused for the token: only when that list fails too does the account ask for attention, since a
 * token restricted to some domains is refused the others. The `zones` setting narrows what apps may touch further.
 *
 * It logs methods, domains, names and types; never the token, and not record contents.
 */
import type { DnsRecord, DnsZone } from '@dither-accounts/interfaces';
import { linkManager, StatusError, type Command } from '@dither-accounts/link';
import { API_URL, type Method, NjallaError, type RawDomain, type RawRecord, rpc } from './api.ts';
import { relName } from './names.ts';

const RECHECK_MS = Number(process.env.DITHER_NJALLA_RECHECK_MS) || 15 * 60_000;
const API = process.env.DITHER_NJALLA_API_URL || API_URL;
const DEFAULT_TTL = 300;

let zones: DnsZone[] = [];
let check: { at: number; ok: boolean; message: string | null; failure: string | null } | null = null;
let checking: Promise<void> | null = null;
let calls = 0;
let changes = 0;
let lastStatus = '';

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'njalla', version: '1', interfaces: ['dns'] });
    lastStatus = '';
    status();
  },
  onCommand: (cmd) => handle(cmd),
});

const token = () => String(link.secret<{ token?: string }>().token ?? '').trim();
/** The `zones` setting: the only domains apps may touch, or null for every one the token reaches. */
const allowed = (): string[] | null => {
  const z = String(link.config.zones ?? '')
    .split(',')
    .map((x) => norm(x))
    .filter(Boolean);
  return z.length ? z : null;
};
const norm = (d: string) => d.trim().toLowerCase().replace(/\.$/, '');

async function call<T>(method: Method, params: Record<string, unknown>): Promise<T> {
  const t = token();
  if (!t) throw new StatusError('no Njalla API token yet: add one on the account', 401, 'login');
  calls++;
  try {
    return await rpc<T>(t, method, params, API);
  } catch (e) {
    if (e instanceof NjallaError && e.failure === 'auth' && method !== 'list-domains') void recheck();
    throw e;
  }
}

/** List the domains: the token check. */
function recheck(): Promise<void> {
  checking ??= (async () => {
    try {
      const r = await call<{ domains?: RawDomain[] }>('list-domains', {});
      const only = allowed();
      zones = (r.domains ?? [])
        .map((d) => ({ name: norm(String(d.name ?? '')), status: d.status ?? null, expiry: d.expiry ?? null }))
        .filter((d) => d.name && (!only || only.includes(d.name)));
      check = { at: Date.now(), ok: true, message: null, failure: null };
    } catch (e) {
      const failure = e instanceof NjallaError ? e.failure : 'http';
      check = { at: Date.now(), ok: false, message: (e as Error).message, failure };
      link.log('warn', 'token check failed', { failure, error: (e as Error).message });
    }
  })().finally(() => {
    checking = null;
    status();
  });
  return checking;
}

function status() {
  const has = !!token();
  const bad = check && !check.ok;
  const signedOut = !has || (bad && check!.failure === 'auth');
  const state = !has ? 'attention' : !check ? 'connecting' : signedOut ? 'attention' : bad ? 'error' : 'online';
  const only = allowed();
  const ev = {
    t: 'status',
    status: state,
    attention: signedOut
      ? { kind: 'login', message: has ? `Njalla turned the token away: ${check?.message ?? ''}. Make a new one (njal.la → Settings → API).` : 'Add a Njalla API token (njal.la → Settings → API → Add token).' }
      : null,
    self: { displayName: 'Njalla', ...(zones.length ? { handle: zones.length === 1 ? zones[0].name : `${zones.length} domains` } : {}) },
    details: { zones: zones.map((z) => z.name), onlyZones: only, checkedAt: check?.at ?? null, calls, changes, ...(API !== API_URL ? { api: API } : {}) },
    layers: [
      { name: 'token', state: !has ? 'failed' : !check ? 'waiting' : signedOut ? 'failed' : 'ok', note: !has ? 'no token in secret.json' : signedOut ? (check?.message ?? '') : '' },
      { name: 'api', state: !has || signedOut ? 'off' : !check ? 'waiting' : bad ? 'failed' : 'ok', note: bad && !signedOut ? (check?.message ?? '') : `${zones.length} domain${zones.length === 1 ? '' : 's'}` },
    ],
  };
  const s = JSON.stringify(ev);
  if (s === lastStatus) return;
  lastStatus = s;
  link.emit(ev);
}

/** A zone an app may touch: in the `zones` setting when there is one. */
function zoneOf(cmd: Command): string {
  const z = norm(String(cmd.zone ?? ''));
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(z)) throw new StatusError(`"${cmd.zone}" is not a domain`, 400);
  const only = allowed();
  if (only && !only.includes(z)) throw new StatusError(`${z} is not one of this account's domains (${only.join(', ')})`, 403, 'zone');
  return z;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameContent = (a: string, b: string) => a.replace(/\.$/, '').toLowerCase() === b.replace(/\.$/, '').toLowerCase();
const typeOf = (t: unknown) => {
  const x = String(t ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(x)) throw new StatusError(`"${t}" is not a record type`, 400);
  return x;
};
const ttlOf = (t: unknown) => (t === undefined || t === null ? undefined : Math.max(60, Math.min(86_400 * 7, Math.round(Number(t)))));

function rec(r: RawRecord): DnsRecord {
  return {
    id: String(r.id),
    name: String(r.name ?? '@') || '@',
    type: String(r.type ?? '').toUpperCase(),
    content: String(r.content ?? ''),
    ttl: typeof r.ttl === 'number' ? r.ttl : r.ttl == null ? null : Number(r.ttl) || null,
    ...(r.prio != null ? { prio: Number(r.prio) } : {}),
  };
}

async function records(zone: string): Promise<DnsRecord[]> {
  const r = await call<{ records?: RawRecord[] }>('list-records', { domain: zone });
  return (r.records ?? []).map(rec);
}

function changed(zone: string, what: string, data: Record<string, unknown>) {
  changes++;
  link.log('info', what, { zone, ...data });
  link.emit({ t: 'dns.changed', zone });
  status();
}

async function add(zone: string, cmd: Command): Promise<DnsRecord> {
  const type = typeOf(cmd.type);
  const name = relName(String(cmd.name ?? ''), zone);
  const content = String(cmd.content ?? '');
  if (!content) throw new StatusError('a record needs content', 400);
  const params: Record<string, unknown> = { domain: zone, name, type, content, ttl: ttlOf(cmd.ttl) ?? DEFAULT_TTL };
  if (cmd.prio !== undefined) params.prio = Number(cmd.prio);
  const r = rec(await call<RawRecord>('add-record', params));
  changed(zone, 'record added', { name, type });
  return r;
}

async function edit(zone: string, id: string, cmd: { content?: unknown; ttl?: unknown; prio?: unknown }, current?: DnsRecord): Promise<DnsRecord> {
  const was = current ?? (await records(zone)).find((r) => r.id === id);
  if (!was) throw new StatusError(`${zone} has no record ${id}`, 404);
  // Njalla's edit-record takes the record whole: what is not changed is sent as it was.
  const params: Record<string, unknown> = { domain: zone, id, content: cmd.content !== undefined ? String(cmd.content) : was.content, ttl: ttlOf(cmd.ttl) ?? was.ttl ?? DEFAULT_TTL };
  const prio = cmd.prio !== undefined ? Number(cmd.prio) : was.prio;
  if (prio != null) params.prio = prio;
  const r = rec({ ...was, ...(await call<Partial<RawRecord>>('edit-record', params)), id });
  changed(zone, 'record changed', { name: was.name, type: was.type });
  return r;
}

async function remove(zone: string, id: string, known?: DnsRecord) {
  await call('remove-record', { domain: zone, id });
  changed(zone, 'record removed', known ? { name: known.name, type: known.type } : { id });
}

async function set(zone: string, cmd: Command) {
  const type = typeOf(cmd.type);
  const name = relName(String(cmd.name ?? ''), zone);
  const content = String(cmd.content ?? '');
  if (!content) throw new StatusError('a record needs content', 400);
  const ttl = ttlOf(cmd.ttl);
  const prio = cmd.prio === undefined ? undefined : Number(cmd.prio);
  const same = (await records(zone)).filter((r) => sameName(r.name, name) && r.type === type);
  const keep = same.find((r) => sameContent(r.content, content)) ?? same[0];
  const removed: string[] = [];
  let record: DnsRecord;
  let edited = false;
  if (!keep) {
    record = await add(zone, { t: 'dns.add', name, type, content, ttl, prio });
  } else if (!sameContent(keep.content, content) || (ttl !== undefined && keep.ttl !== ttl) || (prio !== undefined && keep.prio !== prio)) {
    record = await edit(zone, keep.id, { content, ttl, prio }, keep);
    edited = true;
  } else record = keep;
  for (const r of same) {
    if (r.id === keep?.id) continue;
    await remove(zone, r.id, r);
    removed.push(r.id);
  }
  return { record, changed: !keep || edited || removed.length > 0, removed };
}

async function handle(cmd: Command): Promise<unknown> {
  switch (cmd.t) {
    case 'dns.zones':
      await recheck();
      if (check && !check.ok) throw new StatusError(check.message ?? 'the token check failed', check.failure === 'auth' ? 401 : 502);
      return { zones };
    case 'dns.records':
      return { records: await records(zoneOf(cmd)) };
    case 'dns.add':
      return { record: await add(zoneOf(cmd), cmd) };
    case 'dns.edit': {
      const zone = zoneOf(cmd);
      return { record: await edit(zone, String(cmd.id ?? ''), { content: cmd.content, ttl: cmd.ttl, prio: cmd.prio }) };
    }
    case 'dns.remove': {
      const zone = zoneOf(cmd);
      const id = String(cmd.id ?? '');
      const known = (await records(zone)).find((r) => r.id === id);
      if (!known) throw new StatusError(`${zone} has no record ${id}`, 404);
      await remove(zone, id, known);
      return {};
    }
    case 'dns.set':
      return await set(zoneOf(cmd), cmd);
    default:
      throw new StatusError(`njalla has no operation "${cmd.t}"`, 400);
  }
}

status();
void recheck();
setInterval(() => void recheck(), RECHECK_MS).unref?.();
