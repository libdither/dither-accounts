/**
 * The names our extensions leave where a web page could come across them: the types of the events hook.js and
 * content.js talk by (and the one a hook asks whether it is already running with), a sessionStorage key, a property a
 * hook probes objects with, a media device's groupId. A site must not be able to find our users with a one-line check
 * for a name every install shares, so none of these is in the source: the source has placeholders, and the copy of
 * the extension the sandbox makes each start has them replaced by names made from this account's marker key.
 *
 *   `__MARK_<label>__`     an identifier-like name: a letter, then 7 to 14 letters and digits (valid as a JS
 *                          identifier, a property or Symbol.for key, an attribute, event or storage name)
 *   `__MARKHEX_<label>__`  64 hex digits (what Chromium's own device groupIds look like)
 *
 * <label> is letters and digits. A name is HMAC-SHA256(key, label), so every file of one copy gets the same name for
 * the same label: both ends of a channel (hook.js and content.js) agree without being told.
 *
 * Placeholders go in content scripts (hook.js, content.js), never in a background service worker: Chromium reads
 * content scripts from the copy at every start, but keeps the service worker script it first registered in the
 * profile (its Service Worker storage) and goes on running that one, whatever the copy or the manifest's version says
 * (Chromium 155, an unpacked extension on the command line, a persistent profile). A name stamped into a worker would
 * stay the first start's. test/page-markers.test.ts holds to this.
 *
 * The copy also puts in what every hook shares: a hook.js's `include main-world` comment (an `@include` comment, see
 * INCLUDE) becomes page/main-world.js (the channel to content.js, and what keeps the hook's wrappers looking like what
 * they replaced), and a content.js's `include isolated-world` becomes page/isolated-world.js (the other end of that
 * channel), before the placeholders are replaced.
 *
 * The key: the manager keeps one random secret per install (its registry's kv table) and hands each extractor
 * HMAC(secret, account id) as DITHER_MARKER_KEY (packages/manager/src/supervisor.ts), so the names differ between
 * installs and between accounts, and stay the same across restarts. An extractor started without it (by hand, by
 * another supervisor) makes a random key for the process: never names that are the same everywhere.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER_KEY_ENV = 'DITHER_MARKER_KEY';

const PLACEHOLDER = /__MARK(HEX)?_([A-Za-z0-9]+)__/g;
const INCLUDE = /\/\*@include ([a-z-]+)@\*\//g;
const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'page');
/** What must not be left in a copy: a placeholder or include that was not replaced (a malformed one), or our name. */
const LEFTOVER = /__MARK|@include|dither/i;
/** The files of an extension that are text and may hold placeholders. */
const TEXT = new Set(['.js', '.mjs', '.json', '.html', '.css']);

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = ALPHA + '0123456789';

let processKey: string | null = null;

/** This process's marker key: the one the manager gave it, or else a random one made once per process. */
export function markerKey(env: Record<string, string | undefined> = process.env): string {
  const k = env[MARKER_KEY_ENV];
  if (k && k.length >= 16) return k;
  return (processKey ??= randomBytes(32).toString('base64url'));
}

/** The identifier-like name `__MARK_<label>__` becomes under `key`. */
export function markerName(key: string, label: string): string {
  for (let n = 0; ; n++) {
    const h = createHmac('sha256', key).update(`name\0${label}\0${n}`).digest();
    const len = 8 + (h[0] % 8);
    let s = ALPHA[h[1] % ALPHA.length];
    for (let i = 2; i <= len; i++) s += ALNUM[h[i] % ALNUM.length];
    if (!LEFTOVER.test(s)) return s;
  }
}

/** The 64 hex digits `__MARKHEX_<label>__` becomes under `key`. */
export function markerHex(key: string, label: string): string {
  return createHmac('sha256', key).update(`hex\0${label}`).digest('hex');
}

/** `text` with every include put in (page/<name>.js); an unknown name throws. */
export function expandIncludes(text: string): string {
  return text.replace(INCLUDE, (_m, name: string) => readFileSync(join(PAGE_DIR, `${name}.js`), 'utf8'));
}

/** `text` as the extension's copy has it: every include put in, every placeholder replaced. */
export function stampMarkers(text: string, key: string): string {
  return expandIncludes(text).replace(PLACEHOLDER, (_m, hex: string | undefined, label: string) => (hex ? markerHex(key, label) : markerName(key, label)));
}

function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...textFiles(p));
    else if (e.isFile() && TEXT.has(extname(e.name))) out.push(p);
  }
  return out;
}

/**
 * Replace the placeholders in every text file of an extension copy, in place. Answers the files (relative to `dir`)
 * that still hold something constant of ours: a placeholder left (malformed) or our name. It should be none.
 */
export function stampExtension(dir: string, key: string): string[] {
  const left: string[] = [];
  for (const p of textFiles(dir)) {
    const before = readFileSync(p, 'utf8');
    const after = stampMarkers(before, key);
    if (after !== before) writeFileSync(p, after);
    if (LEFTOVER.test(after)) left.push(relative(dir, p));
  }
  return left;
}
