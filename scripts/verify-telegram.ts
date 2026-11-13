/**
 * Telegram accounts end to end, through a throwaway manager process and the fake Telegram (TELEGRAM_FAKE=1), as the
 * page and an app use them:
 *
 *   1. the add form offers Telegram (api_id, api_hash, test servers); an account is added through POST /api/accounts
 *   2. its QR code (tg://login?token=…) is in its status; "New code" (the page's call of action refreshLink) replaces it
 *   3. a scan signs it in: online, who it is, the details and the dependency chain; secret.json holds the session
 *   4. an app (packages/client: register, approved through the manager's API) gets its snapshot and live events, and
 *      calls send, history, openDirect, forward, react, markRead, typing, fetchMedia, about, configure, profile;
 *      and stands in for the phone: approveLogin (a QR code another device shows), sessions, endSession (refused while
 *      the session is under a day old), and a login code from Telegram (777000) arriving in a chat of its own
 *   5. a two-step password and a phone-and-code sign-in, through the page's calls
 *   6. a restart keeps the session; a session revoked elsewhere goes back to a QR code
 *   7. removing an account on the page, with its directory
 *
 *   bun scripts/verify-telegram.ts [--keep]
 *
 * Port 18510, data under /tmp (deleted after unless --keep). Nothing reaches Telegram: the extractor's backend is the
 * fake, which answers on a socket in each account's directory.
 */
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { FAKE_IDS, fakeControl } from '../extractors/telegram/src/fake.ts';

const ROOT = resolve(import.meta.dir, '..');
const PORT = 18510;
const MGR = `http://127.0.0.1:${PORT}`;
const T = mkdtempSync('/tmp/dacc-tgverify-');
const keep = process.argv.includes('--keep');
const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const S = FAKE_IDS.self;
const DM_ALICE = `dm:${S}:${FAKE_IDS.alice}`;
const DM_BOB = `dm:${S}:${FAKE_IDS.bob}`;
const DEVS = `channel:${FAKE_IDS.devs}`;
const FORUM = `channel:${FAKE_IDS.forum}`;

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' && !ok ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const until = async <T>(f: () => T | Promise<T>, ms: number, what: string): Promise<T | null> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch {}
    await Bun.sleep(100);
  }
  console.log(`     (gave up waiting for ${what})`);
  return null;
};
const get = async (path: string) => (await fetch(MGR + path)).json() as Promise<any>;
const post = async (path: string, body: unknown) => (await fetch(MGR + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: MGR }, body: JSON.stringify(body) })).json() as Promise<any>;
const account = async (id: string) => (await get('/api/state')).accounts.find((a: any) => a.id === id);
const pageAction = (id: string, action: string, args?: unknown) => post(`/api/accounts/${id}/call`, { op: 'action', input: { action, ...(args ? { args } : {}) } });
const accDir = (id: string) => join(T, 'data', 'accounts', id);
const events = new Map<string, any[]>();
const evs = (id: string) => events.get(id) ?? [];
const lastStatus = (id: string) => evs(id).filter((e) => e.t === 'status').at(-1);
const addTelegram = async (label: string) => {
  const r = await post('/api/accounts', { kind: 'telegram', label, config: { apiId: '1234567' }, secret: { apiHash: HASH } });
  if (!r.id) throw new Error(`adding failed: ${r.error}`);
  return r.id as string;
};

let mgr: Subprocess | null = null;
let app: AccountsClient | null = null;
try {
  console.log(`     workdir ${T}`);
  mkdirSync(join(T, 'data'));
  mgr = Bun.spawn(['bun', 'packages/manager/src/main.ts', '--data', join(T, 'data'), '--port', String(PORT), '--host', '127.0.0.1', '--web-dist', join(T, 'no-page')], {
    cwd: ROOT,
    env: { ...process.env, TELEGRAM_FAKE: '1', TELEGRAM_FAKE_QR_MS: '4000', TELEGRAM_HEALTH_MS: '700' },
    stdout: Bun.file(join(T, 'manager.log')),
    stderr: Bun.file(join(T, 'manager.err')),
  });
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), `a throwaway manager on ${PORT}`);

  // 1. The kind and its form.
  const kinds = (await get('/api/state')).kinds;
  const tg = kinds.find((k: any) => k.kind === 'telegram');
  check(tg?.add, 'the manager has the telegram kind, addable on the page', kinds.map((k: any) => k.kind));
  if (!tg) throw new Error('no telegram kind: is extractors/telegram/manifest.ts there?');
  check(JSON.stringify(tg.add.fields.map((f: any) => f.key)) === '["apiId","apiHash","testDc"]' && tg.add.fields[1].secret, 'its form asks for api_id, api_hash (secret) and, optionally, the test servers');
  const bad = await post('/api/accounts', { kind: 'telegram', label: 'bad', config: { apiId: 'x' }, secret: { apiHash: HASH } });
  check(bad.error === 'api_id: the number my.telegram.org shows as App api_id', 'a malformed api_id is refused, in words', bad);

  // An app, as dither-chat's hub would be: chat on every account, approved through the manager's API.
  const reg = await register(MGR, { name: 'verify-telegram', requests: [{ interface: 'chat', level: 'manage', accounts: '*' }] });
  for (const r of reg.requests) await fetch(`${MGR}/api/requests/${r.id}/approve`, { method: 'POST', headers: { origin: MGR }, body: '{}' });
  app = new AccountsClient({ url: MGR, app: reg.app, token: reg.token, onEvents: (a, e) => (events.get(a) ?? events.set(a, []).get(a)!).push(...e) });
  check(await until(() => app!.connected, 5000, 'the app'), 'an app registered, its request approved, connected');

  // 2. Added: a QR code; a new one.
  const id = await addTelegram('Telegram (fake)');
  const qr = await until(() => lastStatus(id)?.attention?.qr, 20_000, 'the QR code');
  check(typeof qr === 'string' && qr.startsWith('tg://login?token='), 'added: its status carries a tg://login QR code for the page to draw', qr);
  check((await account(id))?.status?.attention?.kind === 'link_device', 'the page has it as a code to scan');
  check(JSON.stringify(JSON.parse(readFileSync(join(accDir(id), 'secret.json'), 'utf8'))) === JSON.stringify({ apiHash: HASH }), 'the api_hash went to secret.json, not the config');
  const fresh = await pageAction(id, 'refreshLink');
  const qr2 = await until(() => lastStatus(id)?.attention?.qr !== qr && lastStatus(id)?.attention?.qr, 10_000, 'a new code');
  check(fresh.ok && qr2, '"New code" (action refreshLink) replaces it');
  const qr3 = await until(() => lastStatus(id)?.attention?.qr !== qr2 && lastStatus(id)?.attention?.qr, 10_000, 'a fresh code once it expired');
  check(qr3, 'and a fresh one comes by itself as each expires');

  // 3. Scanned: online.
  await fakeControl(accDir(id), { op: 'scan' });
  const online = await until(async () => {
    const a = await account(id);
    return a?.status?.status === 'online' && a;
  }, 30_000, 'online');
  check(online, 'scanned: online');
  check(online?.self?.name === 'Test User' && online.self.detail === '@testuser', 'signed in as who it is (self)', online?.self);
  check(JSON.stringify(online?.layers?.map((l: any) => l.state)) === '["ok","ok","ok","ok"]', 'its chain: credentials, connection, signed in, updates, all ok', online?.layers);
  const pane = await get(`/api/accounts/${id}`);
  check(pane.status?.details?.signIn === 'signed in' && pane.status.details.chats === 7, "the pane's session facts", pane.status?.details);
  check(JSON.stringify(pane.secret?.keys) === '["apiHash","session","userId"]', 'secret.json: the api_hash and the session, nothing else', pane.secret);

  // 4. The app: the snapshot, live events, every op.
  check(await until(() => evs(id).some((e) => e.t === 'conversation' && e.conversation.nativeId === `${FORUM}/4`), 10_000, 'the snapshot'), 'the app got the snapshot: chats, groups, a forum with its topics as threads');
  check(evs(id).find((e) => e.t === 'hello')?.capabilities?.includes('threads'), 'and its hello with the capabilities');
  const sent = await app.call(chat, id, 'send', { conversation: DM_ALICE, body: 'hi **Alice**' });
  check(await until(() => evs(id).some((e) => e.t === 'message' && e.message.nativeId === sent?.nativeId), 5000, 'the echo'), 'send: the message and its echo as a fact', sent);
  await fakeControl(accDir(id), { op: 'incoming', peer: `user:${FAKE_IDS.alice}`, from: FAKE_IDS.alice, text: 'hello back' });
  check(await until(() => evs(id).some((e) => e.t === 'message' && e.live && e.message.body === 'hello back'), 5000, 'the incoming message'), 'an incoming message reaches the app, live');
  const hist = await app.call(chat, id, 'history', { conversation: DEVS, limit: 10 });
  check(hist.count === 3 && hist.done, 'history', hist);
  const od = await app.call(chat, id, 'openDirect', { peer: '@carol_c' });
  check(od.conversation === `dm:${S}:${FAKE_IDS.carol}` && od.startsAtFirstSend, 'openDirect by @username', od);
  const fw = await app.call(chat, id, 'forward', { conversation: DEVS, source: { conversation: DM_ALICE, message: `${DM_ALICE}#1` } });
  check(fw.nativeId?.startsWith(`${DEVS}#`), 'forward', fw);
  await app.call(chat, id, 'react', { conversation: DEVS, message: `${DEVS}#3`, key: '🎉' });
  check(await until(() => evs(id).some((e) => e.t === 'reaction' && e.key === '🎉' && e.author === String(S)), 5000, 'the reaction'), 'react');
  await app.call(chat, id, 'markRead', { conversation: DM_ALICE, upTo: `${DM_ALICE}#3` });
  await app.call(chat, id, 'typing', { conversation: DM_ALICE });
  check(true, 'markRead and typing');
  const photo = evs(id).find((e) => e.t === 'message' && e.message.nativeId === `${DM_BOB}#4`)?.message.attachments?.[0];
  const media = photo ? await app.call(chat, id, 'fetchMedia', { url: photo.url }) : null;
  check(media?.base64 && Buffer.from(media.base64, 'base64').subarray(1, 4).toString() === 'PNG', 'fetchMedia of a photo', photo);
  const about = await app.call(chat, id, 'about', { target: { kind: 'conversation', nativeId: DEVS } });
  check(about.noun === 'Group' && about.fields.name?.canEdit && about.members?.list.length === 4, 'about a supergroup', about.noun);
  const conf = await app.call(chat, id, 'configure', { target: { kind: 'conversation', nativeId: DEVS }, change: { key: 'slowMode', value: 60 } });
  check(conf.fields.slowMode?.value === 60, 'configure (slow mode)');
  const prof = await app.call(chat, id, 'profile', { who: String(FAKE_IDS.alice) });
  check(prof.bio === 'Down the rabbit hole' && prof.relationship === 'contact', 'profile', prof);
  const flood = await fakeControl(accDir(id), { op: 'flood', method: 'messages.sendMessage', seconds: 90 }).then(() => app!.call(chat, id, 'send', { conversation: DEVS, body: 'x' })).catch((e) => e);
  check(String(flood?.message).includes('wait 90 s'), 'FLOOD_WAIT reaches the app in words', String(flood?.message));
  check(await until(async () => String((await get(`/api/accounts/${id}`)).status?.details?.floodWait).includes('messages.sendMessage'), 5000, 'the wait on the pane'), 'and the pane says what Telegram holds back');

  // 4b. Standing in for the phone: approve a sign-in by its QR code, list the sessions, end one; login codes in
  // Telegram's own chat (777000).
  const act = (action: string, args?: unknown) => app!.call(chat, id, 'action', { action, ...(args ? { args } : {}) }) as Promise<any>;
  const refusal = (action: string, args?: unknown) => act(action, args).then((r) => `answered ${JSON.stringify(r)}`, (e) => String(e?.message ?? e));
  const listed = await act('sessions');
  check(listed?.sessions?.[0]?.current && listed.sessions[0].hash === '0' && listed.sessions.length === 3 && !JSON.stringify(listed).includes('203.0.113.7'), 'sessions: this one first (hash 0), the others, no IPs', listed);
  const shown = await fakeControl(accDir(id), { op: 'loginToken', device: 'Firefox 133, Linux', app: 'Telegram Web' });
  const approved = await act('approveLogin', { link: shown.link });
  check(approved?.session?.device === 'Firefox 133, Linux' && /^-?\d+$/.test(approved.session.hash) && typeof approved.session.createdAt === 'number', 'approveLogin {link}: the other device is signed in, and the answer says what it is', approved);
  check((await refusal('approveLogin', { link: shown.link })).startsWith('That code has already been used'), 'the same code again: already used');
  const stale = await fakeControl(accDir(id), { op: 'loginToken', ttlMs: 0 });
  const expiredWords = await refusal('approveLogin', { link: stale.link });
  check(expiredWords === 'That code has expired: show a new one on the other device', 'an expired code, in words', expiredWords);
  check((await refusal('approveLogin', { link: 'https://example.com/' })).startsWith('That is not a Telegram sign-in code'), 'a link that is not a sign-in code, in words');
  const tooNew = await refusal('endSession', { hash: approved?.session?.hash });
  check(tooNew.startsWith('Telegram does not let a session that is less than a day old end other sessions') && tooNew.includes("this account's own session (Telegram Desktop on dither-accounts"), 'endSession from a session under a day old: refused, naming it', tooNew);
  await fakeControl(accDir(id), { op: 'ageSession', hours: 30 });
  const ended = await act('endSession', { hash: approved?.session?.hash });
  const afterEnd = await act('sessions');
  check(JSON.stringify(ended) === '{}' && !afterEnd.sessions.some((s: any) => s.hash === approved?.session?.hash), 'once it is older, endSession {hash} ends that session', afterEnd);
  const adapterLog = readFileSync(join(accDir(id), 'adapter.log'), 'utf8');
  check(/approveLogin: approved/.test(adapterLog) && !adapterLog.includes(shown.token) && !adapterLog.includes(approved?.session?.hash) && !adapterLog.includes('Firefox'), "the account's log says what ran, never the code, the hash or the device");
  await fakeControl(accDir(id), { op: 'loginCode', code: '27182' });
  const DM_TELEGRAM = `dm:${S}:${FAKE_IDS.telegram}`;
  const codeMsg = await until(() => evs(id).find((e) => e.t === 'message' && e.live && e.message.conversation === DM_TELEGRAM), 5000, 'the login code');
  check(codeMsg && String(codeMsg.message.body).includes('27182') && evs(id).some((e) => e.t === 'conversation' && e.conversation.nativeId === DM_TELEGRAM && e.conversation.shape === 'direct'), "a login code from Telegram (777000) reaches the app, in a chat of its own", codeMsg);

  // 5. A two-step password, and a phone with a code.
  const pw = await addTelegram('Telegram with a password');
  await until(() => lastStatus(pw)?.attention?.qr, 20_000, 'its QR code');
  await fakeControl(accDir(pw), { op: 'setPassword', password: 'tr0ub4dor', hint: 'the comic' });
  await fakeControl(accDir(pw), { op: 'scan' });
  const asked = await until(() => lastStatus(pw)?.attention?.kind === 'login' && lastStatus(pw).attention.message, 10_000, 'the password asked for');
  check(asked && String(asked).includes('“the comic”'), 'a scanned account with a two-step password asks for it (attention login, with the hint)', asked);
  const wrong = await pageAction(pw, 'relogin', { password: 'nope' });
  check(!wrong.ok && wrong.error?.message === 'That password is not right. Try again.', 'a wrong password is refused', wrong);
  const right = await pageAction(pw, 'relogin', { password: 'tr0ub4dor' });
  check(right.ok && (await until(async () => (await account(pw))?.status?.status === 'online', 20_000, 'online')), 'the right one signs in (the page’s password form: action relogin)', right);
  const kept = ['secret.json', 'secret.json.bak', 'state.json', 'adapter.log'].filter((f) => existsSync(join(accDir(pw), f))).some((f) => readFileSync(join(accDir(pw), f), 'utf8').includes('tr0ub4dor'));
  check(!kept, 'the password is nowhere in its directory');

  const ph = await addTelegram('Telegram by phone');
  await until(() => lastStatus(ph)?.attention?.qr, 20_000, 'its QR code');
  const code = await pageAction(ph, 'sendCode', { phone: '+999 662 1234' });
  check(code.ok && (await until(() => lastStatus(ph)?.attention?.kind === 'verify', 5000, 'attention verify')), 'sendCode {phone}: Telegram sends a code (attention verify)', code);
  const badCode = await pageAction(ph, 'signIn', { code: '12345' });
  check(!badCode.ok && badCode.error?.message === 'That code is not right', 'a wrong code is refused', badCode);
  const good = await pageAction(ph, 'signIn', { code: '22222' });
  check(good.ok && (await until(async () => (await account(ph))?.status?.status === 'online', 20_000, 'online')), 'signIn {code}: online (test numbers 99966XYYYY take X five times)', good);

  // 6. A restart keeps the session; a revoked one goes back to a QR code.
  const session = JSON.parse(readFileSync(join(accDir(id), 'secret.json'), 'utf8')).session;
  const before = evs(id).length;
  await post(`/api/accounts/${id}/restart`, {});
  const back = await until(async () => (await account(id))?.online && evs(id).slice(before).some((e) => e.t === 'status' && e.status === 'online'), 30_000, 'online after the restart');
  check(back && !evs(id).slice(before).some((e) => e.t === 'status' && e.attention?.qr), 'a restart: online again on the saved session, no code to scan');
  check(JSON.parse(readFileSync(join(accDir(id), 'secret.json'), 'utf8')).session === session, 'the same session');
  await fakeControl(accDir(ph), { op: 'revoke' });
  const relink = await until(() => lastStatus(ph)?.attention?.qr && lastStatus(ph).attention.message, 15_000, 'a new QR code');
  check(relink && String(relink).includes('signed this device out'), 'a session ended elsewhere: a new QR code, and why', relink);
  check(!JSON.parse(readFileSync(join(accDir(ph), 'secret.json'), 'utf8')).session, 'and its session is gone from secret.json');

  // 7. Removed on the page with its directory.
  for (const x of [id, pw, ph]) await fetch(`${MGR}/api/accounts/${x}?purge=1`, { method: 'DELETE', headers: { origin: MGR } });
  check(await until(async () => !(await account(id)) && !existsSync(accDir(id)) && !existsSync(accDir(pw)), 15_000, 'gone'), 'removed on the page, directories and all');
  const log = existsSync(join(T, 'manager.err')) ? readFileSync(join(T, 'manager.err'), 'utf8') : '';
  check(!/telegram.*left out/i.test(log), 'the manager loaded the kind without complaint', log.slice(-300));
} catch (e) {
  failures++;
  console.log(`FAIL ${(e as Error).stack ?? e}`);
} finally {
  app?.close();
  if (mgr && mgr.exitCode === null) {
    mgr.kill('SIGTERM');
    const killer = setTimeout(() => mgr!.kill('SIGKILL'), 15_000);
    await mgr.exited;
    clearTimeout(killer);
  }
  if (keep) console.log(`     kept ${T}`);
  else rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
