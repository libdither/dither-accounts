import { expect, test } from 'bun:test';
import { fromWhatsApp, toWhatsApp } from '../src/format.ts';

test('WhatsApp styling becomes canonical Markdown', () => {
  expect(fromWhatsApp('*bold* _italic_ ~strike~ `code`')).toBe('**bold** _italic_ ~~strike~~ `code`');
  expect(fromWhatsApp('```\n*not bold*\n```')).toBe('```\n*not bold*\n```');
  expect(fromWhatsApp('5 * 3 * 2 = 30')).toBe('5 * 3 * 2 = 30');
  expect(fromWhatsApp('a*b*c')).toBe('a*b*c'); // markers need an edge
  expect(fromWhatsApp('(*yes*)')).toBe('(**yes**)');
  expect(fromWhatsApp('')).toBe('');
  expect(fromWhatsApp(undefined)).toBe('');
});

test('mentions become <@native id> only for the JIDs WhatsApp listed', () => {
  const resolve = (jid: string) => (jid === '200000000000002@lid' ? '15550000002@s.whatsapp.net' : jid);
  expect(fromWhatsApp('hi @200000000000002 and @12345678', { mentions: ['200000000000002@lid'], resolve })).toBe('hi <@15550000002@s.whatsapp.net> and @12345678');
  expect(fromWhatsApp('@15550000003 look', { mentions: ['15550000003@s.whatsapp.net'] })).toBe('<@15550000003@s.whatsapp.net> look');
});

test('canonical Markdown becomes WhatsApp text', () => {
  expect(toWhatsApp('**bold** *italic* _also_ ~~strike~~ `code`').text).toBe('*bold* _italic_ _also_ ~strike~ `code`');
  expect(toWhatsApp('__under__ ||spoiler|| [site](https://x.org) https://y.org').text).toBe('under spoiler site (https://x.org) https://y.org');
  expect(toWhatsApp('```\n**keep**\n```').text).toBe('```\n**keep**\n```');
  expect(toWhatsApp('***both***').text).toBe('*_both_*');
});

test('mentions go out as @user plus mentionedJID', () => {
  const r = toWhatsApp('hey <@15550000002@s.whatsapp.net> and <@15550000002@s.whatsapp.net>, ask <@123456789012345678>', (id) => (id.includes('@') ? id : null), (id) => (id === '123456789012345678' ? 'Discord Dan' : undefined));
  expect(r.text).toBe('hey @15550000002 and @15550000002, ask @Discord Dan');
  expect(r.mentions).toEqual(['15550000002@s.whatsapp.net']);
});
