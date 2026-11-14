/**
 * What a session says it is (src/profile.ts): Telegram Desktop's own description whenever the api_id is Telegram
 * Desktop's, the account's device name otherwise. The last test compares the bundled version with the Telegram Desktop
 * on this machine, where there is one.
 */
import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { clientProfile, DESKTOP_VERSION, desktopProfile, desktopVersionString, TELEGRAM_DESKTOP, tzOffset, versionFromBin } from '../src/profile.ts';
import { TDESKTOP_VERSION } from '../src/tdata.ts';

const DESKTOP_FIELDS = ['appVersion', 'deviceModel', 'langCode', 'langPack', 'params', 'systemLangCode', 'systemVersion'];

test("Telegram Desktop's api_id gets Telegram Desktop's description, whatever the device name", () => {
  const p = clientProfile(TELEGRAM_DESKTOP.apiId, { deviceName: 'my laptop' });
  expect(Object.keys(p).sort()).toEqual(DESKTOP_FIELDS);
  expect(p).toMatchObject({ deviceModel: 'Desktop', langPack: 'tdesktop', systemLangCode: 'en-US', langCode: 'en' });
  expect(p.systemVersion).toMatch(/^Linux X11( glibc \d+\.\d+)?$/);
  expect(p.appVersion).toBe(process.arch === 'x64' ? DESKTOP_VERSION : `${DESKTOP_VERSION} ${process.arch}`);
  expect(p.params).toEqual({ _: 'jsonObject', value: [{ _: 'jsonObjectValue', key: 'tz_offset', value: { _: 'jsonNumber', value: tzOffset() } }] });
  expect(JSON.stringify(p)).not.toMatch(/dither|mtcute|my laptop/);
  // Both Telegram Desktop paths (its key, and a session of our own on its app) use this one definition.
  expect(desktopProfile()).toEqual(p);
});

test('any other api_id keeps its own honest description', () => {
  expect(clientProfile(1234567, { deviceName: 'my laptop', bin: '/nix/store/abc-telegram-desktop-7.2.9/bin/Telegram' })).toEqual({
    deviceModel: 'my laptop',
    appVersion: '0.1.0',
    systemVersion: 'Linux',
    systemLangCode: 'en',
    langPack: '',
    langCode: 'en',
  });
});

test("the version is the sandbox's Telegram Desktop's when its path says, written as Telegram Desktop writes it", () => {
  expect(desktopVersionString(7_002_009)).toBe('7.2.9');
  expect(desktopVersionString(7_001_000)).toBe('7.1');
  expect(desktopVersionString(TDESKTOP_VERSION)).toBe(DESKTOP_VERSION);
  expect(versionFromBin('/nix/store/abc-telegram-desktop-7.3.1/bin/Telegram')).toBe('7.3.1');
  expect(versionFromBin('/nix/store/abc-telegram-desktop-8.0/bin/Telegram')).toBe('8.0');
  expect(versionFromBin('/nix/store/abc-telegram-desktop-8.0.0/bin/Telegram')).toBe('8.0');
  expect(versionFromBin('/usr/bin/Telegram')).toBeNull();
  expect(versionFromBin(null)).toBeNull();
  const p = desktopProfile('/nix/store/abc-telegram-desktop-7.3.1/bin/Telegram');
  expect(p.appVersion).toStartWith('7.3.1');
  // A path that can't be read still gets the rest of the description.
  expect(p.deviceModel).toBe('Desktop');
});

test("tz_offset as Telegram Desktop rounds it: seconds east of UTC, to the quarter hour, within -12 h … +14 h", () => {
  const at = (minutesWest: number) => ({ getTimezoneOffset: () => minutesWest }) as Date;
  expect(tzOffset(at(0))).toBe(0);
  expect(tzOffset(at(480))).toBe(-8 * 3600);
  expect(tzOffset(at(-330))).toBe(5.5 * 3600);
  expect(tzOffset(at(-345))).toBe(5.75 * 3600);
  expect(tzOffset(at(-840))).toBe(14 * 3600);
});

// Where Telegram Desktop is installed (TELEGRAM_DESKTOP_BIN or on PATH; no nix build here), the bundled version must be
// its version: a nixpkgs bump without a matching TDESKTOP_VERSION (tdata.ts) fails here.
const installed = (() => {
  const p = process.env.TELEGRAM_DESKTOP_BIN || Bun.which('Telegram');
  try {
    return p ? realpathSync(p).replace(/\/\.Telegram-wrapped$/, '/Telegram') : null;
  } catch {
    return null;
  }
})();
const installedVersion = versionFromBin(installed);
if (!installedVersion) console.warn('skipped: no Telegram Desktop from nixpkgs here to compare the bundled version with');
test.if(!!installedVersion)("the bundled Telegram Desktop version is the installed one's", () => {
  expect(DESKTOP_VERSION).toBe(installedVersion!);
  expect(desktopProfile(installed).systemVersion).toMatch(/^Linux X11 glibc \d+\.\d+$/);
});
