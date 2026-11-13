/**
 * `statements`: what a financial source pulled, as files (docs/statements.md). Each pull's output is the same bytes dither-finance's own pullers wrote, under the same names,
 * so an app saves them as they are and its parsers do not change. Files, not parsed rows.
 *
 *   read    only: list the pulled files, fetch one, say which it has (ack), ask for a pull now, name the accounts
 *
 * Nothing here moves money or acts on an account: no transfers, payments, card changes or orders, at any level. An
 * account's pulls wait in its spool until an app acks them, then 30 days more. Times are milliseconds since the epoch.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

/** One pulled file. */
export interface StatementFile {
  /** A per-account counter: the cursor. A later file has a higher seq. */
  seq: number;
  id: string;
  /** What the app saves it as, in `dir` ("" for the top of its raw folder): "simplefin-20261109T061317-w0.json". */
  name: string;
  dir: string;
  mime: string;
  size: number;
  /** Hex, of the file's bytes. */
  sha256: string;
  pulledAt: number;
  /** The span the source was asked for, when it was asked for one. */
  coverage?: { from: number; to: number };
}

/** An account at the source: names only, never a balance. */
export interface StatementAccount {
  id: string;
  name: string;
  /** The bank or service it is at. */
  institution: string | null;
  currency: string | null;
  kind: 'bank' | 'brokerage' | 'card' | 'wallet' | 'payments' | 'orders' | 'unknown';
}

/** How a pull ended. */
export interface StatementsPulled {
  ok: boolean;
  /** Files it added to the spool. */
  saved: number;
  skipped?: 'signed-out' | 'unchanged';
  /** What it needs from you (a new access URL, a sign-in), or why it failed. */
  needs?: string;
}

export const statements = iface({
  name: 'statements',
  version: 1,
  describe: 'What a financial account pulled, as the files its source gave (statements, transactions, wallet transfers). Never moves money.',
  levels: {
    read: 'Read your statements and transactions as files, and ask for a new pull',
  },
  ops: {
    'statements.list': op('read', 'Pulled files after a cursor (seq), oldest first', s.object({ after: s.optional(s.integer), limit: s.optional(s.integer) }), s.typed<{ files: StatementFile[]; next: number }>()),
    'statements.fetch': op('read', "A pulled file's bytes (up to 40 MB)", s.object({ id: s.string }), s.typed<{ name: string; dir: string; mime: string; size: number; sha256: string; base64: string }>(), 60_000),
    'statements.refresh': op(
      'read',
      'Start a pull now; it reports through statements.pulled and the status',
      s.object({ full: s.optional(s.boolean), since: s.optional(s.integer), details: s.optional(s.integer), days: s.optional(s.integer) }),
      s.typed<{ started: boolean; reason?: string }>(),
    ),
    'statements.ack': op('read', 'The app has every file up to this seq; the spool may drop them (after 30 days)', s.object({ through: s.integer }), s.typed<{ acked: number }>()),
    'statements.accounts': op('read', "The source's accounts, by name (no balances)", s.object({}), s.typed<{ accounts: StatementAccount[] }>()),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
    'statements.file': ev('A new pulled file is whole', s.typed<{ file: StatementFile }>()),
    'statements.pulled': ev('A pull ended', s.typed<StatementsPulled>()),
  },
});
