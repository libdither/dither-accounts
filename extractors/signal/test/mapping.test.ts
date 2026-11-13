/**
 * Envelope -> fact mapping, against fixtures in the exact JSON shapes
 * signal-cli 0.14 writes (the `params` of a JSON-RPC `receive` notification:
 * `{account, envelope}`, assembled from its Json* records: JsonMessageEnvelope,
 * JsonDataMessage, JsonSyncDataMessage with the data message unwrapped into
 * it, JsonQuote, JsonMention, JsonTextStyle, JsonAttachment, JsonReaction,
 * JsonEditMessage, JsonSyncReadMessage, JsonTypingMessage, JsonCallMessage, JsonReceiptMessage, JsonPinMessage,
 * JsonUnpinMessage).
 *
 * People: self 5f2c7a8e-…-0001 (+15550100), Alice a11ce000-…-0002 (+15550137),
 * Sam 5a3e0000-…-0003 (+15550161); group Cl1mb1ngCrew+Gr0up…= ("Climbing crew 🧗").
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterEvent, MessageFact } from '@dither-chat/protocol';
import {
  adminChanges,
  contactIdentity,
  describeGroupChange,
  directConversation,
  displayNameOf,
  groupConversation,
  type MapContext,
  mapReceive,
  noteToSelf,
  parseConversation,
  parseMsgId,
  personAbout,
  quoteAttachment,
  quoteSource,
} from '../src/mapping.ts';
import type { SigContact, SigGroup, SigReceive } from '../src/types.ts';

const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const SAM = '5a3e0000-3333-4eee-afff-000000000003';
const GID = 'Cl1mb1ngCrew+Gr0up0000000000000000000000000=';
const GROUP = `group:${GID}`;
const DM_ALICE = `dm:${SELF}:${ALICE}`;
const T = 1793330000000;
const DIR = '/data/accounts/acc_x/signal-cli';

const fixture = (name: string): SigReceive => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', `${name}.json`), 'utf8'));

const index = new Map<string, string>([
  [`${ALICE}:${T + 2000}`, DM_ALICE],
  [`${ALICE}:${T + 3000}`, DM_ALICE],
]);
const ctx = (over: Partial<MapContext> = {}): MapContext => ({
  self: SELF,
  selfNumber: '+15550100',
  signalDir: DIR,
  conversationOf: (id) => index.get(id),
  knownGroup: (g) => g === GID,
  sticker: (pack, id) => (pack === '9acc9e8aba563d26a4994e69263e3b25' && id === 7 ? { emoji: '🧗', contentType: 'image/webp' } : undefined),
  ...over,
});
const map = (name: string, over?: Partial<MapContext>) => mapReceive(fixture(name), ctx(over));
const of = <K extends AdapterEvent['t']>(events: AdapterEvent[], t: K) => events.filter((e): e is Extract<AdapterEvent, { t: K }> => e.t === t);
const message = (events: AdapterEvent[]): MessageFact => {
  const m = of(events, 'message');
  expect(m).toHaveLength(1);
  expect(m[0].live).toBe(true);
  return m[0].message;
};

describe('incoming data messages', () => {
  test('group text with body ranges and mentions', () => {
    const r = map('text-styles-mentions');
    expect(of(r.events, 'identity')).toEqual([{ t: 'identity', identity: { nativeId: ALICE, handle: '+15550137', displayName: 'Alice Chen' } }]);
    expect(message(r.events)).toEqual({
      nativeId: `${ALICE}:${T + 1000}`,
      conversation: GROUP,
      author: ALICE,
      ts: T + 1000,
      kind: 'text',
      body: `Hey <@${SELF}> and <@${SAM}>, the **purple V4** is *evil*. It was ~~easy~~. Spoiler: ||I flashed it||. Beta: \`heel hook\``,
      mentionsSelf: true,
      // Which of Alice's devices sent it and when Signal's server had it, kept as they came.
      extra: { sourceDevice: expect.any(Number), serverReceivedTs: T + 1180, serverDeliveredTs: expect.any(Number) },
    });
    expect(of(r.events, 'conversation')).toHaveLength(0); // known group: no stub
    expect(r.messages[0]).toMatchObject({ nativeId: `${ALICE}:${T + 1000}`, conversation: GROUP, author: ALICE, kind: 'text', timer: 0 });
  });

  test('unknown group: stub conversation from groupInfo and a refresh request', () => {
    const r = map('text-styles-mentions', { knownGroup: () => false });
    expect(of(r.events, 'conversation')).toEqual([{ t: 'conversation', conversation: { nativeId: GROUP, shape: 'group', encrypted: true, name: 'Climbing crew 🧗' } }]);
    expect(r.refreshGroups).toEqual([GID]);
  });

  test('reply in a 1:1: replyTo from the quote, quote kept as fallback', () => {
    const r = map('reply-quote');
    expect(of(r.events, 'conversation')).toEqual([{ t: 'conversation', conversation: { nativeId: DM_ALICE, shape: 'direct', participants: [SELF, ALICE], encrypted: true } }]);
    const m = message(r.events);
    expect(m.conversation).toBe(DM_ALICE);
    expect(m.replyTo).toBe(`${SELF}:${T - 60000}`);
    expect(m.body).toBe("perfect, I'll bring the spare chalk bag");
    expect(m.mentionsSelf).toBeUndefined();
    expect(m.extra).toMatchObject({ quote: { author: SELF, ts: T - 60000, text: 'yes! **7pm** at Mesa?' } });
    expect((m.extra!.quote as object as { attachments?: unknown }).attachments).toBeUndefined();
  });

  test('attachments: file:// under the account dir, long-text attachment dropped', () => {
    const r = map('attachment');
    const m = message(r.events);
    expect(m.kind).toBe('media');
    expect(m.body).toBe('here is the purple V4');
    expect(m.attachments).toEqual([
      { nativeId: 'Xq3vM8kTt0aQ1bC2dE4f.jpg', kind: 'image', mime: 'image/jpeg', name: 'v4.jpg', size: 183424, width: 1600, height: 1200, url: `file://${DIR}/attachments/Xq3vM8kTt0aQ1bC2dE4f.jpg` },
      { nativeId: 'Vn0te1aac2bbb3ccc4dd.aac', kind: 'audio', mime: 'audio/aac', name: 'Vn0te1aac2bbb3ccc4dd.aac', size: 9001, url: `file://${DIR}/attachments/Vn0te1aac2bbb3ccc4dd.aac` },
    ]);
    expect(r.messages[0].files).toEqual([`${DIR}/attachments/Xq3vM8kTt0aQ1bC2dE4f.jpg`, `${DIR}/attachments/Vn0te1aac2bbb3ccc4dd.aac`]);
  });

  test('attachment ids cannot escape the attachments dir', () => {
    const rcv = fixture('attachment');
    rcv.envelope!.dataMessage!.attachments![0].id = '../../../secret.json';
    const m = message(mapReceive(rcv, ctx()).events);
    expect(m.attachments![0].url).toBe(`file://${DIR}/attachments/secret.json`);
  });

  test('reaction add and remove', () => {
    expect(of(map('reaction-add').events, 'reaction')).toEqual([{ t: 'reaction', conversation: GROUP, message: `${ALICE}:${T + 1000}`, author: SAM, key: '🔥' }]);
    expect(of(map('reaction-remove').events, 'reaction')).toEqual([{ t: 'reaction', conversation: GROUP, message: `${ALICE}:${T + 1000}`, author: SAM, key: '🔥', remove: true }]);
    expect(of(map('reaction-add').events, 'message')).toHaveLength(0);
  });

  test('remote delete', () => {
    const r = map('remote-delete');
    expect(of(r.events, 'delete')).toEqual([{ t: 'delete', conversation: DM_ALICE, nativeId: `${ALICE}:${T + 2000}` }]);
    expect(of(r.events, 'message')).toHaveLength(0);
  });

  test('edit re-emits the target message with the new body and editedTs', () => {
    const m = message(map('edit').events);
    expect(m).toMatchObject({
      nativeId: `${ALICE}:${T + 2000}`,
      conversation: DM_ALICE,
      author: ALICE,
      ts: T + 2000,
      editedTs: T + 7000,
      body: "perfect, I'll bring **TWO** chalk bags",
      replyTo: `${SELF}:${T - 60000}`,
    });
    expect(m.attachments).toBeUndefined(); // edits never wipe attachments
  });

  test('group update: system message plus a group refresh', () => {
    const r = map('group-update');
    expect(message(r.events)).toEqual({ nativeId: `${SAM}:${T + 8000}`, conversation: GROUP, author: SAM, ts: T + 8000, kind: 'system', body: 'Sam Rivera updated the group.' });
    expect(r.refreshGroups).toEqual([GID]);
    expect(r.messages[0].groupUpdate).toBe(GID);
  });

  test('sticker', () => {
    const m = message(map('sticker').events);
    expect(m).toMatchObject({ kind: 'sticker', body: '🧗', conversation: GROUP, author: SAM });
    expect(m.attachments).toEqual([{ nativeId: 'sticker:9acc9e8aba563d26a4994e69263e3b25:7', kind: 'image', mime: 'image/webp', name: 'sticker', url: `file://${DIR}/stickers/9acc9e8aba563d26a4994e69263e3b25/7` }]);
  });

  test('disappearing-message timer change is a system message', () => {
    const r = map('expiration-update');
    expect(message(r.events)).toMatchObject({ kind: 'system', body: 'Alice Chen set disappearing messages to 1 week.', conversation: DM_ALICE });
    expect(r.messages[0].timer).toBe(604800);
  });

  test('disappearing message carries its timer and files', () => {
    const r = map('disappearing');
    expect(message(r.events).extra).toMatchObject({ expiresInSeconds: 3600 });
    expect(r.messages[0]).toMatchObject({ expiresInSeconds: 3600, timer: 3600, files: [`${DIR}/attachments/D00rC0de1jpg2aaa3bbb.jpg`] });
  });

  test('view-once media stays on the phone', () => {
    const m = message(map('view-once').events);
    expect(m.kind).toBe('media');
    expect(m.attachments).toBeUndefined();
    expect(m.extra).toMatchObject({ viewOnce: true });
    expect(m.extra!.attachmentNotes).toBeUndefined();
  });

  test('incoming call offer', () => {
    expect(message(map('call-offer').events)).toEqual({ nativeId: `${ALICE}:${T + 16000}`, conversation: DM_ALICE, author: ALICE, ts: T + 16000, kind: 'call', body: '📹 Incoming video call' });
  });

  test('group call updates are deduplicated by era', () => {
    const seen = new Set<string>();
    const once = (k: string) => (seen.has(k) ? false : (seen.add(k), true));
    expect(message(map('group-call', { once }).events)).toMatchObject({ kind: 'call', body: '📞 Sam Rivera started a group call' });
    expect(of(map('group-call', { once }).events, 'message')).toHaveLength(0);
  });

  test('pin, poll', () => {
    expect(message(map('pin').events)).toMatchObject({ kind: 'system', body: 'Alice Chen pinned a message.', replyTo: `${SAM}:${T + 14000}` });
    expect(message(map('poll').events)).toMatchObject({ kind: 'text', body: '📊 **Thursday or Friday?**\n• Thursday\n• Friday' });
  });

  test("a poll is structured on its message, options by position", () => {
    expect(message(map('poll').events).extra?.poll).toEqual({ question: 'Thursday or Friday?', options: [{ id: '0', text: 'Thursday' }, { id: '1', text: 'Friday' }] });
  });

  test("a vote is the voter's whole vote with its number, on the poll's message; a vote names nobody else", () => {
    const r = map('poll-vote');
    expect(of(r.events, 'message')).toEqual([]);
    expect(of(r.events, 'pollUpdate')).toEqual([{ t: 'pollUpdate', conversation: GROUP, message: `${SAM}:${T + 26000}`, vote: { voter: ALICE, options: ['1'], seq: 2, ts: T + 27000 } }]);
    // Taken back: no options. A poll author named by number only resolves like a pin's target.
    const back = fixture('poll-vote');
    Object.assign(back.envelope!.dataMessage!.pollVote!, { optionIndexes: [], authorUuid: null });
    expect(of(mapReceive(back, ctx({ aciOfNumber: (n) => (n === '+15550161' ? SAM : undefined) })).events, 'pollUpdate')[0]).toMatchObject({ vote: { options: [], seq: 2 } });
    expect(of(mapReceive(back, ctx()).events, 'pollUpdate')).toEqual([]);
  });

  test('a poll ended by its author: a line, and the poll closed', () => {
    const r = map('poll-terminate');
    expect(message(r.events)).toMatchObject({ kind: 'system', body: 'Sam Rivera ended the poll.', replyTo: `${SAM}:${T + 26000}` });
    expect(of(r.events, 'pollUpdate')).toEqual([{ t: 'pollUpdate', conversation: GROUP, message: `${SAM}:${T + 26000}`, ended: true, ts: T + 28000 }]);
  });

  test('pin and unpin: a pin event for the target message, by whoever did it; a pin with a duration ends then', () => {
    const pinned = map('pin');
    expect(of(pinned.events, 'pin')).toEqual([{ t: 'pin', conversation: GROUP, message: `${SAM}:${T + 14000}`, pinned: true, by: ALICE, ts: T + 25000 }]);
    expect(pinned.pinTimers).toEqual([]); // -1: for good
    const unpinned = map('unpin');
    expect(message(unpinned.events)).toMatchObject({ kind: 'system', body: 'Alice Chen unpinned a message.', replyTo: `${SAM}:${T + 14000}` });
    expect(of(unpinned.events, 'pin')).toEqual([{ t: 'pin', conversation: GROUP, message: `${SAM}:${T + 14000}`, pinned: false, by: ALICE, ts: T + 26000 }]);
    expect(unpinned.pinTimers).toEqual([]);

    const day = fixture('pin');
    day.envelope!.dataMessage!.pinMessage!.pinDurationSeconds = 86400;
    expect(mapReceive(day, ctx()).pinTimers).toEqual([{ conversation: GROUP, message: `${SAM}:${T + 14000}`, until: T + 25000 + 86_400_000 }]);

    // A target named by number only resolves like a quote's author; one that does not resolve gets no pin event.
    const byNumber = fixture('pin');
    byNumber.envelope!.dataMessage!.pinMessage!.targetAuthorUuid = null;
    expect(of(mapReceive(byNumber, ctx({ aciOfNumber: (n) => (n === '+15550161' ? SAM : undefined) })).events, 'pin')[0]?.message).toBe(`${SAM}:${T + 14000}`);
    const unresolved = mapReceive(byNumber, ctx());
    expect(of(unresolved.events, 'pin')).toEqual([]);
    expect(message(unresolved.events).replyTo).toBeUndefined();
  });

  test('a pin you made on your phone is by you', () => {
    const rcv = fixture('sync-sent-group');
    const sent = rcv.envelope!.syncMessage!.sentMessage!;
    delete sent.message;
    delete sent.quote;
    sent.pinMessage = { targetAuthorUuid: ALICE, targetSentTimestamp: T + 1000, pinDurationSeconds: -1 };
    expect(of(mapReceive(rcv, ctx()).events, 'pin')).toEqual([{ t: 'pin', conversation: GROUP, message: `${ALICE}:${T + 1000}`, pinned: true, by: SELF, ts: sent.timestamp! }]);
  });

  test('housekeeping produces no messages', () => {
    expect(of(map('profile-key-update').events, 'message')).toHaveLength(0);
  });

  test('a message that could not be decrypted: a line in the 1:1 with its sender, nothing of it, once', () => {
    const seen = new Set<string>();
    const once = (k: string) => (seen.has(k) ? false : (seen.add(k), true));
    const r = map('decrypt-error', { once });
    expect(r.logs.some((l) => l.level === 'warn' && l.msg.includes('ProtocolInvalidMessageException'))).toBe(true);
    expect(of(r.events, 'conversation').map((e) => e.conversation.nativeId)).toEqual([`dm:${SELF}:${SAM}`]);
    // An id of its own: the message coming again decrypted (a retry keeps its timestamp) does not land on it.
    expect(message(r.events)).toEqual({ nativeId: `${SAM}:${T + 21000}:undecrypted`, conversation: `dm:${SELF}:${SAM}`, author: SAM, ts: T + 21000, kind: 'system', body: 'A message from Sam Rivera could not be decrypted.', extra: { sourceDevice: 3 } });
    expect(of(map('decrypt-error', { once }).events, 'message')).toHaveLength(0);
    // A duplicate was shown already; your own sends coming back are not lost.
    for (const type of ['ProtocolDuplicateMessageException', 'SelfSendException']) {
      const rcv = fixture('decrypt-error');
      rcv.exception!.type = type;
      rcv.envelope!.timestamp += 1;
      expect(of(mapReceive(rcv, ctx()).events, 'message')).toHaveLength(0);
    }
    // An envelope that did decrypt (the error came later) is shown as itself.
    const ok = fixture('text-styles-mentions');
    ok.exception = { type: 'AttachmentInvalidException', message: 'x' };
    expect(message(mapReceive(ok, ctx()).events).body).toContain('purple V4');
  });
});

describe('what a message carries besides its text', () => {
  test('voice notes and captions as notes on their attachments, in order; a file that did not download is named, not dropped', () => {
    const rcv = fixture('attachment');
    const atts = rcv.envelope!.dataMessage!.attachments!;
    atts[0].caption = ' the crux ';
    atts[2].isVoiceNote = true;
    atts.push({ contentType: 'video/mp4', filename: 'send.mp4', id: 'Gone0000video.mp4', size: 5_000_000 }, { contentType: 'image/png', filename: 'stream.png', id: null, size: 10 });
    const r = mapReceive(rcv, ctx({ exists: (p) => !p.includes('Gone0000') }));
    const m = message(r.events);
    expect(m.attachments!.map((a) => a.name)).toEqual(['v4.jpg', 'Vn0te1aac2bbb3ccc4dd.aac']);
    expect(m.extra).toMatchObject({
      attachmentNotes: [{ caption: 'the crux' }, { voiceNote: true }],
      missingAttachments: [
        { name: 'send.mp4', mime: 'video/mp4', size: 5_000_000 },
        { name: 'stream.png', mime: 'image/png', size: 10 },
      ],
    });
    expect(r.messages[0].files).toHaveLength(2);
    // Nothing but a file that did not come: still a message, of media.
    const only = fixture('attachment');
    only.envelope!.dataMessage!.message = null;
    only.envelope!.dataMessage!.attachments = [{ contentType: 'image/jpeg', filename: 'a.jpg', id: 'Gone0000a.jpg', size: 1 }];
    const m2 = message(mapReceive(only, ctx({ exists: () => false })).events);
    expect(m2).toMatchObject({ kind: 'media', body: '' });
    expect(m2.attachments).toBeUndefined();
    expect(m2.extra!.missingAttachments).toEqual([{ name: 'a.jpg', mime: 'image/jpeg', size: 1 }]);
  });

  test('link previews become embeds, the picture only when it downloaded', () => {
    const rcv = fixture('text-styles-mentions');
    const dm = rcv.envelope!.dataMessage!;
    dm.message = 'look https://www.example.org/route';
    dm.mentions = [];
    dm.textStyles = [];
    dm.previews = [
      { url: 'https://www.example.org/route', title: ' The route ', description: '5.12a, 30 m', image: { contentType: 'image/jpeg', id: 'Pr3view.jpg', size: 900 } },
      { url: 'javascript:alert(1)', title: 'no' },
    ];
    expect(message(mapReceive(rcv, ctx()).events).extra!.embeds).toEqual([
      { url: 'https://www.example.org/route', title: 'The route', description: '5.12a, 30 m', provider: 'example.org', image: `file://${DIR}/attachments/Pr3view.jpg` },
    ]);
    expect(message(mapReceive(rcv, ctx({ exists: () => false })).events).extra!.embeds).toEqual([{ url: 'https://www.example.org/route', title: 'The route', description: '5.12a, 30 m', provider: 'example.org' }]);
  });

  test('a shared contact: a card with all of it, and one line in the body for search and previews', () => {
    const rcv = fixture('text-styles-mentions');
    const dm = rcv.envelope!.dataMessage!;
    dm.message = null;
    dm.mentions = [];
    dm.textStyles = [];
    dm.contacts = [
      {
        name: { given: 'Robin', family: 'Okafor' },
        avatar: { attachment: { contentType: 'image/jpeg', id: 'Av4tar.jpg' }, isProfile: false },
        phone: [{ value: '+15550142', type: 'MOBILE' }, { value: '+15550143', type: 'CUSTOM', label: 'Gym' }],
        email: [{ value: 'robin@example.org', type: 'WORK' }],
        address: [{ type: 'HOME', street: '1 Crag Rd', city: 'Boulder', region: 'CO', postcode: '80302', country: 'US' }],
        organization: 'Route setters',
      },
    ];
    const m = message(mapReceive(rcv, ctx()).events);
    expect(m.body).toBe('👤 Robin Okafor · +15550142, +15550143, robin@example.org');
    expect(m.extra!.contacts).toEqual([
      {
        name: 'Robin Okafor',
        line: '👤 Robin Okafor · +15550142, +15550143, robin@example.org',
        phones: [{ value: '+15550142', label: 'Mobile' }, { value: '+15550143', label: 'Gym' }],
        emails: [{ value: 'robin@example.org', label: 'Work' }],
        organization: 'Route setters',
        addresses: [{ text: '1 Crag Rd, Boulder, CO 80302, US', label: 'Home' }],
        avatar: `file://${DIR}/attachments/Av4tar.jpg`,
      },
    ]);
  });

  test("a quote's attachments carry their kind and thumbnail", () => {
    const rcv = fixture('reply-quote');
    rcv.envelope!.dataMessage!.quote!.attachments = [{ contentType: 'image/jpeg', filename: 'v4.jpg', thumbnail: { contentType: 'image/jpeg', id: 'Thumb1.jpg', size: 2000 } }, { contentType: 'audio/aac', filename: null }];
    expect((message(mapReceive(rcv, ctx()).events).extra!.quote as { attachments: unknown }).attachments).toEqual([
      { mime: 'image/jpeg', name: 'v4.jpg', thumbnail: `file://${DIR}/attachments/Thumb1.jpg` },
      { mime: 'audio/aac', name: null },
    ]);
  });

  test('a story reply and a story reaction show as such; the story itself never comes', () => {
    const rcv = fixture('reply-quote');
    const dm = rcv.envelope!.dataMessage!;
    delete dm.quote;
    dm.storyContext = { authorUuid: SELF, sentTimestamp: T - 5000 };
    expect(message(mapReceive(rcv, ctx()).events).extra).toMatchObject({ storyReply: { author: SELF, ts: T - 5000 } });
    dm.message = null;
    dm.reaction = { emoji: '❤️', targetAuthorUuid: SELF, targetSentTimestamp: T - 5000 };
    const m = message(mapReceive(rcv, ctx()).events);
    expect(m).toMatchObject({ body: '❤️', author: ALICE, conversation: DM_ALICE });
    expect(m.extra).toMatchObject({ storyReply: { author: SELF, ts: T - 5000, emoji: '❤️' } });
    dm.reaction.isRemove = true;
    expect(mapReceive(rcv, ctx()).events.filter((e) => e.t === 'message' || e.t === 'reaction')).toHaveLength(0);
  });

  test('what a reply to a message quotes is kept in signal-cli syntax, cut to fit', () => {
    const r = map('text-styles-mentions');
    expect(r.messages[0].quote).toMatchObject({ m: [`4:1:${SELF}`, `10:1:${SAM}`], s: expect.arrayContaining(['17:9:BOLD']) });
    expect(quoteSource('x'.repeat(1200), ['1100:1:abc', '3:1:def'], ['0:1200:BOLD'])).toEqual({ t: 'x'.repeat(1000), m: ['3:1:def'] });
    expect(quoteAttachment('image/png', 'a:b.png', '/data/x.png')).toBe('image/png:a_b.png:/data/x.png');
    expect(quoteAttachment('audio/aac', null)).toBe('audio/aac');
    expect(quoteAttachment(null, 'f.bin', 'C:/x')).toBe('application/octet-stream:f.bin');
  });
});

describe('sync messages (your other devices)', () => {
  test('sentMessage to a 1:1 is authored by you', () => {
    const r = map('sync-sent-dm');
    expect(of(r.events, 'identity')).toHaveLength(0);
    expect(of(r.events, 'conversation').map((e) => e.conversation.nativeId)).toEqual([DM_ALICE]);
    expect(message(r.events)).toEqual({ nativeId: `${SELF}:${T + 9000}`, conversation: DM_ALICE, author: SELF, ts: T + 9000, kind: 'text', body: 'on my way 🚲' });
  });

  test('sentMessage to a group, quoting someone', () => {
    const m = message(map('sync-sent-group').events);
    expect(m).toMatchObject({ nativeId: `${SELF}:${T + 10000}`, conversation: GROUP, author: SELF, body: 'see you all at **7**', replyTo: `${ALICE}:${T + 1000}` });
  });

  test('Note to Self', () => {
    const r = map('sync-sent-note-to-self');
    expect(of(r.events, 'conversation')).toEqual([{ t: 'conversation', conversation: { nativeId: `dm:${SELF}:${SELF}`, shape: 'self', name: 'Note to Self', participants: [SELF], encrypted: true } }]);
    const m = message(r.events);
    expect(m).toMatchObject({ conversation: `dm:${SELF}:${SELF}`, author: SELF, kind: 'media', body: 'whiteboard from today' });
    expect(m.attachments?.[0]).toMatchObject({ kind: 'image', width: 640, height: 400, name: 'whiteboard.png' });
  });

  test('edit sent from the phone', () => {
    expect(message(map('sync-sent-edit').events)).toMatchObject({ nativeId: `${SELF}:${T + 9000}`, conversation: DM_ALICE, author: SELF, ts: T + 9000, editedTs: T + 18000, body: 'on my way 🚲 (5 min)' });
  });

  test('reaction sent from the phone', () => {
    expect(of(map('sync-sent-reaction').events, 'reaction')).toEqual([{ t: 'reaction', conversation: GROUP, message: `${SAM}:${T + 14000}`, author: SELF, key: '👍' }]);
  });

  test('read sync: per conversation, up to the newest read message; unknown messages skipped', () => {
    const r = map('sync-read');
    expect(of(r.events, 'read')).toEqual([{ t: 'read', conversation: DM_ALICE, upToTs: T + 3000 }]);
    expect(r.logs.some((l) => l.msg.includes('not seen'))).toBe(true);
  });

  test('contacts sync asks for a resync', () => {
    expect(map('contacts-sync').resync).toBe(true);
  });
});

describe('receipts (for messages you sent)', () => {
  // Your messages: "on my way" to Alice (T+9000) and "see you all" in the group (T+10000); T+18000 is an edit of the first.
  const yours = new Map<string, string>([
    [`${SELF}:${T + 9000}`, DM_ALICE],
    [`${SELF}:${T + 10000}`, GROUP],
    [`${SELF}:${T + 18000}`, DM_ALICE],
    [`${SELF}:${T + 11000}`, `dm:${SELF}:${SAM}`],
    [`${SELF}:${T + 12000}`, `dm:${SELF}:${SELF}`],
  ]);
  const rctx = (over: Partial<MapContext> = {}) => ctx({ conversationOf: (id) => yours.get(id), originalOf: (id) => (id === `${SELF}:${T + 18000}` ? `${SELF}:${T + 9000}` : undefined), ...over });
  const receipts = (rcv: SigReceive, over?: Partial<MapContext>) => of(mapReceive(rcv, rctx(over)).events, 'receipt');

  test('a read receipt: per conversation, your message ids, who read them and when', () => {
    expect(receipts(fixture('receipt-read'))).toEqual([
      { t: 'receipt', conversation: DM_ALICE, messages: [`${SELF}:${T + 9000}`], who: ALICE, state: 'read', ts: T + 19000 },
      { t: 'receipt', conversation: GROUP, messages: [`${SELF}:${T + 10000}`], who: ALICE, state: 'read', ts: T + 19000 },
    ]);
    // Nothing else: a receipt is no message and no read state of yours.
    expect(mapReceive(fixture('receipt-read'), rctx()).events.map((e) => e.t)).toEqual(['identity', 'receipt', 'receipt']);
  });

  test('delivered, and viewed (a voice note or video played)', () => {
    expect(receipts(fixture('receipt-delivery'))).toEqual([{ t: 'receipt', conversation: GROUP, messages: [`${SELF}:${T + 10000}`], who: SAM, state: 'delivered', ts: T + 10500 }]);
    const viewed = fixture('receipt-read');
    Object.assign(viewed.envelope!.receiptMessage!, { isRead: false, isViewed: true, timestamps: [T + 9000] });
    expect(receipts(viewed)).toEqual([{ t: 'receipt', conversation: DM_ALICE, messages: [`${SELF}:${T + 9000}`], who: ALICE, state: 'played', ts: T + 19000 }]);
    const neither = fixture('receipt-read');
    Object.assign(neither.envelope!.receiptMessage!, { isRead: false });
    expect(receipts(neither)).toEqual([]);
  });

  test('a receipt for an edit counts for the message it edits, once', () => {
    const rcv = fixture('receipt-read');
    rcv.envelope!.receiptMessage!.timestamps = [T + 9000, T + 18000];
    expect(receipts(rcv)).toEqual([{ t: 'receipt', conversation: DM_ALICE, messages: [`${SELF}:${T + 9000}`], who: ALICE, state: 'read', ts: T + 19000 }]);
  });

  test("messages this device has not seen, someone else's 1:1 and Note to Self are skipped", () => {
    const rcv = fixture('receipt-read');
    rcv.envelope!.receiptMessage!.timestamps = [T + 1, T + 11000, T + 12000];
    const r = mapReceive(rcv, rctx());
    expect(of(r.events, 'receipt')).toEqual([]);
    expect(r.logs).toEqual([{ level: 'debug', msg: 'read receipt for 3 message(s) we have not seen', data: { from: ALICE } }]);
  });

  test('receipts from your own devices are not receipts; your reads arrive as read syncs', () => {
    const rcv = fixture('receipt-read');
    Object.assign(rcv.envelope!, { sourceUuid: SELF, sourceNumber: '+15550100', sourceName: null });
    expect(receipts(rcv)).toEqual([]);
    expect(of(map('sync-read').events, 'receipt')).toEqual([]);
  });
});

describe('typing', () => {
  test('started in a 1:1 and a group, lasting as long as on Signal; stopped says so', () => {
    expect(of(map('typing-dm').events, 'typing')).toEqual([{ t: 'typing', conversation: DM_ALICE, author: ALICE, ttl: 15_000 }]);
    expect(of(map('typing-group').events, 'typing')).toEqual([{ t: 'typing', conversation: GROUP, author: SAM, ttl: 15_000 }]);
    expect(of(map('typing-group-stopped').events, 'typing')).toEqual([{ t: 'typing', conversation: GROUP, author: SAM, stop: true }]);
  });
});

describe('contacts and groups', () => {
  const contact: SigContact = {
    number: '+15550137',
    uuid: ALICE.toUpperCase(),
    name: 'Alice Chen',
    givenName: 'Alice',
    familyName: 'Chen',
    nickGivenName: null,
    isHidden: false,
    profile: { givenName: 'Ali', familyName: null, hasAvatar: false },
  };

  test('listContacts -> contact identity (ACI lowercased, number as handle)', () => {
    expect(contactIdentity(contact, { contact: true })).toEqual({ nativeId: ALICE, handle: '+15550137', displayName: 'Alice Chen', contact: true, nickname: '', note: '' });
    expect(contactIdentity({ ...contact, uuid: null }, { contact: true })).toBeNull();
    expect(contactIdentity({ ...contact, uuid: SELF }, { contact: true, self: SELF })).toMatchObject({ isSelf: true });
  });

  test('display name priority: nickname, contact name, profile name, username', () => {
    expect(displayNameOf({ ...contact, nickGivenName: 'Al', nickFamilyName: 'C' })).toBe('Al C');
    expect(displayNameOf({ ...contact, name: '' })).toBe('Alice Chen'); // given + family
    expect(displayNameOf({ uuid: SAM, name: '', profile: { givenName: 'Sam', familyName: 'Rivera' } })).toBe('Sam Rivera');
    expect(displayNameOf({ uuid: SAM, name: '', username: 'sam.42' })).toBe('sam.42');
  });

  const group: SigGroup = {
    id: GID,
    name: 'Climbing crew 🧗',
    description: 'thursday nights',
    isMember: true,
    members: [
      { number: '+15550100', uuid: SELF, isAdmin: true },
      { number: '+15550137', uuid: ALICE, isAdmin: false },
      { number: null, uuid: null },
    ],
    permissionSendMessage: 'EVERY_MEMBER',
    messageExpirationTime: 0,
  };

  test('listGroups -> group conversation', () => {
    expect(groupConversation(group)).toEqual({ nativeId: GROUP, shape: 'group', encrypted: true, name: 'Climbing crew 🧗', topic: 'thursday nights', participants: [SELF, ALICE] });
    expect(groupConversation({ ...group, permissionSendMessage: 'ONLY_ADMINS' }).variant).toBe('announcement');
  });

  test('1:1 and Note to Self', () => {
    expect(directConversation(SELF, ALICE)).toEqual({ nativeId: DM_ALICE, shape: 'direct', participants: [SELF, ALICE], encrypted: true });
    expect(directConversation(SELF, SELF)).toEqual(noteToSelf(SELF));
  });

  test('group change descriptions', () => {
    const names = (a: string) => (a === ALICE ? 'Alice' : a === SAM ? 'Sam' : a);
    const withSam = { ...group, members: [...group.members!, { number: '+15550161', uuid: SAM }] };
    expect(describeGroupChange(group, withSam, ALICE, SELF, names)).toBe('Alice added Sam.');
    expect(describeGroupChange(withSam, group, SAM, SELF, names)).toBe('Sam left the group.');
    expect(describeGroupChange(group, { ...group, name: 'Crew' }, SELF, SELF, names)).toBe('You renamed the group to “Crew”.');
    expect(describeGroupChange(group, { ...group, messageExpirationTime: 86400 }, ALICE, SELF, names)).toBe('Alice set disappearing messages to 1 day.');
    expect(describeGroupChange(undefined, group, ALICE, SELF, names)).toBe('Alice updated the group.');
    expect(describeGroupChange({ ...group, permissionEditDetails: 'EVERY_MEMBER' }, { ...group, permissionEditDetails: 'ONLY_ADMINS' }, SELF, SELF, names)).toBe('You changed who can edit group info to “Only admins”.');
    expect(describeGroupChange({ ...group, permissionAddMember: 'ONLY_ADMINS' }, { ...group, permissionAddMember: 'EVERY_MEMBER' }, ALICE, SELF, names)).toBe('Alice changed who can add members to “All members”.');
    const linked = { ...group, groupInviteLink: 'https://signal.group/#a' };
    expect(describeGroupChange({ ...group, groupInviteLink: null }, linked, SELF, SELF, names)).toBe('You turned on the group link.');
    expect(describeGroupChange(linked, { ...group, groupInviteLink: 'https://signal.group/#b' }, SELF, SELF, names)).toBe('You reset the group link.');
    expect(describeGroupChange(linked, { ...group, groupInviteLink: null }, SELF, SELF, names)).toBe('You turned off the group link.');
  });

  test('invitations: named to whoever sent them, counted for everyone else; your own is no change here', () => {
    const names = (a: string) => (a === ALICE ? 'Alice' : a === SAM ? 'Sam' : a);
    const ROBIN = '0b5e7ae0-4444-4bbb-8ccc-000000000004';
    const withSam = { ...group, members: [...group.members!, { number: '+15550161', uuid: SAM }] };
    const invited = (g: typeof group, ...who: string[]) => ({ ...g, pendingMembers: [...(g.pendingMembers ?? []), ...who.map((uuid) => ({ number: null, uuid }))] });
    expect(describeGroupChange(group, invited(withSam, ROBIN), SELF, SELF, names)).toBe(`You added Sam, invited ${ROBIN}.`);
    expect(describeGroupChange(group, invited(group, SAM), SELF, SELF, names)).toBe('You invited Sam.');
    expect(describeGroupChange(group, invited(group, SAM, ROBIN), ALICE, SELF, names)).toBe('Alice invited 2 people.');
    expect(describeGroupChange(invited(group, SAM), invited(group, SAM, ROBIN), ALICE, SELF, names)).toBe('Alice invited 1 person.');
    // Invited, then in: joining, not a new invitation.
    expect(describeGroupChange(invited(group, SAM), withSam, SAM, SELF, names)).toBe('Sam joined the group.');
    expect(describeGroupChange(group, invited(group, SELF), ALICE, SELF, names)).toBe('Alice updated the group.');
  });

  test('admins made and unmade, in words and as a diff of the members kept', () => {
    const names = (a: string) => (a === ALICE ? 'Alice' : a === SAM ? 'Sam' : a);
    const crew: SigGroup = {
      ...group,
      members: [
        { number: '+15550100', uuid: SELF, isAdmin: false },
        { number: '+15550137', uuid: ALICE, isAdmin: true },
        { number: '+15550161', uuid: SAM, isAdmin: false },
      ],
    };
    const admin = (g: SigGroup, who: string, isAdmin: boolean): SigGroup => ({ ...g, members: g.members!.map((m) => (m.uuid === who ? { ...m, isAdmin } : m)) });
    expect(adminChanges(crew, admin(crew, SAM, true))).toEqual({ given: [SAM], taken: [] });
    expect(describeGroupChange(crew, admin(crew, SAM, true), ALICE, SELF, names)).toBe('Alice made Sam an admin.');
    expect(describeGroupChange(crew, admin(crew, SELF, true), ALICE, SELF, names)).toBe('Alice made you an admin.');
    expect(describeGroupChange(crew, admin(admin(crew, SELF, true), SAM, true), ALICE, SELF, names)).toBe('Alice made you, Sam admins.');
    expect(adminChanges(crew, admin(crew, ALICE, false))).toEqual({ given: [], taken: [ALICE] });
    expect(describeGroupChange(admin(crew, SAM, true), crew, ALICE, SELF, names)).toBe('Alice revoked admin privileges from Sam.');
    expect(describeGroupChange(admin(crew, SELF, true), crew, ALICE, SELF, names)).toBe('Alice revoked your admin privileges.');
    // Joining or leaving is not a role change, even for an admin.
    const noSam = { ...crew, members: crew.members!.filter((m) => m.uuid !== SAM) };
    expect(adminChanges(noSam, admin(crew, SAM, true))).toEqual({ given: [], taken: [] });
    expect(adminChanges(crew, { ...crew, members: crew.members!.filter((m) => m.uuid !== ALICE) })).toEqual({ given: [], taken: [] });
    // A signal-cli that does not mark members lists the admins instead.
    const unmarked = (admins: string[]): SigGroup => ({ ...group, members: crew.members!.map(({ isAdmin: _a, ...m }) => m), admins: admins.map((uuid) => ({ uuid })) });
    expect(adminChanges(unmarked([ALICE]), unmarked([ALICE, SAM]))).toEqual({ given: [SAM], taken: [] });
  });
});

describe('profiles', () => {
  // listContacts output as signal-cli 0.14 writes it (JsonContact, profile null when it has none).
  const listed: SigContact[] = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'list-contacts.json'), 'utf8'));
  const [nicknamed, stranger, blocked, gone, blank] = listed;

  test('a contact: your name for them, their About and its emoji, their number as a link, your note', () => {
    expect(personAbout(nicknamed, { inContacts: true, avatarUrl: 'file:///x/avatars/profile-a' })).toEqual({
      displayName: 'Al',
      handle: '+15550137',
      avatar: 'file:///x/avatars/profile-a',
      bio: 'Belay on',
      status: { emoji: '🧗' },
      relationship: 'contact',
      links: [{ label: 'Phone', value: '+15550137', url: 'tel:+15550137' }],
      facts: [
        { label: 'Profile name', value: 'Alice C.' },
        { label: 'Note', value: 'Met at the crag' },
      ],
    });
  });

  test('someone signal-cli knows but you have not saved: a stranger, by username, no number to show', () => {
    expect(personAbout(stranger, { inContacts: false })).toEqual({ displayName: 'Robin', handle: '@robin.42', bio: 'Gone bouldering', relationship: 'stranger' });
  });

  test('blocked wins over being a contact, and an empty profile adds nothing', () => {
    expect(personAbout(blocked, { inContacts: true })).toEqual({
      displayName: 'Blake',
      handle: '+15550142',
      relationship: 'blocked',
      links: [{ label: 'Phone', value: '+15550142', url: 'tel:+15550142' }],
    });
    expect(personAbout(gone, { inContacts: false })).toMatchObject({ relationship: 'stranger', facts: [{ label: 'Account', value: 'No longer on Signal' }] });
    expect(personAbout(blank, { inContacts: false })).toEqual({ relationship: 'stranger' });
    expect(personAbout(blank)).toEqual({}); // yourself: no relationship
  });
});

describe('ids', () => {
  test('message ids', () => {
    expect(parseMsgId(`${ALICE}:${T}`)).toEqual({ author: ALICE, ts: T });
    expect(parseMsgId('nope')).toBeNull();
    expect(parseMsgId(`${ALICE}:abc`)).toBeNull();
  });
  test('conversation ids', () => {
    expect(parseConversation(GROUP, SELF)).toEqual({ kind: 'group', groupId: GID });
    expect(parseConversation(DM_ALICE, SELF)).toEqual({ kind: 'dm', peer: ALICE });
    expect(parseConversation(`dm:${SELF}:${SELF}`, SELF)).toEqual({ kind: 'self' });
    expect(parseConversation(`dm:${SAM}:${ALICE}`, SELF)).toBeNull(); // another account's 1:1
    expect(parseConversation('!room:matrix.org', SELF)).toBeNull();
  });
});
