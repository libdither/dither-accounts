import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2ee } from '../src/e2ee.ts';
import type { MatrixClient } from '../src/http.ts';
import { Backoff, Outbox } from '../src/retry.ts';

const networkError = () => new TypeError('The socket connection was closed unexpectedly');

describe('Backoff', () => {
  test('delays grow, stop growing at the last step, and start over after a success', () => {
    const b = new Backoff([10, 20, 40]);
    expect([b.fail(), b.fail(), b.fail(), b.fail()]).toEqual([10, 20, 40, 40]);
    expect(b.failures).toBe(4);
    b.reset();
    expect(b.fail()).toBe(10);
  });

  test('wake ends a sleep early', async () => {
    const b = new Backoff();
    const t0 = Date.now();
    const slept = b.sleep(10_000);
    setTimeout(() => b.wake(), 20);
    await slept;
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('Outbox', () => {
  /** A connection that fails the first `down` sends. */
  const flaky = (down: number) => {
    const sent: string[] = [];
    let calls = 0;
    return {
      sent,
      calls: () => calls,
      send: async (v: string) => {
        calls++;
        if (calls <= down) throw networkError();
        sent.push(v);
      },
    };
  };

  test('a message that fails is retried until it goes out, and later ones wait behind it, in order', async () => {
    const net = flaky(3);
    const box = new Outbox<string>({ send: net.send, wanted: () => true, backoff: new Backoff([5]) });
    const first = box.push('accept', 'flow');
    const second = box.push('mac', 'flow');
    expect(await first).toBe(false); // its first try failed; it is still queued
    await box.idle();
    expect(net.sent).toEqual(['accept', 'mac']);
    expect(net.calls()).toBe(5);
    expect(await second).toBe(true);
    expect(box.pending()).toBe(0);
  });

  test('a message of a flow that is over is dropped, but a cancel still goes out', async () => {
    const net = flaky(2);
    const over = new Set<string>();
    const box = new Outbox<string>({ send: net.send, wanted: ({ key, cancel }) => cancel || !over.has(key), backoff: new Backoff([5]) });
    void box.push('start', 'old');
    void box.push('cancel', 'old', true);
    over.add('old');
    await box.idle();
    expect(net.sent).toEqual(['cancel']);
  });

  test('pending counts per flow, and the change hook fires when a send fails', async () => {
    let changes = 0;
    const box = new Outbox<string>({ send: flaky(1).send, wanted: () => true, backoff: new Backoff([30_000]), onChange: () => changes++ });
    void box.push('a', 'f1');
    void box.push('b', 'f2');
    await Bun.sleep(10);
    expect(box.pending('f1')).toBe(1);
    expect(box.pending('f2')).toBe(1);
    expect(changes).toBeGreaterThan(0);
    // The connection is back: no need to wait out 30 s.
    box.wake();
    await box.idle();
    expect(box.pending()).toBe(0);
  });

  test('stop ends the retries', async () => {
    const box = new Outbox<string>({ send: async () => Promise.reject(networkError()), wanted: () => true, backoff: new Backoff([30_000]) });
    void box.push('a', 'f');
    await Bun.sleep(10);
    box.stop();
    await box.idle();
    expect(box.pending()).toBe(1);
  });
});

describe('E2ee crypto requests', () => {
  test('a key upload that fails on the network is retried without waiting for a sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dither-e2ee-retry-'));
    let down = 3;
    const seen: string[] = [];
    const logs: string[] = [];
    // Just enough of a homeserver for a new device's first requests.
    const client = {
      request: async (method: string, path: string) => {
        seen.push(`${method} ${path}`);
        if (down > 0) {
          down--;
          throw networkError();
        }
        if (path.endsWith('/keys/upload')) return { one_time_key_counts: { signed_curve25519: 50 } };
        if (path.endsWith('/keys/query')) return { device_keys: {}, failures: {} };
        return {};
      },
    } as unknown as MatrixClient;
    const e2ee = await E2ee.open({
      dir,
      userId: '@retry:test.invalid',
      deviceId: 'RETRYDEV',
      storeKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
      client: () => client,
      log: (level, msg) => logs.push(`[${level}] ${msg}`),
      onRoomKeys: () => {},
      onVerification: () => {},
      retryMs: [20],
    });
    try {
      await expect(e2ee.flush()).rejects.toThrow();
      // No sync arrives; the retry timer alone has to get the keys out.
      for (let i = 0; i < 100 && (down > 0 || !seen.some((s) => s.endsWith('/keys/upload'))); i++) await Bun.sleep(20);
      for (let i = 0; i < 100 && (await e2ee.status()).lastError; i++) await Bun.sleep(20);
      const st = await e2ee.status();
      expect(st.lastError).toBeNull();
      expect(seen.filter((s) => s.endsWith('/keys/upload')).length).toBeGreaterThanOrEqual(2);
      expect(logs.some((l) => l.startsWith('[warn] crypto requests failed'))).toBe(true);
      expect(logs.some((l) => l.includes('went through after'))).toBe(true);
    } finally {
      e2ee.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
