/**
 * Chromium's own stderr lines that say nothing about the account, left out of its log (adapter.log) and counted
 * instead: one line now and then says how many of each were left out. Everything else Chromium says still goes in.
 *
 * - `push registration, DEPRECATED_ENDPOINT` and `push registration, QUOTA_EXCEEDED`: Chromium's GCM client asking
 *   Google for a push channel it is not allowed (registration_request.cc), over and over.
 * - `GTK module not found`: GTK looking for desktop modules the sandbox has none of (colorreload-gtk-module and the like).
 * - `X connection error at shutdown`: Chromium losing its display as the sandbox stops (ui/gfx/x/connection.cc).
 */
const NOISE: [name: string, line: RegExp][] = [
  ['push registration, DEPRECATED_ENDPOINT', /registration_request\.cc.*Registration response error message: DEPRECATED_ENDPOINT/],
  ['push registration, QUOTA_EXCEEDED', /registration_request\.cc.*Registration response error message: QUOTA_EXCEEDED/],
  ['GTK module not found', /Gtk-Message: .*Failed to load module "[\w.-]*gtk-module"/],
  ['X connection error at shutdown', /x\/connection\.cc.*X connection error received/],
];

/** How often the count line is written, at most (it is written when the next line comes after this). */
export const NOISE_SUMMARY_MS = 10 * 60_000;

export class ChromiumNoise {
  private counts = new Map<string, number>();
  private since: number;

  constructor(now = Date.now()) {
    this.since = now;
  }

  /** The lines of `text` worth logging; the rest counted. */
  keep(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      const hit = NOISE.find(([, re]) => re.test(l));
      if (hit) this.counts.set(hit[0], (this.counts.get(hit[0]) ?? 0) + 1);
      else out.push(l);
    }
    return out;
  }

  /** The count line, once NOISE_SUMMARY_MS has passed since the last one (or `force`), or null when there is none to say. */
  summary(now = Date.now(), force = false): string | null {
    if (!this.counts.size || (!force && now - this.since < NOISE_SUMMARY_MS)) return null;
    const mins = Math.max(1, Math.round((now - this.since) / 60_000));
    const parts = [...this.counts].map(([name, n]) => `${name} ×${n}`);
    this.counts.clear();
    this.since = now;
    return `left out Chromium's own noise in the last ${mins} min: ${parts.join(', ')}`;
  }
}
