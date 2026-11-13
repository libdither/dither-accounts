/**
 * One CalDAV/CardDAV account: found once (discover.ts), its collections listed, kept up with by sync-collection
 * (RFC 6578) or, where a collection has no sync-token, by its getctag and the members' getetags, and watched by a
 * poll that says `cal.changed` / `contacts.changed` when a collection's token moves. Writes go with If-Match (and
 * If-None-Match: * for new ones), so a change someone else made in between fails with 412 rather than being lost.
 *
 * Kept in the account's directory (dav-state.json): where the account was found, each collection's last token, the
 * ids of the changed instances each event has had (so a removal names them all), and, for collections without
 * sync-collection, a few snapshots of their members' etags (what an app's token points at). The password stays in
 * secret.json; nothing an event or contact says is kept.
 */
import type { AddressBook, CalEvent, CalEventInput, Calendar, Contact, ContactInput } from '@dither-accounts/interfaces';
import { type Link, StatusError } from '@dither-accounts/link';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { discover, type Found, normalizeServer } from './discover.ts';
import { Cal, calendarZone, deleteInstance, expandEvents, invalid, parseInstant, seriesEvents, seriesIn, seriesOf, splitId, writeEvent, zoneName } from './ical.ts';
import { decodeToken, encodeToken, JsonFile } from './state.ts';
import type { Zone } from './tz.ts';
import { contactFrom, writeContact } from './vcard.ts';
import { AuthFailed, canonPath, canonSeg, children, DavClient, type DavResponse, elements, etagValue, hasType, httpError, NS, prop, propText, Unreachable, xmlEscape } from './webdav.ts';

export interface Config {
  server: string;
  username: string;
  /** Only when contacts are on another server than calendars. */
  contactsServer?: string;
  pollSeconds?: number | string;
  /** 'etag': never use sync-collection (tests; servers whose sync reports misbehave). */
  syncMode?: 'auto' | 'etag';
}
export interface Secret {
  password?: string;
}

type Kind = 'cal' | 'card';
interface Coll {
  id: string;
  url: string;
  kind: Kind;
  name: string;
  description: string | null;
  readOnly: boolean;
  syncToken: string | null;
  ctag: string | null;
  // calendars
  color: string | null;
  timeZone: string | null;
  zone: Zone;
  components: ('event' | 'task')[];
}
interface Snapshot {
  id: string;
  at: number;
  ctag: string | null;
  etags: Record<string, string>;
}
interface Persist {
  v: 1;
  /** What `found` was found for: a change of server or user name looks again. */
  for: string;
  found: Found | null;
  /** Collection id → what the poll last saw (sync-token, ctag, or a hash of its members' etags). */
  colls: Record<string, { kind: Kind; url: string; mark: string | null }>;
  polled: boolean;
  /**
   * Calendar → event resource → the ids of its changed instances now, and when each one that went was seen to go
   * (so a removal is named to every token older than that, and to no newer one).
   */
  overrides: Record<string, Record<string, Memo>>;
  /** Collections without sync-collection: the etag snapshots apps' tokens point at, newest last. */
  snapshots: Record<string, Snapshot[]>;
}
/** c: the collection; s: the server's sync-token, or e: an etag snapshot; t: when it was handed out. */
type AppToken = { c: string; s?: string; e?: string; t: number };
interface Memo {
  ids: string[];
  gone: Record<string, number>;
}

const PAGE = 100;
const MULTIGET = 100;
const SNAPSHOTS = 8;
/** How long a removed instance is remembered (an app whose token is older than that lists again anyway). */
const GONE_MS = 90 * 86_400_000;
const PAGE_TTL = 15 * 60_000;
const TOKEN = 'dav1';

const COLL_PROPS =
  '<d:resourcetype/><d:displayname/><d:current-user-privilege-set/><d:sync-token/><cs:getctag/><c:calendar-description/><c:calendar-timezone/><c:supported-calendar-component-set/><ical:calendar-color/><card:addressbook-description/>';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export class DavAccount {
  readonly client: DavClient;
  private file: JsonFile<Persist>;
  st: Persist;
  private cols = new Map<string, Coll>();
  private pages = new Map<string, { coll: Coll; ids: { id: string; etag: string | null }[]; pos: number; token: string; at: number; from: number | null; to: number | null; expand: boolean; filter: boolean }>();
  private initing: Promise<void> | null = null;
  private pollTimer: Timer | null = null;
  private stopped = false;
  // What the status says.
  private authError: string | null = null;
  private authAt = 0;
  private secretMtime = 0;
  private listed = false;
  private down: { message: string; failures: number } | null = null;
  private reached = false;
  private problem: string | null = null;
  private calError: string | null = null;
  private cardError: string | null = null;
  private lastPoll: number | null = null;
  private lastStatus = '';

  constructor(
    private link: Link,
    private config: Config = link.config as Config,
  ) {
    this.client = new DavClient(
      () => ({ username: this.config.username, password: this.link.secret<Secret>().password ?? '' }),
      { userAgent: 'dither-accounts-dav/1', log: (m) => this.link.log('debug', m) },
    );
    this.file = new JsonFile<Persist>(join(link.accountDir, 'dav-state.json'), () => ({ v: 1, for: '', found: null, colls: {}, polled: false, overrides: {}, snapshots: {} }));
    this.st = this.file.load();
    const key = this.forKey();
    if (this.st.for !== key) this.st = { ...this.file.load(), for: key, found: null, colls: {}, polled: false, overrides: {}, snapshots: {} };
  }

  private forKey = () => `${this.config.server ?? ''}|${this.config.username ?? ''}|${this.config.contactsServer ?? ''}`;
  private save() {
    this.file.save(this.st);
  }
  get pollMs() {
    return Math.max(5, Number(this.config.pollSeconds) || 120) * 1000;
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (!str(this.config.server) || !str(this.config.username)) {
      this.problem = 'the account has no server or user name in its config';
      this.status();
      return;
    }
    if (!this.link.secret<Secret>().password) {
      this.authError = 'no password in secret.json; set it on the accounts page';
      this.authAt = Date.now();
      this.status();
    }
    this.secretMtime = this.mtime();
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  private mtime() {
    try {
      return statSync(join(this.link.accountDir, 'secret.json')).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** The loop: get ready, then poll. After a refused password it waits for a new one (or 15 minutes). */
  private async tick() {
    if (this.stopped) return;
    let next = this.pollMs;
    try {
      if (this.authError) {
        // Not again with the password it refused (servers lock accounts out): a new one, or a quarter of an hour.
        const m = this.mtime();
        if (m === this.secretMtime && Date.now() - this.authAt < 15 * 60_000) {
          next = 5000;
          return;
        }
        this.secretMtime = m;
        this.authError = null;
      }
      await this.ready();
      await this.poll();
    } catch (e) {
      if (this.down) next = Math.min(this.pollMs, 30_000);
      if (!(e instanceof AuthFailed) && !(e instanceof Unreachable)) this.link.log('warn', `poll: ${(e as Error).message}`);
    } finally {
      this.status();
      if (!this.stopped) this.pollTimer = setTimeout(() => void this.tick(), next);
    }
  }

  /** Every server call goes through here: it notes the server up or down, and a refused sign-in. */
  private async net<T>(f: () => Promise<T>): Promise<T> {
    try {
      const out = await f();
      this.reached = true;
      if (this.down) {
        this.link.log('info', `${this.origin()} answers again`);
        this.down = null;
        this.status();
      }
      return out;
    } catch (e) {
      if (e instanceof Unreachable) {
        this.down = { message: e.message, failures: (this.down?.failures ?? 0) + 1 };
        this.status();
      } else if (e instanceof AuthFailed) {
        this.reached = true;
        this.down = null;
        this.authError = e.message;
        this.authAt = Date.now();
        this.secretMtime = this.mtime();
        this.link.log('warn', `sign-in refused: ${e.message}`);
        this.status();
      }
      throw e;
    }
  }

  /** Found and listed, or why not (401, 503, 404). */
  async ready(): Promise<void> {
    if (this.problem) throw new StatusError(this.problem, 400);
    if (this.authError) throw new StatusError(this.authError, 401);
    if (this.st.found && this.listed) return;
    this.initing ??= this.init().finally(() => (this.initing = null));
    return this.initing;
  }

  private async init(again = false): Promise<void> {
    const remembered = !!this.st.found;
    if (!this.st.found) {
      const found = await this.net(() => discover(this.client, this.config.server, { contactsServer: this.config.contactsServer ?? null, log: (m) => this.link.log('info', m) }));
      this.st.found = found;
      this.save();
      this.link.log('info', `found: principal ${new URL(found.principal).pathname}, calendars ${found.calHome ? new URL(found.calHome).pathname : 'none'}, address books ${found.cardHome ? new URL(found.cardHome).pathname : 'none'}`);
    } else {
      this.client.trust(normalizeServer(this.config.server));
      if (this.config.contactsServer) this.client.trust(normalizeServer(this.config.contactsServer));
    }
    try {
      await Promise.all([this.listColls('cal'), this.listColls('card')]);
    } catch (e) {
      // A home that is gone (the server moved things): look the account up again, once.
      if (remembered && !again && e instanceof StatusError && (e.status === 404 || e.status === 410)) {
        this.link.log('info', 'a home it remembered is gone; looking again');
        this.st.found = null;
        this.calError = this.cardError = null;
        return this.init(true);
      }
      throw e;
    }
    this.listed = true;
    this.status();
  }

  private origin() {
    try {
      return new URL(this.st.found?.principal ?? normalizeServer(this.config.server)).origin;
    } catch {
      return String(this.config.server);
    }
  }

  // ---------------------------------------------------------------- status

  layers() {
    const f = this.st.found;
    const server = this.problem
      ? { name: 'server', state: 'failed', note: this.problem }
      : this.down
        ? { name: 'server', state: this.down.failures >= 3 ? 'failed' : 'waiting', note: this.down.message }
        : this.reached || f
          ? { name: 'server', state: 'ok', note: `${this.origin()}${this.client.server ? ` (${this.client.server})` : ''}` }
          : { name: 'server', state: 'waiting', note: `connecting to ${this.config.server ?? '?'}` };
    const signedIn = this.authError
      ? { name: 'signed in', state: 'failed', note: this.authError }
      : f && !this.down
        ? { name: 'signed in', state: 'ok', note: `as ${this.config.username}${f.displayName ? ` (${f.displayName})` : ''}` }
        : { name: 'signed in', state: 'waiting', note: 'waits for the server' };
    const coll = (kind: Kind, name: string, home: string | null | undefined, err: string | null, what: string) => {
      if (!f || this.authError || this.down) return { name, state: 'waiting', note: 'waits for the sign-in' };
      if (!home) return { name, state: 'off', note: `this server has no ${what} for this user` };
      if (err) return { name, state: 'failed', note: err };
      const all = [...this.cols.values()].filter((c) => c.kind === kind);
      const ro = all.filter((c) => c.readOnly).length;
      const sync = all.filter((c) => this.mode(c) === 'sync').length;
      const count = `${all.length} ${all.length === 1 ? what.replace(/s$/, '') : what}`;
      return { name, state: 'ok', note: `${count}${ro ? `, ${ro} read-only` : ''}${all.length ? `; ${sync === all.length ? 'sync-collection' : sync ? `sync-collection for ${sync}, etags for the rest` : 'by etags'}` : ''}` };
    };
    return [server, signedIn, coll('cal', 'calendars', f?.calHome, this.calError, 'calendars'), coll('card', 'address books', f?.cardHome, this.cardError, 'address books')];
  }

  status(force = false) {
    const layers = this.layers();
    const f = this.st.found;
    const state = this.problem ? 'error' : this.authError ? 'attention' : this.down ? (this.down.failures >= 3 ? 'error' : 'connecting') : f ? 'online' : 'connecting';
    const all = [...this.cols.values()];
    const ev = {
      t: 'status',
      status: state,
      attention: this.authError ? { kind: 'login', message: `${this.authError}. Replace the password (an app password, for iCloud, Fastmail and the like) on the accounts page.` } : null,
      self: { handle: this.config.username, ...(f?.displayName ? { displayName: f.displayName } : {}), ...(f?.email ? { email: f.email } : {}) },
      details: {
        server: this.origin(),
        username: this.config.username ?? null,
        principal: f ? new URL(f.principal).pathname : null,
        calendarHome: f?.calHome ?? null,
        addressBookHome: f?.cardHome ?? null,
        calendars: all.filter((c) => c.kind === 'cal').length,
        addressBooks: all.filter((c) => c.kind === 'card').length,
        auth: this.client.scheme,
        product: this.client.server || null,
        pollSeconds: this.pollMs / 1000,
        lastPoll: this.lastPoll ? new Date(this.lastPoll).toISOString() : null,
      },
      layers,
    };
    const s = JSON.stringify({ ...ev, details: { ...ev.details, lastPoll: null } });
    if (!force && s === this.lastStatus) return;
    this.lastStatus = s;
    this.link.emit(ev);
  }

  // ---------------------------------------------------------------- collections

  private mode(c: Coll): 'sync' | 'etag' {
    return this.config.syncMode !== 'etag' && c.syncToken ? 'sync' : 'etag';
  }

  private collFrom(r: DavResponse, kind: Kind): Coll {
    const u = new URL(r.href);
    const id = canonPath(u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`);
    const privs = prop(r, NS.d, 'current-user-privilege-set');
    const granted = privs ? children(privs, NS.d, 'privilege').flatMap((p) => elements(p).map((e) => e.localName)) : null;
    const readOnly = granted ? !granted.some((g) => g === 'all' || g === 'write' || g === 'write-content') : false;
    const comps = prop(r, NS.c, 'supported-calendar-component-set');
    const names = comps ? children(comps, NS.c, 'comp').map((e) => String(e.getAttribute('name')).toUpperCase()) : ['VEVENT'];
    const tz = propText(r, NS.c, 'calendar-timezone');
    const zone = calendarZone(tz);
    const color = propText(r, NS.ical, 'calendar-color')?.match(/^#?([0-9a-f]{6})/i)?.[1];
    return {
      id,
      url: u.href.endsWith('/') ? u.href : `${u.href}/`,
      kind,
      name: propText(r, NS.d, 'displayname') ?? decodeURIComponent(id.split('/').filter(Boolean).pop() ?? id),
      description: kind === 'cal' ? propText(r, NS.c, 'calendar-description') : propText(r, NS.card, 'addressbook-description'),
      readOnly,
      syncToken: propText(r, NS.d, 'sync-token'),
      ctag: propText(r, NS.cs, 'getctag'),
      color: color ? `#${color.toUpperCase()}` : null,
      timeZone: tz ? zoneName(zone) : null,
      zone,
      components: [...(names.includes('VEVENT') ? ['event' as const] : []), ...(names.includes('VTODO') ? ['task' as const] : [])],
    };
  }

  private async listColls(kind: Kind): Promise<Coll[]> {
    const home = kind === 'cal' ? this.st.found?.calHome : this.st.found?.cardHome;
    if (!home) return [];
    try {
      const { responses } = await this.net(() => this.client.propfind(home, COLL_PROPS, 1));
      const out = responses.filter((r) => hasType(r, kind === 'cal' ? NS.c : NS.card, kind === 'cal' ? 'calendar' : 'addressbook')).map((r) => this.collFrom(r, kind));
      for (const [id, c] of this.cols) if (c.kind === kind) this.cols.delete(id);
      for (const c of out) this.cols.set(c.id, c);
      if (kind === 'cal') this.calError = null;
      else this.cardError = null;
      return out;
    } catch (e) {
      if (e instanceof AuthFailed || e instanceof Unreachable) throw e;
      const msg = `listing ${new URL(home).pathname}: ${(e as Error).message}`;
      if (kind === 'cal') this.calError = msg;
      else this.cardError = msg;
      throw e;
    }
  }

  private async coll(kind: Kind, id: unknown): Promise<Coll> {
    if (typeof id !== 'string' || !id) throw invalid(kind === 'cal' ? 'calendarId is needed' : 'bookId is needed');
    await this.ready();
    let c = this.cols.get(id);
    if (!c || c.kind !== kind) {
      await this.listColls(kind);
      c = this.cols.get(id);
    }
    if (!c || c.kind !== kind) throw new StatusError(`no ${kind === 'cal' ? 'calendar' : 'address book'} "${id}" in this account`, 404);
    return c;
  }

  // ---------------------------------------------------------------- members, tokens, reports

  private memberId(c: Coll, href: string): string | null {
    const u = new URL(href);
    const p = canonPath(u.pathname);
    if (!p.startsWith(c.id) || p === c.id) return null;
    const rest = p.slice(c.id.length);
    return rest && !rest.includes('/') ? rest : null;
  }
  private memberUrl(c: Coll, id: string) {
    if (!id || id.includes('/') || id === '.' || id === '..') throw invalid(`not an id in this ${c.kind === 'cal' ? 'calendar' : 'address book'}: ${id}`);
    return new URL(canonSeg(id), c.url).href;
  }

  /** Every member and its etag. */
  private async members(c: Coll): Promise<{ id: string; etag: string | null }[]> {
    const { responses } = await this.net(() => this.client.propfind(c.url, '<d:getetag/><d:resourcetype/><d:getcontenttype/>', 1));
    return responses
      .filter((r) => !prop(r, NS.d, 'resourcetype') || !elements(prop(r, NS.d, 'resourcetype')!).length)
      .map((r) => ({ id: this.memberId(c, r.href), etag: propText(r, NS.d, 'getetag') }))
      .filter((m): m is { id: string; etag: string | null } => !!m.id);
  }

  /** The members a calendar-query with a time-range names; null when the server will not do one. */
  private async timeQuery(c: Coll, from: number | null, to: number | null): Promise<{ id: string; etag: string | null }[] | null> {
    const t = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const range = `<c:time-range${from !== null ? ` start="${t(from)}"` : ''}${to !== null ? ` end="${t(to)}"` : ''}/>`;
    const body = `<c:calendar-query ${XMLNS_ALL}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${range}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    try {
      const { responses } = await this.net(() => this.client.report(c.url, body, 1));
      return responses.map((r) => ({ id: this.memberId(c, r.href), etag: propText(r, NS.d, 'getetag') })).filter((m): m is { id: string; etag: string | null } => !!m.id);
    } catch (e) {
      if (e instanceof StatusError && [400, 403, 405, 415, 501, 507].includes(e.status)) {
        this.link.log('info', `${c.id}: no time-range query (${e.status}); filtering here`);
        return null;
      }
      throw e;
    }
  }

  /** The data and etags of members, by multiget, a hundred at a time. */
  private async multiget(c: Coll, ids: string[]): Promise<{ id: string; etag: string | null; data: string }[]> {
    const out: { id: string; etag: string | null; data: string }[] = [];
    const [el, data] = c.kind === 'cal' ? ['c:calendar-multiget', 'c:calendar-data'] : ['card:addressbook-multiget', 'card:address-data'];
    for (let i = 0; i < ids.length; i += MULTIGET) {
      const chunk = ids.slice(i, i + MULTIGET);
      const hrefs = chunk.map((id) => `<d:href>${xmlEscape(new URL(this.memberUrl(c, id)).pathname)}</d:href>`).join('');
      const { responses } = await this.net(() => this.client.report(c.url, `<${el} ${XMLNS_ALL}><d:prop><d:getetag/><${data}/></d:prop>${hrefs}</${el}>`, 1));
      for (const r of responses) {
        const id = this.memberId(c, r.href);
        const d = propText(r, c.kind === 'cal' ? NS.c : NS.card, c.kind === 'cal' ? 'calendar-data' : 'address-data');
        if (id && d) out.push({ id, etag: propText(r, NS.d, 'getetag'), data: d });
      }
    }
    return out;
  }

  private async get(c: Coll, id: string): Promise<{ text: string; etag: string | null } | null> {
    const res = await this.net(() => this.client.request('GET', this.memberUrl(c, id), { headers: { accept: c.kind === 'cal' ? 'text/calendar' : 'text/vcard' } }));
    const text = await res.text();
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw httpError(res.status, 'GET', text);
    return { text, etag: res.headers.get('etag') };
  }

  private async put(c: Coll, id: string, text: string, cond: { ifMatch?: string | null; create?: boolean }): Promise<void> {
    const headers: Record<string, string> = { 'content-type': c.kind === 'cal' ? 'text/calendar; charset=utf-8' : 'text/vcard; charset=utf-8' };
    if (cond.create) headers['if-none-match'] = '*';
    else if (cond.ifMatch) headers['if-match'] = cond.ifMatch;
    const res = await this.net(() => this.client.request('PUT', this.memberUrl(c, id), { headers, body: text }));
    const body = await res.text();
    if (res.ok) return;
    if (res.status === 412 && cond.create) throw new StatusError('there is already one with this uid here', 412);
    throw httpError(res.status, 'PUT', body);
  }

  private async del(c: Coll, id: string, ifMatch?: string | null): Promise<void> {
    const res = await this.net(() => this.client.request('DELETE', this.memberUrl(c, id), { headers: ifMatch ? { 'if-match': ifMatch } : {} }));
    const body = await res.text();
    if (res.ok) return;
    if (res.status === 404) throw new StatusError('no such item (already deleted?)', 404);
    throw httpError(res.status, 'DELETE', body);
  }

  /** A token for "now" in a collection: its sync-token, or a snapshot of its members' etags. */
  private async tokenNow(c: Coll): Promise<{ token: string; members?: { id: string; etag: string | null }[] }> {
    if (this.mode(c) === 'sync') {
      const { responses } = await this.net(() => this.client.propfind(c.url, '<d:sync-token/>', 0));
      const t = responses[0] ? propText(responses[0], NS.d, 'sync-token') : null;
      if (t) return { token: encodeToken(TOKEN, { c: c.id, s: t, t: Date.now() } satisfies AppToken) };
    }
    const snap = await this.snapshot(c);
    return { token: encodeToken(TOKEN, { c: c.id, e: snap.snap.id, t: Date.now() } satisfies AppToken), members: snap.members };
  }

  private async snapshot(c: Coll): Promise<{ snap: Snapshot; members: { id: string; etag: string | null }[] }> {
    const [head, members] = await Promise.all([this.net(() => this.client.propfind(c.url, '<cs:getctag/>', 0)), this.members(c)]);
    const ctag = head.responses[0] ? propText(head.responses[0], NS.cs, 'getctag') : null;
    const etags = Object.fromEntries(members.map((m) => [m.id, etagValue(m.etag) ?? '']));
    const list = (this.st.snapshots[c.id] ??= []);
    const last = list[list.length - 1];
    if (last && JSON.stringify(last.etags) === JSON.stringify(etags)) return { snap: last, members };
    const snap: Snapshot = { id: crypto.randomUUID().slice(0, 13), at: Date.now(), ctag, etags };
    list.push(snap);
    if (list.length > SNAPSHOTS) list.splice(0, list.length - SNAPSHOTS);
    this.save();
    return { snap, members };
  }

  /** What changed since an app's token: members changed (with etags) and removed, the next token, and whether there is more. */
  /** `at`: when the app's token was handed out. */
  private async since(c: Coll, token: string): Promise<{ changed: { id: string; etag: string | null }[]; removed: string[]; token: () => string; more: boolean; at: number }> {
    const t = decodeToken<AppToken>(TOKEN, token);
    if (!t || typeof t.c !== 'string') throw new StatusError('that is not a sync token from this account; list again', 410);
    if (t.c !== c.id) throw invalid(`that sync token is for ${t.c}, not ${c.id}`);
    if (t.s) {
      const body = `<d:sync-collection ${XMLNS_ALL}><d:sync-token>${xmlEscape(t.s)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
      let r: Awaited<ReturnType<DavClient['report']>>;
      try {
        r = await this.net(() => this.client.report(c.url, body, 1));
      } catch (e) {
        if (e instanceof StatusError && (e.status === 410 || ((e.status === 403 || e.status === 409 || e.status === 412 || e.status === 400) && (e as any).condition === 'valid-sync-token'))) {
          throw new StatusError('the sync token is stale (the server no longer knows it): list again', 410);
        }
        throw e;
      }
      const changed: { id: string; etag: string | null }[] = [];
      const removed: string[] = [];
      let more = false;
      for (const x of r.responses) {
        const id = this.memberId(c, x.href);
        if (!id) {
          if (x.status === 507) more = true;
          continue;
        }
        if (x.status === 404) removed.push(id);
        else changed.push({ id, etag: propText(x, NS.d, 'getetag') });
      }
      if (!r.syncToken) throw new StatusError('the server sent no new sync token', 502);
      // The new token is made last: what this call notes as gone is then older than it.
      const s = r.syncToken;
      return { changed, removed, token: () => encodeToken(TOKEN, { c: c.id, s, t: Date.now() } satisfies AppToken), more, at: Number(t.t) || 0 };
    }
    const old = (this.st.snapshots[c.id] ?? []).find((s) => s.id === t.e);
    if (!old) throw new StatusError('the sync token is stale (its snapshot is gone): list again', 410);
    const { snap } = await this.snapshot(c);
    const changed = Object.entries(snap.etags)
      .filter(([id, e]) => old.etags[id] !== e)
      .map(([id, etag]) => ({ id, etag }));
    const removed = Object.keys(old.etags).filter((id) => !(id in snap.etags));
    return { changed, removed, token: () => encodeToken(TOKEN, { c: c.id, e: snap.id, t: Date.now() } satisfies AppToken), more: false, at: Number(t.t) || 0 };
  }

  // ---------------------------------------------------------------- calendar ops

  async calendars(): Promise<{ calendars: Calendar[] }> {
    await this.ready();
    const list = await this.listColls('cal');
    return { calendars: list.map((c) => ({ id: c.id, name: c.name, color: c.color, description: c.description, timeZone: c.timeZone, readOnly: c.readOnly, components: c.components })) };
  }

  /** A resource's events, with the overrides it has had noted. */
  private resourceEvents(c: Coll, r: { id: string; etag: string | null; data: string }, view: { from: number | null; to: number | null; expand: boolean; filter: boolean }): CalEvent[] {
    let cal: Cal;
    try {
      cal = Cal.parse(r.data, c.zone);
    } catch (e) {
      this.link.log('warn', `${c.id}${r.id}: ${(e as Error).message}`);
      return [];
    }
    const s = seriesOf(cal)[0];
    if (!s) return [];
    const ctx = { calendarId: c.id, id: r.id, etag: r.etag };
    const evs = seriesEvents(cal, s, ctx);
    this.noteOverrides(c, r.id, evs.filter((e) => e.recurrenceId).map((e) => e.id));
    const from = view.from ?? -8.64e15;
    const to = view.to ?? 8.64e15;
    if (view.expand) return expandEvents(cal, s, ctx, from, to);
    if (view.filter && (view.from !== null || view.to !== null) && !seriesIn(cal, s, from, to)) return [];
    return evs;
  }

  /** A resource's changed instances as they are now (null: the resource is gone); the ones no longer there are gone as of now. */
  private noteOverrides(c: Coll, id: string, ids: string[] | null) {
    const m = (this.st.overrides[c.id] ??= {});
    const e: Memo = m[id] ? { ids: [...m[id].ids], gone: { ...m[id].gone } } : { ids: [], gone: {} };
    const now = Date.now();
    const keep = new Set(ids ?? []);
    for (const x of e.ids) if (!keep.has(x)) e.gone[x] = now;
    if (ids === null) e.gone[id] = now;
    for (const x of keep) delete e.gone[x];
    e.ids = [...keep];
    for (const [x, at] of Object.entries(e.gone)) if (now - at > GONE_MS) delete e.gone[x];
    const before = JSON.stringify(m[id] ?? null);
    if (!e.ids.length && !Object.keys(e.gone).length) delete m[id];
    else m[id] = e;
    if (JSON.stringify(m[id] ?? null) !== before) this.dirty = true;
  }
  /** The instances of a resource seen to go after `since`. */
  private goneSince(c: Coll, id: string, since: number): string[] {
    const e = this.st.overrides[c.id]?.[id];
    return e ? Object.entries(e.gone).filter(([x, at]) => at > since && x !== id).map(([x]) => x) : [];
  }
  private dirty = false;
  private flush() {
    if (this.dirty) {
      this.dirty = false;
      this.save();
    }
  }

  async events(i: { calendarId: string; from?: string; to?: string; expand?: boolean; pageToken?: string }) {
    if (i.pageToken) return this.eventsPage(i.pageToken);
    const c = await this.coll('cal', i.calendarId);
    const from = i.from ? parseInstant(i.from, 'from') : null;
    const to = i.to ? parseInstant(i.to, 'to') : null;
    if (i.expand && (from === null || to === null)) throw invalid('expand needs from and to');
    if (from !== null && to !== null && to <= from) throw invalid('to is not after from');
    const tok = await this.tokenNow(c);
    let ids: { id: string; etag: string | null }[] | null = null;
    let filter = false;
    if (from !== null || to !== null) {
      ids = await this.timeQuery(c, from, to);
      if (!ids) filter = true;
    }
    ids ??= tok.members ?? (await this.members(c));
    const pid = crypto.randomUUID();
    this.prunePages();
    this.pages.set(pid, { coll: c, ids, pos: 0, token: tok.token, at: Date.now(), from, to, expand: !!i.expand, filter });
    return this.eventsPage(pid);
  }

  private prunePages() {
    for (const [k, p] of this.pages) if (Date.now() - p.at > PAGE_TTL) this.pages.delete(k);
    while (this.pages.size > 50) this.pages.delete(this.pages.keys().next().value!);
  }

  private async eventsPage(pid: string) {
    const p = this.pages.get(pid);
    if (!p) throw new StatusError('that page token expired (or the extractor restarted): list again', 410);
    const chunk = p.ids.slice(p.pos, p.pos + PAGE);
    const res = await this.multiget(p.coll, chunk.map((x) => x.id));
    p.pos += chunk.length;
    p.at = Date.now();
    const events = res.flatMap((r) => this.resourceEvents(p.coll, r, p));
    this.flush();
    const done = p.pos >= p.ids.length;
    if (done) this.pages.delete(pid);
    return { events, next: done ? null : pid, syncToken: done ? p.token : null };
  }

  async changes(i: { calendarId: string; syncToken: string }) {
    const c = await this.coll('cal', i.calendarId);
    const d = await this.since(c, i.syncToken);
    const res = await this.multiget(c, d.changed.map((x) => x.id));
    const changed: CalEvent[] = [];
    const removed: string[] = [];
    for (const r of res) {
      const evs = this.resourceEvents(c, r, { from: null, to: null, expand: false, filter: false });
      changed.push(...evs);
      removed.push(...this.goneSince(c, r.id, d.at));
    }
    // Members that changed but are gone by the time they were fetched count as removed.
    const got = new Set(res.map((r) => r.id));
    for (const x of d.changed) if (!got.has(x.id)) d.removed.push(x.id);
    for (const id of d.removed) {
      this.noteOverrides(c, id, null);
      removed.push(id, ...this.goneSince(c, id, d.at));
    }
    this.flush();
    return { changed, removed: [...new Set(removed)], syncToken: d.token(), more: d.more };
  }

  private writable(c: Coll) {
    if (c.readOnly) throw new StatusError(`${c.kind === 'cal' ? 'calendar' : 'address book'} "${c.name}" is read-only for this account`, 403);
  }

  async putEvent(i: { calendarId: string; id?: string; event: CalEventInput; ifMatch?: string }): Promise<CalEvent> {
    const c = await this.coll('cal', i.calendarId);
    this.writable(c);
    if (!i.event || typeof i.event !== 'object') throw invalid('event is needed');
    let rid: string;
    let want: string;
    if (!i.id) {
      const { text, uid } = writeEvent(null, { kind: 'new' }, i.event);
      rid = /^[A-Za-z0-9._@=+-]{1,120}$/.test(uid) ? `${uid}.ics` : `${crypto.randomUUID()}.ics`;
      await this.put(c, rid, text, { create: true });
      want = rid;
    } else {
      const { series, key } = splitId(i.id);
      rid = series;
      want = i.id;
      for (let attempt = 0; ; attempt++) {
        const cur = await this.get(c, series);
        if (!cur) throw new StatusError('no such event (deleted?)', 404);
        if (i.ifMatch && etagValue(i.ifMatch) !== etagValue(cur.etag)) throw new StatusError('the event changed since that etag', 412);
        const { text } = writeEvent(Cal.parse(cur.text, c.zone), key ? { kind: 'instance', key } : { kind: 'master' }, i.event);
        try {
          await this.put(c, series, text, { ifMatch: i.ifMatch ?? cur.etag });
          break;
        } catch (e) {
          // Someone else's change landed between our read and write: read it again, unless the app named an etag.
          if (e instanceof StatusError && e.status === 412 && !i.ifMatch && attempt < 1) continue;
          throw e;
        }
      }
    }
    const back = await this.get(c, rid);
    if (!back) throw new StatusError('the server took the event but does not give it back', 502);
    const evs = this.resourceEvents(c, { id: rid, etag: back.etag, data: back.text }, { from: null, to: null, expand: false, filter: false });
    this.flush();
    this.changed(c);
    const ev = evs.find((e) => e.id === want) ?? evs[0];
    if (!ev) throw new StatusError('the server took the event but it has no VEVENT now', 502);
    return ev;
  }

  async deleteEvent(i: { calendarId: string; id: string; ifMatch?: string }) {
    const c = await this.coll('cal', i.calendarId);
    this.writable(c);
    if (typeof i.id !== 'string' || !i.id) throw invalid('id is needed');
    const { series, key } = splitId(i.id);
    if (!key) {
      await this.del(c, series, i.ifMatch);
    } else {
      const cur = await this.get(c, series);
      if (!cur) throw new StatusError('no such event (deleted?)', 404);
      if (i.ifMatch && etagValue(i.ifMatch) !== etagValue(cur.etag)) throw new StatusError('the event changed since that etag', 412);
      const text = deleteInstance(Cal.parse(cur.text, c.zone), key);
      if (text === null) await this.del(c, series, i.ifMatch ?? cur.etag);
      else await this.put(c, series, text, { ifMatch: i.ifMatch ?? cur.etag });
    }
    this.changed(c);
    return {};
  }

  // ---------------------------------------------------------------- contacts ops

  async books(): Promise<{ books: AddressBook[] }> {
    await this.ready();
    const list = await this.listColls('card');
    return { books: list.map((c) => ({ id: c.id, name: c.name, description: c.description, readOnly: c.readOnly })) };
  }

  private contactOf(c: Coll, r: { id: string; etag: string | null; data: string }): Contact | null {
    try {
      return contactFrom(r.data, { bookId: c.id, id: r.id, etag: r.etag });
    } catch (e) {
      this.link.log('warn', `${c.id}${r.id}: ${(e as Error).message}`);
      return null;
    }
  }

  private cpages = new Map<string, { coll: Coll; ids: string[]; pos: number; token: string; at: number }>();
  async contactsList(i: { bookId: string; pageToken?: string }) {
    let pid = i.pageToken;
    if (!pid) {
      const c = await this.coll('card', i.bookId);
      const tok = await this.tokenNow(c);
      const ids = (tok.members ?? (await this.members(c))).map((m) => m.id);
      pid = crypto.randomUUID();
      for (const [k, p] of this.cpages) if (Date.now() - p.at > PAGE_TTL) this.cpages.delete(k);
      this.cpages.set(pid, { coll: c, ids, pos: 0, token: tok.token, at: Date.now() });
    }
    const p = this.cpages.get(pid);
    if (!p) throw new StatusError('that page token expired (or the extractor restarted): list again', 410);
    const chunk = p.ids.slice(p.pos, p.pos + PAGE);
    const res = await this.multiget(p.coll, chunk);
    p.pos += chunk.length;
    p.at = Date.now();
    const done = p.pos >= p.ids.length;
    if (done) this.cpages.delete(pid);
    return { contacts: res.map((r) => this.contactOf(p.coll, r)).filter((x): x is Contact => !!x), next: done ? null : pid, syncToken: done ? p.token : null };
  }

  async contactsChanges(i: { bookId: string; syncToken: string }) {
    const c = await this.coll('card', i.bookId);
    const d = await this.since(c, i.syncToken);
    const res = await this.multiget(c, d.changed.map((x) => x.id));
    const got = new Set(res.map((r) => r.id));
    const removed = [...d.removed, ...d.changed.filter((x) => !got.has(x.id)).map((x) => x.id)];
    return { changed: res.map((r) => this.contactOf(c, r)).filter((x): x is Contact => !!x), removed: [...new Set(removed)], syncToken: d.token(), more: d.more };
  }

  async putContact(i: { bookId: string; id?: string; contact: ContactInput; ifMatch?: string }): Promise<Contact> {
    const c = await this.coll('card', i.bookId);
    this.writable(c);
    if (!i.contact || typeof i.contact !== 'object') throw invalid('contact is needed');
    let rid: string;
    if (!i.id) {
      const { text, uid } = writeContact(null, i.contact);
      rid = /^[A-Za-z0-9._@=+-]{1,120}$/.test(uid) ? `${uid}.vcf` : `${crypto.randomUUID()}.vcf`;
      await this.put(c, rid, text, { create: true });
    } else {
      rid = i.id;
      for (let attempt = 0; ; attempt++) {
        const cur = await this.get(c, rid);
        if (!cur) throw new StatusError('no such contact (deleted?)', 404);
        if (i.ifMatch && etagValue(i.ifMatch) !== etagValue(cur.etag)) throw new StatusError('the contact changed since that etag', 412);
        const { text } = writeContact(cur.text, i.contact);
        try {
          await this.put(c, rid, text, { ifMatch: i.ifMatch ?? cur.etag });
          break;
        } catch (e) {
          if (e instanceof StatusError && e.status === 412 && !i.ifMatch && attempt < 1) continue;
          throw e;
        }
      }
    }
    const back = await this.get(c, rid);
    if (!back) throw new StatusError('the server took the contact but does not give it back', 502);
    this.changed(c);
    const out = this.contactOf(c, { id: rid, etag: back.etag, data: back.text });
    if (!out) throw new StatusError('the server gave back a card that does not parse', 502);
    return out;
  }

  async deleteContact(i: { bookId: string; id: string; ifMatch?: string }) {
    const c = await this.coll('card', i.bookId);
    this.writable(c);
    if (typeof i.id !== 'string' || !i.id) throw invalid('id is needed');
    await this.del(c, i.id, i.ifMatch);
    this.changed(c);
    return {};
  }

  // ---------------------------------------------------------------- watching

  private emitChanged(kind: Kind, id: string) {
    this.link.emit(kind === 'cal' ? { t: 'cal.changed', calendarId: id } : { t: 'contacts.changed', bookId: id });
  }

  /** After a write of ours: say so now, and take the collection's new token so the poll does not say it again. */
  private changed(c: Coll) {
    this.emitChanged(c.kind, c.id);
    void this.markOf(c.url)
      .then((mark) => {
        if (this.st.colls[c.id]) {
          this.st.colls[c.id].mark = mark;
          this.save();
        }
      })
      .catch(() => {});
  }

  /** What says a collection changed: its sync-token, else its ctag, else a hash of its members' etags. */
  private async markOf(url: string, r?: DavResponse): Promise<string | null> {
    if (!r) r = (await this.net(() => this.client.propfind(url, '<d:sync-token/><cs:getctag/>', 0))).responses[0];
    const m = r ? (propText(r, NS.d, 'sync-token') ?? propText(r, NS.cs, 'getctag')) : null;
    if (m) return m;
    const { responses } = await this.net(() => this.client.propfind(url, '<d:getetag/>', 1));
    const list = responses.map((x) => `${canonPath(new URL(x.href).pathname)} ${etagValue(propText(x, NS.d, 'getetag')) ?? ''}`).sort();
    return `h:${new Bun.CryptoHasher('sha256').update(list.join('\n')).digest('base64url').slice(0, 22)}`;
  }

  /** One look at every collection: a token that moved, a collection new or gone, says so. */
  async poll() {
    const f = this.st.found;
    if (!f) return;
    const homes = [...new Set([f.calHome, f.cardHome].filter((h): h is string => !!h))];
    const seen = new Set<string>();
    let changedState = false;
    for (const home of homes) {
      const { responses } = await this.net(() => this.client.propfind(home, '<d:resourcetype/><d:sync-token/><cs:getctag/>', 1));
      for (const r of responses) {
        const kind: Kind | null = hasType(r, NS.c, 'calendar') ? 'cal' : hasType(r, NS.card, 'addressbook') ? 'card' : null;
        if (!kind) continue;
        const u = new URL(r.href);
        const id = canonPath(u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`);
        if (seen.has(id)) continue;
        seen.add(id);
        const mark = await this.markOf(u.href, r);
        const prev = this.st.colls[id];
        if (!prev) {
          if (this.st.polled) this.emitChanged(kind, id);
          changedState = true;
        } else if (prev.mark !== mark) {
          this.emitChanged(kind, id);
          changedState = true;
        }
        this.st.colls[id] = { kind, url: u.href, mark };
      }
    }
    for (const [id, c] of Object.entries(this.st.colls)) {
      if (seen.has(id)) continue;
      this.emitChanged(c.kind, id);
      delete this.st.colls[id];
      delete this.st.overrides[id];
      delete this.st.snapshots[id];
      changedState = true;
    }
    if (!this.st.polled) {
      this.st.polled = true;
      changedState = true;
    }
    if (changedState) {
      this.save();
      // Names, colours and read-only may have moved too.
      await Promise.all([this.listColls('cal'), this.listColls('card')]).catch(() => {});
    }
    this.lastPoll = Date.now();
  }
}

const XMLNS_ALL = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';
