/**
 * What a Discord message carries beyond its text, files and plain embeds, as dither-chat's protocol has it
 * (chat-protocol rich.ts; dither-chat docs/rich-messages.md). Pure functions, as map.ts: test/rich.test.ts drives them.
 *
 * - Message flags: sent silently (SUPPRESS_NOTIFICATIONS), only you can see it (EPHEMERAL), previews hidden
 *   (SUPPRESS_EMBEDS), a crosspost, the server's own, a suspended author.
 * - Components: a bot's rows of buttons and selects, kept with their custom ids for a later `interact`; and
 *   Components V2 messages (IS_COMPONENTS_V2), which have no content and no embeds, flattened into text and files.
 * - The roles the text names, with names, and whether one you hold was pinged.
 * - The command a bot answers ("X used /cmd"), an activity invite.
 * - Attachments' alt text, spoiler and explicit flags, and a voice message's length and waveform.
 * - Embeds in full: colour, footer, timestamp, author icon, video.
 * - System message types map.ts leaves generic or names wrongly.
 */

import type * as P from '@dither-chat/protocol';
import type { RawAttachment, RawComponent, RawEmbed, RawMessage } from './discord-types.ts';

/** https://docs.discord.food/resources/message#message-flags */
export const MESSAGE_FLAG = {
  CROSSPOSTED: 1 << 0,
  IS_CROSSPOST: 1 << 1,
  SUPPRESS_EMBEDS: 1 << 2,
  EPHEMERAL: 1 << 6,
  SUPPRESS_NOTIFICATIONS: 1 << 12,
  IS_VOICE_MESSAGE: 1 << 13,
  IS_COMPONENTS_V2: 1 << 15,
  HIDDEN_SUSPENDED_USER: 1 << 17,
  IS_GUILD_OFFICIAL: 1 << 19,
} as const;

/** https://docs.discord.food/resources/message#attachment-flags */
export const ATTACHMENT_FLAG = { IS_SPOILER: 1 << 3, CONTAINS_EXPLICIT_MEDIA: 1 << 4 } as const;

/** https://docs.discord.food/resources/components#component-type */
export const COMPONENT = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
  USER_SELECT: 5,
  ROLE_SELECT: 6,
  MENTIONABLE_SELECT: 7,
  CHANNEL_SELECT: 8,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  MEDIA_GALLERY: 12,
  FILE: 13,
  SEPARATOR: 14,
  CONTAINER: 17,
} as const;

const has = (flags: number | undefined, f: number) => ((flags ?? 0) & f) !== 0;
export const sentSilently = (m: RawMessage) => has(m.flags, MESSAGE_FLAG.SUPPRESS_NOTIFICATIONS);
export const isCrosspost = (m: RawMessage) => has(m.flags, MESSAGE_FLAG.IS_CROSSPOST);

// --------------------------------------------------------------- components

const BUTTON_STYLE: Record<number, P.ButtonStyle> = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link', 6: 'premium' };
const SELECT_KIND: Record<number, P.SelectKind> = { 3: 'string', 5: 'user', 6: 'role', 7: 'mentionable', 8: 'channel' };

/** A component's emoji as body Markdown: a Unicode one as it is, a custom one as <:name:id>. */
function emojiText(e: RawComponent['emoji']): string | undefined {
  if (!e) return undefined;
  if (e.id && /^\d+$/.test(e.id)) return `<${e.animated ? 'a' : ''}:${(e.name || 'emoji').replace(/[^\w]/g, '_')}:${e.id}>`;
  return e.name || undefined;
}

const httpUrl = (u: unknown) => (typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 2048 ? u : undefined);
const text = (s: unknown, max = 200) => (typeof s === 'string' && s ? s.slice(0, max) : undefined);

function control(c: RawComponent): P.ComponentFact | null {
  if (c.type === COMPONENT.BUTTON) {
    const style = BUTTON_STYLE[c.style ?? 2] ?? 'secondary';
    const b: P.ButtonFact = { kind: 'button', style };
    if (c.custom_id) b.id = c.custom_id;
    const label = text(c.label, 80);
    if (label) b.label = label;
    const emoji = emojiText(c.emoji);
    if (emoji) b.emoji = emoji;
    const url = httpUrl(c.url);
    if (url) b.url = url;
    if (c.disabled) b.disabled = true;
    return b.label || b.emoji ? b : null;
  }
  const kind = SELECT_KIND[c.type];
  if (!kind) return null;
  const s: P.SelectFact = { kind: 'select', select: kind };
  if (c.custom_id) s.id = c.custom_id;
  const ph = text(c.placeholder, 150);
  if (ph) s.placeholder = ph;
  if (kind === 'string' && Array.isArray(c.options))
    s.options = c.options.slice(0, 25).map((o) => {
      const description = text(o.description, 100);
      const emoji = emojiText(o.emoji);
      return { label: text(o.label, 100) ?? String(o.value ?? ''), value: String(o.value ?? ''), ...(description ? { description } : {}), ...(emoji ? { emoji } : {}), ...(o.default ? { default: true } : {}) };
    });
  if (typeof c.min_values === 'number') s.min = c.min_values;
  if (typeof c.max_values === 'number') s.max = c.max_values;
  if (c.disabled) s.disabled = true;
  return s;
}

/** What a Components V2 message says in text and files, and its controls, in the order it lays them out. */
export interface Flattened {
  body: string;
  attachments: P.AttachmentFact[];
  rows: P.ComponentRow[];
  /** What the components say of files the message carries anyway (its own attachments), by attachment id. */
  ofAttachments: Map<string, Pick<P.AttachmentFact, 'alt' | 'spoiler'>>;
}

const kindOf = (mime: string | undefined, name: string): P.AttachmentKind => {
  if (/^image\//.test(mime ?? '') || (!mime && /\.(png|jpe?g|gif|webp|avif)$/i.test(name))) return 'image';
  if (/^video\//.test(mime ?? '') || (!mime && /\.(mp4|webm|mov)$/i.test(name))) return 'video';
  if (/^audio\//.test(mime ?? '')) return 'audio';
  return 'file';
};

/**
 * Walk a message's components: action rows become rows of controls; text displays, sections, containers, media
 * galleries, files, thumbnails and separators (Components V2) become text and files. A spoilered container's text is
 * wrapped as a spoiler and its files marked as spoilers.
 */
export function flattenComponents(list: RawComponent[] | undefined, attachments: RawAttachment[] = []): Flattened {
  const out: Flattened = { body: '', attachments: [], rows: [], ofAttachments: new Map() };
  const blocks: string[] = [];
  let n = 0;
  const media = (u: RawComponent['media'], o: { alt?: string | null; spoiler?: boolean; name?: string; size?: number }) => {
    if (!u) return;
    // One of the message's own attachments: it shows as one already, with what is said of it here.
    const own = attachments.find((a) => (u.attachment_id && a.id === u.attachment_id) || (u.url && (a.url === u.url || a.proxy_url === u.url || u.url === `attachment://${a.filename}`)));
    if (own?.id) {
      out.ofAttachments.set(own.id, { ...(o.alt ? { alt: o.alt.slice(0, 2000) } : {}), ...(o.spoiler ? { spoiler: true } : {}) });
      return;
    }
    // attachment:// names one of the message's own files (above); anything else needs an address of its own.
    const url = httpUrl(u.proxy_url) ?? httpUrl(u.url);
    if (!url || out.attachments.some((a) => a.url === url)) return;
    const { content_type: mime, width, height } = u;
    const name = o.name ?? (decodeURIComponent(url.split('?')[0].split('/').pop() ?? '') || undefined);
    out.attachments.push({
      nativeId: `component:${u.attachment_id ?? ++n}`,
      kind: kindOf(mime, name ?? ''),
      url,
      ...(mime ? { mime } : {}),
      ...(name ? { name } : {}),
      ...(typeof width === 'number' ? { width } : {}),
      ...(typeof height === 'number' ? { height } : {}),
      ...(typeof o.size === 'number' ? { size: o.size } : {}),
      ...(o.alt ? { alt: o.alt.slice(0, 2000) } : {}),
      ...(o.spoiler ? { spoiler: true } : {}),
    });
  };
  const walk = (cs: RawComponent[] | undefined, spoiler: boolean, sink: string[]) => {
    for (const c of Array.isArray(cs) ? cs : []) {
      if (!c || typeof c !== 'object') continue;
      switch (c.type) {
        case COMPONENT.ACTION_ROW: {
          const row = (c.components ?? []).map(control).filter((x): x is P.ComponentFact => !!x);
          if (row.length) out.rows.push(row);
          break;
        }
        case COMPONENT.BUTTON:
        case COMPONENT.STRING_SELECT:
        case COMPONENT.USER_SELECT:
        case COMPONENT.ROLE_SELECT:
        case COMPONENT.MENTIONABLE_SELECT:
        case COMPONENT.CHANNEL_SELECT: {
          // A section's accessory button: a row of its own.
          const one = control(c);
          if (one) out.rows.push([one]);
          break;
        }
        case COMPONENT.TEXT_DISPLAY:
          if (typeof c.content === 'string' && c.content.trim()) sink.push(spoiler ? `||${c.content}||` : c.content);
          break;
        case COMPONENT.SECTION:
          walk(c.components, spoiler, sink);
          if (c.accessory) walk([c.accessory], spoiler, sink);
          break;
        case COMPONENT.CONTAINER: {
          const inner: string[] = [];
          walk(c.components, spoiler || !!c.spoiler, inner);
          if (inner.length) sink.push(inner.join('\n\n'));
          break;
        }
        case COMPONENT.THUMBNAIL:
          media(c.media, { alt: c.description, spoiler: spoiler || !!c.spoiler });
          break;
        case COMPONENT.MEDIA_GALLERY:
          for (const it of c.items ?? []) media(it.media, { alt: it.description, spoiler: spoiler || !!it.spoiler });
          break;
        case COMPONENT.FILE:
          media(c.file, { spoiler: spoiler || !!c.spoiler, name: c.name, size: c.size });
          break;
        case COMPONENT.SEPARATOR:
          // A divider shows as a line between blocks; a gap alone as the blank line between them.
          if (c.divider !== false && sink.length) sink.push('───');
          break;
      }
    }
  };
  walk(list, false, blocks);
  out.body = blocks.join('\n\n').replace(/(\n\n───)+$/, '');
  return out;
}

export const isComponentsV2 = (m: RawMessage) => has(m.flags, MESSAGE_FLAG.IS_COMPONENTS_V2);

// ------------------------------------------------------------------- extra

const INTERACTION_KIND: Record<number, P.InteractionFact['kind']> = { 2: 'command', 3: 'component', 4: 'command', 5: 'modal' };

/** "X used /cmd", from interaction_metadata (or the older interaction). */
function interactionFact(m: RawMessage): P.InteractionFact | undefined {
  const i = m.interaction_metadata ?? m.interaction;
  if (!i) return undefined;
  const user = i.user;
  // A context-menu command (message type 23) is named, not slashed.
  const kind: P.InteractionFact['kind'] = m.type === 23 ? 'context' : (INTERACTION_KIND[i.type ?? 2] ?? 'command');
  const name = text(i.name, 100);
  return { kind, ...(name ? { name } : {}), ...(user?.id ? { user: user.id } : {}), ...(user ? { userName: user.global_name || user.username } : {}) };
}

const ACTIVITY_KIND: Record<number, P.ActivityInviteFact['kind']> = { 1: 'join', 2: 'spectate', 3: 'listen', 5: 'request' };

/** A crosspost's webhook is named "Server #channel": where it came from, in words. */
function crosspostFact(m: RawMessage): P.CrosspostFact | undefined {
  if (!isCrosspost(m)) return undefined;
  const name = m.author?.username ?? '';
  const at = name.lastIndexOf(' #');
  return at > 0 ? { server: name.slice(0, at), channel: name.slice(at + 2) } : {};
}

/** The roles the message names, by mention_roles and <@&id> in its text, with names where the hook found them. */
function roleRefs(m: RawMessage, body: string): P.RoleRefFact[] | undefined {
  const named = new Map((m.mention_role_names ?? []).filter((r) => r?.id && r.name).map((r) => [r.id, r]));
  if (!named.size) return undefined;
  const ids = new Set([...(m.mention_roles ?? []), ...[...body.matchAll(/<@&(\d+)>/g)].map((x) => x[1])]);
  const out: P.RoleRefFact[] = [];
  for (const id of ids) {
    const r = named.get(id);
    if (r) out.push({ id, name: r.name, ...(r.color ? { color: r.color } : {}) });
  }
  return out.length ? out : undefined;
}

/** The keys of rich.ts RichExtra this message has, controls given. */
export function richExtra(m: RawMessage, body: string, rows: P.ComponentRow[]): P.RichExtra {
  const x: P.RichExtra = {};
  if (rows.length) {
    x.components = rows;
    const app = m.application_id ?? m.webhook_id ?? (m.author?.bot ? m.author.id : undefined);
    if (app) x.application = app;
  }
  const marks: P.MessageMarks = {};
  if (has(m.flags, MESSAGE_FLAG.EPHEMERAL)) marks.ephemeral = true;
  if (has(m.flags, MESSAGE_FLAG.SUPPRESS_EMBEDS)) marks.suppressEmbeds = true;
  if (has(m.flags, MESSAGE_FLAG.IS_GUILD_OFFICIAL)) marks.official = true;
  // Your own message in an announcement channel that went out to its followers already (threads.ts, Publish).
  if (has(m.flags, MESSAGE_FLAG.CROSSPOSTED)) marks.published = true;
  if (has(m.flags, MESSAGE_FLAG.HIDDEN_SUSPENDED_USER)) marks.hiddenSuspended = true;
  if (Object.keys(marks).length) x.marks = marks;
  const crosspost = crosspostFact(m);
  if (crosspost) x.crosspost = crosspost;
  const interaction = interactionFact(m);
  if (interaction) x.interaction = interaction;
  const activity = m.activity && ACTIVITY_KIND[m.activity.type ?? 0];
  if (activity) x.activity = { kind: activity, ...(m.application?.name ? { name: m.application.name } : {}) };
  const roles = roleRefs(m, body);
  if (roles) x.roles = roles;
  return x;
}

/** A role you hold was pinged (mention_roles names it). Your roles in that server come from the client's own stores. */
export function pingsYourRole(m: RawMessage, selfRoles: readonly string[] | undefined): boolean {
  if (!selfRoles?.length || !m.mention_roles?.length) return false;
  return m.mention_roles.some((r) => selfRoles.includes(r));
}

// ------------------------------------------------------------- attachments

type Marks = Pick<P.AttachmentFact, 'alt' | 'spoiler' | 'explicit' | 'voice'>;

/** An attachment's alt text, spoiler and explicit flags, and a voice message's length and waveform. */
export function attachmentMarks(a: RawAttachment): Marks {
  const out: Marks = {};
  if (typeof a.description === 'string' && a.description.trim()) out.alt = a.description.slice(0, 2000);
  if (has(a.flags, ATTACHMENT_FLAG.IS_SPOILER) || a.spoiler || /^SPOILER_/.test(a.filename ?? '')) out.spoiler = true;
  if (has(a.flags, ATTACHMENT_FLAG.CONTAINS_EXPLICIT_MEDIA)) out.explicit = true;
  if (typeof a.duration_secs === 'number' || typeof a.waveform === 'string') {
    out.voice = {
      ...(typeof a.duration_secs === 'number' && Number.isFinite(a.duration_secs) ? { seconds: Math.round(a.duration_secs * 10) / 10 } : {}),
      ...(typeof a.waveform === 'string' && a.waveform.length <= 2048 ? { waveform: a.waveform } : {}),
    };
  }
  return out;
}

// ------------------------------------------------------------------ embeds

/** Players Discord gives a video embed a page for, loaded by the web app only when clicked. */
const PLAYER = /^https:\/\/(www\.youtube\.com\/embed\/|www\.youtube-nocookie\.com\/embed\/|player\.twitch\.tv\/|clips\.twitch\.tv\/embed|player\.vimeo\.com\/video\/)/;

/** What map.ts's embed leaves out: colour, footer, timestamp, author icon and link, video. */
export function embedMore(e: RawEmbed): Partial<P.EmbedView> {
  const out: Partial<P.EmbedView> = {};
  if (typeof e.color === 'number' && e.color >= 0 && e.color <= 0xffffff) out.color = `#${e.color.toString(16).padStart(6, '0')}`;
  else if (typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color)) out.color = e.color.toLowerCase();
  const footer = text(e.footer?.text, 300);
  if (footer) out.footer = footer;
  const fIcon = httpUrl(e.footer?.icon_url);
  if (fIcon) out.footerIcon = fIcon;
  const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : typeof e.timestamp === 'number' ? e.timestamp : NaN;
  if (Number.isFinite(ts)) out.timestamp = ts;
  const aIcon = httpUrl(e.author?.icon_url);
  if (aIcon) out.authorIcon = aIcon;
  const aUrl = httpUrl(e.author?.url);
  if (aUrl) out.authorUrl = aUrl;
  const v = e.video;
  if (v) {
    const dims = { ...(typeof v.width === 'number' ? { width: v.width } : {}), ...(typeof v.height === 'number' ? { height: v.height } : {}) };
    const page = httpUrl(v.url);
    if (page && PLAYER.test(page)) out.video = { url: page, ...dims, player: true };
    else {
      // A file: Discord's own proxy, never whatever host the embed names.
      const file = httpUrl(v.proxy_url);
      if (file) out.video = { url: file, ...dims, ...(e.type === 'gifv' ? { gifv: true as const } : {}) };
    }
  }
  return out;
}

// ------------------------------------------------------------ system types

/**
 * Words for the system message types map.ts leaves generic or names wrongly (types 13 to 17 are a stream and Server
 * Discovery, not channel updates). undefined: not one of these; map.ts says it.
 * https://docs.discord.food/resources/message#message-type
 */
export function moreSystemText(m: RawMessage, who: string): string | null | undefined {
  const c = m.content?.trim();
  switch (m.type) {
    case 13:
      return `${who} started a stream.`;
    case 14:
      return 'This server was removed from Server Discovery.';
    case 15:
      return 'This server is back in Server Discovery.';
    case 16:
      return 'This server does not meet the Server Discovery requirements: a first warning.';
    case 17:
      return 'This server does not meet the Server Discovery requirements: a final warning.';
    case 22:
      return 'Discord suggests inviting your friends to this server.';
    case 25:
      return `${who} joined a role subscription${c ? `: ${c}` : '.'}`;
    case 26:
      return c ? null : 'An app offered a premium upgrade.';
    case 27:
      return `${who} started the stage${c ? `: ${c}` : '.'}`;
    case 28:
      return `${who} ended the stage${c ? `: ${c}` : '.'}`;
    case 29:
      return `${who} is now a speaker on the stage.`;
    case 30:
      return `${who} raised their hand on the stage.`;
    case 31:
      return `${who} changed the stage topic${c ? `: ${c}` : '.'}`;
    case 32:
      return `${who} subscribed to an app in this server.`;
    case 33:
      return `${who} added an app to the group.`;
    case 34:
      return `${who} removed an app from the group.`;
    case 35:
      return `${who} sent a Nitro referral.`;
    case 36:
      return `${who} paused invites or messages here for safety.`;
    case 37:
      return `${who} ended the safety pause.`;
    case 38:
      return `${who} reported a raid.`;
    case 39:
      return `${who} reported a false alarm.`;
    case 40:
      return 'Discord suggests waking this quiet channel up.';
    case 41:
      return `${who} sent a gift.`;
    case 45:
      return `${who} invited everyone to a voice hangout.`;
    case 64:
      return `${who} invited the group to Nitro.`;
    case 66:
      return c ? null : 'Discord suggests boosting this server.';
    case 42:
    case 48:
    case 50:
    case 51:
    case 69:
      // Discord's own prompts and notices: their text is the message when there is any.
      return c ? null : 'A notice from Discord.';
    default:
      return undefined;
  }
}
