/**
 * What a session tells Telegram about itself: initConnection's fields (deviceModel, systemVersion, appVersion,
 * systemLangCode, langPack, langCode, params), which Telegram keeps with the session and shows under Settings → Devices.
 *
 * On Telegram Desktop's app (api_id 611335) the session says exactly what Telegram Desktop says, from inside the
 * account's sandbox (no /sys, no window manager, X11), so the app id and the description agree. On the account's own
 * app it says what it is: the configured device name. docs/telegram.md, "What a session says it is".
 */
import { readFileSync } from 'node:fs';
import type { tl } from '@mtcute/bun';
import { TDESKTOP_VERSION } from './tdata.ts';

export type InitConnection = Partial<Omit<tl.RawInitConnectionRequest, 'apiId' | 'query'>>;

/**
 * Telegram Desktop's own app, as nixpkgs and Telegram's Linux packages build it (TDESKTOP_API_ID/HASH, published in
 * both). Telegram's terms ask every client for an app of its own, so a QR sign-in uses it only when the account asks
 * (config.app = "desktop"), or when it already signed in with it before that was a choice (a session and no app of
 * its own). The sign-in through Telegram Desktop itself (signIn = "desktop") is that app, so it always does.
 */
export const TELEGRAM_DESKTOP = { apiId: 611335, apiHash: 'd524b414d21f4d37f08684c1df41ac9c' } as const;

/** Telegram Desktop's AppVersionStr for an AppVersion number: 7002009 → "7.2.9", 7001000 → "7.1" (as its version.h). */
export function desktopVersionString(n: number): string {
  const [major, minor, patch] = [Math.floor(n / 1_000_000), Math.floor(n / 1000) % 1000, n % 1000];
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

/** The Telegram Desktop the tdata reader is written for (tdata.ts), when the binary's own version is unknown. */
export const DESKTOP_VERSION = desktopVersionString(TDESKTOP_VERSION);

/** The version in a nix store path (…-telegram-desktop-7.2.9/bin/Telegram), as Telegram Desktop writes it. */
export function versionFromBin(bin?: string | null): string | null {
  const m = bin?.match(/telegram-desktop-(\d+)\.(\d+)(?:\.(\d+))?(?![\d.])/);
  if (!m) return null;
  return desktopVersionString(Number(m[1]) * 1_000_000 + Number(m[2]) * 1000 + Number(m[3] ?? 0));
}

/** The glibc Telegram Desktop runs on: its ELF interpreter's store path, else the one this process runs on. */
function glibcOf(bin?: string | null): string | null {
  try {
    const head = bin ? readFileSync(bin).subarray(0, 4096).toString('latin1') : '';
    const fromBin = head.match(/glibc-(\d+\.\d+)/)?.[1];
    if (fromBin) return fromBin;
  } catch {}
  const report = (process as { report?: { getReport?(): unknown } }).report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime?.match(/^\d+\.\d+/)?.[0] ?? null;
}

/**
 * Telegram Desktop's tz_offset (SessionPrivate::prepareInitParams): seconds east of UTC, folded into −12 h … +14 h and
 * rounded to a quarter hour.
 */
export function tzOffset(now = new Date()): number {
  let s = -now.getTimezoneOffset() * 60 || 0;
  while (s < -12 * 3600) s += 24 * 3600;
  while (s > 14 * 3600) s -= 24 * 3600;
  return Math.sign(s) * Math.round(Math.abs(s) / 900) * 900 || 0;
}

/**
 * What Telegram Desktop sends in initConnection from inside the sandbox (its session_private.cpp and lib_base's
 * base_info_linux.cpp): the device model falls back to "Desktop" (no /sys/class/dmi), the system is "Linux X11 glibc
 * <version>" (no desktop environment or window manager), the app version is its AppVersionStr with nothing after it on
 * x86-64 (" arm64" on ARM), the language pack "tdesktop", and params carry only tz_offset.
 */
export function desktopProfile(bin?: string | null, now?: Date): InitConnection {
  const glibc = glibcOf(bin);
  const arch = process.arch === 'x64' ? '' : ` ${process.arch}`;
  return {
    deviceModel: 'Desktop',
    systemVersion: ['Linux', 'X11', ...(glibc ? ['glibc', glibc] : [])].join(' '),
    appVersion: `${versionFromBin(bin) ?? DESKTOP_VERSION}${arch}`,
    systemLangCode: 'en-US',
    langPack: 'tdesktop',
    langCode: 'en',
    params: { _: 'jsonObject', value: [{ _: 'jsonObjectValue', key: 'tz_offset', value: { _: 'jsonNumber', value: tzOffset(now) } }] },
  };
}

/** On the account's own app: what it is, under the name the account was given. */
export function ownProfile(deviceName: string): InitConnection {
  return { deviceModel: deviceName, appVersion: '0.1.0', systemVersion: 'Linux', systemLangCode: 'en', langPack: '', langCode: 'en' };
}

/**
 * The description for a session on this app: Telegram Desktop's whenever the api_id is Telegram Desktop's (a QR
 * sign-in with its app, the session the sign-in through Telegram Desktop makes, its own key shared), the account's
 * own otherwise. `bin`: the Telegram Desktop the sandbox runs, for its version and glibc.
 */
export function clientProfile(apiId: number, o: { deviceName: string; bin?: string | null }): InitConnection {
  return apiId === TELEGRAM_DESKTOP.apiId ? desktopProfile(o.bin) : ownProfile(o.deviceName);
}
