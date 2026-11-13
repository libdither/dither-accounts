import { expect, test } from 'bun:test';
import { openDirect, type DirectHost } from '../src/direct.ts';

function host(encrypted: boolean) {
  const created: any[] = [];
  const rooms = new Map<string, { membership: string }>();
  const h = {
    encrypted,
    dir: { selfId: '@me:x', directRoomWith: () => null, addDirect() {}, rooms },
    api: {
      request: async (method: string, path: string, opts?: { body?: any }) => {
        if (!path.endsWith('/createRoom')) return {};
        created.push(opts?.body);
        rooms.set('!new:x', { membership: 'join' });
        return { room_id: '!new:x' };
      },
    },
    saveDirect() {},
    identity() {},
    announce() {},
  } as unknown as DirectHost;
  return { h, created };
}

test('a new DM is encrypted when this account has encryption on', async () => {
  const { h, created } = host(true);
  await openDirect(h, '@them:x');
  expect(created[0].initial_state).toEqual([{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]);
});

test('and plain when it does not, since an encrypted room could not be written to', async () => {
  const { h, created } = host(false);
  await openDirect(h, '@them:x');
  expect(created[0].initial_state).toBeUndefined();
});
