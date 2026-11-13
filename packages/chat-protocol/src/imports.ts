/**
 * History imports (docs/import.md): raw sources the hub keeps under <data>/imports/sources/<id>/, uploaded
 * from a client or copied in. A source is never changed once complete; everything derived from it can be
 * thrown away and made again.
 */

import type { Network } from './ontology.ts';

export type ImportSourceKind =
  | 'signal-backup' //    Signal/Molly legacy .backup (encrypted, needs the 30-digit passphrase)
  | 'signal-backup-v2' // a SignalBackups/ folder (backup v2)
  | 'signal-folder' //    a Molly backup folder: SignalBackups/ and, with "Include kept messages", .backup files
  | 'discord-package' //  Discord's own data package (zip)
  | 'dce-html' //         DiscordChatExporter HTML, with downloaded media
  | 'dce-json' //         DiscordChatExporter JSON
  | 'unknown';

export type ImportSourceStatus =
  | 'uploading' //        bytes still arriving; send the rest from `received`
  | 'checking' //         complete; hashing and working out what it is
  | 'needs-passphrase' // an encrypted backup with no passphrase yet
  | 'counting' //         reading it through with the passphrase (progress)
  | 'ready' //            hashed and, where it can be, counted
  | 'error';

/** What a census found: counts and shapes only, never content. Format-specific keys beyond these. */
export interface ImportCensus {
  format: string;
  [k: string]: unknown;
}

/** What an import did, or would do in a dry run (docs/import.md). */
export interface ImportCounts {
  conversations: number;
  conversationsNew: number;
  messages: number;
  /** Not in the hub: inserted. */
  new: number;
  /** Already in the hub and saying the same. */
  same: number;
  /** Already in the hub; the source added a reply link or attachments it lacked. */
  filled: number;
  /** Already in the hub and saying something else: the hub's version stays, the difference is kept for review. */
  conflicts: number;
  /** In this source more than once. */
  duplicates: number;
  /**
   * Of the new and filled: messages the network took back (deleted or disappeared) whose words or files the source
   * kept, now in the hub as kept deleted or disappeared messages, out of sight until adversarial features are shown.
   * Missing from runs before it was counted.
   */
  kept?: number;
}

export interface ImportRunView {
  id: string;
  dryRun: boolean;
  stage: 'reading' | 'applying' | 'done' | 'error' | 'stopped';
  /** 0..1 within the stage. */
  progress: number;
  counts: ImportCounts | null;
  /** From reading: files the export links to, and how many of those are missing. */
  files?: { linked: number; missing: number };
  /** From reading: what the reader left out, by why (Signal: sms, deleted, updates the hub has no line for). */
  skipped?: Record<string, number>;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface ImportConflictView {
  messageId: string;
  conversationId: string;
  kind: 'body' | 'deleted';
  hub: { body: string; deleted: boolean; editedTs: number | null };
  source: { body: string; editedTs?: number; attachments?: string[] };
  ts: number;
  decision: 'take-source' | 'ignore' | null;
}

export interface ImportSourceView {
  id: string;
  network: Network | null;
  /** The hub account its history belongs to, once known. */
  accountId: string | null;
  kind: ImportSourceKind;
  label: string;
  status: ImportSourceStatus;
  /** Total bytes: expected while uploading, found once complete. */
  size: number;
  received: number;
  files: number;
  /** Of the single file, or of the sorted (path, size, sha256) list for a folder: the source's identity. */
  sha256: string | null;
  addedAt: number;
  addedBy: string;
  hasPassphrase: boolean;
  /** 0..1 while counting. */
  progress: number | null;
  census: ImportCensus | null;
  error: string | null;
  notes: string | null;
  /** The latest import or dry run of this source. */
  run: ImportRunView | null;
  /** This kind can be imported now. */
  importable: boolean;
}

/** Uploads go in pieces of at most this, each a PUT at its offset, so a dropped connection resumes. */
export const IMPORT_CHUNK = 8 * 1024 * 1024;
/** The largest single-file source accepted. */
export const MAX_IMPORT = 64 * 1024 * 1024 * 1024;

/** Fetching what an import and live sync both lack, through the account (docs/import-discord.md). */
export interface GapFillView {
  accountId: string;
  running: boolean;
  /** The conversation being paged now. */
  current: string | null;
  conversations: number;
  done: number;
  failed: number;
  pages: number;
  fetched: number;
}
