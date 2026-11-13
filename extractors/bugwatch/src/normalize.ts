/**
 * Fingerprints: what makes two error records the same bug. A message is normalized (ids, numbers, quoted strings,
 * URLs and line:column turned into placeholders) and the first frame in the repository counts by its file and
 * function only, so a deploy that moves lines keeps every fingerprint.
 */
import { createHash } from 'node:crypto';

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const stripProject = (s: string, project?: string) => (project ? s.split(project.endsWith('/') ? project : `${project}/`).join('') : s);

/**
 * A message as fingerprints and notices see it: one line, at most 300 characters, with every id, number, quoted
 * string, URL and line:column a placeholder. What is left is the error's own words.
 */
export function normalize(message: string, project?: string): string {
  let s = stripProject(oneLine(message), project);
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, '<url>');
  s = s.replace(/"(?:[^"\\\n]|\\.){0,300}"/g, '"<s>"');
  s = s.replace(/(^|[\s(\[:=,])'([^'\n]{0,300})'(?=$|[\s)\],.:;])/g, "$1'<s>'");
  s = s.replace(/`[^`\n]{0,300}`/g, '`<s>`');
  s = s.replace(/(\.[A-Za-z]{1,5}):\d+(?::\d+)?/g, '$1:<n>');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>');
  s = s.replace(/\b0x[0-9a-f]+\b/gi, '<hex>');
  s = s.replace(/\b[a-z]{2,8}_(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{6,}\b/g, '<id>');
  s = s.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<hex>');
  s = s.replace(/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{20,}={0,2}/g, '<b64>');
  // Numbers, with a unit if they have one (30s, 200ms, 4kB).
  s = s.replace(/(?<![A-Za-z<_])\d+(?:\.\d+)?(?:ms|s|m|h|d|[kKMG]?[bB])?(?![A-Za-z0-9>])/g, '<n>');
  return clip(s.replace(/\s+/g, ' ').trim(), 300);
}

export interface Frame {
  fn: string;
  file: string;
  inRepo: boolean;
}

/** One `at …` frame: its function and file (no line or column), and whether the file is the project's own. */
export function parseFrame(frame: string, project?: string): Frame {
  let f = oneLine(frame).replace(/^at\s+/, '');
  let fn = '<anonymous>';
  let loc = f;
  const m = /^(.*?)\s+\((.*)\)$/.exec(f);
  if (m) {
    fn = m[1]!.replace(/^(async|new)\s+/, '').trim() || '<anonymous>';
    loc = m[2]!;
  }
  loc = loc.replace(/^file:\/\//, '');
  let file = stripProject(loc.replace(/:\d+(?::\d+)?$/, ''), project);
  const inRepo = !!file && !file.startsWith('/') && !/(^|\/)node_modules\//.test(file) && !/^(node:|bun:|native|internal|<|\[)/.test(file) && /\.[A-Za-z]{1,5}$/.test(file);
  if (!inRepo) file = file.replace(/^.*\/node_modules\//, 'node_modules/');
  return { fn: clip(fn, 120), file: clip(file, 200), inRepo };
}

/** The first frame in the project as `file#function`, or '' when none is. */
export function firstInRepoFrame(stack: string[], project?: string): string {
  for (const s of stack) {
    const f = parseFrame(s, project);
    if (f.inRepo) return `${f.file}#${f.fn}`;
  }
  return '';
}

export interface Fingerprinted {
  /** The fingerprint's text: source name | source | where | name | message | frame. */
  text: string;
  id: string;
  where: string;
  message: string;
  frame: string;
}

export function fingerprint(r: { sourceName: string; source: string; where: string; name: string; message: string; stack: string[] }, project?: string): Fingerprinted {
  const where = normalize(r.where, project);
  const message = normalize(r.message, project);
  const frame = firstInRepoFrame(r.stack, project);
  const text = [r.sourceName, r.source, where, oneLine(r.name), message, frame].join(' | ');
  return { text, id: createHash('sha256').update(text).digest('hex').slice(0, 16), where, message, frame };
}
