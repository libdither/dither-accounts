/**
 * The page's state: the manager's /api/state, polled while the page is visible (the manager has no stream), the
 * activity counts, the route, and the small toasts and confirmations the sections use.
 */
import { computed, signal } from '@preact/signals';
import type { AccountInfo, AuditRow, GrantMatrix, IfaceTypes, ManagerState } from '../../src/api-types.ts';
import { nameOf } from './catalog.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  // Signed out (the session ended or was revoked): to the login, and back here after it.
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    throw new ApiError('sign in again', 401);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

export const state = signal<ManagerState | null>(null);
export const loadError = signal<string | null>(null);

export async function loadState() {
  try {
    state.value = await api<ManagerState>('/api/state');
    loadError.value = null;
  } catch (e) {
    loadError.value = (e as Error).message || 'the manager is not answering';
  }
}

/** Most writes answer with the whole state; take it, so the page never shows the old one after a click. */
export async function act<T = ManagerState>(path: string, opts: { method?: string; body?: unknown } = {}, done?: string): Promise<T | null> {
  try {
    const r = await api<T>(path, opts);
    if (r && typeof r === 'object' && 'apps' in (r as object) && 'accounts' in (r as object)) state.value = r as unknown as ManagerState;
    else void loadState();
    if (done) toast(done);
    return r;
  } catch (e) {
    toast((e as Error).message, 'error');
    return null;
  }
}

let poll: ReturnType<typeof setInterval> | null = null;
export function startPolling() {
  const tick = () => document.visibilityState === 'visible' && void loadState();
  poll ??= setInterval(tick, 2500);
  document.addEventListener('visibilitychange', tick);
}

// ---------------------------------------------------------------- activity

export const auditDays = signal<7 | 30 | 90>(7);
export const audit = signal<AuditRow[] | null>(null);
export async function loadAudit() {
  try {
    audit.value = (await api<{ rows: AuditRow[] }>(`/api/audit?days=${auditDays.value}`)).rows;
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// ---------------------------------------------------------------- the grant matrix

/** GET /api/matrix: who holds what on which account, and their calls there over the last 7 days. */
export const matrix = signal<GrantMatrix | null>(null);
export async function loadMatrix() {
  try {
    matrix.value = await api<GrantMatrix>('/api/matrix?days=7');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// ---------------------------------------------------------------- names

export const accountName = computed(() => new Map((state.value?.accounts ?? []).map((a) => [a.id, a])));
export const appName = computed(() => new Map((state.value?.apps ?? []).map((a) => [a.id, a.name])));
export const kindName = computed(() => new Map((state.value?.kinds ?? []).map((k) => [k.kind, k.name])));
/** What the page calls an account: its nickname, else who it is signed in as, else its kind (catalog.ts). */
export const named = (a: AccountInfo) => nameOf(a, kindName.value.get(a.kind) ?? a.kind);
export const pending = computed(() => (state.value?.apps ?? []).reduce((n, a) => n + a.requests.filter((r) => r.state === 'pending').length, 0));

// ---------------------------------------------------------------- route

export type Section = 'apps' | 'accounts' | 'activity' | 'interfaces' | 'sessions' | 'approvers';
/**
 * `#/accounts/<id>/<tab>`, `#/interfaces/<iface>/<op>`: the section and what is open in it. `#/` is the accounts'
 * overview, the page's home.
 */
export interface Route {
  section: Section;
  parts: string[];
}
const parse = (): Route => {
  const [head, ...parts] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').map(decodeURIComponent);
  const section = (['apps', 'activity', 'interfaces', 'sessions', 'approvers'] as const).includes(head as any) ? (head as Section) : 'accounts';
  return { section, parts: parts.filter(Boolean) };
};
export const route = signal<Route>(parse());
addEventListener('hashchange', () => (route.value = parse()));
export const section = computed(() => route.value.section);
export const href = (s: Section, ...parts: string[]) => (s === 'accounts' && !parts.length ? '#/' : `#/${[s, ...parts].map(encodeURIComponent).join('/')}`);
export const go = (s: Section, ...parts: string[]) => {
  location.hash = href(s, ...parts);
};

// ---------------------------------------------------------------- interface types (loaded once)

export const types = signal<Record<string, IfaceTypes> | null>(null);
let typesLoading = false;
export function loadTypes() {
  if (types.value || typesLoading) return;
  typesLoading = true;
  api<{ types: Record<string, IfaceTypes> }>('/api/interfaces')
    .then((r) => (types.value = r.types))
    .catch((e) => toast(`Could not load the interface types: ${(e as Error).message}`, 'error'))
    .finally(() => (typesLoading = false));
}

/** An account the page just added: its live view opens as soon as it offers one. */
export const openWhenReady = signal<string | null>(null);
/** What to do next with the account the page just added (its kind's Manifest.add.next), until it says more itself. */
export const addedNote = signal<{ id: string; text: string } | null>(null);

/** `?google_error=` from a sign-in that came back with an error, in the query or after the hash. */
export function takeQuery(name: string): string | null {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const v = q.get(name) ?? h.get(name);
  if (v !== null) {
    q.delete(name);
    h.delete(name);
    const hash = location.hash.split('?')[0] + (h.toString() ? `?${h}` : '');
    history.replaceState(history.state, '', location.pathname + (q.toString() ? `?${q}` : '') + hash);
  }
  return v;
}

// ---------------------------------------------------------------- toasts and confirmations

export const toasts = signal<{ id: number; text: string; kind: 'ok' | 'error' }[]>([]);
let seq = 0;
export function toast(text: string, kind: 'ok' | 'error' = 'ok') {
  const id = ++seq;
  toasts.value = [...toasts.value.filter((t) => t.text !== text), { id, text, kind }];
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 2500);
}

export const confirming = signal<{ title: string; body: string; yes: string; danger?: boolean; check?: string; resolve: (ok: boolean, checked: boolean) => void } | null>(null);
export function confirm(title: string, body: string, yes = 'Confirm', danger = true): Promise<boolean> {
  return new Promise((resolve) => (confirming.value = { title, body, yes, danger, resolve: (ok) => resolve(ok) }));
}
/** A confirmation with a box to tick (unticked to start): whether it was confirmed, and whether the box was ticked. */
export function confirmWith(title: string, body: string, yes: string, check: string): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => (confirming.value = { title, body, yes, danger: true, check, resolve: (ok, checked) => resolve({ ok, checked }) }));
}

// ---------------------------------------------------------------- formatting

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** "3 h 12 min" since a time. */
export function since(ms: number | null | undefined): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export async function copy(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast('Copy it by hand: the clipboard is not available here', 'error');
  }
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
