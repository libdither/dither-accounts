import { expect, test } from 'bun:test';
import { FakeRpcError } from '../src/backend.ts';
import { type Clock, FloodError, laneOf, Pacer, SPACING } from '../src/pacer.ts';

/**
 * The pacer's time, for a test: a wait ends at once, the clock moved on to when it would have ended, so what a test
 * checks (when each call started, that a call did not wait) is exact however slow the machine is. Sleeps end in the
 * order of their ends, each once everything the last one set off has run (setImmediate: after the microtasks), so a
 * call that would start in between asks for its own sleep first.
 */
class FakeClock implements Clock {
  t = 1_700_000_000_000;
  /** Each sleep asked for, in ms. */
  readonly sleeps: number[] = [];
  private timers: { at: number; resolve: () => void }[] = [];
  private ticking = false;
  now = () => this.t;
  sleep = (ms: number) => {
    this.sleeps.push(ms);
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + ms, resolve });
      this.tick();
    });
  };
  private tick() {
    if (this.ticking) return;
    this.ticking = true;
    setImmediate(() => {
      this.ticking = false;
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers.shift();
      if (!next) return;
      this.t = Math.max(this.t, next.at);
      next.resolve();
      if (this.timers.length) this.tick();
    });
  }
}

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
  const clock = new FakeClock();
  const p = new Pacer({ spacing: { join: 150, light: 0 }, clock });
  const at: number[] = [];
  const t0 = clock.now();
  await Promise.all(['messages.importChatInvite', 'channels.joinChannel', 'contacts.addContact'].map((m) => p.run(m, async () => void at.push(clock.now() - t0))));
  expect(at).toEqual([0, 150, 300]);
  const t1 = clock.now();
  const n = clock.sleeps.length;
  await p.run('contacts.resolveUsername', async () => void at.push(clock.now() - t1));
  expect(at[3]).toBe(0);
  expect(clock.sleeps.length).toBe(n);
});

test('once (an act): a flood wait is never retried, however short, and a held method fails without being called', async () => {
  const clock = new FakeClock();
  const p = new Pacer({ spacing: { join: 0 }, clock });
  let n = 0;
  const e = await p.run('messages.importChatInvite', async () => {
    n++;
    throw new FakeRpcError(420, 'FLOOD_WAIT_2');
  }, { once: true }).catch((x) => x);
  expect(e).toBeInstanceOf(FloodError);
  expect(e.seconds).toBe(2);
  expect(n).toBe(1);
  expect(clock.sleeps).toEqual([]);
  const again = await p.run('messages.importChatInvite', async () => void n++, { once: true }).catch((x) => x);
  expect(again).toBeInstanceOf(FloodError);
  expect(again.seconds).toBe(2);
  expect(n).toBe(1);
  // It failed at once: no wait for the hold, nor for a turn in the lane.
  expect(clock.sleeps).toEqual([]);
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
  const clock = new FakeClock();
  const p = new Pacer({ spacing: { history: 60, light: 0 }, clock });
  const starts: [number, number][] = [];
  const t0 = clock.now();
  await Promise.all([1, 2, 3, 4].map((i) => p.run('messages.getHistory', async () => void starts.push([i, clock.now() - t0]))));
  expect(starts).toEqual([
    [1, 0],
    [2, 60],
    [3, 120],
    [4, 180],
  ]);
  // Other lanes do not wait for it, even while it is busy.
  const busy = p.run('messages.getHistory', async () => {});
  const t1 = clock.now();
  let other = -1;
  await p.run('users.getUsers', async () => void (other = clock.now() - t1));
  expect(other).toBe(0);
  await busy;
});

test('sends into one chat are a second apart (here 80 ms), other chats are not held', async () => {
  const clock = new FakeClock();
  const p = new Pacer({ spacing: { send: 0 }, perChatSendMs: 80, clock });
  const at: Record<string, number[]> = { a: [], b: [] };
  const t0 = clock.now();
  await Promise.all(['a', 'a', 'b', 'a'].map((chat) => p.run('messages.sendMessage', async () => void at[chat].push(clock.now() - t0), { chat })));
  expect(at).toEqual({ a: [0, 80, 160], b: [0] });
});

test('FLOOD_WAIT: background work waits it out and retries; the method stays held meanwhile', async () => {
  const floods: [string, number][] = [];
  const clock = new FakeClock();
  let heldWhileWaiting: Record<string, number> | null = null;
  // onFlood comes once the wait is set, before the retry: Telegram holds the method meanwhile.
  const p: Pacer = new Pacer({ spacing: { history: 0 }, onFlood: (m, s) => (floods.push([m, s]), (heldWhileWaiting = p.held())), clock });
  let n = 0;
  const t0 = clock.now();
  const r = await p.run(
    'messages.getHistory',
    async () => {
      if (n++ === 0) throw new FakeRpcError(420, 'FLOOD_WAIT_1');
      return 'ok';
    },
    { background: true },
  );
  expect(r).toBe('ok');
  expect(n).toBe(2);
  // Waited out exactly the second Telegram asked for, then tried again.
  expect(clock.sleeps).toEqual([1000]);
  expect(clock.now() - t0).toBe(1000);
  expect(heldWhileWaiting!).toEqual({ 'messages.getHistory': 1 });
  expect(floods).toEqual([['messages.getHistory', 1]]);
  expect(p.floods[0]).toMatchObject({ method: 'messages.getHistory', seconds: 1 });
});

test('FLOOD_WAIT longer than a command may wait: it fails in words, and later calls fail fast', async () => {
  const clock = new FakeClock();
  const p = new Pacer({ spacing: { send: 0 }, maxForegroundWaitMs: 500, clock });
  const e = await p.run('messages.sendMessage', async () => {
    throw new FakeRpcError(420, 'FLOOD_WAIT_30');
  }).catch((x) => x);
  expect(e).toBeInstanceOf(FloodError);
  expect(e.message).toBe('Telegram asks this account to wait 30 s before more messages.sendMessage');
  expect(p.held()).toEqual({ 'messages.sendMessage': 30 });
  let called = false;
  const again = await p.run('messages.sendMessage', async () => void (called = true)).catch((x) => x);
  expect(again).toBeInstanceOf(FloodError);
  expect(again.seconds).toBe(30);
  expect(called).toBe(false);
  // Failed fast: it never waited, neither for the hold nor for its turn.
  expect(clock.sleeps).toEqual([]);
});

test('other errors pass through untouched', async () => {
  const p = new Pacer();
  const e = await p.run('users.getUsers', async () => {
    throw new FakeRpcError(400, 'PEER_ID_INVALID');
  }).catch((x) => x);
  expect(e.text).toBe('PEER_ID_INVALID');
});
