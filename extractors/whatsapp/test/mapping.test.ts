/**
 * Bridge events -> facts, with fixtures the bridge itself printed (`dither-wa-bridge --print-fixtures`
 * from real whatsmeow types), so field names and shapes are WhatsApp's, not guesses.
 */
import { beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { Aliases, bare, Mapper, msgId } from '../src/mapping.ts';
import { State } from '../src/state.ts';

const FIX = new Map<string, any>(
  readFileSync(join(import.meta.dir, 'fixtures/events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .map((e) => [e.fixture, e]),
);
const fx = (name: string) => structuredClone(FIX.get(name)!);

const ME = '15550000001@s.whatsapp.net';
const ME_LID = '200000000000001@lid';
const ALICE = '15550000002@s.whatsapp.net';
const ALICE_LID = '200000000000002@lid';
const BOB = '15550000003@s.whatsapp.net';
const BOB_LID = '200000000000003@lid';
const GROUP = '120363000000000001@g.us';

let st: State;
let al: Aliases;
let m: Mapper;
const names: Record<string, string> = { [ALICE]: 'Alice', [BOB]: 'Bob' };

beforeEach(() => {
  st = new State(join(mkdtempSync(join(tmpdir(), 'wa-map-')), 'state.db'));
  al = new Aliases(st);
  m = new Mapper(st, al, () => ({ id: al.id(ME), jids: [ME, ME_LID] }), (id) => names[id] ?? id);
});

/** Map an event and keep what the adapter would keep. */
function run(ev: any) {
  const o = m.message(ev);
  for (const r of o.remember) st.putMsg(r);
  for (const id of o.forget) st.dropMsg(id);
  return o;
}
const facts = (o: ReturnType<typeof run>) => o.events.filter((e): e is Extract<P.AdapterEvent, { t: 'message' }> => e.t === 'message').map((e) => e.message);

test('JIDs lose their device part', () => {
  expect(bare('15550000002:12@s.whatsapp.net')).toBe(ALICE);
  expect(bare('15550000002.0:3@s.whatsapp.net')).toBe(ALICE);
  expect(bare('15550000002@c.us')).toBe(ALICE);
  expect(bare(GROUP)).toBe(GROUP);
});

test('aliases: a pair is pinned to the phone number, and the first published id sticks', () => {
  al.link(ALICE_LID, ALICE);
  expect(al.id(ALICE_LID)).toBe(ALICE);
  // Bob shows up by LID alone first: that id stays his, even once his number is known.
  expect(al.id(BOB_LID)).toBe(BOB_LID);
  al.link(BOB, BOB_LID);
  expect(al.id(BOB)).toBe(BOB_LID);
  expect(al.jids(BOB_LID)).toEqual([BOB, BOB_LID]);
});

test('a DM text: conversation is the peer, styling converted, sender LID linked', () => {
  const o = run(fx('text'));
  const [f] = facts(o);
  expect(f).toMatchObject({ nativeId: msgId(ALICE, 'A1'), conversation: ALICE, author: ALICE, kind: 'text', body: 'hey, **lunch** tomorrow?' });
  expect(o.events[0]).toMatchObject({ live: true });
  expect(al.id(ALICE_LID)).toBe(ALICE);
  expect(o.touched).toEqual([{ id: ALICE, jid: ALICE, ts: f.ts, group: false }]);
});

test('your own message is authored by you, in the DM with the peer', () => {
  const [f] = facts(run(fx('own_text')));
  expect(f).toMatchObject({ conversation: ALICE, author: ME, body: 'sure ~~maybe~~' });
});

test('a group reply that mentions you: LID sender becomes the phone-number identity', () => {
  const [f] = facts(run(fx('reply_mention')));
  expect(f).toMatchObject({ conversation: GROUP, author: BOB, body: `<@${ME}> see above`, replyTo: msgId(GROUP, 'G0'), mentionsSelf: true });
});

test('media: one attachment served through the adapter, caption as body', () => {
  const [img] = facts(run(fx('image')));
  expect(img.attachments).toEqual([{ kind: 'image', mime: 'image/jpeg', name: 'image.jpg', url: `wa-media:${msgId(ALICE, 'A3')}`, size: 48213, width: 1280, height: 960 }]);
  expect(img).toMatchObject({ kind: 'text', body: 'look' });
  // the thumbnail never reached us, the media key did (for downloading)
  expect(JSON.stringify(st.msg(img.nativeId)!.content)).not.toContain('JPEGThumbnail');
  expect(st.msg(img.nativeId)!.content!.imageMessage!.mediaKey).toBeTruthy();

  const [doc] = facts(run(fx('document')));
  expect(doc.attachments![0]).toMatchObject({ kind: 'file', name: 'plan.pdf', mime: 'application/pdf' });
  expect(doc.body).toBe('the plan');

  const [voice] = facts(run(fx('voice')));
  expect(voice).toMatchObject({ kind: 'media', body: '' });
  expect(voice.attachments![0]).toMatchObject({ kind: 'audio', name: 'voice-message.ogg' });

  const [sticker] = facts(run(fx('sticker')));
  expect(sticker.kind).toBe('sticker');
  expect(sticker.attachments![0]).toMatchObject({ kind: 'image', mime: 'image/webp' });

  const [video] = facts(run(fx('video')));
  expect(video.attachments![0]).toMatchObject({ kind: 'video', size: 2_000_000 });
});

test('reactions: one per person, a removal names what it removes', () => {
  run(fx('own_text'));
  const add = run(fx('reaction'));
  expect(add.events).toEqual([{ t: 'reaction', conversation: ALICE, message: msgId(ALICE, 'A2'), author: ALICE, key: '❤️' }]);
  // a different emoji from the same person replaces the first
  const swap = fx('reaction');
  swap.message.reactionMessage.text = '😂';
  expect(run(swap).events).toEqual([
    { t: 'reaction', conversation: ALICE, message: msgId(ALICE, 'A2'), author: ALICE, key: '❤️', remove: true },
    { t: 'reaction', conversation: ALICE, message: msgId(ALICE, 'A2'), author: ALICE, key: '😂' },
  ]);
  expect(run(fx('unreaction')).events).toEqual([{ t: 'reaction', conversation: ALICE, message: msgId(ALICE, 'A2'), author: ALICE, key: '😂', remove: true }]);
  // nothing left to remove
  expect(run(fx('unreaction')).events).toEqual([]);
});

test('an edit re-sends the original with its time and the new body', () => {
  const [orig] = facts(run(fx('text')));
  const [edited] = facts(run(fx('edit')));
  expect(edited).toMatchObject({ nativeId: orig.nativeId, ts: orig.ts, author: ALICE, body: 'hey, **dinner** tomorrow?' });
  expect(edited.editedTs).toBeGreaterThan(orig.ts);
});

test('a caption edit keeps the media', () => {
  run(fx('image'));
  const ev = fx('edit');
  ev.message.protocolMessage.key.ID = 'A3';
  ev.message.protocolMessage.editedMessage = { conversation: 'better caption' };
  const [f] = facts(run(ev));
  expect(f.body).toBe('better caption');
  expect(f.attachments).toHaveLength(1);
});

test('a revoke deletes, and forgets the message', () => {
  run(fx('text'));
  const o = run(fx('revoke'));
  expect(o.events).toEqual([{ t: 'delete', conversation: ALICE, nativeId: msgId(ALICE, 'A1') }]);
  expect(st.msg(msgId(ALICE, 'A1'))).toBeUndefined();
});

test('forwarded, location, contact, poll', () => {
  expect(facts(run(fx('forwarded')))[0]).toMatchObject({ body: 'chain letter', forward: {} });
  expect(facts(run(fx('location')))[0].body).toBe('📍 Alexanderplatz\nhttps://www.openstreetmap.org/?mlat=52.52&mlon=13.405#map=16/52.52/13.405');
  expect(facts(run(fx('contact_card')))[0].body).toBe('👤 Carol · +1 555 000 0004');
  expect(facts(run(fx('poll')))[0].body).toBe('📊 **Pizza?**\n• yes\n• no\n_Vote on your phone._');
});

test('view-once media is not shown, kept or forwardable', () => {
  const o = run(fx('view_once'));
  const [f] = facts(o);
  expect(f.attachments).toBeUndefined();
  expect(f.body).toContain('View-once photo');
  expect(st.msg(f.nativeId)!.content).toBeNull();
});

test('history: backfill (no notifications), reactions snapshot, system lines', () => {
  run(fx('reply_mention')); // links Bob's LID to his number
  const [h] = facts(run(fx('history_text')));
  expect(h).toMatchObject({ conversation: GROUP, author: BOB, body: 'old news', reactions: [{ key: '👍', authors: [ME] }] });
  expect(run(fx('history_text')).events[0]).toMatchObject({ live: false });
  expect(st.reaction(h.nativeId, ME)).toBe('👍');
  run(fx('text')); // links Alice
  const [stub] = facts(run(fx('history_stub')));
  expect(stub).toMatchObject({ kind: 'system', body: 'Bob added Alice.' });
});

test('a pin: who pinned which message, until the time the pinner chose; an unpin ends it', () => {
  run(fx('own_text'));
  const pin = fx('pin');
  const o = run(pin);
  expect(o.events).toEqual([{ t: 'pin', conversation: ALICE, message: msgId(ALICE, 'A2'), pinned: true, by: ALICE, ts: pin.info.ts }]);
  // Nothing to show as a message, and nothing kept as one.
  expect(o.remember).toEqual([]);
  const week = pin.info.ts + 7 * 86_400_000;
  expect(st.lapsedPins(week - 1)).toEqual([]);
  expect(st.lapsedPins(week)).toEqual([{ msg: msgId(ALICE, 'A2'), conversation: ALICE, expires: week }]);
  // Lapsed once is lapsed: the same pin sent again (a history resync) does not bring it back.
  run(pin);
  expect(st.lapsedPins(Number.MAX_SAFE_INTEGER)).toEqual([]);
});

test('an unpin before the time is up: nothing left to lapse', () => {
  run(fx('own_text'));
  run(fx('pin'));
  const unpin = fx('unpin');
  expect(run(unpin).events).toEqual([{ t: 'pin', conversation: ALICE, message: msgId(ALICE, 'A2'), pinned: false, by: ALICE, ts: unpin.info.ts }]);
  expect(st.lapsedPins(Number.MAX_SAFE_INTEGER)).toEqual([]);
});

test('a pin in a group by someone addressed by LID, for 24 hours', () => {
  const ev = fx('pin_group');
  expect(run(ev).events).toEqual([{ t: 'pin', conversation: GROUP, message: msgId(GROUP, 'G1'), pinned: true, by: BOB, ts: ev.info.ts }]);
  expect(st.lapsedPins(ev.info.ts + 86_400_000)).toHaveLength(1);
});

test('history: a pin and an admin made, from their stubs', () => {
  al.link(ALICE, ALICE_LID);
  al.link(BOB, BOB_LID);
  const pin = fx('history_pin');
  expect(run(pin).events).toEqual([{ t: 'pin', conversation: GROUP, message: msgId(GROUP, 'H1'), pinned: true, by: BOB, ts: pin.info.ts }]);
  // Its day is long over: the sweep unpins it.
  expect(st.lapsedPins(Date.now())).toEqual([{ msg: msgId(GROUP, 'H1'), conversation: GROUP, expires: pin.info.ts + 86_400_000 }]);

  const promote = fx('history_promote');
  const o = run(promote);
  expect(facts(o)).toMatchObject([{ kind: 'system', body: 'Bob made Alice an admin.' }]);
  expect(o.events.filter((e) => e.t === 'role')).toEqual([{ t: 'role', target: { kind: 'conversation', nativeId: GROUP }, member: ALICE, role: 'Admin', given: true, by: BOB, ts: promote.info.ts }]);
  const demote = fx('history_promote');
  demote.web.messageStubType = 'GROUP_PARTICIPANT_DEMOTE';
  expect(run(demote).events.filter((e) => e.t === 'role')).toMatchObject([{ member: ALICE, given: false }]);
});

test('broadcast stories and channels are ignored', () => {
  const ev = fx('text');
  ev.info.chat = 'status@broadcast';
  expect(run(ev).events).toEqual([]);
  ev.info.chat = '120363000000000099@newsletter';
  expect(run(ev).events).toEqual([]);
});

test('a key share or an empty envelope shows nothing', () => {
  const ev = fx('text');
  ev.message = { senderKeyDistributionMessage: { groupID: GROUP }, messageContextInfo: {} };
  expect(run(ev).events).toEqual([]);
});

test('an unknown message type says so instead of vanishing', () => {
  const ev = fx('text');
  ev.message = { someFutureMessage: { foo: 1 } };
  const [f] = facts(run(ev));
  expect(f).toMatchObject({ kind: 'system', extra: { waType: 'someFutureMessage' } });
});

test('groups: a community is a space, its groups are channels in it, the announcement group first', () => {
  const g = m.group(fx('group').group);
  expect(g.conversation).toMatchObject({ nativeId: GROUP, shape: 'channel', variant: 'text', name: 'Climbing crew', topic: 'Tuesdays', spaces: [{ nativeId: '120363000000000009@g.us', position: '1' }] });
  expect(g.conversation!.participants).toEqual([BOB, ME].map((j) => al.id(j)));
  const c = m.group(fx('community').group);
  expect(c.conversation).toBeUndefined();
  expect(c.space).toMatchObject({ nativeId: '120363000000000009@g.us', kind: 'community', name: 'Neighbourhood' });
  const a = m.group(fx('announcements').group);
  expect(a.conversation).toMatchObject({ shape: 'channel', variant: 'announcement', spaces: [{ nativeId: '120363000000000009@g.us', position: '0' }] });
  // a group outside any community
  const plain = fx('group').group;
  delete plain.linkedParent;
  expect(m.group(plain).conversation).toMatchObject({ shape: 'group' });
  expect(m.group(plain).conversation!.spaces).toBeUndefined();
});

test('history conversations: mute, archive, unread, LID chats under the phone number', () => {
  const ev = fx('history');
  const [grp, dm] = ev.conversations.map((c: any) => m.historyConversation(c));
  expect(grp).toMatchObject({ chat: GROUP, unread: 3, patch: { archived: false, name: 'Climbing crew', mute: { level: 'none', until: 1760259200000 } } });
  // the DM came keyed by LID with its phone number alongside
  expect(dm.chat).toBe(ALICE_LID);
  expect(m.convId(dm.chat)).toBe(ALICE);
  expect(dm.patch.archived).toBe(true);
});

test('the chat with yourself is a self conversation', () => {
  expect(m.direct(ME)).toMatchObject({ shape: 'self', participants: [ME] });
  expect(m.direct(ME_LID).nativeId).toBe(ME);
  expect(m.direct(ALICE)).toMatchObject({ shape: 'direct', participants: [ME, ALICE] });
});

test('an invitation message: its line, and the invite kept on the message (nothing joins from it yet)', () => {
  const ev = fx('group_invite');
  const fact = (m.message(ev).events.find((e) => e.t === 'message') as Extract<P.AdapterEvent, { t: 'message' }>).message;
  expect(fact).toMatchObject({ author: ALICE, body: 'Invitation to join “Book club”\ncome read with us' });
  expect(fact.extra).toEqual({ waGroupInvite: { group: '120363000000000002@g.us', code: 'FakeInviteCode01', expires: Number(ev.message.groupInviteMessage.inviteExpiration) * 1000 } });
  // Without a code there is nothing to keep.
  delete ev.message.groupInviteMessage.inviteCode;
  const plain = (m.message({ ...ev, info: { ...ev.info, id: 'A19' } }).events.find((e) => e.t === 'message') as Extract<P.AdapterEvent, { t: 'message' }>).message;
  expect(plain.extra).toBeUndefined();
});
