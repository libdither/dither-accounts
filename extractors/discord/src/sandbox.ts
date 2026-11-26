/**
 * Per-account sandbox: the shared browser sandbox (packages/browser/src/sandbox.ts: a private screen, a NON-headless
 * Chromium with a persistent profile and an unpacked extension, the live view on a Unix socket in the account's
 * directory) running the real Discord web client, with what Discord adds to it: its extension and the bridge it talks
 * to, the call lab's hook, audio that plays without a click (calls), and screen sharing (Go Live) on a screen that can
 * share only itself.
 *
 * Deliberately NOT automation: no Playwright/Puppeteer, no --enable-automation, no --remote-debugging-port, no
 * --headless. It is an ordinary browser window that happens to run on a virtual display, so navigator.webdriver stays
 * false and the client behaves exactly as it would on the user's desktop.
 *
 * Discord's displays (below) are its own, so its accounts keep their slot from start to start.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimDisplay, type DisplayBackend, displayBackend, displayTaken, type FreeDisplay, portInUse, Sandbox as BrowserSandbox } from '@dither-accounts/browser';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_SRC = join(HERE, 'extension');
const LAB_SRC = join(HERE, 'lab');

export interface SandboxOptions {
  accountDir: string;
  display: number | FreeDisplay; // pickDisplay's, or an X display number, e.g. 91 -> :91
  width: number;
  height: number;
  wsUrl: string; //      ws://127.0.0.1:<adapterPort>/
  token: string; //      per-account WebSocket token
  startUrl: string; //   e.g. https://discord.com/app
  noSandbox?: boolean; // set if the chromium suid sandbox is unavailable
  lab?: boolean; //       call lab only: the lab probe and commands go into the hook (scripts/call-lab.ts)
  markerKey?: string; //  what the copy's page-visible names are made from (packages/browser markers.ts); default: the manager's
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** The screen's live view's server went down or came back. */
  onScreenHealth?: () => void;
}

export class Sandbox extends BrowserSandbox {
  constructor(opts: SandboxOptions) {
    super({
      accountDir: opts.accountDir,
      display: opts.display,
      width: opts.width,
      height: opts.height,
      extensionSrc: EXTENSION_SRC,
      // The bridge's address and this account's token, in the copy's config.json (0600).
      config: { wsUrl: opts.wsUrl, token: opts.token },
      // Call lab sandboxes only (scripts/call-lab.ts): the probe and the lab commands go inside the hook.
      prepareExtension: opts.lab
        ? (dir) => {
            const hook = join(dir, 'hook.js');
            const lab = ['probe.js', 'lab.js'].map((f) => readFileSync(join(LAB_SRC, f), 'utf8')).join('\n');
            writeFileSync(hook, readFileSync(hook, 'utf8').replace('/*@lab@*/', () => lab));
          }
        : undefined,
      markerKey: opts.markerKey,
      startUrl: opts.startUrl,
      // Calls: the client's audio feeds the bridge without anyone clicking first.
      flags: ['--autoplay-policy=no-user-gesture-required'],
      noSandbox: opts.noSandbox,
      // Go Live shares this sandbox's screen alone; if its portal and PipeWire fail to start, Discord runs without it.
      screenShare: true,
      log: opts.log,
      onScreenHealth: opts.onScreenHealth,
    });
  }
}

/** Discord's own displays; the other sandboxes pick theirs elsewhere (packages/browser/src/display.ts). */
export const DISCORD_DISPLAYS = { from: 91, to: 99 } as const;

/** The account's preferred slot in :91–:99, the same on every start. */
export function hashedDisplay(accountId: string): number {
  let hc = 0;
  for (const ch of accountId) hc = (hc * 31 + ch.charCodeAt(0)) >>> 0;
  return DISCORD_DISPLAYS.from + (hc % (DISCORD_DISPLAYS.to - DISCORD_DISPLAYS.from + 1));
}

/** A slot nobody holds: no X server on it, no live claim from a sandbox starting, and its extension port free. */
export async function slotFree(n: number, port: number | null): Promise<boolean> {
  if (displayTaken(n)) return false;
  if (port !== null && (await portInUse(port, '127.0.0.1'))) return false;
  return claimDisplay(n);
}

/**
 * On the wayland backend, a compositor of its own (no number, nothing to pick). On x11, the display from config/env
 * when set; else the account's hashed slot in :91–:99 when it is free, or the next free one after it. Two accounts can
 * hash to the same slot, and the second then failed to start ("Is port 8796 in use?", the extension port being 8700 +
 * display), so a slot is taken only when slotFree says so. Its live view is a socket, not a port.
 */
export async function pickDisplay(
  accountId: string,
  config: Record<string, any>,
  opts: { portFixed?: boolean; free?: (n: number, port: number | null) => Promise<boolean>; backend?: DisplayBackend } = {},
): Promise<FreeDisplay> {
  if ((opts.backend ?? displayBackend()) === 'wayland') return { backend: 'wayland', display: null };
  const envD = process.env.DITHER_DISPLAY ? Number(process.env.DITHER_DISPLAY) : undefined;
  if (config.display || envD) return { backend: 'x11', display: Number(config.display ?? envD) };
  const free = opts.free ?? slotFree;
  const { from, to } = DISCORD_DISPLAYS;
  const span = to - from + 1;
  const start = hashedDisplay(accountId) - from;
  for (let i = 0; i < span; i++) {
    const n = from + ((start + i) % span);
    if (await free(n, opts.portFixed ? null : 8700 + n)) return { backend: 'x11', display: n };
  }
  throw new Error(`no free Discord display in :${from}–:${to}; set this account's config.display to one outside it`);
}

export function readConfigFile<T = any>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}
