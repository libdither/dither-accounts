/**
 * A suite's identities (suites.ts) on the page: on the overview, one card per Google account with a chip for each of
 * its services; on an account's pane, the services of the Google account it is part of, each with the account that
 * gives it (this one or another way in), its state, and the apps that use it, or Add when nothing gives it yet.
 */
import type { AccountInfo } from '../../../src/api-types.ts';
import { nicknameOf, services } from '../catalog.ts';
import { href, kindName, state } from '../state.ts';
import { appsUsing, gives, type Identity, partStop, type Suite, type SuitePart } from '../suites.ts';
import { openAdd } from './Add.tsx';
import { Avatar, condition, Dot, type Tone } from './bits.tsx';
import { Icon } from './icons.tsx';

export interface PartState {
  part: SuitePart;
  /** The account that gives it (the one that works, if several do); null when none does. */
  by: AccountInfo | null;
  tone: Tone | null;
  text: string;
}

const RANK: Record<Tone, number> = { good: 0, warn: 1, danger: 2, off: 3 };

/** How one part of an identity stands: which of its accounts gives it, and whether it works there. */
export function partState(i: Identity, part: SuitePart): PartState {
  const states = i.accounts
    .filter((a) => gives(a, part))
    .map((a): PartState => {
      const c = condition(a);
      if (c.tone !== 'good') return { part, by: a, tone: c.tone, text: c.text };
      const stop = partStop(a, part);
      if (stop) return { part, by: a, tone: stop.state === 'failed' ? 'danger' : 'warn', text: stop.note ?? stop.name };
      return { part, by: a, tone: 'good', text: 'Working' };
    })
    .sort((x, y) => RANK[x.tone!] - RANK[y.tone!]);
  return states[0] ?? { part, by: null, tone: null, text: 'Not set up' };
}

/** What the identity is called: a nickname you gave its first account, else its email. */
export function identityName(i: Identity): { name: string; sub: string | null } {
  const main = i.accounts[0];
  const nick = nicknameOf(main, kindName.value.get(main.kind) ?? main.kind);
  if (nick) return { name: nick, sub: i.email ?? `${i.suite.name} · its address is not known yet` };
  if (i.email) return { name: i.email, sub: null };
  const w = main.self ?? main.seenAs;
  const who = w?.name ?? w?.detail;
  return { name: who ?? `${i.suite.name} account`, sub: 'Its address is not known yet' };
}

/** Whether the add sheet can add this part now. */
function canAdd(part: SuitePart): boolean {
  const s = state.value;
  return !!s && services(s).some((sv) => sv.id === part.service);
}
function addPart(part: SuitePart) {
  const sv = services(state.value!).find((x) => x.id === part.service);
  openAdd(sv?.category ?? null, part.service);
}

function PartChip({ p }: { p: PartState }) {
  if (!p.by)
    return canAdd(p.part) ? (
      <button type="button" class="part-chip none" onClick={() => addPart(p.part)} title={`Add ${p.part.name}`} data-part={p.part.id} data-part-state="none">
        <Icon glyph="plus" size={11} />
        {p.part.name}
      </button>
    ) : null;
  return (
    <a class={`part-chip t-${p.tone}`} href={href('accounts', p.by.id)} title={`${p.part.name}: ${p.text}`} data-part={p.part.id} data-part-state={p.tone}>
      <Dot tone={p.tone!} />
      <span class="part-chip-text">
        {p.part.name}
        {p.tone !== 'good' && <span class="part-chip-why">: {p.text}</span>}
      </span>
    </a>
  );
}

const worst = (i: Identity): Tone => {
  const on = i.accounts.filter((a) => a.enabled);
  return on.length ? on.map((a) => condition(a).tone).sort((x, y) => RANK[y] - RANK[x])[0] : 'off';
};

function IdentityCard({ i }: { i: Identity }) {
  const main = i.accounts[0];
  const { name, sub } = identityName(i);
  const tone = worst(i);
  return (
    <div class={`ov-card id-card t-${tone}`} data-identity={i.key}>
      <a class="id-card-head" href={href('accounts', main.id)} data-account={main.id}>
        <Avatar a={main} size={40} />
        <span class="ov-card-text">
          <span class="ov-card-name">{name}</span>
          {sub && <span class="ov-card-sub">{sub}</span>}
        </span>
      </a>
      <span class="id-parts">
        {i.suite.parts.map((part) => (
          <PartChip key={part.id} p={partState(i, part)} />
        ))}
      </span>
    </div>
  );
}

/** A suite's section on the overview: its identities, and adding another. */
export function SuiteSection({ suite, identities }: { suite: Suite; identities: Identity[] }) {
  const ok = identities.filter((i) => worst(i) === 'good').length;
  const first = suite.parts.find(canAdd);
  return (
    <section class="ov-cat" data-category={suite.id} data-suite={suite.id}>
      <div class="ov-cat-head">
        <Icon brand={suite.brand} size={18} />
        <h2>{suite.name}</h2>
        <span class="faint small">
          {ok}/{identities.length}
        </span>
        <span class="grow" />
        {first && (
          <button class="btn sm ghost" title={`Add a ${suite.name} account or service`} aria-label={`Add to ${suite.name}`} onClick={() => addPart(first)} data-add-to={suite.id}>
            <Icon glyph="plus" size={16} />
          </button>
        )}
      </div>
      <div class="ov-grid">
        {identities.map((i) => (
          <IdentityCard i={i} key={i.key} />
        ))}
      </div>
    </section>
  );
}

/** On an account's pane: the Google account it belongs to, service by service. */
export function IdentityBlock({ i, a }: { i: Identity; a: AccountInfo }) {
  const s = state.value!;
  const { name } = identityName(i);
  return (
    <section class="pane-section" data-identity-block={i.key}>
      <h4>
        {i.suite.name} account{i.email && name !== i.email ? ` · ${i.email}` : ''}
      </h4>
      <ul class="parts">
        {i.suite.parts.map((part) => {
          const p = partState(i, part);
          const here = p.by?.id === a.id;
          const apps = p.by ? appsUsing(s.apps, p.by, part.interface) : [];
          return (
            <li key={part.id} class="part-row" data-part={part.id} data-part-state={p.tone ?? 'none'}>
              <strong class="part-name">{part.name}</strong>
              <span class="part-how">
                {!p.by ? (
                  <span class="faint">not set up</span>
                ) : here ? (
                  <span>{i.suite.way[a.kind] ? `${i.suite.way[a.kind]}, this account` : 'This account'}</span>
                ) : (
                  <a href={href('accounts', p.by.id)}>{i.suite.way[p.by.kind] ?? kindName.value.get(p.by.kind) ?? p.by.kind} →</a>
                )}
                {apps.length > 0 && <span class="small faint"> · used by {apps.map((x) => x.name).join(', ')}</span>}
                {p.by && p.tone !== 'good' && <span class="small warn-text part-why">{p.text}</span>}
              </span>
              {p.by ? (
                <span class={`pill part-pill t-${p.tone}`}>
                  <Dot tone={p.tone!} />
                  {p.tone === 'good' ? 'working' : p.tone === 'off' ? 'off' : p.tone === 'danger' ? 'failing' : 'waiting'}
                </span>
              ) : canAdd(part) ? (
                <button class="btn sm" onClick={() => addPart(part)} data-add-part={part.id}>
                  <Icon glyph="plus" size={13} />
                  Add
                </button>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>
      {i.accounts.length > 1 && (
        <p class="small faint">
          {i.accounts.length} ways in: {i.accounts.map((x) => i.suite.way[x.kind] ?? x.kind).join(', ')}. Each is its own account here, with its own sign-in.
        </p>
      )}
    </section>
  );
}

