/**
 * One .ics / webcal feed as one read-only calendar. A refresh asks with If-None-Match / If-Modified-Since when the
 * feed gave an ETag or Last-Modified (and the last copy is in memory), and compares a hash of the text otherwise; a
 * feed that did change is parsed and each event (master or changed instance, by uid and recurrence-id) hashed
 * without its DTSTAMP. Different hashes make a new version; a sync token names a version, and cal.changes answers the
 * events whose hash differs between the token's version and now, and the ids that are no longer there.
 *
 * Kept in the account's directory (ics-state.json): the validators, the text's hash, and the last few versions'
 * event ids and hashes, so tokens hold across a restart. The feed itself is kept only in memory; its URL (which is a
 * password for private feeds) only in secret.json.
 */
import type { CalEvent, Calendar } from '@dither-accounts/interfaces';
import { StatusError, type Link } from '@dither-accounts/link';
import { Cal, calendarZone, eventFrom, eventHash, expandEvents, invalid, parseInstant, seriesIn, seriesOf, type Series, zoneName } from '@dither-accounts/extractor-dav/ical';
import { decodeToken, encodeToken, JsonFile } from '@dither-accounts/extractor-dav/state';
import { join } from 'node:path';

export const CALENDAR_ID = 'feed';
const VERSIONS = 12;
const PAGE = 500;
const MAX_BYTES = 64 * 1024 * 1024;
const TOKEN = 'ics1';

export interface Secret {
  url?: string;
}
interface Version {
  id: string;
  at: number;
  /** Event id → hash. */
  entries: Record<string, string>;
}
interface Persist {
  v: 1;
  /** A hash of the URL these are for: a new URL starts over. */
  for: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  versions: Version[];
  lastChange: number | null;
}

/** webcal:// and webcals:// are https://; http(s) as given. Credentials in the URL become a Basic header. */
export function feedUrl(raw: string): { url: URL; auth: string | null } {
  let s = raw.trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const url = new URL(s);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid(`a feed is an https, http or webcal URL, not ${url.protocol}`);
  let auth: string | null = null;
  if (url.username || url.password) {
    auth = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
    url.username = '';
    url.password = '';
  }
  url.hash = '';
  return { url, auth };
}

const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('base64url').slice(0, 27);

interface Loaded {
  version: string;
  cal: Cal;
  series: Series[];
  /** Event id → the series it is of, and its VEVENT. */
  events: Map<string, { series: Series; comp: import('@dither-accounts/extractor-dav/ical').Comp; hash: string }>;
  calendar: Calendar;
  tasks: number;
}

export class Feed {
  private file: JsonFile<Persist>;
  st: Persist;
  loaded: Loaded | null = null;
  private refreshing: Promise<boolean> | null = null;
  private timer: Timer | null = null;
  private stopped = false;
  // Status.
  lastFetch: number | null = null;
  lastResult: string | null = null;
  problem: { kind: 'auth' | 'gone' | 'down' | 'bad' | 'config'; message: string; failures: number } | null = null;
  private lastStatus = '';

  constructor(
    private link: Link,
    private config: { pollSeconds?: number | string } = link.config,
  ) {
    this.file = new JsonFile<Persist>(join(link.accountDir, 'ics-state.json'), () => ({ v: 1, for: '', etag: null, lastModified: null, contentHash: null, versions: [], lastChange: null }));
    this.st = this.file.load();
    const key = sha(this.link.secret<Secret>().url ?? '');
    if (this.st.for !== key) this.st = { v: 1, for: key, etag: null, lastModified: null, contentHash: null, versions: [], lastChange: null };
  }

  get pollMs() {
    return Math.max(1, Number(this.config.pollSeconds) || 600) * 1000;
  }
  get host() {
    try {
      return feedUrl(this.link.secret<Secret>().url ?? '').url.host;
    } catch {
      return null;
    }
  }
  private save() {
    this.file.save(this.st);
  }
  private get current(): Version | null {
    return this.st.versions[this.st.versions.length - 1] ?? null;
  }

  start() {
    void this.tick();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  private async tick() {
    if (this.stopped) return;
    await this.refresh().catch(() => {});
    if (this.stopped) return;
    // Down: look again sooner (but not more often than the feed is polled anyway).
    const next = this.problem?.kind === 'down' ? Math.min(this.pollMs, 30_000) : this.pollMs;
    this.timer = setTimeout(() => void this.tick(), next);
  }

  /** Fetch it (conditionally) once at a time; true when a new version came of it. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.fetchOnce().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Loaded and no older than `maxAgeMs`, or why not. */
  async fresh(maxAgeMs = Math.min(this.pollMs, 60_000)): Promise<Loaded> {
    if (!this.loaded || !this.lastFetch || Date.now() - this.lastFetch > maxAgeMs) await this.refresh().catch(() => {});
    if (this.loaded) return this.loaded;
    const p = this.problem;
    if (!p) throw new StatusError('the feed is not loaded yet', 503);
    throw new StatusError(p.message, p.kind === 'auth' ? 401 : p.kind === 'gone' ? 404 : p.kind === 'down' ? 503 : p.kind === 'config' ? 400 : 502);
  }

  private fail(kind: NonNullable<Feed['problem']>['kind'], message: string) {
    this.problem = { kind, message, failures: (this.problem?.kind === kind ? this.problem.failures : 0) + 1 };
    this.link.log('warn', `feed: ${message}`);
    this.status();
  }

  private async fetchOnce(): Promise<boolean> {
    const raw = this.link.secret<Secret>().url;
    if (!raw) {
      this.fail('config', 'no feed URL in secret.json; set it on the accounts page');
      return false;
    }
    let target: ReturnType<typeof feedUrl>;
    try {
      target = feedUrl(raw);
    } catch (e) {
      this.fail('config', (e as Error).message);
      return false;
    }
    const headers: Record<string, string> = { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'user-agent': 'dither-accounts-ics/1' };
    if (target.auth) headers.authorization = target.auth;
    // Validators only when the copy they validate is here to keep.
    if (this.loaded && this.st.etag) headers['if-none-match'] = this.st.etag;
    if (this.loaded && this.st.lastModified) headers['if-modified-since'] = this.st.lastModified;
    let res: Response;
    try {
      res = await fetch(target.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    } catch (e: any) {
      this.fail('down', `${target.url.host} is not reachable: ${e?.name === 'TimeoutError' ? 'no answer in time' : String(e?.code ?? e?.message ?? e)}`);
      return false;
    }
    this.lastFetch = Date.now();
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {});
      this.lastResult = 'not modified (304)';
      this.ok();
      return false;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      this.fail('auth', `the feed refused access (${res.status}); the URL may have been reset: give the new one`);
      return false;
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      this.fail('gone', `the feed is gone (${res.status}); was it unpublished?`);
      return false;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      this.fail(res.status >= 500 ? 'down' : 'bad', `the feed answered ${res.status}`);
      return false;
    }
    const len = Number(res.headers.get('content-length'));
    if (len > MAX_BYTES) {
      await res.body?.cancel().catch(() => {});
      this.fail('bad', `the feed is ${Math.round(len / 1e6)} MB, more than ${MAX_BYTES / 1e6} MB`);
      return false;
    }
    const text = await res.text();
    const validators = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    const hash = sha(text);
    if (this.loaded && hash === this.st.contentHash) {
      Object.assign(this.st, validators);
      this.save();
      this.lastResult = 'unchanged (same content)';
      this.ok();
      return false;
    }
    let cal: Cal;
    try {
      cal = Cal.parse(text);
      // Dates and floating times are the calendar's own zone, when it names one.
      cal = new Cal(cal.comp, calendarZone(String(cal.comp.getFirstPropertyValue('x-wr-timezone') ?? '') || null));
    } catch (e) {
      this.fail('bad', `the feed is not iCalendar: ${(e as Error).message}`);
      return false;
    }
    const loaded = this.load(cal);
    const entries = Object.fromEntries([...loaded.events].map(([id, e]) => [id, e.hash]));
    const cur = this.current;
    let changed = false;
    if (cur && JSON.stringify(cur.entries) === JSON.stringify(entries)) {
      loaded.version = cur.id;
      this.lastResult = this.loaded ? 'fetched; no event changed' : 'fetched';
    } else {
      const v: Version = { id: crypto.randomUUID().slice(0, 13), at: Date.now(), entries };
      this.st.versions.push(v);
      if (this.st.versions.length > VERSIONS) this.st.versions.splice(0, this.st.versions.length - VERSIONS);
      this.st.lastChange = Date.now();
      loaded.version = v.id;
      changed = !!cur;
      this.lastResult = cur ? 'fetched; events changed' : 'fetched';
    }
    Object.assign(this.st, validators, { contentHash: hash });
    this.save();
    this.loaded = loaded;
    this.ok();
    if (changed) this.link.emit({ t: 'cal.changed', calendarId: CALENDAR_ID });
    return changed;
  }

  private ok() {
    if (this.problem) this.link.log('info', 'feed: fetched again');
    this.problem = null;
    this.status();
  }

  private load(cal: Cal): Loaded {
    const series = seriesOf(cal, 'split');
    const events = new Map<string, { series: Series; comp: any; hash: string }>();
    for (const s of series) {
      for (const comp of [...(s.master ? [s.master] : []), ...s.overrides]) {
        const rid = cal.time(comp.getFirstProperty('recurrence-id'));
        const id = rid ? `${s.key}#${cal.key(rid)}` : s.key;
        if (!events.has(id)) events.set(id, { series: s, comp, hash: eventHash(cal, comp) });
      }
    }
    const v = (n: string) => {
      const x = cal.comp.getFirstPropertyValue(n);
      return typeof x === 'string' && x.trim() ? x.trim() : null;
    };
    const color = (v('x-apple-calendar-color') ?? v('color'))?.match(/^#?([0-9a-f]{6})\b/i)?.[1];
    const tz = v('x-wr-timezone');
    return {
      version: '',
      cal,
      series,
      events,
      tasks: cal.comp.getAllSubcomponents('vtodo').length,
      calendar: {
        id: CALENDAR_ID,
        name: v('x-wr-calname') ?? v('name') ?? (this.link.label || this.host || 'Feed'),
        color: color ? `#${color.toUpperCase()}` : null,
        description: v('x-wr-caldesc') ?? v('description'),
        timeZone: tz ? zoneName(calendarZone(tz)) : null,
        readOnly: true,
        components: ['event'],
      },
    };
  }

  private event(l: Loaded, id: string): CalEvent {
    const e = l.events.get(id)!;
    return eventFrom(l.cal, e.comp, { calendarId: CALENDAR_ID, id: e.series.key, etag: `"${e.hash}"` });
  }

  // ---------------------------------------------------------------- ops

  private check(calendarId: unknown) {
    if (calendarId !== CALENDAR_ID) throw new StatusError(`no calendar "${String(calendarId)}" here; a feed is one calendar, "${CALENDAR_ID}"`, 404);
  }

  async calendars() {
    const l = await this.fresh(Infinity);
    return { calendars: [l.calendar] };
  }

  async events(i: { calendarId: string; from?: string; to?: string; expand?: boolean; pageToken?: string }) {
    this.check(i.calendarId);
    let pos = 0;
    let q = { from: i.from ?? null, to: i.to ?? null, expand: !!i.expand };
    let l: Loaded;
    if (i.pageToken) {
      const p = decodeToken<{ v: string; o: number; from: string | null; to: string | null; expand: boolean }>(`${TOKEN}p`, i.pageToken);
      if (!p) throw new StatusError('that is not a page token of this feed', 410);
      l = await this.fresh(Infinity);
      if (p.v !== l.version) throw new StatusError('the feed changed while paging: list again', 410);
      pos = p.o;
      q = { from: p.from, to: p.to, expand: p.expand };
    } else l = await this.fresh();
    const from = q.from ? parseInstant(q.from, 'from') : null;
    const to = q.to ? parseInstant(q.to, 'to') : null;
    if (q.expand && (from === null || to === null)) throw invalid('expand needs from and to');
    if (from !== null && to !== null && to <= from) throw invalid('to is not after from');
    const f = from ?? -8.64e15;
    const t = to ?? 8.64e15;
    const out: CalEvent[] = [];
    let n = pos;
    for (; n < l.series.length && out.length < PAGE; n++) {
      const s = l.series[n];
      const ctx = { calendarId: CALENDAR_ID, id: s.key, etag: null };
      if (q.expand) {
        out.push(...expandEvents(l.cal, s, ctx, f, t).map((e) => ({ ...e, etag: this.etagOf(l, e.id, s.key) })));
        continue;
      }
      if ((from !== null || to !== null) && !seriesIn(l.cal, s, f, t)) continue;
      for (const comp of [...(s.master ? [s.master] : []), ...s.overrides]) {
        const rid = l.cal.time(comp.getFirstProperty('recurrence-id'));
        out.push(this.event(l, rid ? `${s.key}#${l.cal.key(rid)}` : s.key));
      }
    }
    const done = n >= l.series.length;
    return {
      events: out,
      next: done ? null : encodeToken(`${TOKEN}p`, { v: l.version, o: n, ...q }),
      syncToken: done ? encodeToken(TOKEN, { v: l.version }) : null,
    };
  }

  /** An instance's etag: its override's hash when it is one, else its series'. */
  private etagOf(l: Loaded, id: string, key: string) {
    const h = l.events.get(id)?.hash ?? l.events.get(key)?.hash;
    return h ? `"${h}"` : null;
  }

  async changes(i: { calendarId: string; syncToken: string }) {
    this.check(i.calendarId);
    const t = decodeToken<{ v: string }>(TOKEN, i.syncToken);
    if (!t || typeof t.v !== 'string') throw new StatusError('that is not a sync token of this feed; list again', 410);
    const old = this.st.versions.find((v) => v.id === t.v);
    if (!old) throw new StatusError('the sync token is stale (that version of the feed is no longer kept): list again', 410);
    const l = await this.fresh();
    const cur = this.st.versions.find((v) => v.id === l.version)!;
    const changed: CalEvent[] = [];
    const removed: string[] = [];
    if (old.id !== cur.id) {
      for (const [id, h] of Object.entries(cur.entries)) if (old.entries[id] !== h && l.events.has(id)) changed.push(this.event(l, id));
      for (const id of Object.keys(old.entries)) if (!(id in cur.entries)) removed.push(id);
    }
    return { changed, removed, syncToken: encodeToken(TOKEN, { v: cur.id }), more: false };
  }

  readOnly(): never {
    throw new StatusError('a feed is read-only: change it where it is published', 403);
  }

  // ---------------------------------------------------------------- status

  layers() {
    const p = this.problem;
    const l = this.loaded;
    const when = this.lastFetch ? new Date(this.lastFetch).toISOString().slice(11, 16) + ' UTC' : null;
    const feed = p
      ? { name: 'feed', state: p.kind === 'down' && p.failures < 3 ? 'waiting' : 'failed', note: l ? `${p.message} (showing the copy from ${when})` : p.message }
      : this.lastFetch
        ? { name: 'feed', state: 'ok', note: `${this.host}: ${this.lastResult ?? 'fetched'} at ${when}; ${this.st.etag ? 'ETag' : this.st.lastModified ? 'Last-Modified' : 'content hash'}` }
        : { name: 'feed', state: 'waiting', note: `fetching ${this.host ?? 'the feed'}` };
    const calendar = l
      ? { name: 'calendar', state: 'ok', note: `${l.events.size} ${l.events.size === 1 ? 'event' : 'events'} in ${l.series.length} series${l.tasks ? ` (${l.tasks} ${l.tasks === 1 ? 'task' : 'tasks'} left out)` : ''}` }
      : p?.kind === 'bad'
        ? { name: 'calendar', state: 'failed', note: p.message }
        : { name: 'calendar', state: 'waiting', note: 'waits for the feed' };
    return [feed, calendar];
  }

  status(force = false) {
    const p = this.problem;
    const l = this.loaded;
    const state = p ? (p.kind === 'auth' || p.kind === 'gone' || p.kind === 'config' ? 'attention' : l ? 'online' : p.kind === 'down' && p.failures < 3 ? 'connecting' : 'error') : l ? 'online' : 'connecting';
    const ev = {
      t: 'status',
      status: state,
      attention: p && (p.kind === 'auth' || p.kind === 'gone' || p.kind === 'config') ? { kind: 'login', message: p.message } : null,
      self: { ...(l ? { displayName: l.calendar.name } : {}), ...(this.host ? { handle: this.host } : {}) },
      details: {
        host: this.host,
        events: l?.events.size ?? null,
        series: l?.series.length ?? null,
        version: l?.version ?? null,
        versionsKept: this.st.versions.length,
        refreshBy: this.st.etag ? 'ETag' : this.st.lastModified ? 'Last-Modified' : 'content hash',
        pollSeconds: this.pollMs / 1000,
        lastFetch: this.lastFetch ? new Date(this.lastFetch).toISOString() : null,
        lastChange: this.st.lastChange ? new Date(this.st.lastChange).toISOString() : null,
      },
      layers: this.layers(),
    };
    const s = JSON.stringify({ ...ev, details: { ...ev.details, lastFetch: null }, layers: ev.layers.map((x) => ({ ...x, note: x.name === 'feed' && x.state === 'ok' ? '' : x.note })) });
    if (!force && s === this.lastStatus) return;
    this.lastStatus = s;
    this.link.emit(ev);
  }
}
