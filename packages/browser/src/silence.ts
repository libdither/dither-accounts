/**
 * A page that did not answer, told apart in the log at the moment it happens. When a bridge request times out, this
 * asks the extension's service worker how Chromium sees the page's tab (`tab.state`) and the page's hook how it sees
 * itself, without the network (`page.state`), each within a few seconds, and logs one line:
 *
 *   the <name> page's silence: request <how far it got>; the hook answers without the network {…}
 *
 * How far it got is the timeout's `reached` (bridge.ts): the worker said it handed the command to the page's port
 * ('worker'), the hook said it had it ('page'), or neither ('none'). A kind whose extension does not answer
 * `tab.state` or `page.state` still gets the line, with `reached` and how long since the bridge's last answer.
 *
 * The extension's side is shared too: page/worker-watch.js (a worker's `got` and `tab.state`) and
 * page/command-watch.js (a hook's `got`, `page.state`, and its "still open after 20 s" line), put in by the copy step
 * (markers.ts). Only names of commands, path templates and counts go in the line: never a body, header, cookie, token
 * or an address with ids in it.
 */
import type { Reached } from './bridge.ts';
import type { Log } from './sandbox.ts';

/** Each probe of a silent page answers within this. */
export const DIAGNOSE_MS = 5_000;

/** What can be asked of the extension: a request with the bridge's own timeout. */
export interface Asker {
  readonly connected: boolean;
  readonly lastAnswerAt: number | null;
  request<T = unknown>(cmd: never, timeoutMs?: number, opts?: { diagnose?: boolean }): Promise<T>;
}

export interface SilenceOpts {
  /** What the line calls the page: "the <name> page's silence". */
  name: string;
  /** The command that was not answered, as a log may name it (its kind; never its body or an address with ids). */
  request: string;
  reached: Reached;
  log: Log;
  /** What to ask the worker for the tab (kind 'tab.state'), or null when its worker has no such command. */
  tab?: Record<string, unknown> | null;
  /** What to ask the hook (kind 'page.state'), or null when the page's hook has no such command. */
  page?: Record<string, unknown> | null;
  /** The worker runs the command itself (statements-common's driver): 'worker' means it took it, not handed it on. */
  workerRuns?: boolean;
  /** When the page last answered; default the bridge's last answer to anything. */
  lastAnswerAt?: number | null;
  /** More fields for the line (counts and ages only). */
  extra?: Record<string, unknown>;
  ms?: number;
}

const REACHED_TEXT: Record<Reached, string> = {
  none: 'not acknowledged by the service worker',
  worker: 'handed to the page, which never said it had it',
  page: 'received by the page, which never answered',
};

/** A path as a log may name it: segments with digits, or long ones, as `*` (page/command-watch.js's watchPath). */
export function pathTemplate(path: string): string {
  return path
    .split('/')
    .map((s) => (/\d/.test(s) || s.length > 24 ? '*' : s))
    .join('/');
}

/** An answer as the line keeps it: a `path` or `url` anywhere in it as a template, with no query or hash. */
function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'path' || k === 'url') && typeof x === 'string') {
      let u: URL | null = null;
      try {
        u = new URL(x);
      } catch {}
      out[k] = u ? (u.protocol === 'http:' || u.protocol === 'https:' ? u.origin + pathTemplate(u.pathname) : `${u.protocol}//${u.host}`) : pathTemplate(x.split(/[?#]/)[0]!);
    } else out[k] = scrub(x, depth + 1);
  }
  return out;
}

type Answer<T> = { ok: true; ms: number; v: T } | { ok: false; ms: number; error: string };

/** Ask the extension what it knows of a silent page and log one line. Never throws. */
export async function diagnoseSilence(bridge: Asker, o: SilenceOpts): Promise<void> {
  const ms = o.ms ?? DIAGNOSE_MS;
  const ask = async (c: Record<string, unknown> | null | undefined): Promise<Answer<Record<string, unknown>> | null> => {
    if (!c || !bridge.connected) return null;
    const t0 = Date.now();
    try {
      const v = await bridge.request<Record<string, unknown>>(c as never, ms, { diagnose: false });
      return { ok: true, ms: Date.now() - t0, v: scrub(v) as Record<string, unknown> };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String((e as Error).message ?? e).slice(0, 200) };
    }
  };
  try {
    const [tab, hook] = await Promise.all([ask(o.tab), ask(o.page)]);
    const at = o.lastAnswerAt === undefined ? bridge.lastAnswerAt : o.lastAnswerAt;
    const reached = o.workerRuns && o.reached === 'worker' ? 'taken by the service worker, which never answered' : REACHED_TEXT[o.reached];
    const said: Record<string, unknown> = {
      request: o.request,
      reached,
      ...(tab ? { tab: tab.ok ? tab.v : `no answer: ${tab.error}` } : {}),
      ...(hook ? { hook: hook.ok ? { answeredInMs: hook.ms, ...hook.v } : `no answer in ${ms / 1000} s: ${hook.error}` } : {}),
      lastAnswerAgoS: at ? Math.round((Date.now() - at) / 1000) : null,
      ...o.extra,
    };
    const of = hook ? `; the hook ${hook.ok ? 'answers without the network' : 'does not answer either'}` : '';
    o.log('warn', `the ${o.name} page's silence: request ${reached}${of}`, said);
  } catch {}
}
