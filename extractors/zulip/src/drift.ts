/**
 * Schema drift on Zulip (docs/manager.md, "Schema drift"): the /events types and ops, and the message keys, that
 * Zulip documents and this extractor knows (maps, or drops on purpose). A type, an op or a message key beyond them is
 * logged once by name, never its value.
 */
import { known, type SchemaWatch } from '@dither-accounts/manager/schema-drift';

/** Every event type in Zulip's /events documentation; those the adapter does not map it drops on purpose. */
export const EVENT_TYPES = known(
  'alert_words', 'attachment', 'channel_folder', 'custom_profile_fields', 'default_stream_groups', 'default_streams', 'delete_message', 'drafts',
  'has_zoom_token', 'heartbeat', 'invites_changed', 'message', 'muted_topics', 'muted_user', 'muted_users', 'navigation_view', 'onboarding_steps',
  'presence', 'push_device', 'reaction', 'realm', 'realm_bot', 'realm_domains', 'realm_emoji', 'realm_export', 'realm_export_consent', 'realm_linkifiers',
  'realm_playgrounds', 'realm_user', 'realm_user_settings_defaults', 'reminders', 'restart', 'saved_snippets', 'scheduled_messages', 'stream', 'submessage',
  'subscription', 'typing', 'typing_edit_message', 'update_display_settings', 'update_global_notifications', 'update_message', 'update_message_flags',
  'user_group', 'user_settings', 'user_status', 'user_topic', 'web_reload_client',
);

/** `type/op` for the types whose ops the adapter tells apart. Other types' ops are not checked. */
const OPS: Record<string, ReadonlySet<string>> = {};
for (const [type, ops] of Object.entries({
  reaction: ['add', 'remove'],
  update_message_flags: ['add', 'remove'],
  typing: ['start', 'stop'],
  subscription: ['add', 'remove', 'update', 'peer_add', 'peer_remove'],
  stream: ['create', 'delete', 'update'],
  channel_folder: ['add', 'update', 'reorder'],
  realm_user: ['add', 'update', 'remove'],
  realm: ['update', 'update_dict', 'deactivated'],
  user_group: ['add', 'remove', 'update', 'add_members', 'remove_members', 'add_subgroups', 'remove_subgroups'],
  scheduled_messages: ['add', 'update', 'remove'],
  reminders: ['add', 'remove'],
})) OPS[type] = known(...ops.map((op) => `${type}/${op}`));
export const EVENT_OPS: Readonly<Record<string, ReadonlySet<string>>> = OPS;

/** A message object's documented keys (GET /messages, the message event), and what a search adds. */
export const MESSAGE_KEYS = known(
  'id', 'sender_id', 'sender_full_name', 'sender_email', 'sender_realm_str', 'content', 'content_type', 'rendered_content', 'timestamp', 'type',
  'stream_id', 'subject', 'topic_links', 'recipient_id', 'display_recipient', 'reactions', 'submessages', 'flags', 'last_edit_timestamp',
  'last_moved_timestamp', 'edit_history', 'is_me_message', 'avatar_url', 'client', 'match_content', 'match_subject',
);

/** One event from /events: its type, and its op where the adapter tells ops apart. */
export function watchEvent(w: SchemaWatch, ev: { type?: unknown; op?: unknown } | null | undefined) {
  if (!ev) return;
  if (w.checkTag('zulip.event', ev.type, EVENT_TYPES)) return;
  const ops = OPS[ev.type as string];
  if (ops && ev.op !== undefined) w.checkTag('zulip.event.op', `${ev.type}/${String(ev.op)}`, ops);
}

export function watchMessage(w: SchemaWatch, m: unknown) {
  w.checkKeys('zulip.message', m, MESSAGE_KEYS);
}
