/**
 * Ids, opaque to apps:
 *
 *   mailbox    base64url of its path                         SU5CT1g          (INBOX)
 *   message    <mailbox>.<UIDVALIDITY>.<UID>                 SU5CT1g.1794070727.42
 *   attachment its MIME part number in the message           2, 1.3
 *   state      q.<UIDVALIDITY>.<HIGHESTMODSEQ>.<UIDNEXT>      (QRESYNC)
 *              c.<UIDVALIDITY>.<HIGHESTMODSEQ>.<snapshot>     (CONDSTORE without QRESYNC)
 *              f.<UIDVALIDITY>.0.<snapshot>                   (neither: a UID+flags diff)
 *   cursor     <UIDVALIDITY>.<UID>                           mail.list's `next`: older than this UID
 *
 * A message keeps its id while it stays in its mailbox; a move gives it a new UID there, so a new id. A changed
 * UIDVALIDITY (the server rebuilt the mailbox) makes every id, cursor and state of it answer 410.
 */
import { StatusError } from '@dither-accounts/link';

export const mailboxId = (path: string) => Buffer.from(path, 'utf8').toString('base64url');

export function mailboxPath(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new StatusError('no such mailbox', 404);
  const p = Buffer.from(id, 'base64url').toString('utf8');
  if (!p || mailboxId(p) !== id) throw new StatusError('no such mailbox', 404);
  return p;
}

export const messageId = (path: string, uidValidity: bigint | string, uid: number) => `${mailboxId(path)}.${uidValidity}.${uid}`;

export interface MessageRef {
  path: string;
  uidValidity: string;
  uid: number;
}

export function parseMessageId(id: unknown): MessageRef {
  const m = typeof id === 'string' ? id.match(/^([A-Za-z0-9_-]+)\.(\d+)\.(\d+)$/) : null;
  if (!m) throw new StatusError(`no such message: ${String(id).slice(0, 80)}`, 404);
  return { path: mailboxPath(m[1]), uidValidity: m[2], uid: Number(m[3]) };
}

export type StateMode = 'q' | 'c' | 'f';
export interface State {
  mode: StateMode;
  uidValidity: string;
  modseq: string;
  /** q: UIDNEXT; c and f: the snapshot's id. */
  rest: string;
}
export const formatState = (s: State) => `${s.mode}.${s.uidValidity}.${s.modseq}.${s.rest}`;
export function parseState(v: string): State {
  const m = v.match(/^([qcf])\.(\d+)\.(\d+)\.([A-Za-z0-9]+)$/);
  if (!m) throw new StatusError('not a state this account gave', 400);
  return { mode: m[1] as StateMode, uidValidity: m[2], modseq: m[3], rest: m[4] };
}

export function parseCursor(v: string): { uidValidity: string; uid: number } {
  const m = v.match(/^(\d+)\.(\d+)$/);
  if (!m) throw new StatusError('not a cursor this account gave', 400);
  return { uidValidity: m[1], uid: Number(m[2]) };
}

/** Sorted UIDs as an IMAP sequence set, 1:5,7,9:12. */
export function toRanges(uids: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < uids.length; ) {
    let j = i;
    while (j + 1 < uids.length && uids[j + 1] === uids[j] + 1) j++;
    out.push(i === j ? String(uids[i]) : `${uids[i]}:${uids[j]}`);
    i = j + 1;
  }
  return out.join(',');
}
export function fromRanges(s: string): number[] {
  const out: number[] = [];
  if (!s) return out;
  for (const part of s.split(',')) {
    const [a, b] = part.split(':').map(Number);
    if (b === undefined) out.push(a);
    else for (let u = a; u <= b; u++) out.push(u);
  }
  return out;
}
