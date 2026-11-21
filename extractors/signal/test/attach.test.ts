/** A file for signal-cli's send (attach.ts): its own name and type in a data URI, a big one by path. */
import { expect, test } from 'bun:test';
import { attachmentArg, DATA_URI_MAX } from '../src/attach.ts';

const bytes = (path: string) => Buffer.from(`bytes of ${path}`);
const arg = (f: Partial<{ path: string; name: string; mime: string; size: number }>) => attachmentArg({ path: '/spool/f4248a5e', name: 'x', mime: 'image/png', size: 10, ...f }, bytes);
const parts = (uri: string) => /^data:([^;,]+)(?:;filename=([^;,]*))?;base64,(.*)$/s.exec(uri)!;

test('a GIF that is really a WebP goes as a WebP under its own name, not as the spool file', () => {
  const [, type, name, data] = parts(arg({ name: 'waving-lizard.webp', mime: 'image/webp' }));
  expect([type, decodeURIComponent(name), Buffer.from(data, 'base64').toString()]).toEqual(['image/webp', 'waving-lizard.webp', 'bytes of /spool/f4248a5e']);
});

test('a name keeps its spaces and punctuation, URL-encoded so ; , and = stay inside it, with no path or control characters', () => {
  expect(decodeURIComponent(parts(arg({ name: 'lease; final, v=2.pdf' }))[2])).toBe('lease; final, v=2.pdf');
  expect(parts(arg({ name: 'lease; final, v=2.pdf' }))[2]).not.toMatch(/[;,=]/);
  expect(decodeURIComponent(parts(arg({ name: '../../etc/pass\nwd' }))[2])).toBe('.._.._etc_pass_wd');
  expect(arg({ name: '' })).toStartWith('data:image/png;base64,');
});

test('a type that is not one goes as opaque bytes', () => {
  for (const mime of ['', 'image', 'text/html;x=1', 'a b/c', 'image/png\r\nx: y']) expect(parts(arg({ mime }))[1]).toBe('application/octet-stream');
  expect(parts(arg({ mime: 'IMAGE/PNG' }))[1]).toBe('image/png');
});

test('a file too big to ride in the request goes by its path', () => {
  expect(arg({ size: DATA_URI_MAX + 1 })).toBe('/spool/f4248a5e');
  expect(arg({ size: DATA_URI_MAX })).toStartWith('data:');
  expect(arg({ size: Number.NaN })).toBe('/spool/f4248a5e');
});
