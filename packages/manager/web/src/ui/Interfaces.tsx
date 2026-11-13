/**
 * Interfaces: the spec as documentation you can run. Each interface's operations by level, with the TypeScript types
 * an app sees for their input and output (and the named types those use), its events, and which kinds implement it.
 * Any operation can be tried on an account that offers it (Runner). `#/interfaces/<iface>/<op>` opens one.
 */
import { useEffect, useState } from 'preact/hooks';
import type { InterfaceInfo } from '../../../src/api-types.ts';
import { href, loadTypes, route, state, types } from '../state.ts';
import { Card, LEVEL_WORD, LEVELS, LevelPill } from './bits.tsx';
import { OpTypes, Runner, TypeText, usedDefs } from './Runner.tsx';

/** One line of the input type, for the collapsed row. */
function brief(t: string | undefined): string {
  if (!t) return '';
  const one = t.replace(/\/\*\*[\s\S]*?\*\/\s*/g, '').replace(/\s+/g, ' ');
  return one.length > 90 ? one.slice(0, 88) + '…' : one;
}

function Op({ i, o, open }: { i: InterfaceInfo; o: InterfaceInfo['ops'][number]; open: boolean }) {
  const [trying, setTrying] = useState(false);
  const t = types.value?.[i.name]?.ops[o.name];
  const offered = state.value!.accounts.filter((a) => a.interfaces.includes(i.name));
  useEffect(() => {
    if (open) document.getElementById(`op-${i.name}-${o.name}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [open]);
  return (
    <div class={`op ${open ? 'open' : ''}`} id={`op-${i.name}-${o.name}`} data-op={o.name}>
      <a class="op-row" href={open ? href('interfaces', i.name) : href('interfaces', i.name, o.name)} aria-expanded={open}>
        <span class="mono op-name">{o.name}</span>
        <span class="op-describe">{o.describe}</span>
        {!open && t && <code class="op-brief faint">{brief(t.input)}</code>}
      </a>
      {open && (
        <div class="op-body">
          <OpTypes iface={i.name} op={o.name} />
          {!trying ? (
            <div class="row">
              <button class="btn sm" disabled={!offered.length} onClick={() => setTrying(true)} data-try>
                Try it on an account
              </button>
              {!offered.length && <span class="small muted">No account offers {i.name} yet.</span>}
            </div>
          ) : (
            <Runner iface={i.name} op={o.name} />
          )}
        </div>
      )}
    </div>
  );
}

function Events({ i }: { i: InterfaceInfo }) {
  const t = types.value?.[i.name];
  const [shown, setShown] = useState<string | null>(null);
  return (
    <details class="events">
      <summary>
        {i.events.length} event{i.events.length === 1 ? '' : 's'}
      </summary>
      <dl class="ops">
        {i.events.map((e) => (
          <div key={e.name}>
            <dt class="mono">{e.name}</dt>
            <dd>
              {e.describe}
              {t?.events[e.name] && (
                <pre class="ev-type">
                  <TypeText text={t.events[e.name]} defs={t.defs} onDef={setShown} />
                </pre>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {shown && t && (
        <div class="defs">
          <span class="label">
            {shown}{' '}
            <button class="link-btn small" onClick={() => setShown(null)}>
              Close
            </button>
          </span>
          {[shown, ...usedDefs([t.defs[shown]], t.defs).filter((n) => n !== shown)].map((n) => (
            <pre key={n}>
              <TypeText text={t.defs[n]} defs={t.defs} onDef={setShown} />
            </pre>
          ))}
        </div>
      )}
    </details>
  );
}

export function Interfaces() {
  useEffect(loadTypes, []);
  const s = state.value!;
  const [openIface, openOp] = route.value.parts;
  return (
    <div class="page">
      <p class="lede">
        An interface is a set of typed operations and the events that come with them. Every operation has a level, so a grant up to a level is the consent lines below it. Extractors, one per kind
        of account, implement interfaces; apps ask for them. Open an operation to see its types, and try it on one of your accounts.
      </p>
      {s.interfaces.map((i) => {
        const kinds = s.kinds.filter((k) => k.interfaces.includes(i.name));
        const accounts = s.accounts.filter((a) => a.interfaces.includes(i.name));
        return (
          <Card class="iface" key={i.name} data-iface={i.name} id={`iface-${i.name}`}>
            <header class="card-head">
              <div>
                <h3 class="mono">{i.name}</h3>
                <p class="muted small">
                  {i.describe} Version {i.version}.
                </p>
              </div>
              <span class="small muted right">
                {kinds.length ? `In ${kinds.map((k) => k.name).join(', ')}` : 'No extractor offers it yet'}
                {accounts.length > 0 && (
                  <>
                    <br />
                    {accounts.filter((a) => a.online).length} of {accounts.length} account{accounts.length === 1 ? '' : 's'} online
                  </>
                )}
              </span>
            </header>
            {LEVELS.filter((l) => i.ops.some((o) => o.level === l)).map((l) => (
              <div class="level-block" key={l} data-level-block={l}>
                <div class="level-head">
                  <LevelPill level={l} />
                  <span>{i.levels[l] ?? LEVEL_WORD[l]}</span>
                </div>
                <div class="op-list">
                  {i.ops
                    .filter((o) => o.level === l)
                    .map((o) => (
                      <Op key={o.name} i={i} o={o} open={openIface === i.name && openOp === o.name} />
                    ))}
                </div>
              </div>
            ))}
            {i.events.length > 0 && <Events i={i} />}
          </Card>
        );
      })}
    </div>
  );
}
