/**
 * Device linking with `signal-cli link -n <name>`.
 *
 * `link` prints the provisioning URI (sgnl://linkdevice?uuid=…&pub_key=…) on
 * stdout, then waits for the phone. The provisioning socket behind the URI
 * lives 90 s (Signal's ProvisioningSocket LIFESPAN), while the command itself
 * only gives up after 120 s ("Link request timed out, please try again."), so
 * a QR code shown for the whole command lifetime would be dead for its last
 * ~30 s. We start a fresh attempt before the current URI expires, publish the
 * new URI once it is printed, and only then stop the old attempt, unless the
 * phone already scanned it (signal-cli logs "linking in progress"), in which
 * case the old attempt wins and the newer ones are dropped.
 *
 * Rotation stops after `maxActiveMs` so an unattended hub does not open a
 * provisioning socket every 80 s forever; refresh() resumes it.
 *
 * On success `link` prints "Associated with: <number>" and exits 0.
 */

import type { Subprocess } from 'bun';
import { type ChildRegistry, type Logger, readLines, redactLinkUri, stopProcess } from './cli.ts';

export interface LinkOptions {
  argv: (deviceName: string) => string[];
  env: Record<string, string | undefined>;
  deviceName: string;
  children: ChildRegistry;
  log: Logger;
  /** A fresh URI to show as a QR code until `refreshAt`; `note` explains why a previous scan failed. */
  onUri: (uri: string, note: string | undefined, refreshAt: number) => void;
  /** The phone scanned the code; signal-cli is finishing the registration. */
  onScanned: () => void;
  /** Linked; `number` as printed by signal-cli. */
  onLinked: (number: string) => void;
  /** Something went wrong and there is no valid code on screen right now. */
  onTrouble: (message: string) => void;
  /** Rotation stopped (maxActiveMs reached); call refresh() to continue. */
  onPaused: () => void;
  /** Start the next attempt this long after the current URI appeared. Default 80 s. */
  rotateAfterMs?: number;
  /** Stop rotating after this long without a scan. Default 30 min. */
  maxActiveMs?: number;
  /** Time and timers for rotation, pausing and retries; tests pass one they move by hand. Default: the real ones. */
  clock?: Clock;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as Timer),
};

interface Attempt {
  n: number;
  proc: Subprocess;
  uri: string | null;
  scanned: boolean;
  /** We stopped it on purpose (a newer code replaced it, or another attempt won). */
  retired: boolean;
  lastErr: string;
}

const BACKOFF_S = [2, 5, 10, 30, 60];

export class LinkFlow {
  private attempts = new Set<Attempt>();
  private published: Attempt | null = null;
  private counter = 0;
  private stopped = false;
  private done = false;
  private paused = false;
  private activeSince = 0;
  private rotateTimer?: unknown;
  private retryTimer?: unknown;
  private failures = 0;
  private note: string | undefined;

  private clock: Clock;

  constructor(private o: LinkOptions) {
    this.clock = o.clock ?? realClock;
  }

  start() {
    this.activeSince = this.clock.now();
    this.spawn();
  }

  /** Abandon linking (relink, shutdown). */
  async stop() {
    this.stopped = true;
    this.clock.clearTimeout(this.rotateTimer);
    this.clock.clearTimeout(this.retryTimer);
    await Promise.all([...this.attempts].map((a) => stopProcess(a.proc, 3000)));
    this.attempts.clear();
  }

  /** Show a new QR code now (also resumes a paused flow). */
  refresh() {
    if (this.stopped || this.done) return;
    if ([...this.attempts].some((a) => a.scanned)) return;
    if (this.paused) {
      this.paused = false;
      this.activeSince = this.clock.now();
    }
    if ([...this.attempts].some((a) => !a.uri)) return; // one is already starting
    this.spawn();
  }

  get isPaused() {
    return this.paused;
  }

  get currentUri() {
    return this.published?.uri ?? null;
  }

  private alive(a: Attempt | null) {
    return !!a && this.attempts.has(a);
  }

  private spawn() {
    if (this.stopped || this.done) return;
    this.clock.clearTimeout(this.retryTimer);
    const n = ++this.counter;
    const proc = Bun.spawn(this.o.argv(this.o.deviceName), { env: this.o.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    this.o.children.add(proc);
    const a: Attempt = { n, proc, uri: null, scanned: false, retired: false, lastErr: '' };
    this.attempts.add(a);
    let number: string | null = null;
    const out = readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      const t = line.trim();
      const uri = t.match(/^(sgnl:\/\/linkdevice\?\S+)$/)?.[1];
      if (uri && !a.uri) this.gotUri(a, uri);
      const m = t.match(/^Associated with:\s*(\S+)/);
      if (m) number = m[1];
    });
    const err = readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      if (!line.trim()) return;
      if (/linking in progress/i.test(line)) this.gotScan(a);
      // The last non-stacktrace line of a failed command is its error message.
      if (!/^\s+at |^\s*\.\.\.|^Caused by/.test(line)) a.lastErr = line.trim();
      this.o.log(/ERROR|WARN|Exception/.test(line) ? 'warn' : 'debug', `[signal-cli link#${n}] ${redactLinkUri(line)}`);
    });
    Promise.all([proc.exited, out, err]).then(([code]) => this.exited(a, code, number));
  }

  private gotUri(a: Attempt, uri: string) {
    a.uri = uri;
    this.o.log('info', `link attempt #${a.n}: device link URI ready (${redactLinkUri(uri)})`);
    if (this.stopped || this.done) return;
    if ([...this.attempts].some((x) => x !== a && x.scanned)) {
      this.retire(a); // an older code is already being used
      return;
    }
    const after = this.o.rotateAfterMs ?? 80_000;
    this.failures = 0;
    this.published = a;
    this.o.onUri(uri, this.note, this.clock.now() + after);
    this.note = undefined;
    // Retire older attempts: their codes are about to expire anyway.
    for (const x of this.attempts) if (x !== a && !x.scanned) this.retire(x);
    this.clock.clearTimeout(this.rotateTimer);
    this.rotateTimer = this.clock.setTimeout(() => this.rotate(), after);
  }

  private retire(a: Attempt) {
    a.retired = true;
    void stopProcess(a.proc, 2000);
  }

  private rotate() {
    if (this.stopped || this.done || this.paused) return;
    if (this.clock.now() - this.activeSince >= (this.o.maxActiveMs ?? 30 * 60_000)) {
      this.paused = true;
      this.o.log('info', 'nobody scanned the code; pausing QR rotation');
      // Let the current code run out; nothing replaces it.
      this.o.onPaused();
      return;
    }
    this.spawn();
  }

  private gotScan(a: Attempt) {
    if (a.scanned) return;
    a.scanned = true;
    this.o.log('info', `link attempt #${a.n}: the phone scanned the code, finishing the link`);
    this.clock.clearTimeout(this.rotateTimer);
    for (const x of this.attempts) if (x !== a) this.retire(x);
    this.o.onScanned();
  }

  private exited(a: Attempt, code: number | null, number: string | null) {
    this.attempts.delete(a);
    if (this.stopped || this.done) return;
    if (code === 0 && number) {
      this.done = true;
      this.clock.clearTimeout(this.rotateTimer);
      for (const x of this.attempts) this.retire(x);
      this.o.onLinked(number);
      return;
    }
    const why = a.lastErr || `signal-cli link exited with code ${code}`;
    if (a.scanned) {
      this.o.log('warn', `link attempt #${a.n} failed after the scan: ${why}`);
      this.note = `Linking failed: ${why.replace(/\.$/, '')}.`;
      this.o.onTrouble(this.note);
      this.activeSince = this.clock.now();
      this.spawn();
      return;
    }
    // A code that died before we replaced it: say why, so a failed scan is not silent.
    if (a.uri && !a.retired) this.o.log(/timed out/i.test(why) ? 'info' : 'warn', `link attempt #${a.n} ended: ${why}`);
    if (this.paused) return;
    const newest = a.n === this.counter;
    if (!a.uri) {
      // Failed before showing a code (network down, server refused, ...).
      if (!newest) return;
      this.failures++;
      const delay = BACKOFF_S[Math.min(this.failures - 1, BACKOFF_S.length - 1)];
      this.o.log('warn', `link attempt #${a.n} failed before showing a code (retry in ${delay}s): ${why}`);
      if (!this.alive(this.published)) this.o.onTrouble(`Could not start device linking: ${why}`);
      this.retryTimer = this.clock.setTimeout(() => this.spawn(), delay * 1000);
      return;
    }
    // A code holder ended (timed out or retired). Replace it unless a newer attempt is on the way.
    if (a === this.published && !this.attempts.size) this.spawn();
  }
}
