/**
 * Each op's own time, carried down to every page request it makes: an op runs inside `withDeadline`, and a page
 * request asks `remainingMs()` how long it may still wait. The manager gives an op the interface's `timeoutMs` (30 s
 * where it names none: packages/manager/src/router.ts); an op that makes several page requests (a write makes up to
 * three) shares that time between them, so the caller hears this account's own sentence, not the manager's timeout.
 *
 * The deadline follows the op's own async path (AsyncLocalStorage), and with it every timer the op starts. So work that
 * outlives the op (the mail watch, the key probe other calls share) starts `outsideOp`, and a queue that runs a job
 * from someone else's callback (GmailMail's) runs it `bindToOp`, under the deadline of the op that queued it.
 */
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { googleCalendar, mail } from '@dither-accounts/interfaces';

/** What the manager allows an op that names no time of its own. */
export const MANAGER_DEFAULT_MS = 30_000;
/** An op's answer is in before the manager's timeout by this much (its sentence on the way back, the manager's own work). */
export const OP_MARGIN_MS = 2_000;

const OPS: Record<string, { timeoutMs?: number }> = { ...googleCalendar.ops, ...mail.ops };

/** The manager's time for an op of this name. */
export function opMs(op: string): number {
  return OPS[op]?.timeoutMs ?? MANAGER_DEFAULT_MS;
}

const store = new AsyncLocalStorage<number>();

/** Run `f` with a deadline `ms` from `now` (the op's own time, less the margin). */
export function withDeadline<T>(ms: number, f: () => T, now = Date.now()): T {
  return store.run(now + ms, f);
}

/** Run `f` under no op's deadline: work that outlives the op that started it. */
export function outsideOp<T>(f: () => T): T {
  return store.exit(f);
}

/** `f`, to run later under the deadline (if any) it was made under, whoever calls it. */
export function bindToOp<F extends (...args: any[]) => any>(f: F): F {
  return AsyncResource.bind(f) as F;
}

/** The deadline `f` runs under, or null outside an op (the mail watch, a probe). */
export function deadline(): number | null {
  return store.getStore() ?? null;
}

/** How long the op may still wait, or `fallback` outside one; never below 0. */
export function remainingMs(fallback: number, now = Date.now()): number {
  const d = deadline();
  return d === null ? fallback : Math.max(0, d - now);
}
