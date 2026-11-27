/**
 * Waiting, in a test, for the exact thing it checks. A condition is looked at when the harness says something
 * happened (the adapter emitted or logged, the fake Telegram was called): the only ways it can turn true. It has no
 * clock of its own. A wall-clock window (these tests had 4 to 6 s) failed whenever the machine was slow for a moment,
 * though nothing was wrong: under load a sign-in that takes milliseconds sat for seconds behind other work. The test's
 * own timeout still ends a real hang, and `report` says afterwards what it was still waiting for.
 */
import { afterAll, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';

interface Wait {
  f: () => unknown;
  what: string;
  resolve: () => void;
  reject: (e: unknown) => void;
}

export class Waits {
  private waits = new Set<Wait>();

  /** Something happened: each waiting condition is looked at again. */
  changed() {
    for (const w of [...this.waits]) {
      let ok: unknown;
      try {
        ok = w.f();
      } catch (e) {
        this.waits.delete(w);
        w.reject(e);
        continue;
      }
      if (ok) {
        this.waits.delete(w);
        w.resolve();
      }
    }
  }

  until(f: () => unknown, what: string): Promise<void> {
    if (f()) return Promise.resolve();
    return new Promise((resolve, reject) => this.waits.add({ f, what, resolve, reject }));
  }

  /** What is still being waited for (a test that timed out), dropped once said. */
  report(last: () => unknown): string[] {
    const out = [...this.waits].map((w) => `still waiting for ${w.what}; last status ${JSON.stringify(last())}`);
    this.waits.clear();
    return out;
  }
}

/**
 * The harnesses of a test file and its temporary directories: after each test, what a timed-out one still waited for
 * goes to stderr; after the file, every adapter is shut down, then the directories go, so one that a failed test left
 * running does not write into a removed directory later and fail some other test.
 */
export function harnesses<H extends { waits: Waits; status: unknown; adapter: { shutdown(): Promise<void> } }>(dirs: string[]) {
  const all: H[] = [];
  afterEach(() => {
    for (const h of all) for (const line of h.waits.report(() => h.status)) console.error(line);
  });
  afterAll(async () => {
    await Promise.all(all.map((h) => h.adapter.shutdown().catch(() => {})));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  return (h: H) => void all.push(h);
}
