/**
 * Keys by name, as the `browser` interface takes them (xdotool's names: Return, Tab, ctrl+a, shift+Tab, Page_Down), as
 * X keysyms for the wayland backend's input, which goes through the live view's RFB socket (rfb.ts). RFB key events
 * carry keysyms; wayvnc finds each one's key in its US keymap. Only what a person types: modifiers, editing and
 * movement keys, F1–F12, the keypad's Enter, and the printable ASCII characters.
 */

export const KEYSYM: Record<string, number> = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  ISO_Left_Tab: 0xfe20,
  Linefeed: 0xff0a,
  Clear: 0xff0b,
  Return: 0xff0d,
  Pause: 0xff13,
  Scroll_Lock: 0xff14,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Prior: 0xff55,
  Page_Up: 0xff55,
  Next: 0xff56,
  Page_Down: 0xff56,
  End: 0xff57,
  Begin: 0xff58,
  Print: 0xff61,
  Insert: 0xff63,
  Menu: 0xff67,
  Num_Lock: 0xff7f,
  KP_Enter: 0xff8d,
  KP_Add: 0xffab,
  KP_Subtract: 0xffad,
  KP_Multiply: 0xffaa,
  KP_Divide: 0xffaf,
  Shift_L: 0xffe1,
  Shift_R: 0xffe2,
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Caps_Lock: 0xffe5,
  Meta_L: 0xffe7,
  Meta_R: 0xffe8,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  Super_L: 0xffeb,
  Super_R: 0xffec,
  space: 0x20,
  exclam: 0x21,
  quotedbl: 0x22,
  numbersign: 0x23,
  dollar: 0x24,
  percent: 0x25,
  ampersand: 0x26,
  apostrophe: 0x27,
  parenleft: 0x28,
  parenright: 0x29,
  asterisk: 0x2a,
  plus: 0x2b,
  comma: 0x2c,
  minus: 0x2d,
  period: 0x2e,
  slash: 0x2f,
  colon: 0x3a,
  semicolon: 0x3b,
  less: 0x3c,
  equal: 0x3d,
  greater: 0x3e,
  question: 0x3f,
  at: 0x40,
  bracketleft: 0x5b,
  backslash: 0x5c,
  bracketright: 0x5d,
  asciicircum: 0x5e,
  underscore: 0x5f,
  grave: 0x60,
  braceleft: 0x7b,
  bar: 0x7c,
  braceright: 0x7d,
  asciitilde: 0x7e,
};
for (let i = 1; i <= 12; i++) KEYSYM[`F${i}`] = 0xffbd + i;

/** xdotool's short names for the modifiers. */
const MODIFIER: Record<string, string> = { ctrl: 'Control_L', control: 'Control_L', shift: 'Shift_L', alt: 'Alt_L', super: 'Super_L', meta: 'Meta_L', win: 'Super_L' };

/** The characters a US keyboard types with Shift held. */
const SHIFTED = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:"<>?');

/** A key name's keysym (Return, a, F5, comma), or null when it is not one this knows. */
export function keysymOf(name: string): number | null {
  if (name in KEYSYM) return KEYSYM[name]!;
  const lower = name.toLowerCase();
  const exact = Object.keys(KEYSYM).find((k) => k.toLowerCase() === lower);
  if (exact) return KEYSYM[exact]!;
  if (name.length === 1) {
    const c = name.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7e) return c;
  }
  return null;
}

/** One key press: modifiers held (keysyms, in order) around one key. */
export interface Chord {
  mods: number[];
  key: number;
}

/** "ctrl+shift+Tab" → its chord; throws on a name it does not know. */
export function parseChord(combo: string): Chord {
  const parts = combo.split('+');
  // "ctrl++" is ctrl and plus.
  if (combo.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
  const keyName = parts.pop()!;
  const mods = parts.map((m) => {
    const sym = keysymOf(MODIFIER[m.toLowerCase()] ?? m);
    if (sym === null) throw new Error(`no modifier "${m}"`);
    return sym;
  });
  const key = keysymOf(keyName);
  if (key === null) throw new Error(`no key "${keyName}" (names as xdotool's: Return, Tab, Escape, ctrl+a, Page_Down)`);
  return { mods, key };
}

/** Text as runs: what the keyboard types (as chords, Shift where a US keyboard needs it), and what only an input method can. */
export type TextRun = { keys: Chord[] } | { text: string };

export function textRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const keyOf = (ch: string): Chord | null => {
    if (ch === '\n') return { mods: [], key: KEYSYM.Return! };
    if (ch === '\t') return { mods: [], key: KEYSYM.Tab! };
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c > 0x7e) return null;
    return { mods: SHIFTED.has(ch) ? [KEYSYM.Shift_L!] : [], key: c };
  };
  for (const ch of text) {
    const k = keyOf(ch);
    const last = runs[runs.length - 1];
    if (k) {
      if (last && 'keys' in last) last.keys.push(k);
      else runs.push({ keys: [k] });
    } else if (last && 'text' in last) last.text += ch;
    else runs.push({ text: ch });
  }
  return runs;
}
