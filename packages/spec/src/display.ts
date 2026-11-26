/**
 * The display backends: which screen an account's sandboxes draw on (docs/browser.md "Display backends"). The one list
 * of them, read by the manager (an account's `displayBackend` setting, the default it gives extractors) and by
 * packages/browser (which screen to start: screen.ts keeps one constructor per name here, and the type checker says
 * when one is missing).
 *
 * Each backend speaks a protocol to its apps: `x11`, an X server on a numbered display from the shared pool
 * (packages/browser display.ts), or `wayland`, a compositor of the sandbox's own with no number at all. What else a
 * backend does differently (its live view's server, its input, its pictures) is its Screen's business.
 *
 * Adding a backend: a line here, its Screen in packages/browser (screen.ts SCREENS), its programs in the pinned set
 * (packages/browser bins.ts, nix/), and a line in docs/browser.md.
 */
export const BACKENDS = {
  /** Xvfb with x11vnc beside it. The default. */
  x11: { protocol: 'x11', label: 'Xvfb' },
  /** A headless sway of the sandbox's own, with wayvnc. */
  wayland: { protocol: 'wayland', label: 'sway (Wayland)' },
} as const satisfies Record<string, { protocol: 'x11' | 'wayland'; label: string }>;

export type DisplayBackend = keyof typeof BACKENDS;
/** The backends that are an X server on a numbered display. */
export type XBackend = { [K in DisplayBackend]: (typeof BACKENDS)[K]['protocol'] extends 'x11' ? K : never }[DisplayBackend];
/** The backends that are a compositor of the sandbox's own. */
export type WaylandBackend = Exclude<DisplayBackend, XBackend>;

export const DISPLAY_BACKENDS = Object.keys(BACKENDS) as DisplayBackend[];
export const DEFAULT_DISPLAY_BACKEND: DisplayBackend = 'x11';
/** The backend an extractor's sandboxes use; the manager sets it per account (docs/supervisor.md). */
export const DISPLAY_BACKEND_ENV = 'DITHER_DISPLAY_BACKEND';

/** A backend's name as given (any case, spaces around), or null when it is none of them. */
export function parseBackend(v: unknown): DisplayBackend | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return Object.hasOwn(BACKENDS, s) ? (s as DisplayBackend) : null;
}

export const isWaylandBackend = (b: DisplayBackend): b is WaylandBackend => BACKENDS[b].protocol === 'wayland';
export const isXBackend = (b: DisplayBackend): b is XBackend => BACKENDS[b].protocol === 'x11';

/** "x11, wayland": for messages that say what may be given. */
export const backendList = () => DISPLAY_BACKENDS.join(', ');
