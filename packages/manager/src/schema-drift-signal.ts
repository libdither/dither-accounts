/**
 * Schema drift for Signal (schema-drift.ts): the signal-cli 0.14.x JSON keys the signal extractor maps
 * (extractors/signal/src/types.ts), and one call that walks a received envelope against them. Kept here, beside the
 * watch, so the extractor needs one line to use it:
 *
 *   watchSignalEnvelope(this.drift, params.envelope);   // where a `receive` notification is handled
 *
 * Names only: the walk reads keys and nothing else (schema-drift.ts, "Privacy").
 */
import { known, type SchemaWatch } from './schema-drift.ts';

const ADDRESS = ['source', 'sourceNumber', 'sourceUuid'];
const DATA_MESSAGE = [
  'timestamp', 'message', 'expiresInSeconds', 'isExpirationUpdate', 'viewOnce', 'groupCallUpdate', 'isEndSession', 'isProfileKeyUpdate', 'hasProfileKey',
  'reaction', 'quote', 'payment', 'mentions', 'previews', 'attachments', 'sticker', 'remoteDelete', 'contacts', 'pollCreate', 'pollVote', 'pollTerminate',
  'textStyles', 'groupInfo', 'storyContext', 'pinMessage', 'unpinMessage', 'adminDelete',
];

export const SIGNAL_KEYS = {
  envelope: known(...ADDRESS, 'sourceName', 'sourceDevice', 'timestamp', 'serverReceivedTimestamp', 'serverDeliveredTimestamp', 'dataMessage', 'editMessage', 'storyMessage', 'syncMessage', 'callMessage', 'receiptMessage', 'typingMessage'),
  dataMessage: known(...DATA_MESSAGE),
  editMessage: known('targetSentTimestamp', 'dataMessage'),
  syncMessage: known('sentMessage', 'sentStoryMessage', 'blockedNumbers', 'blockedGroupIds', 'readMessages', 'type'),
  /** A sent transcript is a data message with its destination (and an edit) on it. */
  sentMessage: known(...DATA_MESSAGE, 'destination', 'destinationNumber', 'destinationUuid', 'editMessage'),
  attachment: known('contentType', 'filename', 'file', 'id', 'size', 'width', 'height', 'caption', 'uploadTimestamp', 'isVoiceNote', 'isGif', 'isBorderless', 'blurhash'),
  receiptMessage: known('when', 'isDelivery', 'isRead', 'isViewed', 'timestamps'),
  typingMessage: known('action', 'timestamp', 'groupId'),
  callMessage: known('offerMessage', 'answerMessage', 'busyMessage', 'hangupMessage', 'iceUpdateMessages', 'opaqueMessage'),
};

/** Tags: text style names and typing actions signal-cli is known to send. */
export const SIGNAL_TAGS = {
  textStyle: known('BOLD', 'ITALIC', 'SPOILER', 'STRIKETHROUGH', 'MONOSPACE'),
  typingAction: known('STARTED', 'STOPPED'),
};

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);

function dataMessage(w: SchemaWatch, surface: string, dm: unknown, keys: ReadonlySet<string>) {
  const d = obj(dm);
  if (!d) return;
  w.checkKeys(surface, d, keys);
  if (Array.isArray(d.attachments)) for (const a of d.attachments) w.checkKeys('signal.attachment', a, SIGNAL_KEYS.attachment);
  if (Array.isArray(d.textStyles)) for (const s of d.textStyles) w.checkTag('signal.textStyle', obj(s)?.style, SIGNAL_TAGS.textStyle);
}

/** Walk one received envelope (signal-cli's `receive` params.envelope). */
export function watchSignalEnvelope(w: SchemaWatch, envelope: unknown) {
  const env = obj(envelope);
  if (!env) return;
  w.checkKeys('signal.envelope', env, SIGNAL_KEYS.envelope);
  dataMessage(w, 'signal.dataMessage', env.dataMessage, SIGNAL_KEYS.dataMessage);
  const edit = obj(env.editMessage);
  if (edit) {
    w.checkKeys('signal.editMessage', edit, SIGNAL_KEYS.editMessage);
    dataMessage(w, 'signal.dataMessage', edit.dataMessage, SIGNAL_KEYS.dataMessage);
  }
  const sync = obj(env.syncMessage);
  if (sync) {
    w.checkKeys('signal.syncMessage', sync, SIGNAL_KEYS.syncMessage);
    dataMessage(w, 'signal.sentMessage', sync.sentMessage, SIGNAL_KEYS.sentMessage);
  }
  w.checkKeys('signal.receiptMessage', env.receiptMessage, SIGNAL_KEYS.receiptMessage);
  const typing = obj(env.typingMessage);
  if (typing) {
    w.checkKeys('signal.typingMessage', typing, SIGNAL_KEYS.typingMessage);
    w.checkTag('signal.typingAction', typing.action, SIGNAL_TAGS.typingAction);
  }
  w.checkKeys('signal.callMessage', env.callMessage, SIGNAL_KEYS.callMessage);
}
