/**
 * The one check every channel that can be replaced must pass (packages/spec/src/handover.ts): calls are sent before,
 * at and after a cut of the transport, while some of them are on it, and each must end exactly one of three ways:
 *
 * - answered, with its own answer, by a far side that ran it (a call that is not repeatable ran exactly once);
 * - refused `retry`: it was never run anywhere;
 * - refused `unsure`: it may have run, at most once, and it is not repeatable (a repeatable one is run again instead).
 *
 * Anything else is a lost call: a timeout, a bare string error, no answer within `settleMs`, or another call's answer.
 * The transport is the site's own (a manager and a fake extractor, a fake page), with a far side that counts its runs.
 */

export interface CutTransport {
  /** Send call `i` (its far side answers with something naming `i`); `repeatable`: a read, safe to run twice. */
  call(i: number, repeatable: boolean): Promise<unknown>;
  /** Cut the transport now, with calls on it; it comes back as the real one does. Resolves once it is back. */
  cut(): Promise<void>;
  /** How many times the far side ran call `i`, on any side. */
  runs(i: number): number | Promise<number>;
  /** What an error means: a typed refusal, or null (a timeout, a plain error): then the call was lost. */
  outcome(e: unknown): 'retry' | 'unsure' | null;
  /** Which call an answer belongs to. Default: the answer's `i`. */
  answerOf?(v: unknown): number | null;
}

export interface CutOpts {
  /** How many calls in all. */
  calls: number;
  /** The cut comes right after this many have been sent. */
  cutAfter: number;
  /** Between two sends. 0: the ones before the cut go out together, as do the ones after it. */
  spacingMs?: number;
  /** Which calls are repeatable. Default: every other one. */
  repeatable?: (i: number) => boolean;
  /** Every call has ended by then, or it counts as lost. */
  settleMs: number;
  /** Before the cut: until the calls sent so far are on the far side (default: nothing). */
  inFlight?: () => Promise<void>;
  /** After `cut()` is called: until the cut has begun, where it begins later than the call (default: nothing). */
  begun?: () => Promise<void>;
}

export interface CutReport {
  answered: number;
  retry: number;
  unsure: number;
  /** One line per call that broke the rule; empty when none did. */
  problems: string[];
  /** Each call's answer, by its number (undefined: refused, or no end). */
  answers: unknown[];
}

export async function cutMidCall(t: CutTransport, o: CutOpts): Promise<CutReport> {
  const repeatable = o.repeatable ?? ((i: number) => i % 2 === 0);
  const answerOf = t.answerOf ?? ((v: unknown) => (v && typeof v === 'object' && typeof (v as { i?: unknown }).i === 'number' ? (v as { i: number }).i : null));
  const ended: ({ ok: true; v: unknown } | { ok: false; e: unknown } | null)[] = Array.from({ length: o.calls }, () => null);
  const sent: Promise<void>[] = [];
  let cutting: Promise<void> | null = null;
  for (let i = 0; i < o.calls; i++) {
    if (i === o.cutAfter) {
      await o.inFlight?.();
      cutting = t.cut();
      await o.begun?.();
    }
    sent.push(
      t.call(i, repeatable(i)).then(
        (v) => void (ended[i] = { ok: true, v }),
        (e) => void (ended[i] = { ok: false, e }),
      ),
    );
    if (o.spacingMs) await Bun.sleep(o.spacingMs);
  }
  if (!cutting) cutting = t.cut();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all([...sent, cutting]), new Promise<void>((r) => (timer = setTimeout(r, o.settleMs)))]);
  clearTimeout(timer);

  const report: CutReport = { answered: 0, retry: 0, unsure: 0, problems: [], answers: ended.map((r) => (r?.ok ? r.v : undefined)) };
  for (let i = 0; i < o.calls; i++) {
    const r = ended[i];
    const runs = await t.runs(i);
    const rep = repeatable(i);
    const what = `call ${i} (${rep ? 'repeatable' : 'once only'}, ${i < o.cutAfter ? 'before' : 'after'} the cut, ran ${runs}×)`;
    if (!r) {
      report.problems.push(`${what}: no end within ${o.settleMs} ms (lost)`);
      continue;
    }
    if (r.ok) {
      report.answered++;
      const of = answerOf(r.v);
      if (of !== i) report.problems.push(`${what}: answered with ${JSON.stringify(r.v)}, not its own answer`);
      if (runs < 1) report.problems.push(`${what}: answered, but the far side never ran it`);
      if (!rep && runs !== 1) report.problems.push(`${what}: answered, and the far side ran it ${runs} times`);
      continue;
    }
    const kind = t.outcome(r.e);
    const msg = String((r.e as Error)?.message ?? r.e);
    if (kind === 'retry') {
      report.retry++;
      if (runs !== 0) report.problems.push(`${what}: refused retry ("${msg}"), but the far side ran it`);
    } else if (kind === 'unsure') {
      report.unsure++;
      if (runs > 1) report.problems.push(`${what}: refused unsure ("${msg}"), and the far side ran it ${runs} times`);
    } else report.problems.push(`${what}: failed untyped ("${msg}") (lost)`);
  }
  return report;
}
