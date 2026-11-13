/**
 * Chat accounts added on the manager's page, end to end, with a throwaway manager, a throwaway dither-chat hub (an app
 * of it, as the service runs it) and the Matrix testbed, the page driven in headless Chromium:
 *
 *   1. Matrix: the add form (homeserver, user ID, password) signs in to the testbed; the account is online on the page
 *      and in the hub, remote; a message from the testbed arrives in the hub, and one sent from the hub reaches it
 *   2. Signal (its real extractor on a fake signal-cli): the page shows the link QR, "New code" replaces it, a scan
 *      links it, and it is online in the hub too
 *   3. WhatsApp (its real extractor on a fake bridge): the QR, then a pairing code for a phone number, also in the hub
 *   4. The hub's log view and its removal of an account the page made, through the manager or not (dither-chat's
 *      side of the port: "gap" lines are what its live code does not do yet, and do not count as failures)
 *   5. Removing an account on the page, with its directory
 *
 *   bun scripts/verify-chat-add.ts [shots-dir] [--keep]
 *
 * Everything is fresh under /tmp (testbed 6198, manager 8483, hub 8495) and deleted after unless --keep. The page is
 * built there too, never into packages/manager/web/dist. Needs dither-chat beside this repo (or DITHER_CHAT_REPO, e.g.
 * a worktree with the port). The hub gets the fake signal-cli and bridge as well, so nothing reaches Signal or
 * WhatsApp even if it runs an account itself.
 */
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const ROOT = resolve(import.meta.dir, '..');
const CHAT = resolve(process.env.DITHER_CHAT_REPO ?? join(ROOT, '../dither-chat'));
const T = mkdtempSync('/tmp/dacc-chatadd-');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const shots = args.find((a) => !a.startsWith('--'));
if (shots) mkdirSync(shots, { recursive: true });
const MGR = 'http://127.0.0.1:8483';
const HUB = 'http://127.0.0.1:8495';
const tbEnv = { ...process.env, DITHER_TESTBED_DIR: join(T, 'tb'), DITHER_TESTBED_PORT: '6198' };
const tag = Math.random().toString(36).slice(2, 8);
const fakes = {
  SIGNAL_CLI_BIN: `${process.execPath} ${join(ROOT, 'extractors/signal/test/fake-signal-cli.ts')}`,
  FAKE_LINK_TIMEOUT_MS: '120000',
  WHATSAPP_BRIDGE_BIN: `${process.execPath} ${join(ROOT, 'extractors/whatsapp/test/fake-bridge.ts')}`,
  FAKE_WA_SOCK: join(T, 'wa.sock'),
  FAKE_WA_LOGGED_IN: '0',
};

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
/** Something dither-chat's live code does not do yet: reported, not failed. */
const gap = (ok: unknown, what: string, detail: unknown = '') => console.log(`${ok ? 'ok  ' : 'gap '} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
const until = async (f: () => unknown | Promise<unknown>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await f()) return true;
    } catch {}
    await Bun.sleep(250);
  }
  console.log(`     (gave up waiting for ${what})`);
  return false;
};
const get = async (base: string, path: string) => (await fetch(base + path)).json() as Promise<any>;
const post = (base: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
const testbed = (...a: string[]) => {
  const r = Bun.spawnSync(['bun', join(ROOT, 'extractors/matrix/testbed/testbed.ts'), ...a], { env: tbEnv, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`testbed ${a[0]}: ${r.stderr.toString().slice(-400)}`);
  return r.stdout.toString();
};
const spawn = (cmd: string[], cwd: string, env: Record<string, string | undefined>, log: string): Subprocess =>
  Bun.spawn(cmd, { cwd, env: env as any, stdout: Bun.file(join(T, log)), stderr: Bun.file(join(T, `${log}.err`)) });
const stopProc = async (p: Subprocess | null) => {
  if (!p || p.exitCode !== null) return;
  p.kill('SIGTERM');
  const killer = setTimeout(() => p.kill('SIGKILL'), 15_000);
  await p.exited;
  clearTimeout(killer);
};
const hubAccount = async (id: string) => (await get(HUB, '/api/bootstrap')).accounts.find((a: any) => a.id === id);
const mgrAccount = async (id: string) => (await get(MGR, '/api/state')).accounts.find((a: any) => a.id === id);
const found = async (text: string) => (await get(HUB, `/api/search?q=${encodeURIComponent(text)}`)).hits.length > 0;

// The fake WhatsApp bridge's control socket: it answers a pairing request with a code.
const waCtl = Bun.listen({ unix: fakes.FAKE_WA_SOCK, socket: { open: (s) => void s.write(JSON.stringify({ result: { op: 'pairPhone', value: { code: 'ABCD1234' } } }) + '\n'), data: () => {} } });

let mgr: Subprocess | null = null;
let hub: Subprocess | null = null;
let browser: Awaited<ReturnType<typeof launch>> | null = null;
try {
  console.log(`     workdir ${T}`);
  if (!existsSync(join(CHAT, 'packages/hub/src/main.ts'))) throw new Error(`no dither-chat at ${CHAT} (set DITHER_CHAT_REPO)`);
  const build = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', join(T, 'dist'), '--emptyOutDir'], { cwd: join(ROOT, 'packages/manager/web'), stdout: 'pipe', stderr: 'pipe' });
  check(build.exitCode === 0 && existsSync(join(T, 'dist/index.html')), 'the page built into the work dir', build.exitCode === 0 ? '' : build.stderr.toString().slice(-300));
  testbed('up');
  const tb = JSON.parse(readFileSync(join(T, 'tb', 'testbed.json'), 'utf8'));
  const general = tb.rooms.general as string;
  check(!!general && tb.users?.quinn?.password, 'the testbed is up');

  mkdirSync(join(T, 'mgr'));
  mgr = spawn(['bun', 'packages/manager/src/main.ts', '--data', join(T, 'mgr'), '--port', '8483', '--host', '127.0.0.1', '--web-dist', join(T, 'dist')], ROOT, { ...process.env, ...fakes }, 'manager.log');
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), 'a fresh manager');
  mkdirSync(join(T, 'web'));
  const hubEnv: Record<string, string | undefined> = { ...process.env, ...fakes, DITHER_DATA: undefined, DITHER_PORT: undefined, DITHER_PUBLIC_URL: undefined, DITHER_ACCOUNTS_URL: MGR, DITHER_ACCOUNTS_CLIENT: join(ROOT, 'packages/client/src/index.ts'), DITHER_CATEGORY_MODEL: 'keyword' };
  hub = spawn(['bun', 'packages/hub/src/main.ts', '--data', join(T, 'hub'), '--port', '8495', '--host', '127.0.0.1', '--web', join(T, 'web')], CHAT, hubEnv, 'hub.log');
  check(await until(async () => (await fetch(`${HUB}/api/health`)).ok, 30_000, 'the hub'), 'a fresh hub, in remote mode');
  await until(async () => (await get(MGR, '/api/state')).apps.some((a: any) => a.name === 'dither-chat'), 15_000, 'the hub registered');
  const app = (await get(MGR, '/api/state')).apps.find((a: any) => a.name === 'dither-chat');
  for (const r of app.requests.filter((r: any) => r.state === 'pending')) await fetch(`${MGR}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  check(app.requests.length === 2, 'the hub asked for chat and for running its kinds; approved');

  browser = await launch();
  const p = browser.page;
  const text = (sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
  const attr = (sel: string, name: string) => p.eval<string | null>(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
  const click = (sel: string) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.click(); })()`);
  /** Type into a Preact-controlled input. */
  const type = (sel: string, value: string) =>
    p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const paneId = () => p.eval<string | null>(`document.querySelector('[data-pane]')?.dataset.pane ?? null`);
  /** Add a kind on the page; the id of the account it opens. */
  const add = async (name: string, label: string, fields: Record<string, string> = {}) => {
    const before = await paneId();
    await click('[data-add-account]');
    await p.until(`!!document.querySelector('[data-add-dialog]')`, 3000);
    await p.eval(`[...document.querySelectorAll('[data-add-dialog] .choice')].find((c) => c.querySelector('strong')?.textContent === ${JSON.stringify(name)}).querySelector('input').click()`);
    await p.until(`!!document.querySelector('[data-add-confirm]')`, 3000);
    await type('.add-form .field input', label);
    for (const [k, v] of Object.entries(fields)) await type(`[data-add-field="${k}"]`, v);
    await click('[data-add-confirm]');
    await p.until(`!document.querySelector('[data-add-dialog]') && !!document.querySelector('[data-pane]') && document.querySelector('[data-pane]').dataset.pane !== ${JSON.stringify(before)}`, 8000);
    return (await paneId())!;
  };

  await p.size(1280, 900);
  await p.goto(`${MGR}/#/accounts`);
  await p.until(`!!document.querySelector('[data-add-account]')`, 8000);

  // 1. Matrix, signed in from the form.
  await click('[data-add-account]');
  await p.until(`!!document.querySelector('[data-add-dialog]')`, 3000);
  const dialog = await text('[data-add-dialog]');
  check(['Discord', 'Signal', 'Matrix', 'WhatsApp', 'Google'].every((n) => dialog.includes(n)), 'the add dialog offers the chat networks and Google');
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await p.until(`!document.querySelector('[data-add-dialog]')`, 3000);
  const mx = await add('Matrix', 'Testbed Matrix', { homeserver: tb.baseUrl, userId: tb.users.quinn.userId, password: tb.users.quinn.password });
  if (shots) await p.shot(`${shots}/01-matrix-added.png`);
  check(await until(async () => (await mgrAccount(mx))?.online && (await mgrAccount(mx))?.status?.status === 'online', 60_000, 'Matrix online'), 'Matrix: signed in from the form, online on the page');
  const secret = JSON.parse(readFileSync(join(T, 'mgr', 'accounts', mx, 'secret.json'), 'utf8'));
  check(!('password' in secret) && !!secret.accessToken, 'its password was used once and dropped; only the session is kept', Object.keys(secret));
  check(!JSON.stringify((await get(MGR, `/api/accounts/${mx}`)).config).includes(tb.users.quinn.password), 'the password is in no config');
  await p.until(`document.querySelector('[data-condition]')?.textContent === 'Online'`, 15_000).catch(() => {});
  check((await text('[data-condition]')) === 'Online', 'the pane says it is online', await text('[data-condition]'));
  check(await until(async () => (await hubAccount(mx))?.status === 'online', 30_000, 'the hub has it'), 'it is in the hub, online, under the same id');
  const hubMx = await hubAccount(mx);
  check(hubMx?.network === 'matrix' && hubMx?.capabilities?.length > 0, 'as a Matrix account with its capabilities', { network: hubMx?.network, caps: hubMx?.capabilities?.length });
  check(!Bun.spawnSync(['ps', '-eo', 'args']).stdout.toString().includes(join(CHAT, 'packages/adapter-matrix/src/main.ts')), 'the hub runs no adapter for it: it is remote');
  testbed('say', 'alice', 'general', `pagein${tag} from alice`);
  check(await until(() => found(`pagein${tag}`), 30_000, 'the message in the hub'), 'a message from the testbed arrives in the hub');
  const conv = (await get(HUB, '/api/bootstrap')).conversations.find((c: any) => c.nativeId === general);
  const sent = await post(HUB, `/api/conversations/${conv?.id}/send`, { body: `pageout${tag} from the hub` });
  check(sent.ok, 'the hub sends', sent.status);
  check(await until(() => testbed('tail', 'general', '10').includes(`pageout${tag}`), 30_000, 'the sent message on the homeserver'), 'and it reaches the homeserver through the manager');

  // 2. Signal: link QR, a new one, a scan.
  const sg = await add('Signal', 'Fake Signal');
  check(await p.until(`(document.querySelector('[data-qr]')?.dataset.qr ?? '').startsWith('sgnl://linkdevice')`, 30_000).then(() => true, () => false), 'Signal: the page shows its link QR');
  check((await p.eval<number>(`document.querySelector('[data-qr] svg')?.getBoundingClientRect().width ?? 0`)) > 100, 'drawn large enough to scan');
  if (shots) await p.shot(`${shots}/02-signal-qr.png`);
  const qr1 = await attr('[data-qr]', 'data-qr');
  await click('[data-new-code]');
  check(await p.until(`(document.querySelector('[data-qr]')?.dataset.qr ?? '') !== ${JSON.stringify(qr1)} && (document.querySelector('[data-qr]')?.dataset.qr ?? '').startsWith('sgnl://')`, 30_000).then(() => true, () => false), '"New code" replaces it');
  check(await until(async () => (await hubAccount(sg))?.attention?.qr?.startsWith('sgnl://'), 15_000, 'the QR in the hub'), 'the hub has the same QR (its own link page would show it)');
  writeFileSync(join(T, 'mgr', 'accounts', sg, 'signal-cli', 'fake-scan'), 'ok');
  check(await until(async () => (await mgrAccount(sg))?.status?.status === 'online', 60_000, 'Signal linked'), 'a scan links it: online on the page');
  check(await until(async () => (await hubAccount(sg))?.status === 'online', 30_000, 'Signal online in the hub'), 'and in the hub');

  // 3. WhatsApp: QR, then a pairing code.
  const wa = await add('WhatsApp', 'Fake WhatsApp');
  check(await p.until(`document.querySelector('[data-qr]')?.dataset.qr === '2@fake-qr'`, 30_000).then(() => true, () => false), 'WhatsApp: the page shows its QR');
  await type('[data-pair-phone]', '+15551234567');
  await p.eval(`document.querySelector('[data-pair-phone]').form.requestSubmit()`);
  check(await p.until(`document.querySelector('[data-pair-code]')?.textContent === 'ABCD-1234'`, 15_000).then(() => true, () => false), 'a pairing code for a phone number replaces it');
  if (shots) await p.shot(`${shots}/03-whatsapp-pair.png`);
  check(await until(async () => (await hubAccount(wa))?.attention?.detail?.pairCode === 'ABCD-1234', 15_000, 'the code in the hub'), 'the hub has the pairing code too');

  // 4. dither-chat's side, as its code is now.
  const log = await (await fetch(`${HUB}/api/accounts/${mx}/log`)).text();
  gap(log.length > 0, "the hub's log view shows the log of an account the page made", { chars: log.length });

  // 5. Remove the WhatsApp account on the page, with its directory.
  await p.goto(`${MGR}/#/accounts/${wa}`);
  await p.until(`!!document.querySelector('[data-remove]')`, 5000);
  await click('[data-remove]');
  await p.until(`!!document.querySelector('[data-confirm-check]')`, 3000);
  if (shots) await p.shot(`${shots}/04-remove.png`);
  await click('[data-confirm-check]');
  await click('[data-confirm]');
  check(await until(async () => !(await mgrAccount(wa)) && !existsSync(join(T, 'mgr', 'accounts', wa)), 15_000, 'gone'), 'removing it with its directory: gone from the manager and the disk');
  await Bun.sleep(3000);
  // Today's hub starts it itself, on an empty directory: a new link code. A ported one says it is gone instead.
  const after = await hubAccount(wa);
  const started = after && (after.status === 'online' || after.status === 'connecting' || after.attention?.kind === 'link_device');
  gap(!started, 'the hub does not start an account the page made and removed on its own (it has no session for it)', { status: after?.status ?? 'gone', attention: after?.attention?.message?.slice(0, 60) ?? null });

  check(p.errors.length === 0, 'no console errors on the page', p.errors);
} catch (e) {
  check(false, 'the run', String((e as Error)?.stack ?? e));
} finally {
  await browser?.close();
  await stopProc(hub);
  await stopProc(mgr);
  waCtl.stop(true);
  try {
    testbed('stop');
  } catch {}
  if (!keep) rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
