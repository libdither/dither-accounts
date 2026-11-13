/**
 * The ics extractor against a local feed server (extractors/ics/test/feed-server.ts), through a real manager and an
 * app's client: the feed as one read-only calendar, recurrence across a change of offset, refresh by ETag (304), by
 * Last-Modified and by content hash (a DTSTAMP that moves on every fetch is no change), cal.changes by uid and
 * recurrence-id, a stale token → 410, writes → 403, paging, a feed behind Basic auth, a refused one, one that is
 * gone, the server going down and back (the last copy still answers), and a restart that keeps the tokens.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { calendar } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager, type Manifest } from '@dither-accounts/manager';
import { addForm } from '../packages/manager/src/http.ts';
import { feedUrl } from '../extractors/ics/src/feed.ts';
import { feed, FeedServer, vevent } from '../extractors/ics/test/feed-server.ts';

setDefaultTimeout(60_000);
const ROOT = resolve(import.meta.dir, '..');
const ICS = join(ROOT, 'extractors/ics');
const PORT = 18532;
const LA = 'America/Los_Angeles';

let srv: FeedServer;
let m: Manager;
let dir: string;
let app: AccountsClient;
let manifest: Manifest;
let acc: string;
const events = new Map<string, { t: string; [k: string]: any }[]>();

const until = async <T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 15_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
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
const cal = (op: keyof (typeof calendar)['ops'] & string, input: any, account = acc) => app.call(calendar, account, op as any, input) as Promise<any>;
const add = async (label: string, url: string, config: Record<string, unknown> = { pollSeconds: 1 }) => {
  const r = await fetch(`${m.url}/api/accounts`, { method: 'POST', body: JSON.stringify({ kind: 'ics', label, config, secret: { url } }) });
  const b = (await r.json()) as any;
  if (!r.ok) throw new Error(b.error);
  return b.id as string;
};
const online = (id: string) => until(() => lastStatus(id)?.status === 'online' && app.accounts.find((a) => a.id === id)?.online, 20_000, `${id} online`);

const LA_TZ = ['BEGIN:VTIMEZONE', 'TZID:America/Los_Angeles', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE'];
const club = (...extra: string[]) => vevent('UID:club@example.com', 'DTSTART;TZID=America/Los_Angeles:20260302T183000', 'DTEND;TZID=America/Los_Angeles:20260302T200000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Book club', ...extra);
const v1 = feed('Team', 'X-WR-TIMEZONE:America/Los_Angeles', 'X-APPLE-CALENDAR-COLOR:#3366cc', ...LA_TZ, ...club(), ...vevent('UID:launch', 'DTSTART;VALUE=DATE:20260315', 'SUMMARY:Launch day'), ...vevent('UID:retro', 'DTSTART:20260320T170000Z', 'DTEND:20260320T180000Z', 'SUMMARY:Retro'));

beforeAll(async () => {
  srv = new FeedServer(PORT);
  srv.set('/team.ics', { text: v1, mode: 'etag' });
  srv.start();
  dir = mkdtempSync(join(tmpdir(), 'dacc-ics-'));
  manifest = (await import(existsSync(join(ICS, 'manifest.ts')) ? join(ICS, 'manifest.ts') : join(ICS, 'manifest.wip.ts'))).default as Manifest;
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['ics', kindOf(manifest, ICS)]]) });
  const reg = await register(m.url, { name: 'ics-test', requests: [{ interface: 'calendar', level: 'write' }] });
  const st = (await (await fetch(`${m.url}/api/state`)).json()) as any;
  for (const a of st.apps) for (const r of a.requests) if (r.state === 'pending') await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, list) => events.set(a, [...(events.get(a) ?? []), ...list]) });
  await until(() => app.connected, 5000, 'connected');
  acc = await add('Team feed', `${srv.url}/team.ics`);
});
afterAll(async () => {
  app?.close();
  await m?.stop();
  srv?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('webcal:// is https://; the add form takes webcal, https and http, and keeps the URL secret', () => {
  expect(feedUrl('webcal://example.com/a.ics').url.href).toBe('https://example.com/a.ics');
  expect(feedUrl('webcals://example.com/a.ics').url.href).toBe('https://example.com/a.ics');
  const withAuth = feedUrl('https://me:p%40ss@example.com/private.ics');
  expect(withAuth.url.href).toBe('https://example.com/private.ics');
  expect(withAuth.auth).toBe(`Basic ${Buffer.from('me:p@ss').toString('base64')}`);
  expect(() => feedUrl('ftp://example.com/a.ics')).toThrow('not ftp:');
  const fields = manifest.add!.fields!;
  expect(addForm(fields, {}, { url: 'webcal://p01-calendars.icloud.com/published/2/abc' })).toEqual({ config: {}, secret: { url: 'webcal://p01-calendars.icloud.com/published/2/abc' } });
  expect(typeof addForm(fields, {}, { url: 'not a url' })).toBe('string');
  expect(addForm(fields, { url: 'https://x/leak.ics' }, {})).toBe('Feed URL is needed');
});

test('online: one read-only calendar from the feed, its layers, the URL only in secret.json', async () => {
  await online(acc);
  const st = lastStatus(acc)!;
  expect(st.layers.map((l: any) => [l.name, l.state])).toEqual([
    ['feed', 'ok'],
    ['calendar', 'ok'],
  ]);
  expect(st.layers[1].note).toBe('3 events in 3 series');
  expect(st.self).toEqual({ displayName: 'Team', handle: `127.0.0.1:${PORT}` });
  expect(st.details).toMatchObject({ host: `127.0.0.1:${PORT}`, events: 3, refreshBy: 'ETag' });
  expect(evs(acc, 'hello')[0]).toMatchObject({ kind: 'ics', interfaces: ['calendar'] });
  const accDir = m.store.account(acc)!.dir;
  expect(JSON.parse(readFileSync(join(accDir, 'secret.json'), 'utf8'))).toEqual({ url: `${srv.url}/team.ics` });
  expect(readFileSync(join(accDir, 'ics-state.json'), 'utf8')).not.toContain('team.ics');
  expect(readFileSync(join(accDir, 'ics-state.json'), 'utf8')).not.toContain('Book club');
  const { calendars } = await cal('cal.calendars', {});
  expect(calendars).toEqual([{ id: 'feed', name: 'Team', color: '#3366CC', description: null, timeZone: LA, readOnly: true, components: ['event'] }]);
});

let token: string;
test('cal.events: each series once, or expanded across the change to daylight time', async () => {
  const all = await cal('cal.events', { calendarId: 'feed' });
  expect(all.events.map((e: any) => [e.id, e.title])).toEqual([
    ['club@example.com', 'Book club'],
    ['launch', 'Launch day'],
    ['retro', 'Retro'],
  ]);
  expect(all.events[0]).toMatchObject({ uid: 'club@example.com', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'], start: { dateTime: '2026-03-02T18:30:00-08:00', timeZone: LA } });
  expect(all.events[1]).toMatchObject({ start: { date: '2026-03-15' }, end: { date: '2026-03-16' } });
  expect(all.next).toBeNull();
  token = all.syncToken;
  expect(token).toMatch(/^ics1\./);
  const ex = await cal('cal.events', { calendarId: 'feed', from: '2026-03-05T00:00:00Z', to: '2026-03-25T00:00:00Z', expand: true });
  expect(ex.events.map((e: any) => [e.id, e.start.dateTime ?? e.start.date])).toEqual([
    ['club@example.com#20260310T013000Z', '2026-03-09T18:30:00-07:00'],
    ['club@example.com#20260317T013000Z', '2026-03-16T18:30:00-07:00'],
    ['club@example.com#20260324T013000Z', '2026-03-23T18:30:00-07:00'],
    ['launch#20260315', '2026-03-15'],
    ['retro#20260320T170000Z', '2026-03-20T17:00:00Z'],
  ]);
  // A window without expand: the series that fall in it.
  const late = await cal('cal.events', { calendarId: 'feed', from: '2026-03-18T00:00:00Z', to: '2026-04-30T00:00:00Z' });
  expect(late.events.map((e: any) => e.id)).toEqual(['club@example.com', 'retro']);
  expect((await fails(cal('cal.events', { calendarId: 'feed', expand: true }))).status).toBe(400);
  expect((await fails(cal('cal.events', { calendarId: 'other' }))).status).toBe(404);
});

test('refreshes ask with If-None-Match and get 304', async () => {
  const before = srv.hitsOf('/team.ics').length;
  await until(() => srv.hitsOf('/team.ics').length >= before + 2, 10_000, 'two more refreshes');
  const h = srv.hitsOf('/team.ics').slice(before);
  expect(h.every((x) => x.ifNoneMatch && x.status === 304)).toBe(true);
  const none = await cal('cal.changes', { calendarId: 'feed', syncToken: token });
  expect(none).toEqual({ changed: [], removed: [], syncToken: token, more: false });
});

test('the feed changes: cal.changed, and cal.changes names what changed and what went, by uid and recurrence-id', async () => {
  const n = evs(acc, 'cal.changed').length;
  srv.update(
    '/team.ics',
    feed(
      'Team',
      'X-WR-TIMEZONE:America/Los_Angeles',
      ...LA_TZ,
      ...club('EXDATE;TZID=America/Los_Angeles:20260316T183000'),
      // One instance moved.
      ...vevent('UID:club@example.com', 'RECURRENCE-ID;TZID=America/Los_Angeles:20260309T183000', 'DTSTART;TZID=America/Los_Angeles:20260310T190000', 'DTEND;TZID=America/Los_Angeles:20260310T203000', 'SUMMARY:Book club (Tuesday)'),
      ...vevent('UID:launch', 'DTSTART;VALUE=DATE:20260316', 'SUMMARY:Launch day (moved)'),
      ...vevent('UID:demo', 'DTSTART:20260327T170000Z', 'SUMMARY:Demo'),
    ),
  );
  await until(() => evs(acc, 'cal.changed').length > n, 10_000, 'cal.changed');
  expect(evs(acc, 'cal.changed').at(-1)).toMatchObject({ calendarId: 'feed' });
  const ch = await cal('cal.changes', { calendarId: 'feed', syncToken: token });
  expect(ch.changed.map((e: any) => [e.id, e.title]).sort((a: string[], b: string[]) => (a[0] < b[0] ? -1 : 1))).toEqual([
    ['club@example.com', 'Book club'],
    ['club@example.com#20260310T013000Z', 'Book club (Tuesday)'],
    ['demo', 'Demo'],
    ['launch', 'Launch day (moved)'],
  ]);
  const moved = ch.changed.find((e: any) => e.recurrenceId);
  expect(moved).toMatchObject({ uid: 'club@example.com', recurrenceId: { dateTime: '2026-03-09T18:30:00-07:00', timeZone: LA }, start: { dateTime: '2026-03-10T19:00:00-07:00', timeZone: LA } });
  expect(ch.removed).toEqual(['retro']);
  expect(ch.syncToken).not.toBe(token);
  const ex = await cal('cal.events', { calendarId: 'feed', from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z', expand: true });
  expect(ex.events.filter((e: any) => e.uid === 'club@example.com').map((e: any) => [e.title, e.start.dateTime])).toEqual([
    ['Book club', '2026-03-02T18:30:00-08:00'],
    ['Book club (Tuesday)', '2026-03-10T19:00:00-07:00'],
    ['Book club', '2026-03-23T18:30:00-07:00'],
  ]);
  // The old token still answers the same (its version is kept); the new one, nothing.
  expect((await cal('cal.changes', { calendarId: 'feed', syncToken: token })).removed).toEqual(['retro']);
  expect((await cal('cal.changes', { calendarId: 'feed', syncToken: ch.syncToken })).changed).toEqual([]);
  token = ch.syncToken;
});

test('a stale or foreign token is 410; writes are 403', async () => {
  const stale = 'ics1.' + Buffer.from(JSON.stringify({ v: 'gone-version' })).toString('base64url');
  const e = await fails(cal('cal.changes', { calendarId: 'feed', syncToken: stale }));
  expect(e.status).toBe(410);
  expect((await fails(cal('cal.changes', { calendarId: 'feed', syncToken: 'dav1.e30' }))).status).toBe(410);
  expect((await fails(cal('cal.put', { calendarId: 'feed', event: { title: 'x', start: { date: '2026-03-01' } } }))).status).toBe(403);
  expect((await fails(cal('cal.put', { calendarId: 'feed', id: 'demo', event: { title: 'x' } }))).status).toBe(403);
  expect((await fails(cal('cal.delete', { calendarId: 'feed', id: 'demo' }))).status).toBe(403);
});

test('a restart keeps the versions: the token from before still answers, and a change while it was down shows', async () => {
  await fetch(`${m.url}/api/accounts/${acc}/restart`, { method: 'POST' });
  await Bun.sleep(300);
  await online(acc);
  expect((await cal('cal.changes', { calendarId: 'feed', syncToken: token })).changed).toEqual([]);
  await fetch(`${m.url}/api/accounts/${acc}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  srv.update('/team.ics', feed('Team', ...vevent('UID:demo', 'DTSTART:20260327T170000Z', 'SUMMARY:Demo')));
  await fetch(`${m.url}/api/accounts/${acc}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
  await online(acc);
  const ch = await cal('cal.changes', { calendarId: 'feed', syncToken: token });
  expect(ch.changed).toEqual([]);
  expect(ch.removed.sort()).toEqual(['club@example.com', 'club@example.com#20260310T013000Z', 'launch']);
});

test('Last-Modified, and a feed with neither validator whose DTSTAMP moves on every fetch', async () => {
  srv.set('/lm.ics', { text: feed('LM', ...vevent('UID:a', 'DTSTART:20260401T100000Z', 'SUMMARY:A')), mode: 'lastmod' });
  srv.set('/plain.ics', { text: feed('Plain', ...vevent('UID:p', 'DTSTART:20260401T100000Z', 'SUMMARY:P')), mode: 'none' });
  const lm = await add('LM', `${srv.url}/lm.ics`);
  const plain = await add('Plain', `${srv.url}/plain.ics`);
  await online(lm);
  await online(plain);
  await until(() => srv.hitsOf('/lm.ics').some((h) => h.ifModifiedSince && h.status === 304), 10_000, 'a 304 by Last-Modified');
  expect(lastStatus(lm)!.details.refreshBy).toBe('Last-Modified');
  const t = (await cal('cal.events', { calendarId: 'feed' }, plain)).syncToken;
  const before = srv.hitsOf('/plain.ics').length;
  await until(() => srv.hitsOf('/plain.ics').length >= before + 3, 10_000, 'refreshes of the plain feed');
  expect(lastStatus(plain)!.details.refreshBy).toBe('content hash');
  expect(evs(plain, 'cal.changed').length).toBe(0);
  expect((await cal('cal.changes', { calendarId: 'feed', syncToken: t }, plain)).changed).toEqual([]);
  srv.update('/plain.ics', feed('Plain', ...vevent('UID:p', 'DTSTART:20260401T100000Z', 'SUMMARY:P (changed)')));
  await until(() => evs(plain, 'cal.changed').length > 0, 10_000, 'cal.changed by content');
  expect((await cal('cal.changes', { calendarId: 'feed', syncToken: t }, plain)).changed.map((e: any) => e.title)).toEqual(['P (changed)']);
  srv.update('/lm.ics', feed('LM', ...vevent('UID:a', 'DTSTART:20260401T100000Z', 'SUMMARY:A2')));
  await until(() => evs(lm, 'cal.changed').length > 0, 10_000, 'cal.changed by Last-Modified');
});

test('a big feed comes a page at a time', async () => {
  const many = Array.from({ length: 1234 }, (_, i) => vevent(`UID:e${i}`, `DTSTART:202605${String((i % 28) + 1).padStart(2, '0')}T100000Z`, `SUMMARY:E${i}`)).flat();
  srv.set('/big.ics', { text: feed('Big', ...many), mode: 'etag' });
  const big = await add('Big', `${srv.url}/big.ics`, { pollSeconds: 60 });
  await online(big);
  const ids: string[] = [];
  let page = await cal('cal.events', { calendarId: 'feed' }, big);
  let pages = 1;
  ids.push(...page.events.map((e: any) => e.id));
  while (page.next) {
    expect(page.syncToken).toBeNull();
    page = await cal('cal.events', { calendarId: 'feed', pageToken: page.next }, big);
    ids.push(...page.events.map((e: any) => e.id));
    pages++;
  }
  expect(pages).toBe(3);
  expect(new Set(ids).size).toBe(1234);
  expect(page.syncToken).toMatch(/^ics1\./);
});

test('a feed behind Basic auth: with the credentials in the URL it loads, without it says so', async () => {
  srv.set('/private.ics', { text: feed('Private', ...vevent('UID:s', 'DTSTART:20260401T100000Z', 'SUMMARY:Secret')), mode: 'etag', auth: 'me:hunter2' });
  const ok = await add('Private', `http://me:hunter2@127.0.0.1:${PORT}/private.ics`);
  await online(ok);
  expect((await cal('cal.events', { calendarId: 'feed' }, ok)).events.map((e: any) => e.title)).toEqual(['Secret']);
  expect(lastStatus(ok)!.self.handle).toBe(`127.0.0.1:${PORT}`);
  const refused = await add('Refused', `${srv.url}/private.ics`);
  await until(() => lastStatus(refused)?.status === 'attention', 10_000, 'attention');
  expect(lastStatus(refused)!.layers.map((l: any) => [l.name, l.state])).toEqual([
    ['feed', 'failed'],
    ['calendar', 'waiting'],
  ]);
  expect((await fails(cal('cal.events', { calendarId: 'feed' }, refused))).status).toBe(401);
  const gone = await add('Gone', `${srv.url}/nothing-here.ics`);
  await until(() => lastStatus(gone)?.status === 'attention', 10_000, 'attention for a 404');
  expect(lastStatus(gone)!.layers[0].note).toContain('gone (404)');
  srv.set('/junk.ics', { text: '<html>not a calendar</html>', mode: 'etag' });
  const junk = await add('Junk', `${srv.url}/junk.ics`);
  await until(() => lastStatus(junk)?.layers?.[1]?.state === 'failed', 10_000, 'calendar failed');
  expect(lastStatus(junk)!.layers[1].note).toContain('not iCalendar');
});

test('the server goes down: the last copy still answers and the layer says so; then it is back', async () => {
  const t = (await cal('cal.events', { calendarId: 'feed' })).syncToken;
  srv.stop();
  await until(() => lastStatus(acc)?.layers?.[0]?.state === 'failed', 20_000, 'feed layer failed');
  expect(lastStatus(acc)!.layers[0].note).toContain('not reachable');
  expect(lastStatus(acc)!.layers[0].note).toContain('showing the copy from');
  expect((await cal('cal.events', { calendarId: 'feed' })).events.map((e: any) => e.id)).toEqual(['demo']);
  const nowhere = await add('Nowhere', 'http://127.0.0.1:18539/x.ics');
  await until(() => lastStatus(nowhere)?.layers?.[0]?.state === 'failed', 20_000, 'nowhere failed');
  expect((await fails(cal('cal.events', { calendarId: 'feed' }, nowhere))).status).toBe(503);
  srv.start();
  await until(() => lastStatus(acc)?.layers?.[0]?.state === 'ok', 20_000, 'feed back');
  expect((await cal('cal.changes', { calendarId: 'feed', syncToken: t })).changed).toEqual([]);
});
