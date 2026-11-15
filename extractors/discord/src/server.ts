/**
 * The adapter's own little WebSocket server: packages/browser's BridgeServer (loopback, token-gated; it correlates
 * request and reply ids and says how far a timed-out request got), typed with Discord's frames. This file also
 * carries a human-pacing queue so outgoing Discord actions are spaced out.
 */

import { BridgeServer as SharedBridge } from '@dither-accounts/browser';
import type { BridgeUp, HookCommand } from './discord-types.ts';
import { phase } from './trace.ts';

export class BridgeServer extends SharedBridge<BridgeUp, HookCommand> {}

/**
 * Serializes outgoing Discord actions with a human-ish gap + jitter, so a burst of
 * hub commands never fires faster than a person could. Sends and history share the
 * queue; history additionally backs off hard on a 429.
 */
export class PaceQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  private penaltyUntil = 0;

  constructor(private opts: { minGapMs: number; jitterMs: number; log: (m: string, d?: unknown) => void }) {}

  run<T>(label: string, fn: () => Promise<T>, extraDelayMs = 0): Promise<T> {
    const queued = Date.now();
    const task = this.chain.then(async () => {
      const now = Date.now();
      const base = this.opts.minGapMs + Math.random() * this.opts.jitterMs + extraDelayMs;
      const waitForGap = Math.max(0, this.last + base - now);
      const waitForPenalty = Math.max(0, this.penaltyUntil - now);
      const wait = Math.max(waitForGap, waitForPenalty);
      if (wait > 0) await Bun.sleep(wait);
      // On the command's span, if it has one (trace.ts): how long it waited its turn.
      phase('paced', { label, waitMs: Math.round(Date.now() - queued) });
      this.last = Date.now();
      try {
        return await fn();
      } catch (e: any) {
        // Discord REST surfaces 429s with retry_after (seconds).
        const retry = e?.retry_after ?? e?.body?.retry_after ?? e?.retryAfter;
        if (retry) {
          this.penaltyUntil = Date.now() + Number(retry) * 1000 + 500;
          this.opts.log(`429 on ${label}; backing off`, { retryAfterMs: Number(retry) * 1000 });
        }
        throw e;
      }
    });
    // keep the chain from rejecting and stalling later tasks
    this.chain = task.catch(() => undefined);
    return task as Promise<T>;
  }
}
