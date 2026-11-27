/**
 * The account's status from what the extractor knows, as one pure function: the status and what it needs from you,
 * the layers it rests on, and the details the account page lists. Names, counts and times only: never an event, a
 * person's name or a token.
 *
 * Signed out is not broken here: Explore reads work without an account, so a signed-out page still answers `explore`
 * while the status asks you to sign in.
 */
import { displayNote, displayState, type FreeDisplay, type ScreenHealth } from '@dither-accounts/browser';
import type * as P from '@dither-chat/protocol';

export type PageState = 'loading' | 'login' | 'ready';

export interface Facts {
  now: number;
  sandbox: { started: boolean; error: string | null; browserAlive: boolean; screen?: ScreenHealth; display: FreeDisplay | number | null; liveView: boolean; startedAt: number };
  extensionAttached: boolean;
  /** The tab the browser shows (origin and path). */
  tab: string | null;
  page: { state: PageState; path: string; since: number } | null;
  self: { id: string } | null;
  hookVersion: number | null;
  /** Partiful showed a check for people, or slowed us down, and when. */
  blocked: { kind: 'check' | 'slow'; at: number; until?: number } | null;
  feed: { items: number; lastFetch: number | null; lastError: string | null; nextAt: number | null; dropped: string | null };
  lastCommand: { kind: string; ok: boolean; at: number; error?: string } | null;
}

export interface Computed {
  status: P.AccountStatus;
  attention: Omit<P.Attention, 'since'> | null;
  layers: P.StatusLayer[];
  details: Record<string, string | number | boolean | null>;
}

/** What the hub may ask for: the Feed page's events, profiles, threads, and the chats. */
export const CAPABILITIES: P.Capability[] = ['liveView', 'media', 'profile', 'posts', 'home', 'history', 'send', 'react', 'markRead'];

const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);
/** The browser has this long to load the extension before its absence is a failure. */
export const ATTACH_MS = 60_000;

export function compute(f: Facts): Computed {
  const layers: P.StatusLayer[] = [];
  let status: P.AccountStatus = 'connecting';
  let attention: Computed['attention'] = null;
  const s = f.sandbox;
  const page = f.page;

  if (s.error) {
    status = 'error';
    attention = { kind: 'unknown', message: `The sandbox failed to start: ${s.error}`, liveView: false };
    layers.push({ name: 'display', state: 'failed', note: s.error });
  } else if (!s.started) {
    layers.push({ name: 'display', state: 'waiting', note: 'starting the display, the browser and the live view' });
  } else {
    // A live view server that died shows here while it is started again (packages/browser screen.ts health).
    layers.push({ name: 'display', ...(s.screen && !s.screen.ok ? displayState(s.display, s.screen) : { state: 'ok' as const, note: `${displayNote(s.display)}${s.liveView ? ', live view on' : ''}` }) });
    if (!s.browserAlive) {
      status = 'error';
      layers.push({ name: 'browser', state: 'failed', note: 'Chromium exited' });
    } else {
      layers.push({ name: 'browser', state: 'ok', note: f.tab ?? 'no tab yet' });
      const late = f.now - s.startedAt > ATTACH_MS;
      if (!f.extensionAttached) {
        layers.push({ name: 'extension', state: late ? 'failed' : 'waiting', note: late ? 'the extension did not connect' : 'waiting for the extension' });
        if (late) {
          status = 'error';
          attention = { kind: 'unknown', message: "The browser's extension did not connect. Restart the account.", liveView: true };
        }
      } else {
        layers.push({ name: 'extension', state: 'ok', note: f.hookVersion ? `hook ${f.hookVersion}` : 'attached' });
        if (!page || page.state === 'loading') {
          layers.push({ name: 'signed in', state: 'waiting', note: f.tab && !/partiful\.com|127\.0\.0\.1|localhost/.test(f.tab) ? 'the browser is not on partiful.com' : 'waiting for partiful.com to load' });
        } else if (page.state === 'login') {
          status = 'attention';
          attention = { kind: 'login', message: 'Sign in to Partiful in the live view (Explore works meanwhile)', liveView: true };
          layers.push({ name: 'signed in', state: 'waiting', note: 'not signed in: sign in in the live view; Explore works meanwhile' });
        } else {
          status = 'online';
          layers.push({ name: 'signed in', state: 'ok', note: f.self ? `as user ${f.self.id}` : 'yes' });
        }
      }
    }
  }

  // A check for people, or being slowed down, is yours to see to in the live view; nothing here answers it.
  if (f.blocked && status !== 'error') {
    const b = f.blocked;
    if (b.kind === 'check') {
      status = 'attention';
      attention = { kind: 'captcha', message: 'Partiful is showing a check for people: open the live view and clear it', liveView: true };
    } else if (b.until && b.until > f.now) {
      attention ??= { kind: 'rate_limited', message: `Partiful asked us to slow down: reads wait until ${hhmmss(b.until)}`, liveView: false };
      if (status === 'online') status = 'attention';
    }
  }

  const fd = f.feed;
  const read = fd.lastFetch ? `read ${hhmmss(fd.lastFetch)}` : null;
  layers.push(
    fd.lastError
      ? { name: 'notifications', state: 'failed', note: `last read failed: ${fd.lastError}` }
      : fd.lastFetch
        ? { name: 'notifications', state: 'ok', note: `${fd.items} items; ${read}${fd.dropped ? `; dropped ${fd.dropped}` : ''}` }
        : { name: 'notifications', state: 'waiting', note: fd.nextAt ? `first read at ${hhmmss(fd.nextAt)}` : 'reads once the account is signed in' },
  );

  const details: Record<string, string | number | boolean | null> = {
    pageState: page?.state ?? null,
    pagePath: page?.path ?? null,
    extensionAttached: f.extensionAttached,
    hookVersion: f.hookVersion,
    self: f.self?.id ?? null,
    blocked: f.blocked ? `${f.blocked.kind} at ${new Date(f.blocked.at).toISOString()}` : null,
    notificationItems: fd.items,
    notificationsRead: fd.lastFetch ? new Date(fd.lastFetch).toISOString() : null,
    notificationsError: fd.lastError,
    dropped: fd.dropped,
    lastCommand: f.lastCommand ? `${f.lastCommand.kind} ${f.lastCommand.ok ? 'ok' : `failed: ${f.lastCommand.error ?? ''}`} at ${new Date(f.lastCommand.at).toISOString()}` : null,
  };
  return { status, attention, layers, details };
}
