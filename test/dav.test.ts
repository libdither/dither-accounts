/**
 * The dav extractor against a real server (Radicale from nixpkgs, extractors/dav/test/radicale.ts), through a real
 * manager and an app's client: discovery from a bare origin and from a path, every calendar and contacts op, sync
 * tokens (and a stale one → 410), If-Match conflicts → 412, recurrence across a change of offset, a read-only
 * calendar → 403, changes made by another client reaching the app as cal.changed / contacts.changed, the ctag/etag
 * way for servers without sync-collection, a refused password and a new one, the server going down and coming back,
 * and a restart that keeps the state tokens rest on.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { calendar, contacts } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager, type Manifest } from '@dither-accounts/manager';
import { ics, Radicale, vcf } from '../extractors/dav/test/radicale.ts';
import { radicale, why } from './needs.ts';

const ok = why('Radicale (from nixpkgs, or RADICALE_BIN)', radicale);
const it = test.skipIf(!ok);

setDefaultTimeout(60_000);
const ROOT = resolve(import.meta.dir, '..');
const DAV = join(ROOT, 'extractors/dav');
const PORT = 18530;
const LA = 'America/Los_Angeles';

let rad: Radicale;
let m: Manager;
let dir: string;
let app: AccountsClient;
let admin: AccountsClient;
let acc: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();

const until = async <T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 15_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
};
const lastStatus = (id: string) => (events.get(id) ?? []).filter((e) => e.t === 'status').at(-1);
const evs = (id: string, t: string) => (events.get(id) ?? []).filter((e) => e.t === t);
const fails = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x) => x,
  );
  if (!(e instanceof CallFailed)) throw new Error(`expected the call to fail, got ${JSON.stringify(e)}`);
  return e;
};
const cal = <K extends keyof (typeof calendar)['ops'] & string>(op: K, input: any, account = acc) => app.call(calendar, account, op, input) as Promise<any>;
const con = <K extends keyof (typeof contacts)['ops'] & string>(op: K, input: any, account = acc) => app.call(contacts, account, op, input) as Promise<any>;
const add = async (label: string, config: Record<string, unknown>, password: string) => {
  const r = await fetch(`${m.url}/api/accounts`, { method: 'POST', body: JSON.stringify({ kind: 'dav', label, config, secret: { password } }) });
  const b = (await r.json()) as any;
  if (!r.ok) throw new Error(b.error);
  return b.id as string;
};
const online = (id: string) => until(() => lastStatus(id)?.status === 'online' && app.accounts.find((a) => a.id === id)?.online, 30_000, `${id} online`);

beforeAll(async () => {
  if (!ok) return;
  rad = new Radicale(PORT, { alice: 'alice-pw', bob: 'bob-pw' }, {
    alice: {
      work: { tag: 'VCALENDAR', name: 'Work', color: '#ff8800ff' },
      home: { tag: 'VCALENDAR', name: 'Home', components: 'VEVENT' },
      holidays: { tag: 'VCALENDAR', name: 'Holidays', items: { 'ny.ics': ics('BEGIN:VEVENT', 'UID:ny-2027', 'DTSTAMP:20260101T000000Z', 'DTSTART;VALUE=DATE:20270101', 'DTEND;VALUE=DATE:20270102', 'SUMMARY:New Year', 'END:VEVENT') } },
      people: { tag: 'VADDRESSBOOK', name: 'People', items: { 'ada.vcf': vcf('UID:ada', 'N:Lovelace;Ada;;;', 'FN:Ada Lovelace', 'EMAIL;TYPE=home:ada@example.com') } },
    },
    bob: { cal: { tag: 'VCALENDAR', name: "Bob's" } },
  });
  await rad.start();
  dir = mkdtempSync(join(tmpdir(), 'dacc-dav-'));
  const file = existsSync(join(DAV, 'manifest.ts')) ? join(DAV, 'manifest.ts') : join(DAV, 'manifest.wip.ts');
  const manifest = (await import(file)).default as Manifest;
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['dav', kindOf(manifest, DAV)]]) });
  const reg = await register(m.url, { name: 'dav-test', requests: [{ interface: 'calendar', level: 'write' }, { interface: 'contacts', level: 'write' }] });
  const runner = await register(m.url, { name: 'dav-runner', requests: [{ interface: 'accounts', level: 'manage', kinds: ['dav'] }] });
  const st = (await (await fetch(`${m.url}/api/state`)).json()) as any;
  for (const a of st.apps) for (const r of a.requests) if (r.state === 'pending') await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  const onEvents = (account: string, list: any[]) => events.set(account, [...(events.get(account) ?? []), ...list]);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents });
  admin = new AccountsClient({ url: m.url, app: runner.app, token: runner.token });
  await until(() => app.connected && admin.connected, 5000, 'clients connected');
  acc = await add('Radicale', { server: rad.url, username: 'alice', pollSeconds: 1 }, 'alice-pw');
}, 120_000);

afterAll(async () => {
  if (!ok) return;
  app?.close();
  admin?.close();
  await m?.stop();
  await rad?.close();
  rmSync(dir, { recursive: true, force: true });
});

it('found from the bare server URL: online, its layers, who it is, the password only in secret.json', async () => {
  await online(acc);
  const st = lastStatus(acc)!;
  expect(st.layers.map((l: any) => [l.name, l.state])).toEqual([
    ['server', 'ok'],
    ['signed in', 'ok'],
    ['calendars', 'ok'],
    ['address books', 'ok'],
  ]);
  expect(st.layers[2].note).toContain('3 calendars, 1 read-only');
  expect(st.self).toMatchObject({ handle: 'alice' });
  expect(st.details).toMatchObject({ server: rad.url, username: 'alice', principal: '/alice/', calendars: 3, addressBooks: 1, auth: 'basic' });
  expect(evs(acc, 'hello')[0]).toMatchObject({ kind: 'dav', interfaces: ['calendar', 'contacts'] });
  const accDir = m.store.account(acc)!.dir;
  expect(JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8'))).toEqual({ password: 'alice-pw' });
  const detail = (await (await fetch(`${m.url}/api/accounts/${acc}`)).json()) as any;
  expect(JSON.stringify(detail.config)).not.toContain('alice-pw');
  expect(readFileSync(join(accDir, 'dav-state.json'), 'utf8')).not.toContain('alice-pw');
  // The page's own view of it.
  const info = ((await (await fetch(`${m.url}/api/state`)).json()) as any).accounts.find((a: any) => a.id === acc);
  expect(info.layers.length).toBe(4);
  expect(info.self.name).toBe('alice');
});

it('cal.calendars: names, colour, components, the read-only one', async () => {
  const { calendars } = await cal('cal.calendars', {});
  const by = Object.fromEntries(calendars.map((c: any) => [c.name, c]));
  expect(Object.keys(by).sort()).toEqual(['Holidays', 'Home', 'Work']);
  expect(by.Work).toMatchObject({ id: '/alice/work/', color: '#FF8800', readOnly: false, components: ['event', 'task'] });
  expect(by.Home.components).toEqual(['event']);
  expect(by.Holidays.readOnly).toBe(true);
});

let weekly: any;
let syncToken: string;
it('cal.put, then cal.events with expand across the change to daylight time', async () => {
  weekly = await cal('cal.put', {
    calendarId: '/alice/work/',
    event: { uid: 'standup-1', title: 'Standup', start: { dateTime: '2026-02-23T09:00:00', timeZone: LA }, end: { dateTime: '2026-02-23T09:15:00', timeZone: LA }, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'], location: 'Room 4' },
  });
  expect(weekly).toMatchObject({ id: 'standup-1.ics', uid: 'standup-1', title: 'Standup', location: 'Room 4', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'], start: { dateTime: '2026-02-23T09:00:00-08:00', timeZone: LA } });
  expect(weekly.etag).toBeTruthy();
  expect(weekly.ics).toContain('TZID:America/Los_Angeles');
  await cal('cal.put', { calendarId: '/alice/work/', event: { uid: 'offsite', title: 'Offsite', start: { date: '2026-03-12' }, end: { date: '2026-03-14' } } });
  const page = await cal('cal.events', { calendarId: '/alice/work/', from: '2026-03-01T00:00:00Z', to: '2026-03-20T00:00:00Z', expand: true });
  expect(page.next).toBeNull();
  expect(page.syncToken).toMatch(/^dav1\./);
  const got = page.events.map((e: any) => [e.id, e.start.dateTime ?? e.start.date, e.end.dateTime ?? e.end.date]);
  expect(got).toEqual(
    expect.arrayContaining([
      ['standup-1.ics#20260302T170000Z', '2026-03-02T09:00:00-08:00', '2026-03-02T09:15:00-08:00'],
      ['standup-1.ics#20260309T160000Z', '2026-03-09T09:00:00-07:00', '2026-03-09T09:15:00-07:00'],
      ['standup-1.ics#20260316T160000Z', '2026-03-16T09:00:00-07:00', '2026-03-16T09:15:00-07:00'],
      ['offsite.ics#20260312', '2026-03-12', '2026-03-14'],
    ]),
  );
  expect(got.length).toBe(4);
  // Without expand: each series once, and a window only names what falls in it (the server's time-range query).
  const plain = await cal('cal.events', { calendarId: '/alice/work/' });
  expect(plain.events.map((e: any) => e.id).sort()).toEqual(['offsite.ics', 'standup-1.ics']);
  const april = await cal('cal.events', { calendarId: '/alice/work/', from: '2026-04-01T00:00:00Z', to: '2026-05-01T00:00:00Z' });
  expect(april.events).toEqual([]);
  syncToken = plain.syncToken;
  expect((await fails(cal('cal.events', { calendarId: '/alice/work/', expand: true }))).status).toBe(400);
  expect((await fails(cal('cal.events', { calendarId: '/alice/nope/' }))).status).toBe(404);
});

it('a change by another client: cal.changed, then cal.changes names it; a delete names its id', async () => {
  const before = evs(acc, 'cal.changed').length;
  const other = rad.as('alice');
  const put = await other.put('/alice/work/lunch.ics', ics('BEGIN:VEVENT', 'UID:lunch', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260310T190000Z', 'DTEND:20260310T200000Z', 'SUMMARY:Lunch', 'END:VEVENT'));
  expect(put.status).toBe(201);
  await until(() => evs(acc, 'cal.changed').slice(before).some((e) => e.calendarId === '/alice/work/'), 15_000, 'cal.changed');
  const ch = await cal('cal.changes', { calendarId: '/alice/work/', syncToken });
  expect(ch.changed.map((e: any) => [e.id, e.title, e.start.dateTime])).toEqual([['lunch.ics', 'Lunch', '2026-03-10T19:00:00Z']]);
  expect(ch.removed).toEqual([]);
  expect(ch.more).toBe(false);
  // Nothing since: nothing.
  const none = await cal('cal.changes', { calendarId: '/alice/work/', syncToken: ch.syncToken });
  expect([none.changed, none.removed]).toEqual([[], []]);
  expect((await other.del('/alice/work/lunch.ics')).status).toBe(200);
  const gone = await cal('cal.changes', { calendarId: '/alice/work/', syncToken: ch.syncToken });
  expect(gone.removed).toEqual(['lunch.ics']);
  syncToken = gone.syncToken;
});

it('a stale or foreign sync token is 410; one for another calendar is 400', async () => {
  const stale = 'dav1.' + Buffer.from(JSON.stringify({ c: '/alice/work/', s: 'http://radicale.org/ns/sync/0000000000000000000000000000000000000000' })).toString('base64url');
  const e = await fails(cal('cal.changes', { calendarId: '/alice/work/', syncToken: stale }));
  expect(e.status).toBe(410);
  expect(e.message).toContain('stale');
  expect((await fails(cal('cal.changes', { calendarId: '/alice/work/', syncToken: 'garbage' }))).status).toBe(410);
  expect((await fails(cal('cal.changes', { calendarId: '/alice/home/', syncToken }))).status).toBe(400);
});

it('If-Match: a write that lost to someone else is 412; with the current etag it goes through', async () => {
  const cur = (await cal('cal.events', { calendarId: '/alice/work/' })).events.find((e: any) => e.id === 'offsite.ics');
  // Someone else changes it.
  const g = await rad.as('alice').get('/alice/work/offsite.ics');
  expect((await rad.as('alice').put('/alice/work/offsite.ics', g.text.replace('SUMMARY:Offsite', 'SUMMARY:Offsite (moved)'), 'text/calendar', { 'if-match': g.etag! })).status).toBe(204);
  const e = await fails(cal('cal.put', { calendarId: '/alice/work/', id: 'offsite.ics', ifMatch: cur.etag, event: { title: 'Mine' } }));
  expect(e.status).toBe(412);
  expect((await fails(cal('cal.delete', { calendarId: '/alice/work/', id: 'offsite.ics', ifMatch: cur.etag }))).status).toBe(412);
  const now = (await cal('cal.events', { calendarId: '/alice/work/' })).events.find((x: any) => x.id === 'offsite.ics');
  expect(now.title).toBe('Offsite (moved)');
  const ok = await cal('cal.put', { calendarId: '/alice/work/', id: 'offsite.ics', ifMatch: now.etag, event: { title: 'Offsite', description: 'two days' } });
  expect(ok).toMatchObject({ title: 'Offsite', description: 'two days', start: { date: '2026-03-12' }, end: { date: '2026-03-14' } });
  expect(ok.etag).not.toBe(now.etag);
  // A new event whose uid is taken.
  expect((await fails(cal('cal.put', { calendarId: '/alice/work/', event: { uid: 'offsite', title: 'again', start: { date: '2026-03-12' } } }))).status).toBe(412);
  const ch = await cal('cal.changes', { calendarId: '/alice/work/', syncToken });
  expect(ch.changed.map((e: any) => [e.id, e.title])).toEqual([['offsite.ics', 'Offsite']]);
  syncToken = ch.syncToken;
});

it('one instance changed, one deleted: overrides and EXDATEs, as changes and as an expansion', async () => {
  const moved = await cal('cal.put', { calendarId: '/alice/work/', id: 'standup-1.ics#20260309T160000Z', event: { title: 'Standup (late)', start: { dateTime: '2026-03-09T11:00:00', timeZone: LA } } });
  expect(moved).toMatchObject({ id: 'standup-1.ics#20260309T160000Z', title: 'Standup (late)', recurrenceId: { dateTime: '2026-03-09T09:00:00-07:00', timeZone: LA }, start: { dateTime: '2026-03-09T11:00:00-07:00', timeZone: LA }, end: { dateTime: '2026-03-09T11:15:00-07:00', timeZone: LA } });
  const ch = await cal('cal.changes', { calendarId: '/alice/work/', syncToken });
  expect(ch.changed.map((e: any) => e.id).sort()).toEqual(['standup-1.ics', 'standup-1.ics#20260309T160000Z']);
  await cal('cal.delete', { calendarId: '/alice/work/', id: 'standup-1.ics#20260316T160000Z' });
  await cal('cal.delete', { calendarId: '/alice/work/', id: 'standup-1.ics#20260309T160000Z' });
  const ch2 = await cal('cal.changes', { calendarId: '/alice/work/', syncToken: ch.syncToken });
  expect(ch2.changed.map((e: any) => e.id)).toEqual(['standup-1.ics']);
  expect(ch2.changed[0].recurrence.sort()).toEqual(['EXDATE;TZID=America/Los_Angeles:20260309T090000', 'EXDATE;TZID=America/Los_Angeles:20260316T090000', 'RRULE:FREQ=WEEKLY;COUNT=6']);
  // The override that went is named as removed.
  expect(ch2.removed).toEqual(['standup-1.ics#20260309T160000Z']);
  syncToken = ch2.syncToken;
  const ex = await cal('cal.events', { calendarId: '/alice/work/', from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z', expand: true });
  expect(ex.events.filter((e: any) => e.uid === 'standup-1').map((e: any) => e.start.dateTime)).toEqual(['2026-03-02T09:00:00-08:00', '2026-03-23T09:00:00-07:00', '2026-03-30T09:00:00-07:00']);
  expect((await fails(cal('cal.delete', { calendarId: '/alice/work/', id: 'standup-1.ics#20260310T160000Z' }))).status).toBe(404);
});

it('cal.put with ics, and cal.delete of a whole event', async () => {
  const text = ics('BEGIN:VEVENT', 'UID:raw-1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260401T100000Z', 'DURATION:PT45M', 'SUMMARY:Raw', 'X-CUSTOM:kept', 'END:VEVENT');
  const ev = await cal('cal.put', { calendarId: '/alice/home/', event: { ics: text } });
  expect(ev).toMatchObject({ id: 'raw-1.ics', title: 'Raw', end: { dateTime: '2026-04-01T10:45:00Z', timeZone: null } });
  expect(ev.ics).toContain('X-CUSTOM:kept');
  await cal('cal.delete', { calendarId: '/alice/home/', id: 'raw-1.ics', ifMatch: ev.etag });
  expect((await rad.as('alice').get('/alice/home/raw-1.ics')).status).toBe(404);
  expect((await fails(cal('cal.delete', { calendarId: '/alice/home/', id: 'raw-1.ics' }))).status).toBe(404);
});

it('a read-only calendar: listed with its events, writes refused with 403', async () => {
  const { events: list } = await cal('cal.events', { calendarId: '/alice/holidays/' });
  expect(list.map((e: any) => [e.title, e.start])).toEqual([['New Year', { date: '2027-01-01' }]]);
  expect((await fails(cal('cal.put', { calendarId: '/alice/holidays/', event: { title: 'x', start: { date: '2027-01-02' } } }))).status).toBe(403);
  expect((await fails(cal('cal.put', { calendarId: '/alice/holidays/', id: 'ny.ics', event: { title: 'x' } }))).status).toBe(403);
  expect((await fails(cal('cal.delete', { calendarId: '/alice/holidays/', id: 'ny.ics' }))).status).toBe(403);
});

let book: string;
let ctoken: string;
it('contacts: books, list, add, change with If-Match, changes, delete', async () => {
  const { books } = await con('contacts.books', {});
  expect(books).toEqual([{ id: '/alice/people/', name: 'People', description: null, readOnly: false }]);
  book = books[0].id;
  const l = await con('contacts.list', { bookId: book });
  expect(l.contacts.map((c: any) => [c.id, c.name.full, c.emails])).toEqual([['ada.vcf', 'Ada Lovelace', [{ value: 'ada@example.com', type: 'home' }]]]);
  ctoken = l.syncToken;
  const before = evs(acc, 'contacts.changed').length;
  const grace = await con('contacts.put', { bookId: book, contact: { uid: 'grace', name: { full: 'Grace Hopper', given: 'Grace', family: 'Hopper' }, phones: [{ value: '+1 555 0100', type: 'cell' }], birthday: '1906-12-09' } });
  expect(grace).toMatchObject({ id: 'grace.vcf', uid: 'grace', name: { full: 'Grace Hopper' }, phones: [{ value: '+1 555 0100', type: 'cell' }], birthday: '1906-12-09' });
  await until(() => evs(acc, 'contacts.changed').length > before, 5000, 'contacts.changed after a write');
  const ch = await con('contacts.changes', { bookId: book, syncToken: ctoken });
  expect(ch.changed.map((c: any) => c.id)).toEqual(['grace.vcf']);
  const changed = await con('contacts.put', { bookId: book, id: 'grace.vcf', ifMatch: grace.etag, contact: { org: 'US Navy', emails: [{ value: 'grace@navy.example', type: 'work' }] } });
  expect(changed).toMatchObject({ org: 'US Navy', emails: [{ value: 'grace@navy.example', type: 'work' }], phones: [{ value: '+1 555 0100', type: 'cell' }] });
  expect((await fails(con('contacts.put', { bookId: book, id: 'grace.vcf', ifMatch: grace.etag, contact: { org: 'stale' } }))).status).toBe(412);
  expect((await fails(con('contacts.delete', { bookId: book, id: 'grace.vcf', ifMatch: grace.etag }))).status).toBe(412);
  // Someone else adds one: contacts.changed from the poll.
  const n = evs(acc, 'contacts.changed').length;
  await rad.as('alice').put('/alice/people/alan.vcf', vcf('UID:alan', 'N:Turing;Alan;;;', 'FN:Alan Turing'));
  await until(() => evs(acc, 'contacts.changed').length > n, 15_000, 'contacts.changed');
  await con('contacts.delete', { bookId: book, id: 'grace.vcf', ifMatch: changed.etag });
  const ch2 = await con('contacts.changes', { bookId: book, syncToken: ch.syncToken });
  expect(ch2.changed.map((c: any) => c.name.full)).toEqual(['Alan Turing']);
  expect(ch2.removed).toEqual(['grace.vcf']);
  ctoken = ch2.syncToken;
  expect((await fails(con('contacts.changes', { bookId: book, syncToken: 'dav1.e30' }))).status).toBe(410);
});

it('a restart keeps what tokens rest on: an old token still answers, removed overrides are still named', async () => {
  // An override, then a token, then a restart, then the override goes.
  await cal('cal.put', { calendarId: '/alice/work/', id: 'standup-1.ics#20260323T160000Z', event: { title: 'Standup (moved)' } });
  const t0 = (await cal('cal.changes', { calendarId: '/alice/work/', syncToken })).syncToken;
  await fetch(`${m.url}/api/accounts/${acc}/restart`, { method: 'POST' });
  await until(() => app.accounts.find((a) => a.id === acc)?.online === false || true, 1000);
  await online(acc);
  await cal('cal.delete', { calendarId: '/alice/work/', id: 'standup-1.ics#20260323T160000Z' });
  const ch = await cal('cal.changes', { calendarId: '/alice/work/', syncToken: t0 });
  expect(ch.removed).toEqual(['standup-1.ics#20260323T160000Z']);
  // A token handed out after that removal is not told it again when the series changes once more.
  await cal('cal.put', { calendarId: '/alice/work/', id: 'standup-1.ics', event: { location: 'Room 5' } });
  const again = await cal('cal.changes', { calendarId: '/alice/work/', syncToken: ch.syncToken });
  expect(again.changed.map((e: any) => [e.id, e.location])).toEqual([['standup-1.ics', 'Room 5']]);
  expect(again.removed).toEqual([]);
  syncToken = again.syncToken;
  const c = await con('contacts.changes', { bookId: book, syncToken: ctoken });
  expect([c.changed, c.removed]).toEqual([[], []]);
});

it('without sync-collection (ctag and etags): tokens, changes, a stale one, and a restart', async () => {
  const id = await add('Radicale by etags', { server: `${rad.url}/alice/`, username: 'alice', pollSeconds: 1, syncMode: 'etag' }, 'alice-pw');
  await online(id);
  expect(lastStatus(id)!.layers[2].note).toContain('by etags');
  const l = await cal('cal.events', { calendarId: '/alice/home/' }, id);
  expect(l.events).toEqual([]);
  const t = l.syncToken;
  const n = evs(id, 'cal.changed').length;
  await rad.as('alice').put('/alice/home/dentist.ics', ics('BEGIN:VEVENT', 'UID:dentist', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Berlin:20260320T083000', 'DTEND;TZID=Europe/Berlin:20260320T090000', 'SUMMARY:Dentist', 'END:VEVENT'));
  await until(() => evs(id, 'cal.changed').length > n, 15_000, 'cal.changed by ctag');
  const ch = await cal('cal.changes', { calendarId: '/alice/home/', syncToken: t }, id);
  expect(ch.changed.map((e: any) => [e.title, e.start])).toEqual([['Dentist', { dateTime: '2026-03-20T08:30:00+01:00', timeZone: 'Europe/Berlin' }]]);
  await fetch(`${m.url}/api/accounts/${id}/restart`, { method: 'POST' });
  await Bun.sleep(300);
  await online(id);
  await rad.as('alice').del('/alice/home/dentist.ics');
  const ch2 = await cal('cal.changes', { calendarId: '/alice/home/', syncToken: ch.syncToken }, id);
  expect(ch2.removed).toEqual(['dentist.ics']);
  // The first token still answers too (its snapshot is kept), with everything since.
  const ch3 = await cal('cal.changes', { calendarId: '/alice/home/', syncToken: t }, id);
  expect([ch3.changed, ch3.removed]).toEqual([[], []]);
  const forged = 'dav1.' + Buffer.from(JSON.stringify({ c: '/alice/home/', e: 'nope' })).toString('base64url');
  expect((await fails(cal('cal.changes', { calendarId: '/alice/home/', syncToken: forged }, id))).status).toBe(410);
  await admin.admin({ do: 'delete', account: id, purge: true });
});

it('a refused password: attention, 401s, and a new password brings it back', async () => {
  const id = await add('Bob, wrong password', { server: rad.url, username: 'bob', pollSeconds: 1 }, 'not-it');
  await until(() => lastStatus(id)?.status === 'attention', 20_000, 'attention');
  const st = lastStatus(id)!;
  expect(st.attention).toMatchObject({ kind: 'login' });
  expect(st.layers.map((l: any) => [l.name, l.state])).toEqual([
    ['server', 'ok'],
    ['signed in', 'failed'],
    ['calendars', 'waiting'],
    ['address books', 'waiting'],
  ]);
  expect((await fails(cal('cal.calendars', {}, id))).status).toBe(401);
  await admin.admin({ do: 'secret', account: id, secret: { password: 'bob-pw' } });
  await online(id);
  expect((await cal('cal.calendars', {}, id)).calendars.map((c: any) => c.name)).toEqual(["Bob's"]);
  // Bob has calendars but no address books.
  expect(lastStatus(id)!.layers[3]).toMatchObject({ name: 'address books', state: 'ok' });
  expect((await con('contacts.books', {}, id)).books).toEqual([]);
  await admin.admin({ do: 'delete', account: id, purge: true });
});

it('a server that is not there, and the server going down and coming back', async () => {
  const nowhere = await add('Nowhere', { server: 'http://127.0.0.1:18538', username: 'x', pollSeconds: 1 }, 'x');
  await until(() => lastStatus(nowhere)?.layers?.[0]?.state === 'failed', 20_000, 'server failed');
  expect(lastStatus(nowhere)!.layers[0].note).toContain('not reachable');
  expect((await fails(cal('cal.calendars', {}, nowhere))).status).toBe(503);
  await admin.admin({ do: 'delete', account: nowhere, purge: true });

  await rad.stop();
  const e = await fails(cal('cal.events', { calendarId: '/alice/work/' }));
  expect(e.status).toBe(503);
  await until(() => ['waiting', 'failed'].includes(lastStatus(acc)?.layers?.[0]?.state), 15_000, 'server layer down');
  expect(lastStatus(acc)!.status).not.toBe('online');
  await rad.start();
  await until(() => lastStatus(acc)?.status === 'online' && lastStatus(acc)?.layers?.[0]?.state === 'ok', 30_000, 'back online');
  const back = await cal('cal.changes', { calendarId: '/alice/work/', syncToken });
  expect(back.syncToken).toMatch(/^dav1\./);
});

it('a server URL with a path, as Nextcloud has it (/remote.php/dav), is used as the context path', async () => {
  const id = await add('Radicale by path', { server: `${rad.url}/alice/`, username: 'alice', pollSeconds: 30 }, 'alice-pw');
  await online(id);
  expect(lastStatus(id)!.details.principal).toBe('/alice/');
  expect((await cal('cal.calendars', {}, id)).calendars.length).toBe(3);
  await admin.admin({ do: 'delete', account: id, purge: true });
});
