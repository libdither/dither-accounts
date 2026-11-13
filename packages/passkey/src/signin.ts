/**
 * Signing in by itself with the passkey (the privacy and schwab kinds): a few tries with backoff, and what a paired
 * phone's refusal does to them (docs/approver.md, "What a refusal does"). One place, so both kinds behave the same and
 * the rules are tested without a browser (test/approver-signin.test.ts).
 *
 * - Each try is the kind's own (load the site, click its passkey option); `backoff` is the wait before each, so three
 *   tries by default. Something only you can give (a code, a captcha) is a hold: the kind keeps it and stops.
 * - A refusal from the approver (ApproverRefusal, which the kind hands to `note` from its passkey handler) ends the
 *   sign-in at once: no more tries, and the kind's click loop stops clicking (`stopped`). The refusal then stands (the
 *   kind keeps it in its state.json, so a restart does not ask again) until the account is seen signed in:
 *     - denied (you said no), refused (the phone's own checks failed), unknown-credential (it no longer holds the key):
 *       no automatic sign-in at all; only a pull you start (statements.refresh, trigger `refresh`) asks once more.
 *     - expired (nobody answered), no-device (the phone is not paired here), error (something failed on the way): the
 *       next scheduled pull (`daily`, `catch-up`) asks once more, so at most one prompt per scheduled pull; the other
 *       automatic sign-ins (at start, the runner's retries, Schwab's pull after you sign in) wait for it.
 * - Passkeys kept on this machine never meet any of this: their tries go on as before.
 */
import { ApproverRefusal } from './authenticator.ts';
import type { Refusal } from './approver.ts';

/** What asks for a sign-in: a pull (statements-common's Why) or the kind's start. */
export type Trigger = 'start' | 'daily' | 'catch-up' | 'retry' | 'refresh' | 'sign-in';

/** Refusals that stand until you do something: only a pull you start asks again. */
const UNTIL_YOU: readonly Refusal[] = ['denied', 'refused', 'unknown-credential'];
const SCHEDULED: readonly Trigger[] = ['daily', 'catch-up'];

/** A refusal from the approver that stops automatic sign-ins (kept in the kind's state.json; no secrets). */
export interface StandingRefusal {
  reason: Refusal;
  /** The device's name as paired (or its id). */
  device: string;
  at: number;
  /** What the device or the manager said, for `refused` and `error`. */
  message?: string;
}

/** What the attention says, and what tries again. */
export function refusalMessage(site: string, r: StandingRefusal): string {
  const why = r.message ? ` (${r.message.slice(0, 120)})` : '';
  switch (r.reason) {
    case 'denied':
      return `The sign-in to ${site} was denied on ${r.device}, so nothing signs in by itself any more. A pull from the page asks your phone once more, or sign in by hand in the live view.`;
    case 'expired':
      return `The sign-in to ${site} waited for your approval on ${r.device}, and it was not answered in time. The next scheduled pull asks once more; a pull from the page asks now.`;
    case 'no-device':
      return `The sign-in to ${site} needs your phone (${r.device}), and it is not paired here. Pair it again under Approvers, or sign in by hand in the live view; the next scheduled pull asks once more.`;
    case 'refused':
      return `${r.device} refused the sign-in to ${site} without asking you: one of its checks failed${why}. Nothing signs in by itself until you pull from the page or sign in by hand in the live view.`;
    case 'unknown-credential':
      return `${r.device} no longer holds this account's passkey for ${site}. Sign in by hand in the live view and add a new passkey; nothing signs in by itself until then.`;
    default:
      return `The sign-in to ${site} through ${r.device} failed${why}. The next scheduled pull tries once more; a pull from the page tries now.`;
  }
}

/** A short line for a layer's note or the details. */
export function refusalNote(r: StandingRefusal): string {
  const what: Record<Refusal, string> = {
    denied: 'denied',
    expired: 'not answered in time',
    'no-device': 'the phone is not paired here',
    refused: 'refused by the phone',
    'unknown-credential': 'the phone no longer holds the passkey',
    error: 'failed',
  };
  return `${what[r.reason] ?? r.reason} on ${r.device}; ${UNTIL_YOU.includes(r.reason) ? 'waits for a pull you start' : 'the next scheduled pull asks again'}`;
}

export type Try<H> = { ok: true } | { ok: false; reason: string; hold?: H };

export interface SignInOpts {
  /** The site's name for messages ("Schwab"). */
  site: string;
  /** The wait before each try (so its length is the number of tries). */
  backoff: readonly number[];
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  /** The standing refusal, kept by the kind (state.json). */
  load: () => StandingRefusal | null;
  save: (r: StandingRefusal | null) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** What to throw for something only you can fix (statements-common's NeedsYou). */
  needsYou: (message: string, kind: string) => Error;
  onChange?: () => void;
}

export class PasskeySignIn {
  /** A sign-in is running now, and what started it. */
  signingIn = false;
  trigger: Trigger | null = null;
  /** The last sign-in gave up after its tries (cleared once signed in). */
  failed: string | null = null;
  lastOkAt: number | null = null;
  /** Tries this run. */
  tries = 0;
  refusal: StandingRefusal | null;
  /** The approver's refusal during the sign-in running now. */
  private during: ApproverRefusal | null = null;
  private now: () => number;

  constructor(private o: SignInOpts) {
    this.now = o.now ?? Date.now;
    this.refusal = o.load();
  }

  /** Why an automatic sign-in for `trigger` must not ask the phone now, or null. */
  blocked(trigger: Trigger): string | null {
    const r = this.refusal;
    if (!r || trigger === 'refresh') return null;
    if (!UNTIL_YOU.includes(r.reason) && SCHEDULED.includes(trigger)) return null;
    return refusalMessage(this.o.site, r);
  }

  /** The line a paired phone shows for a sign-in (Authenticator.reasonFor): why it is asked now. */
  reason(): string {
    switch (this.signingIn ? this.trigger : null) {
      case 'refresh':
        return 'Sign in for the statements pull you started';
      case 'daily':
      case 'catch-up':
      case 'retry':
        return 'Sign in for the daily statements pull';
      case 'sign-in':
        return 'Sign in for the statements pull';
      case 'start':
        return 'Sign in by itself as the account starts';
      default:
        return 'A sign-in in the live view';
    }
  }

  /** The attention a standing refusal shows (kind `approval`), or null. */
  attention(): { kind: 'approval'; message: string } | null {
    return this.refusal ? { kind: 'approval', message: refusalMessage(this.o.site, this.refusal) } : null;
  }

  /** A passkey request was refused (the kind's handler): an approver's refusal during a sign-in stops it. */
  note(err: unknown): boolean {
    if (!this.signingIn || !(err instanceof ApproverRefusal)) return false;
    this.during ??= err;
    return true;
  }

  /** The approver refused during this sign-in: the try stops clicking. */
  get stopped(): boolean {
    return this.during !== null;
  }

  /** The account was seen signed in (by itself, or by you in the live view): a failure and a refusal are over. */
  signedIn() {
    this.failed = null;
    if (!this.refusal) return;
    this.o.log('info', `signed in again: automatic sign-ins may ask ${this.refusal.device} again`);
    this.refusal = null;
    this.o.save(null);
    this.o.onChange?.();
  }

  /**
   * One sign-in: `once(i)` for each try after its wait, until one goes through or `done()` says it is signed in
   * anyway. Throws `needsYou` when a standing refusal blocks `trigger` (kind `approval`, nothing asked), when the
   * approver refuses (kind `approval`, no more tries), with `hold(h)` for a hold, and after the last try (kind `login`).
   */
  async run<H>(trigger: Trigger, once: (i: number) => Promise<Try<H>>, o: { done: () => boolean; hold: (h: H) => Error; failed: (last: string) => string }): Promise<void> {
    const blocked = this.blocked(trigger);
    if (blocked) {
      this.o.log('info', `no automatic sign-in (${trigger}): the last approval was ${this.refusal!.reason} on ${this.refusal!.device}`);
      throw this.o.needsYou(blocked, 'approval');
    }
    this.signingIn = true;
    this.trigger = trigger;
    this.during = null;
    this.o.onChange?.();
    try {
      let last = '';
      const n = this.o.backoff.length;
      for (let i = 0; i < n; i++) {
        if (this.o.backoff[i]) await this.o.sleep(this.o.backoff[i]!);
        if (i && o.done()) return;
        this.tries++;
        const r = await once(i).catch((e): Try<H> => ({ ok: false, reason: String((e as Error)?.message ?? e).slice(0, 160) }));
        if (r.ok) {
          this.failed = null;
          this.lastOkAt = this.now();
          this.o.log('info', `signed in by itself with the passkey (${trigger}, try ${i + 1})`);
          this.signedIn();
          return;
        }
        // Set by note() while the try ran (TypeScript cannot see that).
        const d = this.during as ApproverRefusal | null;
        if (d) {
          this.refusal = { reason: d.reason, device: d.device, at: this.now(), ...(d.detail ? { message: d.detail.slice(0, 200) } : {}) };
          this.o.save(this.refusal);
          this.o.log('warn', `the approver answered ${d.reason} on ${d.device}: no more tries (${trigger}); ${UNTIL_YOU.includes(d.reason) ? 'only a pull you start asks again' : 'the next scheduled pull asks again'}`);
          throw this.o.needsYou(refusalMessage(this.o.site, this.refusal), 'approval');
        }
        if (r.hold !== undefined) throw o.hold(r.hold);
        last = r.reason;
        this.o.log('warn', `automatic sign-in try ${i + 1} of ${n} failed: ${r.reason}`);
      }
      this.failed = last;
      throw this.o.needsYou(o.failed(last), 'login');
    } finally {
      this.signingIn = false;
      this.trigger = null;
      this.during = null;
      this.o.onChange?.();
    }
  }
}
