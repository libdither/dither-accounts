/**
 * Schema drift on Matrix (docs/manager.md, "Schema drift"): the timeline event types, message content keys, msgtypes
 * and relations this extractor maps, checked against each timeline event it processes. Names only, never values.
 */
import { known, type SchemaWatch } from '@dither-accounts/manager/schema-drift';
import { FORWARD_KEY } from './messages.ts';
import type { MxEvent } from './rooms.ts';

/** Non-state timeline events: those mapped, and those read or skipped on purpose (calls, verification, poll votes). */
export const TIMELINE_TYPES = known(
  'm.room.message', 'm.sticker', 'm.room.encrypted', 'm.poll.start', 'org.matrix.msc3381.poll.start',
  'm.reaction', 'm.room.redaction',
  'm.poll.response', 'm.poll.end', 'org.matrix.msc3381.poll.response', 'org.matrix.msc3381.poll.end',
  'm.call.invite', 'm.call.answer', 'm.call.hangup', 'm.call.candidates', 'm.call.select_answer', 'm.call.negotiate', 'm.call.reject',
  'm.key.verification.ready', 'm.key.verification.start', 'm.key.verification.accept', 'm.key.verification.key', 'm.key.verification.mac', 'm.key.verification.done', 'm.key.verification.cancel',
);

export const MSGTYPES = known('m.text', 'm.emote', 'm.notice', 'm.image', 'm.file', 'm.audio', 'm.video', 'm.location', 'm.key.verification.request', 'm.server_notice');

/** m.room.message content keys read by messages.ts (text, media, location, relations, mentions, forwards). */
export const MESSAGE_CONTENT_KEYS = known('msgtype', 'body', 'format', 'formatted_body', 'url', 'file', 'info', 'filename', 'geo_uri', 'm.relates_to', 'm.new_content', 'm.mentions', FORWARD_KEY);

export const REL_TYPES = known('m.replace', 'm.annotation', 'm.thread', 'm.reference');
export const RELATES_TO_KEYS = known('rel_type', 'event_id', 'key', 'm.in_reply_to', 'is_falling_back');
/** unsigned['m.relations']: what the server bundles into an event. */
export const BUNDLED_RELATIONS = known('m.replace', 'm.thread', 'm.reference');

/** Check one (decrypted) non-state timeline event. */
export function watchTimelineEvent(w: SchemaWatch, ev: MxEvent) {
  w.checkTag('matrix.event.type', ev.type, TIMELINE_TYPES);
  const c = ev.content;
  if (ev.type === 'm.room.message' && c && typeof c === 'object') {
    w.checkTag('matrix.msgtype', c.msgtype, MSGTYPES);
    // A verification request is no message; its keys are the verification's.
    if (c.msgtype !== 'm.key.verification.request') w.checkKeys('matrix.event.content', c, MESSAGE_CONTENT_KEYS);
  }
  const rel = c?.['m.relates_to'];
  if (rel && typeof rel === 'object') {
    w.checkKeys('matrix.relates_to', rel, RELATES_TO_KEYS);
    if (rel.rel_type !== undefined) w.checkTag('matrix.rel_type', rel.rel_type, REL_TYPES);
  }
  w.checkKeys('matrix.unsigned.relations', ev.unsigned?.['m.relations'], BUNDLED_RELATIONS);
}
