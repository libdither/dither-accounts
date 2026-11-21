/**
 * Zulip's emoji: names to code points and back, from the server's own table (`/static/generated/emoji/
 * emoji_codes.json`, the one its web client loads), kept in the account directory so a restart needs no request.
 *
 * A reaction is `{ emoji_name, emoji_code, reaction_type }`: `unicode_emoji` with code points in hex joined by `-`
 * (no FE0F), `realm_emoji` with the custom emoji's id, `zulip_extra_emoji` (only `zulip`). The hub's key is the emoji
 * itself for Unicode, and an opaque key for the others (see keyOf).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type * as P from '@dither-chat/protocol';

export interface EmojiTable {
  name_to_codepoint: Record<string, string>;
  codepoint_to_name: Record<string, string>;
}

export interface RealmEmoji {
  id: string;
  name: string;
  source_url: string;
  still_url?: string | null;
  deactivated?: boolean;
}

export class Emoji {
  private table: EmojiTable = { name_to_codepoint: {}, codepoint_to_name: {} };
  realm = new Map<string, RealmEmoji>();

  constructor(private cachePath: string) {
    try {
      const t = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (t?.name_to_codepoint) this.table = t;
    } catch {
      // Fetched on start.
    }
  }

  get loaded() {
    return Object.keys(this.table.name_to_codepoint).length > 0;
  }

  set(t: EmojiTable) {
    this.table = { name_to_codepoint: t.name_to_codepoint ?? {}, codepoint_to_name: t.codepoint_to_name ?? {} };
    try {
      writeFileSync(this.cachePath, JSON.stringify(this.table), { mode: 0o600 });
    } catch {
      // Only a cache.
    }
  }

  /** `smile` → 😄 */
  char(name: string): string | undefined {
    const code = this.table.name_to_codepoint[name];
    return code ? codeToChar(code) : undefined;
  }

  /** `smile` → `1f604`, Zulip's code for it. */
  code(name: string): string | undefined {
    return this.table.name_to_codepoint[name];
  }

  /** 😄 → `smile` (with or without its variation selectors). */
  name(char: string): string | undefined {
    const code = charToCode(char);
    return this.table.codepoint_to_name[code] ?? this.table.codepoint_to_name[charToCode(char, true)];
  }

  realmByName(name: string): RealmEmoji | undefined {
    for (const e of this.realm.values()) if (e.name === name && !e.deactivated) return e;
    return undefined;
  }
}

export function codeToChar(code: string): string {
  return String.fromCodePoint(...code.split('-').map((h) => parseInt(h, 16)));
}

export function charToCode(char: string, keepFe0f = false): string {
  return [...char]
    .map((c) => c.codePointAt(0)!)
    .filter((cp) => keepFe0f || cp !== 0xfe0f)
    .map((cp) => cp.toString(16).padStart(4, '0'))
    .join('-');
}

export interface ZulipReaction {
  emoji_name: string;
  emoji_code: string;
  reaction_type: 'unicode_emoji' | 'realm_emoji' | 'zulip_extra_emoji';
  user_id: number;
}

/** The hub's key for a reaction: the emoji for Unicode, `realm:<id>` for a custom emoji, `zulip` for Zulip's own. */
export function keyOf(r: Pick<ZulipReaction, 'emoji_code' | 'reaction_type'>): string {
  if (r.reaction_type === 'unicode_emoji') return codeToChar(r.emoji_code);
  if (r.reaction_type === 'realm_emoji') return `realm:${r.emoji_code}`;
  return `zulip:${r.emoji_code}`;
}

/** The custom emoji fact for a reaction that is not Unicode. */
export function customOf(r: Pick<ZulipReaction, 'emoji_code' | 'emoji_name' | 'reaction_type'>, emoji: Emoji, base: string): P.CustomEmojiFact | undefined {
  if (r.reaction_type === 'unicode_emoji') return undefined;
  if (r.reaction_type === 'zulip_extra_emoji') return { key: keyOf(r), name: r.emoji_name, url: `zulip:/static/generated/emoji/images/emoji/unicode/zulip.png` };
  const e = emoji.realm.get(r.emoji_code);
  const src = e?.source_url ?? '';
  return { key: keyOf(r), name: r.emoji_name, url: src.startsWith('/') ? `zulip:${src}` : src.startsWith(base) ? `zulip:${src.slice(base.length)}` : src, ...(e?.still_url ? { animated: true } : {}) };
}

/** What to send for the hub's key: Zulip's name, code and type. */
export function reactionOf(key: string, emoji: Emoji, custom?: P.CustomEmojiFact): { emoji_name: string; emoji_code: string; reaction_type: string } | null {
  if (key.startsWith('realm:')) {
    const id = key.slice('realm:'.length);
    const e = emoji.realm.get(id);
    const name = e?.name ?? custom?.name;
    return name ? { emoji_name: name, emoji_code: id, reaction_type: 'realm_emoji' } : null;
  }
  if (key.startsWith('zulip:')) return { emoji_name: 'zulip', emoji_code: key.slice('zulip:'.length), reaction_type: 'zulip_extra_emoji' };
  const name = emoji.name(key);
  if (!name) return null;
  return { emoji_name: name, emoji_code: emoji.code(name) ?? charToCode(key), reaction_type: 'unicode_emoji' };
}
