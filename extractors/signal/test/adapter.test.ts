/**
 * The whole adapter (link flow, daemon supervision, JSON-RPC over the UNIX
 * socket, commands) against test/fake-signal-cli.ts, which speaks signal-cli's
 * CLI/stdout/JSON-RPC protocol without any network. Steps share one adapter
 * and run in order.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { About, AddMembersResult, AdapterEvent, CreateGroupResult, PersonAbout } from '@dither-chat/protocol';
import { type AdapterHost, CAPABILITIES, createGroupError, createGroupParams, LINK_MESSAGE, SignalAdapter, socketPathFor, untold, untoldNotes, updateGroupParams } from '../src/adapter.ts';

const FAKE = join(import.meta.dir, 'fake-signal-cli.ts');
const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const SAM = '5a3e0000-3333-4eee-afff-000000000003';
const BLAKE = 'b10c0000-5555-4ddd-9eee-000000000005'; // blocked
const ROBIN = '0b5e7ae0-4444-4bbb-8ccc-000000000004'; // known, not a contact
const CASEY = 'c0de0000-6666-4fff-8aaa-000000000006'; // a contact whose profile key this device lacks (added later)
const STRAY = 'd0d00000-7777-4aaa-8bbb-000000000007'; // nobody signal-cli knows
const GID = 'Cl1mb1ngCrew+Gr0up0000000000000000000000000=';
const GROUP = `group:${GID}`;
const DM_ALICE = `dm:${SELF}:${ALICE}`;
const LOCKED_ID = 'L0ckedGr0up+AdminsOnly0000000000000000000000=';
const LOCKED = `group:${LOCKED_ID}`;
const INVITED = 'group:Inv1tedGr0up+NotJoined000000000000000000000=';
const T = 1793330000000;

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
const lastStatus = () => of('status').at(-1);
const records = () =>
  existsSync(join(signalDir, 'fake-rpc.jsonl'))
    ? readFileSync(join(signalDir, 'fake-rpc.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const calls = (method: string) => records().filter((r) => r.t === 'rpc' && r.method === method);
const argvs = (sub: string) => records().filter((r) => r.t === 'argv' && r.argv.includes(sub));
const alive = (pid: number) => existsSync(`/proc/${pid}`);
let pushes = 0;
const push = (fixture: string | object) => {
  mkdirSync(join(signalDir, 'fake-push'), { recursive: true });
  const body = typeof fixture === 'string' ? readFileSync(join(import.meta.dir, 'fixtures', `${fixture}.json`), 'utf8') : JSON.stringify(fixture);
  const tmp = join(signalDir, `push-${pushes}.tmp`);
  writeFileSync(tmp, body);
  require('node:fs').renameSync(tmp, join(signalDir, 'fake-push', `${String(pushes++).padStart(4, '0')}.json`));
};
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', `${name}.json`), 'utf8'));
/** A receiptMessage envelope from `who` for your messages sent at `timestamps`. */
const receipt = (who: { uuid: string; number: string; name: string }, kind: 'delivery' | 'read' | 'viewed', timestamps: number[], when: number) => ({
  account: '+15550100',
  envelope: {
    source: who.number,
    sourceNumber: who.number,
    sourceUuid: who.uuid,
    sourceName: who.name,
    sourceDevice: 1,
    timestamp: when,
    serverReceivedTimestamp: when + 180,
    serverDeliveredTimestamp: when + 240,
    receiptMessage: { when, isDelivery: kind === 'delivery', isRead: kind === 'read', isViewed: kind === 'viewed', timestamps },
  },
});
const cmd = (c: any) => adapter.command({ id: String(Math.random()), ...c });
const about = (nativeId: string) => cmd({ t: 'about', target: { kind: 'conversation', nativeId } }) as Promise<About>;
const configure = (nativeId: string, change: any) => cmd({ t: 'configure', target: { kind: 'conversation', nativeId }, change }) as Promise<About>;
const addMembers = (nativeId: string, people: string[]) => cmd({ t: 'addMembers', target: { kind: 'conversation', nativeId }, people }) as Promise<AddMembersResult>;
const createGroup = (name: string | undefined, people: string[]) => cmd({ t: 'createGroup', ...(name === undefined ? {} : { name }), people }) as Promise<CreateGroupResult>;
/** Change one group in the fake's list, as the network would have changed it. */
const editGroup = (id: string, fn: (g: any) => void) => {
  const file = join(signalDir, 'fake-groups.json');
  const all = JSON.parse(readFileSync(file, 'utf8'));
  fn(all.find((x: any) => x.id === id));
  writeFileSync(file, JSON.stringify(all));
};
const profile = (who: string) => cmd({ t: 'profile', who }) as Promise<PersonAbout>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-sig-'));
  signalDir = join(dir, 'signal-cli');
  process.env.FAKE_LINK_TIMEOUT_MS = '5000';
  const host: AdapterHost = {
    emit: (ev) => events.push(ev),
    log: (level, msg) => logs.push(`[${level}] ${msg}`),
    accountDir: dir,
    config: {},
    secret: () => secret,
    saveSecret: (v) => {
      secret = v as Record<string, any>;
    },
  };
  adapter = new SignalAdapter(host, {
    signalCli: async () => [process.execPath, FAKE],
    linkRotateMs: 600,
    restartBackoffMs: [100, 200, 400],
    resnapshotMs: [0],
    resnapshotEveryMs: 3_600_000,
    expirySweepMs: 3_600_000,
    daemonReadyTimeoutMs: 10_000,
    daemonHealthEveryMs: 300,
  });
});

afterAll(async () => {
  await adapter?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('signal adapter against a fake signal-cli', () => {
  test('starts linking: hello, then attention link_device with the QR URI', async () => {
    await adapter.start();
    expect(events[0]).toEqual({ t: 'hello', network: 'signal', version: expect.any(String), capabilities: CAPABILITIES });
    const st = await until('a QR code', () => of('status').find((s) => s.attention?.qr));
    expect(st).toMatchObject({ status: 'attention', attention: { kind: 'link_device', message: LINK_MESSAGE, qr: expect.stringMatching(/^sgnl:\/\/linkdevice\?uuid=FAKE\d+&pub_key=KEY\d+$/) } });
    const argv = argvs('link')[0].argv as string[];
    expect(argv.slice(0, 6)).toEqual(['--config', signalDir, '--trust-new-identities', 'always', 'link', '-n']);
    expect(argv[6]).toBe('dither-chat');
  });

  test('rotates the QR code before it expires and retires the old link process', async () => {
    const first = of('status').find((s) => s.attention?.qr)!.attention!.qr;
    const second = await until('a new QR code', () => of('status').find((s) => s.attention?.qr && s.attention.qr !== first));
    expect(second.attention!.kind).toBe('link_device');
    const firstPid = argvs('link')[0].pid;
    await until('the first link process to exit', () => !alive(firstPid));
  });

  test('scanning links the device, starts the daemon and goes online with self', async () => {
    const mark = events.length;
    writeFileSync(join(signalDir, 'fake-scan'), '');
    const online = await until('online', () => of('status', mark).find((s) => s.status === 'online'));
    expect(of('status', mark)[0]).toMatchObject({ status: 'connecting', attention: null });
    expect(online.self).toEqual({ nativeId: SELF, handle: '+15550100', displayName: 'Quinn', isSelf: true });
    expect(secret).toMatchObject({ number: '+15550100', aci: SELF });
    const d = argvs('daemon')[0].argv as string[];
    expect(d).toEqual(expect.arrayContaining(['-a', SELF, 'daemon', '--socket', '--receive-mode', 'on-connection', '--no-receive-stdout', '--ignore-stories']));
    // no link process survives
    for (const r of argvs('link')) expect(alive(r.pid)).toBe(false);
  });

  test('snapshot: contacts, groups and Note to Self', async () => {
    await until('group conversation', () => of('conversation').find((c) => c.conversation.nativeId === GROUP));
    const idn = (id: string) => of('identity').find((e) => e.identity.nativeId === id)?.identity;
    expect(idn(ALICE)).toEqual({ nativeId: ALICE, handle: '+15550137', displayName: 'Alice Chen', contact: true });
    expect(idn(SAM)).toEqual({ nativeId: SAM, handle: '+15550161', displayName: 'Sam Rivera', contact: true });
    expect(of('conversation').find((c) => c.conversation.nativeId === GROUP)!.conversation).toEqual({
      nativeId: GROUP,
      shape: 'group',
      encrypted: true,
      name: 'Climbing crew 🧗',
      topic: 'thursday nights',
      participants: [SELF, ALICE, SAM],
    });
    expect(of('conversation').find((c) => c.conversation.nativeId === `dm:${SELF}:${SELF}`)!.conversation.shape).toBe('self');
    expect(calls('listContacts').length).toBeGreaterThanOrEqual(2);
  });

  test('the first read of contacts: the Abouts of contacts who set one, nobody else', () => {
    // Sam has none, Blake is blocked, Robin is no contact and has no 1:1, and yours is not news.
    expect(of('customStatus')).toEqual([{ t: 'customStatus', who: ALICE, text: 'Belay on', emoji: '🧗', ts: 1 }]);
  });

  test('incoming envelopes become live messages', async () => {
    push('text-styles-mentions');
    const m = await until('message', () => of('message').find((e) => e.message.nativeId === `${ALICE}:${T + 1000}`));
    expect(m.live).toBe(true);
    expect(m.message).toMatchObject({ conversation: GROUP, author: ALICE, mentionsSelf: true, body: expect.stringContaining('**purple V4**') });
  });

  test('send: Markdown -> text styles, mentions, quote; echo emitted as your message', async () => {
    const mark = events.length;
    const res = (await cmd({ t: 'send', conversation: GROUP, body: `**on it** <@${ALICE}>`, replyTo: `${ALICE}:${T + 1000}` })) as { nativeId: string };
    expect(res.nativeId).toMatch(new RegExp(`^${SELF}:\\d+$`));
    const p = calls('send').at(-1).params;
    expect(p).toMatchObject({ groupId: GID, message: 'on it ￼', textStyle: ['0:5:BOLD'], mention: [`6:1:${ALICE}`], quoteTimestamp: T + 1000, quoteAuthor: ALICE });
    expect(p.quoteMessage).toContain('purple V4');
    const echo = of('message', mark).find((e) => e.message.nativeId === res.nativeId)!;
    expect(echo.message).toMatchObject({ conversation: GROUP, author: SELF, body: `**on it** <@${ALICE}>`, replyTo: `${ALICE}:${T + 1000}` });
  });

  test('send to a new 1:1 announces the conversation; Note to Self uses noteToSelf', async () => {
    const mark = events.length;
    await cmd({ t: 'send', conversation: `dm:${SELF}:${SAM}`, body: 'hi Sam' });
    expect(calls('send').at(-1).params).toEqual({ recipient: [SAM], message: 'hi Sam' });
    expect(of('conversation', mark).map((c) => c.conversation)).toContainEqual({ nativeId: `dm:${SELF}:${SAM}`, shape: 'direct', participants: [SELF, SAM], encrypted: true });
    await cmd({ t: 'send', conversation: `dm:${SELF}:${SELF}`, body: 'note' });
    expect(calls('send').at(-1).params).toEqual({ noteToSelf: true, message: 'note' });
  });

  test('opening a new 1:1 sends nothing, and a number resolves to the same conversation an ACI gets', async () => {
    const sends = calls('send').length;
    const STRANGER = 'f00d0000-1111-4aaa-8bbb-000000000099';
    const byNumber: any = await cmd({ t: 'openDirect', peer: '+15550199' });
    expect(byNumber).toEqual({ conversation: `dm:${SELF}:${STRANGER}`, existed: false, startsAtFirstSend: true });
    expect(calls('getUserStatus').at(-1).params).toEqual({ recipient: ['+15550199'] });
    expect(of('identity').at(-1)!.identity).toMatchObject({ nativeId: STRANGER, handle: '+15550199' });
    expect(await cmd({ t: 'openDirect', peer: STRANGER.toUpperCase() })).toEqual({ conversation: `dm:${SELF}:${STRANGER}`, existed: true, startsAtFirstSend: true });
    expect(calls('send').length).toBe(sends);
    await expect(cmd({ t: 'openDirect', peer: '+15550111' })).rejects.toThrow('is not on Signal');
    await expect(cmd({ t: 'openDirect', peer: SELF })).rejects.toThrow('Note to Self');
    await cmd({ t: 'send', conversation: byNumber.conversation, body: 'first' });
    expect(calls('send').at(-1).params).toEqual({ recipient: [STRANGER], message: 'first' });
  });

  test('files go by path, and our copy is what the echo points at', async () => {
    const src = join(dir, 'spool-file');
    writeFileSync(src, 'png bytes');
    const mark = events.length;
    const res = (await cmd({ t: 'send', conversation: DM_ALICE, body: '', attachments: [{ path: src, name: 'a.png', mime: 'image/png', size: 9, kind: 'image' }] })) as { nativeId: string };
    expect(calls('send').at(-1).params).toEqual({ recipient: [ALICE], message: '', attachment: [src] });
    const echo = of('message', mark).find((e) => e.message.nativeId === res.nativeId)!.message;
    expect(echo.kind).toBe('media');
    expect(echo.attachments).toHaveLength(1);
    expect(echo.attachments![0]).toMatchObject({ kind: 'image', mime: 'image/png', name: 'a.png', size: 9 });
    rmSync(src);
    expect(readFileSync(echo.attachments![0].url.slice('file://'.length), 'utf8')).toBe('png bytes');
  });

  test('reaction context: nothing fancy, and leaving a group ends it', async () => {
    expect(await cmd({ t: 'reactionContext', conversation: DM_ALICE })).toEqual({ canReact: true, custom: [] });
    expect(await cmd({ t: 'reactionContext', conversation: GROUP })).toEqual({ canReact: true, custom: [] });
  });

  test('react, edit, redact, markRead', async () => {
    let mark = events.length;
    await cmd({ t: 'react', conversation: GROUP, message: `${ALICE}:${T + 1000}`, key: '🔥' });
    expect(calls('sendReaction').at(-1).params).toEqual({ groupId: GID, emoji: '🔥', targetAuthor: ALICE, targetTimestamp: T + 1000 });
    expect(of('reaction', mark)).toEqual([{ t: 'reaction', conversation: GROUP, message: `${ALICE}:${T + 1000}`, author: SELF, key: '🔥' }]);
    await cmd({ t: 'react', conversation: GROUP, message: `${ALICE}:${T + 1000}`, key: '🔥', remove: true });
    expect(calls('sendReaction').at(-1).params.remove).toBe(true);

    const sent = (await cmd({ t: 'send', conversation: DM_ALICE, body: 'typo' })) as { nativeId: string };
    const ts = Number(sent.nativeId.split(':')[1]);
    mark = events.length;
    await cmd({ t: 'edit', conversation: DM_ALICE, message: sent.nativeId, body: 'fixed *now*' });
    expect(calls('send').at(-1).params).toEqual({ recipient: [ALICE], message: 'fixed now', textStyle: ['6:3:ITALIC'], editTimestamp: ts });
    expect(of('message', mark)[0].message).toMatchObject({ nativeId: sent.nativeId, ts, editedTs: expect.any(Number), body: 'fixed *now*' });

    mark = events.length;
    await cmd({ t: 'redact', conversation: DM_ALICE, message: sent.nativeId });
    expect(calls('remoteDelete').at(-1).params).toEqual({ recipient: [ALICE], targetTimestamp: ts });
    expect(of('delete', mark)).toEqual([{ t: 'delete', conversation: DM_ALICE, nativeId: sent.nativeId }]);
    await expect(cmd({ t: 'redact', conversation: GROUP, message: `${ALICE}:${T + 1000}` })).rejects.toThrow(/own messages/);

    await cmd({ t: 'markRead', conversation: GROUP, upTo: `${ALICE}:${T + 1000}` });
    expect(calls('sendReceipt').at(-1).params).toEqual({ recipient: ALICE, targetTimestamp: [T + 1000], type: 'read' });
    const before = calls('sendReceipt').length;
    await cmd({ t: 'markRead', conversation: GROUP, upTo: `${ALICE}:${T + 1000}` }); // already acknowledged: no second receipt
    expect(calls('sendReceipt').length).toBe(before);
  });

  test('editing a reply sends the quote again', async () => {
    const sent = (await cmd({ t: 'send', conversation: GROUP, body: 'agreed', replyTo: `${ALICE}:${T + 1000}` })) as { nativeId: string };
    await cmd({ t: 'edit', conversation: GROUP, message: sent.nativeId, body: 'agreed!!' });
    expect(calls('send').at(-1).params).toMatchObject({ groupId: GID, message: 'agreed!!', editTimestamp: Number(sent.nativeId.split(':')[1]), quoteTimestamp: T + 1000, quoteAuthor: ALICE });
  });

  test('receipts: for your messages, per person, and one for an edit counts for the message it edits', async () => {
    const alice = { uuid: ALICE, number: '+15550137', name: 'Alice Chen' };
    const sam = { uuid: SAM, number: '+15550161', name: 'Sam Rivera' };
    const sent = (await cmd({ t: 'send', conversation: DM_ALICE, body: 'rope?' })) as { nativeId: string };
    const ts = Number(sent.nativeId.split(':')[1]);
    let mark = events.length;
    push(receipt(alice, 'delivery', [ts - 999_999], ts + 50)); // not one this device knows: nothing
    push(receipt(alice, 'delivery', [ts], ts + 100));
    expect(await until('delivery receipt', () => of('receipt', mark)[0])).toEqual({ t: 'receipt', conversation: DM_ALICE, messages: [sent.nativeId], who: ALICE, state: 'delivered', ts: ts + 100 });
    expect(of('receipt', mark)).toHaveLength(1);

    mark = events.length;
    await cmd({ t: 'edit', conversation: DM_ALICE, message: sent.nativeId, body: 'rope? the 60 m one' });
    const editedTs = of('message', mark)[0].message.editedTs!;
    push(receipt(alice, 'read', [editedTs], editedTs + 100));
    expect(await until('read receipt', () => of('receipt', mark)[0])).toEqual({ t: 'receipt', conversation: DM_ALICE, messages: [sent.nativeId], who: ALICE, state: 'read', ts: editedTs + 100 });

    // In a group, each person's own receipt; a 1:1 message's receipt from someone else in it is not theirs to give.
    const inGroup = (await cmd({ t: 'send', conversation: GROUP, body: 'who drives?' })) as { nativeId: string };
    const gts = Number(inGroup.nativeId.split(':')[1]);
    const elsewhere = (await cmd({ t: 'send', conversation: `dm:${SELF}:f00d0000-1111-4aaa-8bbb-000000000099`, body: 'you drive?' })) as { nativeId: string };
    mark = events.length;
    push(receipt(alice, 'read', [Number(elsewhere.nativeId.split(':')[1])], gts + 50));
    push(receipt(sam, 'read', [gts], gts + 100));
    push(receipt(alice, 'viewed', [gts], gts + 200));
    await until('two group receipts', () => of('receipt', mark).length >= 2);
    expect(of('receipt', mark)).toEqual([
      { t: 'receipt', conversation: GROUP, messages: [inGroup.nativeId], who: SAM, state: 'read', ts: gts + 100 },
      { t: 'receipt', conversation: GROUP, messages: [inGroup.nativeId], who: ALICE, state: 'played', ts: gts + 200 },
    ]);

    // Sent and then edited on your phone: the edit's receipts count for the first version too.
    push('sync-sent-dm');
    push('sync-sent-edit');
    mark = events.length;
    push(receipt(alice, 'read', [T + 18000], T + 19000));
    expect(await until('receipt for a phone edit', () => of('receipt', mark)[0])).toEqual({ t: 'receipt', conversation: DM_ALICE, messages: [`${SELF}:${T + 9000}`], who: ALICE, state: 'read', ts: T + 19000 });
  });

  test('history, fetchMedia, typing action, bad input', async () => {
    expect(await cmd({ t: 'history', conversation: GROUP, limit: 50 })).toEqual({ count: 0, done: true });
    mkdirSync(join(signalDir, 'attachments'), { recursive: true });
    writeFileSync(join(signalDir, 'attachments', 'x.png'), Buffer.from('89504e470d0a1a0a00', 'hex'));
    expect(await cmd({ t: 'fetchMedia', url: `file://${signalDir}/attachments/x.png` })).toEqual({ mime: 'image/png', base64: Buffer.from('89504e470d0a1a0a00', 'hex').toString('base64') });
    await expect(cmd({ t: 'fetchMedia', url: 'file:///etc/passwd' })).rejects.toThrow();
    await expect(cmd({ t: 'fetchMedia', url: 'https://example.org/a.png' })).rejects.toThrow();
    await cmd({ t: 'action', action: 'typing', args: { conversation: GROUP } });
    expect(calls('sendTyping').at(-1).params).toEqual({ groupId: GID });
    await cmd({ t: 'typing', conversation: DM_ALICE });
    expect(calls('sendTyping').at(-1).params).toEqual({ recipient: [ALICE] });
    await cmd({ t: 'typing', conversation: GROUP, stop: true });
    expect(calls('sendTyping').at(-1).params).toEqual({ groupId: GID, stop: true });
    const lists = calls('listGroups').length;
    expect(await cmd({ t: 'action', action: 'resync' })).toEqual({ ok: true });
    expect(calls('sendSyncRequest')).toHaveLength(1);
    expect(calls('listGroups').length).toBe(lists + 1);
    await expect(cmd({ t: 'action', action: 'nope' })).rejects.toThrow(/unknown action/);
    await expect(cmd({ t: 'send', conversation: '!room:matrix.org', body: 'x' })).rejects.toThrow(/not a Signal conversation/);
    await expect(cmd({ t: 'send', conversation: DM_ALICE, body: 'FAIL' })).rejects.toThrow(/Failed to send/);
  });

  test('disappearing messages are deleted (with their files) once read and expired', async () => {
    push('disappearing');
    const id = `${ALICE}:${T + 20000}`;
    await until('disappearing message', () => of('message').find((e) => e.message.nativeId === id));
    const file = join(signalDir, 'attachments', 'D00rC0de1jpg2aaa3bbb.jpg');
    writeFileSync(file, 'jpeg');
    let mark = events.length;
    adapter.sweepExpired(Date.now() + 7200_000);
    // Your own "hi Sam" (Sam's chat has a 1 h timer, started at send) is gone; Alice's unread message is not.
    expect(of('delete', mark).map((d) => d.conversation)).toEqual([`dm:${SELF}:${SAM}`]);
    mark = events.length;
    await cmd({ t: 'markRead', conversation: DM_ALICE, upTo: id });
    adapter.sweepExpired(Date.now() + 3599_000);
    expect(of('delete', mark)).toHaveLength(0);
    adapter.sweepExpired(Date.now() + 3601_000);
    expect(of('delete', mark)).toEqual([{ t: 'delete', conversation: DM_ALICE, nativeId: id, reason: 'expired' }]);
    expect(existsSync(file)).toBe(false);
  });

  test('remote delete drops the downloaded attachment files too', async () => {
    mkdirSync(join(signalDir, 'attachments'), { recursive: true });
    const file = join(signalDir, 'attachments', 'Xq3vM8kTt0aQ1bC2dE4f.jpg');
    writeFileSync(file, 'jpeg');
    push('attachment');
    await until('photo message', () => of('message').find((e) => e.message.nativeId === `${ALICE}:${T + 3000}`));
    const del = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'remote-delete.json'), 'utf8'));
    del.envelope.dataMessage.remoteDelete.timestamp = T + 3000;
    del.envelope.timestamp = del.envelope.dataMessage.timestamp = T + 3500;
    const mark = events.length;
    push(del);
    await until('delete', () => of('delete', mark).find((d) => d.nativeId === `${ALICE}:${T + 3000}`));
    expect(existsSync(file)).toBe(false);
  });

  test('pins: a pin event for the message; a pin for an hour ends on its own, unless it is unpinned first', async () => {
    let mark = events.length;
    push('pin');
    expect(await until('pin', () => of('pin', mark)[0])).toEqual({ t: 'pin', conversation: GROUP, message: `${SAM}:${T + 14000}`, pinned: true, by: ALICE, ts: T + 25000 });
    expect(of('message', mark).at(-1)!.message).toMatchObject({ kind: 'system', body: 'Alice Chen pinned a message.' });

    const hour = (at: number) => {
      const f = fixture('pin');
      f.envelope.timestamp = f.envelope.dataMessage.timestamp = at;
      Object.assign(f.envelope.dataMessage.pinMessage, { targetAuthor: '+15550137', targetAuthorNumber: '+15550137', targetAuthorUuid: ALICE, targetSentTimestamp: T + 1000, pinDurationSeconds: 3600 });
      return f;
    };
    mark = events.length;
    push(hour(T + 27000));
    await until('timed pin', () => of('pin', mark)[0]);
    const until1 = T + 27000 + 3_600_000;
    adapter.sweepExpired(until1 - 1);
    expect(of('pin', mark)).toHaveLength(1);
    adapter.sweepExpired(until1);
    // Only the timed one: Sam's message is pinned for good.
    expect(of('pin', mark)).toEqual([
      { t: 'pin', conversation: GROUP, message: `${ALICE}:${T + 1000}`, pinned: true, by: ALICE, ts: T + 27000 },
      { t: 'pin', conversation: GROUP, message: `${ALICE}:${T + 1000}`, pinned: false, ts: until1 },
    ]);
    adapter.sweepExpired(until1 + 1);
    expect(of('pin', mark)).toHaveLength(2);

    mark = events.length;
    push(hour(T + 28000));
    const unpin = fixture('unpin');
    Object.assign(unpin.envelope.dataMessage.unpinMessage, { targetAuthor: '+15550137', targetAuthorNumber: '+15550137', targetAuthorUuid: ALICE, targetSentTimestamp: T + 1000 });
    push(unpin);
    await until('unpin', () => of('pin', mark).length >= 2);
    adapter.sweepExpired(T + 28000 + 3_600_000);
    expect(of('pin', mark)).toEqual([
      { t: 'pin', conversation: GROUP, message: `${ALICE}:${T + 1000}`, pinned: true, by: ALICE, ts: T + 28000 },
      { t: 'pin', conversation: GROUP, message: `${ALICE}:${T + 1000}`, pinned: false, by: ALICE, ts: T + 26000 },
    ]);
  });

  test('hello advertises about, configure and addMembers', () => {
    expect(of('hello')[0].capabilities).toEqual(expect.arrayContaining(['about', 'configure', 'addMembers']));
  });

  test('profile: a contact, read from signal-cli by ACI, their identity fact first', async () => {
    expect(of('hello')[0].capabilities).toContain('profile');
    mkdirSync(join(signalDir, 'avatars'), { recursive: true });
    const avatar = join(signalDir, 'avatars', `profile-${ALICE}`);
    writeFileSync(avatar, 'png');
    const n = calls('listContacts').length;
    const mark = events.length;
    const p = await profile(ALICE.toUpperCase());
    expect(calls('listContacts').slice(n).map((c) => c.params)).toEqual([{ recipient: [ALICE] }]);
    expect(p).toEqual({
      displayName: 'Alice Chen',
      handle: '+15550137',
      avatar: pathToFileURL(avatar).href,
      bio: 'Belay on',
      status: { emoji: '🧗' },
      relationship: 'contact',
      links: [{ label: 'Phone', value: '+15550137', url: 'tel:+15550137' }],
      facts: [{ label: 'Profile name', value: 'Alice' }],
    });
    expect(of('identity', mark).map((e) => e.identity)).toEqual([{ nativeId: ALICE, handle: '+15550137', displayName: 'Alice Chen', avatarUrl: pathToFileURL(avatar).href, contact: true }]);
  });

  test('profile: blocked, a stranger (the second read, with allRecipients), and someone signal-cli does not know', async () => {
    const lookups = calls('getUserStatus').length;
    let n = calls('listContacts').length;
    const reads = () => {
      const r = calls('listContacts').slice(n).map((c) => c.params);
      n += r.length;
      return r;
    };
    expect(await profile(BLAKE)).toEqual({ displayName: 'Blake', handle: '+15550142', relationship: 'blocked', links: [{ label: 'Phone', value: '+15550142', url: 'tel:+15550142' }] });
    expect(reads()).toEqual([{ recipient: [BLAKE] }]);
    const mark = events.length;
    expect(await profile(ROBIN)).toEqual({ displayName: 'Robin', bio: 'Gone bouldering', relationship: 'stranger' });
    expect(reads()).toEqual([{ recipient: [ROBIN] }, { recipient: [ROBIN], allRecipients: true }]);
    expect(of('identity', mark).map((e) => e.identity)).toEqual([{ nativeId: ROBIN, displayName: 'Robin' }]);
    expect(await profile('e0000000-8888-4bbb-8ccc-000000000008')).toEqual({});
    expect(reads()).toHaveLength(2);
    // A number would make signal-cli look it up on the server: refused before any read.
    await expect(profile('+15550137')).rejects.toThrow('not a Signal person id');
    expect(reads()).toEqual([]);
    expect(calls('getUserStatus').length).toBe(lookups);
  });

  test('profile of yourself: your number, and your contacts (not blocked, with a name) as friends', async () => {
    const n = calls('listContacts').length;
    const p = await profile(SELF);
    expect(calls('listContacts').slice(n).map((c) => c.params)).toEqual([{ recipient: [SELF], allRecipients: true }, null]); // null: no params, all contacts
    expect(p).toEqual({ displayName: 'Quinn', handle: '+15550100', links: [{ label: 'Phone', value: '+15550100', url: 'tel:+15550100' }], friends: [ALICE, SAM] });
    for (const id of p.friends!) expect(of('identity').find((e) => e.identity.nativeId === id)?.identity).toMatchObject({ contact: true, displayName: expect.any(String) });
  });

  test('your own About: updateProfile with only the about, read back; past 140 refused before any call', async () => {
    const n = calls('updateProfile').length;
    const p = (await cmd({ t: 'setProfile', change: { bio: 'on the wall 🧗' } })) as PersonAbout;
    expect(calls('updateProfile').slice(n).map((c) => c.params)).toEqual([{ about: 'on the wall 🧗' }]);
    expect(p).toMatchObject({ displayName: 'Quinn', handle: '+15550100', bio: 'on the wall 🧗' });
    expect((await profile(SELF)).bio).toBe('on the wall 🧗');
    await expect(cmd({ t: 'setProfile', change: { bio: 'x'.repeat(141) } })).rejects.toThrow('a Signal About takes 140 characters, this one has 141');
    await expect(cmd({ t: 'setProfile', change: {} })).rejects.toThrow('nothing to change');
    // '' clears it.
    expect(((await cmd({ t: 'setProfile', change: { bio: '' } })) as PersonAbout).bio).toBeUndefined();
    expect(calls('updateProfile').length).toBe(n + 2);
  });

  test('about: a group where you are an admin, re-read from signal-cli', async () => {
    const lists = calls('listGroups').length;
    const a = await about(GROUP);
    expect(calls('listGroups').length).toBe(lists + 1);
    expect(calls('listGroups').at(-1).params).toEqual({ groupId: [GID] });
    expect(a.noun).toBe('Group');
    expect(a.fields).toEqual({
      name: { value: 'Climbing crew 🧗', canEdit: true },
      topic: { value: 'thursday nights', canEdit: true },
      avatar: { value: null, canEdit: false, reason: 'Changing the picture is not supported yet.' },
      disappearing: { value: 0, canEdit: true },
      announceOnly: { value: false, canEdit: true },
      editInfo: { value: 'everyone', canEdit: true },
      addMembers: { value: 'everyone', canEdit: true },
      joinApproval: { value: null, canEdit: false, reason: 'Signal does not say whether approval is on.' },
      encrypted: { value: true, canEdit: false, reason: 'Always on in Signal.' },
    });
    expect(a.members).toEqual({
      list: [
        { id: SELF, role: 'Admin', rank: 100 },
        { id: ALICE, role: 'Member', rank: 0 },
        { id: SAM, role: 'Member', rank: 0 },
      ],
      complete: true,
    });
    expect(a.roles).toEqual([
      { id: 'admin', name: 'Admin', rank: 100, count: 1 },
      { id: 'member', name: 'Member', rank: 0, count: 2 },
    ]);
    expect(a.you).toEqual({ role: 'Admin', rank: 100 });
    expect(a.invite).toEqual({ link: null, canCreate: true, canRevoke: false });
    expect(a.adding).toEqual({ can: true, who: 'known', mode: 'add' });
    expect(a.rules!.every((r) => r.you)).toBe(true);
    expect(a.pinned).toBeUndefined();
    expect(a.facts).toBeUndefined();
  });

  test('about: a locked group where you are not an admin says why at every setting', async () => {
    const mark = events.length;
    const a = await about(LOCKED);
    const details = 'Only admins can edit this group’s details.';
    const admins = 'Only admins can change this.';
    expect(a.fields).toMatchObject({
      name: { value: 'Announcements', canEdit: false, reason: details },
      topic: { value: 'read only', canEdit: false, reason: details },
      avatar: { canEdit: false, reason: details },
      disappearing: { value: 604800, canEdit: false, reason: details },
      announceOnly: { value: true, canEdit: false, reason: admins },
      editInfo: { value: 'admins', canEdit: false, reason: admins },
      addMembers: { value: 'admins', canEdit: false, reason: admins },
    });
    expect(a.members!.list).toEqual([
      { id: SELF, role: 'Member', rank: 0 },
      { id: ALICE, role: 'Admin', rank: 100 },
      { id: SAM, role: 'Member', rank: 0 },
    ]);
    expect(a.you).toEqual({ role: 'Member', rank: 0 });
    expect(a.invite).toEqual({ link: 'https://signal.group/#CjQKIFakeLockedGroupLink', canCreate: false, canRevoke: false, reason: 'Only admins can change the invite link.' });
    expect(a.rules).toEqual([
      { what: 'Edit name, description and disappearing messages', who: 'Only admins', you: false },
      { what: 'Add members', who: 'Only admins', you: false },
      { what: 'Send messages', who: 'Only admins', you: false },
      { what: 'Change these settings and the invite link', who: 'Only admins', you: false },
    ]);
    expect(a.facts).toEqual([{ label: 'Invited, not joined yet', value: '1' }]);
    expect(a.adding).toEqual({ can: false, reason: 'Only admins can add members.', who: 'known', mode: 'add' });
    expect(of('conversation', mark).find((c) => c.conversation.nativeId === LOCKED)).toBeUndefined(); // re-read, unchanged: not sent again
    const n = calls('updateGroup').length;
    await expect(configure(LOCKED, { key: 'name', value: 'Mine now' })).rejects.toThrow(details);
    await expect(configure(LOCKED, { key: 'invite', op: 'revoke' })).rejects.toThrow('Only admins can change the invite link.');
    await expect(configure(LOCKED, { key: 'announceOnly', value: false })).rejects.toThrow(admins);
    expect(calls('updateGroup').length).toBe(n);
  });

  test('a group you are only invited to: nothing can change, and no updateGroup accepts the invitation', async () => {
    const a = await about(INVITED);
    expect(a.fields.name).toEqual({ value: 'Surprise party', canEdit: false, reason: 'You are invited to this group but have not joined.' });
    expect(a.adding).toEqual({ can: false, reason: 'You are invited to this group but have not joined.', who: 'known', mode: 'add' });
    expect(a.you).toEqual({});
    expect(a.invite).toMatchObject({ canCreate: false, canRevoke: false });
    expect(of('conversation').find((c) => c.conversation.nativeId === INVITED)).toBeUndefined();
    const n = calls('updateGroup').length;
    await expect(configure(INVITED, { key: 'name', value: 'Party' })).rejects.toThrow('have not joined');
    await expect(configure(INVITED, { key: 'invite', op: 'create' })).rejects.toThrow('have not joined');
    expect(calls('updateGroup').length).toBe(n);
  });

  test('1:1 and Note to Self: the disappearing timer, set with updateContact', async () => {
    const sam = await about(`dm:${SELF}:${SAM}`);
    expect(sam).toEqual({
      noun: 'Chat',
      fields: { disappearing: { value: 3600, canEdit: true }, encrypted: { value: true, canEdit: false, reason: 'Always on in Signal.' } },
      members: { list: [{ id: SELF }, { id: SAM }], complete: true },
      rules: [{ what: 'Change disappearing messages', who: 'Either of you', you: true }],
    });
    const mark = events.length;
    const a = await configure(DM_ALICE, { key: 'disappearing', value: 86400 });
    expect(calls('updateContact').at(-1).params).toEqual({ recipient: ALICE, expiration: 86400 });
    expect(a.fields.disappearing).toEqual({ value: 86400, canEdit: true });
    expect(of('message', mark).map((m) => [m.message.conversation, m.message.kind, m.message.body])).toEqual([[DM_ALICE, 'system', 'You set disappearing messages to 1 day.']]);

    const NOTE = `dm:${SELF}:${SELF}`;
    expect((await about(NOTE)).noun).toBe('Note to Self');
    const n = await configure(NOTE, { key: 'disappearing', value: 300 });
    expect(calls('updateContact').at(-1).params).toEqual({ recipient: SELF, expiration: 300 });
    expect(n).toMatchObject({ noun: 'Note to Self', fields: { disappearing: { value: 300 } }, members: { list: [{ id: SELF }] }, rules: [{ who: 'You' }] });
    await expect(configure(DM_ALICE, { key: 'name', value: 'Alice' })).rejects.toThrow(/no name setting/);
  });

  test('customStatus: an About set, changed or cleared shows on the next read of contacts, once; strangers never', async () => {
    const file = join(signalDir, 'fake-contacts.json'); // written by the updateContact above
    const setAbout = (who: string, about: string | null, aboutEmoji: string | null, at: number) => {
      const all = JSON.parse(readFileSync(file, 'utf8'));
      const c = all.find((x: any) => x.uuid === who);
      c.profile = { ...c.profile, about, aboutEmoji, lastUpdateTimestamp: at };
      writeFileSync(file, JSON.stringify(all));
    };
    setAbout(ALICE, 'Off to Fontainebleau', '⛺', T + 30000);
    setAbout(SAM, 'Rest day', null, T + 30001);
    setAbout(ROBIN, 'New bio', '🪨', T + 30002);
    let mark = events.length;
    const n = records().length;
    await adapter.snapshot();
    expect(of('customStatus', mark)).toEqual([
      { t: 'customStatus', who: ALICE, text: 'Off to Fontainebleau', emoji: '⛺', ts: T + 30000 },
      { t: 'customStatus', who: SAM, text: 'Rest day', ts: T + 30001 },
    ]);
    // Nothing asked of signal-cli beyond what a snapshot always reads.
    const asked = records().slice(n).filter((r) => r.t === 'rpc' && r.method !== 'version').map((r) => r.method);
    expect(asked).toEqual(['listContacts', 'listContacts', 'listGroups']);

    mark = events.length;
    await adapter.snapshot();
    expect(of('customStatus', mark)).toEqual([]);
    setAbout(ALICE, '  ', null, T + 40000);
    await adapter.snapshot();
    expect(of('customStatus', mark)).toEqual([{ t: 'customStatus', who: ALICE, ts: T + 40000 }]);

    // Opening a profile reads them too; a profile signal-cli has never fetched says nothing.
    mark = events.length;
    setAbout(SAM, 'Rest day', '😴', T + 50000);
    await profile(SAM);
    setAbout(ALICE, 'Back', null, 0);
    await profile(ALICE);
    expect(of('customStatus', mark)).toEqual([{ t: 'customStatus', who: SAM, text: 'Rest day', emoji: '😴', ts: T + 50000 }]);
  });

  test('configure name: one updateGroup with the group id and the name, then a fresh About and the fact again', async () => {
    const mark = events.length;
    const a = await configure(GROUP, { key: 'name', value: '  Crag rats ' });
    expect(calls('updateGroup').at(-1).params).toEqual({ groupId: GID, name: 'Crag rats' });
    const rpcs = records().filter((r) => r.t === 'rpc');
    expect(rpcs.at(-1)).toEqual({ t: 'rpc', method: 'listGroups', params: { groupId: [GID] } }); // re-read after the write
    expect(a.fields.name).toEqual({ value: 'Crag rats', canEdit: true });
    expect(of('conversation', mark).map((c) => c.conversation)).toEqual([expect.objectContaining({ nativeId: GROUP, name: 'Crag rats', topic: 'thursday nights' })]);
    expect(of('message', mark).at(-1)!.message).toMatchObject({ conversation: GROUP, author: SELF, kind: 'system', body: 'You renamed the group to “Crag rats”.' });
    // Already so: nothing to send.
    const n = calls('updateGroup').length;
    await configure(GROUP, { key: 'name', value: 'Crag rats' });
    expect(calls('updateGroup').length).toBe(n);
  });

  test('configure topic, disappearing, announceOnly, editInfo, addMembers: one field per call', async () => {
    const last = () => calls('updateGroup').at(-1).params;
    let a = await configure(GROUP, { key: 'topic', value: 'tuesdays now' });
    expect(last()).toEqual({ groupId: GID, description: 'tuesdays now' });
    expect(a.fields.topic!.value).toBe('tuesdays now');
    a = await configure(GROUP, { key: 'disappearing', value: 3600 });
    expect(last()).toEqual({ groupId: GID, expiration: 3600 });
    expect(a.fields.disappearing!.value).toBe(3600);
    let mark = events.length;
    a = await configure(GROUP, { key: 'announceOnly', value: true });
    expect(last()).toEqual({ groupId: GID, setPermissionSendMessages: 'only-admins' });
    expect(a.fields.announceOnly!.value).toBe(true);
    expect(of('conversation', mark).at(-1)!.conversation.variant).toBe('announcement');
    mark = events.length;
    a = await configure(GROUP, { key: 'editInfo', value: 'admins' });
    expect(last()).toEqual({ groupId: GID, setPermissionEditDetails: 'only-admins' });
    expect(a.fields.editInfo!.value).toBe('admins');
    expect(of('message', mark).at(-1)!.message.body).toBe('You changed who can edit group info to “Only admins”.');
    a = await configure(GROUP, { key: 'addMembers', value: 'admins' });
    expect(last()).toEqual({ groupId: GID, setPermissionAddMember: 'only-admins' });
    expect(a.fields.addMembers!.value).toBe('admins');
    expect(a.fields.name!.canEdit).toBe(true); // still an admin
    a = await configure(GROUP, { key: 'announceOnly', value: false });
    expect(last()).toEqual({ groupId: GID, setPermissionSendMessages: 'every-member' });
  });

  test('configure invite: turn the link on, reset it, turn it off', async () => {
    const last = () => calls('updateGroup').at(-1).params;
    let mark = events.length;
    let a = await configure(GROUP, { key: 'invite', op: 'create' });
    expect(last()).toEqual({ groupId: GID, link: 'enabled' });
    const first = a.invite!.link;
    expect(first).toStartWith('https://signal.group/#');
    expect(a.invite).toMatchObject({ canCreate: true, canRevoke: true });
    expect(of('message', mark).at(-1)!.message.body).toBe('You turned on the group link.');
    a = await configure(GROUP, { key: 'invite', op: 'create' });
    expect(last()).toEqual({ groupId: GID, resetLink: true });
    expect(a.invite!.link).not.toBe(first);
    mark = events.length;
    a = await configure(GROUP, { key: 'invite', op: 'revoke' });
    expect(last()).toEqual({ groupId: GID, link: 'disabled' });
    expect(a.invite).toEqual({ link: null, canCreate: true, canRevoke: false });
    expect(of('message', mark).at(-1)!.message.body).toBe('You turned off the group link.');
  });

  test('roles: admins made or unmade by a group update are role events by its sender; a plain re-read finds the rest', async () => {
    const file = join(signalDir, 'fake-groups.json'); // written by the updateGroups above
    const setAdmin = (who: string, isAdmin: boolean) => {
      const all = JSON.parse(readFileSync(file, 'utf8'));
      const g = all.find((x: any) => x.id === GID);
      for (const m of g.members) if (m.uuid === who) m.isAdmin = isAdmin;
      g.admins = g.members.filter((m: any) => m.isAdmin).map(({ number, uuid }: any) => ({ number, uuid }));
      writeFileSync(file, JSON.stringify(all));
    };
    const target = { kind: 'conversation' as const, nativeId: GROUP };
    const described = (mark: number) => until('the update described', () => of('message', mark).find((m) => m.message.body.includes('admin')));

    setAdmin(ALICE, true);
    let mark = events.length;
    push('group-update'); // from Sam
    expect(await until('role', () => of('role', mark)[0])).toEqual({ t: 'role', target, member: ALICE, role: 'Admin', given: true, by: SAM, ts: T + 8000 });
    expect((await described(mark)).message).toMatchObject({ nativeId: `${SAM}:${T + 8000}`, kind: 'system', body: 'Sam Rivera made Alice Chen an admin.' });

    setAdmin(ALICE, false);
    mark = events.length;
    const upd = fixture('group-update');
    upd.envelope.timestamp = upd.envelope.dataMessage.timestamp = T + 8500;
    push(upd);
    expect(await until('role taken', () => of('role', mark)[0])).toEqual({ t: 'role', target, member: ALICE, role: 'Admin', given: false, by: SAM, ts: T + 8500 });
    expect((await described(mark)).message.body).toBe('Sam Rivera revoked admin privileges from Alice Chen.');

    // Changed while nothing said so (or the update is long gone): found on the next read, by nobody in particular.
    setAdmin(SAM, true);
    mark = events.length;
    expect((await about(GROUP)).members!.list).toContainEqual({ id: SAM, role: 'Admin', rank: 100 });
    await about(GROUP);
    expect(of('role', mark)).toEqual([{ t: 'role', target, member: SAM, role: 'Admin', given: true }]);
  });

  test('refuses what Signal cannot do, and never calls updateGroup without a group id', async () => {
    const n = calls('updateGroup').length;
    await expect(configure(GROUP, { key: 'avatar', value: 'file:///tmp/x.png' })).rejects.toThrow('Changing the picture is not supported yet.');
    await expect(configure(GROUP, { key: 'joinApproval', value: true })).rejects.toThrow('Signal does not say whether approval is on.');
    await expect(configure(GROUP, { key: 'encrypted', value: true })).rejects.toThrow('Always on in Signal.');
    await expect(configure(GROUP, { key: 'pin', message: `${ALICE}:${T + 1000}` })).rejects.toThrow(/no list of pinned/);
    await expect(configure(GROUP, { key: 'slowMode', value: 10 })).rejects.toThrow(/not a Signal group setting/);
    await expect(cmd({ t: 'configure', target: { kind: 'space', nativeId: GID }, change: { key: 'name', value: 'x' } })).rejects.toThrow(/no spaces/);
    await expect(configure('group:', { key: 'name', value: 'x' })).rejects.toThrow(/not a Signal conversation/);
    expect(calls('updateGroup').length).toBe(n);
    // The guard itself: signal-cli would make a new group out of any of these.
    for (const id of ['', '  ', undefined, null]) expect(() => updateGroupParams(id, { name: 'x' })).toThrow(/create a new group/);
    expect(() => updateGroupParams(GID, { name: 'x', description: 'y' })).toThrow(/one group change/);
    expect(() => updateGroupParams(GID, { groupId: '' })).toThrow(/one group change/);
    expect(updateGroupParams(GID, { name: 'x' })).toEqual({ groupId: GID, name: 'x' });
  });

  test('addMembers: an admin adds two in one updateGroup with the group id; one comes back invited; the hub hears first', async () => {
    // Casey is in your contacts, and this device has no profile key for them.
    const file = join(signalDir, 'fake-contacts.json');
    const people = JSON.parse(readFileSync(file, 'utf8'));
    people.push({ number: '+15550188', uuid: CASEY, username: null, name: 'Casey', givenName: 'Casey', familyName: null, nickName: null, nickGivenName: null, nickFamilyName: null, note: null, color: null, isArchived: false, isBlocked: false, isHidden: false, messageExpirationTime: 0, profileSharing: false, unregistered: false, profile: null });
    writeFileSync(file, JSON.stringify(people));
    await adapter.snapshot();
    // Only admins add in Crag rats now, and you are one.
    expect((await about(GROUP)).adding).toEqual({ can: true, who: 'known', mode: 'add' });
    const mark = events.length;
    const n = calls('updateGroup').length;
    const lists = calls('listGroups').length;
    const r = await addMembers(GROUP, [ROBIN, CASEY]);
    expect(calls('updateGroup').slice(n).map((c) => c.params)).toEqual([{ groupId: GID, member: [ROBIN, CASEY] }]);
    expect(calls('listGroups').slice(lists).map((c) => c.params)).toEqual([{ groupId: [GID] }, { groupId: [GID] }]); // before and after
    expect(r).toMatchObject({ added: [ROBIN], invited: [CASEY] });
    expect(r.failed).toBeUndefined();
    expect(r.about!.members!.list).toContainEqual({ id: ROBIN, role: 'Member', rank: 0 });
    expect(r.about!.facts).toEqual([{ label: 'Invited, not joined yet', value: '1' }]);
    expect(r.about!.adding).toEqual({ can: true, who: 'known', mode: 'add' });
    // Robin known to the hub before the conversation that has Robin in it; Casey, invited, is no participant.
    const conv = events.findIndex((e, i) => i >= mark && e.t === 'conversation' && e.conversation.nativeId === GROUP);
    expect(conv).toBeGreaterThanOrEqual(mark);
    expect((events[conv] as Extract<AdapterEvent, { t: 'conversation' }>).conversation.participants).toEqual([SELF, ALICE, SAM, ROBIN]);
    const robin = events.findIndex((e) => e.t === 'identity' && e.identity.nativeId === ROBIN);
    expect(robin).toBeGreaterThanOrEqual(0);
    expect(robin).toBeLessThan(conv);
    expect(of('message', mark).map((m) => m.message)).toEqual([expect.objectContaining({ conversation: GROUP, author: SELF, kind: 'system', body: 'You added Robin, invited Casey.' })]);
  });

  test('addMembers: in or invited already, not sent again; someone Signal leaves out and an id that is no ACI are failed', async () => {
    writeFileSync(join(signalDir, 'fake-add.json'), JSON.stringify({ [STRAY]: 'drop' }));
    const mark = events.length;
    const n = calls('updateGroup').length;
    const r = await addMembers(GROUP, [ALICE, CASEY, '+15550137', STRAY]);
    expect(calls('updateGroup').slice(n).map((c) => c.params)).toEqual([{ groupId: GID, member: [STRAY] }]);
    expect(r).toMatchObject({
      added: [ALICE],
      invited: [CASEY],
      failed: [
        { id: '+15550137', reason: 'This is not a Signal person id.' },
        { id: STRAY, reason: 'Signal did not add them.' },
      ],
    });
    expect(of('message', mark)).toEqual([]); // nothing changed: nothing to show
    // Everyone in already: nothing goes to Signal at all.
    expect(await addMembers(GROUP, [ALICE.toUpperCase(), ROBIN, ROBIN])).toMatchObject({ added: [ALICE, ROBIN] });
    expect(calls('updateGroup').length).toBe(n + 1);
  });

  test("addMembers: signal-cli refusing the change is refused with signal-cli's words, and nothing is posted", async () => {
    writeFileSync(join(signalDir, 'fake-add.json'), JSON.stringify({ [STRAY]: { error: 'Failed to update group: GroupPatchNotAcceptedException' } }));
    const mark = events.length;
    await expect(addMembers(GROUP, [STRAY])).rejects.toThrow('Failed to update group: GroupPatchNotAcceptedException');
    expect(of('message', mark)).toEqual([]);
    expect(of('conversation', mark)).toEqual([]);
    rmSync(join(signalDir, 'fake-add.json'));
  });

  test('addMembers: refused before any updateGroup where the About says no, read fresh, not trusted', async () => {
    const n = calls('updateGroup').length;
    await expect(addMembers(LOCKED, [ROBIN])).rejects.toThrow('Only admins can add members.');
    await expect(addMembers(INVITED, [ROBIN])).rejects.toThrow('You are invited to this group but have not joined.');
    await expect(addMembers(DM_ALICE, [ROBIN])).rejects.toThrow('Signal adds people to groups only.');
    await expect(addMembers(`dm:${SELF}:${SELF}`, [ROBIN])).rejects.toThrow('Signal adds people to groups only.');
    await expect(addMembers(GROUP, [])).rejects.toThrow('Nobody to add.');
    const eleven = Array.from({ length: 11 }, (_, i) => `e0000000-8888-4bbb-8ccc-0000000000${String(i).padStart(2, '0')}`);
    await expect(addMembers(GROUP, eleven)).rejects.toThrow('At most 10 people at a time.');
    await expect(cmd({ t: 'addMembers', target: { kind: 'space', nativeId: GID }, people: [ROBIN] })).rejects.toThrow(/no spaces/);
    // An admin no longer, since the hub last looked: only admins add in Crag rats.
    editGroup(GID, (g) => {
      for (const m of g.members) if (m.uuid === SELF) m.isAdmin = false;
    });
    const lists = calls('listGroups').length;
    await expect(addMembers(GROUP, [STRAY])).rejects.toThrow('Only admins can add members.');
    expect(calls('listGroups').slice(lists).map((c) => c.params)).toEqual([{ groupId: [GID] }]);
    expect(calls('updateGroup').length).toBe(n);
    editGroup(GID, (g) => {
      for (const m of g.members) if (m.uuid === SELF) m.isAdmin = true;
    });
    // The guard: signal-cli would make a new group of them.
    for (const id of ['', undefined]) expect(() => updateGroupParams(id, { member: [ROBIN] })).toThrow(/create a new group/);
  });

  test('addMembers: a member who is no admin may, where all members may add', async () => {
    editGroup(LOCKED_ID, (g) => {
      g.permissionAddMember = 'EVERY_MEMBER';
    });
    expect((await about(LOCKED)).adding).toEqual({ can: true, who: 'known', mode: 'add' });
    const mark = events.length;
    const r = await addMembers(LOCKED, [ROBIN]);
    expect(calls('updateGroup').at(-1).params).toEqual({ groupId: LOCKED_ID, member: [ROBIN] });
    expect(r).toMatchObject({ added: [ROBIN] });
    expect(r.about!.you).toEqual({ role: 'Member', rank: 0 });
    expect(of('message', mark).map((m) => m.message.body)).toEqual(['You added Robin.']);
    // Every updateGroup that added anyone named its group.
    const adds = calls('updateGroup').filter((c) => c.params?.member);
    expect(adds.length).toBe(4);
    expect(adds.every((c) => c.params.groupId === GID || c.params.groupId === LOCKED_ID)).toBe(true);
  });

  test('createGroup: one updateGroup with a name and members and no group id; identities, then the group, then the answer', async () => {
    // As signal-cli 0.14.8: nobody by ACI is left out; one group update message to each, with a result each. STRAY's
    // account is gone (pending on Signal's servers, never to answer); Casey's phone could not be told yet.
    writeFileSync(join(signalDir, 'fake-add.json'), JSON.stringify({ [STRAY]: { result: 'UNREGISTERED_FAILURE' }, [CASEY]: { result: 'RATE_LIMIT_FAILURE', retryAfterSeconds: 60 } }));
    const mark = events.length;
    const n = calls('updateGroup').length;
    const r = await createGroup('  Crag rats 2 ', [ROBIN, CASEY, STRAY, '+15550137']);
    expect(calls('updateGroup').slice(n).map((c) => c.params)).toEqual([{ name: 'Crag rats 2', member: [ROBIN, CASEY, STRAY] }]);
    const conversation = r.conversation;
    expect(conversation).toMatch(/^group:NewGr0up\d+=$/);
    expect(r).toEqual({
      conversation,
      added: [ROBIN],
      invited: [CASEY],
      failed: [
        { id: STRAY, reason: 'They are not on Signal any more.' },
        { id: '+15550137', reason: 'This is not a Signal person id.' },
      ],
      notes: [expect.stringMatching(/^Signal could not tell .+ about the group \(Signal is limiting this device\): they may not see it until someone writes in it$/)],
    });
    // Robin known to the hub before the group that has Robin in it; Casey, invited, is no participant yet.
    const conv = events.findIndex((e, i) => i >= mark && e.t === 'conversation' && e.conversation.nativeId === conversation);
    expect(conv).toBeGreaterThanOrEqual(mark);
    const fact = (events[conv] as Extract<AdapterEvent, { t: 'conversation' }>).conversation;
    expect(fact).toMatchObject({ shape: 'group', name: 'Crag rats 2', encrypted: true, participants: [SELF, ROBIN] });
    const robin = events.findIndex((e) => e.t === 'identity' && e.identity.nativeId === ROBIN); // told once, ever
    expect(robin).toBeGreaterThanOrEqual(0);
    expect(robin).toBeLessThan(conv);
    expect(of('message', mark).map((m) => m.message)).toEqual([expect.objectContaining({ conversation, author: SELF, kind: 'system', body: 'You created the group.' })]);
    rmSync(join(signalDir, 'fake-add.json'));
  });

  test('createGroup: refused before any updateGroup without a name, with nobody or too many; signal-cli refusing is its words, nothing made', async () => {
    const n = calls('updateGroup').length;
    const groups = () => JSON.parse(readFileSync(join(signalDir, 'fake-groups.json'), 'utf8')).length;
    const before = groups();
    await expect(createGroup(undefined, [ROBIN])).rejects.toThrow('Give the group a name');
    await expect(createGroup('   ', [ROBIN])).rejects.toThrow('Give the group a name');
    await expect(createGroup('x'.repeat(33), [ROBIN])).rejects.toThrow(/at most 32 characters/);
    await expect(createGroup('Nobody', [])).rejects.toThrow(/at least 1/);
    await expect(createGroup('Nobody', [SELF])).rejects.toThrow(/at least 1/);
    const eleven = Array.from({ length: 11 }, (_, i) => `e0000000-8888-4bbb-8ccc-0000000000${String(i).padStart(2, '0')}`);
    await expect(createGroup('Crowd', eleven)).rejects.toThrow(/at most 10/);
    await expect(createGroup('Numbers', ['+15550137'])).rejects.toThrow('None of them is a Signal person id.');
    expect(calls('updateGroup').length).toBe(n);
    // Signal's servers refusing (a rate limit, a captcha, no profile yet) reads only as "Failed to create group".
    writeFileSync(join(signalDir, 'fake-create.json'), JSON.stringify({ error: true }));
    const mark = events.length;
    await expect(createGroup('Strays', [ROBIN, STRAY])).rejects.toThrow("Signal did not make the group and signal-cli does not say why (Signal may be limiting this device, or this device's profile is not ready). Nothing was made; try again later.");
    expect(calls('updateGroup').length).toBe(n + 1); // once, never again on its own
    expect(of('conversation', mark)).toEqual([]);
    expect(of('message', mark)).toEqual([]);
    expect(groups()).toBe(before);
    rmSync(join(signalDir, 'fake-create.json'));
  });

  test('createGroup: what signal-cli answers, in words', () => {
    // Its JSON-RPC error for a group Signal refused to make (SignalJsonRpcCommandHandler: INTERNAL_ERROR, the class appended).
    const refused = Object.assign(new Error('Failed to send message: Failed to create group (IOException) (UnexpectedErrorException)'), { code: -32603 });
    expect(createGroupError(refused).message).toMatch(/^Signal did not make the group/);
    expect(createGroupError(new Error('Rate limit reached\nNext attempt may be tried at 9999999999999 (later)')).message).toMatch(/^Signal is limiting how often this device can make groups; try again in/);
    expect(createGroupError(new Error('something else')).message).toBe('something else');
    // One result per person told; a proof required is a rate limit failure with a token.
    const told = untold([
      { recipientAddress: { uuid: ROBIN.toUpperCase() }, type: 'SUCCESS' },
      { recipientAddress: { uuid: CASEY }, type: 'RATE_LIMIT_FAILURE', token: 't0ken' },
      { recipientAddress: { uuid: STRAY }, type: 'UNREGISTERED_FAILURE' },
      { recipientAddress: { uuid: SELF }, type: 'IDENTITY_FAILURE' },
    ]);
    expect([...told]).toEqual([
      [CASEY, 'captcha'],
      [STRAY, 'UNREGISTERED_FAILURE'],
      [SELF, 'IDENTITY_FAILURE'],
    ]);
    expect(untoldNotes(told, (id) => (id === CASEY ? 'Casey' : 'Me'))).toEqual([
      'Signal could not tell Casey about the group (Signal wants a captcha from this device first): they may not see it until someone writes in it',
      'Signal could not tell Me about the group (their safety number changed): they may not see it until someone writes in it',
    ]);
  });

  test('createGroup: the guard of its own; the guard on changes to groups is as strict as it was', () => {
    expect(createGroupParams(' Trip ', [ROBIN])).toEqual({ name: 'Trip', member: [ROBIN] });
    expect('groupId' in createGroupParams('Trip', [ROBIN])).toBe(false);
    expect(() => createGroupParams('', [ROBIN])).toThrow(/needs a name/);
    expect(() => createGroupParams('Trip', [])).toThrow(/1 to 10 people/);
    expect(() => createGroupParams('Trip', Array(11).fill(ROBIN))).toThrow(/1 to 10 people/);
    expect(() => createGroupParams('Trip', ['+15550137'])).toThrow(/Signal person ids/);
    // Every updateGroup without a group id so far was one createGroup made, with a name and members.
    const made = calls('updateGroup').filter((c) => !c.params?.groupId);
    expect(made.length).toBe(2);
    expect(made.every((c) => Object.keys(c.params).sort().join() === 'member,name')).toBe(true);
    for (const id of ['', '  ', undefined, null]) expect(() => updateGroupParams(id, { name: 'x' })).toThrow(/create a new group/);
    expect(() => updateGroupParams(GID, { name: 'x', member: [ROBIN] })).toThrow(/one group change/);
  });

  test('hello advertises createGroup', () => {
    expect(CAPABILITIES).toContain('createGroup');
    expect(of('hello')[0].capabilities).toContain('createGroup');
  });

  test('daemon crash: restarted with backoff, back online', async () => {
    const mark = events.length;
    const pid = argvs('daemon').at(-1).pid;
    writeFileSync(join(signalDir, 'fake-exit'), '3');
    await until('connecting', () => of('status', mark).find((s) => s.status === 'connecting'));
    await until('online again', () => of('status', mark).find((s) => s.status === 'online'));
    expect(alive(pid)).toBe(false);
    expect(argvs('daemon').length).toBe(2);
    expect(logs.some((l) => l.includes('signal-cli daemon stopped'))).toBe(true);
  });

  test('a hung daemon (socket open, no answers) is killed and restarted', async () => {
    const mark = events.length;
    const pid = argvs('daemon').at(-1).pid;
    writeFileSync(join(signalDir, 'fake-hang'), String(pid));
    await until('connecting', () => of('status', mark).find((s) => s.status === 'connecting'));
    await until('online again', () => of('status', mark).find((s) => s.status === 'online'));
    expect(alive(pid)).toBe(false);
    expect(logs.filter((l) => l.startsWith('[warn] signal-cli stopped answering'))).toHaveLength(1);
    expect(calls('version').length).toBeGreaterThanOrEqual(2); // the two unanswered probes
    rmSync(join(signalDir, 'fake-hang'));
  });

  test('unlinked from the phone: back to linking, data kept', async () => {
    const mark = events.length;
    const accFile = join(signalDir, 'data', 'accounts.json');
    const acc = JSON.parse(readFileSync(accFile, 'utf8'));
    acc.accounts[0].registered = false;
    writeFileSync(accFile, JSON.stringify(acc));
    writeFileSync(join(signalDir, 'fake-exit'), '0');
    const st = await until('relink QR', () => of('status', mark).find((s) => s.attention?.qr));
    expect(st.attention!.message).toStartWith('This device was unlinked from your phone.');
    expect(existsSync(accFile)).toBe(true);
    await expect(cmd({ t: 'send', conversation: DM_ALICE, body: 'x' })).rejects.toThrow(/not connected/);
    await expect(cmd({ t: 'action', action: 'resync' })).rejects.toThrow(/not connected/);
  });

  test('relink action wipes signal-cli data and starts over', async () => {
    const mark = events.length;
    expect(await cmd({ t: 'action', action: 'relink' })).toEqual({ ok: true });
    expect(secret.number).toBeUndefined();
    expect(secret.aci).toBeUndefined();
    const st = await until('fresh QR', () => of('status', mark).find((s) => s.attention?.qr));
    expect(st.attention!.message).toBe(LINK_MESSAGE);
    expect(existsSync(join(signalDir, 'data', 'accounts.json')) && JSON.parse(readFileSync(join(signalDir, 'data', 'accounts.json'), 'utf8')).accounts.length).toBeFalsy();
  });

  test('QR rotation pauses when nobody scans, and startLink resumes it', async () => {
    // a second adapter with a short attention span, on its own dir
    const dir2 = mkdtempSync(join(tmpdir(), 'dither-sig-'));
    const ev2: AdapterEvent[] = [];
    const a2 = new SignalAdapter(
      { emit: (e) => ev2.push(e), log: () => {}, accountDir: dir2, config: { deviceName: 'test-device' }, secret: () => ({}), saveSecret: () => {} },
      { signalCli: async () => [process.execPath, FAKE], linkRotateMs: 200, linkMaxActiveMs: 500 },
    );
    try {
      await a2.start();
      const st2 = () => ev2.filter((e): e is Extract<AdapterEvent, { t: 'status' }> => e.t === 'status');
      await until('paused', () => st2().find((s) => s.attention?.message.startsWith('The QR code expired')));
      const qrs = new Set(st2().map((s) => s.attention?.qr).filter(Boolean));
      expect(qrs.size).toBeGreaterThanOrEqual(2);
      const mark = ev2.length;
      expect(await a2.command({ t: 'action', id: 'x', action: 'startLink' })).toEqual({ ok: true });
      const fresh = await until('fresh QR after resume', () => ev2.slice(mark).find((e) => e.t === 'status' && !!e.attention?.qr));
      expect(qrs.has((fresh as any).attention.qr)).toBe(false);
      const argv = readFileSync(join(dir2, 'signal-cli', 'fake-rpc.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))[0].argv;
      expect(argv).toEqual(['--config', join(dir2, 'signal-cli'), '--trust-new-identities', 'always', 'link', '-n', 'test-device']);
    } finally {
      await a2.shutdown();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('a scan that fails during registration says so next to the new code', async () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'dither-sig-'));
    const ev3: AdapterEvent[] = [];
    const a3 = new SignalAdapter(
      { emit: (e) => ev3.push(e), log: () => {}, accountDir: dir3, config: {}, secret: () => ({}), saveSecret: () => {} },
      { signalCli: async () => [process.execPath, FAKE] },
    );
    try {
      await a3.start();
      const st3 = () => ev3.filter((e): e is Extract<AdapterEvent, { t: 'status' }> => e.t === 'status');
      const first = await until('qr', () => st3().find((s) => s.attention?.qr));
      writeFileSync(join(dir3, 'signal-cli', 'fake-scan'), 'fail');
      const next = await until('second qr', () => st3().find((s) => s.attention?.qr && s.attention.qr !== first.attention!.qr));
      expect(next.attention!.message).toBe('Linking failed: Link request error: Failed to register as secondary device (NonSuccessfulResponseCodeException). ' + LINK_MESSAGE);
      expect(st3().some((s) => s.status === 'connecting' && s.attention === null)).toBe(true); // while it was finishing
    } finally {
      await a3.shutdown();
      rmSync(dir3, { recursive: true, force: true });
    }
  });

  test('shutdown stops every signal-cli process', async () => {
    const pids = records()
      .filter((r) => r.t === 'argv')
      .map((r) => r.pid);
    await adapter.shutdown();
    await until('children gone', () => pids.every((p) => !alive(p)), 5000);
  });
});

describe('socket path', () => {
  test('lives in the account dir, or a private runtime dir when that path is too long for a UNIX socket', () => {
    expect(socketPathFor('/tmp/dither/accounts/acc_x')).toBe('/tmp/dither/accounts/acc_x/signal-cli.sock');
    const long = '/tmp/' + 'x'.repeat(120) + '/accounts/acc_y';
    const p = socketPathFor(long);
    expect(Buffer.byteLength(p)).toBeLessThan(108);
    expect(p).toMatch(/\/dither-signal-[0-9a-f]{16}\/rpc\.sock$/);
    expect(socketPathFor(long)).toBe(p); // stable per account
    const st = require('node:fs').statSync(require('node:path').dirname(p));
    expect(st.mode & 0o777).toBe(0o700);
    rmSync(require('node:path').dirname(p), { recursive: true, force: true });
  });
});
