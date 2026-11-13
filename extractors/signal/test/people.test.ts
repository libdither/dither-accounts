/**
 * People and this device (src/people.ts) through the whole adapter against test/fake-signal-cli.ts: safety numbers,
 * blocking, contacts as the account's list, nicknames and notes, your own profile and username, devices, captchas
 * and relinking. Steps share one adapter and run in order. Nothing here reaches Signal.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { About, AdapterEvent, PersonAbout } from '@dither-chat/protocol';
import { type AdapterHost, CAPABILITIES, SignalAdapter } from '../src/adapter.ts';
import { challengeOf, cleanCaptcha, cleanSafetyNumber, cleanUsername, contactChange, devicesDetail, keyChanges, safetyOf, splitName } from '../src/people.ts';

const FAKE = join(import.meta.dir, 'fake-signal-cli.ts');
const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const SAM = '5a3e0000-3333-4eee-afff-000000000003';
const BLAKE = 'b10c0000-5555-4ddd-9eee-000000000005';
const GID = 'Cl1mb1ngCrew+Gr0up0000000000000000000000000=';
const GROUP = `group:${GID}`;
const DM_ALICE = `dm:${SELF}:${ALICE}`;

let dir: string;
let signalDir: string;
let adapter: SignalAdapter;
const events: AdapterEvent[] = [];
const logs: string[] = [];
let secret: Record<string, any> = {};

const until = async <T>(what: string, fn: () => T | undefined | null | false, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${logs.slice(-15).join('\n')}`);
    await Bun.sleep(20);
  }
};
const of = <K extends AdapterEvent['t']>(t: K, from = 0) => events.slice(from).filter((e): e is Extract<AdapterEvent, { t: K }> => e.t === t);
const lastStatus = () => of('status').at(-1)!;
const records = () =>
  existsSync(join(signalDir, 'fake-rpc.jsonl'))
    ? readFileSync(join(signalDir, 'fake-rpc.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const calls = (method: string) => records().filter((r) => r.t === 'rpc' && r.method === method);
const cmd = (c: any) => adapter.command({ id: String(Math.random()), ...c });
const profile = (who: string) => cmd({ t: 'profile', who }) as Promise<PersonAbout>;
const resync = () => cmd({ t: 'action', action: 'resync' });
const editJson = (name: string, fn: (all: any[]) => void) => {
  const file = join(signalDir, name);
  const all = JSON.parse(readFileSync(file, 'utf8'));
  fn(all);
  writeFileSync(file, JSON.stringify(all));
};
let pushes = 0;
const push = (o: object) => {
  const d = join(signalDir, 'fake-push');
  require('node:fs').mkdirSync(d, { recursive: true });
  const tmp = join(signalDir, `push-${pushes}.tmp`);
  writeFileSync(tmp, JSON.stringify(o));
  require('node:fs').renameSync(tmp, join(d, `${String(pushes++).padStart(4, '0')}.json`));
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-sigp-'));
  signalDir = join(dir, 'signal-cli');
  process.env.FAKE_LINK_TIMEOUT_MS = '5000';
  const host: AdapterHost = {
    emit: (ev) => events.push(ev),
    log: (level, msg) => (logs.push(`[${level}] ${msg}`), process.env.SHOWLOG && console.log(level, msg)),
    accountDir: dir,
    config: {},
    secret: () => secret,
    saveSecret: (v) => {
      secret = v as Record<string, any>;
    },
  };
  adapter = new SignalAdapter(host, {
    signalCli: async () => [process.execPath, FAKE],
    linkRotateMs: 60_000,
    restartBackoffMs: [100, 200, 400],
    resnapshotMs: [0],
    resnapshotEveryMs: 3_600_000,
    expirySweepMs: 3_600_000,
    daemonReadyTimeoutMs: 10_000,
    daemonHealthEveryMs: 60_000,
  });
});

afterAll(async () => {
  await adapter?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('people.ts helpers', () => {
  test('a key not seen before is no change; a different fingerprint is, with when it came', () => {
    const first = keyChanges(new Map(), [{ uuid: ALICE.toUpperCase(), fingerprint: 'aa', addedTimestamp: 5 }]);
    expect(first.changed).toEqual([]);
    expect(first.keys.get(ALICE)).toEqual({ f: 'aa', a: 5 });
    const same = keyChanges(first.keys, [{ uuid: ALICE, fingerprint: 'aa', addedTimestamp: 5 }]);
    expect(same.changed).toEqual([]);
    const next = keyChanges(first.keys, [{ uuid: ALICE, fingerprint: 'bb', addedTimestamp: 9 }, { uuid: SAM, fingerprint: 'cc', addedTimestamp: 7 }]);
    expect(next.changed).toEqual([{ aci: ALICE, at: 9 }]);
    expect(next.keys.get(ALICE)).toEqual({ f: 'bb', a: 9, c: 9 });
    expect(next.keys.get(SAM)).toEqual({ f: 'cc', a: 7 });
    expect(safetyOf({ safetyNumber: '1'.repeat(60), trustLevel: 'TRUSTED_VERIFIED', scannableSafetyNumber: 'AQ==' }, next.keys.get(ALICE))).toEqual({ digits: '1'.repeat(60), scannable: 'AQ==', trust: 'verified', changedAt: 9 });
  });

  test('names keep the split the phone made; nickname and note changes send only what changed', () => {
    expect(splitName('Ada Lovelace', { given: 'Ada', family: 'Lovelace' })).toEqual({ given: 'Ada', family: 'Lovelace' });
    expect(splitName('Augusta Ada Lovelace', { given: 'Ada', family: 'Lovelace' })).toEqual({ given: 'Augusta Ada', family: 'Lovelace' });
    expect(splitName('Ada King', { given: 'Ada', family: 'Lovelace' })).toEqual({ given: 'Ada King', family: '' });
    const c = { nickGivenName: 'Ali', nickFamilyName: 'C', note: 'climbs' };
    expect(contactChange(c, { nickname: 'Ali C', note: 'climbs' })).toBeNull();
    expect(contactChange(c, { nickname: 'Alison C' })).toEqual({ nickGivenName: 'Alison', nickFamilyName: 'C' });
    expect(contactChange(c, { note: '' })).toEqual({ note: '' });
    expect(() => contactChange(c, { nickname: 'x'.repeat(101) })).toThrow('100');
  });

  test('safety numbers, usernames, captchas and devices as typed', () => {
    expect(cleanSafetyNumber('12345 '.repeat(12))).toBe('12345'.repeat(12));
    expect(() => cleanSafetyNumber('123')).toThrow('60 digits');
    expect(cleanUsername('@quinn')).toBe('quinn');
    expect(cleanUsername('quinn.07')).toBe('quinn.07');
    expect(() => cleanUsername('1quinn')).toThrow();
    expect(cleanCaptcha(' signalcaptcha://signal-hcaptcha.abcdefghijklmnopqrstuvwxyz ')).toBe('signal-hcaptcha.abcdefghijklmnopqrstuvwxyz');
    expect(() => cleanCaptcha('nope')).toThrow();
    expect(challengeOf({ data: { response: { results: [{ type: 'RATE_LIMIT_FAILURE', token: 't1' }] } } })).toBe('t1');
    expect(challengeOf({ results: [{ type: 'SUCCESS' }] })).toBeNull();
    expect(devicesDetail([{ id: 2, name: 'dither-chat' }, { id: 1, name: null, lastSeenTimestamp: 1000 }], 2, 1000)).toBe('Phone #1 (primary), seen today; dither-chat #2 (this one)');
  });
});

describe('signal people and this device against a fake signal-cli', () => {
  test('links, comes online, and asks the phone for a sync once', async () => {
    const key = (n: number, uuid: string, number: string) => ({ number, uuid, fingerprint: `05${String(n).repeat(64)}`, safetyNumber: `${n}`.repeat(60), scannableSafetyNumber: Buffer.from(`scan-${n}`).toString('base64'), trustLevel: 'TRUSTED_UNVERIFIED', addedTimestamp: 1700000000000 + n });
    require('node:fs').mkdirSync(signalDir, { recursive: true });
    writeFileSync(join(signalDir, 'fake-identities.json'), JSON.stringify([key(1, ALICE, '+15550137'), key(2, SAM, '+15550161')]));
    await adapter.start();
    expect(events[0]).toMatchObject({ t: 'hello', capabilities: CAPABILITIES });
    for (const c of ['relationships', 'disconnect', 'block', 'safetyNumbers', 'contactNotes'] as const) expect(CAPABILITIES).toContain(c);
    await until('a QR code', () => of('status').find((s) => s.attention?.qr));
    writeFileSync(join(signalDir, 'fake-scan'), '');
    await until('online', () => of('status').find((s) => s.status === 'online'));
    await until('the sync request after linking', () => calls('sendSyncRequest').length === 1);
  });

  test('the account page: signal-cli version, this device and the linked devices', async () => {
    const st = await until('details', () => of('status').find((s) => s.details?.['linked devices']));
    expect(st.details).toMatchObject({ 'signal-cli': '0.14.8-fake', 'this device': 'dither-chat (#2)', 'linked devices': expect.stringContaining('dither-chat #2 (this one)') });
    expect(st.layers![0]).toEqual({ name: 'signal-cli', state: 'ok', note: 'signal-cli 0.14.8-fake' });
  });

  test('contacts and blocks as the account list; identity facts carry nickname and note', async () => {
    const rel = await until('relationships', () => of('relationships')[0]);
    expect(rel.list).toEqual(expect.arrayContaining([{ identity: ALICE, relationship: 'contact' }, { identity: SAM, relationship: 'contact' }, { identity: BLAKE, relationship: 'blocked' }]));
    expect(rel.list.some((r) => r.identity === SELF)).toBe(false);
    const alice = of('identity').find((e) => e.identity.nativeId === ALICE)!.identity;
    // Nothing to say yet: an empty nickname or note goes only to clear one the hub was told.
    expect(alice).toEqual({ nativeId: ALICE, handle: '+15550137', displayName: 'Alice Chen', contact: true });
  });

  test('a safety number on the profile; a changed key is a line in the 1:1 and a mark on the profile', async () => {
    await cmd({ t: 'send', conversation: DM_ALICE, body: 'hi' });
    const p = await profile(ALICE);
    expect(p.safety).toEqual({ digits: '1'.repeat(60), scannable: Buffer.from('scan-1').toString('base64'), trust: 'unverified' });
    // First read: nothing changed.
    expect(of('message').some((e) => /safety number/.test(e.message.body))).toBe(false);
    const fresh = { number: '+15550137', uuid: ALICE, fingerprint: '05' + '9'.repeat(64), safetyNumber: '9'.repeat(60), scannableSafetyNumber: 'OQ==', trustLevel: 'TRUSTED_UNVERIFIED', addedTimestamp: 1793330000000 };
    writeFileSync(join(signalDir, 'fake-identities.json'), JSON.stringify([fresh]));
    await resync();
    const line = await until('the line', () => of('message').find((e) => e.message.body === 'Your safety number with Alice Chen has changed.'));
    expect(line.message).toMatchObject({ conversation: DM_ALICE, kind: 'system', author: SELF, ts: 1793330000000 });
    expect((await profile(ALICE)).safety).toMatchObject({ digits: '9'.repeat(60), changedAt: 1793330000000 });
    // Read again, nothing new.
    const n = events.length;
    await resync();
    expect(of('message', n).some((e) => /safety number/.test(e.message.body))).toBe(false);
  });

  test('verify: only the current number; then cleared', async () => {
    await expect(cmd({ t: 'verify', who: ALICE, safetyNumber: '1'.repeat(60) })).rejects.toThrow('changed since');
    const p = (await cmd({ t: 'verify', who: ALICE, safetyNumber: '99999 '.repeat(12) })) as PersonAbout;
    expect(p.safety?.trust).toBe('verified');
    expect(calls('trust').at(-1).params).toEqual({ recipient: ALICE, verifiedSafetyNumber: '9'.repeat(60) });
    expect(of('message').some((e) => e.message.body === 'You marked your safety number with Alice Chen verified.')).toBe(true);
    const q = (await cmd({ t: 'verify', who: ALICE, clear: true })) as PersonAbout;
    expect(q.safety?.trust).toBe('unverified');
    expect(calls('trust').at(-1).params).toEqual({ recipient: ALICE, trustAllKnownKeys: true });
    writeFileSync(join(signalDir, 'fake-identities.json'), JSON.stringify([]));
    await expect(cmd({ t: 'verify', who: SAM, safetyNumber: '2'.repeat(60) })).rejects.toThrow('no safety number');
  });

  test('block and unblock a person (remove with blocked); hide a contact', async () => {
    const mark = events.length;
    expect(await cmd({ t: 'block', target: { kind: 'identity', nativeId: SAM } })).toEqual({ blocked: true });
    expect(calls('block').at(-1).params).toEqual({ recipient: [SAM] });
    expect(of('relationship', mark)).toContainEqual({ t: 'relationship', fact: { identity: SAM, relationship: 'blocked' } });
    await expect(cmd({ t: 'remove', identity: SAM, relationship: 'contact' })).rejects.toThrow('look again');
    const r = await cmd({ t: 'remove', identity: SAM, relationship: 'blocked' });
    expect(r).toEqual({ identity: SAM, relationship: 'contact' });
    expect(calls('unblock').at(-1).params).toEqual({ recipient: [SAM] });
    expect(await cmd({ t: 'remove', identity: SAM, relationship: 'contact' })).toEqual({ identity: SAM, relationship: 'stranger' });
    expect(calls('removeContact').at(-1).params).toEqual({ recipient: SAM, hide: true });
    expect(of('relationship', mark).at(-1)).toEqual({ t: 'relationship', fact: { identity: SAM, relationship: 'stranger' } });
  });

  test('block a group from its About', async () => {
    expect(await cmd({ t: 'block', target: { kind: 'conversation', nativeId: GROUP } })).toEqual({ blocked: true });
    expect(((await cmd({ t: 'about', target: { kind: 'conversation', nativeId: GROUP } })) as About).blocked).toBe(true);
    expect(await cmd({ t: 'block', target: { kind: 'conversation', nativeId: GROUP }, unblock: true })).toEqual({ blocked: false });
    expect(calls('unblock').at(-1).params).toEqual({ groupId: [GID] });
    await expect(cmd({ t: 'block', target: { kind: 'conversation', nativeId: DM_ALICE } })).rejects.toThrow('block the person');
  });

  test('your nickname and note write through, each alone', async () => {
    const mark = events.length;
    await cmd({ t: 'setContact', who: ALICE, nickname: 'Ali C', note: 'belays' });
    expect(calls('updateContact').at(-1).params).toEqual({ recipient: ALICE, nickGivenName: 'Ali C', nickFamilyName: '', note: 'belays' });
    const f = await until('the identity', () => of('identity', mark).find((e) => e.identity.nativeId === ALICE && e.identity.nickname === 'Ali C'));
    expect(f.identity).toMatchObject({ displayName: 'Alice Chen', nickname: 'Ali C', note: 'belays' });
    const n = calls('updateContact').length;
    await cmd({ t: 'setContact', who: ALICE, nickname: 'Ali C' });
    expect(calls('updateContact').length).toBe(n); // already so
    const m2 = events.length;
    await cmd({ t: 'setContact', who: ALICE, note: '' });
    expect(calls('updateContact').at(-1).params).toEqual({ recipient: ALICE, note: '' });
    expect(of('identity', m2).find((e) => e.identity.nativeId === ALICE)?.identity).toMatchObject({ nickname: 'Ali C', note: '' });
  });

  test('a 1:1 archived on the phone says so', async () => {
    editJson('fake-contacts.json', (all) => (all.find((c) => c.uuid === ALICE).isArchived = true));
    const mark = events.length;
    await resync();
    expect(of('conversation', mark).find((e) => e.conversation.nativeId === DM_ALICE)?.conversation.archived).toBe(true);
  });

  test('a profile key update reads that person again', async () => {
    const n = calls('listContacts').filter((c) => c.params?.recipient?.includes(ALICE)).length;
    push({ account: '+15550100', envelope: { source: '+15550137', sourceNumber: '+15550137', sourceUuid: ALICE, sourceName: 'Alice', sourceDevice: 1, timestamp: 1793330009000, dataMessage: { timestamp: 1793330009000, message: null, isProfileKeyUpdate: true } } });
    await until('a re-read', () => calls('listContacts').filter((c) => c.params?.recipient?.includes(ALICE)).length > n);
  });

  test('your own profile: name, emoji, picture and username', async () => {
    const pic = join(dir, 'me.png');
    writeFileSync(pic, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const p = (await cmd({ t: 'setProfile', change: { name: 'Quinn Q', emoji: '🌊', avatar: { path: pic, name: 'me.png', mime: 'image/png', size: 4, kind: 'image' }, username: 'quinn' } })) as PersonAbout;
    expect(calls('updateProfile').at(-1).params).toEqual({ aboutEmoji: '🌊', givenName: 'Quinn Q', familyName: '', avatar: pic });
    expect(calls('updateAccount').at(-1).params).toEqual({ username: 'quinn' });
    expect(p).toMatchObject({ displayName: 'Quinn Q', status: { emoji: '🌊' }, username: { name: 'quinn.42', link: 'https://signal.me/#eu/fake8' }, editable: ['bio', 'name', 'emoji', 'avatar', 'username'] });
    expect(p.links).toContainEqual({ label: 'Username', value: 'quinn.42', url: 'https://signal.me/#eu/fake8' });
    await cmd({ t: 'setProfile', change: { avatar: null } });
    expect(calls('updateProfile').at(-1).params).toEqual({ removeAvatar: true });
    const q = (await cmd({ t: 'setProfile', change: { username: null } })) as PersonAbout;
    expect(calls('updateAccount').at(-1).params).toEqual({ deleteUsername: true });
    expect(q.username).toBeUndefined();
    await expect(cmd({ t: 'setProfile', change: { name: '  ' } })).rejects.toThrow('needs a name');
  });

  test('a captcha: a check card, the owner pastes the token, and it goes to Signal', async () => {
    await expect(cmd({ t: 'send', conversation: DM_ALICE, body: 'CAPTCHA' })).rejects.toThrow('rate limiting');
    const st = lastStatus();
    expect(st).toMatchObject({ status: 'attention', attention: { kind: 'captcha', detail: { captcha: { url: 'https://signalcaptchas.org/challenge/generate.html', action: 'submitCaptcha' } } } });
    await expect(cmd({ t: 'action', action: 'submitCaptcha', args: { captcha: 'BADxxxxxxxxxxxxxxxxxxxxxxxx' } })).rejects.toThrow('did not take that captcha');
    expect(lastStatus().attention?.kind).toBe('captcha');
    await cmd({ t: 'action', action: 'submitCaptcha', args: { captcha: 'signalcaptcha://signal-hcaptcha.good-token-1234567890' } });
    expect(calls('submitRateLimitChallenge').at(-1).params).toEqual({ challenge: 'fake-challenge-1', captcha: 'signal-hcaptcha.good-token-1234567890' });
    expect(lastStatus()).toMatchObject({ status: 'online', attention: null });
    await expect(cmd({ t: 'action', action: 'submitCaptcha', args: { captcha: 'x'.repeat(30) } })).rejects.toThrow('not asking');
  });

  test('rename this device', async () => {
    await cmd({ t: 'action', action: 'renameDevice', args: { name: 'dither-chat at home' } });
    expect(calls('updateAccount').at(-1).params).toEqual({ deviceName: 'dither-chat at home' });
    expect(lastStatus().details?.['this device']).toBe('dither-chat at home (#2)');
  });

  test('relink: the old device is renamed, the link screen says to remove it, nothing unregisters', async () => {
    const mark = events.length;
    await cmd({ t: 'action', action: 'relink' });
    // The wipe takes the fake's record with it: the link screen names the device only once the rename went through.
    const st = await until('a QR code', () => of('status', mark).find((s) => s.attention?.qr));
    expect(st.attention!.message).toContain('remove the old “dither-chat (old)” (#2) under Linked devices');
    expect(existsSync(join(signalDir, 'data', 'accounts.json'))).toBe(false);
  });
});
