/**
 * Starting a DM: createRoom with is_direct, m.direct updated, an existing DM reused.
 *
 * New rooms are encrypted when this account has encryption on, and plain when it does not. An existing encrypted DM is
 * still the one reused, even if it cannot be written to: a plaintext room beside it would quietly downgrade the conversation.
 */
import type { IdentityFact, OpenDirectResult } from '@dither-chat/protocol';
import { enc, MatrixError, type MatrixClient } from './http.ts';
import type { Directory } from './rooms.ts';

export interface DirectHost {
  api: Pick<MatrixClient, 'request'>;
  dir: Directory;
  encrypted: boolean;
  saveDirect(content: Record<string, string[]>): void;
  identity(f: IdentityFact): void;
  /** Tell the hub about this room, whether or not it thinks it already knows. */
  announce(roomId: string): void;
}

/** Sync brings a new room almost at once; past this the account is in trouble, not slow. */
const SYNC_WAIT_MS = 25_000;

/** Read, change, write: m.direct is one document shared with every other client of this account. */
export async function listAsDirect(h: DirectHost, peer: string, roomId: string) {
  const path = `/_matrix/client/v3/user/${enc(h.dir.selfId)}/account_data/m.direct`;
  const current: Record<string, string[]> = await h.api.request('GET', path).catch((e) => {
    if (e instanceof MatrixError && e.status === 404) return {};
    throw e;
  });
  if (current[peer]?.includes(roomId)) return;
  const next = { ...current, [peer]: [...(current[peer] ?? []), roomId] };
  await h.api.request('PUT', path, { body: next });
  h.saveDirect(next);
}

export async function openDirect(h: DirectHost, peer: string, waitMs = SYNC_WAIT_MS): Promise<OpenDirectResult> {
  if (peer === h.dir.selfId) throw new Error('that is this account');
  const existing = h.dir.directRoomWith(peer);
  if (existing) {
    await listAsDirect(h, peer, existing.id);
    h.announce(existing.id);
    return { conversation: existing.id, existed: true };
  }
  // An invite to nobody can leave an empty room behind on some servers, so ask first. Only "no such user" stops this:
  // servers may hide profiles, and a remote one may be down while the invite would still queue.
  const profile: any = await h.api.request('GET', `/_matrix/client/v3/profile/${enc(peer)}`).catch((e) => {
    if (e instanceof MatrixError && e.errcode === 'M_NOT_FOUND') throw new Error(`There is no Matrix user ${peer}`);
    return {};
  });
  const f: IdentityFact = { nativeId: peer, handle: peer, contact: true };
  if (typeof profile?.displayname === 'string' && profile.displayname.trim()) f.displayName = profile.displayname.trim();
  h.identity(f);
  const { room_id: roomId } = await h.api.request<{ room_id: string }>('POST', '/_matrix/client/v3/createRoom', { body: { preset: 'trusted_private_chat', is_direct: true, invite: [peer], ...(h.encrypted ? { initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] } : {}) } });
  h.dir.addDirect(peer, roomId);
  await listAsDirect(h, peer, roomId);
  // Until sync has it the adapter holds no state for the room, and could neither send there nor name it.
  const end = Date.now() + waitMs;
  while (h.dir.rooms.get(roomId)?.membership !== 'join') {
    if (Date.now() > end) throw new Error('The room was created but has not synced yet. It will appear on its own.');
    await Bun.sleep(50);
  }
  h.announce(roomId);
  return { conversation: roomId, existed: false };
}
