/**
 * The parts of a message beyond its text, files and embeds (docs/rich-messages.md): a bot's buttons and selects, the
 * marks a network puts on a message, where a crosspost came from, who ran the command a bot answers, an activity
 * invite, and the roles its text names. An adapter sends them in MessageFact.extra under these keys; the hub keeps
 * extra as it came and passes them on in MessageView.
 *
 * All of it is read-only in dither for now. The controls keep what a later `interact` command needs to press one
 * (its `id`, the network's custom id, and the message's `application`), so making them clickable adds a command, not
 * a new shape.
 */

/** How a button looks. `link` opens its `url` and sends nothing to the bot; `premium` is Discord's buy button. */
export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger' | 'link' | 'premium';

export interface ButtonFact {
  kind: 'button';
  /** What pressing it sends back to the bot (Discord's custom_id). Absent on a link button. */
  id?: string;
  label?: string;
  /** A Unicode emoji, or a custom one as body Markdown (`<:name:id>`, `<a:name:id>`). */
  emoji?: string;
  style: ButtonStyle;
  /** A link button's address (http or https only; anything else is left out). */
  url?: string;
  disabled?: boolean;
}

/** What a select picks from: options the bot listed, or people, roles, either, or channels of the place. */
export type SelectKind = 'string' | 'user' | 'role' | 'mentionable' | 'channel';

export interface SelectOptionFact {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
  /** Picked to begin with. */
  default?: boolean;
}

export interface SelectFact {
  kind: 'select';
  /** What choosing sends back to the bot (Discord's custom_id). */
  id?: string;
  select: SelectKind;
  placeholder?: string;
  /** For `string` selects. */
  options?: SelectOptionFact[];
  min?: number;
  max?: number;
  disabled?: boolean;
}

export type ComponentFact = ButtonFact | SelectFact;
/** A row of controls, as the message lays them out. */
export type ComponentRow = ComponentFact[];

/** Marks a network put on a message. Each is there only when true. */
export interface MessageMarks {
  /** Only you can see it (Discord's ephemeral answers to your commands). */
  ephemeral?: true;
  /** Its author hid the link previews: the hub shows no embeds for it. */
  suppressEmbeds?: true;
  /** The server marked it as an official message of its own. */
  official?: true;
  /** Its author's account is suspended; Discord hides their name. */
  hiddenSuspended?: true;
  /** Published to the channels that follow its announcement channel (Discord's CROSSPOSTED; threads.ts Publish). */
  published?: true;
}

/** A message published from a followed announcement channel elsewhere: where it came from, in words. */
export interface CrosspostFact {
  channel?: string;
  server?: string;
}

/** A bot's message answering something someone did: "X used /cmd". */
export interface InteractionFact {
  /** The command's name without its slash, for a command. */
  name?: string;
  kind: 'command' | 'component' | 'modal' | 'context';
  /** Who did it: their native identity id. */
  user?: string;
  userName?: string;
}

/** A message inviting to join or watch an activity (Discord's Rich Presence invites). */
export interface ActivityInviteFact {
  kind: 'join' | 'spectate' | 'listen' | 'request';
  /** The game or app, when known. */
  name?: string;
}

/** A role the text names as `<@&id>`, with what to call it. `color` is CSS hex. */
export interface RoleRefFact {
  id: string;
  name: string;
  color?: string;
}

/** The keys of MessageFact.extra this file defines. */
export interface RichExtra {
  components?: ComponentRow[];
  /** Who the controls answer to (a Discord application id): what a later `interact` sends along. */
  application?: string;
  marks?: MessageMarks;
  crosspost?: CrosspostFact;
  interaction?: InteractionFact;
  activity?: ActivityInviteFact;
  roles?: RoleRefFact[];
}

/** A voice message: how long it lasts and its waveform, one byte (0 to 255) per point, as base64. */
export interface VoiceFact {
  seconds?: number;
  waveform?: string;
}

/** The waveform's points, 0 to 1 each, from its base64. Empty when there is none or it does not read. */
export function waveformPoints(b64: string | undefined): number[] {
  if (!b64) return [];
  try {
    const bin = atob(b64);
    const out: number[] = [];
    for (let i = 0; i < bin.length && i < 512; i++) out.push(bin.charCodeAt(i) / 255);
    return out;
  } catch {
    return [];
  }
}

/** A link to a message of a network the hub may have stored (Discord's discord.com/channels/…/…/… links). */
export interface MessageLinkRef {
  network: 'discord';
  /** The server's id, or null for a DM ("@me"). */
  space: string | null;
  conversation: string;
  message: string;
}

const DISCORD_MESSAGE_LINK = /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(@me|\d{15,22})\/(\d{15,22})\/(\d{15,22})/g;

/** Message links in a body, at most `max`, each once. */
export function messageLinks(body: string, max = 3): MessageLinkRef[] {
  if (!body.includes('/channels/')) return [];
  const out: MessageLinkRef[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(DISCORD_MESSAGE_LINK)) {
    if (seen.has(m[3])) continue;
    seen.add(m[3]);
    out.push({ network: 'discord', space: m[1] === '@me' ? null : m[1], conversation: m[2], message: m[3] });
    if (out.length >= max) break;
  }
  return out;
}

/** A message another one links to, as the hub has it: shown as a quote under the link. Never fetched for this. */
export interface LinkedMessageView {
  messageId: string;
  conversationId: string;
  authorId: string | null;
  ts: number;
  /** The start of its text. */
  text: string;
  /** It has files and no text. */
  attachments?: number;
}

/** MessageView.rich: what of RichExtra a message has, sent silently, and the stored messages it links to. */
export interface RichView extends RichExtra {
  silent?: true;
  linked?: LinkedMessageView[];
}
