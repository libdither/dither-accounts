/**
 * The real backend, offline: mtcute builds on this storage (its state in telegram.sqlite, the auth key only in memory),
 * and the session string it exports is the one it was given. Nothing connects anywhere.
 */
import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MtcuteBackend, updatesIn } from '../src/mtcute.ts';
import { clientProfile, ownProfile, TELEGRAM_DESKTOP } from '../src/profile.ts';

const dir = mkdtempSync(join(tmpdir(), 'dacc-tgmt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('the session string goes in and out whole; telegram.sqlite never holds the auth key', async () => {
  const b = new MtcuteBackend({ apiId: 1, apiHash: '0'.repeat(32), dir, testMode: true, initConnection: ownProfile('test'), log: () => {} });
  const client = (b as unknown as { client: { importSession(s: unknown, f?: boolean): Promise<void> } }).client;
  const authKey = new Uint8Array(256).map((_, i) => (i * 37 + 11) & 0xff);
  const dc = { id: 2, ipAddress: '127.0.0.1', port: 1, testMode: true };
  await client.importSession({ primaryDcs: { main: dc, media: dc }, authKey, self: { userId: 4242, isBot: false, isPremium: false, usernames: [] } }, true);
  const session = await b.exportSession();
  expect(typeof session).toBe('string');
  expect(session.length).toBeGreaterThan(300);
  await b.close();
  // Telegram's view of the key would be these 256 bytes; the database has none of them.
  for (const f of ['telegram.sqlite', 'telegram.sqlite-wal']) {
    if (existsSync(join(dir, f))) expect(readFileSync(join(dir, f)).includes(Buffer.from(authKey.subarray(0, 32)))).toBe(false);
  }
  const db = new Database(join(dir, 'telegram.sqlite'), { readonly: true });
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  for (const t of tables.filter((n) => /auth/i.test(n))) expect((db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
  db.close();
  // A second client on the same directory starts from the string alone, and exports the same.
  const again = new MtcuteBackend({ apiId: 1, apiHash: '0'.repeat(32), dir, testMode: true, initConnection: ownProfile('test'), log: () => {} });
  await (again as unknown as { client: { importSession(s: string, f?: boolean): Promise<void> } }).client.importSession(session, true);
  expect(await again.exportSession()).toBe(session);
  expect(again.info()).toMatchObject({ library: 'mtcute 0.32', layer: 232, testMode: true });
  await again.close();
});

// Read from mtcute 0.32.7 (highlevel/methods/chats/create-group.js, add-chat-members.js): on layer 232
// messages.createChat, messages.addChatUser and channels.inviteToChannel answer messages.invitedUsers, and mtcute
// feeds its `updates` to handleClientUpdate. The backend fed only bare updates and join results.
test("the updates inside an answer are mtcute's to count: bare, a join's, and messages.invitedUsers'", () => {
  const updates = { _: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0 };
  expect(updatesIn(updates)).toBe(updates as never);
  expect(updatesIn({ _: 'messages.chatInviteJoinResultOk', updates })).toBe(updates as never);
  expect(updatesIn({ _: 'messages.invitedUsers', updates, missingInvitees: [] })).toBe(updates as never);
  expect(updatesIn({ _: 'messages.invitedUsers', updates: { _: 'updateShortSentMessage' }, missingInvitees: [] })).toBeNull();
  expect(updatesIn({ _: 'updateShortSentMessage', pts: 1, ptsCount: 1 })).toBeNull();
  expect(updatesIn(true)).toBeNull();
});

/** The initConnection mtcute will wrap the first call in: its defaults, then ours over them. */
function initSent(b: MtcuteBackend): Record<string, unknown> {
  return (b as unknown as { client: { _client: { mt: { network: { _initConnectionParams: Record<string, unknown> } } } } }).client._client.mt.network._initConnectionParams;
}

test("on Telegram Desktop's api_id, every initConnection field is Telegram Desktop's; on your own app, nothing says mtcute", async () => {
  const desk = new MtcuteBackend({ ...TELEGRAM_DESKTOP, dir: mkdtempSync(join(tmpdir(), 'dacc-tgmt-')), testMode: true, initConnection: clientProfile(TELEGRAM_DESKTOP.apiId, { deviceName: 'my laptop' }), log: () => {} });
  const sent = initSent(desk);
  expect(sent).toMatchObject({ _: 'initConnection', apiId: 611335, deviceModel: 'Desktop', langPack: 'tdesktop', systemLangCode: 'en-US', langCode: 'en' });
  expect(String(sent.systemVersion)).toMatch(/^Linux X11( glibc \d+\.\d+)?$/);
  expect(Object.keys(sent).sort()).toEqual(['_', 'apiId', 'appVersion', 'deviceModel', 'langCode', 'langPack', 'params', 'query', 'systemLangCode', 'systemVersion']);
  expect(JSON.stringify(sent)).not.toMatch(/dither|mtcute|my laptop|0\.32/);
  await desk.close();

  const own = new MtcuteBackend({ apiId: 1234567, apiHash: '0'.repeat(32), dir: mkdtempSync(join(tmpdir(), 'dacc-tgmt-')), testMode: true, initConnection: clientProfile(1234567, { deviceName: 'my laptop' }), log: () => {} });
  expect(initSent(own)).toMatchObject({ apiId: 1234567, deviceModel: 'my laptop', appVersion: '0.1.0', systemVersion: 'Linux', langPack: '' });
  expect(JSON.stringify(initSent(own))).not.toMatch(/mtcute|0\.32/);
  await own.close();
});
