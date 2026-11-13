import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { googleCalendar } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { CLIENT, type FakeGoogle, startFakeGoogle } from './fake-google.ts';

const LA = 'America/Los_Angeles';
const PRIMARY = 'me@example.com';
let fake: FakeGoogle;
let m: Manager;
let dir: string;
let app: AccountsClient;
let account: string;
const saved: Record<string, string | undefined> = {};

const until = async (f: () => boolean | Promise<boolean>, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = (path: string, init: RequestInit = {}) => fetch(m.url + path, { redirect: 'manual', ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
const provider = async () => (await (await api('/api/providers/google')).json()) as any;

/** The consent round trip as a browser does it: start → Google says yes → callback. */
async function connect(email: string, query = '') {
  const start = await api(`/oauth/google/start${query}`);
  expect(start.status).toBe(302);
  const consent = start.headers.get('location')!;
  const { code, state } = fake.authorize(consent, email);
  const cb = await api(`/oauth/google/callback?code=${code}&state=${state}`);
  expect(cb.status).toBe(302);
  return { consent: new URL(consent), back: cb.headers.get('location') };
}

beforeAll(async () => {
  fake = startFakeGoogle();
  for (const [k, v] of Object.entries(fake.env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  fake.addCalendar({ id: PRIMARY, summary: PRIMARY, timeZone: LA, accessRole: 'owner', primary: true, selected: true, backgroundColor: '#9fe1e7' });
  dir = mkdtempSync(join(tmpdir(), 'dacc-google-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, publicUrl: 'https://accounts.test' });
});
afterAll(async () => {
  app?.close();
  await m.stop();
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('before a client is set: not configured, and starting says so', async () => {
  expect(await provider()).toEqual({ configured: false, redirectUri: 'https://accounts.test/oauth/google/callback', accounts: [], error: null });
  const r = await api('/oauth/google/start');
  expect(r.headers.get('location')).toBe('/#/accounts?google_error=not_configured');
});

test('the client is kept 0600 and never shown', async () => {
  expect((await api('/api/providers/google/client', { method: 'PUT', body: JSON.stringify({ clientId: 'x' }) })).status).toBe(400);
  const r = await api('/api/providers/google/client', { method: 'PUT', body: JSON.stringify(CLIENT) });
  expect(r.status).toBe(200);
  const st = (await r.json()) as any;
  expect(st.configured).toBe(true);
  expect(JSON.stringify(st)).not.toContain(CLIENT.clientSecret);
  expect(statSync(join(dir, 'providers/google.json')).mode & 0o777).toBe(0o600);
  // A browser on another site may not set it.
  expect((await api('/api/providers/google/client', { method: 'PUT', body: JSON.stringify(CLIENT), headers: { origin: 'https://evil.example' } })).status).toBe(403);
});

test('connecting: PKCE consent, a google-api account with its token 0600, its extractor online', async () => {
  const { consent, back } = await connect('zya@example.com');
  const p = consent.searchParams;
  expect(p.get('scope')).toBe('https://www.googleapis.com/auth/calendar openid email');
  expect([p.get('access_type'), p.get('prompt'), p.get('include_granted_scopes'), p.get('code_challenge_method')]).toEqual(['offline', 'consent', 'true', 'S256']);
  expect(p.get('redirect_uri')).toBe('https://accounts.test/oauth/google/callback');
  expect(back).toBe('/#/accounts');

  const st = await provider();
  expect(st.accounts).toEqual([{ id: expect.any(String), email: 'zya@example.com', scopes: ['calendar'] }]);
  account = st.accounts[0].id;
  const acc = m.store.account(account)!;
  expect(acc).toMatchObject({ kind: 'google-api', label: 'zya@example.com', created_by: null });
  const secretPath = join(acc.dir, 'secret.json');
  expect(statSync(secretPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(secretPath, 'utf8'))).toMatchObject({ refreshToken: expect.stringMatching(/^rt-/), email: 'zya@example.com', sub: 'sub-zya@example.com', clientId: CLIENT.clientId });
  expect(acc.config).not.toContain('rt-');
  await until(() => m.sup.state(account).online, 10_000, 'the google extractor online');
  const state = (await (await api('/api/state')).json()) as any;
  expect(state.accounts.find((a: any) => a.id === account).status).toEqual({ status: 'online' });
  expect(JSON.stringify(state)).not.toContain('rt-');
});

test('connecting the same Google account again updates it rather than adding one', async () => {
  const before = fake.refreshTokens.length;
  await connect('zya@example.com');
  expect((await provider()).accounts.map((a: any) => a.id)).toEqual([account]);
  expect(fake.refreshTokens.length).toBe(before + 1);
  await until(() => m.sup.state(account).online, 10_000, 'back online');
});

test('an app with a google.calendar grant syncs through the manager', async () => {
  const reg = await register(m.url, { name: 'calendar-app', requests: [{ interface: 'google.calendar', level: 'write' }] });
  expect((await api(`/api/requests/${reg.requests[0].id}/approve`, { method: 'POST', body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token });
  await until(() => app.accounts.some((a) => a.id === account && a.grants['google.calendar'] === 'write'), 4000, 'the grant');

  const list = await app.call(googleCalendar, account, 'calendar.calendarList.list', { maxResults: 250 });
  expect(list.items.map((c: any) => c.id)).toEqual([PRIMARY]);

  fake.put(PRIMARY, { id: 'g1', summary: 'Dentist', start: { dateTime: '2026-11-05T15:00:00-08:00', timeZone: LA }, end: { dateTime: '2026-11-05T16:00:00-08:00', timeZone: LA } });
  const first = await app.call(googleCalendar, account, 'calendar.events.list', { calendarId: PRIMARY, singleEvents: false, maxResults: 2500 });
  expect(first.items.map((e: any) => e.summary)).toEqual(['Dentist']);
  expect(first.nextSyncToken).toBeTruthy();

  const made = await app.call(googleCalendar, account, 'calendar.events.insert', { calendarId: PRIMARY, body: { summary: 'Dinner', start: { dateTime: '2026-11-06T19:00:00-08:00' }, end: { dateTime: '2026-11-06T21:00:00-08:00' } } });
  await app.call(googleCalendar, account, 'calendar.events.patch', { calendarId: PRIMARY, eventId: made.id, body: { location: "Luigi's" } });
  expect(fake.event(PRIMARY, made.id)).toMatchObject({ summary: 'Dinner', location: "Luigi's" });

  const delta = await app.call(googleCalendar, account, 'calendar.events.list', { calendarId: PRIMARY, syncToken: first.nextSyncToken });
  expect(delta.items.map((e: any) => e.summary)).toEqual(['Dinner']);

  expect(await app.call(googleCalendar, account, 'calendar.events.delete', { calendarId: PRIMARY, eventId: made.id })).toEqual({});
  const gone = (await app.call(googleCalendar, account, 'calendar.events.delete', { calendarId: PRIMARY, eventId: made.id }).catch((e: any) => e)) as CallFailed;
  expect([gone.code, gone.status]).toEqual(['failed', 410]);

  fake.invalidate(PRIMARY);
  const stale = (await app.call(googleCalendar, account, 'calendar.events.list', { calendarId: PRIMARY, syncToken: delta.nextSyncToken }).catch((e: any) => e)) as CallFailed;
  expect(stale.status).toBe(410);
});

test('one occurrence of a series is patched as its instance; calendars are made and coloured', async () => {
  const master = fake.put(PRIMARY, { id: 'series1', summary: 'Standup', start: { dateTime: '2026-11-02T10:00:00-08:00', timeZone: LA }, end: { dateTime: '2026-11-02T10:15:00-08:00', timeZone: LA }, recurrence: ['RRULE:FREQ=WEEKLY'] });
  const inst = await app.call(googleCalendar, account, 'calendar.events.patch', { calendarId: PRIMARY, eventId: `${master.id}_20261109T180000Z`, body: { summary: 'Standup (long)' } });
  expect(inst).toMatchObject({ recurringEventId: 'series1', summary: 'Standup (long)' });

  const cal = await app.call(googleCalendar, account, 'calendar.calendars.insert', { body: { summary: 'From chats', timeZone: LA } });
  await app.call(googleCalendar, account, 'calendar.calendarList.patch', { calendarId: cal.id, colorRgbFormat: true, body: { backgroundColor: '#b79bff' } });
  expect(fake.calendar(cal.id)).toMatchObject({ summary: 'From chats', backgroundColor: '#b79bff' });
});

test('tokens: an expired access token is refreshed, a 503 retried', async () => {
  const before = fake.tokenRequests.filter((x) => x === 'refresh_token').length;
  fake.expireAccessTokens();
  fake.failNext(503, 1);
  const list = await app.call(googleCalendar, account, 'calendar.calendarList.list', {});
  expect(list.items.length).toBeGreaterThan(0);
  expect(fake.tokenRequests.filter((x) => x === 'refresh_token').length).toBe(before + 1);
});

test('a revoked grant puts the account in attention and calls fail clearly', async () => {
  const appEvents: any[] = [];
  (app as any).opts.onEvents = (_: string, evs: any[]) => appEvents.push(...evs);
  fake.revokeAll();
  const e = (await app.call(googleCalendar, account, 'calendar.calendarList.list', {}).catch((x: any) => x)) as CallFailed;
  expect([e.code, e.status]).toEqual(['failed', 401]);
  expect(e.message).toContain('connect it again');
  await until(() => appEvents.some((x) => x.t === 'status' && x.status === 'attention'), 4000, 'attention');
  const state = (await (await api('/api/state')).json()) as any;
  expect(state.accounts.find((a: any) => a.id === account).status).toMatchObject({ status: 'attention', attention: { kind: 'login' } });
  // Connecting again clears it.
  await connect('zya@example.com', `?account=${account}`);
  await until(() => m.sup.state(account).online, 10_000, 'online again');
  expect((await app.call(googleCalendar, account, 'calendar.calendarList.list', {})).items.length).toBeGreaterThan(0);
});

test('disconnecting revokes, removes the account and its directory', async () => {
  const d = m.store.account(account)!.dir;
  const refresh = JSON.parse(readFileSync(join(d, 'secret.json'), 'utf8')).refreshToken;
  const r = await api(`/api/providers/google/accounts/${account}`, { method: 'DELETE' });
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).accounts).toEqual([]);
  expect(m.store.account(account)).toBeNull();
  expect(existsSync(d)).toBe(false);
  expect(fake.refreshTokens).not.toContain(refresh);
  await until(() => !app.accounts.some((a) => a.id === account), 4000, 'the app no longer sees it');
});
