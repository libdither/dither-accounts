/**
 * The extractor's span for a command that came with a `trace` (the manager's traceparent; packages/manager/src/trace.ts).
 * It is a child of the manager's call span; what happens inside (the pace queue's wait, the hook's phases) is events on
 * it. When the command is done the span goes up as a `log` event whose msg is `trace`, which the manager writes into
 * its trace file rather than the adapter log. A command without `trace` costs nothing.
 *
 * Attributes and events are names, counts and times: never what a command or its answer carries.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type Attrs = Record<string, string | number | boolean | null>;
interface Open {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  startMs: number;
  t0: number;
  attrs: Attrs;
  events: { name: string; atMs: number; attrs?: Attrs }[];
}

const current = new AsyncLocalStorage<Open>();

const hex = (bytes: number) => {
  let s = '';
  for (const x of crypto.getRandomValues(new Uint8Array(bytes))) s += x.toString(16).padStart(2, '0');
  return s;
};

/** Run `fn` as the span of command `t` when `trace` is a traceparent; `send` gets the finished record. */
export async function traced<T>(t: string, trace: unknown, send: (record: unknown) => void, fn: () => Promise<T>): Promise<T> {
  const m = typeof trace === 'string' ? trace.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/) : null;
  if (!m) return fn();
  const s: Open = { name: `discord ${t}`, traceId: m[1]!, spanId: hex(8), parentSpanId: m[2]!, startMs: Date.now(), t0: performance.now(), attrs: { op: t }, events: [] };
  let failed: string | undefined;
  try {
    return await current.run(s, fn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed = msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
    throw e;
  } finally {
    try {
      send({
        name: s.name,
        traceId: s.traceId,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        startMs: s.startMs,
        durationMs: Math.round((performance.now() - s.t0) * 10) / 10,
        attrs: s.attrs,
        ...(s.events.length ? { events: s.events.slice(0, 40) } : {}),
        status: failed === undefined ? 'ok' : 'error',
        ...(failed !== undefined ? { error: failed } : {}),
      });
    } catch {}
  }
}

/** Something that happened in the current command's span, now (or `atMs` after it began). */
export function phase(name: string, attrs?: Attrs, atMs?: number) {
  const s = current.getStore();
  if (!s) return;
  s.events.push({ name, atMs: atMs ?? Math.round((performance.now() - s.t0) * 10) / 10, ...(attrs ? { attrs } : {}) });
}

/** Attributes on the current command's span. */
export function annotate(attrs: Attrs) {
  const s = current.getStore();
  if (s) Object.assign(s.attrs, attrs);
}

/**
 * The hook's own phase times (ms from when the hook began), placed on the span: the hook began once the bridge had the
 * request, which is `sentAt` into the span.
 */
export function hookPhases(phases: unknown, sentAt: number) {
  if (!Array.isArray(phases)) return;
  for (const p of phases.slice(0, 20)) {
    if (p && typeof p.name === 'string' && typeof p.ms === 'number') phase(`hook: ${p.name.slice(0, 60)}`, undefined, Math.round((sentAt + p.ms) * 10) / 10);
  }
}

/** ms since the current span began, for hookPhases. */
export function sinceStart(): number {
  const s = current.getStore();
  return s ? performance.now() - s.t0 : 0;
}
