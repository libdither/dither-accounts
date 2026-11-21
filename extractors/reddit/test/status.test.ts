import { describe, expect, test } from 'bun:test';
import { capabilitiesOf, compute, type Facts, OTHER_MS } from '../src/status.ts';

const NOW = 1_800_000_000_000;
function facts(over: Partial<Facts> = {}): Facts {
  return {
    now: NOW,
    sandbox: { started: true, error: null, browserAlive: true, display: 42, startedAt: NOW - 60_000 },
    extensionAttached: true,
    hookTabs: 1,
    tab: 'https://old.reddit.com/',
    page: { state: 'ready', path: '/', user: 'pat_reads', modhash: true, old: true, since: NOW - 30_000 },
    lastCommand: null,
    feed: { items: 0, lastFetch: null, lastError: null, nextAt: null, dropped: null },
    ...over,
  };
}
const page = (p: Partial<NonNullable<Facts['page']>>) => ({ ...facts().page!, ...p });

describe('status', () => {
  test('signed in on old reddit with its modhash: online, reads and writes', () => {
    const c = compute(facts());
    expect(c.status).toBe('online');
    expect(c.attention).toBeNull();
    expect(c.layers.map((l) => [l.name, l.state])).toEqual([
      ['display', 'ok'],
      ['browser', 'ok'],
      ['extension', 'ok'],
      ['signed in', 'ok'],
      ['page', 'ok'],
      ['inbox', 'waiting'],
    ]);
    expect(c.layers.find((l) => l.name === 'signed in')!.note).toBe('as u/pat_reads');
    expect(c.capabilities).toEqual(['liveView', 'home', 'posts', 'profile', 'postActions', 'publish', 'unpublish']);
  });
  test('signed out: "Sign in to Reddit in the live view", with the live view; only the live view offered', () => {
    const c = compute(facts({ page: page({ state: 'login', user: null, modhash: false, path: '/login/' }) }));
    expect(c.status).toBe('attention');
    expect(c.attention).toEqual({ kind: 'login', message: 'Sign in to Reddit in the live view', liveView: true });
    expect(c.capabilities).toEqual(['liveView']);
  });
  test("Reddit's checks are yours", () => {
    expect(compute(facts({ page: page({ state: 'verify', user: null }) })).attention).toMatchObject({ kind: 'verify', liveView: true });
  });
  test('another page: a while to go back by itself, then it asks', () => {
    expect(compute(facts({ page: page({ state: 'other', old: false, user: null, since: NOW - 5000 }) })).status).toBe('connecting');
    const c = compute(facts({ page: page({ state: 'other', old: false, user: null, since: NOW - OTHER_MS - 1 }) }));
    expect(c.attention).toMatchObject({ kind: 'unknown', message: 'Reddit is open on another page; go to old.reddit.com in the live view' });
  });
  test('no modhash: online for reading, no writes, and the page layer says why', () => {
    const c = compute(facts({ page: page({ modhash: false }) }));
    expect(c.status).toBe('online');
    expect(c.layers.find((l) => l.name === 'page')!.state).toBe('failed');
    expect(capabilitiesOf(page({ modhash: false }))).toEqual(['liveView', 'home', 'posts', 'profile']);
  });
  test('the inbox layer: failed with its error, ok with counts and the time', () => {
    expect(compute(facts({ feed: { items: 0, lastFetch: null, lastError: 'Reddit answered 500', nextAt: null, dropped: null } })).layers.at(-1)).toEqual({ name: 'inbox', state: 'failed', note: 'last read failed: Reddit answered 500' });
    expect(compute(facts({ feed: { items: 4, lastFetch: Date.UTC(2027, 0, 1, 12, 30, 5), lastError: null, nextAt: null, dropped: null } })).layers.at(-1)!.note).toBe('4 items; read 12:30:05');
  });
  test('the sandbox failing, or the extension not attaching', () => {
    expect(compute(facts({ sandbox: { started: false, error: 'Xvfb did not start', browserAlive: false, display: null, startedAt: 0 } })).status).toBe('error');
    expect(compute(facts({ extensionAttached: false, page: null })).attention).toMatchObject({ kind: 'unknown' });
  });
});
