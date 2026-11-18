/**
 * The Gmail canary (docs/google.md, "The Gmail canary"): the self-check run on its own, once the Gmail page has been
 * ready a while after a start and then once a day, reading no message (lists, searches and the mailboxes only). It
 * keeps a fingerprint of the answers' shapes in the account's directory (gmail-canary.json, 0600) and compares each run
 * with the last, so a change in how Gmail lays its answers out is seen before a call has to fail on it.
 *
 * A fingerprint is positions and kinds of things only, never a value: each place in an answer (`json[2][*][0][4][*][6]`,
 * a list of records' places as `[*]`) with the kinds of thing seen there (a list, a number, a date in ms, a string, a
 * label id, an id, a boolean) and how many times. A place is well populated in a run when it was seen at least FREQUENT
 * times, or in every one of two or more answers, and **stable** once it was well populated in STABLE_RUNS runs in a row. A stable place this run did not see at all, or a new kind at one, is a change; places
 * that come and go with the mail (a Cc, attachments, a label some messages have) do not become stable and are not
 * counted. Endpoints are compared only when both runs had answers from them.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { GmailMail, SyncInfo } from './mail.ts';
import { isMs } from './protocol.ts';
import { selfCheck } from './selfcheck.ts';

/** How deep into an answer the fingerprint looks: a message's own fields are at depth 6 in bv's own layout. */
const DEPTH = 8;
/** A place seen this many times in a run (or in each of its answers), in STABLE_RUNS runs in a row, is part of the layout, not of some messages. */
export const FREQUENT = 5;
export const STABLE_RUNS = 2;
/** Places kept per endpoint (an answer laid out wildly otherwise is not kept whole). */
const MAX_PLACES = 4000;

/** Per endpoint: place → kinds seen there and how many times. */
export type Shapes = Record<string, Record<string, { kinds: string[]; n: number; stable?: number }>>;

/** What a value is, coarsely; null for nothing there. */
function coarse(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'number') return isMs(v) ? 'ms' : 'n';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return v.startsWith('^') ? 'label' : /^(?:thread|msg)-[a-z]:/.test(v) ? 'id' : 's';
  return 'obj';
}

/** Adds one answer's places to `into` (the endpoint's map). Lists whose elements are all of one kind are lists of records: `[*]`. */
export function addShape(into: Shapes[string], json: unknown) {
  const walk = (v: unknown, path: string, depth: number) => {
    const k = coarse(v);
    if (k === null) return;
    let at = into[path];
    if (!at && Object.keys(into).length < MAX_PLACES) at = into[path] = { kinds: [], n: 0 };
    if (at) {
      at.n++;
      if (!at.kinds.includes(k)) at.kinds.push(k);
    }
    if (!Array.isArray(v) || depth >= DEPTH) return;
    const kinds = new Set(v.map(coarse).filter(Boolean));
    const records = kinds.size === 1;
    v.forEach((x, i) => walk(x, `${path}[${records ? '*' : i}]`, depth + 1));
  };
  walk(json, 'json', 0);
}

export interface ShapeChange {
  endpoint: string;
  /** Places the last run saw often that this one never saw. */
  gone: string[];
  /** Places seen often before with a kind they never had. */
  newKinds: string[];
}

/** What changed from the last run's shapes to this one's, per endpoint both have (positions and kinds only). */
export function compareShapes(prev: Shapes, next: Shapes): ShapeChange[] {
  const out: ShapeChange[] = [];
  for (const ep of Object.keys(next).sort()) {
    const a = prev[ep];
    const b = next[ep]!;
    if (!a || !Object.keys(a).length || !Object.keys(b).length) continue;
    const gone: string[] = [];
    const newKinds: string[] = [];
    for (const [place, was] of Object.entries(a)) {
      if ((was.stable ?? 0) < STABLE_RUNS) continue;
      const now = b[place];
      if (!now) gone.push(place);
      else {
        const added = now.kinds.filter((k) => !was.kinds.includes(k));
        if (added.length) newKinds.push(`${place}: ${added.join(', ')}`);
      }
    }
    if (gone.length || newKinds.length) out.push({ endpoint: ep, gone: gone.slice(0, 20), newKinds: newKinds.slice(0, 20) });
  }
  return out;
}

export interface CanaryRun {
  at: string;
  /** The self-check's calls all answered, and every answer read whole (no record left out, no layout refused). */
  ok: boolean;
  /** Answers laid out otherwise than known: refused, or records left out (this extractor's sentences, no values). */
  problems: string[];
  changes: ShapeChange[];
  /** The runs compared: false for the first, or when the last run's file could not be read. */
  compared: boolean;
  summary: string;
  ms: number;
}

/** The canary's file: the last run, and the shapes it saw. */
interface CanaryFile {
  run: CanaryRun;
  shapes: Shapes;
}

export function readCanary(file: string): CanaryFile | null {
  try {
    if (!existsSync(file)) return null;
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && v.shapes && typeof v.shapes === 'object' && v.run ? v : null;
  } catch {
    return null;
  }
}

/**
 * One canary run: the self-check without reading a message, every read answer's shape taken as it is read, then
 * compared with the last run's and kept. Never throws for what Gmail answered: that is in `problems`.
 */
export async function runCanary(mail: GmailMail, info: () => Promise<SyncInfo>, file: string, now: () => number = Date.now): Promise<CanaryRun> {
  const t0 = now();
  const last = readCanary(file);
  const shapes: Shapes = {};
  const failedBefore = Object.fromEntries(Object.entries(mail.fp).map(([e, f]) => [e, f.failed]));
  const skippedBefore = { ...mail.evidence.skipped };
  const answers: Record<string, number> = {};
  mail.answerTap = (ep, json) => {
    answers[ep] = (answers[ep] ?? 0) + 1;
    addShape((shapes[ep] ??= {}), json);
  };
  let report: Awaited<ReturnType<typeof selfCheck>> | null = null;
  let error: string | null = null;
  try {
    report = await selfCheck(mail, info, now, { readMessage: false });
  } catch (e) {
    error = String((e as Error).message ?? e).slice(0, 160);
  } finally {
    mail.answerTap = null;
  }
  const problems: string[] = [];
  // A layout's failures only ("at <where>: expected …"): a 5xx or a busy page says nothing of how Gmail lays answers out.
  for (const [ep, f] of Object.entries(mail.fp)) if (f.failed > (failedBefore[ep] ?? 0) && f.note?.startsWith('at ')) problems.push(`${ep}: ${f.note}`);
  for (const [ep, n] of Object.entries(mail.evidence.skipped)) if (n > (skippedBefore[ep] ?? 0)) problems.push(`${ep}: ${n - (skippedBefore[ep] ?? 0)} records left out`);
  // How many runs in a row each place was well populated; the last run's shapes kept for an endpoint this run did not
  // reach, so the next comparison still has them.
  for (const [ep, places] of Object.entries(shapes)) {
    const k = answers[ep] ?? 0;
    for (const [place, now] of Object.entries(places)) now.stable = now.n >= FREQUENT || (k >= 2 && now.n >= k) ? (last?.shapes[ep]?.[place]?.stable ?? 0) + 1 : 0;
  }
  const kept: Shapes = { ...(last?.shapes ?? {}), ...shapes };
  const changes = last ? compareShapes(last.shapes, shapes) : [];
  const ok = !!report?.ok && !problems.length;
  const n = (s: Shapes[string] | undefined) => Object.keys(s ?? {}).length;
  const seen = Object.keys(shapes).sort().map((e) => `${e} ${n(shapes[e])} places`).join(', ') || 'no answers';
  const summary = `${ok ? 'ok' : error ? `not ok (it did not run through: ${error})` : 'not ok'}${changes.length ? `, shapes changed (${changes.map((c) => `${c.endpoint}: ${c.gone.length} gone, ${c.newKinds.length} new kinds`).join('; ')})` : last ? ', shapes as last time' : ', first run'}; ${seen}`;
  const run: CanaryRun = { at: new Date(now()).toISOString(), ok, problems: problems.slice(0, 10), changes, compared: !!last, summary, ms: now() - t0 };
  try {
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ run, shapes: kept } satisfies CanaryFile)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch {}
  return run;
}
