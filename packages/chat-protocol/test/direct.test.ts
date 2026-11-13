import { expect, test } from 'bun:test';
import { directTarget, guessDirectNetwork, guessDirectNetworks } from '../src/direct.ts';

test('a typed address says which network it is for', () => {
  expect(guessDirectNetwork('@ann:matrix.org')).toBe('matrix');
  expect(guessDirectNetwork('@ann:localhost:8448')).toBe('matrix');
  expect(guessDirectNetwork('+1 (555) 123-4567')).toBe('signal');
  expect(guessDirectNetwork('A11CE000-2222-4CCC-9DDD-000000000002')).toBe('signal');
  expect(guessDirectNetwork('ann')).toBeNull();
  expect(guessDirectNetwork('5551234567')).toBeNull(); // no country code: could be anywhere
  expect(guessDirectNetwork('15551234567@s.whatsapp.net')).toBe('whatsapp');
});

test('a phone number could be Signal, WhatsApp, Telegram or Google Messages', () => {
  expect(guessDirectNetworks('+1 (555) 123-4567')).toEqual(['signal', 'whatsapp', 'telegram', 'gmessages']);
  expect(guessDirectNetworks('200000000000002@lid')).toEqual(['whatsapp']);
  expect(guessDirectNetworks('ann')).toEqual([]);
});

test('addresses are normalised, and what is wrong is said', () => {
  expect(directTarget('matrix', ' @ann:matrix.org ')).toEqual({ peer: '@ann:matrix.org' });
  expect(directTarget('signal', '+1 (555) 123-4567')).toEqual({ peer: '+15551234567' });
  expect(directTarget('signal', 'A11CE000-2222-4CCC-9DDD-000000000002')).toEqual({ peer: 'a11ce000-2222-4ccc-9ddd-000000000002' });
  expect(directTarget('discord', '400000000000000001')).toEqual({ peer: '400000000000000001' });
  expect(directTarget('matrix', 'ann')).toHaveProperty('error');
  expect(directTarget('signal', '5551234')).toHaveProperty('error');
  expect(directTarget('discord', 'ann#1234')).toHaveProperty('error');
  expect(directTarget('whatsapp', '+44 20 7946 0042')).toEqual({ peer: '+442079460042' });
  expect(directTarget('whatsapp', '15551234567@s.whatsapp.net')).toEqual({ peer: '15551234567@s.whatsapp.net' });
  expect(directTarget('whatsapp', '07946 0042')).toHaveProperty('error');
});

test('Telegram takes an @username, a phone number or an id; Google Messages a phone number', () => {
  expect(guessDirectNetworks('@durov_fan')).toEqual(['telegram']);
  expect(guessDirectNetworks('@ab')).toEqual([]); // too short for a username
  expect(guessDirectNetwork('@ann:matrix.org')).toBe('matrix'); // still Matrix with a server
  expect(directTarget('telegram', '@durov_fan')).toEqual({ peer: '@durov_fan' });
  expect(directTarget('telegram', 'durov_fan')).toEqual({ peer: '@durov_fan' });
  expect(directTarget('telegram', '+44 20 7946 0042')).toEqual({ peer: '+442079460042' });
  expect(directTarget('telegram', '123456789')).toEqual({ peer: '123456789' });
  expect(directTarget('telegram', 'a b')).toHaveProperty('error');
  expect(directTarget('gmessages', '+1 (555) 123-4567')).toEqual({ peer: '+15551234567' });
  expect(directTarget('gmessages', '@durov_fan')).toHaveProperty('error');
});
