/**
 * The account's status from what the extractor knows, as one pure function (test/status.test.ts): the status and what
 * it needs from you, the layers it rests on, the details the account page lists, and the capabilities the hub may use.
 * Names, counts and times only: never a post, a message, a person's name (the account's own username is the one
 * exception, as every chat kind's signed-in layer has), a cookie or the modhash.
 */
import type * as P from '@dither-chat/protocol';
import { displayName, displayState, type FreeDisplay, type ScreenHealth } from '@dither-accounts/browser';

/** What the page says about itself (hook.js `page`). */
export type PageState = 'login' | 'verify' | 'ready' | 'other';
export const PAGE_STATES: readonly PageState[] = ['login', 'verify', 'ready', 'other'];

export const ATTACH_MS = 30_000;
/** On another page this long (after one try to go back to old.reddit.com), it asks you. */
export const OTHER_MS = 30_000;

export interface Facts {
  now: number;
  sandbox: { started: boolean; error: string | null; browserAlive: boolean; screen?: ScreenHealth; display: FreeDisplay | number | null; startedAt: number };
  extensionAttached: boolean;
  hookTabs: number;
  tab: string | null;
  page: { state: PageState; path: string; user: string | null; modhash: boolean; old: boolean; since: number } | null;
  lastCommand: { kind: string; ok: boolean; at: number; error?: string } | null;
  feed: FeedFacts;
}

/** The inbox's state: counts and times only. */
export interface FeedFacts {
  items: number;
  lastFetch: number | null;
  lastError: string | null;
  nextAt: number | null;
  dropped: string | null;
}

export interface Computed {
  status: P.AccountStatus;
  attention: Omit<P.Attention, 'since'> | null;
  layers: P.StatusLayer[];
  details: Record<string, string | number | boolean | null>;
  capabilities: P.Capability[];
}

const hostOf = (u: string | null) => {
  try {
    return u ? new URL(u).hostname : null;
  } catch {
    return null;
  }
};
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/**
 * What the hub may ask for. Reading (home, posts, profiles) needs the signed-in page; voting, commenting, posting and
 * deleting need its modhash too. Never reposts (Reddit has none), who voted (Reddit names nobody), media or translation.
 */
export function capabilitiesOf(page: Facts['page']): P.Capability[] {
  const caps: P.Capability[] = ['liveView'];
  if (page?.state !== 'ready') return caps;
  caps.push('home', 'posts', 'profile');
  if (page.modhash) caps.push('postActions', 'publish', 'unpublish');
  return caps;
}

export function compute(f: Facts): Computed {
  const attachLate = f.sandbox.started && !f.extensionAttached && f.now - f.sandbox.startedAt > ATTACH_MS;
  const page = f.page;

  // ------------------------------------------------------------ status
  let status: P.AccountStatus = 'connecting';
  let attention: Computed['attention'] = null;
  const att = (kind: P.AttentionKind, message: string, liveView = true) => {
    status = 'attention';
    attention = { kind, message, liveView };
  };
  if (f.sandbox.error) {
    status = 'error';
    attention = { kind: 'unknown', message: `The sandbox failed to start: ${f.sandbox.error}`, liveView: false };
  } else if (attachLate) att('unknown', 'The sandbox extension did not attach; open the live view to see the browser');
  else if (page?.state === 'login') att('login', 'Sign in to Reddit in the live view');
  else if (page?.state === 'verify') att('verify', 'Reddit wants to check this sign-in: open the live view');
  else if (page?.state === 'other' && f.now - page.since > OTHER_MS) att('unknown', 'Reddit is open on another page; go to old.reddit.com in the live view');
  else if (page?.state === 'ready') status = 'online';

  // ------------------------------------------------------------ layers
  const browserFailed = !!f.sandbox.error && /chromium/i.test(f.sandbox.error);
  const display: P.StatusLayer = f.sandbox.started
    ? { name: 'display', ...displayState(f.sandbox.display, f.sandbox.screen) }
    : f.sandbox.error && !browserFailed
      ? { name: 'display', state: 'failed', note: f.sandbox.error }
      : browserFailed
        ? { name: 'display', state: 'off', note: 'not started' }
        : { name: 'display', state: 'waiting', note: 'starting the display' };
  const browser: P.StatusLayer = f.sandbox.started
    ? f.sandbox.browserAlive
      ? { name: 'browser', state: 'ok', note: f.tab ? `Chromium, on ${hostOf(f.tab) ?? f.tab}` : 'Chromium is running' }
      : { name: 'browser', state: 'failed', note: 'Chromium exited; the account restarts' }
    : browserFailed
      ? { name: 'browser', state: 'failed', note: f.sandbox.error! }
      : { name: 'browser', state: 'waiting', note: 'not started yet' };
  const extension: P.StatusLayer = f.extensionAttached
    ? { name: 'extension', state: 'ok', note: f.hookTabs ? 'attached, in the reddit.com page' : 'attached' }
    : attachLate
      ? { name: 'extension', state: 'failed', note: `did not attach within ${ATTACH_MS / 1000} s` }
      : { name: 'extension', state: 'waiting', note: 'not attached yet' };
  const signedIn: P.StatusLayer = !page
    ? { name: 'signed in', state: 'waiting', note: f.extensionAttached ? 'reddit.com is loading' : 'waits for the extension' }
    : page.state === 'login'
      ? { name: 'signed in', state: 'waiting', note: 'sign in to Reddit in the live view' }
      : page.state === 'verify'
        ? { name: 'signed in', state: 'waiting', note: 'Reddit wants a check: open the live view' }
        : page.user
          ? { name: 'signed in', state: 'ok', note: `as u/${page.user}` }
          : { name: 'signed in', state: 'waiting', note: 'not known yet' };
  const pageLayer: P.StatusLayer = !page
    ? { name: 'page', state: 'waiting', note: 'not read yet' }
    : page.state === 'ready'
      ? page.modhash
        ? { name: 'page', state: 'ok', note: 'old.reddit.com, reads and writes' }
        : { name: 'page', state: 'failed', note: 'old.reddit.com without its modhash: reads only (Reddit changed?)' }
      : page.state === 'other'
        ? { name: 'page', state: 'waiting', note: page.old ? 'old.reddit.com, not signed in yet' : 'not on old.reddit.com' }
        : { name: 'page', state: 'waiting', note: 'waits for you to sign in' };
  const fd = f.feed;
  const feed: P.StatusLayer = fd.lastError
    ? { name: 'inbox', state: 'failed', note: `last read failed: ${fd.lastError}` }
    : fd.lastFetch
      ? { name: 'inbox', state: 'ok', note: `${fd.items} items; read ${hhmmss(fd.lastFetch)}${fd.dropped ? `; dropped ${fd.dropped}` : ''}` }
      : { name: 'inbox', state: 'waiting', note: fd.nextAt ? `first read at ${hhmmss(fd.nextAt)}` : 'reads once the account is online' };

  // ------------------------------------------------------------ details
  const details: Record<string, string | number | boolean | null> = {
    display: displayName(f.sandbox.display),
    page: page?.path ?? null,
    pageState: page?.state ?? null,
    oldReddit: page?.old ?? null,
    modhash: page ? page.modhash : null,
    extensionAttached: f.extensionAttached,
    lastCommand: f.lastCommand ? `${f.lastCommand.kind} ${f.lastCommand.ok ? 'ok' : 'failed'} ${hhmmss(f.lastCommand.at)}` : null,
    'feed.items': fd.items,
    'feed.lastFetch': fd.lastFetch ? new Date(fd.lastFetch).toISOString() : null,
    'feed.nextFetch': fd.nextAt ? new Date(fd.nextAt).toISOString() : null,
    'feed.lastError': fd.lastError,
    'feed.dropped': fd.dropped,
  };

  return { status, attention, layers: [display, browser, extension, signedIn, pageLayer, feed], details, capabilities: capabilitiesOf(page) };
}
