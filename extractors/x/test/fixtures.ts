/** Raw objects as the page's hook sends them (after validate.ts), for the unit tests. */
import type { RawConversation, RawMessage, RawUser, SelfTest } from '../src/raw.ts';
import { HOOK_NAMES } from '../src/raw.ts';

export const SELF = '1001';
export const ALICE: RawUser = { id: '2002', screenName: 'alice_a', displayName: 'Alice A', avatarUrl: 'https://pbs.twimg.com/profile_images/2002/a_normal.jpg' };
export const BOB: RawUser = { id: '3003', screenName: 'bob_b', displayName: 'Bob B', avatarUrl: null };
export const T0 = Date.UTC(2026, 10, 7, 12);

export function conv(over: Partial<RawConversation> = {}): RawConversation {
  return { id: '1001-2002', kind: 'ConversationPreviewWithMetadata', legacy: true, group: false, title: null, avatarUrl: null, archived: false, description: null, muted: null, unread: 0, unreadByMe: false, lastTs: T0, lastReadSeq: '3', lastSeq: '3', users: [ALICE], ...over };
}
export function msg(over: Partial<RawMessage> = {}): RawMessage {
  return { id: 'm1', conv: '1001-2002', kind: 'MessageItemReceived', seq: '1', readSeq: '1', ts: T0, sender: ALICE.id, senderUser: ALICE, mine: false, text: 'hi', encrypted: false, undecryptable: false, edited: false, hidden: null, forwarded: null, replyTo: null, reactions: [], attachments: [], ...over };
}
export function selfTest(missing: string[] = [], via: Record<string, string> = {}): SelfTest {
  const hooks = {} as SelfTest['hooks'];
  for (const n of HOOK_NAMES) hooks[n] = missing.includes(n) ? { ok: false, via: null } : { ok: true, via: via[n] ?? 'name' };
  return { version: 1, hooks, counts: { renderers: 2, roots: 2, modules: 9, modulesScanned: 1, conversationsOpen: 0, readsHeld: 0, dropped: {} } };
}
