/**
 * What a network says about a message beyond its body and files: the known keys of MessageFact.extra, which the hub
 * keeps (message.extra) and shows as MessageView's quote, contacts, storyReply, failed and missingAttachments, and as
 * AttachmentView's voiceNote and caption (docs/messages.md). Every key is optional: an adapter sets what its network
 * has, and a hub that does not know a key keeps it and shows nothing of it. `embeds` (EmbedView) is older than this
 * file and stays as it is.
 */

import type { AttachmentKind } from './ontology.ts';
import type { MediaUrl } from './adapter.ts';

/**
 * The message a reply quotes, as the reply itself carries it. Shown when the hub does not have the quoted message
 * (a linked Signal device has nothing from before it was linked); a stored one is shown instead.
 */
export interface QuoteFact {
  /** Native identity id of the quoted author, or their phone number when that is all the network says. */
  author: string | null;
  /** When the quoted message was sent, as the network names it (Signal: the quote's id). */
  ts: number;
  /** Its text, as a message body (mentions as <@id>). */
  text: string;
  attachments?: { mime: string | null; name: string | null; /** A small picture of it, when the network sent one. */ thumbnail?: MediaUrl }[];
}

/** A contact card someone shared (Signal's shared contact). */
export interface SharedContactFact {
  name: string;
  phones?: { value: string; label?: string }[];
  emails?: { value: string; label?: string }[];
  organization?: string;
  /** One line each, as the network's parts joined ("1 Main St, Springfield, 12345"). */
  addresses?: { text: string; label?: string }[];
  avatar?: MediaUrl;
  /** The line the adapter also wrote into the body for this card (for search and previews); the card replaces it there. */
  line?: string;
}

/** Why a message you sent did not reach someone. */
export type SendFailureReason = 'unregistered' | 'identity' | 'rateLimit' | 'network' | 'keys' | 'other';

/** Someone a message you sent did not reach, while it reached others (a group). */
export interface SendFailureFact {
  /** Native identity id, when known. */
  who: string | null;
  number?: string;
  reason: SendFailureReason;
}

/** A file the message had that the account could not download (or skipped): shown as "not downloaded", not left out. */
export interface MissingAttachmentFact {
  name?: string;
  mime?: string;
  size?: number;
}

/** What the network says about one attachment beyond AttachmentFact, by its position in `attachments`. */
export interface AttachmentNote {
  caption?: string;
  /** Recorded as a voice note (Signal's isVoiceNote): shown with the network's voice-note label. */
  voiceNote?: true;
}

/** The known keys of MessageFact.extra. */
export interface MessageExtra {
  quote?: QuoteFact;
  contacts?: SharedContactFact[];
  /** A reply to a story (or, with `emoji`, a reaction to one). `author`: whose story, native id. */
  storyReply?: { author: string | null; ts: number; emoji?: string };
  /** People a message you sent did not reach (capability-free: the adapter that sent it says so on its own fact). */
  failed?: SendFailureFact[];
  missingAttachments?: MissingAttachmentFact[];
  /** One per attachment, in order; null where there is nothing to say. */
  attachmentNotes?: (AttachmentNote | null)[];
  /** Which of the author's devices sent it, and when the network's server took and handed it out (ms epoch). */
  sourceDevice?: number;
  serverReceivedTs?: number;
  serverDeliveredTs?: number;
}

/**
 * A link preview to send with a message (the `send` command's `preview`, capability 'linkPreviews'): the hub fetched
 * it from the first link in the body, through the media proxy's rules (public addresses only, size caps).
 */
export interface LinkPreviewOut {
  url: string;
  title: string;
  description?: string;
  /** A picture for it, a file in the hub's spool; the adapter reads it during the send and the hub deletes it after. */
  image?: string;
}

// ---------------------------------------------------------------- views (MessageView)

export interface QuoteView {
  /** The quoted author's identity, when the hub knows them. */
  authorId: string | null;
  /** Their name in words when no identity is known (a phone number). */
  authorName: string | null;
  ts: number;
  text: string;
  attachments: { kind: AttachmentKind; mime: string | null; name: string | null }[];
  /** A thumbnail of the first attachment, served by the hub. */
  thumbnail: string | null;
}

export interface ContactCardView extends Omit<SharedContactFact, 'avatar'> {
  avatar: string | null;
}

export interface SendFailureView {
  identityId: string | null;
  /** Their name in words when no identity is known. */
  name: string | null;
  reason: SendFailureReason;
}

export interface StoryReplyView {
  /** Whose story: you, someone the hub knows, or nobody it can name. */
  mine: boolean;
  authorId: string | null;
  /** A reaction to the story rather than a reply. */
  emoji?: string;
}

/** Plain words for a send failure. */
export const SEND_FAILURE_WORDS: Record<SendFailureReason, string> = {
  unregistered: 'no longer on the network',
  identity: 'their safety number changed',
  rateLimit: 'the network is rate limiting this account',
  network: 'a network error',
  keys: 'their encryption keys were out of date',
  other: 'the network refused it',
};
