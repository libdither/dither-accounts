/**
 * The adapter against a fake bridge process (test/fake-bridge.ts): pairing by QR and by Google account, what each
 * command turns into on the wire, the facts each bridge event becomes, and what happens when the phone, the pairing
 * or the bridge goes away. No Google and no phone involved.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { type AdapterOptions, CAPABILITIES, ELSEWHERE, GM_TYPING_TTL, GMessagesAdapter, namespaceOf, PHONE_SILENT, type Secret } from '../src/adapter.ts';

const FAKE = join(import.meta.dir, 'fake-bridge.ts');

const SESSION = { browser: { sourceID: 'browser-1' }, mobile: { sourceID: 'phone-1' }, tachyon_token: 'dG9rZW4=', tachyon_expiry: '2026-12-01T00:00:00Z', request_crypto: { aes_key: 'a', hmac_key: 'b' }, refresh_key: {} };
const GOOGLE_SESSION = { ...SESSION, dest_reg_id: '11111111-2222-3333-4444-555555555555', cookies: { SID: 's', HSID: 'h', SSID: 'ss', APISID: 'a', SAPISID: 'sa', OSID: 'o' } };
const COOKIES = 'SID=s; HSID=h; SSID=ss; APISID=a; SAPISID=sa; OSID=o';
const NS = namespaceOf('m:phone-1');
const ME = `${NS}:me`;
const ALICE = '+15550000002';
const BOB = '+15550000003';
const T0 = 1_770_000_000_000;

const me = { id: '1', number: '+15550000001', isMe: true, visible: true };
const alice = { id: '2', number: ALICE, formatted: '(555) 000-0002', fullName: 'Alice Example', firstName: 'Alice', contactId: 'c2', visible: true };
const bob = { id: '3', number: BOB, formatted: '(555) 000-0003', fullName: 'Bob Example', firstName: 'Bob', visible: true };
const conv = (o: Record<string, unknown> = {}) => ({ id: '10', type: 'rcs', status: 'active', lastTs: T0, latestId: '100', outgoingId: '1', participants: [me, alice], ...o });
const GROUP = conv({ id: '20', group: true, name: 'Family', latestId: '200', participants: [me, alice, bob] });
const SMS = conv({ id: '30', type: 'sms', latestId: '300', participants: [me, bob] });
const msg = (o: Record<string, unknown> = {}) => ({ id: '100', conversation: '10', participant: '2', ts: T0, status: 'INCOMING_COMPLETE', state: 'received', kind: 'rcs', text: 'hello', ...o });
const C = (id: string) => `${NS}:c${id}`;
const M = (id: string) => `${NS}:m${id}`;

let current: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const h of current) await h.close();
  current = [];
  delete process.env.FAKE_GM_ECHO;
  delete process.env.FAKE_GM_QUIET;
});

async function harness(o: { secret?: Secret; config?: Record<string, unknown>; dir?: string; echo?: boolean; quiet?: boolean; online?: boolean; connectFails?: number; opts?: Partial<AdapterOptions> } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'gm-adapter-'));
  const secretPath = join(dir, 'secret.json');
  if (o.secret) writeSecretFile(secretPath, o.secret);
  const sock = join(dir, `ctl.${Math.random().toString(36).slice(2)}.sock`);
  const cmds: any[] = [];
  let conns: any[] = [];
  const server = Bun.listen({
    unix: sock,
    socket: {
      open(s) {
        conns.push(s);
        (s as any).buf = '';
      },
      data(s, d) {
        (s as any).buf += d.toString();
        let nl: number;
        while ((nl = (s as any).buf.indexOf('\n')) >= 0) {
          const m = JSON.parse((s as any).buf.slice(0, nl));
          (s as any).buf = (s as any).buf.slice(nl + 1);
          if (m.cmd) cmds.push(m.cmd);
        }
      },
      close(s) {
        conns = conns.filter((c) => c !== s);
      },
    },
  });
  process.env.FAKE_GM_SOCK = sock;
  process.env.FAKE_GM_ECHO = o.echo === false ? '0' : '1';
  process.env.FAKE_GM_QUIET = o.quiet ? '1' : '0';
  process.env.FAKE_GM_CONNECT_FAILS = String(o.connectFails ?? 0);
  const events: P.AdapterEvent[] = [];
  const logs: string[] = [];
  const adapter = new GMessagesAdapter(
    { emit: (e) => events.push(e), log: (_l, m) => logs.push(m), accountDir: dir, config: o.config ?? {}, secret: () => readSecretFile<Secret>(secretPath), saveSecret: (v) => writeSecretFile(secretPath, v) },
    { bridge: async () => ['bun', FAKE], restartBackoffMs: [50, 100], connectBackoffMs: [50, 100], echoTimeoutMs: 1500, activeTimeoutMs: 300, ...o.opts },
  );
  const waitFor = async <T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> => {
    const until = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out waiting for ${fn}`);
      await Bun.sleep(10);
    }
  };
  const ctl = async (m: unknown) => {
    await waitFor(() => conns.length > 0);
    conns[conns.length - 1].write(JSON.stringify(m) + '\n');
  };
  const h = {
    adapter,
    events,
    cmds,
    logs,
    dir,
    waitFor,
    ctl,
    secret: () => readSecretFile<Secret>(secretPath),
    /** Have the bridge print an event, and wait until the adapter has handled it. */
    emit: async (ev: any) => {
      const n = events.length;
      await ctl({ emit: ev });
      const start = Date.now();
      let seen = n;
      let quiet = Date.now();
      while (Date.now() - start < 2000) {
        await Bun.sleep(10);
        if (events.length !== seen) (seen = events.length), (quiet = Date.now());
        else if (seen > n && Date.now() - quiet >= 60) break;
        else if (seen === n && Date.now() - start >= 400) break;
      }
      return events.slice(n);
    },
    cmd: (op: string, nth = 0) => cmds.filter((c) => c.op === op)[nth],
    count: (op: string) => cmds.filter((c) => c.op === op).length,
    status: () => [...events].reverse().find((e): e is Extract<P.AdapterEvent, { t: 'status' }> => e.t === 'status')!,
    layer: (name: string) => h.status().layers!.find((l) => l.name === name)!,
    run: (cmd: Record<string, unknown>) => adapter.command({ id: 'x', ...cmd } as P.AdapterCommand),
    close: async () => {
      await adapter.shutdown();
      server.stop(true);
    },
  };
  current.push(h);
  await adapter.start();
  if (o.online ?? !!o.secret?.session) await waitFor(() => h.status()?.status === 'online');
  return h;
}

const ofType = <T extends P.AdapterEvent['t']>(evs: P.AdapterEvent[], t: T) => evs.filter((e): e is Extract<P.AdapterEvent, { t: T }> => e.t === t);

/** Online, with these conversations (and their latest messages) synced. */
async function synced(convs: unknown[], messages: unknown[] = [], o: Parameters<typeof harness>[0] = {}) {
  const h = await harness({ secret: { session: SESSION }, quiet: true, ...o });
  await h.ctl({ result: { op: 'conversations', value: { conversations: convs } } });
  await h.ctl({ result: { op: 'messages', value: { messages, total: messages.length } } });
  await h.emit({ t: 'settings', settings: { sims: [{ number: 1, phone: '+15550000001', formatted: '(555) 000-0001', carrier: 'Example Mobile', participant: '1', rcs: true }], rcsEnabled: true, readReceipts: true, typingIndicators: true } });
  await h.emit({ t: 'alert', alert: 'browser_active' });
  await h.waitFor(() => h.logs.some((l) => l.startsWith('synced')));
  await h.ctl({ clear: 'messages' });
  return h;
}

// ---------------------------------------------------------------- pairing

test('not paired: a QR code that refreshes as it expires; New code asks again; an expired one says so', async () => {
  const h = await harness();
  const st = await h.waitFor(() => (h.status()?.attention?.qr ? h.status() : undefined));
  expect(st).toMatchObject({ status: 'attention', attention: { kind: 'link_device', qr: 'https://support.google.com/messages/?p=web_computer#?c=FAKEQR1' } });
  expect(st.attention!.qrRefreshAt).toBeGreaterThan(Date.now());
  expect(st.attention!.message).toContain('Device pairing → QR code scanner');
  expect(st.attention!.message).toContain('pairGoogle');
  expect(st.self).toBeUndefined();
  expect(st.layers!.map((l) => [l.name, l.state])).toEqual([
    ['bridge', 'ok'],
    ['phone', 'waiting'],
    ['paired', 'waiting'],
    ['connected', 'waiting'],
  ]);
  expect(h.layer('paired').note).toBe('scan the QR code (1 of 6)');
  expect(ofType(h.events, 'hello')[0]).toMatchObject({ network: 'gmessages', capabilities: CAPABILITIES });
  expect(CAPABILITIES).not.toContain('edit');

  await h.emit({ t: 'qr', url: 'https://support.google.com/messages/?p=web_computer#?c=FAKEQR2', expiresMs: 30_000, attempt: 2, of: 6 });
  expect(h.status().attention!.qr).toEndWith('FAKEQR2');
  expect(h.layer('paired').note).toBe('scan the QR code (2 of 6)');

  await h.emit({ t: 'qr_expired' });
  expect(h.status().attention).toMatchObject({ kind: 'link_device' });
  expect(h.status().attention!.message).toContain('expired');
  expect(h.status().attention!.qr).toBeUndefined();

  await h.adapter.command({ t: 'action', id: '1', action: 'refreshLink' });
  await h.waitFor(() => h.count('startQr') === 2);
  expect(h.cmd('cancelPairing')).toBeTruthy();
});

test('Google will not give a QR code: it says so, and how to pair instead', async () => {
  const h = await harness();
  await h.waitFor(() => h.status()?.attention?.qr);
  await h.ctl({ error: { op: 'startQr', message: 'Google would not start a QR pairing: http 400' } });
  await h.adapter.command({ t: 'action', id: '1', action: 'refreshLink' });
  await h.waitFor(() => h.status().attention?.message.includes('would not give a QR code'));
  expect(h.status().attention!.message).toContain('pairGoogle');
  expect(h.layer('paired').note).toContain('no QR code');
});

test('a scan pairs it: the session goes to secret.json, then it connects, syncs and is online', async () => {
  const h = await harness({ quiet: true });
  await h.waitFor(() => h.status()?.attention?.qr);
  await h.ctl({ result: { op: 'conversations', value: { conversations: [conv()] } } });
  await h.emit({ t: 'paired', via: 'qr', phone: 'phone-1', session: SESSION });
  expect(h.secret().session).toEqual(SESSION);
  expect(h.status().status).toBe('connecting');
  expect(h.layer('paired')).toMatchObject({ state: 'ok', note: 'by QR code' });

  await h.emit({ t: 'connected', google: false, sessionId: 's' });
  expect(h.status().status).toBe('online');
  expect(h.layer('connected').note).toContain('waiting for the phone');
  await h.emit({ t: 'settings', settings: { sims: [{ number: 1, phone: '+15550000001', formatted: '(555) 000-0001', carrier: 'Example Mobile', participant: '1', rcs: true }], rcsEnabled: true, readReceipts: true, typingIndicators: false, defaultSmsApp: true, version: 'v1' } });
  await h.emit({ t: 'alert', alert: 'browser_active' });
  const st = h.status();
  expect(st).toMatchObject({ status: 'online', attention: null, self: { nativeId: ME, handle: '+15550000001', displayName: '(555) 000-0001', isSelf: true } });
  expect(st.layers!.every((l) => l.state === 'ok')).toBe(true);
  expect(h.layer('phone').note).toContain('must stay on and online');
  expect(st.details).toMatchObject({ pairedVia: 'qr', phoneNumber: '+15550000001', carrier: 'Example Mobile', sims: 1, rcs: true, typingIndicators: false, defaultSmsApp: true, activeHere: true, phoneResponding: true, namespace: NS });
  expect(JSON.stringify(st.details)).not.toContain('dG9rZW4');
  await h.waitFor(() => h.cmd('conversations'));
  await h.waitFor(() => ofType(h.events, 'conversation').length > 0);
});

test('pairing by Google account: cookies from the add form, an emoji to tap; a wrong tap says so and New code tries again', async () => {
  const h = await harness({ secret: { cookies: COOKIES } });
  await h.waitFor(() => h.cmd('pairGoogle'));
  expect(h.cmd('pairGoogle').cookies).toBe(COOKIES);
  expect(h.count('startQr')).toBe(0);
  await h.waitFor(() => h.status()?.attention?.kind === 'verify');
  expect(h.status().attention).toMatchObject({ kind: 'verify', detail: { emoji: '🦊' } });
  expect(h.status().attention!.message).toContain('tap 🦊');
  expect(h.layer('paired').note).toBe('tap 🦊 on the phone');
  expect(h.layer('phone').note).toContain('same Google account');

  await h.emit({ t: 'pair_error', via: 'google', code: 'wrong_emoji', error: 'a different emoji was tapped on the phone; try again' });
  expect(h.status().attention).toMatchObject({ kind: 'link_device' });
  expect(h.status().attention!.message).toContain('a different emoji was tapped');
  await h.adapter.command({ t: 'action', id: '1', action: 'refreshLink' });
  await h.waitFor(() => h.count('pairGoogle') === 2);

  await h.emit({ t: 'paired', via: 'google', phone: 'someone@example.com/1', session: GOOGLE_SESSION });
  expect(h.secret()).toEqual({ session: GOOGLE_SESSION });
  await h.emit({ t: 'connected', google: true, account: 'someone@example.com' });
  expect(h.status().details).toMatchObject({ pairedVia: 'google', googleAccount: 'someone@example.com', namespace: namespaceOf(`d:${GOOGLE_SESSION.dest_reg_id}`) });
  expect(h.layer('paired').note).toBe('with a Google account (someone@example.com)');
});

test('Google pairing without cookies asks for them; cookies that do not do ask again; relogin pairs with good ones', async () => {
  const h = await harness({ config: { pairing: 'google' } });
  await h.waitFor(() => h.status()?.attention?.kind === 'login');
  expect(h.status().attention!.message).toContain('messages.google.com');
  expect(h.count('startQr')).toBe(0);
  expect(h.layer('paired').note).toContain('cookies');

  await expect(h.adapter.command({ t: 'action', id: '1', action: 'pairGoogle', args: { cookies: 'SID=1' } })).rejects.toThrow('missing Google cookies');
  expect(h.status().attention).toMatchObject({ kind: 'login' });
  expect(h.status().attention!.message).toContain('missing Google cookies');
  expect(h.secret().cookies).toBeUndefined();

  expect(await h.adapter.command({ t: 'action', id: '2', action: 'relogin', args: { password: COOKIES } })).toEqual({ emoji: '🦊' });
  expect(h.secret().cookies).toBe(COOKIES);
  await h.waitFor(() => h.status().attention?.kind === 'verify');
});

test('a restart keeps the session: it connects with it, without pairing again, and remembers its conversations', async () => {
  const h = await synced([conv()]);
  expect(h.cmd('connect').session).toEqual(SESSION);
  expect(h.count('startQr')).toBe(0);
  const dir = h.dir;
  await h.close();
  current = current.filter((x) => x !== h);
  const again = await harness({ dir, quiet: true, online: true });
  expect(again.cmd('connect').session).toEqual(SESSION);
  expect(again.count('startQr') + again.count('pairGoogle')).toBe(0);
  expect(again.status().self!.nativeId).toBe(ME);
  expect(again.adapter.state.conv(C('10'))).toBeTruthy();
  // A token refreshed by the bridge is kept.
  await again.emit({ t: 'session', session: { ...SESSION, tachyon_token: 'bmV3' } });
  expect(again.secret().session!.tachyon_token).toBe('bmV3');
});

// ---------------------------------------------------------------- events

test('conversations: people are identities by number, directs unnamed, groups named; archived, read, deleted', async () => {
  const h = await synced([conv(), GROUP]);
  const ids = ofType(h.events, 'identity').map((e) => e.identity);
  expect(ids.find((i) => i.nativeId === ALICE)).toEqual({ nativeId: ALICE, displayName: 'Alice Example', handle: '(555) 000-0002', contact: true, avatarUrl: 'gm-avatar:2' });
  expect(ids.find((i) => i.nativeId === BOB)).toEqual({ nativeId: BOB, displayName: 'Bob Example', handle: '(555) 000-0003' });
  expect(ids.find((i) => i.nativeId === ME)).toMatchObject({ isSelf: true });
  const convs = ofType(h.events, 'conversation').map((e) => e.conversation);
  expect(convs.find((c) => c.nativeId === C('10'))).toEqual({ nativeId: C('10'), shape: 'direct', participants: [ME, ALICE], lastMessageAt: T0 });
  expect(convs.find((c) => c.nativeId === C('20'))).toEqual({ nativeId: C('20'), shape: 'group', name: 'Family', participants: [ME, ALICE, BOB], lastMessageAt: T0 });
  expect(ofType(h.events, 'read').map((e) => e.conversation).sort()).toEqual([C('10'), C('20')]);

  // A new message only moves lastMessageAt: no new conversation fact for that.
  expect(await h.emit({ t: 'conversation', conversation: conv({ lastTs: T0 + 5 }) })).toEqual([]);
  const archived = await h.emit({ t: 'conversation', conversation: conv({ status: 'archived' }) });
  expect(ofType(archived, 'conversation')[0].conversation.archived).toBe(true);
  const gone = await h.emit({ t: 'conversation', conversation: conv({ status: 'deleted' }) });
  expect(gone).toEqual([{ t: 'leave', kind: 'conversation', nativeId: C('10') }]);
  expect(await h.emit({ t: 'conversation', conversation: conv({ id: '40', status: 'spam' }) })).toEqual([]);
});

test('read state: a conversation read on the phone is read here', async () => {
  const h = await synced([conv({ unread: true })]);
  expect(ofType(h.events, 'read')).toEqual([]);
  const evs = await h.emit({ t: 'conversation', conversation: conv({ unread: false, lastTs: T0 + 10 }) });
  expect(ofType(evs, 'read')).toEqual([{ t: 'read', conversation: C('10'), upToTs: T0 + 10, unread: 0, mentions: 0 }]);
});

test('messages: the first sync is history; live ones are news, with replies, subjects and media', async () => {
  const h = await synced([conv()], [msg(), msg({ id: '99', ts: T0 - 1000, text: 'earlier' })]);
  const backfill = ofType(h.events, 'message');
  expect(backfill.map((e) => [e.message.nativeId, e.live])).toEqual([
    [M('99'), false],
    [M('100'), false],
  ]);
  expect(backfill[1].message).toMatchObject({ conversation: C('10'), author: ALICE, body: 'hello', kind: 'text', extra: { status: 'received', via: 'rcs' } });

  const live = await h.emit({
    t: 'message',
    message: msg({
      id: '101',
      ts: T0 + 1000,
      text: 'look',
      subject: 'Trip',
      replyTo: '100',
      media: [
        { part: 'p1', mediaId: 'm1', key: 'a2V5', name: 'photo.jpg', mime: 'image/jpeg', size: 1234, width: 640, height: 480 },
        { name: 'clip.mp4', mime: 'video/*', pending: true },
      ],
    }),
  });
  const m = ofType(live, 'message')[0];
  expect(m.live).toBe(true);
  expect(m.message).toEqual({
    nativeId: M('101'),
    conversation: C('10'),
    author: ALICE,
    ts: T0 + 1000,
    kind: 'text',
    body: '**Trip**\nlook\n(waiting for the attachment clip.mp4)',
    attachments: [{ nativeId: 'p1', kind: 'image', mime: 'image/jpeg', name: 'photo.jpg', size: 1234, width: 640, height: 480, url: `gm-media:${M('101')}/0` }],
    replyTo: M('100'),
    extra: { status: 'received', via: 'rcs' },
  });
  // The rest of the media arrives: the message again, not as news.
  const done = await h.emit({ t: 'message', message: msg({ id: '101', ts: T0 + 1000, text: 'look', subject: 'Trip', replyTo: '100', media: [{ part: 'p1', mediaId: 'm1', key: 'a2V5', name: 'photo.jpg', mime: 'image/jpeg' }, { part: 'p2', mediaId: 'm2', key: 'a2V5', name: 'clip.mp4', mime: 'video/mp4' }] }) });
  expect(ofType(done, 'message')[0]).toMatchObject({ live: false, message: { attachments: [{ kind: 'image' }, { kind: 'video', url: `gm-media:${M('101')}/1` }] } });
  // A status change alone publishes nothing.
  expect(ofType(await h.emit({ t: 'message', message: msg({ id: '101', ts: T0 + 1000, text: 'look', subject: 'Trip', replyTo: '100', status: 'INCOMING_DISPLAYED', media: [{ part: 'p1', mediaId: 'm1', key: 'a2V5', name: 'photo.jpg', mime: 'image/jpeg' }, { part: 'p2', mediaId: 'm2', key: 'a2V5', name: 'clip.mp4', mime: 'video/mp4' }] }) }), 'message')).toEqual([]);

  // A sender not in the conversation's list is learnt from the message.
  const stranger = await h.emit({ t: 'message', message: msg({ id: '102', ts: T0 + 2000, participant: '9', senderNumber: '+15550000009', senderName: 'Carol' }) });
  expect(ofType(stranger, 'identity')[0].identity).toMatchObject({ nativeId: '+15550000009', displayName: 'Carol' });
  expect(ofType(stranger, 'message')[0].message.author).toBe('+15550000009');
});

test('MMS the phone is still downloading waits; tombstones: noise is dropped, the rest is a system message', async () => {
  const h = await synced([conv(), GROUP]);
  expect(ofType(await h.emit({ t: 'message', message: msg({ id: '110', ts: T0 + 1, status: 'INCOMING_AUTO_DOWNLOADING', state: 'downloading', kind: 'mms', text: undefined }) }), 'message')).toEqual([]);
  const got = await h.emit({ t: 'message', message: msg({ id: '110', ts: T0 + 1, kind: 'mms', text: undefined, media: [{ part: 'p', mediaId: 'x', key: 'a2V5', mime: 'image/png' }] }) });
  expect(ofType(got, 'message')[0]).toMatchObject({ live: true, message: { kind: 'media', body: '' } });

  expect(await h.emit({ t: 'message', message: msg({ id: '201', conversation: '20', ts: T0 + 2, status: 'TOMBSTONE_RCS_GROUP_CREATED', state: 'system', ignore: true, text: undefined }) })).toEqual([]);
  const left = await h.emit({ t: 'message', message: msg({ id: '202', conversation: '20', participant: '3', ts: T0 + 3, status: 'TOMBSTONE_PARTICIPANT_LEFT', state: 'system', text: 'Bob left' }) });
  expect(ofType(left, 'message')[0].message).toMatchObject({ kind: 'system', body: 'Bob left', author: BOB });

  const enc = await h.emit({ t: 'message', message: msg({ id: '120', ts: T0 + 4, status: 'MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_RCS_TO_E2EE', state: 'system', ignore: true, e2ee: true }) });
  expect(enc).toEqual([{ t: 'conversation', conversation: { nativeId: C('10'), shape: 'direct', participants: [ME, ALICE], lastMessageAt: T0, encrypted: true } }]);
  expect(h.adapter.state.conv(C('10'))!.e2ee).toBe(true);
});

test('deleted on the phone: a delete', async () => {
  const h = await synced([conv()], [msg()]);
  expect(await h.emit({ t: 'message', message: msg({ status: 'MESSAGE_DELETED', state: 'deleted' }) })).toEqual([{ t: 'delete', conversation: C('10'), nativeId: M('100') }]);
  expect(h.adapter.state.msg(M('100'))).toBeUndefined();
});

test('reactions: a snapshot when first seen, then each change as a reaction event', async () => {
  const h = await synced([conv()]);
  const first = await h.emit({ t: 'message', message: msg({ reactions: [{ emoji: '👍', participants: ['2'] }] }) });
  expect(ofType(first, 'message')[0].message.reactions).toEqual([{ key: '👍', authors: [ALICE] }]);
  const changed = await h.emit({ t: 'message', message: msg({ reactions: [{ emoji: '❤️', participants: ['2', '1'] }] }) });
  expect(ofType(changed, 'reaction')).toEqual([
    { t: 'reaction', conversation: C('10'), message: M('100'), author: ALICE, key: '❤️' },
    { t: 'reaction', conversation: C('10'), message: M('100'), author: ME, key: '❤️' },
    { t: 'reaction', conversation: C('10'), message: M('100'), author: ALICE, key: '👍', remove: true },
  ]);
  expect(await h.run({ t: 'reactors', conversation: C('10'), message: M('100'), key: '❤️' })).toEqual({ authors: [ALICE, ME] });
});

test('your messages: delivered and read become receipts; in a group "Read by" names the members', async () => {
  const h = await synced([conv(), GROUP]);
  const mine = (o: Record<string, unknown>) => msg({ id: '150', participant: '1', fromMe: true, status: 'OUTGOING_COMPLETE', state: 'sent', text: 'hi', ...o });
  const sent = await h.emit({ t: 'message', message: mine({}) });
  expect(ofType(sent, 'message')[0].message.author).toBe(ME);
  expect(ofType(sent, 'receipt')).toEqual([]);
  const delivered = await h.emit({ t: 'message', message: mine({ status: 'OUTGOING_DELIVERED', state: 'delivered' }) });
  expect(ofType(delivered, 'receipt')).toEqual([{ t: 'receipt', conversation: C('10'), messages: [M('150')], who: ALICE, state: 'delivered', ts: expect.any(Number) }]);
  const read = await h.emit({ t: 'message', message: mine({ status: 'OUTGOING_DISPLAYED', state: 'read' }) });
  expect(ofType(read, 'receipt')[0]).toMatchObject({ who: ALICE, state: 'read' });
  expect(ofType(await h.emit({ t: 'message', message: mine({ status: 'OUTGOING_DISPLAYED', state: 'read' }) }), 'receipt')).toEqual([]);

  const g = (o: Record<string, unknown>) => mine({ id: '250', conversation: '20', ...o });
  await h.emit({ t: 'message', message: g({}) });
  const one = await h.emit({ t: 'message', message: g({ status: 'OUTGOING_DISPLAYED', state: 'read', statusText: 'Read by Alice' }) });
  expect(ofType(one, 'receipt').map((r) => r.who)).toEqual([ALICE]);
  const both = await h.emit({ t: 'message', message: g({ status: 'OUTGOING_DISPLAYED', state: 'read', statusText: 'Read by Alice, Bob' }) });
  expect(ofType(both, 'receipt').map((r) => r.who)).toEqual([BOB]);

  const failed = await h.emit({ t: 'message', message: mine({ id: '151', status: 'OUTGOING_FAILED_TOO_LARGE', state: 'failed', error: 'too large' }) });
  expect(ofType(failed, 'message')[0].message.extra).toEqual({ status: 'failed', via: 'rcs', error: 'too large' });
});

test('typing: someone typing in an RCS chat reaches the hub for 15 s; a stop stops it', async () => {
  const h = await synced([conv()]);
  expect(await h.emit({ t: 'typing', conversation: '10', number: ALICE, stop: false })).toEqual([{ t: 'typing', conversation: C('10'), author: ALICE, ttl: GM_TYPING_TTL }]);
  expect(await h.emit({ t: 'typing', conversation: '10', number: ALICE, stop: true })).toEqual([{ t: 'typing', conversation: C('10'), author: ALICE, stop: true }]);
  expect(await h.emit({ t: 'typing', conversation: '10', number: '+15550000001', stop: false })).toEqual([]);
  expect(await h.emit({ t: 'typing', conversation: '99', number: ALICE, stop: false })).toEqual([]);
});

// ---------------------------------------------------------------- commands

test('send: plain text from Markdown, a reply in RCS, and the id from the phone’s copy', async () => {
  const h = await synced([conv(), SMS], [msg()]);
  const r = await h.run({ t: 'send', conversation: C('10'), body: '**hi** <@+15550000002>, see [the map](https://example.com)', replyTo: M('100') });
  const sent = h.cmd('send');
  expect(sent).toMatchObject({ conversation: '10', text: 'hi @Alice Example, see the map (https://example.com)', replyTo: '100', outgoing: '1', forceRcs: false });
  expect(sent.tmpId).toBeString();
  expect(r).toEqual({ nativeId: M('91') });
  const echo = ofType(h.events, 'message').find((e) => e.message.nativeId === M('91'))!;
  expect(echo.message).toMatchObject({ author: ME, body: 'hi @Alice Example, see the map (https://example.com)', replyTo: M('100') });

  // An SMS chat cannot quote: the reply goes as a plain message.
  await h.emit({ t: 'message', message: msg({ id: '300', conversation: '30', participant: '3', kind: 'sms' }) });
  await h.run({ t: 'send', conversation: C('30'), body: 'ok', replyTo: M('300') });
  expect(h.cmd('send', 1)).toMatchObject({ conversation: '30', text: 'ok' });
  expect(h.cmd('send', 1).replyTo).toBeUndefined();
  await expect(h.run({ t: 'send', conversation: C('10'), body: '  ' })).rejects.toThrow('nothing to send');
  await expect(h.run({ t: 'send', conversation: C('404'), body: 'x' })).rejects.toThrow('not in this Google Messages account');
});

test('send with attachments: SMS captions the first; RCS sends the text after them; no copy, no id', async () => {
  const h = await synced([conv(), SMS]);
  const file = join(h.dir, 'photo.png');
  writeFileSync(file, 'png');
  const att = (name: string) => ({ path: file, name, mime: 'image/png', size: 3, kind: 'image' as const });
  const sms = await h.run({ t: 'send', conversation: C('30'), body: 'caption', attachments: [att('a.png'), att('b.png')] });
  expect(h.cmds.filter((c) => c.op === 'send').map((c) => [c.media?.name, c.text])).toEqual([
    ['a.png', 'caption'],
    ['b.png', undefined],
  ]);
  expect(sms).toEqual({ nativeId: M('91') });
  await h.run({ t: 'send', conversation: C('10'), body: 'words', attachments: [att('c.png')] });
  expect(h.cmds.filter((c) => c.op === 'send').slice(2).map((c) => [c.media?.name, c.text])).toEqual([
    ['c.png', undefined],
    [undefined, 'words'],
  ]);
  await h.close();
  current = [];
  const quiet = await synced([conv()], [], { echo: false, opts: { echoTimeoutMs: 100 } });
  expect(await quiet.run({ t: 'send', conversation: C('10'), body: 'hello?' })).toEqual({});
});

test('send fails: the phone not answering, the phone refusing it', async () => {
  const h = await synced([conv()]);
  await h.ctl({ error: { op: 'send', message: 'phone_not_responding: the phone did not answer; it may still send the message when it is back online' } });
  await expect(h.run({ t: 'send', conversation: C('10'), body: 'hi' })).rejects.toThrow('Your phone did not answer');
  await h.ctl({ error: { op: 'send', message: "the phone refused the message: FAILURE_4 (is Google Messages the phone's default SMS app?)" } });
  await expect(h.run({ t: 'send', conversation: C('10'), body: 'hi' })).rejects.toThrow('default SMS app');
});

test('not paired: commands say so', async () => {
  const h = await harness();
  await h.waitFor(() => h.status()?.attention?.qr);
  await expect(h.run({ t: 'send', conversation: C('10'), body: 'hi' })).rejects.toThrow('not paired');
  await expect(h.run({ t: 'markRead', conversation: C('10'), upTo: M('1') })).rejects.toThrow('not paired');
  await expect(h.run({ t: 'action', action: 'setActive' })).rejects.toThrow('not connected');
});

test('react: add, switch, remove, each told to the phone and the hub; what SMS does with one', async () => {
  const h = await synced([conv(), SMS], [msg()]);
  await h.run({ t: 'react', conversation: C('10'), message: M('100'), key: '👍' });
  expect(h.cmd('react')).toMatchObject({ conversation: '10', message: '100', emoji: '👍', action: 'add' });
  await h.run({ t: 'react', conversation: C('10'), message: M('100'), key: '😂' });
  expect(h.cmd('react', 1)).toMatchObject({ emoji: '😂', action: 'switch' });
  await h.run({ t: 'react', conversation: C('10'), message: M('100'), key: '👍', remove: true });
  expect(h.count('react')).toBe(2);
  await h.run({ t: 'react', conversation: C('10'), message: M('100'), key: '😂', remove: true });
  expect(h.cmd('react', 2)).toMatchObject({ emoji: '😂', action: 'remove' });
  expect(ofType(h.events, 'reaction').map((r) => [r.key, !!r.remove])).toEqual([
    ['👍', false],
    ['😂', false],
    ['👍', true],
    ['😂', true],
  ]);
  // The phone's copy of the message with the same reaction changes nothing more.
  expect(ofType(await h.emit({ t: 'message', message: msg() }), 'reaction')).toEqual([]);
  expect(await h.run({ t: 'reactionContext', conversation: C('10') })).toMatchObject({ canReact: true, reason: expect.stringContaining('One reaction per person') });
  expect(await h.run({ t: 'reactionContext', conversation: C('30') })).toMatchObject({ canReact: true, reason: expect.stringContaining('SMS and MMS have no reactions') });
  await expect(h.run({ t: 'react', conversation: C('10'), message: M('404'), key: '👍' })).rejects.toThrow('not in this Google Messages');
});

test('markRead tells the phone and the hub', async () => {
  const h = await synced([conv({ unread: true })], [msg()]);
  expect(await h.run({ t: 'markRead', conversation: C('10'), upTo: M('100') })).toEqual({ marked: 1 });
  expect(h.cmd('markRead')).toMatchObject({ conversation: '10', message: '100' });
  expect(ofType(h.events, 'read').at(-1)).toEqual({ t: 'read', conversation: C('10'), upToTs: T0, unread: 0, mentions: 0 });
});

test('typing: told to the phone in RCS chats only; there is no stop to send', async () => {
  const h = await synced([conv(), SMS]);
  await h.run({ t: 'typing', conversation: C('10') });
  expect(h.cmd('typing')).toMatchObject({ conversation: '10' });
  await h.run({ t: 'typing', conversation: C('10'), stop: true });
  await h.run({ t: 'typing', conversation: C('30') });
  expect(h.count('typing')).toBe(1);
});

test('history: older than what is known, as history; done when the phone has no more', async () => {
  const h = await synced([conv()], [msg()]);
  await h.ctl({ result: { op: 'messages', value: { messages: [msg({ id: '98', ts: T0 - 2000, text: 'older' }), msg({ id: '97', ts: T0 - 3000, text: 'oldest', participant: '1', fromMe: true, state: 'read', status: 'OUTGOING_DISPLAYED' }), msg()], total: 3 } } });
  const n = h.events.length;
  expect(await h.run({ t: 'history', conversation: C('10'), limit: 30 })).toEqual({ count: 2, done: false });
  const syncMessages = h.cmds.filter((c) => c.op === 'messages');
  expect(syncMessages.at(-1)).toMatchObject({ conversation: '10', count: 30, cursor: { id: '100', ts: T0 } });
  const got = ofType(h.events.slice(n), 'message');
  expect(got.map((e) => [e.message.nativeId, e.live])).toEqual([
    [M('97'), false],
    [M('98'), false],
  ]);
  expect(got[0].message.author).toBe(ME);
  expect(ofType(h.events.slice(n), 'receipt')).toEqual([]);

  // Asked from a point: the cursor is the newest known message before it.
  await h.ctl({ result: { op: 'messages', value: { messages: [], total: 3 } } });
  expect(await h.run({ t: 'history', conversation: C('10'), beforeTs: T0 - 2000, limit: 10 })).toEqual({ count: 0, done: true });
  expect(h.cmds.filter((c) => c.op === 'messages').at(-1).cursor).toEqual({ id: '97', ts: T0 - 3000 });
});

test('fetchMedia: a download by key, media sent inline, a preview (and the full picture asked for), avatars', async () => {
  const h = await synced([conv()]);
  await h.emit({
    t: 'message',
    message: msg({
      id: '160',
      media: [
        { part: 'p1', mediaId: 'm1', key: 'a2V5', mime: 'image/jpeg' },
        { mime: 'image/png', inline: Buffer.from('inline!').toString('base64') },
        { part: 'p3', thumbId: 't3', thumbKey: 'dGs=', mime: 'image/*' },
        { name: 'x', pending: true },
      ],
    }),
  });
  const a = (await h.run({ t: 'fetchMedia', url: `gm-media:${M('160')}/0` })) as { mime: string; base64: string };
  expect(h.cmd('download')).toMatchObject({ mediaId: 'm1', key: 'a2V5' });
  expect(h.cmd('download').dest).toStartWith(join(h.dir, 'media'));
  expect(existsSync(h.cmd('download').dest)).toBe(false);
  expect(a).toEqual({ mime: 'image/jpeg', base64: Buffer.from('fake media bytes').toString('base64') });
  expect(await h.run({ t: 'fetchMedia', url: `gm-media:${M('160')}/1` })).toEqual({ mime: 'image/png', base64: Buffer.from('inline!').toString('base64') });
  expect(h.count('download')).toBe(1);
  expect(await h.run({ t: 'fetchMedia', url: `gm-media:${M('160')}/2` })).toMatchObject({ mime: 'image/jpeg' });
  expect(h.cmd('download', 1)).toMatchObject({ mediaId: 't3', key: 'dGs=' });
  await h.waitFor(() => h.cmd('fullMedia'));
  expect(h.cmd('fullMedia')).toMatchObject({ message: '160', part: 'p3' });
  await expect(h.run({ t: 'fetchMedia', url: `gm-media:${M('160')}/3` })).rejects.toThrow('not downloaded');
  await expect(h.run({ t: 'fetchMedia', url: `gm-media:${M('404')}/0` })).rejects.toThrow('not in this Google Messages');
  expect(await h.run({ t: 'fetchMedia', url: 'gm-avatar:2' })).toEqual({ mime: 'image/png', base64: Buffer.from('png').toString('base64') });
  expect(h.cmd('thumbnails')).toMatchObject({ ids: ['2'] });
  await expect(h.run({ t: 'fetchMedia', url: 'mxc://nope' })).rejects.toThrow('Not a Google Messages media URL');
});

test('redact deletes the message on the phone', async () => {
  const h = await synced([conv()], [msg()]);
  await h.run({ t: 'redact', conversation: C('10'), message: M('100') });
  expect(h.cmd('delete')).toMatchObject({ message: '100' });
  expect(h.events.at(-1)).toEqual({ t: 'delete', conversation: C('10'), nativeId: M('100') });
  // The phone's own deletion notice afterwards changes nothing.
  expect(await h.emit({ t: 'message', message: msg({ status: 'MESSAGE_DELETED', state: 'deleted' }) })).toEqual([]);
});

test('about: a group’s name (changed on the phone, not here) and members; a direct conversation', async () => {
  const h = await synced([conv(), GROUP]);
  const g = (await h.run({ t: 'about', target: { kind: 'conversation', nativeId: C('20') } })) as P.About;
  expect(g).toMatchObject({ noun: 'Group', fields: { name: { value: 'Family', canEdit: false } }, members: { list: [{ id: ME }, { id: ALICE }, { id: BOB }], total: 3, complete: true } });
  expect(g.facts).toEqual([
    { label: 'Type', value: 'RCS' },
    { label: 'Sends from', value: '(555) 000-0001, Example Mobile' },
  ]);
  const d = (await h.run({ t: 'about', target: { kind: 'conversation', nativeId: C('10') } })) as P.About;
  expect(d).toMatchObject({ noun: 'Conversation', fields: { name: { value: null, canEdit: false } } });
  await expect(h.run({ t: 'configure', target: { kind: 'conversation', nativeId: C('20') }, change: { key: 'name', value: 'x' } })).rejects.toThrow('on the phone');
  await expect(h.run({ t: 'about', target: { kind: 'space', nativeId: 'x' } })).rejects.toThrow('no spaces');
});

test('openDirect makes or finds the conversation with a number; profile; edit and forward', async () => {
  const h = await synced([conv()]);
  const r = (await h.run({ t: 'openDirect', peer: '+1 (555) 000-0070' })) as P.OpenDirectResult;
  expect(h.cmd('getOrCreate')).toMatchObject({ numbers: ['+15550000070'] });
  expect(r).toEqual({ conversation: C('77'), existed: false });
  expect(ofType(h.events, 'conversation').at(-1)!.conversation).toMatchObject({ nativeId: C('77'), participants: [ME, '+15550000070'] });
  await expect(h.run({ t: 'openDirect', peer: 'alice' })).rejects.toThrow('phone number');

  expect(await h.run({ t: 'profile', who: ALICE })).toEqual({ displayName: 'Alice Example', handle: '(555) 000-0002', avatar: 'gm-avatar:2', relationship: 'contact', links: [{ label: 'Phone', value: '(555) 000-0002', url: `tel:${ALICE}` }] });
  expect(await h.run({ t: 'profile', who: BOB })).toMatchObject({ relationship: 'stranger' });
  await expect(h.run({ t: 'edit', conversation: C('10'), message: M('1'), body: 'x' })).rejects.toThrow('cannot edit');
  expect(await h.run({ t: 'forward', conversation: C('10'), source: { conversation: C('10'), message: M('1') } })).toMatchObject({ fallback: expect.any(String) });
});

// ---------------------------------------------------------------- when things go away

test('the phone stops answering: attention, and the phone layer fails; it answers again: online', async () => {
  const h = await synced([conv()]);
  await h.emit({ t: 'phone', responding: false });
  expect(h.status()).toMatchObject({ status: 'attention', attention: { kind: 'unknown', message: PHONE_SILENT } });
  expect(h.layer('phone')).toMatchObject({ state: 'failed' });
  expect(h.layer('phone').note).toContain('not answering since');
  expect(h.status().details!.phoneResponding).toBe(false);
  await h.emit({ t: 'phone', responding: true });
  expect(h.status()).toMatchObject({ status: 'online', attention: null });
  expect(h.layer('phone').state).toBe('ok');
  // Any message from the phone is the phone answering too.
  await h.emit({ t: 'phone', responding: false });
  await h.emit({ t: 'message', message: msg({ id: '170', ts: T0 + 9 }) });
  expect(h.status().status).toBe('online');
});

test('unpaired from the phone: the session leaves secret.json and a new QR code shows', async () => {
  const h = await synced([conv()]);
  await h.emit({ t: 'unpaired', reason: 'revoked' });
  expect(h.secret().session).toBeUndefined();
  await h.waitFor(() => h.status().attention?.qr);
  expect(h.status().attention!.message).toStartWith('This computer was removed under Device pairing on the phone.');
  expect(h.status().self).toBeUndefined();
  expect(h.layer('paired').state).toBe('waiting');
  await expect(h.run({ t: 'send', conversation: C('10'), body: 'hi' })).rejects.toThrow('not paired');
});

test('unpaired with a Google pairing: a new emoji at once, with the same cookies', async () => {
  const h = await harness({ secret: { session: GOOGLE_SESSION } });
  await h.emit({ t: 'unpaired', reason: 'not_found' });
  await h.waitFor(() => h.cmd('pairGoogle'));
  expect(h.cmd('pairGoogle').cookies).toBe(COOKIES);
  expect(h.secret()).toEqual({ cookies: COOKIES });
  await h.waitFor(() => h.status().attention?.kind === 'verify');
  expect(h.status().attention!.message).toStartWith('Google Messages no longer knows this pairing');
});

test('Google signs the session out: it asks for new cookies', async () => {
  const h = await harness({ secret: { session: GOOGLE_SESSION } });
  await h.emit({ t: 'logged_out', reason: 'invalid_credentials', error: 'http 401 while polling' });
  expect(h.secret()).toEqual({});
  expect(h.status()).toMatchObject({ status: 'attention', attention: { kind: 'login' } });
  expect(h.status().attention!.message).toContain('signed this session out');
  // A QR pairing signed out is simply unpaired.
  const q = await harness({ secret: { session: SESSION } });
  await q.emit({ t: 'logged_out', reason: 'invalid_credentials' });
  await q.waitFor(() => q.cmd('startQr'));
});

test('relink unpairs on the phone and pairs again', async () => {
  const h = await synced([conv()]);
  await h.run({ t: 'action', action: 'relink' });
  expect(h.cmd('logout')).toBeTruthy();
  expect(h.secret().session).toBeUndefined();
  await h.waitFor(() => h.status().attention?.qr);
  await expect(h.run({ t: 'action', action: 'refreshLink' })).resolves.toEqual({ started: true });
});

test('another browser takes over: attention; setActive brings it back', async () => {
  const h = await synced([conv()]);
  await h.emit({ t: 'alert', alert: 'browser_inactive' });
  expect(h.status()).toMatchObject({ status: 'attention', attention: { message: ELSEWHERE } });
  expect(h.layer('connected')).toMatchObject({ state: 'failed' });
  await h.run({ t: 'action', action: 'setActive' });
  expect(h.cmd('setActive')).toBeTruthy();
  await h.emit({ t: 'alert', alert: 'browser_active' });
  expect(h.status().status).toBe('online');
  await h.emit({ t: 'alert', alert: 'battery_low' });
  expect(h.status().details!.battery).toBe('low');
  expect(h.layer('phone').note).toContain('battery low');
});

test('no BROWSER_ACTIVE after connecting: it asks the phone to take this session, and syncs anyway', async () => {
  const h = await harness({ secret: { session: SESSION }, quiet: true });
  await h.waitFor(() => h.cmd('setActive'), 3000);
  await h.waitFor(() => h.cmd('conversations'), 3000);
});

test('the bridge dies: it starts again and connects with the session', async () => {
  const h = await synced([conv()]);
  await h.ctl({ exit: 3 });
  await h.waitFor(() => h.status().status === 'connecting');
  await h.waitFor(() => h.count('connect') === 2);
  await h.waitFor(() => h.status().status === 'online');
  expect(h.logs.some((l) => l.includes('exited (code 3)'))).toBe(true);
});

test('a listen error reconnects; a fatal one starts the bridge again', async () => {
  const h = await synced([conv()]);
  await h.emit({ t: 'listen_error', fatal: false, error: 'http 502' });
  expect(h.status().status).toBe('connecting');
  expect(h.layer('connected').note).toBe('reconnecting: http 502');
  await h.emit({ t: 'listen_recovered' });
  expect(h.status().status).toBe('online');
  await h.emit({ t: 'listen_error', fatal: true, error: 'boom' });
  await h.waitFor(() => h.count('connect') === 2);
  await h.waitFor(() => h.status().status === 'online');
});

test('connecting fails: it says so and tries again', async () => {
  const h = await harness({ secret: { session: SESSION }, online: false, quiet: true, connectFails: 2, opts: { connectBackoffMs: [300, 300] } });
  await h.waitFor(() => h.status()?.attention?.message.includes('no route to host'));
  expect(h.status().status).toBe('connecting');
  expect(h.layer('connected').note).toContain('trying again');
  await h.waitFor(() => h.status().status === 'online');
  expect(h.count('connect')).toBe(3);
});

test('no bridge: an error that says why', async () => {
  const h = await harness({ opts: { bridge: async () => Promise.reject(new Error('nix build exited 1')) } });
  await h.waitFor(() => h.status()?.status === 'error');
  expect(h.status().attention!.message).toContain('nix build exited 1');
  expect(h.layer('bridge')).toMatchObject({ state: 'failed' });
});
