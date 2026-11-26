/**
 * The account's status from what the extractor knows, as one pure function (tested in test/status.test.ts): the
 * status and what it needs from you, the layers it rests on, and the details the account page lists. Names, counts
 * and times only: never an event, a person's name or a cookie (the account's own username is the one exception, as
 * every kind's signed-in layer has).
 *
 * Signed out is not a failure here: Luma's discover pages answer anyone, so Explore works before you sign in, and the
 * account asks for a sign-in (attention `login`) for the rest. A Cloudflare check is the account's attention
 * (`captcha`), never solved here.
 */
import type * as P from '@dither-chat/protocol';
import { displayNote, displayState, type FreeDisplay, type ScreenHealth } from '@dither-accounts/browser';

export type PageState = 'loading' | 'login' | 'ready' | 'challenge';

export interface Facts {
  now: number;
  sandbox: { started: boolean; error: string | null; browserAlive: boolean; screen?: ScreenHealth; display: FreeDisplay | number | null; liveView: boolean; startedAt: number };
  extensionAttached: boolean;
  tab: string | null;
  page: { state: PageState; path: string; since: number } | null;
  self: { id: string; username: string | null } | null;
  hookVersion: number | null;
  /** Reads held back after a 429 or a Cloudflare check, until this time. */
  backoff: { until: number; why: '429' | 'challenge' } | null;
  feed: { items: number; lastFetch: number | null; lastError: string | null; nextAt: number | null; dropped: string | null };
  chats: { conversations: number; messages: number; lastFetch: number | null; lastError: string | null };
  city: string | null;
  lastCommand: { kind: string; ok: boolean; at: number; error?: string } | null;
}

export interface Computed {
  status: P.AccountStatus;
  attention: Omit<P.Attention, 'since'> | null;
  layers: P.StatusLayer[];
  details: Record<string, string | number | boolean | null>;
}

/** What the hub may ask for: events (home, threads), profiles, the chats, and the live view. */
export const CAPABILITIES: P.Capability[] = ['liveView', 'media', 'profile', 'posts', 'home', 'history', 'send', 'react', 'markRead'];

const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);
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
        if (page?.state === 'challenge' || f.backoff?.why === 'challenge') {
          status = 'attention';
          attention = { kind: 'captcha', message: 'Luma is showing a check (Cloudflare): clear it in the live view', liveView: true };
          layers.push({ name: 'signed in', state: 'waiting', note: 'a Cloudflare check is in the way: clear it in the live view' });
        } else if (!page || page.state === 'loading') {
          layers.push({ name: 'signed in', state: 'waiting', note: f.tab && !/luma\.com|127\.0\.0\.1|localhost/.test(f.tab) ? 'the browser is not on luma.com' : 'waiting for luma.com to load' });
        } else if (page.state === 'login') {
          status = 'attention';
          attention = { kind: 'login', message: 'Sign in to Luma in the live view (Explore works meanwhile)', liveView: true };
          layers.push({ name: 'signed in', state: 'waiting', note: 'not signed in: sign in in the live view' });
        } else {
          status = 'online';
          layers.push({ name: 'signed in', state: 'ok', note: f.self ? (f.self.username ? `as @${f.self.username}` : `as ${f.self.id}`) : 'yes' });
        }
      }
    }
  }

  if (f.backoff && f.backoff.why === '429' && f.backoff.until > f.now) {
    layers.push({ name: 'pace', state: 'waiting', note: `Luma said slow down (429): reads wait until ${hhmmss(f.backoff.until)}` });
  }

  const fd = f.feed;
  layers.push(
    fd.lastError
      ? { name: 'notifications', state: 'failed', note: `last read failed: ${fd.lastError}` }
      : fd.lastFetch
        ? { name: 'notifications', state: 'ok', note: `${fd.items} items; read ${hhmmss(fd.lastFetch)}${fd.dropped ? `; dropped ${fd.dropped}` : ''}` }
        : { name: 'notifications', state: 'waiting', note: fd.nextAt ? `first read at ${hhmmss(fd.nextAt)}` : 'read once signed in' },
  );
  const ch = f.chats;
  layers.push(
    ch.lastError
      ? { name: 'chats', state: 'failed', note: `last sync failed: ${ch.lastError}` }
      : ch.lastFetch
        ? { name: 'chats', state: 'ok', note: `${ch.conversations} conversations, ${ch.messages} messages; synced ${hhmmss(ch.lastFetch)}` }
        : { name: 'chats', state: 'waiting', note: 'synced once signed in' },
  );

  const details: Record<string, string | number | boolean | null> = {
    pageState: page?.state ?? null,
    pagePath: page?.path ?? null,
    extensionAttached: f.extensionAttached,
    hookVersion: f.hookVersion,
    self: f.self?.id ?? null,
    city: f.city,
    backoffUntil: f.backoff ? new Date(f.backoff.until).toISOString() : null,
    notificationItems: fd.items,
    notificationsRead: fd.lastFetch ? new Date(fd.lastFetch).toISOString() : null,
    notificationsError: fd.lastError,
    dropped: fd.dropped,
    chatConversations: ch.conversations,
    chatMessages: ch.messages,
    chatsSynced: ch.lastFetch ? new Date(ch.lastFetch).toISOString() : null,
    chatsError: ch.lastError,
    lastCommand: f.lastCommand ? `${f.lastCommand.kind} ${f.lastCommand.ok ? 'ok' : `failed: ${f.lastCommand.error ?? ''}`} at ${new Date(f.lastCommand.at).toISOString()}` : null,
  };
  return { status, attention, layers, details };
}
