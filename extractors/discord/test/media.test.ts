/** Stickers and voice messages going out (src/media.ts): the picker's page in hub terms, and when a file is a voice message. */
import { describe, expect, test } from 'bun:test';
import { stickerPageOf, voiceOut } from '../src/media.ts';

describe('the sticker page', () => {
  test("each sticker's picture where the client draws it from; its emoji only when the tag is one", () => {
    const page = stickerPageOf({
      packs: [
        {
          id: 'g1',
          name: 'Pixel',
          source: 'server',
          stickers: [
            { id: '101', name: 'wave', format_type: 1, tags: '👋' },
            { id: '102', name: 'dance', format_type: 3, tags: 'dancer' },
            { id: '103', name: 'gif', format_type: 4 },
          ],
        },
        { id: 'p1', name: 'Wumpus', source: 'standard', cover: '201', stickers: [{ id: '201', name: 'hi', format_type: 2 }] },
        { id: 'empty', name: 'None', source: 'standard', stickers: [] },
      ],
      next: 2,
      note: 'Stickers from other servers need Nitro.',
    });
    expect(page.next).toBe('2');
    expect(page.note).toBe('Stickers from other servers need Nitro.');
    expect(page.packs.map((p) => p.id)).toEqual(['g1', 'p1']);
    expect(page.packs[0].stickers).toEqual([
      { id: '101', name: 'wave', url: 'https://cdn.discordapp.com/stickers/101.png', mime: 'image/png', emoji: '👋' },
      { id: '102', name: 'dance', url: 'https://cdn.discordapp.com/stickers/102.json', mime: 'application/x-lottie+json' },
      { id: '103', name: 'gif', url: 'https://media.discordapp.net/stickers/103.gif', mime: 'image/gif' },
    ]);
    expect(page.packs[1].cover).toBe('https://cdn.discordapp.com/stickers/201.png');
    expect(stickerPageOf({ packs: [], next: null }).next).toBeNull();
  });
});

describe('a voice message', () => {
  const file = { path: '/x', name: 'rec.ogg', mime: 'audio/ogg', size: 10, kind: 'audio' as const };
  test('one Ogg file marked as a recording, with its length and waveform', () => {
    expect(voiceOut([{ ...file, voice: { seconds: 2.345, waveform: 'AAEC' } }])).toEqual({ duration_secs: 2.35, waveform: 'AAEC' });
    // No waveform: a flat one, a point each tenth of a second.
    expect(atob(voiceOut([{ ...file, voice: { seconds: 0.5 } }])!.waveform)).toBe('\0\0\0\0\0');
  });
  test('anything else is the file it is', () => {
    expect(voiceOut([file])).toBeNull();
    expect(voiceOut([{ ...file, mime: 'audio/webm', voice: { seconds: 2 } }])).toBeNull();
    expect(voiceOut([{ ...file, voice: { seconds: 2 } }, file])).toBeNull();
    expect(voiceOut(undefined)).toBeNull();
  });
});
