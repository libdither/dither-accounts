/**
 * WhatsApp text <-> dither-chat canonical Markdown (protocol MessageFact.body).
 *
 *   WhatsApp   *bold*   _italic_   ~strike~    `code`  ```block```  > quote
 *   canonical  **bold** _italic_   ~~strike~~  `code`  ```block```  > quote
 *
 * WhatsApp has no underline, spoiler or links with text; those lose their markers going out.
 * Mentions: WhatsApp writes "@<user part of the JID>" in the text and lists the JIDs in
 * contextInfo.mentionedJID; canonical writes <@nativeId>.
 */

// A marker opens after start, whitespace or punctuation and before a non-space; it closes the other way round.
const EDGE = String.raw`(^|[\s\p{P}\p{S}])`;
const AFTER = String.raw`(?=$|[\s\p{P}\p{S}])`;
const span = (m: string) => new RegExp(`${EDGE}${m}(\\S(?:[^${m}\\n]*?\\S)?)${m}${AFTER}`, 'gu');
const WA_BOLD = span('\\*');
const WA_STRIKE = span('~');

/** Split text into code and non-code runs, so styling never reaches inside code. */
function splitCode(text: string): { code: boolean; v: string }[] {
  const out: { code: boolean; v: string }[] = [];
  const re = /```[\s\S]+?```|`[^`\n]+`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ code: false, v: text.slice(last, m.index) });
    out.push({ code: true, v: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ code: false, v: text.slice(last) });
  return out;
}

export interface FromWhatsAppOptions {
  /** mentionedJID: each @<user> in the text that matches one becomes <@native id>. */
  mentions?: string[];
  /** Native id for a mentioned JID (the adapter's alias table). */
  resolve?: (jid: string) => string;
}

/** WhatsApp text -> canonical Markdown. */
export function fromWhatsApp(text: string | null | undefined, opts: FromWhatsAppOptions = {}): string {
  if (!text) return '';
  const byUser = new Map<string, string>();
  for (const jid of opts.mentions ?? []) byUser.set(jid.split('@')[0].split(':')[0], jid);
  return splitCode(text)
    .map(({ code, v }) => {
      if (code) return v;
      let s = v.replace(WA_BOLD, '$1**$2**').replace(WA_STRIKE, '$1~~$2~~');
      if (byUser.size) {
        s = s.replace(/@(\d{5,20})\b/g, (all, user: string) => {
          const jid = byUser.get(user);
          return jid ? `<@${opts.resolve ? opts.resolve(jid) : jid}>` : all;
        });
      }
      return s;
    })
    .join('');
}

export interface WhatsAppText {
  text: string;
  /** JIDs for contextInfo.mentionedJID. */
  mentions: string[];
}

/**
 * canonical Markdown -> WhatsApp text. `jidOf` turns a mention's native id into the JID to put in
 * mentionedJID (null: write the name instead); `nameOf` names it when it cannot be a mention.
 */
export function toWhatsApp(md: string, jidOf: (nativeId: string) => string | null = (id) => (id.includes('@') ? id : null), nameOf?: (nativeId: string) => string | undefined): WhatsAppText {
  const mentions: string[] = [];
  const text = splitCode(md)
    .map(({ code, v }) => {
      if (code) return v;
      return (
        v
          .replace(/<@!?([^>\s]+)>/g, (_, id: string) => {
            const jid = jidOf(id);
            if (!jid) return `@${nameOf?.(id) ?? id}`;
            if (!mentions.includes(jid)) mentions.push(jid);
            return `@${jid.split('@')[0]}`;
          })
          .replace(/<#([^>\s]+)>/g, '#$1')
          .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, url: string) => (t === url ? url : `${t} (${url})`))
          .replace(/\|\|([\s\S]+?)\|\|/g, '$1')
          .replace(/\*\*\*([^*\n]+?)\*\*\*/g, '**_$1_**')
          // italic first, from *x* (single star) to _x_, before ** becomes *
          .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1_$2_')
          .replace(/\*\*([\s\S]+?)\*\*/g, '*$1*')
          .replace(/__([\s\S]+?)__/g, '$1')
          .replace(/~~([\s\S]+?)~~/g, '~$1~')
          .replace(/^-# /gm, '')
      );
    })
    .join('');
  return { text, mentions };
}
