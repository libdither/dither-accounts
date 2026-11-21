/**
 * A stand-in for the hub's link: the extractor's events land in a list, and a test waits for the exact one it wants.
 * Used by the unit tests (against fake-zulip.ts) and by testbed/drive.ts (against a real Zulip in podman).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';

export interface TestLink extends HubLink {
  events: P.AdapterEvent[];
  logs: { level: string; msg: string }[];
  /** Resolves with the first event (from `from` on) that matches; rejects after `ms`. */
  next<T extends P.AdapterEvent = P.AdapterEvent>(match: (e: P.AdapterEvent) => boolean, ms?: number, from?: number): Promise<T>;
  secretValue: Record<string, unknown>;
}

export function testLink(config: Record<string, unknown>, secret: Record<string, unknown>): TestLink {
  const dir = mkdtempSync(join(tmpdir(), 'zulip-test-'));
  const waiters: { match: (e: P.AdapterEvent) => boolean; resolve: (e: P.AdapterEvent) => void }[] = [];
  const link: TestLink = {
    accountId: 'acc_test',
    accountDir: dir,
    config,
    label: 'test',
    connected: true,
    events: [],
    logs: [],
    secretValue: { ...secret },
    emit(ev) {
      link.events.push(ev);
      for (const w of [...waiters]) {
        if (w.match(ev)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(ev);
        }
      }
    },
    log(level, msg) {
      link.logs.push({ level, msg });
      if (process.env.ZULIP_TEST_LOG) console.log(`[${level}] ${msg}`);
    },
    secret<T>() {
      return { ...link.secretValue } as T;
    },
    saveSecret(v) {
      link.secretValue = { ...(v as Record<string, unknown>) };
    },
    close() {},
    next(match, ms = 10_000, from = 0) {
      const seen = link.events.slice(from).find(match);
      if (seen) return Promise.resolve(seen as any);
      return new Promise((resolve, reject) => {
        const w = { match, resolve: resolve as (e: P.AdapterEvent) => void };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`no matching event in ${ms} ms`));
          }
        }, ms);
      });
    },
  };
  return link;
}
