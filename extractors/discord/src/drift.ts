/**
 * Schema drift on Discord (docs/manager.md, "Schema drift"). The hook whitelists each message's fields (hook.js
 * pickMessage) and forwards only the Flux actions it lists, so field names never drift past it; what can is the
 * values that say what a thing is:
 *
 * - `discord.message.type`: a message type map.ts has no words for (shown today as "unsupported message type");
 * - `discord.embed.type`: an embed type Discord documents none of;
 * - `discord.component.type`: a component type rich.ts does not know, at any depth.
 *
 * Names only: a type's number or name, never the message.
 */
import { known, type SchemaWatch } from '@dither-accounts/manager/schema-drift';
import type { RawComponent, RawMessage } from './discord-types.ts';
import { systemMessageText } from './map.ts';
import { COMPONENT } from './rich.ts';

/** Message types up to 127 that systemMessageText has a case for: probed from it, so the list is not written twice. */
export const MESSAGE_TYPES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (let type = 0; type < 128; type++) {
    const probe = { id: '1', channel_id: '1', author: { id: '2', username: 'probe' }, content: '', timestamp: '1970-01-01T00:00:00Z', type } as RawMessage;
    let text: string | null;
    try {
      text = systemMessageText(probe);
    } catch {
      text = null;
    }
    if (!text?.startsWith('(unsupported message type')) out.add(String(type));
  }
  return out;
})();

/** https://docs.discord.food/resources/message#embed-type */
export const EMBED_TYPES = known(
  'rich', 'image', 'video', 'gifv', 'article', 'link', 'poll_result', 'auto_moderation_message', 'auto_moderation_notification', 'application_news',
  'post_preview', 'safety_policy_notice', 'safety_system_notification', 'age_verification_system_notification', 'voice_channel', 'gift',
);

export const COMPONENT_TYPES = known(...Object.values(COMPONENT).map(String));

function components(w: SchemaWatch, list: unknown, depth: number) {
  if (!Array.isArray(list) || depth > 4) return;
  for (const c of list as RawComponent[]) {
    if (!c || typeof c !== 'object') continue;
    w.checkTag('discord.component.type', c.type, COMPONENT_TYPES);
    components(w, c.components, depth + 1);
    if (c.accessory) components(w, [c.accessory], depth + 1);
  }
}

/** One message as the hook gives it. */
export function watchMessage(w: SchemaWatch, m: RawMessage) {
  w.checkTag('discord.message.type', m.type ?? 0, MESSAGE_TYPES);
  for (const e of Array.isArray(m.embeds) ? m.embeds : []) if (e?.type !== undefined) w.checkTag('discord.embed.type', e.type, EMBED_TYPES);
  components(w, m.components, 0);
}
