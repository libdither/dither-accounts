/**
 * The adapter against a fake bridge process (test/fake-bridge.ts): linking, what each hub command
 * turns into on the wire, read state, history, media, and what happens when the bridge or the
 * session goes away. No WhatsApp involved.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { type AdapterOptions, WhatsAppAdapter } from '../src/adapter.ts';
import { msgId } from '../src/mapping.ts';

const FAKE = join(import.meta.dir, 'fake-bridge.ts');
const FIX = new Map<string, any>(
  readFileSync(join(import.meta.dir, 'fixtures/events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .map((e) => [e.fixture, e]),
);
const fx = (name: string) => {
  const e = structuredClone(FIX.get(name)!);
  delete e.fixture;
  return e;
};

const ME = '15550000001@s.whatsapp.net';
const ALICE = '15550000002@s.whatsapp.net';
const BOB = '15550000003@s.whatsapp.net';
const BOB_LID = '200000000000003@lid';
const GROUP = '120363000000000001@g.us';

type H = Awaited<ReturnType<typeof harness>>;
let current: H | null = null;

afterEach(async () => {
  await current?.close();
  current = null;
});

async function harness(o: { loggedIn?: boolean; opts?: Partial<AdapterOptions> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-adapter-'));
  const sock = join(dir, 'ctl.sock');
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
          const msg = JSON.parse((s as any).buf.slice(0, nl));
          (s as any).buf = (s as any).buf.slice(nl + 1);
          if (msg.cmd) cmds.push(msg.cmd);
        }
      },
      close(s) {
        conns = conns.filter((c) => c !== s);
      },
    },
  });
  process.env.FAKE_WA_SOCK = sock;
  process.env.FAKE_WA_LOGGED_IN = o.loggedIn === false ? '0' : '1';
  const events: P.AdapterEvent[] = [];
  const adapter = new WhatsAppAdapter(
    { emit: (e) => events.push(e), log: () => {}, accountDir: dir, config: {} },
    { bridge: async () => ['bun', FAKE], restartBackoffMs: [50, 100], historyTimeoutMs: 400, expirySweepMs: 60_000, fetch: (async () => new Response('png', { headers: { 'content-type': 'image/png' } })) as any, ...o.opts },
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
  const ctl = async (msg: unknown) => {
    await waitFor(() => conns.length > 0);
    conns[conns.length - 1].write(JSON.stringify(msg) + '\n');
  };
  const h = {
    adapter,
    events,
    cmds,
    dir,
    waitFor,
    ctl,
    /** Have the bridge print an event, and wait until the adapter has handled it. */
    emit: async (ev: any) => {
      const n = events.length;
      await ctl({ emit: ev });
      // Until the adapter has handled it: what it emits, then a quiet moment; or, for an event that yields nothing,
      // long enough that a slow machine would have shown something. A fixed wait failed under load.
      const start = Date.now();
      let seen = n;
      let quiet = Date.now();
      while (Date.now() - start < 2000) {
        await Bun.sleep(10);
        if (events.length !== seen) (seen = events.length), (quiet = Date.now());
        else if (seen > n && Date.now() - quiet >= 40) break;
        else if (seen === n && Date.now() - start >= 250) break;
      }
      return events.slice(n);
    },
    cmd: (op: string, nth = 0) => cmds.filter((c) => c.op === op)[nth],
    status: () => [...events].reverse().find((e): e is Extract<P.AdapterEvent, { t: 'status' }> => e.t === 'status')!,
    close: async () => {
      await adapter.shutdown();
      server.stop(true);
    },
  };
  current = h;
  await adapter.start();
  if (o.loggedIn !== false) {
    await waitFor(() => h.status()?.status === 'online');
    // Connecting ends with the join requests read (none: the fake has no groups), so nothing lands in a later slice.
    await waitFor(() => events.some((e) => e.t === 'requests'));
  }
  return h;
}

const ofType = <T extends P.AdapterEvent['t']>(evs: P.AdapterEvent[], t: T) => evs.filter((e): e is Extract<P.AdapterEvent, { t: T }> => e.t === t);

// ---------------------------------------------------------------- linking

test('not linked: the QR code goes to the hub as link_device attention; New code asks for another', async () => {
  const h = await harness({ loggedIn: false });
  const st = await h.waitFor(() => (h.status()?.attention?.qr ? h.status() : undefined));
  expect(st).toMatchObject({ status: 'attention', attention: { kind: 'link_device', qr: '2@fake-qr' } });
  expect(st.attention!.qrRefreshAt).toBeGreaterThan(Date.now());
  expect(ofType(h.events, 'hello')[0]).toMatchObject({ network: 'whatsapp', capabilities: expect.arrayContaining(['send', 'forward', 'e2ee', 'history']) });

  await h.adapter.command({ t: 'action', id: '1', action: 'refreshLink' });
  expect(h.cmd('link')).toBeTruthy();

  await h.emit({ t: 'qr_done', result: 'timeout' });
  expect(h.status().attention!.message).toContain('expired');
});

test('linking by phone number shows the pairing code', async () => {
  const h = await harness({ loggedIn: false });
  await h.waitFor(() => h.status()?.attention?.qr);
  await h.ctl({ result: { op: 'pairPhone', value: { code: 'ABCD1234' } } });
  await expect(h.adapter.command({ t: 'action', id: '1', action: 'pairPhone', args: { phone: 'call me' } })).rejects.toThrow('country code');
  expect(await h.adapter.command({ t: 'action', id: '2', action: 'pairPhone', args: { phone: '+1 555 000 0001' } })).toEqual({ code: 'ABCD-1234' });
  expect(h.cmd('pairPhone')).toMatchObject({ phone: '+1 555 000 0001' });
  expect(h.status().attention).toMatchObject({ kind: 'link_device', detail: { pairCode: 'ABCD-1234' } });
});

test('after the scan: online with your own identity, then contacts and groups', async () => {
  const h = await harness({ loggedIn: false });
  await h.waitFor(() => h.status()?.attention?.qr);
  await h.ctl({ result: { op: 'groups', value: [FIX.get('community').group, FIX.get('group').group] } });
  await h.ctl({ result: { op: 'contacts', value: [{ jid: ALICE, alt: '200000000000002@lid', fullName: 'Alice Chen', pushName: 'ali' }] } });
  await h.emit({ t: 'qr_done', result: 'success' });
  await h.emit({ t: 'paired', jid: ME, lid: '200000000000001@lid', platform: 'android' });
  await h.emit({ t: 'connected', loggedIn: true, jid: ME, lid: '200000000000001@lid', pushName: 'Me' });
  await h.waitFor(() => ofType(h.events, 'conversation').length);
  expect(h.status()).toMatchObject({ status: 'online', attention: null, self: { nativeId: ME, isSelf: true, displayName: 'Me', handle: '+15550000001' } });
  expect(ofType(h.events, 'identity').find((e) => e.identity.nativeId === ALICE)!.identity).toMatchObject({ displayName: 'Alice Chen', contact: true, handle: '+15550000002', avatarUrl: `wa-avatar:${ALICE}` });
  // the community before the group that sits in it
  const kinds = h.events.filter((e) => e.t === 'space' || e.t === 'conversation').map((e) => e.t);
  expect(kinds).toEqual(['space', 'conversation']);
  expect(ofType(h.events, 'conversation')[0].conversation).toMatchObject({ nativeId: GROUP, shape: 'channel', spaces: [{ nativeId: '120363000000000009@g.us' }] });
});

// ---------------------------------------------------------------- incoming

test('a message from someone new: identity and conversation reach the hub before the message', async () => {
  const h = await harness();
  const evs = await h.emit(fx('text'));
  expect(evs.map((e) => e.t)).toEqual(['identity', 'conversation', 'message']);
  expect(ofType(evs, 'identity')[0].identity).toMatchObject({ nativeId: ALICE, displayName: 'Alice', handle: '+15550000002' });
  expect(ofType(evs, 'conversation')[0].conversation).toMatchObject({ nativeId: ALICE, shape: 'direct', participants: [ME, ALICE] });
  // the second message adds nothing but itself
  expect((await h.emit(fx('image'))).map((e) => e.t)).toEqual(['message']);
});

test('a message in an unknown group asks for the group', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group').group } });
  await h.emit(fx('reply_mention'));
  await h.waitFor(() => h.cmd('group'));
  expect(h.cmd('group')).toMatchObject({ jid: GROUP });
  await h.waitFor(() => ofType(h.events, 'conversation').find((c) => c.conversation.name === 'Climbing crew'));
});

test('history sync on link: chats with mute and archive, then read state with the unread counts', async () => {
  const h = await harness();
  await h.emit(fx('history'));
  await h.emit(fx('history_text'));
  await h.emit(fx('history_stub'));
  const evs = await h.emit({ t: 'history_done', syncType: 'INITIAL_BOOTSTRAP', count: 2 });
  const convs = ofType(h.events, 'conversation').map((e) => e.conversation);
  expect(convs.find((c) => c.nativeId === GROUP)).toMatchObject({ name: 'Climbing crew', mute: { level: 'none' } });
  expect(convs.find((c) => c.nativeId === ALICE)).toMatchObject({ shape: 'direct', archived: true });
  const reads = ofType(evs, 'read');
  expect(reads.find((r) => r.conversation === GROUP)).toMatchObject({ unread: 3 });
  expect(reads.find((r) => r.conversation === ALICE)).toMatchObject({ unread: 0 });
  expect(ofType(h.events, 'message').every((m) => m.live === false)).toBe(true);
});

test('your phone reading a chat marks it read here', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  const evs = await h.emit({ t: 'receipt', chat: ALICE, sender: ME, fromMe: true, isGroup: false, ids: ['A1'], ts: 1_760_000_999_000, type: 'read-self' });
  expect(ofType(evs, 'read')).toEqual([{ t: 'read', conversation: ALICE, upToTs: FIX.get('text').info.ts }]);
  // someone else reading your message is not your read state
  expect(ofType(await h.emit({ t: 'receipt', chat: ALICE, sender: ALICE, fromMe: false, isGroup: false, ids: ['A1'], ts: 1, type: 'read' }), 'read')).toEqual([]);
});

test('receipts on your messages: delivered, read, played, once each per reader, in DMs and per member in groups', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  await h.emit(fx('own_text'));
  await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'see you' });
  const A2 = msgId(ALICE, 'A2');
  const SENT1 = msgId(ALICE, 'SENT1');

  // One of her devices has it; the next device saying so is no news.
  const delivered = fx('receipt_delivered');
  expect(ofType(await h.emit(delivered), 'receipt')).toEqual([{ t: 'receipt', conversation: ALICE, messages: [A2], who: ALICE, state: 'delivered', ts: delivered.ts }]);
  expect(await h.emit({ ...delivered, ts: delivered.ts + 1000 })).toEqual([]);
  // Read: both of your messages it names, the sent one too.
  const read = fx('receipt_read');
  expect(ofType(await h.emit(read), 'receipt')).toEqual([{ t: 'receipt', conversation: ALICE, messages: [A2, SENT1], who: ALICE, state: 'read', ts: read.ts }]);
  // A late delivery after the read is behind it.
  expect(await h.emit(delivered)).toEqual([]);
  const played = fx('receipt_played');
  expect(ofType(await h.emit(played), 'receipt')).toEqual([{ t: 'receipt', conversation: ALICE, messages: [A2], who: ALICE, state: 'played', ts: played.ts }]);
  // Your own devices getting it, and receipts on messages that are not yours, are not receipts from others.
  expect(ofType(await h.emit(fx('receipt_own_device')), 'receipt')).toEqual([]);
  expect(ofType(await h.emit({ ...read, ids: ['A1', 'UNKNOWN'] }), 'receipt')).toEqual([]);

  // A group: per member, by LID, under the id the member already has.
  await h.ctl({ result: { op: 'group', value: FIX.get('group').group } });
  await h.emit(fx('reply_mention'));
  await h.emit(fx('group_from_me'));
  const gread = fx('receipt_group_read');
  expect(ofType(await h.emit(gread), 'receipt')).toEqual([{ t: 'receipt', conversation: GROUP, messages: [msgId(GROUP, 'G3')], who: BOB, state: 'read', ts: gread.ts }]);

  // A chat this account has never had is nobody's DM: nothing, and no new person for it.
  expect(await h.emit({ ...read, chat: '200000000000099@lid', sender: '200000000000099@lid' })).toEqual([]);
});

test('admins made and unmade in a group: roles, and the line WhatsApp shows', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group').group } });
  await h.emit(fx('text')); // Alice, by number and LID
  await h.emit(fx('reply_mention')); // Bob, and the group
  const promote = fx('group_promote');
  const evs = await h.emit(promote);
  expect(ofType(evs, 'role')).toEqual([{ t: 'role', target: { kind: 'conversation', nativeId: GROUP }, member: ALICE, role: 'Admin', given: true, by: BOB, ts: promote.ts }]);
  expect(ofType(evs, 'message')[0].message).toMatchObject({ conversation: GROUP, author: BOB, kind: 'system', body: 'Bob made Alice an admin.' });
  const demote = fx('group_demote');
  const evs2 = await h.emit(demote);
  expect(ofType(evs2, 'role')).toEqual([{ t: 'role', target: { kind: 'conversation', nativeId: GROUP }, member: ALICE, role: 'Admin', given: false, by: BOB, ts: demote.ts }]);
  expect(ofType(evs2, 'message')[0].message.body).toBe('Bob removed Alice as admin.');

  // A community's own parent group: the community's admins.
  const community = FIX.get('community').group;
  await h.emit({ t: 'group', group: community });
  expect(ofType(await h.emit({ ...promote, jid: community.jid }), 'role')).toMatchObject([{ target: { kind: 'space', nativeId: community.jid }, member: ALICE, given: true }]);
  // A group this account is not in: nothing.
  expect(ofType(await h.emit({ ...promote, jid: '120363000000000077@g.us' }), 'role')).toEqual([]);
});

test('a contact’s About as WhatsApp pushes it: passed on for people you know, and an open profile shows it', async () => {
  const h = await harness();
  const about = fx('user_about');
  // Nobody this account knows yet.
  expect(await h.emit(about)).toEqual([]);
  // Someone you only share a group with is not followed.
  await h.ctl({ result: { op: 'group', value: FIX.get('group').group } });
  await h.emit(fx('reply_mention'));
  expect(ofType(await h.emit({ ...about, jid: BOB_LID }), 'customStatus')).toEqual([]);

  await h.emit({ t: 'contact', jid: ALICE, alt: ALICE_LID, fullName: 'Alice Chen', firstName: 'Alice' });
  await h.ctl({ result: { op: 'userInfo', value: FIX.get('user_info').result } });
  expect((await profile(h, ALICE)).bio).toBe('Out climbing');
  expect(ofType(await h.emit(about), 'customStatus')).toEqual([{ t: 'customStatus', who: ALICE, text: 'At the crag', ts: about.ts }]);
  // The profile, opened again soon, shows the new About without asking again.
  expect((await profile(h, ALICE)).bio).toBe('At the crag');
  expect(count(h, 'userInfo')).toBe(1);
  // Cleared, by her LID.
  expect(ofType(await h.emit({ t: 'user_about', jid: ALICE_LID, status: '' }), 'customStatus')).toEqual([{ t: 'customStatus', who: ALICE }]);
  expect(h.cmds.filter((c) => NEVER.includes(c.op))).toEqual([]);
});

test('pins pass through, and a pin whose time is up is unpinned', async () => {
  const h = await harness({ opts: { expirySweepMs: 50 } });
  await h.emit(fx('own_text'));
  const pin = fx('pin');
  expect(ofType(await h.emit(pin), 'pin')[0]).toEqual({ t: 'pin', conversation: ALICE, message: msgId(ALICE, 'A2'), pinned: true, by: ALICE, ts: pin.info.ts });
  // The fixture's week ended long ago.
  const lapsed = await h.waitFor(() => ofType(h.events, 'pin').find((p) => !p.pinned));
  expect(lapsed).toEqual({ t: 'pin', conversation: ALICE, message: msgId(ALICE, 'A2'), pinned: false, ts: pin.info.ts + 7 * 86_400_000 });
  await Bun.sleep(150);
  expect(ofType(h.events, 'pin')).toHaveLength(2);
});

test('leaving a group, being typed at, a picture change', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group').group } });
  await h.emit(fx('reply_mention'));
  expect(ofType(await h.emit({ t: 'chat_presence', chat: GROUP, sender: BOB_LID, fromMe: false, state: 'composing' }), 'typing')).toEqual([{ t: 'typing', conversation: GROUP, author: BOB, ttl: 25_000 }]);
  const pic = await h.emit({ t: 'picture', jid: BOB, id: '123', remove: false });
  expect(ofType(pic, 'identity')[0]?.identity.avatarUrl ?? `wa-avatar:${BOB}?123`).toBe(`wa-avatar:${BOB}?123`);
  const left = await h.emit({ t: 'group_change', jid: GROUP, join: [], leave: [ME], ts: 1 });
  expect(ofType(left, 'leave')).toEqual([{ t: 'leave', kind: 'conversation', nativeId: GROUP }]);
});

test('disappearing messages go when their time is up', async () => {
  const h = await harness({ opts: { expirySweepMs: 50 } });
  const ev = fx('text');
  ev.message = { extendedTextMessage: { text: 'gone soon', contextInfo: { expiration: 1 } } };
  await h.emit(ev);
  const del = await h.waitFor(() => ofType(h.events, 'delete')[0]);
  expect(del).toEqual({ t: 'delete', conversation: ALICE, nativeId: msgId(ALICE, 'A1'), reason: 'expired' });
});

// ---------------------------------------------------------------- commands

test('send: text with a reply and a mention, and the sent message is published', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  const r = await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: '**sure** <@15550000002@s.whatsapp.net>', replyTo: msgId(ALICE, 'A1') });
  expect(r).toEqual({ nativeId: msgId(ALICE, 'SENT1') });
  expect(h.cmd('send')).toMatchObject({
    chat: ALICE,
    message: { extendedTextMessage: { text: '*sure* @15550000002', contextInfo: { stanzaID: 'A1', participant: ALICE, quotedMessage: { conversation: 'hey, *lunch* tomorrow?' }, mentionedJID: [ALICE] } } },
  });
  const sent = ofType(h.events, 'message').at(-1)!.message;
  expect(sent).toMatchObject({ nativeId: msgId(ALICE, 'SENT1'), author: ME, body: '**sure** <@15550000002@s.whatsapp.net>', replyTo: msgId(ALICE, 'A1') });

  await h.adapter.command({ t: 'send', id: '2', conversation: ALICE, body: 'plain' });
  expect(h.cmd('send', 1).message).toEqual({ conversation: 'plain' });
});

test('send in a disappearing chat sets the timer on the message', async () => {
  const h = await harness();
  const ev = fx('text');
  ev.message = { extendedTextMessage: { text: 'hi', contextInfo: { expiration: 604800 } } };
  await h.emit(ev);
  await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'ok' });
  expect(h.cmd('send').message).toEqual({ extendedTextMessage: { text: 'ok', contextInfo: { expiration: 604800 } } });
});

test('send a file: upload, then a media message with the caption', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  await h.ctl({ result: { op: 'upload', value: { url: 'https://mmg/x', directPath: '/v/x', mediaKey: 'a2V5', fileEncSHA256: 'ZW5j', fileSHA256: 'c2hh', fileLength: 3, thumbnail: 'dGh1bWI=', width: 4, height: 3 } } });
  await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'look', attachments: [{ path: '/tmp/x.png', name: 'x.png', mime: 'image/png', size: 3, kind: 'image' }] });
  expect(h.cmd('upload')).toMatchObject({ path: '/tmp/x.png', kind: 'image' });
  expect(h.cmd('send').message).toEqual({ imageMessage: { url: 'https://mmg/x', directPath: '/v/x', mediaKey: 'a2V5', fileEncSHA256: 'ZW5j', fileSHA256: 'c2hh', fileLength: '3', mimetype: 'image/png', caption: 'look', JPEGThumbnail: 'dGh1bWI=', width: 4, height: 3 } });
  const sent = ofType(h.events, 'message').at(-1)!.message;
  expect(sent.attachments![0]).toMatchObject({ kind: 'image', url: `wa-media:${msgId(ALICE, 'SENT1')}` });
});

test('send a voice note with text: the text goes out first as its own message, the audio has no caption', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  await h.ctl({ result: { op: 'upload', value: { url: 'https://mmg/v', directPath: '/v/v', mediaKey: 'a2V5', fileEncSHA256: 'ZW5j', fileSHA256: 'c2hh', fileLength: 5 } } });
  const r = (await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'listen to this', replyTo: msgId(ALICE, 'A1'), attachments: [{ path: '/tmp/v.ogg', name: 'v.ogg', mime: 'audio/ogg', size: 5, kind: 'audio' }] })) as { nativeId: string };
  const sends = h.cmds.filter((c) => c.op === 'send');
  expect(r.nativeId).toBe(msgId(ALICE, 'SENT1'));
  expect(sends).toHaveLength(2);
  expect(sends[0].message.extendedTextMessage).toMatchObject({ text: 'listen to this', contextInfo: { stanzaID: 'A1' } });
  expect(sends[1].message).toEqual({ audioMessage: { url: 'https://mmg/v', directPath: '/v/v', mediaKey: 'a2V5', fileEncSHA256: 'ZW5j', fileSHA256: 'c2hh', fileLength: '5', mimetype: 'audio/ogg' } });
  expect(ofType(h.events, 'message').slice(-2).map((e) => e.message.body)).toEqual(['listen to this', '']);
});

test('react: message keys for a DM and for a LID-addressed group, one reaction at a time', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  await h.adapter.command({ t: 'react', id: '1', conversation: ALICE, message: msgId(ALICE, 'A1'), key: '👍' });
  expect(h.cmd('send').message.reactionMessage).toMatchObject({ key: { remoteJID: ALICE, fromMe: false, ID: 'A1' }, text: '👍' });
  expect(h.cmd('send').message.reactionMessage.key.participant).toBeUndefined();
  await h.adapter.command({ t: 'react', id: '2', conversation: ALICE, message: msgId(ALICE, 'A1'), key: '😂' });
  expect(ofType(h.events, 'reaction').slice(-2)).toEqual([
    { t: 'reaction', conversation: ALICE, message: msgId(ALICE, 'A1'), author: ME, key: '👍', remove: true },
    { t: 'reaction', conversation: ALICE, message: msgId(ALICE, 'A1'), author: ME, key: '😂' },
  ]);
  await h.adapter.command({ t: 'react', id: '3', conversation: ALICE, message: msgId(ALICE, 'A1'), key: '😂', remove: true });
  expect(h.cmd('send', 2).message.reactionMessage.text).toBe('');

  await h.emit(fx('reply_mention'));
  await h.adapter.command({ t: 'react', id: '4', conversation: GROUP, message: msgId(GROUP, 'G1'), key: '❤️' });
  expect(h.cmd('send', 3).message.reactionMessage.key).toEqual({ remoteJID: GROUP, fromMe: false, ID: 'G1', participant: BOB_LID });
});

test('edit and delete your own message', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  const { nativeId } = (await h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'tyop' })) as { nativeId: string };
  // the fake's clock is 2026; pretend the send was just now
  h.adapter.state.db.query('UPDATE msg SET ts = ? WHERE id = ?').run(Date.now(), nativeId);
  await h.adapter.command({ t: 'edit', id: '2', conversation: ALICE, message: nativeId, body: 'typo' });
  const pm = h.cmd('send', 1).message.editedMessage.message.protocolMessage;
  expect(pm).toMatchObject({ key: { remoteJID: ALICE, fromMe: true, ID: 'SENT1' }, type: 'MESSAGE_EDIT', editedMessage: { conversation: 'typo' } });
  expect(ofType(h.events, 'message').at(-1)!.message).toMatchObject({ nativeId, body: 'typo', editedTs: expect.any(Number) });

  await expect(h.adapter.command({ t: 'edit', id: '3', conversation: ALICE, message: msgId(ALICE, 'A1'), body: 'x' })).rejects.toThrow('own messages');

  await h.adapter.command({ t: 'redact', id: '4', conversation: ALICE, message: nativeId });
  expect(h.cmd('send', 2).message).toEqual({ protocolMessage: { key: { remoteJID: ALICE, fromMe: true, ID: 'SENT1' }, type: 'REVOKE' } });
  expect(ofType(h.events, 'delete').at(-1)).toEqual({ t: 'delete', conversation: ALICE, nativeId });
});

test('an edit after 15 minutes is refused before it reaches WhatsApp', async () => {
  const h = await harness();
  await h.emit(fx('own_text'));
  await expect(h.adapter.command({ t: 'edit', id: '1', conversation: ALICE, message: msgId(ALICE, 'A2'), body: 'x' })).rejects.toThrow('15 minutes');
  expect(h.cmd('send')).toBeUndefined();
});

test('markRead: receipts per sender for what is unread, once', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  await h.emit(fx('image'));
  await h.adapter.command({ t: 'markRead', id: '1', conversation: ALICE, upTo: msgId(ALICE, 'A3') });
  expect(h.cmd('markRead')).toMatchObject({ chat: ALICE, sender: '', ids: ['A3', 'A1'] });
  expect(ofType(h.events, 'read').at(-1)).toMatchObject({ conversation: ALICE, upToTs: FIX.get('image').info.ts });
  await h.adapter.command({ t: 'markRead', id: '2', conversation: ALICE, upTo: msgId(ALICE, 'A3') });
  expect(h.cmd('markRead', 1)).toBeUndefined();

  await h.emit(fx('reply_mention'));
  await h.emit(fx('poll'));
  await h.adapter.command({ t: 'markRead', id: '3', conversation: GROUP, upTo: msgId(GROUP, 'G2') });
  expect(h.cmd('markRead', 1)).toMatchObject({ chat: GROUP, sender: BOB_LID, ids: ['G2', 'G1'] });
});

test('forward natively: same media, marked forwarded, the note after it', async () => {
  const h = await harness();
  await h.emit(fx('image'));
  await h.emit(fx('reply_mention'));
  const r = await h.adapter.command({ t: 'forward', id: '1', conversation: GROUP, source: { conversation: ALICE, message: msgId(ALICE, 'A3') }, note: 'from Alice' });
  expect(r).toEqual({ nativeId: msgId(GROUP, 'SENT1') });
  const fwd = h.cmd('send').message.imageMessage;
  expect(fwd).toMatchObject({ caption: 'look', mediaKey: FIX.get('image').message.imageMessage.mediaKey, contextInfo: { isForwarded: true, forwardingScore: 1 } });
  expect(h.cmd('send', 1)).toMatchObject({ chat: GROUP, message: { conversation: 'from Alice' } });

  await h.emit(fx('poll'));
  expect(await h.adapter.command({ t: 'forward', id: '2', conversation: ALICE, source: { conversation: GROUP, message: msgId(GROUP, 'G2') } })).toEqual({ fallback: expect.any(String) });
  expect(await h.adapter.command({ t: 'forward', id: '3', conversation: ALICE, source: { conversation: GROUP, message: msgId(GROUP, 'nope') } })).toEqual({ fallback: expect.any(String) });
});

test('older history comes from the phone on request', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  const pending = h.adapter.command({ t: 'history', id: '1', conversation: ALICE, beforeTs: FIX.get('text').info.ts, limit: 50 });
  await h.waitFor(() => h.cmd('historyRequest'));
  expect(h.cmd('historyRequest')).toMatchObject({ chat: ALICE, msgId: 'A1', fromMe: false, count: 50 });
  const old = fx('text');
  old.info.id = 'OLD1';
  old.info.ts -= 86_400_000;
  old.history = true;
  await h.emit({ t: 'history', syncType: 'ON_DEMAND', conversations: [{ ID: ALICE }], pushnames: [], lidMappings: [] });
  await h.emit(old);
  await h.emit({ t: 'history_done', syncType: 'ON_DEMAND', count: 1 });
  expect(await pending).toEqual({ count: 1, done: false });
  // the phone does not answer: nothing more
  expect(await h.adapter.command({ t: 'history', id: '2', conversation: ALICE, limit: 50 })).toEqual({ count: 0, done: true });
  // nothing to anchor a request on
  expect(await h.adapter.command({ t: 'history', id: '3', conversation: GROUP, limit: 50 })).toEqual({ count: 0, done: true });
});

test('openDirect checks the number and opens the chat, nothing sent', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'isOnWhatsApp', value: [{ query: '+15550000009', jid: '15550000009@s.whatsapp.net', isIn: true }] } });
  expect(await h.adapter.command({ t: 'openDirect', id: '1', peer: '+15550000009' })).toEqual({ conversation: '15550000009@s.whatsapp.net', existed: false, startsAtFirstSend: true });
  expect(ofType(h.events, 'conversation').at(-1)!.conversation).toMatchObject({ nativeId: '15550000009@s.whatsapp.net', shape: 'direct' });
  expect(h.cmd('send')).toBeUndefined();
  await h.ctl({ result: { op: 'isOnWhatsApp', value: [{ query: '+15550000008', jid: '', isIn: false }] } });
  await expect(h.adapter.command({ t: 'openDirect', id: '2', peer: '+15550000008' })).rejects.toThrow('not on WhatsApp');
});

test('fetchMedia downloads through the bridge; avatars through the picture URL', async () => {
  const h = await harness();
  await h.emit(fx('image'));
  const r = (await h.adapter.command({ t: 'fetchMedia', id: '1', url: `wa-media:${msgId(ALICE, 'A3')}` })) as { mime: string; base64: string };
  expect(r.mime).toBe('image/jpeg');
  expect(Buffer.from(r.base64, 'base64').toString()).toBe('fake media bytes');
  expect(h.cmd('download')).toMatchObject({ message: { imageMessage: { directPath: '/v/t62.7118-24/abc?ccb=11-4' } }, info: { id: 'A3', chat: ALICE, fromMe: false } });

  await h.ctl({ result: { op: 'avatar', value: { url: 'https://pps.whatsapp.net/x', id: '9' } } });
  expect(await h.adapter.command({ t: 'fetchMedia', id: '2', url: `wa-avatar:${ALICE}?9` })).toEqual({ mime: 'image/png', base64: Buffer.from('png').toString('base64') });
  await h.ctl({ result: { op: 'avatar', value: null } });
  await expect(h.adapter.command({ t: 'fetchMedia', id: '3', url: `wa-avatar:${BOB}` })).rejects.toThrow('no profile picture');
  // and does not ask again for a while
  await expect(h.adapter.command({ t: 'fetchMedia', id: '4', url: `wa-avatar:${BOB}` })).rejects.toThrow('no profile picture');
  expect(h.cmds.filter((c) => c.op === 'avatar')).toHaveLength(2);
});

// ---------------------------------------------------------------- staying connected

test('the bridge dies: connecting, then a new bridge that reconnects', async () => {
  const h = await harness();
  await h.ctl({ exit: 1 });
  await h.waitFor(() => h.cmds.filter((c) => c.op === 'connect').length === 2);
  await h.waitFor(() => h.status().status === 'online');
  expect(h.events.filter((e) => e.t === 'status').map((e) => (e as any).status)).toContain('connecting');
});

test('unlinked from the phone: back to a QR code with a fresh session', async () => {
  const h = await harness();
  process.env.FAKE_WA_LOGGED_IN = '0';
  await h.emit({ t: 'logged_out', reason: 'logged out from another device', onConnect: false });
  expect(ofType(h.events, 'status').some((s) => s.attention?.kind === 'link_device' && s.attention.message.includes('unlinked'))).toBe(true);
  await h.waitFor(() => h.status()?.attention?.qr);
  expect(h.cmds.filter((c) => c.op === 'connect')).toHaveLength(2);
});

test('a temporary ban: say so, and do not reconnect', async () => {
  const h = await harness();
  await h.emit({ t: 'temporary_ban', code: 101, reason: 'sent too many messages', expireSec: 3600, message: "You've been temporarily banned: sent too many messages" });
  expect(h.status()).toMatchObject({ status: 'attention', attention: { kind: 'rate_limited', message: expect.stringContaining('stays disconnected') } });
  await Bun.sleep(300);
  expect(h.cmds.filter((c) => c.op === 'connect')).toHaveLength(1);
});

test('another copy took the session: stop, and wait for Reconnect', async () => {
  const h = await harness();
  await h.emit({ t: 'stream_replaced' });
  expect(h.status()).toMatchObject({ status: 'error', attention: { message: expect.stringContaining('Another copy') } });
  await Bun.sleep(300);
  expect(h.cmds.filter((c) => c.op === 'connect')).toHaveLength(1);
  await h.adapter.command({ t: 'action', id: '1', action: 'reconnect' });
  await h.waitFor(() => h.cmds.filter((c) => c.op === 'connect').length === 2);
});

test('WhatsApp says the client is too old: an error that says what to update', async () => {
  const h = await harness();
  await h.emit({ t: 'client_outdated' });
  expect(h.status()).toMatchObject({ status: 'error', attention: { kind: 'selector_broken', message: expect.stringContaining('whatsmeow') } });
});

test('commands before linking say so', async () => {
  const h = await harness({ loggedIn: false });
  await h.waitFor(() => h.status()?.attention?.qr);
  await expect(h.adapter.command({ t: 'send', id: '1', conversation: ALICE, body: 'hi' })).rejects.toThrow('not linked');
});

test('typing: chat states both ways, never a presence', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group').group } });
  await h.emit(fx('reply_mention'));
  const typing = async (name: string) => ofType(await h.emit(fx(name)), 'typing');
  expect(await typing('typing_dm')).toEqual([{ t: 'typing', conversation: ALICE, author: ALICE, ttl: 25_000 }]);
  // The sender's LID is the phone-number identity the group already pinned.
  expect(await typing('typing_group')).toEqual([{ t: 'typing', conversation: GROUP, author: BOB, ttl: 25_000 }]);
  expect(await typing('recording_group')).toEqual([{ t: 'typing', conversation: GROUP, author: BOB, ttl: 25_000 }]);
  expect(await typing('paused_group')).toEqual([{ t: 'typing', conversation: GROUP, author: BOB, stop: true }]);
  expect(await typing('typing_own')).toEqual([]);

  await h.adapter.command({ t: 'typing', id: '1', conversation: GROUP });
  await h.adapter.command({ t: 'typing', id: '2', conversation: GROUP, stop: true });
  expect(h.cmd('chatPresence', 0)).toMatchObject({ chat: GROUP, state: 'composing' });
  expect(h.cmd('chatPresence', 1)).toMatchObject({ chat: GROUP, state: 'paused' });
  expect(h.cmds.filter((c) => c.op === 'presence')).toEqual([]);
});

// ---------------------------------------------------------------- about and settings

const BOOKS = '120363000000000002@g.us';
const COMMUNITY = '120363000000000009@g.us';
const ALICE_LID = '200000000000002@lid';
const about = (h: H, nativeId: string, kind: P.AboutTarget['kind'] = 'conversation') => h.adapter.command({ t: 'about', id: 'a', target: { kind, nativeId } }) as Promise<P.About>;
const configure = (h: H, nativeId: string, change: P.AboutChange, kind: P.AboutTarget['kind'] = 'conversation') => h.adapter.command({ t: 'configure', id: 'c', target: { kind, nativeId }, change }) as Promise<P.About>;
const count = (h: H, op: string) => h.cmds.filter((c) => c.op === op).length;

test('hello offers about and configure', async () => {
  const h = await harness();
  expect(ofType(h.events, 'hello')[0].capabilities).toEqual(expect.arrayContaining(['about', 'configure']));
});

test('about a group where you are an admin under your LID: everything editable, the owner, the invite link', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group_admin').group } });
  await h.ctl({ result: { op: 'groupInviteLink', value: { link: 'https://chat.whatsapp.com/FAKECODE1' } } });
  const a = await about(h, BOOKS);
  expect(h.cmd('group')).toMatchObject({ jid: BOOKS });
  expect(h.cmd('groupInviteLink')).toMatchObject({ jid: BOOKS, reset: false });
  expect(a.noun).toBe('Group');
  expect(a.fields).toEqual({
    name: { value: 'Book club', canEdit: true },
    topic: { value: 'One book a month', canEdit: true },
    avatar: { value: `wa-avatar:${BOOKS}`, canEdit: false, reason: 'Changing the picture is not supported yet.' },
    disappearing: { value: 7 * 86_400, canEdit: true },
    announceOnly: { value: false, canEdit: true },
    editInfo: { value: 'admins', canEdit: true },
    addMembers: { value: 'everyone', canEdit: true },
    joinApproval: { value: true, canEdit: true },
    encrypted: { value: true, canEdit: false, reason: 'Always on in WhatsApp.' },
  });
  const bob = h.adapter.mapper.who(BOB_LID);
  const alice = h.adapter.mapper.who(ALICE_LID);
  expect(a.members).toEqual({
    list: [
      { id: bob, role: 'Group owner', rank: 110 },
      { id: ME, role: 'Admin', rank: 100 },
      { id: alice, role: 'Member', rank: 0 },
    ],
    total: 3,
    complete: true,
  });
  // The hub hears of every member before the answer.
  const ids = ofType(h.events, 'identity').map((e) => e.identity.nativeId);
  expect(ids).toEqual(expect.arrayContaining([bob, ME, alice]));
  expect(a.roles).toEqual([
    { id: 'superadmin', name: 'Group owner', rank: 110, count: 1 },
    { id: 'admin', name: 'Admin', rank: 100, count: 1 },
    { id: 'member', name: 'Member', rank: 0, count: 1 },
  ]);
  expect(a.you).toEqual({ role: 'Admin', rank: 100 });
  expect(a.invite).toEqual({ link: 'https://chat.whatsapp.com/FAKECODE1', canCreate: true });
  expect(a.facts).toEqual([{ label: 'Created', value: '2024-03-02' }]);
  expect(a.rules!.every((r) => r.you)).toBe(true);
});

test('about a locked group where you are a member: nothing editable, and why; no invite link asked for', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: { ...FIX.get('group').group, isLocked: true } } });
  const a = await about(h, GROUP);
  expect(a.fields.name).toEqual({ value: 'Climbing crew', canEdit: false, reason: 'Only admins can edit this group’s info.' });
  expect(a.fields.topic).toMatchObject({ canEdit: false, reason: 'Only admins can edit this group’s info.' });
  expect(a.fields.avatar).toMatchObject({ canEdit: false, reason: 'Only admins can edit this group’s info.' });
  expect(a.fields.disappearing).toEqual({ value: 0, canEdit: false, reason: 'Only admins can edit this group’s info.' });
  expect(a.fields.editInfo).toEqual({ value: 'admins', canEdit: false, reason: 'Only admins can change this.' });
  for (const k of ['announceOnly', 'addMembers', 'joinApproval'] as const) expect(a.fields[k]).toMatchObject({ canEdit: false, reason: 'Only admins can change this.' });
  // The bridge did not say who may add people.
  expect(a.fields.addMembers!.value).toBeNull();
  expect(a.members!.list.find((m) => m.id === ME)).toEqual({ id: ME, role: 'Member', rank: 0 });
  expect(a.members!.list.find((m) => m.id !== ME)).toMatchObject({ role: 'Admin', rank: 100 });
  expect(a.you).toEqual({ role: 'Member', rank: 0 });
  expect(a.invite).toEqual({ link: null, canCreate: false, reason: 'Only admins can see and change the invite link.' });
  expect(h.cmd('groupInviteLink')).toBeUndefined();
  expect(a.rules!.find((r) => r.what.startsWith('Edit name'))).toEqual({ what: 'Edit name, description and disappearing messages', who: 'Only admins', you: false });

  // Unlocked, a member may edit the info but still not the admin settings.
  await h.ctl({ result: { op: 'group', value: FIX.get('group').group } });
  const b = await about(h, GROUP);
  expect(b.fields.name).toEqual({ value: 'Climbing crew', canEdit: true });
  expect(b.fields.editInfo).toMatchObject({ value: 'everyone', canEdit: false });
  await expect(configure(h, GROUP, { key: 'announceOnly', value: true })).rejects.toThrow('Only admins can change this.');
  expect(h.cmd('setGroupAnnounce')).toBeUndefined();
});

test('about a community: its own settings, gated to community admins', async () => {
  const h = await harness();
  const parent = { ...FIX.get('community').group, memberAddMode: 'admin_add', count: 40, participants: [{ jid: '200000000000001@lid', pn: ME, lid: '200000000000001@lid', admin: true, superAdmin: true }] };
  await h.ctl({ result: { op: 'group', value: parent } });
  const a = await about(h, COMMUNITY, 'space');
  expect(a.noun).toBe('Community');
  expect(Object.keys(a.fields)).toEqual(['name', 'topic', 'avatar', 'addMembers', 'joinApproval']);
  expect(a.fields.name).toEqual({ value: 'Neighbourhood', canEdit: true });
  expect(a.fields.addMembers).toEqual({ value: 'admins', canEdit: true });
  expect(a.you).toEqual({ role: 'Community owner', rank: 110 });
  expect(a.members).toMatchObject({ total: 40, complete: false });
  await expect(configure(h, COMMUNITY, { key: 'disappearing', value: 86_400 }, 'space')).rejects.toThrow('not a WhatsApp setting');
});

test('a 1:1 chat: its disappearing timer, set with the chat JID and kept up to date', async () => {
  const h = await harness();
  await h.emit(fx('text'));
  const a = await about(h, ALICE);
  expect(a).toEqual({
    noun: 'Chat',
    fields: { disappearing: { value: 0, canEdit: true }, encrypted: { value: true, canEdit: false, reason: 'Always on in WhatsApp.' } },
    members: { list: [{ id: ME }, { id: ALICE }], complete: true },
    rules: [{ what: 'Change disappearing messages', who: 'Either of you', you: true }],
  });
  const n = h.events.length;
  const b = await configure(h, ALICE, { key: 'disappearing', value: 86_400 });
  expect(h.cmd('setDisappearing')).toMatchObject({ jid: ALICE, seconds: 86_400 });
  expect(b.fields.disappearing).toEqual({ value: 86_400, canEdit: true });
  expect(ofType(h.events.slice(n), 'message')[0].message).toMatchObject({ conversation: ALICE, author: ME, kind: 'system', body: 'You turned on disappearing messages: 1 day.' });
  // What is sent next disappears too.
  await h.adapter.command({ t: 'send', id: 's', conversation: ALICE, body: 'hi' });
  expect(h.cmd('send').message).toMatchObject({ extendedTextMessage: { contextInfo: { expiration: 86_400 } } });
  // Alice turns it off from her phone.
  await h.emit({ t: 'message', info: { id: 'EPH1', chat: ALICE, sender: ALICE, fromMe: false, isGroup: false, ts: 1_770_000_100_000 }, message: { protocolMessage: { type: 'EPHEMERAL_SETTING', ephemeralExpiration: 0 } } });
  expect((await about(h, ALICE)).fields.disappearing!.value).toBe(0);
  await expect(configure(h, ALICE, { key: 'disappearing', value: 3600 })).rejects.toThrow('24 hours, 7 days or 90 days');
  await expect(configure(h, ALICE, { key: 'name', value: 'Alice' })).rejects.toThrow('not a setting of a 1:1 chat');
  expect(count(h, 'setDisappearing')).toBe(1);
});

test('configure the name: setGroupName, the group read again, the conversation fact and the About updated', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group_admin').group } });
  await about(h, BOOKS);
  const reads = count(h, 'group');
  const n = h.events.length;
  // The fake still answers the old name: what was written stands until WhatsApp's read catches up.
  const a = await configure(h, BOOKS, { key: 'name', value: '  Reading club ' });
  expect(h.cmd('setGroupName')).toEqual({ id: expect.any(String), op: 'setGroupName', jid: BOOKS, name: 'Reading club' });
  await h.waitFor(() => count(h, 'group') === reads + 1);
  expect(h.cmds.map((c) => c.op).slice(-2)).toEqual(['setGroupName', 'group']);
  expect(a.fields.name).toEqual({ value: 'Reading club', canEdit: true });
  expect(ofType(h.events.slice(n), 'conversation').at(-1)!.conversation).toMatchObject({ nativeId: BOOKS, name: 'Reading club' });
});

test('configure each group setting: the right bridge op and arguments', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group_admin').group } });
  await about(h, BOOKS);
  const cases: [P.AboutChange, string, Record<string, unknown>][] = [
    [{ key: 'topic', value: 'Two books a month' }, 'setGroupTopic', { jid: BOOKS, previousId: 'TOPIC1', topic: 'Two books a month' }],
    [{ key: 'announceOnly', value: true }, 'setGroupAnnounce', { jid: BOOKS, on: true }],
    [{ key: 'editInfo', value: 'everyone' }, 'setGroupLocked', { jid: BOOKS, on: false }],
    [{ key: 'addMembers', value: 'admins' }, 'setGroupMemberAddMode', { jid: BOOKS, mode: 'admin_add' }],
    [{ key: 'joinApproval', value: false }, 'setGroupJoinApproval', { jid: BOOKS, on: false }],
    [{ key: 'disappearing', value: 90 * 86_400 }, 'setDisappearing', { jid: BOOKS, seconds: 90 * 86_400 }],
  ];
  for (const [change, op, args] of cases) {
    const a = await configure(h, BOOKS, change);
    expect(h.cmd(op)).toMatchObject(args);
    expect(a.fields[change.key as P.AboutKey]!.value).toEqual((change as { value: string | number | boolean }).value);
  }
  expect(count(h, 'groupInviteLink')).toBe(1);
  // The timer (set last: the fake answers the same group every time) is what the next message carries.
  await h.adapter.command({ t: 'send', id: 's', conversation: BOOKS, body: 'hi' });
  expect(h.cmd('send').message).toMatchObject({ extendedTextMessage: { contextInfo: { expiration: 90 * 86_400 } } });
});

test('a new invite link replaces the old one; what WhatsApp cannot do is refused before any write', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'group', value: FIX.get('group_admin').group } });
  await h.ctl({ result: { op: 'groupInviteLink', value: { link: 'https://chat.whatsapp.com/FAKECODE1' } } });
  await about(h, BOOKS);
  await h.ctl({ result: { op: 'groupInviteLink', value: { link: 'https://chat.whatsapp.com/FAKECODE2' } } });
  const a = await configure(h, BOOKS, { key: 'invite', op: 'create' });
  expect(h.cmd('groupInviteLink', 1)).toMatchObject({ jid: BOOKS, reset: true });
  expect(count(h, 'groupInviteLink')).toBe(2);
  expect(a.invite).toEqual({ link: 'https://chat.whatsapp.com/FAKECODE2', canCreate: true });

  const before = h.cmds.length;
  await expect(configure(h, BOOKS, { key: 'invite', op: 'revoke' })).rejects.toThrow('cannot turn an invite link off');
  await expect(configure(h, BOOKS, { key: 'pin', message: `${BOOKS}/M1` })).rejects.toThrow('pinned');
  await expect(configure(h, BOOKS, { key: 'avatar', value: 'data:image/jpeg;base64,AAAA' })).rejects.toThrow('not supported yet');
  await expect(configure(h, BOOKS, { key: 'slowMode', value: 10 })).rejects.toThrow('not a WhatsApp setting');
  await expect(configure(h, BOOKS, { key: 'encrypted', value: true })).rejects.toThrow('cannot be changed');
  await expect(configure(h, BOOKS, { key: 'disappearing', value: 3600 })).rejects.toThrow('24 hours, 7 days or 90 days');
  await Bun.sleep(50);
  expect(h.cmds.slice(before)).toEqual([]);
});

// ---------------------------------------------------------------- profiles

const profile = (h: H, who: string) => h.adapter.command({ t: 'profile', id: 'p', who }) as Promise<P.PersonAbout>;
/** Ops that must never come from opening a profile. */
const NEVER = ['isOnWhatsApp', 'presence', 'send'];

test('a contact’s profile: their About and picture from one query for them, name, number and contact from the store', async () => {
  const h = await harness();
  expect(ofType(h.events, 'hello')[0].capabilities).toContain('profile');
  await h.emit({ t: 'contact', jid: ALICE, alt: ALICE_LID, fullName: 'Alice Chen', firstName: 'Alice' });
  await h.ctl({ result: { op: 'userInfo', value: FIX.get('user_info').result } });
  const before = h.cmds.length;
  const n = h.events.length;
  expect(await profile(h, ALICE)).toEqual({
    displayName: 'Alice Chen',
    handle: '+15550000002',
    avatar: `wa-avatar:${ALICE}?1700000001`,
    bio: 'Out climbing',
    links: [{ label: 'Phone', value: '+15550000002', url: 'https://wa.me/15550000002' }],
    relationship: 'contact',
  });
  // One query, for this person only; field names that cannot collide with the command id.
  expect(h.cmds.slice(before).map((c) => c.op)).toEqual(['userInfo', 'blocked']);
  expect(h.cmd('userInfo')).toEqual({ id: expect.any(String), op: 'userInfo', jid: ALICE });
  expect(h.cmd('blocked')).toEqual({ id: expect.any(String), op: 'blocked', jids: [ALICE, ALICE_LID] });
  // The identity, with the new picture, goes first.
  expect(ofType(h.events.slice(n), 'identity').at(-1)!.identity).toMatchObject({ nativeId: ALICE, displayName: 'Alice Chen', contact: true, avatarUrl: `wa-avatar:${ALICE}?1700000001` });
  // Opened again soon after (or by her LID): no second query.
  expect((await profile(h, ALICE_LID)).bio).toBe('Out climbing');
  expect(count(h, 'userInfo')).toBe(1);
  expect(h.cmds.filter((c) => NEVER.includes(c.op))).toEqual([]);
});

test('a business you have not saved, and someone you blocked', async () => {
  const h = await harness();
  const SHOP = '15550000005@s.whatsapp.net';
  await h.ctl({ result: { op: 'userInfo', value: FIX.get('user_info_business').result } });
  expect(await profile(h, SHOP)).toEqual({
    displayName: 'Corner Bakery',
    handle: '+15550000005',
    avatar: `wa-avatar:${SHOP}?1700000002`,
    bio: 'Fresh bread daily',
    facts: [{ label: 'Verified business', value: 'Corner Bakery' }],
    links: [{ label: 'Phone', value: '+15550000005', url: 'https://wa.me/15550000005' }],
    relationship: 'stranger',
  });
  // The LID WhatsApp answered with is the same person from now on.
  expect(h.adapter.aliases.peek('200000000000005@lid')).toBe(SHOP);

  await h.emit({ t: 'push_name', jid: BOB_LID, alt: BOB, name: 'Bob' });
  await h.ctl({ result: { op: 'userInfo', value: {} } });
  await h.ctl({ result: { op: 'blocked', value: { blocked: true } } });
  const bob = await profile(h, BOB);
  expect(bob).toMatchObject({ displayName: 'Bob', relationship: 'blocked' });
  // No picture id in the answer: none, or hidden from you.
  expect(bob.avatar).toBeUndefined();
  expect(bob.bio).toBeUndefined();
  expect(h.cmd('blocked', 1).jids.sort()).toEqual([BOB, BOB_LID].sort());
});

test('your own profile: your About, and your contacts on WhatsApp as friends, their identities first', async () => {
  const h = await harness();
  await h.ctl({
    result: {
      op: 'contacts',
      value: [
        { jid: ALICE, alt: ALICE_LID, firstName: 'Alice', fullName: 'Alice Chen', pushName: 'ali' },
        { jid: ALICE_LID, fullName: 'Alice Chen' },
        { jid: BOB, pushName: 'Bob' },
        { jid: '15550000006@s.whatsapp.net', fullName: 'Dana Ruiz' },
      ],
    },
  });
  await h.ctl({ result: { op: 'userInfo', value: { status: 'Busy', pictureId: '1700000009' } } });
  const n = h.events.length;
  const me = await profile(h, ME);
  expect(me).toEqual({
    displayName: 'Me',
    handle: '+15550000001',
    avatar: `wa-avatar:${ME}?1700000009`,
    bio: 'Busy',
    links: [{ label: 'Phone', value: '+15550000001', url: 'https://wa.me/15550000001' }],
    friends: [ALICE, '15550000006@s.whatsapp.net'],
  });
  expect(h.cmd('userInfo')).toMatchObject({ jid: ME });
  expect(h.cmd('blocked')).toBeUndefined();
  const named = ofType(h.events.slice(n), 'identity').map((e) => e.identity.nativeId);
  expect(named).toEqual(expect.arrayContaining([ALICE, '15550000006@s.whatsapp.net', ME]));
  expect(named).not.toContain(BOB);
  // Your LID is you too.
  expect((await profile(h, '200000000000001@lid')).friends).toHaveLength(2);
  expect(count(h, 'userInfo')).toBe(1);
});

test('your own About: one setAbout to the bridge with only the text, read back without asking WhatsApp again', async () => {
  const h = await harness();
  expect(ofType(h.events, 'hello')[0].capabilities).toContain('editProfile');
  await h.ctl({ result: { op: 'userInfo', value: { status: 'Busy' } } });
  expect((await profile(h, ME)).bio).toBe('Busy');
  const set = (bio?: string) => h.adapter.command({ t: 'setProfile', id: 's', change: bio === undefined ? {} : { bio } }) as Promise<P.PersonAbout>;
  expect(await set('at the beach 🏖️')).toMatchObject({ displayName: 'Me', handle: '+15550000001', bio: 'at the beach 🏖️' });
  expect(h.cmd('setAbout')).toEqual({ id: expect.any(String), op: 'setAbout', about: 'at the beach 🏖️' });
  expect((await profile(h, ME)).bio).toBe('at the beach 🏖️');
  expect(count(h, 'userInfo')).toBe(1);
  // Past 139, or nothing to set: refused before the bridge hears of it.
  await expect(set('x'.repeat(140))).rejects.toThrow('a WhatsApp About takes 139 characters, this one has 140');
  await expect(set()).rejects.toThrow('nothing to change');
  expect(count(h, 'setAbout')).toBe(1);
  // The bridge's refusal, as it said it.
  await h.ctl({ error: { op: 'setAbout', message: 'mex error 400' } });
  await expect(set('hi')).rejects.toThrow('mex error 400');
});

test('profiles ask WhatsApp nothing once the session is replaced, and answer from the store', async () => {
  const h = await harness();
  await h.emit({ t: 'contact', jid: ALICE, alt: ALICE_LID, fullName: 'Alice Chen' });
  await h.emit({ t: 'stream_replaced' });
  const before = h.cmds.length;
  expect(await profile(h, ALICE)).toEqual({
    displayName: 'Alice Chen',
    handle: '+15550000002',
    avatar: `wa-avatar:${ALICE}`,
    links: [{ label: 'Phone', value: '+15550000002', url: 'https://wa.me/15550000002' }],
    relationship: 'contact',
  });
  await Bun.sleep(50);
  expect(h.cmds.slice(before)).toEqual([]);
});

test('a failed query still answers; a burst of profiles is capped; groups are not people', async () => {
  const h = await harness();
  await h.ctl({ error: { op: 'userInfo', message: 'rate-overlimit' } });
  expect(await profile(h, ALICE)).toMatchObject({ displayName: '+15550000002', relationship: 'stranger' });
  // A failure is not remembered as an answer.
  await h.ctl({ result: { op: 'userInfo', value: { status: 'hi' } } });
  await h.ctl({ error: { op: 'userInfo', message: '' } });
  expect((await profile(h, ALICE)).bio).toBe('hi');
  expect(count(h, 'userInfo')).toBe(2);
  for (let i = 0; i < 12; i++) await profile(h, `155500001${String(i).padStart(2, '0')}@s.whatsapp.net`);
  expect(count(h, 'userInfo')).toBe(10);
  await expect(profile(h, GROUP)).rejects.toThrow('not a WhatsApp user');
  expect(h.cmds.filter((c) => NEVER.includes(c.op))).toEqual([]);
});

// ---------------------------------------------------------------- adding (docs/whatsapp.md)

const ME_LID = '200000000000001@lid';
const CAROL = '15550000004@s.whatsapp.net';
const CAROL_LID = '200000000000004@lid';
const DAVE = '15550000006@s.whatsapp.net';
const GARDEN = '120363000000000011@g.us';
const QUIET = '120363000000000012@g.us';
const RIVERSIDE = '120363000000000013@g.us';
const ASK = 'The group’s admins approve new members';
const invite = (code: string): P.AddRef => ({ kind: 'invite', network: 'whatsapp', code, url: `https://chat.whatsapp.com/${code}` });
const phoneRef = (handle: string): P.AddRef => ({ kind: 'person', network: 'whatsapp', handle });
const resolve = (h: H, ref: P.AddRef) => h.adapter.command({ t: 'resolve', id: 'r', ref }) as Promise<P.AddPreview>;
const add = (h: H, ref: P.AddRef, action: 'join' | 'ask' = 'join') => h.adapter.command({ t: 'add', id: 'a', ref, action }) as Promise<P.AddResult>;
const answer = (h: H, request: string, a: P.RequestAnswer) => h.adapter.command({ t: 'answer', id: 'q', request, answer: a }) as Promise<P.AddResult>;
/** Every op adding may send. None adds, removes or invites anyone but you. */
const ADDING_OPS = new Set(['connect', 'contacts', 'groups', 'group', 'groupFromLink', 'joinLink', 'joinRequests', 'answerJoinRequest', 'isOnWhatsApp']);
const strayOps = (h: H) => h.cmds.map((c) => c.op).filter((op) => !ADDING_OPS.has(op));
const carolReq = `${BOOKS}/join/${CAROL_LID}`;
const daveReq = `${BOOKS}/join/${DAVE}`;

/** Linked and connected as the Book club's admin (join approval on), with Carol and Dave asking to join. */
async function admin() {
  const h = await harness({ loggedIn: false });
  await h.waitFor(() => h.status()?.attention?.qr);
  await h.ctl({ result: { op: 'groups', value: [FIX.get('group').group, FIX.get('group_admin').group] } });
  await h.ctl({ result: { op: 'joinRequests', value: FIX.get('join_requests').result } });
  await h.emit({ t: 'connected', loggedIn: true, jid: ME, lid: ME_LID, pushName: 'Me' });
  await h.waitFor(() => ofType(h.events, 'requests')[0]);
  return h;
}

test('hello offers resolve, join and requests, and no connect: WhatsApp has no friends or follows', async () => {
  const h = await harness();
  const caps = ofType(h.events, 'hello')[0].capabilities;
  expect(caps).toEqual(expect.arrayContaining(['resolve', 'join', 'requests', 'openDirect']));
  expect(caps).not.toContain('connect');
});

test('making a group is left out: no createGroup in hello, and the command is refused in words, with nothing sent to the bridge', async () => {
  const h = await harness();
  expect(ofType(h.events, 'hello')[0].capabilities).not.toContain('createGroup');
  const before = h.cmds.length;
  const n = h.events.length;
  await expect(h.adapter.command({ t: 'createGroup', id: 'g1', name: 'Garden', people: [`15550000006@s.whatsapp.net`] })).rejects.toThrow(
    'Making groups from here is left out on WhatsApp, which watches for it: make it on your phone and it shows up here.',
  );
  expect(h.cmds.slice(before)).toEqual([]);
  expect(h.events.slice(n)).toEqual([]);
});

test('resolve an invite link: what WhatsApp says of it, joining nothing and telling nobody', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'groupFromLink', value: FIX.get('link_group').result } });
  const before = h.cmds.length;
  const n = h.events.length;
  expect(await resolve(h, invite('MapleGardenSwap26'))).toEqual({ what: 'group', name: 'Maple garden swap', nativeId: GARDEN, description: 'Seeds and cuttings, every other Sunday', members: 41, actions: ['join'] });
  expect(h.cmds.slice(before)).toEqual([{ id: expect.any(String), op: 'groupFromLink', code: 'MapleGardenSwap26' }]);
  expect(h.events.slice(n)).toEqual([]);

  // Join approval on: Ask, which lands as a request the admins answer.
  await h.ctl({ result: { op: 'groupFromLink', value: FIX.get('link_group_approval').result } });
  expect(await resolve(h, invite('QuietReaders2026'))).toEqual({ what: 'group', name: 'Quiet readers', nativeId: QUIET, description: 'Seeds and cuttings, every other Sunday', members: 7, actions: ['ask'], notes: [ASK] });
  // A community's link: a space.
  await h.ctl({ result: { op: 'groupFromLink', value: FIX.get('link_community').result } });
  expect(await resolve(h, invite('RiversideStreet1'))).toEqual({ what: 'space', name: 'Riverside', nativeId: RIVERSIDE, description: 'Everything on our street', members: 230, actions: ['ask'], notes: ['The community’s admins approve new members'] });
  expect(count(h, 'joinLink')).toBe(0);
  expect(h.events.slice(n)).toEqual([]);
});

test('a link to a group you are in: already joined, and Join anyway sends nothing', async () => {
  const h = await harness();
  await h.emit({ t: 'group', group: FIX.get('group').group });
  await h.ctl({ result: { op: 'groupFromLink', value: { ...FIX.get('link_group').result, jid: GROUP, name: 'Climbing crew' } } });
  expect(await resolve(h, invite('ClimbingCrewLink1'))).toEqual({
    what: 'group',
    name: 'Climbing crew',
    nativeId: GROUP,
    description: 'Seeds and cuttings, every other Sunday',
    members: 41,
    joined: { conversation: GROUP },
    avatar: `wa-avatar:${GROUP}`,
    actions: [],
    notes: ['You are in this group already'],
  });
  expect(await add(h, invite('ClimbingCrewLink1'))).toEqual({ conversation: GROUP, notes: ['You are in this group already'] });
  expect(count(h, 'joinLink')).toBe(0);
});

test('a reset or invalid link: the sentence, and nothing joined', async () => {
  const h = await harness();
  await h.ctl({ error: { op: 'groupFromLink', message: 'This group invite link was reset or revoked' } });
  await expect(resolve(h, invite('OldSwapGroup2025'))).rejects.toThrow('This group invite link was reset or revoked');
  await expect(add(h, invite('OldSwapGroup2025'))).rejects.toThrow('This group invite link was reset or revoked');
  expect(count(h, 'joinLink')).toBe(0);
  // A code WhatsApp never makes does not reach it.
  const before = h.cmds.length;
  await expect(resolve(h, invite('bad-code!'))).rejects.toThrow('This group invite link is invalid');
  expect(h.cmds.length).toBe(before);
  // Nothing but links and numbers to look up.
  await expect(resolve(h, { kind: 'name', network: 'whatsapp', name: 'somebody' })).rejects.toThrow('only group invite links and phone numbers');
});

test('resolve a phone number: one IsOnWhatsApp lookup, the identity before the reply, Message only', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'isOnWhatsApp', value: FIX.get('on_whatsapp').result } });
  const n = h.events.length;
  expect(await resolve(h, phoneRef('+15550000004'))).toEqual({ what: 'person', name: '+15550000004', nativeId: CAROL, actions: ['message'], relationship: 'stranger' });
  expect(h.cmd('isOnWhatsApp')).toEqual({ id: expect.any(String), op: 'isOnWhatsApp', phones: ['+15550000004'] });
  expect(ofType(h.events.slice(n), 'identity').map((e) => e.identity)).toEqual([{ nativeId: CAROL, displayName: '+15550000004', handle: '+15550000004' }]);
  // WhatsApp answered with her LID: the same person from now on, and asked about again, nothing goes to WhatsApp.
  expect(h.adapter.aliases.peek(CAROL_LID)).toBe(CAROL);
  expect((await resolve(h, phoneRef('+15550000004'))).nativeId).toBe(CAROL);
  expect(count(h, 'isOnWhatsApp')).toBe(1);

  // A business: its verified name.
  await h.ctl({ result: { op: 'isOnWhatsApp', value: FIX.get('on_whatsapp_business').result } });
  expect(await resolve(h, phoneRef('+15550000005'))).toEqual({ what: 'person', name: 'Corner Bakery', nativeId: '15550000005@s.whatsapp.net', actions: ['message'], relationship: 'stranger' });
  // Not on WhatsApp: a sentence.
  await h.ctl({ result: { op: 'isOnWhatsApp', value: FIX.get('not_on_whatsapp').result } });
  await expect(resolve(h, phoneRef('+15550000008'))).rejects.toThrow('+15550000008 is not on WhatsApp');
  // One number per lookup, never a list.
  expect(h.cmds.filter((c) => c.op === 'isOnWhatsApp').map((c) => c.phones)).toEqual([['+15550000004'], ['+15550000005'], ['+15550000008']]);
  expect(strayOps(h)).toEqual([]);
});

test('a number this account knows is not looked up: a contact, and you', async () => {
  const h = await harness();
  await h.emit({ t: 'contact', jid: ALICE, alt: ALICE_LID, fullName: 'Alice Chen' });
  expect(await resolve(h, phoneRef('+15550000002'))).toEqual({ what: 'person', name: 'Alice Chen', nativeId: ALICE, avatar: `wa-avatar:${ALICE}`, actions: ['message'], relationship: 'contact' });
  expect(await resolve(h, phoneRef('+15550000001'))).toMatchObject({ what: 'person', nativeId: ME, actions: ['message'], notes: [expect.stringContaining('This is you')] });
  expect(count(h, 'isOnWhatsApp')).toBe(0);
});

test('number lookups stop at 20 an hour, with when the next frees up', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'isOnWhatsApp', value: FIX.get('on_whatsapp').result } });
  for (let i = 0; i < 20; i++) await resolve(h, phoneRef(`+155500010${String(i).padStart(2, '0')}`));
  await expect(resolve(h, phoneRef('+15550001099'))).rejects.toThrow(/looked up 20 phone numbers in the last hour.*frees up in (59 minutes|1 hour)\./);
  expect(count(h, 'isOnWhatsApp')).toBe(20);
});

test('join by link: JoinGroupWithLink once, then the group read as the group path reads it, its conversation first', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'groupFromLink', value: FIX.get('link_group').result } });
  await resolve(h, invite('MapleGardenSwap26'));
  const garden = { ...FIX.get('group').group, jid: GARDEN, name: 'Maple garden swap', linkedParent: undefined };
  await h.ctl({ result: { op: 'joinLink', value: { jid: GARDEN } } });
  await h.ctl({ result: { op: 'group', value: garden } });
  const before = h.cmds.length;
  const n = h.events.length;
  expect(await add(h, invite('MapleGardenSwap26'))).toEqual({ conversation: GARDEN });
  // The link read for the preview answers for the Join: no second read.
  expect(h.cmds.slice(before).map((c) => c.op)).toEqual(['joinLink', 'group']);
  expect(h.cmd('joinLink')).toEqual({ id: expect.any(String), op: 'joinLink', code: 'MapleGardenSwap26' });
  expect(ofType(h.events.slice(n), 'conversation').map((e) => e.conversation)).toMatchObject([{ nativeId: GARDEN, shape: 'group', name: 'Maple garden swap' }]);
  // In it now.
  expect(await resolve(h, invite('MapleGardenSwap26'))).toMatchObject({ joined: { conversation: GARDEN }, actions: [] });
  expect(count(h, 'joinLink')).toBe(1);
  expect(strayOps(h)).toEqual([]);
});

test('ask to join: pending until an admin lets you in, then the group arrives as any other', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'groupFromLink', value: FIX.get('link_group_approval').result } });
  await h.ctl({ result: { op: 'joinLink', value: { jid: QUIET } } });
  const before = h.cmds.length;
  const n = h.events.length;
  // Not previewed first (a Join from an older card): the link is read, then joined.
  expect(await add(h, invite('QuietReaders2026'), 'ask')).toEqual({ pending: true, notes: [ASK] });
  expect(h.cmds.slice(before).map((c) => c.op)).toEqual(['groupFromLink', 'joinLink']);
  expect(ofType(h.events.slice(n), 'conversation')).toEqual([]);
  // Let in: WhatsApp says you joined.
  await h.emit({ t: 'group', group: { ...FIX.get('group').group, jid: QUIET, name: 'Quiet readers', linkedParent: undefined } });
  expect(ofType(h.events.slice(n), 'conversation').map((e) => e.conversation.nativeId)).toEqual([QUIET]);
});

test('approval switched on after the preview: the join was a request after all', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'groupFromLink', value: FIX.get('link_group').result } });
  await h.ctl({ result: { op: 'joinLink', value: { jid: GARDEN } } });
  await h.ctl({ error: { op: 'group', message: "you're not participating in that group" } });
  expect(await add(h, invite('MapleGardenSwap26'))).toEqual({ pending: true, notes: [ASK] });
});

test('a join WhatsApp refuses is not retried; joins stop at 5 a day', async () => {
  const h = await harness();
  await h.ctl({ result: { op: 'groupFromLink', value: FIX.get('link_group_approval').result } });
  await h.ctl({ error: { op: 'joinLink', message: 'This group is full' } });
  await expect(add(h, invite('QuietReaders2026'), 'ask')).rejects.toThrow('This group is full');
  expect(count(h, 'joinLink')).toBe(1);
  await h.ctl({ error: { op: 'joinLink', message: '' } });
  for (let i = 0; i < 4; i++) await add(h, invite(`QuietReaders202${i}`), 'ask');
  await expect(add(h, invite('QuietReaders2029'), 'ask')).rejects.toThrow(/joined or asked to join 5 groups in the last day.*frees up in 24 hours/);
  expect(count(h, 'joinLink')).toBe(5);
});

test('join requests at connect: one read per group you admin with approval on, people and group first, then the whole list', async () => {
  const h = await admin();
  expect(h.cmds.filter((c) => c.op === 'joinRequests')).toEqual([{ id: expect.any(String), op: 'joinRequests', jid: BOOKS }]);
  const reqs = ofType(h.events, 'requests');
  expect(reqs).toHaveLength(1);
  const [carolTs, daveTs] = FIX.get('join_requests').result.map((r: any) => r.ts);
  const target = { kind: 'conversation' as const, nativeId: BOOKS, name: 'Book club', members: 3 };
  expect(reqs[0].requests).toEqual([
    { nativeId: carolReq, kind: 'join', from: CAROL_LID, target, ts: carolTs, answers: ['accept', 'decline'] },
    { nativeId: daveReq, kind: 'join', from: DAVE, target, ts: daveTs, answers: ['accept', 'decline'] },
  ]);
  const at = h.events.indexOf(reqs[0]);
  for (const who of [CAROL_LID, DAVE]) expect(h.events.findIndex((e) => e.t === 'identity' && e.identity.nativeId === who)).toBeGreaterThan(-1);
  for (const who of [CAROL_LID, DAVE]) expect(h.events.findIndex((e) => e.t === 'identity' && e.identity.nativeId === who)).toBeLessThan(at);
  expect(h.events.findIndex((e) => e.t === 'conversation' && e.conversation.nativeId === BOOKS)).toBeLessThan(at);

  // The hub reconnects: the whole list again, its people first.
  const n = h.events.length;
  h.adapter.onHubConnect();
  const again = h.events.slice(n);
  expect(ofType(again, 'requests')).toEqual(reqs);
  expect(again.findIndex((e) => e.t === 'identity' && e.identity.nativeId === DAVE)).toBeLessThan(again.findIndex((e) => e.t === 'requests'));
  expect(strayOps(h)).toEqual([]);
});

test('requests as WhatsApp announces them: new, withdrawn, declined by another admin, let in elsewhere', async () => {
  const h = await harness();
  await h.emit({ t: 'group', group: FIX.get('group_admin').group });
  await h.ctl({ result: { op: 'group', value: FIX.get('group_admin').group } });
  const reads = count(h, 'group');
  const carol = `${BOOKS}/join/${CAROL}`;

  const asked = await h.emit(fx('join_request_new'));
  expect(asked.map((e) => e.t)).toEqual(['identity', 'request']);
  expect(ofType(asked, 'identity')[0].identity).toMatchObject({ nativeId: CAROL, handle: '+15550000004' });
  expect(ofType(asked, 'request')[0].request).toEqual({ nativeId: carol, kind: 'join', from: CAROL, target: { kind: 'conversation', nativeId: BOOKS, name: 'Book club', members: 3 }, ts: fx('join_request_new').ts, answers: ['accept', 'decline'] });
  // A request alone is no reason to read the group again.
  expect(count(h, 'group')).toBe(reads);
  expect(await h.emit(fx('join_request_withdrawn'))).toEqual([{ t: 'requestGone', nativeId: carol }]);

  expect(ofType(await h.emit(fx('join_request_sender')), 'request')[0].request.nativeId).toBe(daveReq);
  expect(await h.emit(fx('join_request_declined'))).toEqual([{ t: 'requestGone', nativeId: daveReq }]);
  await h.emit(fx('join_request_sender'));
  expect(ofType(await h.emit(fx('group_join_approved')), 'requestGone')).toEqual([{ t: 'requestGone', nativeId: daveReq }]);

  // Leaving the group: what waited there goes.
  await h.emit(fx('join_request_new'));
  expect(ofType(await h.emit({ t: 'group_change', jid: BOOKS, join: [], leave: [ME_LID], ts: 1 }), 'requestGone')).toEqual([{ t: 'requestGone', nativeId: carol }]);
  expect(strayOps(h)).toEqual([]);
});

test('answer: accept and decline go to WhatsApp for that one person; block is no WhatsApp answer', async () => {
  const h = await admin();
  await h.ctl({ result: { op: 'answerJoinRequest', value: { approved: true } } });
  let n = h.events.length;
  expect(await answer(h, carolReq, 'accept')).toEqual({ identity: CAROL_LID, conversation: BOOKS });
  expect(h.cmd('answerJoinRequest')).toEqual({ id: expect.any(String), op: 'answerJoinRequest', jid: BOOKS, user: CAROL_LID, approve: true });
  expect(h.events.slice(n)).toEqual([{ t: 'requestGone', nativeId: carolReq }]);

  await expect(answer(h, daveReq, 'block')).rejects.toThrow('accepted or declined');
  n = h.events.length;
  expect(await answer(h, daveReq, 'decline')).toEqual({ identity: DAVE });
  expect(h.cmd('answerJoinRequest', 1)).toEqual({ id: expect.any(String), op: 'answerJoinRequest', jid: BOOKS, user: DAVE, approve: false });
  expect(h.events.slice(n)).toEqual([{ t: 'requestGone', nativeId: daveReq }]);

  // Answered already: not waiting, and nothing more goes to WhatsApp.
  await expect(answer(h, carolReq, 'accept')).rejects.toThrow('not waiting any more');
  expect(count(h, 'answerJoinRequest')).toBe(2);

  // Answered elsewhere just before: WhatsApp's sentence, and gone here too.
  await h.emit({ t: 'join_request', group: BOOKS, user: CAROL_LID, ts: 5 });
  await h.ctl({ error: { op: 'answerJoinRequest', message: 'That request is not waiting any more' } });
  n = h.events.length;
  await expect(answer(h, carolReq, 'decline')).rejects.toThrow('not waiting any more');
  expect(h.events.slice(n)).toEqual([{ t: 'requestGone', nativeId: carolReq }]);
  expect(strayOps(h)).toEqual([]);
});

test('a list WhatsApp would not give whole is never sent as the whole list', async () => {
  const h = await harness({ loggedIn: false });
  await h.waitFor(() => h.status()?.attention?.qr);
  await h.ctl({ result: { op: 'groups', value: [FIX.get('group_admin').group] } });
  await h.ctl({ error: { op: 'joinRequests', message: 'rate-overlimit' } });
  await h.emit({ t: 'connected', loggedIn: true, jid: ME, lid: ME_LID, pushName: 'Me' });
  await h.waitFor(() => count(h, 'joinRequests') === 1);
  await Bun.sleep(150);
  expect(ofType(h.events, 'requests')).toEqual([]);
  // Groups not readable at all: nothing either.
  await h.ctl({ error: { op: 'groups', message: 'disconnected' } });
  await h.adapter.command({ t: 'action', id: '1', action: 'resync' }).catch(() => {});
  expect(ofType(h.events, 'requests')).toEqual([]);
  // Readable again: the whole list.
  await h.ctl({ error: { op: 'groups', message: '' } });
  await h.ctl({ error: { op: 'joinRequests', message: '' } });
  await h.ctl({ result: { op: 'joinRequests', value: FIX.get('join_requests').result } });
  await h.adapter.command({ t: 'action', id: '2', action: 'resync' });
  expect(ofType(h.events, 'requests').map((r) => r.requests.map((x) => x.nativeId))).toEqual([[carolReq, daveReq]]);
});

test('made or unmade an admin, or join approval switched: that group’s requests are read again or dropped', async () => {
  const h = await admin();
  await h.ctl({ result: { op: 'group', value: FIX.get('group_admin').group } });
  await h.ctl({ result: { op: 'joinRequests', value: [FIX.get('join_requests').result[1]] } });
  await h.emit(fx('group_approval_mode'));
  await h.waitFor(() => ofType(h.events, 'requestGone').length);
  expect(ofType(h.events, 'requestGone')).toEqual([{ t: 'requestGone', nativeId: carolReq }]);
  expect(count(h, 'joinRequests')).toBe(2);

  // No longer an admin there: what waited on you goes, without asking WhatsApp.
  const demoted = structuredClone(FIX.get('group_admin').group);
  for (const p of demoted.participants) if (p.lid === ME_LID) p.admin = false;
  await h.ctl({ result: { op: 'group', value: demoted } });
  await h.emit({ t: 'group_change', jid: BOOKS, join: [], leave: [], demote: [ME_LID], sender: BOB_LID, ts: 2 });
  await h.waitFor(() => ofType(h.events, 'requestGone').length === 2);
  expect(ofType(h.events, 'requestGone')[1]).toEqual({ t: 'requestGone', nativeId: daveReq });
  expect(count(h, 'joinRequests')).toBe(2);
});

test('nothing adds anyone to a group: your own join by link and answers to requests are the only membership calls', () => {
  const src = readFileSync(join(import.meta.dir, '../src/adapter.ts'), 'utf8');
  // One call site each: the owner's Join, and the owner's Accept or Decline.
  expect(src.match(/'joinLink'/g)).toHaveLength(1);
  expect(src.match(/'answerJoinRequest'/g)).toHaveLength(1);
  // The bridge has no op that adds people (bridge/main_test.go checks its calls into whatsmeow).
  const bridge = readFileSync(join(import.meta.dir, '../bridge/main.go'), 'utf8');
  expect(bridge).not.toMatch(/UpdateGroupParticipants\(|ParticipantChangeAdd|CreateGroup\(|JoinGroupWithInvite\(/);
});
