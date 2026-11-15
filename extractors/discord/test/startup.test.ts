import { describe, expect, test } from 'bun:test';
import { StartupGate } from '../src/startup.ts';

describe('StartupGate', () => {
  test('a command in the startup window waits until the client is up, then runs', async () => {
    let t = 1_000;
    const gate = new StartupGate(16_000, () => t);
    let ran = false;
    const waiting = gate.wait().then((ms) => {
      ran = true;
      return ms;
    });
    await Promise.resolve();
    expect(ran).toBe(false);
    t = 7_000;
    gate.open();
    expect(await waiting).toBe(6_000);
    expect(ran).toBe(true);
  });

  test('every waiting command goes on when it opens', async () => {
    const gate = new StartupGate(Date.now() + 60_000);
    const all = Promise.all([gate.wait(), gate.wait(), gate.wait()]);
    gate.open();
    expect((await all).length).toBe(3);
  });

  test('once open, or after the window, a command does not wait', async () => {
    const open = new StartupGate(Date.now() + 60_000);
    open.open();
    expect(await open.wait()).toBe(0);
    let t = 20_000;
    const late = new StartupGate(15_000, () => t);
    expect(late.isOpen).toBe(true);
    expect(await late.wait()).toBe(0);
  });

  test('a client that never comes up lets the command go at the end of the window', async () => {
    const gate = new StartupGate(Date.now() + 30);
    const ms = await gate.wait();
    expect(gate.isOpen).toBe(true);
    expect(ms).toBeGreaterThan(0);
  });
});
