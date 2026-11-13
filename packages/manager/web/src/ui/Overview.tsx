/**
 * The page's home: every account, by category (chat, mail, calendars and contacts, money, other), each a card with
 * who it is signed in as, its kind's mark and its state; what needs you on top (accounts, and apps asking for access).
 * Adding is here too: Add for everything, and in each category its services' marks (one click to that service) and
 * a + for the category's sheet. A category with no accounts yet shows its services as tiles to start from.
 */
import type { AccountInfo } from '../../../src/api-types.ts';
import { CATEGORIES, categoryOf, type Service, services, subtitleOf } from '../catalog.ts';
import { href, kindName, named, pending, state } from '../state.ts';
import { openAdd, ServiceMark } from './Add.tsx';
import { attentionOf, Avatar, condition, Dot } from './bits.tsx';
import { Icon } from './icons.tsx';

function AccountCard({ a }: { a: AccountInfo }) {
  const c = condition(a);
  const kn = kindName.value.get(a.kind) ?? a.kind;
  const sub = subtitleOf(a, kn);
  return (
    <a class={`ov-card t-${c.tone}`} href={href('accounts', a.id)} data-account={a.id} title={`${named(a)} · ${kn} · ${c.text}`}>
      <Avatar a={a} size={40} />
      <span class="ov-card-text">
        <span class="ov-card-name">{named(a)}</span>
        <span class="ov-card-sub">{c.tone === 'off' ? `${sub ?? kn} · ${c.text}` : (sub ?? c.text)}</span>
      </span>
      <span class={`ov-state ${c.tone}`} data-condition>
        <Dot tone={c.tone} title={c.text} />
        {(c.tone === 'warn' || c.tone === 'danger') && <span>{c.text}</span>}
      </span>
    </a>
  );
}

function Offer({ list }: { list: Service[] }) {
  return (
    <div class="ov-offer">
      {list.map((sv) => (
        <button key={sv.id} class="ov-offer-tile" title={sv.line} onClick={() => openAdd(sv.category, sv.id)} data-offer={sv.id}>
          <ServiceMark sv={sv} size={32} />
          <span>{sv.name}</span>
        </button>
      ))}
    </div>
  );
}

export function Overview() {
  const s = state.value!;
  const all = services(s);
  const byCat = new Map<string, AccountInfo[]>();
  for (const a of s.accounts) {
    const c = categoryOf(a.interfaces);
    (byCat.get(c) ?? byCat.set(c, []).get(c)!).push(a);
  }
  const online = s.accounts.filter((a) => a.online).length;
  const needing = s.accounts.filter((a) => a.enabled && (a.error || attentionOf(a)));
  const asking = pending.value;
  return (
    <div class="overview" data-overview>
      <header class="ov-head">
        <div>
          <h1>Accounts</h1>
          <p class="small muted">
            {s.accounts.length ? `${online} of ${s.accounts.length} online` : 'None yet'}
            {needing.length > 0 && <span class="warn-text"> · {needing.length} need you</span>}
          </p>
        </div>
        <span class="grow" />
        <button class="btn primary" onClick={() => openAdd()} data-add-account>
          <Icon glyph="plus" size={16} />
          Add account
        </button>
      </header>

      {asking > 0 && (
        <a class="banner attention" href={href('apps')} data-asking>
          <span>
            <strong>{asking === 1 ? 'An app is' : `${asking} apps are`} asking for access.</strong> Review on Apps
          </span>
          <Icon glyph="arrow" size={16} />
        </a>
      )}
      {needing.map((a) => (
        <a class="banner attention" href={href('accounts', a.id)} key={a.id} data-needs={a.id}>
          <span>
            <strong>{named(a)}:</strong> {a.error ?? attentionOf(a)?.message}
          </span>
          <Icon glyph="arrow" size={16} />
        </a>
      ))}

      {CATEGORIES.map((c) => {
        const list = byCat.get(c.id) ?? [];
        const offer = all.filter((sv) => sv.category === c.id);
        if (!list.length && !offer.length) return null;
        return (
          <section class="ov-cat" key={c.id} data-category={c.id}>
            <div class="ov-cat-head">
              <Icon glyph={c.glyph} size={18} />
              <h2>{c.name}</h2>
              {list.length > 0 && (
                <span class="faint small">
                  {list.filter((a) => a.online).length}/{list.length}
                </span>
              )}
              <span class="grow" />
              {list.length > 0 && offer.length > 0 && (
                <span class="ov-quick" aria-label={`Add to ${c.name}`}>
                  {offer.map((sv) => (
                    <button key={sv.id} class="ov-quick-btn" title={`Add ${sv.name}: ${sv.line}`} aria-label={`Add ${sv.name}`} onClick={() => openAdd(c.id, sv.id)} data-quick={sv.id}>
                      <ServiceMark sv={sv} size={24} />
                    </button>
                  ))}
                </span>
              )}
              {offer.length > 0 && (
                <button class="btn sm ghost" title={`Add to ${c.name}`} aria-label={`Add to ${c.name}`} onClick={() => openAdd(c.id)} data-add-to={c.id}>
                  <Icon glyph="plus" size={16} />
                </button>
              )}
            </div>
            {list.length > 0 ? (
              <div class="ov-grid">
                {list
                  .slice()
                  .sort((x, y) => (x.kind === y.kind ? named(x).localeCompare(named(y)) : x.kind.localeCompare(y.kind)))
                  .map((a) => (
                    <AccountCard a={a} key={a.id} />
                  ))}
              </div>
            ) : (
              <Offer list={offer} />
            )}
          </section>
        );
      })}
    </div>
  );
}
