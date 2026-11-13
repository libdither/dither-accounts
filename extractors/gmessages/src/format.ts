/**
 * dither-chat's canonical Markdown (protocol MessageFact.body) -> what an SMS or RCS message says. Neither has any
 * formatting, so styling markers go, mentions become names and links keep their address. Incoming text is kept as
 * it is: a text message has no markup to translate.
 */

/** Runs of text and code, so nothing is changed inside code. */
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

export function toPlain(body: string, nameOf: (identity: string) => string, convName: (conversation: string) => string = (c) => c): string {
  return splitCode(body)
    .map(({ code, v }) => {
      if (code) return v.replace(/^```\w*\n?|```$/g, '').replace(/^`|`$/g, '');
      return v
        .replace(/<@([^>\s]+)>/g, (_, id: string) => `@${nameOf(id)}`)
        .replace(/<#([^>\s]+)>/g, (_, id: string) => `#${convName(id)}`)
        .replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_, t: string, u: string) => (t === u ? u : `${t} (${u})`))
        .replace(/\*\*(\S(?:[^*\n]*?\S)?)\*\*/g, '$1')
        .replace(/__(\S(?:[^_\n]*?\S)?)__/g, '$1')
        .replace(/~~(\S(?:[^~\n]*?\S)?)~~/g, '$1')
        .replace(/\|\|(\S(?:[^|\n]*?\S)?)\|\|/g, '$1');
    })
    .join('');
}

/** A phone number as an identity's native id: digits, with the + of an international number. Null if it is not one. */
export function phoneKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^\+?[\d\s().-]{3,}$/.test(s)) return null;
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length < 3) return null;
  return s.startsWith('+') ? `+${digits}` : digits;
}
