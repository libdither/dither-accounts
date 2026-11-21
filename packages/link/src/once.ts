/**
 * Sending once: a write an app asks for with an idempotency key (mail.send's `idempotencyKey`) runs at most once per
 * key, kept in a file in the account's directory for a week, so a resent call (an app that lost its socket, a manager
 * that restarted) never sends twice, also across this extractor's restarts.
 *
 *   const once = new SendOnce(join(link.accountDir, 'send-keys.json'));
 *   return once.run(cmd.idempotencyKey, (sending) => smtp.send(mail, dir, sending));
 *
 * A key is written down as started before anything goes out, and as done with its answer after. Then, for a key seen
 * before:
 *
 * - done: the first send's answer, again; nothing is sent. `duplicate` (409) when that answer was not kept.
 * - still running in this process: the same answer, once the first has it.
 * - started, and its outcome unknown (this process ended mid-send, or the send failed in a way that may have sent
 *   it): refused with `unsure` (504); nothing is sent. The app looks (in Sent) and sends with a new key if it must.
 *
 * A send that fails before it hands anything over (`sending()` not yet called), or that was refused outright (a 4xx
 * StatusError other than 408), forgets its key: nothing went, so the same key may try again. Any other failure keeps
 * it as started. A send that cannot call `sending()` at the right moment passes `unknown` instead, which says of each
 * failure whether it may have sent.
 */
import { existsSync } from 'node:fs';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { StatusError } from './index.ts';

/** How long a key is kept. */
export const KEEP_MS = 7 * 24 * 3600_000;
/** At most this many keys are kept (the oldest go first). */
export const MAX_KEYS = 5000;
/** A longer key is refused (400). */
export const MAX_KEY_LENGTH = 200;
/** An answer larger than this (as JSON) is not kept: a repeat gets `duplicate`. */
const MAX_ANSWER = 4096;

type Entry = { at: number; state: 'started' | 'done'; answer?: unknown };
type File = { v: 1; keys: Record<string, Entry> };

/** A failure after the send was handed over that may still have sent: anything but a StatusError in 4xx other than 408. */
export const mayHaveSent = (e: unknown) => !(e instanceof StatusError) || e.status < 400 || e.status >= 500 || e.status === 408;

export class SendOnce {
  private running = new Map<string, Promise<unknown>>();

  constructor(
    private path: string,
    private now: () => number = Date.now,
  ) {}

  /** `key` as an app gave it: undefined runs `f` as is; anything but a short non-empty string is 400. */
  async run<T>(key: unknown, f: (sending: () => void) => Promise<T>, o: { unknown?: (e: unknown) => boolean } = {}): Promise<T> {
    // No await before `running` is set: a repeat in the same tick finds the first.
    if (key === undefined || key === null) return f(() => {});
    if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) throw new StatusError(`idempotencyKey is a string of 1 to ${MAX_KEY_LENGTH} characters`, 400);
    const inFlight = this.running.get(key);
    if (inFlight) return inFlight as Promise<T>;
    const file = this.read();
    const seen = file.keys[key];
    if (seen?.state === 'done') {
      if ('answer' in seen) return seen.answer as T;
      throw new StatusError('a message with this idempotencyKey was already sent; it was not sent again', 409, 'duplicate');
    }
    if (seen) throw new StatusError('a message with this idempotencyKey was started before and may or may not have been sent; it was not sent again (look in Sent)', 504, 'unsure');
    file.keys[key] = { at: this.now(), state: 'started' };
    this.write(file);
    const p = (async () => {
      // `f` starts once `running` holds this send, so even one that throws at once is cleared after.
      await null;
      let handed = false;
      try {
        const answer = await f(() => {
          handed = true;
        });
        const f2 = this.read();
        const json = JSON.stringify(answer ?? null);
        f2.keys[key] = { at: f2.keys[key]?.at ?? this.now(), state: 'done', ...(json.length <= MAX_ANSWER ? { answer: answer ?? null } : {}) };
        this.write(f2);
        return answer;
      } catch (e) {
        // Nothing went: the key may be used again. Otherwise it stays started, and a repeat is refused as unsure.
        const maybeSent = o.unknown ? o.unknown(e) : handed && mayHaveSent(e);
        if (!maybeSent) {
          const f2 = this.read();
          delete f2.keys[key];
          this.write(f2);
        }
        throw e;
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, p);
    return p;
  }

  private read(): File {
    const f = existsSync(this.path) ? readSecretFile<Partial<File>>(this.path) : {};
    const keys = f.v === 1 && f.keys && typeof f.keys === 'object' ? f.keys : {};
    const now = this.now();
    const kept = Object.entries(keys)
      .filter(([, e]) => e && typeof e.at === 'number' && now - e.at < KEEP_MS)
      .sort((a, b) => a[1].at - b[1].at)
      .slice(-MAX_KEYS);
    return { v: 1, keys: Object.fromEntries(kept) };
  }

  private write(f: File) {
    writeSecretFile(this.path, f);
  }
}
