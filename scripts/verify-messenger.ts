/**
 * The messenger and instagram kinds end to end, as the page and an app use them, against the fakes
 * (test/fake-messenger.ts) in real sandboxed Chromiums:
 *
 *   1. a throwaway manager (`bun packages/manager/src/main.ts --data <tmp> --port 18566`) lists both kinds, addable,
 *      with the chat interface (Messenger with its optional "site" field)
 *   2. a Messenger and an Instagram account added through POST /api/accounts (config testOrigin points them at the
 *      fakes)
 *   3. both come online: every layer ok, the hooks named in their details, a live view that answers VNC
 *   4. an app registers, its request is approved through the manager's API, and it gets the snapshot and live facts
 *   5. Messenger: sending through the client's composer (a plain chat and an end-to-end encrypted one); what the client
 *      does by hand (react, edit, unsend) learned, then done the same way; media; history; the survey
 *   6. Instagram: send with a reply, react, edit, typing, mark read, history, media, through its own modules
 *   7. the page's "Try it" runs an op
 *   8. an Instagram page without its send module: online and read-only, said so in the "sending" layer; a Messenger
 *      page without its database: selector_broken, naming the hook
 *   9. nothing secret in the logs or statuses; every process gone when the manager stops
 *
 *   bun scripts/verify-messenger.ts [--keep]
 *
 * Ports: manager 18566, the fakes on any free port. Everything is under a fresh temp directory, deleted after unless
 * --keep. Nothing reaches Meta.
 */
import type { Subprocess } from 'bun';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { ALICE, IG, MS, SELF, startFakeMeta } from '../test/fake-messenger.ts';

const ROOT = resolve(import.meta.dir, '..');
const keep = process.argv.includes('--keep');
const T = mkdtempSync(join(tmpdir(), 'dacc-verify-messenger-'));
const PORT = 18566;
const MGR = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
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
/** What the live view's VNC says first, over its Unix socket. */
const rfb = (path: string) =>
  new Promise<string>((res, rej) => {
    const s = connect({ path }, () => {});
    s.once('data', (b) => (res(b.toString('latin1')), s.destroy()));
    s.once('error', rej);
    setTimeout(() => (s.destroy(), rej(new Error('no banner'))), 5000);
  });
function processesOf(ids: string[]): number[] {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const env = readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if (ids.some((id) => env.includes(`DITHER_ACCOUNT_ID=${id}`))) out.push(Number(d));
    } catch {}
  }
  return out;
}

const msgr = await startFakeMeta({ site: 'messenger' });
const insta = await startFakeMeta({ site: 'instagram' });
const igReadOnly = await startFakeMeta({ site: 'instagram', missing: ['IGDMAPISendTextMessage'] });
const msChanged = await startFakeMeta({ site: 'messenger', missing: ['LSDatabaseSingleton', 'LSDatabaseSingletonLazyWrapper'] });
let mgr = null as Subprocess | null;
let app = null as AccountsClient | null;
const ids: string[] = [];

async function add(kind: string, label: string, testOrigin: string): Promise<string> {
  const r = await post('/api/accounts', { kind, label, config: { testOrigin } });
  const added = (await r.json()) as any;
  check(r.ok && added.id, `POST /api/accounts added ${label}`, added.id ?? added.error);
  ids.push(added.id);
  return added.id;
}
const layersOf = (d: any) => d.layers?.map((l: any) => `${l.name}:${l.state}`);

async function main() {
  // 1. The manager, as the service runs it but on its own data and port.
  const cmd = ['bun', join(ROOT, 'packages/manager/src/main.ts'), '--data', join(T, 'data'), '--port', String(PORT), '--host', '127.0.0.1'];
  mgr = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, DITHER_META_GRACE_MS: '8000' }, stdout: Bun.file(join(T, 'manager.out')), stderr: Bun.file(join(T, 'manager.err')) });
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), 'the manager answers', MGR);
  const st = await get('/api/state');
  const ms = st.kinds.find((k: any) => k.kind === 'messenger');
  const ig = st.kinds.find((k: any) => k.kind === 'instagram');
  check(ms?.add && ms.interfaces.includes('chat') && ms.add.fields?.[0]?.key === 'site', 'the messenger kind is listed, addable, with chat and its site field', ms?.add?.fields);
  check(ig?.add && ig.interfaces.includes('chat'), 'the instagram kind is listed, addable, with chat', ig?.add?.blurb);
  if (!ms || !ig) throw new Error('the kinds are not listed (are the manifests still manifest.wip.ts?)');

  // 2-3. Added as the page does; online.
  const m = await add('messenger', 'Messenger (verify)', msgr.url);
  const i = await add('instagram', 'Instagram (verify)', insta.url);
  const sockets = new Set<string>();
  for (const [id, name] of [
    [m, 'Messenger'],
    [i, 'Instagram'],
  ]) {
    const online = await until(async () => {
      const d = await get(`/api/accounts/${id}`);
      return d.status?.status === 'online' && d.layers?.every((l: any) => l.state === 'ok');
    }, 90_000, `${name} online`);
    const d = await get(`/api/accounts/${id}`);
    check(online, `${name}: online, every layer ok`, layersOf(d));
    const det = d.status?.details ?? {};
    check(det.hooksFound && Object.keys(det).some((k) => k.startsWith('hook.')), `${name}: the hooks it found, by name, in its details`, { found: det.hooksFound, backend: det.backend });
    const lv = d.status?.liveView;
    check(lv?.vncSocket && (await rfb(lv.vncSocket)).startsWith('RFB '), `${name}: the live view answers VNC on its socket`, lv?.vncSocket);
    if (lv) sockets.add(lv.vncSocket);
  }
  check(sockets.size === 2, 'started together, each has a display and live view of its own', [...sockets]);

  // 4. An app, approved through the manager's API.
  const reg = await register(MGR, { name: 'verify-messenger', describe: 'scripts/verify-messenger.ts', requests: [{ interface: 'chat', level: 'manage', kinds: ['messenger', 'instagram'], reason: 'verify' }] });
  check((await post(`/api/requests/${reg.requests[0].id}/approve`, {})).ok, 'its request approved');
  const events: Record<string, any[]> = {};
  app = new AccountsClient({ url: MGR, app: reg.app, token: reg.token, onEvents: (a, evs) => (events[a] ??= []).push(...evs) });
  await until(() => app!.connected && app!.accounts.some((a) => a.id === m) && app!.accounts.some((a) => a.id === i), 10_000, 'the app sees both');
  const call = (acc: string, op: string, input: any) => app!.call(chat, acc, op as any, input) as Promise<any>;
  const msg = (acc: string, id: string) => (events[acc] ?? []).filter((e) => e.t === 'message' && e.message.nativeId === id).at(-1);
  // A grant made after the accounts came online: the app asks them to say it all again.
  await call(m, 'action', { action: 'resync' });
  await call(i, 'action', { action: 'resync' });
  check(await until(() => msg(m, 'mid.$e1') && msg(i, 'mid.$ig2'), 15_000, 'the snapshots'), 'the snapshots as message facts (an end-to-end encrypted chat read in the page)');

  // 5. Messenger.
  const live = msgr.fake.deliver(MS.direct, 'live verify');
  check(await until(() => msg(m, live)?.live === true, 15_000, 'a live message'), 'Messenger: a live message');
  const s1 = await call(m, 'send', { conversation: MS.direct, body: 'verify send' });
  check(/^mid\.\$srv/.test(s1.nativeId) && msgr.fake.calls.some((c) => c.label === '46'), "Messenger: send through the composer, as the client's own task", s1);
  const s2 = await call(m, 'send', { conversation: MS.e2ee, body: 'verify e2ee' });
  check(/^mid\.\$srv/.test(s2.nativeId) && msgr.fake.calls.some((c) => c.route === 'backend/sendTextMessage'), "Messenger: send to an end-to-end encrypted chat, through the client's worker", s2);
  msgr.fake.userAction({ type: 'react', thread: MS.direct, message: 'mid.$a1', emoji: '😮' });
  msgr.fake.userAction({ type: 'edit', thread: MS.direct, message: 'mid.$a1', text: 'by hand' });
  msgr.fake.userAction({ type: 'unsend', thread: MS.group, message: 'mid.$g1' });
  check(await until(async () => (await get(`/api/accounts/${m}`)).status?.details?.learned === '29 33 46 742', 20_000, 'learned'), 'Messenger: the client’s own tasks learned (names and constants only)');
  await call(m, 'react', { conversation: MS.direct, message: 'mid.$a3', key: '🎉' });
  await call(m, 'edit', { conversation: MS.direct, message: s1.nativeId, body: 'verify send, edited' });
  await call(m, 'redact', { conversation: MS.direct, message: s1.nativeId });
  check(await until(() => (events[m] ?? []).some((e) => e.t === 'delete' && e.nativeId === s1.nativeId), 15_000, 'the unsend'), 'Messenger: react, edit and unsend, the same way the client did them');
  const pic = msg(m, 'mid.$a3').message.attachments[0];
  const media = await call(m, 'fetchMedia', { url: pic.url });
  check(media.mime === 'image/png', 'Messenger: media through the page', media.mime);
  const h = await call(m, 'history', { conversation: MS.direct, limit: 20 });
  check(h.count > 0 && h.done === true, 'Messenger: history from what the client holds', h);
  const survey = await call(m, 'action', { action: 'survey' });
  check(survey.backend === 'ls' && survey.lists?.LS?.length > 0 && !JSON.stringify(survey).includes('verify send'), 'Messenger: the survey (module names, shapes, counts; no text)', { LS: survey.counts?.LS, trace: survey.trace?.length });

  // 6. Instagram.
  const is = await call(i, 'send', { conversation: IG.direct, body: 'verify ig', replyTo: 'mid.$ig1' });
  check(/^mid\.\$igsrv/.test(is.nativeId), 'Instagram: send with a reply (IGDMAPISendTextMessage)', is);
  await call(i, 'react', { conversation: IG.direct, message: 'mid.$ig1', key: '❤️' });
  await call(i, 'edit', { conversation: IG.direct, message: is.nativeId, body: 'verify ig, edited' });
  await call(i, 'typing', { conversation: IG.direct });
  await call(i, 'markRead', { conversation: IG.direct, upTo: 'mid.$ig3' });
  check(insta.fake.reads.at(-1)?.message === 'mid.$ig3' && insta.fake.typingOut.length === 1, 'Instagram: react, edit, typing and mark read, through its own modules', insta.fake.calls.map((c) => c.name ?? c.path));
  const ih = await call(i, 'history', { conversation: IG.direct, beforeTs: msg(i, 'mid.$ig1').message.ts + 1, limit: 3 });
  check(ih.count === 3, 'Instagram: history through its own query', ih);
  const im = await call(i, 'fetchMedia', { url: msg(i, 'mid.$ig3').message.attachments[0].url });
  check(im.mime === 'image/png', 'Instagram: media', im.mime);

  // 7. The page's Try it.
  const tryIt = (await (await post(`/api/accounts/${i}/call`, { op: 'reactionContext', input: { conversation: IG.direct } })).json()) as any;
  check(tryIt.ok && tryIt.result.canReact === true, "the page's Try it runs an op", tryIt.error);

  // 8. Partial states.
  const ro = await add('instagram', 'Instagram (verify, read-only)', igReadOnly.url);
  const roOk = await until(async () => {
    const d = await get(`/api/accounts/${ro}`);
    return d.status?.status === 'online' && d.layers?.find((l: any) => l.name === 'sending')?.state === 'failed';
  }, 90_000, 'read-only');
  const rd = await get(`/api/accounts/${ro}`);
  check(roOk, 'Instagram without its send module: online, and the sending layer says read-only', rd.layers?.find((l: any) => l.name === 'sending')?.note);
  const refused = await call(ro, 'send', { conversation: IG.direct, body: 'x' }).then(
    () => null,
    (e) => String(e.message ?? e),
  );
  check(refused && /not available/.test(refused) && igReadOnly.fake.calls.length === 0, 'and a send is refused before any request', refused);
  const ch = await add('messenger', 'Messenger (verify, changed app)', msChanged.url);
  const chOk = await until(async () => (await get(`/api/accounts/${ch}`)).status?.attention?.kind === 'selector_broken', 90_000, 'selector_broken');
  const cd = await get(`/api/accounts/${ch}`);
  check(chOk && cd.status?.details?.['hook.ls.db'] === 'missing', 'Messenger without its database: selector_broken, naming the hook', cd.status?.attention?.message);

  // 9. Nothing secret said, nothing left running.
  const logs = ids.map((id) => {
    try {
      return readFileSync(join(T, 'data', 'accounts', id, 'adapter.log'), 'utf8');
    } catch {
      return '';
    }
  }).join('\n');
  const statuses = JSON.stringify(await Promise.all(ids.map((id) => get(`/api/accounts/${id}`))));
  const secrets = ['live verify', 'verify send', 'verify e2ee', 'verify ig', 'hello from alice', 'secret plans', ALICE.name, 'Pelican Club', 'Heron Club', 'secret=query', 'secret snippet'];
  const leaked = secrets.filter((s) => logs.includes(s) || statuses.includes(s));
  check(!leaked.length, 'nothing secret in the logs or statuses', leaked);
  check(SELF.fb && logs.includes('hooks:'), 'the logs name the hooks found');
}

try {
  await main();
} catch (e) {
  check(false, 'the run', String((e as Error)?.stack ?? e));
} finally {
  app?.close();
  if (mgr) {
    mgr.kill('SIGTERM');
    await mgr.exited;
  }
  check(await until(() => processesOf(ids).length === 0, 15_000, 'every process gone'), 'every extractor, Chromium, Xvfb and x11vnc gone after the manager stops');
  for (const f of [msgr, insta, igReadOnly, msChanged]) f.stop();
  if (!keep) rmSync(T, { recursive: true, force: true });
  else console.log(`kept ${T}`);
  console.log(failures ? `\n${failures} FAILED` : '\nall ok');
  process.exit(failures ? 1 : 0);
}
