/**
 * The account's status from what the extractor knows, as one pure function (tested in test/status.test.ts): the
 * status and what it needs from you, the layers it rests on, the details the account page lists, and the
 * capabilities the hub may use. Names, counts and ids only: never a message, a person's name or handle (the account's
 * own handle is the one exception, as every chat kind's signed-in layer has), a cookie or the PIN.
 *
 * The hook points (raw.ts HOOK_NAMES) decide how far it gets:
 *   - react, graph, inbox: nothing works without them. Missing once the chat page is up → "X changed" (selector_broken).
 *   - send: missing → read-only: it keeps reading, the hub is told it cannot send, and the sending layer says why.
 *   - the rest (history, read, reply, edit, unsend, reactions, attach; requests, answer, openDirect, createGroup,
 *     addMembers, groupInfo, typing, forward) each only take their own feature away.
 */
import type * as P from '@dither-chat/protocol';
import type { FeedHookName, HookName, PageState, SelfTest } from './raw.ts';
import { FEED_HOOK_NAMES, HOOK_NAMES } from './raw.ts';

export const CORE: HookName[] = ['react', 'graph', 'inbox'];
/** The hooks are given this long on the chat page before a missing one counts as broken rather than not yet found. */
export const HOOK_GRACE_MS = 90_000;
export const ATTACH_MS = 30_000;

export interface Facts {
  now: number;
  sandbox: { started: boolean; error: string | null; browserAlive: boolean; display: number | null; liveView: boolean; startedAt: number };
  extensionAttached: boolean;
  hookTabs: number;
  tab: string | null;
  page: { state: PageState; path: string; pinMode: string | null; since: number } | null;
  selfTest: SelfTest | null;
  self: { id: string; handle: string | null; via: string | null } | null;
  inbox: { conversations: number; legacy: number; xchat: number; groups: number; loading: boolean; failed: boolean; keysChecked: boolean | null } | null;
  open: number;
  dropped: string | null;
  droppedTotal: number;
  lastCommand: { kind: string; ok: boolean; at: number; error?: string } | null;
  diagnosticsAt: number | null;
  /** HOOK_GRACE_MS unless set (tests). */
  graceMs?: number;
  /** The notification feed (feed.ts); left out, there is no feed layer (the unit tests of the DMs). */
  feed?: FeedFacts;
}

/** The feed's state: counts and times only. */
export interface FeedFacts {
  /** Feed messages announced since the start. */
  items: number;
  /** Profiles announced (personAbout) since the start. */
  people: number;
  /** When it last read the notifications, and whether that worked. */
  lastFetch: number | null;
  lastError: string | null;
  /** When the next read is due (null: not scheduled, as when not online). */
  nextAt: number | null;
  dropped: string | null;
}

export interface Computed {
  status: P.AccountStatus;
  attention: Omit<P.Attention, 'since'> | null;
  layers: P.StatusLayer[];
  details: Record<string, string | number | boolean | null>;
  capabilities: P.Capability[];
  missing: HookName[];
}

const hostOf = (u: string | null) => {
  try {
    return u ? new URL(u).hostname : null;
  } catch {
    return null;
  }
};

/** Hooks the page checks only once a conversation is open, and has not yet. */
export function pendingHooks(st: SelfTest | null): HookName[] {
  if (!st) return [];
  return HOOK_NAMES.filter((n) => !st.hooks[n]?.ok && st.hooks[n]?.via === 'pending');
}
export function missingHooks(st: SelfTest | null): HookName[] {
  if (!st) return [...HOOK_NAMES];
  return HOOK_NAMES.filter((n) => !st.hooks[n]?.ok && st.hooks[n]?.via !== 'pending');
}

/** What the hub may ask for, from the hooks that were found. */
export function capabilitiesOf(st: SelfTest | null): P.Capability[] {
  const ok = (n: HookName) => !!st?.hooks[n]?.ok;
  const caps: P.Capability[] = ['liveView', 'media'];
  if (ok('history')) caps.push('history');
  if (ok('read')) caps.push('markRead');
  if (ok('send')) caps.push('send', 'sendMedia');
  if (ok('send') && ok('edit')) caps.push('edit');
  if (ok('unsend')) caps.push('redact');
  if (ok('reactions')) caps.push('react');
  // Past the conversation itself (docs/x.md "Requests, new chats and groups"): each only where its hook was found.
  if (ok('typing')) caps.push('typing');
  if (ok('forward')) caps.push('forward');
  if (ok('openDirect')) caps.push('openDirect');
  if (ok('requests') && ok('answer')) caps.push('requests');
  if (ok('inbox')) caps.push('about');
  if (ok('groupInfo')) caps.push('configure');
  if (ok('addMembers')) caps.push('addMembers');
  if (ok('createGroup')) caps.push('createGroup');
  if (feedOk(st, 'store') && feedOk(st, 'endpoints') && feedOk(st, 'profiles')) caps.push('profile');
  if (feedOk(st, 'store') && feedOk(st, 'endpoints') && feedOk(st, 'posts')) caps.push('posts');
  // Answering on X: the post actions factory (like, repost, sendTweet); who liked or reposted, whose chunk is loaded at
  // the first ask (pending until then, and offered: it fails with "not found" and is withdrawn if it is not there).
  // Its "Translate post" lives on the same factory (fetchTranslation).
  if (feedOk(st, 'store') && feedOk(st, 'endpoints') && feedOk(st, 'actions')) caps.push('postActions', 'publish', 'translate');
  if (feedOk(st, 'store') && feedOk(st, 'endpoints') && (feedOk(st, 'reactors') || st?.feed?.reactors?.via === 'pending')) caps.push('postReactors');
  return caps;
}

const feedOk = (st: SelfTest | null, n: FeedHookName) => !!st?.feed?.[n]?.ok;
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** The feed's layer and details (docs/x.md "Notifications and profiles"): it never decides the account's status. */
function feedPart(f: Facts, grace: number): { layer: P.StatusLayer; details: Record<string, string | number | null> } {
  const st = f.selfTest;
  const fd = f.feed!;
  const hooks = st?.feed;
  const missing = hooks ? FEED_HOOK_NAMES.filter((n) => !hooks[n]?.ok && hooks[n]?.via !== 'pending') : [];
  const late = f.page?.state === 'chat' && f.now - f.page.since > grace;
  const read = fd.lastFetch ? `read ${hhmmss(fd.lastFetch)}` : null;
  const counts = `${fd.items} items, ${fd.people} profiles`;
  const layer: P.StatusLayer = !st
    ? { name: 'feed', state: 'waiting', note: 'the self-test has not reported yet' }
    : fd.lastError
      ? { name: 'feed', state: 'failed', note: `last read failed: ${fd.lastError}${missing.length ? ` (not found: ${missing.join(', ')})` : ''}` }
      : fd.lastFetch
        ? { name: 'feed', state: 'ok', note: `${counts}; ${read}${fd.dropped ? `; dropped ${fd.dropped}` : ''}` }
        : missing.length && late
          ? { name: 'feed', state: 'failed', note: `X changed: ${missing.join(', ')} not found, so notifications cannot be read` }
          : { name: 'feed', state: 'waiting', note: fd.nextAt ? `first read at ${hhmmss(fd.nextAt)}` : 'reads once the account is online' };
  const details: Record<string, string | number | null> = {
    'feed.items': fd.items,
    'feed.people': fd.people,
    'feed.lastFetch': fd.lastFetch ? new Date(fd.lastFetch).toISOString() : null,
    'feed.nextFetch': fd.nextAt ? new Date(fd.nextAt).toISOString() : null,
    'feed.lastError': fd.lastError,
    'feed.dropped': fd.dropped,
  };
  for (const n of FEED_HOOK_NAMES) {
    const h = hooks?.[n];
    details[`hook.${n}`] = !hooks ? null : h?.ok ? `found${h.via ? ` (${h.via})` : ''}` : h?.via === 'pending' ? 'pending' : 'missing';
  }
  return { layer, details };
}

export function compute(f: Facts): Computed {
  const st = f.selfTest;
  const missing = missingHooks(st);
  const pending = pendingHooks(st);
  const coreMissing = CORE.filter((n) => missing.includes(n));
  const onChat = f.page?.state === 'chat';
  const chatFor = onChat && f.page ? f.now - f.page.since : 0;
  const grace = f.graceMs ?? HOOK_GRACE_MS;
  const broken = !!st && onChat && coreMissing.length > 0 && chatFor > grace;
  const readOnly = !!st && onChat && !coreMissing.length && missing.includes('send') && chatFor > grace;
  const attachLate = f.sandbox.started && !f.extensionAttached && f.now - f.sandbox.startedAt > ATTACH_MS;

  // ------------------------------------------------------------ status
  let status: P.AccountStatus = 'connecting';
  let attention: Computed['attention'] = null;
  const att = (kind: P.AttentionKind, message: string, liveView = true, detail?: unknown) => {
    status = 'attention';
    attention = { kind, message, liveView, ...(detail ? { detail } : {}) };
  };
  if (f.sandbox.error) {
    status = 'error';
    attention = { kind: 'unknown', message: `The sandbox failed to start: ${f.sandbox.error}`, liveView: false };
  } else if (attachLate) att('unknown', 'The sandbox extension did not attach; open the live view to see the browser');
  else if (f.page?.state === 'login') att('login', 'Sign in to X in the live view');
  else if (f.page?.state === 'verify') att('verify', 'X wants to check this sign-in: open the live view');
  else if (f.page?.state === 'pin') att('verify', 'Enter your XChat PIN in the live view, so this browser can open your encrypted chats');
  else if (broken) att('selector_broken', `X changed: ${coreMissing.join(', ')} no longer found, so DMs cannot be read`, true, { missing });
  else if (readOnly) att('selector_broken', 'X changed: sending was not found, so this account only reads (see its hooks)', false, { missing });
  else if (f.page?.state === 'other' && f.self) att('unknown', 'X is open on another page; go back to Chat (x.com/i/chat) in the live view');
  else if (f.inbox && f.inbox.failed) att('unknown', 'X could not load your chats; open the live view to see why');
  else if (onChat && f.inbox && !f.inbox.loading && st && !coreMissing.length) status = 'online';

  // ------------------------------------------------------------ layers
  const browserFailed = !!f.sandbox.error && /chromium/i.test(f.sandbox.error);
  const display: P.StatusLayer = f.sandbox.started
    ? { name: 'display', state: 'ok', note: `Xvfb :${f.sandbox.display}, live view ready` }
    : f.sandbox.error && !browserFailed
      ? { name: 'display', state: 'failed', note: f.sandbox.error }
      : browserFailed
        ? { name: 'display', state: 'off', note: 'not started' }
        : { name: 'display', state: 'waiting', note: 'starting Xvfb' };
  const browser: P.StatusLayer = f.sandbox.started
    ? f.sandbox.browserAlive
      ? { name: 'browser', state: 'ok', note: f.tab ? `Chromium, on ${hostOf(f.tab) ?? f.tab}` : 'Chromium is running' }
      : { name: 'browser', state: 'failed', note: 'Chromium exited; the account restarts' }
    : browserFailed
      ? { name: 'browser', state: 'failed', note: f.sandbox.error! }
      : { name: 'browser', state: 'waiting', note: 'not started yet' };
  const extension: P.StatusLayer = f.extensionAttached
    ? { name: 'extension', state: 'ok', note: f.hookTabs ? 'attached, in the x.com page' : 'attached' }
    : attachLate
      ? { name: 'extension', state: 'failed', note: `did not attach within ${ATTACH_MS / 1000} s` }
      : { name: 'extension', state: 'waiting', note: 'not attached yet' };
  const who = f.self ? (f.self.handle ? `@${f.self.handle}` : `user ${f.self.id}`) : null;
  const signedIn: P.StatusLayer = !f.page
    ? { name: 'signed in', state: 'waiting', note: f.extensionAttached ? 'x.com is loading' : 'waits for the extension' }
    : f.page.state === 'login'
      ? { name: 'signed in', state: 'waiting', note: 'sign in to X in the live view' }
      : f.page.state === 'verify'
        ? { name: 'signed in', state: 'waiting', note: 'X wants a check: open the live view' }
        : who
          ? { name: 'signed in', state: 'ok', note: `as ${who}` }
          : { name: 'signed in', state: 'waiting', note: 'not known yet' };
  const found = st ? HOOK_NAMES.length - missing.length - pending.length : 0;
  const later = pending.length ? `; ${pending.join(', ')} checked once a conversation is open` : '';
  const hooks: P.StatusLayer = !st
    ? { name: 'hooks', state: 'waiting', note: 'the self-test has not reported yet' }
    : coreMissing.length && broken
      ? { name: 'hooks', state: 'failed', note: `${found} of ${HOOK_NAMES.length} found; not ${coreMissing.join(', ')}` }
      : coreMissing.length
        ? { name: 'hooks', state: 'waiting', note: `${found} of ${HOOK_NAMES.length} found so far; not yet ${coreMissing.join(', ')}` }
        : { name: 'hooks', state: 'ok', note: `${found} of ${HOOK_NAMES.length} found${missing.length ? `; not ${missing.join(', ')}` : ''}${later}` };
  const keys: P.StatusLayer =
    f.page?.state === 'pin'
      ? { name: 'XChat keys', state: 'waiting', note: `enter your XChat PIN in the live view${f.page.pinMode ? ` (${f.page.pinMode})` : ''}` }
      : f.inbox && f.inbox.keysChecked === false
        ? { name: 'XChat keys', state: 'waiting', note: 'the page is checking its keys' }
        : f.inbox && !f.inbox.loading
          ? { name: 'XChat keys', state: 'ok', note: f.inbox.xchat ? 'open on this browser' : 'no XChat conversations yet' }
          : { name: 'XChat keys', state: 'waiting', note: 'waits for the chat page' };
  const inbox: P.StatusLayer = !f.inbox
    ? { name: 'inbox', state: coreMissing.length && broken ? 'off' : 'waiting', note: onChat ? 'not read yet' : 'waits for x.com/i/chat' }
    : f.inbox.failed
      ? { name: 'inbox', state: 'failed', note: 'X could not load the chats' }
      : f.inbox.loading
        ? { name: 'inbox', state: 'waiting', note: 'loading' }
        : { name: 'inbox', state: 'ok', note: `${f.inbox.conversations} conversations: ${f.inbox.xchat} XChat, ${f.inbox.legacy} legacy DM; ${f.inbox.groups} groups${f.droppedTotal ? `; ${f.droppedTotal} objects dropped` : ''}` };
  const writeMissing = (['send', 'reply', 'edit', 'unsend', 'reactions'] as HookName[]).filter((n) => missing.includes(n));
  const sending: P.StatusLayer = !st
    ? { name: 'sending', state: 'waiting', note: 'the self-test has not reported yet' }
    : missing.includes('send')
      ? { name: 'sending', state: readOnly ? 'failed' : 'waiting', note: readOnly ? 'read-only: the composer events were not found' : 'not found yet' }
      : { name: 'sending', state: 'ok', note: writeMissing.length ? `can send; not ${writeMissing.join(', ')}` : 'send, reply, edit, unsend, reactions' };

  // ------------------------------------------------------------ details
  const details: Record<string, string | number | boolean | null> = {
    display: f.sandbox.display !== null ? `:${f.sandbox.display}` : null,
    page: f.page?.path ?? null,
    pageState: f.page?.state ?? null,
    pinMode: f.page?.pinMode ?? null,
    extensionAttached: f.extensionAttached,
    hookVersion: st?.version ?? null,
    hooks: st ? `${found} of ${HOOK_NAMES.length}` : null,
    self: f.self ? `${f.self.id}${f.self.via ? ` (${f.self.via})` : ''}` : null,
    conversations: f.inbox?.conversations ?? null,
    xchat: f.inbox?.xchat ?? null,
    legacy: f.inbox?.legacy ?? null,
    groups: f.inbox?.groups ?? null,
    openInPage: f.open,
    reactRenderers: st?.counts.renderers ?? null,
    fiberRoots: st?.counts.roots ?? null,
    modulesLoaded: st?.counts.modules ?? null,
    modulesScanned: st?.counts.modulesScanned ?? null,
    readsHeld: st?.counts.readsHeld ?? null,
    dropped: f.dropped,
    lastCommand: f.lastCommand ? `${f.lastCommand.kind} ${f.lastCommand.ok ? 'ok' : 'failed'} ${new Date(f.lastCommand.at).toISOString().slice(11, 19)}` : null,
    diagnostics: f.diagnosticsAt ? new Date(f.diagnosticsAt).toISOString() : null,
  };
  for (const n of HOOK_NAMES) {
    const h = st?.hooks[n];
    details[`hook.${n}`] = !st ? null : h?.ok ? `found${h.via ? ` (${h.via})` : ''}` : h?.via === 'pending' ? 'pending' : 'missing';
  }

  const layers = [display, browser, extension, signedIn, hooks, keys, inbox, sending];
  if (f.feed) {
    const fp = feedPart(f, grace);
    layers.push(fp.layer);
    Object.assign(details, fp.details);
  }

  return {
    status,
    attention,
    layers,
    details,
    capabilities: capabilitiesOf(st),
    missing,
  };
}
