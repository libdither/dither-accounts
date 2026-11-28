/**
 * Schema drift on WhatsApp (docs/manager.md, "Schema drift"): the parts of a waE2E.Message this extractor maps or
 * skips on purpose, the protocolMessage types, and the bridge's own event names. A message part beyond them (shown
 * today as "cannot be shown here"), a new protocolMessage type or a bridge event the adapter has no case for is
 * logged once by name, never its value.
 */
import { known, type SchemaWatch } from '@dither-accounts/manager/schema-drift';
import { SILENT } from './mapping.ts';
import type { BridgeEvent } from './types.ts';

/** waE2E.Message's parts that contentOf and the mapper read, and those it keeps silent (mapping.ts SILENT). */
export const MESSAGE_KEYS = known(
  ...SILENT,
  'conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
  'reactionMessage', 'protocolMessage', 'locationMessage', 'liveLocationMessage', 'contactMessage', 'contactsArrayMessage',
  'pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'pollCreationMessageV5', 'groupInviteMessage', 'eventMessage',
  'callLogMesssage', 'callLogMessage', 'buttonsMessage', 'templateMessage', 'listMessage', 'interactiveMessage', 'buttonsResponseMessage',
  'listResponseMessage',
);

/** protocolMessage types: those mapped (REVOKE, MESSAGE_EDIT, EPHEMERAL_SETTING) and the sync plumbing skipped on purpose. */
export const PROTOCOL_TYPES = known(
  'REVOKE', 'MESSAGE_EDIT', 'EPHEMERAL_SETTING',
  'HISTORY_SYNC_NOTIFICATION', 'APP_STATE_SYNC_KEY_SHARE', 'APP_STATE_SYNC_KEY_REQUEST', 'INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC',
  'APP_STATE_FATAL_EXCEPTION_NOTIFICATION', 'PEER_DATA_OPERATION_REQUEST_MESSAGE', 'PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE',
  'EPHEMERAL_SYNC_RESPONSE', 'MSG_FANOUT_BACKFILL_REQUEST', 'LID_MIGRATION_MAPPING_SYNC',
);

/** A message event from the bridge: its parts, and its protocolMessage's type. */
export function watchMessage(w: SchemaWatch, ev: Extract<BridgeEvent, { t: 'message' }>) {
  const m = ev.message;
  if (!m) return;
  w.checkKeys('whatsapp.message', m, MESSAGE_KEYS);
  const pm = m.protocolMessage;
  if (pm && pm.type !== undefined) w.checkTag('whatsapp.protocolMessage.type', pm.type, PROTOCOL_TYPES);
}
