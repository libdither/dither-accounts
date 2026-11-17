/**
 * Kinds of message beyond text and files (docs/media-kinds.md): stickers sent from a picker, GIFs, voice messages
 * recorded in the composer, view-once files, and Signal stories. All additive: an adapter says it has each with a capability,
 * and the hub and the app offer it only then.
 */
import type { AttachmentFact, MediaUrl } from './adapter.ts';
import type { AttachmentView } from './api.ts';

export type MediaCapability =
  /** Lists the stickers this account may send here (the `stickers` command) and sends one (`send`'s `sticker`). */
  | 'sendStickers'
  /** Installs a sticker pack from its link (the `addStickerPack` command): Signal's signal.art links. */
  | 'installStickers'
  /**
   * Searches GIFs through the network's own GIF picker (the `gifs` command): Discord's, which asks its provider for the
   * account. The results can be sent anywhere: on Discord as their link, elsewhere as a file.
   */
  | 'searchGifs'
  /**
   * Sends a file as the network's own GIF (an OutgoingAttachment with `gif`): Telegram's animation, WhatsApp's GIF
   * playback. Without it, a GIF goes as an ordinary file.
   */
  | 'sendGifs'
  /**
   * Sends a recorded file as the network's own voice message (`send` with one attachment carrying `voice`): Discord's
   * voice message with its waveform, Signal's voice note. Without it, a recording goes as an ordinary audio file.
   */
  | 'sendVoice'
  /** Sends files to be opened once (`send`'s `viewOnce`): Signal's view-once. */
  | 'sendViewOnce'
  /**
   * Has stories behind its own setting (the account action STORIES_ACTION): with it on, the story events, and
   * `storyViewed` and `storyReply`.
   */
  | 'stories';

// ------------------------------------------------------------------ stickers

/** Where a pack comes from: a server's own stickers, the network's standard packs, or packs installed on the account. */
export type StickerSource = 'server' | 'standard' | 'installed';

export interface StickerFact {
  /** What `send`'s `sticker` takes: Discord's sticker id; Signal's `packId:stickerId`. */
  id: string;
  name: string;
  /** The emoji it stands for, where the network names one. */
  emoji?: string;
  url: MediaUrl;
  mime?: string;
}

export interface StickerPackFact {
  id: string;
  name: string;
  source: StickerSource;
  /** Its cover, else the first sticker's picture. */
  cover?: MediaUrl;
  stickers: StickerFact[];
}

/**
 * The `stickers` command's reply: one page of packs this account may send in the conversation, nothing it may not
 * (Discord's own rule: a server's stickers outside it need Nitro, and the server's permission to use outside stickers).
 */
export interface StickerPage {
  packs: StickerPackFact[];
  /** Pass as `cursor` for the next page; null at the end. */
  next: string | null;
  /** Why there are none, or a limit worth knowing ("Stickers from other servers need Nitro"). Shown in the picker. */
  note?: string;
}

/** As the app gets them: the hub's own picture addresses. */
export interface StickerView extends Omit<StickerFact, 'url'> {
  url: string;
}
export interface StickerPackView extends Omit<StickerPackFact, 'cover' | 'stickers'> {
  cover: string | null;
  stickers: StickerView[];
}

/** GET /api/conversations/:id/stickers?account=&cursor= */
export interface StickerPageView {
  accountId: string | null;
  packs: StickerPackView[];
  next: string | null;
  note?: string;
  /** This account installs packs from a link (capability 'installStickers'). */
  canInstall: boolean;
}

/** Packs in one page of the `stickers` reply. */
export const STICKER_PAGE_PACKS = 8;

/** A signal.art sticker pack link, the only kind `addStickerPack` takes: its pack id and key, or null. */
export function signalStickerLink(s: string): { packId: string; packKey: string } | null {
  const m = /^https:\/\/signal\.art\/addstickers\/#(.+)$/.exec(s.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const packId = q.get('pack_id') ?? '';
  const packKey = q.get('pack_key') ?? '';
  return /^[0-9a-f]{32}$/i.test(packId) && /^[0-9a-f]{64}$/i.test(packKey) ? { packId: packId.toLowerCase(), packKey: packKey.toLowerCase() } : null;
}

// ------------------------------------------------------------------ GIFs

/** One GIF from the network's GIF picker (the `gifs` command). */
export interface GifFact {
  /** The provider's id for it. */
  id: string;
  /** Its page link: what Discord's own picker sends as the message, and what Discord draws back as the GIF. */
  url: string;
  /** It as a looping video (webm or mp4), what the picker shows. */
  src: MediaUrl;
  /** It as a .gif file, where the provider has one: what goes to a network that takes no GIF links. */
  gif?: MediaUrl;
  width: number;
  height: number;
  /** Its words, where the provider gives some: the alt text. */
  title?: string;
}

/** The `gifs` command's reply: one page of results, trending ones without a query. */
export interface GifPage {
  gifs: GifFact[];
  /** Pass as `cursor` for more; null at the end. */
  next: string | null;
  /** Why there are none ("The Discord client has not loaded yet"). */
  note?: string;
}

/** As the app gets them: the hub's own addresses, so the page never loads the provider's. */
export interface GifView extends Omit<GifFact, 'src' | 'gif'> {
  src: string;
  gif: string | null;
}

/**
 * GET /api/gifs?q=&cursor=&conversation=: through the conversation's account where it searches GIFs, else any
 * connected account that does. `accountId` null: none can.
 */
export interface GifPageView {
  accountId: string | null;
  gifs: GifView[];
  next: string | null;
  note?: string;
}

/**
 * GET /api/gifs/yours?before=: GIFs already in your chats, sent or received, newest first, one each. `src` is the
 * picture or video to show; `url` is the link a Discord GIF came as, else null.
 */
export interface YourGif {
  /** The message it came in. */
  messageId: string;
  ts: number;
  url: string | null;
  src: string;
  mime: string;
  width: number | null;
  height: number | null;
}
export interface YourGifsView {
  gifs: YourGif[];
  /** Pass as `before` for older ones; null at the end. */
  next: number | null;
}

// ------------------------------------------------------------------ voice messages

/**
 * A recorded voice message: its length and Discord's waveform (base64 of up to 256 bytes, one each tenth of a second,
 * 0 to 255). Put on the send's one attachment.
 */
export interface VoiceOut {
  seconds: number;
  waveform?: string;
}

/** Longest recording the composer takes, in seconds (Discord's own limit is 20 minutes; this is a phone-sized one). */
export const VOICE_MAX_SECONDS = 10 * 60;
/** Points in a waveform, at most (Discord's). */
export const WAVEFORM_POINTS = 256;

/** Waveform points (0 to 1 each) as Discord's base64: at most WAVEFORM_POINTS, averaged down when there are more. */
export function waveformBase64(points: number[]): string {
  const n = Math.min(points.length, WAVEFORM_POINTS);
  const bytes: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * points.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * points.length) / n));
    let sum = 0;
    for (let j = from; j < to; j++) sum += points[j];
    bytes.push(Math.max(0, Math.min(255, Math.round((sum / (to - from)) * 255))));
  }
  return btoa(String.fromCharCode(...bytes));
}

// ------------------------------------------------------------------ stories

/** Signal keeps a story for a day. */
export const STORY_LIFETIME_MS = 24 * 60 * 60_000;

/** A text story's look, as Signal sends it: colours as CSS hex. */
export interface StoryTextFact {
  text: string;
  /** Signal's font style: 'DEFAULT', 'REGULAR', 'BOLD', 'SERIF', 'SCRIPT', 'CONDENSED'. */
  style?: string;
  color?: string;
  /** Behind the text only. */
  textBackground?: string;
  background?: string;
  /** Background gradient, from the first colour to the last, at `angle` degrees. */
  gradient?: { colors: string[]; angle?: number };
  /** A link the story shows. */
  url?: string;
}

/**
 * Someone's story (the `story` event, capability 'stories'). Never a message: it shows on its author's or group's
 * page only, never in the inbox, never alerts, and is gone at `expiresAt`.
 */
export interface StoryFact {
  /** Signal: "<authorAci>:<sentTimestamp>". */
  nativeId: string;
  author: string;
  /** A group story's group conversation; absent for one sent to its author's contacts. */
  conversation?: string;
  ts: number;
  expiresAt: number;
  /** A picture or video story. */
  attachment?: AttachmentFact;
  text?: StoryTextFact;
  /** Its author lets people reply (and react). */
  allowsReplies: boolean;
}

/** A story as the app gets it (GET /api/stories?identity= or ?conversation=). */
export interface StoryView {
  id: string;
  accountId: string;
  authorId: string;
  conversationId: string | null;
  ts: number;
  expiresAt: number;
  attachment: AttachmentView | null;
  text: StoryTextFact | null;
  allowsReplies: boolean;
  /** Opened here already. */
  viewed: boolean;
}

/**
 * The account action that reads or changes the stories setting: args `{ on?: boolean }`, result StoriesSetting.
 * Off unless turned on. A change takes effect the next time the network's process starts (Signal: its daemon), which
 * the action does not force.
 */
export const STORIES_ACTION = 'stories';

export interface StoriesSetting {
  on: boolean;
  /** Stories are coming in now: the process running was started with the setting on. */
  running: boolean;
}

/** Adapter commands for the capabilities above. */
export type MediaCommand =
  /** One page of stickers this account may send in `conversation` (capability 'sendStickers'). reply.result: StickerPage. */
  | { t: 'stickers'; id: string; conversation: string; cursor?: string }
  /** Install the pack a link names (capability 'installStickers'). reply.result: { pack: StickerPackFact }. */
  | { t: 'addStickerPack'; id: string; uri: string }
  /**
   * One page of GIFs (capability 'searchGifs'): trending ones without `query`, else what it finds. reply.result:
   * GifPage.
   */
  | { t: 'gifs'; id: string; query?: string; cursor?: string }
  /**
   * You opened someone's story (capability 'stories'): tell them where the network's rules allow (Signal: with read
   * receipts on, and never for a story from someone whose message request waits). reply.result: { sent: boolean }.
   */
  | { t: 'storyViewed'; id: string; story: string }
  /**
   * Reply to a story, or react to it with `emoji` (capability 'stories'). The reply goes where the network puts it: the
   * author's direct conversation, or the group of a group story. reply.result: { nativeId } of the reply.
   */
  | { t: 'storyReply'; id: string; story: string; conversation?: string; body?: string; emoji?: string };

/** Adapter events for them. */
export type MediaEvent =
  /** A story came in (capability 'stories'), or one you posted from your phone. */
  | { t: 'story'; story: StoryFact }
  /** Its author deleted it. */
  | { t: 'storyGone'; nativeId: string };
