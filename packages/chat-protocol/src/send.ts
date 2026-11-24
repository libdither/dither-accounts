/** Why a message cannot go out, in words. The composer shows this and the hub enforces it, so a reply from outside the composer gets the same answer. */
import type { AccountView, ConversationView } from './api.ts';
import { NETWORK_META } from './ontology.ts';

export function sendBlocker(c: Pick<ConversationView, 'network' | 'encrypted' | 'variant'> & { nativeId?: string }, acc: Pick<AccountView, 'network' | 'label' | 'status' | 'capabilities'> | null | undefined): string | null {
  // A Luma event's conversation holds its host's blasts: Luma has no comments (docs/events.md "Conversations").
  if (c.network === 'luma' && (c.nativeId ?? '').startsWith('event:')) return 'Luma events take no comments: only the hosts write here, on Luma';
  if (!acc) return 'No account can send here';
  if (acc.status !== 'online' && acc.status !== 'connecting') return `${NETWORK_META[acc.network].name} · ${acc.label} is ${acc.status === 'attention' ? 'waiting for you (see Accounts)' : acc.status}`;
  if (c.variant === 'forum') return c.network === 'telegram' || c.network === 'zulip' ? 'Open a topic to reply' : 'Open a post to reply';
  // Anything sent through an adapter that cannot encrypt would reach the server readable.
  if (c.network === 'matrix' && c.encrypted && !acc.capabilities.includes('e2ee')) return 'This room is encrypted. Use "Set up encryption" on the account\'s page (Accounts) to write here';
  return null;
}
