import type { Network } from './ontology.ts';

/** Hub-id prefixes. Network objects get deterministic ids so ingest is idempotent. */
export type IdPrefix = 'idn' | 'spc' | 'cnv' | 'msg' | 'att' | 'per' | 'acc' | 'fld' | 'rul' | 'cat' | 'job' | 'nsr';
/** Mail's own (docs/mail-design.md §2.1): mailboxes, messages, threads, outbox items. */
export type MailIdPrefix = 'mbx' | 'mml' | 'mth' | 'mob';

const enc = new TextEncoder();

const digest = (s: string) => Buffer.from(new Bun.CryptoHasher('sha256').update(enc.encode(s)).digest().subarray(0, 12)).toString('base64url');

/** 16-char base64url of sha256(network NUL nativeId). Deterministic, so adapters' references resolve without lookups. */
export function hubId(prefix: IdPrefix, network: Network, nativeId: string): string {
  return `${prefix}_${digest(`${network}\0${nativeId}`)}`;
}

/**
 * Mail ids are per account (the manager's account id): sha256(accountId NUL key), as hubId. A message's key is
 * `m:<Message-ID>` (so a move keeps it), else `e:<emailId>` (the server's id in every mailbox), else
 * `x:<mailbox native id>/<native id>` (hub mail/store.ts identify).
 */
export function mailId(prefix: MailIdPrefix, accountId: string, key: string): string {
  return `${prefix}_${digest(`${accountId}\0${key}`)}`;
}

export function randomId(prefix: IdPrefix | MailIdPrefix): string {
  return `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')}`;
}
