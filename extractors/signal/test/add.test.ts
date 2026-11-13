/**
 * Adding on Signal (dither-chat docs/add.md): resolve, add (join by link), the requests list (group invitations and
 * message requests) and its answers, and the quiet rule, against test/fake-signal-cli.ts on an account that is linked
 * already. Steps share one adapter and run in order. Everyone here is made up.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent, RequestAnswer, RequestFact } from '@dither-chat/protocol';
import { groupIdOfLink, groupIdOfMasterKey, groupLink, isMessageRequest, linkMasterKey, rateLimitSentence } from '../src/add.ts';
import { acceptInviteParams, type AdapterHost, SignalAdapter } from '../src/adapter.ts';
import { RpcError } from '../src/rpc.ts';

const FAKE = join(import.meta.dir, 'fake-signal-cli.ts');
const NUMBER = '+15550100';
const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002'; // in your contacts
const JAMIE = 'a0000000-6666-4aaa-8bbb-000000000006'; // wrote before this run: a message request at connect
const QUINN = 'a0000000-7777-4aaa-8bbb-000000000007'; // writes now; accepted on the phone
const RILEY = 'a0000000-8888-4aaa-8bbb-000000000008'; // writes now; you reply from the phone
const DANA = 'a0000000-9999-4aaa-8bbb-000000000009'; // declined here, writes again, blocked here
const ELI = 'a0000000-aaaa-4aaa-8bbb-00000000000a'; // writes now, left waiting
const MEI = 'a0000000-bbbb-4aaa-8bbb-00000000000b'; // found by a username link
const dm = (peer: string) => `dm:${SELF}:${peer}`;
const T = 1793330000000;
const ANSWERS: RequestAnswer[] = ['accept', 'decline', 'block'];

const key = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 3 + seed) & 0xff);
const pw = (seed: number) => Uint8Array.from({ length: 16 }, (_, i) => (i + seed) & 0xff);
const LINK = (seed: number) => groupLink(key(seed), pw(seed));
const GID = (seed: number) => groupIdOfMasterKey(key(seed));
const CREW = GID(1); // you are in it
const PARTY = GID(2); // you are invited to it
const GAMES = GID(3); // joined by its link here
const ASK = GID(4); // its admins approve joins
const PICNIC = 'P1cn1cGr0up+Inv1te000000000000000000000000=';
const HIKE = 'H1keGr0up+Inv1te00000000000000000000000000=';
const CAMP = 'C4mpGr0up+Inv1te00000000000000000000000000=';
const SPAM = 'Sp4mGr0up+Inv1te00000000000000000000000000=';

const person = (uuid: string, given: string, extra: Record<string, unknown> = {}) => ({
  number: null,
  uuid,
  username: null,
  name: null,
  givenName: null,
  familyName: null,
  nickName: null,
  nickGivenName: null,
  nickFamilyName: null,
  note: null,
  color: null,
  isArchived: false,
  isBlocked: false,
  isHidden: false,
  messageExpirationTime: 0,
  profileSharing: false,
  unregistered: false,
  profile: { lastUpdateTimestamp: 1, givenName: given, familyName: null, about: null, aboutEmoji: null, hasAvatar: false, mobileCoinAddress: null },
  _contact: false,
  ...extra,
});
const CONTACTS = [
  person(SELF, 'Quinn', { number: NUMBER, profileSharing: true, _contact: true }),
  person(ALICE, 'Alice', { number: '+15550137', name: 'Alice Chen', givenName: 'Alice', familyName: 'Chen', username: 'alice.37', profileSharing: true, _contact: true }),
  person(JAMIE, 'Jamie'),
  person(QUINN, 'Quinn'),
  person(RILEY, 'Riley'),
  person(DANA, 'Dana'),
  person(ELI, 'Eli'),
  person(MEI, 'Mei', { _links: ['https://signal.me/#eu/FakeUsernameLinkForMei0000'] }),
];
const me = { number: NUMBER, uuid: SELF };
const alice = { number: '+15550137', uuid: ALICE };
const group = (id: string, name: string, o: { member?: boolean; invited?: boolean } = {}) => ({
  id,
  name,
  description: '',
  isMember: !!o.member,
  isBlocked: false,
  messageExpirationTime: 0,
  members: [...(o.member ? [{ ...me, isAdmin: false }] : []), { ...alice, isAdmin: true }],
  pendingMembers: o.invited ? [me] : [],
  requestingMembers: [],
  admins: [alice],
  banned: [],
  permissionAddMember: 'EVERY_MEMBER',
  permissionEditDetails: 'EVERY_MEMBER',
  permissionSendMessage: 'EVERY_MEMBER',
  groupInviteLink: null,
  isTerminated: false,
});

let dir: string;
let signalDir: string;
let adapter: SignalAdapter;
const events: AdapterEvent[] = [];
const logs: string[] = [];

const until = async <V>(what: string, fn: () => V | undefined | null | false, ms = 8000): Promise<V> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as V;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${logs.slice(-15).join('\n')}`);
    await Bun.sleep(20);
  }
};
const of = <K extends AdapterEvent['t']>(t: K, from = 0) => events.slice(from).filter((e): e is Extract<AdapterEvent, { t: K }> => e.t === t);
const records = () =>
  existsSync(join(signalDir, 'fake-rpc.jsonl'))
    ? readFileSync(join(signalDir, 'fake-rpc.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const calls = (method: string) => records().filter((r) => r.t === 'rpc' && r.method === method);
const methodsSince = (n: number) => records().slice(n).filter((r) => r.t === 'rpc' && r.method !== 'version').map((r) => r.method);
const cmd = (c: any) => adapter.command({ id: String(Math.random()), ...c }) as Promise<any>;
const invite = (url: string) => ({ kind: 'invite', network: 'signal', code: url, url });
const who = (handle: string) => ({ kind: 'person', network: 'signal', handle });
const requestOf = (id: string, from = 0) => of('request', from).find((e) => e.request.nativeId === id)?.request;
const gone = (id: string, from = 0) => of('requestGone', from).some((e) => e.nativeId === id);
const firstIndex = (from: number, pred: (e: AdapterEvent) => boolean) => events.findIndex((e, i) => i >= from && pred(e));

let pushes = 0;
const push = (body: object) => {
  mkdirSync(join(signalDir, 'fake-push'), { recursive: true });
  const tmp = join(signalDir, `push-${pushes}.tmp`);
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, join(signalDir, 'fake-push', `${String(pushes++).padStart(4, '0')}.json`));
};
const envelope = (from: string, name: string | null, ts: number, rest: object) => ({
  account: NUMBER,
  envelope: { source: from, sourceNumber: null, sourceUuid: from, sourceName: name, sourceDevice: 1, timestamp: ts, serverReceivedTimestamp: ts + 100, serverDeliveredTimestamp: ts + 200, ...rest },
});
const plain = { expiresInSeconds: 0, isExpirationUpdate: false, viewOnce: false, isEndSession: false, isProfileKeyUpdate: false, hasProfileKey: true };
const dmFrom = (from: string, name: string, ts: number, message: string) => envelope(from, name, ts, { dataMessage: { timestamp: ts, message, ...plain } });
const groupUpdate = (groupId: string, name: string, ts: number) => envelope(ALICE, 'Alice Chen', ts, { dataMessage: { timestamp: ts, message: null, ...plain, groupInfo: { groupId, groupName: name, revision: 2, type: 'UPDATE' } } });
const sentFromPhone = (to: string, ts: number, message: string) => envelope(SELF, null, ts, { sourceDevice: 2, syncMessage: { sentMessage: { destination: null, destinationNumber: null, destinationUuid: to, timestamp: ts, message, ...plain } } });
const quietSync = (ts: number) => envelope(SELF, null, ts, { sourceDevice: 2, syncMessage: {} });

const file = (name: string) => join(signalDir, name);
const readJson = (name: string) => JSON.parse(readFileSync(file(name), 'utf8'));
const editContacts = (fn: (list: any[]) => void) => {
  const l = readJson('fake-contacts.json');
  fn(l);
  writeFileSync(file('fake-contacts.json'), JSON.stringify(l));
};
const editGroups = (fn: (list: any[]) => any[] | void) => {
  const l = readJson('fake-groups.json');
  writeFileSync(file('fake-groups.json'), JSON.stringify(fn(l) ?? l));
};

const host = (): AdapterHost => ({
  emit: (ev) => events.push(ev),
  log: (level, msg) => logs.push(`[${level}] ${msg}`),
  accountDir: dir,
  config: {},
  secret: () => ({}),
  saveSecret: () => {},
});
const makeAdapter = () =>
  new SignalAdapter(host(), {
    signalCli: async () => [process.execPath, FAKE],
    resnapshotMs: [0],
    resnapshotEveryMs: 3_600_000,
    expirySweepMs: 3_600_000,
    daemonReadyTimeoutMs: 10_000,
    requestRecheckMs: [100],
  });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-sig-add-'));
  signalDir = join(dir, 'signal-cli');
  mkdirSync(join(signalDir, 'data'), { recursive: true });
  // Linked already: the daemon starts at once.
  writeFileSync(join(signalDir, 'data', 'accounts.json'), JSON.stringify({ accounts: [{ path: '123456', environment: 'LIVE', number: NUMBER, uuid: SELF }], version: 2 }));
  writeFileSync(file('fake-contacts.json'), JSON.stringify(CONTACTS));
  writeFileSync(file('fake-groups.json'), JSON.stringify([group(CREW, 'Climbing crew', { member: true }), group(PARTY, 'Surprise party', { invited: true })]));
  writeFileSync(
    file('fake-links.json'),
    JSON.stringify({
      [LINK(3)]: { group: group(GAMES, 'Board games') },
      [LINK(4)]: { group: group(ASK, 'Book club'), approval: true },
      [LINK(5)]: { error: 'Group link is not valid: Group link is not active (NOT_ACTIVE)' },
      [LINK(6)]: { error: 'Failed to send message: Proof required (ProofRequiredException)', code: -3 },
    }),
  );
  // Jamie wrote before this run, and it is still unread.
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 1, dms: [JAMIE], index: [[`${JAMIE}:${T}`, { c: dm(JAMIE), t: 'hi' }]], unread: { [dm(JAMIE)]: [[JAMIE, T]] }, expiring: [], groups: {}, heard: { [JAMIE]: T } }));
  adapter = makeAdapter();
});

afterAll(async () => {
  await adapter?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('group links and message requests, offline', () => {
  test("a group's id from its master key is libsignal's (vectors from the libsignal-client bundled in signal-cli 0.14.8)", () => {
    // GroupSecretParams.deriveFromMasterKey(new GroupMasterKey(key)).getPublicParams().getGroupIdentifier()
    expect(groupIdOfMasterKey(key(0))).toBe('tp/S9Mife/m1aODI3X7zDLnMR0Hhwnc85WnQRB0CpfQ=');
    expect(groupIdOfMasterKey(key(7))).toBe('4V5qb92NezHrnm/23S+/9387dfdHqLZZcpf2L+h7Jm4=');
    expect(groupIdOfMasterKey(key(200))).toBe('Bay6Yh2B+40JPYmjMxir8a6o+o0IUxuSZIXjZORJIgQ=');
  });

  test('a link carries its master key; anything else carries none', () => {
    const link = LINK(7);
    expect(link).toStartWith('https://signal.group/#CjQKI');
    expect(linkMasterKey(link)).toEqual(key(7));
    expect(groupIdOfLink(link)).toBe('4V5qb92NezHrnm/23S+/9387dfdHqLZZcpf2L+h7Jm4=');
    for (const bad of ['https://signal.group/#CjQKIFakeLockedGroupLink', 'https://signal.group/', 'https://example.org/#' + link.split('#')[1], 'signal.group/#x', 'https://signal.group/#%%%']) expect(groupIdOfLink(bad)).toBeNull();
  });

  test('who is a message request: no profile sharing, not in your address book, not blocked, still on Signal', () => {
    expect(isMessageRequest(undefined)).toBe(true);
    expect(isMessageRequest({ profileSharing: false })).toBe(true);
    expect(isMessageRequest({ profileSharing: false, profile: { givenName: 'Their own name' } })).toBe(true);
    expect(isMessageRequest({ profileSharing: true })).toBe(false);
    expect(isMessageRequest({ profileSharing: false, givenName: 'Alice' })).toBe(false);
    expect(isMessageRequest({ profileSharing: false, isBlocked: true })).toBe(false);
    expect(isMessageRequest({ profileSharing: false, unregistered: true })).toBe(false);
  });

  test('a rate limit says when it frees up', () => {
    const now = 1_800_000_000_000;
    expect(rateLimitSentence(new RpcError(`Rate limit reached\nNext attempt may be tried at ${now + 600_000} (2027-01-15T08:10:00.000Z)`, -5), 'look people up', now)).toBe('Signal is limiting how often this device can look people up; try again in 10 minutes');
    expect(rateLimitSentence(new RpcError('Rate limit reached', -5, { response: { results: [{ retryAfterSeconds: 7200 }] } }), 'join groups', now)).toBe('Signal is limiting how often this device can join groups; try again in 2 hours');
    expect(rateLimitSentence(new RpcError('Rate limit reached', -5), 'join groups', now)).toBe('Signal is limiting how often this device can join groups and did not say until when; try again later');
    expect(rateLimitSentence(new Error('Invalid group id'), 'join groups', now)).toBeNull();
  });

  test('accepting an invitation is updateGroup with the group id, never without one', () => {
    expect(acceptInviteParams(PARTY)).toEqual({ groupId: PARTY });
    for (const id of ['', '  ', undefined, null]) expect(() => acceptInviteParams(id)).toThrow(/create a new group/);
  });
});

describe('adding on Signal against a fake signal-cli', () => {
  test('hello: resolve, join and requests; no connect, as Signal has no friends or follows', async () => {
    await adapter.start();
    const caps = of('hello')[0].capabilities;
    expect(caps).toEqual(expect.arrayContaining(['resolve', 'join', 'requests', 'openDirect']));
    expect(caps).not.toContain('connect');
  });

  test('connect: the whole list once contacts and groups are read, identities first; an invitation is no conversation', async () => {
    const list = await until('requests', () => of('requests')[0]);
    const sorted = [...list.requests].sort((a, b) => a.nativeId.localeCompare(b.nativeId));
    expect(sorted).toEqual([
      { nativeId: `invite:${PARTY}`, kind: 'invite', target: { kind: 'conversation', nativeId: `group:${PARTY}`, name: 'Surprise party', members: 1 }, ts: expect.any(Number), answers: ANSWERS },
      { nativeId: `message:${JAMIE}`, kind: 'message', from: JAMIE, target: { kind: 'conversation', nativeId: dm(JAMIE) }, ts: T, answers: ANSWERS },
    ] as RequestFact[]);
    const at = events.indexOf(list);
    expect(firstIndex(0, (e) => e.t === 'identity' && e.identity.nativeId === JAMIE)).toBeLessThan(at);
    expect(events.find((e) => e.t === 'identity' && e.identity.nativeId === JAMIE)).toEqual({ t: 'identity', identity: { nativeId: JAMIE, displayName: 'Jamie' } });
    expect(of('conversation').some((c) => c.conversation.nativeId === `group:${PARTY}`)).toBe(false);
    expect(of('conversation').some((c) => c.conversation.nativeId === dm(JAMIE))).toBe(true); // its conversation as usual
    expect(of('conversation').some((c) => c.conversation.nativeId === `group:${CREW}`)).toBe(true);
    expect(of('requests')).toHaveLength(1);
  });

  test('signal-cli runs without --send-read-receipts, so it sends none by itself', () => {
    const argv = records().find((r) => r.t === 'argv' && r.argv.includes('daemon'))!.argv as string[];
    expect(argv).toContain('--receive-mode');
    expect(argv).not.toContain('--send-read-receipts');
  });

  test('quiet: a message request gets no read receipt, typing, reply, reaction or timer, from any command', async () => {
    const out = ['sendReceipt', 'sendTyping', 'send', 'sendReaction', 'updateContact', 'remoteDelete', 'sendPollVote', 'sendPollCreate', 'sendPinMessage'];
    const before = out.map((m) => calls(m).length);
    const mark = events.length;
    push(dmFrom(JAMIE, 'Jamie', T + 500, 'are you around?'));
    const m = await until('the message', () => of('message', mark).find((e) => e.message.nativeId === `${JAMIE}:${T + 500}`));
    expect(m.message).toMatchObject({ conversation: dm(JAMIE), author: JAMIE, body: 'are you around?' }); // as usual
    expect(await cmd({ t: 'markRead', conversation: dm(JAMIE), upTo: `${JAMIE}:${T + 500}` })).toEqual({ receipts: 0 });
    expect(await cmd({ t: 'typing', conversation: dm(JAMIE) })).toEqual({ ok: false });
    expect(await cmd({ t: 'typing', conversation: dm(JAMIE), stop: true })).toEqual({ ok: false });
    expect(await cmd({ t: 'action', action: 'typing', args: { conversation: dm(JAMIE) } })).toEqual({ ok: false });
    await expect(cmd({ t: 'send', conversation: dm(JAMIE), body: 'hi' })).rejects.toThrow('Accept this message request first');
    await expect(cmd({ t: 'react', conversation: dm(JAMIE), message: `${JAMIE}:${T + 500}`, key: '👍' })).rejects.toThrow('Accept this message request first');
    await expect(cmd({ t: 'configure', target: { kind: 'conversation', nativeId: dm(JAMIE) }, change: { key: 'disappearing', value: 3600 } })).rejects.toThrow('Accept this message request first');
    await expect(cmd({ t: 'redact', conversation: dm(JAMIE), message: `${SELF}:${T + 600}` })).rejects.toThrow('Accept this message request first');
    await expect(cmd({ t: 'pollVote', conversation: dm(JAMIE), message: `${JAMIE}:${T + 500}`, options: ['0'] })).rejects.toThrow('Accept this message request first');
    await expect(cmd({ t: 'pollCreate', conversation: dm(JAMIE), poll: { question: 'Q', options: ['a', 'b'], multi: false } })).rejects.toThrow('Accept this message request first');
    await expect(cmd({ t: 'configure', target: { kind: 'conversation', nativeId: dm(JAMIE) }, change: { key: 'pin', message: `${JAMIE}:${T + 500}` } })).rejects.toThrow('Accept this message request first');
    await Bun.sleep(300);
    expect(out.map((m) => calls(m).length)).toEqual(before);
    expect(of('request', mark)).toEqual([]); // nothing new: it was on the list
  });

  test('someone writes first: their message as usual, then a request; quiet even before signal-cli was read', async () => {
    const mark = events.length;
    const receipts = calls('sendReceipt').length;
    // Straight in, and read in the same tick: signal-cli has not been asked about Quinn yet.
    adapter.received(dmFrom(QUINN, 'Quinn', T + 1000, 'hello from a stranger'));
    expect(of('message', mark).map((e) => e.message.nativeId)).toEqual([`${QUINN}:${T + 1000}`]);
    expect(requestOf(`message:${QUINN}`, mark)).toBeUndefined();
    expect(await cmd({ t: 'markRead', conversation: dm(QUINN), upTo: `${QUINN}:${T + 1000}` })).toEqual({ receipts: 0 });
    const r = await until('the request', () => requestOf(`message:${QUINN}`, mark));
    expect(r).toEqual({ nativeId: `message:${QUINN}`, kind: 'message', from: QUINN, target: { kind: 'conversation', nativeId: dm(QUINN) }, ts: T + 1000, answers: ANSWERS });
    const at = firstIndex(mark, (e) => e.t === 'request');
    expect(firstIndex(mark, (e) => e.t === 'identity' && e.identity.nativeId === QUINN)).toBeLessThan(at);
    expect(firstIndex(mark, (e) => e.t === 'message')).toBeLessThan(at);
    expect(calls('sendReceipt').length).toBe(receipts);
  });

  test('accepted on the phone: the look after a sync drops it, and then receipts and typing go', async () => {
    const mark = events.length;
    editContacts((l) => (l.find((c) => c.uuid === QUINN).profileSharing = true)); // the storage sync signal-cli gets
    push(quietSync(T + 1500));
    await until('requestGone', () => gone(`message:${QUINN}`, mark));
    expect(await cmd({ t: 'markRead', conversation: dm(QUINN), upTo: `${QUINN}:${T + 1000}` })).toEqual({ receipts: 1 });
    expect(calls('sendReceipt').at(-1).params).toEqual({ recipient: QUINN, targetTimestamp: [T + 1000], type: 'read' });
    expect(await cmd({ t: 'typing', conversation: dm(QUINN) })).toEqual({ ok: true });
    expect(calls('sendTyping').at(-1).params).toEqual({ recipient: [QUINN] });
  });

  test('you reply from your phone: the request goes at once', async () => {
    const mark = events.length;
    push(dmFrom(RILEY, 'Riley', T + 2000, 'remember me?'));
    await until('the request', () => requestOf(`message:${RILEY}`, mark));
    push(sentFromPhone(RILEY, T + 2100, 'of course'));
    await until('requestGone', () => gone(`message:${RILEY}`, mark));
    expect(await cmd({ t: 'typing', conversation: dm(RILEY) })).toEqual({ ok: true });
  });

  test('accept here: sendMessageRequestResponse accept, gone before the reply; then what was held back goes', async () => {
    const mark = events.length;
    const res = await cmd({ t: 'answer', request: `message:${JAMIE}`, answer: 'accept' });
    expect(calls('sendMessageRequestResponse').at(-1).params).toEqual({ recipient: [JAMIE], type: 'accept' });
    expect(res).toEqual({ conversation: dm(JAMIE), identity: JAMIE, relationship: 'stranger' });
    expect(gone(`message:${JAMIE}`, mark)).toBe(true);
    // Both messages stayed unread through the quiet time: one receipt for both now.
    expect(await cmd({ t: 'markRead', conversation: dm(JAMIE), upTo: `${JAMIE}:${T + 500}` })).toEqual({ receipts: 2 });
    expect(calls('sendReceipt').at(-1).params).toEqual({ recipient: JAMIE, targetTimestamp: [T, T + 500], type: 'read' });
    expect(await cmd({ t: 'typing', conversation: dm(JAMIE) })).toEqual({ ok: true });
    await cmd({ t: 'send', conversation: dm(JAMIE), body: 'hi Jamie' });
    expect(calls('send').at(-1).params).toEqual({ recipient: [JAMIE], message: 'hi Jamie' });
  });

  test('decline: delete, the conversation goes; a new message is a new request', async () => {
    let mark = events.length;
    push(dmFrom(DANA, 'Dana', T + 3000, 'buy my course'));
    await until('the request', () => requestOf(`message:${DANA}`, mark));
    mark = events.length;
    const res = await cmd({ t: 'answer', request: `message:${DANA}`, answer: 'decline' });
    expect(calls('sendMessageRequestResponse').at(-1).params).toEqual({ recipient: [DANA], type: 'delete' });
    expect(res).toEqual({ identity: DANA, relationship: 'stranger' });
    expect(gone(`message:${DANA}`, mark)).toBe(true);
    expect(of('leave', mark)).toEqual([{ t: 'leave', kind: 'conversation', nativeId: dm(DANA) }]);
    mark = events.length;
    push(dmFrom(DANA, 'Dana', T + 4000, 'last chance'));
    const again = await until('a new request', () => requestOf(`message:${DANA}`, mark));
    expect(again.ts).toBe(T + 4000);
    expect(of('conversation', mark).map((c) => c.conversation.nativeId)).toContain(dm(DANA));
  });

  test('block: block, then delete; nothing more from them', async () => {
    const mark = events.length;
    const res = await cmd({ t: 'answer', request: `message:${DANA}`, answer: 'block' });
    expect(calls('block').at(-1).params).toEqual({ recipient: [DANA] });
    expect(calls('sendMessageRequestResponse').at(-1).params).toEqual({ recipient: [DANA], type: 'delete' });
    expect(res).toEqual({ identity: DANA, relationship: 'blocked' });
    expect(gone(`message:${DANA}`, mark)).toBe(true);
    expect(of('leave', mark)).toEqual([{ t: 'leave', kind: 'conversation', nativeId: dm(DANA) }]);
  });

  test('a request that is not waiting: an error, and the hub is told it is gone', async () => {
    const mark = events.length;
    await expect(cmd({ t: 'answer', request: `message:${DANA}`, answer: 'accept' })).rejects.toThrow('That request is not waiting any more');
    expect(gone(`message:${DANA}`, mark)).toBe(true);
  });

  test('an invitation, accepted: updateGroup with the group id alone; the conversation before the reply', async () => {
    const mark = events.length;
    const n = calls('updateGroup').length;
    const res = await cmd({ t: 'answer', request: `invite:${PARTY}`, answer: 'accept' });
    expect(calls('updateGroup').slice(n).map((c) => c.params)).toEqual([{ groupId: PARTY }]);
    expect(res).toEqual({ conversation: `group:${PARTY}` });
    expect(of('conversation', mark).find((c) => c.conversation.nativeId === `group:${PARTY}`)!.conversation).toMatchObject({ shape: 'group', name: 'Surprise party', participants: [ALICE, SELF] });
    expect(of('message', mark).at(-1)!.message).toMatchObject({ conversation: `group:${PARTY}`, author: SELF, kind: 'system', body: 'You accepted the invitation to the group.' });
    expect(gone(`invite:${PARTY}`, mark)).toBe(true);
  });

  test('a new invitation, by a group update: a request from whoever sent it; no conversation, no message', async () => {
    const mark = events.length;
    editGroups((l) => [...l, group(PICNIC, 'Picnic', { invited: true })]);
    push(groupUpdate(PICNIC, 'Picnic', T + 5000));
    const r = await until('the invitation', () => requestOf(`invite:${PICNIC}`, mark));
    expect(r).toEqual({ nativeId: `invite:${PICNIC}`, kind: 'invite', from: ALICE, target: { kind: 'conversation', nativeId: `group:${PICNIC}`, name: 'Picnic', members: 1 }, ts: T + 5000, answers: ANSWERS });
    await Bun.sleep(300);
    expect(of('conversation', mark).some((c) => c.conversation.nativeId === `group:${PICNIC}`)).toBe(false);
    expect(of('message', mark).some((m) => m.message.conversation === `group:${PICNIC}`)).toBe(false);
    expect(await cmd({ t: 'markRead', conversation: `group:${PICNIC}`, upTo: `${ALICE}:${T + 5000}` })).toEqual({ receipts: 0 });
  });

  test('the invitation withdrawn: the next update drops it, and still no conversation', async () => {
    const mark = events.length;
    editGroups((l) => void (l.find((g) => g.id === PICNIC).pendingMembers = []));
    push(groupUpdate(PICNIC, 'Picnic', T + 6000));
    await until('requestGone', () => gone(`invite:${PICNIC}`, mark));
    await Bun.sleep(300);
    expect(of('conversation', mark).some((c) => c.conversation.nativeId === `group:${PICNIC}`)).toBe(false);
    expect(of('message', mark).some((m) => m.message.conversation === `group:${PICNIC}`)).toBe(false);
  });

  test('an invitation accepted on another device: the group shows, with its update, and the request goes', async () => {
    let mark = events.length;
    editGroups((l) => [...l, group(HIKE, 'Hike', { invited: true })]);
    push(groupUpdate(HIKE, 'Hike', T + 7000));
    await until('the invitation', () => requestOf(`invite:${HIKE}`, mark));
    mark = events.length;
    editGroups((l) => [...l.filter((g) => g.id !== HIKE), group(HIKE, 'Hike', { member: true })]);
    push(groupUpdate(HIKE, 'Hike', T + 8000));
    await until('requestGone', () => gone(`invite:${HIKE}`, mark));
    const c = await until('the conversation', () => of('conversation', mark).find((e) => e.conversation.nativeId === `group:${HIKE}`));
    expect(c.conversation).toMatchObject({ name: 'Hike', participants: [SELF, ALICE] });
    await until('its update', () => of('message', mark).find((m) => m.message.conversation === `group:${HIKE}` && m.message.kind === 'system'));
  });

  test('invitations declined (quitGroup) and blocked (quitGroup, then block the group), found by a read', async () => {
    let mark = events.length;
    editGroups((l) => [...l, group(CAMP, 'Camp', { invited: true }), group(SPAM, 'Free crypto', { invited: true })]);
    await adapter.snapshot();
    expect(requestOf(`invite:${CAMP}`, mark)).toMatchObject({ kind: 'invite', target: { name: 'Camp' } });
    expect(requestOf(`invite:${SPAM}`, mark)).toMatchObject({ kind: 'invite', target: { name: 'Free crypto' } });
    expect(requestOf(`invite:${CAMP}`, mark)!.from).toBeUndefined(); // listGroups does not say who invited you
    expect(of('requests', mark)).toEqual([]); // known already: changes only
    mark = events.length;
    let n = calls('quitGroup').length;
    expect(await cmd({ t: 'answer', request: `invite:${CAMP}`, answer: 'decline' })).toEqual({});
    expect(calls('quitGroup').slice(n).map((c) => c.params)).toEqual([{ groupId: CAMP }]);
    expect(gone(`invite:${CAMP}`, mark)).toBe(true);
    n = calls('quitGroup').length;
    const res = await cmd({ t: 'answer', request: `invite:${SPAM}`, answer: 'block' });
    expect(calls('quitGroup').slice(n).map((c) => c.params)).toEqual([{ groupId: SPAM }]);
    expect(calls('block').at(-1).params).toEqual({ groupId: [SPAM] });
    expect(res).toEqual({ notes: ['Declined and blocked: invitations to this group no longer reach you'] });
    mark = events.length;
    await adapter.snapshot();
    expect(of('request', mark)).toEqual([]);
    expect(of('conversation', mark).some((c) => [`group:${CAMP}`, `group:${SPAM}`].includes(c.conversation.nativeId))).toBe(false);
  });

  test('resolve a group link: partial when signal-cli has not got the group, joined when you are in it; never acts', async () => {
    const n = records().length;
    expect(await cmd({ t: 'resolve', ref: invite(LINK(9)) })).toEqual({ what: 'group', name: LINK(9), partial: true, actions: ['join'], notes: ['Signal shows the group only after you join'] });
    expect(await cmd({ t: 'resolve', ref: invite(LINK(1)) })).toEqual({ what: 'group', name: 'Climbing crew', nativeId: `group:${CREW}`, members: 2, joined: { conversation: `group:${CREW}` }, actions: [], notes: ['You are in this group already'] });
    await expect(cmd({ t: 'resolve', ref: invite('https://signal.group/#CjQKIFakeLockedGroupLink') })).rejects.toThrow('This is not a working Signal group link');
    expect(new Set(methodsSince(n))).toEqual(new Set(['listGroups']));
  });

  test('resolve people: a username, a number and a username link; nobody; rate limited; never acts', async () => {
    const n = records().length;
    let mark = events.length;
    expect(await cmd({ t: 'resolve', ref: who('alice.37') })).toEqual({ what: 'person', name: 'Alice Chen', nativeId: ALICE, relationship: 'contact', actions: ['message'] });
    expect(calls('getUserStatus').at(-1).params).toEqual({ username: ['alice.37'] });
    expect(await cmd({ t: 'resolve', ref: who('+15550137') })).toMatchObject({ what: 'person', name: 'Alice Chen', nativeId: ALICE, relationship: 'contact' });
    expect(calls('getUserStatus').at(-1).params).toEqual({ recipient: ['+15550137'] });
    mark = events.length;
    const link = 'https://signal.me/#eu/FakeUsernameLinkForMei0000';
    expect(await cmd({ t: 'resolve', ref: who(link) })).toEqual({ what: 'person', name: 'Mei', nativeId: MEI, relationship: 'stranger', actions: ['message'] });
    expect(calls('getUserStatus').at(-1).params).toEqual({ username: [link] });
    expect(of('identity', mark).map((e) => e.identity)).toEqual([{ nativeId: MEI, displayName: 'Mei' }]); // before the reply
    await expect(cmd({ t: 'resolve', ref: who('+15550111') })).rejects.toThrow('No Signal account has this number');
    await expect(cmd({ t: 'resolve', ref: who('nobody.99') })).rejects.toThrow('No Signal account has this username');
    await expect(cmd({ t: 'resolve', ref: who('busy.42') })).rejects.toThrow(/^Signal is limiting how often this device can look people up; try again in 10 minutes$/);
    expect(of('status', mark).some((s) => s.status !== 'online')).toBe(false); // the lookup's limit, not the account's
    expect(new Set(methodsSince(n))).toEqual(new Set(['getUserStatus', 'listContacts']));
  });

  test('join by link: joinGroup with the URI, the conversation before the reply; in already: nothing called', async () => {
    let mark = events.length;
    const res = await cmd({ t: 'add', ref: invite(LINK(3)), action: 'join' });
    expect(calls('joinGroup').at(-1).params).toEqual({ uri: LINK(3) });
    expect(res).toEqual({ conversation: `group:${GAMES}` });
    expect(of('conversation', mark).find((c) => c.conversation.nativeId === `group:${GAMES}`)!.conversation).toMatchObject({ name: 'Board games', participants: [ALICE, SELF] });
    expect(of('message', mark).at(-1)!.message).toMatchObject({ conversation: `group:${GAMES}`, kind: 'system', body: 'You joined the group via the group link.' });
    const joins = calls('joinGroup').length;
    expect(await cmd({ t: 'add', ref: invite(LINK(3)), action: 'join' })).toEqual({ conversation: `group:${GAMES}`, notes: ['You are in this group already'] });
    expect(calls('joinGroup').length).toBe(joins);
    mark = events.length;
    expect(await cmd({ t: 'resolve', ref: invite(LINK(3)) })).toMatchObject({ name: 'Board games', joined: { conversation: `group:${GAMES}` } });
  });

  test("join a group whose admins approve: pending, no conversation; asking again calls nothing", async () => {
    const mark = events.length;
    expect(await cmd({ t: 'add', ref: invite(LINK(4)), action: 'ask' })).toEqual({ pending: true, notes: ["Asked to join: the group's admins decide"] });
    expect(of('conversation', mark).some((c) => c.conversation.nativeId === `group:${ASK}`)).toBe(false);
    const joins = calls('joinGroup').length;
    expect(await cmd({ t: 'add', ref: invite(LINK(4)), action: 'join' })).toEqual({ pending: true, notes: ['You asked to join already; its admins have not answered'] });
    expect(calls('joinGroup').length).toBe(joins);
    expect(await cmd({ t: 'resolve', ref: invite(LINK(4)) })).toEqual({ what: 'group', name: 'Book club', nativeId: `group:${ASK}`, actions: [], notes: ['You asked to join already; its admins have not answered'] });
  });

  test('a dead link, a captcha (a check: nothing done), and what Signal cannot add', async () => {
    await expect(cmd({ t: 'add', ref: invite(LINK(5)), action: 'join' })).rejects.toThrow('This group link has been reset or turned off');
    expect(await cmd({ t: 'add', ref: invite(LINK(6)), action: 'join' })).toEqual({ check: 'captcha', notes: ['Signal wants a captcha from this device before it joins; nothing was done'] });
    const joins = calls('joinGroup').length;
    await expect(cmd({ t: 'add', ref: who('alice.37'), action: 'friend' })).rejects.toThrow(/no friend requests/);
    await expect(cmd({ t: 'add', ref: { kind: 'invite', network: 'discord', code: 'abc', url: 'https://discord.gg/abc' }, action: 'join' })).rejects.toThrow('This is a Signal account');
    expect(calls('joinGroup').length).toBe(joins);
  });

  test('the hub reconnects: hello, status, and the whole list again', async () => {
    const mark = events.length;
    push(dmFrom(ELI, 'Eli', T + 9000, 'hi?'));
    await until('the request', () => requestOf(`message:${ELI}`, mark));
    const at = events.length;
    adapter.onHubConnect();
    expect(events.slice(at).map((e) => e.t)).toEqual(['hello', 'status', 'requests', 'relationships']);
    expect(of('requests', at)[0].requests.map((r) => r.nativeId)).toEqual([`message:${ELI}`]);
  });

  test('a restart: the same list from state.json; what was answered stays answered', async () => {
    await adapter.shutdown();
    adapter = makeAdapter();
    const mark = events.length;
    await adapter.start();
    const list = await until('requests', () => of('requests', mark)[0]);
    expect(list.requests.map((r) => r.nativeId)).toEqual([`message:${ELI}`]);
    expect(await cmd({ t: 'markRead', conversation: dm(ELI), upTo: `${ELI}:${T + 9000}` })).toEqual({ receipts: 0 });
    expect(await cmd({ t: 'markRead', conversation: dm(JAMIE), upTo: `${JAMIE}:${T + 500}` })).toEqual({ receipts: 1 }); // not held back (after a restart the target is acknowledged once more, as before)
    expect(await cmd({ t: 'typing', conversation: dm(JAMIE) })).toEqual({ ok: true });
  });
});
