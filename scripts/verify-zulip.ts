/**
 * A Zulip account end to end through dither-chat's web app, against the Zulip sandbox (extractors/zulip/testbed), with a
 * throwaway manager and a throwaway hub of their own, the pages driven in headless Chromium:
 *
 *   1. Add account → Zulip in the web app with a wrong API key: the account asks for a sign-in ("login")
 *   2. "Replace sign-in" on the manager's page with the right key: online on the page and in the hub
 *   3. A second account by password on the manager's page: the key is fetched, the password is in no secret or config
 *   4. Structure in the hub: the organization a community, the folder a section, channels forums, topics threads, DMs
 *   5. New post in the app starts a topic, the topic's message box sends into it, Zulip has both; the @ picker there
 *      offers @everyone and @here
 *   6. Live from Zulip: a message, a reaction, a rename that moves the messages, a resolve
 *   7. A restart of the extractor: online again, the message sent meanwhile there once
 *
 *   eval "$(bun extractors/zulip/testbed/sandbox.ts env)"
 *   bun scripts/verify-zulip.ts [shots-dir] [--keep]
 *
 * Needs ZULIP_SANDBOX_URL, ZULIP_SANDBOX_CREDS and NODE_EXTRA_CA_CERTS (the sandbox's CA) from that `env`, and
 * dither-chat beside this repo or at DITHER_CHAT_REPO. Everything else is fresh under /tmp, on free ports, and deleted
 * after unless --keep. The hub is started with DITHER_CALENDAR_URL=off, so it never reaches a calendar beside it.
 * Lines that say "gap" are things known not to hold yet: reported, not failed. The topics it makes carry a run tag.
 */
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const ROOT = resolve(import.meta.dir, '..');
const CHAT = resolve(process.env.DITHER_CHAT_REPO ?? join(ROOT, '../dither-chat'));
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const shots = args.find((a) => !a.startsWith('--'));
if (shots) mkdirSync(shots, { recursive: true });
const credsFile = process.env.ZULIP_SANDBOX_CREDS;
if (!credsFile || !existsSync(credsFile) || !process.env.NODE_EXTRA_CA_CERTS) {
  console.error('no sandbox: eval "$(bun extractors/zulip/testbed/sandbox.ts env)" first');
  process.exit(2);
}
interface SandboxUser {
  email: string;
  password: string;
  apiKey: string;
  userId: number;
}
const creds = JSON.parse(readFileSync(credsFile, 'utf8')) as { url: string; users: Record<string, SandboxUser>; channels: Record<string, number> };
const ZULIP = process.env.ZULIP_SANDBOX_URL ?? creds.url;
const HOST = new URL(ZULIP).host;
const quinn = creds.users.quinn;
const T = mkdtempSync('/tmp/dacc-zulip-');
const tag = `vz${Math.random().toString(36).slice(2, 7)}`;

const freePort = (): number => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
};
const MGR = `http://127.0.0.1:${freePort()}`;
const HUB = `http://127.0.0.1:${freePort()}`;

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
/** Something known not to hold yet: reported, not failed. */
const gap = (ok: unknown, what: string, detail: unknown = '') => console.log(`${ok ? 'ok  ' : 'gap '} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
const until = async <V>(f: () => V | Promise<V>, ms: number, what: string): Promise<V | false> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch {}
    await Bun.sleep(250);
  }
  console.log(`     (gave up waiting for ${what})`);
  return false;
};
const MGR_PASSWORD = `verify-${crypto.randomUUID()}`;
const auth = (base: string): Record<string, string> => {
  const file = base === HUB ? join(T, 'hub', 'api.token') : join(T, 'mgr', 'cli.token');
  if (!existsSync(file)) return {};
  const token = readFileSync(file, 'utf8').trim();
  return base === HUB ? { authorization: `Bearer ${token}`, origin: base } : { 'x-dither-accounts-cli': token };
};
const get = async (base: string, path: string) => (await fetch(base + path, { headers: auth(base) })).json() as Promise<any>;
const post = (base: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(base) }, body: JSON.stringify(body) });
/** Zulip's REST API as one of the sandbox's people. */
const zulip = async (who: string, method: string, path: string, params: Record<string, unknown> = {}): Promise<any> => {
  const u = creds.users[who]!;
  const enc = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const r = await fetch(`${ZULIP}/api/v1${path}${method === 'GET' && enc.size ? `?${enc}` : ''}`, { method, headers: { authorization: `Basic ${btoa(`${u.email}:${u.apiKey}`)}` }, body: method === 'GET' ? undefined : enc });
  return r.json();
};
const say = (who: string, topic: string, content: string) => zulip(who, 'POST', '/messages', { type: 'stream', to: 'sandbox', topic, content });
const newest = async (topic: string): Promise<{ id: number; content: string; subject: string; reactions: { user_id: number; emoji_name: string }[] }[]> =>
  (await zulip('ann', 'GET', '/messages', { anchor: 'newest', num_before: 20, num_after: 0, apply_markdown: false, narrow: [{ operator: 'channel', operand: 'sandbox' }, { operator: 'topic', operand: topic }] })).messages ?? [];
const spawn = (cmd: string[], cwd: string, env: Record<string, string | undefined>, log: string): Subprocess =>
  Bun.spawn(cmd, { cwd, env: env as any, stdout: Bun.file(join(T, log)), stderr: Bun.file(join(T, `${log}.err`)) });
const stopProc = async (p: Subprocess | null) => {
  if (!p || p.exitCode !== null) return;
  p.kill('SIGTERM');
  const killer = setTimeout(() => p.kill('SIGKILL'), 15_000);
  await p.exited;
  clearTimeout(killer);
};
const boot = () => get(HUB, '/api/bootstrap');
const hubAccount = async (id: string) => (await boot()).accounts.find((a: any) => a.id === id);
const mgrAccount = async (id: string) => (await get(MGR, '/api/state')).accounts.find((a: any) => a.id === id);
const thread = async (name: string) => (await boot()).conversations.find((c: any) => c.shape === 'thread' && c.name === name);
const messages = async (conv: string): Promise<any[]> => {
  const m = await get(HUB, `/api/conversations/${conv}/messages?limit=200`);
  return (Array.isArray(m) ? m : m.messages).filter((x: any) => !x.deleted);
};
const build = (dir: string, out: string) => Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', out, '--emptyOutDir'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });

let mgr: Subprocess | null = null;
let hub: Subprocess | null = null;
let browser: Awaited<ReturnType<typeof launch>> | null = null;
try {
  console.log(`     workdir ${T}, run tag ${tag}`);
  if (!existsSync(join(CHAT, 'packages/hub/src/main.ts'))) throw new Error(`no dither-chat at ${CHAT} (set DITHER_CHAT_REPO)`);
  check((await fetch(`${ZULIP}/api/v1/server_settings`).then((r) => r.ok, () => false)) === true, 'the Zulip sandbox answers');
  check(build(join(ROOT, 'packages/manager/web'), join(T, 'mgrdist')).exitCode === 0, "the manager's page built into the work dir");
  check(build(join(CHAT, 'packages/web'), join(T, 'web')).exitCode === 0 && existsSync(join(T, 'web/index.html')), 'the web app built into the work dir');

  mkdirSync(join(T, 'mgr'));
  writeFileSync(join(T, 'mgr-password'), MGR_PASSWORD, { mode: 0o600 });
  const pw = Bun.spawnSync(['bun', 'packages/manager/src/cli.ts', 'set-password', '--data', join(T, 'mgr'), '--file', join(T, 'mgr-password')], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (pw.exitCode !== 0) throw new Error(`set-password: ${pw.stderr.toString().slice(-300)}`);
  mgr = spawn(['bun', 'packages/manager/src/main.ts', '--data', join(T, 'mgr'), '--port', new URL(MGR).port, '--host', '127.0.0.1', '--web-dist', join(T, 'mgrdist')], ROOT, { ...process.env }, 'manager.log');
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), 'a fresh manager');
  // The hub's login, as its own scripts set it up (dither-chat scripts/hub-login.ts, docs/login.md).
  const login = (await import(join(CHAT, 'scripts/hub-login.ts'))) as { prepareLogin(dir: string): Promise<void>; signInPage(page: unknown, base: string): Promise<void> };
  await login.prepareLogin(join(T, 'hub'));
  const hubEnv: Record<string, string | undefined> = { ...process.env, DITHER_DATA: undefined, DITHER_PORT: undefined, DITHER_PUBLIC_URL: undefined, DITHER_CALENDAR_URL: 'off', DITHER_ACCOUNTS_URL: MGR, DITHER_ACCOUNTS_CLIENT: join(ROOT, 'packages/client/src/index.ts'), DITHER_CATEGORY_MODEL: 'keyword' };
  hub = spawn(['bun', 'packages/hub/src/main.ts', '--data', join(T, 'hub'), '--port', new URL(HUB).port, '--host', '127.0.0.1', '--web', join(T, 'web')], CHAT, hubEnv, 'hub.log');
  check(await until(async () => (await fetch(`${HUB}/api/health`)).ok, 30_000, 'the hub'), 'a fresh hub, in remote mode');
  await until(async () => (await get(MGR, '/api/state')).apps.some((a: any) => a.name === 'dither-chat'), 15_000, 'the hub registered');
  const app = (await get(MGR, '/api/state')).apps.find((a: any) => a.name === 'dither-chat');
  for (const r of app.requests.filter((r: any) => r.state === 'pending')) await fetch(`${MGR}/api/requests/${r.id}/approve`, { method: 'POST', headers: auth(MGR), body: '{}' });
  check(app.requests.some((r: any) => r.interface === 'accounts' && (r.kinds ?? []).includes('zulip')), 'the hub asked to run zulip accounts; approved');

  browser = await launch();
  const p = browser.page;
  // A confirm() would hold the page: answer yes.
  p.on('Page.javascriptDialogOpening', () => void p.send('Page.handleJavaScriptDialog', { accept: true }));
  const click = (sel: string) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.click(); })()`);
  const clickText = (sel: string, text: string) =>
    p.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!e) throw new Error('no ' + ${JSON.stringify(text)}); e.click(); })()`);
  /** Real typing into whatever has the focus. */
  const typeInto = async (focus: string, text: string) => {
    await p.eval(`(() => { const e = ${focus}; if (!e) throw new Error('nothing to type into'); e.focus(); e.select?.(); })()`);
    await p.send('Input.insertText', { text });
  };
  const enter = async () => {
    for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  };
  await p.size(1280, 800);

  // 1. Add account → Zulip in the web app, with a wrong key.
  await login.signInPage(p, HUB);
  await p.goto(`${HUB}/#/accounts`);
  await p.eval(`location.reload()`); // the page drawn before the sign-in is the login's
  await p.until(`!!document.querySelector('.add-btn')`, 15_000);
  p.errors.length = 0; // what the login page logged before the sign-in
  await click('.add-btn');
  await p.until(`!!document.querySelector('.net-opt[data-kind="zulip"]')`, 8000);
  if (shots) await p.shot(`${shots}/add-account.png`);
  await click('.net-opt[data-kind="zulip"]');
  await p.until(`document.querySelectorAll('.modal input').length >= 5`, 5000);
  const labels = await p.eval<string>(`document.querySelector('.modal').innerText`);
  check(['Organization URL', 'Email', 'API key', 'Password'].every((l) => labels.includes(l)), 'the web app’s Zulip form asks for the server, the email and a key or a password');
  check(await p.eval<boolean>(`[...document.querySelectorAll('.modal input')].slice(3).every((i) => i.type === 'password')`), 'the key and the password are typed hidden');
  const fields = ['Sandbox', ZULIP, quinn.email, 'WRONGKEYWRONGKEYWRONGKEYWRONGKEY'];
  for (const [i, v] of fields.entries()) await typeInto(`document.querySelectorAll('.modal input')[${i}]`, v);
  if (shots) await p.shot(`${shots}/add-zulip-form.png`);
  await clickText('.modal button', 'Add account');
  const added = await until(async () => (await boot()).accounts.find((a: any) => a.network === 'zulip'), 15_000, 'the account in the hub');
  const id: string = added ? added.id : '';
  check(!!id, 'the form adds a zulip account');
  check(await until(async () => (await hubAccount(id))?.attention?.kind === 'login', 30_000, 'the login attention'), 'a wrong key: the account asks for a sign-in', (await hubAccount(id))?.attention?.message?.slice(0, 80));
  const cfg = (await get(MGR, `/api/accounts/${id}`)).account?.config ?? (await get(MGR, `/api/accounts/${id}`)).config;
  check(JSON.stringify(cfg ?? {}).includes(HOST), 'the server and the email are config, the key is not', Object.keys(cfg ?? {}));
  gap(await p.eval<boolean>(`!!document.querySelector('.account-pane .attention input')`), 'the web app’s account page takes a new key or password for it (today only the manager’s page does)');

  // 2. The right key, on the manager's page.
  const session = /dacc_session=([^;]+)/.exec((await fetch(`${MGR}/login`, { method: 'POST', redirect: 'manual', headers: { origin: MGR }, body: new URLSearchParams({ username: 'admin', password: MGR_PASSWORD }) })).headers.get('set-cookie') ?? '')?.[1];
  await p.send('Network.setCookie', { name: 'dacc_session', value: session, url: MGR, httpOnly: true });
  await p.goto(`${MGR}/#/accounts/${id}`);
  await p.until(`!!document.querySelector('[data-replace-secret]')`, 10_000);
  await click('[data-replace-secret]');
  await p.until(`!!document.querySelector('[data-replace-field="apiKey"]')`, 5000);
  await typeInto(`document.querySelector('[data-replace-field="apiKey"]')`, quinn.apiKey);
  await clickText('button', 'Replace');
  check(await until(async () => (await mgrAccount(id))?.status?.status === 'online', 60_000, 'online in the manager'), 'the right key: online on the manager’s page');
  check(await until(async () => (await hubAccount(id))?.status === 'online', 30_000, 'online in the hub'), 'and in the hub');

  // 3. A second account by password, on the manager's page.
  await p.goto(`${MGR}/#/accounts`);
  await p.until(`!!document.querySelector('[data-add-account]')`, 8000);
  await click('[data-add-account]');
  await p.until(`!!document.querySelector('[data-add-service="zulip"]')`, 5000);
  await click('[data-add-service="zulip"]');
  await p.until(`!!document.querySelector('[data-add-way="password"]')`, 5000);
  const ways = await p.eval<string[]>(`[...document.querySelectorAll('[data-add-way]')].map((e) => e.dataset.addWay)`);
  check(ways.includes('api-key') && ways.includes('password'), 'the manager’s page offers Zulip by API key and by password', ways);
  gap(await p.eval<boolean>(`!document.querySelector('[data-add-field="apiKey"]')?.closest('details')`), 'the API key way shows its key field up front (today under "More options")');
  await click('[data-add-way="password"]');
  await p.eval(`document.querySelector('[data-add-dialog] details')?.setAttribute('open', '')`);
  const before = await p.eval<string | null>(`document.querySelector('[data-pane]')?.dataset.pane ?? null`);
  const typeField = (k: string, v: string) => typeInto(`document.querySelector('input[data-add-field="${k}"], [data-add-field="${k}"] input')`, v);
  await typeField('server', ZULIP);
  await typeField('email', quinn.email);
  await typeField('password', quinn.password);
  await click('[data-add-confirm]');
  await p.until(`!document.querySelector('[data-add-dialog]') && !!document.querySelector('[data-pane]') && document.querySelector('[data-pane]').dataset.pane !== ${JSON.stringify(before)}`, 10_000);
  const second = (await p.eval<string>(`document.querySelector('[data-pane]').dataset.pane`))!;
  check(await until(async () => (await mgrAccount(second))?.status?.status === 'online', 60_000, 'the second account online'), 'by password: online');
  const secretDir = join(T, 'mgr', 'accounts', second);
  const secret = JSON.parse(readFileSync(join(secretDir, 'secret.json'), 'utf8'));
  check(secret.apiKey === quinn.apiKey && !('password' in secret), 'the password was swapped for the key and dropped from the secret', Object.keys(secret));
  check(!JSON.stringify(await get(MGR, `/api/accounts/${second}`)).includes(quinn.password) && !(await p.eval<string>(`document.documentElement.innerHTML`)).includes(quinn.password), 'the password is in no answer and not on the page');
  const bak = join(secretDir, 'secret.json.bak');
  gap(!existsSync(bak) || !readFileSync(bak, 'utf8').includes(quinn.password), 'the password is not left in secret.json.bak either');
  // One account from here on: remove the second on the page, with its directory.
  await click('[data-remove]');
  await p.until(`!!document.querySelector('[data-confirm-check]')`, 3000);
  await click('[data-confirm-check]');
  await click('[data-confirm]');
  check(await until(async () => !(await mgrAccount(second)) && !existsSync(secretDir), 15_000, 'the second account gone'), 'removed again, with its directory');
  await fetch(`${HUB}/api/accounts/${second}`, { method: 'DELETE', headers: auth(HUB) }).catch(() => {});

  // 4. Structure.
  await until(async () => (await boot()).conversations.some((c: any) => c.shape === 'thread'), 30_000, 'topics in the hub');
  const b = await boot();
  const org = b.spaces.find((s: any) => s.nativeId === HOST);
  check(org?.kind === 'community', 'the organization is a community space', org?.name);
  check(b.spaces.some((s: any) => s.kind === 'section' && s.nativeId.startsWith(`${HOST}/f/`)), 'its channel folder is a section');
  const channels = b.conversations.filter((c: any) => c.shape === 'channel');
  check(channels.length > 0 && channels.every((c: any) => c.variant === 'forum' && c.nativeId.startsWith(`${HOST}/s/`)), 'channels are forums', channels.length);
  const sandbox = channels.find((c: any) => c.nativeId === `${HOST}/s/${creds.channels.sandbox}`);
  const topics = b.conversations.filter((c: any) => c.shape === 'thread');
  check(topics.length > 0 && topics.every((c: any) => c.nativeId.includes('/t/')), 'topics are threads', topics.length);
  const byId = new Set(b.conversations.map((c: any) => c.id));
  gap(topics.every((c: any) => byId.has(c.parentId)), 'every topic’s channel is a conversation here', topics.filter((c: any) => !byId.has(c.parentId)).map((c: any) => c.nativeId));
  const convIds = new Map(b.conversations.map((c: any) => [c.id, c]));
  const rootTopics = b.edges.filter((e: any) => e.childKind === 'conversation' && (convIds.get(e.childId) as any)?.shape === 'thread').length;
  gap(rootTopics === 0, 'topics hang under their channel only, not under the organization as channels', { topicsAsChannels: rootTopics });
  const dms = b.conversations.filter((c: any) => c.nativeId.includes('/dm/'));
  check(['direct', 'group', 'self'].every((s) => dms.some((c: any) => c.shape === s)), 'direct, group and self conversations', dms.length);

  // 5. Sending from the app.
  const topic = `${tag} harness topic`;
  await p.goto(`${HUB}/#/s/${org.id}/c/${sandbox.id}`);
  await p.until(`[...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'New post')`, 15_000);
  if (shots) await p.shot(`${shots}/channel-topics.png`);
  await clickText('button', 'New post');
  await p.until(`!!document.querySelector('.modal textarea')`, 5000);
  await typeInto(`document.querySelector('.modal input')`, topic);
  await typeInto(`document.querySelector('.modal textarea')`, `First post ${tag}, **bold**.`);
  await clickText('.modal button', 'Post');
  check(await until(async () => (await newest(topic)).some((m) => m.content === `First post ${tag}, **bold**.` && m.subject === topic), 15_000, 'the post in Zulip'), 'New post starts the topic in Zulip, its capitals kept');
  const made = await until(() => thread(topic), 10_000, 'the topic in the hub');
  check(made && made.parentId === sandbox.id, 'and it is a thread of the channel here');
  if (made) await p.goto(`${HUB}/#/s/${org.id}/c/${made.id}`);
  await p.until(`!!document.querySelector('.composer textarea') && document.querySelectorAll('.msg').length > 0`, 15_000);
  await typeInto(`document.querySelector('.composer textarea')`, `Second message ${tag}.`);
  await enter();
  check(await until(async () => (await newest(topic)).some((m) => m.content === `Second message ${tag}.`), 15_000, 'the message in Zulip'), 'the topic’s message box sends into it');
  // The @ picker in the topic: Zulip's people and groups, and @everyone and @here (sent as Zulip's @**all** and @**topic**).
  await typeInto(`document.querySelector('.composer textarea')`, '@');
  const offered = await p.until(`[...document.querySelectorAll('.mp-pop .mp-note')].some((e) => e.textContent === 'everyone in this topic')`, 10_000).then(
    () => true,
    () => false,
  );
  check(offered, 'the @ picker offers @everyone and @here in a topic');
  if (shots) await p.shot(`${shots}/mention-picker.png`);
  await typeInto(`document.querySelector('.composer textarea')`, ' ');

  // 6. Live from Zulip.
  const live = await say('ann', topic, `@**Quinn Park** live ${tag}`);
  check(await until(() => p.eval<boolean>(`[...document.querySelectorAll('.msg.mentioned')].some((e) => e.innerText.includes(${JSON.stringify(`live ${tag}`)}))`), 15_000, 'the mention on the page'), 'a mention from Zulip shows in the open topic, marked');
  await zulip('bob', 'POST', `/messages/${live.id}/reactions`, { emoji_name: 'heart' });
  check(await until(() => p.eval<boolean>(`[...document.querySelectorAll('.msg')].some((e) => e.innerText.includes(${JSON.stringify(`live ${tag}`)}) && !!e.querySelector('.reaction'))`), 15_000, 'the reaction on the page'), 'a reaction from Zulip shows on it');
  if (shots) await p.shot(`${shots}/topic.png`);
  // Zulip's times are whole seconds. Two messages sent back to back usually share one, and the hub then has no order for them.
  const first = await say('ann', topic, `same second a ${tag}`);
  const next = await say('bob', topic, `same second b ${tag}`);
  await until(async () => made && (await messages(made.id)).filter((m) => m.body.includes('same second')).length === 2, 10_000, 'both messages');
  if (made) {
    const order = (await messages(made.id)).filter((m) => m.body.includes('same second')).map((m) => m.nativeId);
    gap(order[0] === `${HOST}/m/${first.id}` && order[1] === `${HOST}/m/${next.id}`, 'two messages of one second keep Zulip’s order', order);
  }
  const renamed = `${tag} Renamed`;
  const count = made ? (await messages(made.id)).length : 0;
  await zulip('ann', 'PATCH', `/messages/${live.id}`, { topic: renamed, propagate_mode: 'change_all', send_notification_to_old_thread: false, send_notification_to_new_thread: false });
  check(await until(async () => { const t = await thread(renamed); return t && (await messages(t.id)).length === count; }, 15_000, 'the moved messages'), 'a topic renamed in Zulip: its messages are in the new topic', count);
  check(await until(async () => !(await thread(topic)), 5000, 'the old topic gone'), 'and the old topic is gone');
  await zulip('ann', 'PATCH', `/messages/${live.id}`, { topic: `✔ ${renamed}`, propagate_mode: 'change_all', send_notification_to_old_thread: false, send_notification_to_new_thread: false });
  check(await until(async () => (await thread(`✔ ${renamed}`))?.archived === true, 15_000, 'the resolved topic'), 'a topic resolved in Zulip is ✔ and archived here');

  // 7. A restart mid-session.
  const resolved = await thread(`✔ ${renamed}`);
  if (shots && resolved) {
    // The topic's About: Zulip's words for following and muting, Resolve, no Lock or timers.
    await p.goto(`${HUB}/#/about/c/${resolved.id}`);
    await p.until(`document.body.innerText.includes('Unresolve')`, 15_000).catch(() => {});
    await p.shot(`${shots}/topic-about.png`);
    // The topic at a phone's width.
    await p.size(390, 844, true);
    await p.goto(`${HUB}/#/s/${org.id}/c/${resolved.id}`);
    await p.until(`document.querySelectorAll('.msg').length > 0`, 15_000).catch(() => {});
    await p.shot(`${shots}/phone-topic.png`);
    await p.size(1280, 800);
  }
  const had = resolved ? (await messages(resolved.id)).length : 0;
  await post(HUB, `/api/accounts/${id}/action`, { action: 'restart' });
  await say('ann', `✔ ${renamed}`, `during the restart ${tag}`);
  check(await until(async () => (await hubAccount(id))?.status === 'online' && resolved && (await messages(resolved.id)).length === had + 1, 60_000, 'the message sent meanwhile'), 'a restart: online again, the message sent meanwhile is there');
  await Bun.sleep(3000);
  if (resolved) {
    const after = await messages(resolved.id);
    check(after.length === had + 1 && new Set(after.map((m) => m.nativeId)).size === after.length, 'once: no duplicates', after.length);
  }
  const broken = p.errors.filter((e) => /status of (404|502)/.test(e));
  check(p.errors.length === broken.length, 'no errors on the pages', p.errors.filter((e) => !broken.includes(e)).slice(0, 5));
  // Step 3 added the organization a second time and removed it: people's pictures then point at the removed account.
  gap(broken.length === 0, 'no picture fails to load after an account of the same organization was removed', broken.length);
} catch (e) {
  check(false, 'the run', String((e as Error)?.stack ?? e));
} finally {
  await browser?.close();
  await stopProc(hub);
  await stopProc(mgr);
  if (!keep) rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
