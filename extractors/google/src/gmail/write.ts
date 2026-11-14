/**
 * Gmail's writes, as the Gmail page makes them (docs/google.md, "Writing to Gmail"): the bodies of the sync calls (s)
 * that change labels, save a draft and send it, the upload of an attachment, and the reading of their answers. Pure:
 * no I/O here.
 *
 * Learned from the live page on 2026-11-13 by doing each action by hand in its live view while the shape recorder ran,
 * then from the full bodies of compose and send calls on test messages between the owner's own accounts. Every write
 * is one sync call, POST /sync/u/<n>/i/s:
 *
 *   [head, [[change, …]], client, [now, changes, now, sending ? 1 : 0, 49], 2]
 *
 * head is null, or [null, null, 2] when the call sends; client is [1, <sync point>, null, null, [null, 0], null, 1]
 * (null when it sends). Each change is [op, [<thread id>, detail]], `op` a number of the caller's that the answer
 * acknowledges: the answer's json[0] is [[[op, status, null, <sync point>], …]], status 0 when Gmail applied it.
 *
 *   label change   detail[6] = [add | null, remove | null, [msg-f:<id>, …], null ×9]: the labels listed are added to and
 *                  taken off the messages listed (not the rest of their thread). The page adds what it knows of the
 *                  message at [11] (its inbox tab, its sender, its category) and sometimes a time at [3] and a reason at
 *                  [8]; Gmail takes the change without them.
 *   draft          a new message: detail[2] = [[subject, null, now, thread-a:r-<n>, [record]]], a new thread of its own;
 *                  a reply: detail[1] = [record, msg-f:<the message answered>, 1, null, [now]], in that message's thread.
 *   send           detail[13] = [record, msg-f:<answered> | null, 1, null, [now]]: the draft again, with the sent labels.
 *
 * The record of a message being written has 78 positions (MESSAGE_RECORD below). Gmail answers a draft or a send with
 * the thread as it now is (json[1][5]), the message's record in it under the id the page made (msg-a:r-<n>): [13] its
 * Message-ID (Gmail's own), [14] References and [15] In-Reply-To (both from the message answered), [55] Gmail's id in
 * hex.
 *
 * After a send, the page posts one more change of its own, detail[25] = [1, <a long token>, [msg-a:…]], most likely an
 * anti-abuse attestation made by Google's script in the page. It is not made here: a send without it was delivered,
 * and so was a reply with an attachment and a Bcc.
 */
import type { MailAddress } from '@dither-accounts/interfaces';

/** The labels of a star's colour: the page's star adds ^t and the yellow one, and takes the others off. */
export const STAR_STYLES = ['^ss_sy', '^ss_so', '^ss_sr', '^ss_sp', '^ss_sb', '^ss_sg', '^ss_cr', '^ss_co', '^ss_cy', '^ss_cg', '^ss_cb', '^ss_cp'];
/** What leaving the inbox takes off besides ^i, as the page's archive, trash and move do (snoozes, priority marks). */
const OUT_OF_INBOX = ['^ri_hl', '^i', '^iim', '^t_p', '^t_rd', '^us'];

export interface LabelEdit {
  add: string[];
  remove: string[];
}
/** The label changes the page makes for each action, as recorded. */
export const EDITS = {
  /** Mark read: the toolbar's (opening a message also adds ^o, which a mark from here does not claim). */
  read: { add: [], remove: ['^u', '^us'] },
  unread: { add: ['^u'], remove: [] },
  star: { add: ['^t', '^ss_sy'], remove: STAR_STYLES.filter((l) => l !== '^ss_sy') },
  unstar: { add: [], remove: ['^t', ...STAR_STYLES] },
  /** Out of the inbox; Gmail adds ^a (archived). Also out of Trash and Spam, as the page's archive does. */
  archive: { add: ['^a'], remove: [...OUT_OF_INBOX, '^k', '^s', '^t_z', '^afw'] },
  /** Back to the inbox, from the archive, Trash or Spam. */
  inbox: { add: ['^i'], remove: ['^a', '^t_z', '^us', '^k', '^s', '^pr_i_u'] },
  trash: { add: ['^k'], remove: [...OUT_OF_INBOX, '^s', '^a', '^t_z', '^afw', '^pr_i_u'] },
  /** A reply's original: marked replied, as the page does when it sends one. */
  replied: { add: ['^io_re'], remove: ['^io_fwd'] },
} satisfies Record<string, LabelEdit>;
/** Move into one of your labels (the page's "Move to"): the label goes on, the inbox, Trash and Spam come off, other labels stay. */
export const intoLabel = (id: string): LabelEdit => ({ add: [id], remove: [...OUT_OF_INBOX, '^k', '^s'] });

/** The labels a message being written carries: a draft, and one sent. */
export const DRAFT_LABELS = ['^all', '^r', '^r_bt'];
export const SENT_LABELS = ['^all', '^pfg', '^f_bt', '^f_btns', '^f_cl'];

/** Every label a change here may add or take off: the hook refuses any other (extension/hook.js, writeShape). */
export const WRITE_LABEL = /^\^(?:u|us|o|t|ss_[a-z]{2}|i|a|k|s|t_z|ri_hl|iim|t_p|t_rd|afw|pr_i_u|io_re|io_fwd|x_\d{1,24})$/;

/** A label change: these messages of this thread gain and lose these labels. */
export function labelChange(op: number, thread: string, msgs: string[], e: LabelEdit): unknown[] {
  return [op, [`thread-f:${thread}`, [null, null, null, null, null, null, [e.add.length ? e.add : null, e.remove.length ? e.remove : null, msgs.map((m) => `msg-f:${m}`), null, null, null, null, null, null, null, null, null]]]];
}

/** The sync call that makes these changes. `history`: the newest sync point known (the page sends its own). */
export function writeRequest(changes: unknown[], o: { history: string | null; now: number; sending?: boolean }): unknown[] {
  const h = o.history && /^\d{1,15}$/.test(o.history) ? Number(o.history) : null;
  return [o.sending ? [null, null, 2] : null, [changes], o.sending ? null : [1, h, null, null, [null, 0], null, 1], [o.now, changes.length, o.now, o.sending ? 1 : 0, 49], 2];
}

/** A Gmail answer to a write not laid out as known: where, what was expected, what kind of thing was there. */
export class WriteLayoutError extends Error {
  constructor(
    readonly where: string,
    readonly expected: string,
    readonly got: string,
  ) {
    super(`at ${where}: expected ${expected}, got ${got}`);
  }
}
const kind = (v: unknown) => (v === null ? 'null' : v === undefined ? 'nothing' : Array.isArray(v) ? `a list of ${v.length}` : typeof v === 'string' ? 'a string' : typeof v);

/**
 * A write's answer: each op's status (0: applied), the sync point it left, and the changed threads (json[1][5]) for
 * the caller to read a sent message from. Fingerprint: json[0] a list holding one list of [op, status, …] entries.
 */
export function parseWrite(json: unknown): { acks: Map<number, number>; history: string | null; changed: unknown } {
  if (!Array.isArray(json)) throw new WriteLayoutError('json', 'a list', kind(json));
  const block = Array.isArray(json[0]) ? json[0][0] : undefined;
  if (!Array.isArray(block)) throw new WriteLayoutError('json[0][0]', 'the list of acknowledgements', kind(Array.isArray(json[0]) ? json[0][0] : json[0]));
  const acks = new Map<number, number>();
  let history: string | null = null;
  for (const [i, a] of block.entries()) {
    if (!Array.isArray(a) || !Number.isInteger(a[0]) || !Number.isInteger(a[1])) throw new WriteLayoutError(`json[0][0][${i}]`, '[op, status, …]', kind(a));
    acks.set(a[0], a[1]);
    if (Number.isInteger(a[3]) && a[3] >= 0) history = String(a[3]);
  }
  const changed = Array.isArray(json[1]) ? json[1][5] : null;
  return { acks, history, changed };
}

// ------------------------------------------------------------------ writing a message
/** Where each field of a message being written is (78 positions, as the page's). */
export const MESSAGE_RECORD = { id: 0, from: 1, to: 2, cc: 3, bcc: 4, date: 6, subject: 7, body: 8, labels: 10, attachments: 11, messageId: 13, references: 14, inReplyTo: 15, sentAt: 17, session: 51, sending: 74, session2: 76, length: 78 } as const;

/** An attachment as a draft names it: [mime, name, size, null, its id in this draft, null, 0, [], null, the upload's token]. */
export type DraftFile = [string, string, number, null, string, null, 0, [], null, string];
export const draftFile = (f: { mime: string; name: string; size: number; token: string; id: string }): DraftFile => [f.mime, f.name, f.size, null, f.id, null, 0, [], null, f.token];

export interface Writing {
  /** The page's kind of id for a message it writes: msg-a:r-<n>. */
  msgId: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  html: string;
  files: DraftFile[];
  /** The answered message's Message-ID (In-Reply-To); Gmail adds References itself. */
  inReplyTo: string | null;
  /** The page's compose session, `s:<16 hex>|#<msgId>|0`. */
  session: string;
}

const party = (a: MailAddress) => (a.name ? [1, a.email, a.name] : [1, a.email]);

/** A message being written, as the page lays it out: a draft's labels, or the sent ones. */
export function messageRecord(w: Writing, now: number, sending: boolean): unknown[] {
  const r: unknown[] = new Array(MESSAGE_RECORD.length).fill(null);
  r[0] = w.msgId;
  r[1] = [1, w.from.email, w.from.name ?? null, null, null, null, null, null, null, w.from.email];
  r[2] = w.to.map(party);
  r[3] = w.cc.length ? w.cc.map(party) : null;
  r[4] = w.bcc.length ? w.bcc.map(party) : null;
  r[6] = now;
  r[7] = w.subject;
  r[8] = [null, [[0, w.html]], null, null, null, null, 1];
  r[10] = sending ? SENT_LABELS : DRAFT_LABELS;
  r[11] = w.files.length ? w.files : null;
  r[15] = w.inReplyTo;
  r[17] = now;
  r[35] = [null, null, null, null, null, 0];
  r[36] = [null, null, null, 0];
  r[41] = 0;
  r[42] = [0, 0, 41, null, 0];
  r[51] = w.session;
  r[74] = sending ? 2 : null;
  r[76] = [null, null, null, null, null, null, w.session];
  r[77] = [];
  return r;
}

/** A draft's first save: a new thread of its own, or in the thread of the message it answers. */
export function draftChange(op: number, w: Writing, now: number, reply: { thread: string; message: string } | null, newThread: string): unknown[] {
  const rec = messageRecord(w, now, false);
  if (reply) return [op, [`thread-f:${reply.thread}`, [null, [rec, `msg-f:${reply.message}`, 1, null, [now]]]]];
  return [op, [newThread, [null, null, [[w.subject, null, now, newThread, [rec]]]]]];
}

/** The send: the draft saved again with the sent labels. */
export function sendChange(op: number, w: Writing, now: number, reply: { thread: string; message: string } | null, newThread: string): unknown[] {
  const rec = messageRecord(w, now, true);
  const detail: unknown[] = new Array(14).fill(null);
  detail[13] = [rec, reply ? `msg-f:${reply.message}` : null, 1, null, [now]];
  return [op, [reply ? `thread-f:${reply.thread}` : newThread, detail]];
}

/**
 * A sent message's record in a write's answer, found by the id the page made for it: its Message-ID, Gmail's id
 * (from [55], hex) and its labels. Null when the answer does not carry it.
 */
export function sentRecord(changed: unknown, msgId: string): { messageId: string | null; id: string | null; labels: string[] } | null {
  let found: unknown[] | null = null;
  const walk = (v: unknown, depth: number) => {
    if (found || depth > 12 || !Array.isArray(v)) return;
    if (v[0] === msgId && Array.isArray(v[10])) {
      found = v;
      return;
    }
    for (const x of v) walk(x, depth + 1);
  };
  walk(changed, 0);
  if (!found) return null;
  const r = found as unknown[];
  const messageId = typeof r[13] === 'string' && /^<[^<>\s]{3,900}>$/.test(r[13]) ? r[13] : null;
  const id = typeof r[55] === 'string' && /^[0-9a-f]{1,16}$/.test(r[55]) ? BigInt(`0x${r[55]}`).toString() : null;
  return { messageId, id, labels: (r[10] as unknown[]).filter((l): l is string => typeof l === 'string') };
}

// ------------------------------------------------------------------ ids the page makes
const randomBig = (bits: number) => {
  const a = new Uint32Array(Math.ceil(bits / 32));
  crypto.getRandomValues(a);
  let n = 0n;
  for (const x of a) n = (n << 32n) | BigInt(x);
  return n & ((1n << BigInt(bits)) - 1n);
};
/** The page's ids for what it writes: msg-a:r-<n> and thread-a:r-<n>, n a positive 63-bit number. */
export const newMessageId = () => `msg-a:r-${randomBig(63)}`;
export const newThreadId = () => `thread-a:r-${randomBig(63)}`;
export const newSession = (msgId: string) => `s:${randomBig(64).toString(16).padStart(16, '0')}|#${msgId}|0`;
/** An attachment's id within its draft, as the page makes them: f_ and nine base-36 characters. */
export const newFileId = () => `f_${randomBig(48).toString(36).padStart(9, '0').slice(-9)}`;

// ------------------------------------------------------------------ the body
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
/** Text as the page's composer writes it: escaped, a line break per newline, in its `<div dir="ltr">`. */
export function htmlOfText(text: string): string {
  return `<div dir="ltr">${text.replace(/[&<>"]/g, (c) => ESC[c]!).replace(/\r?\n/g, '<br>')}</div>`;
}

// ------------------------------------------------------------------ uploads
/**
 * The start of an attachment's upload, as the page posts it to /_/upload (Google's resumable upload, its metadata a
 * protobuf in base64url): 1 the draft's message id, 3 and 4 zero, 7 the sender, 8 each recipient, 11 zero.
 */
export function uploadMeta(msgId: string, from: string, recipients: string[]): string {
  const enc = new TextEncoder();
  const bytes: number[] = [];
  const str = (field: number, s: string) => {
    const b = enc.encode(s);
    bytes.push((field << 3) | 2);
    let n = b.length;
    while (n > 127) {
      bytes.push((n & 127) | 128);
      n >>= 7;
    }
    bytes.push(n, ...b);
  };
  const zero = (field: number) => bytes.push(field << 3, 0);
  str(1, msgId);
  zero(3);
  zero(4);
  str(7, from);
  for (const r of recipients) str(8, r);
  zero(11);
  return Buffer.from(bytes).toString('base64url');
}
/** What a finished upload answers: a token (base64 of Google's own reference to the file) the draft names it by. */
export const UPLOAD_TOKEN = /^[A-Za-z0-9+/_=-]{16,4000}$/;
