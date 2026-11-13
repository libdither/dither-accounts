/** vCard 3.0 and 4.0 ↔ Contact (extractors/dav/src/vcard.ts): reading what servers and phones write, and changing only what a change names. */
import { expect, test } from 'bun:test';
import { contactFrom, writeContact } from '../extractors/dav/src/vcard.ts';

const ctx = { bookId: 'b', id: 'x.vcf', etag: '"e"' };
const card = (...lines: string[]) => ['BEGIN:VCARD', ...lines, 'END:VCARD'].join('\r\n');

test('an Apple-style 3.0 card: groups and labels, a birthday without a year, an inline photo', () => {
  const c = contactFrom(
    card(
      'VERSION:3.0',
      'PRODID:-//Apple Inc.//iPhone OS 18.0//EN',
      'UID:3F2504E0-4F89-11D3-9A0C-0305E82C3301',
      'N:Lovelace;Ada;King;Countess;',
      'FN:Ada Lovelace',
      'NICKNAME:Ada',
      'ORG:Analytical Engines;Research',
      'TITLE:Mathematician',
      'item1.EMAIL;type=INTERNET;type=pref:ada@example.com',
      'item1.X-ABLabel:_$!<Other>!$_',
      'EMAIL;type=INTERNET;type=WORK:ada@work.example',
      'TEL;type=CELL;type=VOICE;type=pref:+44 20 7946 0000',
      'item2.ADR;type=HOME;type=pref:;;12 St James\'s Square;London;;SW1Y 4JH;United Kingdom',
      'BDAY;X-APPLE-OMIT-YEAR=1604:1604-12-10',
      'URL:https://example.com/ada',
      'NOTE:First programmer\\, arguably',
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==',
      'REV:2026-11-01T10:00:00Z',
    ),
    ctx,
  );
  expect(c).toMatchObject({
    uid: '3F2504E0-4F89-11D3-9A0C-0305E82C3301',
    name: { full: 'Ada Lovelace', given: 'Ada', family: 'Lovelace' },
    nickname: 'Ada',
    org: 'Analytical Engines, Research',
    title: 'Mathematician',
    emails: [
      { value: 'ada@example.com', type: 'other' },
      { value: 'ada@work.example', type: 'work' },
    ],
    phones: [{ value: '+44 20 7946 0000', type: 'cell' }],
    addresses: [{ value: "12 St James's Square, London, SW1Y 4JH, United Kingdom", type: 'home' }],
    birthday: '--12-10',
    urls: ['https://example.com/ada'],
    note: 'First programmer, arguably',
    photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    updated: Date.UTC(2026, 10, 1, 10),
    etag: '"e"',
  });
});

test('a 4.0 card: tel: URIs, a date birthday, a photo URL', () => {
  const c = contactFrom(card('VERSION:4.0', 'UID:urn:uuid:1', 'FN:Grace Hopper', 'N:Hopper;Grace;;;', 'TEL;VALUE=uri;TYPE=work:tel:+1-555-0100', 'BDAY:19061209', 'PHOTO:https://example.com/g.jpg', 'EMAIL;TYPE=home:grace@example.com'), ctx);
  expect(c).toMatchObject({ uid: 'urn:uuid:1', phones: [{ value: '+1-555-0100', type: 'work' }], birthday: '1906-12-09', photo: 'https://example.com/g.jpg', emails: [{ value: 'grace@example.com', type: 'home' }] });
});

test('a new card is 3.0 with the fields, and reads back the same', () => {
  const { text, uid } = writeContact(null, {
    uid: 'new-1',
    name: { full: null, given: 'Alan', family: 'Turing' },
    emails: [{ value: 'alan@example.com', type: 'work' }],
    phones: [{ value: '+44 161 000 0000', type: 'cell' }],
    addresses: [{ value: 'Bletchley Park, Milton Keynes', type: 'work' }],
    org: 'GC&CS',
    birthday: '--06-23',
    note: 'Two lines\nof note',
    photo: 'data:image/png;base64,iVBORw0KGgo=',
    urls: ['https://example.com/alan'],
  });
  expect(uid).toBe('new-1');
  expect(text).toContain('VERSION:3.0');
  expect(text).toContain('FN:Alan Turing');
  const c = contactFrom(text, ctx);
  expect(c).toMatchObject({
    uid: 'new-1',
    name: { full: 'Alan Turing', given: 'Alan', family: 'Turing' },
    emails: [{ value: 'alan@example.com', type: 'work' }],
    phones: [{ value: '+44 161 000 0000', type: 'cell' }],
    addresses: [{ value: 'Bletchley Park, Milton Keynes', type: 'work' }],
    org: 'GC&CS',
    birthday: '--06-23',
    note: 'Two lines\nof note',
    photo: 'data:image/png;base64,iVBORw0KGgo=',
    urls: ['https://example.com/alan'],
  });
  expect(c.updated).toBeGreaterThan(Date.now() - 60_000);
});

test('a change touches only its fields; the rest of the card stays', () => {
  const base = card('VERSION:3.0', 'UID:u1', 'N:Doe;Jane;;;', 'FN:Jane Doe', 'item1.EMAIL:jane@old.example', 'item1.X-ABLabel:Old', 'X-CUSTOM:keep me', 'TEL:+1 555 0101');
  const { text } = writeContact(base, { emails: [{ value: 'jane@new.example', type: 'home' }], birthday: '1990-02-03' });
  expect(text).toContain('X-CUSTOM:keep me');
  expect(text).not.toContain('X-ABLabel');
  const c = contactFrom(text, ctx);
  expect(c).toMatchObject({ name: { full: 'Jane Doe', given: 'Jane', family: 'Doe' }, emails: [{ value: 'jane@new.example', type: 'home' }], phones: [{ value: '+1 555 0101', type: null }], birthday: '1990-02-03' });
  expect(() => writeContact(base, { uid: 'other' })).toThrow('uid cannot change');
  expect(() => writeContact(base, { birthday: 'tomorrow' })).toThrow('birthday');
  // A whole vCard is used as it is.
  const whole = card('VERSION:4.0', 'UID:u1', 'FN:Whole', 'N:;Whole;;;');
  expect(writeContact(base, { vcard: whole }).text).toContain('FN:Whole');
});
