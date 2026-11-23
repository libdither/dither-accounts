/**
 * The account's status from what the extractor knows, as one pure function (tested in test/status.test.ts): the
 * status and what it needs from you, the layers it rests on, and the details the account page lists. Names, counts
 * and times only: never a post, a person's name or a cookie (the account's own handle is the one exception, as every
 * kind's signed-in layer has).
 */
import type * as P from '@dither-chat/protocol';
import { displayName, type FreeDisplay } from '@dither-accounts/browser';

export type PageState = 'loading' | 'login' | 'ready';

export interface Facts {
  now: number;
  sandbox: { started: boolean; error: string | null; browserAlive: boolean; display: FreeDisplay | number | null; liveView: boolean; startedAt: number };
  extensionAttached: boolean;
  /** The tab the browser shows (origin and path). */
  tab: string | null;
  page: { state: PageState; path: string; since: number } | null;
  self: { id: string; handle: string | null } | null;
  hookVersion: number | null;
  feed: { items: number; lastFetch: number | null; lastError: string | null; nextAt: number | null; dropped: string | null };
  lastCommand: { kind: string; ok: boolean; at: number; error?: string } | null;
}

export interface Computed {
  status: P.AccountStatus;
  attention: Omit<P.Attention, 'since'> | null;
  layers: P.StatusLayer[];
  details: Record<string, string | number | boolean | null>;
}

/** What the hub may ask for: the Feed page's commands, and the live view. */
export const CAPABILITIES: P.Capability[] = ['liveView', 'media', 'profile', 'posts', 'postActions', 'publish', 'unpublish', 'home'];

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
    layers.push({ name: 'display', state: 'ok', note: `${displayName(s.display)}${s.liveView ? ', live view on' : ''}` });
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
          layers.push({ name: 'signed in', state: 'waiting', note: f.tab && !/substack\.com|127\.0\.0\.1|localhost/.test(f.tab) ? 'the browser is not on substack.com' : 'waiting for substack.com to load' });
        } else if (page.state === 'login') {
          status = 'attention';
          attention = { kind: 'login', message: 'Sign in to Substack in the live view', liveView: true };
          layers.push({ name: 'signed in', state: 'waiting', note: 'not signed in: sign in in the live view' });
        } else {
          status = 'online';
          layers.push({ name: 'signed in', state: 'ok', note: f.self ? (f.self.handle ? `as @${f.self.handle}` : `as user ${f.self.id}`) : 'yes' });
        }
      }
    }
  }

  const fd = f.feed;
  const read = fd.lastFetch ? `read ${hhmmss(fd.lastFetch)}` : null;
  layers.push(
    fd.lastError
      ? { name: 'activity', state: 'failed', note: `last read failed: ${fd.lastError}` }
      : fd.lastFetch
        ? { name: 'activity', state: 'ok', note: `${fd.items} items; ${read}${fd.dropped ? `; dropped ${fd.dropped}` : ''}` }
        : { name: 'activity', state: 'waiting', note: fd.nextAt ? `first read at ${hhmmss(fd.nextAt)}` : 'reads once the account is online' },
  );

  const details: Record<string, string | number | boolean | null> = {
    pageState: page?.state ?? null,
    pagePath: page?.path ?? null,
    extensionAttached: f.extensionAttached,
    hookVersion: f.hookVersion,
    self: f.self?.id ?? null,
    activityItems: fd.items,
    activityRead: fd.lastFetch ? new Date(fd.lastFetch).toISOString() : null,
    activityError: fd.lastError,
    activityDropped: fd.dropped,
    lastCommand: f.lastCommand ? `${f.lastCommand.kind} ${f.lastCommand.ok ? 'ok' : `failed: ${f.lastCommand.error ?? ''}`} at ${new Date(f.lastCommand.at).toISOString()}` : null,
  };
  return { status, attention, layers, details };
}
