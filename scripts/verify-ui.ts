/**
 * The manager's page end to end in headless Chromium, against a fresh manager: a pending request shows its consent
 * lines; approving it narrower (a lower level, one account, dry run) makes that grant; a grant's level changes and it
 * is revoked; a fake account shows online and restarts, disables and enables; activity shows the calls' counts; the
 * account's pane shows its process, lock, apps, activity, files, log and raw state, opens its live view (a real Xvfb +
 * x11vnc display, on a Unix socket and no TCP port) and runs ops (a read, a write after confirming, a dry run, a failure); the add dialog offers the
 * kinds that sign in by themselves and Google through the API in both of the provider's states; the interfaces page
 * lists test.echo's ops by level with their types and runs one; an account's dependency chain (status.layers) shows
 * its links, says where a failing one stops, and shows nothing when none is sent; the Apps page's grant matrix has
 * apps by accounts grouped by kind, level pills, running and dry-run marks, a 7-day sparkline with the failed and
 * denied calls, and a cell opens that account's activity for the app; at phone width the chain stands vertically and
 * the matrix scrolls sideways inside its card, never the page; the phone layout fits; no console errors.
 *
 * The live service serves packages/manager/web/dist, so build the page somewhere else to test it:
 *
 *   (cd packages/manager/web && bunx --bun vite build --outDir /tmp/dacc-dist --emptyOutDir)
 *   bun packages/manager/src/main.ts --data /tmp/dacc-ui --port 8481 --host 127.0.0.1 --web-dist /tmp/dacc-dist   (fresh dir each run)
 *   bun scripts/verify-ui.ts http://127.0.0.1:8481 [/tmp/dacc-shots] [/tmp/dacc-ui]
 *
 * It seeds the manager itself through the real APIs: two apps register, the first is approved and makes fake accounts
 * (one whose chain fails, one that sends none, a fake chat one), and calls are made so the activity has rows. Given the
 * manager's data dir too, it adds counts for earlier days to its registry, so the sparkline has a week to draw.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { testEcho } from '@dither-accounts/interfaces';
import { resolveBins } from '../extractors/discord/src/sandbox.ts';
import { pickFreeDisplay } from '../packages/browser/src/display.ts';
import { prepareVncSocket, waitForVncSocket, x11vncArgs } from '../packages/browser/src/vnc.ts';
import { inetSockets } from '../packages/browser/test/inet.ts';
import { services } from '../packages/manager/web/src/catalog.ts';
import { launch } from './browser.ts';

const base = process.argv[2] ?? 'http://127.0.0.1:8481';
const shots = process.argv[3];
const dataDir = process.argv[4];
if (shots) mkdirSync(shots, { recursive: true });

const api = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
  const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const until = async (f: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- seed

const before = await api('/api/state');
if (before.apps.length || before.accounts.length) throw new Error('this manager is not fresh: start one on an empty data dir');

const admin = await register(base, {
  name: 'chat-hub',
  describe: 'Chats from your networks in one inbox',
  requests: [
    { interface: 'accounts', level: 'manage', kinds: ['fake', 'chat-fake'], reason: 'To add the accounts you link' },
    { interface: 'test.echo', level: 'manage' },
    { interface: 'chat', level: 'write' },
  ],
});
const reader = await register(base, { name: 'echo-reader', describe: 'Reads echoes', requests: [{ interface: 'test.echo', level: 'manage', reason: 'To shout the plans back' }] });
for (const r of admin.requests) await api(`/api/requests/${r.id}/approve`, 'POST', {});
const c = new AccountsClient({ url: base, app: admin.app, token: admin.token });
await until(() => c.connected, 5000, 'the admin app connected');
// A real display for the live view: Xvfb and x11vnc on a free slot, x11vnc on a Unix socket as a sandbox's is, stopped
// at the end.
const { display } = await pickFreeDisplay();
const bins = resolveBins(() => {});
const xvfb = Bun.spawn([bins.xvfb, `:${display}`, '-screen', '0', '800x600x24', '-nolisten', 'tcp'], { stdout: 'ignore', stderr: 'ignore' });
await until(() => require('node:fs').existsSync(`/tmp/.X11-unix/X${display}`), 5000, 'Xvfb');
const vncDir = mkdtempSync(join(tmpdir(), 'dacc-ui-vnc-'));
const vncSocket = join(vncDir, 'vnc.sock');
prepareVncSocket(vncSocket);
const vnc = Bun.spawn(x11vncArgs(bins.x11vnc, `:${display}`, vncSocket), { stdout: 'ignore', stderr: 'ignore' });
await waitForVncSocket(vncSocket, vnc, 10_000);
const { id: account } = await c.admin({ do: 'create', kind: 'fake', label: 'Fake one', config: { vncSocket } });
// The dependency chain: one whose session layer fails, one that sends no chain at all, and a chat one.
const { id: failing } = await c.admin({ do: 'create', kind: 'fake', label: 'Fake two', config: { failLayer: 'session', failNote: 'the session ran out: sign in again' } });
const { id: silent } = await c.admin({ do: 'create', kind: 'fake', label: 'Fake three', config: { noLayers: true } });
const { id: chatAcc } = await c.admin({ do: 'create', kind: 'chat-fake', label: 'Fake chat' });
await until(() => [account, failing, silent, chatAcc].every((id) => c.accounts.some((a) => a.id === id && a.online)), 15_000, 'the fake accounts online');
for (let i = 0; i < 3; i++) await c.call(testEcho, account, 'echo', { text: `x${i}` });
await c.call(testEcho, account, 'shout', { text: 'y' });
await c.call(testEcho, account, 'fail', { status: 410 }).catch(() => {});
// Earlier days for the sparkline (chat-hub on Fake one): ok, failed and denied calls.
const history: [number, string, number][] = [
  [6, 'ok', 2],
  [4, 'ok', 6],
  [4, 'error', 2],
  [3, 'denied', 1],
  [1, 'ok', 4],
];
if (dataDir) {
  const db = new Database(join(dataDir, 'accounts.sqlite'));
  for (const [ago, outcome, n] of history) {
    const day = new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    db.query('INSERT INTO audit (day, app_id, account, op, outcome, n, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(day, admin.app, account, 'slow', outcome, n, Date.now() - ago * 86_400_000);
  }
  db.close();
}
const earlier = dataDir ? history.reduce((n, [, , k]) => n + k, 0) : 0;
const earlierBad = dataDir ? history.filter(([, o]) => o !== 'ok').reduce((n, [, , k]) => n + k, 0) : 0;

// ---------------------------------------------------------------- browser

const { page: p, close } = await launch();
const text = (sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const click = (sel: string) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.click(); })()`);
const setSelect = (sel: string, value: string) =>
  p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const setCheck = (sel: string, on: boolean) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e.checked !== ${on}) e.click(); })()`);
const confirmYes = async () => {
  await p.until(`!!document.querySelector('[data-confirm]')`, 3000);
  await click('[data-confirm]');
};
const state = () => api('/api/state');
const readerGrants = async () => (await state()).apps.find((a: any) => a.id === reader.app).grants;

try {
  await p.size(1280, 900);
  await p.goto(`${base}/#/apps`);
  await p.until(`!!document.querySelector('[data-request]')`, 10_000);

  // Apps: the waiting request.
  check((await text('[data-pending]')) === '1', 'the Apps tab says one request waits', await text('[data-pending]'));
  const card = await p.eval<string>(`document.querySelector('[data-request] .consent').innerText`);
  check(card.includes('Hear echoes') && card.includes('Shout') && card.includes('Make it emit'), 'the request card shows its consent lines', card);
  check((await text('[data-request]')).includes('To shout the plans back'), 'and the reason');
  if (shots) await p.shot(`${shots}/01-request.png`);

  // Narrow it: write, only the fake account, dry run.
  await setSelect('[data-request] [data-level]', 'write');
  await Bun.sleep(100);
  const lines = await p.eval<string>(`document.querySelector('[data-request] .consent').innerText`);
  check(!lines.includes('Make it emit') && lines.includes('Shout'), 'choosing a lower level shows the narrower consent', lines);
  await setCheck('[data-request] .picker input', false);
  await Bun.sleep(100);
  await setCheck(`[data-request] .picker .indent input`, true);
  await setCheck('[data-request] [data-dry]', true);
  if (shots) await p.shot(`${shots}/02-narrowed.png`);
  await click('[data-request] [data-approve]');
  await until(async () => (await readerGrants()).length === 1, 5000, 'the grant');
  const g = (await readerGrants())[0];
  check(g.level === 'write' && g.dryRun === true && JSON.stringify(g.accounts) === JSON.stringify([account]), 'approving narrower made that grant', { level: g.level, dryRun: g.dryRun, accounts: g.accounts });
  await p.until(`!document.querySelector('[data-request]') && !document.querySelector('[data-pending]')`, 4000);
  check(true, 'the card and the badge are gone');

  // Change the grant's level, then revoke it.
  await setSelect(`[data-grant="${g.id}"] [data-grant-level]`, 'read');
  await until(async () => (await readerGrants())[0]?.level === 'read', 5000, 'the level change');
  check(true, "a grant's level changes");
  await p.until(`!!document.querySelector('[data-grant="${g.id}"] [data-grant-dry]')`, 4000);
  await setCheck(`[data-grant="${g.id}"] [data-grant-dry]`, false);
  await until(async () => (await readerGrants())[0]?.dryRun === false, 5000, 'dry run off');
  check(true, 'dry run toggles off');
  if (shots) await p.shot(`${shots}/03-apps.png`);
  await click(`[data-grant="${g.id}"] [data-revoke]`);
  await confirmYes();
  await until(async () => (await readerGrants()).length === 0, 5000, 'the revoke');
  check(true, 'a grant is revoked after confirming');

  // Accounts: the list, then the pane.
  await click('[data-tab="accounts"]');
  await p.until(`!!document.querySelector('[data-account="${account}"]')`, 5000);
  check((await text(`[data-account="${account}"]`)).includes('fake-one'), 'the fake account is on the overview, named by who it is signed in as', await text(`[data-account="${account}"]`));
  if (shots) await p.shot(`${shots}/04-accounts.png`);
  await click(`[data-account="${account}"]`);
  await p.until(`!!document.querySelector('[data-pane="${account}"] [data-condition]')`, 5000);
  check((await text(`[data-pane="${account}"] [data-condition]`)) === 'Online', 'its pane shows it online', await text(`[data-pane="${account}"] [data-condition]`));
  // Its process from the detail (the chain's own note says "pid" too, and comes with the state, sooner).
  await p.until(`document.querySelector('[data-pane="${account}"]').innerText.includes('dither-accounts (pid')`, 6000);
  const overview = await p.eval<string>(`document.querySelector('[data-pane="${account}"]').innerText`);
  check(overview.includes('Made by chat-hub'), 'with the app that made it');
  check(/pid \d+/.test(overview) && overview.includes('dither-accounts (pid'), 'its process and who holds its lock');
  check(overview.includes('chat-hub') && overview.includes('runs this account'), 'and the apps that reach it');
  check(overview.includes('Live view'), 'it offers a live view', overview.slice(0, 300));
  if (shots) await p.shot(`${shots}/04b-account-pane.png`);

  // Its dependency chain: every link ok, so no stop; laid out in a row on a desktop.
  await p.until(`document.querySelectorAll('[data-pane="${account}"] [data-layers] [data-layer]').length === 3`, 6000);
  const okChain = await p.eval<{ names: string[]; states: string[]; stop: boolean; first: boolean; tops: number[] }>(`(() => {
    const ls = [...document.querySelectorAll('[data-pane="${account}"] [data-layers] [data-layer]')];
    const body = document.querySelector('[data-pane="${account}"] .pane-body');
    return { names: ls.map((l) => l.dataset.layer), states: ls.map((l) => l.dataset.state), stop: !!document.querySelector('[data-pane="${account}"] [data-stop]'), first: body.firstElementChild?.hasAttribute('data-layers'), tops: ls.map((l) => Math.round(l.getBoundingClientRect().top)) };
  })()`);
  check(JSON.stringify(okChain.names) === '["process","session","echo"]' && okChain.states.every((x) => x === 'ok') && !okChain.stop, 'the chain shows each layer ok and no stop', okChain);
  check(okChain.first, 'at the top of the overview');
  check(new Set(okChain.tops).size === 1, 'in a row on a desktop', okChain.tops);
  await p.goto(`${base}/#/accounts/${failing}`);
  await p.until(`!!document.querySelector('[data-pane="${failing}"] [data-stop]')`, 6000);
  const badChain = await p.eval<{ states: string[]; stopAt: string | undefined; stop: string; note: string; colors: string[] }>(`(() => {
    const ls = [...document.querySelectorAll('[data-pane="${failing}"] [data-layer]')];
    const stop = document.querySelector('[data-pane="${failing}"] [data-stop]');
    return { states: ls.map((l) => l.dataset.state), stopAt: stop?.closest('[data-layer]')?.dataset.layer, stop: stop?.textContent ?? '', note: ls[1]?.querySelector('.link-note')?.textContent ?? '', colors: ls.map((l) => getComputedStyle(l.querySelector('.link-pill')).color) };
  })()`);
  check(JSON.stringify(badChain.states) === '["ok","failed","waiting"]', 'a failing chain: ok, failed, then waiting', badChain.states);
  check(badChain.stopAt === 'session' && badChain.stop === 'This is where it stops', 'the failed layer is where it stops', badChain);
  check(badChain.note === 'the session ran out: sign in again', 'with its note under it', badChain.note);
  check(new Set(badChain.colors).size === 3, 'ok, failed and waiting each in their own colour', badChain.colors);
  if (shots) await p.shot(`${shots}/04f-chain-failing.png`);
  await p.goto(`${base}/#/accounts/${silent}`);
  await p.until(`document.querySelector('[data-pane="${silent}"]')?.innerText.includes('pid ')`, 6000);
  check(!(await p.eval<boolean>(`!!document.querySelector('[data-pane="${silent}"] [data-layers]')`)), 'an account that sends no chain shows none');
  await p.goto(`${base}/#/accounts/${account}`);
  await p.until(`!!document.querySelector('[data-pane="${account}"] [data-open-live]')`, 6000);

  // The live view: a real Xvfb + x11vnc display carried through the manager.
  await click('[data-open-live]');
  await p.until(`document.querySelector('[data-lv-state]')?.textContent === 'connected'`, 15_000);
  check(true, 'the live view connects to the VNC server through the manager');
  check(inetSockets(vnc.pid).length === 0, 'its x11vnc listens on its Unix socket only: no TCP or UDP socket', inetSockets(vnc.pid));
  await p.until(`!!document.querySelector('.lv-screen canvas')`, 5000);
  if (shots) await p.shot(`${shots}/04c-live-view.png`);
  await click('[data-lv-close]');

  // Try it: a read answers; a write asks first; dry run does not reach the account.
  await click('[data-pane-tab="try"]');
  await p.until(`!!document.querySelector('[data-runner] [data-op-pick]')`, 5000);
  await p.until(`document.querySelector('[data-runner] [data-input]')?.value.includes('"text"')`, 5000);
  check(true, 'the runner starts from the example input');
  await p.eval(`(() => { const t = document.querySelector('[data-runner] [data-input]'); t.value = '{"text": "from the page"}'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('[data-runner] [data-run]');
  await p.until(`!!document.querySelector('[data-result="ok"]')`, 5000);
  check((await text('[data-result="ok"]')).includes('from the page'), 'echo answers on the page', await text('[data-result="ok"] pre'));
  await setSelect('[data-runner] [data-op-pick]', 'test.echo|shout');
  await p.until(`!!document.querySelector('[data-runner] [data-dry]')`, 3000);
  await click('[data-runner] [data-run]');
  await p.until(`!!document.querySelector('[data-confirm]')`, 3000);
  check((await text('.dialog')).includes('acts as you'), 'a write asks before it runs', await text('.dialog'));
  await click('[data-confirm]');
  await p.until(`document.querySelectorAll('[data-result="ok"]').length === 2`, 5000);
  check((await text('[data-result="ok"] pre')).includes('"text": ""'), 'and runs once you say so');
  await setCheck('[data-runner] [data-dry]', true);
  await click('[data-runner] [data-run]');
  await p.until(`document.querySelectorAll('[data-result="ok"]').length === 3`, 5000);
  check((await text('[data-result="ok"] pre')).includes('dryRun'), 'dry run answers without asking or reaching it');
  await setSelect('[data-runner] [data-op-pick]', 'test.echo|fail');
  await p.until(`document.querySelector('[data-runner] [data-input]')?.value.includes('"status"')`, 3000);
  await p.eval(`(() => { const t = document.querySelector('[data-runner] [data-input]'); t.value = '{"status": 404}'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('[data-runner] [data-run]');
  await p.until(`!!document.querySelector('[data-result="failed"]')`, 5000);
  check((await text('[data-result="failed"]')).includes('(404)'), 'a failure shows its code and upstream status', await text('[data-result="failed"]'));
  if (shots) await p.shot(`${shots}/04d-try.png`);

  // Activity, files, log, raw.
  await click('[data-pane-tab="activity"]');
  await p.until(`document.querySelector('[data-pane]').innerText.includes('This page')`, 6000);
  check(true, "the account's activity counts the page's calls as This page");
  await click('[data-pane-tab="files"]');
  await p.until(`!!document.querySelector('[data-files]')`, 6000);
  check((await text('[data-files]')).includes('adapter.log'), 'files lists its directory', await text('[data-files]'));
  await click('[data-pane-tab="log"]');
  await p.until(`(document.querySelector('[data-log]')?.textContent ?? '').includes('fake extractor up')`, 6000);
  check(true, 'the log tail shows what it logged');
  if (shots) await p.shot(`${shots}/04e-log.png`);
  await click('[data-pane-tab="raw"]');
  await p.until(`document.querySelector('[data-pane]').innerText.includes('"liveView"')`, 6000);
  check(true, 'raw shows its last hello and status');
  await click('[data-pane-tab="overview"]');

  // Restart, disable, enable.
  await click(`[data-pane="${account}"] [data-restart]`);
  await confirmYes();
  await until(async () => (await state()).accounts.find((a: any) => a.id === account)?.online === true, 10_000, 'online after restart');
  await p.until(`document.querySelector('[data-pane="${account}"] [data-condition]')?.textContent === 'Online'`, 6000);
  check(true, 'Restart brings it back online');
  await click(`[data-pane="${account}"] [data-toggle]`);
  await confirmYes();
  await until(async () => (await state()).accounts.find((a: any) => a.id === account)?.enabled === false, 5000, 'disabled');
  await p.until(`document.querySelector('[data-pane="${account}"] [data-condition]')?.textContent === 'Disabled'`, 4000);
  check(true, 'Disable stops it');
  await click(`[data-pane="${account}"] [data-toggle]`);
  await until(async () => (await state()).accounts.find((a: any) => a.id === account)?.online === true, 10_000, 'online after enabling');
  check(true, 'Enable starts it again');

  // Adding: the kinds that sign in by themselves, and Google through the API with both of the provider's states
  // (from its status in /api/state, faked here).
  const google = { configured: false, redirectUri: 'https://accounts.example/oauth/google/callback', accounts: [] as any[], error: null };
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/state*', requestStage: 'Response' }] });
  p.on('Fetch.requestPaused', async (e: any) => {
    try {
      const b = await p.send('Fetch.getResponseBody', { requestId: e.requestId });
      const s = JSON.parse(b.base64Encoded ? Buffer.from(b.body, 'base64').toString() : b.body);
      s.providers = { ...s.providers, google };
      await p.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(s)).toString('base64') });
    } catch {
      await p.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    }
  });
  await p.goto(`${base}/?google_error=access_denied#/accounts`);
  await p.until(`!!document.querySelector('[data-add-account]')`, 6000);
  check((await text('.split-banner')).includes('access_denied'), 'a sign-in error coming back is shown');
  check(!(await p.eval<string>('location.search')).includes('google_error'), 'and taken out of the address');
  await click('[data-add-account]');
  await p.until(`!!document.querySelector('[data-add-dialog]')`, 3000);
  const now = await state();
  const offered = services(now);
  const addable = now.kinds.filter((k: any) => k.add).map((k: any) => k.kind);
  const tiles = await p.eval<string[]>(`[...document.querySelectorAll('[data-add-dialog] [data-add-service]')].map((t) => t.dataset.addService)`);
  check(
    addable.every((k: string) => offered.some((sv) => sv.ways.some((w) => w.kind === k))) && offered.every((sv) => tiles.includes(sv.id)),
    'the add sheet offers a service for every kind that signs in by itself',
    { addable, tiles },
  );
  await click('[data-add-category="mail"]');
  await p.until(`!document.querySelector('[data-add-service="discord"]') && !!document.querySelector('[data-add-service="gmail"]')`, 3000);
  check(true, "a category shows only its own services");
  await click('[data-add-service="gmail"]');
  await p.until(`!!document.querySelector('[data-add-kind="imap"]')`, 3000);
  const gmail = await p.eval<string[]>(`[...document.querySelectorAll('[data-add-kind="imap"] > .field [data-add-field], [data-add-kind="imap"] > label.field [data-add-field]')].map((f) => f.dataset.addField)`);
  check(JSON.stringify(gmail) === JSON.stringify(['email', 'password']), 'Gmail asks only its address and an app password up front (IMAP with the provider set)', gmail);
  await click('[data-add-back]');
  await click('[data-add-category="calendar"]');
  await p.until(`!!document.querySelector('[data-add-service="google"]')`, 3000);
  await click('[data-add-service="google"]');
  await p.until(`!!document.querySelector('[data-add-way="oauth"]')`, 3000);
  await click('[data-add-way="oauth"]');
  await p.until(`!!document.querySelector('[data-google] [data-redirect]')`, 6000);
  check((await text('[data-google] [data-redirect]')) === google.redirectUri, 'Google through the API, not set up: the form shows the redirect URI');
  if (shots) await p.shot(`${shots}/05-add-google-setup.png`);
  Object.assign(google, { configured: true });
  await p.until(`!!document.querySelector('[data-google-connect]')`, 6000);
  check(true, 'Google through the API, set up: Connect');
  await p.send('Fetch.disable');
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await p.until(`!document.querySelector('[data-add-dialog]')`, 3000);

  // Activity.
  await p.goto(`${base}/#/activity`);
  await p.until(`!!document.querySelector('[data-op="echo"]')`, 8000);
  const echo = await p.eval<string[]>(`[...document.querySelectorAll('[data-op="echo"] td')].map((t) => t.textContent)`);
  check(echo[1] === '3', 'activity counts the three echoes', echo);
  const fail = await p.eval<string[]>(`[...document.querySelectorAll('[data-op="fail"] td')].map((t) => t.textContent)`);
  check(fail[2] === '1', 'and the failed call as failed', fail);
  check((await text('.lede')).includes('Never what was asked or answered'), 'and says only counts are kept');
  if (shots) await p.shot(`${shots}/07-activity.png`);

  // Interfaces.
  await click('[data-tab="interfaces"]');
  await p.until(`!!document.querySelector('[data-iface="test.echo"]')`, 4000);
  const ops = await p.eval<Record<string, string[]>>(
    `Object.fromEntries([...document.querySelectorAll('[data-iface="test.echo"] [data-level-block]')].map((b) => [b.dataset.levelBlock, [...b.querySelectorAll('[data-op]')].map((o) => o.dataset.op)]))`,
  );
  check(JSON.stringify(ops) === JSON.stringify({ read: ['echo', 'fail', 'slow', 'echoId'], write: ['shout'], manage: ['emit'] }), 'interfaces list test.echo ops by level', ops);
  await p.goto(`${base}/#/interfaces/test.echo/echo`);
  await p.until(`!!document.querySelector('[data-op="echo"] [data-op-types]')`, 6000);
  check((await text('[data-op="echo"] [data-op-types]')).includes('{ text: string }'), 'an op shows its input and output types', await text('[data-op="echo"] [data-op-types]'));
  await click('[data-op="echo"] [data-try]');
  await p.until(`!!document.querySelector('[data-op="echo"] [data-account-pick]')`, 3000);
  await click('[data-op="echo"] [data-run]');
  await p.until(`!!document.querySelector('[data-op="echo"] [data-result="ok"]')`, 5000);
  check(true, 'and runs on an account picked there');
  if (shots) await p.shot(`${shots}/08-interfaces.png`);

  // The grant matrix. The reader asks again and gets write on Fake one in dry run; it calls Fake one (dry) and Fake
  // two (denied: its grant does not reach it).
  const again = await fetch(`${base}/api/apps/${reader.app}/requests`, { method: 'POST', headers: { authorization: `Bearer ${reader.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requests: [{ interface: 'test.echo', level: 'write' }] }) }).then((r) => r.json());
  await api(`/api/requests/${again.requests[0].id}/approve`, 'POST', { level: 'write', accounts: [account], dryRun: true });
  const rc = new AccountsClient({ url: base, app: reader.app, token: reader.token });
  await until(() => rc.connected && rc.accounts.some((a) => a.id === account), 5000, 'the reader connected');
  await rc.call(testEcho, account, 'shout', { text: 'dry' });
  await rc.call(testEcho, failing, 'echo', { text: 'no' }).catch(() => {});
  rc.close();
  await p.goto(`${base}/#/apps`);
  await p.until(`!!document.querySelector('[data-matrix] [data-cell="${admin.app}|${account}"] .mx-cell')`, 8000);
  const mx = await p.eval<{ apps: string[]; kinds: string[]; accounts: string[]; listKinds: string[] }>(`({
    apps: [...document.querySelectorAll('[data-matrix] [data-mx-app]')].map((r) => r.dataset.mxApp),
    kinds: [...document.querySelectorAll('[data-matrix] [data-mx-kind]')].map((k) => k.dataset.mxKind),
    accounts: [...document.querySelectorAll('[data-matrix] [data-mx-account]')].map((k) => k.dataset.mxAccount),
    listKinds: [],
  })`);
  const st = await state();
  const order = st.accounts.map((a: any) => a.id);
  check(JSON.stringify(mx.apps) === JSON.stringify(st.apps.map((a: any) => a.id)), 'the matrix has every app down the side', mx.apps);
  check(JSON.stringify(mx.accounts) === JSON.stringify(order) && JSON.stringify(mx.kinds) === JSON.stringify([...new Set(st.accounts.map((a: any) => a.kind))]), 'and every account across the top, grouped by kind as in the list', mx);
  check((await p.eval<number>(`document.querySelectorAll('[data-matrix] [data-mx-account] :is(.avatar, .mark)').length`)) === order.length, 'each with its avatar (or its kind\'s mark)');
  const cellOf = (app: string, acc: string) =>
    p.eval<any>(`(() => { const c = document.querySelector('[data-matrix] [data-cell="${app}|${acc}"]'); if (!c) return null; const days = [...c.querySelectorAll('.spark-day')]; return {
      empty: c.hasAttribute('data-empty'), levels: [...c.querySelectorAll('[data-level]')].map((l) => l.dataset.level), pills: [...c.querySelectorAll('.pill')].map((x) => x.textContent),
      runs: !!c.querySelector('[data-runs]'), dry: !!c.querySelector('[data-dry-mark]'), dash: !!c.querySelector('.mx-dash'),
      total: Number(c.querySelector('[data-total]')?.dataset.total ?? -1), bad: Number(c.querySelector('.mx-bad')?.dataset.bad ?? 0),
      days: days.map((d) => [Number(d.dataset.n), Number(d.dataset.bad)]), red: c.querySelectorAll('.spark-bad').length,
      redFill: c.querySelector('.spark-bad') ? getComputedStyle(c.querySelector('.spark-bad')).fill : null, okFill: c.querySelector('.spark-ok') ? getComputedStyle(c.querySelector('.spark-ok')).fill : null } })()`);
  const mine = await cellOf(admin.app, account);
  check(JSON.stringify(mine.levels) === '["manage"]' && mine.runs && !mine.dry, "chat-hub on Fake one: Manage, and it runs it", mine);
  check(mine.days.length === 7 && JSON.stringify(mine.days.at(-1)) === '[5,1]', "a week of days, today's 5 calls with 1 failed", mine.days);
  check(mine.total === 5 + earlier && mine.bad === 1 + earlierBad, 'and the week totals beside it', { total: mine.total, bad: mine.bad });
  if (dataDir) check(JSON.stringify(mine.days) === '[[2,0],[0,0],[8,2],[1,1],[0,0],[4,0],[5,1]]', 'earlier days drawn on their own day', mine.days);
  check(mine.red === (dataDir ? 3 : 1) && mine.redFill !== mine.okFill, 'failed and denied calls are tinted red', { red: mine.red, redFill: mine.redFill, okFill: mine.okFill });
  const theirs = await cellOf(reader.app, account);
  check(JSON.stringify(theirs.levels) === '["write"]' && theirs.dry && !theirs.runs && theirs.total === 1 && theirs.bad === 0, 'echo-reader on Fake one: Write, dry run, its call counted once', theirs);
  const refused = await cellOf(reader.app, failing);
  check(refused.dash && !refused.levels.length && refused.total === 1 && refused.bad === 1, 'echo-reader on Fake two: a dash, and its denied call in red', refused);
  const none = await cellOf(reader.app, chatAcc);
  check(none.empty, 'echo-reader on the chat account: nothing at all', none);
  const chatCell = await cellOf(admin.app, chatAcc);
  check(JSON.stringify(chatCell.levels) === '["write"]' && chatCell.runs, 'chat-hub on the chat account: Write on chat', chatCell);
  const fitsDesk = await p.eval<{ doc: number; win: number }>(`({ doc: document.documentElement.scrollWidth, win: innerWidth })`);
  check(fitsDesk.doc <= fitsDesk.win, 'desktop: the matrix keeps to the page', fitsDesk);
  if (shots) {
    await p.eval(`document.querySelector('[data-matrix]').scrollIntoView({ block: 'start' })`);
    await p.shot(`${shots}/13-matrix.png`);
  }
  await click(`[data-matrix] [data-cell="${admin.app}|${account}"] .mx-cell`);
  await p.until(`!!document.querySelector('[data-pane="${account}"] [data-activity-filter]')`, 6000);
  const act = await p.eval<{ hash: string; rows: string[]; filter: string }>(`({ hash: location.hash, rows: [...document.querySelectorAll('[data-activity-row]')].map((r) => r.dataset.activityRow), filter: document.querySelector('[data-activity-filter]').textContent })`);
  check(act.hash === `#/accounts/${account}/activity/${admin.app}`, "a cell opens that account's activity tab", act.hash);
  check(act.rows.length > 0 && act.rows.every((r) => r === admin.app) && act.filter.includes('chat-hub'), 'filtered to the app', act);
  if (shots) await p.shot(`${shots}/14-matrix-activity.png`);

  // Phone.
  await p.size(390, 844, true);
  await p.goto(`${base}/#/accounts`);
  await p.until(`!!document.querySelector('[data-account]')`, 5000);
  const fits = await p.eval<{ doc: number; win: number; first: boolean; logout: boolean; scrolls: boolean }>(`(() => {
    const on = (e) => !!e && e.getBoundingClientRect().left >= 0 && e.getBoundingClientRect().right <= innerWidth + 1;
    const bar = document.querySelector('.tabs');
    return { doc: document.documentElement.scrollWidth, win: innerWidth, first: on(bar.querySelector('.tab')), logout: on(document.querySelector('[data-logout]')), scrolls: bar.scrollWidth <= bar.clientWidth + 1 || getComputedStyle(bar).overflowX === 'auto' };
  })()`);
  check(fits.doc <= fits.win && fits.first && fits.logout && fits.scrolls, 'phone: nothing spills sideways; the tabs scroll in their bar and Log out stays on screen', fits);
  if (shots) await p.shot(`${shots}/09-phone-accounts.png`);
  await p.goto(`${base}/#/accounts/${account}`);
  await p.until(`!!document.querySelector('[data-pane]')`, 5000);
  const phonePane = await p.eval<{ doc: number; win: number; list: boolean; back: boolean }>(
    `({ doc: document.documentElement.scrollWidth, win: innerWidth, list: getComputedStyle(document.querySelector('.acc-list')).display !== 'none', back: getComputedStyle(document.querySelector('.back')).display !== 'none' })`,
  );
  check(phonePane.doc <= phonePane.win && !phonePane.list && phonePane.back, 'phone: an account takes the screen, with a way back', phonePane);
  if (shots) await p.shot(`${shots}/09b-phone-pane.png`);
  await p.goto(`${base}/#/accounts/${failing}`);
  await p.until(`!!document.querySelector('[data-pane="${failing}"] [data-stop]')`, 6000);
  const phoneChain = await p.eval<{ tops: number[]; lefts: number[]; doc: number; win: number }>(`(() => {
    const ls = [...document.querySelectorAll('[data-pane="${failing}"] [data-layer] .link-pill')];
    return { tops: ls.map((l) => Math.round(l.getBoundingClientRect().top)), lefts: ls.map((l) => Math.round(l.getBoundingClientRect().left)), doc: document.documentElement.scrollWidth, win: innerWidth };
  })()`);
  check(phoneChain.tops.every((t, i) => i === 0 || t > phoneChain.tops[i - 1]) && new Set(phoneChain.lefts).size === 1 && phoneChain.doc <= phoneChain.win, 'phone: the chain stands vertically and fits', phoneChain);
  if (shots) await p.shot(`${shots}/15-phone-chain.png`);
  await p.goto(`${base}/#/apps`);
  await p.until(`!!document.querySelector('[data-app]')`, 5000);
  if (shots) await p.shot(`${shots}/10-phone-apps.png`);
  await p.until(`!!document.querySelector('[data-matrix] [data-mx-scroll] [data-cell]')`, 6000);
  const phoneMx = await p.eval<{ doc: number; win: number; inner: number; box: number; moved: number; card: number }>(`(() => {
    const box = document.querySelector('[data-mx-scroll]');
    box.scrollLeft = 120;
    return { doc: document.documentElement.scrollWidth, win: innerWidth, inner: box.scrollWidth, box: box.clientWidth, moved: box.scrollLeft, card: Math.round(document.querySelector('[data-matrix]').getBoundingClientRect().right) };
  })()`);
  check(phoneMx.inner > phoneMx.box && phoneMx.moved > 0, 'phone: the matrix scrolls sideways inside its card', phoneMx);
  check(phoneMx.doc <= phoneMx.win && phoneMx.card <= phoneMx.win, 'and the page does not', phoneMx);
  if (shots) {
    await p.eval(`document.querySelector('[data-matrix]').scrollIntoView({ block: 'start' })`);
    await p.shot(`${shots}/16-phone-matrix.png`);
    await p.eval(`document.querySelector('[data-mx-scroll]').scrollLeft = 0`);
  }

  // The dark palette, for the eye.
  if (shots) {
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await p.size(1280, 900);
    await p.goto(`${base}/#/accounts`);
    await p.until(`!!document.querySelector('[data-account]')`, 5000);
    await p.shot(`${shots}/11-dark-accounts.png`);
    await p.goto(`${base}/#/apps`);
    await p.until(`!!document.querySelector('[data-app]')`, 5000);
    await p.shot(`${shots}/12-dark-apps.png`);
    await p.until(`!!document.querySelector('[data-matrix] [data-cell] .mx-cell')`, 6000);
    await p.eval(`document.querySelector('[data-matrix]').scrollIntoView({ block: 'start' })`);
    await p.shot(`${shots}/17-dark-matrix.png`);
    await p.goto(`${base}/#/accounts/${failing}`);
    await p.until(`!!document.querySelector('[data-pane="${failing}"] [data-stop]')`, 6000);
    await p.shot(`${shots}/18-dark-chain.png`);
  }

  check(p.errors.length === 0, 'no console errors', p.errors);
} catch (e) {
  failures++;
  console.log('FAIL', (e as Error).message);
  if (shots) await p.shot(`${shots}/failure.png`).catch(() => {});
} finally {
  c.close();
  await close();
  vnc.kill();
  xvfb.kill();
  rmSync(vncDir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
