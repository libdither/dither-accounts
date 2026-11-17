/**
 * Stickers, GIFs and voice messages going out (src/media.ts): the pickers' pages in hub terms, and when a file is a
 * voice message.
 */
import { describe, expect, test } from 'bun:test';
import { GIF_MOST, GIF_STEP, gifLimitOf, gifPageOf, stickerPageOf, voiceOut } from '../src/media.ts';

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

describe('the GIF page', () => {
  const gif = (n: number) => ({ id: `k${n}`, url: `https://klipy.example/gifs/${n}`, src: `//media.example/${n}.webm`, gif_src: `//media.example/${n}.gif`, width: 200, height: 100 });
  const many = (n: number) => Array.from({ length: n }, (_, i) => gif(i));

  test('each GIF with its page link, https pictures and title; one with no link or picture is left out', () => {
    const page = gifPageOf({ gifs: [{ ...gif(1), title: ' Cat waves ' }, { ...gif(2), src: 'https://media.example/2.mp4', gif_src: undefined }, { ...gif(3), url: '' }, { ...gif(4), src: 'data:x' }] }, GIF_STEP);
    expect(page.gifs).toEqual([
      { id: 'k1', url: 'https://klipy.example/gifs/1', src: 'https://media.example/1.webm', gif: 'https://media.example/1.gif', width: 200, height: 100, title: 'Cat waves' },
      { id: 'k2', url: 'https://klipy.example/gifs/2', src: 'https://media.example/2.mp4', width: 200, height: 100 },
    ]);
    expect(page.next).toBeNull();
  });

  test('pages are the next limit: a full page asks for more and keeps only the new tail', () => {
    expect(gifLimitOf(undefined)).toBe(GIF_STEP);
    const first = gifPageOf({ gifs: many(GIF_STEP) }, GIF_STEP);
    expect(first.gifs).toHaveLength(GIF_STEP);
    expect(first.next).toBe(String(GIF_STEP * 2));
    const limit = gifLimitOf(first.next!);
    expect(limit).toBe(GIF_STEP * 2);
    const second = gifPageOf({ gifs: many(limit - 7) }, limit);
    expect(second.gifs.map((g) => g.id)).toEqual(many(limit - 7).slice(GIF_STEP).map((g) => g.id));
    // Fewer than asked: the end.
    expect(second.next).toBeNull();
    // Never past GIF_MOST, whatever the cursor says.
    expect(gifLimitOf('100000')).toBe(GIF_MOST);
    expect(gifLimitOf('nonsense')).toBe(GIF_STEP);
    expect(gifPageOf({ gifs: many(GIF_MOST) }, GIF_MOST).next).toBeNull();
  });

  test("the hook's note comes through", () => {
    expect(gifPageOf({ gifs: [], note: 'The Discord client has not loaded yet.' }, GIF_STEP)).toEqual({ gifs: [], next: null, note: 'The Discord client has not loaded yet.' });
    expect(gifPageOf(null, GIF_STEP)).toEqual({ gifs: [], next: null });
  });
});
