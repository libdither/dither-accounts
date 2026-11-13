/**
 * vCard (3.0 and 4.0) ↔ the `contacts` interface's Contact, with ical.js. A change rewrites only the properties of
 * the fields it gives (and the X-ABLabel of a group it empties); everything else in the card stays as it was. New
 * cards are vCard 3.0, which every CardDAV server takes (iCloud takes nothing else).
 */
import ICAL from 'ical.js';
import type { Contact, ContactInput, ContactValue } from '@dither-accounts/interfaces';
import { type Comp, invalid, parseComponent, type Prop } from './ical.ts';

// ical.js reads and writes vCard 4 URIs as text, escaping their commas (data:image/png;base64\,…); RFC 6350 does
// not escape URI values, so they go through as they are.
(ICAL.design as any).vcard.value.uri = {};

const prop = (j: any[]) => new ICAL.Property(j as any);
const first = (v: unknown): string | null => {
  if (Array.isArray(v)) return first(v[0]);
  return typeof v === 'string' && v.trim() ? v : null;
};
const parts = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? x.filter(Boolean).join(' ') : String(x ?? ''))) : [String(v ?? '')]);
const NOISE = new Set(['internet', 'pref', 'voice', 'x400', 'other']);

function typeOf(p: Prop): string | null {
  const raw = p.getParameter('type');
  const list = (Array.isArray(raw) ? raw : raw ? String(raw).split(',') : []).map((t) => String(t).toLowerCase().trim());
  const label = p.parent?.getAllProperties('x-ablabel').find((l) => l.getParameter('group') && l.getParameter('group') === p.getParameter('group'));
  const lv = label ? String(label.getFirstValue()).replace(/^_\$!<|>!\$_$/g, '').toLowerCase() : null;
  return list.find((t) => !NOISE.has(t)) ?? lv ?? null;
}

function values(c: Comp, name: string, map: (p: Prop) => string | null = (p) => first((p.jCal as any[])[3])): ContactValue[] {
  return c
    .getAllProperties(name)
    .map((p) => ({ value: map(p), type: typeOf(p) }))
    .filter((v): v is ContactValue => !!v.value);
}

/** A BDAY as YYYY-MM-DD or --MM-DD. */
function birthday(c: Comp): string | null {
  const p = c.getFirstProperty('bday');
  if (!p) return null;
  const v = String((p.jCal as any[])[3] ?? '');
  const omit = p.getParameter('x-apple-omit-year');
  let m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return omit && omit === m[1] ? `--${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^--(\d{2})-?(\d{2})/);
  return m ? `--${m[1]}-${m[2]}` : null;
}

function photo(c: Comp): string | null {
  const p = c.getFirstProperty('photo');
  if (!p) return null;
  const j = p.jCal as any[];
  const v = String(j[3] ?? '').replace(/\s+/g, '');
  if (!v) return null;
  const enc = String(p.getParameter('encoding') ?? '').toLowerCase();
  if (j[2] === 'binary' || enc === 'b' || enc === 'base64') {
    const t = String(p.getParameter('type') ?? 'jpeg').toLowerCase().replace(/^image\//, '');
    return `data:image/${t};base64,${v}`;
  }
  return v;
}

function stamp(c: Comp): number | null {
  const v = String((c.getFirstProperty('rev')?.jCal as any[] | undefined)?.[3] ?? '');
  const m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2}))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : null;
}

export function parseVcard(text: string): Comp {
  const c = parseComponent(text, 'a vCard');
  if (c.name !== 'vcard') throw invalid('that is not a vCard');
  return c;
}

/** One vCard as a Contact. */
export function contactFrom(text: string, ctx: { bookId: string; id: string; etag: string | null }): Contact {
  const c = parseVcard(text);
  const n = c.getFirstProperty('n');
  const nv = n ? ((n.jCal as any[])[3] as unknown) : null;
  const np = Array.isArray(nv) ? nv : typeof nv === 'string' ? nv.split(';') : [];
  const str = (name: string) => first((c.getFirstProperty(name)?.jCal as any[] | undefined)?.[3]);
  const org = c.getFirstProperty('org');
  return {
    id: ctx.id,
    bookId: ctx.bookId,
    uid: str('uid') ?? '',
    name: { full: str('fn'), given: first(np[1]), family: first(np[0]) },
    nickname: c.getAllProperties('nickname').flatMap((p) => (p.jCal as any[]).slice(3).flat()).filter(Boolean).join(', ') || null,
    emails: values(c, 'email'),
    phones: values(c, 'tel', (p) => first((p.jCal as any[])[3])?.replace(/^tel:/i, '') ?? null),
    addresses: values(c, 'adr', (p) => {
      const [pobox, ext, street, locality, region, code, country] = parts((p.jCal as any[])[3]).map((s) => s.trim());
      return [pobox, ext, street, locality, [region, code].filter(Boolean).join(' '), country].filter(Boolean).join(', ') || null;
    }),
    org: org ? parts((org.jCal as any[]).slice(3).length > 1 ? (org.jCal as any[]).slice(3) : (org.jCal as any[])[3]).filter(Boolean).join(', ') || null : null,
    title: str('title'),
    birthday: birthday(c),
    urls: c.getAllProperties('url').map((p) => first((p.jCal as any[])[3])).filter((u): u is string => !!u),
    note: str('note'),
    photo: photo(c),
    updated: stamp(c),
    etag: ctx.etag,
    vcard: text,
  };
}

/** Remove a field's properties, and the labels of any group they leave empty. */
function drop(c: Comp, name: string) {
  const groups = new Set(c.getAllProperties(name).map((p) => p.getParameter('group')).filter(Boolean));
  c.removeAllProperties(name);
  for (const g of groups) {
    const left = c.getAllProperties().filter((p) => p.getParameter('group') === g);
    if (left.every((p) => p.name === 'x-ablabel')) for (const p of left) c.removeProperty(p);
  }
}

const esc = (s: string | null | undefined) => (s ?? '').replace(/[\r\n]+/g, ' ');

/** A card with an app's change made (a new 3.0 card when there is none): the text and its UID. */
export function writeContact(base: string | null, input: ContactInput, now = Date.now()): { text: string; uid: string } {
  if (input.vcard) {
    const c = parseVcard(input.vcard);
    const uid = first((c.getFirstProperty('uid')?.jCal as any[] | undefined)?.[3]);
    if (!uid) throw invalid('the vCard has no UID');
    if (base) {
      const old = first((parseVcard(base).getFirstProperty('uid')?.jCal as any[] | undefined)?.[3]);
      if (old && old !== uid) throw invalid("a contact's uid cannot change");
    }
    return { text: c.toString(), uid };
  }
  const c = base ? parseVcard(base) : parseVcard(`BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${input.uid ?? crypto.randomUUID()}\r\nN:;;;;\r\nFN:\r\nEND:VCARD`);
  const v4 = String(c.getFirstPropertyValue('version')) === '4.0';
  const has = (k: keyof ContactInput) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  const uid = first((c.getFirstProperty('uid')?.jCal as any[] | undefined)?.[3]) ?? '';
  if (has('uid') && base && input.uid !== uid) throw invalid("a contact's uid cannot change");
  const add = (j: any[]) => c.addProperty(prop(j));
  const typed = (t: string | null) => (t ? { type: t } : {});

  if (has('name')) {
    const n = input.name!;
    const old = c.getFirstProperty('n');
    const ov = old ? ((old.jCal as any[])[3] as unknown) : null;
    const op = Array.isArray(ov) ? [...ov] : ['', '', '', '', ''];
    while (op.length < 5) op.push('');
    if (n.family !== undefined) op[0] = n.family ?? '';
    if (n.given !== undefined) op[1] = n.given ?? '';
    drop(c, 'n');
    add(['n', {}, 'text', op.map((x) => (Array.isArray(x) ? x : esc(String(x ?? ''))))]);
    if (n.full !== undefined) {
      drop(c, 'fn');
      add(['fn', {}, 'text', esc(n.full) || [n.given, n.family].filter(Boolean).join(' ')]);
    }
  }
  if (has('nickname')) {
    drop(c, 'nickname');
    if (input.nickname) add(['nickname', {}, 'text', esc(input.nickname)]);
  }
  for (const [key, name] of [['emails', 'email'], ['phones', 'tel'], ['addresses', 'adr']] as const) {
    if (!has(key)) continue;
    drop(c, name);
    for (const v of input[key]!) {
      if (!v?.value) continue;
      if (name === 'adr') add(['adr', typed(v.type), 'text', ['', '', esc(v.value), '', '', '', '']]);
      else if (name === 'tel') add(['tel', typed(v.type), v4 ? 'text' : 'phone-number', esc(v.value)]);
      else add(['email', typed(v.type), 'text', esc(v.value)]);
    }
  }
  if (has('org')) {
    drop(c, 'org');
    if (input.org) add(['org', {}, 'text', esc(input.org)]);
  }
  if (has('title')) {
    drop(c, 'title');
    if (input.title) add(['title', {}, 'text', esc(input.title)]);
  }
  if (has('note')) {
    drop(c, 'note');
    if (input.note) add(['note', {}, 'text', input.note]);
  }
  if (has('urls')) {
    drop(c, 'url');
    for (const u of input.urls!) if (u) add(['url', {}, 'uri', u]);
  }
  if (has('birthday')) {
    drop(c, 'bday');
    const b = input.birthday;
    if (b) {
      let m = b.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) add(['bday', {}, 'date', b]);
      else if ((m = b.match(/^--(\d{2})-(\d{2})$/))) {
        // vCard 4 has dates without a year; 3.0 does not, so Apple's way: a stand-in year it is told to leave out.
        if (v4) add(['bday', {}, 'date-and-or-time', `--${m[1]}${m[2]}`]);
        else add(['bday', { 'x-apple-omit-year': '1604' }, 'date', `1604-${m[1]}-${m[2]}`]);
      } else throw invalid('birthday is YYYY-MM-DD or --MM-DD');
    }
  }
  if (has('photo')) {
    drop(c, 'photo');
    const p = input.photo;
    if (p) {
      const m = p.match(/^data:image\/([\w.+-]+);base64,(.*)$/s);
      if (m && !v4) add(['photo', { encoding: 'b', type: m[1].toUpperCase() }, 'binary', m[2].replace(/\s+/g, '')]);
      else add(['photo', v4 ? {} : { value: 'uri' }, 'uri', p]);
    }
  }
  // FN is required: from the name, else the organisation, else an email.
  const fn = first((c.getFirstProperty('fn')?.jCal as any[] | undefined)?.[3]);
  if (!fn) {
    const ns = (c.getFirstProperty('n')?.jCal as any[] | undefined)?.[3];
    const guess = (Array.isArray(ns) ? [ns[1], ns[0]].map(first).filter(Boolean).join(' ') : '') || first((c.getFirstProperty('org')?.jCal as any[] | undefined)?.[3]) || first((c.getFirstProperty('email')?.jCal as any[] | undefined)?.[3]) || '';
    drop(c, 'fn');
    add(['fn', {}, 'text', guess]);
  }
  if (!c.hasProperty('n')) add(['n', {}, 'text', ['', '', '', '', '']]);
  drop(c, 'rev');
  add(['rev', {}, v4 ? 'timestamp' : 'date-time', new Date(now).toISOString().replace(/\.\d+Z$/, 'Z')]);
  return { text: c.toString(), uid };
}
