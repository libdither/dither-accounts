/**
 * Google Messages (kind gmessages) end to end, with a throwaway manager and the extractor's fake bridge (no Google, no
 * phone):
 *
 *   1. the kind and its add form are on the page's API
 *   2. an account added as the page adds it (POST /api/accounts) shows a QR code to scan, with its layers; New code
 *      (the page's refreshLink) asks for another
 *   3. a scan pairs it: the session lands in its secret.json, it connects, syncs and is online, with self and details
 *   4. an app (packages/client: register, its request approved through the manager's API) gets the facts and runs the
 *      ops: send (text, reply, a file), markRead, react, typing, history, fetchMedia, redact, about, openDirect,
 *      profile, reactionContext; and the events: a message, a reaction, a receipt, typing, read
 *   5. the phone going silent and coming back; another browser taking over and setActive
 *   6. a restart keeps the pairing; unpairing on the phone brings the QR back and drops the session
 *   7. an account added with Google cookies pairs by Google account: an emoji to tap
 *
 *   bun scripts/verify-gmessages.ts [--keep]
 *
 * Everything is fresh under /tmp (manager on 18520) and deleted after unless --keep. It needs the kind's manifest.ts
 * (extractors/gmessages/manifest.ts): the manager only loads finished kinds.
 */
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { readSecretFile } from '@dither-chat/protocol/secret-file';

const ROOT = resolve(import.meta.dir, '..');
const T = mkdtempSync('/tmp/dacc-gmessages-');
const keep = process.argv.includes('--keep');
const PORT = 18520;
const MGR = `http://127.0.0.1:${PORT}`;
const SOCK = join(T, 'gm.sock');

const SESSION = { browser: { sourceID: 'browser-1' }, mobile: { sourceID: 'phone-1' }, tachyon_token: 'dG9rZW4=', tachyon_expiry: '2026-12-01T00:00:00Z', request_crypto: { aes_key: 'a', hmac_key: 'b' }, refresh_key: {} };
const SETTINGS = { sims: [{ number: 1, phone: '+15550000001', formatted: '(555) 000-0001', carrier: 'Example Mobile', participant: '1', rcs: true }], rcsEnabled: true, readReceipts: true, typingIndicators: true, defaultSmsApp: true, version: 'fake' };
const me = { id: '1', number: '+15550000001', isMe: true, visible: true };
const alice = { id: '2', number: '+15550000002', formatted: '(555) 000-0002', fullName: 'Alice Example', firstName: 'Alice', contactId: 'c2', visible: true };
const bob = { id: '3', number: '+15550000003', fullName: 'Bob Example', firstName: 'Bob', visible: true };
const T0 = 1_770_000_000_000;
const DIRECT = { id: '10', type: 'rcs', status: 'active', lastTs: T0, latestId: '100', outgoingId: '1', participants: [me, alice] };
const GROUP = { id: '20', type: 'rcs', group: true, name: 'Family', status: 'active', lastTs: T0, latestId: '200', outgoingId: '1', participants: [me, alice, bob] };
const msg = (o: Record<string, unknown> = {}) => ({ id: '100', conversation: '10', participant: '2', ts: T0, status: 'INCOMING_COMPLETE', state: 'received', kind: 'rcs', text: 'hello', ...o });

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const until = async <V>(f: () => V | Promise<V>, ms: number, what: string): Promise<V | undefined> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch {}
    await Bun.sleep(100);
  }
  console.log(`     (gave up waiting for ${what})`);
  return undefined;
};
const api = async (path: string, body?: unknown) => (await fetch(MGR + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
const account = async (id: string) => (await api('/api/state')).accounts.find((a: any) => a.id === id);
const layer = (st: any, name: string) => st?.layers?.find((l: any) => l.name === name);

// The fake bridge's control socket: what the extractor asked the bridge, and what the "phone" says.
const cmds: any[] = [];
let bridges: any[] = [];
const ctl = Bun.listen<{ buf: string }>({
  unix: SOCK,
  socket: {
    open: (s) => {
      s.data = { buf: '' };
      bridges.push(s);
    },
    data: (s, d) => {
      s.data.buf += d.toString();
      let nl: number;
      while ((nl = s.data.buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(s.data.buf.slice(0, nl));
        s.data.buf = s.data.buf.slice(nl + 1);
        if (m.cmd) cmds.push(m.cmd);
      }
    },
    close: (s) => {
      bridges = bridges.filter((b) => b !== s);
    },
  },
});
const phone = async (m: unknown) => {
  await until(() => bridges.length > 0, 10_000, 'a bridge');
  bridges[bridges.length - 1].write(JSON.stringify(m) + '\n');
  await Bun.sleep(150);
};
const sent = (op: string) => cmds.filter((c) => c.op === op);

const events = new Map<string, { t: string; [k: string]: any }[]>();
const evs = (id: string) => events.get(id) ?? [];
const status = (id: string) => evs(id).filter((e) => e.t === 'status').at(-1);

let mgr: Subprocess | null = null;
let app: AccountsClient | null = null;
try {
  console.log(`     workdir ${T}`);
  check(existsSync(join(ROOT, 'extractors/gmessages/manifest.ts')), 'the kind has its manifest.ts');
  mkdirSync(join(T, 'mgr'));
  mgr = Bun.spawn(['bun', 'packages/manager/src/main.ts', '--data', join(T, 'mgr'), '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, GMESSAGES_BRIDGE_BIN: `${process.execPath} ${join(ROOT, 'extractors/gmessages/test/fake-bridge.ts')}`, FAKE_GM_SOCK: SOCK, FAKE_GM_QUIET: '1' },
    stdout: Bun.file(join(T, 'manager.log')),
    stderr: Bun.file(join(T, 'manager.err')),
  });
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), 'a fresh manager on 18520');

  // 1. The kind.
  const kind = (await api('/api/state')).kinds.find((k: any) => k.kind === 'gmessages');
  check(kind?.name === 'Google Messages' && kind?.interfaces?.join() === 'chat', 'the kind gmessages offers chat', kind && { name: kind.name, interfaces: kind.interfaces });
  check(!!kind?.add?.blurb && !!kind?.add?.next && kind?.add?.fields?.[0]?.key === 'cookies' && kind.add.fields[0].secret, 'it has an add form: blurb, next, an optional secret cookies field');

  // An app reading and writing chat, approved through the manager's API.
  const reg = await register(MGR, { name: 'verify-gmessages', requests: [{ interface: 'chat', level: 'write', accounts: '*' }] });
  for (const r of reg.requests) await fetch(`${MGR}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  app = new AccountsClient({ url: MGR, app: reg.app, token: reg.token, onEvents: (a, list) => (events.get(a) ?? events.set(a, []).get(a)!).push(...list) });
  check(await until(() => app!.connected, 5000, 'the app'), 'an app registered, its request approved, connected');

  // 2. Added as the page adds it: a QR code.
  const id = (await api('/api/accounts', { kind: 'gmessages', label: 'Verify phone' })).id as string;
  check(!!id, 'POST /api/accounts made the account', id);
  const qr = await until(() => status(id)?.attention?.qr, 30_000, 'the QR code');
  check(String(qr).startsWith('https://support.google.com/messages/'), 'its status carries the pairing QR code (the page draws it)', qr);
  check(status(id)?.attention?.qrRefreshAt > Date.now(), 'with when it is replaced');
  check(evs(id).find((e) => e.t === 'hello')?.network === 'gmessages', 'hello says gmessages, with its capabilities', evs(id).find((e) => e.t === 'hello')?.capabilities);
  const pageAcc = await account(id);
  check(JSON.stringify(pageAcc?.layers?.map((l: any) => [l.name, l.state])) === JSON.stringify([['bridge', 'ok'], ['phone', 'waiting'], ['paired', 'waiting'], ['connected', 'waiting']]), 'the page has its layers: bridge, phone, paired, connected', pageAcc?.layers);
  const call = async (op: string, input: Record<string, unknown>) => api(`/api/accounts/${id}/call`, { op, input });
  const nc = await call('action', { action: 'refreshLink' });
  check(nc.ok && (await until(() => sent('startQr').length === 2, 5000, 'a second QR')), "the page's New code asks for another", nc);

  // 3. A scan pairs it.
  await phone({ result: { op: 'conversations', value: { conversations: [DIRECT, GROUP] } } });
  await phone({ result: { op: 'messages', value: { messages: [msg()], total: 1 } } });
  await phone({ emit: { t: 'paired', via: 'qr', phone: 'phone-1', session: SESSION } });
  await phone({ emit: { t: 'connected', google: false } });
  await phone({ emit: { t: 'settings', settings: SETTINGS } });
  await phone({ emit: { t: 'alert', alert: 'browser_active' } });
  check(await until(() => status(id)?.status === 'online', 10_000, 'online'), 'scanned: online');
  const dir = join(T, 'mgr', 'accounts', id);
  const secret = readSecretFile<any>(join(dir, 'secret.json'));
  check(JSON.stringify(secret.session) === JSON.stringify(SESSION), 'the session is in its secret.json');
  const st = status(id)!;
  check(st.self?.handle === '+15550000001' && st.self?.isSelf, 'status says who it is (self)', st.self);
  check(st.details?.pairedVia === 'qr' && st.details?.phoneNumber === '+15550000001' && st.details?.carrier === 'Example Mobile', 'and its details', st.details);
  check(st.layers.every((l: any) => l.state === 'ok'), 'every layer ok', st.layers);
  check((await account(id))?.self?.detail === '+15550000001', 'the page shows it signed in as the phone number', (await account(id))?.self);

  // 4. Facts and ops, as the app.
  await until(() => evs(id).some((e) => e.t === 'message' && e.message.body === 'hello'), 10_000, 'the synced message');
  const convs = evs(id).filter((e) => e.t === 'conversation').map((e) => e.conversation);
  const direct = convs.find((c: any) => c.shape === 'direct');
  const group = convs.find((c: any) => c.shape === 'group');
  check(direct && group?.name === 'Family' && group.participants.length === 3, 'conversations: a direct one and a named group with its members', convs);
  const people = evs(id).filter((e) => e.t === 'identity').map((e) => e.identity);
  check(people.some((p: any) => p.nativeId === '+15550000002' && p.displayName === 'Alice Example' && p.contact), 'people are identities by number and name', people);
  const synced = evs(id).find((e) => e.t === 'message' && e.message.body === 'hello')!;
  check(synced.live === false, 'the first sync is history, not news');
  await phone({ emit: { t: 'message', message: msg({ id: '101', ts: T0 + 1000, text: 'are you there?', media: [{ part: 'p1', mediaId: 'm1', key: 'a2V5', name: 'p.jpg', mime: 'image/jpeg', size: 16 }] }) } });
  const live = await until(() => evs(id).find((e) => e.t === 'message' && e.message.body === 'are you there?'), 5000, 'a live message');
  check(live?.live === true && live.message.attachments?.[0]?.url?.startsWith('gm-media:'), 'a live message arrives as news, with its picture', live?.message);
  const m101 = live!.message.nativeId as string;

  const reply = await app.call(chat, id, 'send', { conversation: direct.nativeId, body: '**yes**', replyTo: m101 });
  check(!!reply?.nativeId && sent('send').at(-1)?.text === 'yes' && sent('send').at(-1)?.replyTo === '101', 'send: a reply, Markdown to plain text, the id from the phone’s copy', { reply, cmd: sent('send').at(-1) });
  const file = join(T, 'pic.png');
  writeFileSync(file, 'png');
  const withFile = await app.call(chat, id, 'send', { conversation: direct.nativeId, body: 'look', attachments: [{ path: file, name: 'pic.png', mime: 'image/png', size: 3, kind: 'image' }] });
  check(!!withFile?.nativeId && sent('send').at(-2)?.media?.name === 'pic.png' && sent('send').at(-1)?.text === 'look', 'send: a file, then its text (RCS takes no caption)', sent('send').slice(-2));
  const media = await app.call(chat, id, 'fetchMedia', { url: live!.message.attachments[0].url });
  check(Buffer.from(media.base64, 'base64').toString() === 'fake media bytes' && media.mime === 'image/jpeg', 'fetchMedia downloads the picture', media.mime);
  await app.call(chat, id, 'markRead', { conversation: direct.nativeId, upTo: m101 });
  check(sent('markRead').at(-1)?.message === '101' && (await until(() => evs(id).some((e) => e.t === 'read' && e.conversation === direct.nativeId && e.unread === 0), 5000, 'read')), 'markRead tells the phone, and read state comes back');
  await app.call(chat, id, 'react', { conversation: direct.nativeId, message: m101, key: '❤️' });
  check(sent('react').at(-1)?.emoji === '❤️' && (await until(() => evs(id).some((e) => e.t === 'reaction' && e.key === '❤️'), 5000, 'the reaction')), 'react: the phone gets it and the app hears it');
  const ctx = await app.call(chat, id, 'reactionContext', { conversation: direct.nativeId });
  check(ctx.canReact && /One reaction/.test(ctx.reason ?? ''), 'reactionContext: one reaction per person', ctx);
  await app.call(chat, id, 'typing', { conversation: direct.nativeId });
  check(sent('typing').length === 1, 'typing goes to the phone');
  await phone({ result: { op: 'messages', value: { messages: [msg({ id: '90', ts: T0 - 5000, text: 'long ago' })], total: 2 } } });
  const hist = await app.call(chat, id, 'history', { conversation: direct.nativeId, limit: 20 });
  check(hist.count === 1 && (await until(() => evs(id).some((e) => e.t === 'message' && e.message.body === 'long ago' && e.live === false), 5000, 'the older message')), 'history: older messages, as history', hist);
  await app.call(chat, id, 'redact', { conversation: direct.nativeId, message: m101 });
  check(sent('delete').at(-1)?.message === '101' && (await until(() => evs(id).some((e) => e.t === 'delete' && e.nativeId === m101), 5000, 'the delete')), 'redact deletes it on the phone');
  const about = await app.call(chat, id, 'about', { target: { kind: 'conversation', nativeId: group.nativeId } });
  check(about.fields?.name?.value === 'Family' && about.fields.name.canEdit === false && about.members?.total === 3, 'about: the group name and its members', about);
  const od = await app.call(chat, id, 'openDirect', { peer: '+15550000070' });
  check(od.conversation?.endsWith(':c77') && sent('getOrCreate').at(-1)?.numbers?.[0] === '+15550000070', 'openDirect makes the conversation with a number', od);
  const prof = await app.call(chat, id, 'profile', { who: '+15550000002' });
  check(prof.displayName === 'Alice Example' && prof.relationship === 'contact', 'profile: a contact', prof);
  const edit = await app.call(chat, id, 'edit', { conversation: direct.nativeId, message: m101, body: 'x' }).catch((e: Error) => e);
  check(edit instanceof Error && /cannot edit/.test(edit.message), 'edit is refused (Google Messages has none)', String(edit));
  await phone({ emit: { t: 'message', message: msg({ id: '102', participant: '1', fromMe: true, status: 'OUTGOING_COMPLETE', state: 'sent', ts: T0 + 3000, text: 'mine' }) } });
  await phone({ emit: { t: 'message', message: msg({ id: '102', participant: '1', fromMe: true, status: 'OUTGOING_DISPLAYED', state: 'read', ts: T0 + 3000, text: 'mine' }) } });
  check(await until(() => evs(id).some((e) => e.t === 'receipt' && e.state === 'read' && e.who === '+15550000002'), 5000, 'a receipt'), 'your message read: a receipt');
  await phone({ emit: { t: 'typing', conversation: '10', number: '+15550000002', stop: false } });
  check(await until(() => evs(id).some((e) => e.t === 'typing' && e.author === '+15550000002' && e.ttl === 15_000), 5000, 'typing'), 'someone typing reaches the app');

  // 5. The phone, and another browser.
  await phone({ emit: { t: 'phone', responding: false } });
  check(await until(() => status(id)?.status === 'attention' && layer(status(id), 'phone')?.state === 'failed', 5000, 'phone silent'), 'the phone stops answering: attention, the phone layer failed', status(id)?.attention?.message);
  await phone({ emit: { t: 'phone', responding: true } });
  check(await until(() => status(id)?.status === 'online', 5000, 'online'), 'it answers again: online');
  await phone({ emit: { t: 'alert', alert: 'browser_inactive' } });
  check(await until(() => status(id)?.attention?.message?.includes('another browser'), 5000, 'elsewhere'), 'another browser takes over: attention');
  const act = await call('action', { action: 'setActive' });
  check(act.ok && sent('setActive').length >= 1, 'setActive (as the page runs it) asks the phone to come back', act);
  await phone({ emit: { t: 'alert', alert: 'browser_active' } });
  check(await until(() => status(id)?.status === 'online', 5000, 'online'), 'and it is online again');

  // 6. Restart, then unpaired.
  const before = cmds.length;
  const seen = evs(id).length;
  await api(`/api/accounts/${id}/restart`, {});
  await until(() => cmds.slice(before).some((c) => c.op === 'connect'), 20_000, 'connect');
  check(JSON.stringify(cmds.slice(before).find((c) => c.op === 'connect')?.session) === JSON.stringify(SESSION), 'restarted: it connects with the stored session');
  check(await until(() => evs(id).slice(seen).some((e) => e.t === 'status' && e.status === 'online'), 15_000, 'online'), 'and is online without pairing again', cmds.slice(before).map((c) => c.op));
  check(!cmds.slice(before).some((c) => c.op === 'startQr'), 'no QR code asked for');
  const n = evs(id).length;
  await phone({ emit: { t: 'unpaired', reason: 'revoked' } });
  const again = await until(() => evs(id).slice(n).filter((e) => e.t === 'status' && e.attention?.qr).at(-1), 10_000, 'a new QR');
  check(again?.attention?.message?.includes('removed under Device pairing'), 'unpaired on the phone: it says so, with a new QR code', again?.attention?.message);
  check(readSecretFile<any>(join(dir, 'secret.json')).session === undefined, 'and the session is gone from secret.json');

  // 7. By Google account.
  const cookies = 'SID=s; HSID=h; SSID=ss; APISID=a; SAPISID=sa; OSID=o';
  const gid = (await api('/api/accounts', { kind: 'gmessages', label: 'Verify Google', secret: { cookies } })).id as string;
  const emoji = await until(() => (status(gid)?.attention?.kind === 'verify' ? status(gid) : undefined), 30_000, 'the emoji');
  check(emoji?.attention?.detail?.emoji === '🦊' && emoji.attention.message.includes('tap 🦊'), 'with Google cookies from the add form: an emoji to tap on the phone', emoji?.attention);
  check(sent('pairGoogle').at(-1)?.cookies === cookies, 'the cookies went to the bridge from secret.json');
  const page = await account(gid);
  check(!JSON.stringify(page).includes('SAPISID'), 'no cookie reaches the page');
} catch (e) {
  check(false, 'the run', String((e as Error)?.stack ?? e));
} finally {
  app?.close();
  if (mgr && mgr.exitCode === null) {
    mgr.kill('SIGTERM');
    const killer = setTimeout(() => mgr!.kill('SIGKILL'), 15_000);
    await mgr.exited;
    clearTimeout(killer);
  }
  ctl.stop(true);
  if (!keep) rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
