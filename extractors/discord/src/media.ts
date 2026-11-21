/**
 * Stickers, GIFs and voice messages going out (the app's docs/media-kinds.md): the sticker picker's page from what the
 * hook read in the client's stores, the GIF picker's results, and a recording as Discord's own voice message.
 */
import type * as P from '@dither-chat/protocol';
import type { RawGifPage, RawStickerPage } from './discord-types.ts';
import { stickerAsset } from './map.ts';

/** The page as the hub takes it: each sticker's picture where Discord's client draws it from. */
export function stickerPageOf(r: RawStickerPage): P.StickerPage {
  const packs: P.StickerPackFact[] = [];
  for (const p of r?.packs ?? []) {
    const stickers: P.StickerFact[] = [];
    for (const st of p.stickers ?? []) {
      const a = stickerAsset({ id: st.id, name: st.name, format_type: st.format_type });
      // Tags name the emoji a sticker stands for; only an emoji itself is kept, not a name like "smile".
      const emoji = st.tags?.split(',')[0].trim();
      if (a) stickers.push({ id: st.id, name: st.name, url: a.url, mime: a.mime, ...(emoji && /^\p{Extended_Pictographic}/u.test(emoji) ? { emoji } : {}) });
    }
    if (!stickers.length) continue;
    const cover = p.cover ? stickers.find((x) => x.id === p.cover)?.url : undefined;
    packs.push({ id: p.id, name: p.name, source: p.source, ...(cover ? { cover } : {}), stickers });
  }
  return { packs, next: r?.next == null ? null : String(r.next), ...(r?.note ? { note: r.note } : {}) };
}

/**
 * GIF pages. The client's picker asks for a `limit` and has no offset, so a page is the next limit: the first asks for
 * GIF_STEP results, the next for twice as many and keeps only the new tail, and so on up to GIF_MOST.
 */
export const GIF_STEP = 50;
export const GIF_MOST = 200;

/** How many results to ask the picker for, from the `gifs` command's cursor (the limit the last page said to ask). */
export function gifLimitOf(cursor: string | undefined): number {
  const n = Math.floor(Number(cursor ?? GIF_STEP));
  return Number.isFinite(n) && n > 0 ? Math.min(GIF_MOST, Math.max(GIF_STEP, Math.ceil(n / GIF_STEP) * GIF_STEP)) : GIF_STEP;
}

/** The picker sends some links without a scheme ("//media..."), as its own store strips them: https here. */
const https = (u: unknown): string | null => {
  if (typeof u !== 'string' || !u) return null;
  if (u.startsWith('//')) return `https:${u}`;
  return /^https?:\/\//i.test(u) ? u : null;
};

/** The page as the hub takes it: the results past the last page's limit, and a cursor while a full page came back. */
export function gifPageOf(r: RawGifPage | null | undefined, asked: number): P.GifPage {
  const list = Array.isArray(r?.gifs) ? r.gifs : [];
  const gifs: P.GifFact[] = [];
  for (const g of list.slice(asked - GIF_STEP)) {
    const src = https(g?.src);
    if (!g || !src || typeof g.url !== 'string' || !g.url) continue;
    const gif = https(g.gif_src);
    const title = typeof g.title === 'string' ? g.title.trim() : '';
    gifs.push({ id: String(g.id ?? g.url), url: g.url, src, ...(gif ? { gif } : {}), width: Number(g.width) || 0, height: Number(g.height) || 0, ...(title ? { title } : {}) });
  }
  const next = list.length >= asked && asked < GIF_MOST ? String(asked + GIF_STEP) : null;
  return { gifs, next, ...(r?.note ? { note: r.note } : {}) };
}

/**
 * A send's one recording as Discord's voice message: an Ogg Opus file (what Discord takes as one) with its length and
 * waveform. Anything else goes as the file it is.
 */
export function voiceOut(files: P.OutgoingAttachment[] | undefined): { duration_secs: number; waveform: string } | null {
  if (files?.length !== 1) return null;
  const f = files[0];
  if (!f.voice || !/^audio\/ogg\b/.test(f.mime)) return null;
  const seconds = Number(f.voice.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // The client always sends a waveform; a flat one when the recording had none.
  return { duration_secs: Math.round(seconds * 100) / 100, waveform: f.voice.waveform || btoa(String.fromCharCode(...new Array(Math.min(256, Math.max(1, Math.round(seconds * 10)))).fill(0))) };
}
