/**
 * Which screen an account's sandboxes draw on: an X server (x11: Xvfb + x11vnc; tigervnc, kasmvnc, turbovnc: an Xvnc,
 * X server and live view in one) or wayland (a headless sway + wayvnc), docs/browser.md
 * "Display backends". The manager has a default (display_backend, x11 unless set) and an account's config can name its
 * own (displayBackend); the extractor gets the result as DITHER_DISPLAY_BACKEND. The same parse as
 * @dither-accounts/browser's, which the manager does not depend on.
 */
export const DISPLAY_BACKENDS = ['x11', 'tigervnc', 'kasmvnc', 'turbovnc', 'wayland'] as const;
export type DisplayBackend = (typeof DISPLAY_BACKENDS)[number];

/** A backend's name as given (any case, spaces around), or null when it is none of them. */
export function parseBackend(v: unknown): DisplayBackend | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return (DISPLAY_BACKENDS as readonly string[]).includes(s) ? (s as DisplayBackend) : null;
}
