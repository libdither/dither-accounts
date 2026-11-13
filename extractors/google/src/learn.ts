/**
 * The learn run's script (<accountDir>/gmail-learn.json, docs/google.md "Learning Gmail's protocol"), checked as a
 * whole before any of it runs: a bad script is refused and nothing runs. The reasons say which step and why, never
 * what a search held.
 *
 *   { "steps": [ { "nav": "#search/in:inbox is:read" }, { "wait": 2 }, { "openRead": 0 }, { "back": true }, { "collect": true } ] }
 */
import { navHash } from './gmail-learn.js';

export const LEARN_LIMITS = {
  /** Steps in one run. */
  steps: 12,
  /** openRead steps in one run: read threads opened, at most. */
  openRead: 5,
  /** A wait, in seconds. */
  waitMin: 1,
  waitMax: 20,
  /** The highest openRead index (0: the first read row the list shows). */
  index: 49,
} as const;

export type LearnStep = { nav: string } | { wait: number } | { openRead: number } | { back: true } | { collect: true };

const KINDS = ['nav', 'wait', 'openRead', 'back', 'collect'];

export function checkLearnScript(raw: unknown): { steps: LearnStep[] } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the script is not an object { steps: [...] }' };
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'steps') return { error: 'the script holds anything but steps' };
  const list = (raw as { steps: unknown }).steps;
  if (!Array.isArray(list) || !list.length) return { error: 'steps is not a list of steps' };
  if (list.length > LEARN_LIMITS.steps) return { error: `${list.length} steps; at most ${LEARN_LIMITS.steps}` };
  const steps: LearnStep[] = [];
  let opens = 0;
  for (const [i, s] of list.entries()) {
    const n = `step ${i + 1}`;
    const k = s && typeof s === 'object' && !Array.isArray(s) ? Object.keys(s) : [];
    if (k.length !== 1 || !KINDS.includes(k[0]!)) return { error: `${n} is not one of { ${KINDS.join(' | ')} }` };
    const v = (s as Record<string, unknown>)[k[0]!];
    switch (k[0]) {
      case 'nav':
        try {
          steps.push({ nav: navHash(v) });
        } catch (e) {
          return { error: `${n}: ${(e as Error).message}` };
        }
        break;
      case 'wait':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < LEARN_LIMITS.waitMin || v > LEARN_LIMITS.waitMax) return { error: `${n}: a wait is ${LEARN_LIMITS.waitMin} to ${LEARN_LIMITS.waitMax} seconds` };
        steps.push({ wait: v });
        break;
      case 'openRead':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > LEARN_LIMITS.index) return { error: `${n}: openRead takes a row index, 0 to ${LEARN_LIMITS.index}` };
        if (++opens > LEARN_LIMITS.openRead) return { error: `more than ${LEARN_LIMITS.openRead} openRead steps; at most ${LEARN_LIMITS.openRead} in a run` };
        steps.push({ openRead: v });
        break;
      case 'back':
        if (v !== true) return { error: `${n}: back is { "back": true }` };
        steps.push({ back: true });
        break;
      case 'collect':
        if (v !== true) return { error: `${n}: collect is { "collect": true }` };
        steps.push({ collect: true });
        break;
    }
  }
  return { steps };
}

/** How a step reads in the log: the kind of view for a nav, never a search's words. */
export function describeStep(s: LearnStep): string {
  if ('nav' in s) return s.nav.startsWith('#search/') ? `nav to a search (${s.nav.slice(8).split('+').length} operators)` : `nav to ${s.nav}`;
  if ('wait' in s) return `wait ${s.wait} s`;
  if ('openRead' in s) return `openRead ${s.openRead}`;
  if ('back' in s) return 'back';
  return 'collect';
}
