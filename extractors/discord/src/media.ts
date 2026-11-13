/**
 * Stickers and voice messages going out (the app's docs/media-kinds.md): the sticker picker's page from what the hook
 * read in the client's stores, and a recording as Discord's own voice message.
 */
import type * as P from '@dither-chat/protocol';
import type { RawStickerPage } from './discord-types.ts';
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
