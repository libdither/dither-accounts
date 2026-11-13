/**
 * End-to-end check of the Matrix adapter against the local testbed, with a fake hub.
 *
 *   bun extractors/matrix/testbed/testbed.ts up     # the testbed must be running and seeded
 *   bun extractors/matrix/test/integration.ts
 *
 * Runs the real adapter (src/main.ts) as a fresh device of @quinn with a temporary
 * account dir, plays the hub's side of the /adapter WebSocket, checks the initial
 * facts, then drives every command (send, edit, react, redact, history, markRead,
 * fetchMedia, actions). Test messages go to "Notes to self". Then the encryption half, in
 * integration-e2ee.ts. The devices log out at the end.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { enc, MatrixClient } from '../src/http.ts';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { runE2ee } from './integration-e2ee.ts';

const REPO = resolve(import.meta.dir, '../../..');
const tb = JSON.parse(readFileSync(join(process.env.DITHER_TESTBED_DIR ?? join(REPO, '.data/matrix-testbed'), 'testbed.json'), 'utf8'));
const R: Record<string, string> = tb.rooms;
const token = crypto.randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-itest-'));
writeFileSync(join(dir, 'secret.json'), JSON.stringify({ userId: tb.users.quinn.userId, password: tb.users.quinn.password }), { mode: 0o600 });

// ------------------------------------------------------------------ fake hub

const events: P.AdapterEvent[] = [];
const waiters: { pred: (e: P.AdapterEvent) => boolean; resolve: (e: P.AdapterEvent) => void }[] = [];
type Data = Record<string, never>;
const conn: { ws: import('bun').ServerWebSocket<Data> | null } = { ws: null };

const logLines: string[] = [];
const server = Bun.serve<Data, never>({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/adapter' && u.searchParams.get('token') === token && srv.upgrade(req, { data: {} })) return undefined;
    return new Response('no', { status: 401 });
  },
  websocket: {
    open(ws) {
      conn.ws = ws;
    },
    message(_ws, raw) {
      const ev = JSON.parse(String(raw)) as P.AdapterEvent;
      events.push(ev);
      if (ev.t === 'log') logLines.push(`${ev.msg} ${JSON.stringify(ev.data ?? '')}`);
      for (const w of [...waiters]) if (w.pred(ev)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(ev);
    },
    close() {
      conn.ws = null;
    },
  },
});

function waitFor<T extends P.AdapterEvent>(pred: (e: P.AdapterEvent) => boolean, ms = 15_000, includePast = true): Promise<T> {
  const past = includePast ? events.find(pred) : undefined;
  if (past) return Promise.resolve(past as T);
  return new Promise((res, rej) => {
    const w = { pred, resolve: (e: P.AdapterEvent) => (clearTimeout(t), res(e as T)) };
    const t = setTimeout(() => (waiters.splice(waiters.indexOf(w), 1), rej(new Error('timed out waiting for an event'))), ms);
    waiters.push(w);
  });
}

async function command(cmd: Record<string, unknown>, ms = 60_000): Promise<any> {
  const id = crypto.randomUUID();
  const reply = waitFor<Extract<P.AdapterEvent, { t: 'reply' }>>((e) => e.t === 'reply' && e.id === id, ms, false);
  conn.ws!.send(JSON.stringify({ ...cmd, id }));
  const r = await reply;
  if (!r.ok) throw new Error(`${cmd.t} failed: ${r.error}`);
  return r.result;
}

// ------------------------------------------------------------------ checks

const results: [boolean, string][] = [];
const check = (ok: boolean, what: string, detail?: unknown) => {
  results.push([ok, what]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const facts = <T extends P.AdapterEvent['t']>(t: T) => events.filter((e) => e.t === t) as Extract<P.AdapterEvent, { t: T }>[];
const lastConv = (id: string) => facts('conversation').filter((e) => e.conversation.nativeId === id).at(-1)?.conversation;
const lastMsg = (id: string) => facts('message').filter((e) => e.message.nativeId === id).at(-1);

const startAdapter = (accountDir: string) =>
  Bun.spawn(['bun', join(REPO, 'extractors/matrix/src/main.ts')], {
    cwd: REPO,
    env: {
      ...process.env,
      DITHER_HUB_URL: `ws://127.0.0.1:${server.port}/adapter`,
      DITHER_ACCOUNT_ID: 'acc_itest',
      DITHER_ADAPTER_TOKEN: token,
      DITHER_ACCOUNT_DIR: accountDir,
      DITHER_ACCOUNT_CONFIG: JSON.stringify({ homeserver: tb.baseUrl }),
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
let proc = startAdapter(dir);

/** Stop the adapter, optionally change things while it is down, start it in `accountDir`, wait for it to sync. */
async function restart(accountDir: string, between?: () => void) {
  conn.ws?.send(JSON.stringify({ t: 'shutdown' }));
  await Promise.race([proc.exited, Bun.sleep(5000)]);
  proc.kill();
  await proc.exited;
  between?.();
  const online = waitFor((e) => e.t === 'status' && e.status === 'online', 60_000, false);
  proc = startAdapter(accountDir);
  await online;
}

let failed = false;
try {
  await waitFor((e) => e.t === 'status' && e.status === 'online', 30_000);
  const hello = facts('hello')[0];
  check(['send', 'history', 'react', 'edit', 'redact', 'markRead', 'threads', 'media', 'sendMedia'].every((c) => hello?.capabilities.includes(c as P.Capability)), 'hello with all capabilities', hello?.capabilities);
  const self = facts('status').find((e) => e.self)?.self;
  check(self?.nativeId === tb.users.quinn.userId && self?.displayName === 'Quinn', 'status.self from whoami + profile', self);
  check(!JSON.parse(readFileSync(join(dir, 'secret.json'), 'utf8')).password, 'password dropped from secret.json after login');

  // structure
  const spaces = new Map(facts('space').map((e) => [e.space.nativeId, e.space]));
  check(spaces.size === 3 && spaces.get(R.offtopic)?.parents?.[0]?.nativeId === R.space, 'three spaces, Off-topic nested in Dither Testbed', [...spaces.values()].map((s) => s.name));
  check(lastConv(R.crossposts)?.spaces?.map((s) => s.nativeId).sort().join() === [R.offtopic, R.rustfriends].sort().join(), '#crossposts has two parent spaces', lastConv(R.crossposts)?.spaces);
  check(lastConv(R.dm)?.shape === 'direct' && lastConv(R.dm)?.participants?.includes(tb.users.alice.userId) === true, 'DM is direct with alice');
  check(facts('identity').some((e) => e.identity.nativeId === tb.users.alice.userId && e.identity.contact), 'alice identity is a contact');
  check(lastConv(R.weekend)?.shape === 'group' && lastConv(R.weekend)?.participants?.length === 3, 'Weekend plans is a 3-person group');
  check(lastConv(R.notes)?.shape === 'self', 'Notes to self is a self conversation');
  check(lastConv(R.lobby)?.shape === 'channel' && lastConv(R.lobby)?.spaces?.length === 0, 'public Lobby is a channel without spaces');
  check(lastConv(R.announcements)?.variant === 'announcement', '#announcements variant is announcement');
  check(lastConv(R.secret)?.encrypted === true, 'Secret plans is encrypted');
  const devThread = `${R.dev}|${tb.events.threadRoot}`;
  check(lastConv(devThread)?.shape === 'thread' && lastConv(devThread)?.parentConversation === R.dev, 'dev thread conversation', lastConv(devThread)?.name);
  check(lastMsg(tb.events.threadRoot)?.message.threadRoot === devThread, 'thread root message has threadRoot');
  check(facts('message').every((e) => e.live === false), 'initial sync messages are backfill (live=false)');
  check(lastMsg(tb.events.welcome)?.message.editedTs !== undefined && lastMsg(tb.events.welcome)!.message.body.includes('read #announcements'), 'edit applied to the welcome message');
  check(lastMsg(tb.events.carolReply)?.message.body === 'thanks for setting this up!' && lastMsg(tb.events.carolReply)?.message.replyTo === tb.events.welcome, 'reply fallback stripped, replyTo set');
  check(facts('delete').some((e) => e.nativeId === tb.events.oops), 'redacted message deleted');
  check(!facts('reaction').some((e) => e.key === '😂' && !e.remove) || facts('reaction').some((e) => e.key === '😂' && e.remove), 'redacted reaction not left behind');
  check(lastMsg(tb.events.mention)?.message.mentionsSelf === true && lastMsg(tb.events.mention)!.message.body.startsWith('<@@quinn:dither.test>'), 'mention of quinn', lastMsg(tb.events.mention)?.message.body);
  const read = facts('read').filter((e) => e.conversation === R.general).at(-1);
  check(read?.unread !== undefined && read.upToTs > 0, '#general read state from the server', read);

  // #archive: 120 messages, more than the 50-event window
  const archiveMsgs = () => facts('message').filter((e) => e.message.conversation === R.archive);
  const num = (body: string) => Number(body.match(/#(\d+)/)?.[1]);
  const before = new Set(archiveMsgs().map((e) => num(e.message.body)));
  check(!before.has(1) && before.has(120), 'archive initial window is the newest messages only', `${before.size} distinct`);
  const nine = archiveMsgs().find((e) => num(e.message.body) === 9);
  check(!!nine && nine.message.body.includes('edited much later') && !!nine.message.editedTs, 'edit of a message outside the window: target fetched, edit applied', nine?.message.body);
  const three = archiveMsgs().find((e) => num(e.message.body) === 3);
  check(!!three?.message.threadRoot, 'thread root outside the window fetched with threadRoot', three?.message.threadRoot);
  let pages = 0;
  let h: { count: number; done: boolean } = { count: 0, done: false };
  while (!h.done && pages < 6) {
    h = await command({ t: 'history', conversation: R.archive, limit: 50 });
    pages++;
  }
  const after = new Set(archiveMsgs().map((e) => num(e.message.body)));
  check(h.done && [...Array(120).keys()].every((i) => after.has(i + 1)), `history backfilled #archive to the start in ${pages} pages`, `${after.size} distinct`);
  const five = archiveMsgs().filter((e) => num(e.message.body) === 5).at(-1);
  check(!!five?.message.reactions?.some((r) => r.key === '👍'), 'backfilled #5 carries the reaction seen earlier', five?.message.reactions);
  check(archiveMsgs().filter((e) => num(e.message.body) < 60).every((e) => e.live === false), 'history messages are live=false');

  // commands on "Notes to self"
  const refused = async (cmd: Record<string, unknown>) => command(cmd).then(() => false, (e) => /encrypted/.test(String(e)));
  check(await refused({ t: 'send', conversation: R.secret, body: 'must not go out in plaintext' }), 'send to an encrypted room is refused');
  check(await refused({ t: 'react', conversation: R.secret, message: '$none', key: '\u{1F44D}' }), 'react in an encrypted room is refused');
  check(await refused({ t: 'edit', conversation: R.secret, message: '$none', body: 'must not go out in plaintext' }), 'edit in an encrypted room is refused');
  const sent = await command({ t: 'send', conversation: R.notes, body: '**integration test** <@@alice:dither.test> `code`' });
  const echo = await waitFor<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.nativeId === sent.nativeId);
  check(echo.live === true && echo.message.body === '**integration test** <@@alice:dither.test> `code`', 'send: echo arrives through sync as canonical Markdown', echo.message.body);
  await command({ t: 'edit', conversation: R.notes, message: sent.nativeId, body: 'integration test (edited)' });
  const edited = await waitFor<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.nativeId === sent.nativeId && !!e.message.editedTs);
  check(edited.message.body === 'integration test (edited)', 'edit: target re-emitted with new body and editedTs', edited.message.body);
  await command({ t: 'react', conversation: R.notes, message: sent.nativeId, key: '🎉' });
  await waitFor((e) => e.t === 'reaction' && e.message === sent.nativeId && e.key === '🎉' && !e.remove);
  check(true, 'react: reaction fact arrives');
  await command({ t: 'react', conversation: R.notes, message: sent.nativeId, key: '🎉', remove: true });
  await waitFor((e) => e.t === 'reaction' && e.message === sent.nativeId && e.key === '🎉' && !!e.remove);
  check(true, 'react remove: our reaction is redacted and a remove fact arrives');

  // Spellings of one emoji are one reaction: a key another client sent with U+FE0F is still ours to remove.
  const fe0f = await command({ t: 'react', conversation: R.notes, message: sent.nativeId, key: '👍\uFE0F' });
  check(!!fe0f.nativeId, 'react: a key with a variation selector is accepted');
  await waitFor((e) => e.t === 'reaction' && e.message === sent.nativeId && e.key === '👍\uFE0F' && !e.remove);
  await command({ t: 'react', conversation: R.notes, message: sent.nativeId, key: '👍', remove: true });
  await waitFor((e) => e.t === 'reaction' && e.message === sent.nativeId && e.key === '👍\uFE0F' && !!e.remove);
  check(true, 'react remove: finds our reaction whatever spelling it was sent in');

  // Custom emoji: an MSC2545 room image pack shows up in the context, and reacting with one carries its name.
  const plain = (await command({ t: 'reactionContext', conversation: R.notes })) as P.ReactionContext;
  check(plain.canReact === true && !plain.super, 'context: can react here, and Matrix has no super reactions', plain);
  const quinn = new MatrixClient(tb.baseUrl);
  quinn.accessToken = tb.users.quinn.accessToken;
  const mxc = 'mxc://dither.test/integration-emote';
  await quinn.request('PUT', `/_matrix/client/v3/rooms/${enc(R.notes)}/state/im.ponies.room_emotes/`, {
    body: { pack: { display_name: 'Test pack' }, images: { partyparrot: { url: mxc }, sticker_only: { url: 'mxc://dither.test/nope', usage: ['sticker'] } } },
  });
  await command({ t: 'action', action: 'resync' });
  const ctx = (await command({ t: 'reactionContext', conversation: R.notes })) as P.ReactionContext;
  const pack = ctx.custom.find((g) => g.name === 'Test pack');
  check(pack?.emoji.length === 1 && pack.emoji[0].key === mxc && pack.emoji[0].name === 'partyparrot', 'context: the room pack is offered, without sticker-only images', ctx.custom);
  await command({ t: 'react', conversation: R.notes, message: sent.nativeId, key: mxc, emoji: pack?.emoji[0] });
  const custom = await waitFor<Extract<P.AdapterEvent, { t: 'reaction' }>>((e) => e.t === 'reaction' && e.message === sent.nativeId && e.key === mxc && !e.remove);
  check(custom.emoji?.name === 'partyparrot' && custom.emoji.url === mxc, 'react: a custom emoji comes back described', custom.emoji);
  await command({ t: 'react', conversation: R.notes, message: sent.nativeId, key: mxc, remove: true });
  await waitFor((e) => e.t === 'reaction' && e.message === sent.nativeId && e.key === mxc && !!e.remove);
  check(true, 'react remove: a custom emoji reaction can be taken back');
  await quinn.request('PUT', `/_matrix/client/v3/rooms/${enc(R.notes)}/state/im.ponies.room_emotes/`, { body: {} });
  await command({ t: 'markRead', conversation: R.notes, upTo: sent.nativeId });
  check(true, 'markRead: receipt + read marker accepted');
  await command({ t: 'redact', conversation: R.notes, message: sent.nativeId });
  await waitFor((e) => e.t === 'delete' && e.nativeId === sent.nativeId);
  check(true, 'redact: delete fact arrives');

  // Sending files: text first, then the file as its own event, and the bytes come back through fetchMedia.
  const spool = join(dir, 'spool.png');
  writeFileSync(spool, 'not really a png');
  const fileSent = await command({ t: 'send', conversation: R.notes, body: 'with a caption', attachments: [{ path: spool, name: 'pic.png', mime: 'image/png', size: 16, kind: 'image' }] });
  const caption = await waitFor<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.nativeId === fileSent.nativeId);
  check(caption.message.body === 'with a caption', 'send with files: the text goes first', caption.message.body);
  const fileEcho = await waitFor<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.conversation === R.notes && !!e.message.attachments?.some((a) => a.name === 'pic.png'));
  const att = fileEcho.message.attachments!.find((a) => a.name === 'pic.png')!;
  check(att.kind === 'image' && att.mime === 'image/png' && att.url.startsWith('mxc://'), 'send with files: the file arrives as m.image with an mxc url', att);
  const back = await command({ t: 'fetchMedia', url: att.url });
  check(Buffer.from(back.base64, 'base64').toString() === 'not really a png', 'send with files: the bytes round-trip through the homeserver');

  const threadSent = await command({ t: 'send', conversation: devThread, body: 'integration test in the thread' });
  const inThread = await waitFor<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.nativeId === threadSent.nativeId);
  check(inThread.message.conversation === devThread, 'send into a thread conversation lands in the thread');
  const firstMsgIdx = events.findIndex((e) => e.t === 'message' && e.message.conversation === devThread);
  const threadFactIdx = events.findIndex((e) => e.t === 'conversation' && e.conversation.nativeId === devThread);
  check(threadFactIdx >= 0 && threadFactIdx < firstMsgIdx, 'thread conversation emitted before its first message', { threadFactIdx, firstMsgIdx });
  await command({ t: 'redact', conversation: devThread, message: threadSent.nativeId });
  const th = await command({ t: 'history', conversation: devThread, limit: 50 });
  check(th.done === true, 'thread history via /relations', th);

  const image = lastMsg(tb.events.image)?.message.attachments?.[0];
  const media = await command({ t: 'fetchMedia', url: image?.url });
  const bytes = Buffer.from(media.base64, 'base64');
  check(media.mime === 'image/png' && bytes.subarray(0, 4).toString('hex') === '89504e47' && bytes.length === image?.size, 'fetchMedia: authenticated download of the image', `${media.mime} ${bytes.length}B`);

  // new DMs: carol has none with quinn in the seed (or one from an earlier run, which must be reused)
  const carol = tb.users.carol.userId;
  const accessToken = JSON.parse(readFileSync(join(dir, 'secret.json'), 'utf8')).accessToken;
  const directData = async (): Promise<Record<string, string[]>> => (await fetch(`${tb.baseUrl}/_matrix/client/v3/user/${enc(tb.users.quinn.userId)}/account_data/m.direct`, { headers: { authorization: `Bearer ${accessToken}` } })).json() as any;
  const directBefore: string[] = (await directData())[carol] ?? [];
  const opened = await command({ t: 'openDirect', peer: carol });
  check(opened.existed === directBefore.length > 0, 'openDirect: creates a room, or finds the one from an earlier run', opened);
  const dmFact = lastConv(opened.conversation);
  check(dmFact?.shape === 'direct' && !!dmFact.participants?.includes(carol), 'openDirect: announced as a direct conversation before the reply', dmFact);
  check((await directData())[carol]?.includes(opened.conversation), 'openDirect: listed in m.direct on the server');
  const again = await command({ t: 'openDirect', peer: carol });
  check(again.existed === true && again.conversation === opened.conversation, 'openDirect again: the same room, nothing new', again);
  check(((await directData())[carol] ?? []).length === Math.max(directBefore.length, 1), 'openDirect again: m.direct did not grow');
  const dmSent = await command({ t: 'send', conversation: opened.conversation, body: `new dm ${Date.now()}` });
  const dmEcho = await waitFor<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.nativeId === dmSent.nativeId);
  check(dmEcho.message.conversation === opened.conversation, 'openDirect: sending works and the echo lands in that conversation');
  check(lastConv(opened.conversation)?.shape === 'direct', 'openDirect: still direct after sync echoed the room');
  const nobody = await command({ t: 'openDirect', peer: `@nobody-${Date.now()}:${tb.serverName}` }).catch((e) => e.message);
  check(typeof nobody === 'string' && nobody.includes('no Matrix user'), 'openDirect: an unknown user is refused', nobody);

  const st = await command({ t: 'action', action: 'status' });
  check(st.userId === tb.users.quinn.userId && st.rooms > 10, 'action status', st);
  const mark = events.length;
  const rs = await command({ t: 'action', action: 'resync' });
  const resent = events.slice(mark).filter((e) => e.t === 'message') as Extract<P.AdapterEvent, { t: 'message' }>[];
  check(rs.ok === true && resent.length > 20 && resent.every((e) => !e.live), 'action resync: full sync re-sent as backfill', `${rs.rooms} rooms, ${resent.length} messages`);

  await runE2ee({ tb, dir, events, check, command, waitFor, restart, logs: () => logLines.join('\n') });
} catch (e) {
  failed = true;
  console.log(`FAIL  ${(e as Error).message}`);
} finally {
  // Log the test device out so the testbed doesn't collect devices.
  try {
    const s = JSON.parse(readFileSync(join(dir, 'secret.json'), 'utf8'));
    if (s.accessToken) await fetch(`${tb.baseUrl}/_matrix/client/v3/logout`, { method: 'POST', headers: { authorization: `Bearer ${s.accessToken}` } });
  } catch {}
  conn.ws?.send(JSON.stringify({ t: 'shutdown' }));
  await Promise.race([proc.exited, Bun.sleep(5000)]);
  proc.kill();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
const bad = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - bad}/${results.length} checks passed${failed ? ' (aborted early)' : ''}`);
process.exit(bad || failed ? 1 : 0);
