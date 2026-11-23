/**
 * Which screen an account's sandboxes draw on: x11 (Xvfb + x11vnc) or wayland (a headless sway + wayvnc), docs/browser.md
 * "Display backends". The manager has a default (display_backend, x11 unless set) and an account's config can name its
 * own (displayBackend); the extractor gets the result as DITHER_DISPLAY_BACKEND. The same parse as
 * @dither-accounts/browser's, which the manager does not depend on.
 */
export type DisplayBackend = 'x11' | 'wayland';

/** A backend's name as given (any case, spaces around), or null when it is neither. */
export function parseBackend(v: unknown): DisplayBackend | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s === 'x11' || s === 'wayland' ? s : null;
}
