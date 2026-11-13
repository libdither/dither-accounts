/**
 * Types and the op runner, shared by the Interfaces section and an account's "Try it" tab.
 *
 * Types are the TypeScript the client sees (GET /api/interfaces, from scripts/gen-types.ts). The runner sends one op
 * to one account through the manager (POST /api/accounts/:id/call): the input check, rate limit, call counts and
 * dry run apply as they do to an app, and the counts show under "This page" in Activity.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AccountInfo, InterfaceInfo, PageCallResult } from '../../../src/api-types.ts';
import { api, confirm, copy, kindName, loadTypes, named, state, types } from '../state.ts';
import { LevelPill, type Level } from './bits.tsx';

const TOKEN = /(\/\*\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|\b([A-Z][A-Za-z0-9_]*)\b|\b(string|number|boolean|unknown|undefined|null|any|true|false|type)\b/g;

/** Type text with comments, literals and keywords set apart, and the named types it uses as links. */
export function TypeText({ text, defs, onDef }: { text: string; defs?: Record<string, string>; onDef?: (name: string) => void }) {
  const out: (string | preact.JSX.Element)[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [whole, comment, str, name, kw] = m;
    if (comment) out.push(<span class="t-comment" key={k++}>{comment}</span>);
    else if (str) out.push(<span class="t-str" key={k++}>{str}</span>);
    else if (name && defs?.[name] && onDef)
      out.push(
        <button type="button" class="t-ref" key={k++} onClick={() => onDef(name)} title={`What ${name} is`}>
          {name}
        </button>,
      );
    else if (name) out.push(<span class="t-name" key={k++}>{name}</span>);
    else if (kw) out.push(<span class="t-kw" key={k++}>{kw}</span>);
    else out.push(whole);
    last = m.index! + whole.length;
  }
  out.push(text.slice(last));
  return <code class="type">{out}</code>;
}

/** The named types some type texts use, and the ones those use, in the order met. */
export function usedDefs(texts: string[], defs: Record<string, string>): string[] {
  const seen: string[] = [];
  const visit = (t: string) => {
    for (const m of t.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
      const n = m[1];
      if (defs[n] && !seen.includes(n)) {
        seen.push(n);
        visit(defs[n]);
      }
    }
  };
  texts.forEach(visit);
  return seen;
}

/** An op's input and output types, with the named types they use underneath. */
export function OpTypes({ iface, op }: { iface: string; op: string }) {
  useEffect(loadTypes, []);
  const t = types.value?.[iface];
  const o = t?.ops[op];
  const [open, setOpen] = useState<string[]>([]);
  if (!types.value) return <p class="muted small">Loading types…</p>;
  if (!t || !o) return <p class="muted small">No types for this op.</p>;
  const used = usedDefs([o.input, o.output], t.defs);
  const show = (n: string) => {
    setOpen((x) => (x.includes(n) ? x : [...x, n]));
    requestAnimationFrame(() => document.getElementById(`def-${iface}-${op}-${n}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  return (
    <div class="op-types" data-op-types={op}>
      <div class="sig">
        <span class="label">Input</span>
        <pre>
          <TypeText text={o.input} defs={t.defs} onDef={show} />
        </pre>
      </div>
      <div class="sig">
        <span class="label">Output</span>
        <pre>
          <TypeText text={o.output} defs={t.defs} onDef={show} />
        </pre>
      </div>
      {used.length > 0 && (
        <div class="defs">
          <span class="label">Types used</span>
          {used.map((n) => (
            <details
              key={n}
              id={`def-${iface}-${op}-${n}`}
              open={open.includes(n)}
              onToggle={(e) => {
                const on = (e.currentTarget as HTMLDetailsElement).open;
                setOpen((x) => (on ? (x.includes(n) ? x : [...x, n]) : x.filter((y) => y !== n)));
              }}
            >
              <summary class="mono">{n}</summary>
              <pre>
                <TypeText text={t.defs[n]} defs={t.defs} onDef={show} />
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

interface Run {
  id: number;
  at: number;
  op: string;
  account: string;
  dryRun: boolean;
  out: PageCallResult;
}

const BIG = 200_000;

function ResultView({ run }: { run: Run }) {
  const [all, setAll] = useState(false);
  const text = run.out.ok ? (run.out.result === undefined ? 'undefined' : JSON.stringify(run.out.result, null, 2)) : JSON.stringify(run.out.error, null, 2);
  const cut = !all && text.length > BIG;
  const acc = state.value?.accounts.find((a) => a.id === run.account);
  return (
    <div class={`result ${run.out.ok ? 'ok' : 'failed'}`} data-result={run.out.ok ? 'ok' : run.out.error?.code}>
      <div class="result-head">
        <span class={run.out.ok ? 'good' : 'danger'}>{run.out.ok ? 'Answered' : `Failed: ${run.out.error?.code}${run.out.error?.status ? ` (${run.out.error.status})` : ''}`}</span>
        <span class="mono small">{run.op}</span>
        <span class="muted small">
          {acc?.label ?? run.account} · {run.out.ms} ms{run.dryRun ? ' · dry run' : ''} · {new Date(run.at).toLocaleTimeString()}
        </span>
        <span class="grow" />
        <button class="btn sm ghost" onClick={() => copy(text)}>
          Copy
        </button>
      </div>
      <pre class="json">{cut ? text.slice(0, BIG) : text}</pre>
      {cut && (
        <button class="link-btn small" onClick={() => setAll(true)}>
          Show all {Math.round(text.length / 1024)} KB
        </button>
      )}
    </div>
  );
}

let runSeq = 0;

/**
 * Run ops on an account. With `account`, it is fixed and the op is picked from what that account offers; with `iface`
 * and `op`, the op is fixed and the account is picked from those that offer it.
 */
export function Runner(props: { account?: AccountInfo; iface?: string; op?: string }) {
  useEffect(loadTypes, []);
  const s = state.value!;
  const offered: { iface: InterfaceInfo; op: InterfaceInfo['ops'][number] }[] = useMemo(() => {
    const names = props.account ? props.account.interfaces : props.iface ? [props.iface] : [];
    return s.interfaces.filter((i) => names.includes(i.name)).flatMap((i) => i.ops.map((op) => ({ iface: i, op })));
  }, [s.interfaces, props.account?.id, props.iface]);
  const [opKey, setOpKey] = useState(() => (props.op && props.iface ? `${props.iface}|${props.op}` : offered[0] ? `${offered[0].iface.name}|${offered[0].op.name}` : ''));
  const chosen = offered.find((x) => `${x.iface.name}|${x.op.name}` === opKey) ?? offered[0];

  const accounts: AccountInfo[] = props.account
    ? [props.account]
    : s.accounts.filter((a) => a.interfaces.includes(props.iface ?? '')).sort((a, b) => Number(b.online) - Number(a.online) || named(a).localeCompare(named(b)));
  const [accountId, setAccountId] = useState(props.account?.id ?? accounts.find((a) => a.online)?.id ?? accounts[0]?.id ?? '');
  const account = props.account ?? accounts.find((a) => a.id === accountId);

  const example = chosen ? types.value?.[chosen.iface.name]?.ops[chosen.op.name]?.example : undefined;
  const start = example === undefined ? '{}' : JSON.stringify(example, null, 2);
  const [input, setInput] = useState(start);
  const [touched, setTouched] = useState(false);
  const [shownFor, setShownFor] = useState(`${opKey}|${example !== undefined}`);
  // A fresh op starts from its example (which may arrive after the op is picked), in the same render.
  if (shownFor !== `${opKey}|${example !== undefined}`) {
    setShownFor(`${opKey}|${example !== undefined}`);
    setInput(start);
    setTouched(false);
  }

  const [dryRun, setDryRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);

  let parsed: unknown = null;
  let parseError: string | null = null;
  try {
    parsed = input.trim() ? JSON.parse(input) : {};
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) parseError = 'The input is an object: { … }';
  } catch (e) {
    parseError = (e as Error).message;
  }

  if (!offered.length) return <p class="muted small">This account offers no operations.</p>;
  if (!chosen) return null;
  const level = chosen.op.level as Level;
  const writes = level !== 'read';

  const run = async () => {
    if (!account || parseError) return;
    if (writes && !dryRun) {
      const line = chosen.iface.levels[level] ?? `${level} as you`;
      const ok = await confirm(`Run ${chosen.op.name} on ${named(account)}?`, `This acts as you on ${kindName.value.get(account.kind) ?? account.kind}: ${line}. Dry run checks the input without reaching the account.`, 'Run it', true);
      if (!ok) return;
    }
    setRunning(true);
    const t0 = Date.now();
    const dry = writes && dryRun;
    let out: PageCallResult;
    try {
      out = await api<PageCallResult>(`/api/accounts/${account.id}/call`, { method: 'POST', body: { op: chosen.op.name, input: parsed, dryRun: dry } });
    } catch (e) {
      out = { ok: false, error: { code: 'failed', message: (e as Error).message }, ms: Date.now() - t0 };
    }
    setRuns((r) => [{ id: ++runSeq, at: Date.now(), op: chosen.op.name, account: account.id, dryRun: dry, out }, ...r].slice(0, 6));
    setRunning(false);
  };

  return (
    <div class="runner" data-runner>
      <div class="runner-pick">
        {!props.op && (
          <label class="field">
            <span>Operation</span>
            <select value={opKey} onChange={(e) => setOpKey((e.target as HTMLSelectElement).value)} data-op-pick>
              {s.interfaces
                .filter((i) => offered.some((x) => x.iface.name === i.name))
                .map((i) => (
                  <optgroup label={i.name} key={i.name}>
                    {i.ops.map((o) => (
                      <option value={`${i.name}|${o.name}`} key={o.name}>
                        {o.name} · {o.level}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
          </label>
        )}
        {!props.account && (
          <label class="field">
            <span>Account</span>
            {accounts.length ? (
              <select value={accountId} onChange={(e) => setAccountId((e.target as HTMLSelectElement).value)} data-account-pick>
                {accounts.map((a) => (
                  <option value={a.id} key={a.id}>
                    {named(a)} · {kindName.value.get(a.kind) ?? a.kind}
                    {a.online ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
            ) : (
              <span class="muted small">No account offers {props.iface} yet.</span>
            )}
          </label>
        )}
      </div>
      {!props.op && (
        <>
          <p class="small">
            <LevelPill level={level} /> <span class="muted">{chosen.op.describe}</span>
          </p>
          <OpTypes iface={chosen.iface.name} op={chosen.op.name} />
        </>
      )}
      <label class="field">
        <span class="row">
          Input
          <span class="grow" />
          {touched && example !== undefined && (
            <button
              type="button"
              class="link-btn small"
              onClick={() => {
                setInput(JSON.stringify(example, null, 2));
                setTouched(false);
              }}
            >
              Back to the example
            </button>
          )}
        </span>
        <textarea
          class="json-input"
          spellcheck={false}
          rows={Math.min(14, Math.max(3, input.split('\n').length))}
          value={input}
          onInput={(e) => {
            setInput((e.target as HTMLTextAreaElement).value);
            setTouched(true);
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void run();
          }}
          data-input
        />
      </label>
      {parseError && <p class="small danger">{parseError}</p>}
      <div class="row">
        {writes && (
          <label class="check" title="Answered by the manager without reaching the account">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun((e.target as HTMLInputElement).checked)} data-dry />
            <span>Dry run</span>
          </label>
        )}
        <span class="grow" />
        {account && !account.online && <span class="small warn">{account.label} is offline</span>}
        <button class={`btn ${writes && !dryRun ? 'danger' : 'primary'}`} disabled={!account || !!parseError || running} onClick={run} data-run>
          {running ? 'Running…' : writes && !dryRun ? `Run as you` : 'Run'}
        </button>
      </div>
      {runs.map((r) => (
        <ResultView run={r} key={r.id} />
      ))}
    </div>
  );
}
