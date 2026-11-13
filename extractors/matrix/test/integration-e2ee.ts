/**
 * The encryption half of test/integration.ts, against the same testbed and fake hub. The adapter
 * under test talks to "other clients" (test/peer.ts) in an encrypted room, in both directions.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { enc, MatrixClient } from '../src/http.ts';
import { encodeRecoveryKey, encryptSecret, secretKeyInfo } from '../src/recovery.ts';
import { M, Peer } from './peer.ts';

type MessageEv = Extract<P.AdapterEvent, { t: 'message' }>;

export interface Harness {
  tb: any;
  dir: string;
  events: P.AdapterEvent[];
  check: (ok: boolean, what: string, detail?: unknown) => void;
  command: (cmd: Record<string, unknown>, ms?: number) => Promise<any>;
  waitFor: <T extends P.AdapterEvent>(pred: (e: P.AdapterEvent) => boolean, ms?: number, includePast?: boolean) => Promise<T>;
  /** Stop the adapter (and optionally change its files), then start it again in `dir`, and wait for it to be online. */
  restart: (dir: string, between?: () => void) => Promise<void>;
  logs: () => string;
}

export async function runE2ee(h: Harness) {
  const { tb, dir, check, command, waitFor } = h;
  const baseUrl: string = tb.baseUrl;
  const quinnId: string = tb.users.quinn.userId;
  const aliceId: string = tb.users.alice.userId;
  const msg = (pred: (m: P.MessageFact) => boolean, ms?: number, past = true) => waitFor<MessageEv>((e) => e.t === 'message' && pred(e.message), ms, past);
  const lastMsg = (id: string) => h.events.filter((e): e is MessageEv => e.t === 'message' && e.message.nativeId === id).at(-1)?.message;
  const hello = () => h.events.filter((e): e is Extract<P.AdapterEvent, { t: 'hello' }> => e.t === 'hello').at(-1);

  const alice = await Peer.login(baseUrl, 'alice', tb.users.alice.password);
  const quinn2 = await Peer.login(baseUrl, 'quinn', tb.users.quinn.password);
  const quinnAdmin = new MatrixClient(baseUrl);
  quinnAdmin.accessToken = tb.users.quinn.accessToken;

  // A fresh encrypted room, alice and quinn.
  const created = await alice.client.request('POST', '/_matrix/client/v3/createRoom', {
    body: { name: `e2ee test ${Date.now()}`, preset: 'private_chat', invite: [quinnId], initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] },
  });
  const room: string = created.room_id;
  await quinnAdmin.request('POST', `/_matrix/client/v3/join/${enc(room)}`, { body: {} });
  await msg(() => false, 1500).catch(() => {}); // let the adapter's sync see the room
  await waitFor((e) => e.t === 'conversation' && e.conversation.nativeId === room && e.conversation.encrypted === true);

  // ------------------------------------------------------------------ off until asked for

  check(!hello()?.capabilities.includes('e2ee'), 'e2ee: off by default, no capability');
  check(!existsSync(join(dir, 'crypto.sqlite')), 'e2ee: no crypto store before setup');
  const myDevice = (await command({ t: 'action', action: 'status' })).deviceId as string;
  const published = async () => (await quinnAdmin.request('POST', '/_matrix/client/v3/keys/query', { body: { device_keys: { [quinnId]: [myDevice] } } })).device_keys?.[quinnId]?.[myDevice];
  check(!(await published()), 'e2ee: the device has published no keys before setup');
  const refused = (cmd: Record<string, unknown>) => command(cmd).then(() => false, (e) => /Set up encryption/.test(String(e)));
  check(await refused({ t: 'send', conversation: room, body: 'plaintext?' }), 'e2ee: send before setup is refused, pointing at the setup');
  const off = await command({ t: 'action', action: 'encryptionStatus' });
  check(off.on === false && off.active === false, 'e2ee: status says off', off);

  // ------------------------------------------------------------------ setup

  const st = await command({ t: 'action', action: 'setupEncryption', args: {} });
  check(st.active === true && st.deviceId === myDevice && !st.verified, 'e2ee: setup starts the crypto layer; the device is unverified', { active: st.active, verified: st.verified, backup: st.backup });
  await waitFor((e) => e.t === 'hello' && e.capabilities.includes('e2ee'));
  check(true, 'e2ee: hello now carries the e2ee capability');
  const keys = await published();
  check(keys?.keys?.[`ed25519:${myDevice}`]?.replace(/=+$/, '') === st.fingerprint?.replace(/=+$/, ''), 'e2ee: device keys are on the homeserver');
  const otk = await quinnAdmin.request('POST', '/_matrix/client/v3/keys/claim', { body: { one_time_keys: { [quinnId]: { [myDevice]: 'signed_curve25519' } } } });
  check(Object.keys(otk.one_time_keys?.[quinnId]?.[myDevice] ?? {}).length === 1, 'e2ee: one-time keys are on the homeserver');
  check((statSync(join(dir, 'crypto.sqlite')).mode & 0o777) === 0o600, 'e2ee: crypto store is 0600');
  const secret = JSON.parse(readFileSync(join(dir, 'secret.json'), 'utf8'));
  check((statSync(join(dir, 'secret.json')).mode & 0o777) === 0o600 && secret.e2ee?.on === true && !!secret.e2ee.storeKey, 'e2ee: the switch and the store key are in secret.json');
  const again = await command({ t: 'action', action: 'setupEncryption', args: {} });
  check(again.fingerprint === st.fingerprint, 'e2ee: setting up twice changes nothing');

  // ------------------------------------------------------------------ text, both ways

  const a1 = await alice.send(room, 'm.room.message', { msgtype: 'm.text', body: 'hello from alice, encrypted' });
  const got1 = await msg((m) => m.nativeId === a1 && m.kind !== 'encrypted');
  check(got1.message.body === 'hello from alice, encrypted' && got1.live === true, 'e2ee: receives and decrypts a message, live', got1.message.body);
  const rawA1 = await quinnAdmin.request('GET', `/_matrix/client/v3/rooms/${enc(room)}/event/${enc(a1)}`);
  check(rawA1.type === 'm.room.encrypted', 'e2ee: and the server only has ciphertext of it');

  const z1 = (await command({ t: 'send', conversation: room, body: 'hello from **quinn**, encrypted' })).nativeId as string;
  const seenByAlice = await alice.waitFor((e) => e.event_id === z1);
  check(seenByAlice.raw.type === 'm.room.encrypted' && !JSON.stringify(seenByAlice.raw.content).includes('hello from') && seenByAlice.type === 'm.room.message' && seenByAlice.content.body === 'hello from **quinn**, encrypted', 'e2ee: send arrives at the other client encrypted, and decrypts', seenByAlice.content.body);
  const echo = await msg((m) => m.nativeId === z1);
  check(echo.message.body === 'hello from **quinn**, encrypted', 'e2ee: our own message comes back decrypted', echo.message.body);
  const seenByOwnDevice = await quinn2.waitFor((e) => e.event_id === z1);
  check(seenByOwnDevice.type === 'm.room.message', 'e2ee: our other device got the key too');

  // ------------------------------------------------------------------ replies, edits, reactions, threads

  const areply = await alice.send(room, 'm.room.message', { msgtype: 'm.text', body: 'a reply', 'm.relates_to': { 'm.in_reply_to': { event_id: z1 } } });
  const replied = await msg((m) => m.nativeId === areply && m.kind !== 'encrypted');
  check(replied.message.replyTo === z1 && replied.message.body === 'a reply', 'e2ee: a reply keeps its target');

  const aedit = await alice.send(room, 'm.room.message', { msgtype: 'm.text', body: '* edited by alice', 'm.new_content': { msgtype: 'm.text', body: 'edited by alice' }, 'm.relates_to': { rel_type: 'm.replace', event_id: a1 } });
  const edited = await msg((m) => m.nativeId === a1 && !!m.editedTs);
  check(edited.message.body === 'edited by alice', 'e2ee: an incoming edit applies', { body: edited.message.body, aedit });
  await command({ t: 'edit', conversation: room, message: z1, body: 'edited by quinn' });
  const zedit = await alice.waitFor((e) => e.content?.['m.relates_to']?.rel_type === 'm.replace' && e.content['m.relates_to'].event_id === z1);
  check(zedit.raw.type === 'm.room.encrypted' && zedit.content['m.new_content']?.body === 'edited by quinn', 'e2ee: an edit goes out encrypted');
  await msg((m) => m.nativeId === z1 && m.body === 'edited by quinn');
  check(true, 'e2ee: our own edit comes back applied');

  const forged = await alice.rawSend(room, 'm.room.message', { msgtype: 'm.text', body: '* forged', 'm.new_content': { msgtype: 'm.text', body: 'forged in plaintext' }, 'm.relates_to': { rel_type: 'm.replace', event_id: a1 } });
  await alice.waitFor((e) => e.event_id === forged);
  await Bun.sleep(1500);
  check(lastMsg(a1)?.body === 'edited by alice', 'e2ee: a plaintext edit cannot rewrite an encrypted message');
  const plain = await alice.rawSend(room, 'm.room.message', { msgtype: 'm.text', body: 'sent in the clear' });
  const shown = await msg((m) => m.nativeId === plain);
  check(/Not encrypted/.test(String(shown.message.extra?.encryptionWarning)), 'e2ee: a plaintext message in an encrypted room is flagged', shown.message.extra);
  check(!got1.message.extra?.encryptionWarning, 'e2ee: a decrypted one is not');

  const arx = await alice.send(room, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: z1, key: '🎉' } });
  await waitFor((e) => e.t === 'reaction' && e.message === z1 && e.key === '🎉' && e.author === aliceId && !e.remove);
  check(true, 'e2ee: an encrypted reaction arrives');
  const noBubble = h.events.some((e) => e.t === 'message' && e.message.nativeId === arx);
  check(!noBubble, 'e2ee: and it is no message');
  await alice.client.request('PUT', `/_matrix/client/v3/rooms/${enc(room)}/redact/${enc(arx)}/${enc(alice.client.txnId())}`, { body: {} });
  await waitFor((e) => e.t === 'reaction' && e.message === z1 && e.key === '🎉' && !!e.remove);
  check(true, 'e2ee: redacting it removes it');
  const ctx = await command({ t: 'reactionContext', conversation: room });
  check(ctx.canReact === true, 'e2ee: reacting is offered');
  const zrx = (await command({ t: 'react', conversation: room, message: a1, key: '👍' })).nativeId as string;
  const zrxSeen = await alice.waitFor((e) => e.event_id === zrx);
  check(zrxSeen.raw.type === 'm.room.encrypted' && zrxSeen.type === 'm.reaction' && zrxSeen.content['m.relates_to']?.key === '👍', 'e2ee: our reaction goes out encrypted');
  await waitFor((e) => e.t === 'reaction' && e.message === a1 && e.key === '👍' && e.author === quinnId && !e.remove);
  // Forget the local index: it has to find the reaction on the server, where it is only m.room.encrypted.
  await command({ t: 'react', conversation: room, message: a1, key: '👍', remove: true });
  await waitFor((e) => e.t === 'reaction' && e.message === a1 && e.key === '👍' && !!e.remove);
  check(true, 'e2ee: taking our reaction back works');

  const aroot = await alice.send(room, 'm.room.message', { msgtype: 'm.text', body: 'thread root in an encrypted room' });
  await msg((m) => m.nativeId === aroot && m.kind !== 'encrypted');
  const inThread = await alice.send(room, 'm.room.message', { msgtype: 'm.text', body: 'in the thread', 'm.relates_to': { rel_type: 'm.thread', event_id: aroot, is_falling_back: true, 'm.in_reply_to': { event_id: aroot } } });
  const threadMsg = await msg((m) => m.nativeId === inThread && m.kind !== 'encrypted');
  const tid = `${room}|${aroot}`;
  const tfact = h.events.filter((e) => e.t === 'conversation' && e.conversation.nativeId === tid).at(-1) as any;
  check(threadMsg.message.conversation === tid && threadMsg.message.body === 'in the thread' && tfact?.conversation.name === 'thread root in an encrypted room' && tfact?.conversation.encrypted === true, 'e2ee: a thread in an encrypted room, named by its decrypted root', tfact?.conversation.name);
  const zInThread = (await command({ t: 'send', conversation: tid, body: 'answer in the thread' })).nativeId as string;
  const zt = await alice.waitFor((e) => e.event_id === zInThread);
  check(zt.raw.type === 'm.room.encrypted' && zt.content['m.relates_to']?.rel_type === 'm.thread' && zt.content['m.relates_to']?.event_id === aroot, 'e2ee: send into the thread is encrypted, with the relation for the server to see');

  // ------------------------------------------------------------------ a key that arrives after its message

  // Leaving the session behind forces a new one, whose key we can hold back.
  await alice.machine.invalidateGroupSession(new M.RoomId(room));
  const held = await alice.heldKeyShare(room);
  check(held.length > 0, 'late key: a new session, its key held back', held.length);
  const late = await alice.sendWithoutShare(room, 'm.room.message', { msgtype: 'm.text', body: 'sent before its key' });
  const lateEdit = await alice.sendWithoutShare(room, 'm.room.message', { msgtype: 'm.text', body: '* edited before its key', 'm.new_content': { msgtype: 'm.text', body: 'edited before its key' }, 'm.relates_to': { rel_type: 'm.replace', event_id: late } });
  const lateRx = await alice.sendWithoutShare(room, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: late, key: '⏰' } });
  const utd = await msg((m) => m.nativeId === late);
  check(utd.message.kind === 'encrypted' && utd.message.body === '', 'late key: until then it shows as undecryptable', utd.message.kind);
  await msg((m) => false, 500).catch(() => {});
  check(!h.events.some((e) => e.t === 'message' && (e.message.nativeId === lateEdit || e.message.nativeId === lateRx)), 'late key: its edit and reaction make no bubbles of their own');
  const waiting = await command({ t: 'action', action: 'encryptionStatus' });
  check(waiting.undecrypted >= 3, 'late key: status counts what waits', waiting.undecrypted);
  for (const r of held) await alice.send1(r);
  const fixed = await msg((m) => m.nativeId === late && m.kind !== 'encrypted', 30_000);
  check(fixed.message.kind === 'text', 'late key: retried when the key arrives', fixed.message.body);
  await msg((m) => m.nativeId === late && m.body === 'edited before its key', 20_000);
  check(true, 'late key: the edit that came with it applies');
  await waitFor((e) => e.t === 'reaction' && e.message === late && e.key === '⏰', 20_000);
  check(true, 'late key: the reaction that came with it applies');

  // ------------------------------------------------------------------ media

  const plainBytes = new TextEncoder().encode('a very secret file, not an image at all');
  const spool = join(dir, 'spool-e2ee.png');
  writeFileSync(spool, plainBytes);
  const zf = await command({ t: 'send', conversation: room, body: '', attachments: [{ path: spool, name: 'secret.png', mime: 'image/png', size: plainBytes.length, kind: 'image' }] });
  const zfSeen = await alice.waitFor((e) => e.event_id === zf.nativeId);
  check(zfSeen.raw.type === 'm.room.encrypted' && !JSON.stringify(zfSeen.raw.content).includes('secret.png') && zfSeen.content.msgtype === 'm.image', 'media: the event is encrypted');
  const file = zfSeen.content.file;
  check(!!file?.url && !!file.key && !!file.iv && !!file.hashes?.sha256 && file.v === 'v2' && zfSeen.content.url === undefined, 'media: it has `file`, per the spec, and no `url`', Object.keys(file ?? {}));
  const onServer = new Uint8Array(await (await alice.client.raw('GET', `/_matrix/client/v1/media/download/${file.url.slice('mxc://'.length)}`)).arrayBuffer());
  check(onServer.length === plainBytes.length && Buffer.compare(onServer, plainBytes) !== 0, 'media: the server holds ciphertext', onServer.length);
  const { url: _u, ...info } = file;
  const aliceClear = M.Attachment.decrypt(new M.EncryptedAttachment(onServer, JSON.stringify(info)));
  check(Buffer.compare(aliceClear, plainBytes) === 0, 'media: the other client decrypts our file');
  const zfEcho = await msg((m) => m.nativeId === zf.nativeId && m.kind !== 'encrypted');
  const zfAtt = zfEcho.message.attachments?.[0];
  check(zfAtt?.url.startsWith(`${file.url}#`) === true && zfAtt.name === 'secret.png', 'media: the attachment points at the event that holds the key', zfAtt?.url);
  const back = await command({ t: 'fetchMedia', url: zfAtt!.url });
  check(Buffer.compare(Buffer.from(back.base64, 'base64'), plainBytes) === 0 && back.mime === 'image/png', 'media: our own file comes back decrypted through fetchMedia', back.mime);

  const sendFile = async (bytes: Uint8Array, mimetype: string, name: string) => {
    const enced = M.Attachment.encrypt(bytes);
    const data = enced.encryptedData;
    const mediaInfo = JSON.parse(enced.mediaEncryptionInfo!);
    const up = await alice.client.request('POST', '/_matrix/media/v3/upload', { body: data, contentType: 'application/octet-stream' });
    return alice.send(room, 'm.room.message', { msgtype: 'm.file', body: name, filename: name, file: { ...mediaInfo, url: up.content_uri }, info: { mimetype, size: bytes.length } });
  };
  const incoming = new TextEncoder().encode('from alice, through the hub media path');
  const af = await sendFile(incoming, 'text/plain', 'note.txt');
  const afMsg = await msg((m) => m.nativeId === af && m.kind !== 'encrypted');
  const afBack = await command({ t: 'fetchMedia', url: afMsg.message.attachments![0].url });
  check(Buffer.compare(Buffer.from(afBack.base64, 'base64'), incoming) === 0 && afBack.mime === 'text/plain', 'media: an incoming encrypted file decrypts through fetchMedia', afBack.mime);
  const evil = await sendFile(new TextEncoder().encode('<script>alert(1)</script>'), 'text/html', 'x.html');
  const evilMsg = await msg((m) => m.nativeId === evil && m.kind !== 'encrypted');
  const evilBack = await command({ t: 'fetchMedia', url: evilMsg.message.attachments![0].url });
  check(evilBack.mime === 'application/octet-stream', 'media: a sender cannot make the hub serve HTML', evilBack.mime);
  const tampered = await sendFile(new TextEncoder().encode('original'), 'text/plain', 't.txt');
  const tamperedMsg = await msg((m) => m.nativeId === tampered && m.kind !== 'encrypted');
  const wrongEvent = `${tamperedMsg.message.attachments![0].url.split('#')[0]}#${a1}`;
  check(await command({ t: 'fetchMedia', url: wrongEvent }).then(() => false, () => true), 'media: an event that holds no key for this file opens nothing');

  // ------------------------------------------------------------------ restart

  const before = await command({ t: 'action', action: 'encryptionStatus' });
  await h.restart(dir);
  const after = await command({ t: 'action', action: 'encryptionStatus' });
  check(after.active === true && after.fingerprint === before.fingerprint && after.roomKeys === before.roomKeys, 'restart: same device identity and room keys from the store', { roomKeys: after.roomKeys });
  check((await published())?.keys?.[`ed25519:${myDevice}`]?.replace(/=+$/, '') === after.fingerprint?.replace(/=+$/, ''), 'restart: no new device keys');
  const a2 = await alice.send(room, 'm.room.message', { msgtype: 'm.text', body: 'after the restart' });
  const got2 = await msg((m) => m.nativeId === a2 && m.kind !== 'encrypted');
  check(got2.message.body === 'after the restart', 'restart: still receives on the existing session');
  const z2 = (await command({ t: 'send', conversation: room, body: 'sent after the restart' })).nativeId as string;
  const seen2 = await alice.waitFor((e) => e.event_id === z2);
  check(seen2.type === 'm.room.message' && seen2.content.body === 'sent after the restart', 'restart: the Olm and Megolm sessions still work outward');

  // ------------------------------------------------------------------ never plaintext

  const countPlain = async () => {
    const res = await alice.client.request('GET', `/_matrix/client/v3/rooms/${enc(room)}/messages`, { query: { dir: 'b', limit: 20 } });
    return res.chunk.filter((e: any) => JSON.stringify(e.content).includes('must not leak')).length;
  };
  await h.restart(dir, () => renameSync(join(dir, 'crypto.sqlite'), join(dir, 'crypto.sqlite.away')));
  const broken = await command({ t: 'action', action: 'encryptionStatus' });
  check(broken.on === true && broken.active === false && /other keys/.test(broken.error ?? ''), 'broken store: the device mismatch is noticed, and crypto stays off', broken.error);
  await waitFor((e) => e.t === 'status' && e.attention?.kind === 'unknown');
  check(!!h.events.filter((e): e is Extract<P.AdapterEvent, { t: 'status' }> => e.t === 'status').at(-1)?.attention?.message, 'broken store: the account says so');
  const refusedBroken = async (cmd: Record<string, unknown>) => command(cmd).then(() => false, (e) => /encryption is not working/.test(String(e)));
  check(await refusedBroken({ t: 'send', conversation: room, body: 'must not leak' }), 'broken store: send refused');
  check(await refusedBroken({ t: 'edit', conversation: room, message: z2, body: 'must not leak' }), 'broken store: edit refused');
  check(await refusedBroken({ t: 'react', conversation: room, message: z2, key: 'must not leak' }), 'broken store: react refused');
  check(await refusedBroken({ t: 'send', conversation: room, body: 'must not leak', attachments: [{ path: spool, name: 'must not leak', mime: 'image/png', size: 3, kind: 'image' }] }), 'broken store: files refused');
  check((await countPlain()) === 0, 'broken store: nothing reached the room');
  await h.restart(dir, () => {
    rmSync(join(dir, 'crypto.sqlite'), { force: true });
    rmSync(join(dir, 'crypto.sqlite-wal'), { force: true });
    rmSync(join(dir, 'crypto.sqlite-shm'), { force: true });
    renameSync(join(dir, 'crypto.sqlite.away'), join(dir, 'crypto.sqlite'));
  });
  check((await command({ t: 'action', action: 'encryptionStatus' })).active === true, 'broken store: with the real store back, encryption works again');

  // ------------------------------------------------------------------ cross-signing, secret storage, backup, verification

  await quinn2.bootstrapCrossSigning(tb.users.quinn.password);
  const backup = await quinn2.createBackup();
  await Bun.sleep(1000);
  const uploaded = await quinn2.uploadBackup();
  check(uploaded > 0, 'backup: the other device uploaded its room keys', uploaded);
  await Bun.sleep(1500);

  // SAS, started from the other device.
  const adapterDevice = await quinn2.machine.getDevice(new M.UserId(quinnId), new M.DeviceId(myDevice), 10);
  check(!!adapterDevice && !adapterDevice.isCrossSigningTrusted(), 'verification: the adapter device starts out unverified for the other device');
  const [vreq, vout] = adapterDevice!.requestVerification([M.VerificationMethod.SasV1]);
  await quinn2.send1(vout);
  await waitFor((e) => e.t === 'status' && e.attention?.kind === 'verify' && (e.attention.detail as any)?.verification?.phase === 'requested', 20_000);
  const statusAtAsk = h.events.filter((e): e is Extract<P.AdapterEvent, { t: 'status' }> => e.t === 'status').at(-1);
  check(statusAtAsk?.status === 'online', 'verification: the request shows as attention, and the account stays online');
  await command({ t: 'action', action: 'verifyDevice', args: { step: 'accept' } });
  for (let i = 0; i < 100 && !vreq.isReady(); i++) await Bun.sleep(100);
  const started = await vreq.startSas();
  await quinn2.send1(started![1]);
  const sas = started![0];
  const compare = await waitFor<Extract<P.AdapterEvent, { t: 'status' }>>((e) => e.t === 'status' && (e.attention?.detail as any)?.verification?.phase === 'compare', 20_000);
  for (let i = 0; i < 100 && !sas.canBePresented(); i++) {
    await quinn2.flush();
    await Bun.sleep(100);
  }
  const mine = (compare.attention!.detail as any).verification.emoji.map((e: any) => e.symbol).join('');
  const theirs = sas.emoji()!.map((e) => e.symbol).join('');
  check(mine.length > 0 && mine === theirs, 'verification: both devices show the same emoji', mine);
  for (const out of await sas.confirm()) if (out) await quinn2.send1(out);
  await command({ t: 'action', action: 'verifyDevice', args: { step: 'confirm' } });
  let verified: any;
  for (let i = 0; i < 100; i++) {
    verified = await command({ t: 'action', action: 'encryptionStatus' });
    if (verified.verified && verified.lastVerification === 'verified') break;
    await Bun.sleep(200);
  }
  check(verified.verified === true && verified.lastVerification === 'verified', 'verification: done, and the adapter sees itself cross-signed', { verified: verified.verified, last: verified.lastVerification });
  check(!verified.verification, 'verification: the attention is gone');
  for (let i = 0; i < 50 && !verified.backup; i++) {
    await Bun.sleep(200);
    verified = await command({ t: 'action', action: 'encryptionStatus' });
  }
  check(!!verified.backup && verified.backup.version === backup.version, 'verification: the other device handed over the backup key', verified.backup);

  // Past history on a brand new device, with the backup key as the recovery key.
  const history: string[] = [];
  for (let i = 1; i <= 60; i++) history.push(await alice.send(room, 'm.room.message', { msgtype: 'm.text', body: `old message ${i}` }));
  const hEdit = await alice.send(room, 'm.room.message', { msgtype: 'm.text', body: '* old message 3, edited', 'm.new_content': { msgtype: 'm.text', body: 'old message 3, edited' }, 'm.relates_to': { rel_type: 'm.replace', event_id: history[2] } });
  await quinn2.waitFor((e) => e.event_id === hEdit, 30_000);
  await quinn2.uploadBackup();
  const inBackup = await quinnAdmin.request('GET', '/_matrix/client/v3/room_keys/version', { query: { version: backup.version } });
  check(inBackup.count > 0, 'history: the room keys are in the backup', inBackup.count);

  const newDevice = async (recoveryKey: string) => {
    const d = mkdtempSync(join(tmpdir(), 'dither-matrix-e2ee-'));
    writeFileSync(join(d, 'secret.json'), JSON.stringify({ userId: quinnId, password: tb.users.quinn.password }), { mode: 0o600 });
    chmodSync(join(d, 'secret.json'), 0o600);
    await h.restart(d, () => (h.events.length = 0));
    const s = await command({ t: 'action', action: 'setupEncryption', args: { recoveryKey } });
    return { d, s };
  };
  const logout = async (d: string) => {
    const s = JSON.parse(readFileSync(join(d, 'secret.json'), 'utf8'));
    if (s.accessToken) await fetch(`${baseUrl}/_matrix/client/v3/logout`, { method: 'POST', headers: { authorization: `Bearer ${s.accessToken}` } });
  };

  const rk = encodeRecoveryKey(new Uint8Array(Buffer.from(backup.key.toBase64(), 'base64')));
  const dev2 = await newDevice(rk);
  check(dev2.s.deviceId !== myDevice && dev2.s.backup?.version === backup.version && dev2.s.recoveryKeySaved === true, 'history: a new device accepts the backup key as recovery key', dev2.s.backup);
  check(dev2.s.verified === false, 'history: which verifies nothing by itself');
  const body = (id: string) => lastMsg(id)?.body;
  const nth = history[59];
  await msg((m) => m.nativeId === nth && m.kind !== 'encrypted', 30_000);
  check(body(nth) === 'old message 60', 'history: a message from before this device existed decrypts from the backup', body(nth));
  let pages = 0;
  let hist = { done: false, count: 0 };
  while (!hist.done && pages < 8 && !h.events.some((e) => e.t === 'message' && e.message.nativeId === history[0])) {
    hist = await command({ t: 'history', conversation: room, limit: 50 });
    pages++;
  }
  await msg((m) => m.nativeId === history[0] && m.kind !== 'encrypted', 30_000);
  check(body(history[0]) === 'old message 1', `history: backfilled in ${pages} page(s), and scrollback decrypts`, body(history[0]));
  await msg((m) => m.nativeId === history[2] && !!m.editedTs, 30_000);
  check(body(history[2]) === 'old message 3, edited', 'history: an edit in the backfill applies', body(history[2]));

  // SAS again, started from the hub this time: first the emoji "do not match", then they do.
  const quinnUser = new M.UserId(quinnId);
  const hubStarted = async () => {
    await command({ t: 'action', action: 'verifyDevice', args: { step: 'start' } });
    let req: any;
    for (let i = 0; i < 100 && !req; i++) {
      req = quinn2.machine.getVerificationRequests(quinnUser).find((r) => !r.isDone() && !r.isCancelled() && r.otherDeviceId?.toString() === dev2.s.deviceId);
      if (!req) await Bun.sleep(100);
    }
    if (!req) throw new Error('the other device did not get the request');
    const out = req.acceptWithMethods([M.VerificationMethod.SasV1]);
    if (out) await quinn2.send1(out);
    const compared = waitFor((e) => e.t === 'status' && (e.attention?.detail as any)?.verification?.phase === 'compare', 20_000, false);
    let sasOther: any;
    for (let i = 0; i < 100 && !sasOther; i++) {
      sasOther = req.getVerification();
      if (!sasOther) await Bun.sleep(100);
    }
    const accepted = sasOther.accept();
    if (accepted) await quinn2.send1(accepted);
    await compared;
    for (let i = 0; i < 100 && !sasOther.canBePresented(); i++) await Bun.sleep(100);
    return sasOther;
  };
  const sas1 = await hubStarted();
  await command({ t: 'action', action: 'verifyDevice', args: { step: 'mismatch' } });
  for (let i = 0; i < 100 && !sas1.isCancelled(); i++) await Bun.sleep(100);
  const afterNo = await command({ t: 'action', action: 'encryptionStatus' });
  check(sas1.isCancelled() && !afterNo.verified && !!afterNo.lastVerification && afterNo.lastVerification !== 'verified', 'verification: "they do not match" cancels on both sides, and verifies nothing', afterNo.lastVerification);
  const sas2 = await hubStarted();
  for (const out of await sas2.confirm()) if (out) await quinn2.send1(out);
  await command({ t: 'action', action: 'verifyDevice', args: { step: 'confirm' } });
  let afterYes: any;
  for (let i = 0; i < 100; i++) {
    afterYes = await command({ t: 'action', action: 'encryptionStatus' });
    if (afterYes.verified) break;
    await Bun.sleep(200);
  }
  check(afterYes.verified === true && afterYes.lastVerification === 'verified', 'verification: started from the hub, and verified', afterYes.lastVerification);

  const wrong = await command({ t: 'action', action: 'addRecoveryKey', args: { recoveryKey: encodeRecoveryKey(new Uint8Array(32).fill(9)) } }).then(() => null, (e) => String(e));
  // The testbed account may still have secret storage from an earlier run, so either refusal is right here.
  check(!!wrong && /does not (open|unlock)/.test(wrong), 'recovery key: a wrong one is refused', wrong);
  check(JSON.parse(readFileSync(join(dev2.d, 'secret.json'), 'utf8')).e2ee.recoveryKey === rk, 'recovery key: the good one stays saved, the wrong one is not');
  check(!h.logs().includes(rk.replace(/ /g, '')) && !h.logs().includes(rk) && !h.logs().includes(JSON.parse(readFileSync(join(dev2.d, 'secret.json'), 'utf8')).e2ee.storeKey), 'nothing secret in the adapter log');
  await logout(dev2.d);

  // A new device again, with the Secret Storage key as the recovery key. Cross-signing comes with it.
  const ssss = crypto.getRandomValues(new Uint8Array(32));
  const keyId = `test${Date.now()}`;
  const own = await quinn2.machine.exportCrossSigningKeys();
  await quinn2.setAccountData(`m.secret_storage.key.${keyId}`, { algorithm: 'm.secret_storage.v1.aes-hmac-sha2', ...(await secretKeyInfo(ssss)) });
  await quinn2.setAccountData('m.secret_storage.default_key', { key: keyId });
  const putSecret = async (name: string, value: string | undefined) => {
    if (value) await quinn2.setAccountData(name, { encrypted: { [keyId]: await encryptSecret(ssss, name, value) } });
  };
  await putSecret('m.megolm_backup.v1', backup.key.toBase64());
  await putSecret('m.cross_signing.master', own?.masterKey);
  await putSecret('m.cross_signing.self_signing', own?.self_signing_key);
  await putSecret('m.cross_signing.user_signing', own?.userSigningKey);
  const dev3 = await newDevice(encodeRecoveryKey(ssss));
  check(dev3.s.backup?.version === backup.version, 'secret storage: the recovery key unlocks the backup key', dev3.s.backup);
  let dev3st = dev3.s;
  for (let i = 0; i < 50 && !dev3st.verified; i++) {
    await Bun.sleep(200);
    dev3st = await command({ t: 'action', action: 'encryptionStatus' });
  }
  check(dev3st.verified === true, 'secret storage: and the cross-signing keys, which verify this device', dev3st.crossSigning);
  const dev3device = dev3st.deviceId as string;
  await quinn2.client.request('POST', '/_matrix/client/v3/keys/query', { body: { device_keys: { [quinnId]: [dev3device] } } });
  await quinn2.machine.updateTrackedUsers([new M.UserId(quinnId)]);
  await Bun.sleep(1500);
  const seenFromOther = await quinn2.machine.getDevice(new M.UserId(quinnId), new M.DeviceId(dev3device), 10);
  check(!!seenFromOther?.isCrossSigningTrusted(), 'secret storage: the other device sees it as verified too');
  const dev3Old = await msg((m) => m.nativeId === nth && m.kind !== 'encrypted', 5000);
  check(dev3Old.message.body === 'old message 60', 'secret storage: history decrypts');
  check(!dev3st.recoveryError && dev3st.recovery?.problems?.length === 0, 'secret storage: and nothing is reported missing', dev3st.recovery);

  // What a failed recovery key says: exactly what was wrong.
  const refusal = (recoveryKey: string) => command({ t: 'action', action: 'addRecoveryKey', args: { recoveryKey } }).then(() => 'accepted', (e) => String(e));
  const good = encodeRecoveryKey(ssss).replace(/ /g, '');
  const typo = good.slice(0, 12) + (good[12] === 'a' ? 'b' : 'a') + good.slice(13);
  const said = { typo: await refusal(typo), wrong: await refusal(encodeRecoveryKey(new Uint8Array(32).fill(5))), phrase: await refusal('correct horse battery staple') };
  check(/typo/.test(said.typo), 'recovery key: a typo is called a typo', said.typo);
  check(/does not unlock this account's secret storage/.test(said.wrong), 'recovery key: a wrong key says it does not unlock secret storage', said.wrong);
  check(/no security phrase/.test(said.phrase), 'recovery key: a phrase, where secret storage has none, says so', said.phrase);
  await logout(dev3.d);
  rmSync(dev2.d, { recursive: true, force: true });
  rmSync(dev3.d, { recursive: true, force: true });

  // ------------------------------------------------------------------ cleanup

  await h.restart(dir);
  await alice.client.request('POST', `/_matrix/client/v3/rooms/${enc(room)}/leave`, { body: {} }).catch(() => {});
  await quinnAdmin.request('POST', `/_matrix/client/v3/rooms/${enc(room)}/leave`, { body: {} }).catch(() => {});
  await alice.stop();
  await quinn2.stop();
}
