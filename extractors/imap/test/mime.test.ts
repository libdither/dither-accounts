/**
 * The message the imap kind's mail.send builds (extractors/imap/src/smtp.ts composeMessage): files with a contentId
 * go as inline parts in a multipart/related with the HTML, the rest stay ordinary attachments. No servers: the raw
 * message is read back part by part as text, and with mailparser.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutgoingFile, OutgoingMail } from '@dither-accounts/interfaces';
import { simpleParser } from 'mailparser';
import { composeMessage, outgoingFile } from '../src/smtp.ts';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-imap-mime-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const msg = (over: Partial<OutgoingMail> = {}): OutgoingMail => ({
  to: [{ name: 'Bob', email: 'bob@example.test' }],
  subject: 'Garden',
  text: 'See the sketch.',
  html: '<p>See the sketch: <img src="cid:sketch.1@garden"></p>',
  ...over,
});
const build = (m: OutgoingMail) =>
  composeMessage({ msg: m, from: { name: 'Ann Lee', address: 'ann@example.test' }, files: (m.attachments ?? []).map((a, i) => outgoingFile(a, i, dir)), messageId: '<m1@example.test>', date: new Date(Date.UTC(2026, 0, 2)) }, false);

/** Each part's Content-Type and its nesting depth, in order (boundaries followed by hand). */
function tree(raw: string): { depth: number; type: string; headers: string }[] {
  const out: { depth: number; type: string; headers: string }[] = [];
  const walk = (text: string, depth: number) => {
    const split = text.search(/\r\n\r\n/);
    const headers = text.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
    const body = text.slice(split + 4);
    const type = /^content-type:\s*([^;\r\n]+)/im.exec(headers)?.[1]?.trim().toLowerCase() ?? 'text/plain';
    out.push({ depth, type, headers });
    const boundary = /boundary="?([^";\r\n]+)"?/i.exec(headers)?.[1];
    if (!type.startsWith('multipart/') || !boundary) return;
    const parts = body.split(`--${boundary}`).slice(1, -1);
    for (const p of parts) walk(p.replace(/^\r\n/, ''), depth + 1);
  };
  walk(raw, 0);
  return out;
}

describe('imap mail.send MIME', () => {
  test('a file with a contentId is an inline part in a multipart/related with the HTML; a plain file stays an attachment around it', async () => {
    const raw = await build(
      msg({
        attachments: [
          { filename: 'sketch.png', mime: 'image/png', base64: PNG.toString('base64'), contentId: 'sketch.1@garden' },
          { filename: 'plan.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4 plan').toString('base64') },
        ],
      }),
    );
    const parts = tree(raw.toString());
    expect(parts.map((p) => [p.depth, p.type])).toEqual([
      [0, 'multipart/mixed'],
      [1, 'multipart/alternative'],
      [2, 'text/plain'],
      [2, 'multipart/related'],
      [3, 'text/html'],
      [3, 'image/png'],
      [1, 'application/pdf'],
    ]);
    const png = parts.find((p) => p.type === 'image/png')!.headers;
    expect(png).toMatch(/^content-id: <sketch\.1@garden>$/im);
    expect(png).toMatch(/^content-disposition: inline; filename=sketch\.png$/im);
    const pdf = parts.find((p) => p.type === 'application/pdf')!.headers;
    expect(pdf).toMatch(/^content-disposition: attachment; filename=plan\.pdf$/im);
    expect(pdf).not.toMatch(/^content-id:/im);

    const p = await simpleParser(raw, { keepCidLinks: true });
    expect(p.html).toContain('cid:sketch.1@garden');
    expect(p.attachments.map((a) => [a.filename, a.contentDisposition, a.cid ?? null, a.related ?? false, a.content.toString('base64')])).toEqual([
      ['sketch.png', 'inline', 'sketch.1@garden', true, PNG.toString('base64')],
      ['plan.pdf', 'attachment', null, false, Buffer.from('%PDF-1.4 plan').toString('base64')],
    ]);
  });

  test('an inline part that is not a picture is inline too; HTML alone makes multipart/related the top', async () => {
    const raw = await build(msg({ text: undefined, attachments: [{ filename: 'note.txt', mime: 'text/plain', base64: Buffer.from('hi').toString('base64'), contentId: 'note-1' }] }));
    const parts = tree(raw.toString());
    expect(parts.map((p) => [p.depth, p.type])).toEqual([
      [0, 'multipart/related'],
      [1, 'text/html'],
      [1, 'text/plain'],
    ]);
    expect(parts[2]!.headers).toMatch(/^content-id: <note-1>$/im);
    expect(parts[2]!.headers).toMatch(/^content-disposition: inline; filename=note\.txt$/im);
  });

  test('without a contentId, files are attachments as before', async () => {
    const raw = await build(msg({ html: '<p>Plan attached.</p>', attachments: [{ filename: 'plan.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF').toString('base64') }] }));
    const parts = tree(raw.toString());
    expect(parts.map((p) => [p.depth, p.type])).toEqual([
      [0, 'multipart/mixed'],
      [1, 'multipart/alternative'],
      [2, 'text/plain'],
      [2, 'text/html'],
      [1, 'application/pdf'],
    ]);
    expect(raw.toString()).not.toMatch(/^content-id:/im);
    expect(parts[4]!.headers).toMatch(/^content-disposition: attachment; filename=plan\.pdf$/im);
  });

  test('a contentId is checked: angle brackets, spaces, quotes, empty or too long are refused (400)', () => {
    const file = (contentId: unknown) => ({ filename: 'p.png', mime: 'image/png', base64: 'AQID', contentId }) as OutgoingFile;
    for (const bad of ['<pic@x>', 'pic one', 'pic"1', '', 'a'.repeat(201), 7, null])
      expect(() => outgoingFile(file(bad), 0, dir)).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('attachment 1: contentId') }));
    expect(outgoingFile(file('a_b.c-d@e'), 0, dir)).toMatchObject({ contentId: 'a_b.c-d@e' });
    expect(outgoingFile({ filename: 'p.png', mime: 'image/png', base64: 'AQID' }, 0, dir)).not.toHaveProperty('contentId');
  });
});
