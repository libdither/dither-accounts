/** Which types an encrypted room's media is served as (e2ee.ts safeMediaType): pictures, a JPEG XL among them, but never markup. */
import { expect, test } from 'bun:test';
import { safeMediaType } from '../src/e2ee.ts';

test('pictures, video, audio, plain text and PDF keep their type; markup and the unknown are bytes', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/avif', 'image/jxl', 'video/mp4', 'audio/ogg', 'application/pdf']) expect(safeMediaType(t)).toBe(t);
  expect(safeMediaType('Image/JXL; charset=x')).toBe('image/jxl');
  for (const t of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'image/x-unknown', 42]) expect(safeMediaType(t)).toBe('application/octet-stream');
});
