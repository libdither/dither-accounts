/**
 * A whole message (Gmail's original, from its download route) read as mail.get gives it: mailparser (as the proton
 * kind reads a PGP/MIME body) for the headers, addresses, text and HTML, and attachments named by their IMAP part
 * numbers (`2`, `1.3`: mailparser's partId, the numbering the imap kind's attachment ids use; `1` for a message that
 * is one part). Threading and bulk headers are read as the imap and proton kinds read them: Message-IDs with their
 * angle brackets, raw values unfolded and cut to 300 characters.
 */
import type { MailAddress, MailAttachment, MailBulk } from '@dither-accounts/interfaces';
import { convert } from 'html-to-text';
import { type AddressObject, type Attachment, simpleParser } from 'mailparser';

export interface ParsedMessage {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bulk: MailBulk | null;
  subject: string | null;
  date: number | null;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  text: string | null;
  html: string | null;
  attachments: MailAttachment[];
  /** Each attachment's bytes, by its id. */
  parts: Map<string, Buffer>;
}

/** The Message-IDs in a header's value, `<…>` as written, in order, each once (none over 300 characters). */
export function messageIds(v: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const id of v?.match(/<[^<>\s]+>/g) ?? []) if (id.length <= 300) out.add(id);
  return [...out];
}
/** In-Reply-To's Message-ID (the first, when a client wrote more), bracketed; null without one. */
export function firstMessageId(v: string | null | undefined): string | null {
  const [id] = messageIds(v);
  if (id) return id;
  const bare = v?.trim();
  return bare && bare.length <= 298 && /^[^<>\s@]+@[^<>\s@]+$/.test(bare) ? `<${bare}>` : null;
}
/** One header's value as kept: control characters and runs of space made one space, trimmed, 300 characters. */
const headerValue = (v: string | null | undefined) => (v ? v.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 300) || null : null);

/** Every raw value of a header, unfolded, from mailparser's header lines. */
function rawHeaders(lines: { key: string; line: string }[], name: string): string[] {
  return lines.filter((l) => l.key === name).map((l) => l.line.slice(l.line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim());
}

const flat = (a: AddressObject | AddressObject[] | undefined): MailAddress[] => {
  const out: MailAddress[] = [];
  const add = (list: { address?: string; name?: string; group?: { address?: string; name?: string }[] }[]) => {
    for (const x of list) {
      if (x.group) add(x.group);
      else if (x.address) out.push({ name: x.name?.trim() || null, email: x.address });
    }
  };
  for (const o of a ? (Array.isArray(a) ? a : [a]) : []) add(o.value ?? []);
  return out;
};

function attachmentOf(a: Attachment): MailAttachment {
  return {
    id: a.partId || '1',
    filename: a.filename ?? null,
    mime: (a.contentType || 'application/octet-stream').toLowerCase(),
    size: a.size ?? a.content.length,
    inline: a.contentDisposition === 'inline' || !!a.related,
    contentId: a.cid ? a.cid.replace(/^<|>$/g, '') : null,
  };
}

export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  const p = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const lines = (p.headerLines ?? []) as { key: string; line: string }[];
  const one = (n: string) => rawHeaders(lines, n)[0] ?? null;
  const bulk: MailBulk = { listId: headerValue(one('list-id')), unsubscribe: headerValue(one('list-unsubscribe')), precedence: headerValue(one('precedence')), autoSubmitted: headerValue(one('auto-submitted')) };
  const html = typeof p.html === 'string' ? p.html : null;
  const text = p.text ?? (html ? convert(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }) : null);
  const parts = new Map<string, Buffer>();
  const attachments = p.attachments.map((a) => {
    const m = attachmentOf(a);
    parts.set(m.id, a.content);
    return m;
  });
  return {
    messageId: firstMessageId(one('message-id')),
    inReplyTo: firstMessageId(one('in-reply-to')),
    references: messageIds(rawHeaders(lines, 'references').join(' ')),
    bulk: bulk.listId || bulk.unsubscribe || bulk.precedence || bulk.autoSubmitted ? bulk : null,
    subject: p.subject ?? null,
    date: p.date && Number.isFinite(p.date.getTime()) ? p.date.getTime() : null,
    from: flat(p.from),
    to: flat(p.to),
    cc: flat(p.cc),
    bcc: flat(p.bcc),
    replyTo: flat(p.replyTo),
    text: text || null,
    html,
    attachments,
    parts,
  };
}
