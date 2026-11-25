/**
 * Which screen an account's sandboxes draw on: an X server (x11: Xvfb + x11vnc; tigervnc, turbovnc: an Xvnc, X server
 * and live view in one) or wayland (a headless sway + wayvnc), docs/browser.md
 * "Display backends". The manager has a default (display_backend, x11 unless set) and an account's config can name its
 * own (displayBackend); the extractor gets the result as DITHER_DISPLAY_BACKEND. The same parse as
 * @dither-accounts/browser's, which the manager does not depend on.
 */
export const DISPLAY_BACKENDS = ['x11', 'tigervnc', 'turbovnc', 'wayland'] as const;
export type DisplayBackend = (typeof DISPLAY_BACKENDS)[number];

/**
 * Backends @dither-accounts/browser has that an account cannot be given, and why. KasmVNC's Xvnc speaks an RFB of its
 * own: a pointer event of 11 bytes where noVNC sends 6 (the rest of the stream is misread after the first mouse move),
 * messages of its own (253, 254) sent to every viewer when another one comes or goes (noVNC disconnects on them), and
 * a clipboard only through its own message. So the live view, noVNC through the manager, cannot drive it. It stays in
 * the sandboxes for measuring (scripts/bench-display.ts) with its own client's messages.
 */
export const REFUSED_BACKENDS: Record<string, string> = {
  kasmvnc: "KasmVNC's RFB differs from noVNC's (pointer events, its own session messages, its own clipboard), so the live view cannot drive it",
};

/** A backend's name as given (any case, spaces around), or null when it is none of them. */
export function parseBackend(v: unknown): DisplayBackend | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return (DISPLAY_BACKENDS as readonly string[]).includes(s) ? (s as DisplayBackend) : null;
}
