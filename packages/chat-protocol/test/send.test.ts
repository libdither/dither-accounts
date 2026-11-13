import { expect, test } from 'bun:test';
import { sendBlocker } from '../src/send.ts';

const acc = { network: 'matrix', label: 'mx', status: 'online', capabilities: ['send'] } as const;
const room = { network: 'matrix', encrypted: false, variant: 'text' } as const;

test('the rules, shared by composer and hub', () => {
  expect(sendBlocker(room, acc as any)).toBeNull();
  expect(sendBlocker(room, null)).toBe('No account can send here');
  expect(sendBlocker(room, { ...acc, status: 'connecting' } as any)).toBeNull();
  expect(sendBlocker(room, { ...acc, status: 'offline' } as any)).toBe('Matrix · mx is offline');
  expect(sendBlocker(room, { ...acc, status: 'attention' } as any)).toContain('waiting for you');
  expect(sendBlocker({ ...room, variant: 'forum' }, acc as any)).toBe('Open a post to reply');
});

test('an encrypted Matrix room takes an adapter that can encrypt; Signal always encrypts itself', () => {
  const secret = { ...room, encrypted: true };
  expect(sendBlocker(secret, acc as any)).toContain('Set up encryption');
  expect(sendBlocker(secret, { ...acc, capabilities: ['send', 'e2ee'] } as any)).toBeNull();
  expect(sendBlocker({ ...secret, network: 'signal' }, { ...acc, network: 'signal' } as any)).toBeNull();
});
