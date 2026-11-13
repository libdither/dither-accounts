/**
 * The dav and ics kinds end to end, as the user and an app meet them: a throwaway manager
 * (`bun packages/manager/src/main.ts --data <tmp> --port 18535`), a real CalDAV/CardDAV server (Radicale from
 * nixpkgs, port 18536) and a feed server (port 18537). It adds a dav and an ics account through the manager's HTTP API
 * with the fields the page's add form sends, then, as an app (packages/client): registers, has its requests approved
 * through the manager's API, calls every operation of both interfaces on both accounts, and checks the events it
 * gets (hello, status, cal.changed, contacts.changed), including changes made behind the extractor's back and seen
 * after a restart.
 *
 *   bun scripts/verify-dav.ts [--keep]
 *
 * Everything is under a fresh /tmp/dacc-verifydav-* directory, deleted after unless --keep. Nothing reaches a real
 * account.
 */
import type { Subprocess } from 'bun';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { calendar, contacts } from '@dither-accounts/interfaces';
import { ics, Radicale, vcf } from '../extractors/dav/test/radicale.ts';
import { feed, FeedServer, vevent } from '../extractors/ics/test/feed-server.ts';

const ROOT = resolve(import.meta.dir, '..');
const T = mkdtempSync('/tmp/dacc-verifydav-');
const keep = process.argv.includes('--keep');
const PORT = 18535;
const MGR = `http://127.0.0.1:${PORT}`;
const LA = 'America/Los_Angeles';

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
  return !!ok;
};
const until = async (f: () => unknown | Promise<unknown>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await f()) return true;
    } catch {}
    await Bun.sleep(200);
  }
  console.log(`     (gave up waiting for ${what})`);
  return false;
};
const get = async (path: string) => (await fetch(MGR + path)).json() as Promise<any>;
const post = (path: string, body: unknown) => fetch(MGR + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: MGR }, body: JSON.stringify(body) });
const account = async (id: string) => (await get('/api/state')).accounts.find((a: any) => a.id === id);
/** A call that should fail; its CallFailed. */
const refused = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof CallFailed ? e : null));

const rad = new Radicale(18536, { alice: 'verify-pw' }, {
  alice: {
    work: { tag: 'VCALENDAR', name: 'Work', color: '#2266aaff' },
    holidays: { tag: 'VCALENDAR', name: 'Holidays', items: { 'ny.ics': ics('BEGIN:VEVENT', 'UID:ny', 'DTSTAMP:20260101T000000Z', 'DTSTART;VALUE=DATE:20270101', 'SUMMARY:New Year', 'END:VEVENT') } },
    people: { tag: 'VADDRESSBOOK', name: 'People', items: { 'ada.vcf': vcf('UID:ada', 'N:Lovelace;Ada;;;', 'FN:Ada Lovelace', 'EMAIL;TYPE=home:ada@example.com') } },
  },
});
const feeds = new FeedServer(18537);
const teamFeed = (extra: string[] = []) =>
  feed('Team', 'X-WR-TIMEZONE:America/Los_Angeles', ...vevent('UID:club', 'DTSTART;TZID=America/Los_Angeles:20260302T183000', 'DTEND;TZID=America/Los_Angeles:20260302T200000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Book club'), ...extra);

let mgr = null as Subprocess | null;
let app: AccountsClient | null = null;
const events = new Map<string, { t: string; [k: string]: any }[]>();
const seen = (id: string, t: string) => (events.get(id) ?? []).filter((e) => e.t === t);

async function startManager() {
  const data = join(T, 'mgr');
  mkdirSync(data, { recursive: true });
  mgr = Bun.spawn(['bun', 'packages/manager/src/main.ts', '--data', data, '--port', String(PORT), '--host', '127.0.0.1'], { cwd: ROOT, stdout: Bun.file(join(T, 'manager.log')), stderr: Bun.file(join(T, 'manager.err')) });
  return until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager');
}

try {
  console.log(`     workdir ${T}`);
  await rad.start();
  check(true, `Radicale up at ${rad.url}`);
  feeds.set('/team.ics', { text: teamFeed(), mode: 'etag' });
  feeds.start();
  check((await fetch(`${feeds.url}/team.ics`)).ok, `feed server up at ${feeds.url}`);
  check(await startManager(), 'a throwaway manager');

  const st = await get('/api/state');
  const kinds = Object.fromEntries(st.kinds.map((k: any) => [k.kind, k]));
  check(kinds.dav?.add?.fields?.map((f: any) => f.key).join(',') === 'server,username,password,contactsServer', 'the dav kind has an add form: server, user name, password (secret), contacts server', kinds.dav?.add?.fields?.map((f: any) => f.key));
  check(kinds.ics?.add?.fields?.[0]?.secret === true, 'the ics kind has an add form: the feed URL, kept secret');
  check(kinds.dav?.interfaces?.join() === 'calendar,contacts' && kinds.ics?.interfaces?.join() === 'calendar', 'their interfaces', [kinds.dav?.interfaces, kinds.ics?.interfaces]);

  // As the page's add dialog sends them: the form's fields, secret ones under secret.
  const r1 = await post('/api/accounts', { kind: 'dav', label: 'Radicale (verify)', config: { server: rad.url, username: 'alice' }, secret: { password: 'verify-pw' } });
  const dav = ((await r1.json()) as any).id as string;
  check(r1.ok && dav, 'POST /api/accounts adds the dav account', r1.status);
  const r2 = await post('/api/accounts', { kind: 'ics', label: 'Team feed (verify)', config: {}, secret: { url: `${feeds.url}/team.ics` } });
  const icsAcc = ((await r2.json()) as any).id as string;
  check(r2.ok && icsAcc, 'POST /api/accounts adds the ics account', r2.status);
  const bad = await post('/api/accounts', { kind: 'ics', label: 'x', config: {}, secret: { url: 'not a link' } });
  check(bad.status === 400, 'the form refuses a feed URL that is not one', ((await bad.json()) as any).error);

  check(await until(async () => (await account(dav))?.status?.status === 'online', 30_000, 'dav online'), 'dav: online on the page');
  const da = await account(dav);
  check(da.layers?.map((l: any) => `${l.name}:${l.state}`).join(' ') === 'server:ok signed in:ok calendars:ok address books:ok', 'dav: its layers, server → signed in → calendars → address books', da.layers?.map((l: any) => `${l.name}: ${l.note}`));
  check(da.self?.name === 'alice', 'dav: who it is signed in as', da.self);
  const dd = await get(`/api/accounts/${dav}`);
  check(dd.secret.keys.join() === 'password' && !JSON.stringify(dd.config).includes('verify-pw'), 'dav: the password is in secret.json only', { secret: dd.secret.keys, config: dd.config });
  check(dd.status?.details?.calendars === 2 && dd.status?.details?.addressBooks === 1, 'dav: details', dd.status?.details);
  check(await until(async () => (await account(icsAcc))?.status?.status === 'online', 30_000, 'ics online'), 'ics: online on the page');
  const ia = await account(icsAcc);
  check(ia.layers?.map((l: any) => `${l.name}:${l.state}`).join(' ') === 'feed:ok calendar:ok', 'ics: its layers, feed → calendar', ia.layers?.map((l: any) => `${l.name}: ${l.note}`));
  const id = await get(`/api/accounts/${icsAcc}`);
  check(id.secret.keys.join() === 'url' && !JSON.stringify(id).includes('team.ics'), 'ics: the feed URL is in secret.json only, and nowhere on the page');

  // An app.
  const reg = await register(MGR, { name: 'verify-dav', requests: [{ interface: 'calendar', level: 'write' }, { interface: 'contacts', level: 'write' }] });
  const pending = (await get('/api/state')).apps.find((a: any) => a.id === reg.app).requests.filter((r: any) => r.state === 'pending');
  for (const r of pending) await post(`/api/requests/${r.id}/approve`, {});
  check(pending.length === 2, 'the app registered; its two requests approved through the API');
  app = new AccountsClient({ url: MGR, app: reg.app, token: reg.token, onEvents: (a, list) => events.set(a, [...(events.get(a) ?? []), ...list]) });
  check(await until(() => app!.connected && app!.accounts.filter((a) => a.online).length === 2, 15_000, 'the app sees both'), 'the app sees both accounts, online', app.accounts.map((a) => [a.kind, a.grants]));
  const C = <K extends keyof (typeof calendar)['ops'] & string>(acc: string, op: K, input: any) => app!.call(calendar, acc, op, input) as Promise<any>;
  const K = <K extends keyof (typeof contacts)['ops'] & string>(op: K, input: any) => app!.call(contacts, dav, op, input) as Promise<any>;
  check(await until(() => seen(dav, 'hello').length && seen(dav, 'status').length && seen(icsAcc, 'hello').length && seen(icsAcc, 'status').length, 10_000, 'hello and status'), 'the app got hello and status from both');

  // dav: calendar.
  const { calendars } = await C(dav, 'cal.calendars', {});
  check(calendars.length === 2 && calendars.find((c: any) => c.name === 'Holidays')?.readOnly === true && calendars.find((c: any) => c.name === 'Work')?.color === '#2266AA', 'dav cal.calendars: Work and the read-only Holidays', calendars.map((c: any) => [c.name, c.readOnly, c.color]));
  const work = calendars.find((c: any) => c.name === 'Work').id;
  const listed = await C(dav, 'cal.events', { calendarId: work });
  let token = listed.syncToken;
  check(listed.events.length === 0 && /^dav1\./.test(token), 'dav cal.events on an empty calendar, with a sync token');
  const n0 = seen(dav, 'cal.changed').length;
  const made = await C(dav, 'cal.put', { calendarId: work, event: { title: 'Planning', start: { dateTime: '2026-03-02T09:00:00', timeZone: LA }, end: { dateTime: '2026-03-02T10:00:00', timeZone: LA }, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'], attendees: [{ email: 'bob@example.com', name: 'Bob', status: 'needs-action', role: 'required' }] } });
  check(made.id && made.etag && made.start.dateTime === '2026-03-02T09:00:00-08:00', 'dav cal.put (new): made, with an id and etag', [made.id, made.start]);
  check(await until(() => seen(dav, 'cal.changed').length > n0, 5000, 'cal.changed'), 'dav: cal.changed reaches the app after a write');
  const ex = await C(dav, 'cal.events', { calendarId: work, from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z', expand: true });
  check(ex.events.map((e: any) => e.start.dateTime).join() === '2026-03-02T09:00:00-08:00,2026-03-09T09:00:00-07:00,2026-03-16T09:00:00-07:00', 'dav cal.events expand: three instances, 09:00 on both sides of the change to daylight time', ex.events.map((e: any) => e.start.dateTime));
  const changed = await C(dav, 'cal.put', { calendarId: work, id: made.id, ifMatch: made.etag, event: { location: 'Room 2' } });
  check(changed.location === 'Room 2' && changed.etag !== made.etag, 'dav cal.put (change, If-Match): changed');
  const lost = await refused(C(dav, 'cal.put', { calendarId: work, id: made.id, ifMatch: made.etag, event: { location: 'Room 3' } }));
  check(lost?.status === 412, 'dav cal.put with a stale etag: 412', lost?.message);
  const inst = await C(dav, 'cal.put', { calendarId: work, id: ex.events[1].id, event: { title: 'Planning (moved)', start: { dateTime: '2026-03-10T09:00:00', timeZone: LA } } });
  check(inst.recurrenceId && inst.title === 'Planning (moved)', 'dav cal.put on one instance: an override', inst.id);
  const ch = await C(dav, 'cal.changes', { calendarId: work, syncToken: token });
  check(ch.changed.map((e: any) => e.id).sort().join() === [made.id, inst.id].sort().join() && ch.removed.length === 0, 'dav cal.changes: the series and its override', ch.changed.map((e: any) => e.id));
  token = ch.syncToken;
  const stale = await refused(C(dav, 'cal.changes', { calendarId: work, syncToken: 'dav1.' + Buffer.from(JSON.stringify({ c: work, s: 'http://radicale.org/ns/sync/00' })).toString('base64url') }));
  check(stale?.status === 410, 'dav cal.changes with a stale token: 410', stale?.message);
  const ro = await refused(C(dav, 'cal.put', { calendarId: calendars.find((c: any) => c.readOnly).id, event: { title: 'x', start: { date: '2027-01-02' } } }));
  check(ro?.status === 403, 'dav cal.put on the read-only calendar: 403', ro?.message);
  // Behind its back, then a restart: the poll at start says so.
  await rad.as('alice').put('/alice/work/outside.ics', ics('BEGIN:VEVENT', 'UID:outside', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260305T150000Z', 'SUMMARY:Made elsewhere', 'END:VEVENT'));
  const n1 = seen(dav, 'cal.changed').length;
  await post(`/api/accounts/${dav}/restart`, {});
  check(await until(() => seen(dav, 'cal.changed').length > n1, 20_000, 'cal.changed after restart'), 'dav: a change made elsewhere is said (cal.changed) when it starts again');
  const ch2 = await C(dav, 'cal.changes', { calendarId: work, syncToken: token });
  check(ch2.changed.map((e: any) => e.title).join() === 'Made elsewhere', 'dav cal.changes after the restart, with the token from before: what was made elsewhere', ch2.changed.map((e: any) => e.title));
  await C(dav, 'cal.delete', { calendarId: work, id: 'outside.ics' });
  await C(dav, 'cal.delete', { calendarId: work, id: made.id });
  const ch3 = await C(dav, 'cal.changes', { calendarId: work, syncToken: ch2.syncToken });
  check(ch3.removed.sort().join() === ['outside.ics', made.id, inst.id].sort().join(), 'dav cal.delete, and cal.changes names the series, its override and the other one as removed', ch3.removed);

  // dav: contacts.
  const { books } = await K('contacts.books', {});
  check(books.length === 1 && books[0].name === 'People', 'dav contacts.books', books);
  const cl = await K('contacts.list', { bookId: books[0].id });
  check(cl.contacts.map((c: any) => c.name.full).join() === 'Ada Lovelace', 'dav contacts.list', cl.contacts.map((c: any) => c.name.full));
  const n2 = seen(dav, 'contacts.changed').length;
  const grace = await K('contacts.put', { bookId: books[0].id, contact: { name: { full: 'Grace Hopper', given: 'Grace', family: 'Hopper' }, emails: [{ value: 'grace@example.com', type: 'work' }] } });
  check(grace.id && grace.emails[0]?.value === 'grace@example.com', 'dav contacts.put (new)', grace.id);
  check(await until(() => seen(dav, 'contacts.changed').length > n2, 5000, 'contacts.changed'), 'dav: contacts.changed reaches the app');
  const g2 = await K('contacts.put', { bookId: books[0].id, id: grace.id, ifMatch: grace.etag, contact: { phones: [{ value: '+1 555 0100', type: 'cell' }] } });
  check(g2.phones[0]?.value === '+1 555 0100' && g2.emails.length === 1, 'dav contacts.put (change, If-Match): only what it names');
  const lost2 = await refused(K('contacts.delete', { bookId: books[0].id, id: grace.id, ifMatch: grace.etag }));
  check(lost2?.status === 412, 'dav contacts.delete with a stale etag: 412');
  const cc = await K('contacts.changes', { bookId: books[0].id, syncToken: cl.syncToken });
  check(cc.changed.map((c: any) => c.id).join() === grace.id, 'dav contacts.changes');
  await K('contacts.delete', { bookId: books[0].id, id: grace.id, ifMatch: g2.etag });
  const cc2 = await K('contacts.changes', { bookId: books[0].id, syncToken: cc.syncToken });
  check(cc2.removed.join() === grace.id, 'dav contacts.delete, and contacts.changes names it removed');

  // ics.
  const ic = await C(icsAcc, 'cal.calendars', {});
  check(ic.calendars.length === 1 && ic.calendars[0].readOnly && ic.calendars[0].name === 'Team' && ic.calendars[0].timeZone === LA, 'ics cal.calendars: one read-only calendar from the feed', ic.calendars);
  const ie = await C(icsAcc, 'cal.events', { calendarId: 'feed', from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z', expand: true });
  check(ie.events.map((e: any) => e.start.dateTime).join() === '2026-03-02T18:30:00-08:00,2026-03-09T18:30:00-07:00,2026-03-16T18:30:00-07:00', 'ics cal.events expand across the change to daylight time', ie.events.map((e: any) => e.start.dateTime));
  const itok = (await C(icsAcc, 'cal.events', { calendarId: 'feed' })).syncToken;
  feeds.update('/team.ics', teamFeed(vevent('UID:demo', 'DTSTART:20260320T170000Z', 'SUMMARY:Demo')));
  const n3 = seen(icsAcc, 'cal.changed').length;
  await post(`/api/accounts/${icsAcc}/restart`, {});
  check(await until(() => seen(icsAcc, 'cal.changed').length > n3, 20_000, 'ics cal.changed'), 'ics: the feed changed while it was stopped: cal.changed when it starts');
  const ich = await C(icsAcc, 'cal.changes', { calendarId: 'feed', syncToken: itok });
  check(ich.changed.map((e: any) => e.title).join() === 'Demo' && ich.removed.length === 0, 'ics cal.changes with the token from before the restart', ich.changed.map((e: any) => e.title));
  // A restart fetches whole (the copy an ETag stands for is only in memory); then refreshes ask If-None-Match.
  check(feeds.hitsOf('/team.ics').every((x) => x.status === 200 || (x.ifNoneMatch && x.status === 304)), 'ics: every fetch whole or a 304 for If-None-Match', feeds.hitsOf('/team.ics').map((x) => x.status));
  check((await get(`/api/accounts/${icsAcc}`)).status?.details?.refreshBy === 'ETag', 'ics: it refreshes by ETag');
  const iro = await refused(C(icsAcc, 'cal.put', { calendarId: 'feed', event: { title: 'x', start: { date: '2026-03-01' } } }));
  const ird = await refused(C(icsAcc, 'cal.delete', { calendarId: 'feed', id: 'demo' }));
  check(iro?.status === 403 && ird?.status === 403, 'ics cal.put and cal.delete: 403', [iro?.message]);
  const ist = await refused(C(icsAcc, 'cal.changes', { calendarId: 'feed', syncToken: 'ics1.' + Buffer.from('{"v":"gone"}').toString('base64url') }));
  check(ist?.status === 410, 'ics cal.changes with a stale token: 410');

  // The page's own "Try it" goes the same way.
  const tried = (await (await post(`/api/accounts/${icsAcc}/call`, { op: 'cal.calendars', input: {} })).json()) as any;
  check(tried.ok && tried.result.calendars[0].id === 'feed', "the page's Try it on the ics account");
} catch (e) {
  check(false, 'the run', (e as Error).stack ?? String(e));
} finally {
  app?.close();
  if (mgr && mgr.exitCode === null) {
    mgr.kill('SIGTERM');
    const k = setTimeout(() => mgr?.kill('SIGKILL'), 10_000);
    await mgr.exited;
    clearTimeout(k);
  }
  feeds.stop();
  if (keep) {
    await rad.stop();
    console.log(`     kept ${T} (and Radicale's ${rad.dir})`);
  } else {
    await rad.close();
    rmSync(T, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
