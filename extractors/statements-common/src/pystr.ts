/**
 * Python's str methods where JavaScript's differ, for ports that must decide exactly as the pullers did: which
 * characters strip() and splitlines() treat as whitespace and line ends.
 */
const WS = '[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const PY_SPACE = new RegExp(`^${WS}+|${WS}+$`, 'g');
/** str.strip() with no arguments (Python's whitespace: not U+FEFF, but U+001C–U+001F and U+0085). */
export const pyStrip = (s: string) => s.replace(PY_SPACE, '');
const LINE_END = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85' + String.fromCharCode(0x2028, 0x2029) + ']');
/** str.splitlines(): no empty last line for a trailing line end. */
export function splitlines(s: string): string[] {
  if (!s) return [];
  const parts = s.split(LINE_END);
  if (parts.length && parts[parts.length - 1] === '' && LINE_END.test(s.slice(-2))) parts.pop();
  return parts;
}
