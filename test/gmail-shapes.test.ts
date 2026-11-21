/**
 * Gmail's answers bent every way they can bend (extractors/google/src/gmail/protocol.ts): each hand-made shape under
 * test/gmail-shapes/ (type tags and anchors only, as the shape recorder keeps them: never a value from a real answer)
 * is filled with invented values into a whole answer, then every place in it is mutated in turn: made null, taken out,
 * given a value of another type, given an extra element, or swapped with its neighbour. Whatever the mutation:
 *
 * - nothing but a LayoutError comes out of a reader;
 * - a mutation inside one message costs that message at most: every other message is read as before, and the one is
 *   read, listed in `skipped` (by its id, or its thread when its id is what broke) or left out as a null-labels message;
 * - a mutation inside one thread row (outside its messages) costs that row's messages at most;
 * - a mutation of a whole-answer anchor (json[0], the closing number, the sync block and its sync point) refuses the
 *   whole answer;
 * - every message broken alike refuses the whole answer (a changed layout, not a run of bad records).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LayoutError, parseBv, parseFd, parseS } from '../extractors/google/src/gmail/protocol.ts';

type Path = number[];
const DIR = join(import.meta.dir, 'gmail-shapes');
const load = (name: string): unknown => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));

/** A shape's type tags filled with invented values, each id its own. Anchors (label ids, small numbers) stay as they are. */
export function fill(tags: unknown): unknown {
  let k = 0;
  const id = () => 1_800_000_000_000_000_000n + BigInt(++k);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== 'string') return v;
    if (v === 'id:thread-f') return `thread-f:${id()}`;
    if (v === 'id:msg-f') return `msg-f:${id()}`;
    if (v === 'n') return 4242 + k++;
    if (v === 'n:ms') return 1_790_000_000_000 + ++k * 60_000;
    if (v === 'd') return String(100 + k++);
    if (v === 'e') return `ann${k++}@example.com`;
    if (v === 'h16') return id().toString(16).padStart(16, '0');
    if (v === 's<10') return 'Ann Lee';
    if (v === 's<100') return 'Lunch on Friday';
    return v; // a label id, or another anchor kept as it is
  };
  return walk(tags);
}

const at = (v: unknown, p: Path): unknown => p.reduce<unknown>((x, i) => (Array.isArray(x) ? x[i] : undefined), v);
const key = (p: Path) => p.join('.');
const within = (p: Path, q: Path) => p.length > q.length && q.every((x, i) => p[i] === x);

/** Every place in an answer that a list holds, depth first. */
function places(v: unknown, p: Path = []): Path[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x, i) => [[...p, i], ...places(x, [...p, i])]);
}

/** Places of records by their anchors: messages (a msg-f id first) and rows (bv's and s's: a thread id at [3]; fd's: at [0]). */
function records(v: unknown, fdRows: boolean) {
  const msgs: { path: Path; id: string }[] = [];
  const rows: Path[] = [];
  for (const p of places(v)) {
    const x = at(v, p);
    if (!Array.isArray(x)) continue;
    if (typeof x[0] === 'string' && x[0].startsWith('msg-f:')) msgs.push({ path: p, id: x[0].slice(6) });
    if (fdRows ? typeof x[0] === 'string' && x[0].startsWith('thread-f:') && Array.isArray(x[1]) : typeof x[3] === 'string' && x[3].startsWith('thread-f:')) rows.push(p);
  }
  return { msgs, rows };
}

type Mutation = { name: string; apply: (parent: unknown[], i: number) => void };
const MUTATIONS: Mutation[] = [
  { name: 'null', apply: (a, i) => void (a[i] = null) },
  { name: 'deleted', apply: (a, i) => void a.splice(i, 1) },
  {
    name: 'another type',
    apply: (a, i) => {
      const v = a[i];
      a[i] = v === null ? [] : typeof v === 'string' ? 7 : Array.isArray(v) ? 'x' : typeof v === 'number' ? 'x' : 7;
    },
  },
  { name: 'an extra element', apply: (a, i) => void a.splice(i, 0, structuredClone(a[i])) },
  { name: 'moved', apply: (a, i) => void (i + 1 < a.length ? ([a[i], a[i + 1]] = [a[i + 1], a[i]]) : a.unshift(a.pop())) },
];

interface Read {
  ids: string[];
  skipped: { id: string | null; thread: string | null }[];
  nullLabels: string[];
}
type Reader = (json: unknown) => Read;
const fromRows = (r: { rows: { messages: { id: string | null }[]; nullLabels: string[] }[]; skipped: { id: string | null; thread: string | null }[] }): Read => ({
  ids: r.rows.flatMap((x) => x.messages.map((m) => m.id!)),
  skipped: r.skipped,
  nullLabels: r.rows.flatMap((x) => x.nullLabels),
});
const READERS: { name: string; file: string; read: Reader; fdRows: boolean; anchors: Path[] }[] = [
  { name: 'bv (own layout)', file: 'bv-own', read: (j) => fromRows(parseBv(j)), fdRows: false, anchors: [[0], [18], [18, 0]] },
  { name: 'bv (page layout)', file: 'bv-page', read: (j) => fromRows(parseBv(j)), fdRows: false, anchors: [[0], [18], [18, 0]] },
  { name: 's', file: 's', read: (j) => fromRows(parseS(j)), fdRows: false, anchors: [[1], [1, 0], [1, 7]] },
  {
    name: 'fd',
    file: 'fd',
    read: (j) => {
      const r = parseFd(j);
      return { ids: r.threads.flatMap((t) => t.messages.map((m) => m.id!)), skipped: r.skipped, nullLabels: r.threads.flatMap((t) => t.nullLabels) };
    },
    fdRows: true,
    anchors: [[0], [1]],
  },
];
const sorted = (a: string[]) => [...a].sort();

for (const r of READERS) {
  test(`${r.name}: every place mutated every way; only LayoutError escapes, a broken record costs only itself, whole-answer anchors refuse`, () => {
    const base = fill(load(r.file));
    const good = r.read(base);
    const { msgs, rows } = records(base, r.fdRows);
    expect(sorted(good.ids)).toEqual(sorted(msgs.map((m) => m.id)));
    expect(good.skipped).toEqual([]);
    expect(msgs.length).toBeGreaterThanOrEqual(4);
    const thread = (p: Path) => {
      const row = rows.find((q) => within(p, q));
      const v = row ? at(base, row) : undefined;
      return Array.isArray(v) ? String(r.fdRows ? v[0] : v[3]).replace(/^thread-f:/, '') : null;
    };
    let tried = 0;
    for (const p of places(base)) {
      for (const m of MUTATIONS) {
        const json = structuredClone(base) as unknown[];
        const parent = at(json, p.slice(0, -1)) as unknown[];
        m.apply(parent, p.at(-1)!);
        tried++;
        const what = `${m.name} at ${key(p)}`;
        let out: Read | null = null;
        let err: unknown = null;
        try {
          out = r.read(json);
        } catch (e) {
          err = e;
        }
        // Nothing but a LayoutError, ever; and its sentence names places and kinds, never a value.
        if (err) {
          expect({ what, layout: err instanceof LayoutError }).toEqual({ what, layout: true });
          expect((err as Error).message).not.toMatch(/example\.com|Lunch|Ann Lee|18000000/);
        }
        // A whole-answer anchor made null, taken out or of another type: the answer refused.
        if (r.anchors.some((a) => key(a) === key(p)) && ['null', 'deleted', 'another type'].includes(m.name)) {
          expect({ what, refused: !!err }).toEqual({ what, refused: true });
          continue;
        }
        const msg = msgs.find((x) => key(x.path) === key(p) || within(p, x.path));
        const row = rows.find((q) => key(q) === key(p) || within(p, q));
        if (msg) {
          // Inside one message (or the message itself): that one at most; the rest read as before.
          expect({ what, refused: !!err }).toEqual({ what, refused: false });
          const others = msgs.filter((x) => x !== msg).map((x) => x.id);
          for (const id of others) expect({ what, id, read: out!.ids.includes(id) }).toEqual({ what, id, read: true });
          // (A message taken out whole is one Gmail did not send: nothing to name.)
          if (!out!.ids.includes(msg.id) && !(m.name === 'deleted' && key(p) === key(msg.path))) {
            const named = out!.nullLabels.includes(msg.id) || out!.skipped.some((s) => s.id === msg.id || (s.id === null && s.thread === thread(msg.path)));
            expect({ what, named }).toEqual({ what, named: true });
          }
        } else if (row && !['an extra element', 'moved'].includes(m.name)) {
          // Inside one row, outside its messages: that row's messages at most.
          expect({ what, refused: !!err }).toEqual({ what, refused: false });
          const others = msgs.filter((x) => !within(x.path, row)).map((x) => x.id);
          for (const id of others) expect({ what, id, read: out!.ids.includes(id) }).toEqual({ what, id, read: true });
        }
      }
    }
    expect(tried).toBeGreaterThan(500);
  });

  test(`${r.name}: every message broken alike is a changed layout, and the whole answer is refused`, () => {
    const json = fill(load(r.file));
    for (const m of records(json, r.fdRows).msgs) {
      const rec = at(json, m.path) as unknown[];
      rec[r.fdRows ? 2 : 6] = 'x'; // the date
    }
    expect(() => r.read(json)).toThrow(LayoutError);
    expect(() => r.read(json)).toThrow(/records failed/);
  });
}
