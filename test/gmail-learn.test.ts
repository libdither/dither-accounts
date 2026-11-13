/**
 * The Gmail learn run's pure parts: the traffic shapes the Gmail page's hook records (extractors/google/src/
 * gmail-learn.js, whose shared block hook.js holds word for word), the one check every gmail.nav passes, and the
 * script's check (learn.ts). The browser side is in google-browser.test.ts.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaType, navHash, OPS, pathTemplate, requestShape, type Shape, shape, shapeBody } from '../extractors/google/src/gmail-learn.js';
import { checkLearnScript, describeStep, LEARN_LIMITS } from '../extractors/google/src/learn.ts';

const SRC = join(import.meta.dir, '../extractors/google/src');
/**
 * The content every input below is full of. It is not an identifier (it has a '#'), so where it is a whole object key
 * it cannot pass for a protocol's field name: keys that read as identifiers are kept, by design (docs/google.md).
 */
const MARK = 'Mk#7731';

/** The shared block of a file, line by line, without indentation (hook.js holds it inside its IIFE). */
function block(file: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('/* learn:begin'));
  const end = lines.findIndex((l) => l.trim() === '/* learn:end */');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1).map((l) => l.trim());
}

test('hook.js holds the same learn block as gmail-learn.js, and it names nothing of ours', () => {
  const module = block('gmail-learn.js');
  expect(block('extension/hook.js')).toEqual(module);
  expect(module.length).toBeGreaterThan(100);
  expect(module.join('\n')).not.toMatch(/dither/i);
});

test('strings: anchors are kept, everything else is a type tag', () => {
  // Anchors: system label ids, the kind of a thread or message id, header names (any case).
  for (const a of ['^i', '^all', '^smartlabel_social', '^io_im', '^t']) expect(shape(a)).toBe(a);
  expect(shape('thread-f:1800000000000000001')).toBe('id:thread-f');
  expect(shape('msg-f:1800000000000000001')).toBe('id:msg-f');
  expect(shape('thread-a:r-123456789')).toBe('id:thread-a');
  expect(shape('msg-a:r-987654321')).toBe('id:msg-a');
  for (const h of ['Message-ID', 'message-id', 'In-Reply-To', 'References', 'From', 'to', 'CC', 'Bcc', 'Reply-To', 'Subject', 'Date', 'List-Id', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted', 'Content-Type', 'Delivered-To', 'Return-Path', 'X-Gmail-Labels'])
    expect(shape(h)).toBe(h);
  // Not anchors: a label id with capitals or too long, an id prefix with anything but an id after it, other headers.
  expect(shape('^Secret')).toBe('s<10');
  expect(shape(`^${'a'.repeat(25)}`)).toBe('s<100');
  expect(shape('thread-f:')).toBe('s<10');
  expect(shape('thread-f:12 34')).toBe('s<100');
  expect(shape('X-Mailer')).toBe('s<10');
  // Tags.
  expect(shape('pat@example.com')).toBe('e');
  expect(shape('Pat Example <pat@example.com>')).toBe('e');
  expect(shape('0123456789abcdef')).toBe('h16');
  expect(shape('0123456789ABCDEF')).toBe('s<100');
  expect(shape('1731300000000')).toBe('d');
  expect(shape('2026-11-11')).toBe('ts');
  expect(shape('2026-11-11T10:00:00Z')).toBe('ts');
  expect(shape('2026-11-11T10:00:00.123+01:00')).toBe('ts');
  expect(shape('https://mail.google.com/mail/u/0/')).toBe('url');
  expect(shape('//ssl.gstatic.com/x.png')).toBe('url');
  expect(shape('QUJDREVGR0hJSktMTU5PUFFSU1RVVldY')).toBe('b64');
  expect(shape('AOuZoY5mPqRsTuVwXyZa_-==')).toBe('b64');
  expect(shape('')).toBe('s0');
  expect(shape('hello')).toBe('s<10');
  expect(shape('hello there, friend')).toBe('s<100');
  expect(shape('x '.repeat(200))).toBe('s<1k');
  expect(shape('x '.repeat(600))).toBe('s1k+');
  // A long text with an address in it is a text, not an address.
  expect(shape(`${'word '.repeat(80)}pat@example.com`)).toBe('s<1k');
});

test('numbers: booleans and null as they are, small integers kept, times by unit, the rest n', () => {
  expect([true, false, null].map(shape)).toEqual([true, false, null]);
  expect([0, 1, 7, 64].map(shape)).toEqual([0, 1, 7, 64]);
  expect([65, 1000, -1, 1.5, 123456789012345].map(shape)).toEqual(['n', 'n', 'n', 'n', 'n']);
  expect(shape(1731300000000)).toBe('n:ms');
  expect(shape(1731300000)).toBe('n:s');
  expect(shape(undefined)).toBeNull();
});

test('arrays keep 40 elements by position and say how long longer ones are; objects keep identifier keys; depth is capped at 20', () => {
  expect(shape([1, 'a', null, true])).toEqual([1, 's<10', null, true]);
  expect(shape([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
  expect(shape(Array.from({ length: 41 }, (_, i) => i % 3))).toEqual([...Array.from({ length: 40 }, (_, i) => i % 3), 'len:<100']);
  expect(shape(Array.from({ length: 150 }, (_, i) => i))).toEqual([...Array.from({ length: 40 }, (_, i) => i), 'len:<1k']);
  expect(shape(Array.from({ length: 1500 }, () => 'x'))).toEqual([...Array.from({ length: 40 }, () => 's<10'), 'len:1k+']);
  // Keys that are not identifiers are k* (the first one's value: '1' comes first, as JS orders keys).
  expect(shape({ id: 'abc', 'f.req': 1, _x: 2, 'a-b': 3, '1': 4, 'pat@example.com': 'Pat', 'two words': 5 })).toEqual({ id: 's<10', 'f.req': 1, _x: 2, 'a-b': 3, 'k*': 4 });
  // __proto__ is no key of ours to set.
  const proto = shape(JSON.parse('{"__proto__": {"polluted": 1}, "ok": 1}')) as Record<string, Shape>;
  expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
  expect(proto).toEqual({ 'k*': { polluted: 1 }, ok: 1 });
  // A map-like object keeps its first 48 keys and says how many there were.
  const many = shape(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]))) as Record<string, Shape>;
  expect(Object.keys(many).length).toBe(49);
  expect(many['k#']).toBe('len:<100');
  // Depth: 20 levels of containers, then '…'.
  let deep: unknown = 'leaf';
  for (let i = 0; i < 26; i++) deep = [deep];
  let s: Shape = shape(deep);
  let levels = 0;
  while (Array.isArray(s)) {
    levels++;
    s = s[0]!;
  }
  expect([levels, s]).toEqual([20, '…']);
  let shallow: unknown = 'leaf';
  for (let i = 0; i < 20; i++) shallow = { a: shallow };
  expect(JSON.stringify(shape(shallow))).toContain('"s<10"');
});

test('bodies: JSON after an XSSI prefix, chunks, forms (each value JSON when it parses), and anything else by its length', () => {
  const rows = [['^i', [`thread-f:1`, 'Hello'], 1731300000000, 3]];
  const want = { json: [['^i', ['id:thread-f', 's<10'], 'n:ms', 3]] };
  expect(shapeBody(`)]}'\n${JSON.stringify(rows)}`, 'application/json')).toEqual(want);
  expect(shapeBody(`)]}',\n${JSON.stringify(rows)}`, 'application/json; charset=utf-8')).toEqual(want);
  expect(shapeBody(`while(1);${JSON.stringify(rows)}`, 'text/javascript')).toEqual(want);
  expect(shapeBody(`for(;;);${JSON.stringify(rows)}`, null)).toEqual(want);
  expect(shapeBody(JSON.stringify(rows), null)).toEqual(want);
  // Google's length-prefixed frames, one JSON per line.
  expect(shapeBody(`)]}'\n\n45\n[["wrb.fr","x",null]]\n25\n[["e",4,null,null,5]]\n`, 'application/json')).toEqual({ chunks: [[['s<10', 's<10', null]], [['s<10', 4, null, null, 5]]] });
  // Forms: by type, by how it reads, or a URLSearchParams.
  const f = `f.req=${encodeURIComponent(JSON.stringify([['^i', 50], 'secret words']))}&at=${encodeURIComponent('AOuZoY5mPqRsTuVwXyZa:1731300000000')}&n=7&flag=true&empty=`;
  const wantForm = { form: { 'f.req': [['^i', 50], 's<100'], at: 's<100', n: 7, flag: true, empty: 's0' } };
  expect(shapeBody(f, 'application/x-www-form-urlencoded;charset=utf-8')).toEqual(wantForm);
  expect(shapeBody(f, null)).toEqual(wantForm);
  expect(shapeBody(new URLSearchParams(f), null)).toEqual(wantForm);
  // A form whose type says so is a form even when its text is JSON.
  expect(shapeBody('{"a":1}', 'application/x-www-form-urlencoded')).toEqual({ form: { 'k*': 's0' } });
  const fd = new FormData();
  fd.append('to', 'pat@example.com');
  fd.append('file', new Blob(['x']), 'x.txt');
  expect(shapeBody(fd, null)).toEqual({ multipart: { to: 'e', file: 'file' } });
  // Not JSON: its length only.
  expect(shapeBody('<html><body>Hello there</body></html>', 'text/html')).toEqual({ text: '<100' });
  expect(shapeBody('', 'text/plain')).toEqual({ text: '0' });
  expect(shapeBody(new Blob(['abc']), null)).toEqual({ binary: '<10' });
  expect(shapeBody(new Uint8Array(2000), null)).toEqual({ binary: '1k+' });
  // Already parsed (an XMLHttpRequest's responseType 'json').
  expect(shapeBody({ a: ['x'] }, 'application/json')).toEqual({ json: { a: ['s<10'] } });
  expect(shapeBody(null, null)).toBeNull();
  // A value that is JSON is its JSON's shape (1731300000: seconds); one that is not, a string's (a leading 0: digits).
  expect(requestShape('?hl=en&c=0&rt=r&t=1731300000&ik=0123456789', null, null)).toEqual({ query: { hl: 's<10', c: 0, rt: 's<10', t: 'n:s', ik: 'd' } });
  expect(requestShape('', 'application/json', '[1]')).toEqual({ body: { json: [1] } });
  expect(mediaType('Application/JSON; charset=utf-8')).toBe('application/json');
  expect(mediaType('nonsense')).toBeNull();
});

test('path templates: ids and numbers out, the protocol kept', () => {
  expect(pathTemplate('/sync/u/0/i/bv')).toBe('/sync/u/0/i/bv');
  expect(pathTemplate('/sync/u/12/i/fd')).toBe('/sync/u/12/i/fd');
  expect(pathTemplate('/mail/u/0/x/abc123/')).toBe('/mail/u/0/x/{id}/');
  expect(pathTemplate('/mail/u/0/')).toBe('/mail/u/0/');
  expect(pathTemplate('/a/123456/b')).toBe('/a/{n}/b');
  expect(pathTemplate('/a/pat%40example.com/b')).toBe('/a/{id}/b');
  expect(pathTemplate('/a/averyveryverylongsegmentname/b')).toBe('/a/{id}/b');
  expect(pathTemplate('/_/scs/mail-static/_/js/k=gmail.main.en.x/m=b')).toBe('/_/scs/mail-static/_/js/{id}/{id}');
});

test('nav: the views and operators-only searches, in Gmail’s form; anything else refused without echoing it', () => {
  for (const v of ['#inbox', '#all', '#starred', '#sent']) expect(navHash(v)).toBe(v);
  expect(navHash('#search/in:inbox is:read')).toBe('#search/in%3Ainbox+is%3Aread');
  expect(navHash('#search/in%3Ainbox+is%3Aread')).toBe('#search/in%3Ainbox+is%3Aread');
  expect(navHash('#search/after:2026/01/01 before:2026/02/01 larger:5M')).toBe('#search/after%3A2026%2F01%2F01+before%3A2026%2F02%2F01+larger%3A5M');
  for (const op of OPS) expect(navHash(`#search/${op}:x`)).toBe(`#search/${op}%3Ax`);
  const refused = [
    '#search/dinner',
    '#search/in:inbox dinner plans',
    '#search/from:pat@example.com',
    '#search/to:someone',
    '#search/subject:dinner',
    '#search/"in:inbox"',
    "#search/in:'inbox'",
    '#search/-is:read',
    '#search/is:read OR is:starred',
    '#search/(is:read)',
    '#search/{is:read is:starred}',
    '#search/is:read:x',
    '#search/IS:read',
    '#search/is:',
    '#search/ ',
    '#search/',
    '#search/%E0%A4%A',
    `#search/${Array(9).fill('is:read').join(' ')}`,
    '#label/Secret',
    '#inbox/FMfcgabc',
    '#spam',
    'inbox',
    '',
  ];
  for (const h of refused) {
    let err: Error | null = null;
    try {
      navHash(h);
    } catch (e) {
      err = e as Error;
    }
    expect({ h, refused: !!err }).toEqual({ h, refused: true });
    for (const word of ['dinner', 'pat@', 'someone', 'Secret', 'FMfcg']) expect(err!.message).not.toContain(word);
  }
  expect(() => navHash(7)).toThrow('nav: the hash is not a string');
});

test('the learn script: checked as a whole, with its limits', () => {
  const ok = checkLearnScript({ steps: [{ nav: '#search/in:inbox is:read' }, { wait: 2 }, { openRead: 0 }, { wait: 1.5 }, { back: true }, { collect: true }] });
  expect(ok).toEqual({ steps: [{ nav: '#search/in%3Ainbox+is%3Aread' }, { wait: 2 }, { openRead: 0 }, { wait: 1.5 }, { back: true }, { collect: true }] });
  const err = (raw: unknown) => {
    const r = checkLearnScript(raw);
    return 'error' in r ? r.error : null;
  };
  expect(LEARN_LIMITS).toMatchObject({ steps: 12, openRead: 5, waitMin: 1, waitMax: 20 });
  expect(err({ steps: Array(5).fill({ openRead: 0 }) })).toBeNull();
  expect(err({ steps: Array(6).fill({ openRead: 0 }) })).toBe('more than 5 openRead steps; at most 5 in a run');
  expect(err({ steps: Array(12).fill({ wait: 1 }) })).toBeNull();
  expect(err({ steps: Array(13).fill({ wait: 1 }) })).toBe('13 steps; at most 12');
  expect(err({ steps: [{ nav: '#search/in:inbox dinner plans' }] })).toStartWith('step 1: nav: search word 2 is not an operator');
  expect(err({ steps: [{ collect: true }, { nav: '#search/from:pat' }] })).toStartWith('step 2: nav: search word 1 is not an operator');
  expect(err({ steps: [{ wait: 0 }] })).toBe('step 1: a wait is 1 to 20 seconds');
  expect(err({ steps: [{ wait: 21 }] })).toBe('step 1: a wait is 1 to 20 seconds');
  expect(err({ steps: [{ wait: '5' }] })).toBe('step 1: a wait is 1 to 20 seconds');
  for (const n of [-1, 1.5, 50, '0', null]) expect(err({ steps: [{ openRead: n }] })).toBe('step 1: openRead takes a row index, 0 to 49');
  expect(err({ steps: [{ back: false }] })).toBe('step 1: back is { "back": true }');
  expect(err({ steps: [{ collect: 'yes' }] })).toBe('step 1: collect is { "collect": true }');
  expect(err({ steps: [{ click: 3 }] })).toBe('step 1 is not one of { nav | wait | openRead | back | collect }');
  expect(err({ steps: [{ wait: 1, back: true }] })).toBe('step 1 is not one of { nav | wait | openRead | back | collect }');
  expect(err({ steps: [], more: 1 })).toBe('the script holds anything but steps');
  expect(err({ steps: [] })).toBe('steps is not a list of steps');
  expect(err([{ wait: 1 }])).toBe('the script is not an object { steps: [...] }');
  expect(err(null)).toBe('the script is not an object { steps: [...] }');
  // The log names a step by its kind; a search by how many operators it has, never its words.
  expect(describeStep({ nav: '#search/in%3Ainbox+label%3ATaxes' })).toBe('nav to a search (2 operators)');
  expect(describeStep({ nav: '#inbox' })).toBe('nav to #inbox');
  expect([{ wait: 2 }, { openRead: 1 }, { back: true }, { collect: true }].map((s) => describeStep(s as any))).toEqual(['wait 2 s', 'openRead 1', 'back', 'collect']);
});

/** Every string a shape holds: its leaves and its keys. */
function strings(s: unknown, out: string[] = []): string[] {
  if (typeof s === 'string') out.push(s);
  else if (Array.isArray(s)) for (const x of s) strings(x, out);
  else if (s && typeof s === 'object')
    for (const [k, v] of Object.entries(s)) {
      out.push(k);
      strings(v, out);
    }
  return out;
}

test('no content survives: inputs full of a marker shape to tags and anchors, and every anchor is still there', () => {
  const m = MARK;
  const message = {
    id: `msg-f:1800000000000000017`,
    thread: 'thread-f:1800000000000000001',
    labels: ['^i', '^smartlabel_personal', `Label ${m}`, `^${m}`],
    // (An array keeps its first 4 elements: the anchors are where a shape keeps them.)
    headers: [
      ['Subject', `Re: ${m} dinner plans`],
      ['From', `${m} Person <${m}@example.com>`],
      ['Message-ID', `<${m}.1@mail.example.com>`],
      ['X-Gmail-Labels', `^i,${m}`],
    ],
    to: [['To', `"${m}" <other@example.org>`], ['Subject', m.repeat(3)]],
    [`${m}@example.com`]: { name: `${m} Person`, [m]: m, [`Re: ${m}`]: [m, m, m] },
    body: `<div>Dear ${m},\n${m} wrote: ${m.repeat(400)}</div>`,
    snippet: `${m} …`,
    sizes: [`${m}`, `thread-f:${m}`, `${m}0123456789abcdef`, `2026-11-11${m}`, `https://example.com/${m}`],
  };
  const deep = [[message, [message, message]], `${m}`, { [m]: message }];
  const inputs: unknown[] = [
    shape(message),
    shape(deep),
    shapeBody(`)]}'\n${JSON.stringify(deep)}`, 'application/json'),
    shapeBody(`)]}'\n\n12\n${JSON.stringify(message)}\n9\n${JSON.stringify([m])}\n`, 'application/json'),
    shapeBody(`f.req=${encodeURIComponent(JSON.stringify(deep))}&${encodeURIComponent(m)}=${encodeURIComponent(m)}&q=${encodeURIComponent(`from:${m}`)}`, 'application/x-www-form-urlencoded'),
    shapeBody(`<html>${m}</html>`, 'text/html'),
    requestShape(`?q=${encodeURIComponent(m)}&${encodeURIComponent(m)}=1`, 'application/json', JSON.stringify(message)),
    pathTemplate(`/mail/u/0/x/${encodeURIComponent(m)}/${encodeURIComponent(`${m}@example.com`)}/`),
  ];
  const out = JSON.stringify(inputs);
  expect(out).not.toContain(m);
  for (const part of m.split('#')) expect(out).not.toContain(part);
  // Every anchor made it.
  for (const anchor of ['^i', '^smartlabel_personal', 'id:msg-f', 'id:thread-f', 'Subject', 'From', 'To', 'Message-ID', 'X-Gmail-Labels']) expect(out).toContain(`"${anchor}"`);
  expect(inputs[7]).toBe('/mail/u/0/x/{id}/{id}/');
});

test('whatever the input, a shape holds only tags, anchors and identifier keys', () => {
  // A small seeded generator of JSON with strings of every sort.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const word = () => pick(['plans', `${MARK}`, 'Pat Example', 'pat@example.com', '^i', 'thread-f:1', 'Subject', '2026-11-11', '0123456789abcdef', 'https://x.example/a', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY', '', '12345', 'a b c'.repeat(Math.floor(rnd() * 400))]);
  const gen = (d: number): unknown => {
    const r = rnd();
    // Leaves grow likelier with depth, so a tree stays small; one in a few goes past the depth cap.
    if (d > 23 || r < 0.35 + d * 0.04) return pick([word(), Math.floor(rnd() * 1e14), rnd(), true, null, 3]);
    if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 9) }, () => gen(d + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 6) }, () => [pick([word(), 'id', 'f.req', `k${Math.floor(rnd() * 9)}`]), gen(d + 1)]));
  };
  const TAG = /^(e|h16|d|ts|url|b64|s0|s<10|s<100|s<1k|s1k\+|n|n:ms|n:s|len:(0|<10|<100|<1k|1k\+)|…|k\*|k#|id:(thread|msg)-[fa]|\^[a-z0-9_]{1,24})$/;
  const HEADER = /^(message-id|in-reply-to|references|from|to|cc|bcc|reply-to|subject|date|list-id|list-unsubscribe|precedence|auto-submitted|content-type|delivered-to|return-path|x-gmail-labels)$/i;
  const KEY = /^[A-Za-z_][\w.-]{0,40}$/;
  for (let i = 0; i < 300; i++) {
    const s = shape(gen(0));
    const leaves: string[] = [];
    const keys: string[] = [];
    const walk = (x: unknown) => {
      if (typeof x === 'string') leaves.push(x);
      else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object')
        for (const [k, v] of Object.entries(x)) {
          keys.push(k);
          walk(v);
        }
    };
    walk(s);
    for (const l of leaves) expect({ l, ok: TAG.test(l) || HEADER.test(l) }).toEqual({ l, ok: true });
    for (const k of keys) expect({ k, ok: KEY.test(k) || k === 'k*' || k === 'k#' }).toEqual({ k, ok: true });
    expect(strings(s).join('\n')).not.toContain(MARK);
  }
});
