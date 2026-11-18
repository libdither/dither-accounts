/**
 * The google kind's page transport without a browser: each op's time carried down to its page requests
 * (extractors/google/src/deadline.ts), waiting for a page to be ready instead of refusing at start (ready.ts), and
 * when a silent page's tab is reloaded (reload.ts). Fake clocks only: no waits. The browser side is in
 * google-browser.test.ts.
 */
import { afterEach, expect, jest, test } from 'bun:test';
import { googleCalendar, mail } from '@dither-accounts/interfaces';
import { bindToOp, deadline, MANAGER_DEFAULT_MS, opMs, outsideOp, remainingMs, withDeadline } from '../extractors/google/src/deadline.ts';
import { Readiness } from '../extractors/google/src/ready.ts';
import { LOADING_DEFERS, RELOAD_FIRST_GAP_MS, RELOAD_MAX_GAP_MS, ReloadPolicy } from '../extractors/google/src/reload.ts';

afterEach(() => {
  jest.useRealTimers();
});

test("an op's time is the interface's, or the manager's 30 s; writes and mailboxes name their own", () => {
  expect(opMs('mail.get')).toBe(60_000);
  expect(opMs('mail.send')).toBe(120_000);
  // A write makes up to three page requests (25 s each at most): more than the manager's default.
  for (const op of ['mail.flag', 'mail.move', 'mail.trash']) expect(opMs(op)).toBe(90_000);
  expect(opMs('mail.mailboxes')).toBe(60_000);
  expect(opMs('calendar.events.list')).toBe(120_000);
  expect(opMs('calendar.events.insert')).toBe(MANAGER_DEFAULT_MS);
  expect(opMs('no.such.op')).toBe(MANAGER_DEFAULT_MS);
  // Every op the kind answers is one of its interfaces'.
  expect(Object.keys(mail.ops)).toContain('mail.contacts');
  expect(Object.keys(googleCalendar.ops)).toContain('calendar.events.patch');
});

test('a page request inside an op gets what is left of its time, across awaits; outside one, its own', async () => {
  expect(deadline()).toBeNull();
  expect(remainingMs(25_000)).toBe(25_000);
  const seen: number[] = [];
  await withDeadline(
    28_000,
    async () => {
      seen.push(remainingMs(25_000, 1_000_000));
      await Promise.resolve();
      seen.push(remainingMs(25_000, 1_020_000));
      seen.push(remainingMs(25_000, 1_030_000));
    },
    1_000_000,
  );
  expect(seen).toEqual([28_000, 8_000, 0]);
  expect(deadline()).toBeNull();
});

test("work that outlives an op is under no deadline; a queued job runs under its own op's, whoever starts it", async () => {
  jest.useFakeTimers();
  const queue: (() => void)[] = [];
  const seen: Record<string, number | null> = {};
  withDeadline(1_000, () => {
    // A timer the op starts keeps its deadline; one started outside it does not.
    setTimeout(() => (seen.timer = deadline()), 10);
    outsideOp(() => setTimeout(() => (seen.watch = deadline()), 10));
    queue.push(bindToOp(() => (seen.a = deadline())));
  }, 0);
  withDeadline(2_000, () => {
    queue.push(bindToOp(() => (seen.b = deadline())));
    // Op B's callback runs the queue: each job still under its own op's deadline.
    setTimeout(() => {
      for (const job of queue) job();
    }, 20);
  }, 0);
  jest.advanceTimersByTime(20);
  expect(seen).toEqual({ timer: 1_000, watch: null, a: 1_000, b: 2_000 });
});

test('waiting for readiness: answers as soon as a change makes it ready, with no polling', async () => {
  jest.useFakeTimers();
  const r = new Readiness();
  let why: string | null = 'not open yet';
  const waiting = r.until(() => why, 10_000);
  expect(r.size).toBe(1);
  r.changed(); // something else changed: still not ready, still waiting
  expect(r.size).toBe(1);
  why = null;
  r.changed();
  expect(await waiting).toBeNull();
  expect(r.size).toBe(0);
});

test('waiting for readiness: the last reason once the time is up; a final one, and no time, at once', async () => {
  jest.useFakeTimers();
  const r = new Readiness();
  let why: { status: number; text: string } | null = { status: 503, text: 'not open yet' };
  const final = (e: { status: number }) => e.status !== 503;
  const waiting = r.until(() => why, 10_000, final);
  why = { status: 503, text: 'not synced yet' };
  jest.advanceTimersByTime(10_000);
  expect(await waiting).toEqual({ status: 503, text: 'not synced yet' });
  expect(r.size).toBe(0);

  // Signed out: waiting will not change it.
  const signedOut = r.until(() => ({ status: 401, text: 'signed out' }), 10_000, final);
  expect(r.size).toBe(0);
  expect(await signedOut).toEqual({ status: 401, text: 'signed out' });
  // One that turns final while waiting answers then.
  const turns = r.until(() => why, 10_000, final);
  why = { status: 401, text: 'signed out' };
  r.changed();
  expect(await turns).toEqual({ status: 401, text: 'signed out' });
  // No time left in the op: no wait.
  why = { status: 503, text: 'not open yet' };
  const none = r.until(() => why, 0, final);
  expect(r.size).toBe(0);
  expect(await none).toEqual({ status: 503, text: 'not open yet' });
});

test('reloads back off while they bring no answer, up to a cap between them; an answer starts it over', () => {
  const p = new ReloadPolicy();
  let now = 1_000_000;
  expect(p.decide(now, false)).toEqual({ go: true });
  p.reloaded(now);
  // The next silence 30 s later (as seen live: every 30 s or so) does not reload again.
  now += 30_000;
  const held = p.decide(now, false);
  expect(held.go).toBe(false);
  expect(!held.go && held.why).toMatch(/^backing off after 1 reload that brought no answer, until \d\d:\d\d:\d\d UTC$/);
  now += RELOAD_FIRST_GAP_MS - 30_000;
  expect(p.decide(now, false)).toEqual({ go: true });
  const gaps: number[] = [];
  for (let i = 1; i <= 8; i++) {
    p.reloaded(now);
    gaps.push(p.nextAt - now);
    now = p.nextAt;
  }
  expect(gaps).toEqual([2, 4, 8, 16, 30, 30, 30, 30].map((m) => m * 60_000));
  expect(RELOAD_MAX_GAP_MS).toBe(30 * 60_000);
  p.answered();
  expect(p.decide(now + 1, false)).toEqual({ go: true });
});

test('a tab still loading is not reloaded, unless it stays loading through LOADING_DEFERS silences', () => {
  const p = new ReloadPolicy();
  const now = 1_000_000;
  for (let i = 0; i < LOADING_DEFERS; i++) expect(p.decide(now, true)).toEqual({ go: false, why: 'its tab is still loading' });
  expect(p.decide(now, true)).toEqual({ go: true });
  // Loaded in between: the count starts over.
  const q = new ReloadPolicy();
  q.decide(now, true);
  q.decide(now, false);
  for (let i = 0; i < LOADING_DEFERS; i++) expect(q.decide(now, true).go).toBe(false);
  // Not known (the worker did not say): as if not loading.
  expect(new ReloadPolicy().decide(now, null)).toEqual({ go: true });
});

test('in tests the first gap can be 0: the next reload comes at once', () => {
  const p = new ReloadPolicy(0);
  p.reloaded(5);
  expect(p.decide(5, false)).toEqual({ go: true });
});
