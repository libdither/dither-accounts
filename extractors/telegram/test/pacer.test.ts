import { expect, test } from 'bun:test';
import { FakeRpcError } from '../src/backend.ts';
import { FloodError, laneOf, Pacer, SPACING } from '../src/pacer.ts';

test('methods fall into lanes', () => {
  expect(laneOf('messages.getDialogs')).toBe('dialogs');
  expect(laneOf('messages.getHistory')).toBe('history');
  expect(laneOf('messages.sendMessage')).toBe('send');
  expect(laneOf('channels.deleteMessages')).toBe('send');
  expect(laneOf('channels.readHistory')).toBe('read');
  expect(laneOf('upload.getFile')).toBe('media');
  expect(laneOf('users.getUsers')).toBe('light');
  // Joining and adding contacts are flood-limited hard: their own slow lane. Looking up is the normal one.
  for (const m of ['messages.importChatInvite', 'channels.joinChannel', 'contacts.addContact']) expect(laneOf(m)).toBe('join');
  // So are removing a contact and unblocking; the lists of contacts and blocks are read as the chat lists are.
  for (const m of ['contacts.deleteContacts', 'contacts.unblock']) expect(laneOf(m)).toBe('join');
  // And adding people to groups, and making one.
  for (const m of ['messages.addChatUser', 'channels.inviteToChannel', 'messages.createChat']) expect(laneOf(m)).toBe('join');
  for (const m of ['contacts.getContacts', 'contacts.getBlocked']) expect(laneOf(m)).toBe('dialogs');
  for (const m of ['messages.checkChatInvite', 'contacts.resolveUsername', 'contacts.resolvePhone']) expect(laneOf(m)).toBe('light');
  expect(laneOf('messages.getChatInviteImporters')).toBe('history');
  expect(laneOf('messages.hideChatJoinRequest')).toBe('send');
  expect(SPACING.join).toBeGreaterThanOrEqual(2000);
});

test('the join lane: joins start its spacing apart (here 150 ms), lookups are not held by it', async () => {
  const p = new Pacer({ spacing: { join: 150, light: 0 } });
  const at: number[] = [];
  const t0 = Date.now();
  await Promise.all(['messages.importChatInvite', 'channels.joinChannel', 'contacts.addContact'].map((m) => p.run(m, async () => void at.push(Date.now() - t0))));
  expect(at[1] - at[0]).toBeGreaterThanOrEqual(140);
  expect(at[2] - at[1]).toBeGreaterThanOrEqual(140);
  const t1 = Date.now();
  await p.run('contacts.resolveUsername', async () => {});
  expect(Date.now() - t1).toBeLessThan(60);
});

test('once (an act): a flood wait is never retried, however short, and a held method fails without being called', async () => {
  const p = new Pacer({ spacing: { join: 0 } });
  let n = 0;
  const e = await p.run('messages.importChatInvite', async () => {
    n++;
    throw new FakeRpcError(420, 'FLOOD_WAIT_2');
  }, { once: true }).catch((x) => x);
  expect(e).toBeInstanceOf(FloodError);
  expect(e.seconds).toBe(2);
  expect(n).toBe(1);
  const t0 = Date.now();
  const again = await p.run('messages.importChatInvite', async () => void n++, { once: true }).catch((x) => x);
  expect(again).toBeInstanceOf(FloodError);
  expect(n).toBe(1);
  expect(Date.now() - t0).toBeLessThan(50);
});

test('maxWaitMs: a command waits out only a short hold', async () => {
  const p = new Pacer({ spacing: { light: 0 } });
  const e = await p.run('contacts.resolveUsername', async () => {
    throw new FakeRpcError(420, 'FLOOD_WAIT_20');
  }, { maxWaitMs: 5000 }).catch((x) => x);
  expect(e).toBeInstanceOf(FloodError);
  expect(e.seconds).toBe(20);
});

test('calls in a lane start at least its spacing apart, in order', async () => {
  const p = new Pacer({ spacing: { history: 60 } });
  const starts: number[] = [];
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4].map(() => p.run('messages.getHistory', async () => void starts.push(Date.now() - t0))));
  for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(55);
  // Other lanes do not wait for it
  const t1 = Date.now();
  await p.run('users.getUsers', async () => {});
  expect(Date.now() - t1).toBeLessThan(40);
});

test('sends into one chat are a second apart (here 80 ms), other chats are not held', async () => {
  const p = new Pacer({ spacing: { send: 0 }, perChatSendMs: 80 });
  const at: Record<string, number[]> = { a: [], b: [] };
  const t0 = Date.now();
  await Promise.all(['a', 'a', 'b', 'a'].map((chat) => p.run('messages.sendMessage', async () => void at[chat].push(Date.now() - t0), { chat })));
  expect(at.a[1] - at.a[0]).toBeGreaterThanOrEqual(75);
  expect(at.a[2] - at.a[1]).toBeGreaterThanOrEqual(75);
  expect(at.b[0]).toBeLessThan(40);
});

test('FLOOD_WAIT: background work waits it out and retries; the method stays held meanwhile', async () => {
  const floods: [string, number][] = [];
  const p = new Pacer({ spacing: { history: 0 }, onFlood: (m, s) => floods.push([m, s]) });
  let n = 0;
  const t0 = Date.now();
  const r = await p.run(
    'messages.getHistory',
    async () => {
      if (n++ === 0) throw new FakeRpcError(420, 'FLOOD_WAIT_1');
      return 'ok';
    },
    { background: true },
  );
  expect(r).toBe('ok');
  expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  expect(floods).toEqual([['messages.getHistory', 1]]);
  expect(p.floods[0]).toMatchObject({ method: 'messages.getHistory', seconds: 1 });
});

test('FLOOD_WAIT longer than a command may wait: it fails in words, and later calls fail fast', async () => {
  const p = new Pacer({ spacing: { send: 0 }, maxForegroundWaitMs: 500 });
  const e = await p.run('messages.sendMessage', async () => {
    throw new FakeRpcError(420, 'FLOOD_WAIT_30');
  }).catch((x) => x);
  expect(e).toBeInstanceOf(FloodError);
  expect(e.message).toBe('Telegram asks this account to wait 30 s before more messages.sendMessage');
  expect(p.held()['messages.sendMessage']).toBeGreaterThan(25);
  let called = false;
  const t0 = Date.now();
  const again = await p.run('messages.sendMessage', async () => void (called = true)).catch((x) => x);
  expect(again).toBeInstanceOf(FloodError);
  expect(called).toBe(false);
  expect(Date.now() - t0).toBeLessThan(100);
});

test('other errors pass through untouched', async () => {
  const p = new Pacer();
  const e = await p.run('users.getUsers', async () => {
    throw new FakeRpcError(400, 'PEER_ID_INVALID');
  }).catch((x) => x);
  expect(e.text).toBe('PEER_ID_INVALID');
});
