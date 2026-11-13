/**
 * extractors/google end to end: a real manager runs the extractor, which runs a real Chromium on Xvfb (and x11vnc)
 * with its extension, against the fake Google's stand-in Calendar and Gmail pages and their APIs (fake-google.ts,
 * `web`; Gmail on an origin of its own). Skipped when Xvfb, chromium or x11vnc cannot be found. Every process it starts
 * is gone at the end.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, type CallFailed, register } from '@dither-accounts/client';
import { googleCalendar, mail as mailIface } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { resolveBins } from '../packages/browser/src/index.ts';
import { inetSockets, rfbBanner, x11vncs } from '../packages/browser/test/inet.ts';
import { type FakeGoogle, type FakeMessage, fakeEml, GMAIL_ROWS, startFakeGoogle } from './fake-google.ts';

const LA = 'America/Los_Angeles';
const PRIMARY = 'pat@example.com';
const WEB = {
  sapisid: 'sapisid-that-must-not-leak',
  pageKey: `AIza${'P'.repeat(35)}`,
  htmlKey: `AIza${'H'.repeat(35)}`,
  email: PRIMARY,
  mailKey: `AIza${'M'.repeat(35)}`,
  mailEmail: 'mailbox-owner@example.com',
  labels: ['INBOX', 'secret-label-name', 'another-secret-label'],
  /** What the stand-in Gmail app's rows and /sync answers are full of (fake-gmail-page.js). */
  mailMark: 'Mk#7731',
};
/** What the Gmail side holds that must never reach a log, a status, the probe's answer or the recorded shapes. */
const MAIL_SECRETS = [WEB.mailKey, WEB.mailEmail, 'secret-label-name', 'another-secret-label', 'secret-subject-line', '424242', WEB.mailMark, 'Mk%237731'];

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`google-browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakeGoogle;
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let signedIn: string;
let signedOut: string;
let mailOff: string;
const events: Record<string, any[]> = {};
const saved = process.env.DITHER_GOOGLE_BACKOFF_MS;

const until = async (f: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const statusOf = (account: string) => events[account]?.filter((e) => e.t === 'status').at(-1);
const layerOf = (account: string, name: string) => statusOf(account)?.layers?.find((l: any) => l.name === name);
const config = (authuser: number, more: Record<string, unknown> = {}) => ({ authuser, testOrigin: fake.url, apiBase: fake.url, testMailOrigin: fake.mailUrl, gmailApiBase: fake.mailUrl, ...more });
const accountDir = (id: string) => m!.store.account(id)!.dir;
const logOf = (id: string) => readFileSync(join(accountDir(id), 'adapter.log'), 'utf8');
/** The Gmail probe, asked for as an operator would (a file in the account's directory); its answer. */
async function probeGmail(id: string, ms = 20_000): Promise<any> {
  const out = join(accountDir(id), 'probe-gmail.json');
  rmSync(out, { force: true });
  writeFileSync(join(accountDir(id), 'probe-gmail.request'), '');
  await until(() => existsSync(out), ms, 'probe-gmail.json');
  expect(existsSync(join(accountDir(id), 'probe-gmail.request'))).toBe(false);
  return JSON.parse(readFileSync(out, 'utf8'));
}

/** A learn run's script, put where the extractor looks for it (written whole, as an operator should). */
function learnScript(id: string, script: unknown) {
  const path = join(accountDir(id), 'gmail-learn.json');
  writeFileSync(`${path}.tmp`, JSON.stringify(script));
  renameSync(`${path}.tmp`, path);
}

/** Every process on this machine started for these accounts (the extractor and all it spawned inherit the id). */
function processesOf(ids: string[]): number[] {
  const needles = ids.map((id) => `DITHER_ACCOUNT_ID=${id}`);
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if (needles.some((n) => env.includes(n))) out.push(Number(d));
    } catch {}
  }
  return out;
}


beforeAll(async () => {
  if (!bins) return;
  process.env.DITHER_GOOGLE_BACKOFF_MS = '1';
  fake = startFakeGoogle({ web: WEB });
  fake.addCalendar({ id: PRIMARY, summary: PRIMARY, timeZone: LA, accessRole: 'owner', primary: true, selected: true, backgroundColor: '#9fe1e7' });
  dir = mkdtempSync(join(tmpdir(), 'dacc-gweb-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  const reg = await register(m.url, { name: 'gweb-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['google'] }, { interface: 'google.calendar', level: 'write' }, { interface: 'mail', level: 'read' }] });
  for (const r of reg.requests) expect((await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, evs) => (events[a] ??= []).push(...evs) });
  await until(() => app.connected, 5000, 'the app connected');
  // The signed-in account most tests use, made here rather than in the first test, so that any one of them runs alone
  // (bun test -t): each test below that uses it starts from it up, its Gmail page too.
  signedIn = (await app.admin({ do: 'create', kind: 'google', label: 'Google (test)', config: config(0, { gmailPollSeconds: 2 }) })).id;
  await until(() => statusOf(signedIn)?.status === 'online' && statusOf(signedIn)?.details?.email === WEB.email && statusOf(signedIn)?.details?.endpointsSeen === 2, 60_000, 'online');
  await until(() => layerOf(signedIn, 'Gmail page')?.state === 'ok', 30_000, 'the Gmail page up');
}, 120_000);

afterAll(async () => {
  if (!bins) return;
  app?.close();
  await m?.stop();
  // Whatever a failed test left running.
  for (const pid of processesOf([signedIn, signedOut, mailOff].filter(Boolean))) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fake?.stop();
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.DITHER_GOOGLE_BACKOFF_MS;
  else process.env.DITHER_GOOGLE_BACKOFF_MS = saved;
}, 30_000);

it(
  'signed in: online, with a live view and the session as facts',
  async () => {
    await until(() => statusOf(signedIn)?.status === 'online' && statusOf(signedIn)?.details?.email === WEB.email && statusOf(signedIn)?.details?.endpointsSeen === 2, 60_000, 'online');
    await until(() => layerOf(signedIn, 'Gmail page')?.state === 'ok', 30_000, 'the Gmail page up');
    const st = statusOf(signedIn);
    expect(st.attention).toBeNull();
    // Apps get the live view's size, not its socket (an app opens it through the manager); the manager keeps the socket,
    // vnc.sock in the account's directory.
    expect(st.liveView).toEqual({ width: 1280, height: 800 });
    const lv = m!.router.liveView(signedIn)!;
    expect(lv).toEqual({ vncSocket: join(m!.store.account(signedIn)!.dir, 'vnc.sock'), width: 1280, height: 800 });
    expect(st.self).toEqual({ email: WEB.email });
    expect(st.details).toMatchObject({
      email: WEB.email,
      authuser: '0',
      page: `${fake.url}/calendar/u/0/r`,
      extensionAttached: true,
      calendarPage: true,
      signedIn: true,
      // The page's own Calendar call's key; its hashes end in _u, which this fake refuses, so the plain hash won.
      keySource: 'calendar-request',
      authStyle: 'plain',
      lastProbeStatus: 200,
      pageAuth: 'SAPISIDHASH _u',
      provider: 'Gmail',
      // Both tabs, each with its hook, and nothing of what is in them.
      tabs: 'calendar (hook up), gmail (hook up)',
      mail: true,
      gmailTab: `${fake.mailUrl}/mail/u/0/`,
      gmailPage: true,
      gmailSignedIn: true,
      calendarReloads: 0,
      gmailReloads: 0,
      gmailProbe: null,
      // To a mail client: Gmail, read through its page; not sending yet.
      idPerMessage: true,
      summaryHeaders: false,
      raw: 'original',
      searchIds: true,
      canSend: false,
      sendNote: 'Sending from Gmail is not built yet',
      gmailWatch: 'starts with the first mail call',
      gmailSelfCheck: null,
      // The background lane (an app's archive sends background: true), not stopped; reads have not been seen to mark mail read.
      backgroundLane: true,
      backgroundStopped: null,
      readsMarkRead: false,
    });
    expect(layerOf(signedIn, 'Gmail page')).toEqual({ name: 'Gmail page', state: 'ok', note: 'hook up, signed in' });
    // Calendar's chain as it was, then the Gmail page, which it does not rest on.
    expect(st.layers.map((l: any) => [l.name, l.state])).toEqual([
      ['display', 'ok'],
      ['browser', 'ok'],
      ['extension', 'ok'],
      ['signed in', 'ok'],
      ['API key', 'ok'],
      ['Calendar API', 'ok'],
      ['Gmail page', 'ok'],
      ['Gmail protocol', 'waiting'],
      ['Gmail background', 'ok'],
    ]);
    expect(layerOf(signedIn, 'Gmail background')).toEqual({ name: 'Gmail background', state: 'ok', note: 'idle' });
    expect([fake.pageLoads('calendar', 0), fake.pageLoads('gmail', 0)]).toEqual([1, 1]);
    expect(st.details.display).toMatch(/^:(8\d|1[0-5]\d)$/); // :80–:89, then :100–:159
    expect(events[signedIn].find((e) => e.t === 'hello')).toMatchObject({ network: 'google', version: '1', capabilities: ['liveView'] });
    expect(await rfbBanner(lv.vncSocket)).toMatch(/^RFB \d{3}\.\d{3}/);
    // Its x11vnc listens on that socket only: no TCP or UDP socket at all.
    const vnc = x11vncs(processesOf([signedIn]));
    expect(vnc.length).toBe(1);
    expect(inetSockets(vnc[0]!)).toEqual([]);
    const kept = JSON.parse(readFileSync(join(m!.store.account(signedIn)!.dir, 'state.json'), 'utf8'));
    expect(kept).toEqual({ key: WEB.pageKey, source: 'calendar-request', auth: 'plain' });
  },
  90_000,
);

it(
  'calendars and events through the manager: list, insert, patch, delete, 410s',
  async () => {
    const list = await app.call(googleCalendar, signedIn, 'calendar.calendarList.list', { maxResults: 250 });
    expect(list.items.map((c: any) => c.id)).toEqual([PRIMARY]);

    fake.put(PRIMARY, { id: 'g1', summary: 'Dentist', start: { dateTime: '2026-11-05T15:00:00-08:00', timeZone: LA }, end: { dateTime: '2026-11-05T16:00:00-08:00', timeZone: LA } });
    const first = await app.call(googleCalendar, signedIn, 'calendar.events.list', { calendarId: PRIMARY, singleEvents: false, maxResults: 2500 });
    expect(first.items.map((e: any) => e.summary)).toEqual(['Dentist']);
    expect(first.nextSyncToken).toBeTruthy();

    const made = await app.call(googleCalendar, signedIn, 'calendar.events.insert', { calendarId: PRIMARY, body: { summary: 'Dinner', start: { dateTime: '2026-11-06T19:00:00-08:00' }, end: { dateTime: '2026-11-06T21:00:00-08:00' } } });
    // (Not toMatchObject with expect.any: bun writes the matcher into `made`.)
    expect([typeof made.id, made.summary]).toEqual(['string', 'Dinner']);
    await app.call(googleCalendar, signedIn, 'calendar.events.patch', { calendarId: PRIMARY, eventId: made.id, body: { location: "Luigi's" } });
    expect(fake.event(PRIMARY, made.id)).toMatchObject({ summary: 'Dinner', location: "Luigi's" });

    const delta = await app.call(googleCalendar, signedIn, 'calendar.events.list', { calendarId: PRIMARY, syncToken: first.nextSyncToken });
    expect(delta.items.map((e: any) => e.summary)).toEqual(['Dinner']);

    expect(await app.call(googleCalendar, signedIn, 'calendar.events.delete', { calendarId: PRIMARY, eventId: made.id })).toEqual({});
    const gone = (await app.call(googleCalendar, signedIn, 'calendar.events.delete', { calendarId: PRIMARY, eventId: made.id }).catch((e: any) => e)) as CallFailed;
    expect([gone.code, gone.status]).toEqual(['failed', 410]);

    fake.invalidate(PRIMARY);
    const stale = (await app.call(googleCalendar, signedIn, 'calendar.events.list', { calendarId: PRIMARY, syncToken: delta.nextSyncToken }).catch((e: any) => e)) as CallFailed;
    expect([stale.code, stale.status]).toEqual(['failed', 410]);

    const cal = await app.call(googleCalendar, signedIn, 'calendar.calendars.insert', { body: { summary: 'From chats', timeZone: LA } });
    await app.call(googleCalendar, signedIn, 'calendar.calendarList.patch', { calendarId: cal.id, colorRgbFormat: true, body: { backgroundColor: '#b79bff' } });
    expect(fake.calendar(cal.id)).toMatchObject({ summary: 'From chats', backgroundColor: '#b79bff' });

    // Every call went out with a key and the cookie's hash (the fake refuses anything else).
    expect(fake.calls.filter((c) => c.includes('/calendar/v3/') && !c.includes(`key=${WEB.pageKey}`))).toEqual([]);
  },
  60_000,
);

it(
  'a key Google stops taking is probed again once, and the next one kept',
  async () => {
    fake.setKeys([WEB.htmlKey]);
    const list = await app.call(googleCalendar, signedIn, 'calendar.calendarList.list', {});
    expect(list.items.length).toBeGreaterThan(0);
    await until(() => statusOf(signedIn)?.details?.keySource === 'page-html', 5000, 'the new key in the status');
    expect(statusOf(signedIn).status).toBe('online');
    expect(JSON.parse(readFileSync(join(m!.store.account(signedIn)!.dir, 'state.json'), 'utf8'))).toMatchObject({ key: WEB.htmlKey, source: 'page-html' });
  },
  30_000,
);

it(
  'the Gmail API probe: asked for with a file, answered in probe-gmail.json with statuses and no values',
  async () => {
    const r = await probeGmail(signedIn);
    expect(r).toMatchObject({ origin: fake.mailUrl, api: fake.mailUrl, page: { tab: true, hook: true, signedIn: true, keys: ['page-html'] }, accepted: true, error: null });
    // No key, then the key in the Gmail page's HTML; each with the plain and the _u hash. The fake takes the key and a
    // hash made with the Gmail page's own origin, and refuses _u.
    const rows = r.results.map((x: any) => [x.endpoint, x.key, x.auth, x.status, x.googleStatus ?? null, x.reason ?? null]);
    expect(rows).toEqual([
      ['profile', 'none', 'plain', 403, 'PERMISSION_DENIED', 'forbidden'],
      ['profile', 'none', 'u', 403, 'PERMISSION_DENIED', 'forbidden'],
      ['profile', 'page-html', 'plain', 200, null, null],
      ['profile', 'page-html', 'u', 401, 'UNAUTHENTICATED', 'authError'],
      ['labels', 'none', 'plain', 403, 'PERMISSION_DENIED', 'forbidden'],
      ['labels', 'none', 'u', 403, 'PERMISSION_DENIED', 'forbidden'],
      ['labels', 'page-html', 'plain', 200, null, null],
      ['labels', 'page-html', 'u', 401, 'UNAUTHENTICATED', 'authError'],
    ]);
    expect(r.results[0].message).toStartWith("Method doesn't allow unregistered callers");
    expect(r.results[2].fields).toEqual(['emailAddress', 'historyId', 'messagesTotal', 'threadsTotal']);
    expect(r.results[6].labels).toBe(3);
    expect(r.acceptedWith).toEqual([
      { endpoint: 'profile', key: 'page-html', auth: 'plain' },
      { endpoint: 'labels', key: 'page-html', auth: 'plain' },
    ]);
    // Field names and a count: no address, label name, key, cookie or number from the mailbox.
    const text = readFileSync(join(accountDir(signedIn), 'probe-gmail.json'), 'utf8');
    for (const secret of [...MAIL_SECRETS, WEB.sapisid, WEB.email, 'messagesTotal": ', 'historyId": ']) expect(text).not.toContain(secret);
    expect(fake.mailCalls.filter((c) => c.startsWith('GET /gmail/v1/')).length).toBe(8);
    await until(() => String(statusOf(signedIn)?.details?.gmailProbe).startsWith('accepted ('), 5000, 'the probe in the details');
    expect(logOf(signedIn)).toContain('gmail probe: profile, key page-html, plain hash: 200 fields emailAddress,historyId,messagesTotal,threadsTotal');
  },
  60_000,
);

it(
  'learning Gmail: a run goes to an operators-only search, opens read threads only, goes back, and collects shapes with no content',
  async () => {
    const dir = accountDir(signedIn);
    const out = join(dir, 'gmail-shapes.json');
    rmSync(out, { force: true });
    // The stand-in Gmail app's own first calls are in.
    await until(() => fake.mailCalls.some((c) => c.startsWith('POST /sync/u/0/i/bv')) && fake.mailCalls.some((c) => c.startsWith('GET /mail/u/0/x/')), 15_000, "the Gmail page's own calls");
    expect(fake.mailOpened).toEqual([]);
    const before = logOf(signedIn).length;
    learnScript(signedIn, {
      steps: [
        { nav: '#search/in:inbox is:read' },
        { wait: 1 },
        { openRead: 0 },
        { wait: 1 },
        { back: true },
        { wait: 1 },
        { openRead: 1 },
        { wait: 1 },
        { back: true },
        { wait: 1 },
        { openRead: 9 },
        { collect: true },
      ],
    });
    await until(() => existsSync(out), 40_000, 'gmail-shapes.json');
    await until(() => logOf(signedIn).slice(before).includes('gmail learn: ran 12 steps'), 5000, 'the run done');
    expect(existsSync(join(dir, 'gmail-learn.json'))).toBe(false);
    // The list's first rows are unread or uncertain (zE; neither marker; an unread sender; drawn bold; both markers):
    // only the first and second certainly read rows were opened, each by a click.
    expect(fake.mailOpened).toEqual([GMAIL_ROWS[5]!.t, GMAIL_ROWS[7]!.t]);
    const log = logOf(signedIn).slice(before);
    expect(log).toContain('gmail learn: running 12 steps');
    expect(log).toContain('gmail learn: step 1 (nav to a search (2 operators)): done');
    expect(log).toContain('gmail learn: step 3 (openRead 0): opened');
    expect(log).toContain('gmail learn: step 5 (back): done');
    expect(log).toContain('gmail learn: step 7 (openRead 1): opened');
    expect(log).toContain('gmail learn: step 11 (openRead 9): not opened (the list shows 2 read and 6 unread or uncertain rows; there is no read row 9)');
    expect(log).toContain('gmail learn: collected 5 templates: POST /mail/u/0/ ×1, GET /mail/u/0/x/{id}/ ×1, POST /sync/u/0/i/bv ×4, POST /sync/u/0/i/fd ×2, POST /sync/u/0/i/s ×1; written to gmail-shapes.json');
    expect(log).toContain('gmail learn: ran 12 steps; opened 2 read threads; collected 5 templates');
    // Never the search's words.
    for (const w of ['in:inbox', 'is:read', 'in%3Ainbox']) expect(log).not.toContain(w);
    await until(() => statusOf(signedIn)?.details?.gmailLearn === 'ran 12 steps; opened 2 read threads; collected 5 templates', 5000, 'the run in the details');

    const text = readFileSync(out, 'utf8');
    for (const secret of [...MAIL_SECRETS, WEB.sapisid, WEB.email, 'dinner', 'plans', 'snippet', 'Person', 'FMfcg', '1800000000000000', fake.gmail.xsrf, fake.gmail.ik]) expect(text).not.toContain(secret);
    const shapes = JSON.parse(text);
    // The page's own: its list, threads and resource as before; its first sync (s) and a call carrying its key.
    expect(shapes.templates.map((t: any) => [t.method, t.template, t.count])).toEqual([
      ['POST', '/mail/u/0/', 1],
      ['GET', '/mail/u/0/x/{id}/', 1],
      ['POST', '/sync/u/0/i/bv', 4],
      ['POST', '/sync/u/0/i/fd', 2],
      ['POST', '/sync/u/0/i/s', 1],
    ]);
    const [, x, bv, fd] = shapes.templates;
    expect(x.samples).toEqual([{ status: 200, contentType: 'text/html', requestShape: { query: { ver: 's<10' } }, responseShape: { text: '<100' } }]);
    // The list: once by fetch with a JSON body, then by XMLHttpRequest with a form-encoded f.req (the same shape each
    // time it came back to the list, so one sample).
    expect(bv.samples.length).toBe(2);
    const thread = ['id:thread-f', [['id:msg-f', [['Subject', 's<100'], ['From', 'e'], ['Message-ID', 'e'], ['X-Gmail-Labels', 's<100']], 's<100', 'n:ms'], ['^all', '^i', 's<100', '^smartlabel_personal']], true, ['h16', 'ts', 'url', 'b64']];
    const list = { json: [['s<10', [thread, [...thread.slice(0, 2), false, thread[3]], thread], '^i', 8], 'n:ms', { total: 8, 'k*': 1 }, 's<100'] };
    expect(bv.samples[0]).toEqual({ status: 200, contentType: 'application/json', requestShape: { query: { hl: 's<10', c: 0, rt: 's<10' }, body: { json: [['^i', 50, null, ['s<100']], 'n:ms'] } }, responseShape: list });
    expect(bv.samples[1]).toEqual({ status: 200, contentType: 'application/json', requestShape: { query: { hl: 's<10', c: 2, rt: 's<10' }, body: { form: { 'f.req': [['^i', 50], 's<100', 'n:ms'], at: 's<100' } } }, responseShape: list });
    expect(fd.samples).toEqual([
      {
        status: 200,
        contentType: 'application/json',
        requestShape: { query: { hl: 's<10', c: 1, rt: 's<10' }, body: { json: [['id:thread-f', 's<100'], 2] } },
        responseShape: { json: [[thread[0], thread[1], false, thread[3]], 'n:s', 's<100', 's<100'] },
      },
    ]);
    expect(shapes.dropped).toBe(0);
  },
  90_000,
);

it(
  'learning Gmail: a script with a free-text search, more than 5 openRead steps, or a bad step is refused, and nothing of it runs',
  async () => {
    const dir = accountDir(signedIn);
    const calls = fake.mailCalls.length;
    const opened = fake.mailOpened.length;
    const shapesAt = existsSync(join(dir, 'gmail-shapes.json')) ? readFileSync(join(dir, 'gmail-shapes.json'), 'utf8') : null;
    for (const [script, why] of [
      [{ steps: [{ nav: '#search/in:inbox dinner plans' }, { openRead: 0 }, { collect: true }] }, 'step 1: nav: search word 2 is not an operator'],
      [{ steps: [{ nav: '#inbox' }, ...Array(6).fill({ openRead: 0 }), { collect: true }] }, 'more than 5 openRead steps; at most 5 in a run'],
      [{ steps: [{ collect: true }, { nav: '#search/from:someone@example.net' }] }, 'step 2: nav: search word 1 is not an operator'],
      [{ steps: [{ nav: '#inbox' }, { wait: 60 }, { collect: true }] }, 'step 2: a wait is 1 to 20 seconds'],
    ] as const) {
      const before = logOf(signedIn).length;
      learnScript(signedIn, script);
      await until(() => logOf(signedIn).slice(before).includes('gmail learn: refused, nothing ran: '), 10_000, 'the refusal');
      const log = logOf(signedIn).slice(before);
      expect(log).toContain(`gmail learn: refused, nothing ran: ${why}`);
      expect(log).not.toContain('gmail learn: running');
      expect(log).not.toContain('dinner');
      expect(log).not.toContain('someone@');
      expect(existsSync(join(dir, 'gmail-learn.json'))).toBe(false);
    }
    await until(() => String(statusOf(signedIn)?.details?.gmailLearn).startsWith('refused: step 2: a wait'), 5000, 'the refusal in the details');
    // The page was not steered: it made no call of its own since (it calls on every hash change and opened row), and
    // nothing was collected.
    await Bun.sleep(1500);
    expect(fake.mailCalls.length).toBe(calls);
    expect(fake.mailOpened.length).toBe(opened);
    expect(existsSync(join(dir, 'gmail-shapes.json')) ? readFileSync(join(dir, 'gmail-shapes.json'), 'utf8') : null).toBe(shapesAt);
  },
  60_000,
);

it(
  'no cross-stalling: a Gmail page that does not answer holds up no Calendar call',
  async () => {
    const out = join(accountDir(signedIn), 'probe-gmail.json');
    rmSync(out, { force: true });
    fake.stall('gmail', 'on');
    writeFileSync(join(accountDir(signedIn), 'probe-gmail.request'), '');
    await until(() => fake.held('gmail') > 0, 15_000, 'a Gmail call hanging');
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const list = await app.call(googleCalendar, signedIn, 'calendar.calendarList.list', {});
      expect(list.items.length).toBeGreaterThan(0);
      expect(Date.now() - t0).toBeLessThan(3000);
    }
    expect(fake.held('gmail')).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(false);
    // Gmail answers again: the probe goes on where it was and finishes.
    fake.stall('gmail', 'off');
    await until(() => existsSync(out), 20_000, 'probe-gmail.json');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ accepted: true, error: null });
    expect(statusOf(signedIn).details).toMatchObject({ calendarReloads: 0, gmailReloads: 0 });
  },
  60_000,
);

it(
  'a Calendar page that stops answering: each call says so within 25 s, Gmail goes on, and after two in a row that tab alone is reloaded and answers again',
  async () => {
    const starts = () => logOf(signedIn).split('\n').filter((l) => l.startsWith('--- ')).length;
    const before = starts();
    const loads = { calendar: fake.pageLoads('calendar', 0), gmail: fake.pageLoads('gmail', 0) };
    fake.stall('calendar', 'until-reload');
    const t0 = Date.now();
    const first = app.call(googleCalendar, signedIn, 'calendar.calendarList.list', {}).catch((x: any) => x) as Promise<CallFailed>;
    // Meanwhile the Gmail page answers as ever: the probe runs through while the Calendar call hangs.
    await until(() => fake.held('calendar') > 0, 10_000, 'the Calendar call hanging');
    const r = await probeGmail(signedIn, 15_000);
    expect(r).toMatchObject({ accepted: true, error: null });
    expect(Date.now() - t0).toBeLessThan(20_000);
    for (const [i, call] of [first, null].entries()) {
      const t = Date.now();
      const e = (await (call ?? app.call(googleCalendar, signedIn, 'calendar.calendarList.list', {}).catch((x: any) => x))) as CallFailed;
      expect([e.code, e.status]).toEqual(['failed', 503]);
      expect(e.message).toBe('the Calendar page did not answer in 25 s');
      expect(Date.now() - (i === 0 ? t0 : t)).toBeLessThan(29_000);
      if (i === 0) {
        // One unanswered: the Calendar API layer says so; the status keeps its meaning, the Gmail page is fine.
        await until(() => layerOf(signedIn, 'Calendar API')?.state === 'waiting', 5000, 'the layer');
        expect(layerOf(signedIn, 'Calendar API').note).toBe('the Calendar page did not answer the last request in 25 s');
        expect(statusOf(signedIn).status).toBe('online');
        expect(layerOf(signedIn, 'Gmail page').state).toBe('ok');
      }
    }
    // Two in a row: the Calendar tab, and only it, is sent back to its start page.
    await until(() => logOf(signedIn).includes('the Calendar page did not answer 2 requests in a row; reloading its tab, and only that one'), 10_000, 'the reload');
    await until(() => fake.pageLoads('calendar', 0) === loads.calendar + 1, 15_000, 'the Calendar page loaded again');
    await until(() => logOf(signedIn).includes('the Calendar tab was sent back to its start page'), 10_000, 'the reload done');
    // It answers again.
    await until(async () => (await app.call(googleCalendar, signedIn, 'calendar.calendarList.list', {}).then(() => true, () => false)), 30_000, 'Calendar answering');
    await until(() => layerOf(signedIn, 'Calendar API')?.state === 'ok', 10_000, 'the Calendar API layer ok');
    expect(statusOf(signedIn).status).toBe('online');
    expect(statusOf(signedIn).details).toMatchObject({ calendarReloads: 1, gmailReloads: 0, calendarPage: true, gmailPage: true, tabs: 'calendar (hook up), gmail (hook up)' });
    // The Gmail tab was not touched, and the extractor did not restart.
    expect(fake.pageLoads('gmail', 0)).toBe(loads.gmail);
    expect(layerOf(signedIn, 'Gmail page')).toEqual({ name: 'Gmail page', state: 'ok', note: 'hook up, signed in' });
    expect(starts()).toBe(before);
    expect(logOf(signedIn)).not.toContain('exiting for a supervised restart');
  },
  120_000,
);

it(
  'a Gmail page that stops answering: the probe says so, its tab alone is reloaded, then opened anew; Calendar goes on',
  async () => {
    const starts = () => logOf(signedIn).split('\n').filter((l) => l.startsWith('--- ')).length;
    const before = starts();
    const loads = { calendar: fake.pageLoads('calendar', 0), gmail: fake.pageLoads('gmail', 0) };
    const calendarReloads = statusOf(signedIn).details.calendarReloads;
    const listed = async () => {
      const t0 = Date.now();
      expect((await app.call(googleCalendar, signedIn, 'calendar.calendarList.list', {})).items.length).toBeGreaterThan(0);
      expect(Date.now() - t0).toBeLessThan(3000);
    };
    fake.stall('gmail', 'on'); // through reloads, until it is lifted
    for (const [round, how] of [
      [1, 'reloading its tab, and only that one'],
      [2, 'opening its tab anew'],
    ] as const) {
      await until(() => layerOf(signedIn, 'Gmail page')?.state === 'ok', 30_000, `the Gmail page up (${round})`);
      const t0 = Date.now();
      const out = join(accountDir(signedIn), 'probe-gmail.json');
      const held = fake.held('gmail'); // the last round's, whose page is gone
      rmSync(out, { force: true });
      writeFileSync(join(accountDir(signedIn), 'probe-gmail.request'), '');
      await until(() => fake.held('gmail') > held, 10_000, 'a Gmail call hanging');
      await listed(); // Calendar is not held up by it
      await until(() => existsSync(out), 70_000, 'probe-gmail.json');
      const r = JSON.parse(readFileSync(out, 'utf8'));
      // Two calls, each cut at 25 s with the page's name; then the probe stops.
      expect(r.results.map((x: any) => [x.status, x.error])).toEqual([
        [null, 'the Gmail page did not answer in 25 s'],
        [null, 'the Gmail page did not answer in 25 s'],
      ]);
      expect(r).toMatchObject({ accepted: null, error: 'the Gmail page stopped answering; the probe stopped there' });
      expect(Date.now() - t0).toBeLessThan(60_000);
      await until(() => logOf(signedIn).includes(`the Gmail page did not answer 2 requests in a row; ${how}`), 10_000, `reload ${round}`);
      await until(() => fake.pageLoads('gmail', 0) === loads.gmail + round, 15_000, `the Gmail page loaded again (${round})`);
      await listed();
    }
    // The first reload sent the tab back to its start page; it still did not answer, so the second is a new tab, and
    // the old one is closed: still one Gmail tab.
    expect(logOf(signedIn)).toContain('the Gmail tab was sent back to its start page');
    await until(() => logOf(signedIn).includes('the Gmail tab was reopened'), 10_000, 'the new tab');
    await until(() => statusOf(signedIn)?.details?.tabs === 'calendar (hook up), gmail (hook up)', 30_000, 'one tab each');
    // Gmail answers again.
    fake.stall('gmail', 'off');
    await until(() => layerOf(signedIn, 'Gmail page')?.state === 'ok', 30_000, 'the Gmail page up');
    expect(await probeGmail(signedIn)).toMatchObject({ accepted: true, error: null });
    expect(layerOf(signedIn, 'Gmail page').note).toMatch(/^hook up, signed in; reloaded 2× \(last at \d\d:\d\d UTC\)$/);
    expect(statusOf(signedIn).details).toMatchObject({ gmailReloads: 2, calendarReloads, gmailPage: true, calendarPage: true });
    // The Calendar tab was not touched, nor the extractor restarted.
    expect(fake.pageLoads('calendar', 0)).toBe(loads.calendar);
    expect(layerOf(signedIn, 'Calendar API').state).toBe('ok');
    expect(starts()).toBe(before);
  },
  200_000,
);

/** The fake Gmail's messages a mailbox should list, newest first (Gmail's ids only). */
const expectedIds = (f: (m: FakeMessage) => boolean) =>
  fake.gmail.messages
    .filter((x) => !x.pending && f(x))
    .sort((a, b) => b.date - a.date || (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
    .map((x) => x.id);
const mailCall = (op: string, input: Record<string, unknown>) => app.call(mailIface, signedIn, op as any, input as any) as Promise<any>;
/** bv answers refused for their layout so far (the layout test's), which the self-check counts. */
let bvRefused = 0;

it(
  'Gmail mail through the manager, read-only: mailboxes, list paging, get, attachment, raw, search, changes; Calendar alongside',
  async () => {
    await until(() => layerOf(signedIn, 'Gmail page')?.state === 'ok', 30_000, 'the Gmail page up');
    const writes = fake.gmail.writes;
    const { mailboxes } = await mailCall('mail.mailboxes', {});
    expect(mailboxes.filter((b: any) => b.role).map((b: any) => [b.id, b.role])).toEqual([
      ['^i', 'inbox'],
      ['^t', 'flagged'],
      ['^io_im', 'important'],
      ['^f', 'sent'],
      ['^r', 'drafts'],
      ['all', 'all'],
      ['^s', 'junk'],
      ['^k', 'trash'],
    ]);
    expect(mailboxes.map((b: any) => b.id)).toEqual(expect.arrayContaining(['^x_1', '^x_2', '^x_3']));
    // The inbox to its end, by our cursor; and a mail call and a Calendar call at once.
    const ids: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 20; i++) {
      const [page, cals] = await Promise.all([mailCall('mail.list', { mailboxId: '^i', limit: 25, ...(before ? { before } : {}) }), app.call(googleCalendar, signedIn, 'calendar.calendarList.list', {})]);
      expect(cals.items.length).toBeGreaterThan(0);
      ids.push(...page.messages.map((m: any) => m.id));
      for (const m of page.messages) expect([m.emailId, m.messageId, m.mailboxId, /^\d{19}$/.test(m.threadId)]).toEqual([m.id, null, '^i', true]);
      if (!page.next) break;
      before = page.next;
    }
    expect(ids).toEqual(expectedIds((x) => x.labels.includes('^i')));
    // The background lane through the manager (background: true passes as an extra input), Calendar alongside.
    const [bgPage, bgCals] = await Promise.all([mailCall('mail.list', { mailboxId: '^i', limit: 5, background: true }), app.call(googleCalendar, signedIn, 'calendar.calendarList.list', {})]);
    expect(bgPage.messages.map((m: any) => m.id)).toEqual(ids.slice(0, 5));
    expect(bgCals.items.length).toBeGreaterThan(0);
    await until(() => layerOf(signedIn, 'Gmail background')?.note === 'running' && statusOf(signedIn)?.details?.bvLayout === 'own', 5000, 'the background lane running');
    expect(statusOf(signedIn).details.backgroundStopped).toBeNull();
    // One message whole: get, its attachment, the original.
    const src = fake.gmail.messages.find((x) => x.attachment && x.labels.includes('^i'))!;
    const got = await mailCall('mail.get', { id: src.id });
    expect(got).toMatchObject({ id: src.id, emailId: src.id, threadId: src.thread, messageId: src.messageId, subject: src.subject, text: src.body, html: `<p>${src.body}</p>`, attachments: [{ id: '2', filename: src.attachment!.name, mime: 'application/pdf' }] });
    expect(got.labels).toContain('Inbox');
    expect(await mailCall('mail.attachment', { id: src.id, attachmentId: '2' })).toEqual({ filename: src.attachment!.name, mime: 'application/pdf', base64: src.attachment!.data.toString('base64') });
    const raw = await mailCall('mail.raw', { id: src.id });
    expect(raw).toMatchObject({ filename: null, mime: 'message/rfc822', size: Buffer.byteLength(fakeEml(src)) });
    expect(Buffer.from(raw.base64, 'base64').toString()).toBe(fakeEml(src));
    expect((await mailCall('mail.raw', { id: src.id, background: true })).base64).toBe(raw.base64);
    // That message is unread: it was looked at again after each read (the unread guard), and Gmail (this fake) left it so.
    expect(src.labels).toContain('^u');
    expect(statusOf(signedIn).details.readsMarkRead).toBe(false);
    // Search: Gmail's syntax; ids only with operators only, the estimate null (bv's json[4] is not one); free text refused there.
    const found = await mailCall('mail.search', { query: 'in:inbox is:unread', limit: 200 });
    expect(found.messages.map((m: any) => m.id)).toEqual(expectedIds((x) => x.labels.includes('^i') && x.labels.includes('^u')));
    const idsOnly = await mailCall('mail.search', { query: 'in:inbox newer_than:30d', idsOnly: true });
    expect(idsOnly).toMatchObject({ ids: expectedIds((x) => x.labels.includes('^i') && x.date > Date.now() - 30 * 86_400_000), next: null });
    expect(idsOnly.estimate).toBeNull();
    const refused = (await mailCall('mail.search', { query: 'dinner plans', idsOnly: true }).catch((e) => e)) as CallFailed;
    expect([refused.code, refused.status]).toEqual(['failed', 400]);
    // Changes from Gmail's sync.
    const start = await mailCall('mail.changes', { mailboxId: '^i' });
    const fresh = fake.gmail.arrive({ subject: `Fresh ${WEB.mailMark}` });
    try {
      const c = await mailCall('mail.changes', { mailboxId: '^i', state: start.state });
      expect(c.added.map((m: any) => m.id)).toEqual([fresh.id]);
      expect(c.added[0]).toMatchObject({ emailId: fresh.id, threadId: fresh.thread, flags: { seen: false } });
    } finally {
      fake.gmail.relabel(fresh.id, ['^k'], ['^i', '^all']);
    }
    // Writes are not built, and nothing above wrote.
    for (const [op, input] of [
      ['mail.flag', { ids: [src.id], seen: true }],
      ['mail.move', { ids: [src.id], mailboxId: '^k' }],
      ['mail.trash', { ids: [src.id] }],
    ] as const) {
      const e = (await mailCall(op, input).catch((x) => x)) as CallFailed;
      expect(e.code === 'denied' || e.status === 501).toBe(true);
    }
    expect(fake.gmail.writes).toBe(writes);
    await until(() => layerOf(signedIn, 'Gmail protocol')?.state === 'ok', 5000, 'the Gmail protocol layer ok');
    expect(layerOf(signedIn, 'Gmail protocol').note).toMatch(/^(bv|fd|s|raw)(, (bv|fd|s|raw))* answered as expected \(bv in its own layout\)$/);
  },
  120_000,
);

it(
  'a Gmail layout the extractor does not know: refused with 502 and a plain sentence, nothing returned, the Gmail protocol layer failed; ok again after',
  async () => {
    fake.gmail.layout('swapped');
    try {
      const e = (await mailCall('mail.list', { mailboxId: '^i', limit: 5 }).catch((x) => x)) as CallFailed;
      expect([e.code, e.status]).toEqual(['failed', 502]);
      bvRefused++;
      expect(e.message).toBe("Gmail's list and search (bv) answer is not laid out as this extractor knows it (at json[2][0][0][2]: expected the row's date in ms (13 digits), got an id); nothing was returned rather than possibly wrong mail");
      await until(() => layerOf(signedIn, 'Gmail protocol')?.state === 'failed', 5000, 'the layer failed');
      expect(layerOf(signedIn, 'Gmail protocol').note).toContain("bv: at json[2][0][0][2]: expected the row's date in ms (13 digits), got an id");
      // Calendar does not rest on it.
      expect((await app.call(googleCalendar, signedIn, 'calendar.calendarList.list', {})).items.length).toBeGreaterThan(0);
      expect(statusOf(signedIn).status).toBe('online');
    } finally {
      fake.gmail.layout('normal');
    }
    expect((await mailCall('mail.list', { mailboxId: '^i', limit: 5 })).messages.length).toBe(5);
    await until(() => layerOf(signedIn, 'Gmail protocol')?.state === 'ok', 5000, 'the layer ok again');
  },
  60_000,
);

it(
  "the watch: new inbox mail is mail.arrived and its mailboxes mail.changed, from Gmail's sync",
  async () => {
    await mailCall('mail.mailboxes', {}); // the watch starts with the first mail call
    await until(() => String(statusOf(signedIn)?.details?.gmailWatch).startsWith('looked at'), 15_000, 'the watch looking');
    const n = events[signedIn]!.length;
    const fresh = fake.gmail.arrive({ subject: `Watched ${WEB.mailMark}` });
    try {
      await until(() => events[signedIn]!.slice(n).some((e) => e.t === 'mail.arrived' && e.message?.id === fresh.id), 15_000, 'mail.arrived');
      const evs = events[signedIn]!.slice(n);
      expect(evs.find((e) => e.t === 'mail.arrived').message).toMatchObject({ id: fresh.id, emailId: fresh.id, mailboxId: '^i', threadId: fresh.thread });
      expect(evs.filter((e) => e.t === 'mail.changed').map((e) => e.mailboxId)).toEqual(expect.arrayContaining(['^i', 'all']));
      expect(evs.find((e) => e.t === 'mail.changed').state).toMatch(/^g1\.\d+\.\d{13}$/);
      expect(logOf(signedIn)).toContain('gmail watch: ');
    } finally {
      fake.gmail.relabel(fresh.id, ['^k'], ['^i', '^all']);
    }
    expect(existsSync(join(accountDir(signedIn), 'gmail-watch.json'))).toBe(true);
  },
  60_000,
);

it(
  'the Gmail self-check: asked for with a file, counts, booleans and types only, one read message older than 30 days read',
  async () => {
    const out = join(accountDir(signedIn), 'gmail-selfcheck.json');
    rmSync(out, { force: true });
    const fetched = fake.gmail.rawFetched.length;
    writeFileSync(join(accountDir(signedIn), 'gmail-selfcheck.request'), '');
    await until(() => existsSync(out), 60_000, 'gmail-selfcheck.json');
    expect(existsSync(join(accountDir(signedIn), 'gmail-selfcheck.request'))).toBe(false);
    const text = readFileSync(out, 'utf8');
    const r = JSON.parse(text);
    expect(r).toMatchObject({ ok: true, page: { syncSeen: true, accountKey: true, syncPoint: true }, mailboxes: { system: 10, user: 3 }, inbox: { listed: 50, idsDecimal: true, datesInRange: true, newestFirst: true }, allMail: { listed: 50 }, searchIds: { idsDecimal: true, estimate: 'null' }, message: { found: true, raw: { parsed: true, messageIdHeader: true }, get: { stillSeen: true } } });
    expect(r.fingerprints.bv.failed).toBe(bvRefused); // the layout test's, if it ran, kept as the first mismatch
    const read = [...new Set(fake.gmail.rawFetched.slice(fetched))];
    expect(read.length).toBe(1);
    const msg = fake.gmail.messages.find((x) => x.id === read[0])!;
    expect([msg.labels.includes('^u'), msg.date < Date.now() - 30 * 86_400_000]).toEqual([false, true]);
    const secrets = [...MAIL_SECRETS, WEB.email, WEB.sapisid, 'Plans', 'Person', 'Owner', 'Work', 'Travel', 'example.', '^x_', fake.gmail.xsrf, fake.gmail.ik];
    for (const x of fake.gmail.messages) secrets.push(x.id, x.thread, x.messageId);
    for (const secret of secrets) expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
    await until(() => String(statusOf(signedIn)?.details?.gmailSelfCheck).startsWith('ok: 13 mailboxes, inbox 50, all mail 50'), 5000, 'the self-check in the details');
    expect(logOf(signedIn)).toContain('gmail self-check: ok: 13 mailboxes');
  },
  90_000,
);

it(
  '`mail: false`: no Gmail tab, and its layer is off',
  async () => {
    mailOff = (await app.admin({ do: 'create', kind: 'google', label: 'Google (no mail)', config: config(2, { mail: false }) })).id;
    await until(() => statusOf(mailOff)?.details?.calendarPage === true && statusOf(mailOff)?.details?.tabs === 'calendar (hook up)', 60_000, 'the Calendar tab up');
    // Time enough for a Gmail tab to have been opened, if one were.
    await Bun.sleep(3000);
    expect(statusOf(mailOff).details).toMatchObject({ provider: 'Gmail', tabs: 'calendar (hook up)', mail: false, gmailTab: null, gmailPage: false, gmailSignedIn: null });
    expect(layerOf(mailOff, 'Gmail page')).toEqual({ name: 'Gmail page', state: 'off', note: 'mail: false in the config' });
    expect(layerOf(mailOff, 'Gmail protocol')).toEqual({ name: 'Gmail protocol', state: 'off', note: 'no Gmail tab' });
    expect(layerOf(mailOff, 'Gmail background')).toEqual({ name: 'Gmail background', state: 'off', note: 'no Gmail tab' });
    expect(statusOf(mailOff).details.backgroundLane).toBeUndefined();
    expect(statusOf(mailOff).details).toMatchObject({ canSend: false, sendNote: 'This account reads no mail (mail: false in its config)' });
    expect(fake.pageLoads('gmail', 2)).toBe(0);
    expect(logOf(mailOff)).not.toContain('Gmail tab');
    await app.admin({ do: 'stop', account: mailOff });
    await until(() => processesOf([mailOff]).length === 0, 15_000, 'its processes gone');
  },
  90_000,
);

it(
  'not signed in: attention, sign in in the live view; calls say so',
  async () => {
    signedOut = (await app.admin({ do: 'create', kind: 'google', label: 'Google (signed out)', config: config(1) })).id;
    await until(() => statusOf(signedOut)?.status === 'attention', 60_000, 'attention');
    await until(() => statusOf(signedOut)?.details?.gmailSignedIn === false, 30_000, 'the Gmail page up');
    const st = statusOf(signedOut);
    expect(st.attention).toEqual({ kind: 'login', message: 'Sign in to Google in the live view', liveView: true });
    expect(st.liveView).toEqual({ width: 1280, height: 800 });
    const lv = m!.router.liveView(signedOut)!;
    expect(lv).toEqual({ vncSocket: join(m!.store.account(signedOut)!.dir, 'vnc.sock'), width: 1280, height: 800 });
    expect(lv.vncSocket).not.toBe(m!.router.liveView(signedIn)!.vncSocket);
    expect(st.details).toMatchObject({ signedIn: false, calendarPage: true, page: `${fake.url}/calendar/u/1/r`, keySource: null });
    expect(statusOf(signedOut).details).toMatchObject({ tabs: 'calendar (hook up), gmail (hook up)', gmailPage: true, gmailSignedIn: false, gmailTab: `${fake.mailUrl}/mail/u/1/` });
    expect(layerOf(signedOut, 'Gmail page')).toEqual({ name: 'Gmail page', state: 'waiting', note: 'sign in to Google in the live view' });
    expect(await rfbBanner(lv.vncSocket)).toMatch(/^RFB /);
    const e = (await app.call(googleCalendar, signedOut, 'calendar.calendarList.list', {}).catch((x: any) => x)) as CallFailed;
    expect([e.code, e.status]).toEqual(['failed', 401]);
    // Its Gmail page is signed out: the background lane is stopped (a foreground call says sign in, a background one paused).
    await until(() => statusOf(signedOut)?.details?.backgroundStopped === 'signedOut', 10_000, 'the background lane stopped');
    expect(layerOf(signedOut, 'Gmail background')).toMatchObject({ state: 'failed' });
    const bg = (await app.call(mailIface, signedOut, 'mail.list', { mailboxId: '^i', background: true } as any).catch((x: any) => x)) as CallFailed;
    expect([bg.code, bg.status]).toEqual(['paused', 503]);
    const fg = (await app.call(mailIface, signedOut, 'mail.list', { mailboxId: '^i' }).catch((x: any) => x)) as CallFailed;
    expect([fg.code, fg.status]).toEqual(['failed', 401]);
  },
  90_000,
);

it('no cookie, key, query or event content in the logs or the statuses', () => {
  // The statuses and other events (mail.arrived carries a message, as it should, to apps with a mail grant).
  const said = JSON.stringify(Object.values(events).map((evs) => evs.filter((e) => !String(e.t).startsWith('mail.'))));
  const logs = [signedIn, signedOut, mailOff].filter(Boolean).map((id) => readFileSync(join(m!.store.account(id)!.dir, 'adapter.log'), 'utf8')).join('\n');
  for (const secret of [WEB.sapisid, WEB.pageKey, WEB.htmlKey, 'secret-query', 'secret-hash', 'page-own-secret-body', 'Dinner', "Luigi's", ...MAIL_SECRETS, fake.gmail.xsrf, fake.gmail.ik, 'Plans', 'Person']) {
    expect(said).not.toContain(secret);
    expect(logs).not.toContain(secret);
  }
  expect(logs).toContain('probe: key from calendar-request');
});

it(
  'stopping the manager stops every process it started for them',
  async () => {
    // The running ones this run made (`mail: false`'s was stopped in its test).
    const ids = [signedIn, signedOut].filter(Boolean);
    const displays = ids.map((id) => Number(String(statusOf(id).details.display).slice(1)));
    expect(processesOf(ids).length).toBeGreaterThanOrEqual(4 * ids.length); // each an extractor, Xvfb, x11vnc, Chromium and its helpers
    app.close();
    await m!.stop();
    m = null;
    await until(() => processesOf(ids).length === 0, 15_000, 'every process gone');
    for (const n of displays) expect(existsSync(`/tmp/.X${n}-lock`)).toBe(false);
  },
  30_000,
);
