/**
 * The x kind end to end, as the page and an app (dither-chat) use it, against the fake x.com (test/fake-x.ts) in a
 * real sandboxed Chromium:
 *
 *   1. a throwaway manager (`bun packages/manager/src/main.ts --data <tmp> --port 18575`) lists the kind, addable
 *   2. an account added through POST /api/accounts (config testOrigin points it at the fake)
 *   3. it comes online: every layer ok, who it is, a found/missing line per hook, a live view that answers VNC
 *   4. an app with a chat grant sees the conversations (legacy DM, XChat group, XChat one-to-one) and their messages,
 *      read quietly (nothing marked read on X), then a live one
 *   5. the notifications: the feed conversation, a message per person (likes, a reply, a mention, a quote, a repost,
 *      a follow, X's own), the people's profiles announced, read through the page's own endpoints with the Notifications
 *      chunk loaded as the tab loads it, nothing marked seen on X, then a new like live; a profile with its posts
 *   6. send, reply, edit, react, unsend, mark read, history, media both ways: each through the page's own events,
 *      seen as the fake's API calls
 *   6b. past the conversation: a message request listed, read quietly and accepted; a one-to-one opened through New
 *      message's search; a group made, named, added to and described; its About; typing; a forward with a note; and
 *      X's refusals (someone it lets nobody message, a non-admin renaming an admins-only group)
 *   7. the page's "Try it" runs diagnose: shapes only, kept in diagnostics.json
 *   8. a second account whose page asks for the XChat PIN: attention with the live view, online once entered
 *   9. a third whose composer class cannot be found: read-only, it says so, and still reads
 *  10. nothing personal or secret in the logs or status; every process gone when the manager stops
 *
 *   bun scripts/verify-x.ts [--keep]
 *
 * Ports: manager 18575, the fakes on any free port. Everything is under a fresh temp directory, deleted after unless
 * --keep. Nothing reaches X.
 */
import type { Subprocess } from 'bun';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { CLI_HEADER, CLI_TOKEN_FILE } from '../packages/manager/src/auth.ts';
import { ALICE, BOB, CAROL, DAVE, DIRECT, ERIN, GROUP, LEGACY, PIXEL, REQUEST, SELF, startFakeX } from '../test/fake-x.ts';
import { CARA, DEV, EMI, FINN } from '../test/fake-x-feed.ts';

const ROOT = resolve(import.meta.dir, '..');
const keep = process.argv.includes('--keep');
const T = mkdtempSync(join(tmpdir(), 'dacc-verify-x-'));
const PORT = 18575;
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
/** The manager's API as its CLI reaches it from this machine: the token it writes into its data directory. */
const cli = (): Record<string, string> => {
  try {
    return { [CLI_HEADER]: readFileSync(join(T, 'data', CLI_TOKEN_FILE), 'utf8').trim() };
  } catch {
    return {};
  }
};
const get = async (path: string) => (await fetch(MGR + path, { headers: cli() })).json() as Promise<any>;
const post = (path: string, body: unknown) => fetch(MGR + path, { method: 'POST', headers: { 'content-type': 'application/json', ...cli() }, body: JSON.stringify(body) });
/** What the live view's VNC says first, over its Unix socket. */
const rfb = (path: string) =>
  new Promise<string>((res, rej) => {
    const s = connect({ path }, () => {});
    s.once('data', (b) => (res(b.toString('latin1')), s.destroy()));
    s.once('error', rej);
    setTimeout(() => (s.destroy(), rej(new Error('no banner'))), 5000);
  });
function processesOf(id: string): number[] {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(`DITHER_ACCOUNT_ID=${id}`)) out.push(Number(d));
    } catch {}
  }
  return out;
}

const fake = await startFakeX({});
const pinned = await startFakeX({ pin: true });
const readOnly = await startFakeX({ hideComposer: true });
let mgr = null as Subprocess | null;
let app = null as AccountsClient | null;
const ids: string[] = [];
const events: Record<string, { t: string; [k: string]: any }[]> = {};
const evs = (a: string) => events[a] ?? [];
const msgOf = (a: string, id: string) => evs(a).filter((e) => e.t === 'message' && e.message.nativeId === id).at(-1);

async function add(label: string, config: Record<string, unknown>): Promise<string> {
  const r = await post('/api/accounts', { kind: 'x', label, config });
  const added = (await r.json()) as any;
  check(r.ok && added.id, `POST /api/accounts added "${label}"`, added.id ?? added.error);
  ids.push(added.id);
  return added.id;
}

async function main() {
  // 1. The manager, as the service runs it but on its own data and port.
  const cmd = ['bun', join(ROOT, 'packages/manager/src/main.ts'), '--data', join(T, 'data'), '--port', String(PORT), '--host', '127.0.0.1'];
  mgr = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env }, stdout: Bun.file(join(T, 'manager.out')), stderr: Bun.file(join(T, 'manager.err')) });
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), 'the manager answers', MGR);
  const st = await get('/api/state');
  const kind = st.kinds.find((k: any) => k.kind === 'x');
  check(kind?.add && kind.interfaces.includes('chat'), 'the x kind is listed, addable, with chat', kind?.add?.blurb);

  // dither-chat's grant (chat on every account), approved through the manager's API, before there is an account.
  const reg = await register(MGR, { name: 'verify-x', describe: 'scripts/verify-x.ts', requests: [{ interface: 'chat', level: 'manage', accounts: '*', reason: 'verify' }] });
  check((await post(`/api/requests/${reg.requests[0].id}/approve`, {})).ok, 'its request approved');
  app = new AccountsClient({ url: MGR, app: reg.app, token: reg.token, onEvents: (a, list) => (events[a] ??= []).push(...list) });
  await until(() => app!.connected, 10_000, 'the app connected');

  // 2–3. Added as the page does, and online.
  // The feed's first read 1.5 s after online, then every 4 s (a real account: 30-60 s, then 4-8 minutes).
  const id = await add('X (verify)', { testOrigin: fake.url, feedFirstMs: 1500, feedEveryMs: 4000 });
  const online = await until(async () => {
    const d = await get(`/api/accounts/${id}`);
    return d.status?.status === 'online' && d.layers?.every((l: any) => l.state === 'ok');
  }, 90_000, 'online');
  const d = await get(`/api/accounts/${id}`);
  check(online, 'online, every layer ok', d.layers?.map((l: any) => `${l.name}:${l.state}`));
  check(d.status?.self?.nativeId === SELF.id && d.status?.self?.handle === SELF.screenName, 'who it is signed in as', d.status?.self?.nativeId);
  const hooks = Object.entries(d.status?.details ?? {}).filter(([k]) => k.startsWith('hook.'));
  check(hooks.length === 28 && hooks.every(([k, v]) => typeof v === 'string' && (v.startsWith('found') || (v === 'pending' && ['hook.attach', 'hook.quietReads', 'hook.notifications'].includes(k)))), 'the self-test: every hook found, each saying how (two wait for an open conversation, one for the first feed read)', Object.fromEntries(hooks));
  const lv = d.status?.liveView;
  check(lv?.vncSocket && (await rfb(lv.vncSocket)).startsWith('RFB '), 'the live view answers VNC on its socket', lv);

  // 4. What the app hears.
  await until(() => app!.accounts.some((a) => a.id === id), 10_000, 'the app sees the account');
  const call = (op: string, input: any, account = id) => app!.call(chat, account, op as any, input) as Promise<any>;
  const convs = await until(() => [LEGACY, GROUP, DIRECT].every((c) => evs(id).some((e) => e.t === 'conversation' && e.conversation.nativeId === c)), 30_000, 'the conversations');
  check(convs, 'the conversations: a legacy DM, an XChat group, an XChat one-to-one', evs(id).filter((e) => e.t === 'conversation').map((e) => `${e.conversation.nativeId}:${e.conversation.shape}:${e.conversation.encrypted}`));
  const read = await until(() => msgOf(id, 'm30') && msgOf(id, 'm33') && msgOf(id, 'm35'), 90_000, 'their messages');
  check(read && !fake.calls.some((c) => c.op === 'read'), 'their messages read quietly: nothing marked read on X', { messages: evs(id).filter((e) => e.t === 'message').length });
  const after = Object.entries((await get(`/api/accounts/${id}`)).status?.details ?? {}).filter(([k]) => k.startsWith('hook.'));
  check(after.every(([, v]) => String(v).startsWith('found')), 'with a conversation opened and the feed read, all twenty-eight found', Object.fromEntries(after.filter(([k]) => ['hook.attach', 'hook.quietReads', 'hook.notifications'].includes(k))));
  // 5. The notifications.
  const feedMsgs = () => evs(id).filter((e) => e.t === 'message' && String(e.message.conversation).startsWith('feed:'));
  const first = fake.feed.posts.first.rest_id;
  check(await until(() => feedMsgs().length >= 10, 60_000, 'the feed'), 'the feed: ten messages, one per person and thing done, as backfill', feedMsgs().map((e) => `${e.message.nativeId}:${e.message.kind}:${e.live}`));
  check(evs(id).some((e) => e.t === 'conversation' && String(e.conversation.nativeId).startsWith('feed:') && e.conversation.variant === 'feed' && e.conversation.shape === 'channel'), 'the feed conversation: variant feed, a channel');
  const kinds = new Set(feedMsgs().map((e) => String(e.message.nativeId).split(':')[0]));
  check(['like', 'reply', 'mention', 'quote', 'repost', 'follow', 'other'].every((k) => kinds.has(k)), 'likes, a reply, a mention, a quote, a repost, a follow and X\'s own', [...kinds]);
  check([CARA, DEV, EMI, FINN].every((p) => evs(id).filter((e) => e.t === 'personAbout' && e.who === p.id).length === 1), "each person's profile announced once", evs(id).filter((e) => e.t === 'personAbout').length);
  check(fake.calls.filter((c) => c.op === 'chunk' && c.name === 'bundle.Notifications').length === 1 && !fake.calls.some((c) => c.op === 'notifications.seen'), "read through the page's own endpoints, the Notifications chunk loaded once, nothing marked seen on X");
  fake.feed.like(FINN);
  check(await until(() => feedMsgs().some((e) => e.message.nativeId === `like:${first}:${FINN.id}` && e.live === true), 30_000, 'the new like'), 'a new like arrives live on the next look');
  const prof = await call('profile', { who: CARA.id });
  check(prof?.handle === CARA.handle && prof.posts?.length === 4 && prof.posts[0].pinned && prof.posts[1].repostOf && prof.posts[2].quoteOf && prof.posts[3].media?.[0]?.url?.startsWith('https://pbs.twimg.com/'), 'a profile: who they are and their posts, pinned first, a repost, a quote, a picture', prof?.posts?.map((p: any) => p.id));

  const live = fake.deliver(GROUP, ALICE.id, 'verify: a new one');
  check(await until(() => msgOf(id, live.id)?.live === true, 60_000, 'the live message'), 'a new message arrives live, with its sender', msgOf(id, live.id)?.message?.author);
  const before = evs(id).filter((e) => e.t === 'conversation').length;
  await call('action', { action: 'resync' });
  check(await until(() => evs(id).filter((e) => e.t === 'conversation').length >= before + 3, 20_000, 'the conversations again'), 'resync announces the conversations again');

  // 6. Writes, each through the page's own events.
  const sent = await call('send', { conversation: DIRECT, body: 'verify **send**' });
  check(fake.calls.at(-1)?.op === 'send' && fake.calls.at(-1)?.text === 'verify send' && sent.nativeId, 'send: the composer typed and sent, Markdown made plain', fake.calls.at(-1));
  await call('send', { conversation: LEGACY, body: 'verify reply', replyTo: 'm29' });
  check(fake.calls.at(-1)?.replyToSeq === 29, 'reply: the composer replied to the message', fake.calls.at(-1));
  await call('edit', { conversation: DIRECT, message: sent.nativeId, body: 'verify edited' });
  check(fake.calls.at(-1)?.op === 'edit' && fake.calls.at(-1)?.text === 'verify edited', 'edit', fake.calls.at(-1));
  const hey = fake.msgs.find((m) => m.conv === DIRECT && m.from === BOB.id)!;
  await call('react', { conversation: DIRECT, message: hey.id, key: '🎉' });
  check(fake.calls.at(-1)?.op === 'react' && fake.calls.at(-1)?.emoji === '🎉', 'react', fake.calls.at(-1));
  await call('redact', { conversation: DIRECT, message: sent.nativeId });
  check(fake.calls.at(-1)?.op === 'unsend', 'unsend (delete for everyone)', fake.calls.at(-1));
  await call('markRead', { conversation: GROUP, upTo: live.id });
  check(fake.calls.at(-1)?.op === 'read' && fake.calls.at(-1)?.conv === GROUP, 'mark read: the one read mark sent', fake.calls.filter((c) => c.op === 'read'));
  const h = await call('history', { conversation: LEGACY, limit: 40 });
  check(h.done && msgOf(id, 'm1')?.live === false, 'history scrolled to the beginning, as backfill', h);
  const media = await call('fetchMedia', { url: `x-media://${encodeURIComponent(LEGACY)}/m28/0` });
  check(media.mime === 'image/png' && Buffer.from(media.base64, 'base64').equals(Buffer.from(PIXEL)), 'a picture fetched through the page');
  const path = join(T, 'out.png');
  writeFileSync(path, PIXEL);
  await call('send', { conversation: DIRECT, body: '', attachments: [{ path, name: 'out.png', mime: 'image/png', size: PIXEL.length, kind: 'image' }] });
  check(fake.calls.some((c) => c.op === 'upload') && (fake.calls.at(-1)?.media?.length ?? 0) === 1, "a picture sent through the composer's file input", fake.calls.at(-1));

  // 6b. Past the conversation.
  const hello = await until(() => evs(id).some((e) => e.t === 'hello' && ['requests', 'openDirect', 'createGroup', 'addMembers', 'about', 'configure', 'typing', 'forward'].every((c) => e.capabilities.includes(c))), 30_000, 'the capabilities');
  check(hello, 'the hub is told: requests, openDirect, createGroup, addMembers, about, configure, typing, forward');
  const reqs = await until(() => evs(id).some((e) => e.t === 'requests' && e.requests.some((r: any) => r.nativeId === REQUEST && r.kind === 'message' && r.from === CAROL.id)), 60_000, 'the requests');
  check(reqs, "a message request listed from X's Requests page, from whom, with Accept, Delete and Block", evs(id).filter((e) => e.t === 'requests').at(-1)?.requests?.map((r: any) => `${r.kind}:${r.answers}`));
  const hers = fake.msgs.filter((m) => m.conv === REQUEST);
  const quietly = await until(() => hers.every((m) => msgOf(id, m.id)), 60_000, "the request's messages");
  check(quietly && fake.calls.filter((c) => c.op === 'read').length === 1, "its messages read quietly: X has no read of it (the one read is mark read's)", fake.calls.filter((c) => c.op === 'read').map((c) => c.conv));
  const acc1 = await call('answer', { request: REQUEST, answer: 'accept' });
  check(acc1.conversation === REQUEST && fake.calls.some((c) => c.op === 'acceptRequest' && c.conv === REQUEST), "accepted with the Requests page's Accept", acc1);
  const od = await call('openDirect', { peer: DAVE.screenName });
  check(od.conversation === `${SELF.id}:${DAVE.id}` && od.startsAtFirstSend && fake.calls.some((c) => c.op === 'search'), "a new one-to-one through New message's search, made at its first message", od);
  const refused = await call('openDirect', { peer: ERIN.screenName }).catch((e: any) => e);
  check(/does not let you message/.test(String(refused?.message)), "someone X lets nobody message: refused with X's reason", refused?.message);
  const grp = await call('createGroup', { name: 'Verify group', people: [ALICE.id, CAROL.id] });
  check(/^g\d+$/.test(String(grp.conversation)) && fake.calls.some((c) => c.op === 'createGroup') && fake.calls.some((c) => c.op === 'editGroup' && c.title === 'Verify group'), 'a group made with Create a group, and named on Edit Group', grp);
  const gconv = String(grp.conversation);
  const add2 = await call('addMembers', { target: { kind: 'conversation', nativeId: gconv }, people: [BOB.id] });
  check(add2.added?.includes(BOB.id) && fake.calls.some((c) => c.op === 'addMembers' && c.conv === gconv), 'Bob added with Add people', add2.added);
  const cfg = await call('configure', { target: { kind: 'conversation', nativeId: gconv }, change: { key: 'topic', value: 'verify description' } });
  check(cfg.fields?.topic?.value === 'verify description', 'a description set on Edit Group, the About as it now stands', cfg.fields?.topic);
  fake.convs.get(GROUP)!.adminOnlyEditGroupInfo = true;
  fake.deliver(GROUP, ALICE.id, 'verify: admins only now');
  await until(async () => (await call('about', { target: { kind: 'conversation', nativeId: GROUP } })).fields?.name?.canEdit === false, 30_000, 'admins only');
  const notAdmin = await call('configure', { target: { kind: 'conversation', nativeId: GROUP }, change: { key: 'name', value: 'x' } }).catch((e: any) => e);
  check(/Only admins/.test(String(notAdmin?.message)), "renaming someone else's admins-only group: refused before X is asked", notAdmin?.message);
  const typedBefore = fake.calls.filter((c) => c.op === 'typing').length;
  await Bun.sleep(3500);
  await call('typing', { conversation: DIRECT });
  check(await until(() => fake.calls.filter((c) => c.op === 'typing').length > typedBefore, 30_000, 'typing'), "typing, as the composer reports it");
  await call('forward', { conversation: GROUP, source: { conversation: LEGACY, message: 'm29' }, note: 'verify note' });
  check(fake.calls.some((c) => c.op === 'forward' && c.to?.[0] === GROUP && c.note === 'verify note'), "a forward with a note, through the message's Forward action and X's dialog", fake.calls.filter((c) => c.op === 'forward').at(-1));

  // 7. The page's Try it: diagnose.
  const page = (await (await post(`/api/accounts/${id}/call`, { op: 'action', input: { action: 'diagnose' } })).json()) as any;
  const diag = readFileSync(join(T, 'data', 'accounts', id, 'diagnostics.json'), 'utf8');
  check(page.ok && page.result?.page?.graph?.class === 'WebDmObjectGraph', "the page's Try it runs diagnose", page.error ?? page.result?.page?.graph);
  check(!['verify:', 'legacy line', ALICE.screenName, ALICE.displayName, 'fake-session', CARA.handle, CARA.name, 'tomatoes'].some((s) => diag.includes(s)), 'diagnostics.json holds shapes only', `${diag.length} bytes`);
  check(page.result?.page?.feed?.responses?.notifications?.instructions?.array > 0, "diagnostics include the shapes of X's notifications answer");

  // 8. The XChat PIN.
  const id2 = await add('X (PIN)', { testOrigin: pinned.url });
  const asked = await until(async () => (await get(`/api/accounts/${id2}`)).status?.attention?.kind === 'verify', 60_000, 'the PIN attention');
  const d2 = await get(`/api/accounts/${id2}`);
  check(asked && d2.status.attention.liveView && /XChat PIN/.test(d2.status.attention.message), 'the PIN is asked for with the live view', d2.status?.attention);
  pinned.unlock();
  check(await until(async () => (await get(`/api/accounts/${id2}`)).status?.status === 'online', 60_000, 'online after the PIN'), 'online once the PIN is entered');

  // 9. Read-only.
  const id3 = await add('X (read-only)', { testOrigin: readOnly.url, hookGraceMs: 3000 });
  const ro = await until(async () => (await get(`/api/accounts/${id3}`)).layers?.find((l: any) => l.name === 'sending')?.state === 'failed', 60_000, 'read-only');
  const d3 = await get(`/api/accounts/${id3}`);
  check(ro && d3.status?.details?.['hook.send'] === 'missing', 'no composer class: the sending layer fails, read-only', d3.layers?.find((l: any) => l.name === 'sending'));
  await until(() => app!.accounts.some((a) => a.id === id3), 10_000, 'the app sees it');
  check(await until(() => evs(id3).some((e) => e.t === 'message'), 60_000, 'messages while read-only'), 'and it still reads');
  const no = await call('send', { conversation: DIRECT, body: 'x' }, id3).catch((e: any) => e);
  check(/X changed/.test(String(no?.message)) && !readOnly.calls.some((c) => c.op === 'send'), 'send refuses, saying why, and sends nothing', no?.message);

  // 10. What it said.
  const said = ids.map((x) => readFileSync(join(T, 'data', 'accounts', x, 'adapter.log'), 'utf8')).join('\n') + JSON.stringify((await Promise.all(ids.map((x) => get(`/api/accounts/${x}`)))).map((a) => a.status));
  const leaks = ['legacy line', 'saturday', 'verify:', 'verify edited', 'verify reply', ALICE.screenName, ALICE.displayName, BOB.screenName, BOB.displayName, 'fake-session', 'Weekend plans', CARA.name, CARA.handle, DEV.handle, EMI.handle, FINN.handle, 'tomatoes', 'love this', 'liked your post', 'verify note', 'Verify group', 'verify description', 'conference', CAROL.screenName, DAVE.screenName, ERIN.screenName].filter((s) => said.includes(s));
  check(!leaks.length, 'no message, other person or cookie in the logs or status', leaks.length ? `${leaks.length} leaked` : '');
}

try {
  await main();
} catch (e) {
  check(false, 'the run', String((e as Error)?.stack ?? e));
} finally {
  app?.close();
  if (mgr && mgr.exitCode === null) {
    mgr.kill('SIGTERM');
    const k = setTimeout(() => mgr!.kill('SIGKILL'), 15_000);
    await mgr.exited;
    clearTimeout(k);
  }
  if (ids.length) {
    const gone = await until(() => ids.every((x) => processesOf(x).length === 0), 15_000, 'its processes to go');
    check(gone, 'the manager stopped: every process it started for the accounts is gone');
  }
  fake.stop();
  pinned.stop();
  readOnly.stop();
  if (keep) console.log(`kept ${T}`);
  else rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
