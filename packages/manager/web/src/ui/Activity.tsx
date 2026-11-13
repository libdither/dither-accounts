/** Activity: how many calls each app made to each account, by operation and outcome. Counts only. */
import { useEffect } from 'preact/hooks';
import type { AuditRow } from '../../../src/api-types.ts';
import { act, ago, appName, audit, auditDays, confirm, loadAudit, state } from '../state.ts';
import { accountLabel, Card, Empty } from './bits.tsx';

const OUTCOMES = ['ok', 'error', 'denied', 'limited', 'dry'] as const;
const OUTCOME_WORD: Record<(typeof OUTCOMES)[number], string> = { ok: 'Done', error: 'Failed', denied: 'Denied', limited: 'Limited', dry: 'Dry run' };

interface Line {
  op: string;
  counts: Record<string, number>;
  last: number;
}

/** app → account → op → counts over the window's days. */
function group(rows: AuditRow[]): Map<string, Map<string, Map<string, Line>>> {
  const out = new Map<string, Map<string, Map<string, Line>>>();
  for (const r of rows) {
    const byAcc = out.get(r.app) ?? out.set(r.app, new Map()).get(r.app)!;
    const byOp = byAcc.get(r.account) ?? byAcc.set(r.account, new Map()).get(r.account)!;
    const l = byOp.get(r.op) ?? byOp.set(r.op, { op: r.op, counts: {}, last: 0 }).get(r.op)!;
    l.counts[r.outcome] = (l.counts[r.outcome] ?? 0) + r.n;
    l.last = Math.max(l.last, r.lastAt);
  }
  return out;
}

export function Activity() {
  useEffect(() => {
    void loadAudit();
    const t = setInterval(() => document.visibilityState === 'visible' && void loadAudit(), 5000);
    return () => clearInterval(t);
  }, [auditDays.value]);
  const rows = audit.value;
  const clear = async () => {
    if (await confirm('Clear the activity counts?', 'Every count goes, for every app. New calls are counted from now.', 'Clear')) {
      await act('/api/audit', { method: 'DELETE' }, 'Cleared');
      void loadAudit();
    }
  };
  const groups = rows ? group(rows) : null;
  return (
    <div class="page">
      <p class="lede">Only counts are kept: which app called what on which account, and how it went. Never what was asked or answered. Counts older than 90 days are dropped.</p>
      <div class="row toolbar">
        <div class="seg" role="group" aria-label="Period">
          {([7, 30, 90] as const).map((d) => (
            <button key={d} class={`seg-btn ${auditDays.value === d ? 'on' : ''}`} onClick={() => (auditDays.value = d)}>
              {d} days
            </button>
          ))}
        </div>
        <span class="grow" />
        <button class="btn sm ghost" onClick={clear} disabled={!rows?.length} data-clear>
          Clear
        </button>
      </div>
      {!groups ? (
        <p class="muted">Loading…</p>
      ) : !groups.size ? (
        <Empty>No calls in the last {auditDays.value} days.</Empty>
      ) : (
        [...groups].map(([app, byAcc]) => (
          <Card class="activity" key={app} data-activity-app={app}>
            <header class="card-head">
              <h3>{appName.value.get(app) ?? (state.value ? 'An app since forgotten' : app)}</h3>
            </header>
            {[...byAcc].map(([acc, byOp]) => (
              <div class="table-wrap" key={acc}>
                <h4>{accountLabel(acc)}</h4>
                <table>
                  <thead>
                    <tr>
                      <th>Operation</th>
                      {OUTCOMES.map((o) => (
                        <th class="num" key={o}>
                          {OUTCOME_WORD[o]}
                        </th>
                      ))}
                      <th>Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...byOp.values()]
                      .sort((a, b) => b.last - a.last)
                      .map((l) => (
                        <tr key={l.op} data-op={l.op}>
                          <td class="mono">{l.op}</td>
                          {OUTCOMES.map((o) => (
                            <td class={`num ${l.counts[o] ? `o-${o}` : 'faint'}`} key={o}>
                              {l.counts[o] ?? '·'}
                            </td>
                          ))}
                          <td class="muted">{ago(l.last)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ))}
          </Card>
        ))
      )}
    </div>
  );
}
