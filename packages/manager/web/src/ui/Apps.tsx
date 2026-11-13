/**
 * Apps: what each app asked for and what it may do. Requests wait here as consent cards; approving can narrow them
 * (a lower level, fewer accounts, dry run). Each grant can be changed or revoked at any time. Above the apps, a
 * matrix of apps by accounts says who reaches what, at what level, and how its calls there went this week.
 */
import { useEffect, useState } from 'preact/hooks';
import type { AccountInfo, AppInfo, GrantInfo, InterfaceInfo, MatrixCell, RequestInfo } from '../../../src/api-types.ts';
import { act, ago, confirm, href, kindName, loadMatrix, matrix, named, state } from '../state.ts';
import { AccountPicker, AccountsSummary, Avatar, Card, Dot, Empty, type Level, LEVEL_WORD, LEVELS, LevelPill } from './bits.tsx';

const ifaceOf = (name: string): InterfaceInfo | undefined => state.value?.interfaces.find((i) => i.name === name);

/** The consent lines a level amounts to, as the interface words them. */
function linesFor(iface: string, level: Level, fallback: string[]): string[] {
  const i = ifaceOf(iface);
  if (!i) return fallback;
  return LEVELS.filter((l) => LEVELS.indexOf(l) <= LEVELS.indexOf(level) && i.levels[l]).map((l) => i.levels[l]!);
}

/** Levels the interface has words for, up to `max`. */
function levelsUpTo(iface: string, max: Level): Level[] {
  if (iface === 'accounts') return ['manage'];
  const i = ifaceOf(iface);
  return LEVELS.filter((l) => LEVELS.indexOf(l) <= LEVELS.indexOf(max) && (!i || i.levels[l] || l === max));
}

function ifaceTitle(name: string) {
  return name === 'accounts' ? 'Accounts themselves' : name;
}

function RequestCard({ app, req }: { app: AppInfo; req: RequestInfo }) {
  const [level, setLevel] = useState<Level>(req.level);
  const [all, setAll] = useState(req.accounts === '*');
  const [picked, setPicked] = useState<string[]>(req.accounts === '*' ? [] : req.accounts);
  const [dry, setDry] = useState(false);
  const [busy, setBusy] = useState(false);
  const isAccounts = req.interface === 'accounts';
  const lines = isAccounts ? req.consent : linesFor(req.interface, level, req.consent);
  const approve = async () => {
    setBusy(true);
    await act(`/api/requests/${req.id}/approve`, { method: 'POST', body: { level, accounts: all ? '*' : picked, dryRun: dry } }, `${app.name} may now ${LEVEL_WORD[level].toLowerCase()} ${ifaceTitle(req.interface)}`);
    setBusy(false);
  };
  const deny = async () => {
    setBusy(true);
    await act(`/api/requests/${req.id}/deny`, { method: 'POST' }, `Denied ${app.name}'s request`);
    setBusy(false);
  };
  return (
    <Card class="request" data-request={req.id}>
      <header class="card-head">
        <div>
          <h3>
            {app.name} <span class="muted">asks for</span> {ifaceTitle(req.interface)}
          </h3>
          {app.describe && <p class="muted small">{app.describe}</p>}
        </div>
        <LevelPill level={req.level} />
      </header>
      <ul class="consent">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p class="small">
        <span class="label">On</span> <AccountsSummary accounts={req.accounts} kinds={req.kinds} />
      </p>
      {req.reason && (
        <p class="small">
          <span class="label">Why</span> {req.reason}
        </p>
      )}
      <div class="narrow">
        {!isAccounts && (
          <label class="field">
            <span>Allow up to</span>
            <select value={level} onChange={(e) => setLevel((e.target as HTMLSelectElement).value as Level)} data-level>
              {levelsUpTo(req.interface, req.level).map((l) => (
                <option value={l} key={l}>
                  {LEVEL_WORD[l]}
                </option>
              ))}
            </select>
          </label>
        )}
        {!isAccounts && (
          <AccountPicker
            iface={req.interface}
            kinds={req.kinds}
            all={all}
            picked={picked}
            onChange={(a, p) => {
              setAll(a);
              setPicked(p);
            }}
          />
        )}
        {!isAccounts && level !== 'read' && (
          <label class="check">
            <input type="checkbox" checked={dry} onChange={(e) => setDry((e.target as HTMLInputElement).checked)} data-dry />
            <span>
              Dry run <span class="muted">— writes are answered without reaching the account</span>
            </span>
          </label>
        )}
      </div>
      <div class="row end">
        <button class="btn ghost" disabled={busy} onClick={deny} data-deny>
          Deny
        </button>
        <button class="btn primary" disabled={busy || (!all && !picked.length && !isAccounts)} onClick={approve} data-approve>
          Approve
        </button>
      </div>
    </Card>
  );
}

function GrantRow({ g }: { g: GrantInfo }) {
  const [editing, setEditing] = useState(false);
  const [all, setAll] = useState(g.accounts === '*');
  const [picked, setPicked] = useState<string[]>(g.accounts === '*' ? [] : g.accounts);
  const patch = (body: Record<string, unknown>, done: string) => act(`/api/grants/${g.id}`, { method: 'PATCH', body }, done);
  const isAccounts = g.interface === 'accounts';
  const revoke = async () => {
    if (await confirm('Revoke this grant?', `The app loses ${ifaceTitle(g.interface)} at once. It can ask again; you would see the request here.`, 'Revoke')) {
      await act(`/api/grants/${g.id}`, { method: 'DELETE' }, 'Revoked');
    }
  };
  return (
    <div class="grant" data-grant={g.id}>
      <div class="grant-main">
        <div class="grant-title">
          <strong>{ifaceTitle(g.interface)}</strong>
          {isAccounts ? (
            <LevelPill level="manage" />
          ) : (
            <select class="inline" value={g.level} aria-label="Level" data-grant-level onChange={(e) => patch({ level: (e.target as HTMLSelectElement).value }, 'Level changed')}>
              {levelsUpTo(g.interface, 'manage').map((l) => (
                <option value={l} key={l}>
                  {LEVEL_WORD[l]}
                </option>
              ))}
            </select>
          )}
          {g.dryRun && <span class="pill dry">Dry run</span>}
        </div>
        <ul class="consent small">
          {g.consent.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p class="small">
          <span class="label">On</span> <AccountsSummary accounts={g.accounts} kinds={g.kinds} />
          {!isAccounts && (
            <button class="link-btn" onClick={() => setEditing(!editing)} data-grant-accounts>
              {editing ? 'Cancel' : 'Change'}
            </button>
          )}
        </p>
        {editing && (
          <div class="narrow">
            <AccountPicker
              iface={g.interface}
              kinds={g.kinds}
              all={all}
              picked={picked}
              onChange={(a, p) => {
                setAll(a);
                setPicked(p);
              }}
            />
            <div class="row">
              <button
                class="btn sm primary"
                disabled={!all && !picked.length}
                onClick={async () => {
                  await patch({ accounts: all ? '*' : picked }, 'Accounts changed');
                  setEditing(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
      <div class="grant-actions">
        {!isAccounts && (
          <label class="switch" title="Writes are answered without reaching the account">
            <input type="checkbox" checked={g.dryRun} data-grant-dry onChange={(e) => patch({ dryRun: (e.target as HTMLInputElement).checked }, (e.target as HTMLInputElement).checked ? 'Dry run on' : 'Dry run off')} />
            <span>Dry run</span>
          </label>
        )}
        <button class="btn sm danger" onClick={revoke} data-revoke>
          Revoke
        </button>
      </div>
    </div>
  );
}

function AppCard({ app }: { app: AppInfo }) {
  const forget = async () => {
    if (await confirm(`Forget ${app.name}?`, 'Its grants and its token go. If it runs again it has to introduce itself and ask afresh.', 'Forget app')) {
      await act(`/api/apps/${app.id}`, { method: 'DELETE' }, `Forgot ${app.name}`);
    }
  };
  const decided = app.requests.filter((r) => r.state !== 'pending').slice(0, 5);
  return (
    <Card class="app" data-app={app.id}>
      <header class="card-head">
        <div>
          <h3>
            <Dot tone={app.connected ? 'good' : 'off'} title={app.connected ? 'Connected' : 'Not connected'} /> {app.name}
          </h3>
          <p class="muted small">
            {app.connected ? 'Connected now' : app.lastSeen ? `Last seen ${ago(app.lastSeen)}` : 'Never connected'}
            {app.describe ? ` · ${app.describe}` : ''}
          </p>
        </div>
        <button class="btn sm ghost" onClick={forget} data-forget>
          Forget app
        </button>
      </header>
      {app.grants.length ? app.grants.map((g) => <GrantRow g={g} key={`${g.id}:${g.level}:${g.dryRun}:${JSON.stringify(g.accounts)}`} />) : <p class="muted small">No grants: it can do nothing yet.</p>}
      {decided.length > 0 && (
        <details class="history small">
          <summary>Earlier requests</summary>
          <ul>
            {decided.map((r) => (
              <li key={r.id}>
                {ifaceTitle(r.interface)} · {LEVEL_WORD[r.level as Level]} · <span class={r.state === 'approved' ? 'good' : 'danger'}>{r.state}</span> · {ago(r.createdAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- the grant matrix

const dayWord = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A bar whose top corners are rounded and whose foot stands square on the baseline. */
function bar(x: number, y: number, w: number, h: number, r: number): string {
  const q = Math.min(r, h / 2, w / 2);
  return `M${x},${y + h}V${y + q}Q${x},${y} ${x + q},${y}H${x + w - q}Q${x + w},${y} ${x + w},${y + q}V${y + h}Z`;
}

const SPARK = { w: 6, gap: 2, h: 20 };

/**
 * A cell's calls per day, oldest first and today last, one column a day scaled to the cell's busiest day: the calls
 * that went through in the accent, those that failed or were denied in red on top, a 2px gap between. Each day says
 * its counts on hover; the cell's label and the account's activity tab carry them as text.
 */
function Spark({ calls, days }: { calls: { n: number; bad: number }[]; days: string[] }) {
  const { w, gap, h } = SPARK;
  const max = Math.max(1, ...calls.map((c) => c.n));
  const width = calls.length * (w + gap) - gap;
  return (
    <svg class="spark" width={width} height={h + 1} viewBox={`0 0 ${width} ${h + 1}`} aria-hidden="true">
      <line class="spark-base" x1="0" x2={width} y1={h + 0.5} y2={h + 0.5} />
      {calls.map((c, i) => {
        const x = i * (w + gap);
        const good = c.n - c.bad;
        let total = c.n ? Math.max(2, (c.n / max) * h) : 0;
        let okH = good > 0 ? Math.max(2, (good / c.n) * total) : 0;
        let badH = c.bad > 0 ? Math.max(2, (c.bad / c.n) * total) : 0;
        const between = okH && badH ? gap : 0;
        if (okH + between + badH > h) {
          const over = okH + between + badH - h;
          if (okH >= badH) okH = Math.max(2, okH - over);
          else badH = Math.max(2, badH - over);
        }
        total = okH + between + badH;
        return (
          <g key={days[i] ?? i} class="spark-day" data-day={days[i]} data-n={c.n} data-bad={c.bad}>
            <title>
              {dayWord(days[i])}: {c.n ? plural(c.n, 'call') : 'no calls'}
              {c.bad ? `, ${c.bad} failed or denied` : ''}
            </title>
            <rect class="spark-hit" x={x - gap / 2} y="0" width={w + gap} height={h + 1} />
            {okH > 0 && <path class="spark-ok" d={bar(x, h - okH, w, okH, badH ? 0 : 1.5)} />}
            {badH > 0 && <path class="spark-bad" d={bar(x, h - total, w, badH, 1.5)} />}
          </g>
        );
      })}
    </svg>
  );
}

function MatrixCellView({ app, a, cell, days }: { app: AppInfo; a: AccountInfo; cell: MatrixCell | undefined; days: string[] }) {
  if (!cell)
    return (
      <td class="mx-td" data-cell={`${app.id}|${a.id}`} data-empty>
        <span class="mx-dash" title={`${app.name} cannot reach ${named(a)}`}>—</span>
      </td>
    );
  const held = a.interfaces.filter((i) => cell.grants[i]);
  const total = cell.calls.reduce((n, d) => n + d.n, 0);
  const bad = cell.calls.reduce((n, d) => n + d.bad, 0);
  const label = [
    `${app.name} on ${named(a)}:`,
    held.length ? held.map((i) => `${LEVEL_WORD[cell.grants[i]]} ${i}`).join(', ') : 'no grant',
    cell.manages ? ', runs it' : '',
    cell.dryRun ? ', dry run' : '',
    `; ${plural(total, 'call')} in ${days.length} days${bad ? `, ${bad} failed or denied` : ''}. Opens its activity.`,
  ].join(' ');
  return (
    <td class="mx-td" data-cell={`${app.id}|${a.id}`}>
      <a class="mx-cell" href={href('accounts', a.id, 'activity', app.id)} aria-label={label}>
        <span class="mx-levels">
          {held.length ? (
            held.map((i) => (
              <span class="mx-level" key={i} title={`${i}: ${LEVEL_WORD[cell.grants[i]]}`} data-iface={i} data-level={cell.grants[i]}>
                {a.interfaces.length > 1 && <span class="mono faint">{i}</span>}
                <LevelPill level={cell.grants[i]} />
              </span>
            ))
          ) : (
            <span class="mx-dash">—</span>
          )}
          {cell.manages && (
            <span class="pill runs" title="It may add, start, stop and remove this account" data-runs>
              Runs it
            </span>
          )}
          {cell.dryRun && (
            <span class="pill dry" data-dry-mark>
              Dry run
            </span>
          )}
        </span>
        <span class="mx-calls">
          <Spark calls={cell.calls} days={days} />
          <span class={`mx-count ${total ? '' : 'faint'}`} data-total={total}>
            {total}
          </span>
          {bad > 0 && (
            <span class="mx-bad" data-bad={bad}>
              ✕ {bad}
            </span>
          )}
        </span>
      </a>
    </td>
  );
}

/** Apps down the side, accounts across the top (by kind, as in the account list); a cell per pair. */
function GrantMatrix() {
  const s = state.value!;
  const mx = matrix.value;
  useEffect(() => {
    void loadMatrix();
    const t = setInterval(() => document.visibilityState === 'visible' && void loadMatrix(), 5000);
    return () => clearInterval(t);
  }, []);
  // Reload at once when a grant changes here, not at the next tick.
  const grantsKey = JSON.stringify(s.apps.map((a) => a.grants.map((g) => [g.id, g.level, g.dryRun, g.accounts])));
  useEffect(() => void loadMatrix(), [grantsKey]);
  const byKind = new Map<string, AccountInfo[]>();
  for (const a of s.accounts) (byKind.get(a.kind) ?? byKind.set(a.kind, []).get(a.kind)!).push(a);
  const accounts = [...byKind.values()].flat();
  const firsts = new Set([...byKind.values()].map((l) => l[0].id));
  const cells = new Map((mx?.cells ?? []).map((c) => [`${c.app}|${c.account}`, c]));
  const days = mx?.days ?? [];
  return (
    <Card class="matrix-card" data-matrix>
      <p class="small muted">
        What each app holds on each account, and its calls there over the last {days.length || 7} days, today on the right. A cell opens that account's activity for the app.
      </p>
      {!mx ? (
        <p class="muted small">Loading…</p>
      ) : (
        <div class="mx-scroll" role="region" aria-label="Apps by account" tabIndex={0} data-mx-scroll>
          <table class="mx">
            <thead>
              <tr class="mx-kinds">
                <th class="mx-corner" rowSpan={2} scope="col">
                  App
                </th>
                {[...byKind].map(([kind, list]) => (
                  <th key={kind} class="mx-kind mx-group" colSpan={list.length} scope="colgroup" data-mx-kind={kind}>
                    {kindName.value.get(kind) ?? kind}
                  </th>
                ))}
              </tr>
              <tr class="mx-accounts">
                {accounts.map((a) => (
                  <th key={a.id} scope="col" class={`mx-acc ${firsts.has(a.id) ? 'mx-group' : ''}`} data-mx-account={a.id}>
                    <a class="mx-acc-link" href={href('accounts', a.id)} title={`${named(a)} (${kindName.value.get(a.kind) ?? a.kind})`}>
                      <Avatar a={a} size={22} />
                      <span class="mx-acc-name">{named(a)}</span>
                    </a>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.apps.map((app) => (
                <tr key={app.id} data-mx-app={app.id}>
                  <th scope="row" class="mx-app">
                    <span class="mx-app-name">
                      <Dot tone={app.connected ? 'good' : 'off'} title={app.connected ? 'Connected' : 'Not connected'} /> {app.name}
                    </span>
                  </th>
                  {accounts.map((a) => (
                    <MatrixCellView key={a.id} app={app} a={a} cell={cells.get(`${app.id}|${a.id}`)} days={days} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div class="mx-key small muted" aria-label="Key">
        <span class="mx-key-item">
          <LevelPill level="read" /> <LevelPill level="write" /> <LevelPill level="manage" /> its level on the account's interface
        </span>
        <span class="mx-key-item">
          <span class="pill runs">Runs it</span> may add, start and stop it
        </span>
        <span class="mx-key-item">
          <span class="pill dry">Dry run</span> writes answered without reaching it
        </span>
        <span class="mx-key-item">
          <span class="swatch ok" aria-hidden="true" /> calls a day
        </span>
        <span class="mx-key-item">
          <span class="swatch bad" aria-hidden="true" /> failed or denied
        </span>
      </div>
    </Card>
  );
}

export function Apps() {
  const s = state.value!;
  const waiting = s.apps.flatMap((a) => a.requests.filter((r) => r.state === 'pending').map((r) => ({ app: a, req: r })));
  return (
    <div class="page">
      <p class="lede">
        A grant lets an app use one interface on some of your accounts, up to a level: <b>read</b> what is there, <b>write</b> as you, or <b>manage</b> settings. Nothing is allowed until you
        approve it.
      </p>
      {waiting.length > 0 && (
        <>
          <h2 class="section-title">Waiting for you</h2>
          {waiting.map(({ app, req }) => (
            <RequestCard app={app} req={req} key={req.id} />
          ))}
        </>
      )}
      {s.apps.length > 0 && s.accounts.length > 0 && (
        <>
          <h2 class="section-title">Who reaches what</h2>
          <GrantMatrix />
        </>
      )}
      <h2 class="section-title">Apps</h2>
      {s.apps.length ? s.apps.map((a) => <AppCard app={a} key={a.id} />) : <Empty>No app has introduced itself yet. Apps on this machine register with the manager and ask for what they need; their requests appear here.</Empty>}
    </div>
  );
}
