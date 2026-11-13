/**
 * Accounts. With none picked, the overview (Overview.tsx): every account by category, and adding. With one picked,
 * as in dither-chat: the accounts in a list, and the one you picked beside it, with its live view (when its extractor
 * runs a browser), what it needs from you (a code to scan, a sign-in), what it is signed in as, its process and
 * session, the apps that reach it, its call counts, its files and log, and its operations to try.
 */
import { useEffect, useState } from 'preact/hooks';
import type { AccountDetail, AccountInfo, DirListing, ManagerState, StatusLayer } from '../../../src/api-types.ts';
import { CATEGORIES, categoryOf, nicknameOf, subtitleOf, usernameOf } from '../catalog.ts';
import { act, addedNote, ago, api, appName, bytes, confirm, confirmWith, copy, go, href, kindName, named, openWhenReady, route, since, state, takeQuery, toast } from '../state.ts';
import { openAdd } from './Add.tsx';
import { approvers, loadApprovers } from './Approvers.tsx';
import { AttentionBlock, HavenoControls } from './Attention.tsx';
import { attentionOf, Avatar, condition, Dot, Empty, LevelPill, type Level } from './bits.tsx';
import { Icon } from './icons.tsx';
import { LiveView } from './LiveView.tsx';
import { MoneroKeyImages } from './Monero.tsx';
import { Overview } from './Overview.tsx';
import { Runner } from './Runner.tsx';

interface GoogleStatus {
  accounts: { id: string; email: string | null; scopes: string[] }[];
}

const origin = (a: AccountInfo) => (a.builtin ? 'Part of the manager' : a.createdBy === 'import' ? 'Imported from dither-chat' : a.createdBy ? `Made by ${appName.value.get(a.createdBy) ?? 'an app since forgotten'}` : 'Added here');

// ---------------------------------------------------------------- the list

function AccountList({ active }: { active: string | undefined }) {
  const s = state.value!;
  const byCat = new Map<string, AccountInfo[]>();
  for (const a of s.accounts) {
    const c = categoryOf(a.interfaces);
    (byCat.get(c) ?? byCat.set(c, []).get(c)!).push(a);
  }
  return (
    <nav class="acc-list" aria-label="Accounts">
      <div class="acc-list-head">
        <a class="btn sm ghost" href={href('accounts')} data-overview-link>
          <Icon glyph="back" size={14} />
          Overview
        </a>
        <span class="grow" />
        <button class="btn sm" onClick={() => openAdd()} aria-label="Add an account" title="Add an account">
          <Icon glyph="plus" size={14} />
        </button>
      </div>
      {CATEGORIES.filter((c) => byCat.has(c.id)).map((c) => {
        const list = byCat.get(c.id)!.slice().sort((x, y) => (x.kind === y.kind ? named(x).localeCompare(named(y)) : x.kind.localeCompare(y.kind)));
        return (
          <div class="acc-group" key={c.id} data-category={c.id}>
            <div class="acc-group-head">
              <span>{c.name}</span>
              <span class="faint">
                {list.filter((a) => a.online).length}/{list.length}
              </span>
            </div>
            {list.map((a) => {
              const cd = condition(a);
              const kn = kindName.value.get(a.kind) ?? a.kind;
              const trouble = cd.tone === 'danger' || cd.tone === 'warn';
              return (
                <a key={a.id} href={href('accounts', a.id)} class={`acc-item ${active === a.id ? 'on' : ''}`} aria-current={active === a.id ? 'page' : undefined} data-account={a.id}>
                  <span class="acc-item-avatar">
                    <Avatar a={a} size={30} badge={false} />
                    <Dot tone={cd.tone} title={cd.text} />
                  </span>
                  <span class="acc-item-text">
                    <span class="acc-item-name">{named(a)}</span>
                    <span class={`acc-item-sub ${trouble ? 'warn' : ''}`}>{trouble ? cd.text : (subtitleOf(a, kn) ?? cd.text)}</span>
                  </span>
                </a>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------- the pane

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'try', label: 'Try it' },
  { id: 'activity', label: 'Activity' },
  { id: 'files', label: 'Files' },
  { id: 'log', label: 'Log' },
  { id: 'raw', label: 'Raw' },
] as const;
type Tab = (typeof TABS)[number]['id'];

function useDetail(id: string): [AccountDetail | null, () => void] {
  const [d, setD] = useState<AccountDetail | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let dead = false;
    const load = () =>
      api<AccountDetail>(`/api/accounts/${id}`)
        .then((x) => !dead && setD(x))
        .catch(() => {});
    setD(null);
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 3000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [id, n]);
  return [d, () => setN((x) => x + 1)];
}

function Kv({ rows }: { rows: [string, preact.ComponentChildren][] }) {
  return (
    <dl class="kv">
      {rows
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number' && v > 1_000_000_000_000 && v < 10_000_000_000_000) return `${new Date(v).toLocaleString()} (${ago(v)})`;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const LAYER_WORD: Record<StatusLayer['state'], string> = { ok: 'working', waiting: 'waiting', failed: 'failed', off: 'not used' };
const LAYER_MARK: Record<StatusLayer['state'], string> = { ok: '✓', waiting: '…', failed: '✕', off: '–' };

/**
 * What the account rests on (its status's layers), outermost first: a pill per layer with its note under it. The
 * first that is waiting or failed is where it stops; a layer that is off is one it does not use, so never the stop.
 */
function Chain({ layers }: { layers: StatusLayer[] }) {
  const stop = layers.findIndex((l) => l.state === 'waiting' || l.state === 'failed');
  return (
    <section class="pane-section chain-section" data-layers>
      <h4>What it rests on</h4>
      <ol class="chain">
        {layers.map((l, i) => (
          <li key={`${i}:${l.name}`} class={`link s-${l.state}${i === stop ? ' stop' : ''}`} data-layer={l.name} data-state={l.state} aria-current={i === stop ? 'step' : undefined}>
            <span class="link-pill" title={`${l.name}: ${LAYER_WORD[l.state]}`}>
              <span class="link-mark" aria-hidden="true">
                {LAYER_MARK[l.state]}
              </span>
              <span class="link-name">{l.name}</span>
              <span class="sr-only">, {LAYER_WORD[l.state]}</span>
            </span>
            {l.note && <span class="link-note">{l.note}</span>}
            {i === stop && (
              <span class="link-stop" data-stop>
                This is where it stops
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Its passkeys (privacy, schwab): where new ones are made (here, or a paired phone: docs/approver.md) and each one held,
 * with where its key lives. Never a key.
 */
function Passkeys({ a, d, reload }: { a: AccountInfo; d: AccountDetail; reload: () => void }) {
  useEffect(() => {
    if (!approvers.value) void loadApprovers();
  }, []);
  const pk = d.passkeys!;
  const devices = approvers.value?.devices ?? [];
  const where = (id: string | null) => (id === null ? 'This machine' : (devices.find((x) => x.id === id)?.name ?? 'A removed phone'));
  const choose = async (v: string) => {
    if (await act(`/api/accounts/${a.id}`, { method: 'PATCH', body: { passkeyDevice: v || null } }, v ? `New passkeys go to ${where(v)}` : 'New passkeys are made here')) reload();
  };
  return (
    <section class="pane-section" data-passkeys>
      <h4>Passkeys</h4>
      <label class="row nowrap small">
        <span>Keep new passkeys on</span>
        <select value={pk.device ?? ''} onChange={(e) => void choose((e.target as HTMLSelectElement).value)} data-passkey-device>
          <option value="">This machine (secret.json)</option>
          {devices.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} ({x.fingerprint.slice(0, 11)}…)
            </option>
          ))}
          {pk.device && !devices.some((x) => x.id === pk.device) && <option value={pk.device}>A removed phone</option>}
        </select>
      </label>
      {!devices.length && (
        <p class="muted small">
          Pair a phone on <a href={href('approvers')}>Approvers</a> to keep passkeys there instead.
        </p>
      )}
      {pk.list.length ? (
        <div class="table-wrap">
          <table class="small">
            <thead>
              <tr>
                <th>Passkey</th>
                <th>Site</th>
                <th>Its key is on</th>
                <th>Made</th>
                <th>Last used</th>
              </tr>
            </thead>
            <tbody>
              {pk.list.map((p) => (
                <tr key={p.idPrefix + p.createdAt} data-passkey={p.idPrefix}>
                  <td class="mono">
                    {p.idPrefix}… <span class="muted">{p.algorithm}</span>
                  </td>
                  <td class="mono">{p.rpId}</td>
                  <td>{where(p.device)}</td>
                  <td>{ago(p.createdAt)}</td>
                  <td>
                    {ago(p.lastUsedAt)}
                    {p.verifiedAt && <div class="muted">checked {ago(p.verifiedAt)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted small">None yet: add one in the site’s settings from the live view.</p>
      )}
    </section>
  );
}

function AccountOverview({ a, d, reload }: { a: AccountInfo; d: AccountDetail | null; reload: () => void }) {
  const s = state.value!;
  const google = s.providers.google as GoogleStatus | undefined;
  const oauth = google?.accounts.find((x) => x.id === a.id);
  const hello = d?.hello as { network?: string; version?: string; capabilities?: string[] } | null;
  const details = d?.status?.details as Record<string, unknown> | undefined;
  const p = d?.process;
  const disconnect = async () => {
    if (await confirm(`Disconnect ${oauth?.email ?? 'this Google account'}?`, 'Its token is revoked and apps lose it. Connecting again asks Google for your consent anew.', 'Disconnect')) {
      if (await act(`/api/providers/google/accounts/${a.id}`, { method: 'DELETE' }, 'Disconnected')) go('accounts');
    }
  };
  return (
    <div class="pane-body">
      {a.layers && a.layers.length > 0 && <Chain layers={a.layers} />}

      <section class="pane-section">
        <h4>{a.self || !a.seenAs ? 'Signed in as' : 'Last signed in as'}</h4>
        {a.self ?? a.seenAs ? (
          <div class="who">
            <Avatar a={a} size={40} />
            <div>
              <strong>{(a.self ?? a.seenAs)!.name ?? (a.self ?? a.seenAs)!.detail}</strong>
              {(a.self ?? a.seenAs)!.name && (a.self ?? a.seenAs)!.detail && <p class="muted small">{(a.self ?? a.seenAs)!.detail}</p>}
            </div>
          </div>
        ) : (
          <p class="muted small">{a.online ? 'It has not said yet.' : 'Unknown until it is online.'}</p>
        )}
      </section>

      {details && Object.keys(details).length > 0 && (
        <section class="pane-section" data-details>
          <h4>Session</h4>
          <Kv rows={Object.entries(details).map(([k, v]) => [k, scalar(v)])} />
        </section>
      )}

      {d?.passkeys && <Passkeys a={a} d={d} reload={reload} />}

      <section class="pane-section">
        <h4>Extractor</h4>
        <Kv
          rows={[
            ['State', `${(a.status?.status as string | undefined) ?? (a.online ? 'online' : a.running ? 'starting' : 'not running')}${a.error ? ` · ${a.error}` : ''}`],
            ['Online for', a.online && p?.onlineSince ? since(p.onlineSince) : null],
            ['Process', a.builtin ? 'part of the manager' : p?.pid ? `pid ${p.pid}, running ${since(p.startedAt)}` : 'not running'],
            [
              'Memory',
              p?.tree.length ? (
                <span title={p.tree.map((t) => `${t.name}: ${t.pids.join(', ')}`).join('\n')}>
                  {bytes(p.tree.reduce((n, t) => n + t.rssBytes, 0))}:{' '}
                  {p.tree
                    .slice()
                    .sort((x, y) => y.rssBytes - x.rssBytes)
                    .map((t) => `${t.name}${t.pids.length > 1 ? ` ×${t.pids.length}` : ''} ${bytes(t.rssBytes)}`)
                    .join(', ')}
                </span>
              ) : null,
            ],
            ['Starts', p ? `${p.starts} since the manager started` : null],
            ['Last exit', p?.lastExit ? `code ${p.lastExit.code ?? '—'}${p.lastExit.signal ? `, ${p.lastExit.signal}` : ''}, ${ago(p.lastExit.at)}` : null],
            ['Lock', p?.lock ? `${p.lock.owner} (pid ${p.lock.pid})${p.lock.at ? `, since ${new Date(p.lock.at).toLocaleString()}` : ''}` : 'free'],
            ['Network', hello?.network ? `${hello.network}${hello.version ? `, extractor version ${hello.version}` : ''}` : null],
            [
              'Can',
              hello?.capabilities?.length ? (
                <span class="chips">
                  {hello.capabilities.map((c) => (
                    <span class="chip" key={c}>
                      {c}
                    </span>
                  ))}
                </span>
              ) : null,
            ],
            [
              'Interfaces',
              <span class="chips">
                {a.interfaces.map((i) => (
                  <a class="chip mono" key={i} href={href('interfaces', i)}>
                    {i}
                  </a>
                ))}
              </span>,
            ],
          ]}
        />
      </section>

      <section class="pane-section">
        <h4>Where it lives</h4>
        <Kv
          rows={[
            [
              'Directory',
              <span class="row nowrap">
                <code class="path">{a.dir}</code>
                <button class="link-btn small flex-none" onClick={() => copy(a.dir)}>
                  Copy
                </button>
              </span>,
            ],
            ['Secret', d ? (d.secret.present ? `secret.json with ${d.secret.keys.length ? d.secret.keys.join(', ') : 'nothing in it'}` : 'none') : null],
            ['Origin', `${origin(a)}, ${ago(a.createdAt)}`],
            ['Changed', d ? ago(d.updatedAt) : null],
            ['Id', <code>{a.id}</code>],
          ]}
        />
        {d && Object.keys(d.config).length > 0 && (
          <details class="raw-block">
            <summary>Config</summary>
            <pre class="json">{JSON.stringify(d.config, null, 2)}</pre>
          </details>
        )}
      </section>

      {oauth && (
        <section class="pane-section">
          <h4>Google sign-in</h4>
          <p class="small muted">{oauth.scopes.map((x) => x.replace('https://www.googleapis.com/auth/', '')).join(', ') || 'No scopes'}</p>
          <div class="row">
            <button class="btn sm danger" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        </section>
      )}

      <section class="pane-section">
        <h4>Apps that reach it</h4>
        {!d ? (
          <p class="muted small">Loading…</p>
        ) : d.access.length ? (
          <ul class="access">
            {d.access.map((g) => (
              <li key={g.grant}>
                <strong>{g.appName}</strong> <span class="mono small">{g.interface === 'accounts' ? 'runs this account' : g.interface}</span> <LevelPill level={g.level as Level} />
                {g.dryRun && <span class="pill dry">Dry run</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted small">No app may use it.</p>
        )}
        <a class="small" href={href('apps')}>
          Change on Apps
        </a>
      </section>
    </div>
  );
}

/** Its calls over 30 days; `app` (from the Apps page's matrix) shows only that app's. */
function ActivityTab({ a, d, app }: { a: AccountInfo; d: AccountDetail | null; app?: string }) {
  if (!d) return <p class="muted small pane-body">Loading…</p>;
  const name = (id: string) => (id === 'page' ? 'This page' : (appName.value.get(id) ?? 'An app since forgotten'));
  const rows = app ? d.activity.filter((r) => r.app === app) : d.activity;
  const only = app && (
    <p class="small filter-note" data-activity-filter={app}>
      Only <strong>{name(app)}</strong>'s calls · <a href={href('accounts', a.id, 'activity')}>Show every app's</a>
    </p>
  );
  if (!rows.length)
    return (
      <div class="pane-body">
        {only}
        <p class="muted small">No calls{app ? ` from ${name(app)}` : ''} in the last 30 days.</p>
      </div>
    );
  return (
    <div class="pane-body">
      {only}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>App</th>
              <th>Operation</th>
              <th>Outcome</th>
              <th class="num">Calls</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.day}|${r.app}|${r.op}|${r.outcome}`} data-activity-row={r.app}>
                <td class="muted">{r.day}</td>
                <td>{name(r.app)}</td>
                <td class="mono">{r.op}</td>
                <td class={`o-${r.outcome}`}>{r.outcome}</td>
                <td class="num">{r.n}</td>
                <td class="muted">{ago(r.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="small faint">Counts only: never what was asked or answered.</p>
    </div>
  );
}

function FilesTab({ a }: { a: AccountInfo }) {
  const [l, setL] = useState<DirListing | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let dead = false;
    setL(null);
    api<DirListing>(`/api/accounts/${a.id}/files`)
      .then((x) => !dead && setL(x))
      .catch((e) => toast((e as Error).message, 'error'));
    return () => {
      dead = true;
    };
  }, [a.id, n]);
  if (!l) return <p class="muted small pane-body">Counting…</p>;
  if (!l.exists) return <p class="muted small pane-body">{a.dir} does not exist.</p>;
  return (
    <div class="pane-body">
      <div class="row">
        <code class="path small">{l.path}</code>
        <span class="grow" />
        <span class="small muted">
          {bytes(l.size)}
          {l.partial ? ' or more (stopped counting)' : ''}
        </span>
        <button class="btn sm ghost" onClick={() => setN((x) => x + 1)}>
          Recount
        </button>
      </div>
      <div class="table-wrap">
        <table data-files>
          <thead>
            <tr>
              <th>Name</th>
              <th class="num">Size</th>
              <th class="num">Files</th>
              <th>Changed</th>
            </tr>
          </thead>
          <tbody>
            {l.entries.map((e) => (
              <tr key={e.name}>
                <td class="mono">
                  {e.name}
                  {e.type === 'dir' ? '/' : e.type === 'link' ? ' →' : ''}
                </td>
                <td class="num">{bytes(e.size)}</td>
                <td class="num muted">{e.files ?? ''}</td>
                <td class="muted">{ago(e.mtime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="small faint">Names and sizes only; the page never opens what is in them.</p>
    </div>
  );
}

function LogTab({ a }: { a: AccountInfo }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [wrap, setWrap] = useState(false);
  const [box, setBox] = useState<HTMLPreElement | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () =>
      api<{ lines: string[] }>(`/api/accounts/${a.id}/log?lines=1000`)
        .then((x) => !dead && setLines(x.lines))
        .catch(() => {});
    void load();
    const t = follow ? setInterval(() => document.visibilityState === 'visible' && void load(), 2000) : undefined;
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [a.id, follow]);
  const shown = (lines ?? []).filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()));
  useEffect(() => {
    if (follow && box) box.scrollTop = box.scrollHeight;
  }, [shown.length, follow, box]);
  return (
    <div class="pane-body">
      <div class="row">
        <input class="grow" placeholder="Filter" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} aria-label="Filter the log" />
        <label class="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} />
          <span>Follow</span>
        </label>
        <label class="check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap((e.target as HTMLInputElement).checked)} />
          <span>Wrap</span>
        </label>
      </div>
      {lines === null ? (
        <p class="muted small">Loading…</p>
      ) : (
        <pre class={`log ${wrap ? 'wrap' : ''}`} ref={setBox} data-log>
          {shown.length
            ? shown.map((l, i) => (
                <div key={i} class={/^\[(error)\]|\berror\b/i.test(l) ? 'l-error' : /^\[warn\]/.test(l) ? 'l-warn' : /^\[debug\]/.test(l) ? 'l-debug' : /^---/.test(l) ? 'l-mark' : ''}>
                  {l}
                </div>
              ))
            : 'Nothing logged yet.'}
        </pre>
      )}
      <p class="small faint">The last 1000 lines of adapter.log in its directory.</p>
    </div>
  );
}

function RawTab({ d }: { d: AccountDetail | null }) {
  if (!d) return <p class="muted small pane-body">Loading…</p>;
  return (
    <div class="pane-body">
      <p class="small muted">What its extractor last said about itself. The manager keeps only these two, never what the account says.</p>
      {(['hello', 'status'] as const).map((k) => (
        <details class="raw-block" open key={k}>
          <summary class="mono">{k}</summary>
          <pre class="json">{d[k] ? JSON.stringify(d[k], null, 2) : 'nothing yet'}</pre>
        </details>
      ))}
    </div>
  );
}

function AccountPane({ a, tab, sub }: { a: AccountInfo; tab: Tab; sub?: string }) {
  const [d, reload] = useDetail(a.id);
  const [live, setLive] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const c = condition(a);
  const at = attentionOf(a);

  // An account just added here: its live view opens as soon as it has one.
  useEffect(() => {
    if (openWhenReady.value === a.id && a.liveView) {
      openWhenReady.value = null;
      setLive(true);
    }
  }, [a.id, a.liveView, openWhenReady.value]);
  useEffect(() => (setLive(false), setReplacing(false)), [a.id]);

  const secretFields = (state.value!.kinds.find((k) => k.kind === a.kind)?.add?.fields ?? []).filter((f) => f.secret);
  const toggle = async () => {
    if (a.enabled && !(await confirm(`Disable ${named(a)}?`, 'Its extractor stops and apps cannot reach it until you enable it again. Its session stays where it is.', 'Disable', false))) return;
    await act(`/api/accounts/${a.id}`, { method: 'PATCH', body: { enabled: !a.enabled } }, a.enabled ? `Disabled ${named(a)}` : `Enabled ${named(a)}`);
  };
  const restart = async () => {
    if (await confirm(`Restart ${named(a)}?`, 'Its extractor stops and starts again; apps lose it for a moment (and a call it is in, such as a voice call, ends).', 'Restart', false))
      await act(`/api/accounts/${a.id}/restart`, { method: 'POST' }, `Restarted ${named(a)}`);
  };
  const remove = async () => {
    // dither-chat's hub runs an account it loses from its list itself: for one made here,
    // that is a new, empty session, so it is better removed in dither-chat until the hub is ported.
    const back =
      a.createdBy === 'import'
        ? ' dither-chat runs it again on its own if it still has it.'
        : a.interfaces.includes('chat')
          ? ' If dither-chat shows it, remove it there instead: dither-chat would start it again on its own, with an empty session.'
          : '';
    const title = `Remove ${named(a)}?`;
    const body = `Its extractor stops and the manager forgets it; apps lose it. Its directory (${a.dir}) stays, with its session in it, unless you delete it.${back}`;
    // Only a directory the manager made may go with it; one imported in place belongs to where it came from.
    const r = a.ownDir ? await confirmWith(title, body, 'Remove', 'Also delete its directory: the session is gone for good (a linked device stays listed on your phone until you remove it there)') : { ok: await confirm(title, body, 'Remove'), checked: false };
    if (r.ok && (await act(`/api/accounts/${a.id}${r.checked ? '?purge=1' : ''}`, { method: 'DELETE' }, r.checked ? `Removed ${named(a)} and its directory` : `Removed ${named(a)}`))) go('accounts');
  };
  // A nickname is only for telling accounts apart: an empty one names it by who it signs in as again.
  const kn = kindName.value.get(a.kind) ?? a.kind;
  const nick = nicknameOf(a, kn);
  const rename = async (e: Event) => {
    e.preventDefault();
    if (renaming !== null && renaming.trim() !== (nick ?? '')) await act(`/api/accounts/${a.id}`, { method: 'PATCH', body: { label: renaming.trim() } }, renaming.trim() ? 'Nickname saved' : 'Nickname cleared');
    setRenaming(null);
  };

  return (
    <section class="acc-pane" data-pane={a.id}>
      <header class="pane-head">
        <a class="back btn sm ghost" href={href('accounts')} aria-label="All accounts">
          ←
        </a>
        <Avatar a={a} size={40} />
        <div class="pane-title">
          {renaming !== null ? (
            <form class="row" onSubmit={rename}>
              <input value={renaming} placeholder={usernameOf(a) ?? kn} onInput={(e) => setRenaming((e.target as HTMLInputElement).value)} aria-label="Nickname (empty: none)" autoFocus />
              <button class="btn sm primary">Save</button>
              <button type="button" class="btn sm ghost" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <h2>
              {named(a)}{' '}
              <button class="link-btn small" onClick={() => setRenaming(nick ?? '')} data-rename title="A nickname, to tell it apart; empty names it by who it signs in as">
                {nick ? 'Nickname' : 'Add nickname'}
              </button>
            </h2>
          )}
          <p class="small">
            <span class="muted">{subtitleOf(a, kn) ?? kn}</span> · <span class={`state ${c.tone}`} data-condition>{c.text}</span>
          </p>
        </div>
        <span class="grow" />
        <div class="pane-actions">
          {a.liveView && (
            <button class="btn primary" onClick={() => setLive(true)} data-open-live>
              Live view
            </button>
          )}
          {/* The manager's own notices are part of it: nothing to restart, disable or remove. */}
          {!a.builtin && (
            <>
              <button class="btn" disabled={!a.enabled} onClick={restart} data-restart>
                Restart
              </button>
              {secretFields.length > 0 && (
                <button class="btn ghost" onClick={() => setReplacing(true)} data-replace-secret>
                  Replace sign-in
                </button>
              )}
              <button class="btn ghost" onClick={toggle} data-toggle>
                {a.enabled ? 'Disable' : 'Enable'}
              </button>
              <button class="btn ghost danger-text" onClick={remove} data-remove>
                Remove
              </button>
            </>
          )}
        </div>
      </header>
      {replacing && <ReplaceSecret a={a} fields={secretFields} onClose={() => setReplacing(false)} />}
      {a.error && <p class="banner error pane-banner">{a.error}</p>}
      <AttentionBlock a={a} onLive={() => setLive(true)} />
      {a.kind === 'haveno' && <HavenoControls a={a} onLive={() => setLive(true)} />}
      {a.kind === 'monero' && <MoneroKeyImages a={a} />}
      {addedNote.value?.id === a.id && !at && !a.online ? (
        <p class="banner info pane-banner" data-added-note>
          {addedNote.value.text}
        </p>
      ) : (
        openWhenReady.value === a.id && !a.liveView && !at && <p class="banner info pane-banner">Starting its browser; the live view opens when it is ready.</p>
      )}
      <nav class="pane-tabs" aria-label="About this account">
        {TABS.map((t) => (
          <a key={t.id} href={href('accounts', a.id, ...(t.id === 'overview' ? [] : [t.id]))} class={`pane-tab ${tab === t.id ? 'on' : ''}`} aria-current={tab === t.id ? 'page' : undefined} data-pane-tab={t.id}>
            {t.label}
          </a>
        ))}
      </nav>
      {tab === 'overview' && <AccountOverview a={a} d={d} reload={reload} />}
      {tab === 'try' && (
        <div class="pane-body">
          <p class="small muted">Runs an operation on {named(a)} as an app would, through the same checks; writes act as you unless you choose dry run. Counted under “This page” in Activity.</p>
          <Runner account={a} key={a.id} />
        </div>
      )}
      {tab === 'activity' && <ActivityTab a={a} d={d} app={sub} />}
      {tab === 'files' && <FilesTab a={a} />}
      {tab === 'log' && <LogTab a={a} />}
      {tab === 'raw' && <RawTab d={d} />}
      {live && <LiveView account={a} onClose={() => setLive(false)} />}
    </section>
  );
}

// ---------------------------------------------------------------- adding

/** New values for a kind's secret add-form fields (a token, an app password): merged into secret.json, then a restart. */
function ReplaceSecret({ a, fields, onClose }: { a: AccountInfo; fields: NonNullable<NonNullable<ManagerState['kinds'][number]['add']>['fields']>; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    const secret: Record<string, string> = {};
    for (const f of fields) if (values[f.key]?.trim()) secret[f.key] = values[f.key].trim();
    if (!Object.keys(secret).length) return toast(`Give ${fields.map((f) => f.label).join(' or ')}`, 'error');
    setBusy(true);
    const r = await act(`/api/accounts/${a.id}/secret`, { method: 'POST', body: { secret } }, `Replaced; ${named(a)} restarts on it`);
    setBusy(false);
    if (r) onClose();
  };
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="replace-title" data-replace-dialog>
        <h2 id="replace-title">Replace {named(a)}'s sign-in</h2>
        <form onSubmit={save} class="add-form">
          {fields.map((f) => (
            <label class="field" key={f.key}>
              <span>{f.label}</span>
              <input
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder={f.placeholder}
                value={values[f.key] ?? ''}
                onInput={(e) => setValues({ ...values, [f.key]: (e.target as HTMLInputElement).value })}
                data-replace-field={f.key}
              />
            </label>
          ))}
          <p class="small faint">What you type replaces the old value in its secret.json; the rest of its session stays. Its extractor restarts on it.</p>
          <div class="row end">
            <button type="button" class="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button class="btn primary" disabled={busy} data-replace-confirm>
              Replace
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the section

export function Accounts() {
  const s = state.value!;
  const [returned, setReturned] = useState<string | null>(null);
  useEffect(() => setReturned(takeQuery('google_error')), []);
  const [id, tabPart, sub] = route.value.parts;
  const a = id ? s.accounts.find((x) => x.id === id) : undefined;
  const tab: Tab = (TABS.find((t) => t.id === tabPart)?.id ?? 'overview') as Tab;
  const banner = returned && (
    <p class="banner error split-banner" role="alert">
      Google sign-in did not finish: {returned}
      <button class="link-btn" onClick={() => setReturned(null)}>
        Dismiss
      </button>
    </p>
  );
  if (!id)
    return (
      <>
        {banner}
        <Overview />
      </>
    );
  return (
    <div class="split has-pane">
      {banner}
      <AccountList active={id} />
      {a ? (
        <AccountPane a={a} tab={tab} sub={tab === 'activity' ? sub : undefined} key={a.id} />
      ) : (
        <section class="acc-pane">
          <Empty>No account {id}. It may have been removed.</Empty>
        </section>
      )}
    </div>
  );
}
