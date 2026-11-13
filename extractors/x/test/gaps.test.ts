import { expect, test } from 'bun:test';
import { aboutOf, directFact, groupFact, ingestRequests, requestFact, Requests } from '../src/gaps.ts';
import { XState } from '../src/ingest.ts';
import type { RawAbout, RawUser } from '../src/raw.ts';
import * as V from '../src/validate.ts';
import { ALICE, BOB, conv, SELF, T0 } from './fixtures.ts';

const CAROL: RawUser = { id: '4004', screenName: 'carol_c', displayName: 'Carol C', avatarUrl: null };
const REQ = conv({ id: '1001:4004', legacy: false, users: [CAROL], lastSeq: '2', lastTs: T0 });
const GROUP_REQ = conv({ id: 'g77', legacy: false, group: true, title: 'Book club', users: [ALICE, BOB], lastSeq: '5' });

function state() {
  const st = new XState();
  st.selfId = SELF;
  return st;
}

test('a request: a one-to-one is a message request from them, a group an invitation; X answers a group only with Accept', () => {
  expect(requestFact(REQ, SELF)).toEqual({ nativeId: '1001:4004', kind: 'message', from: CAROL.id, target: { kind: 'conversation', nativeId: '1001:4004' }, ts: T0, answers: ['accept', 'decline', 'block'] });
  expect(requestFact(GROUP_REQ, SELF)).toEqual({ nativeId: 'g77', kind: 'invite', target: { kind: 'conversation', nativeId: 'g77', name: 'Book club', members: 3 }, ts: T0, answers: ['accept'] });
});

test('the Requests list: the whole list first, with its people and conversations; then only what changed', () => {
  const st = state();
  const rq = new Requests();
  // Still loading: nothing said, so the hub keeps what it had.
  expect(ingestRequests(st, rq, { requests: [], loading: true, more: false, failed: false }).events).toEqual([]);
  const first = ingestRequests(st, rq, { requests: [REQ], loading: false, more: false, failed: false });
  expect(first.events.map((e) => e.t)).toEqual(['identity', 'conversation', 'requests']);
  expect(first.events.at(-1)).toEqual({ t: 'requests', requests: [requestFact(REQ, SELF)] });
  expect(first.events[1]).toMatchObject({ t: 'conversation', conversation: { nativeId: REQ.id, shape: 'direct', encrypted: true, participants: [SELF, CAROL.id] } });
  // Its messages are worth reading (quietly): nothing was announced in it yet.
  expect(first.newer).toEqual([REQ.id]);
  // The same again: nothing.
  expect(ingestRequests(st, rq, { requests: [REQ], loading: false, more: false, failed: false }).events).toEqual([]);
  // One more: a request event for it alone.
  const second = ingestRequests(st, rq, { requests: [REQ, GROUP_REQ], loading: false, more: false, failed: false });
  expect(second.events.filter((e) => e.t === 'request')).toEqual([{ t: 'request', request: requestFact(GROUP_REQ, SELF) }]);
  // Carol's gone (answered on the phone): requestGone.
  const third = ingestRequests(st, rq, { requests: [GROUP_REQ], loading: false, more: false, failed: false });
  expect(third.events).toEqual([{ t: 'requestGone', nativeId: REQ.id }]);
  expect(rq.has(REQ.id)).toBe(false);
  // After a reconnect, the whole list again.
  expect(rq.all(st).at(-1)).toEqual({ t: 'requests', requests: [requestFact(GROUP_REQ, SELF)] });
  // Answered here: gone once.
  expect(rq.gone(GROUP_REQ.id)).toEqual([{ t: 'requestGone', nativeId: GROUP_REQ.id }]);
  expect(rq.gone(GROUP_REQ.id)).toEqual([]);
});

const about = (over: Partial<RawAbout> = {}): RawAbout => ({
  conv: 'g9001',
  group: true,
  legacy: false,
  request: false,
  title: 'Weekend plans',
  description: 'Saturday',
  avatarUrl: null,
  muted: false,
  adminOnlyEditGroupInfo: false,
  adminOnlyAddMembers: false,
  adminOnlySendMessages: false,
  participants: [
    { id: SELF, admin: false, current: true },
    { id: ALICE.id, admin: true, current: true },
    { id: BOB.id, admin: false, current: false },
  ],
  member: true,
  selfAdmin: false,
  users: [ALICE],
  ...over,
});

test("a group's About: name and description editable as X says, the picture not from here, its admins, who adds", () => {
  const a = aboutOf(about(), SELF);
  expect(a.noun).toBe('Group');
  expect(a.fields.name).toEqual({ value: 'Weekend plans', canEdit: true });
  expect(a.fields.topic).toEqual({ value: 'Saturday', canEdit: true });
  expect(a.fields.avatar).toMatchObject({ canEdit: false, reason: expect.stringContaining('not built yet') });
  // Who left is not listed; the admin is.
  expect(a.members).toEqual({ list: [{ id: SELF, role: 'Member', rank: 0 }, { id: ALICE.id, role: 'Admin', rank: 100 }], complete: true });
  expect(a.adding).toEqual({ can: true, who: 'known', mode: 'add' });
  // Admin-only info and adding, and you are not an admin: why not.
  const locked = aboutOf(about({ adminOnlyEditGroupInfo: true, adminOnlyAddMembers: true }), SELF);
  expect(locked.fields.name).toEqual({ value: 'Weekend plans', canEdit: false, reason: 'Only admins can edit this group’s name and description.' });
  expect(locked.adding).toMatchObject({ can: false, reason: 'Only admins can add people to this group.' });
  expect(locked.rules?.[0]).toEqual({ what: 'Edit the name, description and picture', who: 'Only admins', you: false });
  // An admin may.
  expect(aboutOf(about({ adminOnlyEditGroupInfo: true, selfAdmin: true }), SELF).fields.name?.canEdit).toBe(true);
  // A group waiting as a request, an old group DM: not from here, and why.
  expect(aboutOf(about({ request: true }), SELF).fields.name).toMatchObject({ canEdit: false, reason: 'Accept the request first.' });
  expect(aboutOf(about({ legacy: true }), SELF).fields.topic).toMatchObject({ canEdit: false, reason: expect.stringContaining('only XChat groups') });
  expect(aboutOf(about({ muted: true }), SELF).facts).toEqual([{ label: 'Notifications', value: 'Muted on X' }]);
});

test("a one-to-one's About: the two of you, nothing to change", () => {
  const a = aboutOf(about({ conv: '1001:3003', group: false, title: null, description: null, participants: [], member: null, users: [BOB] }), SELF);
  expect(a).toEqual({ noun: 'Chat', fields: {}, members: { list: [{ id: SELF }, { id: BOB.id }], complete: true }, facts: [{ label: 'Kind', value: 'XChat (encrypted)' }] });
});

test('facts for what is made from here: a one-to-one before its first message, a group with whom X put in it', () => {
  expect(directFact('1001:5005', SELF, '5005')).toEqual({ nativeId: '1001:5005', shape: 'direct', encrypted: true, participants: [SELF, '5005'] });
  expect(directFact('1001-5005', SELF, '5005').encrypted).toBe(false);
  expect(groupFact('g9100', SELF, ['5005', '2002'], 'Hike')).toEqual({ nativeId: 'g9100', shape: 'group', name: 'Hike', encrypted: true, participants: [SELF, '5005', '2002'] });
});

test('validation: the Requests list and an About, checked as the inbox is', () => {
  const d = new V.Drops();
  const r = V.requests({ requests: [{ ...REQ }, { id: 'bad id!' }, { ...REQ }], loading: false, more: true }, d);
  expect(r?.requests.map((c) => c.id)).toEqual([REQ.id]);
  expect(r?.more).toBe(true);
  expect(V.requests({ nope: 1 }, d)).toBeNull();
  const a = V.about({ conv: 'g9001', group: true, title: 'T', participants: [{ id: SELF, admin: true }, { id: '<x>' }], users: [ALICE, { id: 'x', screenName: 'no spaces allowed' }], selfAdmin: true, avatarUrl: 'https://evil.example/a.png' }, d);
  expect(a).toMatchObject({ conv: 'g9001', group: true, title: 'T', participants: [{ id: SELF, admin: true, current: true }], users: [ALICE], selfAdmin: true, avatarUrl: null });
  expect(V.about({ conv: '' }, d)).toBeNull();
  expect(d.summary()).toContain('requests.no-list 1');
});
